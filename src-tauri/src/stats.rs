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
use std::sync::{Arc, Mutex};
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

/// 一段**连续使用**：当天的分钟数（0..1440，`t` 不含）。
///
/// 为什么还需要它：小时桶只回答"这一小时用了多久"，回答不了
/// "几点到几点在用"——同一小时里先后用了两个软件，桶里看不出先后。
/// 明细面板要的就是这个：`09:12–10:05`、`14:20–14:58` 这样一段一段。
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub f: u16,
    pub t: u16,
}

impl Span {
    fn mins(&self) -> u16 {
        self.t.saturating_sub(self.f)
    }
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
    /// 这一天里**连续使用**的时间段（按分钟）。未用过的 key 不会出现。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spans: Vec<Span>,
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
    /// 最长的若干段"连续使用"，带日期。前端点开某一项时列出来。
    ///
    /// 只留前 `SPAN_KEEP` 段：跨年聚合时会攒出上万段，全给前端既慢又没人看。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spans: Vec<Slot>,
    /// 裁剪**之前**一共有多少段。
    ///
    /// 界面要如实写"共 N 段"：只数 `spans.len()` 会把被裁掉的也算成不存在，
    /// 用户看到的就是"明细不全"却不知道是数据被裁了。
    #[serde(default)]
    pub span_count: u32,
}

/// 带日期的一段连续使用（`f`/`t` 是当天分钟数，`t` 不含）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub date: String,
    pub f: u16,
    pub t: u16,
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

/// 空闲判定阈值（秒）：超过这么久没有任何输入，就认为人不在电脑前。
///
/// 对标 ActivityWatch 的 `aw-watcher-afk.timeout`（默认 180 秒）。这里取 60 秒：
/// 本产品统计的是"自律 / 工作"，人离开 1 分钟基本就是走了；而"看视频、读长文"
/// 这类长时间无输入但确实在用的场景，由 `count_idle` 开关兜底。
const IDLE_TIMEOUT_SECS: u32 = 60;

/// 当前正在累积的"连续使用段"。
///
/// 采样每秒一次，切窗口/切应用时把上一段封口写进 `Acc.spans`。
/// 只放内存：机器重启最多丢最后几分钟的段，比每条都写盘便宜得多。
struct CurSpan {
    date: String,
    key: String,
    on: bool,
    span: Span,
}

static CUR_SPAN: Mutex<Option<CurSpan>> = Mutex::new(None);

/// 把一段封口写进统计。调用前必须先释放 `CUR_SPAN` 锁（内部要锁 stats）。
fn push_span(shared: &Shared, c: &CurSpan) {
    if c.span.mins() == 0 {
        return;
    }
    let Ok(mut cur) = shared.stats.lock() else {
        return;
    };
    // 跨天的段不往回写：那时候 cur 已经是新的一天，写进去就串天了
    if cur.date != c.date {
        return;
    }
    let map = if c.on { &mut cur.on } else { &mut cur.off };
    let Some(acc) = map.get_mut(&c.key) else {
        return;
    };
    // 和上一段挨着就并起来，避免秒级抖动把一天切成几百个 1 分钟碎片
    if let Some(last) = acc.spans.last_mut() {
        if c.span.f <= last.t.saturating_add(1) {
            if c.span.t > last.t {
                last.t = c.span.t;
            }
            return;
        }
    }
    acc.spans.push(c.span);
}

/// 封口当前段（切应用、开始空闲、跨天时调用）
fn span_close(shared: &Shared) {
    let old = CUR_SPAN.lock().ok().and_then(|mut g| g.take());
    if let Some(c) = old {
        push_span(shared, &c);
    }
}

/// 把这一分钟并进当前段；换人/换档就封口再开新段。
fn span_touch(shared: &Shared, date: &str, key: &str, on: bool, min: u16) {
    let mut old: Option<CurSpan> = None;
    {
        let Ok(mut g) = CUR_SPAN.lock() else {
            return;
        };
        let same = g
            .as_ref()
            .map(|c| c.date == date && c.key == key && c.on == on
                && min <= c.span.t.saturating_add(1))
            .unwrap_or(false);
        if same {
            if let Some(c) = g.as_mut() {
                if min.saturating_add(1) > c.span.t {
                    c.span.t = min + 1;
                }
            }
            return;
        }
        old = g.take();
        *g = Some(CurSpan {
            date: date.to_string(),
            key: key.to_string(),
            on,
            span: Span { f: min, t: min + 1 },
        });
    }
    if let Some(c) = old {
        push_span(shared, &c);
    }
}

