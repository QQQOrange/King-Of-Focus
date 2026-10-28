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
//!
//! ## 为什么也不能用模拟键盘
//!
//! 「抢前台 + Ctrl+L + 打字 + 回车」看似可行，但需要窗口真正拿到**键盘焦点**，
//! 而 `SetForegroundWindow` 在非前台进程里经常被 Windows 静默拒绝；
//! 焦点没抢到时，打出来的字符会落到**用户正在用的窗口**里
//! （实测把用户浏览器地址栏打成了乱码搜索词）——这种副作用不可接受。
//!
//! ## 现在的做法：UI Automation（两段式）
//!
//! 1. 找到浏览器主窗口（Chromium 系顶层窗口类名固定为 `Chrome_WidgetWin_*`）
//! 2. （需要新标签时）用 InvokePattern 点「新建标签」按钮，不动用户已打开的页面
//! 3. 给地址栏**设值**：优先 `ValuePattern.SetValue`，**并回读核对**
//! 4. 回读不对 / 直接报错 → 退化为「`SetFocus` 把焦点交给地址栏 + 逐字符 `PostMessage(WM_CHAR)`」
//! 5. 最后 `PostMessage(VK_RETURN)` 提交
//!
//! 第 4 步是兼容性的关键：**Opera 的地址栏不支持 `SetValue`**
//! （空实现，直接抛 `E_FAIL`），但 `SetFocus` + `WM_CHAR` 是有效的。
//! 消息只投给这一个窗口，不进系统键盘队列，所以即使窗口在后台也不会打到别处去。
//!
//! ## 冷启动为什么只产生一个标签页
//!
//! 以前是「`exe 扩展页URL` 启动一次（URL 被丢弃 → 落在新建标签页）」
//! 再「点一次新建标签页 → 落到第二个标签」，于是**一次点击出现两个标签**，
//! 而且中间还有若干固定 `sleep`，肉眼可见地卡。
//! 现在冷启动改成带 `about:blank` 启动（Chromium 允许 `about:`），
//! 等窗口出来后在**这一个**空白标签里直接跳转，全程只有一个标签、没有多余等待。

use windows::core::{Interface, BSTR};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
    IUIAutomationValuePattern, TreeScope_Descendants, UIA_ButtonControlTypeId,
    UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_InvokePatternId,
    UIA_TabItemControlTypeId, UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextLengthW, GetWindowThreadProcessId,
    IsWindowVisible, PostMessageW, WM_CHAR, WM_KEYDOWN, WM_KEYUP,
};
use windows::core::VARIANT;

const VK_RETURN: usize = 0x0D;
const VK_END: usize = 0x23;
const VK_BACK: usize = 0x08;
const CHROME_CLASS_PREFIX: &str = "Chrome_WidgetWin";

struct WinInfo {
    hwnd: HWND,
    area: i64,
    titled: bool,
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
    let mut r = RECT::default();
    let _ = GetWindowRect(hwnd, &mut r);
    let w = (r.right - r.left) as i64;
    let h = (r.bottom - r.top) as i64;
    if w < 400 || h < 300 {
        return BOOL(1);
    }
    // 刚启动的窗口标题可能还是空的（页面没加载完），不能因此就把它排除掉，
    // 否则冷启动时我们会一直"找不到窗口"。空标题只作为排序时的次要权重。
    let titled = GetWindowTextLengthW(hwnd) > 0;
    list.push(WinInfo { hwnd, area: w * h, titled });
    BOOL(1)
}

