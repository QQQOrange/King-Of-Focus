use crate::model::Config;
use std::path::PathBuf;
use std::sync::OnceLock;

pub const DATA_FOLDER: &str = "king of focus data";

/// 便携模式：所有数据都放在 exe 同级的 `king of focus data` 里。
/// 只有该目录不可写（比如装在 Program Files）时才退回 %APPDATA%。
fn resolve_data_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(DATA_FOLDER);
            if std::fs::create_dir_all(&p).is_ok() {
                let probe = p.join(".write-test");
                if std::fs::write(&probe, b"kof").is_ok() {
                    let _ = std::fs::remove_file(&probe);
                    return p;
                }
            }
        }
    }
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    let dir = PathBuf::from(base).join("KingOfFocus");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 正式数据目录（测试模式下也不变，用于合并/回滚）
pub fn prod_data_dir() -> PathBuf {
    DATA_DIR.get_or_init(resolve_data_dir).clone()
}

/// 当前生效的数据目录：测试模式下切到 `<生产目录>/test`
pub fn data_dir() -> PathBuf {
    let d = if crate::testmode::on() {
        crate::testmode::test_dir()
    } else {
        prod_data_dir()
    };
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

pub fn load() -> Config {
    let p = config_path();
    match std::fs::read_to_string(&p) {
        Ok(s) => match serde_json::from_str::<Config>(&s) {
            Ok(mut c) => {
                if c.version == 0 {
                    c.version = 1;
                }
                // v2：遮罩改成"跟着当前前台窗口走"，并且紧贴窗口边界（去掉 6px 留白，
                // 同时改用 DWM 可见边框，避免 Win10/11 的隐形拖拽边框造成一圈缝）
                if c.version < 2 {
                    c.version = 2;
                    c.settings.mask.follow = true;
                    c.settings.mask.margin = 0;
                }
                sanitize(&mut c);
                c
            }
            Err(e) => {
                eprintln!("配置解析失败，已备份: {e}");
                let _ = std::fs::copy(&p, data_dir().join("config.broken.json"));
                Config::default()
            }
        },
        Err(_) => {
            let c = Config::default();
            let _ = save(&c);
            c
        }
    }
}

pub fn save(cfg: &Config) -> Result<(), String> {
    let p = config_path();
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&p, s).map_err(|e| format!("写入配置失败: {e}"))
}

/// 兜底修正，避免前端传上来畸形数据把引擎搞坏
pub fn sanitize(c: &mut Config) {
    for l in c.lists.iter_mut() {
        if l.schedule.len() != 7 {
            l.schedule.resize(7, vec![]);
        }
        for day in l.schedule.iter_mut() {
            for s in day.iter_mut() {
                s.start = s.start.min(1439);
                s.end = s.end.min(1440);
            }
            day.sort_by_key(|s| s.start);
        }
        if l.mode != "whitelist" {
            l.mode = "blacklist".into();
        }
        if l.color.is_empty() {
            l.color = "#ff9f43".into();
        }
    }
    c.settings.poll_ms = c.settings.poll_ms.clamp(300, 5000);
    c.settings.grace_secs = c.settings.grace_secs.clamp(20, 600);
    if c.settings.mask.opacity > 100 {
        c.settings.mask.opacity = 100;
    }
    c.settings.mask.margin = c.settings.mask.margin.clamp(0, 200);
}
