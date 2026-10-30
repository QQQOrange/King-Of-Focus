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
    fn ShellExecuteW(
        hwnd: *mut core::ffi::c_void,
        op: *const u16,
        file: *const u16,
        params: *const u16,
        dir: *const u16,
        show: i32,
    ) -> isize;
}

fn wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

pub fn is_admin() -> bool {
    unsafe { IsUserAnAdmin() != 0 }
}

/// ShellExecuteW 的失败原因码 → 人话
fn shell_exec_reason(n: usize) -> String {
    match n {
        5 => "你在 UAC 弹窗里点了「否」，或者当前账户没有管理员权限".to_string(),
        2 => "找不到程序文件".to_string(),
        31 => "系统无法启动提权进程".to_string(),
        n => format!("ShellExecute 返回 {n}"),
    }
}

/// 以管理员身份拉起一个新实例（UAC 弹窗由系统负责）。
///
/// `params` 作为命令行参数传给新实例：
///   - `--elevated`          标记"我是提权副本"（跳过本次启动的提权循环）
///   - `--wait-pid=<pid>`    等这个 pid 的进程退出后再接管单实例锁
///
/// 早期版本 params 传的是 NULL，新实例完全不知道自己是谁，
/// 于是被单实例互斥体判定为"重复启动"直接退出 —— 用户看到的就是"点了没反应 / 闪退"。
pub fn spawn_elevated(params: &str) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let op = wide("runas");
    let file = wide(&exe.to_string_lossy());
    let dir = exe
        .parent()
        .map(|p| wide(&p.to_string_lossy()))
        .unwrap_or_else(|| wide(""));
    let ps = wide(params);

    // 返回值 <= 32 就是失败，能区分"用户点了 UAC 的否"和"真的没权限"
    let r = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            ps.as_ptr(),
            dir.as_ptr(),
            1, // SW_SHOWNORMAL
        )
    };
    if r as usize <= 32 {
        return Err(format!("提权失败：{}", shell_exec_reason(r as usize)));
    }
    Ok(())
}

/// 提权重启自己：新实例会等本进程退出后再接管单实例锁
pub fn spawn_elevated_self() -> Result<(), String> {
    let params = format!("--elevated --wait-pid={}", std::process::id());
    spawn_elevated(&params)
}

/// 提权失败标记文件：用户拒绝 UAC 后，短时间内不再重复弹窗。
///
/// 名字用 `.elevate_fail` 而不是早期的 `.elevate_try`：
/// 早期版本在"准备提权"时就写标记，导致**提权成功后标记仍在**，
/// 120 秒内的第二次启动会跳过提权 —— 于是"点开先闪退、第 2 次点才正常"，
/// 而且实际运行的实例永远不是管理员。现在只在**提权失败**时才写。
pub const ELEVATE_MARKER: &str = ".elevate_fail";

fn elevate_marker_path() -> std::path::PathBuf {
    crate::cfg::data_dir().join(ELEVATE_MARKER)
}

/// 标记文件是不是"刚失败过"（120 秒内）
pub fn elevate_marker_fresh() -> bool {
    std::fs::metadata(elevate_marker_path())
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|e| e.as_secs() < 120)
        .unwrap_or(false)
}

/// 记下"刚刚提权失败"，避免每次启动都弹 UAC
pub fn mark_elevate_failed() {
    let _ = std::fs::write(elevate_marker_path(), b"1");
}

/// 提权成功后清掉失败标记
pub fn clear_elevate_marker() {
    let _ = std::fs::remove_file(elevate_marker_path());
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
                "disciplineOn": !rt.active.is_empty() || rt.locked || rt.clock_on,
                "blockedApps": rt.blocked_apps,
                "blockedSites": rt.blocked_sites,
                "nextChange": rt.next_change,
                "events": rt.events,
                "hb": rt.hb_ts,
                "hbBrowser": rt.hb_browser,
                "siteUrl": rt.site_url,
                "siteTitle": rt.site_title,
                "wakeNote": rt.wake_note,
                "wakeAt": rt.wake_at,
                "locked": rt.locked,
                "lockUntil": rt.lock_until,
                "lockUntilText": rt.lock_until_text,
                "lockNames": rt.lock_names,
                "breakOn": rt.in_break,
                "breakAny": rt.on_break,
                "breakLeft": rt.break_left,
                "clockInWindow": rt.clock_in_window,
                "clockWeekday": rt.clock_weekday,
                "clockBreak": rt.clock_break,
                "clockOn": rt.clock_on,
                "clockHour": rt.clock_hour,
                "clockLeft": rt.clock_left,
                "clockSummary": crate::clock::summary(&config),
                "sleep": crate::sleep::snapshot(&shared).to_json(&config),
                "sleepText": crate::sleep::summary(&shared),
                // Hub 顶部那块激励语录要显示"这条是哪来的"，所以连同出处一起给
                "quote": rt.quote.clone(),
                "quoteFrom": rt.quote_from.clone(),
                "notice": app_notice,
                "celebrate": celebrate,
            }),
            m,
        )
    };
    let mask = &*shared.mask;
    let preview_left = {
        let until = mask.preview_until.load(Ordering::Relaxed);
        (until - chrono::Local::now().timestamp()).max(0)
    };
    let user_on = mask.on.load(Ordering::Relaxed);
    let schedule_on = mask.schedule_on.load(Ordering::Relaxed);
    let auto_on = config.settings.mask.follow_schedule && schedule_on;
    json!({
        "config": config,
        "runtime": runtime,
        "mask": {
            // on = 最终生效（用户意向 OR 自律接管）；userOn = 用户意向；autoOn = 自律接管
            "on": user_on || auto_on,
            "userOn": user_on,
            "autoOn": auto_on,
            "scheduleOn": schedule_on,
            "painted": mask.painted.load(Ordering::Relaxed),
            "targetPid": mask.target_pid.load(Ordering::Relaxed),
            "opacity": mask.opacity.load(Ordering::Relaxed),
            "blockClick": mask.block_click.load(Ordering::Relaxed),
            "follow": mask.follow.load(Ordering::Relaxed),
            "mediaPause": config.settings.mask.media_pause,
            "hotkey": config.settings.mask.hotkey,
            "hotkeyOk": mask.hk_ok.load(Ordering::Relaxed),
            "followSchedule": config.settings.mask.follow_schedule,
            "previewLeft": preview_left,
            "notice": notice,
        },
        "admin": is_admin(),
        "testMode": crate::testmode::on(),
        "dataDir": cfg::data_dir().to_string_lossy(),
        "browsers": crate::browsers::snapshot(),
        "browserGuard": config.settings.browser_guard,
        "extFolder": crate::browsers::ext_dir().map(|p| p.to_string_lossy().to_string()),
        "extInfo": ext_info_json(),
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
        // 只告诉前端"有没有设置"，任何片段都不外发——令牌不该出现在界面上
        "hasToken": !config.settings.update.token.trim().is_empty(),
        "configPath": cfg::config_path().to_string_lossy(),
        "dataPath": cfg::data_dir().to_string_lossy(),
        "now": now.format("%Y-%m-%d %H:%M").to_string(),
        "weekday": now.format("%u").to_string(),
    })
}

