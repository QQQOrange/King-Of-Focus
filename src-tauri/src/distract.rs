//! 分心事件（distraction inbox）
//!
//! 解决的是自律软件最实际的一个问题：**学习时突然冒出的零散想法**。
//! "等会儿要买牙膏""那个接口该加缓存""刚那条消息要回"——这些念头一旦出现，
//! 大脑就会一直攥着它，专注被打断。写下来就相当于告诉自己"已经记住了"，
//! 于是可以立刻回到原来那件事上。
//!
//! 所以这里的设计原则只有两条：
//! 1. **记录必须比切走去记更快**：HUD 上一个按钮、一个输入框、回车。三秒内完成。
//! 2. **记录不等于完成**：写下来只是"从脑子里搬出来"，真正的处理在事后
//!    （勾选完成 / 删除 / 变成任务）。所以条目默认是未完成，并且在自律时段结束时
//!    统一提醒一次，之后按用户设的间隔反复提醒，直到处理掉。
//!
//! 数据落在 `king of focus data/distractions.json`，**不进跨设备备份**：
//! 它是"事件流"，不是配置。跟统计一样，两台设备各记各的才说得通
//! （在电脑前记下的想法，不该在手机上被提醒一遍）。
//!
//! 与「自律时段」的关系：每条事件都记下所属时段的起止（`segStart`/`segEnd`），
//! 界面因此能说清"这条是 09:00–12:00 那一段里记的"，时段结束时也能精确汇总。

use crate::model::Config;
use crate::shared::Shared;
use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

/// 一条分心事件
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Item {
    pub id: String,
    /// 用户写下的那句话（原样保存，不做敏感词处理）
    pub text: String,
    /// 记录时刻（unix 秒）
    pub at: i64,
    /// 本地日期 `yyyy-MM-dd`：日历按它归组，跨时区换机器也不会串天
    pub day: String,
    /// 所属自律时段的起点 / 终点（unix 秒）。不在时段里记录 → 0
    pub seg_start: i64,
    pub seg_end: i64,
    /// 时段的可读标签，如 `09:00–12:00`
    pub seg_label: String,
    pub done: bool,
    /// 打勾 / 取消打勾的时刻
    pub done_at: i64,
    /// 上一次提醒的时刻（重复提醒按它算间隔）
    pub nudged_at: i64,
}

/// 落盘的整体结构（带版本号：以后加字段不至于读不出来）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Store {
    pub schema: u32,
    pub items: Vec<Item>,
}

/// 磁盘上的上限：超过就丢掉最老的**已完成**条目。
///
/// 只丢已完成的：未完成的是"欠自己的账"，删掉等于把用户的待办吃掉。
/// 5000 条 ≈ 重度用户两三年的量，文件也就几百 KB。
pub const MAX_ITEMS: usize = 5000;

pub fn path() -> PathBuf {
    crate::cfg::data_dir().join("distractions.json")
}

pub fn load() -> Store {
    let text = std::fs::read_to_string(path()).unwrap_or_default();
    let mut st: Store = serde_json::from_str(&text).unwrap_or_default();
    if st.schema == 0 {
        st.schema = 1;
    }
    st
}

