//! 「自律模式生效时间段」——把一周切成 7 天，每天再切成 24 个 1 小时时段。
//!
//! 为什么不用现成的规则时段？
//! 规则里的 `schedule` 是"周一到周日 × 任意分钟区间"，灵活但配置成本高；
//! 这个页面要的是"在 0–24 的柱状图上一把拖过去就选好"，粒度固定为 1 小时，
//! 所以单独一份数据结构，逻辑上只做三件事：
//!
//! 1. 当前这一小时有没有被选中 → `in_window`
//! 2. 选中了的话，现在处于"专注"还是"休息" → `in_break`
//! 3. 当前阶段还剩多少秒 → `left`
//!
//! 每段的"专注 + 休息"以**整点**为锚点循环：第 9 段（09:00–10:00）设成
//! 专注 45 / 休息 15，就是 09:00–09:45 专注、09:45–10:00 休息。
//! `work + brk > 60` 会在 sanitize 里被夹到 60，休息不会溢到下一段。

use crate::model::Config;
use crate::sched::now_local;
use chrono::{Datelike, Timelike};

/// 星期名，索引 = `num_days_from_monday()`（0=周一）
pub const WEEKDAY_NAMES: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

#[derive(Clone, Copy, Debug)]
pub struct ClockState {
    /// 星期几（0=周一 … 6=周日）
    pub weekday: u32,
    /// 当前小时（0–23）
    pub hour: u32,
    /// 是否在被选中的时段里（含休息段）
    pub in_window: bool,
    /// 是否处于该段的休息时间
    pub in_break: bool,
    /// 当前阶段剩余秒数
    pub left: i64,
    pub work: u32,
    pub brk: u32,
}

impl ClockState {
    /// 真正"在专注"（自律模式生效）
    pub fn focusing(&self) -> bool {
        self.in_window && !self.in_break
    }
}

/// 某天某小时的计划（未启用 / 未选中 → None）
///
/// 只认「当前生效的那套方案」：别的方案存着但不参与任何判定。
pub fn plan_at(cfg: &Config, weekday: u32, hour: u32) -> Option<(u32, u32)> {
    let c = &cfg.settings.focus_clock;
    if !c.enabled {
        return None;
    }
    let p = c.active_days()?.get(weekday as usize)?.get(hour as usize)?;
    if !p.on {
        return None;
    }
    Some((p.work.min(60), p.brk.min(60)))
}

/// 当前时刻的状态。未启用或当前小时没选中 → None
pub fn state(cfg: &Config) -> Option<ClockState> {
    state_at(cfg, now_local())
}

/// 与 `state` 一样，但可以指定"现在"。
///
/// 引擎（monitor）与插件服务端（server）必须用同一个"现在"来算自律状态，
/// 否则两边会得出不同结论（插件收不到规则、黑名单形同虚设）。
pub fn state_at(cfg: &Config, now: chrono::NaiveDateTime) -> Option<ClockState> {
    let weekday = now.weekday().num_days_from_monday();
    let hour = now.hour();
    let (work, brk) = plan_at(cfg, weekday, hour)?;
    let minute = now.minute() as i64;
    let sec = now.second() as i64;

    // 休息时长为 0 或专注占满整小时 → 这一段连续专注
    if brk == 0 || work == 0 || work >= 60 {
        return Some(ClockState {
            weekday,
            hour,
            in_window: true,
            in_break: false,
            left: ((60 - minute) * 60 - sec).max(0),
            work: 60,
            brk: 0,
        });
    }

    let brk_end = (work + brk).min(60) as i64;
    let in_break = minute >= work as i64 && minute < brk_end;
    let left = if in_break {
        (brk_end - minute) * 60 - sec
    } else {
        (work as i64 - minute) * 60 - sec
    };
    Some(ClockState {
        weekday,
        hour,
        in_window: true,
        in_break,
        left: left.max(0),
        work,
        brk,
    })
}

/// 自律模式是否由"生效时间段"接管中（休息段不算）
pub fn active(cfg: &Config) -> bool {
    state(cfg).map(|s| s.focusing()).unwrap_or(false)
}

/// 距离这个计划下一次状态翻转还有多少秒（用于界面上的倒计时）。
/// 周计划下"选中了任一时段"就保证 7 天内有翻转，所以探测上限定为 7 天；
/// 近处（2 小时内）用 30 秒精度，远处放宽到 5 分钟——这只是给界面显示用的。
pub fn seconds_until_change(cfg: &Config) -> Option<i64> {
    let c = &cfg.settings.focus_clock;
    if !c.enabled {
        return None;
    }
    let days = c.active_days()?;
    if days.iter().flatten().all(|h| !h.on) {
        return None;
    }
    let now = now_local();
    let cur = state(cfg).map(|s| s.focusing()).unwrap_or(false);

    let mut probe_secs = 30i64;
    while probe_secs <= 7 * 24 * 3600 {
        let probe = now + chrono::Duration::seconds(probe_secs);
        let next = match plan_at(cfg, probe.weekday().num_days_from_monday(), probe.hour()) {
            Some((work, brk)) if brk > 0 && work > 0 && work < 60 => {
                let m = probe.minute();
                !(m >= work && m < (work + brk).min(60))
            }
            Some(_) => true,
            None => false,
        };
        if next != cur {
            return Some(probe_secs);
        }
        probe_secs += if probe_secs < 7200 { 30 } else { 300 };
    }
    None
}

