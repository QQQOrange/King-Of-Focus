package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.HourWin
import com.qqqorange.kingoffocus.data.Slots
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 时段块：合并规则、整块平移、拉边界、冲突与边界。
 *
 * 这些断言对应界面上的三种手势（长按块身 = 平移、按头/尾 = 拉边界），
 * 所以每条都写成"用户会怎么拖"，而不是"函数返回什么"。
 */
class SlotBlockTest {

    private fun day(vararg pairs: Pair<Int, HourWin>): List<HourPlan> {
        val base = List(24) { HourPlan() }
        return base.mapIndexed { h, p ->
            val w = pairs.firstOrNull { it.first == h }?.second ?: return@mapIndexed p
            Slots.pack(listOf(w), 50, 10)
        }
    }

    @Test
    fun `同一段连续的小时并成一块`() {
        val d = day(
            9 to HourWin(0, 60, "s1"),
            10 to HourWin(0, 45, "s1"),
        )
        val b = Slots.blocks(d)
        assertEquals(1, b.size)
        assertEquals(540, b[0].startMin)
        assertEquals(645, b[0].endMin)
    }

    @Test
    fun `相邻但不是同一段时不合并`() {
        val d = day(
            9 to HourWin(0, 60, "s1"),
            10 to HourWin(0, 60, "s2"),
        )
        assertEquals(2, Slots.blocks(d).size)
    }

    @Test
    fun `同一段里重叠的窗口也只算一块`() {
        // 老数据里可能有重叠的两条窗口（导入 / 手工改）：视觉上必须还是一块
        val p = HourPlan(
            on = true, work = 50, brk = 10,
            wins = listOf(HourWin(0, 40, "s1"), HourWin(20, 60, "s1")),
        )
        val d = List(24) { if (it == 9) p else HourPlan() }
        val b = Slots.blocks(d)
        assertEquals(1, b.size)
        assertEquals(540, b[0].startMin)
        assertEquals(600, b[0].endMin)
    }

    @Test
    fun `整块平移保持长度`() {
        val d = day(9 to HourWin(0, 60, "s1"), 10 to HourWin(0, 30, "s1"))
        val moved = Slots.moveBlock(d, "s1", 60, 50, 10)
        val b = Slots.blocks(moved)
        assertEquals(1, b.size)
        assertEquals("10:00", "%02d:%02d".format(b[0].startMin / 60, b[0].startMin % 60))
        assertEquals(90, b[0].minutes)
    }

    @Test
    fun `平移撞到相邻块就停在它的边界上`() {
        // 09:00–10:00 与 11:00–12:00，把前者往下推 120 分钟 → 最多到 11:00
        val d = day(9 to HourWin(0, 60, "s1"), 11 to HourWin(0, 60, "s2"))
        val moved = Slots.moveBlock(d, "s1", 120, 50, 10)
        val b = Slots.blocks(moved)
        assertEquals(2, b.size)
        assertEquals(600, b[0].startMin)  // 10:00 而不是 11:00：60 分钟不能盖到 11:00 那段
        assertEquals(660, b[1].startMin)
    }

    @Test
    fun `平移不会越出当天`() {
        val d = day(0 to HourWin(0, 60, "s1"))
        val up = Slots.moveBlock(d, "s1", -120, 50, 10)
        assertEquals(0, Slots.blocks(up)[0].startMin)
        val late = day(23 to HourWin(0, 60, "s1"))
        val down = Slots.moveBlock(late, "s1", 120, 50, 10)
        assertEquals(1440, Slots.blocks(down)[0].endMin)
    }

    @Test
    fun `拉起点不能越过上一块 也要留一个刻度`() {
        val d = day(9 to HourWin(0, 60, "s1"), 12 to HourWin(0, 60, "s2"))
        // 想把 09 点这一块的起点拉到 13:00：上界是 终点 - 15 分钟
        val r = Slots.resizeBlock(d, "s1", top = true, minute = 13 * 60, step = 15, work = 50, brk = 10)
        assertEquals(585, Slots.blocks(r).first { it.seg == "s1" }.startMin) // 09:45
        // 往上拉过头：下界是 0
        val r2 = Slots.resizeBlock(d, "s1", top = true, minute = -60, step = 15, work = 50, brk = 10)
        assertEquals(0, Slots.blocks(r2).first { it.seg == "s1" }.startMin)
    }

    @Test
    fun `拉终点不能越过下一块`() {
        val d = day(9 to HourWin(0, 60, "s1"), 11 to HourWin(0, 60, "s2"))
        val r = Slots.resizeBlock(d, "s1", top = false, minute = 13 * 60, step = 15, work = 50, brk = 10)
        val b = Slots.blocks(r).first { it.seg == "s1" }
        assertEquals("到 11:00 为止，不能吞掉下一块", 660, b.endMin)
    }

    @Test
    fun `块级编辑不动别的小时`() {
        val d = day(9 to HourWin(0, 60, "s1"), 15 to HourWin(0, 60, "s2"))
        val r = Slots.moveBlock(d, "s1", 60, 50, 10)
        assertTrue(Slots.blocks(r).any { it.seg == "s2" && it.startMin == 900 })
    }

    @Test
    fun `块级编辑不重置番茄参数`() {
        val p = HourPlan(on = true, work = 45, brk = 15, wins = listOf(HourWin(0, 60, "s1")))
        val d = List(24) { if (it == 9) p else HourPlan() }
        val r = Slots.moveBlock(d, "s1", 60, 50, 10)
        assertEquals(45, r[10].work)
        assertEquals(15, r[10].brk)
        assertEquals(50, r[11].work) // 新占的小时用默认值
    }

