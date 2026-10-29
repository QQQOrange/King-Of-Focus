//! 进入自律时间时自动打开应用 / 网页。
//!
//! 三件事要分清楚：
//!
//! 1. **什么时候触发**：不是"开机"，而是「每一个专注段的开始」。
//!    一个长自律时段里会有多个专注段 + 休息段（番茄），每次休息结束回到专注，
//!    都要重新对齐一次；软件启动时恰好落在专注段里，也要立刻对齐一次
//!    （用户说的"电脑一打开就在自律时段内，那就自动打开"）。
//! 2. **怎么不重复**：按「规则 id + 专注段起点」记账，同一段只跑一次。
//!    段内的每一秒 key 都一样，所以不会每秒开一遍。
//! 3. **已打开怎么办**：先找窗口，找到就切到前台（而不是再起一个进程）；
//!    找不到才启动。窗口形式与排列顺序随后统一施加。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use chrono::{NaiveDateTime, TimeZone, Timelike};

use crate::model::{Config, LaunchItem};
use crate::shared::Shared;

/// 上一次执行过的是哪一段（规则 id → 专注段标识）
fn last_map() -> &'static Mutex<HashMap<String, i64>> {
    static M: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 当前专注段的稳定标识。
///
/// 用"自周一 0 点起的分钟数"而不是时间戳：同一段内每秒都一样，
/// 跨天 / 跨周也不会撞号，重启进程后仍是同一个值。
///
/// 连续专注（不休息）时往回回溯到这一整段的起点——否则每小时都会
/// 被当成"新的专注段"，整天每隔 60 分钟抢一次前台，很烦人。
fn focus_key(cfg: &Config, now: &NaiveDateTime) -> Option<i64> {
    let st = crate::clock::state_at(cfg, *now)?;
    if !st.focusing() {
        return None; // 休息段 / 不在时段里：不触发
    }
    let (work, brk, from, _to) = crate::clock::plan_at(cfg, st.weekday, st.hour)?;
    let minute_in_hour = now.minute() as i64;
    let cycle = if brk == 0 || work == 0 || work >= 60 { 0 } else { (work + brk) as i64 };

    let start_min = if cycle > 0 {
        // 番茄：这一小时的窗口起点 + 第几轮 × 周期
        let idx = ((minute_in_hour - from as i64) / cycle).max(0);
        st.hour as i64 * 60 + from as i64 + idx * cycle
    } else {
        // 连续专注：往前回溯到同一天里连续选中的第一个小时
        let mut h = st.hour as i64;
        while h > 0 && crate::clock::plan_at(cfg, st.weekday, (h - 1) as u32).is_some() {
            h -= 1;
        }
        let f = crate::clock::plan_at(cfg, st.weekday, h as u32)
            .map(|x| x.2 as i64)
            .unwrap_or(0);
        h * 60 + f
    };
    Some(st.weekday as i64 * 1440 + start_min)
}

/* ── Win32 ───────────────────────────────────────────────────── */

type Hwnd = isize;

#[repr(C)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[link(name = "user32")]
extern "system" {
    fn EnumWindows(cb: extern "system" fn(Hwnd, isize) -> i32, l: isize) -> i32;
    fn GetWindowThreadProcessId(h: Hwnd, pid: *mut u32) -> u32;
    fn IsWindowVisible(h: Hwnd) -> i32;
    fn GetWindowTextW(h: Hwnd, buf: *mut u16, n: i32) -> i32;
    fn ShowWindow(h: Hwnd, cmd: i32) -> i32;
    fn SetForegroundWindow(h: Hwnd) -> i32;
    fn BringWindowToTop(h: Hwnd) -> i32;
    fn SetWindowPos(h: Hwnd, after: Hwnd, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn SystemParametersInfoW(act: u32, p: u32, pv: *mut Rect, winini: u32) -> i32;
    fn GetWindow(h: Hwnd, cmd: u32) -> Hwnd;
    fn GetWindowLongW(h: Hwnd, idx: i32) -> i32;
}

const SW_SHOWNORMAL: i32 = 1;
const SW_MINIMIZE: i32 = 6;
const SW_RESTORE: i32 = 9;
const SW_MAXIMIZE: i32 = 3;

const SPI_GETWORKAREA: u32 = 0x0030;
const GW_OWNER: u32 = 4;
const GWL_EXSTYLE: i32 = -20;
const WS_EX_TOOLWINDOW: i32 = 0x0000_0080;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_SHOWWINDOW: u32 = 0x0040;

/// 枚举期间收集到的候选窗口（EnumWindows 的回调没有闭包，只能走全局）
fn collected() -> &'static Mutex<Vec<(Hwnd, u32, String)>> {
    static C: OnceLock<Mutex<Vec<(Hwnd, u32, String)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Vec::new()))
}

