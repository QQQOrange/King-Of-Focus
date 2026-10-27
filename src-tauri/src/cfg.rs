use crate::model::{ClockCfg, ClockProfile, Config, DEFAULT_CLOCK_PROFILE_ID, MAX_CLOCK_PROFILES};
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
    // 自律时段：多套「星期时段」方案，每套都是 7 天 × 24 段，
    // 且 work + brk 不能超过 1 小时（否则会跟下一段的计划打架）
    sanitize_clock(&mut c.settings.focus_clock);
}

/// 自律时段配置归一化：
/// 1. 旧版（单套 `days` / 更旧的 `hours`）迁移成第一套方案
/// 2. 每套方案补齐 7×24、夹紧专注 / 休息时长
/// 3. id 去重、名字兜底、`active` 必须指向真实存在的方案
fn sanitize_clock(hc: &mut ClockCfg) {
    if hc.profiles.is_empty() {
        let days = if !hc.days.is_empty() {
            std::mem::take(&mut hc.days)
        } else if hc.hours.len() == 24 {
            // 更旧的"全周共用 24 段"：复制到一周七天
            let legacy = std::mem::take(&mut hc.hours);
            (0..7).map(|_| legacy.clone()).collect()
        } else {
            Vec::new()
        };
        let mut p = ClockProfile::default();
        if !days.is_empty() {
            p.days = days;
        }
        if hc.def_work > 0 {
            p.def_work = hc.def_work;
        }
        if hc.def_brk > 0 {
            p.def_brk = hc.def_brk;
        }
        hc.profiles.push(p);
        hc.active = DEFAULT_CLOCK_PROFILE_ID.into();
    }
    // 迁移完就把旧字段清掉，避免"改了 profiles、旧 days 还是老样子"的双份真相
    hc.days.clear();
    hc.hours.clear();
    hc.profiles.truncate(MAX_CLOCK_PROFILES);

    let mut seen: Vec<String> = Vec::new();
    for (i, p) in hc.profiles.iter_mut().enumerate() {
        normalize_profile(p, i, &mut seen);
    }
    if !hc.profiles.iter().any(|p| p.id == hc.active) {
        hc.active = hc.profiles.first().map(|p| p.id.clone()).unwrap_or_default();
    }
}

