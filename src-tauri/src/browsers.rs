//! 浏览器巡检：识别已安装的浏览器、判定配套插件状态，并在自律时段拦截"插件没开"的浏览器。
//!
//! 为什么不问浏览器、直接读它的配置？
//! Chromium 系浏览器没有对外的"扩展列表"接口，但每个用户配置目录下的
//! `Preferences`（以及 `Secure Preferences`）里有一份 `extensions.settings`，
//! 记录了每个扩展的 `manifest.name`、安装路径和 `state`（1 = 启用，0 = 停用）。
//! 我们按扩展名匹配自己，就能在不注入、不申请任何浏览器权限的前提下判定三种状态。
//!
//! 三种状态的判定口径：
//! - `notInstalled`：所有配置档里都找不到我们的扩展
//! - `enabled`     ：至少一个配置档里 `state == 1` 且没有 `disable_reasons`
//! - `disabled`    ：找到了，但所有命中项都是停用状态（扩展管理页里被关掉）
//! - `unsupported` ：Firefox 这类不吃 Chromium MV3 扩展的浏览器（只看不拦）

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

/// 扩展清单里的名字关键词（小写匹配，命中任意一个即视为我们的扩展）
const EXT_HINTS: [&str; 4] = ["king of focus", "网页拦截", "kingoffocus", "kof-extension"];

/// 点了「安装插件」之后的保护期：这段时间内不因为插件状态不明而关浏览器，
/// 否则用户正开到扩展管理页去装，浏览器就被自己关掉了。
pub static INSTALL_GRACE_UNTIL: AtomicI64 = AtomicI64::new(0);
const INSTALL_GRACE_SECS: i64 = 600;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Family {
    Chromium,
    Firefox,
}

#[derive(Clone, Copy)]
enum Base {
    Local,
    Roaming,
}

struct Def {
    key: &'static str,
    name: &'static str,
    /// 主进程名（小写，不带 .exe）
    exe: &'static str,
    family: Family,
    base: Base,
    /// 用户数据目录（相对 base）
    data: &'static str,
    /// 安装路径候选（依次尝试 %LOCALAPPDATA% / ProgramFiles / ProgramFiles(x86) / %APPDATA%）
    paths: &'static [&'static str],
    /// 扩展管理页
    ext_page: &'static str,
}

