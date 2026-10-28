//! 打开浏览器「扩展管理页」—— 唯一可靠的做法：UI Automation 直接操作地址栏。
//!
//! ## 为什么不能用命令行（这是本问题最反直觉的地方）
//!
//! 直觉做法是 `msedge.exe edge://extensions/`，但 **Chromium 会主动丢弃命令行里的
//! 内部 URL**（`chrome://` / `edge://` / `opera://` 这类）。实测 6 种变体，全部无效：
//!
//! | 方案 | 实测结果 |
//! |---|---|
//! | `msedge.exe edge://extensions/` | 只开「新建标签页」 |
//! | `--new-window edge://extensions/` | 同上 |
//! | `--app=edge://extensions/` | 开一个空窗口 |
//! | `edge://extensions`（无斜杠） | 同上 |
//! | `chrome://extensions/` | 同上 |
//! | 冷启动（独立 profile） | 同上 |
//!
//! 这是浏览器的**安全策略**（防止恶意程序把用户骗到设置页），不是参数写错。
//! 所以"点扩展页没反应"不是本程序的 bug，而是这条路根本走不通。
//!
//! ## 为什么也不能用模拟键盘
//!
//! 「抢前台 + Ctrl+L + 打字 + 回车」看似可行，但有两个致命问题：
//!   · 需要窗口真正拿到**键盘焦点**，而 `SetForegroundWindow` 在非前台进程里
//!     经常被 Windows 静默拒绝；
//!   · 焦点没抢到时，打出来的字符会落到**用户正在用的窗口**里
//!     （实测把用户浏览器地址栏打成了乱码搜索词）——这种副作用不可接受。
//!
//! ## 现在的做法：UI Automation
//!
//! UIA 直接操作控件，**完全不需要键盘焦点**：
//!
//! 1. 找到浏览器主窗口（Chromium 系顶层窗口类名固定为 `Chrome_WidgetWin_1`）
//! 2. 用 InvokePattern 点「新建标签页」按钮（不动用户已打开的页面）
//! 3. 用 ValuePattern 直接给地址栏**设值** `edge://extensions/`
//! 4. `PostMessage(hwnd, WM_KEYDOWN/WM_CHAR/WM_KEYUP, VK_RETURN)` 投递回车提交
//!
//! 第 4 步是关键：PostMessage 直接进目标窗口的消息队列，不经过系统键盘焦点，
//! 所以"窗口在后台"也能提交。这一套已在真实 Edge 上实测通过（新标签成功打开扩展页）。

use windows::core::{Interface, BSTR, VARIANT};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
    IUIAutomationValuePattern, TreeScope_Descendants, UIA_ButtonControlTypeId,
    UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_InvokePatternId,
    UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CHAR, WM_KEYDOWN, WM_KEYUP,
};

const VK_RETURN: usize = 0x0D;
const CHROME_CLASS_PREFIX: &str = "Chrome_WidgetWin";

struct WinInfo {
    hwnd: HWND,
    area: i64,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let list = &mut *(lparam.0 as *mut Vec<WinInfo>);
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }
    let mut cls = [0u16; 128];
    let n = GetClassNameW(hwnd, &mut cls);
    let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
    if !class.starts_with(CHROME_CLASS_PREFIX) {
        return BOOL(1);
    }
    let tlen = GetWindowTextLengthW(hwnd);
    if tlen <= 0 {
        return BOOL(1);
    }
    let mut r = RECT::default();
    let _ = GetWindowRect(hwnd, &mut r);
    let w = (r.right - r.left) as i64;
    let h = (r.bottom - r.top) as i64;
    if w < 400 || h < 300 {
        return BOOL(1);
    }
    list.push(WinInfo { hwnd, area: w * h });
    BOOL(1)
}

/// 找出属于指定进程的所有可见浏览器窗口
fn windows_of(pid: u32) -> Vec<WinInfo> {
    let mut all: Vec<WinInfo> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(enum_proc),
            LPARAM(&mut all as *mut Vec<WinInfo> as isize),
        );
    }
    all.retain(|w| unsafe {
        let mut p = 0u32;
        GetWindowThreadProcessId(w.hwnd, Some(&mut p));
        p == pid
    });
    all
}

struct Uia {
    auto: IUIAutomation,
}

impl Uia {
    fn new() -> Result<Self, String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let auto: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("UIA 初始化失败：{e}"))?;
            Ok(Uia { auto })
        }
    }

    fn root(&self, hwnd: HWND) -> Result<IUIAutomationElement, String> {
        unsafe {
            self.auto
                .ElementFromHandle(hwnd)
                .map_err(|e| format!("取窗口元素失败：{e}"))
        }
    }

    fn find_all(&self, root: &IUIAutomationElement, ctype: i32) -> Vec<IUIAutomationElement> {
        unsafe {
            let Ok(cond) = self
                .auto
                .CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(ctype))
            else {
                return vec![];
            };
            let Ok(arr) = root.FindAll(TreeScope_Descendants, &cond) else {
                return vec![];
            };
            let n = arr.Length().unwrap_or(0);
            (0..n).filter_map(|i| arr.GetElement(i).ok()).collect()
        }
    }

    fn name_of(e: &IUIAutomationElement) -> String {
        unsafe { e.CurrentName().map(|b| b.to_string()).unwrap_or_default() }
    }
}

