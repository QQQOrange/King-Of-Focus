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

/// 带自定义超时的 GET 文本（更新检测用：连不上就快速失败，别让用户干等）
pub fn get_text_t(
    url: &str,
    auth: Option<&str>,
    accept: Option<&str>,
    connect: Duration,
    total: Duration,
) -> Result<String, String> {
    let mut req = ureq::AgentBuilder::new()
        .timeout_connect(connect)
        .timeout(total)
        .build()
        .get(url)
        .set("User-Agent", UA);
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

pub fn get_json_t(
    url: &str,
    auth: Option<&str>,
    connect: Duration,
    total: Duration,
) -> Result<Value, String> {
    let body = get_text_t(url, auth, Some("application/vnd.github+json"), connect, total)?;
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

/// WebDAV 建目录（MKCOL）。
///
/// 为什么需要：默认地址带一层子目录（`/dav/KingOfFocus/`），而 WebDAV 的 PUT
/// **不会**自动建父目录——目录不存在时服务端回 409，用户看到的就是"上传失败"。
/// 以前这一条只能靠在提示里写"请先在服务端创建对应目录"，等于让用户自己动手。
///
/// 已经存在时按 RFC 4918 返回 405，视为成功；301/302 是服务器把目录重定向到
/// 带尾斜杠的地址，也算存在。
pub fn mkcol(url: &str, auth: Option<&str>) -> Result<(), String> {
    let mut req = agent().request("MKCOL", url).set("User-Agent", UA);
    if let Some(a) = auth {
        req = req.set("Authorization", a);
    }
    match req.call() {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(405, _)) => Ok(()),
        Err(ureq::Error::Status(c, _)) if c == 301 || c == 302 => Ok(()),
        Err(e) => Err(describe(e)),
    }
}

/// 逐级补建 URL 上的目录，**失败不报错**（只要别把主流程卡住）。
///
/// 用途：PUT 之前铺路。对 `https://host/dav/A/B/` 会依次 MKCOL `/dav/`、`/dav/A/`、
/// `/dav/A/B/`；对 `https://host/dav/A/file.json` 只会建到 `A/`（最后一段当文件名）。
/// 只读账号、不支持 MKCOL 的网盘会让这些调用失败——那就失败，PUT 自己会报出真正的原因。
/// 要逐级创建的那些目录 URL（纯函数，可单测）。
///
/// 单独抽出来的理由：`ensure_dir` 会发网络请求，测不了"建到哪一级"；
/// 而"把文件名当目录建"这种错误一旦发生，表现是**多出一堆空目录**，
/// 谁也不会立刻发现。
pub fn dir_urls(url: &str) -> Vec<String> {
    let Some(pos) = url.find("://").map(|i| i + 3) else {
        return Vec::new();
    };
    let Some(slash) = url[pos..].find('/').map(|i| pos + i) else {
        return Vec::new();
    };
    let head = &url[..=slash];
    let path = &url[slash + 1..];
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.is_empty() {
        return Vec::new();
    }
    // 末段像文件名（含点、且整串不以 / 结尾）就不当目录建
    let last = segs[segs.len() - 1];
    let is_file = !url.ends_with('/') && last.contains('.');
    let n = if is_file { segs.len() - 1 } else { segs.len() };
    let mut acc = String::from(head);
    let mut out = Vec::new();
    for seg in segs.iter().take(n) {
        acc.push_str(seg);
        acc.push('/');
        out.push(acc.clone());
    }
    out
}

pub fn ensure_dir(url: &str, auth: Option<&str>) {
    for dir in dir_urls(url) {
        let _ = mkcol(&dir, auth);
    }
}

/// 只发给本机 127.0.0.1 的 POST（不重试、短超时）。
/// 新实例用它请已经运行的那个实例"提权重启"。
pub fn post_local(url: &str, body: &str, timeout: std::time::Duration) -> Result<String, String> {
    let a = ureq::AgentBuilder::new().timeout(timeout).build();
    let r = a
        .post(url)
        .set("Content-Type", "application/json")
        .send_string(body)
        .map_err(|e| describe(e))?;
    r.into_string().map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认地址要建到哪一级：`/dav/` 和 `/dav/KingOfFocus/`，**不能**把文件名当目录。
    #[test]
    fn dir_urls_walks_each_level() {
        assert_eq!(
            dir_urls("https://dav.jianguoyun.com/dav/KingOfFocus/"),
            vec![
                "https://dav.jianguoyun.com/dav/".to_string(),
                "https://dav.jianguoyun.com/dav/KingOfFocus/".to_string(),
            ]
        );
        // 带文件名时最后一段不算目录
        assert_eq!(
            dir_urls("https://host/dav/A/file.json"),
            vec!["https://host/dav/".to_string(), "https://host/dav/A/".to_string()]
        );
        // 根目录 / 非法输入：不产生任何 MKCOL
        assert!(dir_urls("https://host/").is_empty());
        assert!(dir_urls("dav.jianguoyun.com/dav/").is_empty());
    }
}
