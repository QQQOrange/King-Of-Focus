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
    AtomicBool, AtomicI64, AtomicIsize, AtomicU32, AtomicU64, AtomicU8, Ordering,
};
use std::sync::Mutex;
use std::thread;
use std::time::Instant;

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
/// MsgWaitForMultipleObjects 的唤醒掩码。
/// 只等"投递类消息"（WinEvent 就走这条路），**不含 QS_INPUT**——
/// 鼠标键盘活动会不停把 QS_ALLINPUT 唤醒，等于白转。
const QS_POSTMESSAGE: u32 = 0x0008;
const QS_SENDMESSAGE: u32 = 0x0040;
/// 事件钩子：把回调投递到注册线程的消息队列（跨进程，不需要注入 DLL）
const WINEVENT_OUTOFCONTEXT: u32 = 0x0000;
/// 事件钩子：跳过本进程自己的窗口事件，避免自我唤醒
const WINEVENT_SKIPOWNPROCESS: u32 = 0x0002;
/// 前台窗口换了
const EVENT_SYSTEM_FOREGROUND: u32 = 0x0003;
/// 窗口最小化 / 还原：目标可能因此失效
const EVENT_SYSTEM_MINIMIZESTART: u32 = 0x0016;
const EVENT_SYSTEM_MINIMIZEEND: u32 = 0x0017;
/// 有新窗口显示出来。用来抓"弹一下就走"的浮条（lazytyper 语音弹条），
/// 让它在被遮罩盖住之前就先浮上去。
const EVENT_OBJECT_SHOW: u32 = 0x8002;
/// 我们自己动过窗口之后，这段时间内的事件一律忽略。
/// 不设这个静默窗口，我们自己的 SetWindowPos 会回头触发事件 → 唤醒 → 再 SetWindowPos，
/// 形成自激，CPU 直接飙起来。
const SELF_SETTLE_MS: u64 = 60;
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
/// 外壳浮层（Start / 搜索）处于打开状态的次数（诊断：判断"让位"分支到底跑没跑）
pub static FLYOUT_HITS: AtomicU64 = AtomicU64::new(0);
/// 浮层打开期间把遮罩抬到最前面的次数（盖住放行弹窗）
pub static FLYOUT_COVER: AtomicU64 = AtomicU64::new(0);
/// 本轮收集到的放行窗口数（诊断用）
pub static PASS_WINS: AtomicU32 = AtomicU32::new(0);

/// 收到过多少次窗口事件（前台切换 / 最小化 / z 序变化）。
/// 事件驱动是否真的在工作，看这个数就知道——不涨说明钩子没生效。
pub static EVENT_COUNT: AtomicU64 = AtomicU64::new(0);
/// 我们自己最后一次动窗口的时刻（GetTickCount64）。
/// 用来在回调里屏蔽自激事件：我们的 SetWindowPos 也会产生 REORDER。
static SELF_ACTION_AT: AtomicU64 = AtomicU64::new(0);
/// 最近一次被外部抢位/切目标的时刻，用来决定兜底超时该多激进
static DISTURBED_AT: AtomicU64 = AtomicU64::new(0);
/// 有新的放行窗口出现，要求主循环立刻重收放行名单（不必等 500ms 周期）
static SCAN_NOW: AtomicBool = AtomicBool::new(false);
/// 遮罩当前是否真的在显示。SHOW 钩子在系统范围极其活跃（任何窗口显示都触发），
/// 遮罩没开时必须第一时间返回，否则光"查进程名"就能白烧一个多点。
static MASK_ACTIVE: AtomicBool = AtomicBool::new(false);
/// 最近一次重收放行名单的原因（诊断用）
static LAST_SCAN: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    unsafe { GetTickCount64() }
}

/// 唤醒遮罩线程的手动信号（自动重置事件）。
///
/// 遮罩线程平时阻塞在 `MsgWaitForMultipleObjects` 里等**窗口事件**。
/// 但"用户点了开关""调了不透明度"这些改的是原子量，**不是窗口事件**，
/// 唤不醒它——遮罩关着时兜底超时是 1 秒，于是点开启要等最多一秒才生效。
/// 所以这里给状态变更单开一条唤醒通道：谁改了状态就 SetEvent 一下。
static WAKE: AtomicIsize = AtomicIsize::new(0);

/// 遮罩线程停止标志：强制退出时置位，遮罩线程下一轮就收尾退出。
///
/// 收尾要做三件事，缺一不可：
///   · 销毁覆盖层窗口（不然会留一个黑色矩形在桌面上）
///   · 注销热键（0xA1）
///   · `timeEndPeriod(1)` 还回去（不然系统定时器精度一直被抬高）
static STOP: AtomicBool = AtomicBool::new(false);

/// 请求遮罩线程收尾退出（强制退出流程调用）
pub fn request_stop() {
    STOP.store(true, Ordering::Relaxed);
    wake();
}


/// 通知遮罩线程"状态变了，立刻重算一帧"。任何改 MaskCtl 的地方都该调一下。
pub fn wake() {
    let h = WAKE.load(Ordering::Relaxed);
    if h != 0 {
        unsafe {
            SetEvent(h as *mut std::ffi::c_void);
        }
    }
}

