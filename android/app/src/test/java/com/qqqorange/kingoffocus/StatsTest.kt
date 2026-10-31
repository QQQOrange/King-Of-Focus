package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.Span
import com.qqqorange.kingoffocus.core.StatsMath
import com.qqqorange.kingoffocus.core.StatsStore
import com.qqqorange.kingoffocus.core.StatsTrack
import com.qqqorange.kingoffocus.core.fmtDuration
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.Rule
import com.qqqorange.kingoffocus.data.defaultDays
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.LocalDate
import java.time.LocalDateTime

/**
 * 使用时长统计的口径测试。
 *
 * 这一组守的是「数字对不对」，不是「页面好不好看」：
 *  · 一次结算必须按真实经过的秒数记账，并且跨整点/跨天要切开；
 *  · 自律生效中 / 时段外 两套数据完全隔离；
 *  · 连续使用段要能回答"几点到几点在用"；
 *  · 老格式（分轨之前的数据）读进来不能崩、也不能凭空变成自律时段内的数据。
 */
class StatsTest {

    private fun tmpDir(): File = Files.createTempDirectory("kof-stats").toFile()

    private fun at(h: Int, m: Int, s: Int = 0): LocalDateTime =
        LocalDateTime.of(2026, 10, 31, h, m, s) // 周六

    // ---------------------------------------------------------------- 切分

    @Test
    fun `一次结算跨整点会切开`() {
        val from = at(9, 59, 50)
        val parts = StatsMath.slices(from, from.plusSeconds(20))
        assertEquals(listOf(9 to 10, 10 to 10), parts.map { it.hour to it.secs })
        assertEquals("2026-10-31", parts[0].date)
    }

    @Test
    fun `跨天不把今天的秒算到明天`() {
        val from = LocalDateTime.of(2026, 10, 31, 23, 59, 58)
        val to = LocalDateTime.of(2026, 11, 1, 0, 0, 2)
        val parts = StatsMath.slices(from, to)
        assertEquals(
            listOf("2026-10-31" to 23, "2026-11-01" to 0),
            parts.map { it.date to it.hour },
        )
        assertEquals("两边各 2 秒", listOf(2, 2), parts.map { it.secs })
    }

    @Test
    fun `补账有上限：休眠一小时不会全算成使用`() {
        val from = at(9, 0)
        val parts = StatsMath.slices(from, from.plusHours(1))
        assertEquals("最多按 5 分钟结算一次", 300, parts.sumOf { it.secs })
    }

    @Test
    fun `时间倒退或零长度不算`() {
        assertTrue(StatsMath.slices(at(9, 0), at(9, 0)).isEmpty())
        assertTrue(StatsMath.slices(at(9, 5), at(9, 0)).isEmpty())
    }

    // ---------------------------------------------------------------- 双轨

    @Test
    fun `自律时段内与时段外完全隔离`() {
        val dir = tmpDir()
        StatsStore.useDirForTest(dir)
        val t = at(9, 0)
        StatsStore.record(t, t.plusSeconds(30), "pkg.a", "A", onTrack = true)
        StatsStore.record(t, t.plusSeconds(10), "pkg.a", "A", onTrack = false)
        StatsStore.record(t, t.plusSeconds(20), "pkg.b", "B", onTrack = false)

        val day = StatsStore.today(t)
        assertEquals(30, day.total(true))
        assertEquals(30, day.total(false))
        assertEquals(60, StatsMath.total(day, null))
        assertEquals(30, StatsMath.hourly(day, true)[9])
        assertEquals(30, StatsMath.hourly(day, false)[9])
        assertEquals(60, StatsMath.hourly(day, null)[9])
        assertEquals(
            "排行分轨：时段外 b 更长（a 的 30 秒在另一轨）",
            listOf("pkg.b", "pkg.a"),
            StatsMath.top(listOf(t.toLocalDate() to day), false).map { it.first },
        )
        assertEquals(
            listOf("pkg.a"),
            StatsMath.top(listOf(t.toLocalDate() to day), true).map { it.first },
        )
    }

