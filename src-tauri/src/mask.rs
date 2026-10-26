//! 专注遮罩（Focus Mask）
//!
//! 技术方案：不用全屏逐像素重绘，而是用 4 块 `WS_EX_LAYERED` 纯黑分层窗口
//! 环绕目标窗口（上/下/左/右四条），只做 SetWindowPos 位移。
//! 好处：拖动/缩放窗口时零重绘开销、天然支持多显示器与任意 DPI，
//! 透明度通过 `SetLayeredWindowAttributes(LWA_ALPHA)` 由 DWM 合成，几乎不吃 GPU/CPU。

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU8, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

type Handle = *mut core::ffi::c_void;
type Hwnd = *mut core::ffi::c_void;

const SM_XVIRTUALSCREEN: i32 = 76;
const SM_YVIRTUALSCREEN: i32 = 77;
const SM_CXVIRTUALSCREEN: i32 = 78;
const SM_CYVIRTUALSCREEN: i32 = 79;

const WS_POPUP: u32 = 0x8000_0000;
const WS_EX_LAYERED: u32 = 0x0008_0000;
const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
const WS_EX_TOPMOST: u32 = 0x0000_0008;

const LWA_ALPHA: u32 = 0x0000_0002;
const HWND_TOPMOST: isize = -1;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_SHOWWINDOW: u32 = 0x0040;
const SWP_NOZORDER: u32 = 0x0004;
const SW_HIDE: i32 = 0;

const PM_REMOVE: u32 = 0x0001;
const WM_QUIT: u32 = 0x0012;
const WM_HOTKEY: u32 = 0x0312;
const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const VK_K: u32 = 0x4B;

#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
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
    // 私有字段占位（真实结构在 64 位下有 lPrivate）
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