unsafe extern "system" fn win_event_proc(
    _hook: *mut std::ffi::c_void,
    event: u32,
    hwnd: Hwnd,
    id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // 新窗口显示。这一支专门处理 lazytyper 那种"弹一下"的浮条：
    // 它是**新出现的窗口**，在下一轮重收（最长 500ms）之前不在豁免名单里，
    // 于是先被遮罩盖住一瞬间、随后才浮上来——用户看到的就是那一下闪。
    //
    // 这里不排队、不等主循环：当场把它顶上去，并让主循环立刻重收名单，
    // 好让后续的摘顶扫描跳过它（否则它又会被当"碍事的浮窗"摘下来）。
    if event == EVENT_OBJECT_SHOW {
        // 遮罩没在显示 → 什么都不用做。这条早退很关键：
        // SHOW 事件覆盖整个桌面，不过滤的话每次都要开进程查名字。
        if !MASK_ACTIVE.load(Ordering::Relaxed) {
            return;
        }
        if hwnd.is_null() || id_object != 0 {
            return;
        }
        if IsWindowVisible(hwnd) == 0 {
            return;
        }
        // 系统外壳（任务栏 / 开始菜单 / 托盘浮出层）绝对不动：
        // 一旦被摘/顶摘顶，DWM 会强制给它加边框，用户看到的就是
        // "开始菜单与任务栏之间多一条缝/闪一下"。SHOW 事件里同样要跳过。
        if is_shell_window(hwnd) {
            return;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 || !is_pass_through(pid) {
            return;
        }
        // 先标记"我们自己动的窗口"，再提。
        // 不标记的话，这次 SetWindowPos 会反过来触发 REORDER/SHOW 事件，
        // 主循环被自激唤醒 → 又跑一遍摘顶扫描，很容易和 lazytyper 的
        // EVENT_OBJECT_SHOW 提升来回拉锯，弹条就在任务栏缝隙边上闪。
        mark_self_action();
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
        SCAN_NOW.store(true, Ordering::Relaxed);
        LAST_SCAN.store(now_ms(), Ordering::Relaxed);
        return;
    }

    // 静默窗口内的事件是我们自己造成的，丢掉
    if now_ms().saturating_sub(SELF_ACTION_AT.load(Ordering::Relaxed)) < SELF_SETTLE_MS {
        return;
    }
    // 前台切换 / 最小化这类必须秒回：立刻叫醒主循环重算"让开哪个窗口"。
    // 少了这一下，主循环要等下一轮 wait_event 超时才醒，那段时间洞口还停在
    // 旧的前台窗口上 → 新的前台窗口先被遮住一下、随后才被让开——就是用户
    // 看到的"切换窗口时被遮罩盖一下又消失"的闪烁。注释里承诺的"事件即时唤醒"
    // 正是靠这里兑现的。
    //
    // 注意：只有这三类才 `wake()` + 记 DISTURBED_AT（短周期纠错）。
    // 其他事件（比如 lazytyper 弹条自己的 SHOW/REORDER）不走 wake()，
    // 否则主循环会被叫醒跑一遍摘顶扫描，又把弹条摘下来 → 拉锯闪烁。
    if event == EVENT_SYSTEM_FOREGROUND
        || event == EVENT_SYSTEM_MINIMIZESTART
        || event == EVENT_SYSTEM_MINIMIZEEND
    {
        DISTURBED_AT.store(now_ms(), Ordering::Relaxed);
        wake();
    }
}

/// 等一个窗口事件；超时返回。没事件时线程真正阻塞，不占 CPU。
/// 同时等唤醒信号，好让"开关/参数变更"也能立刻叫醒它。
unsafe fn wait_event(timeout_ms: u32) {
    let h = WAKE.load(Ordering::Relaxed) as *mut std::ffi::c_void;
    let handles = [h];
    let (count, ptr) = if h.is_null() {
        (0u32, std::ptr::null())
    } else {
        (1u32, handles.as_ptr())
    };
    MsgWaitForMultipleObjects(
        count,
        ptr,
        0,
        timeout_ms,
        QS_POSTMESSAGE | QS_SENDMESSAGE,
    );
}

/// 标记"我们刚动过窗口"，让接下来 SELF_SETTLE_MS 内的 REORDER 事件被忽略
fn mark_self_action() {
    SELF_ACTION_AT.store(now_ms(), Ordering::Relaxed);
}

/// 被我们摘掉 TOPMOST 的窗口。
///
/// 遮罩关闭时必须还回去：那些是用户自己的程序（播放器、便签、输入法候选框……），
/// 不还原的话它们会永久掉到普通层级，用户会以为被我们弄坏了。
static DEMOTED: Mutex<Vec<isize>> = Mutex::new(Vec::new());

fn remember_demoted(h: Hwnd) {
    let v = h as isize;
    if let Ok(mut g) = DEMOTED.lock() {
        if !g.contains(&v) {
            g.push(v);
        }
    }
}

unsafe fn restore_demoted() {
    let list: Vec<isize> = match DEMOTED.lock() {
        Ok(mut g) => std::mem::take(&mut *g),
        Err(_) => return,
    };
    for p in list {
        let h = p as Hwnd;
        if h.is_null() || IsWindow(h) == 0 {
            continue;
        }
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        SetWindowLongW(h, GWL_EXSTYLE, (ex | WS_EX_TOPMOST_FLAG) as i32);
        SetWindowPos(
            h,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
    }
}

/// 覆盖层窗口句柄（遮罩线程写，置顶守护线程读）
static OVERLAY_HWNDS: Mutex<Vec<isize>> = Mutex::new(Vec::new());

/// 覆盖模式下"应该待在遮罩上面"的窗口（选中窗口 + 它的弹窗 + 放行程序的窗口）。
///
/// 这里**故意用无锁的原子数组，不用 Mutex**。上一版用 `try_lock`，守护线程
/// 250Hz 抢锁、主循环每帧写锁，竞争失败时只能退化成"空豁免名单"——
/// 那一刻遮罩就会把目标窗口当外人压下去，正是闪烁的来源之一。
/// 8 个槽位：1 个选中窗口 + 3 个弹窗 + 4 个放行程序窗口，绰绰有余。
pub static EXCEPT_HWNDS: [AtomicIsize; 8] = [
    AtomicIsize::new(0),
    AtomicIsize::new(0),
    AtomicIsize::new(0),
    AtomicIsize::new(0),
    AtomicIsize::new(0),
    AtomicIsize::new(0),
    AtomicIsize::new(0),
    AtomicIsize::new(0),
];

/// 当前锚点（被选中的窗口）。守护线程靠它把遮罩锚到"正下方"。
pub static ANCHOR_HWND: AtomicIsize = AtomicIsize::new(0);

/// 放行名单：这些程序的所有可见窗口都不参与遮罩，始终浮在最上面。
///
/// 为什么放行而不是压制：lazytyper 的语音识别弹条是"用户正在输入"的即时反馈，
/// 把它盖住等于让人看不到自己说的话，反而破坏专注。这类窗口属于"输入通道"，
/// 遮罩应该让路。
///
/// 匹配规则是**进程名子串**（小写、不含 .exe），大小写和完整路径都不影响。
/// 要加别的程序，往这里加一项即可。
const PASS_THROUGH_PROCS: &[&str] = &["lazytyper"];

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

/// 取进程可执行文件名（小写，不含扩展名）。取不到返回空串。
unsafe fn process_stem(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if h.is_null() {
        return String::new();
    }
    let mut buf = [0u16; 512];
    let mut size = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
    CloseHandle(h);
    if ok == 0 || size == 0 {
        return String::new();
    }
    let full = String::from_utf16_lossy(&buf[..size as usize]);
    let name = full.rsplit('\\').next().unwrap_or(&full);
    name.trim_end_matches(".exe").to_lowercase()
}

/// 进程名缓存：pid → (取到的时刻, 名字)。
///
/// 主循环每 50ms 就会问一遍"这个窗口是不是放行程序 / 是不是外壳浮层"，
/// 而 `process_stem` 每次都要 OpenProcess + QueryFullProcessImageName 两个内核调用。
/// 一屏几十个窗口 × 每秒 20 拍 = 每秒上千次内核调用，纯属浪费。
/// 一个进程的映像名在它活着的时候不会变，缓存 1 秒完全够（pid 复用远慢于这个窗口）。
fn stem_cached(pid: u32) -> String {
    const TTL_MS: u64 = 1000;
    const CAP: usize = 256;
    static CACHE: Mutex<Vec<(u32, String, u64)>> = Mutex::new(Vec::new());
    if pid == 0 {
        return String::new();
    }
    let now = now_ms();
    if let Ok(g) = CACHE.lock() {
        if let Some((_, name, at)) = g.iter().find(|(p, _, _)| *p == pid) {
            if now.saturating_sub(*at) < TTL_MS {
                return name.clone();
            }
        }
    }
    let name = unsafe { process_stem(pid) };
    if let Ok(mut g) = CACHE.lock() {
        if let Some(e) = g.iter_mut().find(|(p, _, _)| *p == pid) {
            e.1 = name.clone();
            e.2 = now;
        } else {
            if g.len() >= CAP {
                // 满了就整批清掉：条目少、重建便宜，比写 LRU 简单可靠
                g.clear();
            }
            g.push((pid, name.clone(), now));
        }
    }
    name
}

/// 「外壳浮层」的进程名（小写、不含 .exe）。
///
/// Start 菜单、搜索、任务视图、音量/网络那类飞出面板都在这几个宿主进程里。
/// 它们打开时，**放行程序的小弹窗必须让位**——这正是本次要修的 bug：
/// lazytyper 的语音弹条被我们特意提到遮罩之上（见 PASS_THROUGH_PROCS 的说明），
/// 于是 Start 一打开，它就只能从"开始菜单与任务栏之间的那条缝"里露出来；
/// 而主循环还在不停把它顶回遮罩上方，一顶一摘 → 肉眼看就是持续闪烁。
///
/// 判定用**进程名**而不是窗口类名：`Windows.UI.Core.CoreWindow` 是 UWP 通用类，
/// 拿它判断会把任何 UWP 应用的前台都误当成"浮层打开"，那样弹条就再也不显示了。
const SHELL_FLYOUT_PROCS: &[&str] = &[
    "startmenuexperiencehost",
    "searchhost",
    "shellexperiencehost",
    "textinputhost",
    "startmenu",
];

/// 进程名是否属于"外壳浮层"宿主（纯函数，便于单测）
fn is_shell_flyout_proc(stem: &str) -> bool {
    if stem.is_empty() {
        return false;
    }
    SHELL_FLYOUT_PROCS.iter().any(|p| stem.contains(p))
}

/// 当前前台是不是 Start 菜单 / 搜索 / 任务视图这类外壳浮层。
///
/// 带 50ms 缓存：这个值现在同时决定**遮罩要不要把任务栏那条带也盖住**
/// （见 `paint_cover`），缓存太慢就会在"开始菜单刚弹出来"的头十几帧里
/// 露出旧区域，弹窗正好从那道缝里闪一下。50ms ≈ 主循环一拍，
/// 代价只是一次 GetForegroundWindow + 一次进程名查询，可以忽略。
fn shell_flyout_open() -> bool {
    static CACHE: AtomicU64 = AtomicU64::new(0);   // 高位 = 时刻，bit0 = 上次结果
    let now = now_ms();
    let packed = CACHE.load(Ordering::Relaxed);
    let at = packed >> 1;
    if at != 0 && now.saturating_sub(at) < 50 {
        return (packed & 1) == 1;
    }
    let fg = unsafe { GetForegroundWindow() };
    let v = if fg.is_null() {
        false
    } else {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(fg, &mut pid) };
        let stem = stem_cached(pid);
        is_shell_flyout_proc(&stem)
    };
    CACHE.store((now << 1) | v as u64, Ordering::Relaxed);
    if v {
        FLYOUT_HITS.fetch_add(1, Ordering::Relaxed);
    }
    v
}

/// 给诊断接口用：当前是否处于"外壳浮层打开"状态
pub fn flyout_open_now() -> bool {
    shell_flyout_open()
}

fn is_pass_through(pid: u32) -> bool {
    let stem = stem_cached(pid);
    if stem.is_empty() {
        return false;
    }
    PASS_THROUGH_PROCS.iter().any(|p| stem.contains(p))
}

struct PassCtx {
    out: Vec<Hwnd>,
}

unsafe extern "system" fn pass_through_cb(h: Hwnd, data: isize) -> i32 {
    let ctx = &mut *(data as *mut PassCtx);
    if IsWindowVisible(h) == 0 || is_mask_class(h) {
        return 1;
    }
    let mut pid = 0u32;
    GetWindowThreadProcessId(h, &mut pid);
    if pid != 0 && is_pass_through(pid) {
        ctx.out.push(h);
    }
    1
}

/// 收集放行程序的全部可见顶层窗口
unsafe fn collect_pass_through() -> Vec<Hwnd> {
    let mut ctx = PassCtx { out: Vec::new() };
    EnumWindows(Some(pass_through_cb), &mut ctx as *mut _ as isize);
    ctx.out
}

fn set_except(list: &[Hwnd]) {
    for i in 0..EXCEPT_HWNDS.len() {
        let v = list.get(i).map(|h| *h as isize).unwrap_or(0);
        EXCEPT_HWNDS[i].store(v, Ordering::Relaxed);
    }
}

fn clear_except() {
    for slot in EXCEPT_HWNDS.iter() {
        slot.store(0, Ordering::Relaxed);
    }
}

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
    /// 等消息/事件，替代 sleep 轮询：没有事发生就安静睡着，有事立刻醒
    fn MsgWaitForMultipleObjects(
        count: u32,
        handles: *const *mut std::ffi::c_void,
        wait_all: i32,
        millis: u32,
        wake_mask: u32,
    ) -> u32;
    /// 系统级窗口事件钩子（前台切换、最小化等）。回调投递到注册它的线程。
    fn SetWinEventHook(
        event_min: u32,
        event_max: u32,
        hmod: *mut std::ffi::c_void,
        proc: Option<unsafe extern "system" fn(*mut std::ffi::c_void, u32, Hwnd, i32, i32, u32, u32)>,
        pid: u32,
        thread: u32,
        flags: u32,
    ) -> *mut std::ffi::c_void;
    fn GetTickCount64() -> u64;
    fn CreateEventW(attr: *const u8, manual: i32, initial: i32, name: *const u16) -> *mut std::ffi::c_void;
    fn SetEvent(h: *mut std::ffi::c_void) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
    fn QueryFullProcessImageNameW(
        h: *mut std::ffi::c_void,
        flags: u32,
        buf: *mut u16,
        size: *mut u32,
    ) -> i32;
    fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
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
}

