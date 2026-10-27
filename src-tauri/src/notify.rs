//! 拦截通知窗
//!
//! 「先通知、再关闭」体验的载体：一个右上角的圆角小卡片，置顶、不抢焦点、
//! 不占任务栏，显示几秒后自动收起。
//!
//! 注意两点：
//! - 通知必须压得住专注遮罩，所以要周期性把它重新顶到置顶带最前面；
//! - 同一目标 1.5 秒内只弹一次，避免一次拦截刷出好几张卡片。

use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

static LAST: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// 同一 key 在 within 内只弹一次
fn allow(key: &str, within: Duration) -> bool {
    let mut g = match LAST.lock() {
        Ok(v) => v,
        Err(_) => return true,
    };
    let map = g.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    if let Some(t) = map.get(key) {
        if now.duration_since(*t) < within {
            return false;
        }
    }
    map.insert(key.to_string(), now);
    // 顺手清理过期项，避免长期运行后无限增长
    if map.len() > 64 {
        map.retain(|_, t| now.duration_since(*t) < Duration::from_secs(120));
    }
    true
}

/// 弹出拦截通知
///
/// - `kind`：`app` 或 `site`
/// - `title`：主标题，如「已拦截：Steam」
/// - `body`：副标题（允许含 HTML，调用方负责转义）
/// - `tag`：右下角小标签，如命中的规则名
/// - `secs`：停留秒数
pub fn toast(app: &AppHandle, kind: &str, title: &str, body: &str, tag: &str, secs: u64) {
    let Some(w) = app.get_webview_window("toast") else {
        return;
    };

    // 放到主屏右上角
    if let Ok(Some(m)) = app.primary_monitor() {
        let mp = m.position();
        let ms = m.size();
        let scale = m.scale_factor();
        if let Ok(ws) = w.outer_size() {
            let margin = (22.0 * scale) as i32;
            let x = mp.x + ms.width as i32 - ws.width as i32 - margin;
            let y = mp.y + margin;
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }

    // 关掉再打开置顶，把它插到置顶带的最前面（比专注遮罩更靠上）
    let _ = w.set_always_on_top(false);
    let _ = w.set_always_on_top(true);

    let _ = w.emit(
        "kof-toast",
        serde_json::json!({
            "kind": kind,
            "title": title,
            "body": body,
            "tag": tag,
            "secs": secs,
        }),
    );
    let _ = w.show();

    // 可见期间持续压制其他置顶窗口，到点收起
    let wk = w.clone();
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(250));
            let _ = wk.set_always_on_top(false);
            let _ = wk.set_always_on_top(true);
        }
        let _ = wk.hide();
    });
}

/// 应用被拦截时的通知（带去重）
pub fn blocked_app(app: &AppHandle, label: &str, rule: &str) {
    if !allow(&format!("app:{label}"), Duration::from_millis(1500)) {
        return;
    }
    let body = format!(
        "<b>{}</b><br>自律模式生效中，这个程序马上会被关闭。",
        html(label)
    );
    toast(app, "app", "已拦截这个应用", &body, rule, 4);
}

/// 网页被拦截时的通知（带去重）
pub fn blocked_site(app: &AppHandle, url: &str, rule: &str) {
    if !allow(&format!("site:{url}"), Duration::from_millis(1500)) {
        return;
    }
    let short = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .chars()
        .take(56)
        .collect::<String>();
    let body = format!(
        "<b>{}</b><br>自律模式生效中，这个网页马上会被关闭。",
        html(&short)
    );
    toast(app, "site", "已拦截这个网页", &body, rule, 4);
}

fn html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 供外部拼提示文案时转义 HTML
pub fn esc(s: &str) -> String {
    html(s)
}
