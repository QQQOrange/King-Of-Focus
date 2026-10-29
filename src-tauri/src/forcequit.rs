//! 强制退出通道：Ctrl+Alt+F4（任意前台窗口都生效）+ Alt+F4（仅本程序窗口在前台时生效）
//!
//! 背景（根因）：
//! 之前这个组合键**从来没被注册过**——全代码库里唯一的全局热键是遮罩用的
//! Ctrl+Alt+K（`mask.rs` 里的 `RegisterHotKey(NULL, 0xA1, ...)`）。
//! 所以按下 Ctrl+Alt+F4 时，操作系统根本没人"接单"：既没有热键注册，
//! 也没有键盘钩子，程序压根看不见这次按键。
//! 唯一勉强沾边的是窗口的 `CloseRequested`（Alt+F4 会发 WM_CLOSE），
//! 但那条路被两条业务规则堵死：
//!   1. `close_to_tray = true` → `prevent_close()` + 隐藏到托盘
//!   2. 自律时段 / 专注段内 → `guard::exit_blocked()` → 拒绝退出
//! 于是用户按「强制退出」键，程序纹丝不动。
//!
//! 现在的做法：
//!   · 装一个 **低级键盘钩子**（WH_KEYBOARD_LL）来"看见" F4，
//!     自己判断组合键后决定是否拦截（吞掉）这次按键。
//!     - Ctrl+Alt+F4：无论前台是谁都触发，并吞掉按键（避免同时触发别的动作）
//!     - Alt+F4：只有当前台窗口属于本进程时才触发，避免抢别的程序的 Alt+F4
//!   · 钩子装不上时（极端环境）退回 **RegisterHotKey** 兜底，只支持 Ctrl+Alt+F4。
//!
//! 退出前的清理（顺序有讲究，见 `force_quit`）：
//!   1. 先停掉守护进程 —— 否则守护发现心跳断了会把主进程**重新拉起来**，
//!      用户看到的现象是"按了强制退出，程序又回来了"。
//!   2. 恢复被我们暂停的媒体（媒体管控是全局副作用，不还原就是别人在听哑片）。
//!   3. 让遮罩线程自己收尾：销毁覆盖层窗口、注销热键、`timeEndPeriod(1)`。
//!   4. 落盘统计数据。
//!   5. 释放单实例互斥体，最后退出（带 2 秒看门狗兜底，确保一定走得掉）。
//!
//! 全程**不弹任何确认对话框**：这是"强制"退出的语义。
//! 未保存内容按既有策略处理（和其它退出路径一致：直接丢弃）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::AppHandle;

use crate::shared::Shared;

// ---------------- Win32 常量 ----------------

type Handle = *mut core::ffi::c_void;

const WH_KEYBOARD_LL: i32 = 13;
const HC_ACTION: i32 = 0;
const WM_KEYDOWN: u32 = 0x0100;
const WM_SYSKEYDOWN: u32 = 0x0104;
const WM_HOTKEY: u32 = 0x0312;
const WM_QUIT: u32 = 0x0012;
const PM_REMOVE: u32 = 0x0001;
const PM_NOREMOVE: u32 = 0x0000;
/// 自定义消息：钩子命中后用它唤醒主循环（WM_APP 起点，避免和系统消息撞车）
const WM_APP_FORCE: u32 = 0x8000 + 0x4F;
const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;

const VK_CONTROL: i32 = 0x11;
const VK_MENU: i32 = 0x12;
const VK_F4: i32 = 0x73;

/// 我们自己的热键 id（和遮罩的 0xA1 区分开）
const HOTKEY_ID_FORCE_QUIT: i32 = 0xB4;

#[repr(C)]
struct Msg {
    hwnd: Handle,
    message: u32,
    w_param: usize,
    l_param: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
    _private: u32,
}

#[repr(C)]
struct KbdLlHookStruct {
    vk_code: u32,
    scan_code: u32,
    flags: u32,
    time: u32,
    dw_extra_info: usize,
}

