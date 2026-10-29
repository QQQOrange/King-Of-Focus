//! 睡眠结束后的自动唤醒 + 自动启动。
//!
//! 触发条件（全部满足才执行，缺一不可）：
//!   1. `settings.sleep.wake.enabled` 打开（**默认关**）
//!   2. 有启用的条目，且今天这条要跑（`days` 为空 = 每天）
//!   3. 现在已经过了「这一轮睡眠时段的结束时刻 + delaySecs」
//!   4. 这一轮还没跑过（按"时段结束时刻"去重，落盘，重启也不会重跑）
//!   5. 系统真的已经恢复（有前台窗口 / 不是锁屏中），否则等下一次 tick
//!
//! 为什么以"睡眠时段结束时刻"作为幂等键：它就是这一轮事件的天然主键。
//! 用"跑过了"这种布尔量会在跨天时失效；用时间戳则可以精确回答
//! "07:00 这一轮跑过没有"。
//!
//! 为什么还要区分"有没有真的睡过"：如果用户整夜没睡（一直在用电脑），
//! 07:00 把浏览器全拉起来就很吓人。所以只在「窗口内生过（本进程经历过时段边界）
//! / 刚从休眠恢复 / 刚开机」三种情形下才真正执行。

use crate::cfg;
use crate::model::{Config, SleepWindow, WakeCfg, WakeItem};
use crate::shared::Shared;
use chrono::{Datelike, Local, TimeZone, Timelike};
use serde_json::json;
use std::io::Write;
use std::sync::atomic::{AtomicI64, Ordering};

/// 时段结束后多久之内还允许补跑（开机晚了也一样要跑）
const CATCHUP_SECS: i64 = 4 * 3600;

static LAST_FIRED: AtomicI64 = AtomicI64::new(0);

fn state_path() -> std::path::PathBuf {
    cfg::data_dir().join("wake_last.json")
}

fn log_path() -> std::path::PathBuf {
    cfg::data_dir().join("wake.log")
}

fn load_last() -> i64 {
    let cached = LAST_FIRED.load(Ordering::Relaxed);
    if cached > 0 {
        return cached;
    }
    let v = std::fs::read_to_string(state_path())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("end").and_then(|x| x.as_i64()))
        .unwrap_or(0);
    if v > 0 {
        LAST_FIRED.store(v, Ordering::Relaxed);
    }
    v
}

fn save_last(end: i64) {
    LAST_FIRED.store(end, Ordering::Relaxed);
    let body = json!({ "end": end, "at": Local::now().timestamp() });
    if let Ok(s) = serde_json::to_string(&body) {
        let _ = std::fs::write(state_path(), s);
    }
}

/// 追加一行日志，并只保留最近 120 行（这文件是给人排查用的，不该无限长）
pub fn log(line: &str) {
    let p = log_path();
    let stamp = Local::now().format("%Y-%m-%d %H:%M:%S");
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .and_then(|mut f| writeln!(f, "[{stamp}] {line}"));
    if let Ok(text) = std::fs::read_to_string(&p) {
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() > 120 {
            let tail = lines[lines.len() - 120..].join("\n") + "\n";
            let _ = std::fs::write(&p, tail);
        }
    }
}

/// `ts` 那一天 0 点（本地时区）的 unix 秒。
///
/// 必须用 `ts` 自己换算，不能拿 `Local::now()`：测试里会传"今天 09:00"这种
/// 人造时刻，用 now 去减秒数会算出别的日子。
fn midnight(ts: i64) -> i64 {
    let dt = chrono::Local
        .timestamp_opt(ts, 0)
        .single()
        .unwrap_or_else(chrono::Local::now);
    let secs = dt.hour() as i64 * 3600 + dt.minute() as i64 * 60 + dt.second() as i64;
    ts - secs
}

/// 某一段、以 `start_weekday`（0=周一）为"开始日"的那一轮，结束在什么时刻。
///
/// 关键点：`days` 标的是**开始日**，不是结束日。23:00–07:00 标周一时，
/// 指的是"周一 23:00 到周二 07:00"，所以结束时刻会落到第二天——
/// 用户点"周一"是"周一入夜开始睡"，这层语义必须在代码里坐实，
/// 否则周一凌晨那一觉会被算到周日的配置上。
fn end_for_start(w: &SleepWindow, base: i64, start_weekday: u32) -> Option<i64> {
    if !w.days.is_empty() && !w.days.iter().any(|d| *d as u32 == start_weekday) {
        return None;
    }
    let to = if w.to == 0 { 1440 } else { w.to } as i64;
    let from = w.from as i64;
    // from < to：不跨夜，结束在当天；否则跨夜，结束在次日
    Some(if from < to { base + to * 60 } else { base + 86_400 + to * 60 })
}

