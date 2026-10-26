use crate::matcher;
use crate::model::{Config, RuleList};
use crate::proc::{self, WinApp};
use crate::sched;
use crate::shared::Shared;
use std::collections::HashMap;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub fn start(shared: Arc<Shared>) {
    thread::spawn(move || {
        let mut pending: HashMap<u32, Instant> = HashMap::new();
        let mut logged: HashMap<u32, Instant> = HashMap::new();
        let self_pid = std::process::id();

        loop {
            let cfg: Config = shared.config();
            let poll = cfg.settings.poll_ms.clamp(300, 5000);
            let now = sched::now_local();
            let today = now.format("%Y-%m-%d").to_string();

            let active: Vec<RuleList> = cfg
                .lists
                .iter()
                .filter(|l| l.enabled && sched::is_active(&l.schedule, &now))
                .cloned()
                .collect();

            let next_change = cfg
                .lists
                .iter()
                .filter(|l| l.enabled)
                .filter_map(|l| sched::seconds_until_change(&l.schedule, &now))
                .min()
                .unwrap_or(0);

            if let Ok(mut rt) = shared.rt.lock() {
                if rt.day != today {
                    rt.day = today;
                    rt.blocked_apps = 0;
                    rt.blocked_sites = 0;
                }
                rt.active = active.iter().map(|l| (l.name.clone(), l.mode.clone())).collect();
                rt.next_change = next_change;
            }

            pending.retain(|_, t| t.elapsed().as_secs() < 45);
            logged.retain(|_, t| t.elapsed().as_secs() < 20);

            if !active.is_empty() {
                let apps = proc::screen_apps();

                // 1) 应用拦截
                for a in apps.iter() {
                    if a.pid == self_pid {
                        continue;
                    }
                    let mut blocked_by: Option<&RuleList> = None;
                    for l in active.iter() {
                        if l.mode == "whitelist" {
                            let protected = matcher::is_protected(a, &cfg.settings.protected)
                                || l.extra_protected
                                    .iter()
                                    .any(|p| p.eq_ignore_ascii_case(&a.name));
                            if !protected && !matcher::rule_allows_app(l, a) {
                                blocked_by = Some(l);
                                break;
                            }
                        } else if matcher::rule_blocks_app(l, a) {
                            blocked_by = Some(l);
                            break;
                        }
                    }
                    match blocked_by {
                        Some(rule) => on_block(&shared, &cfg, a, rule, &mut pending, &mut logged),
                        None => {
                            pending.remove(&a.pid);
                        }
                    }
                }

                // 2) 浏览器守护：允许拦截网站时，扩展失联就关掉浏览器
                if cfg.settings.guard_browser && active.iter().any(|l| !l.sites.is_empty()) {
                    let (hb_ts, hb_browser) = match shared.rt.lock() {
                        Ok(rt) => (rt.hb_ts, rt.hb_browser.clone()),
                        Err(_) => (0, String::new()),
                    };
                    let now_ts = chrono::Local::now().timestamp();
                    let alive = hb_ts > 0 && now_ts - hb_ts <= cfg.settings.grace_secs as i64;
                    if hb_ts > 0 && !alive {
                        for a in apps.iter().filter(|a| matcher::is_browser(a)) {
                            if proc::terminate(a.pid) {
                                let label = if hb_browser.is_empty() {
                                    a.name.clone()
                                } else {
                                    hb_browser.clone()
                                };
                                if !cfg.settings.dry_run {
                                    shared.log(
                                        "app",
                                        format!("{} — {}", label, a.title),
                                        "浏览器守护".into(),
                                        "扩展失联，已强制关闭浏览器".into(),
                                    );
                                }
                            }
                        }
                    }
                }
            }

            thread::sleep(Duration::from_millis(poll));
        }
    });
}

fn on_block(
    shared: &Shared,
    cfg: &Config,
    app: &WinApp,
    rule: &RuleList,
    pending: &mut HashMap<u32, Instant>,
    logged: &mut HashMap<u32, Instant>,
) {
    let label = if app.title.is_empty() {
        app.name.clone()
    } else {
        format!("{} — {}", app.name, app.title)
    };

    if cfg.settings.dry_run {
        let first = !logged.contains_key(&app.pid);
        if first {
            logged.insert(app.pid, Instant::now());
            shared.log(
                "app",
                label,
                rule.name.clone(),
                "演练模式：本应拦截（未真的关闭）".into(),
            );
        }
        return;
    }

    if cfg.settings.soft_close {
        match pending.get(&app.pid) {
            None => {
                let ok = proc::soft_close(app.hwnd);
                pending.insert(app.pid, Instant::now());
                if !logged.contains_key(&app.pid) {
                    logged.insert(app.pid, Instant::now());
                    shared.log(
                        "app",
                        label,
                        rule.name.clone(),
                        if ok {
                            "已发送关闭请求".into()
                        } else {
                            "已拦截".into()
                        },
                    );
                }
            }
            Some(t) => {
                if t.elapsed().as_millis() >= 700 {
                    let ok = proc::terminate(app.pid);
                    pending.insert(app.pid, Instant::now());
                    if !ok {
                        let first = !logged.contains_key(&app.pid);
                        if first {
                            logged.insert(app.pid, Instant::now());
                            shared.log(
                                "app",
                                label,
                                rule.name.clone(),
                                "拦截失败：权限不足，请以管理员身份运行".into(),
                            );
                        }
                    }
                }
            }
        }
    } else {
        let ok = proc::terminate(app.pid);
        let key = logged.get(&app.pid).map(|t| t.elapsed().as_secs() >= 5).unwrap_or(true);
        if key || !ok {
            logged.insert(app.pid, Instant::now());
            shared.log(
                "app",
                label,
                rule.name.clone(),
                if ok { "已强制结束".into() } else { "拦截失败：权限不足".into() },
            );
        }
    }
}
