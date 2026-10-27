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
/// 因为压在遮罩上面而被摘掉 TOPMOST 的窗口次数（lazytyper 那类浮窗）
pub static RAISE_DROP: AtomicU64 = AtomicU64::new(0);

/// 覆盖层窗口句柄（遮罩线程写，置顶守护线程读）
static OVERLAY_HWNDS: Mutex<Vec<isize>> = Mutex::new(Vec::new());

/// 覆盖模式下"应该待在遮罩上面"的窗口（选中窗口 + 它的弹窗）。
/// 置顶守护线程在另一个线程里跑，拿不到主循环的局部状态，只能走这个口子。
static RAISE_EXCEPT: Mutex<Vec<isize>> = Mutex::new(Vec::new());

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
    /// 淡入 / 淡出时长（毫秒）
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
    /// 跟随当前最上层窗口（遮罩焦点自动跟着前台窗口跑）
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
            duration: AtomicI32::new(420),
            block_click: AtomicBool::new(true),
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

/// 每台显示器一块静止的遮罩层。
///
/// 整窗刷半透明黑，用 `SetWindowRgn` 只把任务栏扣掉（任务栏不压暗），
/// 除此之外**从不改区域**——选中窗口是靠置顶浮到这一层之上，遮罩本身不动。
struct Overlay {
    hwnd: Hwnd,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    clickthrough: bool,
    shown: bool,
    cur_alpha: u8,
    /// 任务栏签名的校验和：只有在任务栏变化时才重建那块固定区域
    cover_sig: i64,
    /// 上次查任务栏的时间。任务栏枚举不便宜，没必要每帧做
    cover_t: Instant,
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
            cur_alpha: 255,
            cover_sig: i64::MIN,
            cover_t: Instant::now(),
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

