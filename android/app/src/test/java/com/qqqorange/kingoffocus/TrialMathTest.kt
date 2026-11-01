package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.TrialMath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime

/**
 * 「试 25 分钟」写出来的临时时段表。
 *
 * 这块最容易错的是**跨小时/跨午夜**：写错的表现是"试用只跑了 10 分钟就没了"
 * 或者"结束时间对不上"，而用户根本不知道该怎么描述这个 bug。
 */
class TrialMathTest {

    private fun onMinutes(days: List<List<com.qqqorange.kingoffocus.data.HourPlan>>): Int =
        days.sumOf { row -> row.sumOf { if (it.on) it.to - it.from else 0 } }

    private fun cells(days: List<List<com.qqqorange.kingoffocus.data.HourPlan>>) =
        days.flatMap { it }.count { it.on }

    @Test
    fun singleHour() {
        val days = TrialMath.buildDays(LocalDateTime.of(2026, 11, 2, 10, 0), 25)
        assertEquals(25, onMinutes(days))
        assertEquals(1, cells(days))
        val h = days[0][10]
        assertTrue(h.on)
        assertEquals(0, h.from)
        assertEquals(25, h.to)
        assertEquals(TrialMath.SEG, h.seg)
    }

    @Test
    fun crossesHour() {
        // 10:45 起 25 分钟 = 10:45–11:00 + 11:00–11:10
        val days = TrialMath.buildDays(LocalDateTime.of(2026, 11, 2, 10, 45), 25)
        assertEquals(25, onMinutes(days))
        assertEquals(2, cells(days))
        assertEquals(45, days[0][10].from)
        assertEquals(60, days[0][10].to)
        assertEquals(0, days[0][11].from)
        assertEquals(10, days[0][11].to)
    }

    @Test
    fun crossesMidnight() {
        // 周日 23:50 起 25 分钟 → 周一 00:15
        val days = TrialMath.buildDays(LocalDateTime.of(2026, 11, 1, 23, 50), 25)
        assertEquals(25, onMinutes(days))
        assertEquals(2, cells(days))
        assertEquals("周日 23 点：50–60", 60, days[6][23].to)
        assertEquals(50, days[6][23].from)
        assertEquals("周一 0 点：0–15", 15, days[0][0].to)
        assertEquals(0, days[0][0].from)
    }

    @Test
    fun leavesOtherHoursUntouched() {
        val days = TrialMath.buildDays(LocalDateTime.of(2026, 11, 2, 10, 0), 25)
        val others = (0..6).flatMap { wd -> (0..23).map { h -> wd to h } }
            .filter { (wd, h) -> !(wd == 0 && h == 10) }
        assertTrue("只该有 10 点这一格", others.all { (wd, h) -> !days[wd][h].on })
    }

    @Test
    fun clampsSillyDurations() {
        // 太短会变成一个"开了等于没开"的格子；太长会盖掉一整晚
        val tiny = TrialMath.buildDays(LocalDateTime.of(2026, 11, 2, 10, 0), 1)
        assertEquals(5, onMinutes(tiny))
        val huge = TrialMath.buildDays(LocalDateTime.of(2026, 11, 2, 10, 0), 999)
        assertEquals(180, onMinutes(huge))
    }
}