fn save(st: &Store) -> Result<(), String> {
    let p = path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let s = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    // 先写临时文件再改名：写到一半断电也不会把上一份清单写成半截 JSON
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, s).map_err(|e| format!("写入分心事件失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("写入分心事件失败: {e}"))
}

// ---------------------------------------------------------------- 时段归属

/// 某个时刻所在的「自律时段」：(起点, 终点, 标签)。
///
/// 什么叫一段：相邻且都选中的小时算一段（`to == 60` 表示这一小时整段被选中）。
/// 09:00–12:00 排三格 = 一段 3 小时；11:00 那格没选 = 断成两段。
///
/// 为什么不用「小时」当归属：用户心里的一"段"是那三个小时连着坐下来的时间，
/// 时段结束提醒也该按这一段汇总，而不是每到一个整点就催一次。
pub fn segment_bounds(cfg: &Config, now: NaiveDateTime) -> Option<(i64, i64, String)> {
    if !cfg.settings.focus_clock.enabled {
        return None;
    }
    let wd = now.weekday().num_days_from_monday();
    let hour = now.hour();
    let minute = now.minute();
    let wins = crate::clock::plan_wins(cfg, wd, hour)?;
    let (_, _, from, to) = *wins
        .iter()
        .find(|(_, _, f, t)| minute >= *f && minute < *t)?;
    let base = now.date().and_hms_opt(hour, 0, 0)?;
    let mut start = base + Duration::minutes(from as i64);
    let mut end = base + Duration::minutes(to as i64);

    // 往前接：上一小时整段被选中（to == 60）才连得上
    let mut cursor = base;
    for _ in 0..24 {
        if start != cursor {
            break; // 当前段不是从整点开始的（09:15 那种），不再往前并
        }
        let prev = cursor - Duration::hours(1);
        let Ok(hm) = u32::try_from(prev.hour()) else { break };
        let Some(prev_wins) = crate::clock::plan_wins(cfg, prev.weekday().num_days_from_monday(), hm)
        else {
            break;
        };
        let Some((_, _, f, t)) = prev_wins.last() else { break };
        if *t != 60 {
            break; // 上一小时的窗口没顶到整点，说明中间有空隙
        }
        start = prev + Duration::minutes(*f as i64);
        cursor = prev;
    }

    // 往后接：这一小时顶到整点、下一小时从 0 分开始
    let mut cursor = end;
    for _ in 0..24 {
        if cursor != cursor.date().and_hms_opt(cursor.hour(), 0, 0).unwrap_or(cursor) {
            break;
        }
        let Ok(hm) = u32::try_from(cursor.hour()) else { break };
        let Some(next_wins) = crate::clock::plan_wins(cfg, cursor.weekday().num_days_from_monday(), hm)
        else {
            break;
        };
        let Some((_, _, f, t)) = next_wins.first() else { break };
        if *f != 0 {
            break;
        }
        let nxt_end = cursor + Duration::minutes(*t as i64);
        if nxt_end <= end {
            break;
        }
        end = nxt_end;
        cursor = nxt_end;
    }

    let label = format!("{}–{}", start.format("%H:%M"), end.format("%H:%M"));
    Some((start.timestamp(), end.timestamp(), label))
}

// ---------------------------------------------------------------- 增删改查

fn new_id(now: i64, taken: &[Item]) -> String {
    let mut n = 0;
    loop {
        let cand = format!("d{now}{n}");
        if !taken.iter().any(|x| x.id == cand) {
            return cand;
        }
        n += 1;
        if n > 999 {
            return format!("d{now}-{}", taken.len());
        }
    }
}

/// 加一条。返回加进去的条目（界面拿它做"已记下"的即时反馈）。
pub fn add(cfg: &Config, text: &str) -> Result<Item, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("写点什么再记下来".into());
    }
    if text.chars().count() > 500 {
        return Err("一条最多 500 个字".into());
    }
    let now = Local::now();
    let (seg_start, seg_end, seg_label) = match segment_bounds(cfg, now.naive_local()) {
        Some((a, b, l)) => (a, b, l),
        None => (0, 0, String::new()),
    };
    let mut st = load();
    let item = Item {
        id: new_id(now.timestamp(), &st.items),
        text: text.to_string(),
        at: now.timestamp(),
        day: now.format("%Y-%m-%d").to_string(),
        seg_start,
        seg_end,
        seg_label,
        done: false,
        done_at: 0,
        nudged_at: 0,
    };
    st.items.push(item.clone());
    prune(&mut st);
    save(&st)?;
    Ok(item)
}

/// 勾选 / 取消勾选
pub fn set_done(id: &str, done: bool) -> Result<bool, String> {
    let mut st = load();
    let mut hit = false;
    for it in st.items.iter_mut() {
        if it.id == id {
            it.done = done;
            it.done_at = if done { Local::now().timestamp() } else { 0 };
            // 处理掉之后不该再被提醒；取消勾选等于重新欠账，间隔从这一刻重新算
            it.nudged_at = if done { 0 } else { Local::now().timestamp() };
            hit = true;
        }
    }
    if hit {
        save(&st)?;
    }
    Ok(hit)
}

pub fn delete(id: &str) -> Result<bool, String> {
    let mut st = load();
    let before = st.items.len();
    st.items.retain(|x| x.id != id);
    if st.items.len() != before {
        save(&st)?;
        return Ok(true);
    }
    Ok(false)
}

/// 清掉某天的已完成条目（"今天都处理完了"的一键收尾）
pub fn clear_done(day: &str) -> Result<usize, String> {
    let mut st = load();
    let before = st.items.len();
    st.items.retain(|x| !(x.day == day && x.done));
    let n = before - st.items.len();
    if n > 0 {
        save(&st)?;
    }
    Ok(n)
}

/// 只丢最老的已完成条目，未完成的一条都不动
fn prune(st: &mut Store) {
    if st.items.len() <= MAX_ITEMS {
        return;
    }
    let over = st.items.len() - MAX_ITEMS;
    let mut removed = 0;
    let mut out = Vec::with_capacity(st.items.len());
    for it in st.items.drain(..) {
        if removed < over && it.done {
            removed += 1;
            continue;
        }
        out.push(it);
    }
    st.items = out;
}

