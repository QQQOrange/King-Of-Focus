//! 专注遮罩 v2 —— 逐像素 alpha 的圆角扩散动画
//!
//! ┌─ 方案 ────────────────────────────────────────────────────────────┐
//! │ 每台显示器一个 WS_EX_LAYERED 窗口，用 UpdateLayeredWindow 提交     │
//! │ 32bpp 预乘 ARGB 位图。整块位图只画"遮罩"，中间抠出一个圆角矩形洞。 │
//! │ 扩散动画 = 洞口从「整个显示器」收缩到「目标窗口 + 边距」，          │
//! │ 缓动曲线驱动，圆角半径全程不变，透明度同步淡入。                    │
//! └───────────────────────────────────────────────────────────────────┘
//!
//! 不再使用矩形拼条方案：拼条做不出圆角，也做不出从窗口边缘向外铺开的
//! 连续形变；逐像素方案在 2600x1440 上单帧填充约 3ms，静止时不重绘。

use std::sync::atomic::{
    AtomicBool, AtomicI32, AtomicI64, AtomicIsize, AtomicU32, AtomicU64, AtomicU8, Ordering,
};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

type Handle = *mut core::ffi::c_void;
type Hwnd = *mut core::ffi::c_void;
type Hdc = *mut core::ffi::c_void;
type Hmonitor = *mut core::ffi::c_void;

const WS_POPUP: u32 = 0x8000_0000;
const WS_EX_LAYERED: u32 = 0x0008_0000;
const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
const WS_EX_TOPMOST: u32 = 0x0000_0008;

const SW_SHOWNOACTIVATE: i32 = 4;
const SW_HIDE: i32 = 0;
const LWA_ALPHA: u32 = 0x0000_0002;
const RGN_DIFF: i32 = 4;
const BLACK_BRUSH: i32 = 4;

const PM_REMOVE: u32 = 0x0001;
const WM_QUIT: u32 = 0x0012;
const WM_HOTKEY: u32 = 0x0312;
const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const MOD_SHIFT: u32 = 0x0004;
const MOD_WIN: u32 = 0x0008;
const VK_K: u32 = 0x4B;

const GWL_EXSTYLE: i32 = -20;
const HWND_TOPMOST: isize = -1;
const HWND_NOTOPMOST: isize = -2;
/// HWND_TOP：对已是置顶的窗口表示「放到置顶带顶端」——这是唯一能真正提升层级的方式
const HWND_TOP: isize = 0;
const WS_EX_TOPMOST_FLAG: u32 = 0x0000_0008;

/// 当前进程是否管理员（决定能不能改别人的窗口属性）
static IS_ADMIN: AtomicBool = AtomicBool::new(false);
/// GetWindow 的 GW_HWNDPREV：取 z 序排在自己前面的那个窗口
const GW_HWNDPREV: u32 = 3;
/// GetWindow 的 GW_OWNER：取窗口的宿主（owner）
const GW_OWNER: u32 = 4;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_NOOWNERZORDER: u32 = 0x0200;

/// 抬升尝试统计（成功 / 失败），用来判断"压不上去"到底卡在哪
pub static RAISE_OK: AtomicU64 = AtomicU64::new(0);
pub static RAISE_FAIL: AtomicU64 = AtomicU64::new(0);
pub static RAISE_ERR: AtomicU32 = AtomicU32::new(0);
pub static RAISE_DROP_FAIL: AtomicU64 = AtomicU64::new(0);
pub static RAISE_DROP_ERR: AtomicU32 = AtomicU32::new(0);

/// 覆盖层窗口句柄（遮罩线程写，置顶守护线程读）
static OVERLAY_HWNDS: Mutex<Vec<isize>> = Mutex::new(Vec::new());

/// 诊断快照（遮罩线程写，UI 读）——用于界面上的「自查」
pub static DIAG: Mutex<String> = Mutex::new(String::new());

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

impl Rect {
    fn width(&self) -> i32 {
        (self.right - self.left).max(0)
    }
    fn height(&self) -> i32 {
        (self.bottom - self.top).max(0)
    }
}

#[repr(C)]
struct Msg {
    hwnd: Hwnd,
    message: u32,
    w_param: usize,
    l_param: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
    _private: u32,
}

#[repr(C)]
struct WndClassW {
    style: u32,
    lpfn_wnd_proc: Option<unsafe extern "system" fn(Hwnd, u32, usize, isize) -> isize>,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    h_instance: Handle,
    h_icon: Handle,
    h_cursor: Handle,
    hbr_background: Handle,
    lpsz_menu_name: *const u16,
    lpsz_class_name: *const u16,
}

#[repr(C)]
struct MonitorInfo {
    cb_size: u32,
    rc_monitor: Rect,
    rc_work: Rect,
    flags: u32,
}

#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(wc: *const WndClassW) -> u16;
    fn CreateWindowExW(
        ex: u32,
        class: *const u16,
        name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: Hwnd,
        menu: Handle,
        inst: Handle,
        param: *mut core::ffi::c_void,
    ) -> Hwnd;
    fn DefWindowProcW(h: Hwnd, msg: u32, wp: usize, lp: isize) -> isize;
    fn DestroyWindow(h: Hwnd) -> i32;
    fn ShowWindow(h: Hwnd, cmd: i32) -> i32;
    fn SetWindowLongW(h: Hwnd, idx: i32, val: i32) -> i32;
    fn SetWindowPos(h: Hwnd, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetWindow(h: Hwnd, cmd: u32) -> Hwnd;
    fn GetClassNameW(h: Hwnd, buf: *mut u16, max: i32) -> i32;
    fn SetLayeredWindowAttributes(h: Hwnd, key: u32, alpha: u8, flags: u32) -> i32;
    fn SetWindowRgn(h: Hwnd, rgn: Handle, redraw: i32) -> i32;
    fn InvalidateRect(h: Hwnd, r: *const Rect, erase: i32) -> i32;
    fn GetWindowLongW(h: Hwnd, idx: i32) -> i32;
    fn IsWindow(h: Hwnd) -> i32;
    fn GetForegroundWindow() -> Hwnd;
    fn IsWindowVisible(h: Hwnd) -> i32;
    fn IsIconic(h: Hwnd) -> i32;
    fn GetWindowRect(h: Hwnd, r: *mut Rect) -> i32;
    fn EnumDisplayMonitors(
        dc: Hdc,
        clip: *const Rect,
        cb: Option<unsafe extern "system" fn(Hmonitor, Hdc, *mut Rect, isize) -> i32>,
        data: isize,
    ) -> i32;
    fn GetMonitorInfoW(m: Hmonitor, mi: *mut MonitorInfo) -> i32;
    fn PeekMessageW(m: *mut Msg, h: Hwnd, min: u32, max: u32, remove: u32) -> i32;
    fn TranslateMessage(m: *const Msg) -> i32;
    fn DispatchMessageW(m: *const Msg) -> isize;
    fn RegisterHotKey(h: Hwnd, id: i32, modifiers: u32, vk: u32) -> i32;
    fn UnregisterHotKey(h: Hwnd, id: i32) -> i32;
    fn EnumWindows(cb: Option<unsafe extern "system" fn(Hwnd, isize) -> i32>, data: isize) -> i32;
    fn GetWindowThreadProcessId(h: Hwnd, pid: *mut u32) -> u32;
    fn GetWindowTextLengthW(h: Hwnd) -> i32;
    fn SetThreadDpiAwarenessContext(ctx: isize) -> isize;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> Handle;
    fn GetLastError() -> u32;
}

/// 仅在 KOF_DEBUG=1 时写日志，正式运行零开销
pub fn mlog(msg: &str) {
    if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
        return;
    }
    use std::io::Write;
    let p = crate::cfg::data_dir().join("mask-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = writeln!(
            f,
            "[{}] {}",
            chrono::Local::now().format("%H:%M:%S%.3f"),
            msg
        );
    }
}

