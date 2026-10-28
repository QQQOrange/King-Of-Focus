//! 自律状态与「生效中的规则」——引擎和浏览器插件必须用同一份判定。
//!
//! 之前 monitor.rs（拦软件）和 server.rs（给插件的规则）各算各的：
//! monitor 认「自律时段接管」（时钟选中且 applyRules 打开 → 所有已启用规则立刻生效，
//! 忽略规则自己的时间表；休息段则整体暂停），server 却只看规则自己的时间表。
//! 于是出现一个要命的错位：
//!
//!   「自律时段开启 + 规则开启」时，主程序在拦软件，插件却一条规则都收不到，
//!   网站黑名单形同虚设（抖音照常能看）。
//!
//! 这里把判定收成一份，monitor 与 server 共用：
//! 插件拿到的规则 == 引擎此刻真正在执行的规则。

use crate::model::{Config, RuleList};
use chrono::NaiveDateTime;

#[derive(Clone, Copy, Debug, Default)]
pub struct Discipline {
    /// 当前是否落在「自律时段」选中的小时里（含休息段）
    pub clock_in: bool,
    /// 是否处于该小时的休息段
    pub clock_break: bool,
    /// 是否处于专注段（真正在自律）
    pub clock_on: bool,
    /// 时段内强制让所有已启用规则立即生效
    pub clock_all: bool,
    /// 休息段：整体暂停拦截
    pub hard_pause: bool,
    /// 是否有规则处于自己的番茄休息段
    pub on_break: bool,
    /// 当前是周几（0=周一）
    pub clock_weekday: u32,
    /// 当前小时（0–23），不在时段里时为 24
    pub clock_hour: u32,
    /// 当前阶段（专注/休息）剩余秒数
    pub clock_left: i64,
}

/// 一次性算出"现在处于自律的什么状态"
pub fn state(cfg: &Config, now: &NaiveDateTime) -> Discipline {
    let clock = crate::clock::state_at(cfg, *now);
    let clock_in = clock.map(|c| c.in_window).unwrap_or(false);
    let clock_break = clock.map(|c| c.in_break).unwrap_or(false);
    let apply = cfg.settings.focus_clock.apply_rules;
    Discipline {
        clock_in,
        clock_break,
        clock_on: clock.map(|c| c.focusing()).unwrap_or(false),
        clock_all: clock_in && !clock_break && apply,
        hard_pause: clock_break && apply,
        on_break: clock_break
            || cfg.lists.iter().any(|l| {
                l.enabled
                    && crate::sched::is_active(&l.schedule, now)
                    && crate::sched::is_break_now(&l.schedule, &l.brk, now)
            }),
        clock_weekday: clock.map(|c| c.weekday).unwrap_or(7),
        clock_hour: clock.map(|c| c.hour).unwrap_or(24),
        clock_left: clock.map(|c| c.left).unwrap_or(0),
    }
}

/// 当前生效中的规则：引擎拦软件、插件拦网页都用这一份
pub fn active_rules(cfg: &Config, now: &NaiveDateTime, d: &Discipline) -> Vec<RuleList> {
    if d.hard_pause {
        return Vec::new(); // 休息段：整体放行
    }
    cfg.lists
        .iter()
        .filter(|l| {
            if !l.enabled {
                return false;
            }
            if d.clock_all {
                return true; // 时段接管：忽略规则自己的时间表
            }
            crate::sched::is_active(&l.schedule, now)
                && !crate::sched::is_break_now(&l.schedule, &l.brk, now)
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ClockCfg, HourPlan, RuleList, Slot};

    fn base() -> Config {
        let mut c = Config::default();
        c.lists = vec![RuleList {
            id: "r1".into(),
            name: "测试规则".into(),
            enabled: true,
            schedule: vec![vec![Slot { start: 0, end: 0 }]; 7], // 全天生效
            ..RuleList::default()
        }];
        c
    }

    fn now_at(weekday: u32, hour: u32, minute: u32) -> NaiveDateTime {
        // 2026-10-26 是周一（weekday=0）
        let base = chrono::NaiveDate::from_ymd_opt(2026, 10, 26).unwrap();
        let day = base + chrono::Duration::days(weekday as i64);
        day.and_hms_opt(hour, minute, 0).unwrap()
    }

    fn clock_on(cfg: &mut Config, weekday: u32, hour: u32, work: u32, brk: u32) {
        let mut days = vec![vec![HourPlan::default(); 24]; 7];
        days[weekday as usize][hour as usize] = HourPlan { on: true, work, brk, from: 0, to: 60 };
        cfg.settings.focus_clock = ClockCfg::with_days(true, days);
    }

    #[test]
    fn clock_all_forces_enabled_rules_even_when_rule_schedule_is_off() {
        // 规则自己的时间表是"全天之外的空档"（这里设成周一 3:00–4:00，现在不是那会儿）
        let mut c = base();
        c.lists[0].schedule = vec![vec![Slot { start: 180, end: 240 }]; 7];
        // 时段接管：周三 10 点选中
        clock_on(&mut c, 2, 10, 60, 0);
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(d.clock_on, "应处于专注段");
        assert!(d.clock_all, "applyRules 打开时应接管规则");
        let rules = active_rules(&c, &now, &d);
        assert_eq!(rules.len(), 1, "时段接管时规则应生效（哪怕规则自己的时段没到）");
    }

    #[test]
    fn clock_break_pauses_everything() {
        let mut c = base();
        clock_on(&mut c, 2, 10, 40, 20);
        let now = now_at(2, 10, 45); // 40 分专注已过 → 休息段
        let d = state(&c, &now);
        assert!(d.clock_break);
        assert!(d.hard_pause);
        assert!(active_rules(&c, &now, &d).is_empty(), "休息段应整体放行");
    }

    #[test]
    fn outside_window_rule_follows_own_schedule() {
        let mut c = base();
        // 时段没选中 → 不接管
        let mut days = vec![vec![HourPlan::default(); 24]; 7];
        days[0][3] = HourPlan { on: true, work: 60, brk: 0, from: 0, to: 60 };
        c.settings.focus_clock = ClockCfg::with_days(true, days);
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(!d.clock_all);
        assert_eq!(active_rules(&c, &now, &d).len(), 1, "规则全天生效 → 仍然生效");
    }

    #[test]
    fn apply_rules_off_means_clock_does_not_force_rules() {
        let mut c = base();
        c.lists[0].schedule = vec![vec![Slot { start: 180, end: 240 }]; 7];
        clock_on(&mut c, 2, 10, 60, 0);
        c.settings.focus_clock.apply_rules = false;
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(d.clock_on, "时钟本身仍在专注段");
        assert!(!d.clock_all, "applyRules 关掉后不该接管规则");
        assert!(active_rules(&c, &now, &d).is_empty());
    }
}