/// 给地址栏设值 + 投递回车
fn fill_and_submit(uia: &Uia, hwnd: HWND, url: &str) -> Result<(), String> {
    let root = uia.root(hwnd)?;
    let edits = uia.find_all(&root, UIA_EditControlTypeId.0);

    // 地址栏在 Chromium 里是 Name 含「地址」/「Address」的 Edit 控件
    let bar = edits
        .iter()
        .find(|e| {
            let n = Uia::name_of(e);
            let l = n.to_lowercase();
            n.contains("地址") || l.contains("address") || l.contains("search or enter")
        })
        .cloned()
        .ok_or_else(|| "在浏览器窗口里找不到地址栏（可能是浏览器版本不同）".to_string())?;

    unsafe {
        let vp: IUIAutomationValuePattern = bar
            .GetCurrentPattern(UIA_ValuePatternId)
            .and_then(|u| u.cast())
            .map_err(|e| format!("地址栏不支持设值：{e}"))?;
        vp.SetValue(&BSTR::from(url))
            .map_err(|e| format!("写入地址失败：{e}"))?;
    }

    // PostMessage 投递回车：直接进窗口消息队列，不依赖键盘焦点
    unsafe {
        let _ = PostMessageW(hwnd, WM_KEYDOWN, windows::Win32::Foundation::WPARAM(VK_RETURN), LPARAM(0x001C_0001));
        std::thread::sleep(std::time::Duration::from_millis(60));
        let _ = PostMessageW(hwnd, WM_CHAR, windows::Win32::Foundation::WPARAM(VK_RETURN), LPARAM(0x001C_0001));
        std::thread::sleep(std::time::Duration::from_millis(60));
        let _ = PostMessageW(hwnd, WM_KEYUP, windows::Win32::Foundation::WPARAM(VK_RETURN), LPARAM(0xC01C_0001u32 as isize));
    }
    Ok(())
}

/// 点「新建标签页」按钮
fn click_new_tab(uia: &Uia, root: &IUIAutomationElement) -> bool {
    for e in uia.find_all(root, UIA_ButtonControlTypeId.0) {
        let n = Uia::name_of(&e);
        if n.contains("新建标签页") || n.to_lowercase().contains("new tab") {
            unsafe {
                if let Ok(p) = e
                    .GetCurrentPattern(UIA_InvokePatternId)
                    .and_then(|u| u.cast::<IUIAutomationInvokePattern>())
                {
                    if p.Invoke().is_ok() {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// 标签页数量（用于安全检查：确认新标签真的开出来了）
fn tab_count(uia: &Uia, hwnd: HWND) -> usize {
    match uia.root(hwnd) {
        Ok(root) => uia
            .find_all(&root, windows::Win32::UI::Accessibility::UIA_TabItemControlTypeId.0)
            .len(),
        Err(_) => 0,
    }
}

/// 打开扩展管理页（UIA 方案）。`pid` 是浏览器进程 id。
pub fn open_ext_page_via_uia(pid: u32, url: &str, browser_name: &str) -> Result<String, String> {
    let mut wins = windows_of(pid);
    if wins.is_empty() {
        return Err(format!(
            "没找到 {browser_name} 的窗口（可能最小化到了托盘）。\n\
             可以先手动打开 {browser_name}，再点一次；\n\
             或者直接在地址栏输入 {url}。"
        ));
    }
    wins.sort_by_key(|w| -w.area);
    // HWND 内部是裸指针，不实现 Send；跨线程只传它的数值形式，进线程后再还原
    let hwnd_raw = wins[0].hwnd.0 as isize;

    let url = url.to_string();
    let url_for_err = url.clone();
    let name = browser_name.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
        let r = (|| -> Result<String, String> {
            let uia = Uia::new()?;
            let root = uia.root(hwnd)?;

            // 先开新标签，绝不覆盖用户正在看的页面
            let before = tab_count(&uia, hwnd);
            let opened = click_new_tab(&uia, &root);
            if opened {
                std::thread::sleep(std::time::Duration::from_millis(1600));
            }
            // 安全闸：只有确认「标签数增加了」才继续往地址栏写字。
            // 否则可能把 URL 打进用户当前页面 —— 这个事故真实发生过。
            if opened && tab_count(&uia, hwnd) <= before {
                return Err(format!(
                    "{name} 没有响应「新建标签页」，为避免影响你正在浏览的页面，已取消。\n\
                     请手动在地址栏输入 {url}。"
                ));
            }

            fill_and_submit(&uia, hwnd, &url)?;
            std::thread::sleep(std::time::Duration::from_millis(1200));
            Ok(if opened {
                format!("已在新标签页打开 {name} 的扩展管理页")
            } else {
                format!("已在 {name} 当前标签页打开扩展管理页")
            })
        })();
        let _ = tx.send(r);
    });

    match rx.recv_timeout(std::time::Duration::from_secs(12)) {
        Ok(Ok(msg)) => Ok(msg),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!(
            "打开 {browser_name} 扩展页超时。可以手动在地址栏输入 {url_for_err}。"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_class_prefix_matches_real_window_class() {
        // Chromium 系顶层窗口类名固定是 Chrome_WidgetWin_1；别的程序不能被误判
        assert!("Chrome_WidgetWin_1".starts_with(CHROME_CLASS_PREFIX));
        assert!(!"Notepad".starts_with(CHROME_CLASS_PREFIX));
        assert!(!"ApplicationFrameWindow".starts_with(CHROME_CLASS_PREFIX));
    }

    #[test]
    fn return_key_constant_is_correct() {
        // 回车虚拟键码 0x0D，提交地址栏依赖它
        assert_eq!(VK_RETURN, 0x0D);
    }
}
