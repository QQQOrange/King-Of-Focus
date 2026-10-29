//! 睡眠管理：睡眠时段内锁定 + 倒计时自动关机
//!
//! 与「自律时段」的区别：
//!   · 自律时段管的是"白天什么时候不许玩"，靠规则拦软件 / 网页；
//!   · 睡眠时段管的是"这台机器该关着了"，靠全屏锁定 + 关机兜底。
//!
//! 判定链条（每一环都必须成立才锁定）：
//!   1. 睡眠开关打开，且当前分钟落在 [from, to) 里（支持跨夜 23:00 → 07:00）
//!   2. 没有处在积分兑换买来的解锁窗口里（`Points::unlock_until`）
//!   3. 不是测试模式（测试模式下一切照常，方便调排班）
//!
//! 锁定之后开始倒计时：从"发现自己在睡眠时段内"那一刻算起（进程启动、
//! 系统从睡眠唤醒、或者时段刚刚开始），`countdown_min` 分钟之后关机。
//! 用户可以用积分买断一段时间（`points.unlock_until`），买断期间不锁也不关，
//! 买断结束后如果还在睡眠时段内，就重新开始一轮倒计时。
//!
//! 为什么要"重新武装"而不是从固定时刻算：笔记本合盖唤醒后，用户需要一点时间
//! 把手头的事收尾；从唤醒那一刻重新给满倒计时，才符合"我醒了，但我不该醒"的场景。

use crate::cfg;
use crate::model::{Config, SleepWindow};
use crate::shared::Shared;
use chrono::{Datelike, Local, TimeZone, Timelike};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;

/// 关机指令发出后留给系统的时间（秒）。这段时间内还能用积分解锁 + `shutdown /a` 撤回。
pub const SHUTDOWN_GRACE_SECS: i64 = 30;

/// 两次 tick 间隔超过这个秒数 → 认为中途系统睡过去了，重新给满倒计时。
const RESUME_GAP_SECS: i64 = 120;

/// 倒计时的起点。
#[derive(Clone, Copy, Debug, Default)]
struct Arm {
    /// 这一轮从什么时候开始算（unix 秒）
    start: i64,
    /// 已经发过关机指令
    fired: bool,
    /// 这一轮属于**哪一段**（用段起点当 key）。
    ///
    /// 多段之后必须区分：午睡段结束时 `fired` 是 true，紧接着进夜间段，
    /// 如果还沿用上一轮的 fired，夜间段就永远不会关机——该锁的时候没锁，
    /// 这是这个功能最不能出的错。key 一变就重新武装。
    key: i64,
}

fn arm_slot() -> &'static Mutex<Option<Arm>> {
    static ARM: OnceLock<Mutex<Option<Arm>>> = OnceLock::new();
    ARM.get_or_init(|| Mutex::new(None))
}

/// 上一次 tick 的时间戳（用于识别"系统睡过去了"）
fn last_tick() -> &'static AtomicI64 {
    static T: OnceLock<AtomicI64> = OnceLock::new();
    T.get_or_init(|| AtomicI64::new(0))
}

#[link(name = "kernel32")]
extern "system" {
    fn GetTickCount64() -> u64;
}

/// 本次开机的时刻（unix 秒）。拿不到就退回"现在"。
pub fn boot_ts(now: i64) -> i64 {
    let up = uptime_secs();
    if up <= 0 || up > 60 * 60 * 24 * 400 {
        return now;
    }
    now - up
}

/// 本次开机已经过去多少秒（界面显示"刚开机 3 分钟"）
pub fn uptime_secs() -> i64 {
    let ms = unsafe { GetTickCount64() };
    if ms == 0 || ms > 60 * 60 * 24 * 400 {
        return 0;
    }
    (ms / 1000) as i64
}

/// 当前分钟数（当天 0:00 起）
fn minute_of_day() -> u32 {
    minute_of_ts(Local::now().timestamp())
}

/// 某个时间戳对应的"当天第几分钟"（本地时区）
fn minute_of_ts(ts: i64) -> u32 {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|x| {
            let t = x.with_timezone(&Local);
            t.hour() * 60 + t.minute()
        })
        .unwrap_or(0)
}