// ---------------------------------------------------------------- 查询

/// 某天的条目（新→旧）与统计
pub fn day_of(st: &Store, day: &str) -> (Vec<Item>, usize, usize) {
    let mut list: Vec<Item> = st.items.iter().filter(|x| x.day == day).cloned().collect();
    list.sort_by(|a, b| b.at.cmp(&a.at));
    let done = list.iter().filter(|x| x.done).count();
    let total = list.len();
    (list, total, done)
}

/// 月份日历：`{"2026-11-01": {"total": 3, "done": 1}, ...}`
pub fn month_map(st: &Store, month: &str) -> Value {
    let mut m = serde_json::Map::new();
    for it in st.items.iter() {
        if !it.day.starts_with(month) {
            continue;
        }
        let e = m
            .entry(it.day.clone())
            .or_insert_with(|| json!({"total": 0, "done": 0}));
        if let Some(o) = e.as_object_mut() {
            let t = o.get("total").and_then(|x| x.as_i64()).unwrap_or(0) + 1;
            let d = o.get("done").and_then(|x| x.as_i64()).unwrap_or(0) + it.done as i64;
            o.insert("total".into(), json!(t));
            o.insert("done".into(), json!(d));
        }
    }
    Value::Object(m)
}

/// 该提醒哪些未完成项（间隔到点）。
///
/// 三条：
///  · 已完成的不要；
///  · 刚记下的不要（给用户先把这一段用完，别在专注当中又弹一次）；
///  · 间隔没到的不要 —— 间隔取 `settle`（记录后多久才开始催）与
///    `interval`（催过之后隔多久再催）里更严格的那个。
pub fn due_nudges(st: &Store, cfg: &Config, now: i64) -> Vec<Item> {
    let c = &cfg.settings.distract;
    if !c.enabled || c.remind_minutes <= 0 {
        return Vec::new();
    }
    let interval = c.remind_minutes * 60;
    let max_age = c.remind_max_days.max(1) * 86400;
    let mut out: Vec<Item> = st
        .items
        .iter()
        .filter(|x| !x.done)
        .filter(|x| now - x.at <= max_age)
        .filter(|x| {
            let last = if x.nudged_at > 0 { x.nudged_at } else { x.at };
            now - last >= interval
        })
        .cloned()
        .collect();
    out.sort_by(|a, b| a.at.cmp(&b.at));
    out
}

/// 标记"已提醒过"，避免同一批每 30 秒催一次
pub fn mark_nudged(ids: &[String], now: i64) {
    if ids.is_empty() {
        return;
    }
    let mut st = load();
    for it in st.items.iter_mut() {
        if ids.iter().any(|x| *x == it.id) {
            it.nudged_at = now;
        }
    }
    let _ = save(&st);
}

/// 刚结束的那一段里记下的、还没处理的条目。
///
/// 判据是"计划结束时刻贴近现在"（±3 分钟），不是"等于某个数"：
/// 后台循环 20 秒一拍、机器还可能睡过去一会儿，用一个精确值去比对必然对不上。
/// 休息段开始时 `focusing` 也会变 false，但那时段的结束时刻还在一两个小时后，
/// 自然就匹配不到，不会误报。
pub fn ended_segment_items(st: &Store, now: i64) -> Vec<Item> {
    st.items
        .iter()
        .filter(|x| !x.done && x.seg_end > 0 && (now - x.seg_end).abs() <= 180)
        .cloned()
        .collect()
}

// ---------------------------------------------------------------- 后台提醒

