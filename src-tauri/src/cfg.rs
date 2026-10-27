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
    // 自律时段：7 天 × 24 段，且 work + brk 不能超过 1 小时（否则会跟下一段的计划打架）
    let hc = &mut c.settings.focus_clock;
    if hc.days.is_empty() {
        // 旧版"全周共用 24 段"迁移：把旧的 24 段复制到一周七天
        let legacy = if hc.hours.len() == 24 {
            std::mem::take(&mut hc.hours)
        } else {
            vec![crate::model::HourPlan::default(); 24]
        };
        hc.days = (0..7).map(|_| legacy.clone()).collect();
    }
    while hc.days.len() < 7 {
        hc.days.push(vec![crate::model::HourPlan::default(); 24]);
    }
    hc.days.truncate(7);
    for day in hc.days.iter_mut() {
        day.resize(24, crate::model::HourPlan::default());
        for h in day.iter_mut() {
            h.work = h.work.min(60);
            h.brk = h.brk.min(60);
            if h.brk > 0 {
                h.work = h.work.clamp(1, 59);
                if h.work + h.brk > 60 {
                    h.brk = 60 - h.work;
                }
            }
        }
    }
    hc.hours.clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ClockCfg, HourPlan};

    #[test]
    fn clock_migrates_legacy_hours_to_seven_days() {
        let mut c = Config::default();
        let mut hours = vec![HourPlan::default(); 24];
        hours[9] = HourPlan { on: true, work: 45, brk: 15 };
        c.settings.focus_clock = ClockCfg {
            enabled: true,
            apply_rules: true,
            days: Vec::new(),
            hours,
        };
        sanitize(&mut c);
        let hc = &c.settings.focus_clock;
        assert_eq!(hc.days.len(), 7, "旧配置应迁移出 7 天");
        for day in &hc.days {
            assert_eq!(day.len(), 24);
            assert!(day[9].on, "旧选择应复制到每一天");
            assert_eq!((day[9].work, day[9].brk), (45, 15));
        }
        assert!(hc.hours.is_empty(), "迁移后旧字段应清空");
    }

    #[test]
    fn clock_keeps_existing_days_and_clamps() {
        let mut c = Config::default();
        let mut day = vec![HourPlan::default(); 24];
        day[9] = HourPlan { on: true, work: 50, brk: 30 }; // work+brk > 60
        c.settings.focus_clock = ClockCfg {
            enabled: true,
            apply_rules: true,
            days: vec![day],
            hours: Vec::new(),
        };
        sanitize(&mut c);
        let hc = &c.settings.focus_clock;
        assert_eq!(hc.days.len(), 7, "天数不足应补齐");
        let p = &hc.days[0][9];
        assert!(p.on);
        assert_eq!((p.work, p.brk), (50, 10), "work+brk 超 60 时应把休息夹到 60-work");
        // 只有第 0 天有选择，其它天应保持关闭
        assert!(!hc.days[1][9].on);
    }
}