/// 某个时间戳是周几（0=周一 … 6=周日），和 `SleepWindow.days` 同一套下标。
fn weekday_of_ts(ts: i64) -> u32 {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|x| x.with_timezone(&Local).weekday().num_days_from_monday())
        .unwrap_or(0)
}

/// 这一轮睡眠时段的起点（用于界面显示"锁定自 23:00"）。
/// `from <= to` → 今天 from；`from > to` 跨夜 → 分钟数 < to 时算昨天开始的。
fn window_start_of(w: &SleepWindow, ts: i64) -> i64 {
    let min = minute_of_ts(ts) as i64;
    if w.from < w.to {
        return ts - (min - w.from as i64) * 60;
    }
    if min < w.to as i64 {
        // 已经过了半夜，这一轮是昨天开始的
        ts - (min + 24 * 60 - w.from as i64) * 60
    } else {
        ts - (min - w.from as i64) * 60
    }
}

/// 这一轮睡眠时段到什么时候结束（unix 秒）
fn window_end_of(w: &SleepWindow, ts: i64) -> i64 {
    let min = minute_of_ts(ts) as i64;
    let left = if w.from < w.to {
        w.to as i64 - min
    } else if min >= w.from as i64 {
        24 * 60 - min + w.to as i64
    } else {
        w.to as i64 - min
    };
    ts + left.max(0) * 60
}

/// 睡眠状态快照（界面 / sleep 窗口都读它）
#[derive(Clone, Debug)]
pub struct SleepState {
    pub enabled: bool,
    /// 当前是否落在睡眠时段内
    pub in_window: bool,
    /// 是否处于锁定（要挡屏、要倒计时）
    pub locked: bool,
    /// 解锁到什么时候（积分买断）
    pub unlocked_until: i64,
    /// 倒计时终点（unix 秒），0 = 还没开始
    pub deadline: i64,
    /// 还剩几秒
    pub remain: i64,
    /// 已经发过关机指令
    pub fired: bool,
    pub window_start: i64,
    pub window_end: i64,
    /// 这次会不会真的关机（关 = 只锁）
    pub will_shutdown: bool,
    /// 当前这一段自己的参数（多段时界面显示"这一段"的，而不是全局默认值）
    pub seg_from: u32,
    pub seg_to: u32,
    pub seg_countdown: u32,
    pub seg_shutdown: bool,
    pub seg_lock: bool,
    /// 当前段的名字（时间 + 周期），日志和文案用
    pub seg_label: String,
}

impl SleepState {
    pub fn to_json(&self, cfg: &Config) -> Value {
        let s = &cfg.settings.sleep;
        let price = if s.unlock_price <= 0 { 0 } else { s.unlock_price * s.unlock_min as i64 };
        // from / to / countdownMin / shutdown / lockScreen 一律给**当前段**的值。
        // 多段之后如果还报全局默认值，sleep 窗口就会显示"锁定至 07:00"而实际段是
        // 13:00–14:00 的午睡——界面说的时间不是正在生效的那个，比不显示更糟。
        json!({
            "enabled": self.enabled,
            "inWindow": self.in_window,
            "locked": self.locked,
            "unlockedUntil": self.unlocked_until,
            "deadline": self.deadline,
            "remain": self.remain.max(0),
            "fired": self.fired,
            "windowStart": self.window_start,
            "windowEnd": self.window_end,
            "willShutdown": self.will_shutdown,
            "from": self.seg_from,
            "to": self.seg_to,
            "countdownMin": self.seg_countdown,
            "unlockMin": s.unlock_min,
            "price": price,
            "balance": cfg.points.balance,
            "shutdown": self.seg_shutdown,
            "lockScreen": self.seg_lock,
            "segLabel": self.seg_label,
            "windows": s.windows.len(),
        })
    }
}

