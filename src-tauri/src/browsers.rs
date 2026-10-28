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
const EXT_HINTS: [&str; 5] = [
    "king of focus",
    "king-of-focus",
    "kingoffocus",
    "kof-extension",
    "网页拦截",
];

/// 目录名关键词：只在**读不到 manifest** 时作为兜底线索
const PATH_HINTS: [&str; 5] = ["king of focus", "king-of-focus", "kingoffocus", "kof-extension", "kof_ext"];

/// 点了「安装插件」之后的保护期：这段时间内不因为插件状态不明而关浏览器，
/// 否则用户正开到扩展管理页去装，浏览器就被自己关掉了。
pub static INSTALL_GRACE_UNTIL: AtomicI64 = AtomicI64::new(0);
const INSTALL_GRACE_SECS: i64 = 600;

/// 扩展心跳镜像（server.rs 收到 /api/heartbeat 时写入）。
/// 插件能发心跳 = 它确实装好了而且在跑，这比等浏览器把 Preferences 落盘快得多，
/// 用它可以把"刚装完还显示未安装"这段空窗期补上。
pub static HB_TS: AtomicI64 = AtomicI64::new(0);
pub static HB_BROWSER: Mutex<String> = Mutex::new(String::new());
const HB_FRESH_SECS: i64 = 120;

pub fn note_heartbeat(browser: &str) {
    HB_TS.store(chrono::Local::now().timestamp(), Ordering::Relaxed);
    if let Ok(mut g) = HB_BROWSER.lock() {
        *g = browser.to_string();
    }
}

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
    /// 是否"加载已解压的扩展程序"装的（location = 4）
    pub unpacked: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub key: String,
    pub name: String,
    pub installed: bool,
    /// 主程序路径（找不到时为空）
    pub exe: String,
    /// 主程序来源：custom（用户手动指定）/ auto（自动检测）/ none（没找到）
    pub exe_source: String,
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
            exe_source: "none".into(),
            ext: "notInstalled".into(),
            running: false,
            ext_page: d.ext_page.to_string(),
            data_dir: String::new(),
            hits: vec![],
            note: String::new(),
        }
    }
}

/// 用户手动指定的浏览器主程序路径（browserKey → exe 绝对路径）。
///
/// 放全局而不是每次往下传：扫描/打开扩展页/界面渲染三处都要用，
/// 走参数会把签名污染得到处都是。保存配置后由 `set_custom_exe` 刷新。
static CUSTOM_EXE: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// 更新自定义路径表并让扫描缓存失效（改完路径要立刻反映到界面）
pub fn set_custom_exe(map: std::collections::HashMap<String, String>) {
    if let Ok(mut g) = CUSTOM_EXE.lock() {
        g.clear();
        g.extend(map.into_iter().filter(|(_, v)| !v.trim().is_empty()));
    }
    if let Ok(mut c) = CACHE.lock() {
        *c = None;
    }
}

fn custom_for(key: &str) -> Option<String> {
    CUSTOM_EXE
        .lock()
        .ok()
        .and_then(|g| g.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()))
        .filter(|s| !s.trim().is_empty())
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

/// 只读缓存，**绝不扫盘**（界面每次刷新都会调，不能卡）。
/// 还没预热过就返回一份"未检测"的占位——宁可显示"检测中"，
/// 也不能让 get_state 在 UI 线程上去枚举窗口 / 读别人的 Preferences。
pub fn snapshot() -> Vec<BrowserInfo> {
    if let Ok(g) = CACHE.lock() {
        if let Some((_, v)) = g.as_ref() {
            return v.clone();
        }
    }
    DEFS.iter().map(BrowserInfo::blank).collect()
}

/// 后台预热线程：启动时立刻扫一次，之后每 10 秒刷新缓存。
/// 这样"界面读状态"和"扫盘"彻底解耦，扫盘再慢也不会顶住界面。
pub fn warm_start() {
    std::thread::spawn(|| loop {
        let _ = scan(true);
        std::thread::sleep(Duration::from_secs(10));
    });
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

/// 校验一个"用户手动指定"的可执行文件路径是否可用。
/// 返回规范化后的路径，失败时给出能直接抄去排查的原因。
pub fn validate_exe(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path.trim().trim_matches('"'));
    if path.trim().is_empty() {
        return Err("路径是空的".into());
    }
    if !p.exists() {
        return Err(format!("这个路径不存在：{}", p.display()));
    }
    if !p.is_file() {
        return Err(format!("这不是一个文件：{}", p.display()));
    }
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ext != "exe" {
        return Err(format!("选中的不是 .exe 程序：{}", p.display()));
    }
    Ok(p)
}

