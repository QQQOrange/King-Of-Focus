//! Windows 原生进程 / 窗口枚举与终止（无第三方依赖，直接调用 user32 / kernel32）

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;

type Handle = *mut core::ffi::c_void;
type Hwnd = *mut core::ffi::c_void;

const GWL_EXSTYLE: i32 = -20;
const WS_EX_TOOLWINDOW: i32 = 0x0000_0080;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const PROCESS_TERMINATE: u32 = 0x0001;
const WM_CLOSE: u32 = 0x0010;
const WM_GETTEXT: u32 = 0x000D;
const SMTO_BLOCK: u32 = 0x0001;
const SMTO_ABORTIFHUNG: u32 = 0x0002;
const STILL_ACTIVE: u32 = 259;

#[link(name = "user32")]
extern "system" {
    fn EnumWindows(cb: Option<unsafe extern "system" fn(Hwnd, isize) -> i32>, lparam: isize) -> i32;
    fn IsWindowVisible(h: Hwnd) -> i32;
    fn IsWindow(h: Hwnd) -> i32;
    fn IsHungAppWindow(h: Hwnd) -> i32;
    fn GetWindowTextLengthW(h: Hwnd) -> i32;
    fn GetWindowTextW(h: Hwnd, buf: *mut u16, max: i32) -> i32;
    fn GetWindowThreadProcessId(h: Hwnd, pid: *mut u32) -> u32;
    fn GetWindowLongW(h: Hwnd, idx: i32) -> i32;
    fn SendMessageTimeoutW(
        h: Hwnd,
        msg: u32,
        wp: usize,
        lp: isize,
        flags: u32,
        timeout_ms: u32,
        result: *mut usize,
    ) -> isize;
    fn PostMessageW(h: Hwnd, msg: u32, wp: usize, lp: isize) -> i32;
    fn ShowWindow(h: Hwnd, cmd: i32) -> i32;
    fn IsIconic(h: Hwnd) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn CloseHandle(h: Handle) -> i32;
    fn QueryFullProcessImageNameW(h: Handle, flags: u32, buf: *mut u16, size: *mut u32) -> i32;
    fn TerminateProcess(h: Handle, code: u32) -> i32;
    fn GetExitCodeProcess(h: Handle, code: *mut u32) -> i32;
}

#[derive(Clone, Debug)]
pub struct WinApp {
    pub pid: u32,
    pub hwnd: isize,
    pub path: String,
    /// 小写、去掉 .exe 的进程名
    pub name: String,
    pub title: String,
}

unsafe extern "system" fn collect_cb(hwnd: Hwnd, lparam: isize) -> i32 {
    let out = &mut *(lparam as *mut Vec<Hwnd>);
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
    if ex & WS_EX_TOOLWINDOW != 0 {
        return 1;
    }
    // 这里不要再调 GetWindowTextLengthW：它会往目标窗口的 UI 线程
    // SendMessage(WM_GETTEXTLENGTH)，对方一旦卡住（无响应窗口），
    // 整个过程就会跟着永久挂起。标题的读取挪到下面用带超时的 SendMessageTimeout。
    out.push(hwnd);
    1
}

/// 读窗口标题。**绝不无超时地 SendMessage**：
/// 别的程序卡死时（LazyTyper 之类的全屏浮层、卡住的安装器、远程桌面窗口）
/// `GetWindowText` 会一直阻塞，而这段代码是会从 UI 线程（get_state）里被调到的，
/// 一旦阻塞就是"整个界面卡死、只能杀进程"。
fn window_text(h: Hwnd) -> String {
    unsafe {
        if IsHungAppWindow(h) != 0 {
            return String::new();
        }
        let mut buf = vec![0u16; 512];
        let mut got: usize = 0;
        let ok = SendMessageTimeoutW(
            h,
            WM_GETTEXT,
            buf.len(),
            buf.as_mut_ptr() as isize,
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            60,
            &mut got,
        );
        if ok == 0 || got == 0 || got > buf.len() {
            return String::new();
        }
        OsString::from_wide(&buf[..got])
            .to_string_lossy()
            .into_owned()
    }
}

pub fn exe_path(pid: u32) -> String {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return String::new();
        }
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
        CloseHandle(h);
        if ok == 0 {
            return String::new();
        }
        OsString::from_wide(&buf[..size as usize])
            .to_string_lossy()
            .into_owned()
    }
}

pub fn stem(path: &str) -> String {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let s = file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(file);
    s.to_lowercase()
}

/// 进程的可执行文件名（含 .exe，保留原大小写）；取不到返回 None。
/// 用于把 SMTC 媒体会话的 AUMID 归因到具体进程（见 media.rs）。
pub fn exe_name_of(pid: u32) -> Option<String> {
    let p = exe_path(pid);
    if p.is_empty() {
        return None;
    }
    let name = p.rsplit(['\\', '/']).next().unwrap_or(&p).to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// 当前所有"有可见窗口"的应用（去重到 pid 粒度）
pub fn screen_apps() -> Vec<WinApp> {
    unsafe {
        let mut hwnds: Vec<Hwnd> = Vec::new();
        EnumWindows(Some(collect_cb), &mut hwnds as *mut Vec<Hwnd> as isize);

        let mut map: Vec<WinApp> = Vec::new();
        for h in hwnds {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(h, &mut pid);
            if pid == 0 {
                continue;
            }
            let title = window_text(h);
            if title.trim().is_empty() {
                continue;
            }
            if let Some(existing) = map.iter_mut().find(|a| a.pid == pid) {
                if title.len() > existing.title.len() {
                    existing.title = title;
                    existing.hwnd = h as isize;
                }
                continue;
            }
            let path = exe_path(pid);
            let name = if path.is_empty() {
                String::new()
            } else {
                stem(&path)
            };
            map.push(WinApp {
                pid,
                hwnd: h as isize,
                path,
                name,
                title,
            });
        }
        map
    }
}

pub fn is_alive(pid: u32) -> bool {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == STILL_ACTIVE
    }
}

