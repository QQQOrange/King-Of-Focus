//! 自律固化（硬核锁定）：锁定判定、守护进程互保、任务管理器封杀
//!
//! 锁定期间：
//!   · 不能退出程序（托盘 / 命令都会被拒绝）
//!   · 不能修改任何设置（save_config 直接报错）
//!   · 任务管理器 / Process Hacker / 注册表编辑器 等工具会被立刻关闭
//!   · 主进程被杀掉时，`--guard` 守护进程会在 2 秒内把它拉起来
//!
//! 解除只有两条路：时段自然结束，或者用积分解锁。

use crate::cfg;
use crate::model::Config;
use crate::proc;
use crate::sched;
use chrono::Local;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::Duration;

pub const BANNED_PROCS: [&str; 9] = [
    "taskmgr",
    "procexp",
    "procexp64",
    "processhacker",
    "systeminformer",
    "msconfig",
    "regedit",
    "autoruns",
    "autorunsc",
];

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

#[derive(Clone, Debug, Default)]
pub struct LockInfo {
    pub locked: bool,
    /// 触发锁定的规则名
    pub names: Vec<String>,
    /// 本轮锁定结束时间戳（时段结束）
    pub until: i64,
    /// 界面上显示的 "21:30"
    pub until_text: String,
    /// 积分解锁到什么时候
    pub unlocked_until: i64,
}

pub fn lock_info(cfg: &Config) -> LockInfo {
    lock_info_at(cfg, Local::now().naive_local())
}

/// 与 `lock_info` 相同，但"现在"可以指定（便于测试）。
pub fn lock_info_at(cfg: &Config, nd: chrono::NaiveDateTime) -> LockInfo {
    // 测试模式：自律开关随时可用，不做任何固化锁定
    if crate::testmode::on() {
        return LockInfo::default();
    }
    let ts = nd.and_local_timezone(Local).single().map(|x| x.timestamp()).unwrap_or_else(|| Local::now().timestamp());

    // 用积分解锁期间：一律不锁
    if ts < cfg.points.unlock_until {
        let d = chrono::DateTime::from_timestamp(cfg.points.unlock_until, 0)
            .map(|x| x.with_timezone(&Local))
            .map(|x| x.format("%H:%M:%S").to_string())
            .unwrap_or_default();
        return LockInfo {
            locked: false,
            names: vec![],
            until: 0,
            until_text: d.clone(),
            unlocked_until: cfg.points.unlock_until,
        };
    }

    let mut names = Vec::new();
    let mut until = 0i64;
    // 固化（硬锁）是黑名单条目的属性，因此同样**只在自律时间生效**：
    // 自律时段之外用户是自由的，这时候还锁着退出/设置，只会让人觉得
    // 软件在乱管闲事。门槛用 clock_on（专注段），休息段不锁。
    let d = crate::discipline::state(cfg, &nd);
    if !d.clock_on {
        return LockInfo::default();
    }
    for l in cfg.lists.iter() {
        if !l.enabled || !l.hard {
            continue;
        }
        // 条目自己的时间范围是"自律时间内的二次收窄"
        let w = &l.schedule;
        let any = w.iter().any(|day| !day.is_empty());
        if any && !sched::is_active(w, &nd) {
            continue;
        }
        // 安全闸：没有明确结束时间的条目（全天生效）不参与固化，
        // 否则会把自己永久锁死，只有等到明天才有解。
        // 用自律时段本身的结束时间兜底，保证一定有一个"自然解封"的时刻。
        let left = match sched::slot_left_secs(w, &nd) {
            Some(v) if v > 0 => v,
            _ => d.clock_left.max(0),
        };
        if left <= 0 {
            continue;
        }
        names.push(l.name.clone());
        until = until.max(ts + left);
    }
    let until_text = chrono::DateTime::from_timestamp(until, 0)
        .map(|x| x.with_timezone(&Local))
        .map(|x| x.format("%H:%M").to_string())
        .unwrap_or_default();
    LockInfo {
        locked: !names.is_empty(),
        names,
        until,
        until_text,
        unlocked_until: 0,
    }
}

pub fn is_locked(shared: &crate::shared::Shared) -> bool {
    lock_info(&shared.config()).locked
}

