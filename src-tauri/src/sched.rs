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