/// 上一次**真正记进统计**的那一秒落在哪。
///
/// 用途：空闲回溯。判定为"人不在"时，从最后一次输入到现在的这段时间
/// 已经被一秒一秒记成活跃了，要把它们扣回去。
#[derive(Clone)]
struct LastHit {
    date: String,
    key: String,
    /// 记在「自律时段内」还是「时段外」那一档
    on: bool,
    hour: usize,
}

static LAST_HIT: Mutex<Option<LastHit>> = Mutex::new(None);

/// 从 `from_hour` 开始**向前**扣 `n` 秒，返回实际扣掉的秒数。
///
/// 为什么往前扣：空闲是从"最后一次输入"往后累积的，被误记的秒一定落在最近，
/// 跨了整点就会落在前一个小时里。只扣当前小时会让 `sum(hours) != secs`。
fn take_back(hours: &mut [u32], secs: &mut u64, n: u64, from_hour: usize) -> u64 {
    if hours.is_empty() || n == 0 {
        return 0;
    }
    let mut left = n;
    let mut h = from_hour.min(hours.len() - 1);
    loop {
        let take = (hours[h] as u64).min(left);
        hours[h] -= take as u32;
        left -= take;
        if left == 0 || h == 0 {
            break;
        }
        h -= 1;
    }
    let done = n - left;
    *secs = secs.saturating_sub(done);
    done
}

