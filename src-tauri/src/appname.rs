//! exe → 友好名称。
//!
//! 统计页以前直接显示**文件名**（`chrome`、`Code`、`msedge`），看起来像在看进程列表。
//! 真正对人有意义的是 Windows 版本信息里的 `FileDescription`（"Google Chrome"、
//! "Visual Studio Code"），资源管理器里显示的也是它。
//!
//! 三条兜底，按顺序：
//!   1. `FileDescription`（绝大多数正规软件都有）
//!   2. 常见软件的内置对照表（版本信息缺失 / 只是"Microsoft® Windows® Operating System" 时）
//!   3. 文件名本身
//!
//! 结果按路径缓存：一秒一次采样、同一进程反复查版本信息没必要。

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

fn cache() -> &'static Mutex<HashMap<String, String>> {
    static C: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

#[link(name = "version")]
extern "system" {
    fn GetFileVersionInfoSizeW(name: *const u16, handle: *mut u32) -> u32;
    fn GetFileVersionInfoW(name: *const u16, handle: u32, len: u32, data: *mut c_void) -> i32;
    fn VerQueryValueW(
        block: *const c_void,
        sub: *const u16,
        out: *mut *mut c_void,
        len: *mut u32,
    ) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 读 exe 版本信息里的 FileDescription。拿不到就 None（不抛错）。
fn file_description(path: &str) -> Option<String> {
    let w = wide(path);
    unsafe {
        let mut handle: u32 = 0;
        let size = GetFileVersionInfoSizeW(w.as_ptr(), &mut handle);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        if GetFileVersionInfoW(w.as_ptr(), 0, size, buf.as_mut_ptr() as *mut c_void) == 0 {
            return None;
        }
        // 先拿翻译表（语言 + 代码页），再拼出 StringFileInfo 的具体路径。
        // 硬编码 0409（en-US）在中文系统上会取不到，必须查一次。
        let sub = wide("\\VarFileInfo\\Translation");
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut plen: u32 = 0;
        if VerQueryValueW(buf.as_ptr() as *const c_void, sub.as_ptr(), &mut ptr, &mut plen) == 0
            || plen < 4
            || ptr.is_null()
        {
            return None;
        }
        let lang = *(ptr as *const u16);
        let cp = *((ptr as *const u16).add(1));
        let path_sub = wide(&format!(
            "\\StringFileInfo\\{:04x}{:04x}\\FileDescription",
            lang, cp
        ));
        let mut sptr: *mut c_void = std::ptr::null_mut();
        let mut slen: u32 = 0;
        if VerQueryValueW(buf.as_ptr() as *const c_void, path_sub.as_ptr(), &mut sptr, &mut slen) == 0
            || slen == 0
            || sptr.is_null()
        {
            return None;
        }
        let slice = std::slice::from_raw_parts(sptr as *const u16, slen as usize);
        let text = String::from_utf16_lossy(slice)
            .trim_matches(|c: char| c == '\0' || c.is_whitespace())
            .to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

/// 常见软件的内置对照（小写文件名 → 显示名）
const KNOWN: &[(&str, &str)] = &[
    ("msedge", "Microsoft Edge"),
    ("chrome", "Google Chrome"),
    ("firefox", "Firefox"),
    ("brave", "Brave"),
    ("opera", "Opera"),
    ("360se", "360 安全浏览器"),
    ("360chrome", "360 极速浏览器"),
    ("qqbrowser", "QQ 浏览器"),
    ("sogouexplorer", "搜狗浏览器"),
    ("wechat", "微信"),
    ("weixin", "微信"),
    ("qq", "QQ"),
    ("tim", "TIM"),
    ("dingtalk", "钉钉"),
    ("feishu", "飞书"),
    ("lark", "飞书"),
    ("wework", "企业微信"),
    ("wxwork", "企业微信"),
    ("telegram", "Telegram"),
    ("discord", "Discord"),
    ("code", "Visual Studio Code"),
    ("devenv", "Visual Studio"),
    ("idea64", "IntelliJ IDEA"),
    ("pycharm64", "PyCharm"),
    ("goland64", "GoLand"),
    ("webstorm64", "WebStorm"),
    ("clion64", "CLion"),
    ("rider64", "Rider"),
    ("explorer", "文件资源管理器"),
    ("notepad", "记事本"),
    ("notepad++", "Notepad++"),
    ("cmd", "命令提示符"),
    ("powershell", "PowerShell"),
    ("windowsterminal", "Windows 终端"),
    ("wt", "Windows 终端"),
    ("calc", "计算器"),
    ("mspaint", "画图"),
    ("taskmgr", "任务管理器"),
    ("spotify", "Spotify"),
    ("netease cloud music", "网易云音乐"),
    ("cloudmusic", "网易云音乐"),
    ("qqmusic", "QQ 音乐"),
    ("potplayermini64", "PotPlayer"),
    ("vlc", "VLC"),
    ("obs64", "OBS Studio"),
    ("steam", "Steam"),
    ("wegame", "WeGame"),
    ("thunder", "迅雷"),
    ("baidunetdisk", "百度网盘"),
    ("aliyundrive", "阿里云盘"),
    ("winword", "Microsoft Word"),
    ("excel", "Microsoft Excel"),
    ("powerpnt", "Microsoft PowerPoint"),
    ("outlook", "Microsoft Outlook"),
    ("onenote", "OneNote"),
    ("wps", "WPS Office"),
    ("et", "WPS 表格"),
    ("wpp", "WPS 演示"),
    ("acrobat", "Adobe Acrobat"),
    ("acrord32", "Adobe Acrobat Reader"),
    ("photoshop", "Photoshop"),
    ("illustrator", "Illustrator"),
    ("figma", "Figma"),
    ("zoom", "Zoom"),
    ("teams", "Microsoft Teams"),
    ("slack", "Slack"),
];

fn known(stem: &str) -> Option<&'static str> {
    let low = stem.to_lowercase();
    KNOWN.iter().find(|(k, _)| *k == low).map(|(_, v)| *v)
}

/// 版本信息里几乎没信息量的通用描述（系统自带 exe 大量是这句）
fn is_generic(desc: &str) -> bool {
    let d = desc.to_lowercase();
    d.contains("microsoft® windows®")
        || d.contains("microsoft windows")
        || d == "application"
        || d == "windows host process"
}

/// 对外的入口：`path` 是 exe 全路径，`stem` 是文件名（不含扩展名）
pub fn display(path: &str, stem: &str) -> String {
    // 空路径不能进缓存：否则第一次拿到的结果会被后面所有"没路径"的进程共用
    if path.is_empty() {
        return known(stem).map(|s| s.to_string()).unwrap_or_else(|| stem.to_string());
    }
    if let Some(v) = cache().lock().ok().and_then(|c| c.get(path).cloned()) {
        return v;
    }
    let mut name = file_description(path)
        .filter(|d| !is_generic(d))
        .unwrap_or_else(|| known(stem).map(|s| s.to_string()).unwrap_or_else(|| stem.to_string()));
    // 版本信息里偶尔带尾部括号或多余空白，收一下
    name = name.trim().to_string();
    if name.is_empty() {
        name = stem.to_string();
    }
    if let Ok(mut c) = cache().lock() {
        // 缓存别无限长：一天下来正常也不会超过几百个进程
        if c.len() > 512 {
            c.clear();
        }
        c.insert(path.to_string(), name.clone());
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内置表要大小写不敏感（配置里拿到的是 `Chrome` 还是 `chrome` 都可能）
    #[test]
    fn known_is_case_insensitive() {
        assert_eq!(known("Chrome"), Some("Google Chrome"));
        assert_eq!(known("CODE"), Some("Visual Studio Code"));
        assert_eq!(known("nope-not-here"), None);
    }

    /// 系统通用描述要判成"没信息量"，否则资源管理器会显示成
    /// "Microsoft® Windows® Operating System"
    #[test]
    fn generic_description_is_rejected() {
        assert!(is_generic("Microsoft® Windows® Operating System"));
        assert!(is_generic("Microsoft Windows"));
        assert!(!is_generic("Google Chrome"));
    }

    /// 查不到路径时退回文件名，绝不返回空串
    #[test]
    fn falls_back_to_stem() {
        assert_eq!(display("Z:\\not\\exists\\foo.exe", "foo"), "foo");
        assert_eq!(display("Z:\\not\\exists\\chrome.exe", "chrome"), "Google Chrome");
    }
}