#[link(name = "user32")]
extern "system" {
    fn RegisterClassW(wc: *const WndClassW) -> u16;
    fn CreateWindowExW(
        ex_style: u32,
        class_name: *const u16,
        window_name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: Hwnd,
        menu: Handle,
        instance: Handle,
        param: *mut core::ffi::c_void,
    ) -> Hwnd;
    fn DefWindowProcW(h: Hwnd, msg: u32, wp: usize, lp: isize) -> isize;
    fn SetLayeredWindowAttributes(h: Hwnd, key: u32, alpha: u8, flags: u32) -> i32;
    fn SetWindowPos(h: Hwnd, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn ShowWindow(h: Hwnd, cmd: i32) -> i32;
    fn IsWindow(h: Hwnd) -> i32;
    fn IsWindowVisible(h: Hwnd) -> i32;
    fn IsIconic(h: Hwnd) -> i32;
    fn GetWindowRect(h: Hwnd, r: *mut Rect) -> i32;
    fn GetSystemMetrics(idx: i32) -> i32;
    fn PeekMessageW(m: *mut Msg, h: Hwnd, min: u32, max: u32, remove: u32) -> i32;
    fn TranslateMessage(m: *const Msg) -> i32;
    fn DispatchMessageW(m: *const Msg) -> isize;
    fn RegisterHotKey(h: Hwnd, id: i32, modifiers: u32, vk: u32) -> i32;
    fn UnregisterHotKey(h: Hwnd, id: i32) -> i32;
    fn EnumWindows(cb: Option<unsafe extern "system" fn(Hwnd, isize) -> i32>, lparam: isize) -> i32;
    fn GetWindowThreadProcessId(h: Hwnd, pid: *mut u32) -> u32;
    fn GetWindowLongW(h: Hwnd, idx: i32) -> i32;
    fn SetWindowLongW(h: Hwnd, idx: i32, val: i32) -> i32;
    fn GetWindowTextLengthW(h: Hwnd) -> i32;
    fn SetProcessDpiAwarenessContext(ctx: isize) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> Handle;
}

#[link(name = "gdi32")]
extern "system" {
    fn GetStockObject(idx: i32) -> Handle;
}

const GWL_EXSTYLE: i32 = -20;
const BLACK_BRUSH: i32 = 4;

unsafe extern "system" fn wnd_proc(h: Hwnd, msg: u32, wp: usize, lp: isize) -> isize {
    DefWindowProcW(h, msg, wp, lp)
}

/// 遮罩运行期状态（与 UI 线程共享）
pub struct MaskCtl {
    pub on: AtomicBool,
    pub target: AtomicI32,
    pub target_pid: AtomicU32,
    pub opacity: AtomicU8,
    pub margin: AtomicI32,
    pub block_click: AtomicBool,
    pub hotkey: AtomicBool,
    /// 一次性提示（目标窗口关闭等）
    pub notice: Mutex<Option<String>>,
    /// 当前是否已真正铺开
    pub painted: AtomicBool,
}

impl Default for MaskCtl {
    fn default() -> Self {
        MaskCtl {
            on: AtomicBool::new(false),
            target: AtomicI32::new(0),
            target_pid: AtomicU32::new(0),
            opacity: AtomicU8::new(88),
            margin: AtomicI32::new(6),
            block_click: AtomicBool::new(false),
            hotkey: AtomicBool::new(true),
            notice: Mutex::new(None),
            painted: AtomicBool::new(false),
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn find_by_pid(pid: u32) -> Hwnd {
    unsafe extern "system" fn cb(h: Hwnd, lp: isize) -> i32 {
        let target = &mut *(lp as *mut (u32, Hwnd));
        if IsWindowVisible(h) == 0 || GetWindowTextLengthW(h) == 0 {
            return 1;
        }
        let mut p: u32 = 0;
        GetWindowThreadProcessId(h, &mut p);
        if p == target.0 {
            target.1 = h;
            return 0; // 找到就停
        }
        1
    }
    let mut ctx: (u32, Hwnd) = (pid, std::ptr::null_mut());
    EnumWindows(Some(cb), &mut ctx as *mut (u32, Hwnd) as isize);
    ctx.1
}

struct Bands {
    win: [Hwnd; 4],
    visible: bool,
    alpha: u8,
    clickthrough: bool,
}

impl Bands {
    unsafe fn create() -> Bands {
        let hinst = GetModuleHandleW(std::ptr::null());
        let class = wide("KofMaskBand");
        let wc = WndClassW {
            style: 0,
            lpfn_wnd_proc: Some(wnd_proc),
            cb_cls_extra: 0,
            cb_wnd_extra: 0,
            h_instance: hinst,
            h_icon: std::ptr::null_mut(),
            h_cursor: std::ptr::null_mut(),
            hbr_background: GetStockObject(BLACK_BRUSH),
            lpsz_menu_name: std::ptr::null(),
            lpsz_class_name: class.as_ptr(),
        };
        RegisterClassW(&wc);

        let mut win = [std::ptr::null_mut(); 4];
        for i in 0..4 {
            let ex = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST
                | WS_EX_TRANSPARENT;
            let h = CreateWindowExW(
                ex,
                class.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                hinst,
                std::ptr::null_mut(),
            );
            if !h.is_null() {
                SetLayeredWindowAttributes(h, 0, 255, LWA_ALPHA);
            }
            win[i] = h;
        }
        Bands {
            win,
            visible: false,
            alpha: 255,
            clickthrough: true,
        }
    }

    unsafe fn hide_all(&mut self) {
        if !self.visible {
            return;
        }
        for h in self.win {
            if !h.is_null() {
                ShowWindow(h, SW_HIDE);
            }
        }
        self.visible = false;
    }

    unsafe fn set_alpha(&mut self, alpha: u8) {
        if self.alpha == alpha {
            return;
        }
        self.alpha = alpha;
        for h in self.win {
            if !h.is_null() {
                SetLayeredWindowAttributes(h, 0, alpha, LWA_ALPHA);
            }
        }
    }

    unsafe fn set_clickthrough(&mut self, through: bool) {
        if self.clickthrough == through {
            return;
        }
        self.clickthrough = through;
        for h in self.win {
            if h.is_null() {
                continue;
            }
            let mut ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
            if through {
                ex |= WS_EX_TRANSPARENT;
            } else {
                ex &= !WS_EX_TRANSPARENT;
            }
            SetWindowLongW(h, GWL_EXSTYLE, ex as i32);
        }
    }

    unsafe fn place(&mut self, h: Hwnd, x: i32, y: i32, w: i32, hh: i32, first: bool) {
        if h.is_null() {
            return;
        }
        if w <= 0 || hh <= 0 {
            ShowWindow(h, SW_HIDE);
            return;
        }
        let flags = if first {
            SWP_NOACTIVATE | SWP_SHOWWINDOW
        } else {
            SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOZORDER
        };
        SetWindowPos(h, HWND_TOPMOST, x, y, w, hh, flags);
    }
}

/// 目标窗口矩形（去掉不可见/最小化的情况）
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
        ctl.target.store(h as i32, Ordering::Relaxed);
    }
    if IsWindowVisible(h) == 0 {
        return None;
    }
    if IsIconic(h) != 0 {
        return None; // 最小化时保留上一帧位置
    }
    let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    if GetWindowRect(h, &mut r) == 0 {
        return None;
    }
    if r.right <= r.left || r.bottom <= r.top {
        return None;
    }
    Some(r)
}

pub fn start(ctl: std::sync::Arc<MaskCtl>) {
    thread::spawn(move || unsafe {
        // 混合 DPI 多显示器下必须用物理像素坐标，否则遮罩会错位
        SetProcessDpiAwarenessContext(-4);

        let mut bands = Bands::create();
        let hotkey_ok = RegisterHotKey(std::ptr::null_mut(), 0xA1, MOD_CONTROL | MOD_ALT, VK_K) != 0;

        let mut last_rect: Option<(i32, i32, i32, i32)> = None;
        let mut was_on = false;

        loop {
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
                    UnregisterHotKey(std::ptr::null_mut(), 0xA1);
                    return;
                }
                if msg.message == WM_HOTKEY && msg.w_param == 0xA1 {
                    if ctl.on.load(Ordering::Relaxed) {
                        ctl.on.store(false, Ordering::Relaxed);
                        if let Ok(mut n) = ctl.notice.lock() {
                            *n = Some("已通过热键 Ctrl+Alt+K 退出遮罩".into());
                        }
                    }
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let on = ctl.on.load(Ordering::Relaxed);
            if !on {
                bands.hide_all();
                ctl.painted.store(false, Ordering::Relaxed);
                was_on = false;
                last_rect = None;
                thread::sleep(Duration::from_millis(220));
                continue;
            }

            bands.set_alpha(((ctl.opacity.load(Ordering::Relaxed) as u32) * 255 / 100) as u8);
            bands.set_clickthrough(!ctl.block_click.load(Ordering::Relaxed));
            if ctl.hotkey.load(Ordering::Relaxed) && !hotkey_ok {
                RegisterHotKey(std::ptr::null_mut(), 0xA1, MOD_CONTROL | MOD_ALT, VK_K);
            }

            let margin = ctl.margin.load(Ordering::Relaxed);
            match target_rect(&ctl) {
                Some(r) => {
                    let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
                    let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
                    let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1);
                    let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1);

                    // 洞口 = 目标窗口 + 边距，并裁剪到虚拟桌面
                    let left = (r.left - margin).max(vx);
                    let top = (r.top - margin).max(vy);
                    let right = (r.right + margin).min(vx + vw);
                    let bottom = (r.bottom + margin).min(vy + vh);

                    let key = (left, top, right, bottom);
                    if last_rect != Some(key) {
                        let first = !bands.visible;
                        // 上
                        bands.place(bands.win[0], vx, vy, vw, top - vy, first);
                        // 下
                        bands.place(bands.win[1], vx, bottom, vw, vy + vh - bottom, first);
                        // 左
                        bands.place(bands.win[2], vx, top, left - vx, bottom - top, first);
                        // 右
                        bands.place(bands.win[3], right, top, vx + vw - right, bottom - top, first);
                        bands.visible = true;
                        last_rect = Some(key);
                        ctl.painted.store(true, Ordering::Relaxed);
                        was_on = true;
                    }
                }
                None => {
                    // 目标窗口没了：整屏遮住会更"闷"，这里选择自动退出并提示
                    if was_on {
                        ctl.on.store(false, Ordering::Relaxed);
                        if let Ok(mut n) = ctl.notice.lock() {
                            *n = Some("目标窗口已关闭，遮罩自动退出".into());
                        }
                    }
                }
            }

            thread::sleep(Duration::from_millis(24));
        }
    });
}
