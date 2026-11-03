//! 记住主窗口的位置和大小。
//!
//! ## 为什么单独存一个文件，而不是塞进 config
//!
//! 配置是**会同步的**（云同步 / 跨设备备份）。窗口几何属于"这台机器、这块屏幕"，
//! 同步过去只会在另一台机器上把窗口摆到屏幕外。所以单独存 `window.json`，
//! 不参与任何同步。
//!
//! ## 为什么要校验
//!
//! 用户可能把窗口放在第二块显示器上，然后拔掉那块屏。存下来的坐标落在当前
//! 所有显示器的并集之外时，窗口会"消失"（能看到任务栏图标，点了也不出来）。
//! 所以恢复前先和现有显示器比对，越界就只恢复大小并居中。

use std::sync::Mutex;
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WinState {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub maximized: bool,
}

/// 防抖：拖拽/缩放会连发几十个事件，只有停下来才写盘。
static LAST_SAVE: Mutex<Option<std::time::Instant>> = Mutex::new(None);

fn path() -> std::path::PathBuf {
    crate::cfg::data_dir().join("window.json")
}

/// 保存当前窗口几何（最大化时也记下"恢复后"的尺寸，不然下次取消最大化会变成全屏大小）
pub fn save(win: &WebviewWindow) {
    let Ok(maximized) = win.is_maximized() else {
        return;
    };
    // 最大化状态下 inner_size 是屏幕大小：这时**不覆盖**已存的尺寸，
    // 只把 maximized 置 true，用户取消最大化才能回到原来的大小。
    let prev = load().unwrap_or_default();
    let (w, h) = if maximized && prev.w > 0 && prev.h > 0 {
        (prev.w, prev.h)
    } else {
        match win.inner_size() {
            Ok(s) => (s.width, s.height),
            Err(_) => (prev.w, prev.h),
        }
    };
    let (x, y) = if maximized && prev.w > 0 {
        (prev.x, prev.y)
    } else {
        match win.outer_position() {
            Ok(p) => (p.x, p.y),
            Err(_) => (prev.x, prev.y),
        }
    };
    let s = WinState {
        x,
        y,
        w,
        h,
        maximized,
    };
    if s.w < 320 || s.h < 240 {
        return; // 最小化/异常状态，别把垃圾写进去
    }
    let _ = std::fs::write(path(), serde_json::to_string_pretty(&s).unwrap_or_default());
}

/// 拖动/缩放时的入口：最多每 700ms 写一次（停手后还会再写一次，见 main 的 Moved 分支）
pub fn save_debounced(win: &WebviewWindow) {
    let ok = match LAST_SAVE.lock() {
        Ok(mut g) => match *g {
            Some(t) if t.elapsed().as_millis() < 700 => false,
            _ => {
                *g = Some(std::time::Instant::now());
                true
            }
        },
        Err(_) => true,
    };
    if ok {
        save(win);
    }
}

pub fn load() -> Option<WinState> {
    let s = std::fs::read_to_string(path()).ok()?;
    serde_json::from_str(&s).ok()
}

/// 启动时恢复。越界或尺寸异常一律不恢复（宁可居中，也不要窗口跑到屏幕外）
pub fn restore(win: &WebviewWindow) {
    let Some(st) = load() else { return };
    if st.w < 320 || st.h < 240 {
        return;
    }
    // 先定大小：给它一个合法的初始尺寸，再决定位置
    let _ = win.set_size(PhysicalSize::new(st.w, st.h));
    if on_screen(win, st.x, st.y, st.w, st.h) {
        let _ = win.set_position(PhysicalPosition::new(st.x, st.y));
    } else {
        let _ = win.center();
    }
    if st.maximized {
        let _ = win.maximize();
    }
}

/// 存下来的左上角 + 一个角标是否还落在某块显示器里。
/// 只看左上角不够：窗口可能只露出一条边（32px），那样跟丢了没区别。
fn on_screen(win: &WebviewWindow, x: i32, y: i32, w: u32, h: u32) -> bool {
    let monitors = match win.available_monitors() {
        Ok(m) => m,
        Err(_) => return false,
    };
    if monitors.is_empty() {
        return false;
    }
    let _ = (w, h);
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        title_bar_visible(p.x, p.y, s.width, s.height as u32, x, y)
    })
}

/// 标题栏左上角往右下挪 (60, 20) 的那个点，是否落在显示器矩形里。
///
/// 抽成纯函数是为了能直接测——`on_screen` 要真的建一块屏才能跑，
/// 而"窗口跑到屏幕外"这种回归恰恰不该只能靠手动试。
fn title_bar_visible(mx: i32, my: i32, mw: u32, mh: u32, x: i32, y: i32) -> bool {
    let probe_x = x + 60;
    let probe_y = y + 20;
    probe_x >= mx
        && probe_y >= my
        && probe_x < mx.saturating_add(mw as i32)
        && probe_y < my.saturating_add(mh as i32)
}

#[cfg(test)]
mod tests {
    use super::title_bar_visible;

    #[test]
    fn 屏幕内的位置算可见() {
        assert!(title_bar_visible(0, 0, 1920, 1080, 100, 80));
    }

    #[test]
    fn 完全在屏幕外算不可见() {
        // 第二块屏拔掉之后，存下来的 x 还在 2000 多
        assert!(!title_bar_visible(0, 0, 1920, 1080, 2400, 100));
        assert!(!title_bar_visible(0, 0, 1920, 1080, -800, 100));
    }

    #[test]
    fn 只露出标题栏一角也算可见() {
        // 窗口左边大半在屏幕外，但标题栏还露着 60px —— 用户抓得到
        assert!(title_bar_visible(0, 0, 1920, 1080, -30, 40));
    }

    #[test]
    fn 副屏坐标按副屏的矩形判断() {
        assert!(title_bar_visible(1920, 0, 1920, 1080, 2000, 100));
        assert!(!title_bar_visible(1920, 0, 1920, 1080, 100, 100));
    }
}
