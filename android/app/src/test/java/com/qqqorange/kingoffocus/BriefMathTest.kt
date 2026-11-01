package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.BriefMath
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.HourWin
import com.qqqorange.kingoffocus.data.defaultDays
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDateTime

/**
 * 「下一段」的纯逻辑测试。
 *
 * 这几条都是实际会遇到的：正在段里的时候、"一小时两段"的时候、
 * 今天排完了要跳到明天的时候。算错的后果很直观——
 * 用户在自由时间里看到"下一段 09:00 开始"却是昨天那段，就会开始不信这个页面。
 */
class BriefMathTest {

    /** 周一（index 0）排几格；`to` 是这一小时选到第几分钟 */
    private fun cfg(vararg hours: Pair<Int, Int>, enabled: Boolean = true): Config {
        val days = defaultDays().map { it.toMutableList() }.toMutableList()
        hours.forEach { (h, to) ->
            days[0][h] = HourPlan(on = true, work = 50, brk = 10, from = 0, to = to, seg = "s$h")
        }
        return Config(enabled = enabled, days = days)
    }

    /** 2026-11-02 是周一 */
    private fun at(day: Int, h: Int, m: Int): LocalDateTime =
        LocalDateTime.of(2026, 11, day, h, m)

    @Test
    fun `总开关关着就没有下一段`() {
        val c = cfg(9 to 60, enabled = false)
        assertNull(BriefMath.nextSegment(c, at(2, 8, 0)))
    }

    @Test
    fun `空排班返回 null 而不是死循环`() {
        val c = cfg()
        assertNull(BriefMath.nextSegment(c, at(2, 8, 0)))
    }

    @Test
    fun `自由时间里给的是今天还没开始的那段`() {
        val c = cfg(9 to 60, 14 to 60)
        val n = BriefMath.nextSegment(c, at(2, 13, 40))!!
        assertEquals("14:00", n.at)
        assertEquals("14:00–15:00", n.label)
        assertEquals(20 * 60L, n.inSecs)
    }

    @Test
    fun `正在段里时跳过自己 给后面那段`() {
        val c = cfg(9 to 60, 14 to 60)
        val n = BriefMath.nextSegment(c, at(2, 9, 30))!!
        assertEquals("14:00", n.at)
    }

    @Test
    fun `一小时两段时挑起点在未来的那一段`() {
        // 09:00–09:20 与 09:40–10:00 是两段（同一小时里两次拖选）
        val days = defaultDays().map { it.toMutableList() }.toMutableList()
        days[0][9] = HourPlan(
            on = true,
            work = 50,
            brk = 10,
            wins = listOf(HourWin(0, 20, "a"), HourWin(40, 60, "b")),
        )
        val c = Config(enabled = true, days = days)
        val n = BriefMath.nextSegment(c, at(2, 9, 10))!!
        assertEquals("09:40", n.at)
        assertEquals("09:40–10:00", n.label)
        assertEquals(30 * 60L, n.inSecs)
    }

    @Test
    fun `今天排完了就跳到下周同一格`() {
        val c = cfg(9 to 60)
        // 周一 23:30 → 只有下周一 09:00
        val n = BriefMath.nextSegment(c, at(2, 23, 30))!!
        assertEquals("09:00", n.at)
        // 23:30 到次日 09:00 = 9.5 小时，再加 6 天
        assertEquals((9 * 3600 + 1800L) + 6L * 86400, n.inSecs)
    }

    @Test
    fun `倒计时文案 不足一分钟单独说`() {
        assertEquals("不到 1 分钟", BriefMath.fmtLeft(0))
        assertEquals("不到 1 分钟", BriefMath.fmtLeft(59))
        assertEquals("1 分钟", BriefMath.fmtLeft(60))
        assertEquals("1 小时 30 分", BriefMath.fmtLeft(90 * 60))
        assertEquals("2 小时", BriefMath.fmtLeft(120 * 60))
    }
}
