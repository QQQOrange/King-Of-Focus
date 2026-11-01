package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.ReviewMath
import com.qqqorange.kingoffocus.data.ReviewStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek
import java.time.LocalDate

/**
 * 周复盘的两件纯逻辑：**一周从哪天开始**、以及**五条回答怎么存**。
 *
 * 周一起这条必须和「时段」表、统计页的周视图一致——三处不一样的话，
 * 用户看到"本周 6 小时"和时段表上的格子会对不上。
 */
class ReviewMathTest {

    // 2026-11-01 是周日
    private val sunday = LocalDate.of(2026, 11, 1)
    private val monday = LocalDate.of(2026, 10, 26)

    @Test
    fun weekStartsOnMondayAndLastsSevenDays() {
        val sp = ReviewMath.week(sunday, 0)
        assertEquals(monday, sp.start)
        assertEquals(DayOfWeek.MONDAY, sp.start.dayOfWeek)
        assertEquals(DayOfWeek.SUNDAY, sp.end.dayOfWeek)
        assertEquals(6, sp.end.toEpochDay() - sp.start.toEpochDay())
    }

    @Test
    fun offsetOneIsPreviousWeek() {
        val thisWeek = ReviewMath.week(sunday, 0)
        val lastWeek = ReviewMath.week(sunday, 1)
        assertEquals(thisWeek.start.minusWeeks(1), lastWeek.start)
        assertTrue("上周日必须早于本周一", lastWeek.end.isBefore(thisWeek.start))
        assertEquals(1, thisWeek.start.toEpochDay() - lastWeek.end.toEpochDay())
    }

    @Test
    fun negativeOffsetIsClamped() {
        // 脏参数不能算出"未来的一周"
        assertEquals(ReviewMath.week(sunday, 0).start, ReviewMath.week(sunday, -3).start)
    }

    @Test
    fun bestDayIgnoresAllZeroWeek() {
        val days = (0 until 7).map { monday.plusDays(it.toLong()) to 0 }
        assertNull("全 0 的一周不该报最投入的一天", ReviewMath.bestDay(days))
    }

    @Test
    fun bestDayPicksMax() {
        val days = listOf(
            monday to 3600,
            monday.plusDays(2) to 7200,
            monday.plusDays(4) to 600,
        )
        val best = ReviewMath.bestDay(days)
        assertEquals(7200, best?.second)
        assertEquals("周三", ReviewMath.weekdayShort(best!!.first.dayOfWeek))
    }

    // ---------------- 回答存取 ----------------

    @Test
    fun answersArePaddedAndOverwritten() {
        val week = "2026-10-26"
        ReviewStore.saveAnswers(week, listOf("  写登录页  ", ""))
        val a = ReviewStore.answersOf(week)
        assertEquals(ReviewStore.Q_COUNT, a.size)
        assertEquals("写登录页", a[0])
        assertEquals("", a[1])
        // 再存一次是覆盖，不是追加
        ReviewStore.saveAnswers(week, listOf("改一条"))
        assertEquals("改一条", ReviewStore.answersOf(week)[0])
    }

    @Test
    fun badWeekIsIgnored() {
        ReviewStore.saveAnswers("", listOf("x"))
        assertEquals(ReviewStore.Q_COUNT, ReviewStore.answersOf("").size)
        assertTrue(ReviewStore.answersOf("").all { it.isEmpty() })
    }
}
