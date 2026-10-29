//! 休息结束时的「收尾」：把休息里打开的黑名单应用收起来。
//!
//! 触发条件只有一条：**上一拍还在休息、这一拍已经回到学习**。
//! （自律时段里的番茄休息段，或自律规则自带的休息段，都算"休息"。）
//! 为什么不是"看到黑名单应用就处理"：收尾是**边界动作**。若每拍都做，就与
//! 常规拦截重复，而且用户在学习中自己打开的应用也会被"收尾"插一手，
//! 日志里会变成一锅粥。
//!
//! 两种模式（`SweepCfg.mode`）：
//!   · 柔和 soft：最小化窗口 + 把**确实在播放**的媒体暂停；学习期间这个进程被
//!     "停放"（monitor 不再反复强杀）。用户一旦还原窗口，就立刻按常规拦截关掉——
//!     "点开才算重新打开"，这与"休息允许、学习禁止"的语义一致。
//!   · 强制 hard：直接关闭（`soft_close` 为真时先 WM_CLOSE，让程序自己退出；
//!     不退出则由常规拦截兜底强杀）。
//!
//! 作用对象 = **进程**（与拦截同源，见 `discipline::blocked_rule`）：
//!   黑名单命中的进程、白名单外且非保护的进程。**网页不在此处理**——
//!   外部进程只能看到浏览器窗口，看不到标签页；按窗口标题去猜会把整个浏览器
//!   连坐（用户可能开着十个学习用的标签）。网页由浏览器插件按标签页精确拦截，
//!   与这个收尾动作互不影响。
//!
//! 异常与边界：
//!   · 拿不到进程路径 / 权限不足（用户不是管理员、进程以更高权限运行）：
//!     `screen_apps` 拿不到 name，名单匹配自然失配 → 跳过，绝不"凭标题猜着关"。
//!   · 最小化失败（窗口已销毁 / 句柄失效）：只记日志，**不升级为关闭**。
//!     柔和模式的承诺就是"可撤销"，不能偷偷变成强杀。
//!   · 关闭失败：记日志（权限不足会明确写出来），下一拍常规拦截还会再试一次。
//!   · 媒体：只有 PlaybackStatus 明确是 Playing 才暂停；拿不到状态、已暂停、
//!     已停止一律不动（见 `media::pause_playing_of`）。收尾的暂停是单向的，
//!     永不自动恢复，避免"遮罩一关视频自己响起来"。
//!   · dry_run（演练模式）：只记日志，不动窗口、不暂停媒体。

use crate::model::{Config, Rule};
use crate::proc::WinApp;
use crate::shared::Shared;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Soft,
    Hard,
}

impl Default for Mode {
    fn default() -> Self {
        Mode::Soft
    }
}

impl Mode {
    /// 只认 "hard"；其余（含拼错、空、老配置）一律柔和。
    /// 为什么不默认 hard：柔和是可撤销的，配错了代价只是"没收起来"，
    /// 而 hard 配错会把用户正在写的东西关掉。
    pub fn of(s: &str) -> Mode {
        if s == "hard" {
            Mode::Hard
        } else {
            Mode::Soft
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Soft => "soft",
            Mode::Hard => "hard",
        }
    }
}

/// 一次收尾的结果（写日志 / 便于测试断言）
#[derive(Clone, Debug, Default)]
pub struct SweepReport {
    pub mode: Mode,
    /// 被最小化的（柔和模式）
    pub minimized: Vec<String>,
    /// 被关闭的（强制模式）
    pub closed: Vec<String>,
    /// 被暂停的媒体会话（AUMID）
    pub paused: Vec<String>,
    /// 处理失败 / 跳过的数量
    pub skipped: usize,
    /// 需要"停放"的 pid（柔和模式）：学习期间不再被常规拦截强杀
    pub parked: Vec<u32>,
}

