//! WebDAV 云同步：把规则 / 设置（不含统计原始数据）同步到用户自己的网盘
//!
//! 冲突策略：以 payload 里的 updatedAt 为准，新的覆盖旧的（last-write-wins）。
//! 自动同步：每 auto_minutes 分钟检查一次，只在本地有改动时上传。

use crate::cfg;
use crate::model::{Config, SyncCfg, DEFAULT_SYNC_URL};
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

/// 实际使用的同步目录：配置里为空就落到默认值。
///
/// 这一层是**必须**的，不能只靠 `cfg::sanitize`：云同步下载回来的配置、
/// 手工改过的 config.json、`sync_save` 收到空串——都可能让 `url` 变回空。
/// 与其在每个调用点各判一次，不如在这里兜住（旧的"还没有填写 WebDAV 地址"
/// 就是三处各判一次的结果，漏一处就同步不了）。
pub fn url_of(c: &SyncCfg) -> String {
    let u = c.url.trim();
    if u.is_empty() {
        DEFAULT_SYNC_URL.to_string()
    } else {
        u.to_string()
    }
}

/// 地址必须带协议头。WebDAV 一律走 http(s)——写 `dav.jianguoyun.com/...`
/// 这种裸域名以前会一路走到 ureq 才炸，报出来的是一句 "Bad Status"。
fn check_url(u: &str) -> Result<(), String> {
    if u.starts_with("http://") || u.starts_with("https://") {
        Ok(())
    } else {
        Err(format!("地址要以 http:// 或 https:// 开头：{u}"))
    }
}

pub fn remote_url(c: &SyncCfg) -> String {
    let file = if c.remote_file.trim().is_empty() {
        "king-of-focus.json"
    } else {
        c.remote_file.trim()
    };
    join_url(&url_of(c), file)
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
    let base = url_of(&c.settings.sync);
    check_url(&base)?;
    // 目录不存在时 PUT 会 409；先尽力建一层（失败不拦，PUT 会给出真实原因）
    net::ensure_dir(&base, auth_of(&c.settings.sync).as_deref());
    let mut c2 = c.clone();
    c2.updated_at = chrono::Local::now().timestamp();
    let body = payload(&c2, &c.settings.sync.device);
    net::put_text(
        &remote_url(&c.settings.sync),
        auth_of(&c.settings.sync).as_deref(),
        &body,
    )?;
    // 上传成功后把时间戳写回本地，保证下次比较一致。
    // 用 save_quiet：这一笔只是记下"刚上传时的 updated_at"，
    // 再刷一次时间会让本地看起来比云端还新，下一轮又会白传一遍。
    //
    // 必须重新读一次当前配置，不能拿上传前的快照写回：网络请求可能跑好几秒，
    // 期间用户改的设置、刚赚到的积分、刚买的解锁都会被这份旧快照覆盖掉。
    let mut live = shared.config();
    live.updated_at = c2.updated_at;
    let _ = cfg::save_quiet(&live);
    if let Ok(mut w) = shared.cfg.write() {
        *w = live;
    }

    // 顺带上传一份**跨设备备份**（.kofbak）。
    //
    // 为什么：手机端只认 .kofbak（它读不懂桌面的 king-of-focus.json），
    // 所以只在桌面点「立即同步」时，手机上「立即同步」是看不到这份改动的。
    // 这一步让"桌面点一下同步"和"手机能拿到"变成同一件事。
    //
    // 失败不影响主流程：配置已经传上去了，备份只是"顺手多带一份"。
    let extra = match crate::backup::cloud_upload(shared) {
        Ok(msg) => format!("；{msg}"),
        Err(e) => format!("（附带备份未上传：{e}）"),
    };
    Ok(format!(
        "已上传到 {}（{} KB）{extra}",
        remote_url(&c.settings.sync),
        body.len() / 1024
    ))
}

