//! 跨设备备份格式（桌面 ↔ Android）
//!
//! 为什么单独一层：以前备份就是"把 Config 原样加密写盘"，只有桌面版认得。
//! 手机端要读写同一份文件，就必须有一层**两端共用的文档**——它只描述
//! "两台设备都理解的数据"，平台专属的部分各自留在本机设置里不动。
//!
//! 文档结构（camelCase，两端逐字段对齐）：
//!
//! ```json
//! {
//!   "kof": "king-of-focus",      // 识别标记：不是我们的文件就不要碰
//!   "format": "kof-portable",
//!   "schema": 1,                 // 结构版本；将来加字段只做加法
//!   "createdAt": 1793500000,     // 备份生成时间（unix 秒）
//!   "source": "desktop",         // desktop | android（**只是出处标签，不参与读写**）
//!   "device": "DESKTOP-XXXX",
//!   "appVersion": "0.1.70",
//!   "rules":   [ { id, name, enabled, mode, apps[], sites[], ... } ],
//!   "clock":   { enabled, applyRules, granularity, active, profiles[{ id, name, days[7][24] }] },
//!   "points":  { balance, totalEarned, unlockUntil, sleepUnlockUntil },
//!   "settings":{ lang, theme, notify{ enabled, workBefore, breakBefore, breakNotify } },
//!   "stats":   { schema, source, device, at, days[{ day, total, on, top[] }] }
//! }
//! ```
//!
//! 四条硬约束（两端实现必须一致，否则"互通"就是一句空话）：
//! 1. **只读自己认识的字段**：多出来的键一律忽略，缺的键一律按"没意见"处理。
//!    这样任何一端升级加了字段，另一端不会因此报错，也不会把对方的设置改坏。
//! 2. **覆盖 = 文档里有的换掉，文档里没有的不动**。平台专属设置
//!    （桌面的遮罩 / HUD / 端口、手机的拦截页文案）不在文档里，所以
//!    不会被另一端的备份擦掉。
//! 3. **合并只做加法**：绝不改写本机已有的规则与时段，只补缺的；
//!    同 id 或同内容视为"已存在"跳过，同名不同内容才改名并列并计入冲突。
//! 4. **不认来源**：`source` / `device` 只用于界面显示"这份来自哪台机器"，
//!    读写路径上一个分支都不许看它。手机导出的文件在电脑上恢复、电脑导出的
//!    文件在手机上恢复，走的是同一条 `parse → to_config / merge` 流水线。
//!
//! 字段为什么只有这些：文档只放**两端都说得通**的概念。桌面专属的
//! `Settings.mask / hud / port`、手机的拦截页文案 / 通知细项都不进来；
//! 反过来，`points` 里的"今日解锁次数"这种本机记账也不进来——它不是配置，
//! 是"这台机器今天花了几次"，跟着备份跑到另一台机器上只会算错。
//!
//! 结构一致性由测试钉死：`tools/fixtures/portable-canon.json` 是两端共用的
//! 参考文档，`portable-shape.txt` 是它的**字段签名**（每个键的路径与类型）。
//! 桌面与手机各有一条测试拿自己导出的文档去比这份签名——任何一端私改字段名、
//! 悄悄少写一个键，自己那条测试立刻红。见文件末尾 `export_shape_matches_reference`。

use crate::model::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 文件识别标记（`kof` 字段的值）
pub const KOF_MARK: &str = "king-of-focus";
/// 格式名（`format` 字段的值）
pub const FORMAT: &str = "kof-portable";
/// 当前 schema 版本
pub const SCHEMA: u32 = 1;
/// 单个备份最多带多少条规则（防止被构造的文件把界面撑死）
pub const MAX_RULES: usize = 200;

/// 两端共用的设置子集。
///
/// 只放"换个设备也说得通"的项：界面语言、配色、提醒。像窗口位置、进程名、
/// 端口这种出去了就没意义的东西不进来。
///
/// `lang` / `theme` 用**空串表示"这台设备没有这个概念"**（手机端没有语言切换）。
/// 空串不是"恢复成默认值"，读的时候当没写，本机保持原样——否则一份手机备份
/// 就能把桌面用户特意调好的英文界面 + 深色配色一键改回去。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PtSettings {
    /// zh-CN | en | ""（不知道，别改）
    pub lang: String,
    /// system | dark | light | ""（不知道，别改）
    pub theme: String,
    /// 缺省 = 本机不动
    pub notify: Option<PtNotify>,
}

impl Default for PtSettings {
    fn default() -> Self {
        // 默认是"没意见"，不是某个具体值：文档里缺这段时，本机的语言/配色不许被改。
        // 真正导出时 `from_config` 会填上本机的实际值。
        PtSettings {
            lang: String::new(),
            theme: String::new(),
            notify: None,
        }
    }
}

/// 提醒设置里**两端都有**的四项。
///
/// 桌面的 `focusWindow`（提醒时把窗口拉到前台）不进文档：手机端没有"主窗口"，
/// 写进去只会让另一端以为它是共享字段，一恢复就把本机的勾选改掉。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PtNotify {
    pub enabled: bool,
    pub work_before: u32,
    pub break_before: u32,
    pub break_notify: bool,
}

impl Default for PtNotify {
    fn default() -> Self {
        PtNotify {
            enabled: true,
            work_before: 5,
            break_before: 2,
            break_notify: true,
        }
    }
}

