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
//!   "source": "desktop",         // desktop | android
//!   "device": "DESKTOP-XXXX",
//!   "appVersion": "0.1.51",
//!   "rules":   [ { id, name, enabled, mode, apps[], sites[], ... } ],
//!   "clock":   { enabled, applyRules, granularity, active, profiles[{ id, name, days[7][24] }] },
//!   "points":  { balance, totalEarned, unlockUntil, ... },
//!   "settings":{ lang, theme, notify{...} }
//! }
//! ```
//!
//! 三条硬约束（两端实现必须一致，否则"互通"就是一句空话）：
//! 1. **只读自己认识的字段**：多出来的键一律忽略，缺的键一律用默认值。
//!    这样任何一端升级加了字段，另一端不会因此报错。
//! 2. **覆盖 = 文档里的都换掉，文档里没有的不动**。平台专属设置
//!    （桌面的遮罩 / HUD / 端口、手机的拦截页文案）不在文档里，所以
//!    不会被另一端的备份擦掉。
//! 3. **合并只做加法**：绝不改写本机已有的规则与时段，只补缺的；
//!    同 id 或同内容视为"已存在"跳过，同名不同内容才改名并列并计入冲突。

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
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PtSettings {
    /// zh-CN | en
    pub lang: String,
    /// system | dark | light
    pub theme: String,
    pub notify: NotifyCfg,
}

impl Default for PtSettings {
    fn default() -> Self {
        PtSettings {
            lang: "zh-CN".into(),
            theme: "system".into(),
            notify: NotifyCfg::default(),
        }
    }
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
    pub points: Points,
    pub settings: PtSettings,
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
            points: Points::default(),
            settings: PtSettings::default(),
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
            points: c.points.clone(),
            settings: PtSettings {
                lang: c.settings.lang.clone(),
                theme: c.settings.theme.clone(),
                notify: c.settings.notify.clone(),
            },
        }
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

    /// **覆盖模式**：文档里有的统统换掉，文档里没有的本机设置原样保留。
    pub fn to_config(&self, base: &Config) -> Config {
        let mut out = base.clone();
        out.rules = normalize_rules(&self.rules);
        out.settings.focus_clock = self.clock.clone();
        out.points = self.points.clone();
        if matches!(self.settings.lang.as_str(), "zh-CN" | "en") {
            out.settings.lang = self.settings.lang.clone();
        }
        if matches!(self.settings.theme.as_str(), "system" | "dark" | "light") {
            out.settings.theme = self.settings.theme.clone();
        }
        // 提醒：只搬共用的这几项，"提醒时把窗口拉到前台"是桌面专属
        let focus_window = out.settings.notify.focus_window;
        out.settings.notify = self.settings.notify.clone();
        out.settings.notify.focus_window = focus_window;
        crate::cfg::sanitize(&mut out);
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
        let doc: Doc = serde_json::from_value(v).map_err(|e| format!("备份结构不认识：{e}"))?;
        if doc.schema > SCHEMA {
            return Err(format!(
                "这份备份来自更新的版本（schema {}），请先升级本软件再恢复",
                doc.schema
            ));
        }
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
}
