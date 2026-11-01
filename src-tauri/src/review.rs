//! 周复盘：把"看数据"变成"做一个决定"。
//!
//! 为什么不是"再生成一份周报"：报告是数据，复盘是决定。报告可以从头看到尾
//! 却不改变任何事；复盘只有五个问题，答完必须落成一句"下周改什么"。
//! 所以这里的产出不是文档，是一周五条自由文本，存在本机，下周还能翻出来对照。
//!
//! 数据全部来自已有文件（统计日文件、账本、分心事件、段目标、质押），
//! 不新建一套采样——**复盘看到的东西必须和统计页是同一份数据**，
//! 否则用户会先怀疑数据，再怀疑软件。

use chrono::{Datelike, Duration, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

/// 一周的复盘回答（5 个问题固定顺序，空串 = 没答）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Review {
    /// 这一周的周一（YYYY-MM-DD），同时是唯一键
    pub week: String,
    pub answers: Vec<String>,
    pub at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewDoc {
    pub schema: u32,
    pub items: Vec<Review>,
}

/// 问题数量：加问题要同时改前端，所以写成一个常量
pub const Q_COUNT: usize = 5;

pub fn path() -> PathBuf {
    crate::cfg::data_dir().join("reviews.json")
}

fn load() -> ReviewDoc {
    let text = std::fs::read_to_string(path()).unwrap_or_default();
    let mut d: ReviewDoc = serde_json::from_str(&text).unwrap_or_default();
    if d.schema == 0 {
        d.schema = 1;
    }
    d
}

fn save(d: &ReviewDoc) -> Result<(), String> {
    let p = path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let s = serde_json::to_string_pretty(d).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| format!("写入复盘失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("写入复盘失败: {e}"))
}

/// 某一周的起止（周一 ~ 周日）。`offset` 0 = 本周，1 = 上周。
pub fn week_bounds(offset: i64) -> (NaiveDate, NaiveDate) {
    let today = Local::now().date_naive();
    let wd = today.weekday().num_days_from_monday() as i64;
    let start = today - Duration::days(wd + offset.max(0) * 7);
    (start, start + Duration::days(6))
}

fn ymd(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn day_start_ts(d: NaiveDate) -> i64 {
    use chrono::TimeZone;
    Local
        .from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .map(|x| x.timestamp())
        .unwrap_or(0)
}

fn answers_of(week: &str) -> Vec<String> {
    load()
        .items
        .into_iter()
        .find(|x| x.week == week)
        .map(|x| x.answers)
        .unwrap_or_default()
}

/// 保存某一周的回答。空回答也存（"这周没答"和"这周没看过"要能区分）。
pub fn save_answers(week: &str, answers: Vec<String>) -> Result<(), String> {
    if !crate::distract::valid_day(week) {
        return Err("日期不合法".into());
    }
    let mut d = load();
    let clean: Vec<String> = (0..Q_COUNT)
        .map(|i| answers.get(i).cloned().unwrap_or_default().trim().to_string())
        .collect();
    let item = Review { week: week.to_string(), answers: clean, at: Local::now().timestamp() };
    match d.items.iter_mut().find(|x| x.week == week) {
        Some(x) => *x = item,
        None => d.items.push(item),
    }
    // 只留最近 200 周：再老的复盘没人回头看，留着只让文件变大
    if d.items.len() > 200 {
        d.items.sort_by(|a, b| a.week.cmp(&b.week));
        let drop = d.items.len() - 200;
        d.items.drain(0..drop);
    }
    save(&d)
}

/// 一周的数据快照 + 已保存的回答
pub fn week(offset: i64) -> Value {
    let (start, end) = week_bounds(offset);
    let (s, e) = (ymd(start), ymd(end));
    let prev_end = start - Duration::days(1);
    let prev_start = prev_end - Duration::days(6);

    // 每天的自律/总时长：直接复用给"另一台设备"用的日摘要口径，避免两套算法
    let digest = crate::stats::digest(60);
    let find = |day: &str| digest.iter().find(|d| d.day == day).cloned();

    let mut days: Vec<Value> = Vec::new();
    let mut on_secs = 0u64;
    let mut off_secs = 0u64;
    let mut best: (String, u64) = (String::new(), 0);
    let mut cur = start;
    while cur <= end {
        let key = ymd(cur);
        let d = find(&key);
        let on = d.as_ref().map(|x| x.on).unwrap_or(0);
        let total = d.as_ref().map(|x| x.total).unwrap_or(0);
        on_secs += on;
        off_secs += total.saturating_sub(on);
        if on > best.1 {
            best = (key.clone(), on);
        }
        let top = d
            .as_ref()
            .and_then(|x| x.top.first())
            .map(|a| a.name.clone())
            .unwrap_or_default();
        days.push(json!({ "day": key, "on": on, "total": total, "top": top }));
        cur += Duration::days(1);
    }

    // 上周同长度对比：只用来回答"这周比上周多了还是少了"
    let mut prev_on = 0u64;
    let mut p = prev_start;
    while p <= prev_end {
        if let Some(d) = find(&ymd(p)) {
            prev_on += d.on;
        }
        p += Duration::days(1);
    }

    // 被打断的来源（账本）
    let diversions: Vec<Value> = crate::ledger::range(&s, &e)
        .into_iter()
        .take(3)
        .map(|h| json!({ "label": h.label, "n": h.n, "kind": h.kind }))
        .collect();
    let diver_total: u32 = crate::ledger::range(&s, &e).iter().map(|h| h.n).sum();

    // 段目标：写了几个
    let mut goal_days = 0;
    let mut cur = start;
    while cur <= end {
        if !crate::focus::goals_of_day(&ymd(cur)).is_empty() {
            goal_days += 1;
        }
        cur += Duration::days(1);
    }

    // 质押：这一周结算了几笔、其中几笔干净跑完、几笔被没收
    let (from_ts, to_ts) = (day_start_ts(start), day_start_ts(end + Duration::days(1)));
    let stakes: Vec<_> = crate::focus::stakes_all()
        .into_iter()
        .filter(|x| x.seg >= from_ts && x.seg < to_ts && x.settled_at > 0)
        .collect();
    let staked = stakes.len();
    let clean = stakes.iter().filter(|x| !x.void && x.refunded > x.amount).count();
    let voided = stakes.iter().filter(|x| x.void).count();

    // 分心事件：记了几条、处理了几条
    let st = crate::distract::load();
    let items: Vec<_> = st.items.iter().filter(|x| x.day >= s && x.day <= e).collect();
    let dis_total = items.len();
    let dis_done = items.iter().filter(|x| x.done).count();

    json!({
        "week": s,
        "start": s,
        "end": e,
        "days": days,
        "onSecs": on_secs,
        "offSecs": off_secs,
        "prevOnSecs": prev_on,
        "bestDay": best.0,
        "bestOn": best.1,
        "diversions": diversions,
        "diverTotal": diver_total,
        "goalDays": goal_days,
        "staked": staked,
        "stakeClean": clean,
        "stakeVoid": voided,
        "distractTotal": dis_total,
        "distractDone": dis_done,
        "answers": answers_of(&s),
        "qCount": Q_COUNT,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一周永远是 7 天，且从周一开始（与时段表、统计页同一套算法）
    #[test]
    fn week_is_monday_to_sunday() {
        for off in 0..4 {
            let (s, e) = week_bounds(off);
            assert_eq!(s.weekday().num_days_from_monday(), 0, "起点必须是周一");
            assert_eq!(e.weekday().num_days_from_monday(), 6, "终点必须是周日");
            assert_eq!((e - s).num_days(), 6);
        }
    }

    /// 本周与上周不重叠，且上周整段早于本周
    #[test]
    fn weeks_do_not_overlap() {
        let (s0, _) = week_bounds(0);
        let (_, e1) = week_bounds(1);
        assert!(e1 < s0, "上周日必须早于本周一");
        assert_eq!((s0 - e1).num_days(), 1);
    }

    /// 回答补齐到固定条数：前端少传不会被当成"格式坏了"
    #[test]
    fn answers_are_padded_and_trimmed() {
        let week = "2026-10-26";
        save_answers(week, vec!["  写登录页  ".into(), "".into()]).unwrap();
        let a = answers_of(week);
        assert_eq!(a.len(), Q_COUNT);
        assert_eq!(a[0], "写登录页");
        assert_eq!(a[1], "");
        // 重复保存是覆盖，不是追加
        save_answers(week, vec!["改一条".into()]).unwrap();
        assert_eq!(answers_of(week)[0], "改一条");
        let _ = std::fs::remove_file(path());
    }

    /// 坏日期要报错，不能悄悄写进一个不存在的周
    #[test]
    fn rejects_bad_week() {
        assert!(save_answers("2026-13-99", vec![]).is_err());
        assert!(save_answers("", vec![]).is_err());
    }
}
