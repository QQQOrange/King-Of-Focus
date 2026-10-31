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
    // 文件名也要 trim：用户在设置里填 " kof.json " 是很常见的，
    // 以前只去了前导斜杠，空格会原样拼进 URL —— 服务端直接 400/404，
    // 而界面上只会显示"同步失败"，几乎没法自查。
    format!("{}{}", b, file.trim().trim_start_matches('/'))
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
    // 上传体里不能带任何凭据：WebDAV 账号密码、备份口令、更新令牌。
    // 网盘/NAS 的读权限比本机宽得多，明文 PUT 一份 config 等于把凭据交出去。
    // 下载端本来就会保留本机的这些字段（见 download），剥离不影响同步效果。
    let mut safe = config.clone();
    safe.settings.sync.url.clear();
    safe.settings.sync.username.clear();
    safe.settings.sync.password.clear();
    safe.settings.backup.password.clear();
    safe.settings.update.token.clear();
    json!({
        "app": "king-of-focus",
        "schema": 1,
        "updatedAt": config.updated_at,
        "device": device,
        "version": env!("CARGO_PKG_VERSION"),
        "config": safe,
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
        serde_json::from_str(&body).map_err(|_| "云端文件不是 King Of Focus 的配置".to_string())?;
    if v.get("app").and_then(|x| x.as_str()) != Some("king-of-focus") {
        return Err("云端文件的格式不认识（app 字段不匹配）".into());
    }
    let mut remote: Config = serde_json::from_value(
        v.get("config").cloned().ok_or("云端文件缺少 config 字段")?,
    )
    .map_err(|e| format!("云端配置解析失败：{e}"))?;

    // 保留本机的机器专属字段，别被云端覆盖：
    // · 同步账号：不然下一次上传就没凭据了；
    // · 备份口令：被云端换掉后，之后所有本地备份都用别人的口令加密，且用户毫不知情；
    // · 更新令牌 / 提权 / 自启：都是"这台机器怎么运行"的设置，跨机同步没有意义。
    remote.settings.sync.url = c.settings.sync.url.clone();
    remote.settings.sync.username = c.settings.sync.username.clone();
    remote.settings.sync.password = c.settings.sync.password.clone();
    remote.settings.backup.password = c.settings.backup.password.clone();
    remote.settings.update.token = c.settings.update.token.clone();
    remote.settings.run_as_admin = c.settings.run_as_admin;
    remote.settings.autostart = c.settings.autostart;
    remote.updated_at = v.get("updatedAt").and_then(|x| x.as_i64()).unwrap_or(remote.updated_at);
    cfg::sanitize(&mut remote);
    // 下载 = 整份配置覆盖，必须过纪律校验：
    // 自律时段里自动同步拉到"规则已关闭"的云端配置，等于悄悄把纪律关掉。
    if let Some(why) = crate::guard::config_replace_blocked(&c, &remote) {
        return Err(why);
    }
    // 写盘失败必须上报：内存已经是新配置、磁盘还是旧的，重启后"恢复成功"就白做了
    cfg::save(&remote)?;
    let n = remote.rules.len();
    if let Ok(mut w) = shared.cfg.write() {
        *w = remote;
    }
    Ok(format!("已从云端恢复 {n} 条自律规则"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SyncCfg;

    /// 上传体里不能出现任何凭据：网盘的读权限比本机宽得多，
    /// 明文上传一份 config 等于把 WebDAV 口令、备份口令、更新令牌一起交出去。
    #[test]
    fn payload_strips_credentials() {
        let mut c = Config::default();
        c.settings.sync.url = "https://dav.example.com/dav".into();
        c.settings.sync.username = "user1".into();
        c.settings.sync.password = "dav-secret".into();
        c.settings.backup.password = "bak-secret".into();
        c.settings.update.token = "gh-token".into();
        let body = payload(&c, "dev");
        for leaked in ["dav-secret", "bak-secret", "gh-token", "dav.example.com"] {
            assert!(!body.contains(leaked), "上传体里泄露了 {leaked}");
        }
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["config"]["settings"]["sync"]["password"], "");
        assert_eq!(v["config"]["settings"]["backup"]["password"], "");
        assert_eq!(v["config"]["settings"]["update"]["token"], "");
    }

    /// 网盘地址与文件名的拼接：末尾有没有斜杠、文件名带不带前导斜杠都要对。
    /// 拼错一个 `/` 就是 404，而界面上只会显示"同步失败"，很难查。
    #[test]
    fn join_url_handles_slashes() {
        assert_eq!(
            join_url("https://dav.example.com/x", "a.json"),
            "https://dav.example.com/x/a.json"
        );
        assert_eq!(
            join_url("https://dav.example.com/x/", "a.json"),
            "https://dav.example.com/x/a.json"
        );
        assert_eq!(
            join_url("https://dav.example.com/x/", "/a.json"),
            "https://dav.example.com/x/a.json",
            "文件名带前导斜杠不能拼出双斜杠"
        );
        assert_eq!(
            join_url("https://dav.example.com/x/", "sub/a.json"),
            "https://dav.example.com/x/sub/a.json",
            "子目录要保留"
        );
        assert_eq!(
            join_url("  https://dav.example.com/x  ", " a.json "),
            "https://dav.example.com/x/a.json",
            "地址和文件名两端的空格都要去掉，否则拼出来的 URL 是错的"
        );
    }

    /// 没填文件名时用固定名，填了就用填的
    #[test]
    fn remote_url_defaults_and_keeps_custom_name() {
        let mut c = SyncCfg::default();
        c.url = "https://dav.example.com/dav".into();
        c.remote_file = "   ".into();
        assert_eq!(remote_url(&c), "https://dav.example.com/dav/king-of-focus.json");

        c.remote_file = "my/kof.json".into();
        assert_eq!(remote_url(&c), "https://dav.example.com/dav/my/kof.json");
    }

    /// 只有真的填了账号或密码才发 Authorization，否则匿名访问
    #[test]
    fn auth_only_when_credentials_present() {
        let mut c = SyncCfg::default();
        c.username = "".into();
        c.password = "".into();
        assert!(auth_of(&c).is_none(), "空账号密码不该发 Authorization");

        c.username = "u".into();
        assert!(auth_of(&c).is_some(), "只填账号也要带上");
    }

    /// 上传体的契约：对端（另一台机器）靠这些字段判断"要不要覆盖"
    #[test]
    fn payload_carries_schema_device_and_time() {
        let mut cfg = Config::default();
        cfg.updated_at = 1234567890;
        let v: serde_json::Value = serde_json::from_str(&payload(&cfg, "PC-A")).unwrap();
        assert_eq!(v["app"], "king-of-focus");
        assert_eq!(v["schema"], 1);
        assert_eq!(v["device"], "PC-A");
        assert_eq!(v["updatedAt"], 1234567890);
        assert!(v["config"].is_object(), "整份配置要随包上传");
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
    }
}
