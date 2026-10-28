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
            name: "新黑名单".into(),
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
    /// 跟随当前最上层窗口（遮罩焦点自动跟着前台窗口）
    pub follow: bool,
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
    /// 遮罩跟随自律模式：自律生效时就开，自律结束就关
    pub follow_schedule: bool,
    /// 媒体管控：遮罩生效时自动暂停「被盖住/非前台」窗口的媒体播放，
    /// 窗口回到前台/呈现状态时恢复。默认关，避免误伤正在听歌的后台播放。
    pub media_pause: bool,
    /// 【已废弃】旧版"进入指定应用自动开遮罩"，仅保留字段以兼容老配置
    pub auto: bool,
    pub auto_apps: Vec<String>,
}

impl Default for MaskCfg {
    fn default() -> Self {
        MaskCfg {
            opacity: 88,
            follow: true,
            block_click: true,
            target_pid: 0,
            target_title: String::new(),
            hotkey: "Ctrl+Alt+K".into(),
            hotkey_label: "Ctrl+Alt+K".into(),
            follow_schedule: false,
            media_pause: false,
            auto: false,
            auto_apps: vec![],
        }
    }
}

/// 一个 1 小时时段的计划（0-24 点共 24 段）
///
/// 语义和"规则里的番茄"完全一致：`work` 分钟专注 + `brk` 分钟休息循环。
/// 区别只是粒度——这里是"每小时一段"，所以一段里最多一次专注 + 一次休息。
///
/// `from` / `to` 是这一小时的**选中窗口起止分钟**（`[from, to)`）：
/// 默认 `0..60`（整小时全选），右键菜单里可以改成"第 15 分钟到第 45 分钟"，
/// 实现比"整小时"更细的时段边界。只有连续段的首/尾小时会用到非默认值，
/// 中间小时永远是 `0..60`（否则渲染上会出现选中区里的空洞）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct HourPlan {
    /// 这一段算不算"自律模式生效"
    pub on: bool,
    /// 专注时长（分钟）。0 或 60 都表示整段不休息
    pub work: u32,
    /// 休息时长（分钟）。0 = 不休息
    pub brk: u32,
    /// 选中窗口在这一小时里的起始分钟（0–59）
    #[serde(default)]
    pub from: u32,
    /// 选中窗口在这一小时里的结束分钟（1–60，60 = 到整点）
    #[serde(default = "hour_end")]
    pub to: u32,
}

/// `to` 的 serde 默认值：整点结束（旧配置没有这个字段时不能变成 0，
/// 否则整个小时都会被当成"没选中"）
fn hour_end() -> u32 {
    60
}

impl Default for HourPlan {
    fn default() -> Self {
        HourPlan { on: false, work: 50, brk: 10, from: 0, to: 60 }
    }
}

/// 第一套方案的固定 id（旧配置迁移、默认配置都用它）
pub const DEFAULT_CLOCK_PROFILE_ID: &str = "p1";
/// 最多同时保存几套「星期时段」方案（防止误点「新建」堆出上百套）
pub const MAX_CLOCK_PROFILES: usize = 12;

/// 一套「星期时段」方案：7 天 × 24 小时。
///
/// 「自律时段」可以同时存多套方案（工作日强化 / 周末轻松 / 假期……），
/// 同一时刻只有 `ClockCfg::active` 指向的那一套在生效——
/// 换排班不必把原来那张表擦掉重画，切回来就能用。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ClockProfile {
    /// 稳定 id：前端增删改、切换生效方案都靠它定位
    pub id: String,
    /// 显示名（只用于区分，不参与判定）
    pub name: String,
    /// 7 天 × 24 小时；`days[weekday][hour]`，weekday 0=周一 … 6=周日
    pub days: Vec<Vec<HourPlan>>,
    /// 这套方案的通用默认时长：新框选 / 单击选中的时段沿用这套「专注 / 休息」，
    /// 右键菜单应用时也可以顺手把它更新掉（一处设置，处处沿用）
    pub def_work: u32,
    pub def_brk: u32,
}

impl Default for ClockProfile {
    fn default() -> Self {
        ClockProfile {
            id: DEFAULT_CLOCK_PROFILE_ID.into(),
            name: "默认时段".into(),
            days: vec![vec![HourPlan::default(); 24]; 7],
            def_work: 50,
            def_brk: 10,
        }
    }
}

impl ClockProfile {
    /// 一周里选中了多少个小时段
    pub fn count_on(&self) -> usize {
        self.days.iter().flatten().filter(|h| h.on).count()
    }

    /// 一个时段都没选
    pub fn is_empty(&self) -> bool {
        self.days.iter().flatten().all(|h| !h.on)
    }
}