/// 积分账户里**两端都有**的四项。
///
/// `unlockCountToday` / `day` 是本机记账（"今天花了几次积分解锁"），
/// 跟着备份跑到另一台设备上毫无意义，还会被当成"今天已经用过了"。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PtPoints {
    pub balance: i64,
    pub total_earned: i64,
    /// 用积分解锁「自律固化」到什么时候（unix 秒）
    pub unlock_until: i64,
    /// 用积分解锁「睡眠时段」到什么时候（两端都有这个概念）
    pub sleep_unlock_until: i64,
}

/// 一份跨设备备份文档
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Doc {
    pub kof: String,
    pub format: String,
    pub schema: u32,
    pub created_at: i64,
    /// desktop | android
    pub source: String,
    pub device: String,
    pub app_version: String,
    pub rules: Vec<Rule>,
    pub clock: ClockCfg,
    pub points: PtPoints,
    pub settings: PtSettings,
    /// **另一台设备的统计摘要**（转义：不是本机的原始统计）。
    ///
    /// 为什么不带原始数据：两端存储结构不同，原样互传没人读得懂；而摘要
    /// （每天总时长 / 自律时长 / 前三个应用）两边都能算，且不会重复计数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<PeerStats>,
}

impl Default for Doc {
    fn default() -> Self {
        Doc {
            kof: KOF_MARK.into(),
            format: FORMAT.into(),
            schema: SCHEMA,
            created_at: 0,
            source: "desktop".into(),
            device: String::new(),
            app_version: String::new(),
            rules: Vec::new(),
            clock: ClockCfg::default(),
            points: PtPoints::default(),
            settings: PtSettings::default(),
            stats: None,
        }
    }
}

/// 解析结果：新格式文档 + （可选）老格式的整份配置
pub struct Parsed {
    pub doc: Doc,
    /// 老版本桌面备份（payload 就是 Config 本身）。
    /// 这类文件按"整份覆盖"处理——那是它当初的语义，不能悄悄改成局部替换。
    pub legacy: Option<Config>,
}

impl Doc {
    /// 从本机配置导出一份文档
    pub fn from_config(c: &Config) -> Doc {
        Doc {
            kof: KOF_MARK.into(),
            format: FORMAT.into(),
            schema: SCHEMA,
            created_at: chrono::Local::now().timestamp(),
            source: "desktop".into(),
            device: host_device(),
            app_version: crate::version::VERSION.into(),
            rules: c.rules.clone(),
            clock: c.settings.focus_clock.clone(),
            points: PtPoints {
                balance: c.points.balance,
                total_earned: c.points.total_earned,
                unlock_until: c.points.unlock_until,
                sleep_unlock_until: c.points.sleep_unlock_until,
            },
            settings: PtSettings {
                lang: c.settings.lang.clone(),
                theme: c.settings.theme.clone(),
                notify: Some(PtNotify {
                    enabled: c.settings.notify.enabled,
                    work_before: c.settings.notify.work_before,
                    break_before: c.settings.notify.break_before,
                    break_notify: c.settings.notify.break_notify,
                }),
            },
            stats: Some(PeerStats {
                schema: 1,
                source: "desktop".into(),
                device: host_device(),
                at: chrono::Local::now().timestamp(),
                // 30 天足够看出"另一台设备最近在干嘛"，再长会让备份文件翻倍
                days: crate::stats::digest(30),
            }),
        }
    }

    /// 把文档里的统计摘要收下（**只在自己那份更新时**）。
    ///
    /// 三条规则：
    /// · 空的不要（对方刚装、还没数据）；
    /// · 旧的不要（`at` 更小说明是本机已经收过的同一份或更早的版本）；
    /// · **自己导出的不要**：同一台机器恢复自己的备份时，不该在"另一台设备"里
    ///   看到自己 —— 那会让人以为还有一台不存在的设备。
    fn adopt_stats(&self, base: &Config) -> Option<PeerStats> {
        let s = self.stats.as_ref()?;
        if s.days.is_empty() {
            return None;
        }
        if s.at <= base.settings.peer_stats.at {
            return None;
        }
        if s.source == "desktop" && s.device == host_device() {
            return None;
        }
        Some(s.clone())
    }

    /// 序列化成可读 JSON（写盘 / 加密前的内容）
    pub fn render(&self) -> Result<String, String> {
        let mut me = self.clone();
        me.kof = KOF_MARK.into();
        me.format = FORMAT.into();
        me.schema = SCHEMA;
        if me.created_at <= 0 {
            me.created_at = chrono::Local::now().timestamp();
        }
        serde_json::to_string_pretty(&me).map_err(|e| e.to_string())
    }

    /// 与 `render` 同源，但要给"形状比对"用：同一份文档的 `Value` 形态
    pub fn to_value(&self) -> Result<Value, String> {
        let mut me = self.clone();
        me.kof = KOF_MARK.into();
        me.format = FORMAT.into();
        me.schema = SCHEMA;
        serde_json::to_value(&me).map_err(|e| e.to_string())
    }

