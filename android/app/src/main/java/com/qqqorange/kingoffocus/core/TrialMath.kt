package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.defaultDays
import java.time.LocalDateTime

/**
 * 「现在试 25 分钟」要用的那张临时时段表。
 *
 * 手机端没有桌面那套"多套方案"，所以试用只能临时**替换** `Config.days`，
 * 到点再把原表还回去（原始表存在 `kof/trial.json`）。
 *
 * 为什么可以这么做而不会把用户的排班弄丢：
 *  · 试用期间本来就处在一个专注段里，时段页是**只读**的（`ScheduleEngine.frozen`），
 *    用户改不了，也就不存在"试用中改的表被覆盖"；
 *  · 万一进程被杀，下次启动 `Store.init` 会检查过期状态并还原。
 *
 * 这段只负责算格子，不碰磁盘、不碰 Context。
 */
object TrialMath {

    /** 试用默认 25 分钟（与桌面向导一致） */
    const val MINUTES = 25

    /** 试用段用独立的 seg，不会和用户自己排的段混在一起 */
    const val SEG = "trial-seg"

    /**
     * 从 `now` 起 [minutes] 分钟的时段表。
     *
     * 与「时段」表同一套表示：每小时存 from/to 分钟，`to` 是开区间上界（60 = 到整点）。
     * 跨小时、跨午夜都要正确——只覆盖"现在到结束"这一段，别的时间一格不动。
     */
    fun buildDays(now: LocalDateTime, minutes: Int = MINUTES): List<List<HourPlan>> {
        val m = minutes.coerceIn(5, 180)
        val start = now.withSecond(0).withNano(0)
        val end = start.plusMinutes(m.toLong())
        val grid = defaultDays().map { it.toMutableList() }.toMutableList()

        var cur = start
        var guard = 0
        while (cur.isBefore(end) && guard++ < 24) {
            val hourStart = cur.toLocalDate().atTime(cur.hour, 0)
            val hourEnd = hourStart.plusHours(1)
            val stop = if (hourEnd.isBefore(end)) hourEnd else end
            val wd = cur.dayOfWeek.value - 1
            val from = cur.minute
            // stop 落在整点上（含跨天到 00:00）时，to 用 60 表示"到整点"
            val to = if (stop == hourEnd || stop.hour == 0 && stop.minute == 0) 60 else stop.minute
            if (to > from) {
                grid[wd][cur.hour] = HourPlan(
                    on = true,
                    work = 25,
                    brk = 5,
                    from = from,
                    to = to,
                    seg = SEG,
                    wins = emptyList(),
                )
            }
            cur = stop
        }
        return grid
    }
}