/// 把 `ts` 前后各两天的所有"段结束时刻"摊平出来（含是哪一段）。
///
/// 为什么要 ±2 天：跨夜 + 按星期生效时，"今天凌晨结束的那一轮"是**前天晚上**
/// 开始的，只往前看一天会漏掉周末夜间那一段。
fn ends_near(cfg: &Config, ts: i64) -> Vec<(SleepWindow, i64)> {
    let mut out = Vec::new();
    let today = midnight(ts);
    let wd_today = chrono::DateTime::from_timestamp(today, 0)
        .map(|x| x.with_timezone(&Local).weekday().num_days_from_monday())
        .unwrap_or(0) as i64;
    for w in cfg.settings.sleep.segments() {
        for d in -2i64..=1 {
            let base = today + d * 86_400;
            let wd = ((wd_today + d).rem_euclid(7)) as u32;
            if let Some(e) = end_for_start(&w, base, wd) {
                out.push((w.clone(), e));
            }
        }
    }
    out
}

/// 最近一次"睡眠时段结束"（含跨夜、多段时取**最近的那一段**）。
///
/// 返回那一段本身：它带着自己的自动启动清单，所以"午睡结束后开 A、
/// 夜间结束后开 B"才成立。
pub fn last_window_end(cfg: &Config, ts: i64) -> Option<(SleepWindow, i64)> {
    if !cfg.settings.sleep.enabled {
        return None;
    }
    let mut best: Option<(SleepWindow, i64)> = None;
    for (w, e) in ends_near(cfg, ts) {
        if e <= ts && best.as_ref().map_or(true, |(_, b)| e > *b) {
            best = Some((w, e));
        }
    }
    best
}

/// 下一次"睡眠时段结束"（用来提前挂可唤醒定时器）。
pub fn next_window_end(cfg: &Config, ts: i64) -> Option<(SleepWindow, i64)> {
    if !cfg.settings.sleep.enabled {
        return None;
    }
    let mut best: Option<(SleepWindow, i64)> = None;
    for (w, e) in ends_near(cfg, ts) {
        if e > ts && best.as_ref().map_or(true, |(_, b)| e < *b) {
            best = Some((w, e));
        }
    }
    best
}

/// 系统是否已经"恢复到可以开程序"的状态。
///
/// 锁屏 / 正在登录时没有前台窗口，这时候 spawn 出来的程序会排在
/// 一个还没就绪的会话里，经常白屏。等到下一 tick 再试即可。
fn system_ready() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
    }
    unsafe { GetForegroundWindow() != 0 }
}

/// 让系统在 `ms` 毫秒后自己醒来（fResume = TRUE）。
///
/// 没权限（需要 SE_SHUTDOWN_NAME，通常要管理员）时静默失败——
/// 失败也不影响"机器本来就是醒着"的那条路径。
fn arm_wake_timer(ms: i64) {
    if ms <= 0 {
        return;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateWaitableTimerW(attrs: *const u32, manual: i32, name: *const u16) -> isize;
        fn SetWaitableTimer(
            h: isize,
            due: *const i64,
            period: i32,
            routine: *const u8,
            param: *const u8,
            resume: i32,
        ) -> i32;
    }
    unsafe {
        let h = CreateWaitableTimerW(std::ptr::null(), 1, std::ptr::null());
        if h == 0 {
            return;
        }
        // 负值 = 相对时间，单位 100ns
        let due: i64 = -(ms.clamp(1_000, 24 * 3600 * 1000) * 10_000);
        let _ = SetWaitableTimer(h, &due, 0, std::ptr::null(), std::ptr::null(), 1);
        // 句柄不关：进程退出时由系统回收；提前关掉会把定时器一起取消。
    }
}