    @Test
    fun `落盘后重新读回来数字不变`() {
        val dir = tmpDir()
        StatsStore.useDirForTest(dir)
        val t = at(14, 30)
        StatsStore.record(t, t.plusSeconds(20), "pkg.a", "A", onTrack = true)
        StatsStore.record(t, t.plusSeconds(7), "pkg.c", "C", onTrack = false)
        StatsStore.closeSpan()
        StatsStore.flush()

        // 换一个"进程"读：清掉缓存
        StatsStore.useDirForTest(dir)
        val day = StatsStore.day(LocalDate.of(2026, 10, 31))
        assertEquals(20, day.total(true))
        assertEquals(7, day.total(false))
        assertEquals("A", day.on["pkg.a"]?.label)
        assertEquals("段也要落盘", 1, day.on["pkg.a"]?.spans?.size)
    }

    // ---------------------------------------------------------------- 连续使用段

    @Test
    fun `连续的两拍并成一段，隔开就断开`() {
        val dir = tmpDir()
        StatsStore.useDirForTest(dir)
        val t0 = at(9, 0)
        StatsStore.record(t0, t0.plusSeconds(30), "pkg.a", "A", onTrack = true)
        StatsStore.record(t0, t0.plusSeconds(60), "pkg.a", "A", onTrack = true)
        StatsStore.record(t0, t0.withMinute(1).plusSeconds(30), "pkg.a", "A", onTrack = true)
        StatsStore.closeSpan()

        var spans = StatsStore.today(t0).on["pkg.a"]!!.spans
        assertEquals("同一段应该被并起来", 1, spans.size)
        assertTrue("覆盖 9:00 起至少两分钟", spans[0].mins >= 2)

        // 隔了 4 分钟再回来 → 新的一段
        val t1 = at(9, 5)
        StatsStore.record(t1, t1.plusSeconds(30), "pkg.a", "A", onTrack = true)
        StatsStore.closeSpan()
        spans = StatsStore.today(t0).on["pkg.a"]!!.spans
        assertEquals(2, spans.size)
        assertEquals(545, spans[1].f)
    }

    @Test
    fun `落盘会带上还没封口的那一段`() {
        // 一直在用一个应用时，那一段永远不封口；如果只写"已封口"的段，
        // 页面上明细就会缺最后一段，看起来像"我明明在用，怎么没有这一段"。
        val dir = tmpDir()
        StatsStore.useDirForTest(dir)
        val t = at(15, 0)
        StatsStore.record(t, t.plusSeconds(30), "pkg.a", "A", onTrack = true)
        StatsStore.flush()
        StatsStore.useDirForTest(dir) // 假装进程重启，强制从文件读
        val day = StatsStore.day(t.toLocalDate())
        assertEquals(1, day.on["pkg.a"]?.spans?.size)
        assertEquals(30, day.on["pkg.a"]?.secs)
    }

    @Test
    fun `反复落盘不会把同一段写重复`() {
        val dir = tmpDir()
        StatsStore.useDirForTest(dir)
        val t = at(16, 0)
        StatsStore.record(t, t.plusSeconds(20), "pkg.a", "A", onTrack = true)
        repeat(3) { StatsStore.flush() }
        StatsStore.useDirForTest(dir)
        val day = StatsStore.day(t.toLocalDate())
        assertEquals("每段只该出现一次", 1, day.on["pkg.a"]?.spans?.size)
    }

    @Test
    fun `明细把两轨的段合到一条时间轴上`() {
        val dir = tmpDir()
        StatsStore.useDirForTest(dir)
        val t = at(10, 0)
        StatsStore.record(t, t.plusSeconds(30), "pkg.a", "A", onTrack = true)
        StatsStore.closeSpan()
        StatsStore.record(t.withMinute(10), t.withMinute(10).plusSeconds(30), "pkg.a", "A", onTrack = false)
        StatsStore.closeSpan()

        val day = StatsStore.today(t)
        val spans = StatsStore.spansOf("pkg.a", listOf(t.toLocalDate() to day))
        assertEquals(2, spans.size)
        assertEquals(t.withMinute(10).toLocalDate(), spans[1].first)
        assertEquals(610, spans[1].second.f)
    }

