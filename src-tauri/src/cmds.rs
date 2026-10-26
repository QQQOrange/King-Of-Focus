use crate::cfg;
use crate::model::Config;
use crate::shared::Shared;
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[link(name = "shell32")]
extern "system" {
    fn IsUserAnAdmin() -> i32;
}

pub fn is_admin() -> bool {
    unsafe { IsUserAnAdmin() != 0 }
}

/// 积分解锁的每分钟单价（每天第 n 次解锁 ×1.4 递增）
pub fn unlock_price(cfg: &Config) -> i64 {
    let base = 15f64;
    let mult = 1.4f64.powi(cfg.points.unlock_count_today.min(12) as i32);
    (base * mult).round() as i64
}

#[tauri::command]
pub fn get_state(shared: State<'_, Arc<Shared>>) -> Value {
    // 跨天重置解锁次数
    let today = crate::sched::now_local().format("%Y-%m-%d").to_string();
    {
        let mut c = shared.config();
        if c.points.day != today {
            c.points.day = today.clone();
            c.points.unlock_count_today = 0;
            let _ = cfg::save(&c);
            if let Ok(mut w) = shared.cfg.write() {
                *w = c;
            }
        }
    }
    let config = shared.config();
    let now = crate::sched::now_local();
    let (runtime, notice) = {
        let mut rt = shared.rt.lock().unwrap();
        let celebrate = rt
            .celebrate
            .take()
            .map(|(secs, names)| json!({"secs": secs, "rules": names}));
        // 提示只弹一次：取走即清空
        let m = shared
            .mask
            .notice
            .lock()
            .ok()
            .and_then(|mut g| g.take());
        let app_notice = shared.notice.lock().ok().and_then(|mut g| g.take());
        (
            json!({
                "active": rt.active.iter().map(|(n, m)| json!({"name": n, "mode": m})).collect::<Vec<_>>(),
                "disciplineOn": !rt.active.is_empty(),
                "blockedApps": rt.blocked_apps,
                "blockedSites": rt.blocked_sites,
                "nextChange": rt.next_change,
                "events": rt.events,
                "hb": rt.hb_ts,
                "hbBrowser": rt.hb_browser,
                "siteUrl": rt.site_url,
                "siteTitle": rt.site_title,
                "locked": rt.locked,
                "lockUntil": rt.lock_until,
                "lockUntilText": rt.lock_until_text,
                "lockNames": rt.lock_names,
                "breakOn": rt.in_break,
                "breakAny": rt.on_break,
                "breakLeft": rt.break_left,
                "notice": app_notice,
                "celebrate": celebrate,
            }),
            m,
        )
    };
    let mask = &*shared.mask;
    json!({
        "config": config,
        "runtime": runtime,
        "mask": {
            "on": mask.on.load(Ordering::Relaxed),
            "painted": mask.painted.load(Ordering::Relaxed),
            "targetPid": mask.target_pid.load(Ordering::Relaxed),
            "opacity": mask.opacity.load(Ordering::Relaxed),
            "margin": mask.margin.load(Ordering::Relaxed),
            "radius": mask.radius.load(Ordering::Relaxed),
            "duration": mask.duration.load(Ordering::Relaxed),
            "blockClick": mask.block_click.load(Ordering::Relaxed),
            "smooth": mask.smooth.load(Ordering::Relaxed),
            "follow": mask.follow.load(Ordering::Relaxed),
            "hotkey": config.settings.mask.hotkey,
            "hotkeyOk": mask.hk_ok.load(Ordering::Relaxed),
            "auto": config.settings.mask.auto,
            "autoApps": config.settings.mask.auto_apps,
            "notice": notice,
        },
        "admin": is_admin(),
        "pid": std::process::id(),
        "points": {
            "balance": config.points.balance,
            "earned": config.points.total_earned,
            "unlockUntil": config.points.unlock_until,
            "count": config.points.unlock_count_today,
            "price": unlock_price(&config),
        },
        "version": crate::version::VERSION,
        "buildDate": crate::version::BUILD_DATE,
        "developer": crate::version::DEVELOPER,
        "repoUrl": crate::version::REPO_URL,
        "tokenDocUrl": crate::version::TOKEN_DOC_URL,
        "appName": crate::version::APP_NAME,
        "maskedToken": mask_secret(&config.settings.update.token),
        "configPath": cfg::config_path().to_string_lossy(),
        "dataPath": cfg::data_dir().to_string_lossy(),
        "now": now.format("%Y-%m-%d %H:%M").to_string(),
        "weekday": now.format("%u").to_string(),
    })
}

