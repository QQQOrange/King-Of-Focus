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

fn safe_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// 下载安装包，过程中通过 update-progress 事件回报进度
pub fn download(app: &AppHandle, url: &str, name: &str) -> Result<String, String> {
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
    script.push_str("timeout /t 2 /nobreak >nul\r\n");
    script.push_str(&format!("del /f /q \"{}\" >nul 2>&1\r\n", p.display()));
    script.push_str(&format!("start \"\" \"{}\"\r\n", exe.display()));
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