/// 计算当前睡眠状态。纯函数（除了读一次系统时钟），方便写单测。
/// 纯判定：现在是否该被睡眠时段锁住（不看倒计时，只看时段 + 解锁 + 开关）。
///
/// 单独拎出来是因为 `guard::exit_blocked` 只有 `&Config` 可用（拿不到进程内的
/// 倒计时状态），而"能不能退出""能不能改设置"只取决于这一层。
pub fn locked_by_cfg(cfg: &Config, ts: i64) -> bool {
    if crate::testmode::on() {
        return false;
    }
    let s = &cfg.settings.sleep;
    // 锁不锁由**当前命中的那一段**决定：午睡段可能只想关机不想锁屏，
    // 夜间段才全屏锁。用全局 s.lock_screen 会把两段的策略混成一个。
    match s.active(minute_of_ts(ts), weekday_of_ts(ts)) {
        Some(w) => w.lock_screen && ts >= cfg.points.unlock_until,
        None => false,
    }
}

fn state_at(cfg: &Config, ts: i64, arm: Option<Arm>) -> SleepState {
    let s = &cfg.settings.sleep;
    let win = s.active(minute_of_ts(ts), weekday_of_ts(ts));
    let in_window = win.is_some();
    let unlocked_until = cfg.points.unlock_until;
    let unlocked = ts < unlocked_until;
    let locked = locked_by_cfg(cfg, ts);
    let countdown = win.as_ref().map(|w| w.countdown_min.max(1) as i64 * 60).unwrap_or(0);
    let (deadline, fired) = match arm {
        Some(a) if in_window && !unlocked => (a.start + countdown, a.fired),
        _ => (0, false),
    };
    let (seg_from, seg_to, seg_cd, seg_sd, seg_lk, seg_label, wstart, wend) = match win.as_ref() {
        Some(w) => (
            w.from,
            w.to,
            w.countdown_min,
            w.shutdown,
            w.lock_screen,
            format!("{}（{}）", w.label(), w.cycle_text()),
            window_start_of(w, ts),
            window_end_of(w, ts),
        ),
        None => (0, 0, 0, false, false, String::new(), 0, 0),
    };
    SleepState {
        enabled: s.enabled,
        in_window,
        locked,
        unlocked_until: if unlocked { unlocked_until } else { 0 },
        deadline,
        remain: if deadline > 0 { deadline - ts } else { 0 },
        fired,
        window_start: wstart,
        window_end: wend,
        will_shutdown: seg_sd && !cfg.settings.dry_run,
        seg_from,
        seg_to,
        seg_countdown: seg_cd,
        seg_shutdown: seg_sd,
        seg_lock: seg_lk,
        seg_label,
    }
}

/// 从 Shared 里取一份当前状态（会顺手推进倒计时状态机，但不产生副作用之外的关机）
pub fn snapshot(shared: &Shared) -> SleepState {
    let cfg = shared.config();
    let ts = Local::now().timestamp();
    let st = state_at(&cfg, ts, *arm_slot().lock().unwrap());
    st
}

/// 是否处于睡眠锁定（`save_config`、退出等入口用它挡一下）
pub fn is_locked(shared: &Shared) -> bool {
    snapshot(shared).locked
}

/// 界面文案里的"锁定到几点 / 还剩多久"
pub fn summary(shared: &Shared) -> String {
    let st = snapshot(shared);
    if !st.in_window {
        return String::new();
    }
    let fmt = |ts: i64| {
        chrono::DateTime::from_timestamp(ts, 0)
            .map(|x| x.with_timezone(&Local).format("%H:%M").to_string())
            .unwrap_or_default()
    };
    if st.locked {
        format!("睡眠时段锁定中（至 {}）", fmt(st.window_end))
    } else if st.unlocked_until > 0 {
        format!("睡眠时段已用积分解锁至 {}", fmt(st.unlocked_until))
    } else {
        String::new()
    }
}

/// 发一次关机指令（`/s /t 30 /f`，30 秒内还能 `shutdown /a` 撤回）
fn fire_shutdown() -> bool {
    let mut cmd = std::process::Command::new("shutdown.exe");
    cmd.args(["/s", "/t", &SHUTDOWN_GRACE_SECS.to_string(), "/f"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::guard::CREATE_NO_WINDOW);
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

/// 撤回已经排队的关机指令
fn abort_shutdown() {
    let mut cmd = std::process::Command::new("shutdown.exe");
    cmd.arg("/a");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::guard::CREATE_NO_WINDOW);
    }
    let _ = cmd.status();
}