/// 上一次是不是"在专注"。段结束只在 true → false 的那一拍处理。
static WAS_FOCUS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 后台循环：段结束汇总 + 未完成项按间隔重提醒。
///
/// 为什么自己起线程而不塞进 monitor：这两件事都是"到点做一次"的低频任务，
/// 放进每秒跑的守护循环里既浪费，又容易被局部的 return 吞掉
/// （以前"结束提醒"就是这么静默失效的）。
pub fn start(app: tauri::AppHandle, shared: std::sync::Arc<Shared>) {
    std::thread::spawn(move || {
        // 第一拍先对齐一次，别一启动就报"时段结束了"
        {
            let cfg = shared.config();
            let on = crate::clock::state(&cfg).map(|s| s.focusing()).unwrap_or(false);
            WAS_FOCUS.store(on, std::sync::atomic::Ordering::Relaxed);
        }
        loop {
            std::thread::sleep(std::time::Duration::from_secs(20));
            let cfg = shared.config();
            let st = load();
            let now = Local::now().timestamp();
            let focusing = crate::clock::state(&cfg).map(|s| s.focusing()).unwrap_or(false);
            let was = WAS_FOCUS.swap(focusing, std::sync::atomic::Ordering::Relaxed);

            // —— 段结束：汇总这一段的收获 ——
            if was && !focusing && cfg.settings.distract.enabled {
                let items = ended_segment_items(&st, now);
                if !items.is_empty() {
                    let body = if items.len() == 1 {
                        format!("记下了 1 条：{}", clip(&items[0].text))
                    } else {
                        format!("记下了 {} 条想法，去「分心事件」逐条处理", items.len())
                    };
                    crate::notify::toast(&app, "app", "这一段结束了", &body, "分心事件", 8);
                    // 已经催过一次，重复提醒的间隔从现在开始算
                    mark_nudged(&items.iter().map(|x| x.id.clone()).collect::<Vec<_>>(), now);
                }
            }

            // —— 未完成项：按间隔再提醒 ——
            if cfg.settings.distract.enabled {
                let due = due_nudges(&st, &cfg, now);
                if !due.is_empty() {
                    let first = clip(&due[0].text);
                    let body = if due.len() == 1 {
                        format!("「{first}」还没处理")
                    } else {
                        format!("还有 {} 条没处理，最早一条：{first}", due.len())
                    };
                    crate::notify::toast(&app, "warn", "分心事件待处理", &body, "分心事件", 7);
                    mark_nudged(&due.iter().map(|x| x.id.clone()).collect::<Vec<_>>(), now);
                }
            }
        }
    });
}

fn clip(s: &str) -> String {
    let t: String = s.chars().take(18).collect();
    if s.chars().count() > 18 {
        format!("{t}…")
    } else {
        t
    }
}

// ---------------------------------------------------------------- 给界面用

/// 一天的视图数据：条目 + 按时段分组 + 统计
pub fn view_day(day: &str) -> Value {
    let st = load();
    let (list, total, done) = day_of(&st, day);
    let mut groups: Vec<(i64, String, Vec<Item>)> = Vec::new();
    for it in list.iter() {
        let key = it.seg_start;
        if let Some(g) = groups.iter_mut().find(|x| x.0 == key) {
            g.2.push(it.clone());
            continue;
        }
        let label = if it.seg_label.is_empty() {
            "不在自律时段内".to_string()
        } else {
            it.seg_label.clone()
        };
        groups.push((key, label, vec![it.clone()]));
    }
    groups.sort_by(|a, b| b.0.cmp(&a.0));
    json!({
        "day": day,
        "total": total,
        "done": done,
        "items": list,
        "groups": groups.iter().map(|(k, label, items)| json!({
            "segStart": k, "label": label, "items": items,
        })).collect::<Vec<_>>(),
        "month": month_map(&st, &day[..day.len().min(7)]),
    })
}

/// 日历用：本月每天的计数 + 未完成总数（页面顶部提示用）
pub fn view_month(month: &str) -> Value {
    let st = load();
    let pending = st.items.iter().filter(|x| !x.done).count();
    json!({
        "month": month,
        "days": month_map(&st, month),
        "pending": pending,
        "today": Local::now().format("%Y-%m-%d").to_string(),
    })
}

