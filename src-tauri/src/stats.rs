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
    /// 同一个域名下出现过的**页面标题**及各自秒数。
    ///
    /// 为什么要单独存：一个域名（b23.tv、github.com）下面可能是几十个不同标题的页面，
    /// 只留最后一次看到的标题会让统计页的"名字"随采样时机乱跳。
    /// 这里按标题累计，聚合时取最大的那个当主标题，同时能说出"共 N 个页面"。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub titles: BTreeMap<String, u64>,
    /// 这条站点是用哪些浏览器打开的（浏览器显示名 → 秒数）。
    ///
    /// 为什么需要：同一个域名可能今天用 Chrome 看、明天用 Edge 看，
    /// 统计页只说"bilibili.com"就丢了"我平时用哪个浏览器"这个信息。
    /// 按浏览器累计，聚合时取最大的那个当主浏览器，界面上写成「标题（Chrome）」。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub browsers: BTreeMap<String, u64>,
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
    /// 界面直接显示的名字：软件 = 友好名，网址 = 主标题（没有标题才退回域名）
    pub label: String,
    pub category: String,
    pub secs: u64,
    /// 网站的主标题（占时最长的那一个）
    #[serde(default)]
    pub title: String,
    /// 这个域名下一共出现过多少个不同标题（>1 时界面会写"共 N 个页面"）
    #[serde(default)]
    pub pages: u32,
    /// 打开这个站点用得最多的浏览器（空 = 不知道，界面就不加括号）
    #[serde(default)]
    pub browser: String,
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
    // 站点标题：只在"浏览器 + 扩展刚上报"那一支里赋值，后面记录到 titles 里
    let mut site_title = String::new();
    // 站点用哪个浏览器打开的（写进 Acc.browsers，聚合时选主浏览器）
    let mut browser_name = String::new();

    // 浏览器且扩展刚上报过标签页 → 记到具体域名上
    if crate::matcher::BROWSERS.iter().any(|b| name.contains(b)) {
        let (url, ts, title) = match shared.rt.lock() {
            Ok(rt) => (rt.site_url.clone(), rt.site_ts, rt.site_title.clone()),
            Err(_) => (String::new(), 0, String::new()),
        };
        if !url.is_empty() && now.timestamp() - ts <= 300 {
            let d = domain_of(&url);
            if !d.is_empty() && d.contains('.') {
                key = format!("site|{d}");
                // label 先放域名：它才是"聚合口径"。
                // 真正的展示名在 aggregate 里换成主标题（见 finalize_labels），
                // 因为一个域名下会有很多标题，必须按全区间累计之后再选。
                label = d;
                category = "site".to_string();
                site_title = title.clone();
                browser_name = crate::appname::display(&path, &name);
            }
        }
    }

    if key.is_empty() {
        let ident = if path.is_empty() { name.clone() } else { path.clone() };
        if ident.is_empty() {
            return;
        }
        key = format!("app|{}", ident.to_lowercase());
        // 文件名（chrome / Code / msedge）不是"软件名"，读版本信息里的 FileDescription
        label = if path.is_empty() {
            crate::appname::display("", &name)
        } else {
            crate::appname::display(&path, &name)
        };
    }

    // 「自律模式是否开启」必须和其它模块同一个口径：
    // 规则生效 / 自律时段专注 / 固化锁定，三者任一成立都算。
    // 早期这里只判断 rt.active，导致"只用自律时段、没配规则"时
    // 明明在专注，时长却全被记到 off 那一档。
    let state_on = shared
        .rt
        .lock()
        .map(|rt| !rt.active.is_empty() || rt.clock_on || rt.locked)
        .unwrap_or(false);
    let hour = now.hour() as usize;

    if let Ok(mut cur) = shared.stats.lock() {
        let map = if state_on { &mut cur.on } else { &mut cur.off };
        let e = map.entry(key).or_insert_with(|| Acc {
            label: label.clone(),
            category: category.clone(),
            secs: 0,
            hours: vec![0; 24],
            titles: BTreeMap::new(),
            browsers: BTreeMap::new(),
        });
        e.secs += 1;
        if e.hours.len() < 24 {
            e.hours.resize(24, 0);
        }
        e.hours[hour] += 1;
        // 站点：按标题累计，"同一网址多个标题"最后由聚合层归并成一行
        if e.category == "site" {
            let t = site_title.trim();
            if !t.is_empty() {
                *e.titles.entry(t.to_string()).or_insert(0) += 1;
            }
            if !browser_name.is_empty() {
                *e.browsers.entry(browser_name.clone()).or_insert(0) += 1;
            }
        }
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

fn merge(
    dst: &mut BTreeMap<String, Slice>,
    src: &BTreeMap<String, Acc>,
    titles: &mut BTreeMap<String, BTreeMap<String, u64>>,
    browsers: &mut BTreeMap<String, BTreeMap<String, u64>>,
) {
    for (k, v) in src.iter() {
        let e = dst.entry(k.clone()).or_insert_with(|| Slice {
            key: k.clone(),
            label: v.label.clone(),
            category: v.category.clone(),
            secs: 0,
            title: String::new(),
            pages: 0,
            browser: String::new(),
        });
        e.secs += v.secs;
        if !v.titles.is_empty() {
            let slot = titles.entry(k.clone()).or_default();
            for (t, n) in v.titles.iter() {
                *slot.entry(t.clone()).or_insert(0) += *n;
            }
        }
        if !v.browsers.is_empty() {
            let slot = browsers.entry(k.clone()).or_default();
            for (b, n) in v.browsers.iter() {
                *slot.entry(b.clone()).or_insert(0) += *n;
            }
        }
    }
}

/// 把"同一域名下的多个标题"归并成一行：
///   · 主标题 = 累计时长最长的那一个（比"最后一次看到的"稳定得多）
///   · pages  = 不同标题数，界面用它提示"共 N 个页面"
///   · label  = 主标题（没有标题才退回域名）
fn finalize_labels(
    slices: &mut [Slice],
    titles: &BTreeMap<String, BTreeMap<String, u64>>,
    browsers: &BTreeMap<String, BTreeMap<String, u64>>,
) {
    for s in slices.iter_mut() {
        // 主浏览器：这个域名累计用得最久的那个（和主标题同一套口径）
        if let Some(b) = browsers.get(&s.key) {
            if let Some((name, _)) = b.iter().max_by_key(|(_, n)| **n) {
                s.browser = name.clone();
            }
        }
        let Some(m) = titles.get(&s.key) else { continue };
        s.pages = m.len() as u32;
        if let Some((best, _)) = m.iter().max_by_key(|(_, n)| **n) {
            s.title = best.clone();
            if s.category == "site" {
                s.label = best.clone();
            }
        }
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
    let mut titles: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut browsers: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
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
            merge(&mut on, &file.on, &mut titles, &mut browsers);
            merge(&mut off, &file.off, &mut titles, &mut browsers);
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
    finalize_labels(&mut on, &titles, &browsers);
    finalize_labels(&mut off, &titles, &browsers);
    on.sort_by(|a, b| b.secs.cmp(&a.secs));
    off.sort_by(|a, b| b.secs.cmp(&a.secs));
    Agg {
        on,
        off,
        on_hourly,
        off_hourly,
    }
}

/// 取字符串前 n 个**字符**（不是字节）。
///
/// 这里以前写的是 `&start[..7]`，只要传进来的日期短于 7 个字节（比如
/// 经 IPC 传了个 "2026"），就会因为"切在字符边界外"直接 panic，
/// 把处理命令的那条线程打挂。标题这种纯展示逻辑不该有这种风险。
fn prefix(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn title_for(period: &str, start: &str, end: &str) -> String {
    match period {
        "daily" => format!("{start} 日报"),
        "weekly" => format!("{start} ~ {end} 周报"),
        "monthly" => format!("{} 月报", prefix(start, 7)),
        "yearly" => format!("{} 年报", prefix(start, 4)),
        _ => format!("{start} ~ {end} 自定义报告"),
    }
}

/// 校验统计区间：起止都不能为空，也不能倒序。
/// 抽出来是为了能单测（`generate` 还需要真实配置）。
fn check_range(start: &str, end: &str) -> Result<(), String> {
    if start.trim().is_empty() || end.trim().is_empty() {
        return Err("统计区间不完整，无法生成报告".into());
    }
    if start > end {
        return Err("统计区间的开始日期晚于结束日期".into());
    }
    Ok(())
}

pub fn generate(shared: &Shared, period: &str, start: &str, end: &str) -> Result<Report, String> {
    // 起止日期是拼文件名和标题的一部分，空值/倒序都直接拒绝：
    // 否则会生成一个 id 里带空串的怪文件，之后列表里看起来像"无名报告"。
    check_range(start, end)?;
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

/// 报告 id → 文件路径。
///
/// id 来自前端，必须过滤：只允许字母/数字/`-`/`_`，
/// 否则 `../config` 这种就能穿出 reports 目录（三处调用以前各写一遍，容易漏）。
fn report_path(id: &str) -> Option<PathBuf> {
    let safe: String = id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if safe.is_empty() {
        return None;
    }
    Some(stats_dir().join("reports").join(format!("{safe}.json")))
}

pub fn read_report(id: &str) -> Option<Report> {
    let p = report_path(id)?;
    let s = std::fs::read_to_string(p).ok()?;
    serde_json::from_str::<Report>(&s).ok()
}

/// 删除一份报告。
///
/// 文件已经不在时返回 Ok：用户点删除的目的一定是"让它消失"，
/// 目标状态已经达成，再报"删除失败"只会让人以为出了问题。
pub fn delete_report(id: &str) -> Result<(), String> {
    let p = report_path(id).ok_or_else(|| "报告 ID 非法".to_string())?;
    match std::fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除失败：{e}")),
    }
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

#[cfg(test)]
mod tests {
    /// 同一域名下的多个标题要归并成一行：主标题取累计最久的，pages 报总数
    #[test]
    fn titles_merge_into_one_row() {
        let mut slices = vec![Slice {
            key: "site|b23.tv".into(),
            label: "b23.tv".into(),
            category: "site".into(),
            secs: 300,
            title: String::new(),
            pages: 0,
            browser: String::new(),
        }];
        let mut m = std::collections::BTreeMap::new();
        m.insert("【教程】十分钟看懂 Rust".to_string(), 200u64);
        m.insert("某个视频".to_string(), 60u64);
        m.insert("另一个视频".to_string(), 40u64);
        let mut titles = std::collections::BTreeMap::new();
        titles.insert("site|b23.tv".to_string(), m);

        finalize_labels(&mut slices, &titles, &std::collections::BTreeMap::new());
        assert_eq!(slices.len(), 1, "同一域名只能有一行");
        assert_eq!(slices[0].label, "【教程】十分钟看懂 Rust");
        assert_eq!(slices[0].title, "【教程】十分钟看懂 Rust");
        assert_eq!(slices[0].pages, 3);
    }

    /// 没有标题时（老数据 / 扩展没报）退回域名，不能变成空名字
    #[test]
    fn site_without_title_keeps_domain() {
        let mut slices = vec![Slice {
            key: "site|example.com".into(),
            label: "example.com".into(),
            category: "site".into(),
            secs: 10,
            title: String::new(),
            pages: 0,
            browser: String::new(),
        }];
        finalize_labels(&mut slices, &std::collections::BTreeMap::new(), &std::collections::BTreeMap::new());
        assert_eq!(slices[0].label, "example.com");
        assert_eq!(slices[0].pages, 0);
    }

    /// 软件的 label 不受 title 影响（软件没有"标题"这个概念）
    #[test]
    fn app_label_is_not_overwritten() {
        let mut slices = vec![Slice {
            key: "app|c:\\x\\chrome.exe".into(),
            label: "Google Chrome".into(),
            category: "app".into(),
            secs: 99,
            title: String::new(),
            pages: 0,
            browser: String::new(),
        }];
        let mut m = std::collections::BTreeMap::new();
        m.insert("不该出现在软件行里".to_string(), 1u64);
        let mut titles = std::collections::BTreeMap::new();
        titles.insert("app|c:\\x\\chrome.exe".to_string(), m);
        finalize_labels(&mut slices, &titles, &std::collections::BTreeMap::new());
        assert_eq!(slices[0].label, "Google Chrome");
    }

    /// 老数据（没有 titles 字段）必须还能读，否则升级后历史全丢
    #[test]
    fn old_day_file_still_parses() {
        // 路径里不放反斜杠：这里只关心"字段缺失能不能读"，别把 JSON 转义也搅进来
        let raw = r#"{"on":{"app|c:/a.exe":{"label":"a","category":"app","secs":5,"hours":[1]}},"off":{}}"#;
        let f: DayFile = serde_json::from_str(raw).expect("老格式要能读");
        assert_eq!(f.on.len(), 1);
        assert!(f.on.values().next().unwrap().titles.is_empty());
    }

    /// 新数据写出再读回来，titles 不能丢
    #[test]
    fn titles_round_trip() {
        let mut f = DayFile::new("2026-10-29".into());
        let mut acc = Acc { label: "d".into(), category: "site".into(), secs: 9, hours: vec![0; 24], titles: Default::default(), browsers: Default::default() };
        acc.titles.insert("T".into(), 9);
        f.on.insert("site|d.com".into(), acc);
        let raw = serde_json::to_string(&f).unwrap();
        let back: DayFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.on["site|d.com"].titles["T"], 9);
    }

    use super::*;

    /// 标题生成不能因为日期字符串短一点就 panic。
    /// 这是 IPC 边界上的输入，长度不受我们控制。
    #[test]
    fn title_handles_short_dates() {
        assert_eq!(title_for("monthly", "2026", "2026"), "2026 月报");
        assert_eq!(title_for("yearly", "20", "20"), "20 年报");
        assert_eq!(title_for("monthly", "", ""), " 月报");
        // 正常长度仍然是完整前缀
        assert_eq!(title_for("monthly", "2026-10-01", "2026-10-31"), "2026-10 月报");
        assert_eq!(title_for("yearly", "2026-01-01", "2026-12-31"), "2026 年报");
    }

    #[test]
    fn report_path_rejects_traversal() {
        assert!(report_path("").is_none());
        assert!(report_path("../../config").is_some()); // 会被过滤成 "config"
        let p = report_path("../../config").unwrap();
        assert!(p.starts_with(stats_dir().join("reports")), "不能穿出 reports 目录");
        assert!(!p.to_string_lossy().contains(".."));
    }

    #[test]
    fn generate_rejects_bad_range() {
        // 只看参数校验这一层，不碰 aggregate（那需要真实配置与数据目录）
        assert!(check_range("", "2026-10-27").is_err());
        assert!(check_range("2026-10-27", "").is_err());
        assert!(check_range("  ", "2026-10-27").is_err());
        assert!(check_range("2026-10-28", "2026-10-27").is_err());
        assert!(check_range("2026-10-27", "2026-10-27").is_ok());
    }
}
