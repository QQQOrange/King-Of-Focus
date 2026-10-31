//! 备份：本地版本化备份 + WebDAV 云端备份 + 跨设备（手机）导入导出
//!
//! 加密信封（参考 Quick search 的成熟做法）：
//!   `{"kofEnc":1,...}` = 备份密码（Argon2id 派生 + AES-256-GCM，桌面内部用）
//!   `{"kofEnc":2,...}` = Windows DPAPI（跟当前账户走，没设密码时的兜底）
//!   `{"kofEnc":3,...}` = **跨设备**备份密码（PBKDF2-HMAC-SHA256 + AES-256-GCM）
//! 三种情况磁盘上都不会出现明文。
//!
//! 为什么跨设备单独一个信封：手机端没有 Argon2id、也没有 DPAPI。
//! PBKDF2-HMAC-SHA256 是 Android `javax.crypto` 自带的，两端都能算，
//! 于是"设了密码的备份"才能真正在电脑和手机之间来回搬。
//! 没有密码的跨设备导出就是明文 JSON（界面会明确警告），因为 DPAPI 出了这台机器就打不开。
//!
//! 载荷：`portable::Doc`（两端共用的文档，见 portable.rs）。
//! 老版本备份的载荷是 Config 本身，仍然读得懂，且保持"整份覆盖"的老语义。
//!
//! 保留策略：最近 10 份 **且** 7 天内，两条都满足才留，其余清理（本地和云端一致）。

use crate::cfg;
use crate::model::Config;
use crate::net;
use crate::portable::{self, Doc};
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
/// 跨设备信封的 AAD：和桌面内部信封分开，防止一种信封被当成另一种解释
const AAD_PORTABLE: &[u8] = b"king-of-focus-portable-v1";
/// 跨设备信封的默认迭代次数（写入时用；读取时一律以文件里的 `iter` 为准）。
///
/// 测试里调小：600000 轮在 debug 构建下要好几秒，一套测试跑下来全是等待，
/// 而格式本身（salt/nonce/AAD/字段名）在两档迭代下一模一样。
#[cfg(not(test))]
pub const PBKDF2_ITER: u32 = 600_000;
#[cfg(test)]
pub const PBKDF2_ITER: u32 = 20_000;
const PBKDF2_ITER_MIN: u32 = 10_000;
const PBKDF2_ITER_MAX: u32 = 4_000_000;


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
/// 加密一段载荷。
///
/// 设了密码 → `kofEnc:3`（PBKDF2，手机也解得开）；
/// 没设密码 → `kofEnc:2`（DPAPI，只有本机本账户能开，这是"没密码"的代价）。
///
/// 早先设密码用的是 Argon2id（`kofEnc:1`）。那个更抗暴力破解，但手机端
/// 没有现成实现，备份就永远只能在电脑之间搬。现在统一走 PBKDF2-HMAC-SHA256
/// 600000 轮——强度仍然在线（OWASP 推荐档位），换来的是真·跨设备。
/// `kofEnc:1` 的老文件继续读得懂，只是不再往里写。
pub fn encrypt(plain: &str, pass: &str) -> Result<String, String> {
    if pass.trim().is_empty() {
        let ct = dpapi_encrypt(plain.as_bytes())?;
        return Ok(json!({"kofEnc": 2, "alg": "dpapi", "data": b64e(&ct)}).to_string());
    }
    seal_portable_with(plain, pass, PBKDF2_ITER)
}


