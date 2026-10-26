//! 供浏览器扩展使用的本地 HTTP 服务（只监听 127.0.0.1）

use crate::sched;
use crate::shared::Shared;
use serde_json::json;
use std::io::Read;
use std::sync::Arc;
use std::thread;
use tiny_http::{Header, Method, Request, Response, Server};

pub fn start(shared: Arc<Shared>) {
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
            handle(&shared, request);
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

fn handle(shared: &Arc<Shared>, mut req: Request) {
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
                shared.log("site", url, rule, "浏览器插件拦截".into());
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
        "serverTime": chrono::Local::now().timestamp(),
    })
    .to_string()
}
