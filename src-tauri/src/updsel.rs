//! 更新包选择：**平台标识 + 包类型 + 版本号**三重校验。
//!
//! 为什么要有这个模块：桌面端原来在 Release 里"找一个 .exe"，这在只有桌面版的
//! 时候没问题；一旦同一个 Release 里同时挂着 `.apk`、插件 `.zip`，任何"按扩展名
//! 猜"的做法都可能挑错。反过来，手机端如果也"找 .apk"，哪天桌面端发了个带
//! `apk` 字样的东西也会误判。所以这里不猜，**只认清单里写给自己的那一条**，
//! 并且逐项核对：
//!
//! 1. 清单的 `platforms` 里必须有本平台的键（`windows-x64` / `android` / `chrome-extension`）；
//! 2. 文件名必须是 `King.Of.Focus-<版本>-<平台>.<扩展名>`，**版本和平台都要与清单一致**；
//! 3. 扩展名必须是本平台唯一允许的那几种（桌面 exe/msi、安卓 apk、插件 zip/crx）；
//! 4. 版本必须比当前运行的新；
//! 5. 这个文件必须真的出现在**同一个 Release** 的资产列表里（用名字精确匹配，不做模糊查找）；
//! 6. 下载后大小、sha256 都要与清单一致。
//!
//! 任一条不满足就返回一个带错误码的 [Problem]，界面照原文提示，绝不"降级安装"。
//!
//! 这些规则在三个平台各实现一份（Rust / Kotlin / JS），错误码逐字相同，
//! 文档见 `docs/update-channels.md`。

use serde_json::Value;

/// 清单里的应用标识：防止用户把别的项目的清单地址填进来
pub const APP_ID: &str = "king-of-focus";
/// 清单文件名（作为 Release 资产上传，和安装包在同一个 Release 里）
pub const MANIFEST_NAME: &str = "King.Of.Focus-update.json";
/// 资产名统一前缀
pub const NAME_PREFIX: &str = "King.Of.Focus-";
/// 支持的清单 schema 上限（更高版本可能有本端读不懂的字段）
pub const SCHEMA_MAX: i64 = 1;

/// 本机的平台标识。**这就是"我是谁"的唯一答案**，任何选择都必须拿它比对。
pub fn platform_id() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "windows-x64",
        "aarch64" => "windows-arm64",
        "x86" => "windows-x86",
        _ => "windows-unknown",
    }
}

/// 便于界面显示
pub fn platform_label(id: &str) -> &'static str {
    match id {
        "windows-x64" => "Windows 64 位",
        "windows-arm64" => "Windows ARM64",
        "windows-x86" => "Windows 32 位",
        "android" => "Android",
        "chrome-extension" => "浏览器插件",
        _ => "未知平台",
    }
}

/// 本平台允许的安装包扩展名。清单里出现别的类型一律拒绝。
pub fn allowed_exts(platform: &str) -> &'static [&'static str] {
    match platform {
        "android" => &["apk"],
        "chrome-extension" => &["zip", "crx"],
        _ => &["exe", "msi"],
    }
}

/// 校验失败的原因。`code` 是给程序/文档用的稳定标识，`zh` 是给人看的原话。
#[derive(Debug, Clone, PartialEq)]
pub struct Problem {
    pub code: &'static str,
    pub zh: String,
}

impl Problem {
    fn new(code: &'static str, zh: impl Into<String>) -> Self {
        Problem { code, zh: zh.into() }
    }
}

/// 选中并校验通过的更新包
#[derive(Debug, Clone, PartialEq)]
pub struct Selection {
    pub version: String,
    pub file: String,
    pub size: u64,
    pub sha256: String,
    pub kind: String,
}

