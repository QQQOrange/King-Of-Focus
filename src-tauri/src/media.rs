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
//!   · 只暂停**能归因到被盖住进程**的会话（AUMID 含进程名）；归因不了的不动，
//!     避免误停用户正听的、不属于被盖窗口的后台音乐。
//!   · 恢复：窗口回到前台 / 遮罩关 / 开关关掉 → 只还原**我们主动暂停过**的
//!     会话（记在 PAUSED_BY_US），绝不碰用户自己主动暂停的媒体。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

use windows::core::HSTRING;
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
    // RequestAsync 直接给 IAsyncOperation；get() 是阻塞等待完成，SMTC 本地立即就绪。
    // get() 本身返回 Result<SessionManager, Error>，外面不要再套 .ok() 再 and_then。
    SessionManager::RequestAsync()
        .ok()
        .and_then(|op| op.get().ok())
}

/// 暂停所有「非前台 / 被遮住」进程对应的媒体会话。
///
/// `covered_pids`：当前被遮罩盖住（非呈现）的进程 id 名单，由 mask.rs 喂进来。
/// 只暂停能归因到这些进程的会话；动过的记进 PAUSED_BY_US，恢复时只还原这些。
pub fn pause_covered(covered_pids: &[u32]) {
    if !MEDIA_ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    // 名单空了也要走一遍恢复：目标换到前台后，原来那批被停的会话得放出来。
    // resume_uncovered 内部只对"不在名单里的记录"动手，空名单=全部还原。
    if covered_pids.is_empty() {
        resume_all();
        return;
    }
    let Some(mgr) = session_manager() else { return };
    let Ok(sessions) = mgr.GetSessions() else { return };
    let Ok(size) = sessions.Size() else { return };

    for i in 0..size {
        let Ok(sess) = sessions.GetAt(i) else { continue };
        let aumid = sess
            .SourceAppUserModelId()
            .map(|h: HSTRING| h.to_string())
            .unwrap_or_default();
        if aumid.is_empty() || !aumid_covers_pids(&aumid, covered_pids) {
            continue;
        }
        // 已经记录过就不用再停（避免重复发暂停、重复入表）
        if PAUSED_BY_US.lock().map(|g| g.contains_key(&aumid)).unwrap_or(false) {
            continue;
        }
        // TryPauseAsync：fire-and-forget（异步结果不等，够用；要精确等会拖慢遮罩帧）
        if sess.TryPauseAsync().is_ok() {
            if let Ok(mut g) = PAUSED_BY_US.lock() {
                let wp = was_playing(&sess);
                g.insert(aumid, (sess, wp));
            }
        }
    }
    // 原来在名单里的、这轮不在名单里的（窗口回到前台/呈现了）→ 恢复
    resume_uncovered(covered_pids);
}

/// 恢复「已不在被盖住名单里」的会话（窗口回到前台 / 呈现状态时的自动恢复）。
fn resume_uncovered(covered_pids: &[u32]) {
    let Ok(mut g) = PAUSED_BY_US.lock() else { return };
    let stale: Vec<String> = g
        .keys()
        .filter(|aumid| !aumid_covers_pids(aumid, covered_pids))
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

/// 会话 AUMID 是否「属于」被盖住的某个进程（宽松匹配：AUMID 含进程名去 .exe）。
/// 归因不了 → false（不误停）。
fn aumid_covers_pids(aumid: &str, covered_pids: &[u32]) -> bool {
    if aumid.is_empty() || covered_pids.is_empty() {
        return false;
    }
    let low = aumid.to_lowercase();
    for pid in covered_pids {
        // exe_name_of 保留原大小写（Chrome.exe）；AUMID 里是 "Chrome.exe_xxx"
        // 之类的打包名，统一小写比。查不到进程名（已退出 / 权限不够）→ 跳过。
        if let Some(name) = crate::proc::exe_name_of(*pid) {
            let base = name.to_lowercase().replace(".exe", "");
            if !base.is_empty() && low.contains(&base) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aumid_matches_process_name_loosely() {
        // 归因依赖 exe_name_of(pid) 真实进程名：测试里编一个必然存在的 pid
        // （本测试进程自己），再用"含本进程名"的 AUMID 验证宽松匹配。
        let pid = std::process::id();
        let Some(self_name) = crate::proc::exe_name_of(pid) else {
            // 取不到自己的进程名说明环境异常，跳过而不是假红
            return;
        };
        let base = self_name.to_lowercase().replace(".exe", "");
        assert!(aumid_covers_pids(&format!("{base}_abcdef"), &[pid]));
        assert!(aumid_covers_pids(&format!("prefix-{base}-suffix"), &[pid]));
        assert!(!aumid_covers_pids("", &[pid]));
        assert!(!aumid_covers_pids(&format!("{base}_x"), &[]));
        // 无关 AUMID 不应命中
        assert!(!aumid_covers_pids("totally-other-app_zzz", &[pid]));
    }

    #[test]
    fn set_active_off_resumes_without_panic() {
        // 无媒体会话也应安全返回、不 panic
        set_active(true);
        set_active(false);
        assert!(!is_active());
    }
}
