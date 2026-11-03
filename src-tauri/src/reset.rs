//! 配置的「分区重置」：只把某一类设置恢复出厂值，其它一律不动。
//!
//! ## 为什么需要
//!
//! 用户调坏了某个功能（比如时段表画乱了、遮罩参数调得看不见东西），现在只有两条路：
//! 手动一项项改回去，或者整份恢复备份（会把规则、积分一起带走）。前者痛苦，后者过度。
//!
//! ## 三条硬约束
//!
//! 1. **只动一个分区**：`apply` 的每个分支只碰自己那几个字段，绝不整份替换。
//! 2. **重置前先快照**：`config.pre-reset-<时间>-<分区>.json`，而且能**撤销**。
//!    用户点错了不该没法回头。
//! 3. **纪律不可绕过**：规则 / 时段 / 睡眠这几个分区被重置，等于削弱当前的自律——
//!    调用方必须过 `guard::config_replace_blocked` 这道闸（见 cmds 里的包装）。
//!
//! 积分不在可重置范围内：那是"赚来的"，不是"设置"。

use std::path::PathBuf;

use crate::model::Config;

/// 可重置的分区（顺序就是界面上的顺序）
pub const SECTIONS: &[&str] = &[
    "rules",
    "clock",
    "mask",
    "sleep",
    "hud",
    "quotes",
    "notify",
    "distract",
    "stats",
    "browser",
    "sync",
    "update",
];

/// 把 `section` 恢复成出厂值。未知分区返回错误（不静默成功）。
pub fn apply(c: &mut Config, section: &str) -> Result<(), String> {
    let d = Config::default();
    match section {
        "rules" => c.rules = d.rules,
        "clock" => c.settings.focus_clock = d.settings.focus_clock,
        "mask" => c.settings.mask = d.settings.mask,
        "sleep" => c.settings.sleep = d.settings.sleep,
        "hud" => c.settings.hud = d.settings.hud,
        "quotes" => {
            c.settings.custom_quotes = d.settings.custom_quotes;
            c.settings.quote_feeds = d.settings.quote_feeds;
            c.settings.quote_feed = d.settings.quote_feed;
        }
        "notify" => c.settings.notify = d.settings.notify,
        "distract" => c.settings.distract = d.settings.distract,
        "stats" => c.settings.stats = d.settings.stats,
        "browser" => {
            c.settings.browser_guard = d.settings.browser_guard;
            c.settings.guard_browser = d.settings.guard_browser;
            c.settings.grace_secs = d.settings.grace_secs;
            c.settings.browser_exe.clear();
            c.settings.custom_browsers = d.settings.custom_browsers;
        }
        "sync" => c.settings.sync = d.settings.sync,
        "update" => c.settings.update = d.settings.update,
        other => return Err(format!("未知的重置分区：{other}")),
    }
    Ok(())
}

/// 快照文件名：`config.pre-reset-20261103-193500-rules.json`
///
/// 把分区名写进文件名，是为了重启之后界面还能说出"上次重置的是哪一块"，
/// 而不是只能显示一串时间。
fn snapshot_name(ts: &str, section: &str) -> String {
    format!("config.pre-reset-{ts}-{section}.json")
}

/// 重置前落一份快照，返回路径。失败就中止重置（没有后路就不动手）。
pub fn save_snapshot(c: &Config, section: &str) -> Result<PathBuf, String> {
    let dir = crate::cfg::data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let p = dir.join(snapshot_name(&ts, section));
    let body = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    std::fs::write(&p, body).map_err(|e| format!("写快照失败：{e}"))?;
    prune_snapshots(5);
    Ok(p)
}

