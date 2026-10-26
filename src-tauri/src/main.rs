#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod cfg;
mod cmds;
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
    {
        let m = &shared.mask;
        m.opacity.store(config.settings.mask.opacity.min(100), Ordering::Relaxed);
        m.margin.store(config.settings.mask.margin.clamp(0, 200), Ordering::Relaxed);
        m.block_click.store(config.settings.mask.block_click, Ordering::Relaxed);
        m.radius.store(config.settings.mask.radius.clamp(0, 120), Ordering::Relaxed);
        m.duration.store(config.settings.mask.duration_ms.min(2000) as i32, Ordering::Relaxed);
        if let Some((md, vk)) = mask::parse_hotkey(&config.settings.mask.hotkey) {
            m.hk_mod.store(md, Ordering::Relaxed);
            m.hk_vk.store(vk, Ordering::Relaxed);
        }
        m.auto.store(config.settings.mask.auto, Ordering::Relaxed);
        if let Ok(mut g) = m.auto_apps.lock() {
            *g = config.settings.mask.auto_apps.clone();
        }
        m.target_pid.store(config.settings.mask.target_pid, Ordering::Relaxed);
    }

    mask::start(shared.mask.clone());
    stats::start(shared.clone());
    quotes::start(shared.clone());

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
                        if crate::guard::lock_info(&sh_menu.config()).locked {
                            sh_menu.say("自律固化中，结束前无法退出");
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        } else {
                            crate::guard::stop_guard();
                            app.exit(0);
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
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if sh.mask.on.load(Ordering::Relaxed) {
                            sh.mask.on.store(false, Ordering::Relaxed);
                            let _ = w2.set_always_on_top(false);
                        }
                        if sh.config().settings.close_to_tray {
                            api.prevent_close();
                            let _ = w2.hide();
                        }
                    }
                });
            }

            monitor::start(app.handle().clone(), shared.clone());
            server::start(app.handle().clone(), shared.clone());
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
            cmds::mask_auto,
            cmds::mask_test,
            cmds::mask_diag,
            cmds::open_path,
            cmds::open_config_dir,
            cmds::open_extension_dir,
            cmds::restart_as_admin,
            cmds::set_autostart,
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