// ---------------- PBKDF2（跨设备信封 kofEnc:3） ----------------
/// PBKDF2-HMAC-SHA256（RFC 8018）。
///
/// 自己实现而不是拉 `pbkdf2` crate：算法本身就是"HMAC 跑 N 轮再异或"，
/// 20 行内能写完，还能跟 Android 的 `SecretKeyFactory` 用完全相同的参数；
/// 关键路径有单元测试盯着（`pbkdf2_matches_known_vectors`）。
fn pbkdf2_sha256(pass: &[u8], salt: &[u8], iter: u32, out: &mut [u8]) {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type H = Hmac<Sha256>;
    const HLEN: usize = 32;
    let iter = iter.max(1);
    let blocks = out.len().div_ceil(HLEN);
    for i in 1..=blocks {
        let mut mac = <H as Mac>::new_from_slice(pass).expect("HMAC 接受任意长度密钥");
        mac.update(salt);
        mac.update(&(i as u32).to_be_bytes());
        let mut u = mac.finalize().into_bytes();
        let mut t = u;
        for _ in 1..iter {
            let mut mac = <H as Mac>::new_from_slice(pass).expect("HMAC 接受任意长度密钥");
            mac.update(&u);
            u = mac.finalize().into_bytes();
            for k in 0..HLEN {
                t[k] ^= u[k];
            }
        }
        let start = (i - 1) * HLEN;
        let n = (out.len() - start).min(HLEN);
        out[start..start + n].copy_from_slice(&t[..n]);
    }
}

/// 跨设备信封加密。`iter` 只给测试用，正式写入一律用 `PBKDF2_ITER`。
fn seal_portable_with(plain: &str, pass: &str, iter: u32) -> Result<String, String> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let mut key = [0u8; 32];
    pbkdf2_sha256(pass.as_bytes(), &salt, iter, &mut key);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload { msg: plain.as_bytes(), aad: AAD_PORTABLE },
        )
        .map_err(|_| "加密失败".to_string())?;
    Ok(json!({
        "kofEnc": 3, "kdf": "pbkdf2-sha256", "iter": iter,
        "salt": b64e(&salt), "nonce": b64e(&nonce), "data": b64e(&ct)
    })
    .to_string())
}

/// 跨设备备份的打包装：设了密码就加密，没设就是明文 JSON。
///
/// 没设密码时**不能**退回 DPAPI：那玩意儿跟当前 Windows 账户绑定，
/// 拷到手机上就是一堆解不开的字节，用户只会看到"文件损坏"。
/// 明文至少是诚实的，界面上会明确提示"这份文件没有加密"。
pub fn seal_portable(plain: &str, pass: &str) -> Result<String, String> {
    if pass.trim().is_empty() {
        return Ok(plain.to_string());
    }
    seal_portable_with(plain, pass, PBKDF2_ITER)
}

/// 把任意一段备份文本变成明文载荷：是信封就解密，是明文就原样返回。
pub fn unlock(text: &str, pass: &str) -> Result<String, String> {
    let looks_env = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("kofEnc").and_then(|x| x.as_i64()))
        .is_some();
    if looks_env {
        decrypt(text, pass)
    } else {
        Ok(text.to_string())
    }
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
        3 => {
            if pass.trim().is_empty() {
                return Err("这份备份用密码加密，请先在上方填写备份密码".into());
            }
            let salt = b64d(v.get("salt").and_then(|x| x.as_str()).unwrap_or(""))?;
            let nonce = b64d(v.get("nonce").and_then(|x| x.as_str()).unwrap_or(""))?;
            if salt.len() != 16 || nonce.len() != 12 {
                return Err("备份文件已损坏".into());
            }
            let iter = v.get("iter").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            if !(PBKDF2_ITER_MIN..=PBKDF2_ITER_MAX).contains(&iter) {
                return Err("备份文件的加密参数不在合理范围内（可能被改动过）".into());
            }
            let mut key = [0u8; 32];
            pbkdf2_sha256(pass.as_bytes(), &salt, iter, &mut key);
            let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
            let plain = cipher
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload { msg: &data, aad: AAD_PORTABLE },
                )
                .map_err(|_| "密码不对，或者备份文件被改动过".to_string())?;
            String::from_utf8(plain).map_err(|_| "内容不是 UTF-8".into())
        }
        _ => Err("不是 King Of Focus 的备份文件".into()),
    }
}

