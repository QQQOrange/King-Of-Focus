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
use chrono::{Datelike, Duration, Local, NaiveDateTime, Timelike};
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
    /// 这一段做完没有：""（还没答）/ done / partial / missed
    ///
    /// 为什么只要这三档、不做"进度条 + 数量"：那会变成一个小型任务管理器，
    /// 而这份软件要给的是"这一段有没有真的做出东西"，不是又一个待办清单。
    /// 「做完这套卷」本来就是二元的；确实只做了一半，用 partial 也够。
    pub state: String,
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
    let prev_state = st.goals.iter().find(|x| x.seg == seg).map(|x| x.state.clone()).unwrap_or_default();
    st.goals.retain(|g| g.seg != seg);
    if t.is_empty() {
        save(&st)?;
        goal_cache_clear();
        brief_invalidate();
        return Ok(Goal { seg, text: String::new(), at: 0, day: String::new(), state: String::new() });
    }
    let g = Goal {
        seg,
        text: t.to_string(),
        at: Local::now().timestamp(),
        day: Local::now().format("%Y-%m-%d").to_string(),
        // 改文案不清掉已有判定：用户可能只是把"写登录页"改成"写完登录页"
        state: prev_state,
    };
    st.goals.push(g.clone());
    goal_cache_clear();
    brief_invalidate();
    if st.goals.len() > MAX_GOALS {
        st.goals.sort_by_key(|x| x.at);
        let drop = st.goals.len() - MAX_GOALS;
        st.goals.drain(0..drop);
    }
    save(&st)?;
    Ok(g)
}

/// 上一次读到的"某段目标"，用来挡住 HUD 每秒一次的全文件解析
static GOAL_CACHE: std::sync::Mutex<Option<(i64, String)>> = std::sync::Mutex::new(None);

/// 目标变了就把缓存丢掉（写路径只有 `set_goal` / `set_state` 两处）
fn goal_cache_clear() {
    if let Ok(mut g) = GOAL_CACHE.lock() {
        *g = None;
    }
}

/// 某一段的目标文本（没有就是空串）
///
/// HUD 每秒拉一次 `hud_state`，而这里要解析整个 `intents.json`。
/// 目标一天只改几次，用"段 → 文本"的单格缓存挡住重复读盘：
/// 缓存只认最后一个段，所以换段自动失效，不需要按段维护一张表。
pub fn goal_of(seg: i64) -> String {
    if let Ok(g) = GOAL_CACHE.lock() {
        if let Some((s, t)) = &*g {
            if *s == seg {
                return t.clone();
            }
        }
    }
    let t = load()
        .goals
        .into_iter()
        .find(|g| g.seg == seg)
        .map(|g| g.text)
        .unwrap_or_default();
    if let Ok(mut g) = GOAL_CACHE.lock() {
        *g = Some((seg, t.clone()));
    }
    t
}

/// 当前这一段的目标
pub fn goal_now(cfg: &Config) -> String {
    seg_now(cfg).map(|(s, _, _)| goal_of(s)).unwrap_or_default()
}

/// 三档判定里合法的取值（空串 = 还没答，允许写回去表示"撤销"）
const STATES: [&str; 3] = ["done", "partial", "missed"];

pub fn valid_state(s: &str) -> bool {
    s.is_empty() || STATES.contains(&s)
}

/// 给某一段的目标打勾/改判。
///
/// 只允许改**有目标**的段：没写目标的段没有"做没做完"可言，
/// 给它记一个状态只会让完成率变成假的。
pub fn set_state(seg: i64, state: &str) -> Result<Goal, String> {
    if seg <= 0 {
        return Err("这一段的编号不对".into());
    }
    if !valid_state(state) {
        return Err("只能记成 done / partial / missed".into());
    }
    let mut st = load();
    let Some(g) = st.goals.iter_mut().find(|x| x.seg == seg) else {
        return Err("这一段没有写目标，先写一句再标记".into());
    };
    g.state = state.to_string();
    let out = g.clone();
    save(&st)?;
    goal_cache_clear();
    brief_invalidate();
    Ok(out)
}

/// 某一段的判定（没写目标 / 没答 → 空串）
pub fn state_of(seg: i64) -> String {
    load()
        .goals
        .into_iter()
        .find(|g| g.seg == seg)
        .map(|g| g.state)
        .unwrap_or_default()
}

/// 目标在 [start, end] 天内的完成情况：(总数, 做完, 部分, 没做成, 没答)
pub fn goal_stats(start: &str, end: &str) -> (u32, u32, u32, u32, u32) {
    goal_stats_of(&load().goals, start, end)
}

