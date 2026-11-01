package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.OnboardMath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 首用向导写出来的排班表。
 *
 * 这几条必须钉住：排班写错是**静默**的——界面上看着有格子，
 * 判定却不生效，用户只会觉得"这软件不拦人"。
 */
class OnboardMathTest {

    @Test
    fun fillsOnlySelectedWeekdays() {
        val days = OnboardMath.buildDays(listOf(0, 2), 20, 22)
        for (h in 20..21) {
            assertTrue("周一 $h 点要选中", days[0][h].on)
            assertTrue("周三 $h 点要选中", days[2][h].on)
        }
        assertTrue("没选的周二不能开", !days[1][20].on)
        assertTrue("区间外的 19 点不能开", !days[0][19].on)
        assertTrue("to 是开区间上界，22 点不能开", !days[0][22].on)
    }

    @Test
    fun wholeRangeSharesOneSegment() {
        val days = OnboardMath.buildDays(listOf(1), 9, 12)
        val segs = (9..11).map { days[1][it].seg }.toSet()
        assertEquals("整段共用一个 seg，否则会被当成三段", 1, segs.size)
        assertTrue(segs.first().isNotEmpty())
    }

    @Test
    fun clampsBadHours() {
        // 起点给反：至少保住一小时，不能写出空方案
        val same = OnboardMath.buildDays(listOf(1), 22, 22)
        assertTrue(same[1][22].on)
        // 越界：夹到 23 点
        val over = OnboardMath.buildDays(listOf(1), 30, 99)
        assertTrue(over[1][23].on)
        // 非法 weekday 不能崩
        val bad = OnboardMath.buildDays(listOf(9, -1), 8, 9)
        assertTrue("非法 weekday 不该写入任何格子", bad.flatten().none { it.on })
    }

    @Test
    fun minutesCountsSelectedCells() {
        val days = OnboardMath.buildDays(listOf(0, 1), 20, 22)
        assertEquals(2 * 2 * 60, OnboardMath.minutesOf(days))
    }

    @Test
    fun defaultRhythmIsPomodoro() {
        assertEquals(25, OnboardMath.WORK)
        assertEquals(5, OnboardMath.BRK)
        val days = OnboardMath.buildDays(listOf(0), 9, 10)
        assertEquals(25, days[0][9].work)
        assertEquals(5, days[0][9].brk)
    }
}