/// 用积分解锁睡眠时段。
///
/// `minutes = 0` → 用配置里的 `unlock_min`。
/// 价格 = 每分钟单价 × 分钟数（和自律时段那套"每天递增"分开算，
/// 因为睡眠是"整段的买断"，不是按紧张程度加价）。
pub fn unlock(shared: &Arc<Shared>, minutes: u32) -> Result<Value, String> {
    let mut c = shared.config();
    let s = &c.settings.sleep;
    let now = Local::now().timestamp();
    if s.active(minute_of_day(), weekday_of_ts(now)).is_none() {
        return Err("现在不在睡眠时段里，不用解锁".into());
    }
    if s.unlock_price <= 0 {
        return Err("这段睡眠没有开启积分解锁".into());
    }
    let mins = if minutes == 0 { s.unlock_min } else { minutes.clamp(5, 240) };
    let price = s.unlock_price * mins as i64;
    if c.points.balance < price {
        return Err(format!(
            "积分不够：需要 {price} 分，你现在有 {} 分",
            c.points.balance
        ));
    }
    c.points.balance -= price;
    c.points.unlock_count_today += 1;
    let until = Local::now().timestamp() + mins as i64 * 60;
    c.points.unlock_until = until;
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c.clone();
    }
    // 已经排队关机的，赶紧撤回
    abort_shutdown();
    *arm_slot().lock().unwrap() = None;
    Ok(json!({
        "ok": true,
        "spent": price,
        "balance": c.points.balance,
        "until": until,
        "minutes": mins,
    }))
}

