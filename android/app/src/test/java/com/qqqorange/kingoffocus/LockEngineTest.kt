package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.LockCfg
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 锁机判定的单元测试。
 *
 * 这里盯的是"什么时候该锁、什么时候不该锁"——遮罩本身好写，判错才会出事：
 * 判宽了用户被莫名关在门外，判松了这个功能等于没有。
 *
 * 2026-10-26 是周一（`Config.days[0]`）。
 */
class LockEngineTest {

    private val mon = 0

    /** 造一份配置：指定周一哪几个小时被选中 */
    private fun cfg(
        hours: List<Int> = listOf(9),
        enabled: Boolean = true,
        lockOn: Boolean = true,
        work: Int = 45,
        brk: Int = 15,
        points: Int = 100,
    ): Config {
        val base = Config()
        val days = base.days.map { it.toMutableList() }.toMutableList()
        for (h in hours) days[mon][h] = HourPlan(true, work, brk, 0, 60)
        return base.copy(
            enabled = enabled,
            days = days,
            points = points,
            lock = LockCfg(enabled = lockOn, pauseMinutes = 10, pauseCost = 10, stopCost = 30),
        )
    }

    private fun at(h: Int, m: Int): LocalDateTime = LocalDateTime.of(2026, 10, 26, h, m, 0)

    private fun epoch(t: LocalDateTime): Long = t.atZone(ZoneId.systemDefault()).toEpochSecond()

    @Test
    fun defaultIsOff() {
        val c = Config()
        assertFalse("默认不该锁：升级后突然把人关在门外是事故", c.lock.enabled)
        assertFalse(LockEngine.isLockActive(c, at(9, 5)))
    }

    @Test
    fun activeInFocusHour() {
        val c = cfg()
        assertTrue(LockEngine.isLockActive(c, at(9, 5)))
    }

    @Test
    fun inactiveWithoutScheduleOrWithSubSwitchOff() {
        assertFalse("自律总开关关了不锁", LockEngine.isLockActive(cfg(enabled = false), at(9, 5)))
        assertFalse("锁机开关关了不锁", LockEngine.isLockActive(cfg(lockOn = false), at(9, 5)))
        assertFalse("没选中的小时不锁", LockEngine.isLockActive(cfg(hours = listOf(9)), at(10, 5)))
    }

    @Test
    fun inactiveDuringBreak() {
        // 45/15 的番茄：09:50 落在休息段
        val c = cfg(work = 45, brk = 15)
        assertTrue("09:40 还在专注", LockEngine.isLockActive(c, at(9, 40)))
        assertFalse("09:50 是休息段", LockEngine.isLockActive(c, at(9, 50)))
    }

    @Test
    fun pauseWinsUntilItExpires() {
        val c = cfg().copy(lockPausedUntil = epoch(at(9, 20)))
        assertFalse("暂停窗口内不锁", LockEngine.isLockActive(c, at(9, 5)))
        assertTrue("到点自动恢复", LockEngine.isLockActive(c, at(9, 21)))
        assertEquals(15 * 60L, LockEngine.pauseLeftSeconds(c, at(9, 5)))
    }

    @Test
    fun stopOnlyCoversTheCurrentSegment() {
        val c = cfg(hours = listOf(9, 10))
        val seg = LockEngine.segmentKey(c, at(9, 5))
        val stopped = c.copy(lockStoppedSeg = seg)
        assertFalse("这一段已停止", LockEngine.isLockActive(stopped, at(9, 40)))
        assertFalse("同一段（连着的小时）也不该复活", LockEngine.isLockActive(stopped, at(10, 5)))
    }

    @Test
    fun stopExpiresWhenANewSegmentStarts() {
        // 09 和 10 是同一段；11 没选；12 是另一段
        val c = cfg(hours = listOf(9, 10, 12))
        val stopped = c.copy(lockStoppedSeg = LockEngine.segmentKey(c, at(9, 5)))
        assertFalse(LockEngine.isLockActive(stopped, at(10, 5)))
        assertTrue("下一段专注要重新锁", LockEngine.isLockActive(stopped, at(12, 5)))
    }

    @Test
    fun segmentKeyGroupsAdjacentHours() {
        val c = cfg(hours = listOf(9, 10, 12))
        assertEquals(
            LockEngine.segmentKey(c, at(9, 5)),
            LockEngine.segmentKey(c, at(10, 55)),
        )
        assertTrue(
            LockEngine.segmentKey(c, at(9, 5)) != LockEngine.segmentKey(c, at(12, 5)),
        )
    }

    @Test
    fun segmentLeftCountsWholeBlock() {
        val c = cfg(hours = listOf(9, 10))
        // 09:30 → 这一场到 11:00 结束 = 1.5 小时
        assertEquals(90 * 60L, LockEngine.segmentLeftSeconds(c, at(9, 30)))
    }

    @Test
    fun unlockWindowAlsoLiftsLock() {
        val c = cfg().copy(unlockUntil = epoch(at(9, 30)))
        assertFalse("积分解锁窗口内不锁", LockEngine.isLockActive(c, at(9, 5)))
        assertTrue(LockEngine.isLockActive(c, at(9, 31)))
    }

