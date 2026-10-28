//! 供浏览器扩展使用的本地 HTTP 服务（只监听 127.0.0.1）

use crate::sched;
use crate::shared::Shared;
use serde_json::json;
use std::io::Read;
use std::sync::Arc;
use std::thread;
use tauri::Manager;
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
        // 每个请求单独一个线程：本地服务里有些处理会读盘（扫浏览器配置档），
        // 单线程轮询会让"某个慢请求"堵住后面的心跳，插件就会被误判成掉线。
        for request in server.incoming_requests() {
            let app = app.clone();
            let shared = shared.clone();
            thread::spawn(move || handle(&app, &shared, request));
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
        "/api/debug/testmode" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let res = if url.contains("enter=1") {
                    crate::cmds::test_mode_enter_impl(shared)
                } else {
                    crate::cmds::test_mode_exit_impl(shared, url.contains("keep=1"))
                };
                match res {
                    Ok(v) => reply(req, 200, v.to_string()),
                    Err(e) => reply(req, 500, json!({"error": e}).to_string()),
                }
            }
        }
        "/api/debug/start" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let pid = url
                    .split("pid=")
                    .nth(1)
                    .and_then(|v| v.split('&').next())
                    .and_then(|v| v.parse::<u32>().ok())
                    .unwrap_or(0);
                match crate::proc::find_window_by_pid(pid) {
                    Some(h) => {
                        let m = &*shared.mask;
                        m.test_lock.store(false, std::sync::atomic::Ordering::Relaxed);
                        m.target.store(h as isize, std::sync::atomic::Ordering::Relaxed);
                        m.target_pid.store(pid, std::sync::atomic::Ordering::Relaxed);
                        m.manual_hwnd.store(h as isize, std::sync::atomic::Ordering::Relaxed);
                        m.painted.store(false, std::sync::atomic::Ordering::Relaxed);
                        m.on.store(true, std::sync::atomic::Ordering::Relaxed);
                        reply(req, 200, json!({"ok": true, "hwnd": h as isize, "pid": pid}).to_string())
                    }
                    None => reply(req, 404, json!({"error": "找不到该进程的窗口"}).to_string()),
                }
            }
        }
        "/api/debug/events" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let evs = shared
                    .rt
                    .lock()
                    .map(|rt| rt.events.iter().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                reply(req, 200, json!({ "events": evs }).to_string())
            }
        }
        "/api/debug/update" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let c = shared.config();
                reply(req, 200, crate::update::check(&c.settings.update).to_string())
            }
        }
        "/api/debug/ext" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                // ?open=<浏览器key> 时真的执行"打开扩展页"，便于端到端验证
                // 注意：路由已经把 query 剥给 `path` 了，要用原始 `url` 取参数
                let open_key = url
                    .split_once("open=")
                    .map(|(_, v)| v.split('&').next().unwrap_or("").to_string())
                    .filter(|k| !k.is_empty());
                if let Some(key) = open_key {
                    match crate::browsers::open_ext_page(&key) {
                        Ok(msg) => reply(req, 200, json!({"ok": true, "msg": msg}).to_string()),
                        Err(e) => reply(req, 200, json!({"ok": false, "err": e}).to_string()),
                    }
                } else {
                    let loc = crate::browsers::ext_location();
                    reply(req, 200, serde_json::to_string(&loc).unwrap_or_default())
                }
            }
        }
        "/api/debug/browsers" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let list = crate::browsers::scan(true);
                reply(req, 200, json!({"list": list}).to_string())
            }
        }
        "/api/debug/browsers_probe" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let p = url
                    .split("path=")
                    .nth(1)
                    .map(|v| percent_decode(v.split('&').next().unwrap_or("")))
                    .unwrap_or_default();
                let hits = crate::browsers::probe_profiles(&p);
                reply(req, 200, json!({"hits": hits}).to_string())
            }
        }
        "/api/debug/maskpreview" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                match crate::cmds::mask_test_inner(&app, shared) {
                    Ok(v) => reply(req, 200, json!({"ok": true, "preview": v}).to_string()),
                    Err(e) => reply(req, 500, json!({"error": e}).to_string()),
                }
            }
        }
        "/api/debug/maskcfg" => {
            // 供自动化验收脚本设置遮罩参数（与 UI 走同一套运行态）
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let m = &*shared.mask;
                let q = |k: &str| -> Option<i64> {
                    url.split(k)
                        .nth(1)
                        .and_then(|v| v.split('&').next())
                        .and_then(|v| v.parse::<i64>().ok())
                };
                if let Some(v) = q("opacity=") {
                    m.opacity.store(v.clamp(0, 100) as u8, std::sync::atomic::Ordering::Relaxed);
                }
                if let Some(v) = q("follow=") {
                    m.follow.store(v != 0, std::sync::atomic::Ordering::Relaxed);
                }
                if let Some(v) = q("blockclick=") {
                    m.block_click.store(v != 0, std::sync::atomic::Ordering::Relaxed);
                }
                crate::mask::wake();
                reply(
                    req,
                    200,
                    json!({
                        "ok": true,
                        "opacity": m.opacity.load(std::sync::atomic::Ordering::Relaxed),
                        "follow": m.follow.load(std::sync::atomic::Ordering::Relaxed),
                        "blockClick": m.block_click.load(std::sync::atomic::Ordering::Relaxed),
                    })
                    .to_string(),
                )
            }
        }
        "/api/debug/maskon" | "/api/debug/maskoff" => {
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let on = path.ends_with("maskon");
                let m = &*shared.mask;
                m.test_lock.store(false, std::sync::atomic::Ordering::Relaxed);
                m.on.store(on, std::sync::atomic::Ordering::Relaxed);
                crate::mask::wake();
                reply(req, 200, json!({"ok": true, "on": on}).to_string())
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
        "/api/debug/front" => {
            // 仅测试用：把主窗口拉到前台，用来验证"遮罩对自身是否生效"
            if std::env::var("KOF_DEBUG").as_deref() != Ok("1") {
                reply(req, 403, json!({"error": "debug disabled"}).to_string())
            } else {
                let mut h = 0isize;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                    if let Ok(x) = w.hwnd() {
                        h = x.0 as isize;
                    }
                }
                reply(req, 200, json!({"ok": true, "hwnd": h}).to_string())
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
            // 给浏览器巡检留一份心跳镜像：能发心跳就是"插件确实在跑"的活证据
            crate::browsers::note_heartbeat(&browser);
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

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn state_json(shared: &Shared) -> String {
    let cfg = shared.config();
    let now = sched::now_local();
    // 关键：判定口径必须和 monitor.rs（真正在拦软件的那份）完全一致。
    // 以前这里只看"规则自己的时间表"，把「自律时段接管」和「休息段整体暂停」漏掉了，
    // 结果就是：自律时段里主程序在拦软件，插件却一条规则都收不到，
    // 网站黑名单（抖音等）照常能看。
    let dstate = crate::discipline::state(&cfg, &now);
    let active = crate::discipline::active_rules(&cfg, &now, &dstate);
    let rules: Vec<serde_json::Value> = active
        .iter()
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
        // 遮罩是否真的开着：以前这里写死 false，插件/脚本读到的永远是"没开"
        "maskOn": shared.mask.on.load(std::sync::atomic::Ordering::Relaxed),
        "rules": rules,
        // 自律时段接管中：插件据此知道"现在不是按规则自己的时间表在拦"
        "clockOn": dstate.clock_on,
        "clockBreak": dstate.clock_break,
        // 插件据此决定：只关标签页，还是连整个浏览器窗口一起关
        "siteCloseBrowser": cfg.settings.site_close_browser,
        "serverTime": chrono::Local::now().timestamp(),
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Config;

    /// `/api/state` 里的 maskOn 必须反映真实运行态。
    /// 早期这里写死 `false`，插件/脚本永远读到"遮罩没开"。
    #[test]
    fn state_reports_real_mask_switch() {
        let shared = Shared::new(Config::default());

        shared.mask.on.store(false, std::sync::atomic::Ordering::Relaxed);
        let v: serde_json::Value = serde_json::from_str(&state_json(&shared)).unwrap();
        assert_eq!(v["maskOn"], serde_json::json!(false));

        shared.mask.on.store(true, std::sync::atomic::Ordering::Relaxed);
        let v: serde_json::Value = serde_json::from_str(&state_json(&shared)).unwrap();
        assert_eq!(v["maskOn"], serde_json::json!(true));
    }

    /// 没配任何规则时段时，插件应该收到 active=false（否则会误拦全站）
    #[test]
    fn state_inactive_without_rules() {
        let shared = Shared::new(Config::default());
        let v: serde_json::Value = serde_json::from_str(&state_json(&shared)).unwrap();
        assert_eq!(v["active"], serde_json::json!(false));
        assert_eq!(v["rules"].as_array().map(|a| a.len()), Some(0));
    }
}
