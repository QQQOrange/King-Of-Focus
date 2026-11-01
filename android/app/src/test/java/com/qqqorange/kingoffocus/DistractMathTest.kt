package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.DistractMath
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.DistractCfg
import com.qqqorange.kingoffocus.data.DistractItem
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.defaultDays
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime

/**
 * 分心事件的纯逻辑测试。
 *
 * 重点与桌面端 `distract::tests` 一一对应：**时段归属**（哪几个小时算一段）
 * 和**提醒节奏**（什么时候该催、什么时候不该催）。这两件事一旦算错，
 * 用户看到的要么是"时段结束了却没汇总"，要么是"一天被催二十次"。
 */
class DistractMathTest {

    private fun cfg(hours: List<Pair<Int, Int>>): Config {
        val days = defaultDays().map { it.toMutableList() }.toMutableList()
        hours.forEach { (h, to) ->
            days[0][h] = HourPlan(
                on = true,
                work = 50,
                brk = 10,
                from = 0,
                to = to,
                seg = "s",
            )
        }
        return Config(enabled = true, days = days)
    }

    private fun at(h: Int, m: Int): LocalDateTime =
        LocalDate.of(2026, 11, 2).atTime(h, m) // 2026-11-02 是周一

    @Test
    fun threeHoursMergeIntoOneSegment() {
        val seg = DistractMath.segmentBounds(cfg(listOf(9 to 60, 10 to 60, 11 to 60)), at(10, 20))
        assertEquals("09:00–12:00", seg?.label)
        assertEquals(3 * 3600L, (seg!!.end - seg.start))
    }

    @Test
    fun gapBreaksTheSegment() {
        val seg = DistractMath.segmentBounds(cfg(listOf(9 to 60, 11 to 60)), at(11, 30))
        assertEquals("11:00–12:00", seg?.label)
        assertEquals(3600L, seg!!.end - seg.start)
    }

    @Test
    fun partialHourStaysItsOwnSegment() {
        val seg = DistractMath.segmentBounds(cfg(listOf(9 to 45)), at(9, 20))
        assertEquals("09:00–09:45", seg?.label)
        assertEquals(45 * 60L, seg!!.end - seg.start)
    }

    @Test
    fun outsideHoursHasNoSegment() {
        assertNull(DistractMath.segmentBounds(cfg(listOf(9 to 60)), at(13, 0)))
    }

    @Test
    fun disabledScheduleHasNoSegment() {
        val c = cfg(listOf(9 to 60)).copy(enabled = false)
        assertNull(DistractMath.segmentBounds(c, at(10, 0)))
    }

    // ------------------------------------------------------------ 提醒

    private fun item(id: String, at: Long, done: Boolean = false, nudged: Long = 0) =
        DistractItem(
            id = id,
            text = "想法 $id",
            at = at,
            day = "2026-11-02",
            done = done,
            nudgedAt = nudged,
        )

    private fun c2(min: Int, days: Int = 7): Config =
        Config(distract = DistractCfg(enabled = true, remindMinutes = min, remindMaxDays = days))

    @Test
    fun nudgesRespectIntervalAndDoneFlag() {
        val now = 1_000_000L
        // 1_000_000 秒 ≈ 1970-01-12，day 字段不影响提醒判定
        val items = listOf(
            item("old", now - 7200),
            item("fresh", now - 60),
            item("done", now - 7200, done = true),
        )
        val due = DistractMath.dueOf(items, c2(60), now)
        assertEquals(1, due.size)
        assertEquals("old", due[0].id)

        // 催过一次、间隔没到 → 不再催
        val again = listOf(item("old", now - 7200, nudged = now - 60))
        assertTrue(DistractMath.dueOf(again, c2(60), now).isEmpty())

        // 关掉模块 → 一条都不催
        assertTrue(DistractMath.dueOf(items, c2(60).copy(distract = DistractCfg(enabled = false)), now).isEmpty())

        // 间隔 0 = 只在时段结束提醒
        assertTrue(DistractMath.dueOf(items, c2(0), now).isEmpty())
    }

    @Test
    fun staleItemsStopNagging() {
        val now = 10 * 86400L
        val items = listOf(item("ancient", 0))
        assertTrue(DistractMath.dueOf(items, c2(60, days = 1), now).isEmpty())
    }

    // ------------------------------------------------------------ 日历 / 分组