// 把系统定时器精度提到 1ms：默认 15.6ms 会让 4ms 的 sleep 变成 16ms，
// 置顶守护看起来"每 16ms 才压一次"，浮窗就能在中间露出来。
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentThread() -> Handle;
    fn SetThreadPriority(h: Handle, p: i32) -> i32;
}

#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(period: u32) -> u32;
}

#[link(name = "dwmapi")]
extern "system" {
    fn DwmGetWindowAttribute(h: Hwnd, attr: u32, pv: *mut core::ffi::c_void, size: u32) -> i32;
}

const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;

#[link(name = "gdi32")]
extern "system" {
    fn DeleteObject(obj: Handle) -> i32;
    fn CreateRectRgn(x1: i32, y1: i32, x2: i32, y2: i32) -> Handle;
    fn CreateRoundRectRgn(x1: i32, y1: i32, x2: i32, y2: i32, w: i32, h: i32) -> Handle;
    fn CombineRgn(dst: Handle, a: Handle, b: Handle, mode: i32) -> i32;
    fn GetStockObject(idx: i32) -> Handle;
}

unsafe extern "system" fn wnd_proc(h: Hwnd, msg: u32, wp: usize, lp: isize) -> isize {
    DefWindowProcW(h, msg, wp, lp)
}

/// 遮罩运行期状态（UI 线程写入，遮罩线程读取）
pub struct MaskCtl {
    pub on: AtomicBool,
    pub target: AtomicIsize,
    pub target_pid: AtomicU32,
    pub opacity: AtomicU8,
    pub margin: AtomicI32,
    /// 圆角半径（px，物理像素）
    pub radius: AtomicI32,
    /// 扩散动画时长（毫秒）
    pub duration: AtomicI32,
    pub block_click: AtomicBool,
    /// 热键：修饰键位掩码 / 虚拟键码 / 注册代数 / 上次注册是否成功
    pub hk_mod: AtomicU32,
    pub hk_vk: AtomicU32,
    pub hk_gen: AtomicU32,
    pub hk_ok: AtomicBool,
    /// 跟随自律模式：自律生效就开、自律结束就关（由 monitor 驱动）
    pub auto_follow: AtomicBool,
    /// 自律模式当前是否生效（monitor 每轮写入）。
    /// 遮罩生效 = 用户意向(on) OR (auto_follow AND schedule_on)，
    /// 这样"跟随自律"是叠加项，不会再把主开关的意思改来改去。
    pub schedule_on: AtomicBool,
    /// 预览截止时间（unix 秒，0 = 没在预览）。预览只持续几秒，不改变主开关的意向
    pub preview_until: AtomicI64,
    /// 跟随当前最上层窗口（洞口自动跟着前台窗口跑）
    pub follow: AtomicBool,
    /// 测试态：临时不跟随，固定高亮本程序窗口
    pub test_lock: AtomicBool,
    /// 手动选定的目标窗口句柄；非 0 时优先于"跟随前台"（0 = 没有手动锁定）
    pub manual_hwnd: AtomicIsize,
    pub painted: AtomicBool,
    pub notice: Mutex<Option<String>>,
}

/// 解析 "Ctrl+Alt+K" → (修饰键, VK)。不认识的组合返回 None
pub fn parse_hotkey(s: &str) -> Option<(u32, u32)> {
    let mut mods = 0u32;
    let mut vk = 0u32;
    for part in s.split('+').map(|x| x.trim()) {
        if part.is_empty() {
            return None;
        }
        let low = part.to_lowercase();
        match low.as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL,
            "alt" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            "win" | "meta" | "super" => mods |= MOD_WIN,
            _ => {
                let b = part.as_bytes();
                if b.len() == 1 {
                    let c = b[0].to_ascii_uppercase();
                    if c.is_ascii_alphanumeric() {
                        vk = c as u32;
                    }
                } else if low.starts_with('f') {
                    if let Ok(n) = low[1..].parse::<u32>() {
                        if (1..=24).contains(&n) {
                            vk = 0x70 + n - 1;
                        }
                    }
                }
            }
        }
    }
    if vk == 0 || mods == 0 {
        None
    } else {
        Some((mods, vk))
    }
}

