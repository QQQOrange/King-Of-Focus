//! 自律状态与「生效中的规则」——引擎和浏览器插件必须用同一份判定。
//!
//! 之前 monitor.rs（拦软件）和 server.rs（给插件的规则）各算各的：
//! monitor 认「自律时段接管」（时钟选中且 applyRules 打开 → 所有已启用规则立刻生效，
//! 忽略规则自己的时间表；休息段则整体暂停），server 却只看规则自己的时间表。
//! 于是出现一个要命的错位：
//!
//!   「自律时段开启 + 规则开启」时，主程序在拦软件，插件却一条规则都收不到，
//!   网站自律规则形同虚设（抖音照常能看）。
//!
//! 这里把判定收成一份，monitor 与 server 共用：
//! 插件拿到的规则 == 引擎此刻真正在执行的规则。

use crate::model::{Config, Rule};
use chrono::NaiveDateTime;

#[derive(Clone, Copy, Debug, Default)]
pub struct Discipline {
    /// 当前是否落在「自律时段」选中的小时里（含休息段）
    pub clock_in: bool,
    /// 是否处于该小时的休息段
    pub clock_break: bool,
    /// 是否处于专注段（真正在自律）—— **自律规则唯一的生效前提**
    pub clock_on: bool,
    /// 是否允许在自律时间内启用自律规则（设置里的总开关）
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
            || cfg.rules.iter().any(|l| {
                l.enabled
                    && crate::sched::is_active(&l.schedule, now)
                    && crate::sched::is_break_now(&l.schedule, &l.brk, now)
            }),
        clock_weekday: clock.map(|c| c.weekday).unwrap_or(7),
        clock_hour: clock.map(|c| c.hour).unwrap_or(24),
        clock_left: clock.map(|c| c.left).unwrap_or(0),
    }
}

