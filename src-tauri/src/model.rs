use serde::{Deserialize, Serialize};

/// 时间段，单位：分钟（0..1440）。end <= start 表示跨夜。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Slot {
    pub start: u32,
    pub end: u32,
}

impl Default for Slot {
    fn default() -> Self {
        Slot { start: 0, end: 0 }
    }
}

/// 应用条目
/// kind: exe（可执行文件路径） | dir（文件夹内所有 exe） | name（进程名） | title（窗口标题包含）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct AppEntry {
    pub id: String,
    pub kind: String,
    pub value: String,
    pub label: String,
}

impl Default for AppEntry {
    fn default() -> Self {
        AppEntry {
            id: String::new(),
            kind: "exe".into(),
            value: String::new(),
            label: String::new(),
        }
    }
}

/// 网站条目，pattern 支持 domain / 带路径 / 通配符 *
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SiteEntry {
    pub id: String,
    pub pattern: String,
    pub label: String,
}

impl Default for SiteEntry {
    fn default() -> Self {
        SiteEntry {
            id: String::new(),
            pattern: String::new(),
            label: String::new(),
        }
    }
}

/// 锁定信息：防止自己在生效期间随手关掉规则
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Lock {
    /// none | timer | password | text
    pub kind: String,
    /// timer 模式的解锁时间点（unix 秒）
    pub until: i64,
    pub password: String,
    /// text 模式需要抄写的字符数
    pub chars: u32,
}

impl Default for Lock {
    fn default() -> Self {
        Lock {
            kind: "none".into(),
            until: 0,
            password: String::new(),
            chars: 20,
        }
    }
}

/// 休息（番茄）配置
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct BreakCfg {
    /// none | pomodoro
    pub kind: String,
    pub work_min: u32,
    pub break_min: u32,
}

impl Default for BreakCfg {
    fn default() -> Self {
        BreakCfg {
            kind: "none".into(),
            work_min: 25,
            break_min: 5,
        }
    }
}

/// 积分账户
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Points {
    pub balance: i64,
    pub total_earned: i64,
    /// 用积分强行解锁的截止时间
    pub unlock_until: i64,
    pub unlock_count_today: u32,
    pub day: String,
}

impl Default for Points {
    fn default() -> Self {
        Points {
            balance: 0,
            total_earned: 0,
            unlock_until: 0,
            unlock_count_today: 0,
            day: String::new(),
        }
    }
}

/// 一条规则（一个黑名单 / 白名单组）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct RuleList {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// blacklist（这些不能开） | whitelist（只能开这些，即强制模式）
    pub mode: String,
    pub apps: Vec<AppEntry>,
    pub sites: Vec<SiteEntry>,
    /// 网站例外，优先级高于 sites
    pub exceptions: Vec<String>,
    /// 7 天时段，索引 0 = 周一；7 天全空 = 全天生效
    pub schedule: Vec<Vec<Slot>>,
    pub lock: Lock,
    pub color: String,
    /// 仅强制模式生效：白名单里也不会被拦截的进程（用户自定义保护）
    pub extra_protected: Vec<String>,
    /// 休息（番茄）设置
    pub brk: BreakCfg,
    /// 硬核锁定：生效期间不能退出程序、不能改设置、任务管理器会被关掉
    pub hard: bool,
}

impl Default for RuleList {
    fn default() -> Self {
        RuleList {
            id: String::new(),
            name: "新规则".into(),
            enabled: false,
            mode: "blacklist".into(),
            apps: vec![],
            sites: vec![],
            exceptions: vec![],
            schedule: vec![vec![]; 7],
            lock: Lock::default(),
            color: "#ff9f43".into(),
            extra_protected: vec![],
            brk: BreakCfg::default(),
            hard: true,
        }
    }
}

/// 兼容旧配置：hotkey 曾是 bool（true = 用默认组合，false = 关闭）
fn de_hotkey<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    let v = serde_json::Value::deserialize(d)?;
    Ok(match v {
        serde_json::Value::String(s) => s,
        serde_json::Value::Bool(true) => "Ctrl+Alt+K".to_string(),
        serde_json::Value::Bool(false) => String::new(),
        _ => "Ctrl+Alt+K".to_string(),
    })
}

