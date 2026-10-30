//! exe → 友好名称。
//!
//! 统计页以前直接显示**文件名**（`chrome`、`Code`、`msedge`），看起来像在看进程列表。
//! 真正对人有意义的是 Windows 版本信息里的 `FileDescription`（"Google Chrome"、
//! "Visual Studio Code"），资源管理器里显示的也是它。
//!
//! 名字必须**优先取系统里已有的那个**，而不是自己维护一张映射表：
//!
//!   1. **开始菜单 / 任务栏里快捷方式的显示名** —— 这就是用户在系统里看到的名字。
//!      中文 Windows 上装微信，开始菜单里就是「微信.lnk」，目标指向 `Weixin.exe`；
//!      千问是「千问.lnk」→ `qianwen.exe`。这两个 exe 的版本信息里只有英文
//!      （`Weixin` / `Qianwen`），早先照抄就成了大写英文。
//!   2. exe 版本信息的 `FileDescription`（正规软件一般都有，且是本地化过的）
//!   3. 常见软件的内置对照表 —— **只作兜底**：系统里压根没有快捷方式时才用得上
//!   4. 文件名本身
//!
//! 结果按路径缓存：一秒一次采样、同一进程反复查版本信息没必要。
//! 快捷方式表只扫一次（懒加载），之后按 exe 文件名查。

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

/// 系统里的快捷方式：exe 文件名（小写）→ 显示名。
///
/// 扫三个地方，覆盖"用户看见的名字"的全部来源：
///   · 用户开始菜单   %APPDATA%\Microsoft\Windows\Start Menu\Programs
///   · 公共开始菜单   %ProgramData%\Microsoft\Windows\Start Menu\Programs
///   · 任务栏固定区   %APPDATA%\...\Quick Launch\User Pinned\TaskBar
///
/// 为什么能拿到目标 exe：`.lnk` 里存了目标路径的字符串（UTF-16 或 ANSI），
/// 直接扫字节就能取到 `...\Weixin.exe`，不需要 COM。
/// 用 COM（IShellLink）当然更"正规"，但那要手写 vtable，几百行只为读一个名字，
/// 而这里的用法只是"按 exe 反查显示名"，扫字符串足够了——
/// 取不到就往下走版本信息，不会更糟。
fn shortcuts() -> &'static Mutex<HashMap<String, String>> {
    static S: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    S.get_or_init(|| {
        let mut m: HashMap<String, String> = HashMap::new();
        for dir in shortcut_dirs() {
            scan_lnks(&dir, &mut m, 0);
        }
        Mutex::new(m)
    })
}

fn shortcut_dirs() -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<std::path::PathBuf>, p: String| {
        let pb = std::path::PathBuf::from(p);
        if pb.is_dir() {
            out.push(pb);
        }
    };
    if let Ok(appdata) = std::env::var("APPDATA") {
        push(&mut out, format!(r"{appdata}\Microsoft\Windows\Start Menu\Programs"));
        push(
            &mut out,
            format!(r"{appdata}\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"),
        );
    }
    if let Ok(pd) = std::env::var("PROGRAMDATA") {
        push(&mut out, format!(r"{pd}\Microsoft\Windows\Start Menu\Programs"));
    }
    out
}

/// 递归扫 .lnk（限深 4 层：开始菜单不会有更深的业务目录）
fn scan_lnks(dir: &std::path::Path, out: &mut HashMap<String, String>, depth: u8) {
    if depth > 4 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let path = e.path();
        if path.is_dir() {
            scan_lnks(&path, out, depth + 1);
            continue;
        }
        let is_lnk = path
            .extension()
            .map(|x| x.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false);
        if !is_lnk {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|x| x.to_str()) else { continue };
        let name = stem.trim();
        if name.is_empty() {
            continue;
        }
        // 卸载 / 帮助 / 官网 这类快捷方式不是"应用名"，混进来会把
        // 微信显示成"卸载微信"。
        let low = name.to_lowercase();
        if low.contains("卸载")
            || low.contains("uninstall")
            || low.contains("帮助")
            || low.contains("help")
            || low.contains("readme")
            || low.contains("官网")
            || low.contains("website")
        {
            continue;
        }
        let Ok(raw) = std::fs::read(&path) else { continue };
        for target in lnk_targets(&raw) {
            let base = base_of(&target).to_lowercase();
            if base.is_empty() {
                continue;
            }
            // 同一个 exe 可能有多个快捷方式（桌面版 / 快捷方式 / 任务栏）。
            // 优先留**含中文**的那个：这就是"尽量以中文名显示"的落点。
            match out.get(&base) {
                Some(old) if !has_cjk(old) && has_cjk(name) => {
                    out.insert(base, name.to_string());
                }
                Some(_) => {}
                None => {
                    out.insert(base, name.to_string());
                }
            }
        }
    }
}

fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

fn base_of(p: &str) -> &str {
    p.rsplit(['\\', '/']).next().unwrap_or(p)
}