/// 这一拍该不该收尾：上一拍在休息、这一拍已经回到学习。
///
/// `now_study` 由调用方算（在自律时段内且处于专注段，或有生效中的规则）。
/// 时段正好在此刻结束（休息结束后不再有学习段）→ now_study 为假 → 不收尾，
/// 用户自由时间不该被动别人的窗口。
pub fn is_break_to_study(prev_break: bool, now_break: bool, now_study: bool) -> bool {
    prev_break && !now_break && now_study
}

fn label(a: &WinApp) -> String {
    if a.title.is_empty() {
        a.name.clone()
    } else {
        format!("{} — {}", a.name, a.title)
    }
}

/// 执行一次收尾。
///
/// `apps` 由 monitor 扫好传进来（同一拍还会用它们做拦截，避免重复扫描窗口）。
/// `active` 是此刻生效的规则（`discipline::active_rules`），空数组 = 没有规则要执行。
pub fn run(
    shared: &Shared,
    cfg: &Config,
    apps: &[WinApp],
    active: &[Rule],
    self_pid: u32,
) -> SweepReport {
    let sc = &cfg.settings.sweep;
    let mode = Mode::of(sc.mode_norm());
    let mut rep = SweepReport {
        mode,
        ..Default::default()
    };
    if !sc.enabled || active.is_empty() {
        return rep;
    }

    // 1) 挑出"该收"的进程：与拦截同源，跳过自己
    let mut targets: Vec<(&WinApp, &Rule)> = Vec::new();
    for a in apps {
        if a.pid == self_pid || a.pid == 0 {
            continue;
        }
        if let Some(r) = crate::discipline::blocked_rule(cfg, active, a) {
            targets.push((a, r));
        }
    }
    if targets.is_empty() {
        return rep;
    }

    if mode == Mode::Soft {
        // 2) 媒体先行：先读状态、确实在播放才暂停，再最小化窗口。
        //    顺序不能反：最小化之后有些播放器会把会话状态改成 Paused/Stopped，
        //    那时我们已经"看不到播放"了，等于把该暂停的一起漏掉。
        if sc.pause_media && !cfg.settings.dry_run {
            let pids: Vec<u32> = targets.iter().map(|(a, _)| a.pid).collect();
            rep.paused = crate::media::pause_playing_of(&pids);
            for aumid in rep.paused.iter() {
                shared.log(
                    "app",
                    aumid.clone(),
                    "休息结束收尾".into(),
                    "媒体确实在播放，已暂停".into(),
                );
            }
        }
        // 3) 最小化
        for (a, r) in targets.iter() {
            let txt = label(a);
            if cfg.settings.dry_run {
                rep.minimized.push(txt);
                continue;
            }
            if crate::proc::minimize_all(a.pid) > 0 {
                rep.parked.push(a.pid);
                rep.minimized.push(txt.clone());
                shared.log(
                    "app",
                    txt,
                    r.name.clone(),
                    "休息结束：已最小化（柔和模式，学习期间不再强杀）".into(),
                );
            } else {
                // 窗口已失效 / 无权限：绝不升级为关闭
                rep.skipped += 1;
                shared.log(
                    "app",
                    txt,
                    r.name.clone(),
                    "休息结束：最小化失败（窗口可能已失效），未做其他处理".into(),
                );
            }
        }
        return rep;
    }

    // 强制：直接关闭。soft_close 打开时先礼貌关闭，让程序自己退出；
    // 不退出 / 没有 soft_close 时直接结束进程（与常规拦截的策略一致）。
    for (a, r) in targets.iter() {
        let txt = label(a);
        if cfg.settings.dry_run {
            rep.closed.push(txt);
            continue;
        }
        let ok = if cfg.settings.soft_close {
            if crate::proc::soft_close(a.hwnd) {
                true
            } else {
                crate::proc::terminate(a.pid)
            }
        } else {
            crate::proc::terminate(a.pid)
        };
        if ok {
            rep.closed.push(txt.clone());
            shared.log(
                "app",
                txt,
                r.name.clone(),
                "休息结束：已关闭（强制模式）".into(),
            );
        } else {
            rep.skipped += 1;
            shared.log(
                "app",
                txt,
                r.name.clone(),
                "休息结束：关闭失败（权限不足或窗口已失效）".into(),
            );
        }
    }
    rep
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AppEntry, Rule};

    fn app(name: &str, title: &str) -> WinApp {
        WinApp {
            pid: 4242,
            hwnd: 0,
            path: format!("C:\\Apps\\{name}.exe"),
            name: name.to_lowercase(),
            title: title.into(),
        }
    }

    fn rule(mode: &str, list: &[&str]) -> Rule {
        Rule {
            id: "r1".into(),
            name: "娱乐".into(),
            enabled: true,
            mode: mode.into(),
            apps: list
                .iter()
                .map(|v| AppEntry {
                    kind: "name".into(),
                    value: (*v).into(),
                    ..AppEntry::default()
                })
                .collect(),
            ..Rule::default()
        }
    }

    /* ---- 触发条件 ---- */

    #[test]
    fn sweeps_only_on_break_to_study() {
        assert!(is_break_to_study(true, false, true), "休息→学习：收尾");
        assert!(!is_break_to_study(true, true, false), "还在休息：不收尾");
        assert!(!is_break_to_study(false, false, true), "一直在学习：不收尾");
        assert!(!is_break_to_study(true, false, false), "休息结束后时段也结束了：不收尾");
        assert!(!is_break_to_study(false, true, false), "刚进入休息：不收尾");
    }

    #[test]
    fn mode_falls_back_to_soft() {
        assert_eq!(Mode::of("hard"), Mode::Hard);
        assert_eq!(Mode::of("soft"), Mode::Soft);
        assert_eq!(Mode::of(""), Mode::Soft, "空值按柔和");
        assert_eq!(Mode::of("HARD"), Mode::Soft, "大小写不匹配也按柔和，不升级");
        assert_eq!(Mode::of("close"), Mode::Soft);
    }

    /* ---- 作用对象 ---- */

    #[test]
    fn targets_follow_blacklist_and_whitelist() {
        let mut cfg = Config::default();
        cfg.settings.protected.clear();
        let blocked = app("douyin", "抖音");
        let other = app("code", "VS Code");
        // 黑名单：命中即拦
        let bl = rule("blacklist", &["douyin"]);
        assert!(crate::discipline::blocked_rule(&cfg, &[bl.clone()], &blocked).is_some());
        assert!(crate::discipline::blocked_rule(&cfg, &[bl], &other).is_none());
        // 白名单：名单外的才拦
        let wl = rule("whitelist", &["code"]);
        assert!(crate::discipline::blocked_rule(&cfg, &[wl.clone()], &blocked).is_some());
        assert!(crate::discipline::blocked_rule(&cfg, &[wl], &other).is_none());
    }

    #[test]
    fn whitelist_mode_spares_protected_processes() {
        let mut cfg = Config::default();
        cfg.settings.protected = vec!["explorer".into()];
        let explorer = app("explorer", "文件资源管理器");
        let wl = rule("whitelist", &["code"]);
        assert!(
            crate::discipline::blocked_rule(&cfg, &[wl], &explorer).is_none(),
            "系统保护进程即使不在白名单也不该被收尾"
        );
    }

    #[test]
    fn whitelist_mode_spares_rule_extra_protected() {
        let mut cfg = Config::default();
        cfg.settings.protected.clear();
        let mut wl = rule("whitelist", &["code"]);
        wl.extra_protected = vec!["wechat".into()];
        let wx = app("wechat", "微信");
        assert!(crate::discipline::blocked_rule(&cfg, &[wl], &wx).is_none());
    }

    #[test]
    fn report_defaults_are_soft_and_empty() {
        let rep = SweepReport::default();
        assert_eq!(rep.mode, Mode::Soft);
        assert!(rep.minimized.is_empty() && rep.closed.is_empty() && rep.paused.is_empty());
        assert_eq!(rep.skipped, 0);
    }
}