pub fn terminate(pid: u32) -> bool {
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if h.is_null() {
            return false;
        }
        let ok = TerminateProcess(h, 1);
        CloseHandle(h);
        ok != 0
    }
}

/// 先礼貌关闭（发 WM_CLOSE），窗口自己退出能保住现场
pub fn soft_close(hwnd: isize) -> bool {
    unsafe {
        if hwnd == 0 || IsWindow(hwnd as Hwnd) == 0 {
            return false;
        }
        PostMessageW(hwnd as Hwnd, WM_CLOSE, 0, 0) != 0
    }
}

/// SW_MINIMIZE = 6：最小化并**保持进程运行**（不破坏现场，随时可还原）。
const SW_MINIMIZE: i32 = 6;

/// 最小化窗口。返回是否真的发出了请求。
///
/// 为什么用 SW_MINIMIZE 而不是 SW_HIDE：隐藏会让任务栏里也消失，
/// 用户会觉得"程序没了"；最小化还留着任务栏条目，是"收起来"而不是"关掉"。
pub fn minimize(hwnd: isize) -> bool {
    unsafe {
        if hwnd == 0 || IsWindow(hwnd as Hwnd) == 0 {
            return false;
        }
        ShowWindow(hwnd as Hwnd, SW_MINIMIZE) != 0
    }
}

/// 这个窗口现在是不是最小化状态（判断"我们收起来的那一块"有没有被用户点开）。
///
/// 句柄失效 / 窗口已销毁 → false：调用方会把它当成"已经不是停放状态"，
/// 于是按常规拦截处理，不会留一个永久豁免的口子。
pub fn is_minimized(hwnd: isize) -> bool {
    unsafe {
        if hwnd == 0 || IsWindow(hwnd as Hwnd) == 0 {
            return false;
        }
        IsIconic(hwnd as Hwnd) != 0
    }
}

unsafe extern "system" fn by_pid_cb(hwnd: Hwnd, lparam: isize) -> i32 {
    let (pid_target, out) = &mut *(lparam as *mut (u32, Vec<Hwnd>));
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
    if ex & WS_EX_TOOLWINDOW != 0 {
        return 1;
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == *pid_target {
        out.push(hwnd);
    }
    1
}

/// 某个进程所有"可见顶层窗口"的句柄。
///
/// 为什么要"所有"而不是 `screen_apps` 里那一个：一个程序可能开着好几个窗口
/// （主窗 + 独立播放器 + 聊天小窗）。只收最小的那个，用户还能从另一个窗口继续用，
/// "收尾"就形同虚设。
pub fn windows_of_pid(pid: u32) -> Vec<isize> {
    let mut ctx: (u32, Vec<Hwnd>) = (pid, Vec::new());
    unsafe {
        EnumWindows(Some(by_pid_cb), &mut ctx as *mut (u32, Vec<Hwnd>) as isize);
    }
    ctx.1.into_iter().map(|h| h as isize).collect()
}

/// 最小化某个进程的**所有**可见顶层窗口，返回成功的个数。
pub fn minimize_all(pid: u32) -> usize {
    let mut n = 0;
    for h in windows_of_pid(pid) {
        if minimize(h) {
            n += 1;
        }
    }
    n
}

/// 全局扫一遍：pid → (可见顶层窗口数, 其中已最小化的数量)。
///
/// monitor 用它判断"停放的进程是不是还乖乖收着"：只要它还有任意一个窗口没最小化
/// （用户点开了），就不再享受豁免，下一拍按常规拦截处理。
pub fn window_minimized_map() -> std::collections::HashMap<u32, (usize, usize)> {
    let mut map: std::collections::HashMap<u32, (usize, usize)> = std::collections::HashMap::new();
    unsafe extern "system" fn cb(hwnd: Hwnd, lparam: isize) -> i32 {
        let map = &mut *(lparam as *mut std::collections::HashMap<u32, (usize, usize)>);
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if ex & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return 1;
        }
        let e = map.entry(pid).or_insert((0, 0));
        e.0 += 1;
        if IsIconic(hwnd) != 0 {
            e.1 += 1;
        }
        1
    }
    unsafe {
        EnumWindows(Some(cb), &mut map as *mut std::collections::HashMap<u32, (usize, usize)> as isize);
    }
    map
}

pub fn norm_path(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

/// 按 pid 找到该进程最"主"的可见窗口句柄
pub fn find_window_by_pid(pid: u32) -> Option<isize> {
    let mut found: Option<isize> = None;
    for app in screen_apps() {
        if app.pid == pid {
            found = Some(app.hwnd);
            break;
        }
    }
    found
}
