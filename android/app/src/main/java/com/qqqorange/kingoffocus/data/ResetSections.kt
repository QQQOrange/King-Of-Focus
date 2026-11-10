package com.qqqorange.kingoffocus.data

import com.qqqorange.kingoffocus.ui.Loc

/**
 * 手机端的「分区恢复默认」。
 *
 * 逻辑放在 data 层而不是 Compose 里，是为了能直接单测：
 * "恢复 A 不影响 B" 这种事必须被断言守住——它一旦错了，用户点一下就可能
 * 丢掉规则或时段，而他根本不会知道是哪一步弄丢的。
 *
 * 与桌面端 0.1.104 的 `reset::apply` 同一套语义，只少了手机上没有的东西
 * （遮罩、HUD、云同步凭据、更新令牌……那些在 Android 上要么不存在，要么
 * 由系统设置管）。
 */
enum class ResetSection(val title: String, val desc: String) {
    RULES(Loc.t("自律规则"), Loc.t("规则列表回到出厂的那条「自律时间」，自定义规则会被删除。")),
    SCHEDULE(Loc.t("自律时段"), Loc.t("7×24 时段表与多套方案恢复默认。")),
    LOCK(Loc.t("锁机"), Loc.t("锁机开关、暂停/停止价格与强制模式恢复默认。")),
    SLEEP(Loc.t("睡眠"), Loc.t("睡眠时段恢复默认（默认关闭）。")),
    STATS(Loc.t("统计口径"), Loc.t("保留天数与计闲规则恢复默认，已经统计的数据不删。")),
    NOTIFY(Loc.t("提醒"), Loc.t("阶段提醒与每日汇总恢复默认。")),
    DISTRACT(Loc.t("分心事件"), Loc.t("提醒间隔、上限与自动遮罩恢复默认。")),
    ALL(Loc.t("全部配置"), Loc.t("所有设置、规则、时段和积分回到默认值；统计数据与备份文件不动。")),
    ;

    companion object {
        fun of(key: String): ResetSection? = entries.firstOrNull { it.name == key }
    }
}

/** 只替换这一块字段，其它原样保留 */
fun applyReset(cfg: Config, s: ResetSection): Config {
    val d = Config()
    return when (s) {
        ResetSection.RULES -> cfg.copy(rules = d.rules)
        ResetSection.SCHEDULE -> cfg.copy(
            days = d.days,
            plans = d.plans,
            activePlan = d.activePlan,
            granularity = d.granularity,
        )
        ResetSection.LOCK -> cfg.copy(
            lock = d.lock,
            lockAllow = d.lockAllow,
            lockPausedUntil = 0L,
            lockStoppedSeg = "",
        )
        ResetSection.SLEEP -> cfg.copy(sleep = d.sleep)
        ResetSection.STATS -> cfg.copy(stats = d.stats)
        ResetSection.NOTIFY -> cfg.copy(notify = d.notify)
        ResetSection.DISTRACT -> cfg.copy(distract = d.distract)
        ResetSection.ALL -> d
    }
}