/// 自律时段内：拒绝"削弱纪律"的设置改动。
///
/// 只拦真正会让**当前这段自律**失效的改动：
///   · 关掉 / 打开「自律时段」总开关（时段内两个方向都锁死）
///   · 关掉「时段内让已启用规则立即生效」
///   · 切换 / 删除正在生效的那套「星期时段」方案
///   · 取消已经选中的时段（含"清空全部"）
///   · 改掉正在生效的这一小时的专注 / 休息时长（防止"改时长"逃逸）
///   · 动任何一条规则的启用开关（开、关都不行）、删掉已启用的规则
///
/// 门槛用 `clock_in`（含休息段）而不是 `clock_on`：
/// 一个 50/10 的小时段里每分钟都在开关状态之间跳，
/// 只在专注段锁定等于"每小时给你 10 分钟随便改"。
///
/// 其它设置（外观、统计、提醒……）照常可改——固化锁定之外不该把软件变成石头。
/// 测试模式下随时可调（测试模式的意义本来就是"随时开关"）。
pub fn discipline_violation(old: &Config, new: &Config) -> Option<String> {
    if crate::testmode::on() {
        return None;
    }
    discipline_violation_at(old, new, crate::sched::now_local())
}

/// 与 `discipline_violation` 相同，但"现在"可以指定（便于测试）。
pub fn discipline_violation_at(
    old: &Config,
    new: &Config,
    now: chrono::NaiveDateTime,
) -> Option<String> {
    let d = crate::discipline::state(old, &now);
    if !d.clock_in {
        return None; // 不在自律时段内 → 随便改
    }

    let oc = &old.settings.focus_clock;
    let nc = &new.settings.focus_clock;

    // 1) 总开关两个方向都不能动（时段内它只能保持"开"）
    if oc.enabled != nc.enabled {
        return Some(if nc.enabled {
            "自律时段生效中，总开关已锁定，等这一段结束再改".into()
        } else {
            "自律时段生效中，不能关闭「自律时段」总开关".into()
        });
    }
    // 2) "时段内让规则立即生效"不能关
    if oc.apply_rules && !nc.apply_rules {
        return Some("自律时段生效中，不能关闭「时段内让已启用的黑名单立即生效」".into());
    }
    // 2.5) 「自律时段内允许退出」是单向的：时段内只能往"更严"改。
    //      关掉它可以（那是在加强纪律），但时段内不能再打开——
    //      否则这一整条"退出禁令"就成了摆设：点一下开关就绕过去了。
    if !old.settings.allow_quit_in_session && new.settings.allow_quit_in_session {
        return Some("自律时段生效中，不能重新打开「自律时段内允许退出」".into());
    }
    // 3) 正在生效的那套方案不能被切走 / 删掉
    let old_id = oc.active_profile().map(|p| p.id.clone()).unwrap_or_default();
    let new_id = nc.active_profile().map(|p| p.id.clone()).unwrap_or_default();
    if old_id != new_id {
        return Some("自律时段生效中，不能切换「星期时段」方案".into());
    }
    let (Some(od), Some(nd)) = (oc.active_days(), nc.active_days()) else {
        return Some("自律时段生效中，不能删除正在生效的「星期时段」方案".into());
    };
    // 4) 已选中的时段不能取消
    for (d_i, day) in od.iter().enumerate() {
        for (h_i, p) in day.iter().enumerate() {
            if !p.on {
                continue;
            }
            let still_on = nd
                .get(d_i)
                .and_then(|d2| d2.get(h_i))
                .map(|p2| p2.on)
                .unwrap_or(false);
            if !still_on {
                return Some(format!(
                    "自律时段生效中，不能取消已选中的时段（{} {}:00）",
                    crate::clock::WEEKDAY_NAMES.get(d_i).copied().unwrap_or("?"),
                    h_i
                ));
            }
        }
    }
    // 5) 正在生效的这一小时，专注 / 休息时长不能改（否则等于用"改时长"逃逸）
    if d.clock_weekday < 7 && d.clock_hour < 24 {
        let op = od.get(d.clock_weekday as usize).and_then(|x| x.get(d.clock_hour as usize));
        let np = nd.get(d.clock_weekday as usize).and_then(|x| x.get(d.clock_hour as usize));
        if let (Some(op), Some(np)) = (op, np) {
            if (op.work, op.brk) != (np.work, np.brk) {
                return Some(format!(
                    "自律时段生效中，不能改这一小时（{} {}:00）的专注 / 休息时长",
                    crate::clock::WEEKDAY_NAMES.get(d.clock_weekday as usize).copied().unwrap_or("?"),
                    d.clock_hour
                ));
            }
        }
    }
    // 6) 规则的启用开关：时段内一律锁死（开、关都不行）
    for l in &old.lists {
        match new.lists.iter().find(|x| x.id == l.id) {
            None => {
                if l.enabled {
                    return Some(format!("自律时段生效中，不能删除黑名单「{}」", l.name));
                }
            }
            Some(nl) if nl.enabled != l.enabled => {
                return Some(if l.enabled {
                    format!("自律时段生效中，不能关闭黑名单「{}」", l.name)
                } else {
                    format!("自律时段生效中，黑名单开关已锁定，不能开启黑名单「{}」", l.name)
                });
            }
            _ => {}
        }
    }
    // 6) 名单内容也不能偷偷删：删掉一条黑名单 = 放行一个软件 / 一个网站，
    //    再加一条"网站例外" = 同样放行。只挡删，不挡加（加条目是加强纪律）。
    for l in &old.lists {
        if !l.enabled {
            continue;
        }
        let Some(nl) = new.lists.iter().find(|x| x.id == l.id) else {
            continue; // 整条规则被删，上面第 5 条已经拦过
        };
        for a in &l.apps {
            if !nl.apps.iter().any(|x| x.id == a.id) {
                let name = if a.label.is_empty() { &a.value } else { &a.label };
                return Some(format!(
                    "自律时段生效中，不能从黑名单「{}」里删掉软件「{}」",
                    l.name, name
                ));
            }
        }
        for s in &l.sites {
            if !nl.sites.iter().any(|x| x.id == s.id) {
                let name = if s.label.is_empty() { &s.pattern } else { &s.label };
                return Some(format!(
                    "自律时段生效中，不能从黑名单「{}」里删掉网站「{}」",
                    l.name, name
                ));
            }
        }
        for e in &nl.exceptions {
            if !l.exceptions.iter().any(|x| x.eq_ignore_ascii_case(e)) {
                return Some(format!(
                    "自律时段生效中，不能给黑名单「{}」新增网站例外「{}」",
                    l.name, e
                ));
            }
        }
    }
    None
}

