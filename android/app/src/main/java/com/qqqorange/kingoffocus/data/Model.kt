package com.qqqorange.kingoffocus.data

import kotlinx.serialization.Serializable

/**
 * 一小时里的一段计划。
 *
 * 语义与 Windows 版保持一致：
 *  · `on` 决定这一小时是否被选中；
 *  · `from`/`to` 只收窄"这一小时的哪几分钟可见"，**不改变相位**；
 *  · `work`/`brk` 是番茄参数，相位锚点是整点（09:00 起算），不是窗口起点。
 */
@Serializable
data class HourPlan(
    val on: Boolean = false,
    val work: Int = 45,
    val brk: Int = 15,
    val from: Int = 0,
    val to: Int = 60,
)

/**
 * 一条自律规则 = 一份应用名单 + 模式 + 是否固化。
 *
 * Android 上没有"规则自己的时间表"这一层：什么时候生效完全由「自律时段」决定，
 * 规则只管名单。这与 Windows 版重构后的模型一致。
 */
@Serializable
data class Rule(
    val id: String = "",
    val name: String = "",
    val enabled: Boolean = true,
    /** blacklist = 名单内禁止；whitelist = 只允许名单内 */
    val mode: String = "blacklist",
    val packages: List<String> = emptyList(),
    /** 固化：生效期间不允许关闭自律、不允许改设置 */
    val hard: Boolean = true,
)

@Serializable
data class NotifyCfg(
    val enabled: Boolean = true,
    /** 专注结束前多少分钟提醒，0 = 不提醒 */
    val workBefore: Int = 5,
    /** 休息结束前多少分钟提醒，0 = 不提醒 */
    val breakBefore: Int = 2,
    val breakNotify: Boolean = true,
)

@Serializable
data class OverlayCfg(
    val blockEnabled: Boolean = true,
    val message: String = "这段时间在自律中，这个应用不在允许范围内。",
    /** 允许在拦截页上直接结束这一段（Android 端无法真正阻止，做成显式按钮更诚实） */
    val allowStop: Boolean = false,
)

@Serializable
data class Config(
    val version: Int = 1,
    /** 自律总开关：关掉时时段不生效、不拦截 */
    val enabled: Boolean = false,
    /** 7 天 × 24 小时 */
    val days: List<List<HourPlan>> = defaultDays(),
    val defWork: Int = 45,
    val defBrk: Int = 15,
    val rules: List<Rule> = emptyList(),
    val points: Int = 0,
    /** 积分解锁到什么时候（unix 秒）；解锁期间所有拦截暂停 */
    val unlockUntil: Long = 0L,
    val notify: NotifyCfg = NotifyCfg(),
    val overlay: OverlayCfg = OverlayCfg(),
)

fun defaultDays(): List<List<HourPlan>> = List(7) { List(24) { HourPlan() } }

/** 补齐 7×24 的形状：老配置、手工改坏的文件都不至于让界面崩掉 */
fun normalize(cfg: Config): Config {
    val days = (0 until 7).map { d ->
        val row = cfg.days.getOrNull(d).orEmpty()
        (0 until 24).map { h ->
            val p = row.getOrNull(h) ?: HourPlan()
            var from = p.from.coerceIn(0, 59)
            var to = p.to.coerceIn(1, 60)
            if (from >= to) {
                from = 0
                to = 60
            }
            var work = p.work.coerceIn(0, 60)
            var brk = p.brk.coerceIn(0, 60)
            if (brk > 0) {
                work = work.coerceIn(1, 59)
                if (work + brk > 60) brk = 60 - work
            }
            HourPlan(p.on, work, brk, from, to)
        }
    }
    return cfg.copy(days = days, points = cfg.points.coerceAtLeast(0))
}

/** 应用选择器里的一项：包名 + 显示名（不参与序列化） */
data class AppInfo(val pkg: String, val label: String)