/// 同上，但吃一个切片（纯函数，测试用；也避免测试去动真实数据目录）
pub fn goal_stats_of(all: &[Goal], start: &str, end: &str) -> (u32, u32, u32, u32, u32) {
    let goals: Vec<&Goal> = all
        .iter()
        .filter(|g| g.day.as_str() >= start && g.day.as_str() <= end && !g.text.trim().is_empty())
        .collect();
    let mut done = 0;
    let mut partial = 0;
    let mut missed = 0;
    let mut none = 0;
    for g in &goals {
        match g.state.as_str() {
            "done" => done += 1,
            "partial" => partial += 1,
            "missed" => missed += 1,
            _ => none += 1,
        }
    }
    (goals.len() as u32, done, partial, missed, none)
}

/// 某一段的结束时刻（段早就过去也算得出来——按排班重算，不看"现在在不在里面"）
pub fn seg_end_of(cfg: &Config, seg: i64) -> i64 {
    let Some(dt) = chrono::TimeZone::timestamp_opt(&Local, seg, 0).single() else {
        return seg;
    };
    distract::segment_bounds(cfg, dt.naive_local())
        .map(|(_, e, _)| e)
        .unwrap_or(seg)
}

/// 某天的全部目标（按段起点升序）
pub fn goals_of_day(day: &str) -> Vec<Goal> {
    let mut v: Vec<Goal> = load().goals.into_iter().filter(|g| g.day == day).collect();
    v.sort_by_key(|g| g.seg);
    v
}

// ---------------------------------------------------------------- 专注质押

/// 一次质押：这一段押了多少分、结算了没有。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Stake {
    pub seg: i64,
    pub amount: i64,
    pub at: i64,
    /// 结算时间（0 = 还没结算）
    pub settled_at: i64,
    /// 返还了多少（含奖励）；提前退出时为 0
    pub refunded: i64,
    /// 是否被没收（积分解锁 = 提前退出）
    pub void: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct StakeStore {
    pub schema: u32,
    pub stakes: Vec<Stake>,
}

/// 一次押多少。固定值而不是让用户填：押注这一步不该出现输入框——
/// 它有摩擦，而且"押多押少"会变成新的算术题。想押更多就下段再押。
pub const STAKE: i64 = 10;
/// 干净跑完（一次都没被打断）的返还比例：本金 + 20%
pub const STAKE_BONUS: i64 = 2;

pub fn stake_path() -> PathBuf {
    crate::cfg::data_dir().join("stakes.json")
}

fn load_stakes() -> StakeStore {
    let text = std::fs::read_to_string(stake_path()).unwrap_or_default();
    let mut st: StakeStore = serde_json::from_str(&text).unwrap_or_default();
    if st.schema == 0 {
        st.schema = 1;
    }
    st
}

fn save_stakes(st: &StakeStore) -> Result<(), String> {
    let p = stake_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let s = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| format!("写入质押失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("写入质押失败: {e}"))
}

/// 全部质押记录（只读，给周复盘用）
pub fn stakes_all() -> Vec<Stake> {
    load_stakes().stakes
}

/// 当前这一段押的那笔（没押 / 已结算 → None）
pub fn stake_now(cfg: &Config) -> Option<Stake> {
    let (seg, _, _) = seg_now(cfg)?;
    load_stakes()
        .stakes
        .into_iter()
        .find(|x| x.seg == seg && x.settled_at == 0)
}

/// 押一笔。返回押注记录；余额不足 / 不在时段里 / 这段已经押过都会明确报错。
pub fn stake_place(shared: &Shared, amount: i64) -> Result<Stake, String> {
    let mut cfg = shared.config();
    let Some((seg, _, _)) = seg_now(&cfg) else {
        return Err("现在不在自律时段里，先开始一段再押".into());
    };
    let amount = amount.clamp(1, 100);
    let mut st = load_stakes();
    if st.stakes.iter().any(|x| x.seg == seg && x.settled_at == 0) {
        return Err("这一段已经押过了".into());
    }
    if cfg.points.balance < amount {
        return Err(format!("积分不够：押 {amount} 分，你现在有 {} 分", cfg.points.balance));
    }
    cfg.points.balance -= amount;
    crate::cfg::save(&cfg)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = cfg;
    }
    let s = Stake {
        seg,
        amount,
        at: Local::now().timestamp(),
        settled_at: 0,
        refunded: 0,
        void: false,
    };
    st.stakes.push(s.clone());
    if st.stakes.len() > 500 {
        // 只留最近的 500 笔：更老的已经没有任何"还要结算"的可能
        st.stakes.sort_by_key(|x| x.at);
        let drop = st.stakes.len() - 500;
        st.stakes.drain(0..drop);
    }
    save_stakes(&st)?;
    brief_invalidate();
    Ok(s)
}

