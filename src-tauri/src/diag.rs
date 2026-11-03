//! 「导出诊断信息」——把排障需要的东西一次打包成一份文本。
//!
//! 用户不是开发者：让他"去 `%APPDATA%` 找日志、再把 config.json 发过来"是不现实的，
//! 而且 config.json 里还有网盘密码和更新令牌。所以这里统一做三件事：
//!   1. 只挑**排障真正需要**的字段，不整份转储；
//!   2. 凭据一律打码（网盘密码 / 备份口令 / GitHub 令牌）；
//!   3. 附上最近的日志尾巴，崩溃时还有 `crash-*.txt`。

use crate::shared::Shared;

/// 把敏感字段清空后返回一份可外发的配置副本
fn redacted(shared: &Shared) -> String {
    let mut c = shared.config();
    let mask = |s: &mut String| {
        if !s.is_empty() {
            *s = "••••（已隐藏）".into();
        }
    };
    mask(&mut c.settings.sync.password);
    mask(&mut c.settings.sync.username);
    mask(&mut c.settings.backup.password);
    mask(&mut c.settings.update.token);
    // 规则本身不敏感（只有名字和程序名），保留：判断"规则有没有生效"要看它
    serde_json::to_string_pretty(&c).unwrap_or_else(|_| "（序列化失败）".into())
}

fn fmt_ts(ts: i64) -> String {
    if ts <= 0 {
        return "—".into();
    }
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| {
            d.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string()
        })
        .unwrap_or_else(|| ts.to_string())
}

pub fn report(shared: &Shared) -> String {
    let c = shared.config();
    let rt = shared.rt.lock().ok();
    let mut s = String::new();
    s.push_str("═══ King Of Focus 诊断信息 ═══\n\n");

    s.push_str("【环境】\n");
    s.push_str(&format!("版本          {}\n", crate::version::VERSION));
    s.push_str(&format!(
        "系统          {} / {}\n",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    s.push_str(&format!(
        "模式          {}\n",
        if crate::testmode::on() {
            "测试模式（数据在 test/ 子目录）"
        } else {
            "正式"
        }
    ));
    s.push_str(&format!("管理员权限    {}\n", crate::cmds::is_admin()));
    s.push_str(&format!("数据目录      {}\n", crate::cfg::data_dir().display()));
    s.push_str(&format!(
        "配置文件      {}\n",
        crate::cfg::config_path().display()
    ));
    s.push_str(&format!("本地端口      {}\n", c.settings.port));
    s.push('\n');

    s.push_str("【当下状态】\n");
    if let Some(rt) = rt.as_deref() {
        let on = !rt.active.is_empty() || rt.locked || rt.clock_on;
        s.push_str(&format!("自律模式      {}\n", if on { "开启" } else { "关闭" }));
        s.push_str(&format!(
            "命中规则      {}\n",
            if rt.active.is_empty() {
                "（无）".to_string()
            } else {
                rt.active
                    .iter()
                    .map(|(n, _)| n.clone())
                    .collect::<Vec<_>>()
                    .join("、")
            }
        ));
        s.push_str(&format!(
            "固化锁定      {}\n",
            if rt.locked { "是" } else { "否" }
        ));
        s.push_str(&format!("时钟专注      {}\n", if rt.clock_on { "是" } else { "否" }));
        s.push_str(&format!(
            "本轮开始      {}\n",
            fmt_ts(rt.since)
        ));
        s.push_str(&format!(
            "下次状态变化  {}\n",
            if rt.next_change > 0 {
                format!("{} 分钟后", (rt.next_change + 59) / 60)
            } else {
                "—".to_string()
            }
        ));
        s.push_str(&format!(
            "今日拦截      软件 {} / 网页 {}\n",
            rt.blocked_apps, rt.blocked_sites
        ));
    } else {
        s.push_str("运行时状态    读不到（锁被占用）\n");
    }
    s.push_str(&format!(
        "专注遮罩      {}\n",
        if shared.mask.on.load(std::sync::atomic::Ordering::Relaxed) {
            "开着"
        } else {
            "关着"
        }
    ));
    s.push_str(&format!(
        "遮罩热键      {}（注册{}）\n",
        c.settings.mask.hotkey,
        if shared.mask.hk_ok.load(std::sync::atomic::Ordering::Relaxed) {
            "成功"
        } else {
            "失败/未注册"
        }
    ));
    s.push_str(&format!(
        "积分          {}（累计获得 {}，解锁至 {}）\n",
        c.points.balance,
        c.points.total_earned,
        fmt_ts(c.points.unlock_until)
    ));
    s.push('\n');

    s.push_str("【云同步】\n");
    s.push_str(&format!(
        "开关          {}（每 {} 分钟自动）\n",
        if c.settings.sync.enabled { "开" } else { "关" },
        c.settings.sync.auto_minutes
    ));
    s.push_str(&format!("上次同步      {}\n", fmt_ts(c.settings.sync.last_sync)));
    s.push_str(&format!(
        "上次结果      {}\n",
        if c.settings.sync.last_result.is_empty() {
            "—"
        } else {
            &c.settings.sync.last_result
        }
    ));
    s.push_str(&format!(
        "上次错误      {}\n",
        if c.settings.sync.last_error.is_empty() {
            "—"
        } else {
            &c.settings.sync.last_error
        }
    ));
    s.push('\n');

    s.push_str("【更新】\n");
    s.push_str(&format!(
        "上次检查      {}\n",
        fmt_ts(c.settings.update.last_check)
    ));
    if c.settings.update.platforms.is_empty() {
        s.push_str("清单缓存      （无）\n");
    } else {
        for (k, v) in &c.settings.update.platforms {
            s.push_str(&format!("  {k:<16} v{}\n", v.version));
        }
    }
    s.push('\n');

    s.push_str("【日志（最近 400 行）】\n");
    s.push_str(&crate::logs::tail());
    s.push_str("\n\n【配置（凭据已隐藏）】\n");
    s.push_str(&redacted(shared));
    s.push('\n');
    s
}