/// 「自律模式生效时间段」：多套方案，每套都是"把一周切成 7 天、每天再切成 24 段"。
///
/// `profiles` 存所有方案，`active` 指向当前生效的那一套。
/// `days` / `hours` / `def_work` / `def_brk` 是旧版"只有一套方案"时摊在
/// ClockCfg 上的字段，只用于一次性迁移：加载时若 `profiles` 为空，会把它们
/// 搬进第一套方案并清空，之后不再参与任何逻辑。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClockCfg {
    pub enabled: bool,
    /// 时段内让所有「已启用」的规则立刻生效（忽略各规则自己的时段）
    #[serde(default = "default_true")]
    pub apply_rules: bool,
    /// 所有「星期时段」方案
    #[serde(default)]
    pub profiles: Vec<ClockProfile>,
    /// 当前生效的方案 id；空 / 找不到 → 退回第一套
    #[serde(default)]
    pub active: String,
    /// 旧字段：单套方案的 7×24。仅用于一次性迁移，迁移后清空
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub days: Vec<Vec<HourPlan>>,
    /// 旧字段：全周共用的 24 段。仅用于一次性迁移，迁移后清空
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hours: Vec<HourPlan>,
    /// 旧字段：通用默认时长（已搬到每套方案里）
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub def_work: u32,
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub def_brk: u32,
}

fn default_true() -> bool { true }
fn is_zero_u32(v: &u32) -> bool { *v == 0 }

impl ClockCfg {
    /// 当前生效的那套方案（`active` 找不到时退回第一套）
    pub fn active_profile(&self) -> Option<&ClockProfile> {
        if let Some(p) = self.profiles.iter().find(|p| p.id == self.active) {
            return Some(p);
        }
        self.profiles.first()
    }

    /// 当前生效方案的一周排班表
    pub fn active_days(&self) -> Option<&Vec<Vec<HourPlan>>> {
        self.active_profile().map(|p| &p.days)
    }

    /// 用一套 7×24 的排班表构造配置（旧配置迁移与测试用）
    pub fn with_days(enabled: bool, days: Vec<Vec<HourPlan>>) -> Self {
        let mut c = ClockCfg::default();
        c.enabled = enabled;
        if let Some(p) = c.profiles.first_mut() {
            p.days = days;
        }
        c
    }
}

impl Default for ClockCfg {
    fn default() -> Self {
        let p = ClockProfile::default();
        ClockCfg {
            enabled: false,
            apply_rules: true,
            active: p.id.clone(),
            profiles: vec![p],
            days: Vec::new(),
            hours: Vec::new(),
            def_work: 0,
            def_brk: 0,
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

/// 浏览器巡检与自律时段守护
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct BrowserGuardCfg {
    /// 自律时段里发现浏览器没装插件 / 插件被停用 → 自动关闭
    pub enabled: bool,
    /// 关闭前弹一张提示卡（告诉用户为什么、还有几秒）
    pub notify: bool,
    /// 宽限毫秒：从"看到浏览器"到"真的关"之间留给用户的反应时间（不超过 5 秒硬约束）
    pub grace_ms: u32,
    /// 启动时是否自动探测已安装的浏览器
    pub detect_on_start: bool,
}

impl Default for BrowserGuardCfg {
    fn default() -> Self {
        BrowserGuardCfg {
            enabled: true,
            notify: true,
            grace_ms: 1200,
            detect_on_start: true,
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
    /// 浏览器插件巡检
    pub browser_guard: BrowserGuardCfg,
    /// 本地通信端口
    pub port: u16,
    /// 开机自启
    pub autostart: bool,
    /// 总是以管理员身份运行（能摘掉别人的置顶属性，遮罩才压得住浮窗）
    pub run_as_admin: bool,
    /// 关闭窗口时最小化到托盘
    pub close_to_tray: bool,
    /// 主窗口置顶：让 King of Focus 始终浮在其它窗口上面。
    ///
    /// 之前程序只会在各种场合把它 `set_always_on_top(false)`（遮罩接管、
    /// 选中目标窗口、点托盘图标……），却从来没有把它设回 true，
    /// 结果就是"有多个窗口时它永远在最底下"，用户得先把别的窗口都挪开才看得见它。
    pub always_on_top: bool,
    /// 关闭前先尝试温和关闭
    pub soft_close: bool,
    /// 网页命中黑名单时，除了关掉那个标签页，是否连整个浏览器窗口一起关掉
    pub site_close_browser: bool,
    /// 自律模式生效期间是否禁止打开任务管理器（固化锁定时始终禁止，与本开关无关）
    pub block_taskmgr: bool,
    /// 全局保护进程名（强制模式不拦截）
    pub protected: Vec<String>,
    /// 浏览器自定义安装路径：browserKey → 可执行文件绝对路径。
    ///
    /// 装到非默认位置（绿色版、被改过安装目录、便携版）时自动检测找不到主程序，
    /// 「扩展页」按钮就开不了。这里让用户手动指定，打开扩展页时优先用它。
    pub browser_exe: std::collections::HashMap<String, String>,
    /// 外观：system | dark | light
    pub theme: String,
    /// 专注遮罩
    pub mask: MaskCfg,
    /// 自律模式生效时间段（24 段）
    pub focus_clock: ClockCfg,
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
            browser_guard: BrowserGuardCfg::default(),
            port: 27315,
            autostart: false,
            run_as_admin: false,
            close_to_tray: true,
            always_on_top: false,
            soft_close: true,
            site_close_browser: true,
            block_taskmgr: true,
            protected: default_protected(),
            browser_exe: std::collections::HashMap::new(),
            theme: "system".into(),
            mask: MaskCfg::default(),
            focus_clock: ClockCfg::default(),
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
            version: 2,
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
