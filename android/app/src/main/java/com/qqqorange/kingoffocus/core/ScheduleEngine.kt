package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Slots
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 自律时段引擎（纯函数，可单测）。
 *
 * 与 Windows 版 `clock.rs` 同一套口径：
 *  · 一周 7 天 × 24 小时，每格可以是"整点内的某几分钟"（from/to）；
 *  · 番茄相位锚点是**整点**，`offset % (work + brk)` 取模，
 *    所以 25/5 这种小于一小时的配置一小时里会跑两轮；
 *  · 阶段剩余时间以窗口结束封顶（09:00–09:30 的窗口里看不到 09:45 开始的休息）；
 *  · 一小时内的累计休息受 `Config.defCap` 限制，到上限后休息整轮跳过（见 [phase]）。
 */
object ScheduleEngine {

    data class State(
        val inWindow: Boolean,
        val inBreak: Boolean,
        /** 当前阶段剩余秒数 */
        val leftSeconds: Long,
        val work: Int,
        val brk: Int,
        /** 命中的窗口的段标识；老数据为空（此时退回"连续小时算一段"） */
        val seg: String = "",
    ) {
        val focusing: Boolean get() = inWindow && !inBreak
    }

    /** 一个阶段：现在是不是休息、这一阶段还剩多少**分钟**（以整点为界） */
    data class Phase(val inBreak: Boolean, val leftMin: Int)

    /**
     * 番茄相位（纯函数）。**桌面端 `clock.rs::phase_at` 是同一份算法**，改一边必须改另一边。
     *
     * 相位锚点是整点：`off = 这一小时的第几分钟 % (work + brk)`。
     *
     * [cap] 是"这一小时累计休息上限"（0 = 不限）。它改变的是**休息还能给多久**：
     *  · 第 k 轮休息之前，已经休掉 `min(k×brk, cap)` 分钟；
     *  · 只剩 `cap - acc` 分钟可休，所以这一轮实际长度 = `min(brk, 剩余额度)`；
     *  · 额度用完（0 分钟）时这一轮**整段跳过**——`inBreak = false`，
     *    于是锁机不解除、拦截继续，这就是"达到上限后保持学习锁机状态"。
     *
     * 注意被截断的休息之后不会再有休息：额度已经归零，后面每轮都是跳过。
     * 所以"休息结束"之后一律算到整点，不需要再找下一轮。
     */
    fun phase(work: Int, brk: Int, cap: Int, minute: Int): Phase {
        val w = work.coerceIn(0, 60)
        val b = brk.coerceIn(0, 60)
        val c = cap.coerceIn(0, 60)
        // 不设休息 / 专注占满整小时 → 整段专注
        if (b == 0 || w == 0 || w >= 60) return Phase(false, 60 - minute)

        val cyc = w + b
        val k = minute / cyc
        val off = minute % cyc
        // 第 i 轮休息实际能休多久（0 = 整轮跳过）
        fun durAt(i: Int): Int =
            if (c <= 0) b else (c - minOf(i * b, c)).coerceAtLeast(0).coerceAtMost(b)

        val dur = durAt(k)
        if (off < w) {
            // 专注中：本轮休息若已被额度吃掉，就一直专注到整点
            return if (dur > 0) Phase(false, w - off) else Phase(false, 60 - minute)
        }
        if (off < w + dur) return Phase(true, w + dur - off)

        // 这一轮休息已经走完（含被截断）：额度用完 → 到整点；否则等下一轮
        val nextStart = (k + 1) * cyc + w
        val nextDur = durAt(k + 1)
        return if (nextDur > 0 && nextStart < 60) Phase(false, nextStart - minute) else Phase(false, 60 - minute)
    }

