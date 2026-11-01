//! 首用向导。
//!
//! 为什么需要它：装完之后软件是"空"的——没有时段、没有规则，界面上十几个页面
//! 每个都能点，但用户不知道**先做哪一件**。多数人在这一步流失，而不是因为功能不够。
//!
//! 所以这里只做三件事，而且**都用既有通道**，不新造一套数据：
//!   1. 几点学 → 写一套 `ClockProfile`（就是「自律时段」页里那套结构）；
//!   2. 哪些不该开 → 写一条 `Rule`（就是「自律规则」页里那一条）；
//!   3. 现在就试 25 分钟 → 写一套**一次性**的时段方案，到点自动删掉并还原。
//!
//! 第三条最容易做歪：如果为了"试用"就永久改掉用户的排班，那就是 bug。
//! 所以试用方案有固定 id、有结束时间、由后台每拍自愈清理——程序关掉再打开也能收干净。

use crate::model::{AppEntry, ClockProfile, Config, HourPlan, Rule};
use crate::shared::Shared;
use chrono::{Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 向导写出来的方案 / 规则的固定 id（重走一遍时是覆盖，不是堆积）
pub const PROFILE_ID: &str = "onboard-profile";
pub const RULE_ID: &str = "onboard-rule";
/// 试用用的临时方案 id
pub const TRIAL_ID: &str = "onboard-trial";

/// 一次性试用：`until` 之后由 `tick_trial` 收尾
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Trial {
    /// 试用之前生效的方案 id（结束后还原）
    pub prev_active: String,
    /// 结束时刻（unix 秒）
    pub until: i64,
    /// 试用之前「自律时段」总开关的状态（默认开，老数据缺这个键也说得通）
    #[serde(default = "default_true")]
    pub prev_clock_enabled: bool,
    /// 试用之前「跟随自律模式自动开遮罩」的状态
    #[serde(default = "default_true")]
    pub prev_follow: bool,
}

fn default_true() -> bool {
    true
}

fn clamp_hour(h: u32) -> u32 {
    h.min(23)
}

/// 把「周几 + 几点到几点」写成一套 7×24 的方案
fn build_profile(days: &[u32], from_hour: u32, to_hour: u32, work: u32, brk: u32) -> ClockProfile {
    let (a, b) = (clamp_hour(from_hour), clamp_hour(to_hour).max(clamp_hour(from_hour) + 1));
    let mut grid = vec![vec![HourPlan::default(); 24]; 7];
    // 整段共用一个 seg：用户心里"这一段"是连着的，中途断开就不是一段
    let seg = "onboard-seg";
    for &wd in days {
        if wd > 6 {
            continue;
        }
        for h in a..b {
            grid[wd as usize][h as usize] = HourPlan {
                on: true,
                work,
                brk,
                from: 0,
                to: 60,
                seg: seg.into(),
                wins: Vec::new(),
            };
        }
    }
    ClockProfile {
        id: PROFILE_ID.into(),
        name: "开始用的时段".into(),
        days: grid,
        def_work: work,
        def_brk: brk,
        def_cap: 0,
        bound: Vec::new(),
    }
}

/// 向导建的那条规则（抽出来是为了能用单测钉住 `hard = false`）
///
/// **不能固化**：`Rule::default()` 的 `hard` 是 true，而写给新手的规则一旦固化，
/// 到了点连关都关不掉（新用户还没有积分可解锁）——那不是自律，是陷阱。
pub fn build_rule(apps: Vec<AppEntry>) -> Rule {
    let mut r = Rule { id: RULE_ID.into(), name: "开始时选的".into(), ..Rule::default() };
    r.enabled = true;
    r.mode = "blacklist".into();
    r.apps = apps;
    r.color = "gold".into();
    r.hard = false;
    r
}

fn save_cfg(shared: &Shared, mut c: Config) -> Result<(), String> {
    crate::cfg::sanitize(&mut c);
    c.updated_at = Local::now().timestamp();
    crate::cfg::save(&c)?;
    if let Ok(mut w) = shared.cfg.write() {
        *w = c;
    }
    Ok(())
}

/// 向导最后一步：写时段 + 写规则，并标记"走过了"。
///
/// `apps` 是 exe 路径列表（桌面端规则条目就是路径）；空 = 这一步跳过。
pub fn apply(
    shared: &Shared,
    days: Vec<u32>,
    from_hour: u32,
    to_hour: u32,
    apps: Vec<String>,
) -> Result<Value, String> {
    if crate::sleep::is_locked(shared) {
        return Err("睡眠时段锁定中，现在改不了设置".into());
    }
    let mut c = shared.config();

    // 1) 时段
    let prof = build_profile(&days, from_hour, to_hour, 25, 5);
    match c.settings.focus_clock.profiles.iter_mut().find(|p| p.id == PROFILE_ID) {
        Some(p) => *p = prof,
        None => {
            // 用户原本有一套"默认时段"但一格都没排时，直接替换掉：
            // 留着两套空方案只会让人在「自律时段」页上多按一次切换。
            let only_empty = c.settings.focus_clock.profiles.len() == 1
                && c.settings.focus_clock.profiles[0]
                    .days
                    .iter()
                    .flatten()
                    .all(|h| !h.on);
            if only_empty {
                c.settings.focus_clock.profiles[0] = prof;
            } else {
                c.settings.focus_clock.profiles.push(prof);
            }
        }
    }
    // 两条路（覆盖 / 替换唯一的空方案）最后都落在同一个 id 上，直接写死更不容易看错
    c.settings.focus_clock.active = PROFILE_ID.into();
    c.settings.focus_clock.enabled = true;
    c.settings.focus_clock.apply_rules = true;

    // 2) 规则（这一步可以空）
    let list: Vec<AppEntry> = apps
        .into_iter()
        .filter(|x| !x.trim().is_empty())
        .map(|p| AppEntry {
            id: String::new(),
            kind: "exe".into(),
            label: crate::proc::stem(&p),
            value: p,
        })
        .collect();
    if !list.is_empty() {
        let r = build_rule(list);
        match c.rules.iter_mut().find(|x| x.id == RULE_ID) {
            Some(x) => *x = r,
            None => c.rules.push(r),
        }
    }

    // 3) 让"到点就盖遮罩"这件事真的发生：不打开这个，用户排完班什么都看不到
    c.settings.mask.follow_schedule = true;
    // 走过了，以后不再自动弹
    c.settings.onboarded = Some(true);

    save_cfg(shared, c)?;
    crate::mask::wake();
    // 排班变了：总览的"现在/下一段"要立刻跟着变，不能等 20 秒缓存过期
    crate::focus::brief_invalidate();
    Ok(plan_summary(&shared.config()))
}

/// 试用 25 分钟（可调）：写一套一次性方案，到点由 `tick_trial` 删掉并还原。
pub fn trial(shared: &Shared, minutes: u32) -> Result<Value, String> {
    if crate::sleep::is_locked(shared) {
        return Err("睡眠时段锁定中".into());
    }
    let m = minutes.clamp(5, 120) as i64;
    let now = Local::now();
    let until = now.timestamp() + m * 60;
    let mut c = shared.config();

    // 上一套正在生效的方案：结束后要还回去
    let prev = if c.settings.focus_clock.active.is_empty() {
        c.settings.focus_clock.profiles.first().map(|p| p.id.clone()).unwrap_or_default()
    } else {
        c.settings.focus_clock.active.clone()
    };

    // 从"现在这一分钟"到 +m 分钟：可能跨小时、跨天，逐分钟铺
    let mut grid = vec![vec![HourPlan::default(); 24]; 7];
    let seg = "onboard-trial-seg";
    let mut t = now;
    loop {
        let wd = t.weekday().num_days_from_monday() as usize;
        let h = t.hour() as usize;
        let start_min = t.minute();
        // 这一小时的结束边界：要么整点，要么试用结束时刻
        let hour_end_ts = (t + chrono::Duration::minutes(60 - start_min as i64))
            .with_minute(0)
            .and_then(|x| x.with_second(0))
            .and_then(|x| x.with_nanosecond(0));
        let mut end_min = 60u32;
        if let Some(he) = hour_end_ts {
            if he.timestamp() > until {
                end_min = start_min + ((until - t.timestamp()) / 60) as u32;
            }
        }
        let cell = &mut grid[wd][h];
        // 同一小时可能被铺两次（跨天/重复），用 wins 保住多段
        if cell.on && cell.from == 0 && cell.to == 60 {
            // 已经整小时覆盖，不重复加
        } else {
            cell.on = true;
            cell.work = 25;
            cell.brk = 5;
            cell.from = start_min;
            cell.to = end_min.min(60).max(start_min + 1);
            cell.seg = seg.into();
            cell.wins = Vec::new();
        }
        let next = t + chrono::Duration::minutes((end_min.saturating_sub(start_min)) as i64);
        if next.timestamp() >= until || end_min >= 60 {
            break;
        }
        t = next;
        if t.timestamp() >= until {
            break;
        }
    }

    let prof = ClockProfile {
        id: TRIAL_ID.into(),
        name: "试用 25 分钟".into(),
        days: grid,
        def_work: 25,
        def_brk: 5,
        def_cap: 0,
        bound: Vec::new(),
    };
    match c.settings.focus_clock.profiles.iter_mut().find(|p| p.id == TRIAL_ID) {
        Some(p) => *p = prof,
        None => c.settings.focus_clock.profiles.push(prof),
    }
    c.settings.focus_clock.active = TRIAL_ID.into();
    // 试用要真的生效，所以这两项临时打开；**原来的状态记下来，结束时放回去**。
    // 不放回去的话，本来关着自律在试用的用户，试完会突然开始被拦。
    let prev_clock_enabled = c.settings.focus_clock.enabled;
    let prev_follow = c.settings.mask.follow_schedule;
    c.settings.focus_clock.enabled = true;
    c.settings.mask.follow_schedule = true;
    c.settings.trial = Some(Trial {
        prev_active: prev,
        until,
        prev_clock_enabled,
        prev_follow,
    });

    save_cfg(shared, c)?;
    crate::mask::wake();
    crate::focus::brief_invalidate();
    Ok(json!({ "until": until, "minutes": m }))
}

/// 后台每拍调用：试用到点就收尾（删方案、还原 active）。
///
/// 放在循环里而不是"起一个定时器"：程序关掉再打开，这条照样能把过期试用收干净。
/// 返回值 = 这一拍真的收尾了（调用方据此说一句"试用结束，已还原"）。
///
/// 为什么要有这句话：试用结束后遮罩会自己关掉。没有任何提示的话，
/// 用户只会觉得"它自己坏了"，而不是"试用的 25 分钟到了"。
pub fn tick_trial(shared: &Shared) -> bool {
    let c = shared.config();
    let Some(t) = c.settings.trial.clone() else { return false };
    if Local::now().timestamp() < t.until {
        return false;
    }
    let mut c = c;
    c.settings.focus_clock.profiles.retain(|p| p.id != TRIAL_ID);
    if c.settings.focus_clock.active == TRIAL_ID {
        // 还回原来那套；原来的已经没了就退回第一套
        let back = if c.settings.focus_clock.profiles.iter().any(|p| p.id == t.prev_active) {
            t.prev_active.clone()
        } else {
            c.settings.focus_clock.profiles.first().map(|p| p.id.clone()).unwrap_or_default()
        };
        c.settings.focus_clock.active = back;
    }
    // 时段开关与"自动开遮罩"都还原成试用之前的样子
    c.settings.focus_clock.enabled = t.prev_clock_enabled;
    c.settings.mask.follow_schedule = t.prev_follow;
    c.settings.trial = None;
    let _ = save_cfg(shared, c);
    crate::mask::wake();
    crate::focus::brief_invalidate();
    true
}

/// 标记"走过了"（跳过）或"重来一遍"（设置页里的入口）
pub fn set_done(shared: &Shared, done: bool) -> Result<(), String> {
    let mut c = shared.config();
    c.settings.onboarded = Some(done);
    save_cfg(shared, c)
}

/// 给界面看的摘要（完成页 / 设置页都读它）
pub fn plan_summary(c: &Config) -> Value {
    let f = &c.settings.focus_clock;
    let p = f.profiles.iter().find(|x| x.id == f.active).or_else(|| f.profiles.first());

    let mut days: Vec<u32> = Vec::new();
    let mut from_hour = 24u32;
    let mut to_hour = 0u32;
    let mut minutes = 0u32;
    if let Some(p) = p {
        for (wd, row) in p.days.iter().enumerate() {
            let mut any = false;
            for (h, hp) in row.iter().enumerate() {
                if !hp.on {
                    continue;
                }
                any = true;
                from_hour = from_hour.min(h as u32);
                to_hour = to_hour.max(h as u32 + 1);
                minutes += hp.to.saturating_sub(hp.from).min(60);
            }
            if any {
                days.push(wd as u32);
            }
        }
    }
    json!({
        "enabled": f.enabled,
        "profileId": p.map(|x| x.id.clone()).unwrap_or_default(),
        "profileName": p.map(|x| x.name.clone()).unwrap_or_default(),
        "days": days,
        "fromHour": if from_hour == 24 { 0 } else { from_hour },
        "toHour": to_hour,
        "minutes": minutes,
        "ruleCount": c.rules.iter().filter(|r| r.enabled).count(),
        // None（老配置）也算走过了：不能让老用户升级后被弹一次向导
        "onboarded": c.settings.onboarded != Some(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 选中的星期与小时都要落到格子里，其余保持空
    #[test]
    fn profile_fills_only_selected_cells() {
        let p = build_profile(&[0, 2], 20, 22, 25, 5);
        for h in 20..22 {
            assert!(p.days[0][h].on, "周一 20/21 点必须选中");
            assert!(p.days[2][h].on, "周三 20/21 点必须选中");
            assert_eq!(p.days[0][h].seg, "onboard-seg", "整段共用一个 seg");
        }
        assert!(!p.days[1][20].on, "没选周二就不能开");
        assert!(!p.days[0][19].on, "区间外不能开");
        assert!(!p.days[0][22].on, "to 是开区间上界");
    }

    /// 向导建的规则**不能固化**：新手没有积分，固化等于把人锁在外面
    #[test]
    fn onboard_rule_is_never_hard() {
        let r = build_rule(vec![AppEntry {
            id: String::new(),
            kind: "exe".into(),
            value: "C:////Games////steam.exe".into(),
            label: "steam".into(),
        }]);
        assert!(!r.hard, "向导规则一旦固化，到点连关都关不掉");
        assert!(r.enabled);
        assert_eq!(r.mode, "blacklist");
        assert_eq!(r.apps.len(), 1);
        assert_eq!(r.id, RULE_ID);
    }

    /// 起止给反了 / 越界时不能写出空方案或越界方案
    #[test]
    fn profile_clamps_bad_hours() {
        let p = build_profile(&[1], 22, 22, 25, 5);
        assert!(p.days[1][22].on, "from == to 时至少保住一小时，不能写成空");
        let p2 = build_profile(&[1], 30, 99, 25, 5);
        assert!(p2.days[1][23].on, "越界的 from 被夹到 23 点");
        assert!(build_profile(&[9], 8, 9, 25, 5).days.iter().flatten().all(|h| !h.on), "非法 weekday 不能 panic");
    }
}
