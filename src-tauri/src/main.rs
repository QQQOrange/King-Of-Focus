#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod browsers;
mod cfg;
mod clock;
mod cmds;
mod discipline;
mod extpage;
mod forcequit;
mod guard;
mod mask;
mod matcher;
mod media;
mod model;
mod monitor;
mod net;
mod notify;
mod proc;
mod quotes;
mod report_out;
mod sched;
mod server;
mod shared;
mod stats;
mod testmode;
mod sync;
mod update;
mod version;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attr: *const u8, owner: i32, name: *const u16) -> *mut std::ffi::c_void;
    fn CloseHandle(h: *mut std::ffi::c_void) -> i32;
}

const INSTANCE_MUTEX: &str = "Local\\KingOfFocus-SingleInstance";

/// 当前进程持有的单实例互斥体句柄（故意不随进程关闭，进程退出时由系统回收）
static INSTANCE_LOCK: std::sync::atomic::AtomicPtr<std::ffi::c_void> =
    std::sync::atomic::AtomicPtr::new(std::ptr::null_mut());

/// 尝试创建单实例互斥体，成功返回 true
fn create_instance_lock() -> bool {
    let name: Vec<u16> = format!("{INSTANCE_MUTEX}\0").encode_utf16().collect();
    unsafe {
        let h = CreateMutexW(std::ptr::null(), 1, name.as_ptr());
        if h.is_null() {
            return true;
        }
        if std::io::Error::last_os_error().raw_os_error() == Some(183) {
            // 已存在：必须关掉这个句柄，否则互斥体对象永远不销毁，
            // 提权副本会一直拿到 183，永远接不了班。
            CloseHandle(h);
            return false;
        }
        INSTANCE_LOCK.store(h, Ordering::SeqCst);
        true
    }
}

/// 主动释放单实例锁（提权交接时用，让新实例能立刻接管）
#[allow(dead_code)]
pub fn release_instance_lock() {
    let p = INSTANCE_LOCK.swap(std::ptr::null_mut(), Ordering::SeqCst);
    if !p.is_null() {
        unsafe {
            CloseHandle(p);
        }
    }
}

/// 抢单实例锁。
///
/// `elevated = true` 表示这是提权副本：它是被上一个进程"接班"的，
/// 上一个进程可能还没退干净，所以这里要轮询等待，最多等 15 秒。
/// 早期版本这里直接 return，导致提权副本一启动就被判定为"重复启动"退出 ——
///
/// 也就是用户看到的"点开先闪退、第 2 次点才正常"。
fn acquire_instance(elevated: bool) -> bool {
    if create_instance_lock() {
        return true;
    }
    if !elevated {
        return false;
    }
    for _ in 0..150 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if create_instance_lock() {
            return true;
        }
    }
    false
}

/// 从命令行参数里解析 `--wait-pid=1234`
fn arg_wait_pid(args: &[String]) -> Option<u32> {
    args.iter()
        .find_map(|a| a.strip_prefix("--wait-pid="))
        .and_then(|v| v.trim().parse::<u32>().ok())
}

