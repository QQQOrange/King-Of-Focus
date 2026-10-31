package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.data.Config
import java.time.Duration
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 锁机判定（纯函数，可单测）。
 *
 * ## 锁机 ≠ 拦截
 * 「拦截」回答的是"你打开了某个不该开的应用"：命中名单就盖一页拦截页。
 * 「锁机」回答的是"现在是专注段，整台手机先别用"：把你送回桌面，**立刻**盖上全屏遮罩。
 *
 * 为什么是"回桌面 + 盖遮罩"而不是"杀进程 / 关机"：
 *   · Android 沙箱根本不允许一个应用结束另一个应用的进程，也不允许关机；
 *   · 就算能，那是破坏性的——用户手上有正在写的文档、正在导航的地图；
 *   · 回桌面 + 遮罩是"可撤销的阻断"：所有应用都还在，只是被挡在遮罩后面。
 *
 * ## 三处状态，缺一不可
 *   · `pause`   —— 花积分买一段时间自由（[Config.lockPausedUntil]）；
 *   · `stop`    —— 花积分把**这一段**的锁机整个关掉（[Config.lockStoppedSeg]）；
 *   · `unlock`  —— 既有的"积分解锁窗口"（[Config.unlockUntil]），一并尊重。
 * 用"段标识"而不是时间戳做 stop 的键：换一段专注时自动恢复，不用定时器去清理。
 */
object LockEngine {

    /**
     * 任何时候都不盖的通道。
     *
     * 盖住状态栏/来电/紧急呼叫/权限弹窗不是自律，是把手机变成砖：
     * 真出事的时候用户连电话都打不出去。输入法也必须放行，否则任何需要打字的地方
     * 都会变成"点了没反应"。
     */
    private val ALWAYS_ALLOW = setOf(
        "com.android.systemui",
        "com.android.emergency",
        "com.android.dialer",
        "com.google.android.dialer",
        "com.android.server.telecom",
        "com.android.phone",
        "com.android.permissioncontroller",
        "com.google.android.permissioncontroller",
        "com.android.inputmethod.latin",
        "com.google.android.inputmethod.latin",
    )

    /**
     * @param imePkgs 当前启用的输入法包名（由调用方用 InputMethodManager 取）。
     *   输入法不能靠包名猜：搜狗是 `com.sohu.inputmethod.sogou`、百度是 `com.baidu.input`、
     *   讯飞是 `com.iflytek.inputmethod`——猜不全就会让"任何要打字的地方都点不动"。
     */
    fun isAlwaysAllowed(pkg: String, imePkgs: Set<String> = emptySet()): Boolean =
        pkg in ALWAYS_ALLOW ||
            pkg in imePkgs ||
            pkg.contains("inputmethod", ignoreCase = true) ||
            pkg.contains("permissioncontroller", ignoreCase = true)

    private fun epoch(now: LocalDateTime): Long =
        now.atZone(ZoneId.systemDefault()).toEpochSecond()

    /** 积分解锁窗口内（和 GuardEngine 同一口径：解锁期间一切暂停） */
    fun isUnlocked(cfg: Config, now: LocalDateTime): Boolean = epoch(now) < cfg.unlockUntil

    /** 暂停窗口内 */
    fun isPaused(cfg: Config, now: LocalDateTime): Boolean = epoch(now) < cfg.lockPausedUntil

    private fun hourOn(cfg: Config, t: LocalDateTime): Boolean =
        cfg.days.getOrNull(t.dayOfWeek.value - 1)?.getOrNull(t.hour)?.on == true

    /**
     * 当前"锁机段"的标识：从这一刻往回走，直到前一个小时不再选中。
     *
     * 为什么按"连续选中区间"而不是按小时：19:00–22:00 连着三小时属于同一场专注，
     * 用户"停止锁机"时想停的是这一整场，而不是"这一个小时"。
     * 段变了（下一场专注开始）→ 停止自动失效，不需要任何定时器。
     */
    fun segmentKey(cfg: Config, now: LocalDateTime): String {
        var cur = now.withMinute(0).withSecond(0).withNano(0)
        var guard = 0
        while (guard++ < 48) {
            val prev = cur.minusHours(1)
            if (!hourOn(cfg, prev)) break
            cur = prev
        }
        return "${cur.toLocalDate()}|${cur.hour}"
    }

    /**
     * 此刻是否处于锁机状态。
     *
     * 六条都要满足：锁机开关开着 / 自律开着 / 在时段内 / 不在休息段 /
     * 不在积分解锁窗口 / 没被暂停 / 这一段没被停止。
     */
    fun isLockActive(cfg: Config, now: LocalDateTime): Boolean {
        if (!cfg.lock.enabled || !cfg.enabled) return false
        val st = ScheduleEngine.stateAt(cfg, now) ?: return false
        if (st.inBreak) return false
        if (isUnlocked(cfg, now)) return false
        if (isPaused(cfg, now)) return false
        if (cfg.lockStoppedSeg.isNotEmpty() && cfg.lockStoppedSeg == segmentKey(cfg, now)) return false
        return true
    }

    /**
     * 现在这一拍要不要把遮罩盖上去。
     *
     * 不盖的四种情况：不在锁机 / 读不到前台（宁可漏一拍也不乱盖）/
     * 前台就是自己（遮罩已经在）/ 前台在白名单或紧急通道里。
     *
     * 注意**桌面不在放行名单里**：回桌面之后遮罩要立刻盖住桌面，否则"回桌面"就是出口。
     */
    fun shouldMask(
        cfg: Config,
        now: LocalDateTime,
        fg: String?,
        selfPkg: String,
        imePkgs: Set<String> = emptySet(),
    ): Boolean {
        if (!isLockActive(cfg, now)) return false
        if (fg.isNullOrEmpty()) return false
        if (fg == selfPkg) return false
        if (fg in cfg.lockAllow) return false
        if (isAlwaysAllowed(fg, imePkgs)) return false
        return true
    }

    /**
     * 这一场锁机还剩多少秒（不是番茄阶段剩余）。
     *
     * 遮罩上该显示的是"还要关多久"，所以从当前小时往后找连续选中的最后一小时。
     */
    fun segmentLeftSeconds(cfg: Config, now: LocalDateTime): Long {
        var end = now.withMinute(0).withSecond(0).withNano(0).plusHours(1)
        var guard = 0
        while (guard++ < 48 && hourOn(cfg, end)) end = end.plusHours(1)
        return Duration.between(now, end).seconds.coerceAtLeast(0)
    }

    /** 暂停还能用多久（秒）；没暂停返回 0 */
    fun pauseLeftSeconds(cfg: Config, now: LocalDateTime): Long =
        (cfg.lockPausedUntil - epoch(now)).coerceAtLeast(0)

    /** 积分够不够 */
    fun canAfford(cfg: Config, cost: Int): Boolean = cfg.points >= cost

    /** 暂停一次的价格与时长（界面和执行处读同一份，不会各说各的） */
    data class Price(val cost: Int, val minutes: Int)

    fun pausePrice(cfg: Config): Price =
        Price(cfg.lock.pauseCost.coerceAtLeast(0), cfg.lock.pauseMinutes.coerceIn(1, 120))

    fun stopPrice(cfg: Config): Int = cfg.lock.stopCost.coerceAtLeast(0)
}
