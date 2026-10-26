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
    /// 上次把主窗口拉到前台的时间（毫秒），用于防抖
    pub last_focus: i64,
    /// 积分累加器（毫秒）
    pub points_acc: u64,
    /// 是否有规则正处于番茄休息段
    pub on_break: bool,
    pub in_break: bool,
    /// 当前番茄阶段剩余秒数
    pub break_left: i64,
    /// 是否处于固化（硬锁）状态
    pub locked: bool,
    pub lock_until: i64,
    pub lock_until_text: String,
    pub lock_names: Vec<String>,
    /// 本轮自律开始时间（unix 秒），0 = 没在自律
    pub since: i64,
    /// 当前励志短语
    pub quote: String,
    pub quote_from: String,
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
            last_focus: 0,
            points_acc: 0,
            on_break: false,
            in_break: false,
            break_left: 0,
            locked: false,
            lock_until: 0,
            lock_until_text: String::new(),
            lock_names: vec![],
            since: 0,
            quote: String::new(),
            quote_from: String::new(),
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
    /// 一次性提示（要弹给用户看的一句话）
    pub notice: Mutex<Option<String>>,
}

impl Shared {
    pub fn new(cfg: Config) -> Self {
        Shared {
            cfg: RwLock::new(cfg),
            rt: Mutex::new(Runtime::default()),
            mask: Arc::new(MaskCtl::default()),
            stats: Mutex::new(DayFile::default()),
            stats_dirty: AtomicBool::new(false),
            notice: Mutex::new(None),
        }
    }

    pub fn say(&self, msg: impl Into<String>) {
        if let Ok(mut n) = self.notice.lock() {
            *n = Some(msg.into());
        }
    }

    /// 加积分（自律奖励）
    pub fn add_points(&self, n: i64) {
        let mut c = self.config();
        c.points.balance += n;
        c.points.total_earned += n;
        let _ = crate::cfg::save(&c);
        if let Ok(mut w) = self.cfg.write() {
            *w = c;
        }
    }

    /// 扣积分，不够就返回 false
    pub fn spend_points(&self, n: i64) -> bool {
        let mut c = self.config();
        if c.points.balance < n {
            return false;
        }
        c.points.balance -= n;
        let _ = crate::cfg::save(&c);
        if let Ok(mut w) = self.cfg.write() {
            *w = c;
        }
        true
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