/// 专注遮罩配置
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct MaskCfg {
    /// 遮罩不透明度 0-100
    pub opacity: u8,
    /// 目标窗口四周留出的可见边距（像素）
    pub margin: i32,
    /// 遮罩圆角半径（像素）
    pub radius: i32,
    /// 扩散 / 收起动画时长（毫秒，0 = 瞬间）
    pub duration_ms: u32,
    /// 跟随当前最上层窗口（洞口自动跟着前台窗口）
    pub follow: bool,
    /// true = 逐像素抗锯齿圆角；false（默认）= 区域挖洞，兼容性优先
    pub smooth: bool,
    /// 是否屏蔽鼠标点击（遮罩吃掉点击，防止手滑去点别的窗口）
    pub block_click: bool,
    /// 上次使用的目标窗口
    pub target_pid: u32,
    pub target_title: String,
    /// 全局快捷键，如 "Ctrl+Alt+K"；空串 = 不注册
    /// （旧版本这里是 bool，老配置要能平滑读进来）
    #[serde(deserialize_with = "de_hotkey")]
    pub hotkey: String,
    pub hotkey_label: String,
    /// 进入下列应用时自动开启遮罩（exe 名，不带 .exe）
    pub auto: bool,
    pub auto_apps: Vec<String>,
}

impl Default for MaskCfg {
    fn default() -> Self {
        MaskCfg {
            opacity: 88,
            margin: 6,
            radius: 28,
            duration_ms: 420,
            follow: false,
            smooth: false,
            block_click: false,
            target_pid: 0,
            target_title: String::new(),
            hotkey: "Ctrl+Alt+K".into(),
            hotkey_label: "Ctrl+Alt+K".into(),
            auto: false,
            auto_apps: vec![],
        }
    }
}

/// 备份配置
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupCfg {
    /// 备份密码；留空则用 Windows DPAPI 加密（跟本机账户走）
    pub password: String,
    /// 打开软件时顺手做一次本地备份
    pub auto_on_start: bool,
}

impl Default for BackupCfg {
    fn default() -> Self {
        BackupCfg {
            password: String::new(),
            auto_on_start: false,
        }
    }
}

/// 提醒设置
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct NotifyCfg {
    pub enabled: bool,
    /// 学习结束前多少分钟提醒（0 = 不提醒，上限 120）
    pub work_before: u32,
    /// 休息结束前多少分钟提醒
    pub break_before: u32,
    /// 休息提醒可以单独关掉
    pub break_notify: bool,
    /// 提醒时是否把主窗口拉到前台
    pub focus_window: bool,
}

impl Default for NotifyCfg {
    fn default() -> Self {
        NotifyCfg {
            enabled: true,
            work_before: 5,
            break_before: 2,
            break_notify: true,
            focus_window: false,
        }
    }
}

/// 桌面悬浮 HUD
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct HudCfg {
    pub enabled: bool,
    /// 励志短语多久换一次（分钟）
    pub quote_minutes: u32,
    /// 距屏幕右边缘的距离
    pub offset_x: i32,
    pub offset_y: i32,
}

impl Default for HudCfg {
    fn default() -> Self {
        HudCfg {
            enabled: true,
            quote_minutes: 60,
            offset_x: 20,
            offset_y: 20,
        }
    }
}

/// WebDAV 云同步配置
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncCfg {
    pub enabled: bool,
    /// WebDAV 目录地址，例如 https://dav.jianguoyun.com/dav/KingOfFocus/
    pub url: String,
    pub username: String,
    pub password: String,
    pub auto: bool,
    pub auto_minutes: u32,
    pub remote_file: String,
    pub device: String,
    pub last_sync: i64,
    pub last_error: String,
    pub last_result: String,
}

impl Default for SyncCfg {
    fn default() -> Self {
        SyncCfg {
            enabled: false,
            url: String::new(),
            username: String::new(),
            password: String::new(),
            auto: true,
            auto_minutes: 30,
            remote_file: "king-of-focus.json".into(),
            device: std::env::var("COMPUTERNAME").unwrap_or_else(|_| "我的电脑".into()),
            last_sync: 0,
            last_error: String::new(),
            last_result: String::new(),
        }
    }
}

/// 自动更新配置
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateCfg {
    pub enabled: bool,
    pub repo: String,
    /// GitHub 个人访问令牌（用于提升 API 额度），界面上只显示掩码
    pub token: String,
    /// 用户选择"跳过"的版本号
    pub skipped_version: String,
    pub last_check: i64,
}

impl Default for UpdateCfg {
    fn default() -> Self {
        UpdateCfg {
            enabled: true,
            repo: crate::version::REPO_NAME.into(),
            token: String::new(),
            skipped_version: String::new(),
            last_check: 0,
        }
    }
}

/// 使用时长统计配置
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct StatsCfg {
    pub enabled: bool,
    /// 无操作超过 60 秒是否仍计入（默认不计）
    pub count_idle: bool,
    pub auto_daily: bool,
    pub auto_weekly: bool,
    pub auto_monthly: bool,
    pub auto_yearly: bool,
    /// 每 N 天生成一次报告，0 = 关闭
    pub custom_days: u32,
    /// 自定义周期的起始锚点 yyyy-mm-dd
    pub custom_anchor: String,
    /// 原始数据保留天数
    pub retention_days: u32,
}