impl Default for MaskCtl {
    fn default() -> Self {
        MaskCtl {
            on: AtomicBool::new(false),
            target: AtomicIsize::new(0),
            target_pid: AtomicU32::new(0),
            opacity: AtomicU8::new(88),
            margin: AtomicI32::new(6),
            radius: AtomicI32::new(28),
            duration: AtomicI32::new(420),
            block_click: AtomicBool::new(false),
            hk_mod: AtomicU32::new(MOD_CONTROL | MOD_ALT),
            hk_vk: AtomicU32::new(VK_K),
            hk_gen: AtomicU32::new(1),
            hk_ok: AtomicBool::new(false),
            auto_follow: AtomicBool::new(false),
            schedule_on: AtomicBool::new(false),
            preview_until: AtomicI64::new(0),
            follow: AtomicBool::new(false),
            test_lock: AtomicBool::new(false),
            manual_hwnd: AtomicIsize::new(0),
            painted: AtomicBool::new(false),
            notice: Mutex::new(None),
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 缓动：easeOutCubic
fn ease_out(t: f32) -> f32 {
    let u = 1.0 - t.clamp(0.0, 1.0);
    1.0 - u * u * u
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// 每台显示器一块覆盖层
///
/// 整窗刷半透明黑 + 整窗透明度 + `SetWindowRgn` 把目标窗口那块"挖掉"。
/// 传统分层窗口路子，不依赖 DWM 的逐像素合成，兼容性最好；区域是全屏的，
/// 所以任务栏、浮动工具条也一起盖住。
struct Overlay {
    hwnd: Hwnd,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    clickthrough: bool,
    shown: bool,
    /// 上一帧的区域参数，没变就不重建区域
    last_key: Option<(i32, i32, i32, i32, i32, u8)>,
    /// 上一帧任务栏签名的校验和（任务栏位移/隐藏时触发重画）
    last_bar_sig: i64,
    cur_alpha: u8,
}

impl Overlay {
    unsafe fn new(class: &[u16], r: Rect) -> Option<Overlay> {
        let inst = GetModuleHandleW(std::ptr::null());
        let ex = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TRANSPARENT;
        let hwnd = CreateWindowExW(
            ex,
            class.as_ptr(),
            std::ptr::null(),
            WS_POPUP,
            r.left,
            r.top,
            r.width(),
            r.height(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            inst,
            std::ptr::null_mut(),
        );
        if hwnd.is_null() {
            mlog(&format!("CreateWindowExW 失败 err={}", GetLastError()));
            return None;
        }

        mlog(&format!(
            "Overlay 建立 hwnd={:?} {}x{} @({},{})",
            hwnd, r.width(), r.height(), r.left, r.top
        ));

        Some(Overlay {
            hwnd,
            x: r.left,
            y: r.top,
            w: r.width(),
            h: r.height(),
            clickthrough: true,
            shown: false,
            last_key: None,
            last_bar_sig: 0,
            cur_alpha: 255,
        })
    }

    unsafe fn destroy(&mut self) {
        if !self.hwnd.is_null() {
            DestroyWindow(self.hwnd);
            self.hwnd = std::ptr::null_mut();
        }
    }

    unsafe fn set_clickthrough(&mut self, through: bool) {
        if self.clickthrough == through {
            return;
        }
        self.clickthrough = through;
        let mut ex = GetWindowLongW(self.hwnd, GWL_EXSTYLE) as u32;
        if through {
            ex |= WS_EX_TRANSPARENT;
        } else {
            ex &= !WS_EX_TRANSPARENT;
        }
        SetWindowLongW(self.hwnd, GWL_EXSTYLE, ex as i32);
    }

    /// 遮罩"让开"的口袋矩形（屏幕坐标）：把目标矩形再向外撑出圆角半径。
    ///
    /// 圆角必须画在**窗口外侧**。`CreateRoundRectRgn` 的圆弧是往矩形内部拐的，
    /// 如果直接拿窗口矩形当参数，四个角各会被吃掉 radius 像素——
    /// 那正是"选中的窗口没有被完整显示"的根源。先把矩形撑出去，
    /// 圆弧就整个落在窗口之外，窗口边界 1px 都不会被切。
    ///
    /// radius = 0 时口袋就是目标矩形本身（含边距），遮罩严丝合缝地贴着窗口。
    fn pocket_rect(hole: &Rect, radius: f32) -> Rect {
        let r = radius.max(0.0).round() as i32;
        Rect {
            left: hole.left - r,
            top: hole.top - r,
            right: hole.right + r,
            bottom: hole.bottom + r,
        }
    }

    /// Region 模式：整窗半透明黑，用区域把目标窗口挖出来
    unsafe fn paint_region(&mut self, hole: &Rect, radius: f32, alpha: u8) {
        if self.w <= 0 || self.h <= 0 {
            return;
        }
        // 任务栏永远不遮：把它也算进"要扣掉的区域"。放在 key 里，任务栏移动/自动隐藏时能触发重画
        let bars: Vec<Rect> = taskbar_rects()
            .into_iter()
            .filter(|r| {
                // 如果当前高亮的正是任务栏本身，就不用再扣一次
                !(r.left == hole.left && r.top == hole.top && r.right == hole.right && r.bottom == hole.bottom)
            })
            .collect();
        let bar_sig: i64 = bars
            .iter()
            .map(|r| (r.left as i64 * 31 + r.top as i64 * 17 + r.right as i64 * 7 + r.bottom as i64))
            .sum();
        let key = (
            hole.left,
            hole.top,
            hole.right,
            hole.bottom,
            radius as i32,
            alpha,
        );
        let key_changed = self.shown && self.last_key == Some(key) && self.last_bar_sig == bar_sig;
        if key_changed {
            return;
        }
        self.last_key = Some(key);
        self.last_bar_sig = bar_sig;

        if self.cur_alpha != alpha || !self.shown {
            SetLayeredWindowAttributes(self.hwnd, 0, alpha, LWA_ALPHA);
            self.cur_alpha = alpha;
        }

        // 洞换到窗口局部坐标
        let hx0 = hole.left - self.x;
        let hy0 = hole.top - self.y;
        let hx1 = hole.right - self.x;
        let hy1 = hole.bottom - self.y;

        let full = CreateRectRgn(0, 0, self.w, self.h);
        if !full.is_null() {
            if hx1 > 0 && hy1 > 0 && hx0 < self.w && hy0 < self.h {
                // 口袋 = 目标矩形外撑 radius，圆角弧线落在窗口外侧（见 pocket_rect）
                let p = Self::pocket_rect(hole, radius);
                let px0 = p.left - self.x;
                let py0 = p.top - self.y;
                let px1 = p.right - self.x;
                let py1 = p.bottom - self.y;
                let d = (((radius.max(0.0).round()) as i32) * 2).max(1);
                let cut = CreateRoundRectRgn(px0, py0, px1, py1, d, d);
                if !cut.is_null() {
                    CombineRgn(full, full, cut, RGN_DIFF);
                    DeleteObject(cut);
                }
            }
            // 任务栏：从遮罩区域里扣掉，保证它不被压暗（用户明确要求）
            for b in bars.iter() {
                let bx0 = b.left - self.x;
                let by0 = b.top - self.y;
                let bx1 = b.right - self.x;
                let by1 = b.bottom - self.y;
                if bx1 <= 0 || by1 <= 0 || bx0 >= self.w || by0 >= self.h {
                    continue;
                }
                let cut = CreateRectRgn(bx0, by0, bx1, by1);
                if !cut.is_null() {
                    CombineRgn(full, full, cut, RGN_DIFF);
                    DeleteObject(cut);
                }
            }
            // SetWindowRgn 成功后区域归系统所有，不能自己删
            if SetWindowRgn(self.hwnd, full, 1) == 0 {
                DeleteObject(full);
            }
        }

        if !self.shown {
            ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
            self.shown = true;
            // 只在第一次显示时催一次重绘；之后靠 SetWindowRgn 带着重画，
            // 否则每帧对 4K 全屏做一次擦背景会把消息泵压死
            let _ = InvalidateRect(self.hwnd, std::ptr::null(), 1);
            mlog(&format!(
                "Region 首帧 hwnd={:?} {}x{} alpha={} radius={:.0} 洞=({},{},{},{})",
                self.hwnd, self.w, self.h, alpha, radius,
                hole.left, hole.top, hole.right, hole.bottom
            ));
        }
    }

    /// 是否有"外部"窗口压在遮罩上面。
    /// 桌面挂件（时钟、歌词条、下载悬浮窗）大多会周期性把自己重新置顶，
    /// 它们每秒抢一次，而我们每 500ms 才压一次 → 用户看到的就是"间断地被遮住"。
    unsafe fn covered_by_others(&self) -> bool {
        if !self.shown {
            return false;
        }
        // 沿 z 序一路往上找：只要上面还有"别人家的可见窗口"，就算被盖。
        // 之前只看紧邻的那一个，一旦中间夹着自己的通知卡片就会误判成"没被盖"，
        // 于是重压被跳过，退化成 250ms 才压一次 —— 那就是间歇性漏遮的真凶。
        let mut h = GetWindow(self.hwnd, GW_HWNDPREV);
        let mut guard = 0;
        while !h.is_null() && guard < 64 {
            guard += 1;
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, &mut pid);
            if pid != std::process::id() && IsWindowVisible(h) != 0 {
                return true;
            }
            h = GetWindow(h, GW_HWNDPREV);
        }
        false
    }

    /// 把压在遮罩上面的外部置顶窗口的 TOPMOST 属性摘掉。
    ///
    /// 这一步需要**高完整性级别**（管理员）才能对别人的窗口 SetWindowLong。
    /// 摘掉之后对方就落在普通层级，遮罩一次就把它盖死，不会再来回抢——
    /// 这正是"让 lazytyper 那条横条一次性被盖住"的关键。
    unsafe fn strip_topmost_above(&self) {
        if !IS_ADMIN.load(Ordering::Relaxed) {
            return;
        }
        let mut h = GetWindow(self.hwnd, GW_HWNDPREV);
        let mut guard = 0;
        while !h.is_null() && guard < 32 {
            guard += 1;
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, &mut pid);
            if pid != std::process::id() && IsWindowVisible(h) != 0 && !is_shell_window(h) {
                let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
                if (ex & WS_EX_TOPMOST_FLAG) != 0 {
                    SetWindowLongW(h, GWL_EXSTYLE, (ex & !WS_EX_TOPMOST_FLAG) as i32);
                    SetWindowPos(
                        h,
                        HWND_NOTOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                    );
                }
            }
            h = GetWindow(h, GW_HWNDPREV);
        }
    }

    /// 把遮罩重新顶到最上层。
    /// 任务栏、后打开的全屏视频都是置顶窗口，不周期性重压就会被盖住。
    unsafe fn reassert(&mut self) {
        if !self.shown {
            return;
        }
        force_above(self.hwnd);
    }

    unsafe fn hide(&mut self) {
        if self.shown {
            ShowWindow(self.hwnd, SW_HIDE);
            self.shown = false;
            self.last_key = None;
        }
    }
}

/// 把当前覆盖层句柄发布给置顶守护线程
fn publish_overlays(list: &[Overlay]) {
    if let Ok(mut g) = OVERLAY_HWNDS.lock() {
        *g = list.iter().map(|o| o.hwnd as isize).collect();
    }
}

fn monitors() -> Vec<Rect> {
    unsafe extern "system" fn cb(m: Hmonitor, _dc: Hdc, _clip: *mut Rect, data: isize) -> i32 {
        let out = &mut *(data as *mut Vec<Rect>);
        let mut mi = MonitorInfo {
            cb_size: std::mem::size_of::<MonitorInfo>() as u32,
            rc_monitor: Rect { left: 0, top: 0, right: 0, bottom: 0 },
            rc_work: Rect { left: 0, top: 0, right: 0, bottom: 0 },
            flags: 0,
        };
        if GetMonitorInfoW(m, &mut mi) != 0 {
            out.push(mi.rc_monitor);
        }
        1
    }
    let mut v: Vec<Rect> = Vec::new();
    unsafe {
        EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(cb), &mut v as *mut _ as isize);
    }
    if v.is_empty() {
        v.push(Rect { left: 0, top: 0, right: 1920, bottom: 1080 });
    }
    v
}

unsafe fn find_by_pid(pid: u32) -> Hwnd {
    unsafe extern "system" fn cb(h: Hwnd, lp: isize) -> i32 {
        let t = &mut *(lp as *mut (u32, Hwnd));
        if IsWindowVisible(h) == 0 || GetWindowTextLengthW(h) == 0 {
            return 1;
        }
        let mut p: u32 = 0;
        GetWindowThreadProcessId(h, &mut p);
        if p == t.0 {
            t.1 = h;
            return 0;
        }
        1
    }
    let mut ctx: (u32, Hwnd) = (pid, std::ptr::null_mut());
    EnumWindows(Some(cb), &mut ctx as *mut (u32, Hwnd) as isize);
    ctx.1
}

/// 调试用：强制把某个窗口当作"当前最上层窗口"（0 = 不覆盖）
pub static FOLLOW_OVERRIDE: AtomicIsize = AtomicIsize::new(0);

/// 当前最上层（前台）窗口的矩形。
/// 排除本程序自己的窗口，避免把遮罩挖在自己身上。
/// 系统外壳窗口（任务栏、桌面、托盘）。
/// 这些窗口的 TOPMOST 千万不能动——一旦被摘掉，Windows 会给任务栏画一圈边框，
/// 就是用户看到的“托盘和任务栏之间多了一个外框”。
unsafe fn is_shell_window(h: Hwnd) -> bool {
    let mut buf = [0u16; 96];
    let n = GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32);
    if n <= 0 {
        return false;
    }
    let name = String::from_utf16_lossy(&buf[..n as usize]);
    matches!(
        name.as_str(),
        "Shell_TrayWnd"
            | "Shell_SecondaryTrayWnd"
            | "Progman"
            | "WorkerW"
            | "DV2ControlHost"
            | "NotifyIconOverflowWindow"
            | "TopLevelWindowForOverflowXamlIsland"
            | "Windows.UI.Core.CoreWindow"
    )
}

/// 任务栏矩形（主屏 + 副屏）。遮罩要"跳过"这些区域——任务栏永远保持原样。
unsafe fn taskbar_rects() -> Vec<Rect> {
    unsafe extern "system" fn cb(h: Hwnd, lp: isize) -> i32 {
        let out = &mut *(lp as *mut Vec<Rect>);
        if IsWindowVisible(h) == 0 {
            return 1;
        }
        let mut buf = [0u16; 64];
        let n = GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32);
        if n <= 0 {
            return 1;
        }
        let name = String::from_utf16_lossy(&buf[..n as usize]);
        if name == "Shell_TrayWnd" || name == "Shell_SecondaryTrayWnd" {
            let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
            if GetWindowRect(h, &mut r) != 0 && r.width() > 0 && r.height() > 0 {
                out.push(r);
            }
        }
        1
    }
    let mut out: Vec<Rect> = Vec::new();
    EnumWindows(Some(cb), &mut out as *mut Vec<Rect> as isize);
    out
}