    @Test
    fun monthCountsPerDay() {
        val items = listOf(
            item("a", 1).copy(day = "2026-11-02"),
            item("b", 2).copy(day = "2026-11-02", done = true),
            item("c", 3).copy(day = "2026-11-03"),
            item("d", 4).copy(day = "2026-12-01"),
        )
        val m = DistractMath.monthCounts(items, "2026-11")
        assertEquals(2, m["2026-11-02"]?.total)
        assertEquals(1, m["2026-11-02"]?.done)
        assertEquals(1, m["2026-11-03"]?.total)
        assertNull(m["2026-12-01"])
    }

    @Test
    fun dayGroupsSplitBySegmentAndSortDesc() {
        val items = listOf(
            item("a", 100).copy(day = "2026-11-02", segStart = 0, segLabel = ""),
            item("b", 200).copy(day = "2026-11-02", segStart = 900, segLabel = "09:00–12:00"),
            item("c", 300).copy(day = "2026-11-02", segStart = 900, segLabel = "09:00–12:00"),
            item("d", 400).copy(day = "2026-11-03", segStart = 900),
        )
        val g = DistractMath.dayGroups(items, "2026-11-02")
        assertEquals(2, g.size)
        // 有段的在前，段内按时间倒序
        assertEquals("09:00–12:00", g[0].label)
        assertEquals(listOf("c", "b"), g[0].items.map { it.id })
        // 没段的归到"不在自律时段内"
        assertEquals("不在自律时段内", g[1].label)
        assertEquals(listOf("a"), g[1].items.map { it.id })
    }

    @Test
    fun endedSegmentMatchesAroundPlannedEnd() {
        val now = 1_000_000L
        val items = listOf(
            item("just", now - 60).copy(segEnd = now + 30),
            item("old", now - 60).copy(segEnd = now - 3600),
            item("done", now - 60, done = true).copy(segEnd = now),
        )
        val hit = DistractMath.endedSegment(items, now)
        assertEquals(listOf("just"), hit.map { it.id })
    }

    @Test
    fun validDayRejectsGarbage() {
        assertTrue(DistractMath.validDay("2026-11-02"))
        assertTrue(!DistractMath.validDay("2026-13-99"))
        assertTrue(!DistractMath.validDay(""))
    }

    // ---------------- 上一段：做到了吗 ----------------

    private fun goal(seg: LocalDateTime, text: String, state: String = ""): com.qqqorange.kingoffocus.data.Goal =
        com.qqqorange.kingoffocus.data.Goal(
            seg = seg.atZone(java.time.ZoneId.systemDefault()).toEpochSecond(),
            text = text,
            day = seg.toLocalDate().toString(),
            state = state,
        )

    /** 只挑"已经结束、且写了目标"的那一段 */
    @Test
    fun lastEndedPicksFinishedGoal() {
        val c = cfg(listOf(9 to 60)) // 只有周一 09:00–10:00
        val goals = listOf(goal(at(9, 0), "写完登录页"))
        // 还在段里：不算"上一段"
        assertNull(DistractMath.lastEndedGoal(c, goals, at(9, 30)))
        // 段结束后 10 分钟：命中
        val hit = DistractMath.lastEndedGoal(c, goals, at(10, 10))
        assertEquals("写完登录页", hit?.goal)
        assertEquals("", hit?.state)
    }

    /** 超过 6 小时就不再问：早上那段到晚上还追着问 = 骚扰 */
    @Test
    fun lastEndedExpiresAfterSixHours() {
        val c = cfg(listOf(9 to 60))
        val goals = listOf(goal(at(9, 0), "写完登录页"))
        assertNull(DistractMath.lastEndedGoal(c, goals, at(17, 0)))
        // 刚好 6 小时整还算（边界不苛刻到分钟）
        assertEquals("写完登录页", DistractMath.lastEndedGoal(c, goals, at(16, 0))?.goal)
    }

    /** 没写目标的段不该冒出来问"做到了吗" */
    @Test
    fun lastEndedSkipsEmptyGoals() {
        val c = cfg(listOf(9 to 60))
        assertNull(DistractMath.lastEndedGoal(c, listOf(goal(at(9, 0), "   ")), at(10, 10)))
    }

    /** 同一批里取**最近**的那一段 */
    @Test
    fun lastEndedTakesMostRecent() {
        val c = cfg(listOf(9 to 60, 11 to 60))
        val goals = listOf(goal(at(9, 0), "第一段"), goal(at(11, 0), "第二段", "done"))
        val hit = DistractMath.lastEndedGoal(c, goals, at(13, 0))
        assertEquals("第二段", hit?.goal)
        assertEquals("done", hit?.state)
    }
}
