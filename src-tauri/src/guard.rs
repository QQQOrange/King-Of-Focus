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
    let now = Local::now();
    let nd = now.naive_local();
    let ts = now.timestamp();

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
    for l in cfg.lists.iter() {
        if !l.enabled || !l.hard {
            continue;
        }
        if !sched::is_active(&l.schedule, &nd) {
            continue;
        }
        // 安全闸：没有明确结束时间的规则（全天生效）不参与固化，
        // 否则会把自己永久锁死，只有等到明天才有解。
        let left = match sched::slot_left_secs(&l.schedule, &nd) {
            Some(v) if v > 0 => v,
            _ => continue,
        };
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
        let info = lock_info(&cfg::load());
        if !info.locked {
            break; // 时段结束 / 积分解锁 → 守护自己退出
        }
        if heartbeat_age() > 8 {
            if restarts >= 40 {
                break; // 防止无限拉起
            }
            restarts += 1;
            if let Ok(exe) = std::env::current_exe() {
                let _ = Command::new(exe).spawn();
            }
            // 给新进程一点时间写心跳
            thread::sleep(Duration::from_secs(4));
        }
    }
    let _ = std::fs::remove_file(pid_path());
    let _ = std::fs::remove_file(hb_path());
}

/// 停止守护（解锁后调用）
pub fn stop_guard() {
    let _ = std::fs::remove_file(hb_path());
    if let Some(p) = existing_guard() {
        proc::terminate(p);
    }
    let _ = std::fs::remove_file(pid_path());
}
