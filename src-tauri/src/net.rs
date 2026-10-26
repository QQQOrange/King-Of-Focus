//! 极简 HTTP 客户端封装（ureq + native-tls，走 Windows schannel，不引入 C 依赖）

use serde_json::Value;
use std::time::Duration;

pub const UA: &str = "KingOfFocus/1.0 (Windows; +https://github.com/QQQOrange/King-Of-Focus)";

pub fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
}

/// base64（为了 basic auth，避免多引一个 crate）
pub fn b64(input: &str) -> String {
    const CH: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(CH[((n >> 18) & 63) as usize] as char);
        out.push(CH[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { CH[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { CH[(n & 63) as usize] as char } else { '=' });
    }
    out
}

pub fn basic_auth(user: &str, pass: &str) -> String {
    format!("Basic {}", b64(&format!("{user}:{pass}")))
}

pub fn describe(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => match code {
            401 => "认证失败（401）：用户名 / 密码或令牌不正确".to_string(),
            403 => "无权限（403）：可能是权限不足或触发了频率限制".to_string(),
            404 => "地址不存在（404）：请检查路径是否写对".to_string(),
            405 => "方法不被允许（405）：该地址可能不支持写入".to_string(),
            409 => "目录不存在（409）：请先在服务端创建对应目录".to_string(),
            423 => "资源被锁定（423）".to_string(),
            429 => "请求过于频繁（429）".to_string(),
            507 => "空间不足（507）".to_string(),
            _ => format!("服务端返回 HTTP {code}"),
        },
        ureq::Error::Transport(t) => format!("网络错误：{t}"),
    }
}

pub fn get_text(url: &str, auth: Option<&str>, accept: Option<&str>) -> Result<String, String> {
    let mut req = agent().get(url).set("User-Agent", UA);
    if let Some(a) = auth {
        req = req.set("Authorization", a);
    }
    if let Some(ac) = accept {
        req = req.set("Accept", ac);
    }
    match req.call() {
        Ok(r) => r.into_string().map_err(|e| format!("读取响应失败：{e}")),
        Err(e) => Err(describe(e)),
    }
}

pub fn get_json(url: &str, auth: Option<&str>) -> Result<Value, String> {
    let body = get_text(url, auth, Some("application/vnd.github+json"))?;
    serde_json::from_str::<Value>(&body).map_err(|e| format!("响应不是合法 JSON：{e}"))
}

pub fn put_text(url: &str, auth: Option<&str>, body: &str) -> Result<(), String> {
    let mut req = agent()
        .put(url)
        .set("User-Agent", UA)
        .set("Content-Type", "application/json; charset=utf-8");
    if let Some(a) = auth {
        req = req.set("Authorization", a);
    }
    match req.send_string(body) {
        Ok(_) => Ok(()),
        Err(e) => Err(describe(e)),
    }
}

pub fn delete(url: &str, auth: Option<&str>) -> Result<(), String> {
    let mut req = agent().delete(url).set("User-Agent", UA);
    if let Some(a) = auth {
        req = req.set("Authorization", a);
    }
    match req.call() {
        Ok(_) => Ok(()),
        Err(e) => Err(describe(e)),
    }
}
