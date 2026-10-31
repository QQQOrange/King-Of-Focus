package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.ScheduleRules
import com.qqqorange.kingoffocus.data.Slots
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "今天之前的星期不许编辑"的规则。
 *
 * 关键的一条：拒绝必须发生在**写入路径**上，而不只是界面上点不动——
 * 只拦界面的话，换个入口就绕过去了。
 */
class ScheduleRulesTest {

    private fun emptyDay() = List(24) { HourPlan() }

    @Test
    fun `今天及之后可编辑，之前一律锁住`() {
        assertFalse(ScheduleRules.canEdit(0, todayIdx = 5))
        assertFalse(ScheduleRules.canEdit(4, todayIdx = 5))
        assertTrue(ScheduleRules.canEdit(5, todayIdx = 5))
        assertTrue(ScheduleRules.canEdit(6, todayIdx = 5))
        // 周一那天七列全开
        assertEquals(List(7) { true }, ScheduleRules.editableDays(0))
        assertEquals(
            "周六时周一至周五是锁的",
            listOf(false, false, false, false, false, true, true),
            ScheduleRules.editableDays(5),
        )
    }

    @Test
    fun `被锁的日子涂不动，数据原样返回`() {
        val day = emptyDay()
        val after = ScheduleRules.paint(
            dayIdx = 0, todayIdx = 5, day = day,
            slot = 36, step = 15, on = true, work = 45, brk = 15,
        )
        assertEquals("锁住的列不能写入", 0, Slots.dayMinutes(after))
        assertEquals(day, after)
    }

    @Test
    fun `今天那一列照常能涂`() {
        val after = ScheduleRules.paint(
            dayIdx = 5, todayIdx = 5, day = emptyDay(),
            slot = 36, step = 15, on = true, work = 45, brk = 15,
        )
        assertEquals(15, Slots.dayMinutes(after))
    }

    @Test
    fun `整列清空同样受锁限制`() {
        val full = Slots.paintDay(emptyDay(), true, 45, 15)
        val locked = ScheduleRules.paintAll(
            dayIdx = 2, todayIdx = 5, day = full, on = false, work = 45, brk = 15,
        )
        assertEquals("锁住的列不能被清空", 1440, Slots.dayMinutes(locked))

        val today = ScheduleRules.paintAll(
            dayIdx = 5, todayIdx = 5, day = full, on = false, work = 45, brk = 15,
        )
        assertEquals("今天可以清空", 0, Slots.dayMinutes(today))
    }

    @Test
    fun `提示文案说清了下周会解锁`() {
        assertTrue(ScheduleRules.lockReason("周一").contains("下周一自动解锁"))
    }
}