impl Default for StatsCfg {
    fn default() -> Self {
        StatsCfg {
            enabled: true,
            count_idle: false,
            auto_daily: true,
            auto_weekly: true,
            auto_monthly: true,
            auto_yearly: true,
            custom_days: 0,
            custom_anchor: String::new(),
            retention_days: 400,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 进程扫描间隔（毫秒）
    pub poll_ms: u64,
    /// 演练模式：只记录不真的关掉
    pub dry_run: bool,
    /// 拦截网站时，若浏览器未安装扩展则强制关闭浏览器
    pub guard_browser: bool,
    /// 扩展心跳容忍秒数
    pub grace_secs: u64,
    /// 本地通信端口
    pub port: u16,
    /// 开机自启
    pub autostart: bool,
    /// 关闭窗口时最小化到托盘
    pub close_to_tray: bool,
    /// 关闭前先尝试温和关闭
    pub soft_close: bool,
    /// 网页命中黑名单时，除了关掉那个标签页，是否连整个浏览器窗口一起关掉
    pub site_close_browser: bool,
    /// 全局保护进程名（强制模式不拦截）
    pub protected: Vec<String>,
    /// 外观：system | dark | light
    pub theme: String,
    /// 专注遮罩
    pub mask: MaskCfg,
    /// 时长统计
    pub stats: StatsCfg,
    /// 云同步
    pub sync: SyncCfg,
    /// 自动更新
    pub update: UpdateCfg,
    /// 桌面 HUD
    pub hud: HudCfg,
    /// 提醒
    pub notify: NotifyCfg,
    /// 备份
    pub backup: BackupCfg,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            poll_ms: 1000,
            dry_run: false,
            guard_browser: true,
            grace_secs: 90,
            port: 27315,
            autostart: false,
            close_to_tray: true,
            soft_close: true,
            site_close_browser: true,
            protected: default_protected(),
            theme: "system".into(),
            mask: MaskCfg::default(),
            stats: StatsCfg::default(),
            sync: SyncCfg::default(),
            update: UpdateCfg::default(),
            hud: HudCfg::default(),
            notify: NotifyCfg::default(),
            backup: BackupCfg::default(),
        }
    }
}

pub fn default_protected() -> Vec<String> {
    [
        "explorer", "taskmgr", "csrss", "wininit", "winlogon", "services", "lsass", "smss",
        "svchost", "dwm", "fontdrvhost", "sihost", "ctfmon", "runtimebroker",
        "shellexperiencehost", "startmenuexperiencehost", "searchhost", "searchapp",
        "textinputhost", "applicationframehost", "systemsettings", "lockapp",
        "useroobebroker", "msedgewebview2", "widgets", "securityhealthsystray",
        "securityhealthservice", "wudfhost", "dllhost", "conhost", "wmiprvse",
        "zilv-dawang", "自律大王", "king-of-focus", "regedit", "mmc", "logonui", "consent",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub version: u32,
    pub lists: Vec<RuleList>,
    pub settings: Settings,
    /// 最后修改时间（云同步冲突判定用）
    pub updated_at: i64,
    /// 积分账户
    pub points: Points,
}

impl Default for Config {
    fn default() -> Self {
        let weekdays_19 = |start: u32, end: u32| vec![Slot { start, end }];
        let mut l = RuleList {
            id: "seed-study".into(),
            name: "自律时间".into(),
            enabled: false,
            mode: "blacklist".into(),
            apps: vec![],
            sites: vec![],
            exceptions: vec![],
            schedule: vec![
                weekdays_19(19 * 60, 21 * 60 + 30),
                weekdays_19(19 * 60, 21 * 60 + 30),
                weekdays_19(19 * 60, 21 * 60 + 30),
                weekdays_19(19 * 60, 21 * 60 + 30),
                weekdays_19(19 * 60, 21 * 60 + 30),
                weekdays_19(9 * 60, 11 * 60 + 30),
                weekdays_19(9 * 60, 11 * 60 + 30),
            ],
            lock: Lock::default(),
            color: "#ff9f43".into(),
            extra_protected: vec![],
            brk: BreakCfg {
                kind: "pomodoro".into(),
                work_min: 50,
                break_min: 10,
            },
            hard: true,
        };
        l.id = "seed-study".into();
        Config {
            version: 1,
            lists: vec![l],
            settings: Settings::default(),
            updated_at: chrono::Local::now().timestamp(),
            points: Points::default(),
        }
    }
}

/// 运行期拦截记录
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub ts: i64,
    /// app | site
    pub kind: String,
    pub target: String,
    pub rule: String,
    pub detail: String,
}
