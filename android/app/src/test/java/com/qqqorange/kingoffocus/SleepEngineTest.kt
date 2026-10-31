package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.SleepEngine
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.SleepCfg
import com.qqqorange.kingoffocus.data.SleepSegment
import com.qqqorange.kingoffocus.data.normalize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

/**
 * 睡眠时段。
 *
 * 最容易被写错的是跨夜：23:00 → 07:00 这段，凌晨 1 点到底算不算在窗口里，
 * 两处判断（午夜前 / 午夜后）只要有一处漏了，用户就会在半夜被放出来。
 */
class SleepEngineTest {

    private fun cfg(seg: SleepSegment = SleepSegment(1380, 420), unlock: Long = 0L) = Config(
        sleep = SleepCfg(enabled = true, segments = listOf(seg), lockScreen = true, unlockMin = 10, unlockPrice = 2),
        points = 100,
        sleepUnlockUntil = unlock,
    )

    private fun t(day: Int, hour: Int, minute: Int = 0): LocalDateTime =
        LocalDateTime.of(2026, 10, day, hour, minute)

    @Test
    fun crossNightWindowCoversBothSidesOfMidnight() {
        val c = cfg()
        // 22:59 还没开始
        assertNull(SleepEngine.active(c, t(30, 22, 59)))
        // 23:00 开始
        assertNotNull(SleepEngine.active(c, t(30, 23, 0)))
        // 凌晨 1 点仍在窗口里（窗口是"昨天 23:00 到今天 07:00"）
        assertNotNull(SleepEngine.active(c, t(31, 1, 0)))
        // 06:59 还在，07:00 结束
        assertNotNull(SleepEngine.active(c, t(31, 6, 59)))
        assertNull(SleepEngine.active(c, t(31, 7, 0)))
        // 白天当然不在
        assertNull(SleepEngine.active(c, t(31, 12, 0)))
    }

    @Test
    fun sameDayWindowWorks() {
        val c = cfg(SleepSegment(60, 120)) // 01:00 → 02:00
        assertNull(SleepEngine.active(c, t(31, 0, 30)))
        assertNotNull(SleepEngine.active(c, t(31, 1, 30)))
        assertNull(SleepEngine.active(c, t(31, 2, 0)))
    }

    @Test
    fun zeroLengthSegmentIsIgnored() {
        // from == to 当成空段：手滑填成一样时不能把整机锁一整天
        val c = cfg(SleepSegment(600, 600))
        assertNull(SleepEngine.active(c, t(31, 10, 0)))
    }

    @Test
    fun disabledSleepNeverLocks() {
        val c = cfg().copy(sleep = cfg().sleep.copy(enabled = false))
        assertFalse(SleepEngine.isSleeping(c, t(31, 1, 0)))
    }

    /** 锁屏关掉：只统计、不锁（有人就是不想被锁） */
    @Test
    fun lockScreenOffMeansNoLock() {
        val c = cfg().copy(sleep = cfg().sleep.copy(lockScreen = false))
        assertNotNull(SleepEngine.active(c, t(31, 1, 0)))
        assertFalse(SleepEngine.isSleeping(c, t(31, 1, 0)))
    }

    /** 用积分买的那一段：窗口还在，但不该再锁 */
    @Test
    fun unlockWindowSuspendsLocking() {
        val now = t(31, 1, 0)
        val until = now.atZone(java.time.ZoneId.systemDefault()).toEpochSecond() + 600
        val c = cfg(unlock = until)
        assertTrue("窗口仍在（统计要照常）", SleepEngine.active(c, now) != null)
        assertFalse("已付费解锁，不能再锁", SleepEngine.isSleeping(c, now))
    }

    @Test
    fun unlockPriceIsPerMinute() {
        assertEquals(20, SleepEngine.unlockPrice(cfg()))
        // 价格 0 = 不开放
        val free = cfg().copy(sleep = cfg().sleep.copy(unlockPrice = 0))
        assertEquals(0, SleepEngine.unlockPrice(free))
        assertFalse(SleepEngine.canUnlock(free, t(31, 1, 0)))
    }

    @Test
    fun cannotAffordMeansNoUnlock() {
        val poor = cfg().copy(points = 5)
        assertFalse(SleepEngine.canUnlock(poor, t(31, 1, 0)))
        assertTrue(SleepEngine.canUnlock(cfg(), t(31, 1, 0)))
    }

    /** 解锁时间不能被买到这一段睡眠之外 */
    @Test
    fun unlockNeverExceedsSegmentEnd() {
        val now = t(31, 6, 55) // 距 07:00 只剩 5 分钟
        val c = cfg().copy(sleep = cfg().sleep.copy(unlockMin = 60))
        val until = SleepEngine.unlockUntil(c, now)
        val end = t(31, 7, 0).atZone(java.time.ZoneId.systemDefault()).toEpochSecond()
        assertEquals("最多买到起床时间", end, until)
    }

    @Test
    fun formatSegmentIsReadable() {
        assertEquals("23:00 – 07:00", SleepEngine.fmtSegment(SleepSegment(1380, 420)))
        assertEquals("00:00 – 24:00", SleepEngine.fmtSegment(SleepSegment(0, 1440)))
    }

    /** 老配置没有 plans：normalize 要自动补一套，不能让界面空着 */
    @Test
    fun normalizeSeedsOnePlan() {
        val c = normalize(Config())
        assertEquals(1, c.plans.size)
        assertEquals(c.plans.first().id, c.activePlan)
    }
}
