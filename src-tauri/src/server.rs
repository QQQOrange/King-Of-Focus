//! 供浏览器扩展使用的本地 HTTP 服务（只监听 127.0.0.1）

use crate::sched;
use crate::shared::Shared;
use serde_json::json;
use std::io::Read;
use std::sync::Arc;
use std::thread;
use tiny_http::{Header, Method, Request, Response, Server};

pub fn start(app: tauri::AppHandle, shared: Arc<Shared>) {
    thread::spawn(move || {
        let port = shared.config().settings.port;
        let addr = format!("127.0.0.1:{port}");
        let server = match Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[扩展服务] 端口 {port} 启动失败: {e}（可能被占用）");
                return;
            }
        };
        println!("[King of Focus] 扩展服务已监听 http://{addr}");
        for request in server.incoming_requests() {
            handle(&app, &shared, request);
        }
    });
}

fn cors<W: std::io::Write + std::io::Read>(resp: &mut Response<W>) {
    for (k, v) in [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Headers", "*"),
        ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
        ("Cache-Control", "no-store"),
    ] {
        if let Ok(h) = Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            let _ = resp.add_header(h);
        }
    }
}

fn reply(req: Request, code: u16, body: String) {
    let mut resp = Response::from_string(body).with_status_code(code);
    cors(&mut resp);
    let _ = req.respond(resp);
}

fn handle(app: &tauri::AppHandle, shared: &Arc<Shared>, mut req: Request) {
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();

    if *req.method() == Method::Options {
        let mut resp = Response::empty(204);
        cors(&mut resp);
        let _ = req.respond(resp);
        return;
    }

    match path.as_str() {
        "/api/ping" => reply(req, 200, json!({"ok": true, "app": "King of Focus", "v": 1}).to_string()),
        // 仅 KOF_DEBUG=1 时开放，供自动化验收脚本驱动遮罩（与 UI 走同一函数）
        "/api/debug/mask" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let on = !url.contains("off=1");
                let m = &*shared.mask;
                if on {
                    match crate::cmds::mask_test_inner(app, shared) {
                        Ok(v) => reply(req, 200, json!({"ok": true, "testing": v}).to_string()),
                        Err(e) => reply(req, 500, json!({"error": e}).to_string()),
                    }
                } else {
                    m.on.store(false, std::sync::atomic::Ordering::Relaxed);
                    reply(req, 200, json!({"ok": true, "testing": false}).to_string())
                }
            }
        }
        "/api/debug/follow" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let h = url
                    .split("hwnd=")
                    .nth(1)
                    .and_then(|v| v.split('&').next())
                    .and_then(|v| isize::from_str_radix(v.trim_start_matches("0x"), 16).ok())
                    .unwrap_or(0);
                crate::mask::FOLLOW_OVERRIDE.store(h, std::sync::atomic::Ordering::Relaxed);
                reply(req, 200, json!({"ok": true, "follow": h}).to_string())
            }
        }
        "/api/debug/diag" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let d = crate::mask::DIAG
                    .lock()
                    .map(|s| s.clone())
                    .unwrap_or_default();
                reply(req, 200, json!({"diag": d, "maskOn": shared.mask.on.load(std::sync::atomic::Ordering::Relaxed)}).to_string())
            }
        }
        "/api/state" => reply(req, 200, state_json(shared)),
        "/api/heartbeat" => {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let v = serde_json::from_str::<serde_json::Value>(&body).unwrap_or(serde_json::Value::Null);
            let browser = v
                .get("browser")
                .and_then(|b| b.as_str())
                .unwrap_or("unknown")
                .to_string();
            let url = v.get("url").and_then(|b| b.as_str()).unwrap_or("").to_string();
            let title = v.get("title").and_then(|b| b.as_str()).unwrap_or("").to_string();
            if let Ok(mut rt) = shared.rt.lock() {
                rt.hb_ts = chrono::Local::now().timestamp();
                rt.hb_browser = browser;
                if !url.is_empty() {
                    rt.site_url = url;
                    rt.site_title = title;
                    rt.site_ts = rt.hb_ts;
                }
            }
            reply(req, 200, json!({"ok": true}).to_string())
        }
        "/api/report" => {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("?").to_string();
                let rule = v.get("rule").and_then(|x| x.as_str()).unwrap_or("网站黑名单").to_string();
                shared.log("site", url.clone(), rule.clone(), "浏览器插件拦截".into());
                // 先弹通知，插件端会在收到响应后延迟几百毫秒再关页面
                crate::notify::blocked_site(app, &url, &rule);
                // 网页被拦 → 同样把主程序拉到前台首页
                crate::monitor::focus_main(app, shared);
            }
            reply(req, 200, json!({"ok": true}).to_string())
        }
        "/" => reply(
            req,
            200,
            json!({
                "app": "King of Focus",
                "usage": "浏览器扩展通过 /api/state 获取当前生效的网站规则",
                "endpoints": ["/api/ping", "/api/state", "/api/heartbeat", "/api/report"]
            })
            .to_string(),
        ),
        _ => reply(req, 404, json!({"error": "not found"}).to_string()),
    }
}

fn state_json(shared: &Shared) -> String {
    let cfg = shared.config();
    let now = sched::now_local();
    let rules: Vec<serde_json::Value> = cfg
        .lists
        .iter()
        .filter(|l| l.enabled && sched::is_active(&l.schedule, &now))
        .map(|l| {
            json!({
                "name": l.name,
                "mode": l.mode,
                "sites": l.sites.iter().map(|s| s.pattern.clone()).collect::<Vec<String>>(),
                "exceptions": l.exceptions,
            })
        })
        .collect();
    json!({
        "active": !rules.is_empty(),
        "maskOn": false,
        "rules": rules,
        // 插件据此决定：只关标签页，还是连整个浏览器窗口一起关
        "siteCloseBrowser": cfg.settings.site_close_browser,
        "serverTime": chrono::Local::now().timestamp(),
    })
    .to_string()
}