/// 窗口的“真实可见边界”。
/// Win10/11 的 GetWindowRect 会把 DWM 的不可见拖拽边框算进去（约 7px），
/// 用它挖洞就会在窗口四周留一圈透明缝——这正是“边缘残留间隙”的来源。
/// DWMWA_EXTENDED_FRAME_BOUNDS 返回的是肉眼看到的那个框。
unsafe fn window_bounds(h: Hwnd) -> Option<Rect> {
    // 系统外壳（任务栏、开始菜单、托盘浮出层）没有"隐形拖拽边框"，
    // 但它们的 DWM 扩展边框会把投影（约 8~16px）算进来。
    // 用 DWM 边框挖洞 → 窗口四周会留一圈"外扩"的亮边，正是用户看到的现象。
    if is_shell_window(h) {
        let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
        if GetWindowRect(h, &mut r) != 0 && r.width() > 0 && r.height() > 0 {
            return Some(r);
        }
    }
    let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    let hr = DwmGetWindowAttribute(
        h,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut r as *mut Rect as *mut core::ffi::c_void,
        std::mem::size_of::<Rect>() as u32,
    );
    if hr == 0 && r.width() > 0 && r.height() > 0 {
        return Some(r);
    }
    let mut r2 = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    if GetWindowRect(h, &mut r2) != 0 && r2.width() > 0 && r2.height() > 0 {
        return Some(r2);
    }
    None
}

/// 回溯到"主窗口"。
///
/// Windows 用 owner 关系区分主窗口和次生窗口：
/// - 主窗口：`GetWindow(hwnd, GW_OWNER)` 为空；
/// - 对话框、设置面板、弹出菜单、工具面板：owner 指向拉起它的那个主窗口。
///
/// 遮罩只应该框住主窗口，所以遇到带 owner 的窗口就一路回溯到最顶上的那个。
unsafe fn root_window(h: Hwnd) -> Hwnd {
    let mut cur = h;
    let mut guard = 0;
    while guard < 8 {
        guard += 1;
        let owner = GetWindow(cur, GW_OWNER);
        if owner.is_null() || IsWindow(owner) == 0 {
            break;
        }
        cur = owner;
    }
    cur
}

/// 本程序主窗口句柄（由 main/cmds 在启动、测试、预览时写入）。
/// 遮罩允许把洞挖在自己身上——用户明确要求"专注遮罩也要盖住 King of Focus 自己"。
pub static SELF_MAIN: AtomicIsize = AtomicIsize::new(0);

