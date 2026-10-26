//! 测试模式
//!
//! 目标：**所有功能都真实生效**，唯一区别是自律模式可以随时开关，且数据与正式环境隔离。
//!
//! 隔离方式很直接——换数据目录：
//!   - 正式：`<软件目录>/king of focus data/`
//!   - 测试：`<软件目录>/king of focus data/test/`
//!
//! 配置、统计日报、报告全部落在各自的目录里，互不可见。退出测试模式时二选一：
//!   - 保留：把测试目录里的配置与统计合并回正式目录
//!   - 丢弃：直接删掉整个测试目录

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

static ON: AtomicBool = AtomicBool::new(false);

pub fn on() -> bool {
    ON.load(Ordering::Relaxed)
}

pub fn set(v: bool) {
    ON.store(v, Ordering::Relaxed);
}

/// 正式数据目录（不受测试模式影响）
pub fn prod_dir() -> PathBuf {
    crate::cfg::prod_data_dir()
}

/// 测试数据目录
pub fn test_dir() -> PathBuf {
    let d = prod_dir().join("test");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// 当前生效的数据目录
pub fn current_dir() -> PathBuf {
    if on() {
        test_dir()
    } else {
        prod_dir()
    }
}

/// 进入测试模式：用当前配置做一份"测试配置"的起点
pub fn enter() -> Result<(), String> {
    let td = test_dir();
    let tcfg = td.join("config.json");
    if !tcfg.exists() {
        // 以正式配置为模板，测试里改坏了也不影响正式
        let src = crate::cfg::config_path();
        if src.exists() {
            std::fs::copy(&src, &tcfg).map_err(|e| format!("创建测试配置失败：{e}"))?;
        }
    }
    set(true);
    Ok(())
}

/// 退出测试模式。`keep = true` 时把测试数据合并回正式环境。
pub fn exit(keep: bool) -> Result<(), String> {
    let td = test_dir();
    if keep {
        // 1) 配置：测试配置覆盖正式配置
        let tcfg = td.join("config.json");
        if tcfg.exists() {
            let dst = crate::cfg::prod_data_dir().join("config.json");
            std::fs::copy(&tcfg, &dst).map_err(|e| format!("合并测试配置失败：{e}"))?;
        }
        // 2) 统计：按天文件同名覆盖，报告按文件名覆盖（只补不删）
        merge_tree(&td.join("stats"), &crate::cfg::prod_data_dir().join("stats"))?;
    }
    // 无论保留与否，测试目录都要清掉，避免下次进去看到上次的残留
    let _ = std::fs::remove_dir_all(&td);
    set(false);
    Ok(())
}

/// 递归把 src 下的文件覆盖到 dst（同名覆盖，不删除 dst 里已有的其它文件）
fn merge_tree(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    if !src.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let e = entry.map_err(|x| x.to_string())?;
        let from = e.path();
        let to = dst.join(e.file_name());
        if from.is_dir() {
            merge_tree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|x| x.to_string())?;
        }
    }
    Ok(())
}