    /** 未启用 / 当前小时没选中 / 分钟落在窗口外 → null */
    fun stateAt(cfg: Config, now: LocalDateTime): State? {
        if (!cfg.enabled) return null
        val day = cfg.days.getOrNull(now.dayOfWeek.value - 1) ?: return null
        val p = day.getOrNull(now.hour) ?: return null
        if (!p.on) return null
        val minute = now.minute
        // 刻度细到 10/15 分钟后，一小时里可以有好几段（比如 0–15 与 30–45）。
        // 只有落进**具体某一段**才算在时段内；否则中间那段空档会被当成解锁。
        // 命中哪一段就用哪一段的结尾算剩余时间——拿第一段去套第二段会算出负数。
        val win = Slots.windowAt(p, minute) ?: return null

        val winLeft = win.to - minute
        val sec = now.second.toLong()
        val work = p.work.coerceIn(0, 60)
        val brk = p.brk.coerceIn(0, 60)

        // 全天专注 / 不做番茄
        if (brk == 0 || work == 0 || work >= 60) {
            return State(true, false, (winLeft * 60 - sec).coerceAtLeast(0), 60, 0, win.seg)
        }

        // 相位（含"累计休息上限"）全在 phase 里：锚点是整点，窗口的 from/to
        // 只决定"哪几分钟可见"，不改变节奏
        val ph = phase(work, brk, cfg.defCap, minute)
        return State(
            inWindow = true,
            inBreak = ph.inBreak,
            // 窗口可能比阶段更早结束（如 09:00–09:30 的窗口里看不到 09:45 开始的休息），
            // 尾段一律截到窗口末尾
            leftSeconds = (minOf(ph.leftMin, winLeft) * 60 - sec).coerceAtLeast(0),
            work = work,
            brk = brk,
            seg = win.seg,
        )
    }

    /**
     * 现在能不能改时段 —— **与桌面端 `settingsFrozen()` 同义**。
     *
     * 为什么要有：自律工具最大的漏洞是"正在专注时顺手把时段改掉"。
     * 一旦允许，锁机和拦截都形同建议。所以专注段生效期间时段页是只读的。
     *
     * 三种情况会解除冻结，因为它们都是用户**明确付过代价**的：
     *   · 积分解锁窗口内（`unlockUntil`）；
     *   · 锁机暂停期间（`lockPausedUntil`）；
     *   · 已经"停止本段"（`lockStoppedSeg`）——本段都停了，没必要再挡。
     * 休息段也不冻结：那本来就是自由时间。
     */
    fun frozen(cfg: Config, now: LocalDateTime): Boolean {
        if (!cfg.enabled) return false
        val ts = now.atZone(ZoneId.systemDefault()).toEpochSecond()
        if (ts < cfg.unlockUntil) return false
        if (ts < cfg.lockPausedUntil) return false
        if (cfg.lockStoppedSeg.isNotEmpty()) return false
        return stateAt(cfg, now)?.focusing == true
    }

    /** 今天还有哪些小时被选中（用于界面概览） */
    fun todayHours(cfg: Config, dayOfWeek: Int): List<Int> {
        val day = cfg.days.getOrNull(dayOfWeek - 1) ?: return emptyList()
        return day.mapIndexedNotNull { h, p -> if (p.on) h else null }
    }

    /** 到下一次"生效状态翻转"还有多少秒；用于顶部倒计时（简单起见只看未来 24 小时） */
    fun secondsUntilChange(cfg: Config, now: LocalDateTime): Long? {
        val cur = stateAt(cfg, now) != null
        var probe = now.plusSeconds(30)
        var acc = 30L
        while (acc <= 24 * 3600) {
            if ((stateAt(cfg, probe) != null) != cur) return acc
            probe = probe.plusSeconds(30)
            acc += 30
        }
        return null
    }

    fun fmtLeft(seconds: Long): String {
        val s = seconds.coerceAtLeast(0)
        val m = s / 60
        val h = m / 60
        return if (h > 0) "%d:%02d:%02d".format(h, m % 60, s % 60) else "%02d:%02d".format(m, s % 60)
    }
}
