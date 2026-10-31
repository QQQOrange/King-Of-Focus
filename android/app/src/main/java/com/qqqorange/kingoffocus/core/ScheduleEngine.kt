package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.data.Config
import java.time.LocalDateTime

/**
 * 自律时段引擎（纯函数，可单测）。
 *
 * 与 Windows 版 `clock.rs` 同一套口径：
 *  · 一周 7 天 × 24 小时，每格可以是"整点内的某几分钟"（from/to）；
 *  · 番茄相位锚点是**整点**，`offset % (work + brk)` 取模，
 *    所以 25/5 这种小于一小时的配置一小时里会跑两轮；
 *  · 阶段剩余时间以窗口结束封顶（09:00–09:30 的窗口里看不到 09:45 开始的休息）。
 */
object ScheduleEngine {

    data class State(
        val inWindow: Boolean,
        val inBreak: Boolean,
        /** 当前阶段剩余秒数 */
        val leftSeconds: Long,
        val work: Int,
        val brk: Int,
    ) {
        val focusing: Boolean get() = inWindow && !inBreak
    }

    /** 未启用 / 当前小时没选中 / 分钟落在窗口外 → null */
    fun stateAt(cfg: Config, now: LocalDateTime): State? {
        if (!cfg.enabled) return null
        val day = cfg.days.getOrNull(now.dayOfWeek.value - 1) ?: return null
        val p = day.getOrNull(now.hour) ?: return null
        if (!p.on) return null
        val minute = now.minute
        if (minute < p.from || minute >= p.to) return null

        val winLeft = p.to - minute
        val sec = now.second.toLong()
        val work = p.work.coerceIn(0, 60)
        val brk = p.brk.coerceIn(0, 60)

        // 全天专注 / 不做番茄
        if (brk == 0 || work == 0 || work >= 60) {
            return State(true, false, (winLeft * 60 - sec).coerceAtLeast(0), 60, 0)
        }

        val cycle = work + brk
        // 相位锚点是整点：窗口的 from/to 只决定"哪几分钟可见"，不改变节奏
        val off = minute % cycle
        val inBreak = off >= work
        val phaseLeft = if (inBreak) cycle - off else work - off
        return State(
            inWindow = true,
            inBreak = inBreak,
            leftSeconds = (minOf(phaseLeft, winLeft) * 60 - sec).coerceAtLeast(0),
            work = work,
            brk = brk,
        )
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