#[tauri::command]
pub fn save_config(shared: State<'_, Arc<Shared>>, config: Config) -> Result<(), String> {
    // 睡眠时段锁定中：所有设置都改不了（这才是"限制所有功能"）。
    // 唯一的出路是锁屏窗口上的「积分解锁」，或者等这一轮睡眠时段结束。
    if crate::sleep::is_locked(&shared) {
        return Err("睡眠时段锁定中：只能用积分解锁，或者等这一段结束".into());
    }
    if crate::guard::is_locked(&shared) {
        let info = crate::guard::lock_info(&shared.config());
        return Err(format!(
            "自律固化中（{} 结束），现在改不了设置",
            if info.until_text.is_empty() { "本时段".to_string() } else { info.until_text }
        ));
    }
    // 自律时段内：拒绝"削弱纪律"的改动（关规则、关自律时段、取消已选时段……）
    // 界面上的开关虽然已经置灰，但真正把关的是这一层——直接调命令也绕不过去。
    let old = shared.config();
    if let Some(why) = crate::guard::discipline_violation(&old, &config) {
        return Err(why);
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
fn ext_info_json() -> Value {
    let loc = crate::browsers::ext_location();
    json!({
        "path": loc.path,
        "exists": loc.exists,
        "crx": loc.crx,
        "exeDir": loc.exe_dir,
        "source": loc.source,
    })
}

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
/// 和 browsers_scan 同理：枚举窗口 + 读进程名是阻塞操作，不能放在 UI 线程上
#[tauri::command]
pub async fn list_windows() -> Vec<Value> {
    tauri::async_runtime::spawn_blocking(|| {
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
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default()
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


/// 把配置灌进运行态（启动时和切换测试模式后都要走这一遍）
pub fn apply_runtime_cfg(shared: &Arc<Shared>) {
    let config = shared.config();
    // 浏览器自定义路径要同步给扫描/打开扩展页那一侧
    crate::browsers::set_custom_exe(config.settings.browser_exe.clone());
    sync_custom_browsers(&config);
    let m = &*shared.mask;
    m.opacity.store(config.settings.mask.opacity.min(100), Ordering::Relaxed);
    m.block_click.store(config.settings.mask.block_click, Ordering::Relaxed);
    m.follow.store(config.settings.mask.follow, Ordering::Relaxed);
    if let Some((md, vk)) = crate::mask::parse_hotkey(&config.settings.mask.hotkey) {
        m.hk_mod.store(md, Ordering::Relaxed);
        m.hk_vk.store(vk, Ordering::Relaxed);
        m.hk_gen.fetch_add(1, Ordering::Relaxed);
    }
    m.auto_follow
        .store(config.settings.mask.follow_schedule, Ordering::Relaxed);
    m.target_pid
        .store(config.settings.mask.target_pid, Ordering::Relaxed);
    m.media_pause
        .store(config.settings.mask.media_pause, Ordering::Relaxed);
    // 开关关掉时顺手把停过的媒体还回去（切配置/退出测试模式都会走这里）
    if !config.settings.mask.media_pause {
        crate::media::set_active(false);
    }
}

/// 进入测试模式：换到独立数据目录，所有功能照常生效，但自律模式可以随时开关
#[tauri::command]
pub fn test_mode_enter(shared: State<'_, Arc<Shared>>) -> Result<Value, String> {
    test_mode_enter_impl(&shared)
}

pub fn test_mode_enter_impl(shared: &Arc<Shared>) -> Result<Value, String> {
    if crate::testmode::on() {
        return Ok(json!({"on": true}));
    }
    // 进入测试模式会切到独立的数据目录，等于把正式环境的规则整份"换掉"，
    // 而 testmode::on() 还会让固化锁定与纪律校验全部短路。
    // 所以它是比"关规则"更彻底的逃逸口，必须和退出程序一样挡住。
    if let Some(why) = crate::guard::exit_blocked(&shared.config()) {
        return Err(format!("{why}；测试模式请等这一段结束后再进"));
    }
    // 先把正式数据落盘，避免切换时丢当前累计
    crate::stats::flush(shared);
    crate::testmode::enter()?;
    let c = cfg::load();
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    crate::stats::reload_today(shared);
    apply_runtime_cfg(shared);
    Ok(json!({
        "on": true,
        "dataDir": cfg::data_dir().to_string_lossy(),
        "configPath": cfg::config_path().to_string_lossy(),
    }))
}

/// 退出测试模式。keep=true 保留测试期间的设置与数据（合并进正式环境），false 全部丢弃。
#[tauri::command]
pub fn test_mode_exit(shared: State<'_, Arc<Shared>>, keep: bool) -> Result<Value, String> {
    test_mode_exit_impl(&shared, keep)
}

pub fn test_mode_exit_impl(shared: &Arc<Shared>, keep: bool) -> Result<Value, String> {
    if !crate::testmode::on() {
        return Ok(json!({"on": false}));
    }
    crate::stats::flush(shared);
    crate::testmode::exit(keep)?;
    let c = cfg::load();
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    crate::stats::reload_today(shared);
    apply_runtime_cfg(shared);
    Ok(json!({
        "on": false,
        "kept": keep,
        "dataDir": cfg::data_dir().to_string_lossy(),
    }))
}

#[tauri::command]
pub fn test_mode_status() -> Value {
    json!({
        "on": crate::testmode::on(),
        "dataDir": cfg::data_dir().to_string_lossy(),
        "prodDir": cfg::prod_data_dir().to_string_lossy(),
    })
}


/// 重新探测已安装的浏览器与插件状态（用户点「重新检测」/ 启动时调用）
///
/// async + spawn_blocking：这条命令要枚举窗口、读各浏览器的 Preferences，
/// 全是阻塞 IO/系统调用。同步命令跑在 UI 线程上，一旦某个窗口无响应就会把界面顶死。
#[tauri::command]
pub async fn browsers_scan() -> Value {
    tauri::async_runtime::spawn_blocking(|| {
        let list = crate::browsers::scan(true);
        let installed = list.iter().filter(|b| b.installed).count();
        let broken = list
            .iter()
            .filter(|b| b.installed && (b.ext == "notInstalled" || b.ext == "disabled"))
            .count();
        json!({
            "list": list,
            "installed": installed,
            "broken": broken,
            "extFolder": crate::browsers::ext_dir().map(|p| p.to_string_lossy().to_string()),
        })
    })
    .await
    .unwrap_or_else(|e| json!({"list": [], "error": format!("扫描失败：{e}")}))
}

/// 打开某个浏览器的扩展管理页（安装流程第一步），并给 10 分钟保护期
///
/// 一定要 async：同步命令是在 **UI 线程**上执行的，而 `CreateProcessW` 在
/// "Edge/Chrome 是 AppX 执行别名 / 杀软正在扫描 / 已有实例要交接"这几种情况下
/// 会阻塞几百毫秒到几十秒。那一整段时间 WebView 的消息循环停摆，
/// 表现出来的就是"点安装插件 → 整个界面卡死"。
/// 改成 async 之后它跑在异步运行时的阻塞线程池里，界面永远能继续响应。
#[tauri::command]
pub async fn browser_open_ext(key: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::browsers::open_ext_page(&key))
        .await
        .map_err(|e| format!("启动进程失败：{e}"))?
}

/// 设置/清除某个浏览器的自定义主程序路径。
///
/// `path` 为空 = 清除该浏览器的自定义设置（回退到自动检测）。
/// 非空时必须通过校验（存在、是文件、是 .exe），否则直接报错、不写入配置——
/// 存一个坏路径进去比不存更糟，用户会以为已经设好了。
#[tauri::command]
pub fn browser_set_path(
    shared: State<'_, Arc<Shared>>,
    key: String,
    path: String,
) -> Result<String, String> {
    let trimmed = path.trim().trim_matches('"').to_string();
    let mut c = shared.config();

    if trimmed.is_empty() {
        c.settings.browser_exe.remove(&key);
        cfg::save(&c)?;
        if let Ok(mut w) = shared.cfg.write() {
            *w = c.clone();
        }
        crate::browsers::set_custom_exe(c.settings.browser_exe.clone());
        sync_custom_browsers(&c);
        return Ok("已清除自定义路径，改为自动检测".into());
    }

    let p = crate::browsers::validate_exe(&trimmed)?;
    let normalized = p.to_string_lossy().to_string();
    c.settings.browser_exe.insert(key.clone(), normalized.clone());
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c.clone();
    }
    crate::browsers::set_custom_exe(c.settings.browser_exe.clone());
    sync_custom_browsers(&c);
    Ok(format!("已保存：{normalized}"))
}

/// 把配置里的自定义浏览器同步进扫描器（启动与保存两处都要走）
fn sync_custom_browsers(c: &crate::model::Config) {
    let list: Vec<(String, String, String, String)> = c
        .settings
        .custom_browsers
        .iter()
        .map(|b| (b.id.clone(), b.name.clone(), b.exe.clone(), b.ext_page.clone()))
        .collect();
    crate::browsers::set_custom_browsers_all(list);
}

/// 新增或修改一个自定义浏览器（exe 必须存在，避免登记一个点不开的路径）。
#[tauri::command]
pub fn browser_custom_save(
    shared: State<'_, Arc<Shared>>,
    id: String,
    name: String,
    exe: String,
    ext_page: String,
) -> Result<Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("请给这个浏览器起个名字".into());
    }
    let p = crate::browsers::validate_exe(&exe)?;
    let normalized = p.to_string_lossy().to_string();

    let mut c = shared.config();
    let cid = if id.trim().is_empty() {
        format!("c{}", chrono::Local::now().timestamp_millis())
    } else {
        id.trim().to_string()
    };
    let page = ext_page.trim().to_string();
    if let Some(b) = c.settings.custom_browsers.iter_mut().find(|b| b.id == cid) {
        b.name = name.clone();
        b.exe = normalized.clone();
        b.ext_page = page.clone();
    } else {
        if c.settings.custom_browsers.len() >= 16 {
            return Err("最多登记 16 个自定义浏览器".into());
        }
        c.settings.custom_browsers.push(crate::model::CustomBrowser {
            id: cid.clone(),
            name: name.clone(),
            exe: normalized.clone(),
            ext_page: page,
        });
    }
    crate::cfg::sanitize(&mut c);
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c.clone();
    }
    let list: Vec<(String, String, String, String)> = c
        .settings
        .custom_browsers
        .iter()
        .map(|b| (b.id.clone(), b.name.clone(), b.exe.clone(), b.ext_page.clone()))
        .collect();
    crate::browsers::set_custom_browsers_all(list);
    Ok(json!({"ok": true, "id": cid, "name": name, "exe": normalized}))
}