    /** 03:00–04:00 与 04:00–05:00：把后面那段拖到前面，应该**换位**而不是顶住不动 */
    @Test
    fun `把后一段拖到前一段之前 会交换位置`() {
        val d = day(3 to HourWin(0, 60, "a"), 4 to HourWin(0, 60, "b"))
        val r = Slots.dragBlock(d, "b", 3 * 60, 15, 50, 10)
        val b = Slots.blocks(r)
        assertEquals("两段还是两段", 2, b.size)
        assertEquals("被拖的那段占 03:00", 180, b[0].startMin)
        assertEquals("b 现在在 03:00–04:00", "b", b[0].seg)
        assertEquals("原来那段挪到 04:00", 240, b[1].startMin)
        assertEquals("总跨度不变", 300, b[1].endMin)
    }

    @Test
    fun `拖到最顶部会成为第一段`() {
        val d = day(8 to HourWin(0, 60, "a"), 10 to HourWin(0, 60, "b"))
        val r = Slots.dragBlock(d, "b", 0, 15, 50, 10)
        val b = Slots.blocks(r)
        assertEquals("b 排到最前", "b", b[0].seg)
        assertEquals("从这一段最早的起点开始排", 480, b[0].startMin)
        assertEquals("a 跟着排到后面", 540, b[1].startMin)
    }

    @Test
    fun `拖到最底部会成为最后一段`() {
        val d = day(8 to HourWin(0, 60, "a"), 10 to HourWin(0, 60, "b"))
        val r = Slots.dragBlock(d, "a", 1440, 15, 50, 10)
        val b = Slots.blocks(r)
        assertEquals("b 变成第一段", "b", b[0].seg)
        assertEquals("a 排到最后", "a", b[1].seg)
        assertEquals("整体跨度不变", 600, b[1].endMin)
    }

    @Test
    fun `跨过中间两块 落到手指所在的位置`() {
        // a 从 03:00 拖到 05:00：落点正好是 c 的起点，所以 a 占 05:00，
        // b、c 依次上移补位 —— 块会落在**手指松开的地方**，这是最不容易错的感觉
        val d = day(
            3 to HourWin(0, 60, "a"),
            4 to HourWin(0, 60, "b"),
            5 to HourWin(0, 60, "c"),
        )
        val r = Slots.dragBlock(d, "a", 5 * 60, 15, 50, 10)
        val b = Slots.blocks(r)
        assertEquals(listOf("b", "c", "a"), b.map { it.seg })
        assertEquals(listOf(180, 240, 300), b.map { it.startMin })
        assertEquals("a 落在 05:00–06:00", 360, b[2].endMin)
    }

    @Test
    fun `往上拖到中间起点时 排在它前面`() {
        // c 从 05:00 拖到 04:00（b 的起点）：往上拖的齐平按"排到它前面"算
        val d = day(
            3 to HourWin(0, 60, "a"),
            4 to HourWin(0, 60, "b"),
            5 to HourWin(0, 60, "c"),
        )
        val r = Slots.dragBlock(d, "c", 4 * 60, 15, 50, 10)
        val b = Slots.blocks(r)
        assertEquals(listOf("a", "c", "b"), b.map { it.seg })
    }

    @Test
    fun `没越过别的块时还是自由平移`() {
        val d = day(3 to HourWin(0, 60, "a"))
        val r = Slots.dragBlock(d, "a", 5 * 60, 15, 50, 10)
        assertEquals(300, Slots.blocks(r)[0].startMin)
    }

    @Test
    fun `长度不同的相邻块重排后不重叠 总跨度不变`() {
        // 03–04（1 小时）+ 04–06（2 小时）：把 2 小时那段拖到 03:00
        val d = day(3 to HourWin(0, 60, "a"), 4 to HourWin(0, 60, "b"), 5 to HourWin(0, 60, "b"))
        val r = Slots.dragBlock(d, "b", 3 * 60, 15, 50, 10)
        val b = Slots.blocks(r)
        assertEquals(2, b.size)
        assertEquals("b 在前", "b", b[0].seg)
        assertEquals(180, b[0].startMin)
        assertEquals(300, b[0].endMin)
        assertEquals("a 接在后面", 300, b[1].startMin)
        assertEquals(360, b[1].endMin)
    }

    @Test
    fun `拖出当天会被夹住`() {
        val d = day(23 to HourWin(0, 60, "a"))
        val r = Slots.dragBlock(d, "a", 5000, 15, 50, 10)
        assertEquals(1380, Slots.blocks(r)[0].startMin)
        val r2 = Slots.dragBlock(d, "a", -500, 15, 50, 10)
        assertEquals(0, Slots.blocks(r2)[0].startMin)
    }

    @Test
    fun `找不到段时原样返回`() {
        val d = day(9 to HourWin(0, 60, "s1"))
        assertEquals(d, Slots.moveBlock(d, "不存在", 60, 50, 10))
        assertEquals(d, Slots.resizeBlock(d, "不存在", true, 600, 15, 50, 10))
        assertNull(Slots.blockAt(day(9 to HourWin(0, 60, "s1")), 700))
    }

    @Test
    fun `老数据拖动前补段标识只动那一块`() {
        val d = day(9 to HourWin(0, 60, ""), 11 to HourWin(0, 60, ""))
        val first = Slots.blocks(d).first()
        val r = Slots.assignSeg(d, first, "new", 50, 10)
        val b = Slots.blocks(r)
        assertEquals(2, b.size)
        assertEquals("new", b[0].seg)
        assertEquals("不碰另一块", "", b[1].seg)
    }
}
