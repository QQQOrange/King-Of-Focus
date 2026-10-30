//! 媒体管控：遮罩生效时自动暂停「被盖住 / 非前台」窗口的媒体播放，
//! 窗口回到前台 / 呈现状态时恢复。
//!
//! 用 WinRT 的 `GlobalSystemMediaTransportControlsSessionManager`（SMTC，
//! Windows 10 1809+ 的系统媒体传输控件）：这是 Windows 自己给"当前正在播放
//! 的媒体"做的统一入口，浏览器标签、网易云、PotPlayer、Spotify……只要接了
//! SMTC 就能被枚举、被暂停/恢复。
//!
//! 为什么不用模拟媒体键（VK_MEDIA_PLAY_PAUSE）：媒体键只停"最近活跃的那一个
//! 会话"，而我们要的是**精确暂停特定窗口**的媒体；键控做不到。也不去点播放器
//! 的暂停按钮（千人千面不可靠）。
//!
//! 状态判断与恢复策略：
//!   · 触发条件 = 遮罩生效，且某媒体会话对应的进程正被遮罩盖住（非前台/非呈现）。
//!     "是否被盖住"由 mask.rs 判定后把 pid 名单喂进来（`pause_covered`）。
//!   · 只暂停**能归因到被盖住进程**的会话（见 `names_of_pids`：进程名 + 产品名），
//!     归因不了的不动，避免误停用户正听的、不属于被盖窗口的后台音乐。
//!   · 恢复：窗口回到前台 / 遮罩关 / 开关关掉 → 只还原**我们主动暂停过**的
//!     会话（记在 PAUSED_BY_US），绝不碰用户自己主动暂停的媒体。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use windows::core::HSTRING;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
};

/// 我们主动暂停过的会话：AUMID → (会话句柄, 是否原本在播放)。
/// 「是否原本在播放」用于恢复时区分：原本就在暂停/停止态的会话，只解除记录、不发 TryPlay，
/// 否则会把用户自己主动暂停的视频/音乐又播起来。
/// HashMap::new 不是 const，static 里只能用 LazyLock 延迟到首次使用时构造。
static PAUSED_BY_US: LazyLock<Mutex<HashMap<String, (Session, bool)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static MEDIA_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 诊断用：上一次检查的时间与摘要（界面的「自查」会显示）。
static LAST_TICK: AtomicU64 = AtomicU64::new(0);
static LAST_RUN: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(String::new()));

/// 进程名缓存：被盖住的窗口每 500ms 重算一次，但进程名单大多不变；
/// 每次都去读版本信息太浪费（一屏二三十个进程就是二三十次文件解析）。
static NAME_CACHE: LazyLock<Mutex<(Vec<u32>, Vec<String>)>> =
    LazyLock::new(|| Mutex::new((Vec::new(), Vec::new())));

thread_local! {
    /// 防御性初始化：WinRT 在**没初始化过公寓**的线程上不保证能激活对象
    /// （实测本机 Win11 会自动落到 MTA，但老系统/老版本有拿不到管理器的情况）。
    /// 遮罩线程是裸 Win32 线程，扫尾线程又是 tokio 的，都不是我们控制的，
    /// 所以每次用到 SMTC 前先确保线程在 MTA 里。幂等；已是别的套间
    /// （S_FALSE / RPC_E_CHANGED_MODE）也照常可用，错误一律忽略。
    static MTA: () = unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    };
}

