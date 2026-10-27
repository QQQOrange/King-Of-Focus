use crate::model::Slot;
use chrono::{Datelike, Duration, Local, NaiveDateTime, Timelike, Weekday};

pub const DAY_NAMES: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

pub fn weekday_index(w: Weekday) -> i64 {
    match w {
        Weekday::Mon => 0,
        Weekday::Tue => 1,
        Weekday::Wed => 2,
        Weekday::Thu => 3,
        Weekday::Fri => 4,
        Weekday::Sat => 5,
        Weekday::Sun => 6,
    }
}

fn slots_of(schedule: &[Vec<Slot>], day: usize) -> &[Slot] {
    schedule.get(day).map(|v| v.as_slice()).unwrap_or(&[])
}

/// 展开成"绝对分钟"（以周一 00:00 为 0）
pub fn abs_ranges(schedule: &[Vec<Slot>]) -> Vec<(i64, i64)> {
    let mut out = Vec::new();
    for day in 0..7usize {
        for s in slots_of(schedule, day) {
            let a = day as i64 * 1440 + s.start as i64;
            let mut b = day as i64 * 1440 + s.end as i64;
            if b <= a {
                b += 1440; // 跨夜
            }
            out.push((a, b));
        }
    }
    out
}

pub fn is_empty_schedule(schedule: &[Vec<Slot>]) -> bool {
    (0..7).all(|d| slots_of(schedule, d).is_empty())
}

pub fn is_active(schedule: &[Vec<Slot>], now: &NaiveDateTime) -> bool {
    if is_empty_schedule(schedule) {
        return true; // 未设置时段 = 全天生效
    }
    let di = weekday_index(now.weekday());
    let t = (now.hour() * 60 + now.minute()) as i64;
    let abs_now = di * 1440 + t;
    let ranges = abs_ranges(schedule);
    for &(a, b) in &ranges {
        for k in [-1i64, 0, 1] {
            let shifted = abs_now + k * 10080;
            if shifted >= a && shifted < b {
                return true;
            }
        }
    }
    false
}

/// 距离下一次"生效/失效"状态翻转还有多少秒
///
/// 跨周注意：候选边界可能落在"上一周/下一周"的同一段上。
/// 早期实现只从本周的 abs_now 往后找候选，遇到「周日 23:00–周一 01:00」
/// 这种跨周边界的时段时，周一 00:59 会找不到 01:00 这个翻转点（返回 None）。
/// 现在把每个边界都投影到 [abs_now+1, abs_now+10080] 窗口内再比。
pub fn seconds_until_change(schedule: &[Vec<Slot>], now: &NaiveDateTime) -> Option<i64> {
    if is_empty_schedule(schedule) {
        return None;
    }
    let di = weekday_index(now.weekday());
    let t = (now.hour() * 60 + now.minute()) as i64;
    let abs_now = di * 1440 + t;
    let cur = is_active(schedule, now);

    let mut best: Option<i64> = None;
    for (a, b) in abs_ranges(schedule) {
        for edge in [a, b] {
            for base in [-10080i64, 0, 10080] {
                let c = edge + base;
                if c <= abs_now {
                    continue;
                }
                let delta = c - abs_now;
                if delta > 10080 {
                    continue;
                }
                let probe = *now + Duration::minutes(delta);
                if is_active(schedule, &probe) != cur {
                    // 减掉当前这一分钟已经走过的秒数
                    let secs = (delta * 60 - now.second() as i64).max(1);
                    best = Some(best.map_or(secs, |v| v.min(secs)));
                }
            }
        }
    }
    best
}

pub fn now_local() -> NaiveDateTime {
    Local::now().naive_local()
}

