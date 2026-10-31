package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.Span
import com.qqqorange.kingoffocus.core.StatsDay
import com.qqqorange.kingoffocus.core.StatsMetrics
import com.qqqorange.kingoffocus.core.StatsStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * 三项指标（时长 / 次数 / 时段）的计算口径。
 *
 * 这三项是统计页的骨架：饼图看时长占比、柱状看时段分布、列表看次数与单次长度。
 * 任何一项在某个档位下"算不出来"，那个档位就是不完整的——所以这里对
 * 自律时段内 / 时段外 / 汇总 三档都各钉一遍。
 */
class StatsMetricsTest {

    private fun d(s: String): LocalDate = LocalDate.parse(s)

    /** 造一天：on/off 各自 (secs, spans) */
    private fun day(
        date: String,
        on: Map<String, Pair<String, Pair<Int, List<Span>>>> = emptyMap(),
        off: Map<String, Pair<String, Pair<Int, List<Span>>>> = emptyMap(),
    ): StatsDay {
        val sd = StatsDay(date)
        for ((k, v) in on) {
            val (label, secs, spans) = Triple(v.first, v.second.first, v.second.second)
            sd.acc(k, true, label).apply {
                this.secs = secs
                spans.forEach { this.spans.add(it) }
                for (sp in spans) this.hours[sp.f / 60] += (sp.t - sp.f) * 60
            }
        }
        for ((k, v) in off) {
            val (label, secs, spans) = Triple(v.first, v.second.first, v.second.second)
            sd.acc(k, false, label).apply {
                this.secs = secs
                spans.forEach { this.spans.add(it) }
                for (sp in spans) this.hours[sp.f / 60] += (sp.t - sp.f) * 60
            }
        }
        return sd
    }

    private fun days(vararg ds: StatsDay): List<Pair<LocalDate, StatsDay>> =
        ds.map { d(it.date) to it }

    @Test
    fun `时长为零时三项都是空`() {
        val s = StatsMetrics.scope(days(StatsDay("2026-10-31")), null)
        assertTrue(s.empty)
        assertEquals(-1, s.peakHour)
        assertEquals(-1, s.firstMin)
        assertTrue(s.items.isEmpty())
    }

    @Test
    fun `三项指标在两档下都算得出来`() {
        // 自律时段内：Chrome 两段（9:00-9:20, 10:00-10:10）
        // 时段外：Chrome 一段（20:00-20:30）+ Messages 一段
        val sd = day(
            "2026-10-31",
            on = mapOf("chrome" to ("Chrome" to (1800 to listOf(Span(540, 560), Span(600, 610))))),
            off = mapOf(
                "chrome" to ("Chrome" to (1800 to listOf(Span(1200, 1230)))),
                "msg" to ("Messages" to (600 to listOf(Span(1260, 1270)))),
            ),
        )
        val ds = days(sd)

        val on = StatsMetrics.scope(ds, true)
        assertEquals("时长", 1800, on.secs)
        assertEquals("次数", 2, on.sessions)
        assertEquals("平均一次", 900, on.avgSec)
        assertEquals("最长一次", 1200, on.longestSec)
        assertEquals("峰值小时", 9, on.peakHour)
        assertEquals("最早开始", 540, on.firstMin)
        assertEquals("最晚结束", 610, on.lastMin)
        assertEquals("有数据的整点数", 2, on.activeHours)

        val off = StatsMetrics.scope(ds, false)
        assertEquals(2400, off.secs)
        assertEquals(2, off.sessions)
        assertEquals(20, off.peakHour)

        val all = StatsMetrics.scope(ds, null)
        assertEquals("汇总时长 = 两档相加", 4200, all.secs)
        assertEquals("汇总次数", 4, all.sessions)
        assertEquals("汇总峰值小时：20 点", 20, all.peakHour)
        assertEquals("9/10/20/21 四个整点都有数据", 4, all.activeHours)
    }

    @Test
    fun `汇总时同一应用的跨档段要连起来算一次`() {
        // 自律时段内 9:00-9:20，接着时段外 9:20-9:40 —— 同一次连续使用
        val sd = day(
            "2026-10-31",
            on = mapOf("chrome" to ("Chrome" to (1200 to listOf(Span(540, 560))))),
            off = mapOf("chrome" to ("Chrome" to (1200 to listOf(Span(560, 580))))),
        )
        val all = StatsMetrics.scope(days(sd), null)
        assertEquals("两段相接 → 1 次", 1, all.sessions)
        assertEquals(2400, all.secs)
        assertEquals("单次长度 = 两段之和", 2400, all.longestSec)
    }

    @Test
    fun `每小时分解出来的是两档各自的量`() {
        val sd = day(
            "2026-10-31",
            on = mapOf("a" to ("甲" to (600 to listOf(Span(540, 550))))),
            off = mapOf("a" to ("甲" to (300 to listOf(Span(1220, 1225))))),
        )
        val (on, off) = StatsMetrics.hourlyBoth(days(sd))
        assertEquals(600, on[9])
        assertEquals(0, on[20])
        assertEquals(300, off[20])
        assertEquals(0, off[9])
    }

    @Test
    fun `点某一小时能看到那个小时的明细`() {
        val sd = day(
            "2026-10-31",
            on = mapOf(
                "a" to ("甲" to (600 to listOf(Span(540, 550)))),
                "b" to ("乙" to (1800 to listOf(Span(560, 590)))),
            ),
        )
        val at9 = StatsMetrics.atHour(days(sd), true, 9)
        assertEquals(listOf("b", "a"), at9.map { it.key })
        assertEquals(1800, at9[0].secs)
        assertTrue("别的小时不该冒出来", StatsMetrics.atHour(days(sd), true, 15).isEmpty())
    }

    @Test
    fun `跨多天时次数与最早最晚按天号比较`() {
        val sd1 = day("2026-10-30", on = mapOf("a" to ("甲" to (600 to listOf(Span(480, 490))))))
        val sd2 = day("2026-10-31", on = mapOf("a" to ("甲" to (600 to listOf(Span(1200, 1210))))))
        val s = StatsMetrics.scope(listOf(d(("2026-10-30")) to sd1, d("2026-10-31") to sd2), true)
        assertEquals(2, s.sessions)
        assertEquals("最早 = 08:00", 480, s.firstMin)
        assertEquals("最晚 = 20:10", 1210, s.lastMin)
        assertEquals(2, s.days)
    }

    @Test
    fun `没有段的老数据：次数为 0 但不丢时长`() {
        val dir = java.nio.file.Files.createTempDirectory("kof-metrics").toFile()
        StatsStore.useDirForTest(dir)
        // 直接落一份老格式（只有小时桶，没有 spans）
        java.io.File(dir, "2026-10-29.json").writeText(
            """{"date":"2026-10-29","apps":{"old":[0,0,0,0,0,0,0,0,600,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}}""",
        )
        val ds = listOf(d("2026-10-29") to StatsStore.day(d("2026-10-29")))
        val s = StatsMetrics.scope(ds, false)
        assertEquals(600, s.secs)
        assertEquals("没有段就没有次数", 0, s.sessions)
        assertEquals(-1, s.firstMin)
        assertEquals("峰值小时照样有", 8, s.peakHour)
    }
}