/// 从 .lnk 的字节里抠出目标 exe 路径。
///
/// 两种编码都扫：UTF-16LE（`W\0e\0i\0x\0i\0n\0.\0e\0x\0e\0`）和 ANSI。
/// 只看以 `.exe` 结尾、并且带目录分隔符的片段——
/// 短片段（`qianwen.exe`）是同一路径的尾巴，留着也没用。
fn lnk_targets(raw: &[u8]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    // UTF-16LE：每个 ASCII 字符后面跟一个 0
    let mut i = 0usize;
    while i + 1 < raw.len() {
        if raw[i + 1] != 0 || !(0x20..0x7f).contains(&raw[i]) {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i;
        while j + 1 < raw.len() && raw[j + 1] == 0 && (0x20..0x7f).contains(&raw[j]) {
            j += 2;
        }
        if j - start >= 10 {
            let mut s = String::new();
            let mut k = start;
            while k < j {
                s.push(raw[k] as char);
                k += 2;
            }
            if s.to_lowercase().ends_with(".exe") && (s.contains('\\') || s.contains('/')) {
                out.push(s);
            }
        }
        i = j.max(i + 1);
    }

    // ANSI
    let mut i = 0usize;
    while i < raw.len() {
        if !(0x20..0x7f).contains(&raw[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < raw.len() && (0x20..0x7f).contains(&raw[i]) {
            i += 1;
        }
        if i - start >= 10 {
            let s = String::from_utf8_lossy(&raw[start..i]).to_string();
            if s.to_lowercase().ends_with(".exe") && (s.contains('\\') || s.contains('/')) {
                out.push(s);
            }
        }
    }
    out
}

/// 产品名（版本信息里的 FileDescription，如 "Microsoft Edge"）。
///
/// 媒体管控要靠它把 SMTC 会话归因到进程：很多播放器的会话 AUMID 用的是**产品名**
/// （"MicrosoftEdge"），而进程名是 "msedge.exe"，光比进程名永远对不上。
pub fn product_name(path: &str) -> Option<String> {
    file_description(path)
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

/// 按 exe 文件名查系统快捷方式里的显示名
fn shortcut_name(stem: &str) -> Option<String> {
    let key = format!("{}.exe", stem.to_lowercase());
    let key2 = stem.to_lowercase();
    let m = shortcuts().lock().ok()?;
    m.get(&key)
        .or_else(|| m.get(&key2))
        .filter(|v| !v.trim().is_empty())
        .cloned()
}

/// 对外的入口：`path` 是 exe 全路径，`stem` 是文件名（不含扩展名）
pub fn display(path: &str, stem: &str) -> String {
    // 空路径不能进缓存：否则第一次拿到的结果会被后面所有"没路径"的进程共用
    if path.is_empty() {
        // 只给了文件名也要先查系统快捷方式：有些调用方（插件上报、旧数据）
        // 手里没有全路径，但 exe 名足够反查"用户看见的名字"。
        return shortcut_name(stem)
            .or_else(|| known(stem).map(|s| s.to_string()))
            .unwrap_or_else(|| stem.to_string());
    }
    if let Some(v) = cache().lock().ok().and_then(|c| c.get(path).cloned()) {
        return v;
    }
    // 优先级：**系统里的快捷方式名** > 版本信息 > 内置表 > 文件名。
    //
    // 第一步就是"读系统已有的名字"：微信的 exe 叫 Weixin.exe、版本信息也是英文，
    // 但开始菜单里明明是「微信」——那个名字才是用户在任务栏上看到的。
    let mut name = shortcut_name(stem)
        .or_else(|| file_description(path).filter(|d| !is_generic(d)))
        .map(|d| {
            // 版本信息是纯英文 / 全大写时（WEIXIN、Qianwen）也别直接摆上去：
            // 先试内置表，最后才原样用。
            if has_cjk(&d) {
                d
            } else {
                known(stem)
                    .map(|x| x.to_string())
                    .or_else(|| known_prefix(&d).map(|x| x.to_string()))
                    .unwrap_or(d)
            }
        })
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
mod probe {
    /// 手工验证用：`cargo test -- --ignored --nocapture probe_real_names`
    #[test]
    #[ignore]
    fn probe_real_names() {
        for (path, stem) in [
            ("", "Weixin"),
            (r"C://Users//64381//AppData//Local//Programs//QianwenApp//qianwen.exe", "qianwen"),
            ("", "WeChat"),
            ("", "chrome"),
            ("", "Code"),
        ] {
            println!("{stem:12} -> {}", super::display(path, stem));
        }
        let m = super::shortcuts().lock().unwrap();
        let mut hits: Vec<_> = m.iter().filter(|(k, _)| {
            let k = k.to_lowercase();
            k.contains("weixin") || k.contains("wechat") || k.contains("qianwen")
        }).collect();
        hits.sort();
        println!("--- 快捷方式表命中 ---");
        for (k, v) in hits {
            println!("  {k} -> {v}");
        }
        println!("表大小 {}", m.len());
    }
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
