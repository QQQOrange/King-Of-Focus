package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Slots
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

    const val MODE_GENTLE = "gentle"
    const val MODE_STRICT = "strict"

    /** 强制模式：没有任何"提前结束"的出口，只能等这一段走完 */
    fun isStrict(cfg: Config): Boolean = cfg.lock.mode == MODE_STRICT

    /** 积分解锁窗口内（和 GuardEngine 同一口径：解锁期间一切暂停） */
    fun isUnlocked(cfg: Config, now: LocalDateTime): Boolean = epoch(now) < cfg.unlockUntil

    /** 暂停窗口内 */
    fun isPaused(cfg: Config, now: LocalDateTime): Boolean = epoch(now) < cfg.lockPausedUntil

    private fun hourOn(cfg: Config, t: LocalDateTime): Boolean =
        cfg.days.getOrNull(t.dayOfWeek.value - 1)?.getOrNull(t.hour)?.on == true

    /** 某一刻所在窗口的段标识（不在时段内 → 空串） */
    private fun segAt(cfg: Config, t: LocalDateTime): String {
        val p = cfg.days.getOrNull(t.dayOfWeek.value - 1)?.getOrNull(t.hour) ?: return ""
        return Slots.windowAt(p, t.minute)?.seg.orEmpty()
    }

    /**
     * 当前"锁机段"的标识：从这一刻往回走，走到**同一段**的开头。
     *
     * 和桌面端一样，"相邻"不等于"同一段"：09:00–10:00 与 10:00–11:00 可能是一次
     * 拖出来的两段，也可能是两次分别设的。有 `seg` 就按 id 认，没有才退回
     * "连续选中的小时算一段"（老配置的行为）。
     *
     * 段变了 → "停止本段"自动失效，不需要任何定时器。
     */
    fun segmentKey(cfg: Config, now: LocalDateTime): String {
        val seg = segAt(cfg, now)
        var cur = now.withMinute(0).withSecond(0).withNano(0)
        var guard = 0
        while (guard++ < 48) {
            val prevHour = cur.minusHours(1)
            // 用"上一小时的最后一分钟"判断，比看 hour.on 精确：
            // 上一小时的窗口可能只到 :45，那就不该并进来
            val prevMinute = prevHour.withMinute(59)
            val same = if (seg.isEmpty()) {
                hourOn(cfg, prevHour)
            } else {
                segAt(cfg, prevMinute) == seg
            }
            if (!same) break
            cur = prevHour
        }
        return if (seg.isEmpty()) "${cur.toLocalDate()}|${cur.hour}"
        else "${cur.toLocalDate()}|$seg"
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
        // 强制模式**故意**不看暂停/停止：那两个状态是温和模式买来的自由，
        // 现在切成强制了，就不能靠"之前买过一次"绕过（否则切模式就是个后门）。
        if (!isStrict(cfg)) {
            if (isPaused(cfg, now)) return false
            if (cfg.lockStoppedSeg.isNotEmpty() && cfg.lockStoppedSeg == segmentKey(cfg, now)) return false
        }
        return true
    }

    /** 温和模式才有"买自由"这件事；强制模式返回 false，界面据此隐藏按钮 */
    fun canPause(cfg: Config, now: LocalDateTime): Boolean = isLockActive(cfg, now) && !isStrict(cfg)

    fun canStop(cfg: Config, now: LocalDateTime): Boolean = isLockActive(cfg, now) && !isStrict(cfg)

    /**
     * 能不能把模式从强制切回温和。
     *
     * 强制锁机正在进行时不允许——否则"先切回温和，再点停止"就是一步到位的绕过。
     * 等这一段结束就随便改。
     */
    fun canSwitchMode(cfg: Config, now: LocalDateTime): Boolean =
        !(isStrict(cfg) && isLockActive(cfg, now))

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
        // 允许名单只有一个来源：白名单规则（见 GuardEngine.allowedPackages）。
        // 以前这里读 cfg.lockAllow，于是"遮罩放行的应用"和"规则放行的应用"可以不一样。
        if (fg in GuardEngine.allowedPackages(cfg)) return false
        if (isAlwaysAllowed(fg, imePkgs)) return false
        return true
    }

    /**
     * 这一场锁机还剩多少秒（不是番茄阶段剩余）。
     *
     * 遮罩上该显示的是"还要关多久"，所以从当前小时往后找连续选中的最后一小时。
     */
    fun segmentLeftSeconds(cfg: Config, now: LocalDateTime): Long {
        val day = cfg.days.getOrNull(now.dayOfWeek.value - 1) ?: return 0
        val p = day.getOrNull(now.hour) ?: return 0
        val win = Slots.windowAt(p, now.minute) ?: return 0
        val seg = win.seg
        // 先算到"当前这一段的窗口"结束
        // 本小时的起点 + 窗口结束分钟（`withMinute(0)` 之后只需再加 win.to）
        var end = now.withSecond(0).withNano(0).withMinute(0).plusMinutes(win.to.toLong())
        // 再往后整小时延伸：下一小时必须从 0 分就开始、且是同一段
        var guard = 0
        while (guard++ < 48) {
            val nextHour = end
            if (nextHour.minute != 0) break
            val np = cfg.days.getOrNull(nextHour.dayOfWeek.value - 1)?.getOrNull(nextHour.hour)
                ?: break
            if (!np.on) break
            val wins = Slots.windowsOf(np)
            val first = wins.firstOrNull() ?: break
            if (first.from != 0) break
            val same = if (seg.isEmpty()) true else first.seg == seg
            if (!same) break
            end = nextHour.plusMinutes(wins.last().to.toLong())
        }
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