/// 整份配置被"外部来源"覆盖时的守卫（备份恢复 / 云同步下载）。
///
/// 这两个入口以前是直接 `cfg::save`，完全绕过 `save_config` 的校验：
/// 自律时段里恢复一份「规则已关闭」的旧备份、或者自动同步拉到别的设备上
/// 那份还没开规则的配置，等于一键绕过纪律。现在统一走这里判断。
pub fn config_replace_blocked(old: &Config, new: &Config) -> Option<String> {
    if crate::testmode::on() {
        return None;
    }
    let info = lock_info(old);
    if info.locked {
        return Some(format!(
            "自律固化中（{} 结束），现在不能整份覆盖配置",
            if info.until_text.is_empty() { "本时段".to_string() } else { info.until_text }
        ));
    }
    discipline_violation(old, new)
}

/// 现在能不能退出程序。
///
/// 两种情况不允许退出：
///   · 固化锁定中（硬锁，规则的"固化"开关打开时）
///   · 自律时段正在专注（休息段不算——休息本来就不是自律时间）
pub fn exit_blocked(cfg: &Config) -> Option<String> {
    if crate::testmode::on() {
        return None;
    }
    exit_blocked_at(cfg, crate::sched::now_local())
}

/// 与 `exit_blocked` 相同，但"现在"可以指定（便于测试）。
pub fn exit_blocked_at(cfg: &Config, now: chrono::NaiveDateTime) -> Option<String> {
    // 注意用带 `now` 的那个版本：早期这里读的是真实时钟，
    // 导致"可注入时间"的函数在测试里行为随运行时刻变化。
    let info = lock_info_at(cfg, now);
    if info.locked {
        return Some(format!(
            "自律固化中（{} 结束），现在不能退出程序",
            if info.until_text.is_empty() { "本时段".to_string() } else { info.until_text }
        ));
    }
    let d = crate::discipline::state(cfg, &now);
    if d.clock_in {
        // 设置里允许在自律时段内退出 → 不再拦关窗口
        if cfg.settings.allow_quit_in_session {
            return None;
        }
        let mins = (d.clock_left / 60).max(1);
        return Some(format!(
            "自律时段内已禁止退出（约 {mins} 分钟后结束）",
        ));
    }
    None
}

