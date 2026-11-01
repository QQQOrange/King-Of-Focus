//! 「这一段要做什么」与「被打断几次」
//!
//! 自律软件最容易漏掉的一环：**开始专注时没有写清目标**。
//! 于是两小时后合上电脑，只记得"我坐了挺久"，说不出做完了什么；
//! 而"没写目标"本身又让分心变得毫无成本——反正也没违背什么。
//!
//! 所以这里做两件小事：
//! 1. **段目标**：每段可以写一句（可选，不强迫）。写下来的目标会出现在时段结束的
//!    汇总里，形成"我说要做 A → 我做了多久 → 被 B 打断了 3 次"的闭环。
//! 2. **打断计数**：这一段里被拦了几次应用/网站。这是现成的信号（本来就拦了），
//!    只是以前只发一条通知就没了。计数给 HUD 与结束汇总用，不需要新的采样。
//!
//! 数据都留在本机（`intents.json` + 内存计数）：这是"这一节课的笔记"，不是配置。

use crate::distract;
use crate::model::Config;
use crate::shared::Shared;
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};

/// 一段的目标
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Goal {
    /// 所属时段的起点（unix 秒）——一段一条，改就是覆盖
    pub seg: i64,
    pub text: String,
    pub at: i64,
    pub day: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    pub schema: u32,
    pub goals: Vec<Goal>,
}

/// 最多留多少条目标（一天两三段，够用两年）
const MAX_GOALS: usize = 2000;

pub fn path() -> PathBuf {
    crate::cfg::data_dir().join("intents.json")
}

fn load() -> Store {
    let text = std::fs::read_to_string(path()).unwrap_or_default();
    let mut st: Store = serde_json::from_str(&text).unwrap_or_default();
    if st.schema == 0 {
        st.schema = 1;
    }
    st
}