/// 从清单里挑出本平台那一条，并跑完 1~5 条校验。
///
/// `assets` 是本 Release 里真实存在的资产名（用来做第 5 条：名字必须真在列表里）。
pub fn select(
    manifest: &Value,
    platform: &str,
    current: &str,
    assets: &[String],
) -> Result<Selection, Problem> {
    let app = manifest.get("app").and_then(|x| x.as_str()).unwrap_or("");
    if app != APP_ID {
        return Err(Problem::new(
            "E_BAD_APP",
            format!("这不是 King Of Focus 的更新清单（app = \"{app}\"）"),
        ));
    }
    let schema = manifest.get("schema").and_then(|x| x.as_i64()).unwrap_or(0);
    if schema < 1 || schema > SCHEMA_MAX {
        return Err(Problem::new(
            "E_BAD_SCHEMA",
            format!("更新清单版本 {schema} 本机读不懂，请手动下载新版"),
        ));
    }

    let entry = manifest
        .get("platforms")
        .and_then(|p| p.get(platform))
        .filter(|v| v.is_object())
        .ok_or_else(|| {
            Problem::new(
                "E_PLATFORM_MISSING",
                format!(
                    "这次发布没有 {}（{platform}）的安装包，本机不会去装别的平台的包",
                    platform_label(platform)
                ),
            )
        })?;

    let version = entry
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !valid_version(&version) {
        return Err(Problem::new(
            "E_BAD_VERSION",
            format!("清单里的版本号不是 x.y.z 形式：\"{version}\" 不能拿来比大小"),
        ));
    }

    let file = entry.get("file").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    if file.is_empty() {
        return Err(Problem::new("E_BAD_MANIFEST", "清单里没有写包名"));
    }

    // ---- 2. 名字里的版本与平台必须和清单一致 ----
    if !name_matches(&file, &version, platform) {
        return Err(Problem::new(
            "E_NAME_MISMATCH",
            format!(
                "包名和清单对不上：{} 应该叫 {}{}-{}.<{}>",
                file,
                NAME_PREFIX,
                version,
                platform,
                allowed_exts(platform).join("/")
            ),
        ));
    }

    // ---- 3. 扩展名必须是本平台允许的类型 ----
    if let Some(bad) = foreign_type(&file, platform) {
        return Err(Problem::new(
            "E_TYPE_MISMATCH",
            format!(
                "这是 {} 的安装包，不能装在 {} 上",
                kind_label(bad),
                platform_label(platform)
            ),
        ));
    }

    // ---- 4. 必须比当前运行的新 ----
    if crate::update::cmp_ver(&version, current) <= 0 {
        return Err(Problem::new(
            "E_NOT_NEWER",
            format!("清单里的 {version} 不比当前的 {current} 新"),
        ));
    }

    let size = entry.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
    if size == 0 {
        return Err(Problem::new("E_BAD_SIZE", "清单里没写文件大小，无法校验下载完整性"));
    }
    let sha256 = entry
        .get("sha256")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(Problem::new("E_BAD_HASH", "清单里的 sha256 不合法，拒绝下载"));
    }

    // ---- 5. 这个文件必须真的在这个 Release 里 ----
    let present = assets.iter().any(|a| a.eq_ignore_ascii_case(&file));
    if !present {
        return Err(Problem::new(
            "E_ASSET_MISSING",
            format!("Release 里找不到 {file}，清单和发布资产不一致"),
        ));
    }

    let kind = entry
        .get("kind")
        .and_then(|x| x.as_str())
        .unwrap_or_else(|| default_kind(platform))
        .to_string();
    Ok(Selection {
        version,
        file,
        size,
        sha256,
        kind,
    })
}

/// 版本号必须是三段纯数字：`1.2` / `1.2.3.4` / `1.2.3-beta` 一律拒绝。
/// 比大小用的是逐段数字比较，形态不统一时很容易比出"永远没有更新"。
pub fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 4 && p.chars().all(|c| c.is_ascii_digit()))
}

/// 名字是否严格等于 `King.Of.Focus-<version>-<platform>.<允许的扩展名>`
pub fn name_matches(file: &str, version: &str, platform: &str) -> bool {
    let lower = file.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix(&NAME_PREFIX.to_ascii_lowercase()) else {
        return false;
    };
    let Some((stem, ext)) = rest.rsplit_once('.') else {
        return false;
    };
    if !allowed_exts(platform).iter().any(|e| *e == ext) {
        return false;
    }
    let want = format!("{}-{}", version.to_ascii_lowercase(), platform);
    stem == want
}

/// 名字里出现"别的平台"的痕迹时，返回那个平台的标识。
///
/// 这一步专门对付最糟的一种错：清单写错了（比如 desktop 那一条写成了 apk 文件），
/// 名字/版本/SHA 全都自洽，只有扩展名不对。上面的扩展名检查会先拦住，
/// 这里再兜一层"文件名里带 android / apk / extension"的情况。
fn foreign_type(file: &str, platform: &str) -> Option<&'static str> {
    let lower = file.to_ascii_lowercase();
    let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    let is_apk = ext == "apk" || lower.contains("-android") || lower.contains("安卓");
    let is_ext = ext == "zip" || ext == "crx" || lower.contains("-extension") || lower.contains("-chrome");
    let is_win = ext == "exe" || ext == "msi";
    if is_apk && platform != "android" {
        return Some("android");
    }
    if is_ext && platform != "chrome-extension" {
        return Some("chrome-extension");
    }
    if is_win && !platform.starts_with("windows") {
        return Some("windows");
    }
    None
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "android" => "Android",
        "chrome-extension" => "浏览器插件",
        "windows" => "Windows",
        _ => "其他平台",
    }
}

