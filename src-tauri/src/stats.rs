//! 使用时长统计
//!
//! 采集：前台窗口归属。每秒采样一次，把 1 秒记到「当前前台应用」或「当前浏览器标签页域名」上。
//! 粒度：日文件内按小时（0-23）分桶，最小可查到"某天某小时"。
//! 双轨：自律模式开启 / 未开启 两套 BTreeMap，完全独立，互不混合。

use crate::cfg;
use crate::model::Config;
use crate::proc;
use crate::shared::Shared;
use chrono::{Datelike, Duration as CDur, Local, NaiveDate, Timelike};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration as StdDuration;

type Hwnd = *mut core::ffi::c_void;

#[repr(C)]
struct LastInputInfo {
    cb: u32,
    dw: u32,
}

#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> Hwnd;
    fn GetWindowThreadProcessId(h: Hwnd, pid: *mut u32) -> u32;
    fn GetLastInputInfo(li: *mut LastInputInfo) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetTickCount() -> u32;
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Acc {
    pub label: String,
    /// app | site
    pub category: String,
    pub secs: u64,
    /// 24 个小时桶
    pub hours: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DayFile {
    pub date: String,
    pub on: BTreeMap<String, Acc>,
    pub off: BTreeMap<String, Acc>,
}

impl DayFile {
    pub fn new(date: String) -> Self {
        DayFile {
            date,
            on: BTreeMap::new(),
            off: BTreeMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Slice {
    pub key: String,
    pub label: String,
    pub category: String,
    pub secs: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Report {
    pub id: String,
    pub period: String,
    pub title: String,
    pub start: String,
    pub end: String,
    pub created: i64,
    pub on_secs: u64,
    pub off_secs: u64,
    pub on: Vec<Slice>,
    pub off: Vec<Slice>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct SchedState {
    daily: String,
    weekly: String,
    monthly: String,
    yearly: String,
    custom: String,
}

pub fn stats_dir() -> PathBuf {
    let p = cfg::data_dir().join("stats");
    let _ = std::fs::create_dir_all(p.join("days"));
    let _ = std::fs::create_dir_all(p.join("reports"));
    p
}

fn day_path(date: &str) -> PathBuf {
    stats_dir().join("days").join(format!("{date}.json"))
}

fn load_day(date: &str) -> DayFile {
    match std::fs::read_to_string(day_path(date)) {
        Ok(s) => serde_json::from_str::<DayFile>(&s).unwrap_or_else(|_| DayFile::new(date.into())),
        Err(_) => DayFile::new(date.into()),
    }
}

fn save_day(df: &DayFile) -> Result<(), String> {
    if df.date.is_empty() {
        return Ok(());
    }
    let p = day_path(&df.date);
    let tmp = p.with_extension("json.tmp");
    let s = serde_json::to_string(df).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, s).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

pub fn domain_of(url: &str) -> String {
    let s = url.split("://").last().unwrap_or(url);
    let host = s.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    host.trim_start_matches("www.").to_lowercase()
}

fn idle_secs() -> u32 {
    unsafe {
        let mut li = LastInputInfo {
            cb: std::mem::size_of::<LastInputInfo>() as u32,
            dw: 0,
        };
        if GetLastInputInfo(&mut li) == 0 {
            return 0;
        }
        GetTickCount().wrapping_sub(li.dw) / 1000
    }
}

/// 秒表线程：每秒采样一次 + 每 15 秒落盘
pub fn start(shared: Arc<Shared>) {
    {
        let today = Local::now().format("%Y-%m-%d").to_string();
        if let Ok(mut cur) = shared.stats.lock() {
            *cur = load_day(&today);
        }
    }

    let sh = shared.clone();
    thread::spawn(move || {
        let mut ticks: u32 = 0;
        loop {
            let cfg = sh.config();
            if cfg.settings.stats.enabled {
                sample(&sh, &cfg);
            }
            ticks += 1;
            if ticks % 15 == 0 {
                flush(&sh);
            }
            thread::sleep(StdDuration::from_millis(1000));
        }
    });

    let sh2 = shared.clone();
    thread::spawn(move || {
        // 启动时先清理一次过期数据，然后每 30 秒检查一次报告时机
        prune(&sh2.config());
        loop {
            run_due(&sh2);
            thread::sleep(StdDuration::from_secs(30));
        }
    });
}

fn sample(shared: &Shared, cfg: &Config) {
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();

    // 跨天轮转
    {
        if let Ok(mut cur) = shared.stats.lock() {
            if cur.date != today {
                if !cur.date.is_empty() {
                    let _ = save_day(&cur);
                }
                *cur = DayFile::new(today.clone());
                shared.stats_dirty.store(false, Ordering::Relaxed);
            }
        }
    }

    if !cfg.settings.stats.count_idle && idle_secs() >= 60 {
        return;
    }

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() {
        return;
    }
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, &mut pid);
    }
    if pid == 0 {
        return;
    }

    let path = proc::exe_path(pid);
    let name = if path.is_empty() {
        String::new()
    } else {
        proc::stem(&path)
    };

    let mut key = String::new();
    let mut label = String::new();
    let mut category = String::from("app");

    // 浏览器且扩展刚上报过标签页 → 记到具体域名上
    if crate::matcher::BROWSERS.iter().any(|b| name.contains(b)) {
        let (url, ts) = match shared.rt.lock() {
            Ok(rt) => (rt.site_url.clone(), rt.site_ts),
            Err(_) => (String::new(), 0),
        };
        if !url.is_empty() && now.timestamp() - ts <= 300 {
            let d = domain_of(&url);
            if !d.is_empty() && d.contains('.') {
                key = format!("site|{d}");
                label = d;
                category = "site".to_string();
            }
        }
    }

    if key.is_empty() {
        let ident = if path.is_empty() { name.clone() } else { path.clone() };
        if ident.is_empty() {
            return;
        }
        key = format!("app|{}", ident.to_lowercase());
        label = if name.is_empty() { ident } else { name };
    }

    let state_on = shared
        .rt
        .lock()
        .map(|rt| !rt.active.is_empty())
        .unwrap_or(false);
    let hour = now.hour() as usize;

    if let Ok(mut cur) = shared.stats.lock() {
        let map = if state_on { &mut cur.on } else { &mut cur.off };
        let e = map.entry(key).or_insert_with(|| Acc {
            label: label.clone(),
            category: category.clone(),
            secs: 0,
            hours: vec![0; 24],
        });
        e.secs += 1;
        if e.hours.len() < 24 {
            e.hours.resize(24, 0);
        }
        e.hours[hour] += 1;
    }
    shared.stats_dirty.store(true, Ordering::Relaxed);
}

/// 切换数据目录后把"今天"的累计重新读进内存
pub fn reload_today(shared: &Shared) {
    let d = chrono::Local::now().format("%Y-%m-%d").to_string();
    let f = load_day(&d);
    if let Ok(mut g) = shared.stats.lock() {
        *g = f;
    }
    shared.stats_dirty.store(false, Ordering::Relaxed);
}

pub fn flush(shared: &Shared) {
    if !shared.stats_dirty.swap(false, Ordering::Relaxed) {
        return;
    }
    let snapshot = match shared.stats.lock() {
        Ok(c) => c.clone(),
        Err(_) => return,
    };
    if save_day(&snapshot).is_err() {
        shared.stats_dirty.store(true, Ordering::Relaxed);
    }
}

fn merge(dst: &mut BTreeMap<String, Slice>, src: &BTreeMap<String, Acc>) {
    for (k, v) in src.iter() {
        let e = dst.entry(k.clone()).or_insert_with(|| Slice {
            key: k.clone(),
            label: v.label.clone(),
            category: v.category.clone(),
            secs: 0,
        });
        e.secs += v.secs;
    }
}

pub struct Agg {
    pub on: Vec<Slice>,
    pub off: Vec<Slice>,
    pub on_hourly: [u64; 24],
    pub off_hourly: [u64; 24],
}

pub fn aggregate(shared: &Shared, start: &str, end: &str) -> Agg {
    let mut on: BTreeMap<String, Slice> = BTreeMap::new();
    let mut off: BTreeMap<String, Slice> = BTreeMap::new();
    let mut on_hourly = [0u64; 24];
    let mut off_hourly = [0u64; 24];

    let live = shared.stats.lock().map(|c| c.clone()).unwrap_or_default();

    if let (Ok(s), Ok(e)) = (start.parse::<NaiveDate>(), end.parse::<NaiveDate>()) {
        let mut cur = s;
        while cur <= e {
            let ds = cur.format("%Y-%m-%d").to_string();
            let file = if ds == live.date {
                live.clone()
            } else {
                load_day(&ds)
            };
            merge(&mut on, &file.on);
            merge(&mut off, &file.off);
            for acc in file.on.values() {
                for (i, v) in acc.hours.iter().take(24).enumerate() {
                    on_hourly[i] += *v as u64;
                }
            }
            for acc in file.off.values() {
                for (i, v) in acc.hours.iter().take(24).enumerate() {
                    off_hourly[i] += *v as u64;
                }
            }
            cur = match cur.succ_opt() {
                Some(x) => x,
                None => break,
            };
        }
    }

    let mut on: Vec<Slice> = on.into_values().collect();
    let mut off: Vec<Slice> = off.into_values().collect();
    on.sort_by(|a, b| b.secs.cmp(&a.secs));
    off.sort_by(|a, b| b.secs.cmp(&a.secs));
    Agg {
        on,
        off,
        on_hourly,
        off_hourly,
    }
}

fn title_for(period: &str, start: &str, end: &str) -> String {
    match period {
        "daily" => format!("{start} 日报"),
        "weekly" => format!("{start} ~ {end} 周报"),
        "monthly" => format!("{} 月报", &start[..7]),
        "yearly" => format!("{} 年报", &start[..4]),
        _ => format!("{start} ~ {end} 自定义报告"),
    }
}

pub fn generate(shared: &Shared, period: &str, start: &str, end: &str) -> Result<Report, String> {
    let agg = aggregate(shared, start, end);
    let on_secs = agg.on.iter().map(|s| s.secs).sum();
    let off_secs = agg.off.iter().map(|s| s.secs).sum();
    let id = format!("{period}_{start}_{end}");
    let mut on = agg.on;
    let mut off = agg.off;
    on.truncate(60);
    off.truncate(60);
    let r = Report {
        id: id.clone(),
        period: period.to_string(),
        title: title_for(period, start, end),
        start: start.to_string(),
        end: end.to_string(),
        created: Local::now().timestamp(),
        on_secs,
        off_secs,
        on,
        off,
    };
    let p = stats_dir().join("reports").join(format!("{id}.json"));
    let s = serde_json::to_string_pretty(&r).map_err(|e| e.to_string())?;
    std::fs::write(&p, s).map_err(|e| format!("写入报告失败: {e}"))?;
    Ok(r)
}

pub fn list_reports() -> Vec<serde_json::Value> {
    let dir = stats_dir().join("reports");
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Ok(s) = std::fs::read_to_string(&p) {
                if let Ok(r) = serde_json::from_str::<Report>(&s) {
                    out.push(serde_json::json!({
                        "id": r.id,
                        "period": r.period,
                        "title": r.title,
                        "start": r.start,
                        "end": r.end,
                        "created": r.created,
                        "onSecs": r.on_secs,
                        "offSecs": r.off_secs,
                    }));
                }
            }
        }
    }
    out.sort_by(|a, b| {
        b["created"].as_i64().unwrap_or(0).cmp(&a["created"].as_i64().unwrap_or(0))
    });
    out
}

pub fn read_report(id: &str) -> Option<Report> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return None;
    }
    let p = stats_dir().join("reports").join(format!("{safe}.json"));
    let s = std::fs::read_to_string(p).ok()?;
    serde_json::from_str::<Report>(&s).ok()
}