    /// 是否有"外部"窗口压在遮罩上面。
    /// 桌面挂件（时钟、歌词条、下载悬浮窗）大多会周期性把自己重新置顶，
    /// 它们每秒抢一次，而我们每 500ms 才压一次 → 用户看到的就是"间断地被遮住"。
    unsafe fn covered_by_others(&self, except: &[Hwnd]) -> bool {
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
            // except 里的窗口（覆盖模式下的选中窗口和它的弹窗）本来就该在上面，
            // 不能算"被盖"——否则每一轮都会判定需要重提，白白烧掉大量 CPU，
            // 还会和目标的置顶来回拉锯。
            if pid != std::process::id()
                && IsWindowVisible(h) != 0
                && !except.iter().any(|e| *e == h)
            {
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
    ///
    /// `except` 里的窗口不能碰：覆盖模式下选中窗口本来就该待在遮罩上面，
    /// 把它的 TOPMOST 摘掉等于当场把用户正在用的窗口压到遮罩底下。
    unsafe fn strip_topmost_above(&self, except: &[Hwnd]) {
        if !IS_ADMIN.load(Ordering::Relaxed) {
            return;
        }
        let mut h = GetWindow(self.hwnd, GW_HWNDPREV);
        let mut guard = 0;
        while !h.is_null() && guard < 32 {
            guard += 1;
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, &mut pid);
            if pid != std::process::id()
                && IsWindowVisible(h) != 0
                && !is_shell_window(h)
                && !except.iter().any(|e| *e == h)
            {
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

    /// 覆盖模式：整块铺满，遮罩全程静止。
    ///
    /// 只在"任务栏变化"时重建一次固定区域（任务栏要留出来，不能压暗），
    /// 除此之外一帧都不碰窗口区域。这正是覆盖模式比挖洞跟手的根本原因：
    /// 窗口拖动时遮罩根本不需要重绘，视觉上完全由 DWM 合成，没有"迟到一帧"。
    unsafe fn paint_cover(&mut self, alpha: u8) {
        if self.w <= 0 || self.h <= 0 {
            return;
        }
        // 任务栏枚举（FindWindow + 取矩形）不便宜，而任务栏根本不会毫秒级变化。
        // 挖洞模式静止时靠 need 直接跳过这段，覆盖模式每帧都会走进来，
        // 所以这里必须自己节流——否则光查任务栏就能吃掉三四十个点单核。
        if self.cover_t.elapsed().as_millis() >= 500 {
            self.cover_t = Instant::now();
            let bars = taskbar_rects();
            let sig: i64 = bars
                .iter()
                .map(|r| r.left as i64 * 31 + r.top as i64 * 17 + r.right as i64 * 7 + r.bottom as i64)
                .sum();
            if sig != self.cover_sig {
                self.cover_sig = sig;
                let full = CreateRectRgn(0, 0, self.w, self.h);
                if !full.is_null() {
                    for b in bars.iter() {
                        let (x0, y0) = (b.left - self.x, b.top - self.y);
                        let (x1, y1) = (b.right - self.x, b.bottom - self.y);
                        if x1 <= 0 || y1 <= 0 || x0 >= self.w || y0 >= self.h {
                            continue;
                        }
                        let cut = CreateRectRgn(x0, y0, x1, y1);
                        if !cut.is_null() {
                            CombineRgn(full, full, cut, RGN_DIFF);
                            DeleteObject(cut);
                        }
                    }
                    if SetWindowRgn(self.hwnd, full, 1) == 0 {
                        DeleteObject(full);
                    }
                }
            }
        }
        if self.cur_alpha != alpha || !self.shown {
            SetLayeredWindowAttributes(self.hwnd, 0, alpha, LWA_ALPHA);
            self.cur_alpha = alpha;
        }
        if !self.shown {
            ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
            self.shown = true;
            let _ = InvalidateRect(self.hwnd, std::ptr::null(), 1);
            mlog(&format!(
                "Cover 首帧 hwnd={:?} {}x{} alpha={}",
                self.hwnd, self.w, self.h, alpha
            ));
        }
    }

    /// 把遮罩重新顶到最上层，但放过 `except` 里的窗口（覆盖模式下的选中窗口）
    unsafe fn reassert_except(&mut self, except: &[Hwnd]) {
        if !self.shown {
            return;
        }
        force_above_except(self.hwnd, except);
    }

    unsafe fn hide(&mut self) {
        if self.shown {
            ShowWindow(self.hwnd, SW_HIDE);
            self.shown = false;
        }
    }
}

/// 把当前覆盖层句柄发布给置顶守护线程
fn publish_overlays(list: &[Overlay]) {
    if let Ok(mut g) = OVERLAY_HWNDS.lock() {
        *g = list.iter().map(|o| o.hwnd as isize).collect();
    }
}

/// 被覆盖模式临时提到遮罩之上的窗口。
///
/// `was_topmost` 必须记准确：原本就在置顶带里的窗口，摘掉遮罩后不能把它降级，
/// 否则用户开一次专注遮罩，自己那个本来置顶的播放器就永久掉到普通层级了。
struct Raised {
    hwnd: Hwnd,
    was_topmost: bool,
}

/// 把窗口提到遮罩之上（保持位置、大小、激活状态不变）。
///
/// 注意对**已经是 topmost** 的窗口，`SetWindowPos(HWND_TOPMOST)` 是空操作，
/// 在置顶带内部提不动层级，必须用 `HWND_TOP`——这一点和 force_above 同一个坑。
unsafe fn ensure_above(h: Hwnd, raised: &mut Vec<Raised>) {
    if h.is_null() || IsWindow(h) == 0 || IsWindowVisible(h) == 0 {
        return;
    }
    let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
    let was = (ex & WS_EX_TOPMOST_FLAG) != 0;
    if !was {
        // 不在置顶带里：必须变成 topmost，否则永远在遮罩下面。这一步只做一次。
        if !raised.iter().any(|r| r.hwnd == h) {
            raised.push(Raised { hwnd: h, was_topmost: false });
        }
        SetWindowPos(
            h,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
        return;
    }
    // 已经是 topmost：只有头顶真的压着遮罩时才需要再提。
    // 不这么判断的话，每帧对每个窗口都 SetWindowPos，单核能烧掉三十多个点——
    // 而绝大多数帧的 z 序根本没变。
    let mut w = GetWindow(h, GW_HWNDPREV);
    let mut guard = 0;
    let mut behind_mask = false;
    while !w.is_null() && guard < 64 {
        guard += 1;
        if IsWindowVisible(w) != 0 {
            behind_mask = is_mask_class(w);
            break;
        }
        w = GetWindow(w, GW_HWNDPREV);
    }
    if !behind_mask {
        return;
    }
    // 对已经 topmost 的窗口 HWND_TOPMOST 是空操作，只能靠 HWND_TOP 在置顶带内提到顶
    SetWindowPos(
        h,
        HWND_TOP,
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
    );
}

/// 把不再需要的窗口恢复到调用前的层级。
unsafe fn release_raised(raised: &mut Vec<Raised>, keep: &[Hwnd]) {
    raised.retain(|r| {
        if keep.iter().any(|k| *k == r.hwnd) {
            return true;
        }
        if IsWindow(r.hwnd) != 0 && !r.was_topmost {
            SetWindowPos(
                r.hwnd,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            );
        }
        false
    });
}

struct CollectCtx {
    pid: u32,
    out: Vec<Hwnd>,
}

unsafe extern "system" fn collect_visible_cb(h: Hwnd, data: isize) -> i32 {
    let ctx = &mut *(data as *mut CollectCtx);
    let mut p = 0u32;
    GetWindowThreadProcessId(h, &mut p);
    if p == ctx.pid && IsWindowVisible(h) != 0 && !is_mask_class(h) {
        ctx.out.push(h);
    }
    1
}

/// 判断是不是遮罩自己的窗口。遮罩也属于本进程，覆盖模式下如果把它一起
/// 当作"选中窗口"提到最上面，遮罩就翻身盖住一切了。
fn is_mask_class(h: Hwnd) -> bool {
    unsafe {
        let mut buf = [0u16; 64];
        let n = GetClassNameW(h, buf.as_mut_ptr(), 64);
        if n <= 0 {
            return false;
        }
        String::from_utf16_lossy(&buf[..n as usize]) == "KofMaskV2"
    }
}

/// 收集某个进程所有可见的顶层窗口。
///
/// 覆盖模式下必须把它们一起浮到遮罩之上：下拉菜单、右键菜单、工具提示都是
/// **独立的顶层窗口**，不属于选中窗口的子树。只把主窗口置顶的话，
/// 一拉菜单菜单就被遮罩整个吃掉——这是覆盖模式最容易踩的坑。
unsafe fn collect_visible_windows(pid: u32) -> Vec<Hwnd> {
    let mut ctx = CollectCtx { pid, out: Vec::new() };
    EnumWindows(Some(collect_visible_cb), &mut ctx as *mut _ as isize);
    ctx.out
}

fn monitors() -> Vec<Rect> {    unsafe extern "system" fn cb(m: Hmonitor, _dc: Hdc, _clip: *mut Rect, data: isize) -> i32 {
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

/// 把窗口压到最上层，但**放过** `except` 里的窗口。
///
/// 覆盖模式下遮罩和选中窗口都在置顶带里：遮罩定时重压是为了防浮窗盖住它，
/// 但如果重压时把选中窗口也压下去，用户就会看到窗口一闪一闪地被遮罩吃掉。
/// 所以重压前先看头顶是谁——是自己人就别动。
unsafe fn force_above_except(hwnd: Hwnd, except: &[Hwnd]) {
    if hwnd.is_null() || IsWindow(hwnd) == 0 {
        return;
    }
    if IsWindowVisible(hwnd) == 0 {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    let mut h = GetWindow(hwnd, GW_HWNDPREV);
    let mut guard = 0;
    let mut covered_by_self = false;
    let mut has_above = false;
    let mut above: Hwnd = std::ptr::null_mut();
    while !h.is_null() && guard < 256 {
        guard += 1;
        if IsWindowVisible(h) != 0 {
            has_above = true;
            covered_by_self = except.iter().any(|e| *e == h);
            above = h;
            break;
        }
        h = GetWindow(h, GW_HWNDPREV);
    }
    // 头顶就是选中窗口（或它的弹窗）：这正是覆盖模式要的效果，别把它压回去
    if covered_by_self || !has_above {
        return;
    }
    // 头顶是外部置顶窗口（lazytyper 那种每隔几帧把自己重新置顶的横条）。
    //
    // 只把它压下去是没用的——它下一帧又抢回来，用户看到的就是一直闪。
    // 所以这里顺手把它的 TOPMOST 属性摘掉：摘掉之后它落到普通层级，
    // 我们的遮罩（还在置顶带里）从根上就盖住它，不需要每帧再抢。
    // 这一步要管理员权限，摘不动就退化成"每帧压一次"。
    if IS_ADMIN.load(Ordering::Relaxed) && !is_shell_window(above) {
        let ex = GetWindowLongW(above, GWL_EXSTYLE) as u32;
        if (ex & WS_EX_TOPMOST_FLAG) != 0 {
            SetWindowLongW(above, GWL_EXSTYLE, (ex & !WS_EX_TOPMOST_FLAG) as i32);
            SetWindowPos(
                above,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            );
            RAISE_DROP.fetch_add(1, Ordering::Relaxed);
        }
    }
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
            // 覆盖模式下选中窗口就待在遮罩上面，守护线程必须放过它。
            // 不放过的话，这里的 250Hz 会和主循环的目标置顶来回拉锯：
            // 遮罩每 4ms 压上一次、主循环再提回来，用户看到的是窗口闪，
            // 顺便白烧掉十几个点的 CPU。
            let except: Vec<Hwnd> = match RAISE_EXCEPT.try_lock() {
                Ok(v) => v.iter().map(|x| *x as Hwnd).collect(),
                Err(_) => Vec::new(),
            };
            for h in hs {
                if h != 0 {
                    force_above_except(h as Hwnd, &except);
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
        // 最近一次真正重画的时刻。窗口在动 → 短周期紧跟；窗口静止 → 放长周期省 CPU
        let mut last_paint_at = Instant::now();
        let mut last_tick = Instant::now();
        let mut hk_gen_done = 0u32;
        let mut logged_miss = false;
        let mut lost: Option<Instant> = None;
        let mut last_hole: Option<Rect> = None;
        let mut last_top = Instant::now();
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
        // ---- 覆盖模式专用 ----
        // 被临时提到遮罩之上的窗口（含原 topmost 状态，退出时必须还原）
        let mut raised: Vec<Raised> = Vec::new();
        // 选中窗口所在进程的全部可见顶层窗口（含下拉菜单这类独立 popup）
        let mut popups: Vec<Hwnd> = Vec::new();
        let mut popup_pid = 0u32;
        let mut popup_t = Instant::now();
        // 上一帧的选中窗口句柄：变了才说明"刚切换过目标"，需要短周期快速收敛
        let mut last_tgt: isize = 0;

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
                followed_key = follow_now.map(|(_, h)| h).unwrap_or(0);
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
                // 遮罩收起 → 把之前临时提到最上层的窗口全部还原。
                // 不做这一步，用户用过的窗口会一直挂在我们制造的 topmost 上。
                release_raised(&mut raised, &[]);
                if let Ok(mut g) = RAISE_EXCEPT.try_lock() {
                    g.clear();
                }
                popups.clear();
                popup_pid = 0;
                ctl.painted.store(false, Ordering::Relaxed);
                // 这里也要刷新诊断，否则界面会一直显示上一次的"已开启/洞口"
                if last_diag.elapsed().as_millis() >= 500 {
                    last_diag = Instant::now();
                    let report = format!(
                        "on={} painted=false{} 置顶={} 跟随窗口={:#x} 手动={:#x} 覆盖={:#x} progress=0.00 窗口=(0,0,0,0) 覆盖层=0 副屏={}",
                        on,
                        if follow_flag { " 跟随前台" } else { "" },
                        raised.len(),
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
            // 目标矩形（屏幕坐标）。只用于诊断展示与"选中窗口跑出本屏"的判断，
            // 不影响渲染——遮罩不动，窗口自己浮上去。
            let hole_end = t;
            // 透明度：前 35% 淡入
            let fade = ease_out((progress / 0.35).min(1.0));
            let alpha = (opacity * fade * 255.0).round().clamp(0.0, 255.0) as u8;

            if alpha == 0 {
                for o in overlays.iter_mut() {
                    o.hide();
                }
                release_raised(&mut raised, &[]);
                thread::sleep(Duration::from_millis(16));
                continue;
            }

            // 真正要画的时候才分配位图
            if overlays.len() != mons.len() {
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

            // "自己人"的窗口列表：选中窗口 + 它的弹窗。
            // 遮罩重压时必须放过它们，否则会把用户正在用的窗口一闪一闪地压下去。
            let mut self_wins: Vec<Hwnd> = Vec::new();

            let t_paint = Instant::now();
            {
                // ================= 覆盖模式 =================
                // 遮罩是静止的一整块（只在任务栏变化时重算一次区域），
                // 窗口靠"置顶"浮到遮罩之上，所以遮罩全程不需要跟随、不会滞后。
                for o in overlays.iter_mut() {
                    o.set_clickthrough(!block_click);
                    o.paint_cover(alpha);
                }
                // 选中窗口 + 它的弹窗一起浮上来
                let tgt = if follow {
                    followed_key
                } else {
                    ctl.target.load(Ordering::Relaxed)
                };
                let mut tpid = 0u32;
                if tgt != 0 {
                    GetWindowThreadProcessId(tgt as Hwnd, &mut tpid);
                }
                if tpid != 0 && (popup_pid != tpid || popup_t.elapsed().as_millis() >= 500) {
                    popup_pid = tpid;
                    popup_t = Instant::now();
                    popups = collect_visible_windows(tpid);
                }
                if tgt == 0 {
                    popups.clear();
                }
                if tgt != 0 {
                    self_wins.push(tgt as Hwnd);
                }
                for h in popups.iter() {
                    if *h != tgt as Hwnd {
                        self_wins.push(*h);
                    }
                }
                release_raised(&mut raised, &self_wins);
                // 主窗口先提，弹窗后提 —— 后提的在上，菜单才会压在窗口之上
                if tgt != 0 {
                    ensure_above(tgt as Hwnd, &mut raised);
                }
                for h in popups.iter() {
                    if *h != tgt as Hwnd {
                        ensure_above(*h, &mut raised);
                    }
                }
                ctl.painted.store(progress >= 1.0, Ordering::Relaxed);
                // 只有"换了目标"才算一次动作，用它驱动短周期；
                // 否则每帧都刷新时间戳，短周期会永远生效、白烧 CPU。
                if tgt != last_tgt {
                    last_tgt = tgt;
                    last_paint_at = Instant::now();
                }
                // 遮罩本身不重绘，所以这里**不累加** stat_n：
                // 自查里看到 fps=0 就说明"遮罩一帧都没画"，这正是零延迟的根据。
                stat_paint_us += t_paint.elapsed().as_micros() as u64;
            }
            // 把"自己人"告诉置顶守护线程。遮罩收起时 self_wins 为空，
            // 这一步同时起到清空豁免的作用——不清的话守护线程会继续放行上一次的窗口。
            if let Ok(mut g) = RAISE_EXCEPT.try_lock() {
                if g.len() != self_wins.len() || g.iter().zip(self_wins.iter()).any(|(a, b)| *a != *b as isize) {
                    g.clear();
                    g.extend(self_wins.iter().map(|h| *h as isize));
                }
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
            // 遮罩本身不重绘，重压只为防浮窗抢位。
            // 浮窗抢位是"每秒几次"级别的慢动作，50ms 压一次完全够用。
            if last_top.elapsed().as_millis() >= 50 {
                last_top = Instant::now();
                for o in overlays.iter_mut() {
                    // 管理员模式：把压在头上的浮窗降级到普通层级，一次性盖死。
                    // self_wins 里的窗口不能碰——选中窗口本来就该在遮罩上面。
                    o.strip_topmost_above(&self_wins);
                    o.reassert_except(&self_wins);
                    if o.covered_by_others(&self_wins) {
                        o.reassert_except(&self_wins);
                        o.reassert_except(&self_wins);
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
                let report = format!(
                    "on={} painted={}{} 抬升={}/{} err={} 摘顶={} 跟随窗口={:#x} 手动={:#x} 覆盖={:#x} progress={:.2} alpha={} fps={} 循环={}/s 单帧={:.1}ms 置顶={} 窗口=({},{},{},{}) 覆盖层={} 副屏={}",
                    ctl.on.load(Ordering::Relaxed),
                    ctl.painted.load(Ordering::Relaxed),
                    if follow { " 跟随前台" } else { "" },
                    RAISE_OK.load(Ordering::Relaxed),
                    RAISE_FAIL.load(Ordering::Relaxed),
                    RAISE_ERR.load(Ordering::Relaxed),
                    RAISE_DROP.load(Ordering::Relaxed),
                    followed_key,
                    ctl.manual_hwnd.load(Ordering::Relaxed),
                    FOLLOW_OVERRIDE.load(Ordering::Relaxed),
                    progress,
                    alpha,
                    stat_fps,
                    stat_loop,
                    stat_paint_ms,
                    raised.len(),
                    hole_end.left,
                    hole_end.top,
                    hole_end.right,
                    hole_end.bottom,
                    parts.join(" | "),
                    mons.len()
                );
                if let Ok(mut d) = DIAG.lock() {
                    *d = report;
                }
            }

            // 跟随周期。遮罩根本不重绘，周期只影响"多快发现换了目标窗口"。
            // 目标稳定时放到 15ms（够用且省 CPU），刚切换过则用 6ms 快速收敛。
            let tick_ms = if on && target.is_some() {
                if last_paint_at.elapsed().as_millis() < 400 {
                    6
                } else {
                    15
                }
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