/// 今天的日期串（前端别自己算，避免机器时区和 Rust 侧不一致）
pub fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// 日期是否存在（防止前端传 `2026-13-99` 把界面画崩）
pub fn valid_day(s: &str) -> bool {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ClockProfile, HourPlan};

    fn cfg_with(hours: &[(usize, usize)]) -> Config {
        let mut c = Config::default();
        let mut p = ClockProfile::default();
        for (h, to) in hours {
            p.days[0][*h] = HourPlan {
                on: true,
                work: 50,
                brk: 10,
                from: 0,
                to: *to as u32,
                seg: "s".into(),
                wins: vec![],
            };
        }
        c.settings.focus_clock.enabled = true;
        c.settings.focus_clock.profiles = vec![p];
        c.settings.focus_clock.active = c.settings.focus_clock.profiles[0].id.clone();
        c
    }

    #[test]
    fn three_hours_merge_into_one_segment() {
        let c = cfg_with(&[(9, 60), (10, 60), (11, 60)]);
        // 2026-11-02 是周一（weekday 0）
        let now = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap().and_hms_opt(10, 20, 0).unwrap();
        let (s, e, label) = segment_bounds(&c, now).expect("10:20 在时段里");
        assert_eq!(label, "09:00–12:00");
        assert_eq!(e - s, 3 * 3600, "三段要连成一段");
    }

    #[test]
    fn gap_breaks_the_segment() {
        let c = cfg_with(&[(9, 60), (11, 60)]);
        let now = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap().and_hms_opt(11, 30, 0).unwrap();
        let (s, e, label) = segment_bounds(&c, now).expect("11:30 在时段里");
        assert_eq!(label, "11:00–12:00");
        assert_eq!(e - s, 3600, "10 点没选，不能把两段并起来");
    }

    #[test]
    fn partial_hour_stays_its_own_segment() {
        let c = cfg_with(&[(9, 45)]);
        let now = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap().and_hms_opt(9, 20, 0).unwrap();
        let (s, e, label) = segment_bounds(&c, now).expect("9:20 在 9:00–9:45 内");
        assert_eq!(label, "09:00–09:45");
        assert_eq!(e - s, 45 * 60);
    }

    #[test]
    fn outside_hours_has_no_segment() {
        let c = cfg_with(&[(9, 60)]);
        let now = NaiveDate::from_ymd_opt(2026, 11, 2).unwrap().and_hms_opt(13, 0, 0).unwrap();
        assert!(segment_bounds(&c, now).is_none());
    }

    fn it(id: &str, at: i64, done: bool) -> Item {
        Item {
            id: id.into(),
            text: format!("想法 {id}"),
            at,
            day: "2026-11-02".into(),
            seg_start: 0,
            seg_end: 0,
            seg_label: String::new(),
            done,
            done_at: 0,
            nudged_at: 0,
        }
    }

    #[test]
    fn day_view_splits_done_and_total() {
        let st = Store {
            schema: 1,
            items: vec![it("a", 1, false), it("b", 2, true), it("c", 3, false)],
        };
        let (list, total, done) = day_of(&st, "2026-11-02");
        assert_eq!((total, done), (3, 1));
        assert_eq!(list[0].id, "c", "新的排前面");
        let (other, t2, _) = day_of(&st, "2026-11-03");
        assert!(other.is_empty() && t2 == 0);
    }

    #[test]
    fn month_map_counts_per_day() {
        let mut b = it("b", 2, true);
        b.day = "2026-11-03".into();
        let st = Store { schema: 1, items: vec![it("a", 1, false), b] };
        let m = month_map(&st, "2026-11");
        assert_eq!(m["2026-11-02"]["total"], 1);
        assert_eq!(m["2026-11-02"]["done"], 0);
        assert_eq!(m["2026-11-03"]["done"], 1);
        assert!(month_map(&st, "2026-12").as_object().unwrap().is_empty());
    }

    #[test]
    fn nudges_respect_interval_and_done_flag() {
        let mut c = Config::default();
        c.settings.distract.enabled = true;
        c.settings.distract.remind_minutes = 60;
        c.settings.distract.remind_max_days = 7;
        let now = 1_000_000;
        let st = Store {
            schema: 1,
            items: vec![
                it("old", now - 7200, false),   // 两小时前：该催了
                it("fresh", now - 60, false),   // 一分钟前：别催
                it("done", now - 7200, true),   // 已处理：不催
            ],
        };
        let due = due_nudges(&st, &c, now);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "old");

        // 催过一次之后，间隔没到就不再催
        let mut st2 = st.clone();
        st2.items[0].nudged_at = now - 60;
        assert!(due_nudges(&st2, &c, now).is_empty());

        // 关掉模块 → 一条都不催
        c.settings.distract.enabled = false;
        assert!(due_nudges(&st, &c, now).is_empty());
    }

    #[test]
    fn stale_items_stop_nagging() {
        let mut c = Config::default();
        c.settings.distract.remind_minutes = 60;
        c.settings.distract.remind_max_days = 1;
        let now = 10 * 86400;
        let st = Store { schema: 1, items: vec![it("ancient", 0, false)] };
        assert!(due_nudges(&st, &c, now).is_empty(), "超过上限天数就别再催了");
    }

    #[test]
    fn prune_only_drops_done_items() {
        let mut items: Vec<Item> = (0..MAX_ITEMS + 10)
            .map(|i| it(&format!("i{i}"), i as i64, i % 2 == 0))
            .collect();
        items.push(it("pending", 9_999, false));
        let mut st = Store { schema: 1, items };
        prune(&mut st);
        assert!(st.items.len() <= MAX_ITEMS);
        assert!(
            st.items.iter().any(|x| x.id == "pending"),
            "未完成的一条都不能丢"
        );
    }
}
