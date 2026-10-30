use crate::guard;
use crate::matcher;
use crate::model::{Config, Rule};
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

/// 把 HUD 摆到用户选的那个角。
///
/// 四角 + 边距（`offset_x/offset_y`）的组合足够避开绝大多数"主要专注内容"：
/// 比如代码编辑器把侧栏放左边，就选右下；看视频就选左上。
/// 换位置后立刻生效（命令里也会调这个函数），不用等下一轮轮询。
pub fn place_hud(app: &tauri::AppHandle, cfg: &crate::model::Config) {
    let Some(w) = app.get_webview_window("hud") else {
        return;
    };
    let Ok(Some(mon)) = w.primary_monitor() else {
        return;
    };
    let scale = mon.scale_factor();
    let wsz = w
        .outer_size()
        .unwrap_or(tauri::PhysicalSize::new(268, 116));
    let h = &cfg.settings.hud;
    let ix = (h.offset_x.max(0) as f64 * scale) as i32;
    let iy = (h.offset_y.max(0) as f64 * scale) as i32;
    // 用**工作区**而不是整块屏幕：屏幕尺寸把任务栏也算进去了，
    // 右下 / 左下两个角会让弹窗压住任务栏（甚至挡住开始按钮）。
    // 工作区原点也一并带上，主屏不在 (0,0) 时位置才不会整体偏掉。
    let wa = mon.work_area();
    let (mx, my) = (wa.position.x, wa.position.y);
    let (mw, mh) = (wa.size.width as i32, wa.size.height as i32);
    let (ww, wh) = (wsz.width as i32, wsz.height as i32);
    // 窗口比工作区还高（极小屏 / 放大 200%）时夹住，别跑到屏幕外
    let x_max = (mx + mw - ww - ix).max(mx);
    let y_max = (my + mh - wh - iy).max(my);
    let (x, y) = match h.corner_norm() {
        "tl" => (mx + ix, my + iy),
        "br" => (x_max, y_max),
        "bl" => (mx + ix, y_max),
        _ => (x_max, my + iy),
    };
    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
}

