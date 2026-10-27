#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod browsers;
mod cfg;
mod clock;
mod cmds;
mod discipline;
mod guard;
mod mask;
mod matcher;
mod model;
mod monitor;
mod net;
mod notify;
mod proc;
mod quotes;
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
}

/// 单实例：已经有一个在跑就直接退出，避免两个进程抢着拦同一个程序
fn single_instance() -> bool {
    let name: Vec<u16> = "Local\\KingOfFocus-SingleInstance\0".encode_utf16().collect();
    unsafe {
        let h = CreateMutexW(std::ptr::null(), 1, name.as_ptr());
        if h.is_null() {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(183)
    }
}

fn main() {
    // 守护进程模式：由主进程在锁定时拉起，只负责"主进程被杀就复活它"
    if std::env::args().any(|a| a == "--guard") {
        guard::guard_main();
        return;
    }
    if !single_instance() {
        return;
    }

    let config = cfg::load();
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
            // 配置里要求管理员模式，但当前不是 → 提权重启一次。
            // 用标记文件防止"用户拒绝 UAC → 每次启动都弹窗"的死循环。
            if config.settings.run_as_admin && !cmds::is_admin() {
                let marker = cfg::data_dir().join(".elevate_try");
                let fresh = std::fs::metadata(&marker)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .map(|e| e.as_secs() < 120)
                    .unwrap_or(false);
                if !fresh {
                    let _ = std::fs::write(&marker, b"1");
                    let _ = cmds::restart_as_admin(app.handle().clone());
                }
            }
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
                        let on = sh_menu.mask.on.load(Ordering::Relaxed);
                        sh_menu.mask.on.store(!on, Ordering::Relaxed);
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.set_always_on_top(false);
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
                        if sh.mask.on.load(Ordering::Relaxed) {
                            sh.mask.on.store(false, Ordering::Relaxed);
                            let _ = w2.set_always_on_top(false);
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

            monitor::start(app.handle().clone(), shared.clone());
            server::start(app.handle().clone(), shared.clone());

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
            cmds::test_mode_enter,
            cmds::test_mode_exit,
            cmds::test_mode_status,
            cmds::browsers_scan,
            cmds::browser_open_ext,
            cmds::browser_open_folder,
            cmds::browser_ext_info,
            cmds::quit_app,
            cmds::hide_window,
            cmds::show_main,
            cmds::points_unlock,
            cmds::hud_state,
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
