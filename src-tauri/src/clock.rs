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
//!
//! 每小时的选中窗口还可以用 `from`/`to` 收窄成"第几分钟到第几分钟"
//! （默认 `0..60` = 整小时）：只有连续段的首/尾小时会带非默认值，
//! 于是"08:15–11:45"这种比整小时更细的边界也能表达。窗口外一律视为没选中。

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
/// 返回 `(work, brk, from, to)`：专注分钟、休息分钟、选中窗口的起止分钟。
/// 只认「当前生效的那套方案」：别的方案存着但不参与任何判定。
pub fn plan_at(cfg: &Config, weekday: u32, hour: u32) -> Option<(u32, u32, u32, u32)> {
    let c = &cfg.settings.focus_clock;
    if !c.enabled {
        return None;
    }
    let p = c.active_days()?.get(weekday as usize)?.get(hour as usize)?;
    if !p.on {
        return None;
    }
    Some((p.work.min(60), p.brk.min(60), p.from.min(59), p.to.clamp(1, 60)))
}

/// 当前时刻的状态。未启用 / 当前小时没选中 / 分钟落在窗口外 → None
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
    let (work, brk, from, to) = plan_at(cfg, weekday, hour)?;
    let minute = now.minute() as i64;
    let sec = now.second() as i64;

    // 起止分钟窗口外 → 这一小时没被选中（比如只选了 09:15–09:45）
    if minute < from as i64 || minute >= to as i64 {
        return None;
    }
    // 到窗口结束还剩多少分钟：专注/休息的阶段剩余时间都不能超过它
    let win_left = to as i64 - minute;

    // 休息时长为 0 或专注占满整小时 → 这一段连续专注
    if brk == 0 || work == 0 || work >= 60 {
        return Some(ClockState {
            weekday,
            hour,
            in_window: true,
            in_break: false,
            left: (win_left * 60 - sec).max(0),
            work: 60,
            brk: 0,
        });
    }

    let brk_end = (work + brk).min(60) as i64;
    let in_break = minute >= work as i64 && minute < brk_end;
    let phase_left = if in_break {
        brk_end - minute
    } else {
        work as i64 - minute
    };
    Some(ClockState {
        weekday,
        hour,
        in_window: true,
        in_break,
        // 窗口可能比阶段更早结束（如 09:00–09:30 的窗口里看不到 09:45 开始的休息）
        left: (phase_left.min(win_left) * 60 - sec).max(0),
        work,
        brk,
    })
}

/// 某一时刻是否"真正在自律"（在窗口内且不在休息段）
pub fn focusing_at(cfg: &Config, now: chrono::NaiveDateTime) -> bool {
    state_at(cfg, now).map(|s| s.focusing()).unwrap_or(false)
}

/// 自律模式是否由"生效时间段"接管中（休息段不算）
pub fn active(cfg: &Config) -> bool {
    focusing_at(cfg, now_local())
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
    let cur = focusing_at(cfg, now);

    // 直接按"未来时刻的专注状态"探测：分钟级窗口、跨小时、跨天都自动算对
    let mut probe_secs = 30i64;
    while probe_secs <= 7 * 24 * 3600 {
        let probe = now + chrono::Duration::seconds(probe_secs);
        if focusing_at(cfg, probe) != cur {
            return Some(probe_secs);
        }
        probe_secs += if probe_secs < 7200 { 30 } else { 300 };
    }
    None
}