pub fn start(app: AppHandle, shared: Arc<Shared>) {
    thread::spawn(move || {
        // 值 = (上次动手的时刻, 已尝试次数)。次数用来做退避：目标以管理员权限运行时
        // terminate 永远失败，原来每 700ms 重试一次且永不停止。
        let mut pending: HashMap<u32, (Instant, u32)> = HashMap::new();
        let mut logged: HashMap<u32, Instant> = HashMap::new();
        let self_pid = std::process::id();
        let mut acc_ms: u64 = 0;
        let mut guard_running = false;
        let mut notified_phase = false;
        let mut last_break_left: i64 = 0;
        let mut browser_guard = crate::browsers::GuardState::new();
        // 上一拍是不是"在休息"：休息结束的收尾（最小化 / 关闭）靠它识别边界。
        // 初值取 None：程序刚启动 / 刚从睡眠里回来时我们并不知道"刚才是不是休息"，
        // 于是这一拍不做收尾——宁可漏一次，也不要在用户刚开机的第一秒就把
        // 他昨天开着的东西收走。
        let mut prev_break: Option<bool> = None;
        // 柔和模式"停放"的进程：学习期间不再被常规拦截反复强杀。
        // 只要它还是最小化状态就继续放行；用户一还原窗口，立刻按拦截处理。
        let mut parked: HashMap<u32, Instant> = HashMap::new();

        loop {
            let cfg: Config = shared.config();
            let poll = cfg.settings.poll_ms.clamp(300, 5000);
            let now = sched::now_local();
            let today = now.format("%Y-%m-%d").to_string();

            // ---- 固化（硬锁）状态 ----
            let lock = guard::lock_info(&cfg);
            if lock.locked {
                // 强制退出进行中：不再喂心跳，也不再拉守护。
                // 否则"杀掉守护 → 监控下一轮又 ensure_guard 拉起来 →
                // 守护发现心跳断了 → 把主进程复活"，用户看到的现象是
                // "按了强制退出，程序又回来了"。
                if !guard::quitting() {
                    guard::write_heartbeat();
                    if !guard_running {
                        guard::ensure_guard();
                        guard_running = true;
                    }
                }
            } else if guard_running {
                guard::stop_guard();
                guard_running = false;
            }

            // ---- 「自律时段」：0–24 点的 24 段计划 ----
            // 它和规则时段不是二选一：时钟选中且 applyRules 打开时，规则直接生效
            // （忽略规则自己的时段），时钟的休息段则把拦截整体暂停。
            // 判定统一放在 discipline 模块，插件服务端（server.rs）用的是同一份，
            // 否则会出现"主程序在拦软件、插件却收不到规则"的自律规则失效。
            let dstate = crate::discipline::state(&cfg, &now);
            let clock_in = dstate.clock_in;
            let clock_break = dstate.clock_break;
            let clock_on = dstate.clock_on;

            // ---- 生效中的规则（休息段内的规则暂时放行）----
            let active: Vec<Rule> = crate::discipline::active_rules(&cfg, &now, &dstate);

            // ---- 进入自律时间时自动打开应用 / 网页 ----
            // 放在这里（而不是独立的秒级线程）是因为它要看同一份 dstate：
            // "现在是不是专注段"必须和拦截判定同口径，否则会出现
            // 规则已经在拦人了、窗口却没打开的情况。
            // 内部按"规则 + 专注段起点"记账，段内只会执行一次。
            crate::autoopen::tick(&shared, &cfg, &now, &dstate);

            // 当前是否有规则处于「休息」
            let on_break = dstate.on_break;

            let next_change = cfg
                .rules
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
                    .rules
                    .iter()
                    .filter(|l| l.enabled && sched::is_active(&l.schedule, &now))
                    // 只认**真的配了番茄**的规则：以前取的是"第一条生效规则"，
                    // 它没配番茄就返回 (false, 0)，后面配了番茄的规则被完全忽略 ——
                    // 休息段照常拦截、休息结束的收尾也不触发。
                    .filter(|l| {
                        l.brk.kind == "pomodoro" && l.brk.work_min > 0 && l.brk.break_min > 0
                    })
                    .map(|l| sched::pomodoro_state(&l.schedule, &l.brk, &now))
                    .next()
                    .unwrap_or((false, 0))
            };

            // ---- 休息结束的收尾（最小化 / 关闭休息里打开的黑名单应用）----
            // 只在"上一拍还在休息、这一拍已经回到学习"的那一拍触发。
            // 判定与拦截同源：现在真的有生效规则（或处在自律时段专注段）才算"回到学习"。
            let now_study = clock_on || !active.is_empty();
            let just_back = match prev_break {
                Some(pb) => crate::sweep::is_break_to_study(pb, break_now, now_study),
                None => false,
            };
            prev_break = Some(break_now);

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
                    // 「休息 → 学习」的代次：浏览器插件靠它认出这次边界，
                    // 好在网页侧也做一次收尾（标签页它自己才够得着）。
                    if just_back {
                        rt.sweep_seq = rt.sweep_seq.wrapping_add(1);
                    }
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
                    // 阶段重置必须独立于"这一拍要不要提醒"：
                    // 关掉提醒（或阈值设 0）的那段时间里状态也得推进，
                    // 否则重新打开时"已提醒"标记还停在旧阶段，本阶段就再也提醒不了。
                    if phase_left as i64 > last_break_left + 5 {
                        notified_phase = false;
                    }
                    last_break_left = phase_left;
                    if threshold > 0 && !notified_phase && (phase_left as i64) <= threshold as i64 {
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
            // 自律状态一变就叫醒遮罩线程，别等兜底超时
            crate::mask::wake();

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
                    place_hud(&app, &cfg);
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

            pending.retain(|_, (t, _)| t.elapsed().as_secs() < 45);
            logged.retain(|_, t| t.elapsed().as_secs() < 20);

            // 自律模式是否正在生效：规则生效中 / 时段专注中 / 固化锁定中
            let discipline_on = !active.is_empty() || lock.locked || clock_on;

            if discipline_on {
                let apps = proc::screen_apps();

                // 0) 休息结束收尾：把休息里打开的黑名单应用收起来。
                //    放在拦截之前：柔和模式要先暂停媒体、再最小化，并且把被收起来的
                //    进程"停放"起来——否则下面第 2 步会在同一拍就把它们强杀掉，
                //    柔和模式就完全失去意义了。
                if just_back && cfg.settings.sweep.enabled {
                    let rep = crate::sweep::run(&shared, &cfg, &apps, &active, self_pid);
                    for pid in rep.parked.iter() {
                        parked.insert(*pid, Instant::now());
                    }
                    // 一次收尾只做一拍：停机 / 睡眠跨过边界时也只会补做一次
                    if !rep.minimized.is_empty() || !rep.closed.is_empty() {
                        crate::mask::mlog(&format!(
                            "休息结束收尾 模式={} 收起={} 关闭={} 暂停媒体={} 跳过={}",
                            rep.mode.as_str(),
                            rep.minimized.len(),
                            rep.closed.len(),
                            rep.paused.len(),
                            rep.skipped
                        ));
                    }
                }

                // 0b) 停放的进程还在不在"最小化"状态：
                //     进程没了 / 用户还原了**任意一个**窗口 / 句柄失效 → 摘掉停放标记，
                //     下面第 2 步立刻按常规拦截处理（"点开就等于重新打开"）。
                //     判据是"它所有可见顶层窗口都最小化"，只看主窗会让
                //     多窗口的程序从第二个窗口继续用下去。
                if !parked.is_empty() {
                    let wins = proc::window_minimized_map();
                    parked.retain(|pid, _| {
                        wins.get(pid).map(|(total, min)| *total > 0 && min == total).unwrap_or(false)
                    });
                }

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
                            // 演练模式只记录、不动手（原来这里连日志都不写，
                            // 用户开着"演练"却照样被结束进程，等于演练完全失效）
                            if cfg.settings.dry_run {
                                let first = logged
                                    .get(&a.pid)
                                    .map(|t| t.elapsed().as_secs() >= 20)
                                    .unwrap_or(true);
                                if first {
                                    logged.insert(a.pid, Instant::now());
                                    shared.log(
                                        "app",
                                        format!("{} — {}", a.name, a.title),
                                        "自律固化".into(),
                                        "演练：锁定期间本应禁止打开此类工具".into(),
                                    );
                                }
                                continue;
                            }
                            proc::terminate(a.pid);
                            focus_main(&app, &shared);
                            shared.log(
                                "app",
                                format!("{} — {}", a.name, a.title),
                                "自律固化".into(),
                                "锁定期间禁止打开此类工具".into(),
                            );
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
                        if !cfg.settings.dry_run {
                            proc::terminate(a.pid);
                        }
                        if first {
                            logged.insert(a.pid, Instant::now());
                            let label = format!("{} — {}", a.name, a.title);
                            crate::notify::blocked_app(&app, &label, "任务管理器");
                            shared.log(
                                "app",
                                label,
                                "任务管理器".into(),
                                if cfg.settings.dry_run {
                                    "演练：自律期间本应关闭任务管理器".into()
                                } else {
                                    "自律期间禁止打开任务管理器".into()
                                },
                            );
                        }
                    }
                }

                // 2) 自律规则 / 强制模式
                for a in apps.iter() {
                    if a.pid == self_pid {
                        continue;
                    }
                    // 柔和模式收起来、且还保持最小化的：学习期间放它一马。
                    // 这不是"豁免"——用户一旦点开（不再最小化），0b 那一步就把它
                    // 从 parked 里摘掉，这一拍立刻按拦截关掉。
                    if parked.contains_key(&a.pid) {
                        continue;
                    }
                    let blocked_by = crate::discipline::blocked_rule(&cfg, &active, a);
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
                            // 演练模式下不关浏览器，只记一条（20 秒节流，避免刷屏）
                            let touched = if cfg.settings.dry_run {
                                let first = logged
                                    .get(&a.pid)
                                    .map(|t| t.elapsed().as_secs() >= 20)
                                    .unwrap_or(true);
                                if first {
                                    logged.insert(a.pid, Instant::now());
                                }
                                first
                            } else {
                                proc::terminate(a.pid)
                            };
                            if touched {
                                let label = if hb_browser.is_empty() {
                                    a.name.clone()
                                } else {
                                    hb_browser.clone()
                                };
                                shared.log(
                                    "app",
                                    format!("{} — {}", label, a.title),
                                    "浏览器守护".into(),
                                    if cfg.settings.dry_run {
                                        "演练：扩展失联，本应关闭浏览器".into()
                                    } else {
                                        "扩展失联，已强制关闭浏览器".into()
                                    },
                                );
                            }
                        }
                    }
                }
            } else if !parked.is_empty() {
                // 不在自律状态（休息段 / 时段外 / 规则都关了）：停放名单作废。
                // 休息段里黑名单本来就放行，不需要"停放"这层豁免。
                parked.clear();
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
    rule: &Rule,
    pending: &mut HashMap<u32, (Instant, u32)>,
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
                pending.insert(app.pid, (Instant::now(), 1));
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
            Some(kv) => {
                let (t, n) = *kv;
                // 每失败一次就把下一次的间隔拉长一倍（0.7s → 1.4s → 2.8s → 5.6s → 11s）。
                // 原来失败也照样每 700ms 重来一次、永不停止，对着一个关不掉的目标持续开火。
                let wait = 700u64.saturating_mul(1u64 << n.min(4));
                if t.elapsed().as_millis() as u64 >= wait {
                    let ok = proc::terminate(app.pid);
                    if ok {
                        pending.remove(&app.pid);
                    } else {
                        pending.insert(app.pid, (Instant::now(), n.saturating_add(1)));
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