/// 当前生效中的自律规则：引擎拦软件、插件拦网页都用这一份
///
/// **自律规则没有自己的时间表。** 它的语义就一句话：
/// 「自律时间里不能打开的软件 / 网站」。
/// 什么时候算自律时间，完全由「自律时段」那一页决定；
/// 自律规则只管名单本身，不参与任何时间判定。
///
/// 所以这里只有三个条件：
///   1. 处于自律时间（`clock_on`，即自律时段的专注段）
///   2. 这条自律规则被启用
///   3. 它被**当前这套**自律时段绑定（没绑任何一条 = 全部生效）
///
/// 之前自律规则条目还带一张周时间表，那是把两件事混在了一起：
/// 用户想"9 点开始自律"，结果要去两个页面各排一次时间，很容易对不上。
/// 现在时间只在「自律时段」排一次，自律规则纯名单。
pub fn active_rules(cfg: &Config, now: &NaiveDateTime, d: &Discipline) -> Vec<Rule> {
    let _ = now; // 自律规则不再依赖具体时刻，保留参数是为了不破坏调用方签名
    // 自律时间之外（含休息段、没选中的小时）→ 自律规则整体静默
    if !d.clock_on {
        return Vec::new();
    }
    // 总开关关掉 → 自律规则不随自律时间启用
    if !d.apply_rules {
        return Vec::new();
    }
    // 这套时段绑定的自律规则分组；空 = 不限制（老配置与默认行为）
    let fc = &cfg.settings.focus_clock;
    let bound: &[String] = fc
        .active_profile()
        .map(|p| p.bound.as_slice())
        .unwrap_or(&[]);
    cfg.rules
        .iter()
        .filter(|l| l.enabled)
        .filter(|l| bound.is_empty() || bound.contains(&l.id))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ClockCfg, HourPlan, Rule, Slot};

    fn base() -> Config {
        let mut c = Config::default();
        c.rules = vec![Rule {
            id: "r1".into(),
            name: "测试规则".into(),
            enabled: true,
            schedule: vec![vec![Slot { start: 0, end: 0 }]; 7], // 全天生效
            ..Rule::default()
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
        days[weekday as usize][hour as usize] = HourPlan { on: true, work, brk, from: 0, to: 60, seg: String::new(), wins: Vec::new() };
        cfg.settings.focus_clock = ClockCfg::with_days(true, days);
    }

    #[test]
    fn entry_schedule_is_ignored_now() {
        // 自律规则不再有自己的时间表：条目上的 schedule 写什么都不影响生效与否。
        // 时间只由「自律时段」决定 —— 这是本轮的核心语义变更。
        let mut c = base();
        // 故意写一个"现在肯定不在"的时间表（周一 3:00–4:00，现在是周三 10:30）
        c.rules[0].schedule = vec![vec![Slot { start: 180, end: 240 }]; 7];
        clock_on(&mut c, 2, 10, 60, 0);
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(d.clock_on);
        assert_eq!(
            active_rules(&c, &now, &d).len(),
            1,
            "自律时间内、条目已启用 → 生效，条目自己的时间表不再参与判定"
        );
    }

    #[test]
    fn blacklist_active_inside_discipline_time_with_empty_schedule() {
        let mut c = base();
        clock_on(&mut c, 2, 10, 60, 0);
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(d.clock_on);
        assert_eq!(active_rules(&c, &now, &d).len(), 1, "自律时间内应生效");
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
        assert!(active_rules(&c, &now, &d).is_empty(), "总开关关掉后自律规则不启用");
    }

    #[test]
    fn disabled_entry_never_active() {
        let mut c = base();
        c.rules[0].enabled = false;
        clock_on(&mut c, 2, 10, 60, 0);
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(active_rules(&c, &now, &d).is_empty());
    }

    /// 两套方案绑定不同的自律规则分组：同一时刻按"当前那套"的绑定判定。
    ///
    /// 这是"每套自律时段可自定义绑定某一套自律规则中的分组"的核心验收：
    /// 切方案不只是换时间表，还要换"这段时间管哪些名单"。
    #[test]
    fn profile_binding_selects_which_lists_apply() {
        let mut c = base();
        c.rules.push(Rule {
            id: "r2".into(),
            name: "娱乐".into(),
            enabled: true,
            ..Rule::default()
        });
        clock_on(&mut c, 2, 10, 60, 0);
        // 第二套方案（同一天同一小时），只绑 "r2"
        let mut p2 = c.settings.focus_clock.profiles[0].clone();
        p2.id = "p2".into();
        p2.name = "周末".into();
        p2.bound = vec!["r2".into()];
        c.settings.focus_clock.profiles.push(p2);

        let now = now_at(2, 10, 30);

        // 用第一套（bound 为空 = 全部）→ 两条都生效
        c.settings.focus_clock.active = "p1".into();
        let d = state(&c, &now);
        let ids: Vec<String> = active_rules(&c, &now, &d).into_iter().map(|l| l.id).collect();
        assert_eq!(ids.len(), 2, "未绑定 = 全部生效：{ids:?}");

        // 切到第二套（只绑 r2）→ 只剩 r2
        c.settings.focus_clock.active = "p2".into();
        let d = state(&c, &now);
        let ids: Vec<String> = active_rules(&c, &now, &d).into_iter().map(|l| l.id).collect();
        assert_eq!(ids, vec!["r2".to_string()], "绑定后只应生效被绑的那条：{ids:?}");
    }

    /// 绑定到一条"没启用"的自律规则 → 不生效（enabled 仍然是硬门槛）
    #[test]
    fn binding_cannot_force_disabled_list() {
        let mut c = base();
        clock_on(&mut c, 2, 10, 60, 0);
        c.settings.focus_clock.profiles[0].bound = vec!["r1".into()];
        c.rules[0].enabled = false;
        let now = now_at(2, 10, 30);
        let d = state(&c, &now);
        assert!(active_rules(&c, &now, &d).is_empty(), "绑定不能绕过 enabled 开关");
    }

    /// 与时间无关的回归：休息段即使绑定了也不生效
    #[test]
    fn binding_still_respects_break_pause() {
        let mut c = base();
        clock_on(&mut c, 2, 10, 40, 20);
        c.settings.focus_clock.profiles[0].bound = vec!["r1".into()];
        let now = now_at(2, 10, 45);
        let d = state(&c, &now);
        assert!(d.clock_break);
        assert!(active_rules(&c, &now, &d).is_empty());
    }
}