type HookProc = unsafe extern "system" fn(i32, usize, isize) -> isize;

#[link(name = "user32")]
extern "system" {
    fn SetWindowsHookExW(
        id: i32,
        lpfn: Option<HookProc>,
        hmod: Handle,
        thread_id: u32,
    ) -> Handle;
    fn UnhookWindowsHookEx(hhk: Handle) -> i32;
    fn CallNextHookEx(hhk: Handle, code: i32, wparam: usize, lparam: isize) -> isize;
    fn RegisterHotKey(hwnd: Handle, id: i32, modifiers: u32, vk: u32) -> i32;
    fn UnregisterHotKey(hwnd: Handle, id: i32) -> i32;
    fn GetAsyncKeyState(vkey: i32) -> i16;
    fn GetForegroundWindow() -> Handle;
    fn GetWindowThreadProcessId(hwnd: Handle, pid: *mut u32) -> u32;
    fn GetMessageW(m: *mut Msg, hwnd: Handle, min: u32, max: u32) -> i32;
    fn PeekMessageW(m: *mut Msg, hwnd: Handle, min: u32, max: u32, remove: u32) -> i32;
    fn TranslateMessage(m: *const Msg) -> i32;
    fn DispatchMessageW(m: *const Msg) -> isize;
    fn PostThreadMessageW(thread_id: u32, msg: u32, wparam: usize, lparam: isize) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> Handle;
    fn GetTickCount64() -> u64;
    fn GetCurrentThreadId() -> u32;
}

// ---------------- 状态 ----------------

/// 组合键命中 → 置位；主循环看到后执行退出流程
static TRIGGERED: AtomicBool = AtomicBool::new(false);
/// 已经在退出流程里了（幂等，防止钩子和热键两条路重复触发）
static QUITTING: AtomicBool = AtomicBool::new(false);
/// 钩子装上了没有（用于诊断 / 决定是否走热键兜底）
static HOOK_OK: AtomicBool = AtomicBool::new(false);
/// 全局热键注册成功没有
static HOTKEY_OK: AtomicBool = AtomicBool::new(false);
/// 最近一次命中时的修饰键状态（只用于日志，由主循环读取）
static HIT_CTRL: AtomicBool = AtomicBool::new(false);
static HIT_ALT: AtomicBool = AtomicBool::new(false);
/// 安装钩子的线程 id（钩子回调要用它唤醒阻塞中的 GetMessageW）
static HOOK_TID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
/// 已安装的键盘钩子句柄（退出时卸载）
static HOOK_HANDLE: std::sync::atomic::AtomicPtr<core::ffi::c_void> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

/// 当前前台窗口是不是我们自己（Alt+F4 的判定依据）
fn foreground_is_ours() -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, &mut pid);
        pid != 0 && pid == std::process::id()
    }
}

fn key_down(vk: i32) -> bool {
    unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
}

/// Alt 键当前是否按着。
///
/// 用途：区分 **Alt+F4** 和 **点右上角 X**。
///
/// 这两个动作在 Win32 层面走的是**同一条路**：
///   Alt+F4 → `WM_SYSCOMMAND(SC_CLOSE)` → `WM_CLOSE` → 窗口关闭请求
///   点 X   → `WM_CLOSE`                          → 窗口关闭请求
/// Tauri 把两者都报成同一个 `CloseRequested` 事件，事件里没有任何字段能区分。
/// 但 Alt+F4 触发时用户的手还按在 Alt 上（物理上不可能先松开 Alt 再敲 F4），
/// 而点 X 时 Alt 一定是松开的——所以用「Alt 是否按着」就能把两者分开。
///
/// 这个判定放在 `CloseRequested` 里，用来让 Alt+F4 走强制退出通道
/// （绕过「收进托盘」和「自律时段禁止退出」两条规则）。
pub fn alt_held() -> bool {
    key_down(VK_MENU)
}