fn default_kind(platform: &str) -> &'static str {
    match platform {
        "android" => "apk",
        "chrome-extension" => "extension",
        _ => "installer",
    }
}

/// 老发布没有清单时的兜底：只接受本平台扩展名，且名字里不能有别的平台的痕迹。
///
/// 这条路径**只在清单缺失时**走，并且要在界面上明说"这次发布没带清单"，
/// 不能让它变成绕过校验的后门。
pub fn legacy_pick<'a>(
    assets: impl Iterator<Item = (&'a str, &'a str, u64)>,
    platform: &str,
) -> Option<(String, String, u64)> {
    let exts = allowed_exts(platform);
    assets
        .filter(|(name, _, _)| {
            let lower = name.to_ascii_lowercase();
            let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
            exts.contains(&ext) && foreign_type(name, platform).is_none()
        })
        .map(|(n, u, s)| (n.to_string(), u.to_string(), s))
        .next()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn asset(version: &str, platform: &str, ext: &str) -> String {
        format!("King.Of.Focus-{version}-{platform}.{ext}")
    }

    fn manifest(version: &str, file: &str) -> Value {
        json!({
            "app": "king-of-focus",
            "schema": 1,
            "tag": format!("v{version}"),
            "platforms": {
                "windows-x64": {
                    "version": version, "kind": "installer", "file": file,
                    "size": 12_345, "sha256": "a".repeat(64)
                }
            }
        })
    }

    #[test]
    fn accepts_a_matching_desktop_entry() {
        let f = asset("9.9.9", "windows-x64", "exe");
        let m = manifest("9.9.9", &f);
        let s = select(&m, "windows-x64", "0.1.51", &[f.clone()]).unwrap();
        assert_eq!(s.version, "9.9.9");
        assert_eq!(s.file, f);
        assert_eq!(s.size, 12_345);
    }

    /// 最核心的一条：清单里给的是安卓包（或压根没有桌面条目）时，桌面端必须拒绝，
    /// 而不是"再找找有没有别的 exe"。
    #[test]
    fn desktop_refuses_an_android_entry() {
        let m = json!({
            "app": "king-of-focus", "schema": 1,
            "platforms": { "android": { "version": "9.9.9", "file": "King.Of.Focus-9.9.9-android.apk",
                                        "size": 1, "sha256": "a".repeat(64) } }
        });
        let p = select(&m, "windows-x64", "0.1.51", &[]).unwrap_err();
        assert_eq!(p.code, "E_PLATFORM_MISSING");
        assert!(p.zh.contains("不会去装别的平台的包"), "{}", p.zh);
    }

    /// 清单把 apk 写在桌面那一条里（发布脚本手滑）→ 类型检查必须拦住
    #[test]
    fn desktop_refuses_apk_listed_under_desktop() {
        let m = json!({
            "app": "king-of-focus", "schema": 1,
            "platforms": { "windows-x64": { "version": "9.9.9",
                "file": "King.Of.Focus-9.9.9-windows-x64.apk",
                "size": 1, "sha256": "a".repeat(64) } }
        });
        let p = select(&m, "windows-x64", "0.1.51", &[]).unwrap_err();
        // 名字里的扩展名不在允许集合里，先被 name_matches 拒掉
        assert!(
            p.code == "E_NAME_MISMATCH" || p.code == "E_TYPE_MISMATCH",
            "{}",
            p.code
        );
    }

    /// 名字里的版本和清单版本不一致（常见于发布脚本改版本号漏了包名）
    #[test]
    fn rejects_name_version_mismatch() {
        let m = manifest("9.9.9", "King.Of.Focus-9.9.8-windows-x64.exe");
        let p = select(&m, "windows-x64", "0.1.51", &["King.Of.Focus-9.9.8-windows-x64.exe".into()])
            .unwrap_err();
        assert_eq!(p.code, "E_NAME_MISMATCH");
    }

    /// 名字里的平台标识不对
    #[test]
    fn rejects_name_platform_mismatch() {
        let m = manifest("9.9.9", "King.Of.Focus-9.9.9-android.exe");
        let p = select(&m, "windows-x64", "0.1.51", &["King.Of.Focus-9.9.9-android.exe".into()])
            .unwrap_err();
        assert_eq!(p.code, "E_NAME_MISMATCH");
    }

    /// 清单自洽但 Release 里没有这个文件：不能拿相近的包顶替
    #[test]
    fn rejects_when_asset_absent_from_release() {
        let f = asset("9.9.9", "windows-x64", "exe");
        let m = manifest("9.9.9", &f);
        let p = select(&m, "windows-x64", "0.1.51", &["King.Of.Focus-9.9.9-windows-x64.msi".into()])
            .unwrap_err();
        assert_eq!(p.code, "E_ASSET_MISSING");
    }

    #[test]
    fn refuses_older_or_same_version() {
        let f = asset("0.1.51", "windows-x64", "exe");
        let m = manifest("0.1.51", &f);
        let p = select(&m, "windows-x64", "0.1.51", &[f]).unwrap_err();
        assert_eq!(p.code, "E_NOT_NEWER");
    }

    #[test]
    fn refuses_broken_hashes_and_sizes() {
        let f = asset("9.9.9", "windows-x64", "exe");
        let mut m = manifest("9.9.9", &f);
        m["platforms"]["windows-x64"]["sha256"] = json!("zz");
        assert_eq!(select(&m, "windows-x64", "0.1.51", &[f.clone()]).unwrap_err().code, "E_BAD_HASH");
        m["platforms"]["windows-x64"]["sha256"] = json!("a".repeat(64));
        m["platforms"]["windows-x64"]["size"] = json!(0);
        assert_eq!(select(&m, "windows-x64", "0.1.51", &[f]).unwrap_err().code, "E_BAD_SIZE");
    }

    #[test]
    fn refuses_foreign_manifest() {
        let mut m = manifest("9.9.9", "King.Of.Focus-9.9.9-windows-x64.exe");
        m["app"] = json!("something-else");
        assert_eq!(select(&m, "windows-x64", "0.1.51", &[]).unwrap_err().code, "E_BAD_APP");
        let mut m2 = manifest("9.9.9", "King.Of.Focus-9.9.9-windows-x64.exe");
        m2["schema"] = json!(9);
        assert_eq!(select(&m2, "windows-x64", "0.1.51", &[]).unwrap_err().code, "E_BAD_SCHEMA");
    }

    /// 兜底路径：没有清单时也只认自己的类型，绝不把 apk / zip 当成桌面包
    #[test]
    fn legacy_pick_skips_other_platforms() {
        let assets = vec![
            ("King.Of.Focus-0.1.52-android.apk", "https://x/a.apk", 10u64),
            ("King.Of.Focus-Extension-0.1.52.zip", "https://x/e.zip", 11),
            ("King.Of.Focus-0.1.52.exe", "https://x/a.exe", 12),
        ];
        let got = legacy_pick(assets.iter().map(|(n, u, s)| (*n, *u, *s)), "windows-x64");
        assert_eq!(got.map(|x| x.0).as_deref(), Some("King.Of.Focus-0.1.52.exe"));

        // 只有安卓包时，桌面端宁可"没有可安装的包"，也不能拿 apk 充数
        let only_apk = vec![("King.Of.Focus-0.1.52-android.apk", "https://x/a.apk", 10u64)];
        assert!(legacy_pick(only_apk.iter().map(|(n, u, s)| (*n, *u, *s)), "windows-x64").is_none());
    }

    #[test]
    fn android_only_takes_apk() {
        let assets = vec![
            ("King.Of.Focus-0.1.52.exe", "https://x/a.exe", 12u64),
            ("King.Of.Focus-0.2.1-android.apk", "https://x/a.apk", 10),
        ];
        let got = legacy_pick(assets.iter().map(|(n, u, s)| (*n, *u, *s)), "android");
        assert_eq!(got.map(|x| x.0).as_deref(), Some("King.Of.Focus-0.2.1-android.apk"));
    }

    #[test]
    fn platform_ids_are_stable() {
        // 这台机器上跑测试就是 x64；真正要保证的是"标识不随时间漂移"
        assert!(platform_id().starts_with("windows-"));
        assert_eq!(platform_label("windows-x64"), "Windows 64 位");
        assert_eq!(allowed_exts("android"), &["apk"]);
    }
}