/// 自律时段内是否被"禁止退出"锁住。
///
/// 条件只有两个：设置里关掉了「自律时段内允许退出」，且现在落在生效时段里。
///
/// 判定用 `clock_in`（整个生效时段，含休息段）而不是 `clock_on`（专注段）：
/// 用户在设置里读到的文案是"自律时间内能不能退出"，休息那几分钟同样属于
/// 这段时间，不能因为"正好在休息"就允许退出——那等于留了个后门。
///
/// 固化（`lock_info`）是另一套机制，不在这里管：固化期间本来就另有守卫，
/// 而强制退出正是用户从固化里出来的通道，这条通道不能被这个开关一起关掉。
pub fn session_quit_locked(cfg: &Config) -> bool {
    if crate::testmode::on() {
        return false;
    }
    if cfg.settings.allow_quit_in_session {
        return false;
    }
    crate::discipline::state(cfg, &crate::sched::now_local()).clock_in
}

/// 被「禁止退出」挡住时给用户看的说明；没被挡住返回 None
pub fn session_quit_hint(cfg: &Config) -> Option<String> {
    if !session_quit_locked(cfg) {
        return None;
    }
    let d = crate::discipline::state(cfg, &crate::sched::now_local());
    let mins = (d.clock_left / 60).max(1);
    Some(format!(
        "自律时段正在生效（约 {mins} 分钟后结束），设置里关掉了「自律时段内允许退出」，现在无法退出"
    ))
}

// ---------------- 守护进程 ----------------

fn hb_path() -> PathBuf {
    cfg::data_dir().join("guard.hb")
}

fn pid_path() -> PathBuf {
    cfg::data_dir().join("guard.pid")
}

pub fn write_heartbeat() {
    let ts = Local::now().timestamp().to_string();
    let _ = std::fs::write(hb_path(), ts);
}

fn heartbeat_age() -> i64 {
    match std::fs::read_to_string(hb_path()) {
        Ok(s) => match s.trim().parse::<i64>() {
            Ok(t) => Local::now().timestamp() - t,
            Err(_) => 9999,
        },
        Err(_) => 9999,
    }
}

fn existing_guard() -> Option<u32> {
    std::fs::read_to_string(pid_path())
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|p| proc::is_alive(*p))
}

/// 确保守护进程在跑（只在锁定时调用）
pub fn ensure_guard() {
    if existing_guard().is_some() {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        let _ = Command::new(exe)
            .arg("--guard")
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn();
    }
}

/// 守护进程主体（由 main 在 `--guard` 参数时调用）
pub fn guard_main() {
    // 已经有别的守护在跑就退出，避免越滚越多
    if let Some(p) = existing_guard() {
        if p != std::process::id() {
            return;
        }
    }
    let _ = std::fs::write(pid_path(), std::process::id().to_string());

    let mut restarts = 0u32;
    loop {
        thread::sleep(Duration::from_secs(2));
        // 主进程主动退出（强制退出）→ 不复活
        if quit_requested() {
            let _ = std::fs::remove_file(pid_path());
            let _ = std::fs::remove_file(hb_path());
            return;
        }
        let info = lock_info(&cfg::load());
        if !info.locked {
            break; // 时段结束 / 积分解锁 → 守护自己退出
        }
        if heartbeat_age() > 8 {
            if restarts >= 40 {
                break; // 防止无限拉起
            }
            restarts += 1;
            respawn_main();
            // 给新进程一点时间写心跳
            thread::sleep(Duration::from_secs(4));
        }
    }
    let _ = std::fs::remove_file(pid_path());
    let _ = std::fs::remove_file(hb_path());
}

