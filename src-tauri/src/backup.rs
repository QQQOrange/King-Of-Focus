//! 备份：本地版本化备份 + WebDAV 云端备份 + 加密
//!
//! 加密信封（参考 Quick search 的成熟做法）：
//!   `{"kofEnc":1,...}` = 备份密码（Argon2id 派生 + AES-256-GCM，可跨机恢复）
//!   `{"kofEnc":2,...}` = Windows DPAPI（跟当前账户走，没设密码时的兜底）
//! 两种情况磁盘上都不会出现明文。
//!
//! 保留策略：最近 10 份 **且** 7 天内，两条都满足才留，其余清理（本地和云端一致）。

use crate::cfg;
use crate::model::Config;
use crate::net;
use crate::shared::Shared;
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const DIR_NAME: &str = "king of focus back";
pub const EXT: &str = ".kofbak";
pub const KEEP_COUNT: usize = 10;
pub const KEEP_DAYS: i64 = 7;
const AAD: &[u8] = b"king-of-focus-backup-v1";

// ---------------- base64 ----------------
const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64e(data: &[u8]) -> String {
    let mut out = String::new();
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if c.len() > 1 { B64[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { B64[(n & 63) as usize] as char } else { '=' });
    }
    out
}

pub fn b64d(s: &str) -> Result<Vec<u8>, String> {
    let mut map = [255u8; 256];
    for (i, c) in B64.iter().enumerate() {
        map[*c as usize] = i as u8;
    }
    let clean: Vec<u8> = s.bytes().filter(|b| *b != b'\n' && *b != b'\r' && *b != b' ').collect();
    let mut out = Vec::new();
    for c in clean.chunks(4) {
        if c.len() < 2 {
            break;
        }
        let v: Vec<u8> = c
            .iter()
            .map(|b| if *b == b'=' { 0 } else { map[*b as usize] })
            .collect();
        if v.contains(&255) {
            return Err("base64 数据损坏".into());
        }
        let n = ((v[0] as u32) << 18) | ((v[1] as u32) << 12)
            | ((v.get(2).copied().unwrap_or(0) as u32) << 6)
            | (v.get(3).copied().unwrap_or(0) as u32);
        out.push((n >> 16) as u8);
        if c.len() > 2 && c[2] != b'=' {
            out.push((n >> 8) as u8);
        }
        if c.len() > 3 && c[3] != b'=' {
            out.push(n as u8);
        }
    }
    Ok(out)
}

// ---------------- Windows DPAPI ----------------
#[repr(C)]
struct Blob {
    cb: u32,
    pb: *mut u8,
}

#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        data: *const Blob,
        desc: *const u16,
        entropy: *const Blob,
        reserved: *mut core::ffi::c_void,
        prompt: *mut core::ffi::c_void,
        flags: u32,
        out: *mut Blob,
    ) -> i32;
    fn CryptUnprotectData(
        data: *const Blob,
        desc: *mut *mut u16,
        entropy: *const Blob,
        reserved: *mut core::ffi::c_void,
        prompt: *mut core::ffi::c_void,
        flags: u32,
        out: *mut Blob,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(h: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
}

const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

fn dpapi_encrypt(plain: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        let input = Blob { cb: plain.len() as u32, pb: plain.as_ptr() as *mut u8 };
        let mut out = Blob { cb: 0, pb: std::ptr::null_mut() };
        if CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(),
                            std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) == 0 {
            return Err("DPAPI 加密失败".into());
        }
        let v = std::slice::from_raw_parts(out.pb, out.cb as usize).to_vec();
        LocalFree(out.pb as *mut core::ffi::c_void);
        Ok(v)
    }
}

fn dpapi_decrypt(data: &[u8]) -> Result<Vec<u8>, String> {
    unsafe {
        let input = Blob { cb: data.len() as u32, pb: data.as_ptr() as *mut u8 };
        let mut out = Blob { cb: 0, pb: std::ptr::null_mut() };
        if CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(),
                              std::ptr::null_mut(), std::ptr::null_mut(),
                              CRYPTPROTECT_UI_FORBIDDEN, &mut out) == 0 {
            return Err("DPAPI 解密失败（可能不是本机/本账户创建的备份）".into());
        }
        let v = std::slice::from_raw_parts(out.pb, out.cb as usize).to_vec();
        LocalFree(out.pb as *mut core::ffi::c_void);
        Ok(v)
    }
}

// ---------------- 信封 ----------------
pub fn encrypt(plain: &str, pass: &str) -> Result<String, String> {
    if pass.trim().is_empty() {
        let ct = dpapi_encrypt(plain.as_bytes())?;
        return Ok(json!({"kofEnc": 2, "alg": "dpapi", "data": b64e(&ct)}).to_string());
    }
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let params = Params::new(19_456, 2, 1, Some(32)).map_err(|e| e.to_string())?;
    let a2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    a2.hash_password_into(pass.as_bytes(), &salt, &mut key)
        .map_err(|e| format!("密钥派生失败: {e}"))?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain.as_bytes(), aad: AAD })
        .map_err(|_| "加密失败".to_string())?;
    Ok(json!({
        "kofEnc": 1, "kdf": "argon2id", "salt": b64e(&salt),
        "nonce": b64e(&nonce), "data": b64e(&ct)
    })
    .to_string())
}