    @Test
    fun `mergeSpans 合并相邻与重叠`() {
        val merged = StatsMath.mergeSpans(listOf(Span(600, 620), Span(621, 640), Span(700, 710)))
        assertEquals(2, merged.size)
        assertEquals(600 to 640, merged[0].f to merged[0].t)
        assertEquals(700 to 710, merged[1].f to merged[1].t)
    }

    // ---------------------------------------------------------------- 老数据

    @Test
    fun `老格式（没有轨）读进来落到时段外，不会崩`() {
        val dir = tmpDir()
        val legacy = """{"date":"2026-10-30","apps":{"pkg.old":[0,0,0,0,0,0,0,0,120,60,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}}"""
        File(dir, "2026-10-30.json").writeText(legacy)
        StatsStore.useDirForTest(dir)

        val day = StatsStore.day(LocalDate.of(2026, 10, 30))
        assertEquals("老数据没有自律状态，只能算时段外", 180, day.total(false))
        assertEquals(0, day.total(true))
        assertEquals(120, day.off["pkg.old"]?.hours?.get(8))
        assertEquals("那时没有段，明细为空但不炸", 0, day.off["pkg.old"]?.spans?.size)
    }

    @Test
    fun `坏文件不会把当天读数变成崩溃`() {
        val dir = tmpDir()
        File(dir, "2026-10-29.json").writeText("{ 这不是 json")
        StatsStore.useDirForTest(dir)
        val day = StatsStore.day(LocalDate.of(2026, 10, 29))
        assertEquals(0, day.totalAll())
    }

    @Test
    fun `保留天数按文件数清理`() {
        val dir = tmpDir()
        StatsStore.useDirForTest(dir)
        for (i in 1..12) {
            File(dir, "2026-09-%02d.json".format(i)).writeText("""{"date":"2026-09-%02d"}""".format(i))
        }
        StatsStore.prune(7)
        assertEquals(7, dir.listFiles { f -> f.name.endsWith(".json") }?.size)
    }

    // ---------------------------------------------------------------- 双轨判定

    private fun cfgWith(hour: Int, rules: List<Rule> = emptyList(), work: Int = 60, brk: Int = 0): Config {
        val days = defaultDays().map { it.toMutableList() }.toMutableList()
        days[5][hour] = HourPlan(true, work, brk, 0, 60) // 周六
        return Config(enabled = true, days = days, rules = rules)
    }

    @Test
    fun `只配时段没配规则，也算自律生效中`() {
        // 桌面端 monitor.rs 的 discipline_on = 规则生效 || 时段专注 || 锁机。
        // 早期手机端只判规则，于是"只排了时段"的时间全被记到时段外。
        val c = cfgWith(9)
        assertTrue(StatsTrack.on(c, at(9, 10)))
        assertFalse("10 点没排", StatsTrack.on(c, at(10, 10)))
        assertFalse("总开关关了就不算", StatsTrack.on(c.copy(enabled = false), at(9, 10)))
    }

    @Test
    fun `休息段不算自律生效中`() {
        val c = cfgWith(9, work = 45, brk = 15)
        assertTrue(StatsTrack.on(c, at(9, 10)))
        assertFalse("09:50 是休息", StatsTrack.on(c, at(9, 50)))
    }

    @Test
    fun `时长读法`() {
        assertEquals("45 秒", fmtDuration(45))
        assertEquals("59 分钟", fmtDuration(59 * 60))
        assertEquals("1 小时", fmtDuration(3600))
        assertEquals("1 小时 23 分", fmtDuration(3600 + 23 * 60))
    }
}