/// 最近一次按下 Alt 的时刻（GetTickCount64 毫秒）
static ALT_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Alt 键"刚刚被按过"的判定窗口（毫秒）。
///
/// 单看 `GetAsyncKeyState(VK_MENU)` 有个坑：窗口关闭请求是在用户**松开 Alt 之后**
/// 才处理到的（WM_SYSCOMMAND → WM_CLOSE 是异步转发）。手快的人一按完就撒手，
/// 到达我们代码时 Alt 已经松开了，判定就会漏掉，于是 Alt+F4 又被当成"点 X"处理
/// （自律时段里表现为"按了没反应"）。
///
/// 所以再叠一层"最近按过 Alt"的时间窗：只要 1.5 秒内按过 Alt，
/// 这一次关闭请求就按 Alt+F4 处理。
const ALT_RECENT_MS: u64 = 1500;

/// 是否应当把这次窗口关闭请求判定为 **Alt+F4**（而不是点 X）
pub fn is_alt_f4_close() -> bool {
    let held = alt_held();
    let last = ALT_AT.load(Ordering::Relaxed);
    let now = unsafe { GetTickCount64() };
    let age = if last == 0 { u64::MAX } else { now.saturating_sub(last) };
    let hit = held || age < ALT_RECENT_MS;
    if hit {
        // 只在"确实判定为 Alt+F4"时记一行，避免普通关窗也刷日志
        log(&format!("CloseRequested 判定为 Alt+F4（alt_held={held} 距按Alt={age}ms）"));
    }
    hit
}

/// 组合键判定（纯函数，便于单元测试）。
///
/// 规则：
///   · Ctrl+Alt+F4 → 一律触发（前台是谁都行，这就是"强制退出"）
///   · Alt+F4     → 只有本程序窗口在前台时才触发（不抢别的程序的 Alt+F4）
///   · 其余任何 F4 组合 → 不触发
pub fn combo_triggers(vk: i32, ctrl: bool, alt: bool, fg_is_ours: bool) -> bool {
    if vk != VK_F4 {
        return false;
    }
    if ctrl && alt {
        return true;
    }
    if alt && !ctrl {
        return fg_is_ours;
    }
    false
}