/// 删掉一个自定义浏览器
#[tauri::command]
pub fn browser_custom_remove(shared: State<'_, Arc<Shared>>, id: String) -> Result<Value, String> {
    let mut c = shared.config();
    let before = c.settings.custom_browsers.len();
    c.settings.custom_browsers.retain(|b| b.id != id);
    if c.settings.custom_browsers.len() == before {
        return Err("没找到这条记录".into());
    }
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c.clone();
    }
    let list: Vec<(String, String, String, String)> = c
        .settings
        .custom_browsers
        .iter()
        .map(|b| (b.id.clone(), b.name.clone(), b.exe.clone(), b.ext_page.clone()))
        .collect();
    crate::browsers::set_custom_browsers_all(list);
    Ok(json!({"ok": true}))
}

/// 校验一个路径但不保存（供界面在选完文件后即时提示）
#[tauri::command]
pub fn browser_check_path(path: String) -> Result<String, String> {
    crate::browsers::validate_exe(&path).map(|p| p.to_string_lossy().to_string())
}

/// 扩展目录信息（路径 / 是否存在 / CRX / 程序目录 / 来源），供安装引导展示与复制
#[tauri::command]
pub fn browser_ext_info() -> Value {
    let loc = crate::browsers::ext_location();
    json!({
        "path": loc.path,
        "exists": loc.exists,
        "crx": loc.crx,
        "exeDir": loc.exe_dir,
        "source": loc.source,
    })
}

