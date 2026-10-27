use crate::guard;
use crate::matcher;
use crate::model::{Config, RuleList};
use crate::proc::{self, WinApp};
use crate::sched;
use crate::shared::Shared;
use std::collections::HashMap;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 把主窗口拉到前台并跳到首页（带 1.5 秒防抖，避免疯狂抢焦点）
pub fn focus_main(app: &AppHandle, shared: &Shared) {
    let now_ms = chrono::Local::now().timestamp_millis();
    let go = match shared.rt.lock() {
        Ok(mut rt) => {
            if now_ms - rt.last_focus < 1500 {
                false
            } else {
                rt.last_focus = now_ms;
                true
            }
        }
        Err(_) => false,
    };
    if !go {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("goto-home", ());
}

pub fn start(app: AppHandle, shared: Arc<Shared>) {
    thread::spawn(move || {
        let mut pending: HashMap<u32, Instant> = HashMap::new();
        let mut logged: HashMap<u32, Instant> = HashMap::new();
        let self_pid = std::process::id();
        let mut acc_ms: u64 = 0;
        let mut guard_running = false;
        let mut notified_phase = false;
        let mut last_break_left: i64 = 0;
        let mut browser_guard = crate::browsers::GuardState::new();

        loop {
            let cfg: Config = shared.config();
            let poll = cfg.settings.poll_ms.clamp(300, 5000);
            let now = sched::now_local();
            let today = now.format("%Y-%m-%d").to_string();

            // ---- 固化（硬锁）状态 ----
            let lock = guard::lock_info(&cfg);
            if lock.locked {
                guard::write_heartbeat();
                if !guard_running {
                    guard::ensure_guard();
                    guard_running = true;
                }
            } else if guard_running {
                guard::stop_guard();
                guard_running = false;
            }

            // ---- 「自律时段」：0–24 点的 24 段计划 ----
            // 它和规则时段不是二选一：时钟选中且 applyRules 打开时，规则直接生效
            // （忽略规则自己的时段），时钟的休息段则把拦截整体暂停。
            // 判定统一放在 discipline 模块，插件服务端（server.rs）用的是同一份，
            // 否则会出现"主程序在拦软件、插件却收不到规则"的黑名单失效。
            let dstate = crate::discipline::state(&cfg, &now);
            let clock_in = dstate.clock_in;
            let clock_break = dstate.clock_break;
            let clock_on = dstate.clock_on;

            // ---- 生效中的规则（休息段内的规则暂时放行）----
            let active: Vec<RuleList> = crate::discipline::active_rules(&cfg, &now, &dstate);

            // 当前是否有规则处于「休息」
            let on_break = dstate.on_break;

            let next_change = cfg
                .lists
                .iter()
                .filter(|l| l.enabled)
                .filter_map(|l| sched::seconds_until_change(&l.schedule, &now))
                .chain(crate::clock::seconds_until_change(&cfg))
                .min()
                .unwrap_or(0);

            // 番茄阶段（优先用小时段的计划，其次是第一条带番茄的生效规则）
            let (break_now, break_left) = if dstate.clock_in {
                (dstate.clock_break, dstate.clock_left)
            } else {
                cfg
                    .lists
                    .iter()
                    .filter(|l| l.enabled && sched::is_active(&l.schedule, &now))
                    .map(|l| sched::pomodoro_state(&l.schedule, &l.brk, &now))
                    .next()
                    .unwrap_or((false, 0))
            };

            let mut just_finished = false;

            {
                if let Ok(mut rt) = shared.rt.lock() {
                    if rt.day != today {
                        rt.day = today;
                        rt.blocked_apps = 0;
                        rt.blocked_sites = 0;
                    }
                    rt.active = active.iter().map(|l| (l.name.clone(), l.mode.clone())).collect();
                    rt.next_change = next_change;
                    rt.on_break = on_break;
                    rt.break_left = break_left;
                    rt.in_break = break_now;
                    rt.locked = lock.locked;
                    rt.lock_until = lock.until;
                    rt.lock_until_text = lock.until_text.clone();
                    rt.lock_names = lock.names.clone();
                    rt.clock_in_window = clock_in;
                    rt.clock_break = clock_break;
                    rt.clock_on = clock_on;
                    rt.clock_weekday = dstate.clock_weekday;
                    rt.clock_hour = dstate.clock_hour;
                    rt.clock_left = dstate.clock_left;
                    let now_ts = chrono::Local::now().timestamp();
                    let running = !active.is_empty() || lock.locked || clock_on;
                    if running && rt.since == 0 {
                        rt.since = now_ts;
                    }
                    if !running && rt.since > 0 {
                        // 一段自律结束了 → 攒一条"恭喜"给界面弹窗
                        let secs = (now_ts - rt.since).max(0);
                        if secs >= 60 {
                            let names = if rt.lock_names.is_empty() {
                                rt.active
                                    .iter()
                                    .map(|(n, _)| n.clone())
                                    .collect::<Vec<_>>()
                                    .join("、")
                            } else {
                                rt.lock_names.join("、")
                            };
                            rt.celebrate = Some((secs, names));
                            just_finished = true;
                        }
                        rt.since = 0;
                    }
                }
            }

            if just_finished {
                // 让用户能立刻看到恭喜弹窗
                let _ = app.emit("goto-home", ());
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                }
            }

            // ---- 阶段提醒：学习 / 休息结束前若干分钟各提醒一次 ----
            {
                let n = &cfg.settings.notify;
                // 没配番茄时，"本轮专注"就是整段时间，用时段剩余时间兜底
                let phase_left = if break_left > 0 {
                    break_left
                } else if !active.is_empty() {
                    active
                        .iter()
                        .filter_map(|l| sched::slot_left_secs(&l.schedule, &now))
                        .min()
                        .unwrap_or(0)
                } else {
                    0
                };
                if n.enabled && phase_left > 0 {
                    let threshold = if break_now {
                        if n.break_notify { n.break_before.min(120) * 60 } else { 0 }
                    } else {
                        n.work_before.min(120) * 60
                    };
                    if threshold > 0 {
                        // 换阶段时剩余时间会跳大，用它来重置"已提醒"标记
                        if phase_left as i64 > last_break_left + 5 {
                            notified_phase = false;
                        }
                        if !notified_phase && (phase_left as i64) <= threshold as i64 {
                            notified_phase = true;
                            let mins = ((phase_left + 59) / 60).max(1);
                            let msg = if break_now {
                                format!("休息还剩 {mins} 分钟，准备回到专注")
                            } else {
                                format!("本轮专注还剩 {mins} 分钟，坚持一下")
                            };
                            shared.say(msg);
                            if n.focus_window {
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                }
                            }
                        }
                        last_break_left = phase_left;
                    }
                }
            }

            // ---- 遮罩跟随自律：只发布"自律模式现在生效吗"，绝不改写用户意向 ----
            // 遮罩线程里的口径是：生效 = 用户开关 OR (跟随自律 AND 这里发布的标志)。
            // 这样"关掉跟随"之后主开关立刻回到用户手里，也不会出现
            // "手动关了 1 秒又被自己打开"的打架现象。
            shared.mask.schedule_on.store(
                !active.is_empty() || lock.locked || clock_on,
                std::sync::atomic::Ordering::Relaxed,
            );

            // ---- 桌面 HUD 显隐 ----
            // 遮罩开着时把 HUD 收起来：HUD 自己是置顶小窗，留在上面会变成
            // 遮罩上的一块"挖不掉的横条"，而且它每秒刷新会跟遮罩抢置顶
            let mask_on = shared.mask.on.load(std::sync::atomic::Ordering::Relaxed)
                || (cfg.settings.mask.follow_schedule
                    && shared.mask.schedule_on.load(std::sync::atomic::Ordering::Relaxed));
            let show_hud =
                (!active.is_empty() || lock.locked || clock_on) && cfg.settings.hud.enabled && !mask_on;
            if let Some(w) = app.get_webview_window("hud") {
                let vis = w.is_visible().unwrap_or(false);
                if show_hud && !vis {
                    if let Ok(Some(mon)) = w.primary_monitor() {
                        let msize = mon.size();
                        let scale = mon.scale_factor();
                        let wsz = w
                            .outer_size()
                            .unwrap_or(tauri::PhysicalSize::new(268, 116));
                        let x = msize.width as i32
                            - wsz.width as i32
                            - (cfg.settings.hud.offset_x as f64 * scale) as i32;
                        let y = (cfg.settings.hud.offset_y as f64 * scale) as i32;
                        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                    }
                    let _ = w.show();
                } else if !show_hud && vis {
                    let _ = w.hide();
                }
            }

            // ---- 积分：只有真正在「工作段」里才计时 ----
            if (!active.is_empty() || clock_on) && !cfg.settings.dry_run {
                acc_ms += poll;
                if acc_ms >= 60_000 {
                    acc_ms -= 60_000;
                    shared.add_points(1);
                }
            }

            pending.retain(|_, t| t.elapsed().as_secs() < 45);
            logged.retain(|_, t| t.elapsed().as_secs() < 20);

            // 自律模式是否正在生效：规则生效中 / 时段专注中 / 固化锁定中
            let discipline_on = !active.is_empty() || lock.locked || clock_on;

            if discipline_on {
                let apps = proc::screen_apps();

                // 1) 锁定期间：封杀任务管理器一类的"逃生工具"
                if lock.locked {
                    for a in apps.iter() {
                        if a.pid == self_pid {
                            continue;
                        }
                        let hit = guard::BANNED_PROCS
                            .iter()
                            .any(|b| a.name == *b || a.name.contains(b));
                        if hit {
                            proc::terminate(a.pid);
                            focus_main(&app, &shared);
                            if !cfg.settings.dry_run {
                                shared.log(
                                    "app",
                                    format!("{} — {}", a.name, a.title),
                                    "自律固化".into(),
                                    "锁定期间禁止打开此类工具".into(),
                                );
                            }
                        }
                    }
                }

                // 1b) 自律期间：按设置封杀任务管理器（用户可在「设置」里关掉这一项）
                //     固化锁定时无论如何都封（上面那段），这里管的是普通自律时段。
                if !lock.locked && cfg.settings.block_taskmgr {
                    for a in apps.iter() {
                        if a.pid == self_pid {
                            continue;
                        }
                        if a.name != "taskmgr" {
                            continue;
                        }
                        let first = logged
                            .get(&a.pid)
                            .map(|t| t.elapsed().as_secs() >= 20)
                            .unwrap_or(true);
                        proc::terminate(a.pid);
                        if first {
                            logged.insert(a.pid, Instant::now());
                            let label = format!("{} — {}", a.name, a.title);
                            crate::notify::blocked_app(&app, &label, "任务管理器");
                            if !cfg.settings.dry_run {
                                shared.log(
                                    "app",
                                    label,
                                    "任务管理器".into(),
                                    "自律期间禁止打开任务管理器".into(),
                                );
                            }
                        }
                    }
                }

                // 2) 黑名单 / 强制模式
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
                        Some(rule) => {
                            let did = on_block(&app, &shared, &cfg, a, rule, &mut pending, &mut logged);
                            if did {
                                focus_main(&app, &shared);
                            }
                        }
                        None => {
                            pending.remove(&a.pid);
                        }
                    }
                }

                // 3) 浏览器插件巡检：自律时段里，插件没开就别开着浏览器
                crate::browsers::guard_step(&app, &shared, &cfg, &apps, &mut browser_guard);

                // 4) 浏览器守护
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

/// 返回本次是否真的触发了一次新的拦截（用来决定要不要跳首页）
fn on_block(
    handle: &AppHandle,
    shared: &Shared,
    cfg: &Config,
    app: &WinApp,
    rule: &RuleList,
    pending: &mut HashMap<u32, Instant>,
    logged: &mut HashMap<u32, Instant>,
) -> bool {
    let label = if app.title.is_empty() {
        app.name.clone()
    } else {
        format!("{} — {}", app.name, app.title)
    };

    // 第一次看到这个目标：先弹通知，让用户知道发生了什么，下一次轮询再动手关。
    // poll_ms 默认 800ms，所以「看到通知 → 被关掉」大约 1 秒内完成。
    let fresh = logged
        .get(&app.pid)
        .map(|t| t.elapsed().as_secs() >= 8)
        .unwrap_or(true);
    if fresh && !cfg.settings.dry_run {
        logged.insert(app.pid, Instant::now());
        crate::mask::mlog(&format!(
            "拦截命中 应用={} 规则={} pid={}",
            label, rule.name, app.pid
        ));
        crate::notify::blocked_app(handle, &label, &rule.name);
        shared.log(
            "app",
            label.clone(),
            rule.name.clone(),
            "已拦截：先提示，随后强制关闭".into(),
        );
        return true;
    }

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
        return first;
    }

    if cfg.settings.soft_close {
        match pending.get(&app.pid) {
            None => {
                let ok = proc::soft_close(app.hwnd);
                pending.insert(app.pid, Instant::now());
                let first = !logged.contains_key(&app.pid);
                if first {
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
                first
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
                        return first;
                    }
                }
                false
            }
        }
    } else {
        let ok = proc::terminate(app.pid);
        let gate = logged
            .get(&app.pid)
            .map(|t| t.elapsed().as_secs() >= 5)
            .unwrap_or(true);
        if gate || !ok {
            logged.insert(app.pid, Instant::now());
            shared.log(
                "app",
                label,
                rule.name.clone(),
                if ok {
                    "已强制结束".into()
                } else {
                    "拦截失败：权限不足".into()
                },
            );
            return ok;
        }
        false
    }
}