#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(period: u32) -> u32;
    fn timeEndPeriod(period: u32) -> u32;
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
    /// 媒体管控：遮罩生效时自动暂停「被盖住」窗口的媒体播放（真暂停+自动恢复）
    pub media_pause: AtomicBool,
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
            media_pause: AtomicBool::new(false),
            notice: Mutex::new(None),
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
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
    /// 上次建区域时"外壳浮层是否打开"。它一变就必须立刻重建区域：
    /// 浮层开着时整屏覆盖（不挖任务栏），关掉后恢复挖洞。
    cover_flyout: bool,
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
            cover_flyout: false,
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


    /// 覆盖模式：整块铺满，遮罩全程静止。
    ///
    /// 平时只在"任务栏变化"时重建一次固定区域（任务栏要留出来，不能压暗），
    /// 除此之外一帧都不碰窗口区域。这正是覆盖模式比挖洞跟手的根本原因：
    /// 窗口拖动时遮罩根本不需要重绘，视觉上完全由 DWM 合成，没有"迟到一帧"。
    ///
    /// **外壳浮层（开始菜单 / 搜索）打开时反过来**：把任务栏那条带也盖住。
    /// 原因见 `shell_flyout_open` 的说明——被挖掉的那条带正好是开始菜单底边与
    /// 任务栏之间的缝，放行程序（lazytyper）的弹窗就藏在那条缝下面，
    /// 区域一挖开它就露出来。盖上以后它整块被遮罩压住，缝隙处什么都不显示。
    unsafe fn paint_cover(&mut self, alpha: u8, flyout: bool) {
        if self.w <= 0 || self.h <= 0 {
            return;
        }
        // 任务栏枚举（FindWindow + 取矩形）不便宜，而任务栏根本不会毫秒级变化。
        // 挖洞模式静止时靠 need 直接跳过这段，覆盖模式每帧都会走进来，
        // 所以这里必须自己节流——否则光查任务栏就能吃掉三四十个点单核。
        //
        // 但"浮层开关"不能等这 500ms：开始菜单刚弹出来的头几帧如果还在用
        // 旧的挖洞区域，那条缝就在，弹窗就会闪一下。所以状态一变立刻重建一次。
        let flip = flyout != self.cover_flyout;
        if flip || self.cover_t.elapsed().as_millis() >= 500 || self.cover_sig == i64::MIN {
            self.cover_t = Instant::now();
            self.cover_flyout = flyout;
            let bars = if flyout { Vec::new() } else { taskbar_rects() };
            let sig: i64 = bars
                .iter()
                .map(|r| r.left as i64 * 31 + r.top as i64 * 17 + r.right as i64 * 7 + r.bottom as i64)
                .sum::<i64>()
                // 浮层开关也要进签名：否则区域只在"任务栏变了"时才重建，
                // 浮层打开那一刻手上还是旧的挖洞区域，缝照样存在。
                ^ if flyout { 0x5F_1F_00 } else { 0 };
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

    /// 把遮罩顶到置顶带的最前面（盖住一切置顶浮窗）。
    ///
    /// 用在"Start 菜单 / 搜索打开"的时候：那会儿不需要再给选中窗口留亮区
    /// （它本来就被开始菜单挡住了），但必须压住 lazytyper 那类小弹窗。
    ///
    /// 为什么是"抬自己"而不是"摘对方"：对方是自动置顶的窗口，
    /// 我们摘一次它立刻加回来，两边 50ms 拉一次锯 —— 那就是用户看到的闪烁。
    /// 抬自己是一次性动作，对方再调 `SetWindowPos(HWND_TOPMOST)` 对已经置顶的
    /// 窗口是空操作，抢不回去。
    unsafe fn raise_top(&mut self) {
        if self.hwnd.is_null() || IsWindow(self.hwnd) == 0 {
            return;
        }
        let ex = GetWindowLongW(self.hwnd, GWL_EXSTYLE) as u32;
        if (ex & WS_EX_TOPMOST_FLAG) == 0 {
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
        SetWindowPos(
            self.hwnd,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
        mark_self_action();
    }

    /// 把遮罩锚定到选中窗口的正下方（三层结构见 `reassert_below`）
    unsafe fn anchor_under(&mut self, anchor: Hwnd, except: &[Hwnd]) {
        if !self.shown {
            return;
        }
        reassert_below(self.hwnd, anchor, except);
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
        if keep.contains(&r.hwnd) {
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

/// 同上，但显式排除 `target_pid`（被选中/跟随的那个窗口所属进程）。
unsafe fn collect_covered_pids_with_target(target_pid: u32, exempt: &[Hwnd]) -> Vec<u32> {
    unsafe extern "system" fn cb(h: Hwnd, lp: isize) -> i32 {
        let ctx = &mut *(lp as *mut CoverCtx);
        if IsWindowVisible(h) == 0 {
            return 1;
        }
        if is_mask_class(h) || is_shell_window(h) {
            return 1;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(h, &mut pid);
        if pid == 0 || pid == std::process::id() || pid == ctx.target_pid {
            return 1;
        }
        if ctx.exempt.contains(&h) {
            return 1;
        }
        if !ctx.out.contains(&pid) {
            ctx.out.push(pid);
        }
        1
    }
    struct CoverCtx {
        target_pid: u32,
        exempt: Vec<Hwnd>,
        out: Vec<u32>,
    }
    let mut ctx = CoverCtx {
        target_pid,
        exempt: exempt.to_vec(),
        out: Vec::new(),
    };
    EnumWindows(Some(cb), &mut ctx as *mut _ as isize);
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
            // Windows 11 开始菜单 / 搜索 / 任务视图 / 输入法切换：
            // 这些都是 shell/系统外壳，一旦被摘掉 TOPMOST 会被 DWM 强行加一圈边框，
            // 就是用户看到的"开始菜单与任务栏之间多出一条缝隙/闪烁"。
            | "LauncherTipWnd"
            | "MultitaskingViewFrame"
            | "XamlExplorerHostIslandWindow"
            | "Windows.Internal.Shell.TabProxyWindow"
            | "Shell_InputSwitchTopLevelWindow"
            | "ShellInputSwitchWindow"
            | "Windows.UI.Composition.DesktopWindowContentBridge"
            | "Windows.Internal.Shell.StartMenuExperienceHost"
            | "SearchPane"
            | "TaskSwitcherWnd"
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
/// 遮罩允许把洞挖在自己身上——用户明确要求"专注遮罩也要盖住 King Of Focus 自己"。
pub static SELF_MAIN: AtomicIsize = AtomicIsize::new(0);

/// 把主窗口抬到置顶带的最前面。
///
/// 只调 `set_always_on_top(true)` 不一定能把窗口"浮上来"：如果它已经是
/// WS_EX_TOPMOST，再设一次属性是空操作，窗口仍旧被别的置顶窗口压着。
/// 真正确保"浮到最前"的做法是 `SetWindowPos(HWND_TOPMOST)`，
/// 再配合 HWND_TOP 提到置顶带顶端。
pub fn raise_self() {
    let h = SELF_MAIN.load(Ordering::Relaxed) as Hwnd;
    if h.is_null() {
        return;
    }
    unsafe {
        if IsWindow(h) == 0 {
            return;
        }
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        SetWindowLongW(h, GWL_EXSTYLE, (ex | WS_EX_TOPMOST_FLAG) as i32);
        SetWindowPos(
            h,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
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
}

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

/// 把遮罩**锚定**到 `anchor`（被选中的那个窗口）的正下方。
///
/// 这是三层结构的核心：
///
/// ```text
///   最上  anchor（被点中的应用）   ← 最高优先级，永远不被遮罩盖住
///         mask  （遮罩）          ← 紧贴锚点下方，压住其余一切
///   最下  其他应用                 ← 普通层级，被遮罩直接盖掉
/// ```
///
/// 关键在 `SetWindowPos(mask, anchor, …)`：`hWndInsertAfter` 传窗口句柄时，
/// 语义是"把 mask 放到 anchor 后面（z 序更靠下）"。一次调用同时做到两件事——
/// 提过所有别的窗口、又永远不越过 anchor。
///
/// 上一版用的是 `HWND_TOP`（提到置顶带最顶），那必然先越过 anchor，
/// 再由主循环把 anchor 提回来；250Hz 的守护线程和主循环之间就形成稳定拉锯，
/// 用户看到的是内容不停闪。改成锚定之后这个来回从结构上就不存在了。
///
/// 稳定态下（遮罩已贴着锚点、锚点上方也没浮窗）这个函数**不做任何窗口操作**，
/// 只花两次 z 序查询，所以 250Hz 也没有开销压力。
unsafe fn reassert_below(hwnd: Hwnd, anchor: Hwnd, except: &[Hwnd]) {
    if hwnd.is_null() || IsWindow(hwnd) == 0 {
        return;
    }
    if IsWindowVisible(hwnd) == 0 {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }

    let anchor_ok = !anchor.is_null() && IsWindow(anchor) != 0 && IsWindowVisible(anchor) != 0;

    // 遮罩正上方"第一个可见窗口"
    let mut w = GetWindow(hwnd, GW_HWNDPREV);
    let mut guard = 0;
    let mut first_above: Hwnd = std::ptr::null_mut();
    while !w.is_null() && guard < 64 {
        guard += 1;
        if IsWindowVisible(w) != 0 {
            first_above = w;
            break;
        }
        w = GetWindow(w, GW_HWNDPREV);
    }

    if !anchor_ok {
        // 没有锚点（目标还没出现/已消失）：退回"抢最顶"，别让遮罩被浮窗盖住
        if first_above.is_null() {
            return;
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
            mark_self_action();
        } else {
            RAISE_FAIL.fetch_add(1, Ordering::Relaxed);
            RAISE_ERR.store(GetLastError(), Ordering::Relaxed);
        }
        return;
    }

    // 锚点必须是置顶窗口，否则遮罩锚到它下面会一起掉出置顶带，
    // 反过来被普通窗口盖住。
    let aex = GetWindowLongW(anchor, GWL_EXSTYLE) as u32;
    if (aex & WS_EX_TOPMOST_FLAG) == 0 {
        SetWindowPos(
            anchor,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
    }

    // 已经紧贴锚点下方 → 不用动窗口，省掉一次 z 序重排（也就没有重绘抖动）
    if first_above != anchor {
        let ok = SetWindowPos(
            hwnd,
            anchor as isize,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
        if ok != 0 {
            RAISE_OK.fetch_add(1, Ordering::Relaxed);
            mark_self_action();
        } else {
            RAISE_FAIL.fetch_add(1, Ordering::Relaxed);
            RAISE_ERR.store(GetLastError(), Ordering::Relaxed);
        }
    }

    // 把**所有**压在遮罩上面的外部置顶窗口都摘出置顶带。
    //
    // 为什么要扫全部、而不是只看紧邻的那一个：
    // 之前的写法遇到 `is_shell_window` 或自己人就 `break`，只要最上面先撞上
    // 任务栏/输入法/别的浮窗，后面真正碍事的 lazytyper 那条横条就永远扫不到——
    // 这就是"遮罩一直遮不住它"的直接原因。
    //
    // 遮罩本身是置顶窗口，所以它 z 序**上方**只剩置顶带里的窗口：
    // 选中窗口（except，跳过）和那些抢置顶的浮窗（要摘）。普通窗口都在遮罩下面，
    // 不会出现在这条链里，所以这个扫描范围是精确的、不会误伤普通窗口。
    // 外壳浮层（Start / 搜索 …）打开时，放行程序的窗口不再享受"永久豁免摘顶"：
    // 它们这会儿只会从缝里露出来，必须能和普通浮窗一样被摘下去。
    let flyout = shell_flyout_open();
    if IS_ADMIN.load(Ordering::Relaxed) {
        let mut a = GetWindow(hwnd, GW_HWNDPREV);
        let mut g2 = 0;
        while !a.is_null() && g2 < 64 {
            g2 += 1;
            // 放行程序（lazytyper 等）的窗口**永久豁免摘顶**——
            // 这是"弹条闪烁"的根因：摘顶扫描把弹条当"碍事浮窗"摘掉 TOPMOST，
            // 主循环 ensure_above 又顶回去，形成 8ms 级拉锯。
            // 弹条本来就是要显示的，摘它毫无道理，直接跳过。
            // 用 `is_pass_through` 按 pid 判定，不依赖 except 名单的时序。
            let mut pid_a = 0u32;
            GetWindowThreadProcessId(a, &mut pid_a);
            let is_pass = pid_a != 0 && is_pass_through(pid_a) && !flyout;
            if IsWindowVisible(a) != 0
                && !except.contains(&a)
                && !is_shell_window(a)
                && !is_mask_class(a)
                && !is_pass
            {
                let ex = GetWindowLongW(a, GWL_EXSTYLE) as u32;
                if (ex & WS_EX_TOPMOST_FLAG) != 0 {
                    SetWindowLongW(a, GWL_EXSTYLE, (ex & !WS_EX_TOPMOST_FLAG) as i32);
                    SetWindowPos(
                        a,
                        HWND_NOTOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                    );
                    RAISE_DROP.fetch_add(1, Ordering::Relaxed);
                    remember_demoted(a);
                    // 抓到一次抢位 → 进入短时高频窗口，防止它马上又抢回来。
                    // 这是"按需升频"，不是拿高频当常态：摘干净后 400ms 自动回落。
                    DISTURBED_AT.store(now_ms(), Ordering::Relaxed);
                }
            }
            a = GetWindow(a, GW_HWNDPREV);
        }
    }
}

pub fn start(ctl: std::sync::Arc<MaskCtl>) {
    // 先提定时器精度：事件驱动之后不再靠高频轮询，但少数场景（刚被抢位后的
    // 短促纠正窗口）仍需 8ms 级别的等待精度。
    unsafe {
        timeBeginPeriod(1);
    }
    IS_ADMIN.store(crate::cmds::is_admin(), Ordering::Relaxed);
    thread::spawn(move || unsafe {
        // 混合 DPI 下必须拿物理像素，否则洞和遮罩对不齐
        SetThreadDpiAwarenessContext(-4);

        // 事件钩子：只在本线程（有消息泵）注册，回调也会投递到这里。
        //
        // 范围为什么是 FOREGROUND..MINIMIZEEND 而**不含 EVENT_OBJECT_REORDER**：
        // 试过监听 REORDER（z 序变化），确实能第一时间发现浮窗抢位，但那个事件
        // 在整个桌面范围里极其高频——任何窗口的位置/层级变动都会触发，结果就是
        // 主循环被唤醒得比原来的定时轮询还勤（实测 237 次/秒，CPU 反而从 2% 涨到 6%）。
        // 那不是"事件驱动"，是把轮询换了个马甲。
        //
        // 现在的分工：
        //   · 前台切换 / 最小化 → 事件即时唤醒（这类事件本来就低频，且必须秒回）
        //   · 浮窗抢置顶 → 由兜底检查发现，发现后进入短时高频压制（见 DISTURBED_AT）
        let hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_MINIMIZEEND,
            std::ptr::null_mut(),
            Some(win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        // 单独再挂一个"窗口显示"钩子。EVENT_OBJECT_SHOW 在 0x8002 段，
        // 和上面那段系统事件不相邻，没法用同一个区间覆盖，只能分开注册。
        let hook_show = SetWinEventHook(
            EVENT_OBJECT_SHOW,
            EVENT_OBJECT_SHOW,
            std::ptr::null_mut(),
            Some(win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        mlog(&format!("WinEvent 钩子 {:?} / show {:?}", hook, hook_show));

        // 状态变更的唤醒通道。必须在这里（遮罩线程启动时）创建，
        // 因为 wait_event 只在这个线程里用。
        let we = CreateEventW(std::ptr::null(), 0, 0, std::ptr::null());
        WAKE.store(we as isize, Ordering::Relaxed);

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
        let mut hk_gen_done = 0u32;
        let mut logged_miss = false;
        let mut lost: Option<Instant> = None;
        let mut last_hole: Option<Rect> = None;
        let mut last_top = Instant::now();
        let mut followed_key: isize = 0;
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
        // 放行程序（lazytyper 语音弹条等）的可见窗口，定期重收
        let mut pass_wins: Vec<Hwnd> = Vec::new();
        let mut pass_t = Instant::now();
        // 上一帧的选中窗口句柄：变了才说明"刚切换过目标"，需要短周期快速收敛
        #[allow(unused_assignments)]
        let mut last_tgt: isize = 0;

        loop {
            // ---- 强制退出收尾 ----
            // 走到这里说明进程准备退出了：把该还的东西还回去，别在桌面上
            // 留一个黑色覆盖层，也别占着系统定时器精度。
            if STOP.load(Ordering::Relaxed) {
                for o in overlays.iter_mut() {
                    o.destroy();
                }
                overlays.clear();
                publish_overlays(&overlays);
                // 被我们临时提到置顶带上的窗口要还回去，
                // 否则用户自己的播放器会永久挂在最上层。
                release_raised(&mut raised, &[]);
                restore_demoted();
                UnregisterHotKey(std::ptr::null_mut(), 0xA1);
                timeEndPeriod(1);
                mlog("遮罩线程收到停止指令，已收尾退出");
                return;
            }
            // ---- 先等，再干活 ----
            // 事件驱动：前台切换 / 最小化 / 新窗口显示都会把我们从等待里叫醒，
            // 没事件时线程真正阻塞（CPU≈0），不再靠固定频率轮询去"发现"变化。
            // 兜底超时只在"确实有变化的余波期"缩短（8ms），平时 500ms 只是防止
            // 极端情况下漏事件，不承担响应性——响应性由事件保证。
            //
            // scan_now：有放行程序的新窗口刚冒出来，不等了，立刻重收名单。
            let scan_now = SCAN_NOW.swap(false, Ordering::Relaxed);
            if !scan_now {
                let disturbed =
                    now_ms().saturating_sub(DISTURBED_AT.load(Ordering::Relaxed)) < 400;
                let want_on =
                    ctl.on.load(Ordering::Relaxed) || ctl.auto_follow.load(Ordering::Relaxed);
                let t = if !want_on {
                    1000
                } else if disturbed {
                    8
                } else {
                    500
                };
                wait_event(t);
            }

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
            let block_click = ctl.block_click.load(Ordering::Relaxed);
            // 媒体管控：跟随遮罩开关。关/收起时把我们停过的媒体全部还原。
            let media_on = ctl.media_pause.load(Ordering::Relaxed);
            let media_should_run = media_on && on;
            if media_should_run {
                crate::media::set_active(true);
            } else {
                // set_active(false) 内部会 resume_all，一次搞定开关+还原
                crate::media::set_active(false);
            }

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

            // 遮罩是瞬开瞬关：没有过渡、没有延时。on 且拿得到目标就是全亮，
            // 否则整块收起。上一版残留的 progress 状态机已删除。
            if !on || target.is_none() {
                for o in overlays.iter_mut() {
                    o.hide();
                }
                // 遮罩收起 → 把之前临时提到最上层的窗口全部还原。
                // 不做这一步，用户用过的窗口会一直挂在我们制造的 topmost 上。
                release_raised(&mut raised, &[]);
                clear_except();
                // 被我们摘掉置顶的外部窗口也要还回去，别留在普通层级
                restore_demoted();
                popups.clear();
                popup_pid = 0;
                ctl.painted.store(false, Ordering::Relaxed);
                MASK_ACTIVE.store(false, Ordering::Relaxed);
                // 这里也要刷新诊断，否则界面会一直显示上一次的"已开启/洞口"
                // 关闭态循环只有 1 次/秒，这里不必节流：
                // 不刷新的话，用户点了关闭、界面「自查」还会显示"已开启"好几百毫秒，
                // 看起来就像"关不掉"。
                {
                    let report = format!(
                        "on={} painted=false{} 置顶={} 跟随窗口={:#x} 手动={:#x} 覆盖={:#x} 窗口=(0,0,0,0) 覆盖层=0 副屏={}",
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
                continue;
            }

            let t = target.unwrap();
            // 目标矩形（屏幕坐标）。只用于诊断展示，不影响渲染——
            // 遮罩不动，窗口自己浮上去。
            let hole_end = t;
            // 不透明度直接到位，没有任何淡入
            let alpha = (opacity * 255.0).round().clamp(0.0, 255.0) as u8;
            if alpha == 0 {
                for o in overlays.iter_mut() {
                    o.hide();
                }
                continue;
            }

            // 这一拍只查一次"外壳浮层开没开"：它同时决定
            //   ① 遮罩要不要把任务栏那条带也盖住（paint_cover）
            //   ② 要不要把放行程序的弹窗顶回遮罩之上
            // 之前这里散着查了三四次，每次都过一次 GetForegroundWindow + 查进程名。
            let flyout_now = shell_flyout_open();

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
                    o.paint_cover(alpha, flyout_now);
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
                // ---- 放行程序的窗口（lazytyper 的语音识别弹条等）----
                // 500ms 定时 + SCAN_NOW（刚弹出来的那一刻）双触发。
                // 拿到名单后，无论有没有变化都**立刻**把它们顶上去：
                // 这是"弹条贴着任务栏缝隙被压下去又浮上来"的最后一道保险——
                // 就算摘顶扫描 / show 钩子之间有几十毫秒的窗口，这里每 500ms
                // 也会再兜一次，弹条不会再出现持续闪烁。
                if pass_t.elapsed().as_millis() >= 500 || scan_now {
                    pass_t = Instant::now();
                    pass_wins = collect_pass_through();
                    // 浮层打开时不顶：顶上去只会露在 Start 与任务栏之间的缝里闪
                    if !flyout_now {
                        for h in pass_wins.iter() {
                            ensure_above(*h, &mut raised);
                        }
                    }
                }
                if tgt != 0 {
                    self_wins.push(tgt as Hwnd);
                }
                for h in popups.iter() {
                    if *h != tgt as Hwnd {
                        self_wins.push(*h);
                    }
                }
                for h in pass_wins.iter() {
                    if *h != tgt as Hwnd && !self_wins.iter().any(|x| x == h) {
                        self_wins.push(*h);
                    }
                }
                release_raised(&mut raised, &self_wins);
                // 主窗口先提，弹窗/放行窗口后提 —— 后提的在上
                if tgt != 0 {
                    ensure_above(tgt as Hwnd, &mut raised);
                }
                // ---- 媒体管控：暂停「被盖住」进程的媒体（真暂停，回到前台自动恢复）----
                // 节奏：与 popups 同级（500ms）重算名单，避免每帧都 EnumWindows。
                if media_should_run && (popup_t.elapsed().as_millis() >= 500 || scan_now) {
                    let covered = collect_covered_pids_with_target(tpid, &self_wins);
                    crate::media::pause_covered(&covered);
                }
                for h in popups.iter() {
                    if *h != tgt as Hwnd {
                        ensure_above(*h, &mut raised);
                    }
                }
                // 放行程序的窗口：ensure_above 内部会跳过 z 序没被遮罩压住的窗口，
                // 所以即使每轮都调一遍也不会造成多余 SetWindowPos。
                // 刚才在重收 pass_wins 时已经立刻顶过一次，这里再兜一遍：
                // 万一摘顶扫描在两轮之间把弹条摘下来了，最多 50ms 就会被捞回来，
                // 而不是等下一次 500ms 定时扫描。
                for h in pass_wins.iter() {
                    if *h != tgt as Hwnd {
                        ensure_above(*h, &mut raised);
                    }
                }
                ctl.painted.store(true, Ordering::Relaxed);
                MASK_ACTIVE.store(true, Ordering::Relaxed);
                // 只有"换了目标"才算一次动作，用它驱动短周期；
                // 否则每帧都刷新时间戳，短周期会永远生效、白烧 CPU。
                last_tgt = tgt;
                // 遮罩本身不重绘，所以这里**不累加** stat_n：
                // 自查里看到 fps=0 就说明"遮罩一帧都没画"，这正是零延迟的根据。
                stat_paint_us += t_paint.elapsed().as_micros() as u64;
            }
            // 把"自己人"和锚点告诉守护线程（无锁原子写，永远不会读不到）
            set_except(&self_wins);
            ANCHOR_HWND.store(last_tgt, Ordering::Relaxed);

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

            // 层级维持（三层结构的落地）。
            // 遮罩锚在选中窗口正下方，浮窗抢位由守护线程高频处理；这里 50ms 兜一次。
            // 注意：这里**不再**调用 strip_topmost_above —— 它会把选中窗口上方的
            // 一切（包括锚点本身）都降级，和"被点击的应用最高优先级"直接冲突。
            // 摘顶只对"压在锚点头上的那一个"做，逻辑收在 reassert_below 里。
            if last_top.elapsed().as_millis() >= 50 {
                last_top = Instant::now();
                let anchor = last_tgt as Hwnd;
                if flyout_now {
                    // 外壳浮层（Start / 搜索）打开：遮罩抬到最前面，压住其它自动置顶的小窗。
                    for o in overlays.iter_mut() {
                        o.raise_top();
                        FLYOUT_COVER.fetch_add(1, Ordering::Relaxed);
                    }
                } else {
                    for o in overlays.iter_mut() {
                        o.anchor_under(anchor, &self_wins);
                    }
                }

                // 放行程序（lazytyper 语音弹条）**任何情况下都保持显示**：
                // 之前试过浮层打开时让它隐身（DWM cloak / SW_HIDE）来消掉"缝里闪"，
                // 但那等于把用户的横条藏起来，而且浮层一开一关就是一次可见性抖动。
                // 现在只有一个方向的动作 —— 始终把它顶到遮罩之上，不去摘它的置顶、
                // 也不压到遮罩下面，所以不存在"遮罩压 / 横条顶"的对拉，也就不会闪。
                PASS_WINS.store(pass_wins.len() as u32, Ordering::Relaxed);
                for h in pass_wins.iter() {
                    ensure_above(*h, &mut raised);
                }
            }

            // 每 1s 更新一次诊断快照（界面上的「自查」按钮读它）
            // 诊断快照不限流：这里每秒才走到几次（事件驱动），
            // 而界面「自查」要靠它立刻反映开关状态，节流会让"刚点开"看起来没反应。
            {
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
                    "on={} painted={}{} 抬升={}/{} err={} 摘顶={} 事件={} 跟随窗口={:#x} 手动={:#x} 覆盖={:#x} alpha={} fps={} 循环={}/s 单帧={:.1}ms 置顶={} 窗口=({},{},{},{}) 覆盖层={} 副屏={}",
                    ctl.on.load(Ordering::Relaxed),
                    ctl.painted.load(Ordering::Relaxed),
                    if follow { " 跟随前台" } else { "" },
                    RAISE_OK.load(Ordering::Relaxed),
                    RAISE_FAIL.load(Ordering::Relaxed),
                    RAISE_ERR.load(Ordering::Relaxed),
                    RAISE_DROP.load(Ordering::Relaxed),
                    EVENT_COUNT.load(Ordering::Relaxed),
                    followed_key,
                    ctl.manual_hwnd.load(Ordering::Relaxed),
                    FOLLOW_OVERRIDE.load(Ordering::Relaxed),
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

            // 循环末尾不再 sleep：下一轮开头会 wait_event，
            // 没有新事件就一直睡着。这里只把事件标志复位。
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(l: i32, t: i32, rr: i32, b: i32) -> Rect {
        Rect { left: l, top: t, right: rr, bottom: b }
    }


    /// 外壳浮层的识别规则：只认那几个系统宿主进程。
    ///
    /// 这条是"打开开始菜单时 lazytyper 弹条从缝里露出来"那个 bug 的判据回归。
    /// 匹配太宽（比如用 UWP 通用窗口类）会把普通应用也当成浮层，弹条就永远不显示了；
    /// 匹配太窄则等于没修。
    #[test]
    fn shell_flyout_proc_matching() {
        // Start 菜单 / 搜索 / 壳层飞出面板 / 输入法面板
        assert!(is_shell_flyout_proc("startmenuexperiencehost"));
        assert!(is_shell_flyout_proc("searchhost"));
        assert!(is_shell_flyout_proc("shellexperiencehost"));
        assert!(is_shell_flyout_proc("textinputhost"));
        // 放行程序自己、资源管理器、本程序都不能被当成浮层
        assert!(!is_shell_flyout_proc("lazytyper"));
        assert!(!is_shell_flyout_proc("explorer"));
        assert!(!is_shell_flyout_proc("king-of-focus"));
        assert!(!is_shell_flyout_proc(""));
    }

    /// 放行名单与浮层名单必须是两套东西：混在一起会让"正常使用时弹条不显示"
    #[test]
    fn pass_through_and_flyout_lists_are_disjoint() {
        for p in PASS_THROUGH_PROCS {
            assert!(
                !SHELL_FLYOUT_PROCS.iter().any(|f| p.contains(f) || f.contains(p)),
                "放行程序不应同时被当成外壳浮层：{p}"
            );
        }
    }
}