/// 把一天里选中的小时合并成连续区间（"08:00–12:00、14:00–16:00"）
fn day_ranges(day: &[crate::model::HourPlan]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < day.len() {
        if !day[i].on {
            i += 1;
            continue;
        }
        let start = i;
        while i + 1 < day.len() && day[i + 1].on {
            i += 1;
        }
        out.push(format!("{:02}:00–{:02}:00", start, i + 1));
        i += 1;
    }
    out
}

/// 人类可读的时段摘要。
/// 一周七天完全一样 → "每天 08:00–12:00、14:00–18:00"；
/// 否则逐天列出有选中的日子 → "周三 08:00–12:00；周六 09:00–11:00"。
///
/// 存了多套方案时前面带上方案名——不然界面上根本分不清说的是哪一套。
pub fn summary(cfg: &Config) -> String {
    let c = &cfg.settings.focus_clock;
    let Some(p) = c.active_profile() else {
        return "未选择任何时段".into();
    };
    let body = days_summary(&p.days);
    if c.profiles.len() > 1 {
        format!("「{}」{}", p.name, body)
    } else {
        body
    }
}

fn days_summary(days: &[Vec<crate::model::HourPlan>]) -> String {
    if days.is_empty() {
        return "未选择任何时段".into();
    }
    // 七天都相同 → 压缩成"每天"
    let first = day_ranges(&days[0]);
    if !first.is_empty() && days.iter().all(|d| day_ranges(d) == first) {
        return format!("每天 {}", first.join("、"));
    }
    let mut parts: Vec<String> = Vec::new();
    for (w, day) in days.iter().enumerate() {
        let ranges = day_ranges(day);
        if ranges.is_empty() {
            continue;
        }
        let name = WEEKDAY_NAMES.get(w).copied().unwrap_or("?");
        parts.push(format!("{} {}", name, ranges.join("、")));
    }
    if parts.is_empty() {
        "未选择任何时段".into()
    } else {
        parts.join("；")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ClockCfg, ClockProfile, Config, HourPlan};

    fn cfg_with(days: Vec<Vec<HourPlan>>, enabled: bool) -> Config {
        let mut c = Config::default();
        c.settings.focus_clock = ClockCfg::with_days(enabled, days);
        c
    }

    fn all_off() -> Vec<Vec<HourPlan>> {
        vec![vec![HourPlan::default(); 24]; 7]
    }

    fn all_on(work: u32, brk: u32) -> Vec<Vec<HourPlan>> {
        vec![vec![HourPlan { on: true, work, brk }; 24]; 7]
    }

    #[test]
    fn plan_none_when_disabled() {
        let mut days = all_off();
        days[0][9] = HourPlan { on: true, work: 50, brk: 10 };
        assert!(plan_at(&cfg_with(days, false), 0, 9).is_none());
    }

    #[test]
    fn plan_none_when_hour_not_selected() {
        assert!(plan_at(&cfg_with(all_off(), true), 0, 9).is_none());
    }

    #[test]
    fn plan_clamps_and_reads_selected() {
        let mut days = all_off();
        days[2][9] = HourPlan { on: true, work: 90, brk: 30 };
        let c = cfg_with(days, true);
        assert_eq!(plan_at(&c, 2, 9), Some((60, 30)));
        assert_eq!(plan_at(&c, 3, 9), None);
        assert_eq!(plan_at(&c, 2, 23), None);
    }

    #[test]
    fn plan_out_of_range_weekday() {
        assert!(plan_at(&cfg_with(all_on(50, 10), true), 7, 9).is_none());
    }

    #[test]
    fn state_none_when_disabled() {
        let c = cfg_with(all_on(50, 10), false);
        assert!(state(&c).is_none());
        assert!(!active(&c));
        assert!(seconds_until_change(&c).is_none());
    }

    #[test]
    fn state_hits_selected_hour() {
        // 全天全周选中：当前小时必然命中
        let c = cfg_with(all_on(50, 10), true);
        let s = state(&c).expect("当前小时应命中");
        assert!(s.in_window);
        assert!(s.weekday < 7);
        assert!(s.left >= 0 && s.left <= 3000);
        // 休息段最多 10 分钟
        if s.in_break {
            assert!(s.left <= 600);
        }
    }

    #[test]
    fn state_continuous_when_work_fills_hour() {
        let c = cfg_with(all_on(60, 10), true);
        let s = state(&c).expect("当前小时应命中");
        assert!(!s.in_break);
        assert_eq!((s.work, s.brk), (60, 0));
    }

    #[test]
    fn state_weekday_matters() {
        // 只有"今天"选中，其它天全关：state 的成败取决于今天是周几
        let mut days = all_off();
        for h in 0..24 {
            days[0][h] = HourPlan { on: true, work: 50, brk: 10 };
        }
        let c = cfg_with(days, true);
        match state(&c) {
            Some(s) => assert_eq!(s.weekday, 0, "只有周一选中，能命中就说明今天是周一"),
            None => assert!(now_local().weekday().num_days_from_monday() != 0),
        }
    }

    #[test]
    fn summary_every_day_when_all_same() {
        let mut days = all_off();
        for h in [8, 9, 10, 11, 14, 15] {
            for d in days.iter_mut() {
                d[h].on = true;
            }
        }
        assert_eq!(
            summary(&cfg_with(days, true)),
            "每天 08:00–12:00、14:00–16:00"
        );
    }

    #[test]
    fn summary_per_day_when_differs() {
        let mut days = all_off();
        for h in [8, 9, 10, 11] {
            days[2][h].on = true; // 周三
        }
        days[5][9].on = true; // 周六
        assert_eq!(
            summary(&cfg_with(days, true)),
            "周三 08:00–12:00；周六 09:00–10:00"
        );
    }

    #[test]
    fn summary_empty_when_nothing_selected() {
        assert_eq!(summary(&cfg_with(all_off(), true)), "未选择任何时段");
    }

    #[test]
    fn seconds_until_change_none_when_all_off() {
        assert!(seconds_until_change(&cfg_with(all_off(), true)).is_none());
    }

    #[test]
    fn seconds_until_change_some_when_any_hour_on() {
        let mut days = all_off();
        days[0][9] = HourPlan { on: true, work: 50, brk: 10 };
        // 周计划：只要选了任一天的一小时，7 天内必然有状态翻转（不管今天周几）
        assert!(seconds_until_change(&cfg_with(days, true)).is_some());
    }

    #[test]
    fn weekday_names_cover_monday_to_sunday() {
        assert_eq!(WEEKDAY_NAMES.len(), 7);
        assert_eq!(WEEKDAY_NAMES[0], "周一");
        assert_eq!(WEEKDAY_NAMES[6], "周日");
    }

    /// 多套方案：只有 active 指定的那一套参与判定
    fn two_profiles() -> Config {
        let mut a = ClockProfile::default();
        a.id = "work".into();
        a.name = "工作日".into();
        let mut b = ClockProfile::default();
        b.id = "rest".into();
        b.name = "周末".into();
        for h in 8..12 {
            a.days[0][h] = HourPlan { on: true, work: 50, brk: 10 };
            b.days[0][h] = HourPlan { on: true, work: 25, brk: 5 };
        }
        let mut c = Config::default();
        c.settings.focus_clock = ClockCfg {
            enabled: true,
            profiles: vec![a, b],
            active: "work".into(),
            ..ClockCfg::default()
        };
        c
    }

    #[test]
    fn plan_at_follows_active_profile() {
        let mut c = two_profiles();
        assert_eq!(plan_at(&c, 0, 8), Some((50, 10)));
        c.settings.focus_clock.active = "rest".into();
        assert_eq!(plan_at(&c, 0, 8), Some((25, 5)), "切换方案后应按新方案判定");
        c.settings.focus_clock.enabled = false;
        assert!(plan_at(&c, 0, 8).is_none(), "总开关关掉后哪套都不生效");
    }

    #[test]
    fn active_falls_back_to_first_when_id_missing() {
        let mut c = two_profiles();
        c.settings.focus_clock.active = "已经删掉的方案".into();
        assert_eq!(
            c.settings.focus_clock.active_profile().map(|p| p.id.as_str()),
            Some("work"),
            "active 失效时退回第一套"
        );
        assert_eq!(plan_at(&c, 0, 8), Some((50, 10)));
    }

    #[test]
    fn summary_prefixes_profile_name_when_multiple() {
        let mut c = two_profiles();
        assert_eq!(summary(&c), "「工作日」周一 08:00–12:00");
        c.settings.focus_clock.active = "rest".into();
        assert_eq!(summary(&c), "「周末」周一 08:00–12:00");
        // 只有一套时不加前缀，保持旧文案
        c.settings.focus_clock.profiles.truncate(1);
        c.settings.focus_clock.active = "work".into();
        assert_eq!(summary(&c), "周一 08:00–12:00");
    }

    #[test]
    fn seconds_until_change_uses_active_profile() {
        let mut c = two_profiles();
        c.settings.focus_clock.active = "rest".into();
        // 两套都在周一 8–12 点，翻转点一致；关键是不能因为另一套而算错
        assert!(seconds_until_change(&c).is_some());
        c.settings.focus_clock.profiles.truncate(1);
        assert!(seconds_until_change(&c).is_some());
    }
}
