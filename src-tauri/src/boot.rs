//! 安全模式：连续几次「启动后很快就没了」之后，先活下来再说。
//!
//! 为什么需要它：`panic = "abort"`，一旦某条规则 / 某个钩子让程序在启动阶段崩掉，
//! 用户看到的是"双击没反应"或者"闪一下就没了"，而**每次启动都会再崩一次**，
//! 他连设置页都进不去，只能删配置文件重来。
//!
//! 判定：两次启动间隔 < 120 秒算一次"异常启动"（正常用一会儿再重开不算）。
//! 连续 3 次 → 安全模式：不拦、不遮罩、不自动打开，但统计照常记录，
//! 界面顶部挂一条红色提示，让人先能进来把坏规则改掉。
//!
//! 退出安全模式有两条路：
//!   · 这次启动活过 90 秒（后台线程调 `mark_ok`）；
//!   · 用户自己在界面上点「退出安全模式」。

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

static SAFE: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct Boot {
    /// 连续异常启动次数
    attempts: u32,
    /// 上一次启动的时间（unix 秒）
    last: i64,
}

fn path() -> std::path::PathBuf {
    crate::cfg::data_dir().join("boot.json")
}

fn load() -> Boot {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(b: &Boot) {
    if let Ok(s) = serde_json::to_string(b) {
        let _ = std::fs::write(path(), s);
    }
}

/// 启动时调用一次，返回"这是连续第几次异常启动"。
pub fn begin() -> u32 {
    let now = chrono::Local::now().timestamp();
    let mut b = load();
    // 隔了 2 分钟以上再开，说明上一次是正常用过的（哪怕没跑 mark_ok）
    b.attempts = if b.last > 0 && now - b.last < 120 {
        b.attempts.saturating_add(1)
    } else {
        1
    };
    b.last = now;
    save(&b);
    if b.attempts >= 3 {
        SAFE.store(true, Ordering::Relaxed);
    }
    b.attempts
}

/// 活过一段时间之后调用：清零计数、退出安全模式。
pub fn mark_ok() {
    let mut b = load();
    if b.attempts != 0 {
        b.attempts = 0;
        save(&b);
    }
    SAFE.store(false, Ordering::Relaxed);
}

pub fn safe() -> bool {
    SAFE.load(Ordering::Relaxed)
}

/// 用户在界面上主动退出安全模式
pub fn leave() {
    mark_ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 两次间隔很短才累加() {
        // 纯逻辑版本，避免测试去读真实数据目录
        fn next(prev_attempts: u32, prev_last: i64, now: i64) -> u32 {
            if prev_last > 0 && now - prev_last < 120 {
                prev_attempts.saturating_add(1)
            } else {
                1
            }
        }
        assert_eq!(2, next(1, 1000, 1100));
        assert_eq!(1, next(5, 1000, 2000));
        assert_eq!(1, next(0, 0, 1000));
    }
}
