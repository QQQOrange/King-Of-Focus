//! 自动更新：GitHub Releases 检测 → 下载 → 退出 → 静默安装 → 重新启动

use crate::model::UpdateCfg;
use crate::net;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 更新检测专用超时：连不上就快速失败。
/// 之前用默认的 15s 连接 + 60s 总超时，网络不通时一次检测能卡一分多钟。
const CHK_CONNECT: Duration = Duration::from_secs(6);
const CHK_TOTAL: Duration = Duration::from_secs(12);

pub fn current() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 语义化版本比较，返回 1 / 0 / -1
pub fn cmp_ver(a: &str, b: &str) -> i32 {
    fn parse(s: &str) -> Vec<i64> {
        s.trim()
            .trim_start_matches(['v', 'V'])
            .split(['.', '-', '+'])
            .take(3)
            .map(|x| x.parse::<i64>().unwrap_or(0))
            .collect()
    }
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..3 {
        let x = *pa.get(i).unwrap_or(&0);
        let y = *pb.get(i).unwrap_or(&0);
        if x != y {
            return if x > y { 1 } else { -1 };
        }
    }
    0
}

pub fn update_dir() -> PathBuf {
    let p = crate::cfg::data_dir().join("updates");
    let _ = fs::create_dir_all(&p);
    p
}

fn repo_of(c: &UpdateCfg) -> String {
    let r = c.repo.trim();
    if r.is_empty() {
        "QQQOrange/King-Of-Focus".to_string()
    } else {
        r.to_string()
    }
}

fn bearer(token: &str) -> Option<String> {
    let t = token.trim();
    if t.is_empty() {
        None
    } else {
        Some(format!("Bearer {t}"))
    }
}

