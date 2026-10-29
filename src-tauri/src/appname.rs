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
    ("wechatappex", "微信"),
    ("wxwork", "企业微信"),
    ("qqlive", "腾讯视频"),
    ("iqiyi", "爱奇艺"),
    ("youku", "优酷"),
    ("bilibili", "哔哩哔哩"),
    ("bilibilihelper", "哔哩哔哩"),
    ("douyin", "抖音"),
    ("kuaishou", "快手"),
    ("xiaohongshu", "小红书"),
    ("zhihu", "知乎"),
    ("xmind", "XMind"),
    ("typora", "Typora"),
    ("obsidian", "Obsidian"),
    ("notion", "Notion"),
    ("yuque", "语雀"),
    ("xunlei", "迅雷"),
    ("qiyeweixin", "企业微信"),
    ("alipay", "支付宝"),
    ("taobao", "淘宝"),
    ("jd", "京东"),
    ("pinduoduo", "拼多多"),
    ("meituan", "美团"),
    ("netease", "网易"),
    ("kgmusic", "酷狗音乐"),
    ("kugou", "酷狗音乐"),
    ("baidupinyin", "百度输入法"),
    ("sogouinput", "搜狗输入法"),
    ("qqpinyin", "QQ 输入法"),
    ("iflytek", "讯飞输入法"),
    ("snipaste", "Snipaste"),
    ("everything", "Everything"),
    ("bandizip", "Bandizip"),
    ("7zfm", "7-Zip"),
    ("winrar", "WinRAR"),
    ("idman", "Internet Download Manager"),
    ("clash", "Clash"),
    ("v2rayn", "v2rayN"),
    ("todesk", "ToDesk"),
    ("sunloginclient", "向日葵"),
    ("anydesk", "AnyDesk"),
    ("rustdesk", "RustDesk"),
    ("wemeet", "腾讯会议"),
    ("tencentmeeting", "腾讯会议"),
    ("voov", "腾讯会议"),
    ("dingtalkding", "钉钉"),
    ("gitkraken", "GitKraken"),
    ("sourcetree", "Sourcetree"),
    ("githubdesktop", "GitHub Desktop"),
    ("postman", "Postman"),
    ("apifox", "Apifox"),
    ("navicat", "Navicat"),
    ("dbeaver", "DBeaver"),
    ("androidstudio", "Android Studio"),
    ("unity", "Unity"),
    ("unrealengine", "Unreal Engine"),
    ("blender", "Blender"),
    ("premiere", "Adobe Premiere"),
    ("aftereffects", "Adobe After Effects"),
    ("audition", "Adobe Audition"),
    ("lightroom", "Adobe Lightroom"),
];

/// 进程名带后缀的情况：WeChatAppEx、WeixinHelper、WeChatWebview……
///
/// 只对**明确的一组**做前缀匹配，不用"任意 key 前缀"这种通用规则：
/// 那会把 chromedriver 认成 Chrome、codeblocks 认成 VS Code，比不认更糟。
const KNOWN_PREFIX: &[(&str, &str)] = &[
    ("wechatapp", "微信"),
    ("wechatwebview", "微信"),
    ("weixin", "微信"),
    ("wecom", "企业微信"),
    ("wxwork", "企业微信"),
    ("dingtalk", "钉钉"),
    ("feishu", "飞书"),
    ("wpscloud", "WPS Office"),
    ("qqmusic", "QQ 音乐"),
    ("cloudmusic", "网易云音乐"),
];

fn known_prefix(s: &str) -> Option<&'static str> {
    let low = s.to_lowercase();
    KNOWN_PREFIX
        .iter()
        .find(|(k, _)| low.starts_with(k))
        .map(|(_, v)| *v)
}

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
    // **内置表优先**：它是人工整理过的名字，而版本信息经常是全大写英文
    // （微信的 FileDescription 就是 "WEIXIN"，QQ 是 "QQ"），
    // 直接用会让统计页变成一串大写缩写。有中文名就用中文名。
    let mut name = match known(stem) {
        Some(v) => v.to_string(),
        None => file_description(path)
            .filter(|d| !is_generic(d))
            // 版本信息本身是纯大写英文（WEIXIN / WECHAT）时，也别直接摆上去：
            // 能靠前缀认出是哪个软件就换成中文名，认不出才原样显示。
            .map(|d| known_prefix(&d).map(|x| x.to_string()).unwrap_or(d))
            .unwrap_or_else(|| known(stem).map(|s| s.to_string()).unwrap_or_else(|| stem.to_string())),
    };
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

    /// 内置表必须**优先于**版本信息。
    /// 微信的 FileDescription 是 "WEIXIN"，直接用它统计页就是一串大写缩写。
    #[test]
    fn builtin_name_beats_version_info() {
        assert_eq!(display("", "weixin"), "微信");
        assert_eq!(display("", "WeChat"), "微信");
        assert_eq!(display("", "wechatappex"), "微信");
        assert_eq!(display("", "wxwork"), "企业微信");
        assert_eq!(display("", "qq"), "QQ");
        assert_eq!(display("", "dingtalk"), "钉钉");
    }

    /// 带后缀的进程名靠前缀认出来（WeChatAppEx / WeixinHelper 这类）
    #[test]
    fn prefix_match_handles_child_processes() {
        assert_eq!(known_prefix("WeChatAppEx"), Some("微信"));
        assert_eq!(known_prefix("WeixinHelper"), Some("微信"));
        // 不能误伤：chromedriver 不是 Chrome，codeblocks 不是 VS Code
        assert_eq!(known_prefix("chromedriver"), None);
        assert_eq!(known_prefix("codeblocks"), None);
    }

    /// 中文软件名要覆盖常见的那一批，别让它们退化成文件名
    #[test]
    fn common_chinese_apps_are_named() {
        for (stem, want) in [
            ("bilibili", "哔哩哔哩"),
            ("qqmusic", "QQ 音乐"),
            ("cloudmusic", "网易云音乐"),
            ("wemeet", "腾讯会议"),
            ("todesk", "ToDesk"),
            ("xunlei", "迅雷"),
        ] {
            assert_eq!(known(stem), Some(want), "{stem}");
        }
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