/// 找出属于指定进程的可见浏览器窗口，最像"主窗口"的排在前面
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
    // 有标题的优先，其次按面积从大到小（多窗口时取最大的那个）
    all.sort_by(|a, b| b.titled.cmp(&a.titled).then(b.area.cmp(&a.area)));
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

    fn class_of(e: &IUIAutomationElement) -> String {
        unsafe { e.CurrentClassName().map(|b| b.to_string()).unwrap_or_default() }
    }

    /// 地址栏候选打分。分数越高越可能是"能输入的那个框"。
    ///
    /// 各家的结构差别很大，实测三例：
    ///   · Edge   ：1 个 Edit，Name「地址和搜索栏」，class `OmniboxViewViews`
    ///   · Opera  ：2 个 Edit，Name 都叫「地址栏」，class 分别是
    ///              `AddressBarView`（外壳，不接收输入）和 `AddressTextfieldView`（真输入框）
    ///   · 某些 Chromium 还带一个「搜索网络」的 Edit（其实是搜索框，不能当地址栏用）
    ///
    /// 所以判据是"class 像不像输入框 > 名字像不像地址栏"，并且要**排除**搜索框。
    fn omnibox_score(name: &str, class: &str) -> i32 {
        let n = name.to_lowercase();
        let c = class.to_lowercase();
        let mut s = 0;
        // 真正的文本输入控件（Opera / Chromium 的命名习惯）
        if c.contains("textfield") || c.contains("omnibox") || c.contains("textfieldview") {
            s += 10;
        }
        // 地址栏外壳（能设值，但不是最佳选择）
        if c.contains("addressbar") && !c.contains("textfield") {
            s += 4;
        }
        if name.contains("地址") || n.contains("address") {
            s += 5;
        }
        if n.contains("search") || name.contains("搜索") {
            s -= 6;
        }
        if n.contains("find") || name.contains("查找") {
            s -= 6;
        }
        s
    }

    /// 找地址栏。返回 None 表示这个浏览器没暴露可写的地址栏。
    fn find_omnibox(&self, root: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        let edits = self.find_all(root, UIA_EditControlTypeId.0);
        let mut best: Option<(i32, IUIAutomationElement)> = None;
        for e in edits {
            // 只读的框（页面里的输入框之类）不能当地址栏
            let ro = match value_pattern(&e) {
                Some(vp) => unsafe { vp.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(false) },
                None => continue,
            };
            if ro {
                continue;
            }
            let score = Self::omnibox_score(&Self::name_of(&e), &Self::class_of(&e));
            if score <= 0 {
                continue;
            }
            if best.as_ref().map(|(b, _)| score > *b).unwrap_or(true) {
                best = Some((score, e));
            }
        }
        best.map(|(_, e)| e)
    }

    /// 找「新建标签」按钮。
    ///
    /// **Opera 的按钮叫「新建标签」，不是「新建标签页」**（少一个"页"字），
    /// 老代码只匹配「新建标签页」/ "new tab"，于是 Opera 上永远找不到按钮 →
    /// 退回"在当前页跳转"或直接失败。这里 name 与 class 双轨匹配。
    fn find_new_tab(&self, root: &IUIAutomationElement) -> Option<IUIAutomationElement> {
        for e in self.find_all(root, UIA_ButtonControlTypeId.0) {
            let name = Self::name_of(&e);
            let class = Self::class_of(&e);
            if new_tab_button_matches(&name, &class) {
                return Some(e);
            }
        }
        None
    }

    fn tab_names(&self, root: &IUIAutomationElement) -> Vec<String> {
        self.find_all(root, UIA_TabItemControlTypeId.0)
            .iter()
            .map(Self::name_of)
            .collect()
    }
}

fn value_pattern(e: &IUIAutomationElement) -> Option<IUIAutomationValuePattern> {
    unsafe {
        e.GetCurrentPattern(UIA_ValuePatternId)
            .ok()
            .and_then(|u| u.cast::<IUIAutomationValuePattern>().ok())
    }
}

/// 「新建标签」按钮的判据（抽成纯函数，便于逐条断言）
fn new_tab_button_matches(name: &str, class: &str) -> bool {
    // class 是 Chromium 内部的稳定标识，跨语言最可靠
    if class == "AddTabButton" {
        return true;
    }
    let n = name.to_lowercase();
    // "新建标签页" 也包含 "新建标签"，一条覆盖两种写法
    name.contains("新建标签")
        || name.contains("新标签页")
        || name.contains("新建选项卡")
        || name.contains("新建标签页")
        || n.contains("new tab")
        || n == "+"
}