/// 低级键盘钩子回调：只看 F4，判断组合键后决定吞不吞。
/// 低级键盘钩子回调。
///
/// **这里是全程序最危险的地方**，两条铁律：
///
/// 1. 必须极快返回。Windows 对低级钩子回调有硬性超时（LowLevelHooksTimeout，
///    默认 300ms）。一旦超时，系统会**静默摘掉**钩子——不报错、不抛异常，
///    只是从此再也收不到任何按键。现象极具迷惑性：
///    "单进程时 Alt+F4 好用，一开固化（多一个守护进程抢 CPU）就失灵"。
///
/// 2. **绝对不能做任何 I/O**（写文件、写日志都算）。曾经的版本在这里调 `log()`
///    写日志文件，磁盘一慢就超时，钩子在启动几秒后就被系统摘掉——
///    这正是"按了没反应"的真正原因。现在回调里只做：
///    读键值 → 判组合键 → 置原子标志 → PostThreadMessage 唤醒主循环。
///    真正干活（日志、清理、退出）全在主循环里做。
unsafe extern "system" fn hook_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    if code == HC_ACTION {
        let msg = wparam as u32;
        if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
            let st = &*(lparam as *const KbdLlHookStruct);
            // 记下 Alt 被按下的时刻：窗口关闭请求到达时 Alt 可能已经松开了，
            // 靠这个时间戳才能把 Alt+F4 和"点 X"区分开。
            if st.vk_code as i32 == VK_MENU {
                ALT_AT.store(GetTickCount64(), Ordering::Relaxed);
            }
            // 只判 F4；其它按键在这里立刻放行（绝大多数按键走这条快路径）
            if st.vk_code as i32 == VK_F4 {
                let ctrl = key_down(VK_CONTROL);
                let alt = key_down(VK_MENU);
                let fg_ours = foreground_is_ours();
                if combo_triggers(st.vk_code as i32, ctrl, alt, fg_ours) {
                    HIT_CTRL.store(ctrl, Ordering::Relaxed);
                    HIT_ALT.store(alt, Ordering::Relaxed);
                    TRIGGERED.store(true, Ordering::SeqCst);
                    // 叫醒阻塞在 GetMessageW 上的主循环（回调返回后它会继续阻塞）
                    let tid = HOOK_TID.load(Ordering::SeqCst);
                    if tid != 0 {
                        PostThreadMessageW(tid, WM_APP_FORCE, 0, 0);
                    }
                    // 返回 1 = 吞掉这次按键，别让它继续传给前台程序
                    return 1;
                }
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

/// 启动强制退出监听（进程启动时调用一次）
///
/// 方案说明（为什么不用低级键盘钩子）：
///   WH_KEYBOARD_LL 看起来最灵活，但它有个致命弱点：回调必须在
///   LowLevelHooksTimeout（默认 300ms）内返回，否则系统会**静默摘掉钩子**，
///   不报错、不抛异常，只是从此收不到任何按键。
///   实测在"主进程 + 固化守护"双进程抢 CPU 时，钩子几秒内就被摘掉，
///   表现为"单进程时 Alt+F4 好用，一开固化就失灵"——极难排查。
///
/// 所以改成两条各自最可靠的路径：
///   1. **Ctrl+Alt+F4** → `RegisterHotKey` 系统级热键。由系统直接投递 WM_HOTKEY，
///      不经过任何回调超时机制，前台后台都稳定。这是"强制退出"的主通道。
///   2. **Alt+F4** → 走窗口的 `CloseRequested`（见 main.rs）。
///      Alt+F4 本来就是"关闭当前窗口"，Windows 会把它变成 WM_CLOSE，
///      由 `is_alt_f4_close()` 区分"Alt+F4"和"点右上角 X"。
///      这条路只在窗口处于前台时生效——这符合预期：后台按 Alt+F4 不该
///      越过前台程序去关我们的窗口。
pub fn start(app: AppHandle, shared: Arc<Shared>) {
    std::thread::spawn(move || unsafe {
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
        // 先建立线程消息队列（RegisterHotKey 的 WM_HOTKEY 依赖它）
        PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);

        // 主通道：系统级热键 Ctrl+Alt+F4
        let ok = RegisterHotKey(
            std::ptr::null_mut(),
            HOTKEY_ID_FORCE_QUIT,
            MOD_CONTROL | MOD_ALT,
            VK_F4 as u32,
        ) != 0;
        HOTKEY_OK.store(ok, Ordering::SeqCst);
        log(&format!("强制退出热键 Ctrl+Alt+F4 注册={ok}"));

        // 钩子：**始终安装**，它承担两件热键做不到的事：
        //   1. 第一次按下 Alt 时把时刻记进 ALT_AT —— `is_alt_f4_close()` 靠它
        //      才能把 "Alt+F4" 和 "点右上角 X" 区分开（两者在 Win32 层同属 WM_CLOSE）。
        //   2. 热键被别的程序占用时，它还能独立识别 Ctrl+Alt+F4。
        //
        // 回调已经是**零 I/O**（只读键值 + 写原子量 + PostThreadMessage），
        // 这是它不被系统按 LowLevelHooksTimeout 摘掉的前提。
        let module = GetModuleHandleW(std::ptr::null());
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), module, 0);
        HOOK_OK.store(!hook.is_null(), Ordering::SeqCst);
        HOOK_HANDLE.store(hook, Ordering::SeqCst);
        HOOK_TID.store(GetCurrentThreadId(), Ordering::SeqCst);
        log(&format!(
            "强制退出就绪：热键={ok} 钩子={}",
            !hook.is_null()
        ));

        loop {
            // 阻塞等消息：0 CPU，热键一来立刻醒
            let r = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
            if r == 0 || r == -1 {
                break;
            }
            if (msg.message == WM_HOTKEY && msg.w_param as i32 == HOTKEY_ID_FORCE_QUIT)
                || msg.message == WM_APP_FORCE
            {
                TRIGGERED.store(true, Ordering::SeqCst);
            }
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
            if TRIGGERED.swap(false, Ordering::SeqCst) {
                log("收到强制退出信号（热键 / Alt+F4）");
                // 被自律时段挡住时**不能** return：这条线程就是热键服务本身，
                // 一返回热键就注销了，等这段结束再按也不会响应。
                if force_quit(&app, &shared) {
                    return;
                }
            }
        }
    });
}