/// 最近一次重置的快照：(路径, 分区, 时间戳)
pub fn latest_snapshot() -> Option<(PathBuf, String, i64)> {
    let dir = crate::cfg::data_dir();
    let rd = std::fs::read_dir(&dir).ok()?;
    let mut best: Option<(PathBuf, String, i64)> = None;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix("config.pre-reset-") else {
            continue;
        };
        let Some(rest) = rest.strip_suffix(".json") else {
            continue;
        };
        // <yyyyMMdd-HHmmss>-<section>
        let (ts, section) = match rest.split_once('-').and_then(|_| {
            // 时间戳本身带一个 '-'，所以从右往左切
            rest.rsplit_once('-')
        }) {
            Some((t, s)) => (t.to_string(), s.to_string()),
            None => continue,
        };
        let Ok(naive) = chrono::NaiveDateTime::parse_from_str(&ts, "%Y%m%d-%H%M%S") else {
            continue;
        };
        let at = naive.and_local_timezone(chrono::Local).single()?.timestamp();
        if best.as_ref().map(|(_, _, b)| at > *b).unwrap_or(true) {
            best = Some((e.path(), section, at));
        }
    }
    best
}

/// 撤销最近一次重置：读回快照。成功后把这份快照删掉（只能撤一次，
/// 但快照还有旧的几份，连续撤两次会回到更早的状态——这是有意的：
/// "撤销"就是往回退一步，不是无底洞）。
pub fn load_latest() -> Result<(Config, String, PathBuf), String> {
    let (p, section, _) = latest_snapshot().ok_or_else(|| "没有可撤销的重置".to_string())?;
    let s = std::fs::read_to_string(&p).map_err(|e| format!("读快照失败：{e}"))?;
    let c: Config = serde_json::from_str(&s).map_err(|e| format!("快照解析失败：{e}"))?;
    Ok((c, section, p))
}

pub fn drop_snapshot(p: &std::path::Path) {
    let _ = std::fs::remove_file(p);
}

/// 只留最近 `keep` 份快照
fn prune_snapshots(keep: usize) {
    let dir = crate::cfg::data_dir();
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.starts_with("config.pre-reset-") && s.ends_with(".json"))
                .unwrap_or(false)
        })
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{MaskCfg, SleepCfg};

    fn cfg() -> Config {
        let mut c = Config::default();
        // 先把几个分区改成"非默认"，才好验证重置确实只动了自己
        c.rules[0].name = "我的规则".into();
        c.settings.mask.opacity = 42;
        c.settings.sleep.enabled = true;
        c.settings.custom_quotes = vec!["我自己写的".into()];
        c.settings.hud.offset_x = 999;
        c.settings.grace_secs = 1;
        c.points.balance = 777;
        c
    }

    #[test]
    fn 重置规则只动规则() {
        let mut c = cfg();
        apply(&mut c, "rules").unwrap();
        assert_eq!(c.rules.len(), Config::default().rules.len());
        assert_ne!(c.rules[0].name, "我的规则");
        // 其它分区原样
        assert_eq!(c.settings.mask.opacity, 42);
        assert_eq!(c.points.balance, 777);
    }

    #[test]
    fn 重置遮罩只动遮罩() {
        let mut c = cfg();
        apply(&mut c, "mask").unwrap();
        assert_eq!(c.settings.mask.opacity, MaskCfg::default().opacity);
        assert_eq!(c.settings.sleep.enabled, true);
        assert_eq!(c.settings.custom_quotes.len(), 1);
    }

    #[test]
    fn 重置睡眠只动睡眠() {
        let mut c = cfg();
        apply(&mut c, "sleep").unwrap();
        assert_eq!(c.settings.sleep.enabled, SleepCfg::default().enabled);
        assert_eq!(c.settings.mask.opacity, 42);
    }

    #[test]
    fn 重置语录清掉自定义但不碰积分() {
        let mut c = cfg();
        apply(&mut c, "quotes").unwrap();
        assert!(c.settings.custom_quotes.is_empty());
        assert_eq!(c.points.balance, 777);
        assert_eq!(c.settings.mask.opacity, 42);
    }

    #[test]
    fn 未知分区报错而不是静默成功() {
        let mut c = cfg();
        assert!(apply(&mut c, "nope").is_err());
        // 什么都没变
        assert_eq!(c.settings.mask.opacity, 42);
    }

    #[test]
    fn 全部分区都能重置() {
        for s in SECTIONS {
            let mut c = cfg();
            apply(&mut c, s).unwrap_or_else(|e| panic!("分区 {s} 重置失败: {e}"));
        }
    }
}