    /// **覆盖模式**：文档里有的统统换掉，文档里没有的本机设置原样保留。
    pub fn to_config(&self, base: &Config) -> Config {
        let stats = self.adopt_stats(base);
        let mut out = base.clone();
        out.rules = normalize_rules(&self.rules);
        // 「时段内让规则立即生效」是本机策略，手机端根本没有这个概念（它写死 true）。
        // 整块覆盖会让用户特意关掉的开关被一份手机备份悄悄打开——等于绕过了自律。
        let keep_apply = out.settings.focus_clock.apply_rules;
        out.settings.focus_clock = self.clock.clone();
        out.settings.focus_clock.apply_rules = keep_apply;
        // 积分：只搬四个共享项。「今天用了几次」是本机记账，恢复备份不该把它清零
        out.points.balance = self.points.balance;
        // 累计获得取较大值：手机端的 Config 没有这个字段，导出时拿余额顶替，
        // 直接照单全收会把"累计 500"改成"累计 30"。
        out.points.total_earned = self.points.total_earned.max(base.points.total_earned);
        out.points.unlock_until = self.points.unlock_until;
        out.points.sleep_unlock_until = self.points.sleep_unlock_until;
        // 空串 = 这台设备没有这个概念（手机端没有语言/配色切换），保持本机原样。
        // 不这么写的话，一份手机备份就能把桌面调好的英文界面改回中文。
        if matches!(self.settings.lang.as_str(), "zh-CN" | "en") {
            out.settings.lang = self.settings.lang.clone();
        }
        if matches!(self.settings.theme.as_str(), "system" | "dark" | "light") {
            out.settings.theme = self.settings.theme.clone();
        }
        // 提醒：只搬共用的四项，"提醒时把窗口拉到前台"是桌面专属
        if let Some(n) = &self.settings.notify {
            out.settings.notify.enabled = n.enabled;
            out.settings.notify.work_before = n.work_before;
            out.settings.notify.break_before = n.break_before;
            out.settings.notify.break_notify = n.break_notify;
        }
        crate::cfg::sanitize(&mut out);
        if let Some(st) = stats {
            out.settings.peer_stats = st;
        }
        out.updated_at = chrono::Local::now().timestamp();
        out
    }

    /// **合并模式**：只加法。
    ///
    /// 规则：同 id 或同内容 → 跳过；同名不同内容 → 改名并列并计冲突；其余追加。
    /// 时段：本机没选中的小时才用备份里的小时补上（已选中的一个字都不改）。
    /// 积分：取两边较大值，不累加（否则来回导入几次就能刷分）。
    /// 其余设置：不动。合并的承诺是"只会多，不会变"，动设置就违背了。
    pub fn merge(&self, base: &Config) -> (Config, MergeStats) {
        let stats = self.adopt_stats(base);
        let mut st = MergeStats::default();
        let mut out = base.clone();
        out.rules = normalize_rules(&out.rules);

        let mut ids: Vec<String> = out.rules.iter().map(|r| r.id.clone()).collect();
        let mut sigs: Vec<String> = out.rules.iter().map(sig).collect();

        for mut r in normalize_rules(&self.rules) {
            let s = sig(&r);
            if ids.iter().any(|x| *x == r.id) || sigs.iter().any(|x| *x == s) {
                st.skipped += 1;
                continue;
            }
            if out.rules.iter().any(|x| x.name.trim() == r.name.trim() && !r.name.trim().is_empty()) {
                r.name = unique_name(&out.rules, &r.name, &base.settings.lang);
                st.conflict += 1;
            } else {
                st.added += 1;
            }
            ids.push(r.id.clone());
            sigs.push(sig(&r));
            out.rules.push(r);
        }

        // 时段：只补本机空着的小时
        let doc_days = self
            .clock
            .active_profile()
            .map(|p| p.days.clone())
            .unwrap_or_default();
        let ai = out
            .settings
            .focus_clock
            .profiles
            .iter()
            .position(|p| p.id == out.settings.focus_clock.active)
            .unwrap_or(0);
        if let Some(prof) = out.settings.focus_clock.profiles.get_mut(ai) {
            for (d, day) in doc_days.iter().enumerate().take(7) {
                for (h, hp) in day.iter().enumerate().take(24) {
                    if !hp.on {
                        continue;
                    }
                    if let Some(cur) = prof.days.get_mut(d).and_then(|row| row.get_mut(h)) {
                        if !cur.on {
                            *cur = hp.clone();
                            st.slots += 1;
                        }
                    }
                }
            }
        }

        // 积分取大值：合并不会让余额变少，也不会翻倍
        out.points.balance = out.points.balance.max(self.points.balance);
        out.points.total_earned = out.points.total_earned.max(self.points.total_earned);

        crate::cfg::sanitize(&mut out);
        // 统计摘要也收下：它不属于"规则/时段"，合并模式下收它不违背
        // "只会多、不会变"的承诺（本机统计一个字节都不动，只是多了一份对端的）
        if let Some(s2) = stats {
            out.settings.peer_stats = s2;
        }
        out.updated_at = chrono::Local::now().timestamp();
        (out, st)
    }
}

/// 合并结果计数（界面据此给出"新增 3 条 / 跳过 2 条 / 冲突 1 条"）
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MergeStats {
    /// 新追加的规则
    pub added: u32,
    /// 已存在（同 id 或同内容）而跳过的规则
    pub skipped: u32,
    /// 同名但内容不同，改名并列的规则
    pub conflict: u32,
    /// 补上的小时段
    pub slots: u32,
}

impl MergeStats {
    /// 什么都没变（用来提示"没有新内容"）
    pub fn is_noop(&self) -> bool {
        self.added == 0 && self.conflict == 0 && self.slots == 0
    }
}