/// 在资源管理器里打开 extension 目录（"加载已解压的扩展程序"要用）
/// 同样必须 async：explorer.exe 从提权进程里拉起来时也可能卡上一会儿
#[tauri::command]
pub async fn browser_open_folder() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(crate::browsers::open_ext_folder)
        .await
        .map_err(|e| format!("启动资源管理器失败：{e}"))?
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
    // 手动选中了这个窗口 → 立刻锁定它，不再被"跟随前台"抢走
    m.manual_hwnd.store(hwnd as isize, Ordering::Relaxed);
    m.painted.store(false, Ordering::Relaxed);
    m.on.store(true, Ordering::Relaxed);
    // 选中窗口后立刻上遮罩，不等兜底超时
    crate::mask::wake();

    // 主窗口的层级由用户设置决定，不在这里一刀切成"不置顶"。
    // （以前这里写死 false，用户开了"窗口置顶"也会被这次操作悄悄取消）
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(shared.config().settings.always_on_top);
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
    shared.mask.manual_hwnd.store(0, Ordering::Relaxed);
    // 遮罩关了，媒体管控也一起收：把我们停过的媒体还回去
    crate::media::set_active(false);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(shared.config().settings.always_on_top);
    }
}

#[tauri::command]
pub fn mask_set(
    shared: State<'_, Arc<Shared>>,
    opacity: Option<u8>,
    block_click: Option<bool>,
    follow: Option<bool>,
    follow_schedule: Option<bool>,
    media_pause: Option<bool>,
) {
    let m = &*shared.mask;
    if let Some(o) = opacity {
        m.opacity.store(o.min(100), Ordering::Relaxed);
    }
    if let Some(v) = follow {
        // 只管"遮罩范围"：跟随当前窗口 / 固定目标。绝不顺手开关遮罩——
        // 开关承载别的含义，正是之前"以为关了其实开着"的根源。
        m.follow.store(v, Ordering::Relaxed);
    }
    if let Some(v) = follow_schedule {
        m.auto_follow.store(v, Ordering::Relaxed);
    }
    if let Some(b) = block_click {
        m.block_click.store(b, Ordering::Relaxed);
    }
    if let Some(v) = media_pause {
        // 媒体管控开关：关掉时立刻把我们停过的媒体还回去
        m.media_pause.store(v, Ordering::Relaxed);
        if !v {
            crate::media::set_active(false);
        }
    }
    // 参数改动也要立刻生效（比如拖不透明度滑块时能实时看到）
    crate::mask::wake();

    // 这几个开关以前只改内存里的原子值，从不写配置：改完界面看着是生效的，
    // 重启后透明度 / 跟随 / 屏蔽点击全部回退，而界面上没有任何"未保存"标记。
    // 与 mask_follow_schedule / mask_media_pause 保持同一口径：改了就落盘。
    let mut c = shared.config();
    let mut dirty = false;
    if let Some(o) = opacity {
        let o = o.min(100);
        if c.settings.mask.opacity != o {
            c.settings.mask.opacity = o;
            dirty = true;
        }
    }
    if let Some(v) = follow {
        if c.settings.mask.follow != v {
            c.settings.mask.follow = v;
            dirty = true;
        }
    }
    if let Some(v) = follow_schedule {
        if c.settings.mask.follow_schedule != v {
            c.settings.mask.follow_schedule = v;
            dirty = true;
        }
    }
    if let Some(b) = block_click {
        if c.settings.mask.block_click != b {
            c.settings.mask.block_click = b;
            dirty = true;
        }
    }
    if let Some(v) = media_pause {
        if c.settings.mask.media_pause != v {
            c.settings.mask.media_pause = v;
            dirty = true;
        }
    }
    if dirty {
        if let Err(e) = cfg::save(&c) {
            crate::mask::mlog(&format!("遮罩设置保存失败：{e}"));
        } else if let Ok(mut w) = shared.cfg.write() {
            *w = c;
        }
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

/// 主开关：只改"用户意向"。真正是否生效由遮罩线程算：
/// 生效 = on OR (跟随自律 AND 自律模式生效)，见 mask.rs 注释。
#[tauri::command]
pub fn mask_set_on(shared: State<'_, Arc<Shared>>, on: bool) -> Result<(), String> {
    let m = &*shared.mask;
    let auto_hold = m.auto_follow.load(Ordering::Relaxed) && m.schedule_on.load(Ordering::Relaxed);
    if auto_hold && !on {
        // 自律接管期间不允许手动关：否则遮罩线程下一帧又会按自律状态打开，
        // 界面就会出现"关了又自己开"的鬼畜效果
        return Err("自律模式生效中，遮罩由自律模式接管；等这一段时间结束就会自动恢复".into());
    }
    m.preview_until.store(0, Ordering::Relaxed);
    m.test_lock.store(false, Ordering::Relaxed);
    m.manual_hwnd.store(0, Ordering::Relaxed);
    m.painted.store(false, Ordering::Relaxed);
    m.on.store(on, Ordering::Relaxed);
    // 叫醒遮罩线程：否则它要等到兜底超时（最长 1 秒）才会看到开关变了
    crate::mask::wake();
    Ok(())
}

/// 预览效果：临时打开 5 秒就自动收，不会把主开关改成"已启用"
#[tauri::command]
pub fn mask_preview(shared: State<'_, Arc<Shared>>) -> i64 {
    let m = &*shared.mask;
    let now = chrono::Local::now().timestamp();
    if m.preview_until.load(Ordering::Relaxed) > now {
        // 正在预览 → 再点一次提前结束
        m.preview_until.store(0, Ordering::Relaxed);
        m.test_lock.store(false, Ordering::Relaxed);
        m.on.store(false, Ordering::Relaxed);
        crate::mask::wake();
        return 0;
    }
    m.test_lock.store(true, Ordering::Relaxed);
    m.painted.store(false, Ordering::Relaxed);
    m.on.store(true, Ordering::Relaxed);
    m.preview_until.store(now + 5, Ordering::Relaxed);
    crate::mask::wake();
    5
}

/// 遮罩跟随自律模式
#[tauri::command]
pub fn mask_follow_schedule(shared: State<'_, Arc<Shared>>, enabled: bool) -> Result<(), String> {
    let m = &*shared.mask;
    m.auto_follow.store(enabled, Ordering::Relaxed);
    crate::mask::wake();
    let mut c = shared.config();
    c.settings.mask.follow_schedule = enabled;
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    Ok(())
}

/// 媒体管控开关（遮罩生效时自动暂停被盖住窗口的媒体）
#[tauri::command]
pub fn mask_media_pause(shared: State<'_, Arc<Shared>>, enabled: bool) -> Result<(), String> {
    let m = &*shared.mask;
    m.media_pause.store(enabled, Ordering::Relaxed);
    if !enabled {
        // 关掉时立刻把我们停过的媒体还回去
        crate::media::set_active(false);
    }
    crate::mask::wake();
    let mut c = shared.config();
    c.settings.mask.media_pause = enabled;
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

/// 供命令行/调试接口复用，UI 与自动化测试走同一条代码路径。
///
/// 语义是「预览」而不是「开启」：固定高亮本程序窗口，5 秒后自动收起，
/// 期间主开关的意向不会被改写——这样界面上永远不会出现
/// "我只是想看下效果，结果遮罩一直开着"的情况。
pub fn mask_test_inner(app: &AppHandle, shared: &Arc<Shared>) -> Result<bool, String> {
    let m = &*shared.mask;
    let now = chrono::Local::now().timestamp();
    if m.preview_until.load(Ordering::Relaxed) > now {
        m.preview_until.store(0, Ordering::Relaxed);
        m.test_lock.store(false, Ordering::Relaxed);
        m.on.store(false, Ordering::Relaxed);
        return Ok(false);
    }

    let self_pid = std::process::id();
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
    // 记住主窗口：跟随前台时若前台是本程序，遮罩要盖的就是这个窗口
    crate::mask::SELF_MAIN.store(hwnd, Ordering::Relaxed);

    m.target.store(hwnd, Ordering::Relaxed);
    m.target_pid.store(self_pid, Ordering::Relaxed);
    m.test_lock.store(true, Ordering::Relaxed);
    m.painted.store(false, Ordering::Relaxed);
    m.on.store(true, Ordering::Relaxed);
    m.preview_until.store(now + 5, Ordering::Relaxed);
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

/// 提权重启的公共实现（命令入口与"开关管理员模式"共用）。
///
/// 拉起一个带 `--elevated` 标记的新实例，本进程让位退出。关键点：
/// - 必须把 `--elevated` 和 `--wait-pid` 传给新实例。
///   没有 `--elevated`：新实例走普通启动路径，会被单实例互斥体判定为
///   "重复启动"直接退出 —— 表现就是"点了没反应 / 闪退"。
///   没有 `--wait-pid`：新实例一起来就抢锁，而本进程还活着 → 抢不到锁，
///   只能轮询等待，接管会慢好几秒。
/// - 退出前要过 `exit_blocked`：这条路和托盘退出没有区别，不能当后门用。
fn restart_as_admin_inner(app: &AppHandle, shared: &Arc<Shared>) -> Result<(), String> {
    // 这条路会真的退出本进程 → 与托盘退出同等对待
    if let Some(why) = crate::guard::exit_blocked(&shared.config()) {
        return Err(format!("{why}；重启会中断自律，请等这一段结束后再操作"));
    }
    spawn_elevated_self()?;
    // 延迟一小会儿再退出：让当前这次 invoke 的响应先发回前端，
    // 否则界面会先弹一个"调用失败"的红色提示，然后才重启。
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(350));
        // 别把守护进程留下来：它会以为主进程死了，又拉起一个旧权限的实例
        crate::guard::stop_guard();
        h.exit(0);
    });
    Ok(())
}

#[tauri::command]
pub fn restart_as_admin(app: AppHandle, shared: State<'_, Arc<Shared>>) -> Result<(), String> {
    restart_as_admin_inner(&app, &shared)
}

/// 打开"总是以管理员身份运行"。开启后立刻提权重启一次（UAC 确认后生效）。
#[tauri::command]
pub fn set_run_as_admin(
    app: AppHandle,
    shared: State<'_, Arc<Shared>>,
    enabled: bool,
) -> Result<(), String> {
    let mut c = shared.config();
    let before = c.settings.run_as_admin;
    let need_restart = enabled && !is_admin();
    // 只有"需要真重启"时才拦；单纯把开关关掉不重启，不该被纪律限制挡住
    if need_restart {
        if let Some(why) = crate::guard::exit_blocked(&c) {
            return Err(format!("{why}；切换管理员模式要重启程序，请等这一段结束后再操作"));
        }
    }
    c.settings.run_as_admin = enabled;
    cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c.clone();
    }
    if need_restart {
        if let Err(e) = restart_as_admin_inner(&app, &shared) {
            // 没提权成功就把开关退回去，避免"界面显示已开启、实际没生效"
            c.settings.run_as_admin = before;
            let _ = cfg::save(&c);
            if let Ok(mut w) = shared.cfg.write() {
                *w = c;
            }
            return Err(e);
        }
    }
    Ok(())
}

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VAL: &str = "KingOfFocus";
const TASK_NAME: &str = "King Of Focus";