/// 这个地址栏显示的是不是"没有用户内容"的页面 —— 决定能不能直接复用当前标签。
///
/// 判据必须宽一点，因为各家冷启动时显示的东西不一样：
///   · Edge / Chrome：新建标签页，地址栏是空的
///   · Opera：`opera://startpage`（我的导航）
///   · 被命令行带过 about:blank 的：`about:blank`
/// 这些页面里没有任何用户正在看的内容，覆盖掉不会有损失；
/// 而像 `https://xxx` 这种就一定要另开标签，绝不能覆盖。
fn is_empty_page(v: &str) -> bool {
    let t = v.trim().to_lowercase();
    if t.is_empty() {
        return true;
    }
    // 所有 about: 页面都没有用户内容
    if t.starts_with("about:") {
        return true;
    }
    // 各家"起始页 / 新建标签页"的内部地址
    const START_PAGES: [&str; 10] = [
        "edge://newtab",
        "chrome://newtab",
        "brave://newtab",
        "opera://startpage",
        "opera://start-page",
        "vivaldi://startpage",
        "chrome://welcome",
        "edge://welcome",
        "qqbrowser://newtab",
        "360se://newtab",
    ];
    START_PAGES.iter().any(|p| t == *p || t.starts_with(&format!("{p}/")))
}

