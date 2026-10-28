//! WebDAV 云同步：把规则 / 设置（不含统计原始数据）同步到用户自己的网盘
//!
//! 冲突策略：以 payload 里的 updatedAt 为准，新的覆盖旧的（last-write-wins）。
//! 自动同步：每 auto_minutes 分钟检查一次，只在本地有改动时上传。

use crate::cfg;
use crate::model::{Config, SyncCfg};
use crate::net;
use crate::shared::Shared;
use serde_json::json;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

fn join_url(base: &str, file: &str) -> String {
    let mut b = base.trim().to_string();
    if !b.ends_with('/') {
        b.push('/');
    }
    format!("{}{}", b, file.trim_start_matches('/'))
}

pub fn remote_url(c: &SyncCfg) -> String {
    let file = if c.remote_file.trim().is_empty() {
        "king-of-focus.json"
    } else {
        c.remote_file.trim()
    };
    join_url(&c.url, file)
}

fn auth_of(c: &SyncCfg) -> Option<String> {
    if c.username.is_empty() && c.password.is_empty() {
        None
    } else {
        Some(net::basic_auth(&c.username, &c.password))
    }
}

fn payload(config: &Config, device: &str) -> String {
    json!({
        "app": "king-of-focus",
        "schema": 1,
        "updatedAt": config.updated_at,
        "device": device,
        "version": env!("CARGO_PKG_VERSION"),
        "config": config,
    })
    .to_string()
}

/// 上传本机配置（云端覆盖）
pub fn upload(shared: &Shared) -> Result<String, String> {
    let c = shared.config();
    if c.settings.sync.url.trim().is_empty() {
        return Err("还没有填写 WebDAV 地址".into());
    }
    let mut c2 = c.clone();
    c2.updated_at = chrono::Local::now().timestamp();
    let body = payload(&c2, &c.settings.sync.device);
    net::put_text(
        &remote_url(&c.settings.sync),
        auth_of(&c.settings.sync).as_deref(),
        &body,
    )?;
    // 上传成功后把时间戳写回本地，保证下次比较一致
    let mut live = c.clone();
    live.updated_at = c2.updated_at;
    let _ = cfg::save(&live);
    if let Ok(mut w) = shared.cfg.write() {
        *w = live;
    }
    Ok(format!(
        "已上传到 {}（{} KB）",
        remote_url(&c.settings.sync),
        body.len() / 1024
    ))
}

/// 从云端拉取并覆盖本机配置
pub fn download(shared: &Shared) -> Result<String, String> {
    let c = shared.config();
    if c.settings.sync.url.trim().is_empty() {
        return Err("还没有填写 WebDAV 地址".into());
    }
    let body = net::get_text(&remote_url(&c.settings.sync), auth_of(&c.settings.sync).as_deref(), None)?;
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| "云端文件不是 King of Focus 的配置".to_string())?;
    if v.get("app").and_then(|x| x.as_str()) != Some("king-of-focus") {
        return Err("云端文件的格式不认识（app 字段不匹配）".into());
    }
    let mut remote: Config = serde_json::from_value(
        v.get("config").cloned().ok_or("云端文件缺少 config 字段")?,
    )
    .map_err(|e| format!("云端配置解析失败：{e}"))?;

    // 保留本机的同步账号信息，别被云端覆盖掉
    remote.settings.sync.url = c.settings.sync.url.clone();
    remote.settings.sync.username = c.settings.sync.username.clone();
    remote.settings.sync.password = c.settings.sync.password.clone();
    remote.updated_at = v.get("updatedAt").and_then(|x| x.as_i64()).unwrap_or(remote.updated_at);
    cfg::sanitize(&mut remote);
    // 下载 = 整份配置覆盖，必须过纪律校验：
    // 自律时段里自动同步拉到"规则已关闭"的云端配置，等于悄悄把纪律关掉。
    if let Some(why) = crate::guard::config_replace_blocked(&c, &remote) {
        return Err(why);
    }
    let _ = cfg::save(&remote);
    let n = remote.lists.len();
    if let Ok(mut w) = shared.cfg.write() {
        *w = remote;
    }
    Ok(format!("已从云端恢复 {n} 条黑名单"))
}

/// 智能同步：谁新用谁
pub fn smart(shared: &Shared) -> Result<String, String> {
    let c = shared.config();
    if c.settings.sync.url.trim().is_empty() {
        return Err("还没有填写 WebDAV 地址".into());
    }
    let auth = auth_of(&c.settings.sync);
    let url = remote_url(&c.settings.sync);
    let remote = net::get_text(&url, auth.as_deref(), None);

    match remote {
        Err(e) => {
            // 云端没文件 → 直接上传
            if e.contains("404") {
                return upload(shared);
            }
            Err(e)
        }
        Ok(body) => {
            let remote_ts = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("updatedAt").and_then(|x| x.as_i64()))
                .unwrap_or(0);
            if remote_ts > c.updated_at + 2 {
                download(shared)
            } else if c.updated_at > remote_ts + 2 {
                upload(shared)
            } else {
                Ok("两端已经是同一版本，无需同步".into())
            }
        }
    }
}

/// 自动同步线程
pub fn start_auto(shared: Arc<Shared>) {
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(20));
        loop {
            let c = shared.config();
            let sy = &c.settings.sync;
            if sy.enabled && sy.auto && !sy.url.trim().is_empty() {
                let r = smart(&shared);
                let mut c2 = shared.config();
                c2.settings.sync.last_sync = chrono::Local::now().timestamp();
                c2.settings.sync.last_error = r.as_ref().err().cloned().unwrap_or_default();
                c2.settings.sync.last_result = r.clone().unwrap_or_default();
                let _ = cfg::save(&c2);
                if let Ok(mut w) = shared.cfg.write() {
                    *w = c2;
                }
            }
            let mins = shared.config().settings.sync.auto_minutes.clamp(5, 1440) as u64;
            thread::sleep(Duration::from_secs(mins * 60));
        }
    });
}