/// 查询剩余 API 额度（该接口本身不计费）
pub fn quota(token: &str) -> Result<(i64, i64), String> {
    let v = net::get_json_t(
        "https://api.github.com/rate_limit",
        bearer(token).as_deref(),
        CHK_CONNECT,
        CHK_TOTAL,
    )?;
    let core = v.get("resources").and_then(|r| r.get("core"));
    let remaining = core
        .and_then(|c| c.get("remaining"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    let limit = core
        .and_then(|c| c.get("limit"))
        .and_then(|x| x.as_i64())
        .unwrap_or(0);
    Ok((remaining, limit))
}

pub fn check(cfg: &UpdateCfg) -> Value {
    let repo = repo_of(cfg);
    let (remaining, limit) = quota(&cfg.token).unwrap_or((0, 0));
    let auth = bearer(&cfg.token);
    let rel_url = format!("https://api.github.com/repos/{repo}/releases/latest");

    match net::get_json_t(&rel_url, auth.as_deref(), CHK_CONNECT, CHK_TOTAL) {
        Ok(v) => release_json(&v, cfg, remaining, limit),
        Err(e) => {
            // 仓库只打了 tag、还没发 Release 时，GitHub 的 /releases/latest 会返回 404。
            // 以前这里直接把错误抛给界面，用户看到的就是"检测不了"。
            // 退一步用 /tags 比较版本号，至少能明确回答"有没有新版"。
            if e.contains("404") {
                let tags_url = format!("https://api.github.com/repos/{repo}/tags");
                match net::get_json_t(&tags_url, auth.as_deref(), CHK_CONNECT, CHK_TOTAL) {
                    Ok(Value::Array(arr)) => {
                        let best = arr
                            .iter()
                            .filter_map(|t| t.get("name").and_then(|x| x.as_str()))
                            .filter(|n| !n.is_empty())
                            .max_by(|a, b| cmp_ver(a, b).cmp(&0))
                            .unwrap_or("");
                        if best.is_empty() {
                            // 连标签都没有：再退一步，直接读仓库里的 Cargo.toml 版本号。
                            // 这样"检测是否有新版"至少是个真实答案，而不是一句"检测不了"。
                            return match repo_version(&repo, auth.as_deref()) {
                                Some(tag) => {
                                    let newer = cmp_ver(&tag, &current()) > 0;
                                    json!({
                                        "ok": true,
                                        "hasUpdate": newer && tag != cfg.skipped_version,
                                        "latest": tag,
                                        "newer": newer,
                                        "current": current(),
                                        "skipped": cfg.skipped_version,
                                        "notes": "",
                                        "publishedAt": "",
                                        "asset": Value::Null,
                                        "source": "manifest",
                                        "remaining": remaining,
                                        "limit": limit,
                                        "error": "",
                                        "note": "仓库还没有 Release / 标签，这里按仓库源码里的版本号比较；需要安装请到 GitHub 下载或自行编译。",
                                    })
                                }
                                None => json!({
                                    "ok": false,
                                    "hasUpdate": false,
                                    "current": current(),
                                    "remaining": remaining,
                                    "limit": limit,
                                    "error": "仓库里没有 Release、没有标签，也读不到源码里的版本号",
                                }),
                            };
                        }
                        let newer = cmp_ver(best, &current()) > 0;
                        json!({
                            "ok": true,
                            "hasUpdate": newer && best != cfg.skipped_version,
                            "latest": best,
                            "newer": newer,
                            "current": current(),
                            "skipped": cfg.skipped_version,
                            "notes": "",
                            "publishedAt": "",
                            "asset": Value::Null,
                            "source": "tag",
                            "remaining": remaining,
                            "limit": limit,
                            "error": "",
                            "note": "仓库还没有发布 Release 安装包，这里按标签版本比较；需要安装请到 GitHub 手动下载。",
                        })
                    }
                    Ok(_) => json!({
                        "ok": false,
                        "hasUpdate": false,
                        "current": current(),
                        "remaining": remaining,
                        "limit": limit,
                        "error": "GitHub 返回的标签列表格式不对",
                    }),
                    Err(e2) => json!({
                        "ok": false,
                        "hasUpdate": false,
                        "current": current(),
                        "remaining": remaining,
                        "limit": limit,
                        "error": e2,
                    }),
                }
            } else {
                json!({
                    "ok": false,
                    "hasUpdate": false,
                    "current": current(),
                    "remaining": remaining,
                    "limit": limit,
                    "error": e,
                })
            }
        }
    }
}

/// 从仓库源码的 Cargo.toml 里读版本号（Release/标签都没有时的最后兜底）
fn repo_version(repo: &str, auth: Option<&str>) -> Option<String> {
    let mut last = None;
    for branch in ["main", "master"] {
        let url = format!("https://raw.githubusercontent.com/{repo}/{branch}/src-tauri/Cargo.toml");
        if let Ok(text) = net::get_text_t(&url, auth, None, CHK_CONNECT, CHK_TOTAL) {
            for line in text.lines() {
                let l = line.trim();
                if let Some(rest) = l.strip_prefix("version") {
                    if let Some(v) = rest.split('"').nth(1) {
                        let v = v.trim().to_string();
                        if !v.is_empty() {
                            return Some(v);
                        }
                    }
                }
            }
        }
        last = Some(());
    }
    let _ = last;
    None
}

/// 把 GitHub 的 release 响应转成界面用的结构
fn release_json(v: &Value, cfg: &UpdateCfg, remaining: i64, limit: i64) -> Value {
    let tag = v
        .get("tag_name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let notes = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let published = v
        .get("published_at")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    // 优先 Setup 安装包，其次任意 exe，最后 msi
    let assets = v
        .get("assets")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let pick = |pred: &dyn Fn(&str) -> bool| -> Option<(String, String, u64)> {
        assets.iter().find_map(|a| {
            let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
            if !pred(name) {
                return None;
            }
            let u = a.get("browser_download_url").and_then(|x| x.as_str())?;
            let size = a.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
            Some((name.to_string(), u.to_string(), size))
        })
    };
    let lower = |s: &str| s.to_lowercase();
    let found = pick(&|n| lower(n).ends_with(".exe") && lower(n).contains("setup"))
        .or_else(|| pick(&|n| lower(n).ends_with(".exe")))
        .or_else(|| pick(&|n| lower(n).ends_with(".msi")));

    let newer = cmp_ver(&tag, &current()) > 0;
    let asset = match &found {
        Some((n, u, s)) => json!({"name": n, "url": u, "size": s}),
        None => Value::Null,
    };
    json!({
        "ok": true,
        "hasUpdate": newer && tag != cfg.skipped_version,
        "latest": tag,
        "newer": newer,
        "current": current(),
        "skipped": cfg.skipped_version,
        "notes": notes,
        "publishedAt": published,
        "asset": asset,
        "source": "release",
        "remaining": remaining,
        "limit": limit,
        "error": "",
        "note": if found.is_none() { "这个 Release 里没有可自动安装的安装包，请到 GitHub 手动下载。" } else { "" },
    })
}

/// 把远端的资产名净化成**一个纯文件名**。
///
/// 资产名来自 GitHub API / 用户填的地址，不能直接 `dir.join(name)`：
///   · `/` 和 `\` 必须干掉，否则 `../../x.exe` 会写到目标目录外面；
///   · `.` 是允许的（文件名要用），但**全是点**的名字（`.`、`..`）要挡掉，
///     否则 `dir.join("..")` 直接指到父目录，后面 `File::create` 会撞目录；
///   · 清洗完是空串时退回一个固定名字，保证永远能落盘。
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    // 清洗完是空、或者**全是点**（`.` / `..`）时才回退。
    // 不能简单 trim 首尾的点：`../../evil.exe` 会被清成 `.._.._evil.exe`，
    // 那个名字虽然安全（没有分隔符），但它是"真实可用的文件名"，不该被改写。
    if cleaned.is_empty() || cleaned.chars().all(|c| c == '.') {
        "update.bin".to_string()
    } else {
        cleaned
    }
}

/// 下载安装包，过程中通过 update-progress 事件回报进度
pub fn download(app: &AppHandle, url: &str, name: &str, expected: u64) -> Result<String, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("下载地址不合法".into());
    }
    let dir = update_dir();
    let file = dir.join(safe_name(name));
    let _ = fs::remove_file(&file);

    let resp = net::agent()
        .get(url)
        .set("User-Agent", net::UA)
        .call()
        .map_err(net::describe)?;

    let total = resp
        .header("Content-Length")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut f = fs::File::create(&file).map_err(|e| format!("无法写入临时文件：{e}"))?;

    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last = Instant::now();
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("下载中断：{e}"))?;
        if n == 0 {
            break;
        }
        f.write_all(&buf[..n])
            .map_err(|e| format!("写入磁盘失败：{e}"))?;
        done += n as u64;
        if last.elapsed() >= Duration::from_millis(220) {
            last = Instant::now();
            let _ = app.emit(
                "update-progress",
                json!({"done": done, "total": total}),
            );
        }
    }
    let _ = f.flush();
    drop(f);

    if total > 0 && done < total {
        return Err(format!(
            "下载不完整（{} / {} KB），请重试",
            done / 1024,
            total / 1024
        ));
    }
    // 服务器不回 Content-Length（chunked）时 total 是 0，上面那条检查整段被跳过 ——
    // 截断的安装包照样能通过 MZ 校验（PE 头就在开头）。所以再用 Release 资产清单里的
    // 大小核对一次：这是唯一与"服务器怎么说"无关的权威值。
    if expected > 0 && done != expected {
        let _ = fs::remove_file(&file);
        return Err(format!(
            "下载的文件大小不符（{} / {} KB），请重试",
            done / 1024,
            expected / 1024
        ));
    }
    if done < 100 * 1024 {
        let _ = fs::remove_file(&file);
        return Err("下载到的文件太小，可能是错误页面，请稍后重试".into());
    }
    // 校验 PE 头，防止下到 HTML 错误页
    let mut head = [0u8; 2];
    if let Ok(mut fh) = fs::File::open(&file) {
        let _ = fh.read_exact(&mut head);
    }
    if &head != b"MZ" {
        let _ = fs::remove_file(&file);
        return Err("下载的文件不是 Windows 安装包（MZ 头校验失败）".into());
    }
    Ok(file.to_string_lossy().to_string())
}

