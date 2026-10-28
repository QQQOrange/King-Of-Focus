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
    /// 是否处于专注段（真正在自律）—— **黑名单唯一的生效前提**
    pub clock_on: bool,
    /// 是否允许在自律时间内启用黑名单（设置里的总开关）
    pub apply_rules: bool,
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
        apply_rules: apply,
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

/// 当前生效中的黑名单：引擎拦软件、插件拦网页都用这一份
///
/// **硬性前提：只在「自律时间」内生效。**
/// 自律时间 = 「自律时段」当前处于**专注段**（`clock_on`）。
///   · 没配自律时段 / 当前小时没选中 → 一律不拦
///   · 番茄休息段 → 一律不拦
///   · 只有专注段内，才按条目自己的时间范围做进一步收窄
///
/// 为什么这么定：黑名单是"自律的执法工具"，不是常驻的防火墙。
/// 自律时间之外用户是自由的，这时还去关人家的软件、拦人家的网页，
/// 只会让人觉得软件在乱管闲事，反而破坏自律工具本身的可信度。
///
/// 条目自己的 `schedule` 现在只承担一个职责：**在自律时间内再收窄范围**。
/// 空时间表 = 自律时间内全程生效；画了时间表 = 只在画出来的那些时段生效。
pub fn active_rules(cfg: &Config, now: &NaiveDateTime, d: &Discipline) -> Vec<RuleList> {
    // 自律时间之外（含休息段、没选中的小时）→ 黑名单整体静默
    if !d.clock_on {
        return Vec::new();
    }
    // 总开关关掉 → 黑名单不随自律时间启用
    if !d.apply_rules {
        return Vec::new();
    }
    cfg.lists
        .iter()
        .filter(|l| {
            if !l.enabled {
                return false;
            }
            // 条目自己的时间范围作为"自律时间内的二次收窄"
            let w = &l.schedule;
            let any = w.iter().any(|day| !day.is_empty());
            if any && !crate::sched::is_active(w, now) {
                return false;
            }
            // 条目自己的番茄休息段也放行
            !crate::sched::is_break_now(w, &l.brk, now)
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
    fn entry_schedule_narrows_inside_discipline_time() {
        // 黑名单条目自己的时间表是"周一 3:00–4:00"，现在是周三 10 点。
        // 旧语义：自律时段接管 → 忽略条目时间表。
        // 新语义：条目时间表是"自律时间内的二次收窄"，不命中就不生效。
        let mut c = base();
        c.lists[0].schedule = vec![vec![Slot { start: 180, end: 240 }]; 7];
        clock_on(&mut c, 2, 10, 60, 0);
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(d.clock_on, "应处于专注段");
        let rules = active_rules(&c, &now, &d);
        assert!(rules.is_empty(), "条目自己的时间表没命中 → 不生效");
    }

    #[test]
    fn blacklist_silent_outside_discipline_time() {
        // 核心新语义：自律时间之外，黑名单一律不启用，哪怕它自己的时间表是全天
        let mut c = base();
        // 自律时段：周一 9 点（现在测周三 10 点，不在时段内）
        let mut days = vec![vec![HourPlan::default(); 24]; 7];
        days[0][9] = HourPlan { on: true, work: 60, brk: 0, from: 0, to: 60 };
        c.settings.focus_clock = ClockCfg::with_days(true, days);
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(!d.clock_on, "不在自律时间");
        assert!(
            active_rules(&c, &now, &d).is_empty(),
            "自律时间外必须静默，哪怕条目时间表是全天"
        );
    }

    #[test]
    fn blacklist_active_inside_discipline_time_with_empty_schedule() {
        // 自律时间 + 条目时间表为空（= 不额外收窄）→ 生效
        let mut c = base();
        clock_on(&mut c, 2, 10, 60, 0);
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(d.clock_on);
        assert_eq!(active_rules(&c, &now, &d).len(), 1, "自律时间内应生效");
    }

    #[test]
    fn blacklist_narrows_with_own_schedule_inside_discipline_time() {
        // 自律时间内在，但条目时间表只覆盖 09:00–09:30，现在 10:30 → 不生效
        let mut c = base();
        c.lists[0].schedule = vec![vec![Slot { start: 540, end: 570 }]; 7];
        clock_on(&mut c, 2, 10, 60, 0);
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(d.clock_on);
        assert!(active_rules(&c, &now, &d).is_empty(), "条目时间范围没覆盖 → 不生效");
    }

    #[test]
    fn clock_break_pauses_everything() {
        let mut c = base();
        clock_on(&mut c, 2, 10, 40, 20);
        let now = now_at(2, 10, 45); // 40 分专注已过 → 休息段
        let d = state(&c, &now);
        assert!(d.clock_break);
        assert!(d.hard_pause);
        assert!(!d.clock_on, "休息段不算自律时间");
        assert!(active_rules(&c, &now, &d).is_empty(), "休息段应整体放行");
    }

    #[test]
    fn apply_rules_off_means_clock_does_not_force_rules() {
        let mut c = base();
        clock_on(&mut c, 2, 10, 60, 0);
        c.settings.focus_clock.apply_rules = false;
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(d.clock_on, "时钟本身仍在专注段");
        assert!(active_rules(&c, &now, &d).is_empty(), "总开关关掉后黑名单不启用");
    }

    #[test]
    fn disabled_entry_never_active() {
        let mut c = base();
        c.lists[0].enabled = false;
        clock_on(&mut c, 2, 10, 60, 0);
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(active_rules(&c, &now, &d).is_empty());
    }
}