/// 找出某个浏览器的主程序。
///
/// 顺序：**用户手动指定的路径优先**，没有或已失效再走自动检测。
/// 手动路径失效时不要静默忽略——那会让"我明明设过路径"变得莫名其妙，
/// 所以把两条信息都带回给调用方。
pub fn resolve_exe(key: &str, custom: Option<&String>) -> (Option<PathBuf>, Option<String>) {
    let d = match DEFS.iter().find(|d| d.key == key) {
        Some(d) => d,
        None => return (None, None),
    };
    if let Some(raw) = custom {
        if !raw.trim().is_empty() {
            match validate_exe(raw) {
                Ok(p) => return (Some(p), None),
                Err(e) => {
                    // 手动路径坏了 → 继续自动检测，但把原因带出去
                    let auto = find_exe(d);
                    let note = if auto.is_some() {
                        format!("自定义路径无效（{e}），已改用自动检测到的位置")
                    } else {
                        format!("自定义路径无效：{e}")
                    };
                    return (auto, Some(note));
                }
            }
        }
    }
    (find_exe(d), None)
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

/// "加载已解压的扩展程序"装进来的扩展，Chromium 只在 `extensions.settings` 里写
/// `path` / `location` / `state`，**不写 `manifest` 字段**。
/// 实测（Edge 129，location=4）整个条目长这样：
/// `{"location":4,"path":"D:\\software\\myself\\extension","state":1}`
/// 于是只按 `manifest.name` / 路径关键词匹配的老逻辑会把它判成"未安装"——
/// 这正是"明明装了插件，软件还说插件未安装"的根因。
///
/// 修法：`path` 指向的目录里就有真正的 `manifest.json`，直接读它。
fn manifest_name_at(dir: &Path) -> String {
    let f = dir.join("manifest.json");
    // 扩展目录很深、文件很小，读一次几十微秒；外层有 15 秒缓存，不会拖慢界面
    let Ok(bytes) = std::fs::read(&f) else {
        return String::new();
    };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return String::new();
    };
    v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// `path` 可能是绝对路径，也可能是相对配置档目录的相对路径（商店安装就是后者）
fn resolve_ext_path(raw: &str, profile_dir: &Path) -> PathBuf {
    let p = PathBuf::from(raw);
    if p.is_absolute() {
        p
    } else {
        profile_dir.join(raw)
    }
}

fn looks_like_ours(name: &str) -> bool {
    let low = name.to_lowercase();
    EXT_HINTS.iter().any(|h| low.contains(h))
}

/// 判定单个 `extensions.settings` 条目是不是我们的扩展，是就返回展示名。
fn entry_identity(e: &serde_json::Value, profile_dir: &Path) -> Option<String> {
    // 1) 条目里内嵌的 manifest（商店 / crx 安装）
    let inline = e
        .pointer("/manifest/name")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    if looks_like_ours(inline) {
        return Some(inline.to_string());
    }

    // 2) 条目里的 path（解压加载的扩展只能靠这个）
    let raw = e.get("path").and_then(|x| x.as_str()).unwrap_or("");
    if raw.is_empty() {
        return None;
    }
    let dir = resolve_ext_path(raw, profile_dir);
    let on_disk = manifest_name_at(&dir);
    if looks_like_ours(&on_disk) {
        return Some(on_disk);
    }

    // 3) 兜底：路径关键词（扩展已被删掉、只剩残留记录时，仍要能被认出来并提示"已失效"）
    let low = raw.to_lowercase();
    if PATH_HINTS.iter().any(|h| low.contains(h)) {
        return Some(if on_disk.is_empty() {
            entry_name(e)
        } else {
            on_disk
        });
    }
    None
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
            // Chrome 系把扩展状态放 `extensions/settings`；Opera 放 `extensions/opsettings`。
            // 两者结构相同（id → 条目），只是节点名不同，都要读——Opera 只读 settings 会漏检。
            let settings = v
                .pointer("/extensions/settings")
                .and_then(|x| x.as_object());
            let opsettings = v
                .pointer("/extensions/opsettings")
                .and_then(|x| x.as_object());
            let iter = settings
                .into_iter()
                .flat_map(|m| m.iter())
                .chain(opsettings.into_iter().flat_map(|m| m.iter()));
            for (id, e) in iter {
                if hits.iter().any(|h| h.profile == pname && h.id == *id) {
                    continue;
                }
                let Some(name) = entry_identity(e, &pdir) else {
                    continue;
                };
                // state: 1 = 启用，0 = 停用；disable_reasons 非空也算停用。
                // 解压加载的扩展可能压根不写 state —— 没写就是开着（默认 1）。
                let state = e.get("state").and_then(|x| x.as_u64()).unwrap_or(1);
                let reasons = e
                    .get("disable_reasons")
                    .and_then(|x| x.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                // location 4 = LOAD_UNPACKED（开发者模式加载的文件夹）
                let unpacked = e.get("location").and_then(|x| x.as_u64()) == Some(4);
                let raw = e.get("path").and_then(|x| x.as_str()).unwrap_or("");
                hits.push(ExtHit {
                    profile: pname.clone(),
                    name,
                    id: id.clone(),
                    enabled: state == 1 && reasons == 0,
                    path: if unpacked {
                        format!("{}（解压加载）", raw)
                    } else {
                        raw.to_string()
                    },
                    unpacked,
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
    let t0 = std::time::Instant::now();
    let running: Vec<String> = crate::proc::screen_apps()
        .iter()
        .map(|a| a.name.clone())
        .collect();

    let mut out = Vec::with_capacity(DEFS.len());
    for d in DEFS {
        // 自定义路径优先，回退自动检测
        let custom = custom_for(d.key);
        let (exe, exe_note) = resolve_exe(d.key, custom.as_ref());
        let exe_from_custom = custom.is_some() && exe.is_some();
        let data = user_data(d);
        let data_ok = data.as_ref().map(|p| p.is_dir()).unwrap_or(false);
        let installed = exe.is_some() || data_ok;
        let mut info = BrowserInfo::blank(d);
        info.installed = installed;
        info.exe = exe
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        info.exe_source = if exe_from_custom {
            "custom".into()
        } else if exe.is_some() {
            "auto".into()
        } else {
            "none".into()
        };
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
                        let unpacked = hits.iter().any(|h| h.enabled && h.unpacked);
                        info.note = if unpacked {
                            format!("{} 个配置档里已启用（开发者模式加载的文件夹）。", n)
                        } else {
                            format!("{} 个配置档里已启用。", n)
                        };
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
        // 自定义路径有问题（不存在 / 不是 exe）但自动检测救回来了，
        // 要把原因说清楚，否则用户会疑惑"我明明设过路径怎么没生效"
        if let Some(n) = exe_note {
            info.note = if info.note.is_empty() {
                n
            } else {
                format!("{n}。{}", info.note)
            };
        }
        out.push(info);
    }

    // ---- 心跳兜底 ----
    // Preferences 是浏览器"定期落盘"的，刚装完插件的几十秒里文件里可能还没有它。
    // 但只要插件在跑，它就会不停发心跳——这是最硬的证据。
    // 只在"同时只有一个受支持的浏览器在跑"时归因，避免张冠李戴。
    let hb_ts = HB_TS.load(Ordering::Relaxed);
    let hb_live = hb_ts > 0 && chrono::Local::now().timestamp() - hb_ts <= HB_FRESH_SECS;
    if hb_live {
        let hb_name = HB_BROWSER.lock().map(|g| g.clone()).unwrap_or_default();
        let running: Vec<String> = out
            .iter()
            .filter(|b| b.installed && b.running && b.ext != "unsupported")
            .map(|b| b.key.clone())
            .collect();
        if running.len() == 1 {
            let key = running[0].clone();
            if hb_matches(&hb_name, &key) {
                if let Some(b) = out.iter_mut().find(|b| b.key == key) {
                    if b.ext != "enabled" {
                        b.ext = "enabled".into();
                        b.note = "插件正在发心跳，判定为已启用（浏览器可能还没把配置落盘）。".into();
                    }
                }
            }
        }
    }
    // 扫盘超过 200ms 才记一笔，排查"界面是不是被扫盘拖慢"时有用
    if t0.elapsed().as_millis() > 200 {
        crate::mask::mlog(&format!("scan 耗时 {}ms", t0.elapsed().as_millis()));
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
    let custom = custom_for(key);
    let (exe, note) = resolve_exe(key, custom.as_ref());
    let exe = exe.ok_or_else(|| {
        // 这条提示要能直接指导用户下一步：说明为什么失败、去哪设路径、还能怎么手动完成
        let detail = note.clone().map(|n| format!("（{n}）")).unwrap_or_default();
        format!(
            "找不到 {} 的主程序{detail}。\n\
             多半是装在了非默认目录（绿色版 / 便携版 / 自定义安装位置）。\n\
             解决：在「浏览器」列表里点「设置安装路径」，选中 {}.exe 即可。\n\
             也可以手动打开 {}，在地址栏输入 {} 进入扩展页。",
            d.name, d.name.to_lowercase(), d.name, d.ext_page
        )
    })?;
    INSTALL_GRACE_UNTIL.store(
        chrono::Local::now().timestamp() + INSTALL_GRACE_SECS,
        Ordering::Relaxed,
    );
    let mut cmd = Command::new(&exe);
    cmd.arg("--new-window").arg(d.ext_page);
    // 显式断开三个标准句柄：本程序是 GUI 子系统、没有控制台，
    // 子进程继承到无效句柄时，个别启动器（AppX 别名）会卡在初始化上。
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    cmd.spawn().map_err(|e| {
        format!(
            "启动 {} 失败：{e}\n用的是这个路径：{}\n\
             如果它确实不是浏览器主程序，请在「浏览器」列表里重新设置安装路径；\n\
             也可以手动打开 {} 在地址栏输入 {}。",
            d.name,
            exe.display(),
            d.name,
            d.ext_page
        )
    })?;
    Ok(match note {
        Some(n) => format!("已打开 {} 的扩展管理页（{n}）", d.name),
        None => format!("已打开 {} 的扩展管理页", d.name),
    })
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

fn hb_matches(hb: &str, key: &str) -> bool {
    let hb = hb.to_lowercase();
    match key {
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
        if hb_alive && single && hb_matches(&hb_browser, def.key) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 在临时目录里造一份 Chrome 式的 `extensions/settings` 条目。
    fn write_chrome_pref(dir: &Path, id: &str, entry: serde_json::Value) {
        let v = serde_json::json!({ "extensions": { "settings": { id: entry } } });
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("Secure Preferences"), v.to_string()).unwrap();
    }

    /// 在临时目录里造一份 Opera 式的 `extensions/opsettings` 条目。
    fn write_opera_pref(dir: &Path, id: &str, entry: serde_json::Value) {
        let v = serde_json::json!({ "extensions": { "opsettings": { id: entry } } });
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("Secure Preferences"), v.to_string()).unwrap();
    }

    /// 造一个解压加载的我们的扩展：条目里不写 manifest.name、不写 state，
    /// 识别只能靠 path 指向的目录里的 manifest.json —— 与 Opera 实测一致。
    fn unpacked_ours_entry(path: &str) -> serde_json::Value {
        serde_json::json!({
            "location": 4,
            "path": path,
            "active_permissions": { "api": ["alarms", "storage"] },
            "disable_reasons": [],
        })
    }

    /// 在磁盘上落一个 manifest.json（name 是我们的）。
    fn write_manifest(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::json!({ "name": name, "version": "1.0.0", "manifest_version": 3 })
                .to_string(),
        )
        .unwrap();
    }

    /// Chrome 路径仍能识别（回归保护：改动不能把 Chrome 系弄坏）。
    #[test]
    fn scan_reads_chrome_extensions_settings() {
        let tmp = std::env::temp_dir().join(format!("kof_brw_chrome_{}", std::process::id()));
        let ext = tmp.join("ext");
        write_manifest(&ext, "King of Focus 网页拦截");
        let _ = std::fs::remove_file(tmp.join("Secure Preferences"));
        write_chrome_pref(
            &tmp,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            unpacked_ours_entry(&ext.to_string_lossy()),
        );
        let hits = scan_profiles(&tmp);
        assert_eq!(hits.len(), 1, "Chrome settings 条目应被识别：{hits:?}");
        assert!(hits[0].enabled, "解压加载无 state 应视为启用：{hits:?}");
        assert!(hits[0].unpacked);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Opera 把扩展状态放在 `extensions/opsettings`（不是 settings）——
    /// 这正是"Opera 装了却提示未安装"的根因。必须能识别出来。
    #[test]
    fn scan_reads_opera_extensions_opsettings() {
        let tmp = std::env::temp_dir().join(format!("kof_brw_opera_{}", std::process::id()));
        let ext = tmp.join("ext");
        write_manifest(&ext, "King of Focus 网页拦截");
        write_opera_pref(
            &tmp,
            "edpcikhfaamopgineppbimjhjgnbgdhp",
            unpacked_ours_entry(&ext.to_string_lossy()),
        );
        let hits = scan_profiles(&tmp);
        assert_eq!(hits.len(), 1, "Opera opsettings 条目应被识别：{hits:?}");
        assert!(hits[0].enabled, "Opera 解压加载无 state/disabled 应视为启用：{hits:?}");
        assert!(hits[0].unpacked, "location=4 应判为解压加载：{hits:?}");
        assert!(hits[0].name.contains("King of Focus"), "名字来自磁盘 manifest：{hits:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Opera 条目在 settings 与 opsettings 同时存在时不能重复计数（同 id 去重）。
    #[test]
    fn scan_dedups_across_settings_and_opsettings() {
        let tmp = std::env::temp_dir().join(format!("kof_brw_dedup_{}", std::process::id()));
        let ext = tmp.join("ext");
        write_manifest(&ext, "King of Focus 网页拦截");
        let entry = unpacked_ours_entry(&ext.to_string_lossy());
        // 同 id 同时出现在 settings 和 opsettings
        let v = serde_json::json!({
            "extensions": {
                "settings": { "zzzz": entry },
                "opsettings": { "zzzz": entry },
            }
        });
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("Secure Preferences"), v.to_string()).unwrap();
        let hits = scan_profiles(&tmp);
        assert_eq!(hits.len(), 1, "同 id 在两个节点里只能算一个：{hits:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Opera 解压加载条目无 disable_reasons（字段缺失）时不应被误判为停用。
    #[test]
    fn opera_unpacked_without_state_counts_as_enabled() {
        let tmp = std::env::temp_dir().join(format!("kof_brw_state_{}", std::process::id()));
        let ext = tmp.join("ext");
        write_manifest(&ext, "King of Focus 网页拦截");
        // 故意不写 state、不写 disable_reasons（Opera 解压加载实测如此）
        let entry = serde_json::json!({
            "location": 4,
            "path": ext.to_string_lossy(),
            "active_permissions": { "api": ["alarms"] },
        });
        write_opera_pref(&tmp, "opnoState00000000000000000000000", entry);
        let hits = scan_profiles(&tmp);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].enabled, "state/disabled 缺失应视为启用：{hits:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Opera 手动停用时会写 disable_reasons（非空）→ 判为停用。
    #[test]
    fn opera_with_disable_reasons_counts_as_disabled() {
        let tmp = std::env::temp_dir().join(format!("kof_brw_dis_{}", std::process::id()));
        let ext = tmp.join("ext");
        write_manifest(&ext, "King of Focus 网页拦截");
        let entry = serde_json::json!({
            "location": 4,
            "path": ext.to_string_lossy(),
            "active_permissions": { "api": ["alarms"] },
            "disable_reasons": [1],
        });
        write_opera_pref(&tmp, "opDisabled000000000000000000000", entry);
        let hits = scan_profiles(&tmp);
        assert_eq!(hits.len(), 1);
        assert!(!hits[0].enabled, "disable_reasons 非空应判停用：{hits:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