/// 人类可读的时段摘要
pub fn summary(schedule: &[Vec<Slot>]) -> String {
    if is_empty_schedule(schedule) {
        return "全天生效".into();
    }
    let mut parts: Vec<String> = Vec::new();
    for d in 0..7 {
        let s = slots_of(schedule, d);
        if s.is_empty() {
            continue;
        }
        let ranges: Vec<String> = s
            .iter()
            .map(|x| format!("{}-{}", mins(x.start), mins(x.end)))
            .collect();
        parts.push(format!("{}{}", DAY_NAMES[d], ranges.join(",")));
    }
    parts.join(" ")
}

pub fn mins(m: u32) -> String {
    format!("{:02}:{:02}", (m / 60) % 24, m % 60)
}

/// 当前所处的时段（返回绝对分钟区间，已处理跨夜与跨周）
pub fn current_slot(schedule: &[Vec<Slot>], now: &NaiveDateTime) -> Option<(i64, i64)> {
    let di = weekday_index(now.weekday());
    let abs_now = di * 1440 + (now.hour() * 60 + now.minute()) as i64;
    for (a, b) in abs_ranges(schedule) {
        for k in [-1i64, 0, 1] {
            let s = abs_now + k * 10080;
            if s >= a && s < b {
                return Some((a, b));
            }
        }
    }
    None
}

/// 当前时段还剩多少秒结束
///
/// 跨周注意：`current_slot` 可能命中"上一周/下一周"的同一段
/// （它靠 `abs_now + k * 10080` 判断归属）。直接把未平移的 `b` 减掉当前时间，
/// 会差出整整 7 天——例如「周日 23:00–周一 01:00」在周一 00:30 会算出 10080 分钟。
/// 这里先把当前时间平移到与 `[a, b)` 同一周，再算差值。
pub fn slot_left_secs(schedule: &[Vec<Slot>], now: &NaiveDateTime) -> Option<i64> {
    let (a, b) = current_slot(schedule, now)?;
    let di = weekday_index(now.weekday());
    let abs_now = di * 1440 + (now.hour() * 60 + now.minute()) as i64;
    // 单段最长 24 小时，平移到 [a, b) 内最多各走一次，不会死循环
    let mut same_week = abs_now;
    while same_week < a {
        same_week += 10080;
    }
    while same_week >= b {
        same_week -= 10080;
    }
    Some(((b - same_week) * 60 - now.second() as i64).max(0))
}

/// 番茄：当前是否处于休息段，以及这一小段还剩多少秒
pub fn pomodoro_state(
    schedule: &[Vec<Slot>],
    brk: &crate::model::BreakCfg,
    now: &NaiveDateTime,
) -> (bool, i64) {
    if brk.kind != "pomodoro" || brk.work_min == 0 || brk.break_min == 0 {
        return (false, 0);
    }
    let (a, _) = match current_slot(schedule, now) {
        Some(x) => x,
        None => return (false, 0),
    };
    let di = weekday_index(now.weekday());
    let abs_now = di * 1440 + (now.hour() * 60 + now.minute()) as i64;
    let mut elapsed_min = abs_now - a;
    if elapsed_min < 0 {
        elapsed_min += 10080;
    }
    let cycle = (brk.work_min + brk.break_min) as i64;
    let pos = elapsed_min % cycle;
    let in_break = pos >= brk.work_min as i64;
    let left_min = if in_break {
        cycle - pos - 1
    } else {
        brk.work_min as i64 - pos - 1
    };
    let left = left_min * 60 + (60 - now.second() as i64);
    (in_break, left.max(0))
}