/// 退出 → 删旧包 → 静默安装 → 启动新版本
pub fn apply(app: &AppHandle, installer: &str) -> Result<(), String> {
    let p = PathBuf::from(installer);
    if !p.exists() {
        return Err("安装包已不存在，请重新下载".into());
    }
    let exe = std::env::current_exe().map_err(|e| format!("找不到自身路径：{e}"))?;
    let dir = update_dir();

    // 收集需要删除的旧安装包（同目录下除本次之外的所有 exe/msi）
    let mut olds: Vec<String> = Vec::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let path = e.path();
            let is_pkg = matches!(
                path.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()).as_deref(),
                Some("exe") | Some("msi") | Some("tmp")
            );
            if is_pkg && path != p {
                olds.push(path.to_string_lossy().to_string());
            }
        }
    }

    let mut script = String::new();
    script.push_str("@echo off\r\n");
    script.push_str("chcp 65001 >nul\r\n");
    script.push_str("timeout /t 3 /nobreak >nul\r\n");
    // 0.1.10 起可执行文件叫 "King Of Focus.exe"；老版本是 king-of-focus.exe。
    // 两个都杀，避免升级时旧进程还活着、新文件被占用。
    script.push_str("taskkill /f /im \"King Of Focus.exe\" >nul 2>&1\r\n");
    script.push_str("taskkill /f /im \"king-of-focus.exe\" >nul 2>&1\r\n");
    for o in &olds {
        script.push_str(&format!("del /f /q \"{o}\" >nul 2>&1\r\n"));
    }
    let silent = if p.extension().and_then(|s| s.to_str()) == Some("msi") {
        format!("start \"\" /wait msiexec /i \"{}\" /qn /norestart\r\n", p.display())
    } else {
        format!("start \"\" /wait \"{}\" /S\r\n", p.display())
    };
    script.push_str(&silent);
    // 安装失败必须能被发现：以前不管 ERRORLEVEL，删包、起旧版本、界面显示"更新完成"，
    // 用户看到版本号没变却没有任何提示。这里写一个 marker，下次启动读出来告诉他。
    let marker = crate::cfg::data_dir().join("update-failed.txt");
    script.push_str("if errorlevel 1 (\r\n");
    script.push_str(&format!("  > \"{}\" echo 1\r\n", marker.display()));
    script.push_str(&format!("  del /f /q \"{}\" >nul 2>&1\r\n", p.display()));
    script.push_str(&format!("  start \"\" \"{}\"\r\n", exe.display()));
    script.push_str(") else (\r\n");
    script.push_str(&format!("  del /f /q \"{}\" >nul 2>&1\r\n", p.display()));
    script.push_str(&format!("  start \"\" \"{}\"\r\n", exe.display()));
    script.push_str(")\r\n");
    script.push_str("del /f /q \"%~f0\" >nul 2>&1\r\n");

    let script_path = dir.join("apply-update.cmd");
    fs::write(&script_path, script).map_err(|e| format!("无法写入安装脚本：{e}"))?;

    Command::new("cmd")
        .args([
            "/C",
            "start",
            "",
            "/min",
            &script_path.to_string_lossy().to_string(),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("启动安装程序失败：{e}"))?;

    // 安装脚本会 taskkill 本进程；守护进程如果还活着会把旧版本又拉起来，
    // 和安装程序打架。先让它走。
    crate::guard::stop_guard();
    app.exit(0);
    Ok(())
}

