use crate::mask::MaskCtl;
use crate::model::{Config, Event};
use crate::stats::DayFile;
use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};

pub struct Runtime {
    /// 当前生效的规则（名称 + 模式）
    pub active: Vec<(String, String)>,
    pub blocked_apps: u32,
    pub blocked_sites: u32,
    pub day: String,
    pub events: VecDeque<Event>,
    /// 浏览器扩展最近一次心跳（unix 秒）
    pub hb_ts: i64,
    pub hb_browser: String,
    /// 扩展上报的当前标签页
    pub site_url: String,
    pub site_title: String,
    pub site_ts: i64,
    pub site_browser: String,
    /// 距离下次状态变化（秒），<=0 表示无
    pub next_change: i64,
    /// 已拦截的目标（用于 UI 高亮）
    pub last_blocked: String,
}

impl Default for Runtime {
    fn default() -> Self {
        Runtime {
            active: vec![],
            blocked_apps: 0,
            blocked_sites: 0,
            day: String::new(),
            events: VecDeque::new(),
            hb_ts: 0,
            hb_browser: String::new(),
            site_url: String::new(),
            site_title: String::new(),
            site_ts: 0,
            site_browser: String::new(),
            next_change: 0,
            last_blocked: String::new(),
        }
    }
}

pub struct Shared {
    pub cfg: RwLock<Config>,
    pub rt: Mutex<Runtime>,
    pub mask: Arc<MaskCtl>,
    /// 当天时长累计（内存态，定期落盘）
    pub stats: Mutex<DayFile>,
    pub stats_dirty: AtomicBool,
}

impl Shared {
    pub fn new(cfg: Config) -> Self {
        Shared {
            cfg: RwLock::new(cfg),
            rt: Mutex::new(Runtime::default()),
            mask: Arc::new(MaskCtl::default()),
            stats: Mutex::new(DayFile::default()),
            stats_dirty: AtomicBool::new(false),
        }
    }

    pub fn config(&self) -> Config {
        self.cfg.read().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn log(&self, kind: &str, target: String, rule: String, detail: String) {
        let ts = chrono::Local::now().timestamp();
        if let Ok(mut rt) = self.rt.lock() {
            if kind == "site" {
                rt.blocked_sites += 1;
            } else {
                rt.blocked_apps += 1;
            }
            rt.last_blocked = target.clone();
            rt.events.push_front(Event {
                ts,
                kind: kind.to_string(),
                target,
                rule,
                detail,
            });
            while rt.events.len() > 240 {
                rt.events.pop_back();
            }
        }
    }
}