/// 从云端拉取并覆盖本机配置
pub fn download(shared: &Shared) -> Result<String, String> {
    let c = shared.config();
    check_url(&url_of(&c.settings.sync))?;
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
    check_url(&url_of(&c.settings.sync))?;
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
            // 地址恒有值（空 = 默认），所以这里只判两个开关。
            // 以前多一个 `!sy.url.trim().is_empty()`，而 url 恰好就是空的 ——
            // 自动同步一次都没跑过。
            if sy.enabled && sy.auto {
                let r = smart(&shared);
                let mut c2 = shared.config();
                c2.settings.sync.last_sync = chrono::Local::now().timestamp();
                c2.settings.sync.last_error = r.as_ref().err().cloned().unwrap_or_default();
                c2.settings.sync.last_result = r.clone().unwrap_or_default();
                // 记账写入，不能刷新 updated_at：否则本机永远"比云端新"，
                // 另一台设备刚上传的规则会被这边的过期配置覆盖掉。
                let _ = cfg::save_quiet(&c2);
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
    /// 默认地址：空配置也能算出可用的 URL。
    ///
    /// 这条是这次 bug 的回归断言——以前 `url` 为空，`remote_url` 拼出来就是
    /// `king-of-focus.json`（没有主机），而三处调用各自报"还没有填写 WebDAV 地址"。
    #[test]
    fn empty_url_falls_back_to_default() {
        let mut c = SyncCfg::default();
        assert_eq!(c.url, DEFAULT_SYNC_URL, "默认配置就该带默认地址");
        assert_eq!(url_of(&c), DEFAULT_SYNC_URL);

        c.url = "   ".into();
        assert_eq!(url_of(&c), DEFAULT_SYNC_URL, "只有空白也算空");
        assert!(remote_url(&c).starts_with("https://"));
        assert!(remote_url(&c).ends_with("/king-of-focus.json"));
    }

    /// 自定义地址一个字都不许被默认值覆盖
    #[test]
    fn custom_url_is_kept_verbatim() {
        let mut c = SyncCfg::default();
        c.url = "  https://dav.example.com/dav/my/  ".into();
        assert_eq!(url_of(&c), "https://dav.example.com/dav/my/");
        assert_eq!(
            remote_url(&c),
            "https://dav.example.com/dav/my/king-of-focus.json"
        );
    }

    /// 加载老配置（url 空）后被清洗成默认地址，而不是继续空着
    #[test]
    fn sanitize_fills_default_url() {
        let mut c = Config::default();
        c.settings.sync.url = String::new();
        crate::cfg::sanitize(&mut c);
        assert_eq!(c.settings.sync.url, DEFAULT_SYNC_URL);
        // 自定义的不会被改
        c.settings.sync.url = "https://dav.example.com/dav/".into();
        crate::cfg::sanitize(&mut c);
        assert_eq!(c.settings.sync.url, "https://dav.example.com/dav/");
    }

    /// 地址缺协议头要早报错，别一路走到网络层
    #[test]
    fn bare_host_is_rejected() {
        assert!(check_url("dav.jianguoyun.com/dav/").is_err());
        assert!(check_url("https://dav.jianguoyun.com/dav/").is_ok());
        assert!(check_url("http://192.168.1.2:5005/dav/").is_ok());
    }

    /// 端到端：默认地址那种"带子目录且目录还不存在"的情况，能不能直接上传。
    ///
    /// 需要本地脚手架：`python tools/dav_stub.py shots/davprobe 8765`
    /// 这条不进常规测试（要网络），用 `cargo test -- --ignored` 手动跑。
    #[test]
    #[ignore = "需要 tools/dav_stub.py 在 8765 端口运行"]
    fn dav_roundtrip_creates_missing_dir() {
        let mut c = SyncCfg::default();
        // 故意指向一个还不存在的二级目录，模拟"默认地址第一次使用"
        c.url = "http://127.0.0.1:8765/KingOfFocus/sub/".into();
        let base = url_of(&c);
        net::ensure_dir(&base, None);
        net::put_text(&remote_url(&c), None, "{\"app\":\"king-of-focus\"}").expect("上传应成功");
        let got = net::get_text(&remote_url(&c), None, None).expect("读回应成功");
        assert!(got.contains("king-of-focus"), "读回的内容不对：{got}");
    }

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