/// 把"刚刚被误记成活跃的空闲秒数"从落点上扣回去。
fn refund_idle(shared: &Shared, secs: u32) {
    if secs == 0 {
        return;
    }
    let Some(hit) = LAST_HIT.lock().ok().and_then(|g| g.clone()) else {
        return;
    };
    let Ok(mut cur) = shared.stats.lock() else {
        return;
    };
    // 跨天不追溯：昨天那份已经落盘，回扣会把两天都弄乱
    if cur.date != hit.date {
        return;
    }
    let map = if hit.on { &mut cur.on } else { &mut cur.off };
    let Some(acc) = map.get_mut(&hit.key) else {
        return;
    };
    if take_back(&mut acc.hours, &mut acc.secs, secs as u64, hit.hour) > 0 {
        shared.stats_dirty.store(true, Ordering::Relaxed);
    }
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
        // 本次"连续空闲"已经记进去多少秒（用来在跨过阈值时一次扣回）
        let mut idle_run: u32 = 0;
        loop {
            let cfg = sh.config();
            if cfg.settings.stats.enabled {
                sample(&sh, &cfg, &mut idle_run);
            } else {
                idle_run = 0;
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

fn sample(shared: &Shared, cfg: &Config, idle_run: &mut u32) {
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();

    // 跨天轮转
    {
        if let Ok(mut cur) = shared.stats.lock() {
            if cur.date != today {
                // 跨天的最后一段直接丢掉：写回要换文件，误差最多一两分钟，
                // 不值得为它把轮转逻辑搅复杂（注释见 push_span 的 date 检查）
                if let Ok(mut g) = CUR_SPAN.lock() {
                    g.take();
                }
                if !cur.date.is_empty() {
                    let _ = save_day(&cur);
                }
                *cur = DayFile::new(today.clone());
                shared.stats_dirty.store(false, Ordering::Relaxed);
            }
        }
    }

    if !cfg.settings.stats.count_idle {
        let idle = idle_secs();
        if idle >= IDLE_TIMEOUT_SECS {
            // **刚跨过阈值**：从"最后一次输入"到现在的每一秒都已经被记成活跃了
            // （阈值内那几十秒是照记的，否则每次短暂停顿都会把一段切成碎片）。
            // 既然确认人不在，就把这一段整个扣回去。
            //
            // ActivityWatch 的等价做法：变成 AFK 时，afk 事件的 timestamp 取
            // `last_input`（而不是"发现的那一刻"），再用 filter_period_intersect
            // 把这段从活跃时长里裁掉。两者结果一致：**离开的时间一秒都不算**。
            if *idle_run > 0 {
                refund_idle(shared, *idle_run);
                *idle_run = 0;
            }
            // 人走了 = 这一段结束（不然下次回来会接成一段超长的假时段）
            span_close(shared);
            return;
        }
        // 阈值内：照常记，但记着"这段是可能要被扣的"
        *idle_run = idle_run.saturating_add(1);
    } else {
        *idle_run = 0;
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

    // 记下落点：万一接下来判定为空闲，就靠它把误记的秒扣回去
    let mut hit: Option<LastHit> = None;
    if let Ok(mut cur) = shared.stats.lock() {
        let map = if state_on { &mut cur.on } else { &mut cur.off };
        let e = map.entry(key.clone()).or_insert_with(|| Acc {
            label: label.clone(),
            category: category.clone(),
            secs: 0,
            hours: vec![0; 24],
            titles: BTreeMap::new(),
            browsers: BTreeMap::new(),
            spans: Vec::new(),
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
        hit = Some(LastHit {
            date: cur.date.clone(),
            key: key.clone(),
            on: state_on,
            hour,
        });
    }
    // key 要留给后面记时段用，所以上面 clone 了一份
    let keep_key = key;
    if let (Some(h), Ok(mut g)) = (hit, LAST_HIT.lock()) {
        *g = Some(h);
    }
    span_touch(
        shared,
        &today,
        &keep_key,
        state_on,
        (now.hour() as u16) * 60 + now.minute() as u16,
    );
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

/* ---------------- 日历（周 / 月） ---------------- */

/// 日历里的一天：某个条目的当天明细
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CalItem {
    pub key: String,
    pub label: String,
    pub category: String,
    pub secs: u64,
    /// 当天的连续使用段（分钟，`t` 不含）
    pub spans: Vec<Span>,
}

/// 日历里的一天
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CalDay {
    pub date: String,
    pub secs: u64,
    pub items: Vec<CalItem>,
}

fn push_cal(map: &mut BTreeMap<String, CalItem>, key: &str, acc: &Acc) {
    let e = map.entry(key.to_string()).or_insert_with(|| CalItem {
        key: key.to_string(),
        label: acc.label.clone(),
        category: acc.category.clone(),
        secs: 0,
        spans: Vec::new(),
    });
    e.secs += acc.secs;
    e.spans.extend(acc.spans.iter().copied());
}

/// 把当天同一个条目的段排序、合并相邻段（on/off 两套数据合到一起时会出现）。
fn tidy_spans(v: &mut Vec<Span>) {
    v.sort_by_key(|s| s.f);
    let mut out: Vec<Span> = Vec::with_capacity(v.len());
    for sp in v.drain(..) {
        if let Some(last) = out.last_mut() {
            if sp.f <= last.t.saturating_add(1) {
                last.t = last.t.max(sp.t);
                continue;
            }
        }
        out.push(sp);
    }
    *v = out;
}

/// 逐日明细：周日历 / 月日历用。
///
/// 为什么不复用 `aggregate`：它把整个区间合成一行行 `Slice`，
/// 而日历要的是"**每天**分别用了哪些软件、各在几点到几点"。
/// 日文件本来就是按天存的，直接逐日读最准，也不会被聚合的裁剪逻辑影响。
///
/// `tab`：`on` / `off` / 其它（两个数据集按条目相加）。
pub fn calendar(start: &str, end: &str, tab: &str) -> Vec<CalDay> {
    let mut d0 = match NaiveDate::parse_from_str(start, "%Y-%m-%d") {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut d1 = match NaiveDate::parse_from_str(end, "%Y-%m-%d") {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    if d1 < d0 {
        std::mem::swap(&mut d0, &mut d1);
    }
    // 上限一年：防止误传一个巨大区间，把界面拖死
    if (d1 - d0).num_days() > 366 {
        d1 = d0 + CDur::days(366);
    }

    let mut out = Vec::new();
    let mut cur = d0;
    while cur <= d1 {
        let date = cur.format("%Y-%m-%d").to_string();
        let file = load_day(&date);
        let mut map: BTreeMap<String, CalItem> = BTreeMap::new();
        if tab != "off" {
            for (k, a) in file.on.iter() {
                push_cal(&mut map, k, a);
            }
        }
        if tab != "on" {
            for (k, a) in file.off.iter() {
                push_cal(&mut map, k, a);
            }
        }
        let mut items: Vec<CalItem> = map.into_values().collect();
        for it in items.iter_mut() {
            tidy_spans(&mut it.spans);
        }
        items.sort_by(|a, b| b.secs.cmp(&a.secs).then(a.label.cmp(&b.label)));
        let secs = items.iter().map(|i| i.secs).sum();
        out.push(CalDay { date, secs, items });
        cur += CDur::days(1);
    }
    out
}

fn merge(
    dst: &mut BTreeMap<String, Slice>,
    src: &BTreeMap<String, Acc>,
    date: &str,
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
            spans: Vec::new(),
            span_count: 0,
        });
        e.secs += v.secs;
        for sp in v.spans.iter() {
            e.spans.push(Slot {
                date: date.to_string(),
                f: sp.f,
                t: sp.t,
            });
        }
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
/// 每个项目最多带多少段明细。跨年聚合会攒出上万段，全给前端既慢也没人看。
/// 以前是 20 —— 一天里切来切去很容易就超过 20 段，于是"明细"其实是被砍过的：
/// 用户看到的是"这一项就在这几个时段用过"，与事实不符。现在放到 400：
/// 单日 / 单周 / 单月都不可能触顶，只有跨年聚合这种极端情况才会裁剪，
/// 而那种情况界面会如实写"共 N 段（这里列 M 段）"。
const SPAN_KEEP: usize = 400;

/// 先记下真实段数，再裁剪。顺序不能反：反了 `span_count` 就永远等于上限。
fn trim_slice(s: &mut Slice) {
    s.span_count = s.spans.len() as u32;
    trim_spans(&mut s.spans);
}

/// 只保留最长的若干段，然后按时间顺序排回去（展示时要按时间读）。
fn trim_spans(spans: &mut Vec<Slot>) {
    if spans.len() > SPAN_KEEP {
        spans.sort_by(|a, b| (b.t - b.f).cmp(&(a.t - a.f)));
        spans.truncate(SPAN_KEEP);
    }
    spans.sort_by(|a, b| a.date.cmp(&b.date).then(a.f.cmp(&b.f)));
}

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
            merge(&mut on, &file.on, &file.date, &mut titles, &mut browsers);
            merge(&mut off, &file.off, &file.date, &mut titles, &mut browsers);
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
    on.iter_mut().for_each(trim_slice);
    off.iter_mut().for_each(trim_slice);
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
            spans: Vec::new(),
            span_count: 0,
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
            spans: Vec::new(),
            span_count: 0,
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
            spans: Vec::new(),
            span_count: 0,
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
        let mut acc = Acc { label: "d".into(), category: "site".into(), secs: 9, hours: vec![0; 24], titles: Default::default(), browsers: Default::default(), spans: Default::default() };
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


    /// 同一小时内扣减：总量和小时桶同时减，保持 `sum(hours) == secs`
    #[test]
    fn take_back_same_hour() {
        let mut hours = vec![0u32; 24];
        hours[9] = 120;
        let mut secs = 120u64;
        assert_eq!(take_back(&mut hours, &mut secs, 30, 9), 30);
        assert_eq!(hours[9], 90);
        assert_eq!(secs, 90);
    }

    /// 跨整点的空闲要**往前**扣：只扣当前小时会让 sum(hours) 和 secs 对不上
    #[test]
    fn take_back_walks_back_into_previous_hour() {
        let mut hours = vec![0u32; 24];
        hours[8] = 100;
        hours[9] = 20;
        let mut secs = 120u64;
        // 从 9 点开始往回收 50 秒：先扣完 9 点的 20，再扣 8 点的 30
        assert_eq!(take_back(&mut hours, &mut secs, 50, 9), 50);
        assert_eq!(hours[9], 0);
        assert_eq!(hours[8], 70);
        assert_eq!(secs, 70);
        assert_eq!(hours.iter().map(|x| *x as u64).sum::<u64>(), secs);
    }

    /// 要扣的比记得还多（比如刚过零点）：扣到 0 为止，不能扣成负数、也不能 panic
    #[test]
    fn take_back_clamps_at_zero() {
        let mut hours = vec![0u32; 24];
        hours[0] = 10;
        let mut secs = 10u64;
        assert_eq!(take_back(&mut hours, &mut secs, 600, 0), 10);
        assert_eq!(secs, 0);
        assert_eq!(hours[0], 0);
    }

    /// 0 秒 / 空小时表都不该动任何东西
    #[test]
    fn take_back_noop_cases() {
        let mut hours = vec![0u32; 24];
        hours[3] = 5;
        let mut secs = 5u64;
        assert_eq!(take_back(&mut hours, &mut secs, 0, 3), 0);
        assert_eq!(secs, 5);
        assert_eq!(hours[3], 5);

        let mut empty: Vec<u32> = Vec::new();
        let mut s2 = 7u64;
        assert_eq!(take_back(&mut empty, &mut s2, 3, 5), 0);
        assert_eq!(s2, 7);
    }

    /// 日历：相邻段要合并，倒序区间要能自动纠正
    #[test]
    fn calendar_merges_adjacent_spans_and_fixes_order() {
        // 直接测纯函数，避免碰磁盘
        let mut v = vec![
            Span { f: 600, t: 660 },
            Span { f: 660, t: 700 },
            Span { f: 720, t: 730 },
        ];
        tidy_spans(&mut v);
        assert_eq!(v, vec![Span { f: 600, t: 700 }, Span { f: 720, t: 730 }]);

        // 完全相同的段也不能重复
        let mut v2 = vec![Span { f: 540, t: 600 }, Span { f: 540, t: 600 }];
        tidy_spans(&mut v2);
        assert_eq!(v2, vec![Span { f: 540, t: 600 }]);
    }

    /// 没人用过的那天也要出现在日历里（否则前端得自己补日期）
    #[test]
    fn calendar_returns_every_day_in_range() {
        let days = calendar("2026-10-26", "2026-11-01", "on");
        assert_eq!(days.len(), 7, "跨月也要一天不少");
        assert_eq!(days[0].date, "2026-10-26");
        assert_eq!(days[6].date, "2026-11-01");
        // 倒序传入等价于正序
        let rev = calendar("2026-11-01", "2026-10-26", "all");
        assert_eq!(rev.len(), 7);
        assert_eq!(rev[0].date, "2026-10-26");
    }

    /// 段长就是 end - start，边界不能出现负数
    #[test]
    fn span_length_never_negative() {
        assert_eq!(Span { f: 545, t: 600 }.mins(), 55);
        assert_eq!(Span { f: 600, t: 600 }.mins(), 0);
        assert_eq!(Span { f: 600, t: 500 }.mins(), 0, "倒挂也不能算出负数");
    }

    /// 超过上限时只留最长的那些，并且**展示前按时间排回去**
    #[test]
    fn trim_spans_keeps_longest_then_sorts_by_time() {
        // 造 SPAN_KEEP + 6 段，长度随 i 递增：最短的 6 段应当被裁掉
        let mut v: Vec<Slot> = (0..(SPAN_KEEP + 6))
            .map(|i| {
                let len = 1 + i as u16;
                let f = ((i * 13) % 1200) as u16;
                Slot {
                    date: format!("2026-10-{:02}", 1 + i % 3),
                    f,
                    t: f + len,
                }
            })
            .collect();
        let lens: Vec<u16> = v.iter().map(|x| x.t - x.f).collect();
        trim_spans(&mut v);
        assert_eq!(v.len(), SPAN_KEEP, "最多留 SPAN_KEEP 段");
        let kept_min = v.iter().map(|x| x.t - x.f).min().unwrap_or(0);
        assert!(
            kept_min >= lens.iter().filter(|l| **l <= kept_min).max().copied().unwrap_or(0),
            "留下的必须是最长的那些"
        );
        // 输出按 (日期, 起始) 升序
        let mut sorted = v.clone();
        sorted.sort_by(|a, b| a.date.cmp(&b.date).then(a.f.cmp(&b.f)));
        assert_eq!(v, sorted, "展示顺序必须是时间序");
    }

    /// 不足上限时原样保留（只是排个序）——单日/单周根本不会触顶
    #[test]
    fn trim_spans_keeps_everything_when_few() {
        let mut v = vec![
            Slot { date: "2026-10-02".into(), f: 600, t: 660 },
            Slot { date: "2026-10-01".into(), f: 540, t: 600 },
        ];
        trim_spans(&mut v);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].date, "2026-10-01", "按日期升序");
    }

    /// `span_count` 记的是**裁剪前**的段数：界面才能如实写"共 N 段（列 M 段）"
    #[test]
    fn trim_slice_reports_true_span_count() {
        let mut sl = Slice {
            spans: (0..(SPAN_KEEP + 3))
                .map(|i| Slot { date: "2026-10-01".into(), f: i as u16, t: i as u16 + 1 })
                .collect(),
            ..Default::default()
        };
        trim_slice(&mut sl);
        assert_eq!(sl.span_count as usize, SPAN_KEEP + 3, "真实段数不能被裁剪影响");
        assert_eq!(sl.spans.len(), SPAN_KEEP);

        // 没触顶时两者相等
        let mut few = Slice {
            spans: vec![Slot { date: "2026-10-01".into(), f: 10, t: 20 }],
            ..Default::default()
        };
        trim_slice(&mut few);
        assert_eq!(few.span_count, 1);
        assert_eq!(few.spans.len(), 1);
    }

    /// 越界小时不能 panic（防御：hours 长度可能被老数据改坏）
    #[test]
    fn take_back_out_of_range_hour_is_safe() {
        let mut hours = vec![0u32; 24];
        hours[23] = 40;
        let mut secs = 40u64;
        assert_eq!(take_back(&mut hours, &mut secs, 10, 99), 10);
        assert_eq!(secs, 30);
    }
}
