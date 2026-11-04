package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.ResetSection
import com.qqqorange.kingoffocus.data.applyReset
import com.qqqorange.kingoffocus.data.defaultDays
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「分区恢复默认」的隔离性。
 *
 * 这一组断言守的是同一件事：**恢复 A 不能动 B**。
 * 用户点「恢复统计口径」时，最怕的是规则或时段被一起清掉——那不会有任何提示，
 * 只会在下一段自律里表现为"怎么什么都没拦"。
 */
class ResetSectionsTest {

    /** 一份"每块都被改过"的配置 */
    private fun custom(): Config {
        val c = Config()
        val days = defaultDays().map { it.toMutableList() }.toMutableList()
        days[0][9] = days[0][9].copy(on = true)
        return c.copy(
            enabled = true,
            days = days,
            rules = listOf(com.qqqorange.kingoffocus.data.Rule(id = "x", name = "我的规则")),
            points = 88,
            totalEarned = 200,
            sleep = c.sleep.copy(enabled = true, unlockMin = 42),
            stats = c.stats.copy(enabled = false, retentionDays = 30),
            lock = c.lock.copy(enabled = true, pauseMinutes = 33),
            notify = c.notify.copy(enabled = false),
        )
    }

    @Test
    fun `恢复规则只动规则`() {
        val out = applyReset(custom(), ResetSection.RULES)
        assertEquals(Config().rules, out.rules)
        assertEquals("积分不该被重置", 88, out.points)
        assertEquals("累计获得不该被重置", 200, out.totalEarned)
        assertTrue("睡眠设置不该被重置", out.sleep.enabled)
        assertEquals("统计口径不该被重置", 30, out.stats.retentionDays)
    }

    @Test
    fun `恢复统计只动统计`() {
        val out = applyReset(custom(), ResetSection.STATS)
        assertEquals(Config().stats, out.stats)
        assertEquals("规则不该被重置", "我的规则", out.rules[0].name)
        assertTrue("睡眠设置不该被重置", out.sleep.enabled)
    }

    @Test
    fun `恢复睡眠只动睡眠`() {
        val out = applyReset(custom(), ResetSection.SLEEP)
        assertEquals(Config().sleep, out.sleep)
        assertEquals("统计保留天数不该变", 30, out.stats.retentionDays)
        assertEquals("锁机设置不该变", 33, out.lock.pauseMinutes)
    }

    @Test
    fun `恢复时段只动时段`() {
        val out = applyReset(custom(), ResetSection.SCHEDULE)
        assertEquals(Config().days, out.days)
        assertEquals("规则不该被重置", "我的规则", out.rules[0].name)
    }

    @Test
    fun `恢复全部会把积分清零`() {
        val out = applyReset(custom(), ResetSection.ALL)
        assertEquals(0, out.points)
        assertEquals(0, out.totalEarned)
        assertNotEquals("规则应回到默认", "我的规则", out.rules.firstOrNull()?.name)
    }

    @Test
    fun `每个分区都能恢复且不抛异常`() {
        for (s in ResetSection.entries) {
            applyReset(custom(), s)
        }
    }
}