/// 强制退出的清理步骤。
///
/// 抽成枚举 + 固定顺序，是为了让"退出前到底做了什么、顺序对不对"可以被单元测试覆盖，
/// 而不是只靠肉眼看代码。顺序本身有讲究（见 `cleanup_steps` 的注释）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitStep {
    /// 写"别复活"哨兵 + 停守护进程
    StopGuard,
    /// 还原被我们暂停的媒体
    ResumeMedia,
    /// 遮罩线程收尾（销毁覆盖层、注销热键、timeEndPeriod）
    StopMask,
    /// 统计数据落盘
    FlushStats,
    /// 释放单实例互斥体
    ReleaseLock,
    /// 卸载键盘钩子与全局热键
    Unhook,
}

/// 清理步骤的固定顺序。
///
/// 为什么是这个顺序：
///   1. `StopGuard` 必须**最先**：守护进程发现心跳断了会把主进程复活，
///      不先停掉它，"强制退出"等于按下退出后程序又回来了。
///      哨兵也要在杀守护之前写好，否则守护可能在被杀之前就决定了复活。
///   2. `ResumeMedia`：媒体是**全局副作用**（别的进程在播放），越早还原越好。
///   3. `StopMask`：销毁覆盖层窗口，别在桌面上留一个黑块。
///   4. `FlushStats`：落盘今天的统计，别丢数据。
///   5. `ReleaseLock`：释放单实例互斥体，新实例能立刻接管。
///   6. `Unhook`：卸掉自己装的全局钩子/热键，不给别的进程留残留。
pub fn cleanup_steps() -> Vec<QuitStep> {
    vec![
        QuitStep::StopGuard,
        QuitStep::ResumeMedia,
        QuitStep::StopMask,
        QuitStep::FlushStats,
        QuitStep::ReleaseLock,
        QuitStep::Unhook,
    ]
}

/// 强制退出：清理 → 退出。全程不弹确认框。
///
/// 返回 `true` 表示"已经在退出"，`false` 表示**被拒**（自律时段内禁止退出）。
/// 调用方必须区分这两种：被拒时热键线程不能 `return`，否则热键就永远失效了，
/// 等这一段结束用户再按也没反应。
pub fn force_quit(app: &AppHandle, shared: &Shared) -> bool {
    // 先过"自律时段内是否允许退出"这道闸：
    // 开关关掉时，热键 / Alt+F4 / 设置页按钮走的都是这个函数，
    // 在入口处统一拒绝，保证"任何方式都退不掉"是真的。
    if let Some(why) = crate::guard::session_quit_hint(&shared.config()) {
        log(&format!("拒绝退出：{why}"));
        crate::notify::toast(app, "warn", "自律时段内已禁止退出", &why, "quit-blocked", 6);
        return false;
    }
    if QUITTING.swap(true, Ordering::SeqCst) {
        return true;
    }
    log("强制退出开始");

    for step in cleanup_steps() {
        match step {
            QuitStep::StopGuard => {
                // 哨兵先写，再杀守护：哨兵是给守护的"别复活"信号，
                // 必须在它有可能做复活决定之前就位。
                crate::guard::mark_quitting();
                crate::guard::stop_guard();
            }
            QuitStep::ResumeMedia => {
                crate::media::set_active(false);
            }
            QuitStep::StopMask => {
                crate::mask::request_stop();
            }
            QuitStep::FlushStats => {
                crate::stats::flush(shared);
            }
            QuitStep::ReleaseLock => {
                crate::release_instance_lock();
            }
            QuitStep::Unhook => unsafe {
                let h = HOOK_HANDLE.swap(std::ptr::null_mut(), Ordering::SeqCst);
                if !h.is_null() {
                    UnhookWindowsHookEx(h);
                }
                UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID_FORCE_QUIT);
            },
        }
    }

    // 退出。看门狗兜底：万一 Tauri 的退出流程卡住，2 秒后硬退。
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(2000));
        log("退出超时，强制结束进程");
        std::process::exit(0);
    });
    log("强制退出已触发");
    app.exit(0);
    true
}

