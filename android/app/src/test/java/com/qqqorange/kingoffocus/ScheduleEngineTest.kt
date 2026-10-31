package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.GuardEngine
import com.qqqorange.kingoffocus.core.ScheduleEngine
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.HourWin
import com.qqqorange.kingoffocus.data.Rule
import com.qqqorange.kingoffocus.data.defaultDays
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 时段与拦截判定的核心断言。
 *
 * 这些用例全部来自桌面版踩过的坑（番茄相位、窗口裁剪、解锁窗口、系统壳放行），
 * Android 端必须保持同一套语义，否则两个平台的"自律"会给出不同答案。
 */
class ScheduleEngineTest {

    private fun monday(hour: Int, minute: Int, second: Int = 0): LocalDateTime =
        LocalDateTime.of(2026, 10, 26, hour, minute, second) // 2026-10-26 是周一

    private fun cfg(hour: Int = 9, work: Int = 45, brk: Int = 15, from: Int = 0, to: Int = 60): Config {
        val days = defaultDays().map { it.toMutableList() }.toMutableList()
        days[0][hour] = HourPlan(true, work, brk, from, to)
        return Config(enabled = true, days = days)
    }

    @Test
    fun `未启用时没有状态`() {
        val c = cfg().copy(enabled = false)
        assertNull(ScheduleEngine.stateAt(c, monday(9, 10)))
    }

    @Test
    fun `未被选中的小时没有状态`() {
        assertNull(ScheduleEngine.stateAt(cfg(), monday(10, 10)))
    }

    /** 45/15：09:00-09:45 专注、09:45-10:00 休息 */
    @Test
    fun `常规番茄的专注与休息`() {
        val c = cfg()
        val focus = ScheduleEngine.stateAt(c, monday(9, 10))!!
        assertFalse(focus.inBreak)
        assertEquals(35 * 60L, focus.leftSeconds) // 45 - 10 = 35 分钟

        val brk = ScheduleEngine.stateAt(c, monday(9, 50))!!
        assertTrue(brk.inBreak)
        assertEquals(10 * 60L, brk.leftSeconds) // 休息到 10:00
    }

    /**
     * 25/5 这种「专注+休息 < 60」的配置：一小时里要跑两轮。
     * 以前只判一次 minute < work + brk，09:30 之后会把剩余算成负数。
     */
    @Test
    fun `一小时内的多轮番茄`() {
        val c = cfg(work = 25, brk = 5)
        val s1 = ScheduleEngine.stateAt(c, monday(9, 35))!!
        assertFalse("35 % 30 = 5，第二轮专注", s1.inBreak)
        assertEquals(20 * 60L, s1.leftSeconds)

        val s2 = ScheduleEngine.stateAt(c, monday(9, 57))!!
        assertTrue("57 % 30 = 27 ≥ 25，第二轮休息", s2.inBreak)
        assertEquals(3 * 60L, s2.leftSeconds)
    }

    /** 阶段剩余不能超过窗口剩余：09:00-09:30 配 45/15，09:10 只剩 20 分钟 */
    @Test
    fun `剩余时间被窗口裁剪`() {
        val c = cfg(work = 45, brk = 15, from = 0, to = 30)
        val s = ScheduleEngine.stateAt(c, monday(9, 10))!!
        assertFalse(s.inBreak)
        assertEquals(20 * 60L, s.leftSeconds)
    }

    /** 窗口外（from/to 收窄）不算在时段内 */
    @Test
    fun `窗口外没有状态`() {
        val c = cfg(from = 15, to = 45)
        assertNull(ScheduleEngine.stateAt(c, monday(9, 10)))
        assertNull(ScheduleEngine.stateAt(c, monday(9, 50)))
        assertEquals(
            15 * 60L,
            ScheduleEngine.stateAt(c, monday(9, 30))!!.leftSeconds, // 到 09:45 还剩 15 分钟
        )
    }

    /**
     * 十分钟刻度带来的新形态：一小时里两段（09:00–09:15 与 09:30–09:45）。
     *
     * 中间那 15 分钟必须**不算**在时段内——以前只有一对 from/to，只能取外包区间
     * 0–45，等于把中间的休息也锁上了。
     */
    @Test
    fun `一小时里的两段只在各自窗口内生效`() {
        val days = defaultDays().map { it.toMutableList() }.toMutableList()
        days[0][9] = HourPlan(
            on = true,
            work = 60,
            brk = 0,
            from = 0,
            to = 45,
            wins = listOf(HourWin(0, 15), HourWin(30, 45)),
        )
        val c = Config(enabled = true, days = days)

        assertEquals("第一段还剩 5 分钟", 5 * 60L, ScheduleEngine.stateAt(c, monday(9, 10))!!.leftSeconds)
        assertNull("中间的空档不该在时段内", ScheduleEngine.stateAt(c, monday(9, 20)))
        assertEquals("第二段还剩 10 分钟", 10 * 60L, ScheduleEngine.stateAt(c, monday(9, 35))!!.leftSeconds)
        assertNull("第二段之后也结束", ScheduleEngine.stateAt(c, monday(9, 50)))
    }

    /** 积分解锁期间所有拦截暂停；休息段同理 */
    @Test
    fun `解锁窗口与休息段都放行`() {
        val c = cfg()
        val rule = Rule(id = "r1", name = "测试", packages = listOf("com.example.app"))
        val withRule = c.copy(rules = listOf(rule))
        val now = monday(9, 10)
        assertEquals(1, GuardEngine.activeRules(withRule, now).size)

        val ts = now.atZone(ZoneId.systemDefault()).toEpochSecond()
        val unlocked = withRule.copy(unlockUntil = ts + 600)
        assertTrue(GuardEngine.activeRules(unlocked, now).isEmpty())

        val onBreak = monday(9, 50)
        assertTrue(GuardEngine.activeRules(withRule, onBreak).isEmpty())
    }

    /** 系统壳永远放行：拦了它们手机就变砖（白名单模式最容易踩） */
    @Test
    fun `白名单放行系统壳`() {
        val c = cfg().copy(
            rules = listOf(
                Rule(id = "r", name = "白名单", mode = "whitelist", packages = listOf("com.example.app")),
            ),
        )
        val now = monday(9, 10)
        assertNull(GuardEngine.blockedRule(c, now, "com.android.systemui", "com.qqqorange.kingoffocus"))
        assertNull(GuardEngine.blockedRule(c, now, "com.qqqorange.kingoffocus", "com.qqqorange.kingoffocus"))
        assertEquals(
            "r",
            GuardEngine.blockedRule(c, now, "com.tencent.mm", "com.qqqorange.kingoffocus")?.id,
        )
    }

    /** 黑名单：只有名单内被拦 */
    @Test
    fun `黑名单只拦名单内`() {
        val c = cfg().copy(
            rules = listOf(Rule(id = "b", name = "黑名单", packages = listOf("com.tencent.mm"))),
        )
        val now = monday(9, 10)
        assertEquals("b", GuardEngine.blockedRule(c, now, "com.tencent.mm", "self")?.id)
        assertNull(GuardEngine.blockedRule(c, now, "com.example.other", "self"))
    }
}
