package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.HourWin
import com.qqqorange.kingoffocus.data.Slots
import com.qqqorange.kingoffocus.data.defaultDays
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 十分钟/十五分钟刻度的算术。
 *
 * 这些断言守的是"刻度只改画法、不改数据"：同一份窗口在两种刻度下必须表达同样的分钟数，
 * 一小时里能不能有两段、取消中间一格会不会把一小时劈成两半，全都靠 [Slots]。
 */
class SlotsTest {

    private fun emptyDay(): List<HourPlan> = List(24) { HourPlan() }

    private fun hourOf(day: List<HourPlan>, h: Int) = day[h]

    @Test
    fun `格子到分钟的映射在两种刻度下都对齐整点`() {
        assertEquals(96, Slots.slotsPerDay(15))
        assertEquals(144, Slots.slotsPerDay(10))
        // 15 分钟：第 95 格 = 23:45
        assertEquals(23, Slots.hourOfSlot(95, 15))
        assertEquals(45, Slots.offsetOfSlot(95, 15))
        // 10 分钟：第 137 格 = 22:50
        assertEquals(22, Slots.hourOfSlot(137, 10))
        assertEquals(50, Slots.offsetOfSlot(137, 10))
        // 两种刻度都不能有一格跨小时（否则"一小时一格"的判定就崩了）
        for (step in listOf(10, 15)) {
            for (slot in 0 until Slots.slotsPerDay(step)) {
                val abs = slot * step
                assertEquals("第 $slot 格在 $step 刻度下的小时", abs / 60, Slots.hourOfSlot(slot, step))
                assertEquals("第 $slot 格在 $step 刻度下的分钟", abs % 60, Slots.offsetOfSlot(slot, step))
            }
        }
    }

    @Test
    fun `涂一格再涂一次就撤销`() {
        var day = Slots.paintSlot(emptyDay(), 36, 15, true, 45, 15) // 09:00-09:15
        assertEquals(15, Slots.dayMinutes(day))
        assertTrue(Slots.covers(hourOf(day, 9), 0))

        day = Slots.paintSlot(day, 36, 15, false, 45, 15)
        assertEquals(0, Slots.dayMinutes(day))
        assertFalse(hourOf(day, 9).on)
    }

    @Test
    fun `同一小时里的两段互不吞并`() {
        // 10 分钟刻度：涂 09:00-09:10 和 09:20-09:30
        var day = Slots.paintSlot(emptyDay(), 54, 10, true, 45, 15)
        day = Slots.paintSlot(day, 56, 10, true, 45, 15)
        val h = hourOf(day, 9)
        assertEquals(2, h.wins.size)
        assertEquals(HourWin(0, 10), h.wins[0])
        assertEquals(HourWin(20, 30), h.wins[1])
        // 外包区间仍然是 0..30（给老代码看的），但中间那 10 分钟不算选中
        assertEquals(0, h.from)
        assertEquals(30, h.to)
        assertFalse("中间的空档不能被算成选中", Slots.covers(h, 15))
        assertEquals(20, Slots.dayMinutes(day))
    }

    @Test
    fun `相邻格子会合并成一段`() {
        var day = emptyDay()
        for (slot in 54..56) day = Slots.paintSlot(day, slot, 10, true, 45, 15) // 09:00-09:30
        val h = hourOf(day, 9)
        assertEquals("只有一段时不写 wins，序列化形状和以前一样", 0, h.wins.size)
        assertEquals(0, h.from)
        assertEquals(30, h.to)
        assertTrue(h.on)
    }

    @Test
    fun `取消中间一格会把一小时劈成两段`() {
        // 先整小时选上，再去掉 09:20-09:30
        var day = Slots.paintDay(emptyDay(), true, 45, 15)
        day = Slots.paintSlot(day, 56, 10, false, 45, 15)
        val h = hourOf(day, 9)
        assertEquals(2, h.wins.size)
        assertEquals(HourWin(0, 20), h.wins[0])
        assertEquals(HourWin(30, 60), h.wins[1])
        assertEquals("全天 24 小时减掉这 10 分钟", 1440 - 10, Slots.dayMinutes(day))
    }

    @Test
    fun `刻度切换不动数据，只留下半格提示`() {
        // 15 分钟刻度下排 09:00-09:45
        var day = emptyDay()
        for (slot in 36..38) day = Slots.paintSlot(day, slot, 15, true, 45, 15)
        val before = Slots.dayMinutes(day)

        // 换成 10 分钟刻度：数据一个字都不该变
        assertEquals(before, Slots.dayMinutes(day))
        assertEquals(45, before)

        // 10 分钟刻度下：09:00-09:10 是完整一格；09:40-09:50 只覆盖到 09:45 → 半格
        val h = hourOf(day, 9)
        val full = Slots.windowsOf(h).sumOf { maxOf(0, minOf(it.to, 10) - maxOf(it.from, 0)) }
        val half = Slots.windowsOf(h).sumOf { maxOf(0, minOf(it.to, 50) - maxOf(it.from, 40)) }
        assertEquals(10, full)
        assertEquals(5, half)
    }

    @Test
    fun `多涂一格不会把调过的番茄重置成默认值`() {
        var day = emptyDay()
        day = Slots.paintSlot(day, 36, 15, true, 25, 5) // 09:00-09:15，25/5
        assertEquals(25, hourOf(day, 9).work)
        day = Slots.paintSlot(day, 37, 15, true, 45, 15) // 再涂 09:15-09:30，用的还是默认 45/15
        assertEquals("这一小时本来就选着一部分，番茄参数要沿用", 25, hourOf(day, 9).work)
        assertEquals(5, hourOf(day, 9).brk)
    }

    @Test
    fun `坏窗口在打包时被丢掉`() {
        // from ≥ to：手改坏的配置不能变成"整小时选中"
        val bad = Slots.pack(listOf(HourWin(40, 10)), 45, 15)
        assertFalse(bad.on)
        assertEquals(0, Slots.dayMinutes(listOf(bad)))
    }

    @Test
    fun `重叠的窗口会合并`() {
        val p = Slots.pack(listOf(HourWin(0, 20), HourWin(10, 30), HourWin(25, 40)), 45, 15)
        assertTrue(p.on)
        assertEquals("合并成一段后 wins 应当为空", 0, p.wins.size)
        assertEquals(0, p.from)
        assertEquals(40, p.to)
    }

    @Test
    fun `拖选区间与方向无关，且包含两端`() {
        assertEquals("往下拖", 4..10, Slots.dragRange(4, 10))
        assertEquals("往上拖结果一样", 4..10, Slots.dragRange(10, 4))
        assertEquals("原地不动只含一格", 7..7, Slots.dragRange(7, 7))
    }

    @Test
    fun `fmtMinutes 读起来像人话`() {
        assertEquals("0 分钟", Slots.fmtMinutes(0))
        assertEquals("45 分钟", Slots.fmtMinutes(45))
        assertEquals("3 小时", Slots.fmtMinutes(180))
        assertEquals("3 小时 20 分", Slots.fmtMinutes(200))
    }
}