/// 等指定的原进程真正退出（提权交接用）
///
/// 必须等它退出、并且互斥体随之释放，提权副本才能干净地接管。
/// 直接抢锁会拿到 ERROR_ALREADY_EXISTS，然后只能干等。
fn wait_process_exit(pid: u32, timeout_ms: u64) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if !proc::is_alive(pid) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn main() {
    // 守护进程模式：由主进程在锁定时拉起，只负责"主进程被杀就复活它"
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--guard") {
        guard::guard_main();
        return;
    }
    // 提权副本标记：由 spawn_elevated("--elevated") 传入
    let elevated = args.iter().any(|a| a == "--elevated");
    // 被守护拉起来的复活实例：不清"别复活"哨兵，
    // 否则守护下一轮又能把它复活，"强制退出"就白按了。
    let respawned = args.iter().any(|a| a == "--respawn");
    if !respawned {
        crate::guard::clear_quit_sentinel();
    }

    // 提权副本：先等原进程真正退出（它退出会释放单实例互斥体），
    // 再去抢锁 —— 否则会一直拿到 ERROR_ALREADY_EXISTS。
    if elevated {
        if let Some(pid) = arg_wait_pid(&args) {
            wait_process_exit(pid, 20_000);
        }
    }

    // 先抢单实例锁：已经有实例在跑就安静退出。
    // 顺序很重要 —— 必须先确认"没有别的实例"，再决定要不要弹 UAC，
    // 否则用户重复双击 exe 时会莫名弹一次 UAC。
    if !acquire_instance(elevated) {
        return;
    }

    let config = cfg::load();

    // 清理早期版本的提权标记（.elevate_try）。
    // 旧版在"准备提权"时就写标记，提权成功后也不删 —— 结果 120 秒内的
    // 第二次启动会跳过提权，实际跑的实例永远不是管理员。
    let _ = std::fs::remove_file(cfg::data_dir().join(".elevate_try"));

    // 提权副本：清掉"上次提权失败"的标记
    if elevated {
        cmds::clear_elevate_marker();
    } else if config.settings.run_as_admin && !cmds::is_admin() {
        // 启动即提权。必须发生在创建窗口之前：
        // 否则会先弹出一个普通权限的窗口再被杀掉 —— 用户看到的"闪退"。
        if !cmds::elevate_marker_fresh() {
            match cmds::spawn_elevated_self() {
                Ok(()) => {
                    // 提权副本会等本进程退出（--wait-pid）后再接管单实例锁。
                    // 这里**不要**提前释放锁：提前释放会让"再点一次 exe"的
                    // 第三个进程有机会抢到锁，把提权副本挤掉。
                    // 本进程返回即退出，句柄由系统回收，锁自然释放。
                    return;
                }
                Err(e) => {
                    // UAC 被拒 / 没权限：记录标记 120 秒内不再弹窗，
                    // 但本次仍以普通权限继续跑，不让程序起不来。
                    eprintln!("[king-of-focus] {e}");
                    cmds::mark_elevate_failed();
                }
            }
        }
    }

    let shared = Arc::new(shared::Shared::new(config.clone()));
    let shared_exit = shared.clone();

    // 把配置里的遮罩参数灌进运行态
    cmds::apply_runtime_cfg(&shared);

    mask::start(shared.mask.clone());
    stats::start(shared.clone());
    quotes::start(shared.clone());
    // 浏览器/插件状态的后台预热：界面只读内存快照，扫盘永远不占 UI 线程
    browsers::warm_start();

    // 启动时自动备份（只留最近 10 份 / 7 天）
    if config.settings.backup.auto_on_start {
        let sh = shared.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(5));
            let _ = backup::make(&sh);
        });
    }
    sync::start_auto(shared.clone());
    update::cleanup();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(shared.clone())
        .setup(move |app| {
            // 注：管理员提权已在 main() 里、创建窗口之前完成。
            // 放在 setup() 里会先闪出一个普通权限窗口再被杀掉（用户看到的"闪退"）。
            // 运行时再设一次窗口图标，保证任务栏/Alt+Tab 用的是新图标
            for label in ["main", "hud"] {
                if let Some(w) = app.get_webview_window(label) {
                    if let Ok(img) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")) {
                        let _ = w.set_icon(img);
                    }
                }
            }

            let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let mask_item = MenuItem::with_id(app, "mask", "开关专注遮罩", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 King of Focus", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &mask_item, &quit])?;
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

            let sh_menu = shared.clone();
            TrayIconBuilder::with_id("kof")
                .icon(icon)
                .tooltip("King of Focus")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "mask" => {
                        // 自律接管期间，遮罩的开关由自律状态决定：
                        // 这里再翻一次"用户意向"只会让界面显示和实际不一致。
                        // 和被占用的热键一样，给一句提示说明为什么点了没反应。
                        let m = &*sh_menu.mask;
                        let auto_hold = m.auto_follow.load(Ordering::Relaxed)
                            && m.schedule_on.load(Ordering::Relaxed);
                        if auto_hold {
                            if let Ok(mut n) = m.notice.lock() {
                                *n = Some(
                                    "自律模式生效中，遮罩由自律模式接管；结束时会自动恢复".into(),
                                );
                            }
                        } else {
                            let on = m.on.load(Ordering::Relaxed);
                            m.on.store(!on, Ordering::Relaxed);
                        }
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.set_always_on_top(sh_menu.config().settings.always_on_top);
                            let _ = w.show();
                        }
                    }
                    "quit" => {
                        match crate::guard::exit_blocked(&sh_menu.config()) {
                            Some(why) => {
                                // 自律时段内：拦截退出。
                                // 以前这里是"提示 + 把主界面拉到前面"，用户点了退出却
                                // 看到界面自己跳出来——现在只弹一张不抢焦点的提示卡。
                                let body = format!(
                                    "<b>{}</b><br>这段时间是自律时段，结束前程序不能退出。",
                                    crate::notify::esc(&why)
                                );
                                crate::notify::toast(&app, "app", "现在不能退出", &body, "自律模式", 5);
                                sh_menu.say(why);
                            }
                            None => {
                                crate::guard::stop_guard();
                                app.exit(0);
                            }
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 单击或双击都直接打开主界面
                    let hit = matches!(
                        event,
                        TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
                            | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. }
                    );
                    if hit {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // 关窗口 = 收进托盘；遮罩如果开着，顺手关掉，避免黑屏下找不到人
            if let Some(win) = app.get_webview_window("main") {
                let sh = shared.clone();
                let w2 = win.clone();
                let app_h = win.app_handle().clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // ---- Alt+F4 识别（关键）----
                        // Alt+F4 和点右上角 X 在 Win32 层面是**同一条路**
                        // （Alt+F4 → WM_SYSCOMMAND(SC_CLOSE) → WM_CLOSE → CloseRequested），
                        // Tauri 报出来的事件完全一样，字段里没有任何东西能区分。
                        // 唯一的区别是：按 Alt+F4 的那一刻用户的手还按在 Alt 上，
                        // 点 X 时 Alt 一定是松开的。
                        //
                        // 所以这里必须单独判：Alt+F4 = 用户的"强制退出"意图，
                        // 哪怕此刻正在自律时段里、哪怕设了"关闭窗口时收进托盘"，
                        // 也要真的把程序停下来 —— 这正是"强制退出"的意义。
                        // 反过来，点 X 仍然走原来的规则（收进托盘 / 时段内拦截）。
                        if crate::forcequit::is_alt_f4_close() {
                            api.prevent_close();
                            // 自律时段内关掉了「允许退出」时，这里会被拒，
                            // 窗口保持原样（上面已经 prevent_close）。
                            let _ = crate::forcequit::force_quit(&app_h, &sh);
                            return;
                        }
                        if sh.mask.on.load(Ordering::Relaxed) {
                            sh.mask.on.store(false, Ordering::Relaxed);
                            let _ = w2.set_always_on_top(sh.config().settings.always_on_top);
                        }
                        if sh.config().settings.close_to_tray {
                            api.prevent_close();
                            let _ = w2.hide();
                        } else if let Some(why) = crate::guard::exit_blocked(&sh.config()) {
                            // 自律时段内：连"关窗口"这条退路也不给。
                            // 窗口保持打开，只弹一张不抢焦点的提示卡说明原因。
                            api.prevent_close();
                            let body = format!(
                                "<b>{}</b><br>这段时间是自律时段，结束前程序不能退出。",
                                crate::notify::esc(&why)
                            );
                            crate::notify::toast(&app_h, "app", "现在不能退出", &body, "自律模式", 5);
                        }
                    }
                });
            }

            // 启动时应用「窗口置顶」设置（之前这一项根本没被读过）
            if shared.config().settings.always_on_top {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_always_on_top(true);
                    crate::mask::raise_self();
                }
            }

            monitor::start(app.handle().clone(), shared.clone());
            server::start(app.handle().clone(), shared.clone());

            // 强制退出监听：Ctrl+Alt+F4（任意前台）/ Alt+F4（本程序在前台）
            crate::forcequit::start(app.handle().clone(), shared.clone());

            // 记住主窗口句柄：遮罩允许把洞挖在本程序身上（盖住 King of Focus 自己）
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(h) = w.hwnd() {
                    mask::SELF_MAIN.store(h.0 as isize, std::sync::atomic::Ordering::Relaxed);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmds::get_state,
            cmds::save_config,
            cmds::list_windows,
            cmds::pick_path,
            cmds::mask_start,
            cmds::mask_stop,
            cmds::mask_set,
            cmds::mask_hotkey,
            cmds::mask_follow_schedule,
            cmds::mask_media_pause,
            cmds::mask_set_on,
            cmds::mask_preview,
            cmds::mask_test,
            cmds::mask_diag,
            cmds::open_path,
            cmds::open_config_dir,
            cmds::open_extension_dir,
            cmds::restart_as_admin,
            cmds::set_autostart,
            cmds::set_run_as_admin,
            cmds::set_always_on_top,
            cmds::test_mode_enter,
            cmds::test_mode_exit,
            cmds::test_mode_status,
            cmds::browsers_scan,
            cmds::browser_open_ext,
            cmds::browser_open_folder,
            cmds::browser_ext_info,
            cmds::browser_set_path,
            cmds::browser_check_path,
            cmds::quit_app,
            cmds::force_quit,
            cmds::hide_window,
            cmds::show_main,
            cmds::points_unlock,
            cmds::hud_state,
            cmds::hud_set_look,
            cmds::hud_save,
            cmds::notify_save,
            cmds::backup_make,
            cmds::backup_list,
            cmds::backup_restore,
            cmds::backup_delete,
            cmds::backup_open_dir,
            cmds::backup_save,
            cmds::backup_cloud_list,
            cmds::backup_cloud_upload,
            cmds::backup_cloud_restore,
            cmds::stats_range,
            cmds::stats_flush,
            cmds::stats_dir_path,
            cmds::report_list,
            cmds::report_get,
            cmds::report_generate,
            cmds::report_delete,
            cmds::report_export,
            cmds::sync_save,
            cmds::sync_now,
            cmds::sync_upload,
            cmds::sync_download,
            cmds::update_check,
            cmds::update_quota,
            cmds::update_save,
            cmds::update_download,
            cmds::update_apply,
            cmds::open_url,
        ])
        .build(tauri::generate_context!())
        .expect("King of Focus 启动失败")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                stats::flush(&shared_exit);
            }
        });
}