pub fn delete_report(id: &str) -> Result<(), String> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return Err("非法的报告 ID".into());
    }
    let p = stats_dir().join("reports").join(format!("{safe}.json"));
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

fn sched_path() -> PathBuf {
    stats_dir().join("sched.json")
}

fn load_sched() -> SchedState {
    std::fs::read_to_string(sched_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_sched(s: &SchedState) {
    if let Ok(t) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(sched_path(), t);
    }
}

fn prune(cfg: &Config) {
    let keep = cfg.settings.stats.retention_days.max(30) as i64;
    let cutoff = Local::now().date_naive() - CDur::days(keep);
    let cutoff_str = cutoff.format("%Y-%m-%d").to_string();

    if let Ok(rd) = std::fs::read_dir(stats_dir().join("days")) {
        for e in rd.flatten() {
            let p = e.path();
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                if stem.len() == 10 && stem < cutoff_str.as_str() {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(stats_dir().join("reports")) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Ok(s) = std::fs::read_to_string(&p) {
                if let Ok(r) = serde_json::from_str::<Report>(&s) {
                    let created = chrono::DateTime::from_timestamp(r.created, 0)
                        .map(|d| d.with_timezone(&Local).date_naive());
                    if let Some(c) = created {
                        if c < cutoff {
                            let _ = std::fs::remove_file(&p);
                        }
                    }
                }
            }
        }
    }
}

/// 到期自动生成报告（应用没开也会在下次启动时补上）
fn run_due(shared: &Shared) {
    let cfg = shared.config();
    let st = &cfg.settings.stats;
    if !st.enabled {
        return;
    }
    let mut s = load_sched();
    let mut changed = false;
    let today = Local::now().date_naive();

    if st.auto_daily {
        let y = today - CDur::days(1);
        let key = y.format("%Y-%m-%d").to_string();
        if s.daily != key {
            let _ = generate(shared, "daily", &key, &key);
            s.daily = key;
            changed = true;
        }
    }
    if st.auto_weekly {
        let monday = today - CDur::days(today.weekday().num_days_from_monday() as i64);
        let pm = monday - CDur::days(7);
        let ps = pm + CDur::days(6);
        let key = pm.format("%Y-%m-%d").to_string();
        if s.weekly != key {
            let _ = generate(
                shared,
                "weekly",
                &key,
                &ps.format("%Y-%m-%d").to_string(),
            );
            s.weekly = key;
            changed = true;
        }
    }
    if st.auto_monthly {
        let first = today.with_day(1).unwrap_or(today);
        let pend = first - CDur::days(1);
        let pstart = pend.with_day(1).unwrap_or(pend);
        let key = pstart.format("%Y-%m").to_string();
        if s.monthly != key {
            let _ = generate(
                shared,
                "monthly",
                &pstart.format("%Y-%m-%d").to_string(),
                &pend.format("%Y-%m-%d").to_string(),
            );
            s.monthly = key;
            changed = true;
        }
    }
    if st.auto_yearly {
        let y = today.year() - 1;
        let key = format!("{y}");
        if s.yearly != key {
            let _ = generate(shared, "yearly", &format!("{y}-01-01"), &format!("{y}-12-31"));
            s.yearly = key;
            changed = true;
        }
    }
    if st.custom_days > 0 {
        let n = st.custom_days as i64;
        let anchor = if st.custom_anchor.is_empty() {
            today
        } else {
            st.custom_anchor.parse::<NaiveDate>().unwrap_or(today)
        };
        let elapsed = (today - anchor).num_days();
        let done = elapsed / n;
        if done >= 1 {
            let ws = anchor + CDur::days((done - 1) * n);
            let we = ws + CDur::days(n - 1);
            let key = we.format("%Y-%m-%d").to_string();
            if s.custom != key {
                let _ = generate(
                    shared,
                    "custom",
                    &ws.format("%Y-%m-%d").to_string(),
                    &we.format("%Y-%m-%d").to_string(),
                );
                s.custom = key;
                changed = true;
            }
        }
    }

    if changed {
        save_sched(&s);
    }
}