/// 给地址栏填 URL。返回实际用了哪种方式。
///
/// 为什么必须回读：`SetValue` 在有些实现里"返回成功但没写进去"，
/// 有些直接抛 `E_FAIL`（Opera）。只看返回值会误判成成功，然后回车把
/// 用户当前页面刷成一片空白。
fn fill_omnibox(
    uia: &Uia,
    hwnd: HWND,
    root: &IUIAutomationElement,
    url: &str,
) -> Result<FillKind, String> {
    let bar = uia
        .find_omnibox(root)
        .ok_or_else(|| "在浏览器窗口里找不到地址栏（可能是浏览器版本差异，或窗口还没加载完）".to_string())?;

    // ① 首选：ValuePattern 直接设值（Edge / Chrome / Brave / Vivaldi 都支持）
    if let Some(vp) = value_pattern(&bar) {
        let readonly = unsafe { vp.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(false) };
        if !readonly && unsafe { vp.SetValue(&BSTR::from(url)) }.is_ok() {
            std::thread::sleep(std::time::Duration::from_millis(120));
            let got = unsafe { vp.CurrentValue().map(|b| b.to_string()).unwrap_or_default() };
            if got.trim() == url {
                return Ok(FillKind::Value);
            }
        }
    }

    // ② 兜底：把焦点交给地址栏，**先清空再逐字符输入**（Opera 走这条）
    //
    // 为什么必须先清空：冷启动时地址栏里已经写着 about:blank，
    // 直接往里打字会变成 "opera://extensions/about:blank"（真的发生过）。
    // Opera 的 ValuePattern 既不能设值也不能清空，只能用
    // 「End 把光标移到末尾 + 逐次退格」这一套纯按键动作来擦干净。
    //
    // 这些消息只投给这一个窗口的消息队列，不进系统键盘队列，
    // 所以不会打到用户正在用的别的程序里。
    unsafe {
        let _ = bar.SetFocus();
    }
    std::thread::sleep(std::time::Duration::from_millis(180));
    let cur = unsafe {
        value_pattern(&bar)
            .and_then(|vp| vp.CurrentValue().ok())
            .map(|b| b.to_string())
            .unwrap_or_default()
    };
    if !cur.is_empty() {
        // End：把光标移到末尾（UIA 的 SetFocus 不会自动全选，光标可能停在开头）
        post_key(hwnd, VK_END);
        std::thread::sleep(std::time::Duration::from_millis(80));
        // 退格清空。上限 400 个字符，防止异常配置让这里退化成死循环。
        let n = cur.encode_utf16().count().min(400);
        for _ in 0..n {
            post_key(hwnd, VK_BACK);
            std::thread::sleep(std::time::Duration::from_millis(18));
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
    for unit in url.encode_utf16() {
        unsafe {
            let _ = PostMessageW(hwnd, WM_CHAR, WPARAM(unit as usize), LPARAM(0x001C_0001));
        }
        std::thread::sleep(std::time::Duration::from_millis(12));
    }
    std::thread::sleep(std::time::Duration::from_millis(150));

    // 回读核对：内容对不上就不能按回车，否则会把错的地址提交出去
    let got = unsafe {
        value_pattern(&bar)
            .and_then(|vp| vp.CurrentValue().ok())
            .map(|b| b.to_string())
            .unwrap_or_default()
    };
    if !got.trim().eq_ignore_ascii_case(url.trim()) {
        return Err(format!(
            "往 {name} 地址栏输入 {url} 时，读回来的是「{got}」。\n\
             为免提交到错误地址，已中止；请手动在地址栏输入 {url}。",
            name = "浏览器",
            url = url
        ));
    }
    Ok(FillKind::Typed)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FillKind {
    /// ValuePattern 设值成功
    Value,
    /// 退化为逐字符投递
    Typed,
}

/// 投递一次完整的按键（down / char / up），全部走该窗口的消息队列
fn post_key(hwnd: HWND, vk: usize) {
    unsafe {
        let _ = PostMessageW(hwnd, WM_KEYDOWN, WPARAM(vk), LPARAM(0x001C_0001));
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = PostMessageW(hwnd, WM_CHAR, WPARAM(vk), LPARAM(0x001C_0001));
        std::thread::sleep(std::time::Duration::from_millis(20));
        let _ = PostMessageW(hwnd, WM_KEYUP, WPARAM(vk), LPARAM(0xC01C_0001u32 as isize));
    }
}

/// 当前地址栏里显示的文本（读不到就当作空）
fn omnibox_value(uia: &Uia, root: &IUIAutomationElement) -> String {
    let Some(bar) = uia.find_omnibox(root) else {
        return String::new();
    };
    unsafe {
        value_pattern(&bar)
            .and_then(|vp| vp.CurrentValue().ok())
            .map(|b| b.to_string())
            .unwrap_or_default()
    }
}

fn press_enter(hwnd: HWND) {
    unsafe {
        let _ = PostMessageW(hwnd, WM_KEYDOWN, WPARAM(VK_RETURN), LPARAM(0x001C_0001));
        std::thread::sleep(std::time::Duration::from_millis(60));
        let _ = PostMessageW(hwnd, WM_CHAR, WPARAM(VK_RETURN), LPARAM(0x001C_0001));
        std::thread::sleep(std::time::Duration::from_millis(60));
        let _ = PostMessageW(
            hwnd,
            WM_KEYUP,
            WPARAM(VK_RETURN),
            LPARAM(0xC01C_0001u32 as isize),
        );
    }
}

/// 轮询等条件满足（用来替代固定 `sleep`：好了就立刻往下走，别让用户干等）
fn wait_until<T>(mut f: impl FnMut() -> Option<T>, tries: usize, gap_ms: u64) -> Option<T> {
    for _ in 0..tries {
        if let Some(v) = f() {
            return Some(v);
        }
        std::thread::sleep(std::time::Duration::from_millis(gap_ms));
    }
    f()
}

/// 打开扩展管理页（UIA 方案）。`pid` 是浏览器进程 id。
pub fn open_ext_page_via_uia(pid: u32, url: &str, browser_name: &str) -> Result<String, String> {
    let wins = windows_of(pid);
    if wins.is_empty() {
        return Err(format!(
            "没找到 {browser_name} 的窗口（可能最小化到了托盘）。\n\
             可以先手动打开 {browser_name}，再点一次；\n\
             或者直接在地址栏输入 {url}。"
        ));
    }
    // HWND 内部是裸指针，不实现 Send；跨线程只传它的数值形式，进线程后再还原
    let hwnd_raw = wins[0].hwnd.0 as isize;

    let url = url.to_string();
    let url_for_err = url.clone();
    let name = browser_name.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
        let r = run(hwnd, &url, &name);
        let _ = tx.send(r);
    });

    match rx.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(Ok(msg)) => Ok(msg),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!(
            "打开 {browser_name} 扩展页超时。可以手动在地址栏输入 {url_for_err}。"
        )),
    }
}