    @Test
    fun shouldMaskSkipsAllowListAndEmergency() {
        val c = cfg().copy(lockAllow = listOf("com.tencent.mm"))
        val now = at(9, 5)
        assertTrue("桌面也要盖", LockEngine.shouldMask(c, now, "com.google.android.apps.nexuslauncher", "com.qqqorange.kingoffocus"))
        assertTrue("别的应用要盖", LockEngine.shouldMask(c, now, "com.example.game", "com.qqqorange.kingoffocus"))
        assertFalse("白名单不盖", LockEngine.shouldMask(c, now, "com.tencent.mm", "com.qqqorange.kingoffocus"))
        assertFalse("自己不盖", LockEngine.shouldMask(c, now, "com.qqqorange.kingoffocus", "com.qqqorange.kingoffocus"))
        assertFalse("读不到前台就不乱盖", LockEngine.shouldMask(c, now, null, "com.qqqorange.kingoffocus"))
        assertFalse("来电/紧急呼叫不能盖", LockEngine.shouldMask(c, now, "com.android.dialer", "com.qqqorange.kingoffocus"))
        assertFalse("状态栏不能盖", LockEngine.shouldMask(c, now, "com.android.systemui", "com.qqqorange.kingoffocus"))
        assertFalse(
            "输入法不能盖",
            LockEngine.shouldMask(c, now, "com.baidu.input", "com.qqqorange.kingoffocus", setOf("com.baidu.input")),
        )
    }

    @Test
    fun maskFollowsLockState() {
        val c = cfg()
        val now = at(9, 5)
        assertTrue(LockEngine.shouldMask(c, now, "com.example.game", "x"))
        val paused = c.copy(lockPausedUntil = epoch(at(9, 20)))
        assertFalse("暂停后遮罩立刻该消失", LockEngine.shouldMask(paused, now, "com.example.game", "x"))
        val stopped = c.copy(lockStoppedSeg = LockEngine.segmentKey(c, now))
        assertFalse("停止后遮罩立刻该消失", LockEngine.shouldMask(stopped, now, "com.example.game", "x"))
    }

    @Test
    fun priceAndAffordability() {
        val c = cfg(points = 5)
        assertEquals(LockEngine.Price(10, 10), LockEngine.pausePrice(c))
        assertEquals(30, LockEngine.stopPrice(c))
        assertFalse("5 分付不起暂停", LockEngine.canAfford(c, LockEngine.pausePrice(c).cost))
        assertTrue("刚好够就算够", LockEngine.canAfford(c.copy(points = 10), 10))
    }

    // ---------------- 温和 / 强制 ----------------

    private fun strict(c: Config) = c.copy(lock = c.lock.copy(mode = LockEngine.MODE_STRICT))

    @Test
    fun strictIgnoresPauseBoughtEarlier() {
        val c = cfg()
        val paused = c.copy(lockPausedUntil = epoch(at(9, 50)))
        assertFalse("温和模式下暂停有效", LockEngine.isLockActive(paused, at(9, 5)))
        assertTrue(
            "切成强制后，之前买的暂停不算数（否则切模式就是个后门）",
            LockEngine.isLockActive(strict(paused), at(9, 5)),
        )
    }

    @Test
    fun strictIgnoresStopOfCurrentSegment() {
        val c = cfg()
        val stopped = c.copy(lockStoppedSeg = LockEngine.segmentKey(c, at(9, 5)))
        assertFalse(LockEngine.isLockActive(stopped, at(9, 10)))
        assertTrue(LockEngine.isLockActive(strict(stopped), at(9, 10)))
    }

    @Test
    fun strictHasNoExitDoor() {
        val c = strict(cfg())
        val now = at(9, 5)
        assertTrue(LockEngine.isLockActive(c, now))
        assertFalse("强制模式没有暂停", LockEngine.canPause(c, now))
        assertFalse("强制模式没有停止", LockEngine.canStop(c, now))
        // 温和模式两个都有
        val g = cfg()
        assertTrue(LockEngine.canPause(g, now))
        assertTrue(LockEngine.canStop(g, now))
    }

    @Test
    fun cannotSwitchBackToGentleWhileStrictLockRuns() {
        val c = strict(cfg())
        assertFalse("强制锁机进行中不许切回温和", LockEngine.canSwitchMode(c, at(9, 5)))
        assertTrue("这一段过了就随便改", LockEngine.canSwitchMode(c, at(10, 5)))
        assertTrue("本来就不是强制，当然能改", LockEngine.canSwitchMode(cfg(), at(9, 5)))
    }

    @Test
    fun strictEndsWhenTheSegmentEnds() {
        // work=60/brk=0 表示这一小时不做番茄，整点内一直是专注段
        val c = strict(cfg(hours = listOf(9), work = 60, brk = 0))
        assertTrue(LockEngine.isLockActive(c, at(9, 59)))
        assertFalse("配置的小时走完就自然解除", LockEngine.isLockActive(c, at(10, 1)))
    }
}