extern "system" fn enum_cb(h: Hwnd, _l: isize) -> i32 {
    unsafe {
        if IsWindowVisible(h) == 0 {
            return 1;
        }
        // 有 owner 的是对话框 / 工具窗；带 TOOLWINDOW 的是托盘气泡之类。
        // 这两类不能当成"主窗口"去置前，否则会切到一个看不见的小窗上。
        if GetWindow(h, GW_OWNER) != 0 {
            return 1;
        }
        if GetWindowLongW(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW != 0 {
            return 1;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(h, &mut pid);
        if pid == 0 {
            return 1;
        }
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
        let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        if let Ok(mut v) = collected().lock() {
            v.push((h, pid, title));
        }
    }
    1
}

/// 当前所有可见顶层窗口：(句柄, pid, 标题)
fn windows() -> Vec<(Hwnd, u32, String)> {
    if let Ok(mut v) = collected().lock() {
        v.clear();
    }
    unsafe {
        EnumWindows(enum_cb, 0);
    }
    collected().lock().map(|v| v.clone()).unwrap_or_default()
}

fn work_area() -> Option<Rect> {
    let mut r = Rect { left: 0, top: 0, right: 0, bottom: 0 };
    let ok = unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut r, 0) };
    if ok == 0 || r.right <= r.left || r.bottom <= r.top {
        None
    } else {
        Some(r)
    }
}

/* ── 启动 / 定位 ─────────────────────────────────────────────── */

