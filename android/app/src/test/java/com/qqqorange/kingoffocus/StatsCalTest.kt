package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.Acc
import com.qqqorange.kingoffocus.core.CalDay
import com.qqqorange.kingoffocus.core.Slice
import com.qqqorange.kingoffocus.core.Span
import com.qqqorange.kingoffocus.core.StatsCal
import com.qqqorange.kingoffocus.core.StatsDay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * 日历窗口、按轨合并、饼图切片与配色。
 *
 * 这几块决定"上面饼图、下面日历、再下面明细"能不能对得上，
 * 所以每条都钉一个断言：窗口差一天，月末那行就会串月；配色差一位，
 * 同一个应用在饼图和日历里就是两个颜色。
 */
class StatsCalTest {

    private fun d(s: String): LocalDate = LocalDate.parse(s)

    private fun day(date: String, on: Map<String, Pair<String, Int>> = emptyMap(),
                    off: Map<String, Pair<String, Int>> = emptyMap()): StatsDay {
        val sd = StatsDay(date)
        for ((k, v) in on) sd.acc(k, true, v.first).also { it.secs = v.second }
        for ((k, v) in off) sd.acc(k, false, v.first).also { it.secs = v.second }
        return sd
    }

    // ---------------------------------------------------------------- 窗口

    @Test
    fun `一周从周一开始`() {
        // 2026-10-31 是周六 → 本周一是 10-26
        assertEquals(d("2026-10-26"), StatsCal.weekStart(d("2026-10-31")))
        assertEquals(d("2026-10-26"), StatsCal.weekStart(d("2026-10-26")))
        val (s, e) = StatsCal.weekWindow(d("2026-10-31"))
        assertEquals(d("2026-10-26"), s)
        assertEquals(d("2026-11-01"), e)
    }

    @Test
    fun `月窗口铺满整周，不会只剩半行`() {
        // 2026-10-01 是周四；10-31 是周六
        val (s, e) = StatsCal.monthWindow(d("2026-10-15"))
        assertEquals(d("2026-09-28"), s)
        assertEquals(d("2026-11-01"), e)
        val days = (e.toEpochDay() - s.toEpochDay() + 1).toInt()
        assertEquals("必须是 7 的倍数", 0, days % 7)
        assertEquals(35, days)
    }

    // ---------------------------------------------------------------- 按轨合并

    @Test
    fun `汇总视图把两轨的同一应用合成一条`() {
        val sd = StatsDay("2026-10-31")
        sd.acc("a", true, "甲").apply { secs = 1200; spans.add(Span(540, 560)) }
        sd.acc("a", false, "甲").apply { secs = 600; spans.add(Span(560, 570)) }
        sd.acc("b", false, "乙").apply { secs = 300; spans.add(Span(700, 705)) }

        val all = StatsCal.day(sd, null)
        assertEquals(2100, all.secs)
        assertEquals(2, all.items.size)
        assertEquals("甲", all.items[0].label)
        assertEquals(1800, all.items[0].secs)
        assertEquals(
            "相接的两段要连起来（两轨 = 同一段时间轴）",
            listOf(Span(540, 570)),
            all.items[0].spans,
        )

        assertEquals("只看自律时段内", 1200, StatsCal.day(sd, true).secs)
        assertEquals("只看时段外", 900, StatsCal.day(sd, false).secs)
    }

    @Test
    fun `空的一天不会出现在明细里`() {
        val sd = StatsDay("2026-10-30")
        sd.off["zero"] = Acc("零", "app")
        val cal = StatsCal.day(sd, null)
        assertEquals(0, cal.secs)
        assertTrue("0 秒的条目不该占一行", cal.items.isEmpty())
    }

    // ---------------------------------------------------------------- 饼图切片

    @Test
    fun `超过八项时余下的合成其他`() {
        val sd = StatsDay("2026-10-31")
        for (i in 0 until 11) {
            sd.acc("p$i", true, "应用$i").apply { secs = (11 - i) * 100 }
        }
        val slices = StatsCal.slices(listOf(d("2026-10-31") to sd), true, 8) { it }
        assertEquals(9, slices.size)
        assertEquals("p0", slices.first().key)
        assertEquals("__rest", slices.last().key)
        assertEquals("其他 3 项", slices.last().label)
        assertEquals("100+200+300", 600, slices.last().secs)
        assertEquals("合计必须等于总时长", 6600, slices.sumOf { it.secs })
    }

    @Test
    fun `不到九项时不出现其他`() {
        val sd = StatsDay("2026-10-31")
        sd.acc("a", true, "甲").apply { secs = 100 }
        sd.acc("b", true, "乙").apply { secs = 50 }
        val slices = StatsCal.slices(listOf(d("2026-10-31") to sd), true, 8) { it }
        assertEquals(listOf("a", "b"), slices.map { it.key })
    }

    // ---------------------------------------------------------------- 配色

    @Test
    fun `日历沿用饼图的颜色，新key接着排`() {
        val pie = listOf(
            Slice("a", "甲", 100, 0),
            Slice("b", "乙", 90, 1),
            Slice("c", "丙", 80, 2),
        )
        val slots = StatsCal.colorSlots(pie, mapOf("a" to 100, "b" to 90, "c" to 80, "d" to 70, "e" to 5))
        assertEquals(0, slots["a"])
        assertEquals(1, slots["b"])
        assertEquals(2, slots["c"])
        assertEquals("只在日历里出现的按用量接着排", 3, slots["d"])
        assertEquals(4, slots["e"])
    }

    @Test
    fun `其他项不占颜色`() {
        val pie = listOf(Slice("a", "甲", 100, 0), Slice("__rest", "其他 2 项", 30, 1))
        val slots = StatsCal.colorSlots(pie, mapOf("a" to 100, "z" to 20))
        assertTrue("聚合块不该有颜色", "__rest" !in slots)
        assertEquals("剩下的 key 从 0 之后的空位开始", 1, slots["z"])
    }

    @Test
    fun `颜色槽越界会绕回来`() {
        val pie = (0 until 12).map { Slice("k$it", "应用$it", 100 - it, it) }
        val slots = StatsCal.colorSlots(pie, emptyMap(), paletteSize = 12)
        assertEquals(0, slots["k0"])
        assertEquals(11, slots["k11"])
        assertEquals(12, pie.size)
    }

    @Test
    fun `一天的条目按用时从多到少`() {
        val sd = StatsDay("2026-10-31")
        sd.acc("a", true, "甲").apply { secs = 60 }
        sd.acc("b", true, "乙").apply { secs = 600 }
        val cal: CalDay = StatsCal.day(sd, true)
        assertEquals(listOf("b", "a"), cal.items.map { it.key })
    }
}