/// 清理本次会话之外的残留安装包
/// 上次安装是否失败（marker 由安装脚本在 ERRORLEVEL 非 0 时写下）
pub fn take_update_failed() -> bool {
    let p = crate::cfg::data_dir().join("update-failed.txt");
    if p.exists() {
        let _ = fs::remove_file(&p);
        true
    } else {
        false
    }
}

pub fn cleanup() {
    let dir = update_dir();
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if let Ok(meta) = p.metadata() {
                if let Ok(t) = meta.modified() {
                    if let Ok(age) = t.elapsed() {
                        if age.as_secs() > 3 * 24 * 3600 {
                            let _ = fs::remove_file(&p);
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ucfg() -> UpdateCfg {
        UpdateCfg::default()
    }

    /// 版本比较必须按**数字**比，不能按字符串。
    /// `1.0.10` vs `1.0.9` 按字符串比会得出"更旧"，用户会收不到更新。
    #[test]
    fn version_compare_is_numeric() {
        assert_eq!(cmp_ver("1.0.10", "1.0.9"), 1);
        assert_eq!(cmp_ver("1.0.9", "1.0.10"), -1);
        assert_eq!(cmp_ver("v1.2.3", "1.2.3"), 0, "v 前缀不影响结果");
        assert_eq!(cmp_ver("1.2", "1.2.0"), 0, "缺的段按 0 补");
        assert_eq!(cmp_ver("0.1.29", "0.1.28"), 1);
        assert_eq!(cmp_ver("", "0.0.0"), 0, "空串不能 panic");
        assert_eq!(cmp_ver("1.2.3-beta.1", "1.2.3"), 0, "预发布按主版本比");
    }

    /// 资产优先级：Setup 安装包 > 任意 exe > msi
    #[test]
    fn release_prefers_setup_then_exe_then_msi() {
        let v = json!({
            "tag_name": "9.9.9",
            "body": "notes",
            "published_at": "2026-10-30T00:00:00Z",
            "assets": [
                { "name": "readme.txt", "browser_download_url": "https://x/readme.txt", "size": 1 },
                { "name": "app.msi", "browser_download_url": "https://x/app.msi", "size": 2 },
                { "name": "King.Of.Focus-9.9.9.exe", "browser_download_url": "https://x/a.exe", "size": 3 },
                { "name": "KingOfFocus-Setup-9.9.9.exe", "browser_download_url": "https://x/setup.exe", "size": 4 },
            ],
        });
        let out = release_json(&v, &ucfg(), 10, 60);
        assert_eq!(out["latest"], "9.9.9");
        assert_eq!(out["hasUpdate"], true);
        assert_eq!(out["asset"]["name"], "KingOfFocus-Setup-9.9.9.exe", "有 Setup 就选 Setup");
    }

    /// 没有安装包时要给出"手动下载"的说明，而不是给个空链接
    #[test]
    fn release_without_assets_asks_for_manual_download() {
        let v = json!({ "tag_name": "9.9.9", "assets": [] });
        let out = release_json(&v, &ucfg(), 0, 60);
        assert_eq!(out["asset"], serde_json::Value::Null);
        assert!(out["note"].as_str().unwrap_or("").contains("手动下载"));
        assert_eq!(out["hasUpdate"], true, "没有包也仍然提示有新版本");
    }

    /// 已经"跳过"的版本不再提示
    #[test]
    fn skipped_version_is_not_offered() {
        let v = json!({ "tag_name": "9.9.9", "assets": [] });
        let mut c = ucfg();
        c.skipped_version = "9.9.9".into();
        assert_eq!(release_json(&v, &c, 0, 60)["hasUpdate"], false);

        // 换一个更新的版本，跳过标记不应该继续挡住
        c.skipped_version = "9.9.8".into();
        assert_eq!(release_json(&v, &c, 0, 60)["hasUpdate"], true);
    }

    /// 不比当前版本新的，不算更新
    #[test]
    fn older_or_same_tag_has_no_update() {
        let v = json!({ "tag_name": "0.0.1", "assets": [] });
        let out = release_json(&v, &ucfg(), 0, 60);
        assert_eq!(out["newer"], false);
        assert_eq!(out["hasUpdate"], false);
    }

    /// 资产名不能带出目录：路径分隔符要变成下划线，纯点名要挡掉
    #[test]
    fn download_name_cannot_escape_target_dir() {
        assert_eq!(safe_name("../../evil.exe"), ".._.._evil.exe");
        assert_eq!(safe_name("a/b\\c.exe"), "a_b_c.exe");
        assert_eq!(safe_name(".."), "update.bin", "纯点名会指到父目录");
        assert_eq!(safe_name("."), "update.bin");
        assert_eq!(safe_name(""), "update.bin");
        assert_eq!(safe_name("King.Of.Focus-0.1.29.exe"), "King.Of.Focus-0.1.29.exe");
    }
}