pub fn decrypt(envelope: &str, pass: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(envelope).map_err(|_| "备份文件格式不认识".to_string())?;
    let kind = v.get("kofEnc").and_then(|x| x.as_i64()).unwrap_or(0);
    let data = b64d(v.get("data").and_then(|x| x.as_str()).unwrap_or(""))?;
    match kind {
        2 => {
            let plain = dpapi_decrypt(&data)?;
            String::from_utf8(plain).map_err(|_| "内容不是 UTF-8".into())
        }
        1 => {
            if pass.trim().is_empty() {
                return Err("这份备份用密码加密，请先在上方填写备份密码".into());
            }
            let salt = b64d(v.get("salt").and_then(|x| x.as_str()).unwrap_or(""))?;
            let nonce = b64d(v.get("nonce").and_then(|x| x.as_str()).unwrap_or(""))?;
            if salt.len() != 16 || nonce.len() != 12 {
                return Err("备份文件已损坏".into());
            }
            let params = Params::new(19_456, 2, 1, Some(32)).map_err(|e| e.to_string())?;
            let a2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
            let mut key = [0u8; 32];
            a2.hash_password_into(pass.as_bytes(), &salt, &mut key)
                .map_err(|e| e.to_string())?;
            let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
            let plain = cipher
                .decrypt(Nonce::from_slice(&nonce), Payload { msg: &data, aad: AAD })
                .map_err(|_| "密码不对，或者备份文件被改动过".to_string())?;
            String::from_utf8(plain).map_err(|_| "内容不是 UTF-8".into())
        }
        _ => Err("不是 King Of Focus 的备份文件".into()),
    }
}

// ---------------- 本地备份 ----------------
pub fn dir() -> PathBuf {
    let base = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| cfg::data_dir());
    let d = base.join(DIR_NAME);
    let _ = std::fs::create_dir_all(&d);
    d
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 生成一份备份，返回文件信息
pub fn make(shared: &Shared) -> Result<Value, String> {
    let c = shared.config();
    let pass = c.settings.backup.password.clone();
    let payload = serde_json::to_string(&c).map_err(|e| e.to_string())?;
    let env = encrypt(&payload, &pass)?;
    let name = format!("kof-{}{}", stamp(), EXT);
    let path = dir().join(&name);
    std::fs::write(&path, env).map_err(|e| format!("写入备份失败: {e}"))?;
    prune_local();
    Ok(json!({
        "name": name,
        "size": std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        "encrypted": !pass.trim().is_empty(),
        "dir": dir().to_string_lossy(),
    }))
}

pub fn list() -> Vec<Value> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir()) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some(&EXT[1..]) {
                continue;
            }
            let meta = e.metadata().ok();
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push(json!({
                "name": p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string(),
                "path": p.to_string_lossy(),
                "size": meta.map(|m| m.len()).unwrap_or(0),
                "mtime": mtime,
            }));
        }
    }
    out.sort_by(|a, b| b["mtime"].as_i64().unwrap_or(0).cmp(&a["mtime"].as_i64().unwrap_or(0)));
    out
}

