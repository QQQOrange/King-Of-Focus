//! 「节奏」：连续达标天数 + 本周对比。
//!
//! ## 为什么要有它
//!
//! 这个软件的数据已经很全了（分时、日历、排行、报告），但**没有一个数字回答
//! "我最近是变好还是变差"**。人真正会被推动的是「别断」和「比上周强一点」，
//! 而不是"昨天用了 4 小时 12 分"。
//!
//! ## 达标怎么算
//!
//! 一条规则：**当天的自律时长达到当天计划，且写过的目标都做完了**。
//!   · 没有计划的休息日既不加也不断（`continue`）——休息不该被当成失败；
//!   · 没写目标的日子只看时长（不能因为"没规划"就判失败）；
//!   · 今天还没过完时，今天的未达标**不算断**（streak 从昨天往前数）。
//!
//! 只读聚合，不改任何状态；不做 I/O 缓存以外的优化，结果缓存 60 秒。

use chrono::{Datelike, Days, Local, NaiveDate};
use std::sync::Mutex;

use crate::model::Config;
use crate::shared::Shared;

#[derive(serde::Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Rhythm {
    /// 连续达标天数（从昨天往前数；今天是否达标见 `todayState`）
    pub streak: u32,
    /// done | pending | rest
    pub today_state: String,
    pub today_on_secs: u64,
    pub today_plan_secs: u64,
    pub today_goals_total: u32,
    pub today_goals_done: u32,
    /// 本周（周一起）累计自律秒数
    pub week_on_secs: u64,
    /// 上周同期（同样只算到今天是周几）——按"同期"比才公平
    pub last_week_on_secs: u64,
    pub week_days: u32,
}

static CACHE: Mutex<Option<(i64, Rhythm)>> = Mutex::new(None);

pub fn get(shared: &Shared) -> Rhythm {
    let now = Local::now().timestamp();
    if let Ok(g) = CACHE.lock() {
        if let Some((at, v)) = &*g {
            if now - *at < 60 {
                return v.clone();
            }
        }
    }
    let v = compute(shared);
    if let Ok(mut g) = CACHE.lock() {
        *g = Some((now, v.clone()));
    }
    v
}

/// 配置变了（改排班、写目标）立刻作废
pub fn invalidate() {
    if let Ok(mut g) = CACHE.lock() {
        *g = None;
    }
}

fn compute(shared: &Shared) -> Rhythm {
    let cfg = shared.config();
    let today = Local::now().date_naive();
    let mut r = Rhythm::default();

    // 目标一次读完，按天分组：逐天调 goals_of_day 会把同一个文件读 90 次
    let mut goals_by_day: std::collections::HashMap<String, (u32, u32)> =
        std::collections::HashMap::new();
    for g in crate::focus::all_goals() {
        if g.text.trim().is_empty() {
            continue;
        }
        let e = goals_by_day.entry(g.day.clone()).or_insert((0, 0));
        e.0 += 1;
        if g.state == "done" {
            e.1 += 1;
        }
    }

    r.today_plan_secs = plan_secs(&cfg, today);
    r.today_on_secs = crate::stats::day_on_secs(&today.to_string());
    let (gt, gd) = goals_by_day
        .get(&today.to_string())
        .copied()
        .unwrap_or((0, 0));
    r.today_goals_total = gt;
    r.today_goals_done = gd;
    r.today_state = if r.today_plan_secs == 0 {
        "rest".into()
    } else if reached(r.today_on_secs, r.today_plan_secs, gt, gd) {
        "done".into()
    } else {
        "pending".into()
    };

    r.streak = streak_from(
        today,
        90,
        |d| plan_secs(&cfg, d),
        |d| {
            let k = d.to_string();
            let (gt, gd) = goals_by_day.get(&k).copied().unwrap_or((0, 0));
            (crate::stats::day_on_secs(&k), gt, gd)
        },
    );

    // 本周 / 上周同期（周一为界）
    let wd = today.weekday().num_days_from_monday();
    let monday = today - Days::new(wd as u64);
    for i in 0..=wd {
        if let Some(d) = monday.checked_add_days(Days::new(i as u64)) {
            r.week_on_secs += crate::stats::day_on_secs(&d.to_string());
        }
    }
    r.week_days = wd + 1;
    let last_mon = monday - Days::new(7);
    for i in 0..=wd {
        if let Some(d) = last_mon.checked_add_days(Days::new(i as u64)) {
            r.last_week_on_secs += crate::stats::day_on_secs(&d.to_string());
        }
    }
    r
}