fn save(st: &Store) -> Result<(), String> {
    let p = path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let s = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| format!("写入段目标失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("写入段目标失败: {e}"))
}

/// 当前所在的时段（起点、终点、标签）
fn seg_now(cfg: &Config) -> Option<(i64, i64, String)> {
    distract::segment_bounds(cfg, Local::now().naive_local())
}

/// 写/改当前这段的目标。返回空串表示清空。
pub fn set_goal(cfg: &Config, text: &str) -> Result<Goal, String> {
    let Some((seg, _, _)) = seg_now(cfg) else {
        return Err("现在不在自律时段里，先开始一段再写目标".into());
    };
    let t = text.trim();
    if t.chars().count() > 200 {
        return Err("一句目标最多 200 个字".into());
    }
    let mut st = load();
    st.goals.retain(|g| g.seg != seg);
    if t.is_empty() {
        save(&st)?;
        return Ok(Goal { seg, text: String::new(), at: 0, day: String::new() });
    }
    let g = Goal {
        seg,
        text: t.to_string(),
        at: Local::now().timestamp(),
        day: Local::now().format("%Y-%m-%d").to_string(),
    };
    st.goals.push(g.clone());
    if st.goals.len() > MAX_GOALS {
        st.goals.sort_by_key(|x| x.at);
        let drop = st.goals.len() - MAX_GOALS;
        st.goals.drain(0..drop);
    }
    save(&st)?;
    Ok(g)
}

/// 某一段的目标文本（没有就是空串）
pub fn goal_of(seg: i64) -> String {
    load()
        .goals
        .into_iter()
        .find(|g| g.seg == seg)
        .map(|g| g.text)
        .unwrap_or_default()
}

/// 当前这一段的目标
pub fn goal_now(cfg: &Config) -> String {
    seg_now(cfg).map(|(s, _, _)| goal_of(s)).unwrap_or_default()
}

/// 某天的全部目标（按段起点升序）
pub fn goals_of_day(day: &str) -> Vec<Goal> {
    let mut v: Vec<Goal> = load().goals.into_iter().filter(|g| g.day == day).collect();
    v.sort_by_key(|g| g.seg);
    v
}

// ---------------------------------------------------------------- 打断计数

/// 计数是按"段"走的：段一变就归零。放内存即可——
/// 它只服务"这一段的实时反馈"，重启后重数不影响任何历史数据。
static BLOCK_SEG: AtomicI64 = AtomicI64::new(0);
static BLOCK_N: AtomicU32 = AtomicU32::new(0);

/// 记一次拦截。调用点是"真的拦了"的两处：应用被送回 / 网页被关。
pub fn note_block(shared: &Shared) {
    let cfg = shared.config();
    let Some((seg, _, _)) = seg_now(&cfg) else { return };
    let last = BLOCK_SEG.load(Ordering::Relaxed);
    if last != seg {
        BLOCK_SEG.store(seg, Ordering::Relaxed);
        BLOCK_N.store(1, Ordering::Relaxed);
    } else {
        BLOCK_N.fetch_add(1, Ordering::Relaxed);
    }
}

/// 当前段被打断了几次（不在段里 → 0）
pub fn blocks_now(cfg: &Config) -> u32 {
    let Some((seg, _, _)) = seg_now(cfg) else { return 0 };
    if BLOCK_SEG.load(Ordering::Relaxed) != seg {
        return 0;
    }
    BLOCK_N.load(Ordering::Relaxed)
}

/// 指定段被打断了几次（段结束汇总用）
pub fn blocks_of(seg: i64) -> u32 {
    if BLOCK_SEG.load(Ordering::Relaxed) != seg {
        return 0;
    }
    BLOCK_N.load(Ordering::Relaxed)
}

/// 给 HUD / 主页用的一小包状态
pub fn snapshot(cfg: &Config) -> serde_json::Value {
    let seg = seg_now(cfg);
    json!({
        "inSegment": seg.is_some(),
        "goal": seg.as_ref().map(|(s, _, _)| goal_of(*s)).unwrap_or_default(),
        "blocks": blocks_now(cfg),
        "segLabel": seg.map(|(_, _, l)| l).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ClockProfile, HourPlan};
    use chrono::NaiveDate;

    fn cfg_with(hour: usize, to: usize) -> Config {
        let mut c = Config::default();
        let mut p = ClockProfile::default();
        p.days[0][hour] = HourPlan {
            on: true,
            work: 50,
            brk: 10,
            from: 0,
            to: to as u32,
            seg: "s".into(),
            wins: vec![],
        };
        c.settings.focus_clock.enabled = true;
        c.settings.focus_clock.profiles = vec![p];
        c.settings.focus_clock.active = c.settings.focus_clock.profiles[0].id.clone();
        c
    }

    /// 段目标按段存：同一段写两次是覆盖，不是新增
    #[test]
    fn goal_is_one_per_segment() {
        let mut st = Store { schema: 1, goals: vec![] };
        let seg = 1000i64;
        for t in ["先写登录页", "先写登录页（改）"] {
            st.goals.retain(|g| g.seg != seg);
            st.goals.push(Goal {
                seg,
                text: t.into(),
                at: 1,
                day: "2026-11-02".into(),
            });
        }
        assert_eq!(st.goals.len(), 1);
        assert_eq!(st.goals[0].text, "先写登录页（改）");
    }

    /// 段变了，打断计数就该归零（否则 HUD 会一直显示上一段的数字）
    #[test]
    fn block_counter_resets_with_segment() {
        BLOCK_SEG.store(111, Ordering::Relaxed);
        BLOCK_N.store(3, Ordering::Relaxed);
        assert_eq!(blocks_of(111), 3);
        assert_eq!(blocks_of(222), 0, "别的段不该继承这个数字");
    }

    /// 不在时段里时不该报"这一段的目标"（也不该允许写）
    #[test]
    fn no_segment_no_goal() {
        let c = cfg_with(9, 60);
        // 构造一个必然不在 9 点的时刻是不现实的；这里只验"关掉时段后一定没有"
        let mut off = c.clone();
        off.settings.focus_clock.enabled = false;
        assert_eq!(goal_now(&off), "");
        assert!(set_goal(&off, "x").is_err());
    }

    #[test]
    fn segment_labels_are_stable_through_distract() {
        // 归属算法只有一份（distract::segment_bounds），这里确认它确实能被复用
        let c = cfg_with(9, 60);
        let at = NaiveDate::from_ymd_opt(2026, 11, 2)
            .unwrap()
            .and_hms_opt(9, 10, 0)
            .unwrap();
        let (_, _, label) = distract::segment_bounds(&c, at).expect("9:10 在时段里");
        assert_eq!(label, "09:00–10:00");
    }
}