// ---------------- 本地备份 ----------------
pub fn dir() -> PathBuf {
    // 与**数据目录**同级，而不是 exe 所在目录。
    // 数据目录是带"可写探测 + 回落到 %APPDATA%"的，备份必须跟着走：
    // 以前装在 Program Files 时数据已回落到 APPDATA，备份却仍往不可写的安装目录写，
    // 而失败还被上层吞掉 —— 用户以为每天都有备份，其实一份都没有。
    let dd = cfg::data_dir();
    let base = dd.parent().map(|p| p.to_path_buf()).unwrap_or(dd);
    let d = base.join(DIR_NAME);
    let _ = std::fs::create_dir_all(&d);
    d
}

fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 生成一份备份，返回文件信息
///
/// 载荷是**跨设备文档**（portable::Doc），不再是 Config 原样：
/// 这样同一份文件设了密码就能直接拷到手机上恢复。
/// 加密方式仍按本机设置走（有密码 = Argon2id，没密码 = DPAPI 只保本机）。
pub fn make(shared: &Shared) -> Result<Value, String> {
    let c = shared.config();
    let pass = c.settings.backup.password.clone();
    let payload = Doc::from_config(&c).render()?;
    let env = encrypt(&payload, &pass)?;
    let name = format!("kof-{}{}", stamp(), EXT);
    let path = dir().join(&name);
    std::fs::write(&path, env).map_err(|e| format!("写入备份失败: {e}"))?;
    prune_local();
    Ok(json!({
        "name": name,
        "size": std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        "encrypted": !pass.trim().is_empty(),
        "portable": !pass.trim().is_empty(),
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

/// 恢复模式归一化：只认 merge，其余一律按覆盖处理。
///
/// 为什么默认是覆盖而不是合并：用户点"恢复"时脑子里想的是"回到那个状态"。
/// 合并是"把另一台设备的东西并进来"，必须显式选择，不能默默变成加法。
pub fn mode_norm(mode: &str) -> &'static str {
    if mode == "merge" {
        "merge"
    } else {
        "overwrite"
    }
}

/// 恢复备份目录里的一份（界面上的"恢复"按钮）
pub fn restore_local(shared: &Shared, path: &str, mode: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读不到备份文件: {e}"))?;
    apply(shared, &text, mode)
}

/// 从任意路径导入（含手机传来的文件）
pub fn import_file(shared: &Shared, path: &str, mode: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读不到这个文件: {e}"))?;
    apply(shared, &text, mode)
}

/// 导出到任意路径（跨设备用）
///
/// 设了备份密码 → PBKDF2 信封（手机也解得开）；
/// 没设 → 明文 JSON，返回值里 `encrypted:false`，界面必须把这句话说出来。
pub fn export_file(shared: &Shared, path: &str) -> Result<Value, String> {
    let c = shared.config();
    let pass = c.settings.backup.password.clone();
    let doc = Doc::from_config(&c);
    let plain = doc.render()?;
    let out = seal_portable(&plain, &pass)?;
    let p = Path::new(path);
    if let Some(d) = p.parent() {
        if !d.as_os_str().is_empty() {
            std::fs::create_dir_all(d).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    std::fs::write(p, out).map_err(|e| format!("写入失败: {e}"))?;
    Ok(json!({
        "path": p.to_string_lossy(),
        "encrypted": !pass.trim().is_empty(),
        "size": std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
        "rules": doc.rules.len(),
        "source": doc.source,
        "createdAt": doc.created_at,
    }))
}

/// 把一段备份文本应用到本机配置
///
/// 返回值给界面组装提示：{ mode, rules, added, skipped, conflict, slots, legacy, source, noop }
fn apply(shared: &Shared, text: &str, mode: &str) -> Result<Value, String> {
    let local = shared.config();
    let plain = unlock(text, &local.settings.backup.password)?;
    let parsed = portable::parse(&plain)?;
    let mode = mode_norm(mode);

    // 老格式的覆盖：保持"整份替换"的老语义（那是它当初的承诺）。
    // 合并仍然只能走加法，所以老格式的合并按新文档的加法规则处理。
    if mode == "overwrite" {
        if let Some(legacy) = &parsed.legacy {
            let mut remote = legacy.clone();
            // 本机的同步/备份账号信息不被覆盖
            remote.settings.sync = local.settings.sync.clone();
            remote.settings.backup = local.settings.backup.clone();
            remote.settings.update = local.settings.update.clone();
            remote.settings.theme = local.settings.theme.clone();
            remote.updated_at = chrono::Local::now().timestamp();
            cfg::sanitize(&mut remote);
            // 恢复备份 = 整份配置覆盖，必须和 save_config 走同一套纪律校验，
            // 否则自律时段里恢复一份"规则关闭"的旧备份就能绕过限制。
            if let Some(why) = crate::guard::config_replace_blocked(&local, &remote) {
                return Err(why);
            }
            let n = remote.rules.len();
            commit(shared, remote)?;
            return Ok(json!({
                "mode": "overwrite", "legacy": true, "rules": n,
                "added": n, "skipped": 0, "conflict": 0, "slots": 0, "noop": false,
            }));
        }
    }

    let doc = &parsed.doc;
    if mode == "merge" {
        let (next, st) = doc.merge(&local);
        if st.is_noop() {
            // 什么都不用改：既别写盘，也别报错——"这份已经并进去了"
            return Ok(json!({
                "mode": "merge", "legacy": false, "noop": true,
                "rules": local.rules.len(),
                "added": 0, "skipped": st.skipped, "conflict": 0, "slots": 0,
            }));
        }
        // 合并只会加东西，不该触发"整份覆盖"的固化锁；但仍要确认没把纪律改弱
        if let Some(why) = crate::guard::discipline_violation(&local, &next) {
            return Err(why);
        }
        let n = next.rules.len();
        commit(shared, next)?;
        return Ok(json!({
            "mode": "merge", "legacy": false, "noop": false,
            "rules": n,
            "added": st.added, "skipped": st.skipped,
            "conflict": st.conflict, "slots": st.slots,
        }));
    }

    let next = doc.to_config(&local);
    if let Some(why) = crate::guard::config_replace_blocked(&local, &next) {
        return Err(why);
    }
    let n = next.rules.len();
    commit(shared, next)?;
    Ok(json!({
        "mode": "overwrite", "legacy": false, "noop": false,
        "rules": n,
        "added": n, "skipped": 0, "conflict": 0, "slots": 0,
        "source": doc.source, "device": doc.device, "createdAt": doc.created_at,
    }))
}

/// 落盘 + 换内存里的配置
fn commit(shared: &Shared, next: Config) -> Result<(), String> {
    cfg::save(&next)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = next;
    }
    Ok(())
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

pub fn cloud_restore(shared: &Shared, name: &str, mode: &str) -> Result<Value, String> {
    if !name.ends_with(EXT) || name.contains('/') || name.contains('\\') {
        return Err("备份文件名不合法".into());
    }
    let c = shared.config();
    let (base, auth) = remote_base(&c)?;
    let env = net::get_text(&format!("{base}{name}"), auth.as_deref(), None)?;
    apply(shared, &env, mode)
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

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// PBKDF2-HMAC-SHA256 的公开测试向量。
    ///
    /// 这段是自己实现的（为了跟 Android 的 javax.crypto 参数完全一致），
    /// 所以必须钉死在标准值上：算错了不会崩，只会让"另一端解不开"。
    #[test]
    fn pbkdf2_matches_known_vectors() {
        let mut out = [0u8; 32];
        pbkdf2_sha256(b"password", b"salt", 1, &mut out);
        assert_eq!(
            hex(&out),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        pbkdf2_sha256(b"password", b"salt", 2, &mut out);
        assert_eq!(
            hex(&out),
            "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"
        );
        pbkdf2_sha256(b"password", b"salt", 4096, &mut out);
        assert_eq!(
            hex(&out),
            "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
        );
    }

    /// 跨设备信封：能解开、错密码拒绝、AAD 不同不能混用
    #[test]
    fn portable_envelope_roundtrip() {
        // 测试里用低迭代（正式 600000 在 debug 下太慢），读的时候以文件里的 iter 为准
        let plain = r#"{"kof":"king-of-focus","rules":[]}"#;
        let env = seal_portable_with(plain, "phonepass", 10_000).unwrap();
        assert!(env.contains("\"kofEnc\":3"), "{env}");
        assert!(!env.contains("rules"), "明文泄漏");
        assert_eq!(unlock(&env, "phonepass").unwrap(), plain);
        assert!(unlock(&env, "wrong").is_err(), "错密码必须拒绝");
        // 没填密码时说清楚，而不是报"文件损坏"
        let e = unlock(&env, "").unwrap_err();
        assert!(e.contains("密码"), "{e}");
    }

    /// 一次性工具：生成"桌面端加密备份"的样例，供手机端单元测试真实解开。
    /// 跑法：cargo test --offline __gen_interop_fixture -- --ignored
    #[test]
    #[ignore]
    fn __gen_interop_fixture() {
        let plain = include_str!("../../tools/fixtures/portable-v1.json");
        let env = seal_portable_with(plain, "kof-demo-2026", 20_000).unwrap();
        let p = std::path::Path::new("../tools/fixtures/portable-enc.json");
        std::fs::write(p, env).unwrap();
    }

    /// 反向互通：这份是**手机端真机导出**的加密备份（它自己写的 600000 轮 PBKDF2），
    /// 桌面端必须解得开。方向反过来也验一遍，才不是"我能读你、你读不了我"。
    ///
    /// 生成方式：手机「设置 → 备份与恢复」填密码 kof-demo-2026 → 导出 → adb pull 回来。
    #[test]
    fn android_envelope_opens_on_desktop() {
        let env = include_str!("../../tools/fixtures/portable-enc-android.json");
        assert!(env.contains("\"kofEnc\":3"), "应该是跨设备信封");
        assert!(env.contains("\"iter\":600000"), "真机导出应写 600000 轮");
        let plain = unlock(env, "kof-demo-2026").expect("桌面端必须能解开手机导出的备份");
        let p = portable::parse(&plain).expect("解开后必须是合法文档");
        assert_eq!(p.doc.source, "android");
        assert_eq!(p.doc.rules.len(), 2);
        // 桌面端的 3 个小时段在"桌面 → 手机 → 再导出"之后必须还在
        let on = p
            .doc
            .clock
            .active_profile()
            .map(|x| x.days.iter().flatten().filter(|h| h.on).count())
            .unwrap_or(0);
        assert_eq!(on, 3, "时段跟着备份走了一圈，不能丢");
        // 落到桌面配置：exe/site 之外，pkg 条目要原样保留（手机端就是靠它拦应用）
        let c = p.doc.to_config(&Config::default());
        assert_eq!(c.rules.len(), 2);
        let mut base = Config::default();
        base.rules.clear();
        let (_c, st) = p.doc.merge(&base);
        assert_eq!(st.added, 2, "空配置里合并两份规则，应该都是新增");
    }

    /// 没设密码的导出就是明文：这是有意的（DPAPI 出了这台机器就打不开）
    #[test]
    fn portable_plain_when_no_password() {
        let doc = r#"{"kof":"king-of-focus","format":"kof-portable","schema":1}"#;
        assert_eq!(seal_portable(doc, "").unwrap(), doc);
        assert_eq!(unlock(doc, "").unwrap(), doc, "明文要能原样回到解析层");
        let env = seal_portable_with(doc, "pw", 10_000).unwrap();
        assert!(env.starts_with('{') && env.contains("kofEnc"));
    }

}