fn run(hwnd: HWND, url: &str, name: &str) -> Result<String, String> {
    let uia = Uia::new()?;

    // 等地址栏出现（冷启动时窗口可能先出来、UI 后画出来）
    let root = wait_until(
        || {
            let root = uia.root(hwnd).ok()?;
            if uia.find_omnibox(&root).is_some() {
                Some(root)
            } else {
                None
            }
        },
        30,
        100,
    )
    .ok_or_else(|| {
        format!(
            "{name} 的窗口还没准备好（找不到地址栏）。\n\
             请等它加载完再点一次，或直接在地址栏输入 {url}。"
        )
    })?;

    // 决定在哪个标签里跳转。
    //
    // 判据只有一条：**当前标签是不是"没有内容"的页面**（新标签页 / 起始页 / 空白页）。
    //   · 是 → 就地跳转。这一个标签本来就是空的，覆盖它不会有任何损失，
    //          而且用户点一下"扩展页"只得到**一个**标签页。
    //   · 否 → 开一个新标签，绝不动用户正在看的页面。
    //
    // 以前这里按"浏览器是不是我们刚启动的"来分两种模式，但那个前提并不可靠：
    // 浏览器可能在启动时恢复上次的标签（Opera 就经常这样），
    // 于是"刚启动"的窗口里其实坐着用户的真实页面。按页面内容判断才是稳的。
    let cur = omnibox_value(&uia, &root);
    let reuse = is_empty_page(&cur);
    let mut opened_new = false;

    if !reuse {
        let before = uia.tab_names(&root).len();
        let clicked = uia
            .find_new_tab(&root)
            .map(|btn| unsafe {
                btn.GetCurrentPattern(UIA_InvokePatternId)
                    .ok()
                    .and_then(|u| u.cast::<IUIAutomationInvokePattern>().ok())
                    .map(|p| p.Invoke().is_ok())
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if !clicked {
            return Err(format!(
                "找不到 {name} 的「新建标签页」按钮。\n\
                 为了不覆盖你当前正在浏览的页面，已取消；请手动在地址栏输入 {url}。"
            ));
        }
        opened_new = true;

        // 等新标签就绪。判据用"地址栏变空"为主、"标签数增加"为辅：
        // 只数 TabItem 不可靠 —— 浏览器新建标签后，无障碍树要过一会儿才多出一个节点，
        // 曾经因为等不到这个节点而误报"没响应"，还把已经打开的新标签丢在那里。
        let _ = wait_until(
            || {
                if is_empty_page(&omnibox_value(&uia, &root)) {
                    return Some(true);
                }
                if uia.tab_names(&root).len() > before {
                    return Some(true);
                }
                None
            },
            25,
            100,
        );

        // 最后的安全闸：此刻地址栏还是有内容的页面 → 宁可放弃，也不覆盖
        let now_val = omnibox_value(&uia, &root);
        if !is_empty_page(&now_val) {
            return Err(format!(
                "{name} 没能切到一个空白标签页（当前是「{now_val}」）。\n\
                 为避免影响你正在浏览的页面，已取消；请手动在地址栏输入 {url}。"
            ));
        }
    }

    fill_omnibox(&uia, hwnd, &root, url)?;
    press_enter(hwnd);

    // 验证：地址栏提交后标签名会变成「扩展」。读到就算成功，
    // 读不到（浏览器文案差异 / 权限限制）也不谎报失败，给出可操作提示。
    let ok = wait_until(
        || {
            let ts = uia.tab_names(&root);
            if tab_names_have_extensions(&ts) {
                Some(true)
            } else {
                None
            }
        },
        25,
        100,
    )
    .unwrap_or(false);

    Ok(if ok {
        if opened_new {
            format!("已在新标签页打开 {name} 的扩展管理页")
        } else {
            format!("已打开 {name} 的扩展管理页")
        }
    } else {
        format!(
            "已向 {name} 发送跳转请求，但没能确认结果。\n\
             如果页面没变化，请在地址栏输入 {url}。"
        )
    })
}

/// 标签名里有没有「扩展」（各家语言的写法都收一下）
fn tab_names_have_extensions(names: &[String]) -> bool {
    names.iter().any(|t| {
        let l = t.to_lowercase();
        t.contains("扩展") || l.contains("extension") || t.contains("擴充")
    })
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
        assert_eq!(VK_RETURN, 0x0D);
    }

    /// 新建标签按钮的四种真实名字都要认出来。
    ///
    /// Opera 这条是这轮问题的根因：它的按钮叫「新建标签」，
    /// 老代码只匹配「新建标签页」，于是永远点不到。
    #[test]
    fn new_tab_button_names_are_recognised() {
        assert!(new_tab_button_matches("新建标签页", "ToolbarButton"));
        assert!(
            new_tab_button_matches("新建标签", "AddTabButton"),
            "Opera 的按钮名是「新建标签」，必须匹配"
        );
        assert!(new_tab_button_matches("New Tab", "ToolbarButton"));
        assert!(new_tab_button_matches("", "AddTabButton"), "class 命中即可");
        // 不能误伤
        assert!(!new_tab_button_matches("扩展", "ExtensionsToolbarButton"));
        assert!(!new_tab_button_matches("关闭", "ThemedFrameCloseButton"));
        assert!(!new_tab_button_matches("重新载入", "ReloadStopButton"));
    }

    /// 地址栏候选打分：Opera 的真输入框要赢过外壳和搜索框
    #[test]
    fn omnibox_scoring_prefers_real_textfield() {
        let opera_field = Uia::omnibox_score("地址栏", "AddressTextfieldView");
        let opera_shell = Uia::omnibox_score("地址栏", "AddressBarView");
        let opera_search = Uia::omnibox_score("搜索网络", "SearchBox_input__wVi3v");
        let edge_field = Uia::omnibox_score("地址和搜索栏", "OmniboxViewViews");
        assert!(opera_field > opera_shell, "真输入框应优于外壳");
        assert!(opera_field > 0, "Opera 的地址栏必须能被选中");
        assert!(opera_search <= 0, "搜索框不能被当成地址栏：{opera_search}");
        assert!(edge_field > 0, "Edge 的地址栏必须能被选中");
    }

    /// 「能不能复用当前标签」的判据。
    ///
    /// 冷启动时各家的地址栏内容不同（Edge 空、Opera 是 opera://startpage），
    /// 所以判据必须覆盖这些"没有用户内容"的页面；同时**绝不能**把真实网页判成空。
    #[test]
    fn empty_page_detection() {
        assert!(is_empty_page(""));
        assert!(is_empty_page("  "));
        assert!(is_empty_page("about:blank"));
        assert!(is_empty_page("About:Blank"));
        assert!(is_empty_page("opera://startpage"));
        assert!(is_empty_page("edge://newtab"));
        assert!(!is_empty_page("https://www.bilibili.com/"));
        assert!(!is_empty_page("edge://extensions/"));
        assert!(!is_empty_page("opera://extensions/"));
    }

    /// 结果校验：标签名判断要认中英文
    #[test]
    fn extension_tab_detection() {
        assert!(tab_names_have_extensions(&["新建标签页".into(), "扩展".into()]));
        assert!(tab_names_have_extensions(&["Extensions".into()]));
        assert!(!tab_names_have_extensions(&["新建标签页".into()]));
        assert!(!tab_names_have_extensions(&[]));
    }
}