/// "目标程序 / 网页"其实是个命令行，按空格切但要尊重双引号
fn split_args(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in raw.chars() {
        match c {
            '"' => quoted = !quoted,
            ' ' | '\t' if !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn weekday_idx() -> u8 {
    Local::now().weekday().num_days_from_monday() as u8
}

fn item_due(it: &WakeItem, wd: u8) -> bool {
    it.enabled && (it.days.is_empty() || it.days.contains(&wd))
}

fn run_item(it: &WakeItem) -> Result<(), String> {
    if it.kind == "url" {
        return crate::cmds::open_url(it.target.clone());
    }
    let mut cmd = std::process::Command::new(&it.target);
    let args = split_args(&it.args);
    if !args.is_empty() {
        cmd.args(&args);
    }
    // 工作目录取 exe 所在目录：有些程序不带工作目录会找不到自己的资源
    if let Some(dir) = std::path::Path::new(&it.target).parent() {
        if dir.as_os_str().len() > 0 {
            cmd.current_dir(dir);
        }
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("{}：{}", it.target, e))
}

/// 真正执行一轮。返回 (成功数, 失败说明)
fn run_items(w: &WakeCfg, wd: u8) -> (usize, Vec<String>) {
    let mut ok = 0usize;
    let mut fails = Vec::new();
    // 清单来自**刚结束的那一段**，不是全局那份（单段模式下两者是同一个对象）
    for it in w.items.iter() {
        if !item_due(it, wd) {
            continue;
        }
        match run_item(it) {
            Ok(()) => {
                ok += 1;
                log(&format!("OK   {} {}", if it.kind == "url" { "网页" } else { "软件" }, it.target));
            }
            Err(e) => {
                log(&format!("FAIL {} {}", if it.kind == "url" { "网页" } else { "软件" }, e));
                fails.push(e);
            }
        }
    }
    (ok, fails)
}

/// 每秒调用一次。`prev_in_window` = 上一 tick 是否在睡眠时段内，
/// `resumed` = 这一 tick 之前系统睡了一段时间（tick 间隔异常大）。
pub fn tick(shared: &Shared, cfg: &Config, ts: i64, prev_in_window: bool, resumed: bool) -> Option<String> {
    if !cfg.settings.sleep.enabled {
        return None;
    }

    // ① 还没结束：提前挂"可唤醒定时器"，到点让系统自己醒。
    //    这里必须用**未来最近**的那个结束时刻；以前用 last_window_end 做这个判断，
    //    可它返回的一定 <= now，所以那段代码从来没跑过（死分支）。
    if let Some((w, next)) = next_window_end(cfg, ts) {
        if w.wake.enabled && w.wake.wake_system {
            let ms = (next - ts) * 1000;
            // 每小时最多挂一次（重复挂会创建一堆句柄）
            if Local::now().minute() == 0 && Local::now().second() < 2 {
                arm_wake_timer(ms);
            }
        }
    }

    // ② 刚结束的是哪一段？用它自己的开关和清单
    let (win, end) = match last_window_end(cfg, ts) {
        Some(v) => v,
        None => return None,
    };
    let w = &win.wake;
    if !w.enabled {
        return None;
    }

    // 刚结束不久：先等 delay，让网络 / 磁盘就绪
    let due = end + w.delay_secs as i64;
    if ts < due {
        return None;
    }
    if ts - end > CATCHUP_SECS {
        return None;
    }
    if load_last() == end {
        return None; // 这一轮已经跑过
    }
    // 必须有"真的睡过 / 刚开机"的证据，否则整夜没睡的人也会被拉一堆程序
    let booted_recently = crate::sleep::uptime_secs() < 300;
    if !(prev_in_window || resumed || booted_recently) {
        return None;
    }
    if !system_ready() {
        return None; // 还在锁屏 / 登录界面，下一 tick 再试
    }

    // 先记账再执行：万一某个程序 spawn 卡住，也不会在下一 tick 重复拉一遍
    save_last(end);
    let wd = weekday_idx();
    let (ok, fails) = run_items(w, wd);
    if ok == 0 && fails.is_empty() {
        return None; // 今天这条不跑
    }
    let note = if fails.is_empty() {
        format!("睡眠结束自动启动：{ok} 项已打开")
    } else {
        format!(
            "睡眠结束自动启动：{ok} 项成功，{} 项失败（详见 wake.log）",
            fails.len()
        )
    };
    log(&format!("[{}] {}", win.label(), note));
    if let Ok(mut rt) = shared.rt.lock() {
        rt.wake_note = note.clone();
        rt.wake_at = ts;
    }
    Some(note)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SleepCfg;

    fn cfg_with(from: u32, to: u32) -> Config {
        let mut c = Config::default();
        c.settings.sleep = SleepCfg {
            enabled: true,
            from,
            to,
            ..SleepCfg::default()
        };
        c
    }

    /// 普通时段：今天的结束点还没到 → 取昨天那个
    #[test]
    fn window_end_before_today() {
        // 2026-10-29 03:00 本地时间点，窗口 23:00–07:00 → 最近一次结束是今天 07:00？
        // 不，03:00 < 07:00，所以最近一次是**昨天** 07:00。
        let c = cfg_with(23 * 60, 7 * 60);
        let base = midnight(Local::now().timestamp());
        let ts = base + 3 * 3600; // 今天 03:00
        let (_, end) = last_window_end(&c, ts).expect("该有时段");
        assert_eq!(end, base - 86_400 + 7 * 3600);
    }

    /// 过了结束点：就是今天的
    #[test]
    fn window_end_after_today() {
        let c = cfg_with(23 * 60, 7 * 60);
        let base = midnight(Local::now().timestamp());
        let ts = base + 9 * 3600; // 今天 09:00
        assert_eq!(last_window_end(&c, ts).map(|(_, e)| e), Some(base + 7 * 3600));
    }

    /// 填 24:00 的窗口：结束点在当天 24 点
    #[test]
    fn window_end_at_midnight() {
        let c = cfg_with(23 * 60, 0);
        let base = midnight(Local::now().timestamp());
        let ts = base + 23 * 3600 + 1800; // 23:30
        // to = 0 视为 24:00，还没到 → 昨天 24 点
        assert_eq!(last_window_end(&c, ts).map(|(_, e)| e), Some(base - 86_400 + 24 * 3600));
    }

    /// 关掉睡眠 / 空时段 → 没有"结束时刻"，也就不会误触发
    #[test]
    fn disabled_has_no_window_end() {
        let mut c = cfg_with(23 * 60, 7 * 60);
        c.settings.sleep.enabled = false;
        assert!(last_window_end(&c, Local::now().timestamp()).is_none());
        let mut c2 = cfg_with(23 * 60, 7 * 60);
        c2.settings.sleep.to = 23 * 60; // from == to
        assert!(last_window_end(&c2, Local::now().timestamp()).is_none());
    }

    /// 两段睡眠：最近一次结束必须是**更近的那一段**，而不是全局 to 最大的那段
    #[test]
    fn last_end_belongs_to_nearest_segment() {
        let mut c = Config::default();
        c.settings.sleep.enabled = true;
        c.settings.sleep.windows = vec![
            SleepWindow {
                id: "nap".into(),
                from: 13 * 60,
                to: 14 * 60,
                ..Default::default()
            },
            SleepWindow {
                id: "night".into(),
                from: 23 * 60,
                to: 7 * 60,
                ..Default::default()
            },
        ];
        let base = midnight(Local::now().timestamp());
        let ts = base + 14 * 3600 + 1800; // 今天 14:30
        let (w, end) = last_window_end(&c, ts).expect("该有结束时刻");
        assert_eq!(w.id, "nap", "14:30 最近结束的是午睡段");
        assert_eq!(end, base + 14 * 3600);
    }

    /// 每段带自己的清单：午睡段开 A，夜间段开 B
    #[test]
    fn wake_items_are_per_segment() {
        let mut c = Config::default();
        c.settings.sleep.enabled = true;
        let mut nap = SleepWindow {
            id: "nap".into(),
            from: 13 * 60,
            to: 14 * 60,
            ..Default::default()
        };
        nap.wake.enabled = true;
        nap.wake.items = vec![WakeItem {
            id: "a".into(),
            kind: "app".into(),
            target: "C:/a.exe".into(),
            ..Default::default()
        }];
        let mut night = SleepWindow {
            id: "night".into(),
            from: 23 * 60,
            to: 7 * 60,
            ..Default::default()
        };
        night.wake.enabled = true;
        night.wake.items = vec![WakeItem {
            id: "b".into(),
            kind: "app".into(),
            target: "C:/b.exe".into(),
            ..Default::default()
        }];
        c.settings.sleep.windows = vec![nap, night];

        let base = midnight(Local::now().timestamp());
        let (w1, _) = last_window_end(&c, base + 14 * 3600 + 60).unwrap();
        assert_eq!(w1.id, "nap");
        assert_eq!(w1.wake.items[0].target, "C:/a.exe");

        let (w2, _) = last_window_end(&c, base + 7 * 3600 + 60).unwrap();
        assert_eq!(w2.id, "night");
        assert_eq!(w2.wake.items[0].target, "C:/b.exe");
    }

    /// 未来的结束时刻：用来提前挂可唤醒定时器（原来这个分支永远是死的）
    #[test]
    fn next_end_is_in_the_future() {
        let c = cfg_with(23 * 60, 7 * 60);
        let base = midnight(Local::now().timestamp());
        let ts = base + 23 * 3600 + 1800; // 今天 23:30
        let (_, next) = next_window_end(&c, ts).expect("该有未来的结束点");
        assert!(next > ts);
        assert_eq!(next, base + 86_400 + 7 * 3600, "明天 07:00");
    }

    /// 参数拆分会尊重双引号（带空格的路径必须原样传进去）
    #[test]
    fn args_respect_quotes() {
        assert_eq!(split_args(""), Vec::<String>::new());
        assert_eq!(split_args("--a --b"), vec!["--a", "--b"]);
        assert_eq!(
            split_args(r#"--name "hello world" -v"#),
            vec!["--name", "hello world", "-v"]
        );
    }

    /// days 为空 = 每天；指定星期就只在那几天跑
    #[test]
    fn item_day_scope() {
        let mut it = WakeItem::default();
        assert!(item_due(&it, 0));
        it.days = vec![0, 2];
        assert!(item_due(&it, 0));
        assert!(!item_due(&it, 1));
        it.enabled = false;
        assert!(!item_due(&it, 0));
    }
}
