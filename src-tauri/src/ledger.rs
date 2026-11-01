//! 分心账本：今天是被**谁**打断的
//!
//! 「打断 3 次」这种总数没法定行动，但"3 次里 2 次是短视频"就能定：关掉它，
//! 或者把它放进禁止名单。所以拦截发生时顺手记一笔"谁"，按天聚合成一张账。
//!
//! 只记**真的被拦下**的东西（应用被送回桌面 / 网页被关掉），
//! 不记"扫到了但放过"的窗口——那些不算打断，记进去只会让账本虚高。
//!
//! 数据落在 `king of focus data/ledger/YYYY-MM-DD.json`，一天一个文件：
//! 单文件几十条，读写都很轻；跨天不用清理，旧文件跟着统计一起被保留策略管。
//! **不进跨设备备份**：这是本机的行为记录，跟分心事件、统计同类。

use crate::model::Config;
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Hit {
    /// 归并键：应用用 exe 名，网站用域名
    pub key: String,
    /// 界面上显示的名字
    pub label: String,
    /// app | site
    pub kind: String,
    /// 今天被拦了几次
    pub n: u32,
    /// 最后一次的时间戳
    pub last: i64,
    /// 命中的规则名（最近一次）
    pub rule: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Day {
    pub schema: u32,
    pub day: String,
    pub hits: Vec<Hit>,
}

/// 一天最多留多少条（真到几百条也已经没有"看排名"的意义了）
pub const MAX_HITS: usize = 200;

pub fn dir() -> PathBuf {
    crate::cfg::data_dir().join("ledger")
}

fn path_of(day: &str) -> PathBuf {
    dir().join(format!("{day}.json"))
}

pub fn load_day(day: &str) -> Day {
    let text = std::fs::read_to_string(path_of(day)).unwrap_or_default();
    let mut d: Day = serde_json::from_str(&text).unwrap_or_default();
    if d.schema == 0 {
        d.schema = 1;
    }
    if d.day.is_empty() {
        d.day = day.to_string();
    }
    d
}

fn save_day(d: &Day) -> Result<(), String> {
    let dir = dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建账本目录失败: {e}"))?;
    let p = path_of(&d.day);
    let s = serde_json::to_string_pretty(d).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| format!("写入账本失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("写入账本失败: {e}"))
}

/// 记一次打断。
///
/// `key` 是归并键（exe 名 / 域名），`label` 是给人看的名字。
/// 同名不同规则的命中合并到一条，`rule` 保留最近一次的来源。
pub fn record(kind: &str, key: &str, label: &str, rule: &str) {
    let key = key.trim();
    if key.is_empty() {
        return;
    }
    let now = Local::now();
    let day = now.format("%Y-%m-%d").to_string();
    let mut d = load_day(&day);
    let ts = now.timestamp();
    if let Some(h) = d.hits.iter_mut().find(|x| x.key == key) {
        h.n = h.n.saturating_add(1);
        h.last = ts;
        h.rule = rule.to_string();
        if !label.is_empty() {
            h.label = label.to_string();
        }
    } else {
        if d.hits.len() >= MAX_HITS {
            // 满了就丢掉"最久没出现"的那条，而不是拒记新的
            if let Some((i, _)) = d.hits.iter().enumerate().min_by_key(|(_, x)| x.last) {
                d.hits.remove(i);
            }
        }
        d.hits.push(Hit {
            key: key.to_string(),
            label: if label.is_empty() { key.to_string() } else { label.to_string() },
            kind: kind.to_string(),
            n: 1,
            last: ts,
            rule: rule.to_string(),
        });
    }
    let _ = save_day(&d);
}

/// 今天的账（按次数从高到低）
pub fn top_today(limit: usize) -> Value {
    let day = Local::now().format("%Y-%m-%d").to_string();
    let mut d = load_day(&day);
    let total: u32 = d.hits.iter().map(|x| x.n).sum();
    d.hits.sort_by(|a, b| b.n.cmp(&a.n).then(b.last.cmp(&a.last)));
    d.hits.truncate(limit.max(1));
    json!({
        "day": day,
        "total": total,
        "items": d.hits,
    })
}

/// 区间内的合计（报告用）：按 key 合并后按次数排序
pub fn range(start: &str, end: &str) -> Vec<Hit> {
    use chrono::Days;
    let mut map: std::collections::BTreeMap<String, Hit> = std::collections::BTreeMap::new();
    let Ok(mut d) = chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d") else {
        return Vec::new();
    };
    let Ok(b) = chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d") else {
        return Vec::new();
    };
    while d <= b {
        let day = d.format("%Y-%m-%d").to_string();
        for h in load_day(&day).hits {
            match map.get_mut(&h.key) {
                Some(x) => {
                    x.n += h.n;
                    x.last = x.last.max(h.last);
                }
                None => {
                    map.insert(h.key.clone(), h);
                }
            }
        }
        // 用 checked_add：`succ_opt` 在末尾会返回 None，退回 b 就成了死循环
        match d.checked_add_days(Days::new(1)) {
            Some(n) => d = n,
            None => break,
        }
    }
    let mut out: Vec<Hit> = map.into_values().collect();
    out.sort_by(|x, y| y.n.cmp(&x.n));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 归并规则：同一个 key 累加次数、更新最近时间；不同 key 各占一行
    #[test]
    fn merge_by_key() {
        let mut d = Day { schema: 1, day: "2026-11-02".into(), hits: vec![] };
        let mut one = |key: &str, ts: i64| {
            if let Some(h) = d.hits.iter_mut().find(|x| x.key == key) {
                h.n += 1;
                h.last = ts;
            } else {
                d.hits.push(Hit {
                    key: key.into(),
                    label: key.into(),
                    kind: "app".into(),
                    n: 1,
                    last: ts,
                    rule: "娱乐".into(),
                });
            }
        };
        one("bilibili.exe", 10);
        one("bilibili.exe", 20);
        one("steam.exe", 15);
        assert_eq!(d.hits.len(), 2);
        let b = d.hits.iter().find(|x| x.key == "bilibili.exe").unwrap();
        assert_eq!(b.n, 2);
        assert_eq!(b.last, 20, "最近一次时间要更新，排序才不会用旧值");
    }

    /// 日期不合法时不 panic、返回空（前端传了奇怪的串也不能把报告弄崩）
    #[test]
    fn range_rejects_bad_dates() {
        assert!(range("2026-13-99", "2026-11-02").is_empty());
        assert!(range("", "").is_empty());
    }

    /// 超过上限时丢掉"最久没出现"的那条，而不是拒记新的
    #[test]
    fn cap_drops_stalest() {
        let mut d = Day { schema: 1, day: "2026-11-02".into(), hits: vec![] };
        for i in 0..MAX_HITS {
            d.hits.push(Hit {
                key: format!("k{i}"),
                label: format!("k{i}"),
                kind: "app".into(),
                n: 1,
                last: i as i64,
                rule: String::new(),
            });
        }
        assert_eq!(d.hits.len(), MAX_HITS);
        let (i, _) = d.hits.iter().enumerate().min_by_key(|(_, x)| x.last).unwrap();
        d.hits.remove(i);
        d.hits.push(Hit {
            key: "new".into(),
            label: "new".into(),
            kind: "app".into(),
            n: 1,
            last: 9999,
            rule: String::new(),
        });
        assert_eq!(d.hits.len(), MAX_HITS);
        assert!(d.hits.iter().any(|x| x.key == "new"));
        assert!(!d.hits.iter().any(|x| x.key == "k0"), "最老的 k0 该被丢掉");
    }
}