/// 复活主进程。
///
/// 这里**不**直接调 ShellExecuteW 提权：守护进程是后台无窗口进程，
/// 由它弹 UAC 会在用户毫无预期的时候突然拦截屏幕。
/// 正确做法是普通拉起，让新主进程自己走 main() 里的提权流程
/// （带"120 秒内不重复弹窗"的失败标记）。
///
/// 另外：守护进程是主进程 spawn 出来的，**会继承主进程的权限**。
/// 主进程是管理员时，守护也是管理员，普通拉起出来的新主进程同样是管理员。
fn respawn_main() {
    if let Ok(exe) = std::env::current_exe() {
        // 带 --respawn 标记：新实例据此知道"我是被守护拉起来的，不是用户启动的"，
        // 于是不会清掉"别复活"哨兵（否则守护下一轮又能把它复活）。
        let _ = Command::new(exe).arg("--respawn").spawn();
    }
}

/// 停止守护（解锁后调用）
/// 强制退出哨兵：主进程准备退出时写下这个文件。
///
/// 为什么需要它：主进程杀掉守护进程和守护进程决定"要复活主进程"之间
/// 存在一个时间差。守护每 2 秒查一次心跳，心跳文件一旦消失（主进程刚死）
/// 它就可能正好在这一刻决定复活——用户看到的就是"强制退出之后程序又回来了"。
/// 哨兵文件让守护在复活前先看一眼：这个退出是**故意的**，别复活。
fn quit_sentinel_path() -> PathBuf {
    cfg::data_dir().join("guard.quit")
}

/// 写哨兵：告诉守护"主进程是主动退出的，不要复活"
pub fn mark_quitting() {
    let _ = std::fs::write(quit_sentinel_path(), "1");
    set_quitting();
}

/// 清除哨兵（正常启动时调用，避免上一次强制退出的残留影响本次运行）
pub fn clear_quit_sentinel() {
    let _ = std::fs::remove_file(quit_sentinel_path());
}

/// 守护是否被告知"不要复活"
fn quit_requested() -> bool {
    quit_sentinel_path().exists()
}

pub fn stop_guard() {
    let _ = std::fs::remove_file(hb_path());
    if let Some(p) = existing_guard() {
        proc::terminate(p);
    }
    let _ = std::fs::remove_file(pid_path());
}