/// 支持的浏览器。Chromium 系才可能装我们的 MV3 插件；Firefox 只识别、不拦。
static DEFS: &[Def] = &[
    Def {
        key: "chrome",
        name: "Google Chrome",
        exe: "chrome",
        family: Family::Chromium,
        base: Base::Local,
        data: "Google\\Chrome\\User Data",
        paths: &["Google\\Chrome\\Application\\chrome.exe"],
        ext_page: "chrome://extensions/",
    },
    Def {
        key: "edge",
        name: "Microsoft Edge",
        exe: "msedge",
        family: Family::Chromium,
        base: Base::Local,
        data: "Microsoft\\Edge\\User Data",
        paths: &["Microsoft\\Edge\\Application\\msedge.exe"],
        ext_page: "edge://extensions/",
    },
    Def {
        key: "brave",
        name: "Brave",
        exe: "brave",
        family: Family::Chromium,
        base: Base::Local,
        data: "BraveSoftware\\Brave-Browser\\User Data",
        paths: &["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
        ext_page: "brave://extensions/",
    },
    Def {
        key: "vivaldi",
        name: "Vivaldi",
        exe: "vivaldi",
        family: Family::Chromium,
        base: Base::Local,
        data: "Vivaldi\\User Data",
        paths: &["Vivaldi\\Application\\vivaldi.exe"],
        ext_page: "vivaldi://extensions/",
    },
    Def {
        key: "opera",
        name: "Opera",
        exe: "opera",
        family: Family::Chromium,
        base: Base::Roaming,
        data: "Opera Software\\Opera Stable",
        paths: &["Programs\\Opera\\opera.exe", "Opera\\opera.exe"],
        ext_page: "opera://extensions/",
    },
    Def {
        key: "chromium",
        name: "Chromium",
        exe: "chromium",
        family: Family::Chromium,
        base: Base::Local,
        data: "Chromium\\User Data",
        paths: &["Chromium\\Application\\chrome.exe"],
        ext_page: "chrome://extensions/",
    },
    Def {
        key: "360chrome",
        name: "360 极速浏览器",
        exe: "360chrome",
        family: Family::Chromium,
        base: Base::Local,
        data: "360Chrome\\Chrome\\User Data",
        paths: &["360Chrome\\Chrome\\Application\\360chrome.exe"],
        ext_page: "chrome://extensions/",
    },
    Def {
        key: "qqbrowser",
        name: "QQ 浏览器",
        exe: "qqbrowser",
        family: Family::Chromium,
        base: Base::Local,
        data: "Tencent\\QQBrowser\\User Data",
        paths: &["Tencent\\QQBrowser\\QQBrowser.exe"],
        ext_page: "qqbrowser://extensions/",
    },
    Def {
        key: "sogou",
        name: "搜狗高速浏览器",
        exe: "sogouexplorer",
        family: Family::Chromium,
        base: Base::Roaming,
        data: "SogouExplorer",
        paths: &["SogouExplorer\\SogouExplorer.exe"],
        ext_page: "chrome://extensions/",
    },
    Def {
        key: "firefox",
        name: "Mozilla Firefox",
        exe: "firefox",
        family: Family::Firefox,
        base: Base::Roaming,
        data: "Mozilla\\Firefox",
        paths: &["Mozilla Firefox\\firefox.exe"],
        ext_page: "",
    },
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtHit {
    /// 配置档名（Default / Profile 1 …）
    pub profile: String,
    /// 扩展名（取自 manifest.name 或目录名）
    pub name: String,
    /// 扩展 ID
    pub id: String,
    pub enabled: bool,
    /// 说明：来自解压目录还是商店安装
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub key: String,
    pub name: String,
    pub installed: bool,
    /// 主程序路径（找不到时为空）
    pub exe: String,
    /// notInstalled | enabled | disabled | unsupported
    pub ext: String,
    /// 现在是否有可见窗口（有 = 正在使用）
    pub running: bool,
    pub ext_page: String,
    pub data_dir: String,
    /// 命中的扩展条目（用于界面上"哪个配置档里装了、是开还是关"）
    pub hits: Vec<ExtHit>,
    /// 给人看的补充说明
    pub note: String,
}

impl BrowserInfo {
    fn blank(d: &Def) -> BrowserInfo {
        BrowserInfo {
            key: d.key.to_string(),
            name: d.name.to_string(),
            installed: false,
            exe: String::new(),
            ext: "notInstalled".into(),
            running: false,
            ext_page: d.ext_page.to_string(),
            data_dir: String::new(),
            hits: vec![],
            note: String::new(),
        }
    }
}

/* ---------------- 缓存 ---------------- */

static CACHE: Mutex<Option<(Instant, Vec<BrowserInfo>)>> = Mutex::new(None);

/// 扫描（带缓存）。`force = true` 时忽略缓存重新读盘。
pub fn scan(force: bool) -> Vec<BrowserInfo> {
    let ttl = Duration::from_secs(15);
    if !force {
        if let Ok(g) = CACHE.lock() {
            if let Some((t, v)) = g.as_ref() {
                if t.elapsed() < ttl {
                    return v.clone();
                }
            }
        }
    }
    let list = full_scan();
    if let Ok(mut g) = CACHE.lock() {
        *g = Some((Instant::now(), list.clone()));
    }
    list
}

/// 只读缓存，绝不扫盘（每次界面刷新都会调，不能卡）
pub fn snapshot() -> Vec<BrowserInfo> {
    scan(false)
}

pub fn clear_cache() {
    if let Ok(mut g) = CACHE.lock() {
        *g = None;
    }
}

/* ---------------- 路径与探测 ---------------- */

fn env_path(k: &str) -> Option<PathBuf> {
    std::env::var_os(k).map(PathBuf::from).filter(|p| p.exists())
}

fn roots() -> Vec<PathBuf> {
    [
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "ProgramFiles(x86)",
        "PROGRAMW6432",
        "APPDATA",
    ]
    .iter()
    .filter_map(|k| env_path(k))
    .collect()
}

fn find_exe(d: &Def) -> Option<PathBuf> {
    for root in roots() {
        for rel in d.paths {
            let p = root.join(rel);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn base_dir(d: &Def) -> Option<PathBuf> {
    match d.base {
        Base::Local => env_path("LOCALAPPDATA"),
        Base::Roaming => env_path("APPDATA"),
    }
}

fn user_data(d: &Def) -> Option<PathBuf> {
    base_dir(d).map(|b| b.join(d.data))
}

/* ---------------- 扩展判定 ---------------- */

fn entry_matches(e: &serde_json::Value) -> bool {
    let name = e
        .pointer("/manifest/name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_lowercase();
    if EXT_HINTS.iter().any(|h| name.contains(h)) {
        return true;
    }
    let path = e
        .get("path")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_lowercase();
    path.contains("king of focus")
        || path.contains("kingoffocus")
        || path.contains("kof-extension")
        || path.contains("kof_ext")
}

fn entry_name(e: &serde_json::Value) -> String {
    if let Some(n) = e.pointer("/manifest/name").and_then(|x| x.as_str()) {
        if !n.is_empty() {
            return n.to_string();
        }
    }
    e.get("path")
        .and_then(|x| x.as_str())
        .map(|p| {
            p.rsplit(['\\', '/'])
                .next()
                .unwrap_or(p)
                .to_string()
        })
        .unwrap_or_default()
}

/// 一个浏览器用户目录下的所有配置档
fn profile_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let has_prefs =
        |p: &Path| p.join("Preferences").exists() || p.join("Secure Preferences").exists();
    if has_prefs(root) {
        // Opera / 单配置档的浏览器：Preferences 直接放在根上
        out.push(("默认".to_string(), root.to_path_buf()));
        return out;
    }
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let n = e.file_name().to_string_lossy().to_string();
        let lower = n.to_lowercase();
        if lower == "system profile" || lower == "guest profile" || lower.starts_with("crashpad") {
            continue;
        }
        if has_prefs(&p) {
            out.push((n, p));
        }
    }
    out
}

fn scan_profiles(root: &Path) -> Vec<ExtHit> {
    let mut hits: Vec<ExtHit> = Vec::new();
    for (pname, pdir) in profile_dirs(root) {
        for fname in ["Preferences", "Secure Preferences"] {
            let file = pdir.join(fname);
            let Ok(bytes) = std::fs::read(&file) else {
                continue;
            };
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                // 浏览器正在写这个文件时会读到半截 JSON，跳过即可（下次扫描再读）
                continue;
            };
            let Some(settings) = v
                .pointer("/extensions/settings")
                .and_then(|x| x.as_object())
            else {
                continue;
            };
            for (id, e) in settings {
                if !entry_matches(e) {
                    continue;
                }
                if hits.iter().any(|h| h.profile == pname && h.id == *id) {
                    continue;
                }
                // state: 1 = 启用，0 = 停用；disable_reasons 非空也算停用
                let state = e.get("state").and_then(|x| x.as_u64()).unwrap_or(1);
                let reasons = e
                    .get("disable_reasons")
                    .and_then(|x| x.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                hits.push(ExtHit {
                    profile: pname.clone(),
                    name: entry_name(e),
                    id: id.clone(),
                    enabled: state == 1 && reasons == 0,
                    path: e
                        .get("path")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                });
            }
        }
    }
    hits
}

/// 调试用：直接扫一个"用户数据目录"，返回命中的扩展条目。
/// 生产逻辑不经过它，但可以让自动化测试在临时目录里构造各种状态来验证判定。
pub fn probe_profiles(path: &str) -> Vec<ExtHit> {
    scan_profiles(Path::new(path))
}

fn full_scan() -> Vec<BrowserInfo> {
    let running: Vec<String> = crate::proc::screen_apps()
        .iter()
        .map(|a| a.name.clone())
        .collect();

    let mut out = Vec::with_capacity(DEFS.len());
    for d in DEFS {
        let exe = find_exe(d);
        let data = user_data(d);
        let data_ok = data.as_ref().map(|p| p.is_dir()).unwrap_or(false);
        let installed = exe.is_some() || data_ok;
        let mut info = BrowserInfo::blank(d);
        info.installed = installed;
        info.exe = exe
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        info.data_dir = data
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        info.running = running.iter().any(|n| n == d.exe)
            || (d.key == "chromium" && running.iter().any(|n| n == "chrome"));

        if installed {
            match d.family {
                Family::Firefox => {
                    info.ext = "unsupported".into();
                    info.note = "本插件基于 Chromium MV3，Firefox 无法安装；这类浏览器不参与校验与拦截。"
                        .into();
                }
                Family::Chromium => {
                    let hits = match data.as_ref() {
                        Some(p) if p.is_dir() => scan_profiles(p),
                        _ => Vec::new(),
                    };
                    if hits.is_empty() {
                        info.ext = "notInstalled".into();
                        info.note = if data_ok {
                            "已安装浏览器，但所有配置档里都没有本插件。".into()
                        } else {
                            "浏览器还没启动过（没有用户数据目录），插件状态无法判定；先打开一次浏览器再检测。"
                                .into()
                        };
                    } else if hits.iter().any(|h| h.enabled) {
                        info.ext = "enabled".into();
                        let n = hits.iter().filter(|h| h.enabled).count();
                        info.note = format!("{} 个配置档里已启用。", n);
                    } else {
                        info.ext = "disabled".into();
                        info.note = "插件已安装，但在扩展管理页里被停用了。".into();
                    }
                    info.hits = hits;
                }
            }
        } else {
            info.note = "未检测到安装。".into();
        }
        out.push(info);
    }
    out
}

/// 进程名 → 浏览器定义
pub fn def_by_exe(name: &str) -> Option<&'static Def> {
    DEFS.iter().find(|d| d.exe == name)
}

pub fn info_for_exe(name: &str) -> Option<BrowserInfo> {
    let d = def_by_exe(name)?;
    scan(false).into_iter().find(|b| b.key == d.key)
}

/* ---------------- 安装引导 ---------------- */

/// 扩展目录的定位结果
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtLocation {
    /// 最佳候选路径（即使不存在也会给出"应该在哪"）
    pub path: String,
    /// 这个路径下真的有 manifest.json
    pub exists: bool,
    /// 同目录下的 CRX 安装包（没有则为空）
    pub crx: String,
    /// 程序所在目录，用于降级提示
    pub exe_dir: String,
    /// 这个路径是按哪条规则找到的，便于排查
    pub source: String,
}

/// 定位扩展目录。按"从近到远"的顺序找，命中条件是 **目录里真的有 manifest.json**，
/// 避免只靠目录名撞上一个空文件夹。
///
/// 顺序：
/// 1. 程序同级 `extension\`（绿色版/安装版的正常布局）
/// 2. 上一级 `extension\`
/// 3. 上两级 `extension\`（开发时 exe 在 target\release 下）
/// 4. `%LOCALAPPDATA%\King of Focus\extension`
pub fn ext_location() -> ExtLocation {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default();

    let mut cands: Vec<(PathBuf, String)> = vec![
        (exe_dir.join("extension"), "程序同级 extension".to_string()),
        (
            exe_dir.join("..").join("extension"),
            "上一级 extension".to_string(),
        ),
        (
            exe_dir.join("..").join("..").join("extension"),
            "上两级 extension".to_string(),
        ),
        (
            exe_dir.join("..").join("..").join("..").join("extension"),
            "仓库根目录 extension".to_string(),
        ),
    ];
    if let Some(local) = env_path("LOCALAPPDATA") {
        cands.push((
            local.join("King of Focus").join("extension"),
            "本地数据目录 extension".to_string(),
        ));
    }

    for (p, src) in cands.iter() {
        if p.join("manifest.json").is_file() {
            let crx = find_crx(&exe_dir);
            // 规范化：去掉路径里的 ".."，界面展示和复制出来都干净
            let clean = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
            // canonicalize 在 Windows 上会带 \?\ 前缀，展示和复制时去掉更自然
            let mut disp = clean.to_string_lossy().to_string();
            if let Some(rest) = disp.strip_prefix("\\\\?\\") {
                disp = rest.to_string();
            }
            return ExtLocation {
                path: disp,
                exists: true,
                crx,
                exe_dir: exe_dir.to_string_lossy().to_string(),
                source: src.clone(),
            };
        }
    }

    // 一个都没命中：给出"最可能应该在哪"的路径，让界面能明确告诉用户
    let guess = exe_dir.join("extension");
    ExtLocation {
        path: guess.to_string_lossy().to_string(),
        exists: false,
        crx: find_crx(&exe_dir),
        exe_dir: exe_dir.to_string_lossy().to_string(),
        source: "未找到（按程序同级 extension 推测）".to_string(),
    }
}

fn find_crx(dir: &Path) -> String {
    for name in [
        "KingOfFocus-Extension.crx",
        "king-of-focus-extension.crx",
        "extension.crx",
    ] {
        let p = dir.join(name);
        if p.is_file() {
            return p.to_string_lossy().to_string();
        }
    }
    String::new()
}

/// 兼容旧调用：只拿路径（找不到也返回推测路径）
pub fn ext_dir() -> Option<PathBuf> {
    let loc = ext_location();
    if loc.path.is_empty() {
        None
    } else {
        Some(PathBuf::from(loc.path))
    }
}

/// 打开浏览器的扩展管理页，并给 10 分钟保护期
pub fn open_ext_page(key: &str) -> Result<String, String> {
    let d = DEFS
        .iter()
        .find(|d| d.key == key)
        .ok_or_else(|| format!("不认识的浏览器：{key}"))?;
    if d.ext_page.is_empty() {
        return Err(format!("{} 不支持本插件", d.name));
    }
    let exe = find_exe(d).ok_or_else(|| format!("没有找到 {} 的主程序，可能装在非默认位置", d.name))?;
    INSTALL_GRACE_UNTIL.store(
        chrono::Local::now().timestamp() + INSTALL_GRACE_SECS,
        Ordering::Relaxed,
    );
    let mut cmd = Command::new(&exe);
    cmd.arg("--new-window").arg(d.ext_page);
    cmd.spawn()
        .map_err(|e| format!("启动 {} 失败：{e}", d.name))?;
    Ok(format!("已打开 {} 的扩展管理页", d.name))
}

/// 在资源管理器里打开扩展目录。
///
/// 三种结果都返回"人能读懂的一句话"，界面直接显示：
/// - 目录存在且打开成功
/// - 目录不存在但有 CRX → 打开程序目录，并说明可以直接拖 CRX 安装
/// - 两者都没有 → 明确告知路径应该在哪、怎么修
pub fn open_ext_folder() -> Result<String, String> {
    let loc = ext_location();
    INSTALL_GRACE_UNTIL.store(
        chrono::Local::now().timestamp() + INSTALL_GRACE_SECS,
        Ordering::Relaxed,
    );

    if loc.exists {
        return match Command::new("explorer.exe").arg(&loc.path).spawn() {
            Ok(_) => Ok(format!("已打开扩展目录：{}", loc.path)),
            Err(e) => Err(format!(
                "打不开资源管理器（{e}）。路径是：{}，可以手动粘到资源管理器地址栏。",
                loc.path
            )),
        };
    }

    if !loc.crx.is_empty() {
        return match Command::new("explorer.exe").arg(&loc.exe_dir).spawn() {
            Ok(_) => Ok(format!(
                "没找到 extension 文件夹（绿色版可能只带了 CRX）。已打开程序目录：{}。\
                 可以把 {} 直接拖进浏览器扩展页安装。",
                loc.exe_dir,
                Path::new(&loc.crx)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            )),
            Err(e) => Err(format!(
                "没找到 extension 文件夹，也打不开资源管理器（{e}）。\
                 程序目录：{}，里面有 CRX 安装包，可以手动拖进浏览器扩展页。",
                loc.exe_dir
            )),
        };
    }

    Err(format!(
        "没找到扩展文件夹，也没有找到 CRX 安装包。\n\
         期望位置：{}\n\
         程序目录：{}\n\
         处理办法：重新解压完整的安装包（里面应包含 extension 文件夹），\
         或到 GitHub 下载最新版；也可以直接用 CRX 拖进浏览器扩展页。",
        loc.path, loc.exe_dir
    ))
}

/* ---------------- 自律时段守护 ---------------- */

struct Pending {
    deadline: Instant,
    /// 最后一次尝试关闭的时间（失败重试用）
    last_try: Instant,
    /// 已经提示过几次（提示只发一次）
    notified: bool,
}

pub struct GuardState {
    pending: HashMap<u32, Pending>,
    /// 每个浏览器上一次记录事件的时间，避免反复写日志
    logged: HashMap<String, Instant>,
}

impl GuardState {
    pub fn new() -> GuardState {
        GuardState {
            pending: HashMap::new(),
            logged: HashMap::new(),
        }
    }
}

fn hb_matches(hb: &str, d: &Def) -> bool {
    let hb = hb.to_lowercase();
    match d.key {
        "chrome" | "chromium" | "brave" | "vivaldi" | "opera" | "360chrome" | "qqbrowser"
        | "sogou" => hb.contains("chrome") || hb.contains("chrom"),
        "edge" => hb.contains("edge"),
        _ => false,
    }
}

/// 自律时段里的浏览器检查。由 monitor 每轮调用一次。
///
/// 判定优先级：
/// 1. 插件状态 = enabled → 放行
/// 2. Firefox（unsupported）→ 放行（它本来就装不了本插件）
/// 3. 其它情况：先弹一张提示卡，宽限 `grace_ms` 后关闭，关闭结果写进拦截记录
pub fn guard_step(
    app: &tauri::AppHandle,
    shared: &crate::shared::Shared,
    cfg: &crate::model::Config,
    apps: &[crate::proc::WinApp],
    st: &mut GuardState,
) {
    let g = &cfg.settings.browser_guard;
    if !g.enabled {
        st.pending.clear();
        return;
    }
    // 用户刚点了「安装插件」→ 给他时间装，别把浏览器关了
    let now_ts = chrono::Local::now().timestamp();
    if now_ts < INSTALL_GRACE_UNTIL.load(Ordering::Relaxed) {
        st.pending.clear();
        return;
    }

    let list = scan(false);
    let (hb_ts, hb_browser) = match shared.rt.lock() {
        Ok(rt) => (rt.hb_ts, rt.hb_browser.clone()),
        Err(_) => (0, String::new()),
    };
    let hb_alive = hb_ts > 0 && now_ts - hb_ts <= cfg.settings.grace_secs.max(30) as i64;

    // 同一时刻只跑着一个浏览器时，心跳可以当作"插件在工作"的证据
    // （扩展刚装好、Preferences 还没落盘的那几十秒，靠这条避免误杀）
    let mut browser_pids: Vec<u32> = apps
        .iter()
        .filter(|a| a.pid != std::process::id() && def_by_exe(&a.name).is_some())
        .map(|a| a.pid)
        .collect();
    browser_pids.dedup();
    let single = browser_pids.len() == 1;

    let grace = Duration::from_millis(g.grace_ms.clamp(300, 3500) as u64);
    let mut seen: Vec<u32> = Vec::new();

    for a in apps {
        if a.pid == std::process::id() {
            continue;
        }
        let Some(def) = def_by_exe(&a.name) else {
            continue;
        };
        seen.push(a.pid);

        let info = list.iter().find(|b| b.key == def.key);
        let status = info.map(|i| i.ext.as_str()).unwrap_or("notInstalled");

        // 1) 插件正常 / 该浏览器不支持插件 → 放行
        if status == "enabled" || status == "unsupported" {
            st.pending.remove(&a.pid);
            continue;
        }
        // 2) 心跳兜底：只有唯一一个浏览器在跑时才认
        if hb_alive && single && hb_matches(&hb_browser, def) {
            st.pending.remove(&a.pid);
            continue;
        }

        let why = if status == "disabled" {
            "插件被停用"
        } else {
            "插件未安装"
        };
        let target = format!("{} — {}", def.name, a.title);

        let entry = st.pending.entry(a.pid).or_insert_with(|| {
            // 第一次看到这个浏览器：先弹提示，让用户知道接下来会发生什么
            if g.notify {
                let body = format!(
                    "<b>{}</b><br>自律时段里，{}。{} 秒后会自动关闭这个浏览器。",
                    html(def.name),
                    why,
                    (g.grace_ms as f64 / 1000.0).max(1.0).round() as i64
                );
                crate::notify::toast(app, "app", "浏览器插件未启用", &body, "浏览器巡检", 3);
            }
            Pending {
                deadline: Instant::now() + grace,
                last_try: Instant::now(),
                notified: true,
            }
        });
        let _ = entry.notified;

        let due = Instant::now() >= entry.deadline;

        // 演练模式：只记录，不真的关
        if cfg.settings.dry_run {
            if st
                .logged
                .get(def.key)
                .map(|t| t.elapsed() > Duration::from_secs(30))
                .unwrap_or(true)
            {
                st.logged.insert(def.key.to_string(), Instant::now());
                shared.log(
                    "browser",
                    target.clone(),
                    "浏览器插件".into(),
                    format!("演练模式：检测到{why}，本应关闭浏览器（未真的关闭）"),
                );
            }
            st.pending.remove(&a.pid);
            continue;
        }

        if !due {
            continue;
        }

        // 到点：先温和关闭，0.4 秒不退再强杀
        let mut closed = false;
        if cfg.settings.soft_close {
            if crate::proc::soft_close(a.hwnd) {
                let until = Instant::now() + Duration::from_millis(400);
                while Instant::now() < until {
                    if !crate::proc::is_alive(a.pid) {
                        closed = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(40));
                }
            }
        }
        if !closed && crate::proc::is_alive(a.pid) {
            closed = crate::proc::terminate(a.pid);
        }

        if closed {
            shared.log(
                "browser",
                target,
                "浏览器插件".into(),
                format!("自律时段：{why}，已自动关闭（宽限 {}ms）", g.grace_ms),
            );
            st.logged.insert(def.key.to_string(), Instant::now());
            st.pending.remove(&a.pid);
        } else {
            // 关不掉（多为权限不足：浏览器以管理员运行，而本程序不是）
            if st
                .logged
                .get(&format!("fail:{}", def.key))
                .map(|t| t.elapsed() > Duration::from_secs(60))
                .unwrap_or(true)
            {
                st.logged
                    .insert(format!("fail:{}", def.key), Instant::now());
                shared.log(
                    "browser",
                    format!("{} — {}", def.name, a.title),
                    "浏览器插件".into(),
                    format!("自律时段：{why}，关闭失败（权限不足，建议以管理员身份运行本程序）"),
                );
                if g.notify {
                    crate::notify::toast(
                        app,
                        "app",
                        "无法关闭浏览器",
                        "权限不足：这个浏览器可能是以管理员身份运行的。<br>用管理员身份重启 King of Focus 后即可拦住。",
                        "浏览器巡检",
                        4,
                    );
                }
            }
            // 5 秒后再试
            if let Some(p) = st.pending.get_mut(&a.pid) {
                p.deadline = Instant::now() + Duration::from_secs(5);
                p.last_try = Instant::now();
            }
        }
    }

    // 已经退出的进程不必再等
    st.pending.retain(|pid, _| seen.contains(pid));
    st.logged.retain(|_, t| t.elapsed() < Duration::from_secs(600));
}

fn html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