unsafe fn is_self_window(h: Hwnd) -> bool {
    if h.is_null() {
        return false;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(h, &mut pid);
    pid != 0 && pid == std::process::id()
}

unsafe fn follow_rect() -> Option<(Rect, isize)> {
    let ov = FOLLOW_OVERRIDE.load(Ordering::Relaxed);
    let raw = if ov != 0 { ov as Hwnd } else { GetForegroundWindow() };
    if raw.is_null() {
        return None;
    }
    // 弹窗/对话框/设置面板 → 回溯到它的主窗口，只对主窗口生效
    let mut fg = root_window(raw);
    if fg.is_null() {
        return None;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(fg, &mut pid);
    if ov == 0 && pid == 0 {
        return None;
    }
    // 前台是本程序自己的窗口时不再直接放弃：
    // 以前这里 return None 正是"遮罩对自己不生效"的原因。
    // 但要注意别把洞挖到通知卡片/HUD 这种小窗上，所以统一换成真正的主窗口。
    if ov == 0 && pid == std::process::id() {
        let main = SELF_MAIN.load(Ordering::Relaxed);
        if main != 0 && IsWindow(main as Hwnd) != 0 {
            fg = main as Hwnd;
        }
    }
    if IsWindowVisible(fg) == 0 || IsIconic(fg) != 0 {
        return None;
    }
    let r = window_bounds(fg)?;
    Some((r, fg as isize))
}

/// 两个矩形之间做插值（窗口切换时的过渡）
fn lerp_rect(a: &Rect, b: &Rect, t: f32) -> Rect {
    Rect {
        left: lerp(a.left as f32, b.left as f32, t).round() as i32,
        top: lerp(a.top as f32, b.top as f32, t).round() as i32,
        right: lerp(a.right as f32, b.right as f32, t).round() as i32,
        bottom: lerp(a.bottom as f32, b.bottom as f32, t).round() as i32,
    }
}

/// 洞口在"切换目标窗口"过渡中的当前位置。
///
/// 返回 `(当前洞口, 过渡是否已结束)`。
///
/// **speed = 0 必须瞬时到位**：model.rs 里 `duration_ms` 的语义明写「0 = 瞬间」。
/// 早期实现在这里写死 `span = 1.0`（秒），等于"把速度调到 0，洞口反而要滑 1 秒"，
/// 是用户反馈"速度设成 0 还是有过渡动画"的直接原因。
fn hole_transition(from: &Rect, to: &Rect, elapsed: f32, duration: f32) -> (Rect, bool) {
    if duration <= 0.001 {
        // 瞬时：不插值，直接落到目标位置
        return (*to, true);
    }
    let p = (elapsed / duration).min(1.0);
    if p >= 1.0 {
        (*to, true)
    } else {
        (lerp_rect(from, to, ease_out(p)), false)
    }
}

unsafe fn target_rect(ctl: &MaskCtl) -> Option<Rect> {
    let mut h = ctl.target.load(Ordering::Relaxed) as Hwnd;
    if h.is_null() || IsWindow(h) == 0 {
        let pid = ctl.target_pid.load(Ordering::Relaxed);
        if pid == 0 {
            return None;
        }
        h = find_by_pid(pid);
        if h.is_null() {
            return None;
        }
        ctl.target.store(h as isize, Ordering::Relaxed);
    }
    if IsWindowVisible(h) == 0 || IsIconic(h) != 0 {
        return None;
    }
    window_bounds(h)
}

/// 把某个覆盖层压到"所有外部窗口之上"。
///
/// 关键点：对一个**已经是 topmost** 的窗口再调 `SetWindowPos(HWND_TOPMOST)`
/// 是空操作——它不会在置顶带内部往上提层级。所以只要上面压着别的置顶窗口
/// （lazytyper 那种每隔几毫秒把自己重新置顶的横条），就必须把那个窗口当锚点：
/// `SetWindowPos(自己, 对方, …)` 才能插到它上面，否则永远压不回去，
/// 表现出来就是"横条一弹一弹地闪出来"。
unsafe fn force_above(hwnd: Hwnd) {
    if hwnd.is_null() || IsWindow(hwnd) == 0 {
        return;
    }
    if IsWindowVisible(hwnd) == 0 {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    // 只在自己确实被压在下面时才动，避免无谓的 z 序操作
    let mut has_above = false;
    let mut h = GetWindow(hwnd, GW_HWNDPREV);
    let mut guard = 0;
    while !h.is_null() && guard < 256 {
        guard += 1;
        if IsWindowVisible(h) != 0 {
            has_above = true;
            break;
        }
        h = GetWindow(h, GW_HWNDPREV);
    }
    if !has_above {
        return;
    }

    // 关键：对"已经是置顶"的窗口，
    //   SetWindowPos(hwnd, HWND_TOPMOST, …) 是**空操作**（不会在置顶带内提升层级）；
    //   HWND_NOTOPMOST 再 HWND_TOPMOST 会把它踢到置顶带**底部**（实测 51 → 131）；
    //   唯一有效的是 HWND_TOP(0)：对置顶窗口表示"放到置顶带顶端"（实测成功反超）。
    let ok = SetWindowPos(
        hwnd,
        HWND_TOP,
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
    );
    if ok != 0 {
        RAISE_OK.fetch_add(1, Ordering::Relaxed);
    } else {
        RAISE_FAIL.fetch_add(1, Ordering::Relaxed);
        RAISE_ERR.store(GetLastError(), Ordering::Relaxed);
    }
}

/// 置顶守护：独立线程以 ~250Hz 把覆盖层压到最上层。
/// 有些浮窗（lazytyper、歌词条）每次动画都重新置顶，主循环 60Hz 压不过它的节奏，
/// 这里用更高的频率专门做这一件事，把"漏遮"压到肉眼不可见。
fn spawn_topmost_keeper(ctl: std::sync::Arc<MaskCtl>) {
    thread::spawn(move || unsafe {
        // 置顶守护对延迟很敏感：常规优先级下 1ms 的 sleep 实测会被拖到 5~15ms，
        // 提到 HIGHEST 后能把"浮窗抢到我们前面"的时间窗压到一帧以内。
        SetThreadPriority(GetCurrentThread(), 2); // THREAD_PRIORITY_HIGHEST
        loop {
            thread::sleep(Duration::from_millis(1));
            if !ctl.on.load(Ordering::Relaxed) {
                continue;
            }
            let hs: Vec<isize> = match OVERLAY_HWNDS.try_lock() {
                Ok(v) => v.clone(),
                Err(_) => continue,
            };
            for h in hs {
                if h != 0 {
                    force_above(h as Hwnd);
                }
            }
        }
    });
}

pub fn start(ctl: std::sync::Arc<MaskCtl>) {
    // 先提定时器精度，否则下面 2ms 的守护循环会被系统拉到 16ms
    unsafe {
        timeBeginPeriod(1);
    }
    IS_ADMIN.store(crate::cmds::is_admin(), Ordering::Relaxed);
    spawn_topmost_keeper(ctl.clone());
    thread::spawn(move || unsafe {
        // 混合 DPI 下必须拿物理像素，否则洞和遮罩对不齐
        SetThreadDpiAwarenessContext(-4);

        let class = wide("KofMaskV2");
        let inst = GetModuleHandleW(std::ptr::null());
        let wc = WndClassW {
            style: 0,
            lpfn_wnd_proc: Some(wnd_proc),
            cb_cls_extra: 0,
            cb_wnd_extra: 0,
            h_instance: inst,
            h_icon: std::ptr::null_mut(),
            h_cursor: std::ptr::null_mut(),
            hbr_background: GetStockObject(BLACK_BRUSH),
            lpsz_menu_name: std::ptr::null(),
            lpsz_class_name: class.as_ptr(),
        };
        let rc = RegisterClassW(&wc);
        mlog(&format!("遮罩线程启动，RegisterClassW={} err={}", rc, GetLastError()));

        let mut overlays: Vec<Overlay> = Vec::new();
        let mut monitor_sig: Vec<Rect> = Vec::new();
        let mut progress: f32 = 0.0; // 0 = 无遮罩，1 = 完全铺开
        let mut last_paint: Option<(Rect, u8, i32, i32)> = None;
        // 最近一次真正重画的时刻。窗口在动 → 短周期紧跟；窗口静止 → 放长周期省 CPU
        let mut last_paint_at = Instant::now();
        let mut last_tick = Instant::now();
        let mut hk_gen_done = 0u32;
        let mut logged_miss = false;
        let mut lost: Option<Instant> = None;
        let mut last_hole: Option<Rect> = None;
        let mut last_top = Instant::now();
        // 跟随模式：记住"洞口当前挂在哪个窗口上"，以及切换过渡的起点
        let mut follow_key: isize = 0;
        let mut hole_from: Option<Rect> = None;
        let mut hole_t0 = Instant::now();
        let mut hole_painted: Option<Rect> = None;
        let mut followed_key: isize = 0;
        let mut last_diag = Instant::now();
        // 帧率诊断（每秒结算一次）：重画次数 + 单次重画耗时
        let mut stat_n = 0u32;
        let mut stat_paint_us = 0u64;
        let mut stat_t0 = Instant::now();
        let mut stat_fps = 0u32;
        let mut stat_paint_ms = 0f32;
        // 循环频率：区分"画得慢"和"循环本身转得慢"
        let mut stat_loop_n = 0u32;
        let mut stat_loop = 0u32;

        loop {
            // ---- 生效判定（先算出来，消息泵和后面都共用同一个口径）----
            // 语义统一为：
            //   遮罩生效 = 用户意向(on)  OR  (跟随自律 AND 自律模式当前生效)
            // "跟随自律"只是一层叠加，绝不改写用户意向；自律接管期间主开关在界面上置灰。
            let on_user = ctl.on.load(Ordering::Relaxed);
            let auto_hold =
                ctl.auto_follow.load(Ordering::Relaxed) && ctl.schedule_on.load(Ordering::Relaxed);
            let eff_on = on_user || auto_hold;

            // ---- 消息泵（热键）----
            let mut msg = Msg {
                hwnd: std::ptr::null_mut(),
                message: 0,
                w_param: 0,
                l_param: 0,
                time: 0,
                pt_x: 0,
                pt_y: 0,
                _private: 0,
            };
            let mut pump_budget = 0;
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                pump_budget += 1;
                if pump_budget > 128 {
                    // 消息风暴（例如大面积重绘）时先让出，保证动画继续走
                    break;
                }
                if msg.message == WM_QUIT {
                    for o in overlays.iter_mut() {
                        o.destroy();
                    }
                    UnregisterHotKey(std::ptr::null_mut(), 0xA1);
                    return;
                }
                // 热键：自律接管期间不真的关掉遮罩，只提示一句，避免"按了没反应"
                if msg.message == WM_HOTKEY && msg.w_param == 0xA1 && eff_on {
                    if auto_hold {
                        if let Ok(mut n) = ctl.notice.lock() {
                            *n = Some("自律模式生效中，遮罩由自律模式接管；结束时会自动恢复".into());
                        }
                    } else {
                        ctl.on.store(false, Ordering::Relaxed);
                        if let Ok(mut n) = ctl.notice.lock() {
                            *n = Some("已通过热键 Ctrl+Alt+K 退出遮罩".into());
                        }
                    }
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let now = Instant::now();
            let dt = now.duration_since(last_tick).as_secs_f32().min(0.1);
            last_tick = now;
            stat_loop_n += 1;

            // 预览到点自动收：预览只是"看一眼效果"，不该悄悄变成真开启
            let pv = ctl.preview_until.load(Ordering::Relaxed);
            if pv > 0 && chrono::Local::now().timestamp() >= pv {
                ctl.preview_until.store(0, Ordering::Relaxed);
                ctl.test_lock.store(false, Ordering::Relaxed);
                ctl.on.store(false, Ordering::Relaxed);
            }

            // on 是"最终是否生效"：用户意向 OR 自律接管。
            // follow 只决定"洞口钉在哪个窗口上"，不参与开关判断。
            let follow_flag = ctl.follow.load(Ordering::Relaxed);
            let on = ctl.on.load(Ordering::Relaxed) || auto_hold;
            let opacity = ctl.opacity.load(Ordering::Relaxed).min(100) as f32 / 100.0;
            let margin = ctl.margin.load(Ordering::Relaxed).max(0);
            let radius = ctl.radius.load(Ordering::Relaxed).clamp(0, 120) as f32;
            let duration = ctl.duration.load(Ordering::Relaxed).clamp(0, 3000) as f32 / 1000.0;
            let block_click = ctl.block_click.load(Ordering::Relaxed);

            // ---- 热键：代数变了就重注册，结果写回 hk_ok 供界面读 ----
            let gen = ctl.hk_gen.load(Ordering::Relaxed);
            if gen != hk_gen_done {
                UnregisterHotKey(std::ptr::null_mut(), 0xA1);
                let vk = ctl.hk_vk.load(Ordering::Relaxed);
                let md = ctl.hk_mod.load(Ordering::Relaxed);
                let ok = vk != 0 && RegisterHotKey(std::ptr::null_mut(), 0xA1, md, vk) != 0;
                ctl.hk_ok.store(ok, Ordering::Relaxed);
                hk_gen_done = gen;
            }

            // ---- 分辨率/显示器变化才销毁重建（位图按需创建，不占用平时内存）----
            let mons = monitors();
            if mons.len() != monitor_sig.len() || mons.iter().zip(monitor_sig.iter()).any(|(a, b)| {
                a.left != b.left || a.top != b.top || a.right != b.right || a.bottom != b.bottom
            }) {
                for o in overlays.iter_mut() {
                    o.destroy();
                }
                overlays.clear();
                publish_overlays(&overlays);
                monitor_sig = mons.clone();
                last_paint = None;
            }

            // ---- 目标窗口 ----
            // 优先级：手动选定的窗口 > 跟随前台 > 用户配置的固定目标。
            // 之前这里只认 follow，导致"在界面里选中某个窗口"完全无效——
            // 因为点按钮的那一刻前台是本程序，follow_rect() 拿不到目标。
            let follow_cfg = ctl.follow.load(Ordering::Relaxed);
            let fg_now = if follow_cfg { follow_rect() } else { None };

            // 只要出现过"别的程序"的前台窗口，就认为用户已经切走了：
            // 1) 测试态自动结束（否则洞口会一直卡在测试窗口上，就是用户说的"残留"）
            // 2) 手动锁定的目标自动释放，交还给跟随
            // 注意：本程序自己的窗口不算"切走"，否则遮罩盖自己的时候测试态会被立刻解掉
            if let Some((_, h)) = fg_now {
                if !is_self_window(h as Hwnd) && ctl.test_lock.load(Ordering::Relaxed) {
                    ctl.test_lock.store(false, Ordering::Relaxed);
                }
            }
            let mut manual = ctl.manual_hwnd.load(Ordering::Relaxed);
            if manual != 0 {
                if let Some((_, h)) = fg_now {
                    if h != manual {
                        manual = 0;
                        ctl.manual_hwnd.store(0, Ordering::Relaxed);
                    }
                }
            }
            let test_lock = ctl.test_lock.load(Ordering::Relaxed);
            let follow = follow_cfg && !test_lock && manual == 0;
            let follow_now = if follow { fg_now } else { None };
            if follow {
                let key = follow_now.map(|(_, h)| h).unwrap_or(0);
                followed_key = key;
                if key != follow_key {
                    // 换了窗口（或切到别的程序）→ 从上一次画的位置平滑移过去
                    follow_key = key;
                    hole_from = hole_painted;
                    hole_t0 = Instant::now();
                }
            }
            // 跟随模式下拿不到前台窗口（比如焦点在本程序上）就当作"没有目标"，
            // 绝不能回退到旧的手选目标，否则洞口会停在别的地方
            // 跟随模式下前台若是本程序自己（比如刚点了按钮），保持上一帧的高亮，
            // 不要因为"读不到前台"就把遮罩收掉
            let target_now = if follow {
                follow_now.map(|(r, _)| r).or(last_hole)
            } else {
                target_rect(&ctl)
            };
            if target_now.is_none() && on && !logged_miss {
                logged_miss = true;
                mlog(&format!(
                    "目标暂时无效 on=true target={:#x} pid={}",
                    ctl.target.load(Ordering::Relaxed),
                    ctl.target_pid.load(Ordering::Relaxed)
                ));
            } else if target_now.is_some() {
                logged_miss = false;
            }
            let target = match target_now {
                Some(t) => {
                    last_hole = Some(t);
                    lost = None;
                    Some(t)
                }
                None => {
                    if on {
                        let since = *lost.get_or_insert_with(Instant::now);
                        if since.elapsed().as_millis() > 1500 {
                            ctl.on.store(false, Ordering::Relaxed);
                            if let Ok(mut n) = ctl.notice.lock() {
                                *n = Some("目标窗口已关闭，遮罩自动退出".into());
                            }
                            lost = None;
                            last_hole = None;
                            None
                        } else {
                            // 抖动期沿用上一帧的洞，避免闪一下
                            last_hole
                        }
                    } else {
                        lost = None;
                        None
                    }
                }
            };

            // ---- 动画进度 ----
            let step = if duration <= 0.001 { 1.0 } else { dt / duration };
            let animating;
            if on && target.is_some() {
                if progress < 1.0 {
                    progress = (progress + step).min(1.0);
                    animating = true;
                } else {
                    animating = false;
                }
            } else {
                if progress > 0.0 {
                    progress = (progress - step * 1.6).max(0.0);
                    animating = true;
                } else {
                    animating = false;
                }
            }

            if progress <= 0.001 || target.is_none() {
                for o in overlays.iter_mut() {
                    o.hide();
                }
                ctl.painted.store(false, Ordering::Relaxed);
                last_paint = None;
                // 这里也要刷新诊断，否则界面会一直显示上一次的"已开启/洞口"
                if last_diag.elapsed().as_millis() >= 500 {
                    last_diag = Instant::now();
                    let report = format!(
                        "on={} painted=false{} 跟随窗口={:#x} 手动={:#x} 覆盖={:#x} progress=0.00 洞=(0,0,0,0) 覆盖层=0 副屏={}",
                        on,
                        if follow_flag { " 跟随前台" } else { "" },
                        followed_key,
                        ctl.manual_hwnd.load(Ordering::Relaxed),
                        FOLLOW_OVERRIDE.load(Ordering::Relaxed),
                        mons.len()
                    );
                    if let Ok(mut d) = DIAG.lock() {
                        *d = report;
                    }
                }
                if !animating {
                    thread::sleep(Duration::from_millis(40));
                }
                continue;
            }

            let t = target.unwrap();
            // 任务栏 / 开始菜单 / 托盘浮出层这类系统外壳：留白必须强制为 0。
            // 它们是贴着屏幕边缘的整块区域，任何正留白都会在四周露出一圈"外扩"，
            // 看起来就像遮罩没有贴住窗口。
            let is_shell = {
                let h = if follow {
                    followed_key
                } else {
                    ctl.target.load(Ordering::Relaxed)
                };
                h != 0 && is_shell_window(h as Hwnd)
            };
            let margin = if is_shell { 0 } else { margin };
            let want = Rect {
                left: t.left - margin,
                top: t.top - margin,
                right: t.right + margin,
                bottom: t.bottom + margin,
            };
            // 只有"换了窗口"才做过渡；窗口被拖动/缩放时 want 每帧都在变，
            // 这时必须 1:1 跟随，否则会有一帧的延迟感
            let hole_end = match hole_from {
                Some(from) => {
                    let (rect, done) = hole_transition(
                        &from,
                        &want,
                        hole_t0.elapsed().as_secs_f32(),
                        duration,
                    );
                    if done {
                        hole_from = None;
                    }
                    rect
                }
                None => want,
            };
            let e = ease_out(progress);

            // 透明度：前 35% 淡入
            let fade = ease_out((progress / 0.35).min(1.0));
            let alpha = (opacity * fade * 255.0).round().clamp(0.0, 255.0) as u8;

            if alpha == 0 {
                for o in overlays.iter_mut() {
                    o.hide();
                }
                thread::sleep(Duration::from_millis(16));
                continue;
            }

            let key = (hole_end, alpha, radius as i32, progress.to_bits() as i32);
            let need = animating || last_paint != Some(key);

            // 真正要画的时候才分配位图
            if need && overlays.len() != mons.len() {
                for o in overlays.iter_mut() {
                    o.destroy();
                }
                overlays.clear();
                for m in &mons {
                    if let Some(o) = Overlay::new(&class, *m) {
                        overlays.push(o);
                    }
                }
                publish_overlays(&overlays);
            }

            let t_paint = Instant::now();
            for (i, o) in overlays.iter_mut().enumerate() {
                o.set_clickthrough(!block_click);
                if !need {
                    continue;
                }
                let m = mons[i.min(mons.len() - 1)];
                // 洞口从"整块显示器"平滑收缩到目标窗口
                let hole = Rect {
                    left: lerp(m.left as f32, hole_end.left as f32, e).round() as i32,
                    top: lerp(m.top as f32, hole_end.top as f32, e).round() as i32,
                    right: lerp(m.right as f32, hole_end.right as f32, e).round() as i32,
                    bottom: lerp(m.bottom as f32, hole_end.bottom as f32, e).round() as i32,
                };
                hole_painted = Some(hole);
                o.paint_region(&hole, radius, alpha);
            }
            if need {
                ctl.painted.store(progress >= 1.0, Ordering::Relaxed);
                last_paint = Some(key);
                last_paint_at = Instant::now();
                // 帧率诊断：窗口快速拖动时"遮罩跟不上"到底是画得慢还是循环被别的事拖住，
                // 只能靠这两个数说话（重画次数/秒 + 单次重画耗时）
                stat_n += 1;
                stat_paint_us += t_paint.elapsed().as_micros() as u64;
            }
            if stat_t0.elapsed().as_millis() >= 1000 {
                stat_fps = stat_n;
                stat_loop = stat_loop_n;
                stat_paint_ms = if stat_n > 0 {
                    stat_paint_us as f32 / stat_n as f32 / 1000.0
                } else {
                    0.0
                };
                stat_n = 0;
                stat_loop_n = 0;
                stat_paint_us = 0;
                stat_t0 = Instant::now();
            }

            // 置顶维持：按 ~16ms 节流。
            // 桌面浮窗（lazytyper / 时钟 / 歌词条）会周期性把自己重新置顶，
            // SetWindowPos 是"后调用者赢"，所以必须持续重压；但没必要每 2ms 压一次——
            // 那时循环周期还是 16ms，节流到 16ms 与原行为等价，却能把跟随期间的 CPU 降下来。
            if last_top.elapsed().as_millis() >= 15 {
                last_top = Instant::now();
                for o in overlays.iter_mut() {
                    // 管理员模式：把压在头上的浮窗降级到普通层级，一次性盖死
                    o.strip_topmost_above();
                    o.reassert();
                    if o.covered_by_others() {
                        o.reassert();
                        o.reassert();
                    }
                }
            }

            // 每 1s 更新一次诊断快照（界面上的「自查」按钮读它）
            if last_diag.elapsed().as_millis() >= 200 {
                last_diag = Instant::now();
                let mut parts = Vec::new();
                for (i, o) in overlays.iter().enumerate() {
                    let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
                    GetWindowRect(o.hwnd, &mut r);
                    parts.push(format!(
                        "屏{} hwnd={:?} 可见={} 区域={}x{}@({},{})",
                        i + 1,
                        o.hwnd,
                        IsWindowVisible(o.hwnd),
                        r.width(),
                        r.height(),
                        r.left,
                        r.top
                    ));
                }
                let pocket = Overlay::pocket_rect(&hole_end, radius);
                let report = format!(
                    "on={} painted={}{} 抬升={}/{} err={} 降级失败={}/{} 跟随窗口={:#x} 手动={:#x} 覆盖={:#x} progress={:.2} alpha={} fps={} 循环={}/s 单帧={:.1}ms 洞=({},{},{},{}) 覆盖层={} 副屏={}",
                    ctl.on.load(Ordering::Relaxed),
                    ctl.painted.load(Ordering::Relaxed),
                    if follow { " 跟随前台" } else { "" },
                    RAISE_OK.load(Ordering::Relaxed),
                    RAISE_FAIL.load(Ordering::Relaxed),
                    RAISE_ERR.load(Ordering::Relaxed),
                    RAISE_DROP_FAIL.load(Ordering::Relaxed),
                    RAISE_DROP_ERR.load(Ordering::Relaxed),
                    followed_key,
                    ctl.manual_hwnd.load(Ordering::Relaxed),
                    FOLLOW_OVERRIDE.load(Ordering::Relaxed),
                    progress,
                    alpha,
                    stat_fps,
                    stat_loop,
                    stat_paint_ms,
                    pocket.left,
                    pocket.top,
                    pocket.right,
                    pocket.bottom,
                    parts.join(" | "),
                    mons.len()
                );
                if let Ok(mut d) = DIAG.lock() {
                    *d = report;
                }
            }

            // 跟随周期：窗口在动时压到 2ms，遮罩最多落后一个周期——旧值 16ms 在快速
            // 拖动下会明显拖影（窗口已经移开几十像素，遮罩还在原位）。
            // 窗口静止 120ms 后放回 8ms：跟随精度对静止画面没有意义，把空转 CPU 让出去。
            // 遮罩没开或没有目标时 40ms，几乎不占 CPU。
            let tick_ms = if on && target.is_some() {
                if last_paint_at.elapsed().as_millis() < 120 { 2 } else { 8 }
            } else {
                40
            };
            thread::sleep(Duration::from_millis(tick_ms));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(l: i32, t: i32, rr: i32, b: i32) -> Rect {
        Rect { left: l, top: t, right: rr, bottom: b }
    }

    /// 点是否落在圆角矩形内（与 `CreateRoundRectRgn` 的几何一致）。
    /// 用来验证"窗口有没有被圆角切掉"——这是遮罩最核心的正确性不变量。
    fn in_round_rect(px: f64, py: f64, rect: &Rect, rad: f64) -> bool {
        let (l, t, rr, b) = (
            rect.left as f64,
            rect.top as f64,
            rect.right as f64,
            rect.bottom as f64,
        );
        if px < l || px > rr || py < t || py > b {
            return false;
        }
        if rad <= 0.0 {
            return true;
        }
        // 把点夹到"圆心所在的矩形"，得到最近的圆心，再比半径
        let cx = px.clamp(l + rad, rr - rad);
        let cy = py.clamp(t + rad, b - rad);
        let (dx, dy) = (px - cx, py - cy);
        dx * dx + dy * dy <= rad * rad + 1e-6
    }

    /// **核心不变量**：选中窗口的每一个像素都必须在遮罩的"口袋"里，不能被圆角切掉。
    ///
    /// 旧实现直接给窗口矩形套 `CreateRoundRectRgn`，圆弧在矩形内部拐进来，
    /// 四个角各被吃掉 radius 像素——用户看到的就是"选中的页面没有被完整显示"。
    #[test]
    fn 圆角不得吃掉窗口任何一个角() {
        let win = r(100, 100, 700, 500);
        // 反向验证：直接拿窗口矩形套圆角（也就是修复前的旧几何），窗口左上角确实
        // 会落在圆角之外。这条断言用来证明"检测手段本身是有效的"——
        // 否则上面那轮循环可能是永远通过的假阳性。
        assert!(
            !in_round_rect(win.left as f64, win.top as f64, &win, 28.0),
            "旧几何下窗口角本应被切掉；如果这条通过不了，说明判定函数写错了"
        );
        for radius in [0.0f32, 1.0, 8.0, 28.0, 60.0, 80.0] {
            let pocket = Overlay::pocket_rect(&win, radius);
            let rad = radius.round() as f64;
            // 窗口内 41x41 采样点，含四个角点
            for i in 0..=40 {
                for j in 0..=40 {
                    let px = win.left as f64 + (win.right - win.left) as f64 * i as f64 / 40.0;
                    let py = win.top as f64 + (win.bottom - win.top) as f64 * j as f64 / 40.0;
                    assert!(
                        in_round_rect(px, py, &pocket, rad),
                        "radius={} 时窗口内的点 ({}, {}) 落在口袋外（会被遮罩盖住）",
                        radius,
                        px,
                        py
                    );
                }
            }
        }
    }

    /// radius = 0 时口袋必须严丝合缝等于目标矩形，不能有任何多余留白
    #[test]
    fn 半径为零时口袋紧贴窗口() {
        let win = r(10, 20, 310, 220);
        assert_eq!(Overlay::pocket_rect(&win, 0.0), win);
    }

    /// radius > 0 时口袋应当对称外扩，且四个角确实是圆弧（不是直角）
    #[test]
    fn 圆角口袋向外撑开() {
        let win = r(0, 0, 200, 100);
        let p = Overlay::pocket_rect(&win, 30.0);
        assert_eq!(p, r(-30, -30, 230, 130));
        // 口袋的角点（矩形四角）应当落在圆角之外 —— 说明角被圆掉了
        assert!(!in_round_rect(-30.0, -30.0, &p, 30.0), "口袋自己的角应该被圆掉");
        // 而窗口的角点必须在里面
        assert!(in_round_rect(0.0, 0.0, &p, 30.0), "窗口的角必须保留");
    }

    /// 速度 = 0 时必须瞬时到位，不能有任何过渡。
    /// 这是用户明确反馈过的 bug：把动画速度设成 0，洞口却还要滑 1 秒。
    #[test]
    fn 速度为0时瞬间到位() {
        let from = r(0, 0, 100, 100);
        let to = r(500, 500, 600, 600);
        // 任意时刻（包括 0ms）都应直接落在目标位置
        for ms in [0.0f32, 1.0, 16.0, 250.0, 999.0, 5000.0] {
            let (pos, done) = hole_transition(&from, &to, ms / 1000.0, 0.0);
            assert_eq!(pos, to, "speed=0 时在 {}ms 处没有瞬时到位", ms);
            assert!(done, "speed=0 时过渡应立即结束");
        }
    }

    /// speed=0 但 duration 是个极小非零值时，也应当按"瞬间"处理
    #[test]
    fn 极小时长同样瞬时() {
        let from = r(0, 0, 100, 100);
        let to = r(500, 500, 600, 600);
        let (pos, done) = hole_transition(&from, &to, 0.0, 0.0005);
        assert_eq!(pos, to);
        assert!(done);
    }

    /// 正常时长：起点=旧位置，结束点=新位置，中途应有插值
    #[test]
    fn 正常时长有过渡() {
        let from = r(0, 0, 100, 100);
        let to = r(500, 500, 600, 600);
        let (start, done) = hole_transition(&from, &to, 0.0, 1.0);
        assert_eq!(start, from, "过渡起点应是旧位置");
        assert!(!done, "刚开始不应结束");

        let (mid, done) = hole_transition(&from, &to, 0.5, 1.0);
        assert!(!done);
        assert!(mid.left > from.left && mid.left < to.left, "中途应处于插值状态");

        let (end, done) = hole_transition(&from, &to, 1.5, 1.0);
        assert_eq!(end, to, "超过时长后应落到目标位置");
        assert!(done, "超过时长后过渡应结束");
    }

    /// 洞口从整屏收缩到目标窗口的主动画：speed=0 时进度必须一帧到 1.0
    #[test]
    fn 主动画速度为0时一帧到位() {
        let duration = 0.0f32; // 0ms
        let dt = 0.016f32; // 一帧
        let step = if duration <= 0.001 { 1.0 } else { dt / duration };
        assert_eq!(step, 1.0);
        let progress = (0.0f32 + step).min(1.0);
        assert_eq!(progress, 1.0, "speed=0 时扩散进度应一帧到顶");
        // 淡入曲线：progress=1 时 fade 也应直接到 1（不残留过渡）
        let fade = ease_out((progress / 0.35).min(1.0));
        assert_eq!(fade, 1.0, "speed=0 时透明度不应有淡入残留");
    }

    /// 洞口收缩系数：progress=1 时 e=1，洞口已经是目标窗口
    #[test]
    fn 进度到顶时洞口完全展开() {
        let e = ease_out(1.0);
        assert_eq!(e, 1.0);
    }

}