fn add_run_entry(exe: &str) {
    let _ = Command::new("reg")
        .args([
            "add",
            RUN_KEY,
            "/v",
            RUN_VAL,
            "/t",
            "REG_SZ",
            "/d",
            &format!("\"{exe}\""),
            "/f",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

fn remove_run_entry() {
    let _ = Command::new("reg")
        .args(["delete", RUN_KEY, "/v", RUN_VAL, "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

/// 计划任务：登录时以**最高权限**启动，开机不弹 UAC。
///
/// 为什么需要它：HKCU 的 Run 项只能以当前用户权限启动，开机后跑的是一个
/// 普通权限实例；配置里就算写了"以管理员启动"，也只能在程序**起来之后**
/// 再弹 UAC 提权（用户还得点一次确认，托盘常驻时甚至根本走不到）。
/// 用 ONLOGON + `/RL HIGHEST` 的任务，开机就是管理员，一步到位。
fn add_scheduled_task(exe: &str) -> bool {
    Command::new("schtasks")
        .args([
            "/Create",
            "/TN",
            TASK_NAME,
            "/TR",
            &format!("\"{exe}\""),
            "/SC",
            "ONLOGON",
            "/RL",
            "HIGHEST",
            "/F",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|st| st.success())
        .unwrap_or(false)
}

fn remove_scheduled_task() {
    let _ = Command::new("schtasks")
        .args(["/Delete", "/TN", TASK_NAME, "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

/// 统一的自启落地：Run 项 / 计划任务二选一，不会同时存在两条。
///
/// `want_admin` 为真且当前**确实是管理员**时才建计划任务 ——
/// 普通权限下 schtasks 会被拒绝，硬建只会每次启动都多一次失败调用。
pub fn apply_autostart(on: bool, want_admin: bool) {
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return,
    };
    if !on {
        remove_run_entry();
        if is_admin() {
            remove_scheduled_task();
        }
        return;
    }
    if want_admin && is_admin() && add_scheduled_task(&exe) {
        // 任务版就位后清掉 Run 项，避免同一台机器启动两次
        remove_run_entry();
        return;
    }
    if want_admin {
        // 没权限建任务：至少把旧的普通权限任务清掉，免得残留一条低权限自启
        remove_scheduled_task();
    }
    add_run_entry(&exe);
}

#[tauri::command]
pub fn set_autostart(shared: State<'_, Arc<Shared>>, enabled: bool) -> Result<(), String> {
    let c = shared.config();
    apply_autostart(enabled, c.settings.run_as_admin);
    Ok(())
}

/// 请**已经运行的那个实例**提权重启（由它自己写配置 + 弹 UAC）。
///
/// 第二个实例拿不到单实例锁时会走到这里：否则用户"开了管理员启动"、
/// 双击 exe，却因为托盘里那个普通权限实例还活着而永远拿不到管理员。
pub fn ask_peer_to_elevate(cfg: &Config) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{}/api/elevate", cfg.settings.port);
    let body = crate::net::post_local(&url, "{}", std::time::Duration::from_millis(2500))?;
    let v: serde_json::Value =
        serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    match v.get("ok").and_then(|x| x.as_bool()) {
        Some(true) => Ok(if v.get("already").and_then(|x| x.as_bool()) == Some(true) {
            "已在以管理员身份运行".into()
        } else {
            "已请正在运行的实例提权重启".into()
        }),
        _ => Err(v
            .get("why")
            .and_then(|x| x.as_str())
            .unwrap_or("正在运行的实例没有响应")
            .to_string()),
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle, shared: State<'_, Arc<Shared>>) -> Result<(), String> {
    // 自律时段内不能退出：拦截并给出原因，不跳转到主页面
    if let Some(why) = crate::guard::exit_blocked(&shared.config()) {
        return Err(why);
    }
    crate::guard::stop_guard();
    app.exit(0);
    Ok(())
}

/// 强制退出（与 Ctrl+Alt+F4 走同一条路径）
///
/// 与 `quit_app` 的区别：**不受自律时段/专注段的退出拦截**，
/// 也一定走完整的资源清理（守护进程、媒体、遮罩、统计、互斥体）。
#[tauri::command]
pub fn force_quit(app: AppHandle, shared: State<'_, Arc<Shared>>) -> Result<(), String> {
    // 拒绝时把原因带回前端，设置页能直接弹出来，而不是"点了没反应"
    if crate::forcequit::force_quit(&app, &shared) {
        Ok(())
    } else {
        Err(crate::guard::session_quit_hint(&shared.config())
            .unwrap_or_else(|| "现在不能退出".to_string()))
    }
}

/// 主窗口置顶开关。
///
/// 为什么需要它：程序里多处会 `set_always_on_top(false)`（遮罩接管、选中目标窗口、
/// 托盘操作…），而从来没有一处把它设回 true。于是用户感觉"主界面永远在别的窗口
/// 下面，必须先挪开别的窗口才看得见"。这里给一个显式开关，并让那些地方统一读这个值。
#[tauri::command]
pub fn set_always_on_top(
    app: AppHandle,
    shared: State<'_, Arc<Shared>>,
    enabled: bool,
) -> Result<(), String> {
    let mut c = shared.config();
    c.settings.always_on_top = enabled;
    crate::cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    if let Some(w) = app.get_webview_window("main") {
        w.set_always_on_top(enabled).map_err(|e| e.to_string())?;
        // 从"不置顶"切到"置顶"时，仅设属性不会自己浮上来，得主动抬一次
        if enabled {
            let _ = w.show();
            let _ = w.set_focus();
            crate::mask::raise_self();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn show_main(app: AppHandle) {    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 睡眠状态（锁屏窗口每秒轮询；主界面也用）
#[tauri::command]
pub fn sleep_state(shared: State<'_, Arc<Shared>>) -> Value {
    let cfg = shared.config();
    let mut v = crate::sleep::snapshot(&shared).to_json(&cfg);
    if let Some(o) = v.as_object_mut() {
        o.insert("uptime".into(), json!(crate::sleep::uptime_secs()));
        o.insert("text".into(), json!(crate::sleep::summary(&shared)));
        o.insert("lang".into(), json!(cfg.settings.lang));
        o.insert("testMode".into(), json!(crate::testmode::on()));
        o.insert("dryRun".into(), json!(cfg.settings.dry_run));
    }
    v
}

/// 用积分解锁睡眠时段（锁屏窗口上的那个按钮）
#[tauri::command]
pub fn sleep_unlock(shared: State<'_, Arc<Shared>>, minutes: Option<u32>) -> Result<Value, String> {
    crate::sleep::unlock(&shared, minutes.unwrap_or(0))
}

/// 换一条语录：按指定来源**立刻**取一条。
///
/// 返回值刻意不用 `Err` 表示失败——"网络挂了"和"这句没过正向过滤"都是
/// 正常业务结果，界面要靠它决定"退到本地池"并给用户一个明确的说明。
/// 只有"这个来源根本不存在"才走 Err（那是真 bug）。
#[tauri::command]
pub fn quote_fetch(shared: State<'_, Arc<Shared>>, id: String) -> Result<Value, String> {
    let cfg = shared.config();
    let feed = crate::quotes::feed_by_id(&cfg, &id).ok_or_else(|| "没有这个语录来源".to_string())?;
    if feed.kind == "local" {
        // 本地源不联网：内置池在前端（离线也要能立刻换），这里只报告类型
        return Ok(json!({"ok": false, "reason": "local", "feed": feed.id}));
    }
    match crate::quotes::fetch_feed(&feed) {
        Some((text, from)) => {
            // 顺手同步给 HUD，并落盘当"最后一次联网结果"，下次启动第一屏就是它
            crate::quotes::set_quote(&shared, text.clone(), from.clone());
            crate::quotes::save_cache(&text, &from);
            Ok(json!({
                "ok": true,
                "text": text,
                "from": from,
                "feed": feed.id,
                "feedName": feed.name,
                "home": feed.home,
            }))
        }
        None => Ok(json!({"ok": false, "reason": "offline", "feed": feed.id})),
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
        let d = crate::discipline::state(&c, &now);
        // 自律时段（专注段）也算"正在进行"，口径与引擎保持一致
        let running = d.clock_on || !crate::discipline::active_rules(&c, &now, &d).is_empty();
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
/// 设置 HUD 的停靠角与不透明度，并**立刻**生效（不等下一轮轮询）。
///
/// 角用短码（tr/tl/br/bl）；透明度 30–100，越界会被夹住。
/// 落盘之后即使重启也还是用户选的位置和透明度。
#[tauri::command]
pub fn hud_set_look(
    app: AppHandle,
    shared: State<'_, Arc<Shared>>,
    corner: Option<String>,
    opacity: Option<u32>,
    offset_x: Option<i32>,
    offset_y: Option<i32>,
) -> Result<(), String> {
    let mut c = shared.config();
    if let Some(v) = corner {
        c.settings.hud.corner = v;
    }
    if let Some(v) = opacity {
        c.settings.hud.opacity = v;
    }
    if let Some(v) = offset_x {
        c.settings.hud.offset_x = v.max(0);
    }
    if let Some(v) = offset_y {
        c.settings.hud.offset_y = v.max(0);
    }
    // 归一化（非法角回落 tr，透明度夹到 30–100）
    c.settings.hud.corner = c.settings.hud.corner_norm().to_string();
    c.settings.hud.opacity = c.settings.hud.opacity_pct();
    crate::cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c.clone();
    }
    crate::monitor::place_hud(&app, &c);
    Ok(())
}

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
        // HUD 的语言跟着主界面走（它是个独立窗口，只能自己读）
        "lang": cfg.settings.lang,
        "hudEnabled": cfg.settings.hud.enabled,
        // HUD 自己的外观：页面按这个透明度自己调，改完立刻能看到
        "opacity": cfg.settings.hud.opacity_pct(),
        "corner": cfg.settings.hud.corner_norm(),
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

/// 日历（周 / 月）：逐日给出「这一天各软件用了多久、哪几段」
#[tauri::command]
pub fn stats_calendar(start: String, end: String, tab: String) -> Vec<crate::stats::CalDay> {
    crate::stats::calendar(&start, &end, &tab)
}

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

/// 把文件名里 Windows 不接受的字符换掉，并留一个兜底名。
/// 报告标题会带日期和"日报"这类词，通常没问题，但自定义标题可能是任意文本。
fn safe_file_name(title: &str, ext: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    s = s.trim().trim_end_matches('.').to_string();
    if s.chars().count() > 80 {
        s = s.chars().take(80).collect();
    }
    if s.is_empty() {
        s = "报告".into();
    }
    format!("{s}.{ext}")
}

/// 导出报告：Markdown / 纯文本 / Word。
///
/// 三种格式都由 `report_out::blocks` 这同一份结构渲染，
/// 所以标题层级、段落、列表缩进一致；保存位置由用户在系统对话框里选。
#[tauri::command]
pub async fn report_export(app: AppHandle, id: String, format: String) -> Result<String, String> {
    let r = crate::stats::read_report(&id).ok_or_else(|| "报告不存在，可能已被删除".to_string())?;
    let (ext, label) = match format.as_str() {
        "md" | "markdown" => ("md", "Markdown"),
        "txt" | "text" => ("txt", "纯文本"),
        "docx" | "word" => ("docx", "Word 文档"),
        other => return Err(format!("不支持的导出格式：{other}")),
    };
    let picked = app
        .dialog()
        .file()
        .set_title("导出报告")
        .set_file_name(&safe_file_name(&r.title, ext))
        .add_filter(label, &[ext])
        .blocking_save_file();
    let path = picked.ok_or_else(|| "已取消导出".to_string())?;
    let mut p = std::path::PathBuf::from(path.to_string());
    // 用户可能手打了一个别的后缀（或没写），统一补成所选格式，
    // 否则 .docx 会变成一个打不开的裸文件
    let wrong = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| !s.eq_ignore_ascii_case(ext))
        .unwrap_or(true);
    if wrong {
        p.set_extension(ext);
    }
    let bs = crate::report_out::blocks(&r);
    let bytes = match ext {
        "md" => crate::report_out::markdown(&bs).into_bytes(),
        "txt" => crate::report_out::plain(&bs).into_bytes(),
        _ => crate::report_out::docx(&bs),
    };
    std::fs::write(&p, bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(p.to_string_lossy().to_string())
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
pub async fn sync_now(shared: State<'_, Arc<Shared>>) -> Result<String, String> {
    let shared = shared.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = crate::sync::smart(&shared);
        after_sync(&shared, r)
    })
    .await
    .map_err(|_| "同步线程异常退出".to_string())?
}

#[tauri::command]
pub async fn sync_upload(shared: State<'_, Arc<Shared>>) -> Result<String, String> {
    let shared = shared.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = crate::sync::upload(&shared);
        after_sync(&shared, r)
    })
    .await
    .map_err(|_| "同步线程异常退出".to_string())?
}

#[tauri::command]
pub async fn sync_download(shared: State<'_, Arc<Shared>>) -> Result<String, String> {
    let shared = shared.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = crate::sync::download(&shared);
        after_sync(&shared, r)
    })
    .await
    .map_err(|_| "同步线程异常退出".to_string())?
}

// ---------------- 自动更新 ----------------

// 注意：以下命令都碰网络，必须是 async + spawn_blocking。
// 同步命令跑在 Tauri 主线程上，网络一慢就把整个界面冻住（点哪都没反应），
// 启动时的自动更新检查就踩过这个坑。
#[tauri::command]
pub async fn update_check(
    shared: State<'_, Arc<Shared>>,
    token: Option<String>,
) -> Result<Value, String> {
    let shared = shared.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut c = shared.config();
        // 用户可能刚把令牌粘进输入框就点了「立即检查」：先用上它，别逼他先去保存
        if let Some(t) = token {
            let t = t.trim().to_string();
            if !t.is_empty() && t != c.settings.update.token {
                c.settings.update.token = t;
                let _ = cfg::save(&c);
                if let Ok(mut w) = shared.cfg.write() {
                    *w = c.clone();
                }
            }
        }
        let v = crate::update::check(&c.settings.update);
        let mut c2 = c.clone();
        c2.settings.update.last_check = chrono::Local::now().timestamp();
        let _ = cfg::save(&c2);
        if let Ok(mut w) = shared.cfg.write() {
            *w = c2;
        }
        v
    })
    .await
    .map_err(|_| "更新检查线程异常退出".to_string())
}

#[tauri::command]
pub async fn update_quota(shared: State<'_, Arc<Shared>>) -> Result<Value, String> {
    let shared = shared.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let c = shared.config();
        match crate::update::quota(&c.settings.update.token) {
            Ok((rem, lim)) => json!({ "ok": true, "remaining": rem, "limit": lim }),
            Err(e) => json!({ "ok": false, "error": e }),
        }
    })
    .await
    .map_err(|_| "额度查询线程异常退出".to_string())
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
    // 下载是阻塞 IO，放阻塞线程池，别占着异步运行时
    tauri::async_runtime::spawn_blocking(move || crate::update::download(&app, &url, &name))
        .await
        .map_err(|_| "下载线程异常退出".to_string())?
}

#[tauri::command]
pub fn update_apply(
    app: AppHandle,
    shared: State<'_, Arc<Shared>>,
    installer: String,
) -> Result<(), String> {
    // 自动更新会退出进程并让安装脚本 taskkill 掉它 → 同样不能绕过"自律期间不许退出"。
    // 而且守护进程会在安装期间不断把旧版本拉起来，装上又被打断，两头都不落好。
    if let Some(why) = crate::guard::exit_blocked(&shared.config()) {
        return Err(format!("{why}；更新需要退出程序，请等这一段结束后再更新"));
    }
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