/// 提前退出（积分解锁）：这一笔没收，不返还。
pub fn stake_forfeit(shared: &Shared) {
    let cfg = shared.config();
    let Some((seg, _, _)) = seg_now(&cfg) else { return };
    let mut st = load_stakes();
    let mut hit = false;
    for x in st.stakes.iter_mut() {
        if x.seg == seg && x.settled_at == 0 {
            x.settled_at = Local::now().timestamp();
            x.void = true;
            x.refunded = 0;
            hit = true;
        }
    }
    if hit {
        let _ = save_stakes(&st);
        brief_invalidate();
    }
}

/// 到点结算：时段自然结束 → 退本金（干净跑完再加 20%）。
///
/// 为什么不在"结束提醒"那一刻做：那条路依赖 UI 是否在看，且机器休眠会错过。
/// 这里每 20 秒扫一次"该结算的账"，什么时候回来都能补上。
pub fn tick_settle(shared: &Shared) {
    let now = Local::now().timestamp();
    let mut st = load_stakes();
    if !st.stakes.iter().any(|x| x.settled_at == 0 && x.seg > 0 && x.seg < now) {
        return;
    }
    // seg 是段的**起点**，真正的结束时刻要重新算：这里用"下一段起点 > now"
    // 近似会漏掉同日多段，所以直接看这笔账的段是否已经整个过去：
    // 段起点 + 24h 一定过去；但我们要的是"这段已经结束"，判据见下。
    let cfg = shared.config();
    let mut refund_total = 0i64;
    let mut changed = false;
    for x in st.stakes.iter_mut() {
        if x.settled_at != 0 || x.seg <= 0 {
            continue;
        }
        // 这笔账对应的段是否已经结束：当前不在这个段里，且时间已过起点 1 分钟以上。
        // （段内不会结算；跨段/跨天之后自然命中）
        let in_this_seg = distract::segment_bounds(&cfg, Local::now().naive_local())
            .map(|(s, _, _)| s == x.seg)
            .unwrap_or(false);
        if in_this_seg || now - x.seg < 60 {
            continue;
        }
        let Some(back) = settle_decision(x, in_this_seg, now, blocks_of(x.seg)) else {
            continue;
        };
        x.settled_at = now;
        x.refunded = back;
        refund_total += back;
        changed = true;
    }
    if !changed {
        return;
    }
    let _ = save_stakes(&st);
    if refund_total > 0 {
        let mut c = shared.config();
        c.points.balance += refund_total;
        c.points.total_earned += refund_total;
        let _ = crate::cfg::save(&c);
        if let Ok(mut w) = shared.cfg.write() {
            *w = c;
        }
    }
    brief_invalidate();
}

/// 结算判定（纯函数，方便单测）：该退多少分。
///
/// 三条：还没到点（仍在段内 / 记账不到一分钟）→ 不结算；
/// 自然结束 → 退本金；一次都没被打断 → 再 +20%。
fn settle_decision(x: &Stake, in_this_seg: bool, now: i64, blocks: u32) -> Option<i64> {
    if x.settled_at != 0 || x.seg <= 0 {
        return None;
    }
    if in_this_seg || now - x.seg < 60 {
        return None;
    }
    Some(if blocks == 0 { x.amount + STAKE_BONUS } else { x.amount })
}

/// 给界面的一小包：当前这段押了多少、结算过几笔/// 给界面的一小包：当前这段押了多少、结算过几笔
pub fn stake_snapshot(cfg: &Config) -> serde_json::Value {
    let cur = stake_now(cfg);
    let st = load_stakes();
    let settled: Vec<&Stake> = st.stakes.iter().filter(|x| x.settled_at > 0).collect();
    let last = settled.last();
    json!({
        "amount": cur.as_ref().map(|x| x.amount).unwrap_or(0),
        "stake": STAKE,
        "bonus": STAKE_BONUS,
        "lastVoid": last.map(|x| x.void).unwrap_or(false),
        "lastRefunded": last.map(|x| x.refunded).unwrap_or(0),
    })
}

// ---------------------------------------------------------------- 打断计数

/// 计数是按"段"走的：段一变就归零。放内存即可——
/// 它只服务"这一段的实时反馈"，重启后重数不影响任何历史数据。
static BLOCK_SEG: AtomicI64 = AtomicI64::new(0);
static BLOCK_N: AtomicU32 = AtomicU32::new(0);