/// 仅在 KOF_DEBUG=1 时输出日志
///
/// 同时写一份到数据目录的 `forcequit.log`：
/// 本程序是 GUI 子系统（windows_subsystem），stderr 在双击启动时根本没有宿主，
/// 排查"钩子看见了按键却没触发"这类问题时，重定向 stderr 也常常拿不到内容。
/// 写文件是唯一可靠的方式。
fn log(msg: &str) {
    if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
        return;
    }
    eprintln!("[king-of-focus][forcequit] {msg}");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(crate::cfg::data_dir().join("forcequit.log"))
    {
        use std::io::Write;
        let _ = writeln!(f, "{} {msg}", chrono::Local::now().format("%H:%M:%S%.3f"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctrl_alt_f4_always_triggers() {
        // 前台不是我们，也照样触发
        assert!(combo_triggers(VK_F4, true, true, false));
        assert!(combo_triggers(VK_F4, true, true, true));
    }

    #[test]
    fn alt_f4_only_when_ours() {
        assert!(combo_triggers(VK_F4, false, true, true));
        assert!(!combo_triggers(VK_F4, false, true, false));
    }

    #[test]
    fn other_keys_never_trigger() {
        assert!(!combo_triggers(0x4B, true, true, true)); // K
        assert!(!combo_triggers(VK_F4, true, false, true)); // Ctrl+F4
        assert!(!combo_triggers(VK_F4, false, false, true)); // 裸 F4
    }

    #[test]
    fn shift_does_not_break_combo() {
        // Shift 只是被忽略，不影响判定
        assert!(combo_triggers(VK_F4, true, true, false));
    }

    #[test]
    fn cleanup_order_puts_guard_first() {
        // 守护必须最先处理：不先停它，它会把主进程复活
        let steps = cleanup_steps();
        assert_eq!(steps[0], QuitStep::StopGuard);
    }

    #[test]
    fn cleanup_covers_all_resources() {
        let steps = cleanup_steps();
        for s in [
            QuitStep::StopGuard,
            QuitStep::ResumeMedia,
            QuitStep::StopMask,
            QuitStep::FlushStats,
            QuitStep::ReleaseLock,
            QuitStep::Unhook,
        ] {
            assert!(steps.contains(&s), "缺少清理步骤 {s:?}");
        }
        // 不能有重复步骤
        let mut uniq = steps.clone();
        uniq.dedup();
        assert_eq!(uniq.len(), steps.len());
    }

    #[test]
    fn media_restore_precedes_mask_teardown() {
        // 媒体是全局副作用，要先于遮罩收尾还原
        let steps = cleanup_steps();
        let m = steps.iter().position(|s| *s == QuitStep::ResumeMedia).unwrap();
        let k = steps.iter().position(|s| *s == QuitStep::StopMask).unwrap();
        assert!(m < k);
    }

    #[test]
    fn stats_flush_precedes_exit() {
        // 统计落盘必须在释放锁之前完成
        let steps = cleanup_steps();
        let f = steps.iter().position(|s| *s == QuitStep::FlushStats).unwrap();
        let l = steps.iter().position(|s| *s == QuitStep::ReleaseLock).unwrap();
        assert!(f < l);
    }
}
