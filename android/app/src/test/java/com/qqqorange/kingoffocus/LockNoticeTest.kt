package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.core.SleepEngine
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.LockCfg
import com.qqqorange.kingoffocus.data.Rule
import com.qqqorange.kingoffocus.data.SleepCfg
import com.qqqorange.kingoffocus.data.SleepSegment
import com.qqqorange.kingoffocus.data.defaultDays
import com.qqqorange.kingoffocus.data.normalize
import java.time.LocalDateTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 锁机提醒的"什么时候"、锁机期的应用判定、以及睡眠必须锁机。
 *
 * 这些是**服务每秒在做的事**，所以用固定时刻断言，不依赖跑起来看通知栏。
 */
class LockNoticeTest {

    private fun cfg(lock: LockCfg, hour: Int = 9): Config {
        val days = defaultDays().toMutableList()
        days[0] = days[0].toMutableList().also { h ->
            h[hour] = HourPlan(on = true, work = 50, brk = 10)
        }
        return Config(enabled = true, lock = lock, days = days)
    }

    /** 2026-10-26 是周一 */
    private fun monday(h: Int, m: Int) = LocalDateTime.of(2026, 10, 26, h, m)

    @Test
    fun `锁机开始前五分钟能算出准确秒数`() {
        val c = cfg(LockCfg(enabled = true, beforeMin = 5))
        assertEquals(300L, LockEngine.secondsUntilStart(c, monday(8, 55), 2))
        assertEquals(60L, LockEngine.secondsUntilStart(c, monday(8, 59), 2))
        assertEquals("已经锁着 → 0", 0L, LockEngine.secondsUntilStart(c, monday(9, 10), 2))
        assertNull("视野只有 1 小时，90 分钟后的锁机看不到", LockEngine.secondsUntilStart(c, monday(7, 30), 1))
    }

    @Test
    fun `锁机关着时不算下一次`() {
        val c = cfg(LockCfg(enabled = false, beforeMin = 5))
        assertNull(LockEngine.secondsUntilStart(c, monday(8, 55), 2))
    }

    @Test
    fun `睡眠开始前也能提前提醒`() {
        val c = Config(
            enabled = false,
            sleep = SleepCfg(enabled = true, segments = listOf(SleepSegment(1380, 420))),
        )
        // 22:55 距离 23:00 还有 5 分钟
        assertEquals(300L, SleepEngine.secondsUntilStart(c, LocalDateTime.of(2026, 10, 26, 22, 55), 2))
        assertEquals(0L, SleepEngine.secondsUntilStart(c, LocalDateTime.of(2026, 10, 26, 23, 10), 2))
        assertNull(SleepEngine.secondsUntilStart(c, LocalDateTime.of(2026, 10, 26, 20, 0), 2))
    }

    @Test
    fun `睡眠时段必须锁机 老配置里的关闭会被纠正`() {
        val off = Config(sleep = SleepCfg(enabled = true, lockScreen = false))
        assertTrue("升级后一律按要锁处理", normalize(off).sleep.lockScreen)
        val on = Config(sleep = SleepCfg(enabled = true, lockScreen = true))
        assertTrue(normalize(on).sleep.lockScreen)
    }

    @Test
    fun `整机锁下除白名单外一律挡住`() {
        val c = cfg(LockCfg(enabled = true, scope = "all")).copy(
            rules = listOf(Rule(id = "w", mode = "whitelist", packages = listOf("com.ok"))),
        )
        assertFalse(LockEngine.decision(c, "com.ok", false, "self").block)
        assertTrue(LockEngine.decision(c, "com.other", false, "self").block)
        assertFalse("输入法永远放行", LockEngine.decision(c, "com.sohu.inputmethod.sogou", false, "self").block)
        assertFalse("来电永远放行", LockEngine.decision(c, "com.android.dialer", false, "self").block)
    }

    @Test
    fun `只按规则 有白名单就只允许名单内`() {
        val c = cfg(LockCfg(enabled = true, scope = "rules")).copy(
            rules = listOf(
                Rule(id = "w", mode = "whitelist", packages = listOf("com.ok")),
                Rule(id = "b", mode = "blacklist", packages = listOf("com.bad")),
            ),
        )
        assertFalse(LockEngine.decision(c, "com.ok", false, "self").block)
        assertTrue(LockEngine.decision(c, "com.bad", false, "self").block)
        assertTrue("白名单存在时，名单外一律挡", LockEngine.decision(c, "com.other", false, "self").block)
    }

    @Test
    fun `只按规则 只有黑名单就只禁黑名单`() {
        val c = cfg(LockCfg(enabled = true, scope = "rules")).copy(
            rules = listOf(Rule(id = "b", mode = "blacklist", packages = listOf("com.bad"))),
        )
        assertTrue(LockEngine.decision(c, "com.bad", false, "self").block)
        assertFalse("别的应用照常使用", LockEngine.decision(c, "com.other", false, "self").block)
    }

    @Test
    fun `睡眠恒为整机锁 与 scope 无关`() {
        val c = cfg(LockCfg(enabled = true, scope = "rules")).copy(
            rules = listOf(Rule(id = "b", mode = "blacklist", packages = listOf("com.bad"))),
        )
        assertTrue(LockEngine.decision(c, "com.other", sleep = true, selfPkg = "self").block)
        assertFalse(
            "白名单应用睡眠时仍可用（闹钟、笔记）",
            LockEngine.decision(
                c.copy(rules = listOf(Rule(id = "w", mode = "whitelist", packages = listOf("com.alarm")))),
                "com.alarm",
                sleep = true,
                selfPkg = "self",
            ).block,
        )
    }

    @Test
    fun `被禁用的规则不参与锁机判定`() {
        val c = cfg(LockCfg(enabled = true, scope = "rules")).copy(
            rules = listOf(Rule(id = "b", mode = "blacklist", packages = listOf("com.bad"), enabled = false)),
        )
        assertFalse(LockEngine.decision(c, "com.bad", false, "self").block)
    }
}