/// 把 "C:/a/b.exe --x \"y z\"" 拆成参数列表（尊重双引号）
fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote = false;
    for c in s.chars() {
        match c {
            '"' => quote = !quote,
            ' ' | '\t' if !quote => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// 路径的最后一段（文件名）
fn base_name(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

/// 找一个 exe 已经开着的窗口：按进程 exe 文件名匹配。
///
/// 为什么不用窗口标题：标题会随文档名变（"未命名 - 记事本"），
/// 而 exe 名是稳定的。这条路能准确回答"它是不是已经开着了"。
fn find_by_exe(exe: &str) -> Option<Hwnd> {
    let want = base_name(exe).to_lowercase();
    if want.is_empty() {
        return None;
    }
    for (h, pid, _t) in windows() {
        let path = crate::proc::exe_path(pid);
        if path.is_empty() {
            continue;
        }
        if base_name(&path).to_lowercase() == want {
            return Some(h);
        }
    }
    None
}

/// 找一个"已经打开着这个网址"的浏览器窗口：按标题里是否包含域名判断。
///
/// 这是**尽力而为**：没有浏览器 API，拿不到标签页的真实 URL，
/// 只能靠标题猜。猜不到就新开一个 —— 这条限制在 README 里写明了。
fn find_url_window(url: &str) -> Option<Hwnd> {
    let host = url
        .split("//")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_lowercase();
    if host.is_empty() {
        return None;
    }
    let key = host.split('.').next().unwrap_or(&host).to_string();
    if key.len() < 2 {
        return None;
    }
    for (h, pid, title) in windows() {
        let path = crate::proc::exe_path(pid);
        let name = base_name(&path).to_lowercase();
        let is_browser = crate::matcher::BROWSERS.iter().any(|b| name.contains(b));
        if !is_browser {
            continue;
        }
        if title.to_lowercase().contains(&key) {
            return Some(h);
        }
    }
    None
}

fn spawn_app(item: &LaunchItem) -> bool {
    let mut cmd = std::process::Command::new(&item.target);
    for a in split_args(&item.args) {
        cmd.arg(a);
    }
    // 工作目录取 exe 所在目录：不少程序按相对路径找自己的资源
    if let Some(dir) = std::path::Path::new(&item.target).parent() {
        if dir.is_dir() {
            cmd.current_dir(dir);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP，避免它跟着我们的控制台一起退出
        cmd.creation_flags(0x0000_0200);
    }
    cmd.spawn().is_ok()
}

fn open_url_with(item: &LaunchItem) -> bool {
    // 指定了浏览器就用它，否则走系统默认
    if !item.browser.trim().is_empty() {
        let mut cmd = std::process::Command::new(item.browser.trim());
        cmd.arg(&item.target);
        if cmd.spawn().is_ok() {
            return true;
        }
    }
    crate::cmds::open_url(item.target.clone()).is_ok()
}

/// 打开（或切到）一项，返回它的窗口句柄
fn ensure_item(item: &LaunchItem) -> Option<Hwnd> {
    let is_url = item.is_url();
    let found = if is_url {
        find_url_window(&item.target)
    } else {
        find_by_exe(&item.target)
    };
    if let Some(h) = found {
        // 已经开着：切到前台就够了，不再起第二个进程
        unsafe {
            ShowWindow(h, SW_RESTORE);
            BringWindowToTop(h);
            SetForegroundWindow(h);
        }
        return Some(h);
    }
    let ok = if is_url { open_url_with(item) } else { spawn_app(item) };
    if !ok {
        return None;
    }
    // 等窗口出现：程序启动到创建主窗口有个过程，最多等 6 秒
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let h = if is_url {
            find_url_window(&item.target)
        } else {
            find_by_exe(&item.target)
        };
        if h.is_some() {
            return h;
        }
    }
    None
}

/// 按数组顺序从左到右平铺，并施加各自的窗口形式。
///
/// 这是 Windows 上最"朴素也最稳"的排列：拿工作区宽度等分，
/// 不猜用户屏幕布局、不依赖虚拟桌面 API。最小化的窗口只设位置不抢焦点。
fn arrange(wins: &[(Hwnd, &'static str)]) {
    let Some(area) = work_area() else { return };
    let n = wins.len() as i32;
    if n == 0 {
        return;
    }
    let total_w = area.right - area.left;
    let total_h = area.bottom - area.top;
    // 最大化只留一个：多个最大化互相覆盖，等于只有最后一个可见
    let max_count = wins.iter().filter(|(_, m)| *m == "max").count();

    for (i, (h, mode)) in wins.iter().enumerate() {
        let h = *h;
        unsafe {
            match *mode {
                "min" => {
                    // 先摆好位置再最小化：还原时位置就是对的
                    let w = total_w / n;
                    SetWindowPos(h, 0, area.left + w * i as i32, area.top, w, total_h,
                        SWP_NOZORDER | SWP_SHOWWINDOW);
                    ShowWindow(h, SW_MINIMIZE);
                }
                "max" if max_count == 1 => {
                    ShowWindow(h, SW_MAXIMIZE);
                    BringWindowToTop(h);
                    SetForegroundWindow(h);
                }
                _ => {
                    // 窗口化（或"多个最大化"里的非最后一个）：等分平铺
                    let w = total_w / n;
                    ShowWindow(h, SW_RESTORE);
                    SetWindowPos(h, 0, area.left + w * i as i32, area.top, w, total_h,
                        SWP_NOZORDER | SWP_SHOWWINDOW);
                }
            }
        }
    }
    // 最后一个非最小化窗口拿焦点，符合"按顺序打开，最后一个在前"的直觉
    if let Some((h, m)) = wins.iter().rev().find(|(_, m)| *m != "min") {
        unsafe {
            BringWindowToTop(*h);
            SetForegroundWindow(*h);
        }
        let _ = m;
    }
}

/// 执行一条规则的清单，返回说明文字（给提示条用）
fn run_items(items: &[LaunchItem]) -> (usize, Vec<String>) {
    let mut ok = 0usize;
    let mut fails = Vec::new();
    let mut wins: Vec<(Hwnd, &'static str)> = Vec::new();

    // 同一批里可能有重复目标（用户手滑加了两遍）：只处理第一次
    let mut seen: Vec<String> = Vec::new();
    for it in items {
        let key = format!("{}|{}", it.kind, it.target);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        match ensure_item(it) {
            Some(h) => {
                ok += 1;
                wins.push((h, it.win_mode()));
            }
            None => fails.push(it.target.clone()),
        }
    }
    arrange(&wins);
    (ok, fails)
}

/// 记一行日志（只留最近 120 行，别把磁盘写满）
fn log(line: &str) {
    use std::io::Write;
    let p = crate::cfg::data_dir().join("autoopen.log");
    let old = std::fs::read_to_string(&p).unwrap_or_default();
    let mut lines: Vec<&str> = old.lines().collect();
    if lines.len() > 120 {
        lines.drain(0..lines.len() - 120);
    }
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(&format!("[{stamp}] {line}\n"));
    if let Ok(mut f) = std::fs::File::create(&p) {
        let _ = f.write_all(out.as_bytes());
    }
}

/// 每次主循环调用一次。
///
/// 返回 Some(说明) 表示这一 tick 真的执行了（调用方可以拿去弹提示）。
pub fn tick(
    shared: &Shared,
    cfg: &Config,
    now: &NaiveDateTime,
    d: &crate::discipline::Discipline,
) -> Option<String> {
    // 测试模式不真开程序：单测和演练都不该在开发机上弹一堆窗口
    if crate::testmode::on() {
        return None;
    }
    let key = focus_key(cfg, now)?;

    let rules = crate::discipline::active_rules(cfg, now, d);
    let mut total_ok = 0usize;
    let mut all_fails: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();

    for r in rules.iter().filter(|r| r.autolaunch.enabled && !r.autolaunch.items.is_empty()) {
        {
            let done = last_map().lock().ok().and_then(|m| m.get(&r.id).copied());
            if done == Some(key) {
                continue; // 这一段已经跑过
            }
        }
        let (ok, fails) = run_items(&r.autolaunch.items);
        if ok > 0 || !fails.is_empty() {
            names.push(r.name.clone());
        }
        total_ok += ok;
        all_fails.extend(fails);
        if let Ok(mut m) = last_map().lock() {
            m.insert(r.id.clone(), key);
        }
    }

    if names.is_empty() {
        return None;
    }
    let note = if all_fails.is_empty() {
        format!("进入自律时间：已打开 {} 项（{}）", total_ok, names.join("、"))
    } else {
        format!(
            "进入自律时间：{} 项已打开，{} 项失败（{}）",
            total_ok,
            all_fails.len(),
            names.join("、")
        )
    };
    if let Ok(mut rt) = shared.rt.lock() {
        rt.launch_note = note.clone();
        rt.launch_at = now.and_local_timezone(chrono::Local).single()
            .map(|x| x.timestamp())
            .unwrap_or(0);
    }
    log(&note);
    Some(note)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 参数拆分尊重双引号
    #[test]
    fn args_respect_quotes() {
        assert_eq!(split_args(""), Vec::<String>::new());
        assert_eq!(split_args("--a --b"), vec!["--a", "--b"]);
        assert_eq!(
            split_args(r#"--name "hello world" -v"#),
            vec!["--name", "hello world", "-v"]
        );
    }

    /// 文件名提取要同时吃 / 和 \
    #[test]
    fn base_name_handles_both_separators() {
        assert_eq!(base_name("C:\\Apps\\WeChat.exe"), "WeChat.exe");
        assert_eq!(base_name("C:/Apps/Code.exe"), "Code.exe");
        assert_eq!(base_name("solo.exe"), "solo.exe");
    }

    /// 专注段标识：同一段内不变，休息段不触发
    #[test]
    fn focus_key_is_stable_within_a_phase() {
        use crate::model::{ClockCfg, HourPlan};
        let mut c = Config::default();
        c.settings.focus_clock = ClockCfg::default();
        c.settings.focus_clock.enabled = true;
        // 周一 09:00–12:00 连续专注（直接改 profiles 里的第一套）
        let p = &mut c.settings.focus_clock.profiles[0];
        for h in 9..12 {
            p.days[0][h] = HourPlan { on: true, work: 60, brk: 0, from: 0, to: 60, seg: "s1".into() };
        }
        let a = chrono::NaiveDate::from_ymd_opt(2026, 10, 26).unwrap()
            .and_hms_opt(9, 5, 0).unwrap();
        let b = chrono::NaiveDate::from_ymd_opt(2026, 10, 26).unwrap()
            .and_hms_opt(11, 55, 0).unwrap();
        assert_eq!(focus_key(&c, &a), focus_key(&c, &b), "同一段内 key 必须一样");
    }
}