#[tauri::command]
pub fn save_config(shared: State<'_, Arc<Shared>>, config: Config) -> Result<(), String> {
    if crate::guard::is_locked(&shared) {
        let info = crate::guard::lock_info(&shared.config());
        return Err(format!(
            "自律固化中（{} 结束），现在改不了设置",
            if info.until_text.is_empty() { "本时段".to_string() } else { info.until_text }
        ));
    }
    let mut c = config;
    cfg::sanitize(&mut c);
    c.updated_at = chrono::Local::now().timestamp();
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    Ok(())
}

/// 只露头尾的掩码，用于界面展示
fn mask_secret(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        return String::new();
    }
    let n = t.chars().count();
    if n <= 8 {
        return "••••••••".into();
    }
    let head: String = t.chars().take(4).collect();
    let tail: String = t.chars().skip(n - 4).collect();
    format!("{head}••••••••{tail}")
}

/// 当前所有有可见窗口的程序（给"选择目标窗口 / 添加应用"用）
#[tauri::command]
pub fn list_windows() -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    crate::proc::screen_apps()
        .into_iter()
        .filter(|a| seen.insert(a.pid))
        .map(|a| {
            json!({
                "pid": a.pid,
                "name": a.name,
                "title": a.title,
                "path": a.path,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn pick_path(app: AppHandle, kind: String) -> Option<String> {
    if kind == "dir" {
        app.dialog()
            .file()
            .set_title("选择文件夹（该文件夹下所有程序都会被拦截）")
            .blocking_pick_folder()
            .map(|p| p.to_string())
    } else {
        app.dialog()
            .file()
            .set_title("选择程序")
            .add_filter("程序", &["exe", "lnk"])
            .blocking_pick_file()
            .map(|p| p.to_string())
    }
}

#[tauri::command]
pub fn mask_start(
    app: AppHandle,
    shared: State<'_, Arc<Shared>>,
    pid: u32,
    title: String,
) -> Result<(), String> {
    let hwnd = crate::proc::find_window_by_pid(pid)
        .ok_or_else(|| "找不到该窗口，它可能已经关闭了".to_string())?;
    let m = &*shared.mask;
    m.target.store(hwnd as isize, Ordering::Relaxed);
    m.target_pid.store(pid, Ordering::Relaxed);
    m.painted.store(false, Ordering::Relaxed);
    m.on.store(true, Ordering::Relaxed);

    // 主窗口不再强制置顶（保持正常窗口层级，可以被别的窗口盖住/最小化）
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(false);
    }
    let mut c = shared.config();
    c.settings.mask.target_pid = pid;
    c.settings.mask.target_title = title;
    let _ = crate::cfg::save(&c);
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    Ok(())
}

#[tauri::command]
pub fn mask_stop(app: AppHandle, shared: State<'_, Arc<Shared>>) {
    shared.mask.on.store(false, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(false);
    }
}

#[tauri::command]
pub fn mask_set(
    shared: State<'_, Arc<Shared>>,
    opacity: Option<u8>,
    margin: Option<i32>,
    radius: Option<i32>,
    duration_ms: Option<u32>,
    block_click: Option<bool>,
    smooth: Option<bool>,
    follow: Option<bool>,
) {
    let m = &*shared.mask;
    if let Some(o) = opacity {
        m.opacity.store(o.min(100), Ordering::Relaxed);
    }
    if let Some(v) = margin {
        m.margin.store(v.clamp(0, 200), Ordering::Relaxed);
    }
    if let Some(v) = radius {
        m.radius.store(v.clamp(0, 120), Ordering::Relaxed);
    }
    if let Some(v) = duration_ms {
        m.duration.store(v.min(3000) as i32, Ordering::Relaxed);
    }
    if let Some(v) = smooth {
        m.smooth.store(v, Ordering::Relaxed);
    }
    if let Some(v) = follow {
        m.follow.store(v, Ordering::Relaxed);
        // 跟随模式本身就是"常开"，打开它就直接开始
        m.painted.store(false, Ordering::Relaxed);
        m.on.store(v, Ordering::Relaxed);
    }
    if let Some(b) = block_click {
        m.block_click.store(b, Ordering::Relaxed);
    }
}

/// 设置全局快捷键（带冲突检测：注册失败会回滚到原来的组合）
#[tauri::command]
pub fn mask_hotkey(shared: State<'_, Arc<Shared>>, combo: String) -> Result<(), String> {
    let m = &*shared.mask;
    let trimmed = combo.trim().to_string();
    let parsed = if trimmed.is_empty() {
        None
    } else {
        match crate::mask::parse_hotkey(&trimmed) {
            Some(v) => Some(v),
            None => return Err("格式不对，需要至少一个修饰键加一个键，例如 Ctrl+Alt+K".into()),
        }
    };

    let (prev_md, prev_vk) = (
        m.hk_mod.load(Ordering::Relaxed),
        m.hk_vk.load(Ordering::Relaxed),
    );
    match parsed {
        Some((md, vk)) => {
            m.hk_mod.store(md, Ordering::Relaxed);
            m.hk_vk.store(vk, Ordering::Relaxed);
        }
        None => m.hk_vk.store(0, Ordering::Relaxed),
    }
    m.hk_gen.fetch_add(1, Ordering::Relaxed);
    std::thread::sleep(std::time::Duration::from_millis(260));
    let ok = m.hk_ok.load(Ordering::Relaxed);

    if !trimmed.is_empty() && !ok {
        // 被别的程序占用 → 回滚，别把用户原来的热键搞丢
        m.hk_mod.store(prev_md, Ordering::Relaxed);
        m.hk_vk.store(prev_vk, Ordering::Relaxed);
        m.hk_gen.fetch_add(1, Ordering::Relaxed);
        return Err(format!("{trimmed} 已被其他程序占用，换一个组合再试"));
    }

    let mut c = shared.config();
    c.settings.mask.hotkey = trimmed.clone();
    c.settings.mask.hotkey_label = trimmed;
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    Ok(())
}

/// 自动触发：进入这些应用就开遮罩，切走就关
#[tauri::command]
pub fn mask_auto(
    shared: State<'_, Arc<Shared>>,
    enabled: bool,
    apps: Vec<String>,
) -> Result<(), String> {
    let m = &*shared.mask;
    m.auto.store(enabled, Ordering::Relaxed);
    if let Ok(mut g) = m.auto_apps.lock() {
        *g = apps.clone();
    }
    let mut c = shared.config();
    c.settings.mask.auto = enabled;
    c.settings.mask.auto_apps = apps;
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    Ok(())
}

/// 遮罩自查：返回遮罩线程最后一帧的真实状态，方便判断「没生效」卡在哪一步
#[tauri::command]
pub fn mask_diag() -> String {
    crate::mask::DIAG
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| "（无数据：遮罩还没启动过）".into())
}

/// 一键测试：立刻以本程序主窗口为目标，用 150ms 动画跑一遍，方便反复调参
#[tauri::command]
pub fn mask_test(app: AppHandle, shared: State<'_, Arc<Shared>>) -> Result<bool, String> {
    mask_test_inner(&app, &shared)
}

/// 供命令行/调试接口复用，UI 与自动化测试走同一条代码路径
pub fn mask_test_inner(app: &AppHandle, shared: &Arc<Shared>) -> Result<bool, String> {
    let m = &*shared.mask;
    let self_pid = std::process::id();
    let testing = m.on.load(Ordering::Relaxed) && m.target_pid.load(Ordering::Relaxed) == self_pid;

    if testing {
        m.on.store(false, Ordering::Relaxed);
        m.duration
            .store(shared.config().settings.mask.duration_ms.min(2000) as i32, Ordering::Relaxed);
        return Ok(false);
    }

    let hwnd = match app.get_webview_window("main") {
        Some(w) => match w.hwnd() {
            Ok(h) => h.0 as isize,
            Err(_) => crate::proc::find_window_by_pid(self_pid).map(|x| x as isize).unwrap_or(0),
        },
        None => return Err("找不到主窗口".into()),
    };
    if hwnd == 0 {
        return Err("找不到主窗口句柄".into());
    }

    // 测试只跟遮罩本身有关，和自律模式无关；
    // 动画时长沿用用户设置（想快速连点就把时长调小，而不是偷偷改成固定值）
    m.duration
        .store(shared.config().settings.mask.duration_ms.min(3000) as i32, Ordering::Relaxed);
    m.target.store(hwnd, Ordering::Relaxed);
    m.target_pid.store(self_pid, Ordering::Relaxed);
    m.painted.store(false, Ordering::Relaxed);
    m.on.store(true, Ordering::Relaxed);
    let _ = app.get_webview_window("main").map(|w| w.set_always_on_top(false));
    Ok(true)
}

#[tauri::command]
pub fn open_path(path: String) {    let _ = Command::new("explorer")
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

#[tauri::command]
pub fn open_config_dir() {
    open_path(cfg::data_dir().to_string_lossy().to_string());
}

/// 在若干候选位置里找插件目录
pub fn extension_dir() -> Option<std::path::PathBuf> {
    let mut cands: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        let mut p = exe.clone();
        for _ in 0..4 {
            p.pop();
            cands.push(p.join("extension"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        cands.push(cwd.join("extension"));
        cands.push(cwd.join("../extension"));
    }
    cands.into_iter().find(|p| p.join("manifest.json").exists())
}

#[tauri::command]
pub fn open_extension_dir() -> Result<(), String> {
    match extension_dir() {
        Some(p) => {
            open_path(p.to_string_lossy().to_string());
            Ok(())
        }
        None => Err("找不到 plugin 目录，请手动打开项目的 extension 文件夹".into()),
    }
}

#[tauri::command]
pub fn restart_as_admin(app: AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let cmd = format!(
        "Start-Process -FilePath '{}' -Verb RunAs",
        exe.to_string_lossy().replace('\'', "''")
    );
    Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    if enabled {
        Command::new("reg")
            .args([
                "add",
                key,
                "/v",
                "KingOfFocus",
                "/t",
                "REG_SZ",
                "/d",
                &format!("\"{}\"", exe.to_string_lossy()),
                "/f",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
    } else {
        Command::new("reg")
            .args(["delete", key, "/v", "KingOfFocus", "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle, shared: State<'_, Arc<Shared>>) -> Result<(), String> {
    if crate::guard::is_locked(&shared) {
        return Err("自律固化中，结束前无法退出".into());
    }
    crate::guard::stop_guard();
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn show_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 用积分强行解锁
#[tauri::command]
pub fn points_unlock(shared: State<'_, Arc<Shared>>, minutes: u32) -> Result<Value, String> {
    let minutes = minutes.clamp(1, 120);
    let mut c = shared.config();
    // 没有在进行中的自律时段时不允许兑换，避免白花积分
    let info = crate::guard::lock_info(&c);
    if !info.locked {
        let now = crate::sched::now_local();
        let running = c.lists.iter().any(|l| l.enabled && crate::sched::is_active(&l.schedule, &now));
        if !running {
            return Err("当前没有正在进行的自律时段，不需要解锁".into());
        }
    }
    let price = unlock_price(&c) * minutes as i64;
    if c.points.balance < price {
        return Err(format!(
            "积分不够：需要 {price} 分，你现在有 {} 分",
            c.points.balance
        ));
    }
    c.points.balance -= price;
    c.points.unlock_count_today += 1;
    c.points.unlock_until = chrono::Local::now().timestamp() + (minutes as i64) * 60;
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c.clone();
    }
    crate::guard::stop_guard();
    Ok(json!({
        "ok": true,
        "spent": price,
        "balance": c.points.balance,
        "until": c.points.unlock_until,
    }))
}

/// 桌面 HUD 的数据源（1 秒轮询）
#[tauri::command]
pub fn hud_state(shared: State<'_, Arc<Shared>>) -> Value {
    let now = chrono::Local::now().timestamp();
    let (on, locked, elapsed, remaining, until_text, break_on, break_left, quote, quote_from) = {
        match shared.rt.lock() {
            Ok(rt) => (
                !rt.active.is_empty() || rt.locked,
                rt.locked,
                if rt.since > 0 { (now - rt.since).max(0) } else { 0 },
                if rt.lock_until > 0 { (rt.lock_until - now).max(0) } else { 0 },
                rt.lock_until_text.clone(),
                rt.in_break,
                rt.break_left,
                rt.quote.clone(),
                rt.quote_from.clone(),
            ),
            Err(_) => (false, false, 0, 0, String::new(), false, 0, String::new(), String::new()),
        }
    };
    let cfg = shared.config();
    let warn = if !cfg.settings.notify.enabled {
        false
    } else if break_on {
        cfg.settings.notify.break_notify && break_left > 0
            && break_left as i64 <= cfg.settings.notify.break_before.min(120) as i64 * 60
    } else {
        break_left > 0 && break_left as i64 <= cfg.settings.notify.work_before.min(120) as i64 * 60
    };
    json!({
        "on": on,
        "locked": locked,
        "elapsed": elapsed,
        "remaining": remaining,
        "untilText": until_text,
        "breakOn": break_on,
        "breakLeft": break_left,
        "warn": warn,
        "quote": quote,
        "quoteFrom": quote_from,
        "theme": cfg.settings.theme,
        "hudEnabled": cfg.settings.hud.enabled,
    })
}

#[tauri::command]
pub fn notify_save(
    shared: State<'_, Arc<Shared>>,
    enabled: bool,
    work_before: u32,
    break_before: u32,
    break_notify: bool,
) -> Result<(), String> {
    let mut c = shared.config();
    c.settings.notify.enabled = enabled;
    c.settings.notify.work_before = work_before.min(120);
    c.settings.notify.break_before = break_before.min(120);
    c.settings.notify.break_notify = break_notify;
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    Ok(())
}

#[tauri::command]
pub fn hud_save(shared: State<'_, Arc<Shared>>, enabled: bool, quote_minutes: u32) -> Result<(), String> {
    let mut c = shared.config();
    c.settings.hud.enabled = enabled;
    c.settings.hud.quote_minutes = quote_minutes.clamp(5, 1440);
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    Ok(())
}

#[tauri::command]
pub fn hide_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

// ---------------- 使用时长统计 ----------------

#[tauri::command]
pub fn stats_range(shared: State<'_, Arc<Shared>>, start: String, end: String) -> Value {
    let agg = crate::stats::aggregate(&shared, &start, &end);
    let on_secs: u64 = agg.on.iter().map(|s| s.secs).sum();
    let off_secs: u64 = agg.off.iter().map(|s| s.secs).sum();
    json!({
        "start": start,
        "end": end,
        "on": agg.on,
        "off": agg.off,
        "onSecs": on_secs,
        "offSecs": off_secs,
        "onHourly": agg.on_hourly.to_vec(),
        "offHourly": agg.off_hourly.to_vec(),
    })
}

#[tauri::command]
pub fn report_list() -> Value {
    json!(crate::stats::list_reports())
}

#[tauri::command]
pub fn report_get(id: String) -> Value {
    match crate::stats::read_report(&id) {
        Some(r) => json!(r),
        None => Value::Null,
    }
}

#[tauri::command]
pub fn report_generate(
    shared: State<'_, Arc<Shared>>,
    period: String,
    start: String,
    end: String,
) -> Result<Value, String> {
    crate::stats::generate(&shared, &period, &start, &end).map(|r| json!(r))
}

#[tauri::command]
pub fn report_delete(id: String) -> Result<(), String> {
    crate::stats::delete_report(&id)
}

#[tauri::command]
pub fn stats_dir_path() -> String {
    crate::stats::stats_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn stats_flush(shared: State<'_, Arc<Shared>>) {
    crate::stats::flush(&shared);
}

// ---------------- 云同步 ----------------

fn after_sync(shared: &Shared, r: Result<String, String>) -> Result<String, String> {
    let mut c = shared.config();
    c.settings.sync.last_sync = chrono::Local::now().timestamp();
    match &r {
        Ok(m) => {
            c.settings.sync.last_result = m.clone();
            c.settings.sync.last_error.clear();
        }
        Err(e) => c.settings.sync.last_error = e.clone(),
    }
    let _ = cfg::save(&c);
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    r
}

#[tauri::command]
pub fn sync_save(
    shared: State<'_, Arc<Shared>>,
    url: String,
    username: String,
    password: String,
    auto: bool,
    auto_minutes: u32,
    enabled: bool,
) -> Result<(), String> {
    let mut c = shared.config();
    c.settings.sync.url = url.trim().to_string();
    c.settings.sync.username = username;
    c.settings.sync.password = password;
    c.settings.sync.auto = auto;
    c.settings.sync.auto_minutes = auto_minutes.clamp(5, 1440);
    c.settings.sync.enabled = enabled;
    if c.settings.sync.device.trim().is_empty() {
        c.settings.sync.device = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "我的电脑".into());
    }
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    Ok(())
}

#[tauri::command]
pub fn sync_now(shared: State<'_, Arc<Shared>>) -> Result<String, String> {
    let r = crate::sync::smart(&shared);
    after_sync(&shared, r)
}

#[tauri::command]
pub fn sync_upload(shared: State<'_, Arc<Shared>>) -> Result<String, String> {
    let r = crate::sync::upload(&shared);
    after_sync(&shared, r)
}

#[tauri::command]
pub fn sync_download(shared: State<'_, Arc<Shared>>) -> Result<String, String> {
    let r = crate::sync::download(&shared);
    after_sync(&shared, r)
}

// ---------------- 自动更新 ----------------

#[tauri::command]
pub fn update_check(shared: State<'_, Arc<Shared>>) -> Value {
    let c = shared.config();
    let v = crate::update::check(&c.settings.update);
    let mut c2 = c.clone();
    c2.settings.update.last_check = chrono::Local::now().timestamp();
    let _ = cfg::save(&c2);
    if let Ok(mut w) = shared.cfg.write() {
        *w = c2;
    }
    v
}

#[tauri::command]
pub fn update_quota(shared: State<'_, Arc<Shared>>) -> Value {
    let c = shared.config();
    match crate::update::quota(&c.settings.update.token) {
        Ok((rem, lim)) => json!({ "ok": true, "remaining": rem, "limit": lim }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn update_save(
    shared: State<'_, Arc<Shared>>,
    token: Option<String>,
    enabled: Option<bool>,
    skip: Option<String>,
) -> Result<(), String> {
    let mut c = shared.config();
    if let Some(t) = token {
        c.settings.update.token = t.trim().to_string();
    }
    if let Some(e) = enabled {
        c.settings.update.enabled = e;
    }
    if let Some(s) = skip {
        c.settings.update.skipped_version = s;
    }
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    Ok(())
}

#[tauri::command]
pub async fn update_download(app: AppHandle, url: String, name: String) -> Result<String, String> {
    crate::update::download(&app, &url, &name)
}

#[tauri::command]
pub fn update_apply(app: AppHandle, installer: String) -> Result<(), String> {
    crate::update::apply(&app, &installer)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("只支持 http / https 链接".into());
    }
    Command::new("cmd")
        .args(["/C", "start", "", u])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------- 备份 ----------------

#[tauri::command]
pub fn backup_make(shared: State<'_, Arc<Shared>>) -> Result<Value, String> {
    crate::backup::make(&shared)
}

#[tauri::command]
pub fn backup_list() -> Value {
    json!(crate::backup::list())
}

#[tauri::command]
pub fn backup_restore(shared: State<'_, Arc<Shared>>, path: String) -> Result<String, String> {
    crate::backup::restore_local(&shared, &path)
}

#[tauri::command]
pub fn backup_delete(path: String) -> Result<(), String> {
    crate::backup::delete_file(&path)
}

#[tauri::command]
pub fn backup_open_dir() {
    open_path(crate::backup::dir().to_string_lossy().to_string());
}

#[tauri::command]
pub fn backup_save(
    shared: State<'_, Arc<Shared>>,
    password: String,
    auto_on_start: bool,
) -> Result<(), String> {
    let mut c = shared.config();
    c.settings.backup.password = password;
    c.settings.backup.auto_on_start = auto_on_start;
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    Ok(())
}

#[tauri::command]
pub fn backup_cloud_list(shared: State<'_, Arc<Shared>>) -> Result<Value, String> {
    crate::backup::cloud_list(&shared).map(|v| json!(v))
}

#[tauri::command]
pub fn backup_cloud_upload(shared: State<'_, Arc<Shared>>) -> Result<String, String> {
    crate::backup::cloud_upload(&shared)
}

#[tauri::command]
pub fn backup_cloud_restore(shared: State<'_, Arc<Shared>>, name: String) -> Result<String, String> {
    crate::backup::cloud_restore(&shared, &name)
}