/// 解析一段文本：新格式文档 / 老格式整份配置
pub fn parse(text: &str) -> Result<Parsed, String> {
    let v: Value = serde_json::from_str(text).map_err(|_| "备份内容不是合法的 JSON".to_string())?;
    if v.get("kof").and_then(|x| x.as_str()) == Some(KOF_MARK) {
        // `Doc` 的每个字段都有 `default`，所以**只认 kof 标记是不够的**：
        // `{"kof":"king-of-focus"}` 也能反序列化成功，得到一份"空文档"。
        // 而恢复默认是覆盖模式 —— 规则会被清空、时段被关掉、积分归零。
        // 真备份一定是导出端写全的（字段签名里 rules/clock/points/settings 都在），
        // 所以这里要求：format 对得上、schema 在范围内、且至少带一个有效分区。
        if let Some(f) = v.get("format").and_then(|x| x.as_str()) {
            if f != FORMAT {
                return Err(format!("备份格式不认识（format={f}）"));
            }
        }
        let schema = v.get("schema").and_then(|x| x.as_u64()).unwrap_or(0);
        if schema == 0 {
            return Err("备份文件缺少 schema，无法确认版本".into());
        }
        if schema > SCHEMA as u64 {
            return Err(format!(
                "这份备份来自更新的版本（schema {schema}），请先升级本软件再恢复"
            ));
        }
        let has_section = ["rules", "clock", "points", "settings", "stats"]
            .iter()
            .any(|k| v.get(*k).is_some());
        if !has_section {
            return Err("备份文件里没有任何可恢复的内容（rules / clock / points / settings 全缺）".into());
        }
        let doc: Doc = serde_json::from_value(v).map_err(|e| format!("备份结构不认识：{e}"))?;
        return Ok(Parsed { doc, legacy: None });
    }
    // 老格式：payload 就是 Config（有 settings，且规则键叫 rules 或 lists）
    if v.get("settings").is_some() && (v.get("rules").is_some() || v.get("lists").is_some()) {
        let c: Config =
            serde_json::from_value(v).map_err(|e| format!("备份内容解析失败：{e}"))?;
        return Ok(Parsed {
            doc: Doc::from_config(&c),
            legacy: Some(c),
        });
    }
    Err("这不是 King Of Focus 的备份内容".into())
}

/// 文档的「字段签名」：每个键的路径 + 类型，按路径排序、一行一个。
///
/// 为什么需要它：只对比 "能不能读" 是不够的——一端悄悄少写一个键，另一端
/// 照样能用默认值读出来，于是"两端的备份结构一致"就成了一句自我安慰。
/// 签名把每个键钉在纸面上：桌面与手机各有一条测试，拿自己导出的文档去比
/// `tools/fixtures/portable-shape.txt`，少一个键、多一个键、类型变了，立刻红。
///
/// 数组统一记成 `path[]`，元素是对象/数组时继续往里走（同一个数组里的
/// 多个元素取并集），所以签名与"这次数据里有几条"无关。
pub fn shape(v: &Value) -> String {
    let mut out = std::collections::BTreeSet::new();
    walk(v, "", &mut out);
    out.into_iter().collect::<Vec<_>>().join("\n")
}

fn walk(v: &Value, path: &str, out: &mut std::collections::BTreeSet<String>) {
    match v {
        Value::Object(m) => {
            for (k, x) in m {
                let p = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
                walk(x, &p, out);
            }
        }
        Value::Array(a) => {
            out.insert(format!("{path}[]"));
            let p = format!("{path}[]");
            for x in a {
                match x {
                    Value::Object(_) | Value::Array(_) => walk(x, &p, out),
                    other => {
                        out.insert(format!("{p}:{}", type_of(other)));
                    }
                }
            }
        }
        other => {
            out.insert(format!("{path}:{}", type_of(other)));
        }
    }
}