/// 只保留最近 10 份且 7 天内的
fn prune_local() {
    let files = list();
    let now = chrono::Local::now().timestamp();
    for (i, f) in files.iter().enumerate() {
        let old = now - f["mtime"].as_i64().unwrap_or(0) > KEEP_DAYS * 86400;
        if i >= KEEP_COUNT || old {
            if let Some(p) = f["path"].as_str() {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}

pub fn restore_local(shared: &Shared, path: &str) -> Result<String, String> {
    let env = std::fs::read_to_string(path).map_err(|e| format!("读不到备份文件: {e}"))?;
    apply(shared, &env)
}

fn apply(shared: &Shared, envelope: &str) -> Result<String, String> {
    let c = shared.config();
    let plain = decrypt(envelope, &c.settings.backup.password)?;
    let mut remote: Config = serde_json::from_str(&plain).map_err(|e| format!("备份内容解析失败: {e}"))?;
    // 本机的同步/备份账号信息不被覆盖
    remote.settings.sync = c.settings.sync.clone();
    remote.settings.backup = c.settings.backup.clone();
    remote.settings.update = c.settings.update.clone();
    remote.settings.theme = c.settings.theme.clone();
    remote.updated_at = chrono::Local::now().timestamp();
    crate::cfg::sanitize(&mut remote);
    // 恢复备份 = 整份配置覆盖，必须和 save_config 走同一套纪律校验，
    // 否则自律时段里恢复一份"规则关闭"的旧备份就能绕过限制。
    if let Some(why) = crate::guard::config_replace_blocked(&c, &remote) {
        return Err(why);
    }
    crate::cfg::save(&remote)?;
    let n = remote.rules.len();
    if let Ok(mut w) = shared.cfg.write() {
        *w = remote;
    }
    Ok(format!("已恢复 {n} 条自律规则（含设置）"))
}

// ---------------- 云端备份（WebDAV） ----------------
fn remote_base(c: &Config) -> Result<(String, Option<String>), String> {
    let url = c.settings.sync.url.trim();
    if url.is_empty() {
        return Err("还没有填写 WebDAV 地址".into());
    }
    let mut base = url.to_string();
    if !base.ends_with('/') {
        base.push('/');
    }
    let auth = if c.settings.sync.username.is_empty() && c.settings.sync.password.is_empty() {
        None
    } else {
        Some(net::basic_auth(&c.settings.sync.username, &c.settings.sync.password))
    };
    Ok((base, auth))
}

fn hrefs(xml: &str) -> Vec<String> {
    let low = xml.to_lowercase();
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Some(pos) = low[i..].find("href>") {
        let s = i + pos + 5;
        let e = low[s..].find("</").map(|x| s + x).unwrap_or(low.len());
        if e > s {
            out.push(xml[s..e].trim().to_string());
        }
        i = e.max(s);
    }
    out
}

/// 列出云端所有备份（按时间倒序）
pub fn cloud_list(shared: &Shared) -> Result<Vec<Value>, String> {
    let c = shared.config();
    let (base, auth) = remote_base(&c)?;
    let body = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;
    let mut req = net::agent()
        .request("PROPFIND", &base)
        .set("Depth", "1")
        .set("Content-Type", "application/xml; charset=utf-8")
        .set("User-Agent", net::UA);
    if let Some(a) = &auth {
        req = req.set("Authorization", a);
    }
    let xml = match req.send_string(body) {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        Err(e) => return Err(net::describe(e)),
    };
    let mut out = Vec::new();
    for h in hrefs(&xml) {
        let name = h.rsplit('/').next().unwrap_or("").to_string();
        let name = name.replace("%20", " ");
        if !name.ends_with(EXT) {
            continue;
        }
        out.push(json!({
            "name": name,
            "href": h,
            "url": format!("{}{}", base, name),
        }));
    }
    out.sort_by(|a, b| b["name"].as_str().unwrap_or("").cmp(a["name"].as_str().unwrap_or("")));
    Ok(out)
}

/// 备份 → 加密 → 上传 → 按策略清理云端旧包
pub fn cloud_upload(shared: &Shared) -> Result<String, String> {
    let local = make(shared)?;
    let c = shared.config();
    let (base, auth) = remote_base(&c)?;
    let name = local["name"].as_str().unwrap_or("").to_string();
    let path = dir().join(&name);
    let env = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    net::put_text(&format!("{base}{name}"), auth.as_deref(), &env)?;

    // 云端保留策略
    let mut removed = 0;
    if let Ok(list) = cloud_list(shared) {
        let now = chrono::Local::now();
        for (i, f) in list.iter().enumerate() {
            let n = f["name"].as_str().unwrap_or("");
            let old = chrono::NaiveDateTime::parse_from_str(
                n.trim_start_matches("kof-").trim_end_matches(EXT),
                "%Y%m%d-%H%M%S",
            )
            .map(|d| (now.naive_local() - d).num_days() > KEEP_DAYS)
            .unwrap_or(false);
            if i >= KEEP_COUNT || old {
                let _ = net::delete(&format!("{base}{n}"), auth.as_deref());
                removed += 1;
            }
        }
    }
    Ok(format!("已上传 {name}（清理旧备份 {removed} 份）"))
}

pub fn cloud_restore(shared: &Shared, name: &str) -> Result<String, String> {
    if !name.ends_with(EXT) || name.contains('/') || name.contains('\\') {
        return Err("备份文件名不合法".into());
    }
    let c = shared.config();
    let (base, auth) = remote_base(&c)?;
    let env = net::get_text(&format!("{base}{name}"), auth.as_deref(), None)?;
    apply(shared, &env)
}

pub fn delete_file(path: &str) -> Result<(), String> {
    // 只允许删备份目录里的文件
    let p = Path::new(path);
    if p.parent() != Some(dir().as_path()) {
        return Err("只能删除备份目录内的文件".into());
    }
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64_roundtrip() {
        for n in 0..40usize {
            let v: Vec<u8> = (0..n as u8).collect();
            assert_eq!(b64d(&b64e(&v)).unwrap(), v, "len={n}");
        }
    }

    #[test]
    fn password_envelope_roundtrip() {
        let plain = r#"{"rules":[{"name":"自律时间"}]}"#;
        let env = encrypt(plain, "pw123456").unwrap();
        assert!(!env.contains("自律时间"), "明文泄漏");
        assert_eq!(decrypt(&env, "pw123456").unwrap(), plain);
        assert!(decrypt(&env, "wrong").is_err(), "错密码必须拒绝");
    }

    #[test]
    fn dpapi_envelope_roundtrip() {
        let env = encrypt("hello-kof", "").unwrap();
        assert!(env.contains("dpapi"));
        assert!(!env.contains("hello-kof"));
        assert_eq!(decrypt(&env, "").unwrap(), "hello-kof");
    }

    #[test]
    fn reject_garbage() {
        assert!(decrypt("not json", "").is_err());
        assert!(decrypt(r#"{"kofEnc":99,"data":""}"#, "").is_err());
    }
}