fn ensure_mta() {
    MTA.with(|_| ());
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn note(s: &str) {
    if let Ok(mut g) = LAST_RUN.lock() {
        *g = s.to_string();
    }
}

/// 自查用的一行摘要：开关 / 暂停数 / 上次检查距今 / 上次结果。
pub fn diag() -> String {
    let t = LAST_TICK.load(Ordering::Relaxed);
    let age = if t == 0 {
        "还没跑过".to_string()
    } else {
        format!("{:.1}s 前", (now_ms().saturating_sub(t)) as f64 / 1000.0)
    };
    let last = LAST_RUN.lock().map(|s| s.clone()).unwrap_or_default();
    let paused = PAUSED_BY_US.lock().map(|g| g.len()).unwrap_or(0);
    format!(
        "{} · 暂停中 {} · 上次检查 {} {}",
        if is_active() { "开" } else { "关" },
        paused,
        age,
        last
    )
}

/// 查询会话当前是否处于「播放中」。SMTC 状态由播放器异步上报，
/// 拿不到 PlaybackInfo / 状态时保守返回 true（宁可多发一次 TryPlay，
/// 也不要误判成"用户暂停"把正在播的音乐停在暂停态）。
fn was_playing(sess: &Session) -> bool {
    match sess.GetPlaybackInfo().and_then(|info| info.PlaybackStatus()) {
        Ok(status) => status
            == windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing,
        Err(_) => true,
    }
}

/// 媒体管控开/关（由遮罩设置驱动）。关掉时立刻恢复所有被我们暂停的媒体。
pub fn set_active(on: bool) {
    MEDIA_ACTIVE.store(on, Ordering::Relaxed);
    if !on {
        resume_all();
    }
}

pub fn is_active() -> bool {
    MEDIA_ACTIVE.load(Ordering::Relaxed)
}

/// 取 SMTC 会话管理器。WinRT 未就绪 / 系统不支持时返回 None，调用方静默降级。
fn session_manager() -> Option<SessionManager> {
    ensure_mta();
    // RequestAsync 直接给 IAsyncOperation；get() 是阻塞等待完成，SMTC 本地立即就绪。
    // get() 本身返回 Result<SessionManager, Error>，外面不要再套 .ok() 再 and_then。
    SessionManager::RequestAsync()
        .ok()
        .and_then(|op| op.get().ok())
}

/// 归一化：只留 ASCII 字母数字并小写。"Microsoft Edge" → "microsoftedge"
fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn push_name(out: &mut Vec<String>, raw: &str, min: usize) {
    let n = norm(raw);
    if n.len() >= min && !out.contains(&n) {
        out.push(n);
    }
}

/// 一个进程可能被 SMTC 用不同名字引用，两个都收：
///   · 进程名："msedge.exe" → "msedge"
///   · 产品名："Microsoft Edge" → "microsoftedge"
/// 只比进程名会漏掉 Edge 这类"AUMID 用产品名、进程名却是缩写"的播放器。
fn names_of_pids(pids: &[u32]) -> Vec<String> {
    if pids.is_empty() {
        return Vec::new();
    }
    if let Ok(g) = NAME_CACHE.lock() {
        if g.0 == pids {
            return g.1.clone();
        }
    }
    let mut out: Vec<String> = Vec::new();
    for pid in pids {
        let path = crate::proc::exe_path(*pid);
        if path.is_empty() {
            continue;
        }
        if let Some(name) = crate::proc::exe_name_of(*pid) {
            push_name(&mut out, &name.to_lowercase().replace(".exe", ""), 3);
        }
        if let Some(desc) = crate::appname::product_name(&path) {
            push_name(&mut out, &desc, 4);
        }
    }
    if let Ok(mut g) = NAME_CACHE.lock() {
        *g = (pids.to_vec(), out.clone());
    }
    out
}

/// AUMID 是否指向这些名字里的某一个。
///
/// 双向包含：AUMID 可能是全称（"MicrosoftEdge"）、也可能是简称（"Chrome"，
/// 而进程名是 "Google Chrome" → "googlechrome"）。太短的名字不参与反向匹配，
/// 免得 "app" 这种碎片把不相干的会话也算进来。
fn aumid_matches(aumid: &str, names: &[String]) -> bool {
    let a = norm(aumid);
    if a.is_empty() || names.is_empty() {
        return false;
    }
    for n in names {
        if n.is_empty() {
            continue;
        }
        if a.contains(n.as_str()) {
            return true;
        }
        if a.len() >= 4 && n.contains(a.as_str()) {
            return true;
        }
    }
    false
}

/// 暂停所有「非前台 / 被遮住」进程对应的媒体会话。
///
/// `covered_pids`：当前被遮罩盖住（非呈现）的进程 id 名单，由 mask.rs 喂进来。
/// 只暂停能归因到这些进程的会话；动过的记进 PAUSED_BY_US，恢复时只还原这些。
pub fn pause_covered(covered_pids: &[u32]) {
    LAST_TICK.store(now_ms(), Ordering::Relaxed);
    if !MEDIA_ACTIVE.load(Ordering::Relaxed) {
        note("未开启");
        return;
    }
    // 名单空了也要走一遍恢复：目标换到前台后，原来那批被停的会话得放出来。
    // resume_uncovered 内部只对"不在名单里的记录"动手，空名单=全部还原。
    if covered_pids.is_empty() {
        resume_all();
        note("没有目标窗口，已全部还原");
        return;
    }
    let Some(mgr) = session_manager() else {
        note("拿不到 SMTC 会话管理器（WinRT 不可用）");
        return;
    };
    let Ok(sessions) = mgr.GetSessions() else {
        note("枚举会话失败");
        return;
    };
    let Ok(size) = sessions.Size() else {
        note("会话数量读取失败");
        return;
    };
    let names = names_of_pids(covered_pids);
    let mut hit: Vec<String> = Vec::new();

    for i in 0..size {
        let Ok(sess) = sessions.GetAt(i) else { continue };
        let aumid = sess
            .SourceAppUserModelId()
            .map(|h: HSTRING| h.to_string())
            .unwrap_or_default();
        if aumid.is_empty() || !aumid_matches(&aumid, &names) {
            continue;
        }
        // 已经记录过就不用再停（避免重复发暂停、重复入表）
        if PAUSED_BY_US.lock().map(|g| g.contains_key(&aumid)).unwrap_or(false) {
            continue;
        }
        // 先读"原本在不在播"再暂停：TryPauseAsync 之后状态多半已经变成 Paused，
        // 那时再读会把"本来在播"判成"本来没播"，恢复时就再也不会 TryPlay 了
        // （媒体被停住、怎么都不回来，就是从这里开始的）。
        let wp = was_playing(&sess);
        // TryPauseAsync：fire-and-forget（异步结果不等，够用；要精确等会拖慢遮罩帧）
        if sess.TryPauseAsync().is_ok() {
            if let Ok(mut g) = PAUSED_BY_US.lock() {
                g.insert(aumid.clone(), (sess, wp));
            }
            hit.push(aumid);
        }
    }
    // 原来在名单里的、这轮不在名单里的（窗口回到前台/呈现了）→ 恢复
    resume_uncovered(&names);

    if hit.is_empty() {
        note(&format!("会话 {} 个，没有命中被盖住的进程", size));
    } else {
        note(&format!("会话 {} 个，暂停了 {}", size, hit.join("、")));
    }
}

/// 恢复「已不在被盖住名单里」的会话（窗口回到前台 / 呈现状态时的自动恢复）。
fn resume_uncovered(names: &[String]) {
    let Ok(mut g) = PAUSED_BY_US.lock() else { return };
    let stale: Vec<String> = g
        .keys()
        .filter(|aumid| !aumid_matches(aumid, names))
        .cloned()
        .collect();
    for k in stale {
        if let Some((sess, was_play)) = g.remove(&k) {
            if was_play {
                let _ = sess.TryPlayAsync();
            }
        }
    }
}

/// 恢复我们暂停过的所有会话并清空记录（只还原我们动过的）。
pub fn resume_all() {
    let Some(mut g) = PAUSED_BY_US.lock().ok() else { return };
    if g.is_empty() {
        return;
    }
    for (_, (sess, was_play)) in g.drain() {
        if was_play {
            let _ = sess.TryPlayAsync();
        }
    }
}

/* ───────── 休息结束收尾用：只暂停"确实在播放"的会话 ─────────
 *
 * 和上面的 `pause_covered` 有两个关键区别：
 *   1. **只在状态明确是 Playing 时**才动手。拿不到状态、已暂停、已停止 →
 *      一律不碰。上面的 pause_covered 走的是"宁可多发一次"的保守策略，
 *      这里刚好相反：收尾是"顺手把声音停下"，绝不能因为状态读不到就
 *      去按播放键（那会变成"莫名其妙开始放音乐"）。
 *   2. 暂停结果**不记进 PAUSED_BY_US**，也就永远不会被自动恢复。
 *      收尾暂停是单向操作：用户想听，自己点播放。这样不会出现
 *      "遮罩一关 / 窗口回到前台，刚才被收走的视频自己响起来"。
 */

/// 会话的播放状态：`Some(true)` = 正在播放，`Some(false)` = 明确没在播，
/// `None` = 状态读不到（环境不支持 / 播放器没上报）。
fn playback_state(sess: &Session) -> Option<bool> {
    match sess.GetPlaybackInfo().and_then(|info| info.PlaybackStatus()) {
        Ok(st) => Some(
            st == windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing,
        ),
        Err(_) => None,
    }
}

/// 暂停「确实在播放」且能归因到 `pids` 的会话，返回被请求暂停的 AUMID。
///
/// 调用方（休息结束收尾）拿它写日志；返回空 = 没有任何会话需要暂停。
/// 不做自动恢复，也不写入 PAUSED_BY_US —— 见上面注释。
pub fn pause_playing_of(pids: &[u32]) -> Vec<String> {
    let mut done = Vec::new();
    if pids.is_empty() {
        return done;
    }
    let Some(mgr) = session_manager() else { return done };
    let Ok(sessions) = mgr.GetSessions() else { return done };
    let Ok(size) = sessions.Size() else { return done };
    let names = names_of_pids(pids);
    for i in 0..size {
        let Ok(sess) = sessions.GetAt(i) else { continue };
        let aumid = sess
            .SourceAppUserModelId()
            .map(|h: HSTRING| h.to_string())
            .unwrap_or_default();
        if aumid.is_empty() || !aumid_matches(&aumid, &names) {
            continue;
        }
        // 关键闸门：只有"确实在播放"才暂停。
        // None（读不到）/ Some(false)（已暂停 / 已停止 / 已关闭）→ 什么都不做。
        if playback_state(&sess) != Some(true) {
            continue;
        }
        if sess.TryPauseAsync().is_ok() {
            done.push(aumid);
        }
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aumid_matches_process_name_loosely() {
        // 归因依赖真实进程信息：用本测试进程自己，再编一个"含本进程名"的 AUMID
        let pid = std::process::id();
        let names = names_of_pids(&[pid]);
        if names.is_empty() {
            // 取不到自己的进程名说明环境异常，跳过而不是假红
            return;
        }
        let base = names[0].clone();
        assert!(aumid_matches(&format!("{base}_abcdef"), &names));
        assert!(aumid_matches(&format!("prefix-{base}-suffix"), &names));
        assert!(!aumid_matches("", &names));
        assert!(!aumid_matches(&format!("{base}_x"), &[]));
        assert!(!aumid_matches("totally-other-app_zzz", &names));
    }

    /// 真实世界的两种形状：Edge 的会话 AUMID 用产品名，进程名却是缩写；
    /// Chrome 的 AUMID 是简称，产品名反而是全称。以前只比进程名，Edge 永远对不上。
    #[test]
    fn aumid_matches_product_name_shapes() {
        let edge = vec![norm("msedge"), norm("Microsoft Edge")];
        assert!(aumid_matches("Microsoft.MicrosoftEdge_8wekyb3d8bbwe!MicrosoftEdge", &edge));
        assert!(aumid_matches("MSEdge", &edge));
        assert!(!aumid_matches("Chrome", &edge));

        let chrome = vec![norm("chrome"), norm("Google Chrome")];
        assert!(aumid_matches("Chrome", &chrome));
        assert!(aumid_matches("chrome.exe", &chrome));
        assert!(!aumid_matches("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", &chrome));

        // 反向匹配有长度门槛：AUMID 只有 3 个字符时不会去"包含于"长产品名里，
        // 免得 "vlc" 这种短 AUMID 把毫不相干的会话也算成它的
        let names = vec![norm("someverylongproductname")];
        assert!(!aumid_matches("vlc", &names));
    }

    #[test]
    fn norm_strips_punctuation_and_case() {
        assert_eq!(norm("Microsoft Edge"), "microsoftedge");
        assert_eq!(norm("PotPlayerMini64.exe"), "potplayermini64exe");
        assert_eq!(norm("网易云音乐"), "");
    }

    #[test]
    fn set_active_off_resumes_without_panic() {
        // 无媒体会话也应安全返回、不 panic
        set_active(true);
        set_active(false);
        assert!(!is_active());
    }

    /// 手动排障用：`cargo test probe_sessions -- --ignored --nocapture`
    /// 打印这台机器当前的 SMTC 会话（AUMID + 状态），以及每个会话能否被归因。
    #[test]
    #[ignore]
    fn probe_sessions() {
        let mgr = session_manager();
        println!("manager = {:?}", mgr.is_some());
        let Some(mgr) = mgr else { return };
        let ss = mgr.GetSessions().unwrap();
        let n = ss.Size().unwrap();
        println!("sessions = {}", n);
        let names = names_of_pids(&[std::process::id()]);
        println!("self names = {:?}", names);
        for i in 0..n {
            let s = ss.GetAt(i).unwrap();
            let aumid = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
            println!("  [{}] aumid={:?} playing={:?}", i, aumid, playback_state(&s));
        }
    }

    #[test]
    fn diag_reports_state() {
        set_active(true);
        assert!(diag().starts_with("开"));
        set_active(false);
        assert!(diag().starts_with("关"));
    }
}