fn type_of(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// 规则的"内容指纹"：只认 名称 + 模式 + 名单。
///
/// 刻意**不含**时段、颜色、固化这些"外观/强度"字段：
/// 合并要做的是"这条规则有没有"的判断题，同一份名单 + 同一个名字就是同一条，
/// 时段不同只说明两边排班不一样，不该因此多出一条一模一样的规则。
///
/// 手机端有一份逐字对应的实现（Portable.kt `sig`），改这里必须同步改那边。
pub fn sig(r: &Rule) -> String {
    let mut apps: Vec<String> = r
        .apps
        .iter()
        .map(|a| a.value.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    apps.sort();
    apps.dedup();
    let mut sites: Vec<String> = r
        .sites
        .iter()
        .map(|s| s.pattern.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    sites.sort();
    sites.dedup();
    format!(
        "{}|{}|{}|{}",
        r.name.trim().to_lowercase(),
        r.mode.trim(),
        apps.join(","),
        sites.join(",")
    )
}

/// 给冲突规则起一个不重名的名字
fn unique_name(taken: &[Rule], base: &str, lang: &str) -> String {
    let base = base.trim();
    let base = if base.is_empty() { "未命名" } else { base };
    let tag = if lang == "en" { " (from backup)" } else { "（来自备份）" };
    let mut cand = format!("{base}{tag}");
    let mut n = 2;
    while taken.iter().any(|r| r.name.trim() == cand) {
        cand = if lang == "en" {
            format!("{base} (from backup {n})")
        } else {
            format!("{base}（来自备份 {n}）")
        };
        n += 1;
        if n > MAX_RULES {
            break;
        }
    }
    cand
}

/// 规则归一化：补 id、去重 id、裁掉超量、丢掉完全空白的条目
fn normalize_rules(list: &[Rule]) -> Vec<Rule> {
    let mut out: Vec<Rule> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for r in list.iter() {
        if out.len() >= MAX_RULES {
            break;
        }
        let mut r = r.clone();
        r.name = r.name.trim().to_string();
        if r.name.is_empty() {
            r.name = "未命名".into();
        }
        r.id = r.id.trim().to_string();
        if r.id.is_empty() {
            r.id = next_id(&ids);
        }
        if ids.iter().any(|x| *x == r.id) {
            // id 撞车：换一个，别让两条规则互相覆盖（前端一律按 id 定位）
            r.id = next_id(&ids);
        }
        ids.push(r.id.clone());
        if r.schedule.len() != 7 {
            r.schedule.resize(7, Vec::new());
        }
        out.push(r);
    }
    out
}

fn next_id(taken: &[String]) -> String {
    for n in 1..=(MAX_RULES + 1) {
        let cand = format!("bk{n}");
        if !taken.iter().any(|x| *x == cand) {
            return cand;
        }
    }
    "bk".into()
}

/// 主机名（写进文档，界面上显示"这份备份来自哪台机器"）
pub fn host_device() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "这台电脑".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AppEntry, Lock};

    fn rule(id: &str, name: &str, apps: &[&str]) -> Rule {
        Rule {
            id: id.into(),
            name: name.into(),
            enabled: true,
            mode: "blacklist".into(),
            apps: apps
                .iter()
                .map(|v| AppEntry {
                    id: String::new(),
                    kind: "exe".into(),
                    value: (*v).into(),
                    label: String::new(),
                })
                .collect(),
            sites: vec![],
            exceptions: vec![],
            schedule: vec![vec![]; 7],
            lock: Lock::default(),
            color: "#ff9f43".into(),
            extra_protected: vec![],
            brk: BreakCfg::default(),
            hard: true,
            autolaunch: AutoLaunchCfg::default(),
        }
    }

    #[test]
    fn config_roundtrip_keeps_rules_and_clock() {
        let mut c = Config::default();
        c.rules = vec![rule("a", "娱乐", &["D:/games/x.exe"]), rule("b", "工作", &["C:/w.exe"])];
        c.settings.focus_clock.enabled = true;
        c.points.balance = 42;
        let doc = Doc::from_config(&c);
        let text = doc.render().unwrap();
        let back = parse(&text).unwrap();
        assert!(back.legacy.is_none(), "新格式不该被当成老格式");
        assert_eq!(back.doc.rules.len(), 2);
        assert_eq!(back.doc.points.balance, 42);
        let out = back.doc.to_config(&c);
        assert_eq!(out.rules.len(), 2);
        assert_eq!(out.rules[1].name, "工作");
        assert!(out.settings.focus_clock.enabled);
    }

    #[test]
    fn legacy_config_text_is_recognised() {
        let mut c = Config::default();
        c.rules = vec![rule("seed", "旧规则", &["a.exe"])];
        let text = serde_json::to_string(&c).unwrap();
        let p = parse(&text).unwrap();
        assert!(p.legacy.is_some(), "老格式必须走整份覆盖");
        assert_eq!(p.doc.rules.len(), 1);
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(parse("not json").is_err());
        assert!(parse(r#"{"hello":1}"#).is_err());
        // 未来 schema 要明确拒绝，而不是读一半乱掉
        let mut d = Doc::default();
        d.schema = SCHEMA + 1;
        let t = serde_json::to_string(&d).unwrap();
        assert!(parse(&t).is_err());
    }

    /// 合并 = 加法：同 id 跳过、同内容跳过、同名不同内容改名并列
    #[test]
    fn merge_is_additive_and_dedups() {
        let mut local = Config::default();
        local.rules = vec![rule("a", "娱乐", &["x.exe"])];

        let mut src = Config::default();
        src.rules = vec![
            rule("a", "娱乐（被改过）", &["x.exe", "y.exe"]), // 同 id → 跳过
            rule("b", "娱乐", &["x.exe"]),                   // 同内容 → 跳过
            rule("c", "娱乐", &["z.exe"]),                   // 同名不同内容 → 冲突
            rule("d", "学习", &["w.exe"]),                   // 新规则 → 追加
        ];
        let doc = Doc::from_config(&src);
        let (out, st) = doc.merge(&local);
        assert_eq!(st.skipped, 2, "同 id / 同内容都要跳过");
        assert_eq!(st.conflict, 1);
        assert_eq!(st.added, 1);
        assert_eq!(out.rules.len(), 3);
        // 本机那条一个字都没被改
        assert_eq!(out.rules[0].name, "娱乐");
        assert_eq!(out.rules[0].apps.len(), 1);
        // 冲突那条改了名
        assert!(out.rules[1].name.contains("来自备份"), "{}", out.rules[1].name);
        assert_eq!(out.rules[2].name, "学习");
    }

    #[test]
    fn merge_repeats_are_idempotent() {
        let mut local = Config::default();
        local.rules.clear(); // 只看这次合并的结果，别让内置的示例规则混进来
        let mut src = Config::default();
        src.rules = vec![rule("a", "娱乐", &["x.exe"])];
        let doc = Doc::from_config(&src);
        let (once, st1) = doc.merge(&local);
        assert_eq!(st1.added, 1);
        assert_eq!(once.rules.len(), 1);
        let (twice, st2) = doc.merge(&once);
        assert_eq!(st2.added, 0, "同一份备份导入两次不该翻倍");
        assert_eq!(twice.rules.len(), 1);
    }

    /// 时段合并：本机没选的补上，本机选了的保持原样
    #[test]
    fn merge_fills_only_empty_hours() {
        let mut local = Config::default();
        let li = local
            .settings
            .focus_clock
            .profiles
            .iter()
            .position(|p| p.id == local.settings.focus_clock.active)
            .unwrap();
        local.settings.focus_clock.profiles[li].days[0][9] = HourPlan {
            on: true,
            work: 50,
            brk: 10,
            from: 0,
            to: 60,
            seg: String::new(),
            wins: vec![],
        };

        let mut src = Config::default();
        let si = src
            .settings
            .focus_clock
            .profiles
            .iter()
            .position(|p| p.id == src.settings.focus_clock.active)
            .unwrap();
        // 09:00 与 10:00 都开着，但番茄参数不同
        for h in [9usize, 10] {
            src.settings.focus_clock.profiles[si].days[0][h] = HourPlan {
                on: true,
                work: 30,
                brk: 30,
                from: 0,
                to: 60,
                seg: String::new(),
                wins: vec![],
            };
        }
        let (out, st) = Doc::from_config(&src).merge(&local);
        assert_eq!(st.slots, 1, "只该补 10:00 这一个小时");
        let oi = out
            .settings
            .focus_clock
            .profiles
            .iter()
            .position(|p| p.id == out.settings.focus_clock.active)
            .unwrap();
        assert_eq!(out.settings.focus_clock.profiles[oi].days[0][9].work, 50, "本机已选的不能改");
        assert_eq!(out.settings.focus_clock.profiles[oi].days[0][10].work, 30, "空着的要补上");
    }

    #[test]
    fn merge_points_take_max_not_sum() {
        let mut local = Config::default();
        local.points.balance = 10;
        let mut src = Config::default();
        src.points.balance = 7;
        let (out, _) = Doc::from_config(&src).merge(&local);
        assert_eq!(out.points.balance, 10, "合并不能把余额变成 17");
        src.points.balance = 30;
        let (out2, _) = Doc::from_config(&src).merge(&local);
        assert_eq!(out2.points.balance, 30, "备份里更多时取更大的");
    }

    /// 覆盖不该动平台专属设置（遮罩 / HUD / 端口这类手机根本表达不了的东西）
    #[test]
    fn overwrite_keeps_native_settings() {
        let mut local = Config::default();
        local.settings.mask.media_pause = true;
        local.settings.hud.offset_x = 123;
        local.settings.port = 45678;
        local.settings.notify.focus_window = true;

        let mut src = Config::default();
        src.rules = vec![rule("z", "从备份来", &["q.exe"])];
        src.settings.notify.enabled = false;

        let out = Doc::from_config(&src).to_config(&local);
        assert!(out.settings.mask.media_pause, "遮罩设置要被保留");
        assert_eq!(out.settings.hud.offset_x, 123);
        assert_eq!(out.settings.port, 45678);
        assert!(out.settings.notify.focus_window, "桌面专属的提醒项要保留");
        assert!(!out.settings.notify.enabled, "共用的提醒开关要被换掉");
        assert_eq!(out.rules.len(), 1);
    }

    /// 空 id 的规则要补 id，重复 id 要换掉 —— 否则前端会同时改到两条
    #[test]
    fn ids_are_repaired() {
        let mut src = Config::default();
        src.rules = vec![rule("", "A", &["a"]), rule("", "B", &["b"]), rule("x", "C", &["c"]), rule("x", "D", &["d"])];
        let out = Doc::from_config(&src).to_config(&Config::default());
        let ids: Vec<&str> = out.rules.iter().map(|r| r.id.as_str()).collect();
        assert!(ids.iter().all(|i| !i.is_empty()));
        let mut uniq = ids.clone();
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(uniq.len(), ids.len(), "id 必须唯一：{ids:?}");
    }

    /// 两端共用的样例文件：这里必须能读，手机端测试读同一份。
    /// 统计摘要：收下的规则（新、非空、不是自己导出的）
    #[test]
    fn stats_are_adopted_only_when_newer_and_not_mine() {
        let base = Config::default();
        let mut doc = Doc::default();
        doc.stats = Some(PeerStats {
            schema: 1,
            source: "android".into(),
            device: "Pixel".into(),
            at: 100,
            days: vec![PeerDay {
                day: "2026-11-01".into(),
                total: 3600,
                on: 1800,
                top: vec![PeerApp {
                    name: "微信".into(),
                    secs: 1200,
                }],
            }],
        });

        let out = doc.to_config(&base);
        assert_eq!(out.settings.peer_stats.days.len(), 1);
        assert_eq!(out.settings.peer_stats.last_days(7), (3600, 1800));

        // 更旧的不覆盖
        let mut older = doc.clone();
        older.stats.as_mut().unwrap().at = 50;
        let out2 = older.to_config(&out);
        assert_eq!(out2.settings.peer_stats.at, 100, "旧摘要不该覆盖新摘要");

        // 自己导出的不收（同一台机器恢复自己的备份）
        let mut mine = doc.clone();
        mine.stats.as_mut().unwrap().source = "desktop".into();
        mine.stats.as_mut().unwrap().device = host_device();
        assert!(
            mine.to_config(&Config::default()).settings.peer_stats.is_empty(),
            "自己导出的不该显示成「另一台设备」"
        );

        // 空的不收
        let mut empty = doc.clone();
        empty.stats.as_mut().unwrap().days.clear();
        assert!(empty
            .to_config(&Config::default())
            .settings
            .peer_stats
            .is_empty());
    }

    /// 合并模式也要收摘要，但绝不碰本机的规则与时段
    #[test]
    fn merge_takes_stats_without_touching_rules() {
        let mut doc = Doc::default();
        doc.stats = Some(PeerStats {
            schema: 1,
            source: "android".into(),
            device: "Pixel".into(),
            at: 500,
            days: vec![PeerDay {
                day: "2026-11-01".into(),
                total: 60,
                on: 30,
                top: vec![],
            }],
        });
        let base = Config::default();
        let (out, _st) = doc.merge(&base);
        assert_eq!(out.settings.peer_stats.days.len(), 1);
        assert_eq!(out.rules.len(), base.rules.len(), "合并不会动本机规则");
    }

    /// 桌面排好「当天」之后，另一端应用出来必须**一模一样**。
    ///
    /// 这份样例是两端共用的（Android 的 `PortableTest` 读同一个文件）：
    /// 只要有一端把字段名改了，这条就会红——这正是"两端配置不一致"最省事的保险。
    #[test]
    fn desktop_day_fixture_applies_clock_rules_and_stats() {
        let text = include_str!("../../tools/fixtures/portable-desktop-day.json");
        let p = parse(text).expect("样例必须是合法的新格式");
        let base = Config::default();
        let out = p.doc.to_config(&base);

        // —— 时段：周一 09:00–12:00，25/5，每小时休息上限 15 ——
        let prof = out
            .settings
            .focus_clock
            .profiles
            .iter()
            .find(|x| x.id == "p-day")
            .expect("方案要一起搬过来");
        assert_eq!(prof.name, "当天");
        assert_eq!(prof.def_work, 25);
        assert_eq!(prof.def_brk, 5);
        assert_eq!(prof.def_cap, 15, "每小时休息上限也要带过来");
        assert_eq!(prof.bound, vec!["r-work".to_string()], "方案绑定的规则不能丢");
        for h in 9..12 {
            assert!(prof.days[0][h].on, "周一 {h} 点应该是选中的");
            assert_eq!(prof.days[0][h].work, 25);
            assert_eq!(prof.days[0][h].brk, 5);
        }
        assert!(!prof.days[0][8].on, "8 点没选，不能凭空多出来");
        assert!(!prof.days[0][12].on, "12 点没选，不能凭空多出来");
        assert!(!prof.days[1][9].on, "周二不该被周一的排班溅到");
        assert_eq!(out.settings.focus_clock.active, "p-day");
        assert_eq!(out.settings.focus_clock.granularity, 15);

        // —— 规则：白名单 + 绑定 ——
        assert_eq!(out.rules.len(), 1);
        assert_eq!(out.rules[0].name, "工作类");
        assert_eq!(out.rules[0].mode, "whitelist");
        assert_eq!(out.rules[0].apps.len(), 1);

        // —— 统计摘要 ——
        assert_eq!(out.settings.peer_stats.days.len(), 2);
        assert_eq!(out.settings.peer_stats.last_days(7), (9000, 4500));
        assert_eq!(out.settings.peer_stats.source, "desktop");
    }

    #[test]
    fn shared_fixture_parses() {
        let text = include_str!("../../tools/fixtures/portable-v1.json");
        let p = parse(text).expect("样例必须是合法的新格式");
        assert!(p.legacy.is_none());
        assert_eq!(p.doc.rules.len(), 2);
        assert_eq!(p.doc.rules[0].name, "夜间自律");
        assert_eq!(p.doc.rules[0].apps.len(), 1);
        assert_eq!(p.doc.rules[1].sites.len(), 1, "网站条目也要能带过来");
        assert!(p.doc.clock.enabled);
        assert_eq!(p.doc.points.balance, 120);
        assert_eq!(p.doc.settings.lang, "zh-CN");
        // 手机端写的那份也一样能读
        let phone = include_str!("../../tools/fixtures/portable-android.json");
        let q = parse(phone).expect("手机端样例必须能读");
        assert_eq!(q.doc.source, "android");
        assert_eq!(q.doc.rules.len(), 1);
        assert_eq!(q.doc.rules[0].apps[0].kind, "pkg");
        // 手机产的文件在桌面端落地后，规则不能变成"什么都没拦"
        let out = q.doc.to_config(&Config::default());
        assert_eq!(out.rules.len(), 1);
        assert_eq!(out.rules[0].apps[0].value, "com.example.doomscroll");
    }

    // ------------------------------------------------------------ 两端同构

    /// 一份"什么都有"的配置：用来生成跨端参考文档（canon）。
    ///
    /// 刻意把每个可选分支都填上（多段窗口、方案绑定、网站例外、锁机文案、
    /// 自动打开、统计摘要），这样导出的文档里每个键都会出现一次，
    /// `portable-shape.txt` 才是完整的签名，而不是"这次碰巧没写那几个键"。
    fn rich_config() -> Config {
        let mut c = Config::default();
        c.settings.lang = "en".into();
        c.settings.theme = "dark".into();
        c.settings.notify.enabled = true;
        c.settings.notify.work_before = 7;
        c.settings.notify.break_before = 3;
        c.settings.notify.break_notify = false;
        c.settings.notify.focus_window = true;
        c.points.balance = 120;
        c.points.total_earned = 300;
        c.points.unlock_until = 1_793_600_000;
        c.points.sleep_unlock_until = 1_793_700_000;
        c.points.unlock_count_today = 2;
        c.points.day = "2026-11-01".into();

        let mut r1 = rule("r-work", "工作类", &["D:/Apps/code.exe"]);
        r1.mode = "whitelist".into();
        r1.apps.push(AppEntry {
            id: "a2".into(),
            kind: "pkg".into(),
            value: "com.tencent.mm".into(),
            label: "微信".into(),
        });
        r1.schedule[0] = vec![Slot { start: 540, end: 720 }];
        r1.color = "#4dabf7".into();
        r1.extra_protected = vec!["explorer.exe".into()];
        r1.brk = BreakCfg { kind: "pomodoro".into(), work_min: 50, break_min: 10 };
        r1.lock = Lock { kind: "text".into(), until: 0, password: String::new(), chars: 12 };
        r1.autolaunch = AutoLaunchCfg {
            enabled: true,
            items: vec![LaunchItem {
                id: "l1".into(),
                kind: "app".into(),
                target: "D:/Apps/code.exe".into(),
                args: String::new(),
                window: "max".into(),
                browser: String::new(),
            }],
        };
        let mut r2 = rule("r-night", "夜间自律", &[]);
        r2.sites = vec![SiteEntry {
            id: "s1".into(),
            pattern: "*.bilibili.com".into(),
            label: "B 站".into(),
        }];
        r2.exceptions = vec!["*.bilibili.com/learn".into()];
        c.rules = vec![r1, r2];

        // 两套方案：一套有排班（还含"一小时两段"），一套空着
        let mut p1 = ClockProfile::default();
        p1.id = "p-work".into();
        p1.name = "工作日".into();
        p1.def_work = 25;
        p1.def_brk = 5;
        p1.def_cap = 15;
        p1.bound = vec!["r-work".into()];
        for h in 9..12usize {
            p1.days[0][h] = HourPlan {
                on: true,
                work: 25,
                brk: 5,
                from: 0,
                to: 60,
                seg: "s-morning".into(),
                wins: vec![],
            };
        }
        p1.days[2][14] = HourPlan {
            on: true,
            work: 30,
            brk: 10,
            from: 0,
            to: 60,
            seg: String::new(),
            wins: vec![
                HourWin { from: 0, to: 15, seg: "s-a".into() },
                HourWin { from: 30, to: 45, seg: "s-b".into() },
            ],
        };
        let mut p2 = ClockProfile::default();
        p2.id = "p-weekend".into();
        p2.name = "周末".into();
        p2.def_work = 45;
        p2.def_brk = 15;
        c.settings.focus_clock.enabled = true;
        c.settings.focus_clock.granularity = 15;
        c.settings.focus_clock.active = "p-work".into();
        c.settings.focus_clock.profiles = vec![p1, p2];
        c
    }

    fn rich_doc() -> Doc {
        let mut d = Doc::from_config(&rich_config());
        d.stats = Some(PeerStats {
            schema: 1,
            source: "android".into(),
            device: "Pixel".into(),
            at: 1_793_510_000,
            days: vec![PeerDay {
                day: "2026-11-01".into(),
                total: 7200,
                on: 3600,
                top: vec![PeerApp { name: "微信".into(), secs: 1800 }],
            }],
        });
        d
    }

    /// 一次性工具：生成两端共用的参考文档与字段签名。
    ///
    /// 跑法：`cargo test --offline __gen_canon_fixture -- --ignored`
    /// **改了 `Doc` / `Rule` / `ClockCfg` 的字段之后要重跑它**，否则两端那条
    /// `export_shape_matches_reference` 会红——这正是它存在的意义。
    #[test]
    #[ignore]
    fn __gen_canon_fixture() {
        let d = rich_doc();
        let json = d.render().unwrap();
        std::fs::write("../tools/fixtures/portable-canon.json", &json).unwrap();
        let shape = shape(&d.to_value().unwrap());
        std::fs::write("../tools/fixtures/portable-shape.txt", shape + "\n").unwrap();
    }

    /// 桌面端导出的文档必须与参考签名**逐键一致**。
    ///
    /// 手机端 `PortableTest.exportShapeMatchesReference` 比的是同一份文件：
    /// 两端各自"对着同一把尺子量自己"，传递下去就等于两端互相比对。
    #[test]
    fn export_shape_matches_reference() {
        // 归一化行尾：Windows 上 core.autocrlf=true（Git for Windows 默认）会把样例
        // 检出成 CRLF，而 shape() 用 "\n" 拼接 —— 不处理的话这条断言在 Windows
        // 上永远失败，等于发版自检直接失效。
        let want = include_str!("../../tools/fixtures/portable-shape.txt").replace("\r\n", "\n");
        let got = shape(&rich_doc().to_value().unwrap());
        assert_eq!(got, want.trim_end(), "导出的字段集合变了；改字段就该同步参考样例与两端实现");
    }

    /// 参考文档本身必须能被解析，并且解析回来的形状不变（读写对称）
    #[test]
    fn canon_fixture_roundtrips_to_same_shape() {
        let text = include_str!("../../tools/fixtures/portable-canon.json");
        let p = parse(text).expect("参考文档必须合法");
        let again = p.doc.to_value().unwrap();
        assert_eq!(shape(&again), shape(&serde_json::from_str::<Value>(text).unwrap()));
    }

    /// 空串 = "这台设备没有这个概念"：不能把对端的语言/配色改回默认值。
    ///
    /// 手机端没有语言切换，导出时写的是 `lang: ""` / `theme: ""`。
    /// 以前它硬写 `zh-CN` / `system`，于是桌面用户把界面调成英文 + 深色之后，
    /// 只要恢复一次手机备份就被"一键还原"，用户会以为自己的设置被吃了。
    #[test]
    fn empty_lang_and_theme_keep_local_values() {
        let mut local = Config::default();
        local.settings.lang = "en".into();
        local.settings.theme = "dark".into();
        local.points.unlock_count_today = 3;
        local.points.day = "2026-11-01".into();

        let mut d = Doc::default();
        d.settings.lang = String::new();
        d.settings.theme = String::new();
        d.settings.notify = None;
        d.rules = vec![rule("x", "手机规则", &["com.a.b"])];

        let out = d.to_config(&local);
        assert_eq!(out.settings.lang, "en", "手机没有语言概念，不能改本机的");
        assert_eq!(out.settings.theme, "dark");
        assert!(out.settings.notify.enabled, "文档没带提醒设置时本机不动");
        assert_eq!(out.points.unlock_count_today, 3, "本机记账不跟着备份走");
        assert_eq!(out.rules.len(), 1, "规则照常覆盖");
    }
}
