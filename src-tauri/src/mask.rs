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

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicU32, AtomicU8, Ordering};
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
const ULW_ALPHA: u32 = 0x0000_0002;
const DIB_RGB_COLORS: u32 = 0;

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
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_NOOWNERZORDER: u32 = 0x0200;

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
struct BitmapInfoHeader {
    bi_size: u32,
    bi_width: i32,
    bi_height: i32,
    bi_planes: u16,
    bi_bit_count: u16,
    bi_compression: u32,
    bi_size_image: u32,
    bi_x_pels: i32,
    bi_y_pels: i32,
    bi_clr_used: u32,
    bi_clr_important: u32,
}

#[repr(C)]
struct BitmapInfo {
    header: BitmapInfoHeader,
    colors: [u32; 3],
}

#[repr(C)]
struct Point {
    x: i32,
    y: i32,
}

#[repr(C)]
struct Size {
    cx: i32,
    cy: i32,
}

#[repr(C)]
struct BlendFunction {
    blend_op: u8,
    blend_flags: u8,
    source_constant_alpha: u8,
    alpha_format: u8,
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
    fn UpdateLayeredWindow(
        h: Hwnd,
        dst: Hdc,
        pt_dst: *const Point,
        size: *const Size,
        src: Hdc,
        pt_src: *const Point,
        color_key: u32,
        blend: *const BlendFunction,
        flags: u32,
    ) -> i32;
    fn SetWindowLongW(h: Hwnd, idx: i32, val: i32) -> i32;
    fn SetWindowPos(h: Hwnd, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetWindowLongW(h: Hwnd, idx: i32) -> i32;
    fn IsWindow(h: Hwnd) -> i32;
    fn GetForegroundWindow() -> Hwnd;
    fn IsWindowVisible(h: Hwnd) -> i32;
    fn IsIconic(h: Hwnd) -> i32;
    fn GetWindowRect(h: Hwnd, r: *mut Rect) -> i32;
    fn GetDC(h: Hwnd) -> Hdc;
    fn ReleaseDC(h: Hwnd, dc: Hdc) -> i32;
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

#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(dc: Hdc) -> Hdc;
    fn CreateDIBSection(
        dc: Hdc,
        bmi: *const BitmapInfo,
        usage: u32,
        bits: *mut *mut core::ffi::c_void,
        section: Handle,
        offset: u32,
    ) -> Handle;
    fn SelectObject(dc: Hdc, obj: Handle) -> Handle;
    fn DeleteObject(obj: Handle) -> i32;
    fn DeleteDC(dc: Hdc) -> i32;
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
    /// 进入指定应用时自动开启
    pub auto: AtomicBool,
    pub auto_apps: std::sync::Mutex<Vec<String>>,
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
            auto: AtomicBool::new(false),
            auto_apps: Mutex::new(Vec::new()),
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
struct Overlay {
    hwnd: Hwnd,
    mem_dc: Hdc,
    bmp: Handle,
    old_bmp: Handle,
    bits: *mut u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    clickthrough: bool,
    shown: bool,
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

        let screen = GetDC(std::ptr::null_mut());
        let mem_dc = CreateCompatibleDC(screen);
        let bmi = BitmapInfo {
            header: BitmapInfoHeader {
                bi_size: std::mem::size_of::<BitmapInfoHeader>() as u32,
                bi_width: r.width(),
                // 负高度 = 自上而下，和我们的绘制顺序一致
                bi_height: -r.height(),
                bi_planes: 1,
                bi_bit_count: 32,
                bi_compression: 0,
                bi_size_image: 0,
                bi_x_pels: 0,
                bi_y_pels: 0,
                bi_clr_used: 0,
                bi_clr_important: 0,
            },
            colors: [0; 3],
        };
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bmp = CreateDIBSection(screen, &bmi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
        ReleaseDC(std::ptr::null_mut(), screen);
        if bmp.is_null() {
            mlog(&format!("CreateDIBSection 失败 err={}", GetLastError()));
            DestroyWindow(hwnd);
            return None;
        }
        mlog(&format!(
            "Overlay 建立 hwnd={:?} {}x{} @({},{})",
            hwnd, r.width(), r.height(), r.left, r.top
        ));
        let old_bmp = SelectObject(mem_dc, bmp);

        Some(Overlay {
            hwnd,
            mem_dc,
            bmp,
            old_bmp,
            bits: bits as *mut u32,
            x: r.left,
            y: r.top,
            w: r.width(),
            h: r.height(),
            clickthrough: true,
            shown: false,
        })
    }

    unsafe fn destroy(&mut self) {
        if self.bmp != std::ptr::null_mut() {
            SelectObject(self.mem_dc, self.old_bmp);
            DeleteObject(self.bmp);
            self.bmp = std::ptr::null_mut();
        }
        if self.mem_dc != std::ptr::null_mut() {
            DeleteDC(self.mem_dc);
            self.mem_dc = std::ptr::null_mut();
        }
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

    /// 圆角矩形的"洞"在该行的水平区间；None 表示这一行没洞（整行遮住）
    fn span(row: i32, hole: &Rect, radius: f32, w: i32) -> Option<(i32, i32)> {
        let (top, bottom) = (hole.top as f32, hole.bottom as f32);
        let y = row as f32;
        if y < top || y >= bottom {
            return None;
        }
        let r = radius
            .max(0.0)
            .min((hole.width() as f32) / 2.0)
            .min((hole.height() as f32) / 2.0);
        let mut inset = 0.0f32;
        if r > 0.5 {
            let dy_top = y - top;
            if dy_top < r {
                let d = r - dy_top;
                inset = r - (r * r - d * d).max(0.0).sqrt();
            }
            let dy_bot = bottom - 1.0 - y;
            if dy_bot < r {
                let d = r - dy_bot;
                inset = inset.max(r - (r * r - d * d).max(0.0).sqrt());
            }
        }
        let x0 = (hole.left as f32 + inset).round() as i32;
        let x1 = (hole.right as f32 - inset).round() as i32;
        if x1 <= 0 || x0 >= w {
            return None;
        }
        Some((x0.max(0), x1.min(w)))
    }

    /// 把一块"遮罩 + 圆角洞"的位图画进 DIB 并提交给 DWM
    unsafe fn paint(&mut self, hole_screen: &Rect, radius: f32, alpha: u8) {
        let w = self.w;
        let h = self.h;
        if w <= 0 || h <= 0 || self.bits.is_null() {
            return;
        }
        // 洞换到本屏局部坐标
        let hole = Rect {
            left: hole_screen.left - self.x,
            top: hole_screen.top - self.y,
            right: hole_screen.right - self.x,
            bottom: hole_screen.bottom - self.y,
        };
        let px = (alpha as u32) << 24; // 预乘黑：B=G=R=0, A=alpha

        let buf = std::slice::from_raw_parts_mut(self.bits, (w as usize) * (h as usize));
        for row in 0..h {
            let line = &mut buf[(row as usize) * (w as usize)..(row as usize + 1) * (w as usize)];
            match Self::span(row, &hole, radius, w) {
                None => line.fill(px),
                Some((x0, x1)) => {
                    let a = x0.clamp(0, w) as usize;
                    let b = x1.clamp(0, w) as usize;
                    if a > 0 {
                        line[..a].fill(px);
                    }
                    if b < w as usize {
                        line[b..].fill(px);
                    }
                    // 洞内必须清成全透明：位图是复用的，不清会留下上一帧的"鬼影"
                    if b > a {
                        line[a..b].fill(0);
                    }
                }
            }
        }

        let pt_dst = Point { x: self.x, y: self.y };
        let size = Size { cx: w, cy: h };
        let pt_src = Point { x: 0, y: 0 };
        let blend = BlendFunction {
            blend_op: 0,
            blend_flags: 0,
            source_constant_alpha: 0,
            alpha_format: 1,
        };
        let ok = UpdateLayeredWindow(
            self.hwnd,
            std::ptr::null_mut(),
            &pt_dst,
            &size,
            self.mem_dc,
            &pt_src,
            0,
            &blend,
            ULW_ALPHA,
        );
        if !self.shown {
            // 回读位图，确认内容真的是「黑 + 洞」，而不是整块透明/整块黑
            let at = |x: i32, y: i32| -> u32 {
                if x < 0 || y < 0 || x >= w || y >= h {
                    return 0xFFFF_FFFF;
                }
                *self.bits.offset((y as isize) * (w as isize) + x as isize)
            };
            let cx = (hole.left + hole.right) / 2;
            let cy = (hole.top + hole.bottom) / 2;
            mlog(&format!(
                "首帧 ULW ok={} err={} size={}x{} alpha={} radius={:.0} hole=({},{},{},{})",
                ok, GetLastError(), w, h, alpha, radius,
                hole.left, hole.top, hole.right, hole.bottom
            ));
            mlog(&format!(
                "位图回读 角({},0)={:#010X} 洞心({},{})={:#010X} 洞左外={:#010X}",
                0, at(0, 0), cx, cy, at(cx, cy), at(hole.left - 8, cy)
            ));
            ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
            self.shown = true;
        }
    }

    /// 把遮罩重新顶到最上层。
    /// 后创建的其他置顶窗口（全屏视频、游戏启动器、某些输入法）会盖住我们，
    /// 所以运行期必须周期性重压一次，否则用户会看到「遮罩没生效」。
    unsafe fn reassert(&mut self) {
        if !self.shown {
            return;
        }
        if IsWindowVisible(self.hwnd) == 0 {
            ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
        }
        SetWindowPos(
            self.hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
    }

    unsafe fn hide(&mut self) {
        if self.shown {
            ShowWindow(self.hwnd, SW_HIDE);
            self.shown = false;
        }
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
    let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    if GetWindowRect(h, &mut r) == 0 || r.width() <= 0 || r.height() <= 0 {
        return None;
    }
    Some(r)
}

pub fn start(ctl: std::sync::Arc<MaskCtl>) {
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
            hbr_background: std::ptr::null_mut(),
            lpsz_menu_name: std::ptr::null(),
            lpsz_class_name: class.as_ptr(),
        };
        let rc = RegisterClassW(&wc);
        mlog(&format!("遮罩线程启动，RegisterClassW={} err={}", rc, GetLastError()));

        let mut overlays: Vec<Overlay> = Vec::new();
        let mut monitor_sig: Vec<Rect> = Vec::new();
        let mut progress: f32 = 0.0; // 0 = 无遮罩，1 = 完全铺开
        let mut last_paint: Option<(Rect, u8, i32, i32)> = None;
        let mut last_tick = Instant::now();
        let mut was_on = false;
        let mut hk_gen_done = 0u32;
        let mut auto_owned = false;
        let mut last_auto = Instant::now();
        let mut logged_miss = false;
        let mut lost: Option<Instant> = None;
        let mut last_hole: Option<Rect> = None;
        let mut last_top = Instant::now();
        let mut last_diag = Instant::now();

        loop {
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
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                if msg.message == WM_QUIT {
                    for o in overlays.iter_mut() {
                        o.destroy();
                    }
                    UnregisterHotKey(std::ptr::null_mut(), 0xA1);
                    return;
                }
                if msg.message == WM_HOTKEY && msg.w_param == 0xA1 && ctl.on.load(Ordering::Relaxed) {
                    ctl.on.store(false, Ordering::Relaxed);
                    if let Ok(mut n) = ctl.notice.lock() {
                        *n = Some("已通过热键 Ctrl+Alt+K 退出遮罩".into());
                    }
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let now = Instant::now();
            let dt = now.duration_since(last_tick).as_secs_f32().min(0.1);
            last_tick = now;

            let on = ctl.on.load(Ordering::Relaxed);
            let opacity = ctl.opacity.load(Ordering::Relaxed).min(100) as f32 / 100.0;
            let margin = ctl.margin.load(Ordering::Relaxed).max(0);
            let radius = ctl.radius.load(Ordering::Relaxed).clamp(0, 120) as f32;
            let duration = ctl.duration.load(Ordering::Relaxed).clamp(0, 2000) as f32 / 1000.0;
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

            // ---- 自动触发：前台切到指定应用就开，切走就关 ----
            if last_auto.elapsed().as_millis() >= 200 {
                last_auto = Instant::now();
                if ctl.auto.load(Ordering::Relaxed) {
                    let apps = ctl.auto_apps.lock().map(|v| v.clone()).unwrap_or_default();
                    let mut hit: Option<(Hwnd, u32)> = None;
                    if !apps.is_empty() {
                        let fg = GetForegroundWindow();
                        if !fg.is_null() {
                            let mut pid = 0u32;
                            GetWindowThreadProcessId(fg, &mut pid);
                            if pid != 0 {
                                let path = crate::proc::exe_path(pid);
                                let name = if path.is_empty() {
                                    String::new()
                                } else {
                                    crate::proc::stem(&path)
                                };
                                if !name.is_empty()
                                    && apps.iter().any(|a| a.eq_ignore_ascii_case(&name))
                                {
                                    hit = Some((fg, pid));
                                }
                            }
                        }
                    }
                    match hit {
                        Some((h, pid)) => {
                            if ctl.target_pid.load(Ordering::Relaxed) != pid || !ctl.on.load(Ordering::Relaxed) {
                                ctl.target.store(h as isize, Ordering::Relaxed);
                                ctl.target_pid.store(pid, Ordering::Relaxed);
                                ctl.on.store(true, Ordering::Relaxed);
                                auto_owned = true;
                            }
                        }
                        None => {
                            // 切到别的应用 / 退出该应用 → 收掉自己开的遮罩
                            if auto_owned && ctl.on.load(Ordering::Relaxed) {
                                ctl.on.store(false, Ordering::Relaxed);
                            }
                            auto_owned = false;
                        }
                    }
                } else {
                    auto_owned = false;
                }
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
                monitor_sig = mons.clone();
                last_paint = None;
            }

            // ---- 目标窗口（允许短暂抖动：目标切走/最小化 1.5 秒内不退出）----
            let target_now = target_rect(&ctl);
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
            was_on = on;

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
                if !animating {
                    thread::sleep(Duration::from_millis(40));
                }
                continue;
            }

            let t = target.unwrap();
            let hole_end = Rect {
                left: t.left - margin,
                top: t.top - margin,
                right: t.right + margin,
                bottom: t.bottom + margin,
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
            }

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
                o.paint(&hole, radius, alpha);
            }
            if need {
                ctl.painted.store(progress >= 1.0, Ordering::Relaxed);
                last_paint = Some(key);
            }

            // 每 500ms 把遮罩重新压到最上层：别的置顶窗口抢不过就重压
            if last_top.elapsed().as_millis() >= 500 {
                last_top = Instant::now();
                for o in overlays.iter_mut() {
                    o.reassert();
                }
            }

            // 每 1s 更新一次诊断快照（界面上的「自查」按钮读它）
            if last_diag.elapsed().as_millis() >= 1000 {
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
                    "on={} painted={} progress={:.2} alpha={} 洞=({},{},{},{}) 覆盖层={} 副屏={}",
                    ctl.on.load(Ordering::Relaxed),
                    ctl.painted.load(Ordering::Relaxed),
                    progress,
                    alpha,
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

            thread::sleep(Duration::from_millis(16));
        }
    });
}
