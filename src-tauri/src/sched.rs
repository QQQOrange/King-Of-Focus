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
pub fn seconds_until_change(schedule: &[Vec<Slot>], now: &NaiveDateTime) -> Option<i64> {
    if is_empty_schedule(schedule) {
        return None;
    }
    let di = weekday_index(now.weekday());
    let t = (now.hour() * 60 + now.minute()) as i64;
    let abs_now = di * 1440 + t;
    let cur = is_active(schedule, now);

    let mut candidates: Vec<i64> = Vec::new();
    for (a, b) in abs_ranges(schedule) {
        for base in [0i64, 10080] {
            candidates.push(a + base);
            candidates.push(b + base);
        }
    }
    candidates.sort_unstable();
    candidates.dedup();

    for c in candidates {
        if c > abs_now {
            let delta = c - abs_now;
            if delta > 10080 {
                break;
            }
            let probe = *now + Duration::minutes(delta);
            if is_active(schedule, &probe) != cur {
                let secs = delta * 60 - now.second() as i64;
                return Some(secs.max(1));
            }
        }
    }
    None
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
pub fn slot_left_secs(schedule: &[Vec<Slot>], now: &NaiveDateTime) -> Option<i64> {
    let (_, b) = current_slot(schedule, now)?;
    let di = weekday_index(now.weekday());
    let abs_now = di * 1440 + (now.hour() * 60 + now.minute()) as i64;
    Some(((b - abs_now) * 60 - now.second() as i64).max(0))
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