/// 纯逻辑版的连续天数：`on(d)` 返回当天的自律秒数。
///
/// 抽出来是为了能单测——真的去读 90 天文件既慢又依赖机器状态，
/// 而"休息日不该断"这种规则必须被断言守住。
fn streak_from<P, O>(today: NaiveDate, max_days: u64, plan: P, on: O) -> u32
where
    P: Fn(NaiveDate) -> u64,
    O: Fn(NaiveDate) -> (u64, u32, u32),
{
    let mut streak = 0u32;
    for i in 1..=max_days {
        let Some(d) = today.checked_sub_days(Days::new(i)) else {
            break;
        };
        let p = plan(d);
        if p == 0 {
            continue; // 休息日：不中断也不加分
        }
        let (secs, gt, gd) = on(d);
        if !reached(secs, p, gt, gd) {
            break;
        }
        streak += 1;
    }
    streak
}

/// 30 秒容差：采样是整分钟的，跨零点的几秒不该让一天"差一点没达标"
fn reached(on: u64, plan: u64, goals_total: u32, goals_done: u32) -> bool {
    on + 30 >= plan && (goals_total == 0 || goals_done >= goals_total)
}

fn plan_secs(cfg: &Config, day: NaiveDate) -> u64 {
    let wd = day.weekday().num_days_from_monday();
    let mins: u64 = (0..24u32)
        .filter_map(|h| crate::clock::plan_wins(cfg, wd, h))
        .flat_map(|w| w.into_iter())
        .map(|(_, _, f, t)| t.saturating_sub(f) as u64)
        .sum();
    mins * 60
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn 连续达标从天往回数() {
        let today = d(2026, 11, 5);
        // 计划 60 分钟；11-04、11-03 达标，11-02 不达标
        let got = streak_from(
            today,
            90,
            |_| 3600,
            |x| {
                let secs = if x >= d(2026, 11, 3) { 3600 } else { 0 };
                (secs, 0, 0)
            },
        );
        assert_eq!(2, got);
    }

    #[test]
    fn 休息日不中断也不加分() {
        let today = d(2026, 11, 5);
        // 11-04 是休息日（计划 0）→ 跳过；11-03、11-02 达标；11-01 起不达标
        let got = streak_from(
            today,
            90,
            |x| if x == d(2026, 11, 4) { 0 } else { 3600 },
            |x| {
                if x >= d(2026, 11, 2) {
                    (3600, 0, 0)
                } else {
                    (0, 0, 0)
                }
            },
        );
        assert_eq!(2, got, "休息日不该把连续打断");
    }

    #[test]
    fn 目标没做完不算达标() {
        let today = d(2026, 11, 5);
        let got = streak_from(
            today,
            90,
            |_| 3600,
            |x| {
                if x == d(2026, 11, 4) {
                    (3600, 3, 2) // 时长够了，但写了 3 个只做 2 个
                } else {
                    (3600, 0, 0)
                }
            },
        );
        assert_eq!(0, got, "11-04 目标没做完 → 连续中断");
    }

    #[test]
    fn 没写目标只看时长() {
        let today = d(2026, 11, 5);
        // 时长够、目标数 0：只看时长，应当算达标
        let got = streak_from(today, 90, |_| 3600, |_| (3600, 0, 0));
        assert_eq!(90, got);
    }

    #[test]
    fn 三十秒容差不卡边界() {
        assert!(reached(3570, 3600, 0, 0));
        assert!(!reached(3500, 3600, 0, 0));
    }
}