/// 把一天里选中的小时合并成连续区间（"08:00–12:00、14:00–16:00"）。
/// 起止分钟非整点时带分钟（"08:15–11:45"）；中间小时的窗口不完整时
/// 会把区间断开——那段洞是真的没选中，文本不能假装连着。
fn day_ranges(day: &[crate::model::HourPlan]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < day.len() {
        if !day[i].on {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i;
        // 连续性看"有效边界"：上一小时得到整点、下一小时从整点开始，才算连上
        while end + 1 < day.len()
            && day[end + 1].on
            && day[end].to >= 60
            && day[end + 1].from == 0
        {
            end += 1;
        }
        let f = day[start].from.min(59);
        let t = day[end].to.clamp(1, 60);
        let (eh, em) = if t >= 60 { (end + 1, 0u32) } else { (end, t) };
        out.push(format!("{start:02}:{f:02}–{eh:02}:{em:02}"));
        i = end + 1;
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
        vec![vec![HourPlan { on: true, work, brk, from: 0, to: 60 }; 24]; 7]
    }

    #[test]
    fn plan_none_when_disabled() {
        let mut days = all_off();
        days[0][9] = HourPlan { on: true, work: 50, brk: 10, from: 0, to: 60 };
        assert!(plan_at(&cfg_with(days, false), 0, 9).is_none());
    }

    #[test]
    fn plan_none_when_hour_not_selected() {
        assert!(plan_at(&cfg_with(all_off(), true), 0, 9).is_none());
    }

    #[test]
    fn plan_clamps_and_reads_selected() {
        let mut days = all_off();
        days[2][9] = HourPlan { on: true, work: 90, brk: 30, from: 0, to: 60 };
        let c = cfg_with(days, true);
        assert_eq!(plan_at(&c, 2, 9), Some((60, 30, 0, 60)));
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
            days[0][h] = HourPlan { on: true, work: 50, brk: 10, from: 0, to: 60 };
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
        days[0][9] = HourPlan { on: true, work: 50, brk: 10, from: 0, to: 60 };
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
            a.days[0][h] = HourPlan { on: true, work: 50, brk: 10, from: 0, to: 60 };
            b.days[0][h] = HourPlan { on: true, work: 25, brk: 5, from: 0, to: 60 };
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
        assert_eq!(plan_at(&c, 0, 8), Some((50, 10, 0, 60)));
        c.settings.focus_clock.active = "rest".into();
        assert_eq!(plan_at(&c, 0, 8), Some((25, 5, 0, 60)), "切换方案后应按新方案判定");
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
        assert_eq!(plan_at(&c, 0, 8), Some((50, 10, 0, 60)));
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

    /* ---- 起止分钟（窗口）---- */

    /// 2026-10-26 是周一；tests 里都用它配一个确定的"现在"
    fn monday(hour: u32, minute: u32) -> chrono::NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, 10, 26)
            .unwrap()
            .and_hms_opt(hour, minute, 0)
            .unwrap()
    }

    #[test]
    fn plan_at_returns_window_fields() {
        let mut days = all_off();
        days[0][9] = HourPlan { on: true, work: 45, brk: 15, from: 15, to: 45 };
        assert_eq!(plan_at(&cfg_with(days, true), 0, 9), Some((45, 15, 15, 45)));
    }

    #[test]
    fn state_none_when_minute_outside_window() {
        let mut days = all_off();
        days[0][9] = HourPlan { on: true, work: 50, brk: 10, from: 15, to: 45 };
        let c = cfg_with(days, true);
        assert!(state_at(&c, monday(9, 10)).is_none(), "09:10 在窗口开始前");
        assert!(state_at(&c, monday(9, 50)).is_none(), "09:50 在窗口结束后");
        let s = state_at(&c, monday(9, 30)).expect("09:30 落在 15–45 窗口里");
        assert!(s.in_window && !s.in_break, "30 < 50，应是专注");
        assert_eq!(s.left, 15 * 60, "到 09:45 窗口结束还剩 15 分钟");
    }

    #[test]
    fn state_window_clips_phase_left() {
        // 窗口 09:00–09:30，而休息段从 09:45 才开始 → 永远看不到休息
        let mut days = all_off();
        days[0][9] = HourPlan { on: true, work: 50, brk: 10, from: 0, to: 30 };
        let c = cfg_with(days, true);
        let s = state_at(&c, monday(9, 10)).expect("09:10 在窗口里");
        assert!(!s.in_break, "窗口内全程专注");
        assert_eq!(s.left, 20 * 60, "剩余以窗口结束封顶，不是阶段结束");
    }

    #[test]
    fn state_break_inside_window() {
        // 窗口整段落在休息段里：09:30–09:50，休息段是 20–60
        let mut days = all_off();
        days[0][9] = HourPlan { on: true, work: 20, brk: 40, from: 30, to: 50 };
        let c = cfg_with(days, true);
        let s = state_at(&c, monday(9, 35)).expect("09:35 在窗口里");
        assert!(s.in_window && s.in_break, "35 落在 20–60 休息段");
        assert_eq!(s.left, 15 * 60, "到 09:50 窗口结束");
    }

    #[test]
    fn state_window_after_break_start() {
        // 从休息段中间开始选：09:50–10:00 全是休息
        let mut days = all_off();
        days[0][9] = HourPlan { on: true, work: 45, brk: 15, from: 50, to: 60 };
        let c = cfg_with(days, true);
        let s = state_at(&c, monday(9, 55)).expect("09:55 在窗口里");
        assert!(s.in_break, "55 >= 45 是休息段");
        assert_eq!(s.left, 5 * 60);
    }

    #[test]
    fn summary_includes_minute_boundaries() {
        let mut days = all_off();
        days[0][8] = HourPlan { on: true, work: 50, brk: 10, from: 15, to: 60 };
        days[0][9] = HourPlan { on: true, work: 50, brk: 10, from: 0, to: 60 };
        days[0][10] = HourPlan { on: true, work: 50, brk: 10, from: 0, to: 60 };
        days[0][11] = HourPlan { on: true, work: 50, brk: 10, from: 0, to: 45 };
        assert_eq!(summary(&cfg_with(days, true)), "周一 08:15–11:45");
    }

    #[test]
    fn summary_splits_at_interior_partial_hour() {
        // 第 9 小时只选 0–30：08–12 连着选也会有洞，文本必须断开
        let mut days = all_off();
        for h in [8, 10, 11] {
            days[0][h] = HourPlan { on: true, work: 50, brk: 10, from: 0, to: 60 };
        }
        days[0][9] = HourPlan { on: true, work: 50, brk: 10, from: 0, to: 30 };
        assert_eq!(summary(&cfg_with(days, true)), "周一 08:00–09:30、10:00–12:00");
    }

    #[test]
    fn seconds_until_change_with_window() {
        let mut days = all_off();
        days[0][9] = HourPlan { on: true, work: 50, brk: 10, from: 15, to: 45 };
        assert!(seconds_until_change(&cfg_with(days, true)).is_some());
    }

    #[test]
    fn focusing_at_respects_window() {
        let mut days = all_off();
        days[0][9] = HourPlan { on: true, work: 50, brk: 10, from: 15, to: 45 };
        let c = cfg_with(days, true);
        assert!(!focusing_at(&c, monday(9, 10)));
        assert!(focusing_at(&c, monday(9, 30)));
        assert!(!focusing_at(&c, monday(9, 50)));
    }

    /// 端到端：把"7×24 全选"的 JSON 反序列化成 Config，再算 state。
    ///
    /// 这条测试是为了抓一类很隐蔽的问题：**JSON 字段名写错 → 该方案解析失败 →
    /// profiles 变空 → plan_at 返回 None → 表现成"自律时段没生效"**，
    /// 而配置在文件里看起来完全正常。
    #[test]
    fn json_roundtrip_full_week_is_focusing() {
        let plan = r#"{"on":true,"work":60,"brk":0,"from":0,"to":60}"#;
        let day = format!("[{}]", vec![plan; 24].join(","));
        let days = format!("[{}]", vec![day; 7].join(","));
        let json = format!(
            r#"{{"settings":{{"focusClock":{{"enabled":true,"applyRules":true,"active":"p1",
               "profiles":[{{"id":"p1","name":"t","days":{days},"defWork":60,"defBrk":0}}]}}}}}}"#
        );
        let cfg: Config = serde_json::from_str(&json).expect("配置应能反序列化");
        let fc = &cfg.settings.focus_clock;
        assert!(fc.enabled, "enabled 应为 true");
        assert_eq!(fc.profiles.len(), 1, "profiles 不该为空（字段名错会变空）");
        let days_parsed = fc.active_days().expect("应能取到生效方案");
        assert_eq!(days_parsed.len(), 7);
        assert_eq!(days_parsed[0].len(), 24);

        // 任意时刻都该在专注段
        let now = monday(13, 30);
        let st = state_at(&cfg, now).expect("应返回 ClockState");
        assert!(st.in_window, "7×24 全选 → 任何时刻都在窗口内");
        assert!(st.focusing(), "60/0 → 全程专注");
        assert!(!st.in_break);
    }

    /// 同上，但用 snake_case 的 def_work/def_brk 也要能兼容（旧配置文件）
    #[test]
    fn json_accepts_legacy_snake_case_profile() {
        let plan = r#"{"on":true,"work":60,"brk":0,"from":0,"to":60}"#;
        let day = format!("[{}]", vec![plan; 24].join(","));
        let days = format!("[{}]", vec![day; 7].join(","));
        let json = format!(
            r#"{{"settings":{{"focusClock":{{"enabled":true,"applyRules":true,"active":"p1",
               "profiles":[{{"id":"p1","name":"t","days":{days},"def_work":60,"def_brk":0}}]}}}}}}"#
        );
        let cfg: Config = serde_json::from_str(&json).expect("旧字段格式也应能解析");
        assert_eq!(cfg.settings.focus_clock.profiles.len(), 1);
        assert!(state_at(&cfg, monday(9, 0)).map(|s| s.focusing()).unwrap_or(false));
    }
}