/// 休息中不拦截
pub fn is_break_now(schedule: &[Vec<Slot>], brk: &crate::model::BreakCfg, now: &NaiveDateTime) -> bool {
    pomodoro_state(schedule, brk, now).0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now_at(weekday: u32, hour: u32, minute: u32, sec: u32) -> NaiveDateTime {
        // 2026-10-26 是周一（weekday=0）
        let base = chrono::NaiveDate::from_ymd_opt(2026, 10, 26).unwrap();
        (base + Duration::days(weekday as i64))
            .and_hms_opt(hour, minute, sec)
            .unwrap()
    }

    /// 只有周日 23:00–周一 01:00（跨夜 + 跨周边界）
    fn sunday_night() -> Vec<Vec<Slot>> {
        let mut s = vec![vec![]; 7];
        s[6] = vec![Slot { start: 23 * 60, end: 60 }];
        s
    }

    #[test]
    fn cross_midnight_covers_both_sides() {
        let s = sunday_night();
        assert!(is_active(&s, &now_at(6, 23, 30, 0)), "周日晚应生效");
        assert!(is_active(&s, &now_at(0, 0, 30, 0)), "周一凌晨应仍生效");
        assert!(!is_active(&s, &now_at(0, 1, 30, 0)), "周一 01:30 应已结束");
        assert!(!is_active(&s, &now_at(6, 22, 30, 0)), "周日 22:30 还没开始");
    }

    /// 跨周匹配时，剩余时间不能差出整整 7 天。
    /// 这条曾经是错的：current_slot 用 k=+1 平移到下一周才命中，
    /// 但 slot_left_secs 直接拿未平移的 b 去减，得到 10080 分钟。
    #[test]
    fn slot_left_secs_handles_cross_week_match() {
        let s = sunday_night();
        // 周一 00:30 → 距周一 01:00 还有 30 分钟
        let left = slot_left_secs(&s, &now_at(0, 0, 30, 0)).expect("应处于时段内");
        assert_eq!(left, 30 * 60, "跨周命中时剩余时间应为 30 分钟，实际 {left} 秒");
        // 周日 23:30 → 还有 90 分钟
        assert_eq!(slot_left_secs(&s, &now_at(6, 23, 30, 0)), Some(90 * 60));
        // 不在时段内 → None
        assert_eq!(slot_left_secs(&s, &now_at(0, 2, 0, 0)), None);
    }

    #[test]
    fn pomodoro_state_handles_cross_midnight() {
        let s = sunday_night();
        let brk = crate::model::BreakCfg {
            kind: "pomodoro".into(),
            work_min: 45,
            break_min: 15,
        };
        // 周一 00:30 = 时段开始后第 90 分钟 → 进入第二轮休息（90 % 60 = 30 ≥ 45? 否）
        let (in_break, left) = pomodoro_state(&s, &brk, &now_at(0, 0, 30, 0));
        assert!(!in_break, "第 90 分钟应在第二轮的专注段");
        assert!(left > 0 && left <= 45 * 60, "剩余 {left} 秒应落在 45 分钟内");
        // 周一 00:50 = 第 110 分钟 → 110 % 60 = 50 ≥ 45 → 休息
        assert!(pomodoro_state(&s, &brk, &now_at(0, 0, 50, 0)).0, "第 110 分钟应在休息段");
    }

    #[test]
    fn empty_schedule_means_all_day() {
        let e = vec![vec![]; 7];
        assert!(is_active(&e, &now_at(2, 3, 0, 0)), "空时间表 = 全天生效");
        assert_eq!(seconds_until_change(&e, &now_at(2, 3, 0, 0)), None);
        assert_eq!(summary(&e), "全天生效");
    }

    #[test]
    fn seconds_until_change_detects_boundary() {
        let s = sunday_night();
        // 周一 00:59:30 → 30 秒后结束
        let d = seconds_until_change(&s, &now_at(0, 0, 59, 30)).expect("应该能算出翻转点");
        assert_eq!(d, 30, "距 01:00 还有 30 秒，实际 {d}");
    }

    #[test]
    fn normal_slot_matches_own_day_only() {
        let mut s = vec![vec![]; 7];
        s[2] = vec![Slot { start: 9 * 60, end: 18 * 60 }]; // 周三 09:00–18:00
        assert!(is_active(&s, &now_at(2, 10, 0, 0)));
        assert!(!is_active(&s, &now_at(3, 10, 0, 0)), "不该串到周四");
        assert_eq!(slot_left_secs(&s, &now_at(2, 17, 30, 0)), Some(30 * 60));
    }
}
