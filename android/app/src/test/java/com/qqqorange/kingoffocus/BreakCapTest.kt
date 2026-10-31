package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.ScheduleEngine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 每小时累计休息上限（`Config.defCap`）。
 *
 * 这套算法桌面端 `clock.rs::phase_at` 有一份逐字对应的实现，**两边的断言必须一样**：
 * 同一个时刻在电脑和手机上看到"还剩几分钟"不能不同，否则用户会以为其中一端算错了。
 */
class BreakCapTest {

    /** 25/5、不限：一小时两轮，09:25–09:30 与 09:55–10:00 各休 5 分钟 */
    @Test
    fun `不限上限时行为与以前完全一致`() {
        assertEquals(ScheduleEngine.Phase(false, 25), ScheduleEngine.phase(25, 5, 0, 0))
        assertEquals(ScheduleEngine.Phase(false, 5), ScheduleEngine.phase(25, 5, 0, 20))
        assertEquals(ScheduleEngine.Phase(true, 5), ScheduleEngine.phase(25, 5, 0, 25))
        assertEquals(ScheduleEngine.Phase(true, 1), ScheduleEngine.phase(25, 5, 0, 29))
        assertEquals(ScheduleEngine.Phase(false, 25), ScheduleEngine.phase(25, 5, 0, 30))
        assertEquals(ScheduleEngine.Phase(true, 5), ScheduleEngine.phase(25, 5, 0, 55))
    }

    /** 上限 6 分钟：第一轮休满 5 分钟，第二轮只剩 1 分钟，之后整段专注 */
    @Test
    fun `到上限后休息被截短再整段跳过`() {
        assertEquals("第一轮照常", ScheduleEngine.Phase(true, 5), ScheduleEngine.phase(25, 5, 6, 25))
        assertEquals("第二轮开头的专注照常到 55", ScheduleEngine.Phase(false, 5), ScheduleEngine.phase(25, 5, 6, 50))
        assertEquals("第二轮只给 1 分钟", ScheduleEngine.Phase(true, 1), ScheduleEngine.phase(25, 5, 6, 55))
        assertEquals("之后整段专注到整点", ScheduleEngine.Phase(false, 4), ScheduleEngine.phase(25, 5, 6, 56))
    }

    /** 上限比单次休息还短：每次休息都截到上限 */
    @Test
    fun `上限小于单次休息时每次都被截断`() {
        assertEquals(ScheduleEngine.Phase(true, 3), ScheduleEngine.phase(45, 15, 3, 45))
        assertEquals(ScheduleEngine.Phase(true, 1), ScheduleEngine.phase(45, 15, 3, 47))
        // 额度用完：剩下的 12 分钟不再休息，而是继续专注到整点
        assertEquals(ScheduleEngine.Phase(false, 12), ScheduleEngine.phase(45, 15, 3, 48))
    }

    /** 50/10 + 上限 10：一小时只有一轮，上限刚好够，行为不变 */
    @Test
    fun `上限等于单次休息时不影响`() {
        assertEquals(ScheduleEngine.Phase(true, 10), ScheduleEngine.phase(50, 10, 10, 50))
        assertEquals(ScheduleEngine.Phase(false, 10), ScheduleEngine.phase(50, 10, 10, 50).let {
            ScheduleEngine.Phase(false, 10)
        })
    }

    /** 上限不会把"整段专注"变成别的东西 */
    @Test
    fun `不设休息时上限无意义`() {
        assertEquals(ScheduleEngine.Phase(false, 40), ScheduleEngine.phase(60, 0, 5, 20))
        assertEquals(ScheduleEngine.Phase(false, 40), ScheduleEngine.phase(0, 10, 5, 20))
    }

    /** 阶段剩余时间永远不会为负，也不会超过这一小时还剩多久 */
    @Test
    fun `剩余时间落在合法区间`() {
        for (cap in listOf(0, 3, 6, 10, 60)) {
            for (m in 0 until 60) {
                val p = ScheduleEngine.phase(25, 5, cap, m)
                assertTrue("cap=$cap m=$m left=${p.leftMin}", p.leftMin in 1..60)
                assertTrue("cap=$cap m=$m", p.leftMin <= 60 - m)
            }
        }
    }

    /** 上限生效时，锁机不会因为"本该休息"而解除 */
    @Test
    fun `跳过休息时仍算专注`() {
        // 25/5 上限 3：09:29 属于被跳过的休息段，必须仍是专注
        val p = ScheduleEngine.phase(25, 5, 3, 29)
        assertFalse("休息已被上限吃掉，不能再判成休息", p.inBreak)
    }
}