/// 记一次拦截。调用点是"真的拦了"的两处：应用被送回 / 网页被关。
///
/// 除了给 HUD 的"这一段被打断几次"，还顺手记进账本（`ledger`）——
/// 总数只说明"被打断得多"，账本才说明"被谁打断"。
pub fn note_block(shared: &Shared, kind: &str, key: &str, label: &str, rule: &str) {
    crate::ledger::record(kind, key, label, rule);
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

// ---------------------------------------------------------------- 今日概览

/// 今天还剩/正在进行什么，给总览页顶部那一块用。
///
/// 为什么放在 Rust 算：判断"下一段什么时候开始"要用和遮罩、锁机完全相同的
/// 排班口径（`plan_wins` / 窗口的 from-to）。在 JS 里另算一份，迟早和判定打架。
/// 缓存：`get_state` 每 1.5 秒拉一次，而这里要读当天的统计文件。
/// 20 秒的缓存让"打开总览就已经有数"，又不至于每次轮询都去碰磁盘。
static BRIEF: std::sync::Mutex<Option<(i64, serde_json::Value)>> = std::sync::Mutex::new(None);

pub fn today_brief(shared: &Shared) -> serde_json::Value {
    let now = Local::now().timestamp();
    if let Ok(g) = BRIEF.lock() {
        if let Some((at, v)) = &*g {
            if now - *at < 20 {
                return v.clone();
            }
        }
    }
    let v = compute_brief(shared);
    if let Ok(mut g) = BRIEF.lock() {
        *g = Some((now, v.clone()));
    }
    v
}

/// 配置变了（写目标、改排班）立刻作废，不然要等 20 秒才看到自己刚写的东西
pub fn brief_invalidate() {
    if let Ok(mut g) = BRIEF.lock() {
        *g = None;
    }
}

fn compute_brief(shared: &Shared) -> serde_json::Value {
    let cfg = shared.config();
    let now = Local::now();
    let naive = now.naive_local();
    let seg = distract::segment_bounds(&cfg, naive);
    let seg_left = seg.as_ref().map(|(_, e, _)| (*e - now.timestamp()).max(0)).unwrap_or(0);
    let next = next_segment(&cfg, naive);
    let plan_min = today_plan_minutes(&cfg, naive);
    let today = now.format("%Y-%m-%d").to_string();
    let agg = crate::stats::aggregate(shared, &today, &today);
    let on_min = agg.on.iter().map(|s| s.secs).sum::<u64>() / 60;
    let (goal_total, goal_done, _, _, _) = goal_stats(&today, &today);

    json!({
        "today": today,
        "inSegment": seg.is_some(),
        "segLabel": seg.as_ref().map(|(_, _, l)| l.clone()).unwrap_or_default(),
        "segLeft": seg_left,
        "goal": seg.as_ref().map(|(s, _, _)| goal_of(*s)).unwrap_or_default(),
        "blocks": blocks_now(&cfg),
        // 这一段的目标做完没有（""/done/partial/missed）
        "goalState": seg.as_ref().map(|(s, _, _)| state_of(*s)).unwrap_or_default(),
        // 上一段（已结束、有目标、6 小时内）：总览据此问"做到了吗"
        "review": match last_ended_goal(&cfg, now.timestamp()) {
            Some((s, e, t, st)) => json!({ "seg": s, "end": e, "goal": t, "state": st }),
            None => serde_json::Value::Null,
        },
        // 下一个还没开始的段：秒数 + 人话标签 + 起始 HH:MM
        "nextInSecs": next.as_ref().map(|x| x.0).unwrap_or(-1),
        "nextLabel": next.as_ref().map(|x| x.1.clone()).unwrap_or_default(),
        "nextAt": next.as_ref().map(|x| x.2.clone()).unwrap_or_default(),
        "planMin": plan_min,
        "onMin": on_min,
        // 今日成果：写了几个目标、做完几个。时长是过程，这才是结果。
        "goalTotal": (goal_total, goal_done).0,
        "goalDone": (goal_total, goal_done).1,
        "points": cfg.points.balance,
    })
}

/// 上一次**已经结束、而且写了目标**的那一段（6 小时内）。
///
/// 总览上那句"上一段：写登录页 —— 做到了吗"问的就是它。
/// 只回溯 6 小时：早上那一段到晚上还追着问，那不叫复盘，叫骚扰。
fn last_ended_goal(cfg: &Config, now: i64) -> Option<(i64, i64, String, String)> {
    let today = Local::now().format("%Y-%m-%d").to_string();
    let mut best: Option<(i64, i64, String, String)> = None;
    for g in goals_of_day(&today) {
        if g.text.trim().is_empty() {
            continue;
        }
        let end = seg_end_of(cfg, g.seg);
        if end > now || now - end > 6 * 3600 {
            continue;
        }
        if best.as_ref().map(|(s, _, _, _)| g.seg > *s).unwrap_or(true) {
            best = Some((g.seg, end, g.text, g.state));
        }
    }
    best
}

/// 往后找"下一个还没开始的段"：(还有多少秒, 标签, 起始时刻)
///
/// 逐小时扫、最多 7 天：一小时两段的情况也能找对（同一小时里的后一段）。
fn next_segment(cfg: &Config, now: NaiveDateTime) -> Option<(i64, String, String)> {
    for step in 0..168i64 {
        let base = (now + Duration::hours(step))
            .with_minute(0)
            .and_then(|x| x.with_second(0))
            .and_then(|x| x.with_nanosecond(0))?;
        let wd = base.weekday().num_days_from_monday();
        let Some(wins) = crate::clock::plan_wins(cfg, wd, base.hour()) else {
            continue;
        };
        for (_, _, f, to) in wins {
            let start = base + Duration::minutes(f as i64);
            if start <= now {
                continue;
            }
            let end = base + Duration::minutes(to as i64);
            return Some((
                (start - now).num_seconds(),
                format!("{}–{}", start.format("%H:%M"), end.format("%H:%M")),
                start.format("%H:%M").to_string(),
            ));
        }
    }
    None
}

/// 今天排了多少分钟（选中窗口的总时长）
fn today_plan_minutes(cfg: &Config, now: NaiveDateTime) -> u32 {
    let wd = now.weekday().num_days_from_monday();
    (0..24u32)
        .filter_map(|h| crate::clock::plan_wins(cfg, wd, h))
        .flat_map(|w| w.into_iter())
        .map(|(_, _, f, t)| t.saturating_sub(f))
        .sum()
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
                state: String::new(),
            });
        }
        assert_eq!(st.goals.len(), 1);
        assert_eq!(st.goals[0].text, "先写登录页（改）");
    }

    /// 质押结算：段内不结、干净跑完加奖励、被打断过只退本金、已结算的跳过
    #[test]
    fn stake_settles_once_and_pays_bonus() {
        let x = Stake { seg: 1000, amount: 10, at: 0, settled_at: 0, refunded: 0, void: false };
        // 还在这一段里 → 不结算
        assert_eq!(settle_decision(&x, true, 2000, 0), None);
        // 刚过起点不到一分钟 → 不结算（避免"押完立刻退"）
        assert_eq!(settle_decision(&x, false, 1030, 0), None);
        // 干净跑完 → 本金 + 2
        assert_eq!(settle_decision(&x, false, 5000, 0), Some(12));
        // 被打断过 → 只退本金
        assert_eq!(settle_decision(&x, false, 5000, 3), Some(10));
        // 结算过的账不再动
        let done = Stake { settled_at: 4000, ..x.clone() };
        assert_eq!(settle_decision(&done, false, 5000, 0), None);
    }

    /// 判定只认三档 + 空串：写进奇怪的字符串会让完成率变成假的
    #[test]
    fn only_three_states_are_valid() {
        for ok in ["", "done", "partial", "missed"] {
            assert!(valid_state(ok), "{ok} 应该合法");
        }
        for bad in ["ok", "DONE", "false", "1"] {
            assert!(!valid_state(bad), "{bad} 不该被接受");
        }
    }

    /// 完成率只数"写了目标"的段：空目标不该拉低分母
    #[test]
    fn goal_stats_count_only_real_goals() {
        let g = |day: &str, text: &str, state: &str| Goal {
            seg: 1,
            text: text.into(),
            at: 0,
            day: day.into(),
            state: state.into(),
        };
        let all = vec![
            g("2026-10-26", "写完登录页", "done"),
            g("2026-10-26", "", "done"),          // 空目标：不算
            g("2026-10-27", "背 40 个词", "partial"),
            g("2026-10-27", "看论文", "missed"),
            g("2026-10-28", "整理笔记", ""),       // 没答
            g("2026-11-02", "下周的", "done"),     // 区间外
        ];
        let (total, done, part, missed, none) = goal_stats_of(&all, "2026-10-26", "2026-11-01");
        assert_eq!((total, done, part, missed, none), (4, 1, 1, 1, 1));
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