fn normalize_profile(p: &mut ClockProfile, idx: usize, seen: &mut Vec<String>) {
    // id：空的 / 撞车的重新发一个，保证前端能唯一定位
    let mut id = p.id.trim().to_string();
    if id.is_empty() || seen.iter().any(|s| *s == id) {
        let mut n = idx + 1;
        loop {
            let cand = format!("p{n}");
            if !seen.iter().any(|s| *s == cand) {
                id = cand;
                break;
            }
            n += 1;
        }
    }
    p.id = id.clone();
    seen.push(id);

    let name = p.name.trim().to_string();
    p.name = if name.is_empty() {
        format!("方案 {}", idx + 1)
    } else {
        name.chars().take(30).collect()
    };

    while p.days.len() < 7 {
        p.days.push(vec![crate::model::HourPlan::default(); 24]);
    }
    p.days.truncate(7);
    for day in p.days.iter_mut() {
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

    // 通用默认时长：与单段同样的夹紧口径（新选时段沿用这套值）
    p.def_work = p.def_work.clamp(1, 60);
    p.def_brk = p.def_brk.min(60);
    if p.def_brk > 0 {
        p.def_work = p.def_work.clamp(1, 59);
        if p.def_work + p.def_brk > 60 {
            p.def_brk = 60 - p.def_work;
        }
    }
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
            hours,
            profiles: Vec::new(),
            ..ClockCfg::default()
        };
        sanitize(&mut c);
        let hc = &c.settings.focus_clock;
        assert_eq!(hc.profiles.len(), 1, "旧配置应迁移出一套方案");
        let days = hc.active_days().expect("应有一套方案");
        assert_eq!(days.len(), 7, "旧配置应迁移出 7 天");
        for day in days {
            assert_eq!(day.len(), 24);
            assert!(day[9].on, "旧选择应复制到每一天");
            assert_eq!((day[9].work, day[9].brk), (45, 15));
        }
        assert!(hc.hours.is_empty(), "迁移后旧字段应清空");
    }

    #[test]
    fn clock_migrates_legacy_days_into_first_profile() {
        // 上一版把单套方案直接摊在 ClockCfg.days 上
        let mut c = Config::default();
        let mut day = vec![HourPlan::default(); 24];
        day[9] = HourPlan { on: true, work: 50, brk: 30 }; // work+brk > 60
        c.settings.focus_clock = ClockCfg {
            enabled: true,
            days: vec![day],
            profiles: Vec::new(),
            def_work: 45,
            def_brk: 15,
            ..ClockCfg::default()
        };
        sanitize(&mut c);
        let hc = &c.settings.focus_clock;
        assert_eq!(hc.profiles.len(), 1);
        assert_eq!(hc.active, DEFAULT_CLOCK_PROFILE_ID);
        assert!(hc.days.is_empty(), "迁移后旧字段应清空");
        let p = &hc.profiles[0];
        assert_eq!(p.days.len(), 7, "天数不足应补齐");
        assert!(p.days[0][9].on);
        assert_eq!(
            (p.days[0][9].work, p.days[0][9].brk),
            (50, 10),
            "work+brk 超 60 时应把休息夹到 60-work"
        );
        assert!(!p.days[1][9].on, "只有第 0 天有选择，其它天应保持关闭");
        assert_eq!((p.def_work, p.def_brk), (45, 15), "旧通用时长应跟着搬过去");
    }

    #[test]
    fn clock_keeps_multiple_profiles() {
        let mut c = Config::default();
        let mut a = ClockProfile::default();
        a.id = "work".into();
        a.name = "工作日强化".into();
        a.days[0][9] = HourPlan { on: true, work: 50, brk: 10 };
        let mut b = ClockProfile::default();
        b.id = "weekend".into();
        b.name = "周末轻松".into();
        b.days[5][10] = HourPlan { on: true, work: 25, brk: 5 };
        c.settings.focus_clock = ClockCfg {
            enabled: true,
            profiles: vec![a, b],
            active: "weekend".into(),
            ..ClockCfg::default()
        };
        sanitize(&mut c);
        let hc = &c.settings.focus_clock;
        assert_eq!(hc.profiles.len(), 2, "两套方案都应保留");
        assert_eq!(hc.active, "weekend", "当前方案不能被改掉");
        assert!(hc.active_profile().unwrap().days[5][10].on);
        assert!(!hc.active_profile().unwrap().days[0][9].on);
        // 另一套原样留着
        assert!(hc.profiles[0].days[0][9].on);
    }

    #[test]
    fn clock_dedups_ids_and_falls_back_when_active_missing() {
        let mut c = Config::default();
        let mut a = ClockProfile::default();
        a.id = "dup".into();
        let mut b = ClockProfile::default();
        b.id = "dup".into();
        b.name = "  ".into();
        c.settings.focus_clock = ClockCfg {
            enabled: true,
            profiles: vec![a, b],
            active: "不存在的方案".into(),
            ..ClockCfg::default()
        };
        sanitize(&mut c);
        let hc = &c.settings.focus_clock;
        let ids: Vec<&str> = hc.profiles.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1], "重复 id 必须重新发号");
        assert!(!hc.profiles[1].name.trim().is_empty(), "空名字应兜底");
        assert_eq!(hc.active, ids[0], "active 失效时退回第一套");
    }

    #[test]
    fn clock_profile_defaults_and_clamps() {
        // 畸形值：work+brk 超 60 → 休息夹到 60-work
        let mut c = Config::default();
        c.settings.focus_clock.profiles[0].def_work = 90;
        c.settings.focus_clock.profiles[0].def_brk = 30;
        sanitize(&mut c);
        let p = &c.settings.focus_clock.profiles[0];
        assert_eq!((p.def_work, p.def_brk), (59, 1));

        // serde 缺省：一套方案没写这两个字段时走 50/10
        let json = r#"{"id":"x","name":"x","days":[]}"#;
        let p: ClockProfile = serde_json::from_str(json).unwrap();
        assert_eq!((p.def_work, p.def_brk), (50, 10));
        // 序列化用 camelCase
        let out = serde_json::to_string(&p).unwrap();
        assert!(out.contains("\"defWork\":50"), "{out}");
        assert!(out.contains("\"defBrk\":10"), "{out}");

        // 顶层旧字段为 0 时不写进 JSON，避免新配置里残留一大堆 0
        let hc = ClockCfg::default();
        let v: serde_json::Value = serde_json::from_str(&serde_json::to_string(&hc).unwrap()).unwrap();
        assert!(v.get("defWork").is_none(), "{v}");
        assert!(v.get("defBrk").is_none(), "{v}");
        assert!(v.get("days").is_none(), "{v}");
    }
}
