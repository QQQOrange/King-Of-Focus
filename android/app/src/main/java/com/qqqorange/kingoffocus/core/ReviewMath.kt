package com.qqqorange.kingoffocus.core

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters

/**
 * 周复盘的纯逻辑：一周的起止、以及"这周比上周怎样"。
 *
 * 与桌面端 `review::week_bounds` 同一套口径：**周一到周日**，
 * 与「时段」表的横轴、统计页的周视图完全一致——三处不一样的话，
 * 用户看到"本周 6 小时"和时段表上的格子会对不上。
 *
 * 这里只放纯计算；数据汇总在 `data/Review.kt`（要读几个 store）。
 */
object ReviewMath {

    /** 一周的起止（都是闭区间） */
    data class Span(val start: LocalDate, val end: LocalDate) {
        val startKey: String get() = start.toString()
        val endKey: String get() = end.toString()
        val days: Int get() = 7
    }

    /**
     * 某一周。`offset` 0 = 本周，1 = 上周。
     *
     * 负数按 0 处理：界面上只有"本周 / 上周"两个按钮，
     * 但底层别因为一个脏参数算出未来的一周。
     */
    fun week(today: LocalDate, offset: Long = 0): Span {
        val back = (today.dayOfWeek.value - 1) + offset.coerceAtLeast(0) * 7
        val monday = today.minusDays(back.toLong())
        return Span(monday, monday.plusDays(6))
    }

    /** 上一周（用来对比"这周比上周多了还是少了"） */
    fun prev(sp: Span): Span = Span(sp.start.minusWeeks(1), sp.end.minusWeeks(1))

    /**
     * 一周里最投入的那一天。
     *
     * 全 0 时返回 null，而不是硬给一个 0 秒的"最佳"——
     * "本周最投入的一天：周一 0 分钟"这种话只会让人关掉页面。
     */
    fun bestDay(seconds: List<Pair<LocalDate, Int>>): Pair<LocalDate, Int>? =
        seconds.maxByOrNull { it.second }?.takeIf { it.second > 0 }

    /** "周一 / 周二"这种短名（复盘里说"最投入的是周四"比日期好读） */
    fun weekdayShort(d: DayOfWeek): String = when (d) {
        DayOfWeek.MONDAY -> "周一"
        DayOfWeek.TUESDAY -> "周二"
        DayOfWeek.WEDNESDAY -> "周三"
        DayOfWeek.THURSDAY -> "周四"
        DayOfWeek.FRIDAY -> "周五"
        DayOfWeek.SATURDAY -> "周六"
        else -> "周日"
    }

    /** 便宜起见：给定日期直接落到它那周的周一 */
    fun mondayOf(d: LocalDate): LocalDate = d.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
}