/// 每秒一次：推进状态机、开关锁屏窗口、到点关机。
pub fn start(app: tauri::AppHandle, shared: Arc<Shared>) {
    std::thread::spawn(move || {
        let mut shown = false;
        loop {
            let ts = Local::now().timestamp();
            // 系统睡过去了（合盖 / 休眠）：这一轮重新给满倒计时
            let last = last_tick().load(Ordering::Relaxed);
            let resumed = last > 0 && ts - last > RESUME_GAP_SECS;
            if resumed {
                *arm_slot().lock().unwrap() = None;
            }
            last_tick().store(ts, Ordering::Relaxed);

            let cfg = shared.config();
            let s = &cfg.settings.sleep;
            let min = minute_of_day();
            let win = s.active(min, weekday_of_ts(ts));
            let in_window = win.is_some();
            let unlocked = ts < cfg.points.unlock_until;
            // 这一轮属于哪一段：用段起点当 key（同一段在整轮里恒定不变）
            let seg_key = win.as_ref().map(|w| window_start_of(w, ts)).unwrap_or(0);

            // ① 武装 / 解除
            {
                let mut a = arm_slot().lock().unwrap();
                if !in_window || unlocked {
                    *a = None;
                } else if a.map(|x| x.key != seg_key).unwrap_or(true) {
                    // key 变了 = 换了一段（或刚进来）：重新给满倒计时。
                    // 起点取「开机时刻」和「这一段开始时刻」里较晚的那个：
                    // 开机 2 分钟就进睡眠时段 → 还剩 8 分钟；时段开始后才开机 → 从开机算。
                    // 这样才真的是"开机后 N 分钟内关机"，而不是"软件启动后 N 分钟"。
                    let started = boot_ts(ts).max(seg_key).min(ts);
                    *a = Some(Arm { start: started, fired: false, key: seg_key , ..Default::default() });
                }
            }
            let st = state_at(&cfg, ts, *arm_slot().lock().unwrap());

            // ② 到点关机（只发一次）
            if st.locked && st.remain <= 0 && !st.fired && st.will_shutdown {
                if let Some(a) = arm_slot().lock().unwrap().as_mut() {
                    a.fired = true;
                }
                fire_shutdown();
                crate::notify::toast(
                    &app,
                    "app",
                    "睡眠时段",
                    "<b>倒计时结束</b><br>睡眠时段内这台电脑应该已经关掉了，30 秒后关机。",
                    "睡眠管理",
                    8,
                );
            }
            // ③ 锁屏窗口：锁定期间常驻最上层，并且每 5 秒抢一次焦点
            //    （别的置顶窗口弹出来就会盖住它，那这层锁就形同虚设）
            let want = st.locked;
            if let Some(w) = app.get_webview_window("sleep") {
                if want {
                    if !shown {
                        let _ = w.show();
                        shown = true;
                    }
                    let _ = w.set_always_on_top(true);
                    if ts % 5 == 0 {
                        let _ = w.set_focus();
                    }
                } else if shown {
                    let _ = w.hide();
                    shown = false;
                }
            }

            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_sleep(from: u32, to: u32) -> Config {
        let mut c = Config::default();
        c.settings.sleep.enabled = true;
        c.settings.sleep.from = from;
        c.settings.sleep.to = to;
        c.settings.sleep.countdown_min = 10;
        c
    }

    /// 跨夜：23:00–07:00 覆盖 23:30 与 02:00，不覆盖 12:00
    #[test]
    fn window_wraps_midnight() {
        let c = with_sleep(23 * 60, 7 * 60);
        assert!(c.settings.sleep.covers_minute(23 * 60 + 30));
        assert!(c.settings.sleep.covers_minute(2 * 60));
        assert!(!c.settings.sleep.covers_minute(12 * 60));
        assert!(!c.settings.sleep.covers_minute(7 * 60), "右开区间，07:00 已经结束");
    }

    /// 起止相同 = 没有睡眠时段（不能理解成 24 小时，否则半夜开机就被关机）
    #[test]
    fn empty_window_never_covers() {
        let c = with_sleep(9 * 60, 9 * 60);
        for m in [0, 8 * 60, 9 * 60, 23 * 60] {
            assert!(!c.settings.sleep.covers_minute(m), "{m}");
        }
    }

    /// 倒计时：武装之后 remain 递减，归零后过期
    #[test]
    fn countdown_reaches_zero() {
        let mut c = with_sleep(0, 1440);
        c.settings.sleep.countdown_min = 10;
        let ts = Local::now().timestamp();
        let st = state_at(&c, ts, Some(Arm { start: ts - 60, fired: false , ..Default::default() }));
        // 已经过了 1 分钟 → 还剩 9 分钟（允许 ±2 秒的取整误差）
        assert!((st.remain - 9 * 60).abs() <= 2, "{}", st.remain);
        let st2 = state_at(&c, ts, Some(Arm { start: ts - 11 * 60, fired: false , ..Default::default() }));
        assert!(st2.remain < 0, "超过 10 分钟就该到点了");
    }

    /// 积分解锁期间：不锁、不关机
    #[test]
    fn unlock_suppresses_lock() {
        let mut c = with_sleep(0, 1440);
        let ts = Local::now().timestamp();
        c.points.unlock_until = ts + 600;
        let st = state_at(&c, ts, Some(Arm { start: ts, fired: false , ..Default::default() }));
        assert!(st.in_window);
        assert!(!st.locked, "解锁期间不该锁");
        assert_eq!(st.deadline, 0, "解锁期间不该有倒计时");
    }

    /// 锁定期间：既改不了设置（save_config 那一层），也不许退出程序
    #[test]
    fn exit_is_blocked_while_locked() {
        let mut c = with_sleep(0, 1440);
        let ts = Local::now().timestamp();
        assert!(locked_by_cfg(&c, ts));
        let now = Local::now().naive_local();
        let why = crate::guard::exit_blocked_at(&c, now);
        assert!(why.is_some(), "睡眠锁定期间必须禁止退出");

        // 解锁之后立刻放行
        c.points.unlock_until = ts + 600;
        assert!(!locked_by_cfg(&c, ts));
        assert!(crate::guard::exit_blocked_at(&c, now).is_none());
    }

    /* ── 多段睡眠 ── */

    fn multi_cfg() -> Config {
        let mut c = Config::default();
        c.settings.sleep.enabled = true;
        c.settings.sleep.windows = vec![
            // 午睡：不锁屏、只关机（5 分钟），这不是笔误——两段本来就该能配不同策略
            SleepWindow {
                id: "nap".into(),
                from: 13 * 60,
                to: 14 * 60,
                lock_screen: false,
                shutdown: true,
                countdown_min: 5,
                ..Default::default()
            },
            SleepWindow {
                id: "night".into(),
                from: 23 * 60,
                to: 7 * 60,
                lock_screen: true,
                shutdown: true,
                countdown_min: 10,
                ..Default::default()
            },
        ];
        c
    }

    /// 多段：各自命中自己的时间，跨夜那段也能命中凌晨
    #[test]
    fn multi_segments_hit_their_own_time() {
        let c = multi_cfg();
        let s = &c.settings.sleep;
        assert_eq!(s.active(13 * 60 + 30, 0).map(|w| w.id), Some("nap".into()));
        assert_eq!(s.active(23 * 60 + 30, 0).map(|w| w.id), Some("night".into()));
        // 周一凌晨 02:00 属于"周日入夜"那一轮 → 每天生效，照样命中
        assert_eq!(s.active(2 * 60, 0).map(|w| w.id), Some("night".into()));
        assert!(s.active(9 * 60, 0).is_none(), "09:00 两段都不在");
    }

    /// 每段的锁屏策略是独立的：午睡不锁屏，夜间锁
    #[test]
    fn lock_policy_is_per_segment() {
        let c = multi_cfg();
        let ts_at = |h: u32| {
            let n = Local::now();
            Local
                .with_ymd_and_hms(n.year(), n.month(), n.day(), h, 30, 0)
                .single()
                .unwrap()
                .timestamp()
        };
        assert!(!locked_by_cfg(&c, ts_at(13)), "午睡段关了锁屏，不该锁");
        assert!(locked_by_cfg(&c, ts_at(23)), "夜间段开着锁屏，必须锁");
    }

    /// 老配置（windows 为空）仍然走单段语义，一个字段都没变
    #[test]
    fn legacy_single_segment_still_works() {
        let c = with_sleep(23 * 60, 7 * 60);
        let s = &c.settings.sleep;
        assert!(s.windows.is_empty());
        assert_eq!(s.segments().len(), 1);
        assert!(s.active(2 * 60, 0).is_some());
        assert!(s.active(12 * 60, 0).is_none());
    }

    /// 多段覆盖了旧字段时，旧字段不再参与判定（避免"两套真相"）
    #[test]
    fn windows_override_legacy_fields() {
        let mut c = multi_cfg();
        c.settings.sleep.from = 9 * 60;
        c.settings.sleep.to = 10 * 60;
        let s = &c.settings.sleep;
        assert!(s.active(9 * 60 + 30, 0).is_none(), "旧字段不该再生效");
        assert!(s.active(13 * 60 + 30, 0).is_some());
    }

    /* ── 生效周期三模式 ── */

    /// 三种模式的判定投影：每天 / 仅工作日 / 指定
    #[test]
    fn cycle_mode_projection() {
        let mut w = SleepWindow::default();
        assert_eq!(w.cycle_mode(), "everyday");

        w.set_cycle_mode("workdays", None);
        assert_eq!(w.days, vec![0, 1, 2, 3, 4]);
        assert_eq!(w.cycle_mode(), "workdays");

        w.set_cycle_mode("custom", Some(&[6, 5]));
        assert_eq!(w.days, vec![5, 6], "自定义要先排序");
        assert_eq!(w.cycle_mode(), "custom");

        w.set_cycle_mode("everyday", None);
        assert!(w.days.is_empty());
        assert_eq!(w.cycle_mode(), "everyday");
    }

    /// custom 没有历史时给「周一三五」——不能给工作日全集，否则投影回 workdays，
    /// 用户点了"指定"却发现按钮跳回去，会以为没生效。
    #[test]
    fn custom_default_is_not_workdays() {
        let mut w = SleepWindow::default();
        w.set_cycle_mode("custom", None);
        assert_eq!(w.days, vec![0, 2, 4]);
        assert_eq!(w.cycle_mode(), "custom");
    }

    /// 反过来：用户在 custom 里手动勾成工作日全集时，投影就是 workdays。
    /// 这是**有意**的等价——同一个集合不该有两种说法。
    #[test]
    fn custom_matching_workdays_projects_to_workdays() {
        let mut w = SleepWindow::default();
        w.set_cycle_mode("custom", Some(&[0, 1, 2, 3, 4]));
        assert_eq!(w.cycle_mode(), "workdays");
    }

    /// 切模式**只动 days**，不许把时间/开关改掉（这是最容易写错的地方）
    #[test]
    fn cycle_switch_keeps_time_and_flags() {
        let mut w = SleepWindow {
            from: 22 * 60 + 30,
            to: 6 * 60 + 15,
            lock_screen: false,
            shutdown: false,
            countdown_min: 42,
            ..Default::default()
        };
        let before = (w.from, w.to, w.lock_screen, w.shutdown, w.countdown_min);
        w.set_cycle_mode("workdays", None);
        w.set_cycle_mode("custom", Some(&[2]));
        w.set_cycle_mode("everyday", None);
        assert_eq!(
            (w.from, w.to, w.lock_screen, w.shutdown, w.countdown_min),
            before
        );
    }

    /// 从"指定"切走再切回：恢复上一次的自定义集合，而不是清空或给工作日
    #[test]
    fn custom_mode_remembers_last_set() {
        let mut w = SleepWindow::default();
        w.set_cycle_mode("custom", Some(&[6, 0, 3]));
        assert_eq!(w.days, vec![0, 3, 6]);
        w.set_cycle_mode("everyday", None);
        assert!(w.days.is_empty());
        // 界面会把上一次的自定义集合传回来
        w.set_cycle_mode("custom", Some(&[0, 3, 6]));
        assert_eq!(w.days, vec![0, 3, 6]);
    }

    /// 跨夜 + 按星期：days 标的是**开始日**。
    /// 周一 23:00–07:00 → 周二凌晨 02:00 仍属于周一那轮；周一凌晨 02:00 不属于。
    #[test]
    fn cross_night_days_bind_to_start_day() {
        let mut w = SleepWindow {
            from: 23 * 60,
            to: 7 * 60,
            days: vec![0],
            ..Default::default()
        };
        assert!(w.covers(23 * 60 + 30, 0), "周一 23:30 = 周一那轮");
        assert!(w.covers(2 * 60, 1), "周二 02:00 仍是周一那轮");
        assert!(!w.covers(2 * 60, 0), "周一 02:00 是周日那轮，没标");
        assert!(!w.covers(23 * 60 + 30, 1), "周二 23:30 不在这轮的星期里");

        // 不跨夜时，星期就是当天
        w.from = 13 * 60;
        w.to = 14 * 60;
        assert!(w.covers(13 * 60 + 30, 0));
        assert!(!w.covers(13 * 60 + 30, 1));
    }

    /// 仅工作日：周六不触发、周五触发
    #[test]
    fn workdays_skip_weekend() {
        let mut w = SleepWindow {
            from: 23 * 60,
            to: 7 * 60,
            ..Default::default()
        };
        w.set_cycle_mode("workdays", None);
        assert!(w.covers(23 * 60 + 30, 4), "周五晚上该生效");
        assert!(!w.covers(23 * 60 + 30, 5), "周六晚上不该生效");
        // 周六凌晨属于周五那轮 → 仍然生效（周五晚睡到周六早上）
        assert!(w.covers(2 * 60, 5), "周六凌晨是周五那轮，必须生效");
    }

    /// 段被禁用 / 空段 → 不参与判定，也不会让整张表失效
    #[test]
    fn disabled_or_empty_segments_are_ignored() {
        let mut c = multi_cfg();
        c.settings.sleep.windows[1].enabled = false;
        let s = &c.settings.sleep;
        assert!(s.active(23 * 60 + 30, 0).is_none(), "禁用段不该命中");
        assert!(s.active(13 * 60 + 30, 0).is_some(), "其它段照常");

        c.settings.sleep.windows[0].to = c.settings.sleep.windows[0].from;
        assert!(c.settings.sleep.active(13 * 60 + 30, 0).is_none(), "空段不该命中");
    }

    /// 关掉睡眠开关 → 什么都不发生
    #[test]
    fn disabled_never_locks() {
        let mut c = with_sleep(0, 1440);
        c.settings.sleep.enabled = false;
        let ts = Local::now().timestamp();
        let st = state_at(&c, ts, Some(Arm { start: ts, fired: false , ..Default::default() }));
        assert!(!st.in_window);
        assert!(!st.locked);
    }
}