/// 强制退出进行中：置位后不再写心跳、不再拉起守护。
///
/// 没有这个标志会有一个很典型的"按了强制退出，程序又回来了"：
/// 强制退出会杀掉守护进程，但监控线程下一轮（poll 周期 300–5000ms）
/// 发现"还在锁定中"→ 又 `ensure_guard()` 把守护拉起来 →
/// 守护发现主进程心跳断了 → 又把主进程复活。
/// 置位后监控线程不再喂心跳，守护自然会因为"时段结束/解锁"而退出。
static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 标记：程序正在强制退出
pub fn set_quitting() {
    QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// 是否正在强制退出
pub fn quitting() -> bool {
    QUITTING.load(std::sync::atomic::Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ClockCfg, Config, HourPlan, RuleList};

    fn now_at(weekday: u32, hour: u32, minute: u32) -> chrono::NaiveDateTime {
        // 2026-10-26 是周一（weekday=0）
        let base = chrono::NaiveDate::from_ymd_opt(2026, 10, 26).unwrap();
        (base + chrono::Duration::days(weekday as i64)).and_hms_opt(hour, minute, 0).unwrap()
    }

    /// 周三 10 点选中、60 分连续专注
    fn cfg_with_clock() -> Config {
        let mut c = Config::default();
        let mut days = vec![vec![HourPlan::default(); 24]; 7];
        days[2][10] = HourPlan { on: true, work: 60, brk: 0, from: 0, to: 60 };
        c.settings.focus_clock = ClockCfg::with_days(true, days);
        c.lists = vec![RuleList {
            id: "r1".into(),
            name: "测试规则".into(),
            enabled: true,
            ..RuleList::default()
        }];
        c
    }

    #[test]
    fn in_window_cannot_disable_clock_switch() {
        let old = cfg_with_clock();
        let mut new = old.clone();
        new.settings.focus_clock.enabled = false;
        let v = discipline_violation_at(&old, &new, now_at(2, 10, 30));
        assert!(v.is_some(), "自律时段内不能关总开关");
        assert!(v.unwrap().contains("总开关"));
    }

    #[test]
    fn in_window_clock_switch_is_exactly_locked() {
        // 时段内总开关只有"保持不变"这一个合法状态
        let old = cfg_with_clock();
        let now = now_at(2, 10, 30);
        let mut same = old.clone();
        same.settings.focus_clock.enabled = true;
        assert!(
            discipline_violation_at(&old, &same, now).is_none(),
            "值没变 → 不算改动"
        );
        let mut off = old.clone();
        off.settings.focus_clock.enabled = false;
        assert!(
            discipline_violation_at(&old, &off, now).is_some(),
            "关掉总开关必须被拒"
        );
    }

    #[test]
    fn break_segment_is_locked_too() {
        // 50/10 的小时段：10 分休息段内同样不许动开关，
        // 否则"每小时有 10 分钟可以随便改"等于没锁
        let mut c = Config::default();
        let mut days = vec![vec![HourPlan::default(); 24]; 7];
        days[2][10] = HourPlan { on: true, work: 40, brk: 20, from: 0, to: 60 };
        c.settings.focus_clock = ClockCfg::with_days(true, days);
        c.lists = vec![RuleList {
            id: "r1".into(),
            name: "测试规则".into(),
            enabled: true,
            ..RuleList::default()
        }];
        let now = now_at(2, 10, 45); // 40 分专注已过 → 休息段
        assert!(!crate::discipline::state(&c, &now).clock_on, "确实是休息段");
        let mut off = c.clone();
        off.settings.focus_clock.enabled = false;
        assert!(
            discipline_violation_at(&c, &off, now).is_some(),
            "休息段内也不能关总开关"
        );
        let mut rule_off = c.clone();
        rule_off.lists[0].enabled = false;
        assert!(
            discipline_violation_at(&c, &rule_off, now).is_some(),
            "休息段内也不能关规则"
        );
    }

    #[test]
    fn in_window_cannot_switch_or_delete_profile() {
        let mut old = cfg_with_clock();
        // 加第二套方案，当前仍用第一套
        let mut other = crate::model::ClockProfile::default();
        other.id = "p2".into();
        other.name = "另一套".into();
        other.days[2][10] = HourPlan { on: true, work: 60, brk: 0, from: 0, to: 60 };
        old.settings.focus_clock.profiles.push(other);

        let now = now_at(2, 10, 30);
        let mut sw = old.clone();
        sw.settings.focus_clock.active = "p2".into();
        assert!(
            discipline_violation_at(&old, &sw, now).is_some(),
            "时段内不能切走正在生效的方案"
        );

        let mut del = old.clone();
        del.settings.focus_clock.profiles.remove(0);
        del.settings.focus_clock.active = "p2".into();
        assert!(
            discipline_violation_at(&old, &del, now).is_some(),
            "时段内不能删掉正在生效的方案"
        );

        // 改另一套（不生效的那套）不受影响
        let mut edit_other = old.clone();
        edit_other.settings.focus_clock.profiles[1].days[4][20].on = true;
        assert!(
            discipline_violation_at(&old, &edit_other, now).is_none(),
            "改没生效的那套方案不该被拦"
        );
    }

    #[test]
    fn in_window_cannot_toggle_rule_switch() {
        let old = cfg_with_clock();
        let now = now_at(2, 10, 30);
        let mut off = old.clone();
        off.lists[0].enabled = false;
        assert!(discipline_violation_at(&old, &off, now).is_some(), "不能关");

        let mut off_old = old.clone();
        off_old.lists[0].enabled = false;
        let mut on_new = off_old.clone();
        on_new.lists[0].enabled = true;
        let v = discipline_violation_at(&off_old, &on_new, now);
        assert!(v.is_some(), "时段内连「打开规则」也锁死（开关整体不可动）");
        assert!(v.unwrap().contains("锁定"));
    }

    #[test]
    fn in_window_cannot_disable_apply_rules() {
        let old = cfg_with_clock();
        let mut new = old.clone();
        new.settings.focus_clock.apply_rules = false;
        assert!(discipline_violation_at(&old, &new, now_at(2, 10, 30)).is_some());
    }

    #[test]
    fn in_window_cannot_clear_selected_slots() {
        let old = cfg_with_clock();
        let mut new = old.clone();
        new.settings.focus_clock.profiles[0].days[2][10].on = false;
        assert!(discipline_violation_at(&old, &new, now_at(2, 10, 30)).is_some());
    }

    #[test]
    fn in_window_cannot_change_running_hour_duration() {
        let old = cfg_with_clock();
        let mut new = old.clone();
        new.settings.focus_clock.profiles[0].days[2][10].work = 5;
        assert!(discipline_violation_at(&old, &new, now_at(2, 10, 30)).is_some());
    }

    #[test]
    fn in_window_cannot_disable_or_delete_enabled_rule() {
        let old = cfg_with_clock();
        let mut new = old.clone();
        new.lists[0].enabled = false;
        assert!(discipline_violation_at(&old, &new, now_at(2, 10, 30)).is_some());
        let mut new2 = old.clone();
        new2.lists.clear();
        assert!(discipline_violation_at(&old, &new2, now_at(2, 10, 30)).is_some());
    }

    #[test]
    fn in_window_cannot_remove_entries_from_active_rule() {
        use crate::model::{AppEntry, SiteEntry};
        let mut old = cfg_with_clock();
        old.lists[0].apps = vec![AppEntry {
            id: "a1".into(),
            kind: "name".into(),
            value: "douyin".into(),
            label: "抖音".into(),
        }];
        old.lists[0].sites = vec![SiteEntry {
            id: "s1".into(),
            pattern: "douyin.com".into(),
            label: "抖音".into(),
        }];
        let now = now_at(2, 10, 30);

        // 删软件
        let mut n1 = old.clone();
        n1.lists[0].apps.clear();
        let v = discipline_violation_at(&old, &n1, now).expect("删软件应被拒绝");
        assert!(v.contains("抖音"), "{v}");

        // 删网站
        let mut n2 = old.clone();
        n2.lists[0].sites.clear();
        assert!(discipline_violation_at(&old, &n2, now).is_some(), "删网站应被拒绝");

        // 加网站例外
        let mut n3 = old.clone();
        n3.lists[0].exceptions.push("douyin.com".into());
        assert!(discipline_violation_at(&old, &n3, now).is_some(), "新增例外应被拒绝");

        // 只加不减 → 放行（加条目是加强纪律）
        let mut n4 = old.clone();
        n4.lists[0].sites.push(SiteEntry {
            id: "s2".into(),
            pattern: "bilibili.com".into(),
            label: "B站".into(),
        });
        assert!(discipline_violation_at(&old, &n4, now).is_none(), "新增条目不该被拦");
    }

    #[test]
    fn outside_window_all_changes_allowed() {
        let old = cfg_with_clock();
        let mut new = old.clone();
        new.settings.focus_clock.enabled = false;
        new.lists.clear();
        assert!(discipline_violation_at(&old, &new, now_at(2, 11, 30)).is_none());
    }

    #[test]
    fn unrelated_settings_always_allowed() {
        let old = cfg_with_clock();
        let mut new = old.clone();
        new.settings.theme = "light".into();
        new.settings.poll_ms = 2000;
        assert!(discipline_violation_at(&old, &new, now_at(2, 10, 30)).is_none());
    }

    /// 「自律时段内允许退出」是这次新增的开关，默认开（保持历史行为）。
    /// 判定要跟着开关走：开着不拦、关掉才拦，时段外永远放行。
    #[test]
    fn exit_blocked_follows_allow_quit_switch() {
        let mut c = cfg_with_clock();
        // 关掉固化（hard）再测：固化是另一套更硬的锁，会盖住这个开关的判定
        c.lists[0].hard = false;
        assert!(exit_blocked_at(&c, now_at(2, 10, 30)).is_none(), "默认允许退出，时段内也不该拦");
        c.settings.allow_quit_in_session = false;
        assert!(exit_blocked_at(&c, now_at(2, 10, 30)).is_some(), "关掉开关后时段内必须退不掉");
        assert!(exit_blocked_at(&c, now_at(2, 11, 30)).is_none(), "时段外仍然可以退出");
    }

    /// 休息段同样属于"自律时间"：不能因为正好在休息就允许退出，那是个后门。
    #[test]
    fn quit_lock_covers_break_segment() {
        let mut c = cfg_with_clock();
        c.lists[0].hard = false;
        c.settings.allow_quit_in_session = false;
        c.settings.focus_clock.profiles[0].days[2][10] =
            HourPlan { on: true, work: 40, brk: 20, from: 0, to: 60 };
        assert!(exit_blocked_at(&c, now_at(2, 10, 45)).is_some(), "休息段也属于自律时段");
    }

    /// 开关是单向的：时段内可以关掉（更严），不能再打开（那就是绕过退出禁令）。
    #[test]
    fn cannot_reopen_quit_switch_inside_window() {
        let mut old = cfg_with_clock();
        old.settings.allow_quit_in_session = false;
        let mut reopened = old.clone();
        reopened.settings.allow_quit_in_session = true;
        assert!(
            discipline_violation_at(&old, &reopened, now_at(2, 10, 30)).is_some(),
            "时段内不允许把退出权限放回来"
        );

        let mut old2 = cfg_with_clock();
        old2.settings.allow_quit_in_session = true;
        let mut hardened = old2.clone();
        hardened.settings.allow_quit_in_session = false;
        assert!(
            discipline_violation_at(&old2, &hardened, now_at(2, 10, 30)).is_none(),
            "时段内收紧（关掉允许退出）应该放行"
        );
    }

    /// `config_replace_blocked`（备份恢复 / 云同步下载）复用同一套判定，
    /// 这里锁住它依赖的两条语义：时段内不许削弱、时段外放行。
    #[test]
    fn weakening_config_rejected_inside_window() {
        let old = cfg_with_clock();
        let mut weakened = old.clone();
        weakened.lists[0].enabled = false;
        let now = now_at(2, 10, 30); // 周三 10:30，自律时段内
        assert!(
            discipline_violation_at(&old, &weakened, now).is_some(),
            "覆盖成'规则已关闭'的配置应被拒绝"
        );
    }

    #[test]
    fn equivalent_config_allowed_outside_window() {
        let old = cfg_with_clock();
        let now = now_at(2, 11, 30); // 时段外
        assert!(
            discipline_violation_at(&old, &old.clone(), now).is_none(),
            "同样的配置在时段外应放行"
        );
    }

    // ---- 固化（hard）只在自律时间生效：新语义的核心测试 ----

    /// 自律时间内 + 固化条目 → 锁定
    #[test]
    fn hard_lock_active_inside_discipline_time() {
        let mut c = cfg_with_clock();
        c.lists[0].hard = true;
        let info = lock_info_at(&c, now_at(2, 10, 30));
        assert!(info.locked, "自律时间内固化应生效：{info:?}");
        assert_eq!(info.names.len(), 1);
    }

    /// 自律时间外 + 固化条目 → **不锁**（黑名单只在自律时间生效）
    #[test]
    fn hard_lock_silent_outside_discipline_time() {
        let mut c = cfg_with_clock();
        c.lists[0].hard = true;
        // 周三 15 点：时钟只选了 10 点那段 → 不在自律时间
        let info = lock_info_at(&c, now_at(2, 15, 0));
        assert!(!info.locked, "自律时间外固化必须不生效：{info:?}");
    }

    /// 番茄休息段 → 不算自律时间，固化不生效
    #[test]
    fn hard_lock_silent_during_break() {
        let mut c = cfg_with_clock();
        c.lists[0].hard = true;
        // 把 10 点那段改成 40 专注 / 20 休息，10:45 落在休息段
        let mut days = vec![vec![HourPlan::default(); 24]; 7];
        days[2][10] = HourPlan { on: true, work: 40, brk: 20, from: 0, to: 60 };
        c.settings.focus_clock = ClockCfg::with_days(true, days);
        let info = lock_info_at(&c, now_at(2, 10, 45));
        assert!(!info.locked, "休息段不算自律时间，不该锁：{info:?}");
    }

    /// 退出拦截：关掉「自律时段内允许退出」后，时段内禁止退出、时段外放行
    #[test]
    fn exit_allowed_outside_discipline_time() {
        let mut c = cfg_with_clock();
        c.lists[0].hard = false;
        c.settings.allow_quit_in_session = false;
        // 自律时间内（周三 10:20）→ 禁退
        assert!(
            exit_blocked_at(&c, now_at(2, 10, 20)).is_some(),
            "自律时间内应禁止退出"
        );
        // 自律时间外（周三 15:00）→ 允许退出
        assert!(
            exit_blocked_at(&c, now_at(2, 15, 0)).is_none(),
            "自律时间外应允许退出"
        );
    }
}
