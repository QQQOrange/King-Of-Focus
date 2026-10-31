package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.LockCfg
import com.qqqorange.kingoffocus.data.Rule
import com.qqqorange.kingoffocus.data.defaultDays
import com.qqqorange.kingoffocus.data.normalize
import com.qqqorange.kingoffocus.ui.PageTimer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「展示锁机页面」开关的两档行为，以及轻档提示页的 5 秒计时。
 *
 * 这两块都容易被"顺手改一点"弄坏：开关一关就等于整机锁没了，
 * 计时多算一秒就等于用户根本没看到提示。
 */
class LockPageTest {

    private fun cfg(scope: String = "all", page: Boolean = true): Config {
        val days = defaultDays().map { it.toMutableList() }.toMutableList()
        days[0][9] = HourPlan(on = true, work = 50, brk = 10)
        return Config(
            enabled = true,
            days = days,
            lock = LockCfg(enabled = true, scope = scope, showPage = page),
            rules = listOf(
                Rule(id = "b", name = "游戏", mode = "blacklist", packages = listOf("com.game")),
                Rule(id = "w", name = "工具", mode = "whitelist", packages = listOf("com.keep")),
            ),
        )
    }

    @Test
    fun `开关默认开 老配置升级后行为不变`() {
        assertTrue(Config().lock.showPage)
        assertTrue("缺字段的老配置落到 true", normalize(Config()).lock.showPage)
    }

    @Test
    fun `关闭后只拦黑名单 白名单不参与`() {
        val c = cfg(page = false)
        assertTrue("黑名单里的应用要弹提示页", LockEngine.pageBlocked(c, "com.game", "self"))
        assertFalse("非黑名单照常用", LockEngine.pageBlocked(c, "com.other", "self"))
        assertFalse(
            "白名单不参与：白名单外的应用也不弹（否则又变回整机锁）",
            LockEngine.pageBlocked(c, "com.notInWhitelist", "self"),
        )
        assertFalse("白名单内更不会被拦", LockEngine.pageBlocked(c, "com.keep", "self"))
    }

    @Test
    fun `关闭后紧急通道与自家应用永远不算`() {
        val c = cfg(page = false)
        assertFalse(LockEngine.pageBlocked(c, "com.android.dialer", "self"))
        assertFalse(LockEngine.pageBlocked(c, "com.android.systemui", "self"))
        assertFalse(LockEngine.pageBlocked(c, "self", "self"))
        assertFalse(LockEngine.pageBlocked(c, "com.sohu.inputmethod.sogou", "self"))
    }

    @Test
    fun `关闭后停用的规则也不算`() {
        val c = cfg(page = false).copy(
            rules = listOf(Rule(id = "b", name = "游戏", mode = "blacklist", packages = listOf("com.game"), enabled = false)),
        )
        assertFalse(LockEngine.pageBlocked(c, "com.game", "self"))
    }

    @Test
    fun `both 规则 禁止优先于允许`() {
        // 允许 A、B，禁止 B、C：B 两边都有 → 以禁止为准
        val c = cfg().copy(
            rules = listOf(
                Rule(
                    id = "m",
                    name = "混合",
                    mode = "both",
                    packages = listOf("com.a", "com.b"),
                    deny = listOf("com.b", "com.c"),
                ),
            ),
        )
        assertFalse("只在允许名单里", "com.a" in com.qqqorange.kingoffocus.core.GuardEngine.blackPackages(c))
        assertTrue("禁止名单里", "com.b" in com.qqqorange.kingoffocus.core.GuardEngine.blackPackages(c))
        assertTrue("两者都命中 → 禁止", LockEngine.decision(c, "com.b", false, "self").block)
        assertFalse("只在允许名单 → 放", LockEngine.decision(c, "com.a", false, "self").block)
        assertTrue("名单外 → 挡（有允许名单）", LockEngine.decision(c, "com.other", false, "self").block)
    }

    @Test
    fun `both 没有允许名单时退化成纯黑名单`() {
        // 整机锁（scope=all）下本来就全挡，所以这里必须用"只按规则"才看得出差别
        val c = cfg(scope = "rules").copy(
            rules = listOf(Rule(id = "m", name = "混合", mode = "both", deny = listOf("com.game"))),
        )
        assertTrue(LockEngine.decision(c, "com.game", false, "self").block)
        assertFalse("没写允许名单，就不该全锁", LockEngine.decision(c, "com.other", false, "self").block)
    }

    @Test
    fun `白名单规则里的禁止名单也生效`() {
        val c = cfg().copy(
            rules = listOf(
                Rule(
                    id = "w",
                    name = "只允许工具",
                    mode = "whitelist",
                    packages = listOf("com.keep", "com.bad"),
                    deny = listOf("com.bad"),
                ),
            ),
        )
        assertTrue("名单内但被列为例外", LockEngine.decision(c, "com.bad", false, "self").block)
        assertFalse(LockEngine.decision(c, "com.keep", false, "self").block)
    }

    @Test
    fun `时段边界与切换 锁机状态跟着变`() {
        // 09:00–10:00，50/10：09:00 起专注段锁机；09:50 进休息 → 不锁；10:00 出时段 → 不锁
        val c = cfg()
        val mon = { h: Int, m: Int -> java.time.LocalDateTime.of(2026, 10, 26, h, m) }
        assertFalse("08:59 还没开始", LockEngine.isLockActive(c, mon(8, 59)))
        assertTrue("09:00 开始锁", LockEngine.isLockActive(c, mon(9, 0)))
        assertFalse("09:50 番茄休息，不锁", LockEngine.isLockActive(c, mon(9, 50)))
        assertFalse("10:00 出时段（下一小时没选中）→ 不锁", LockEngine.isLockActive(c, mon(10, 0)))
    }

    @Test
    fun `强制模式下暂停与停止都不生效`() {
        val c = cfg().copy(lock = LockCfg(enabled = true, mode = "strict", scope = "all"))
        val at = java.time.LocalDateTime.of(2026, 10, 26, 9, 10)
        val sec = at.atZone(java.time.ZoneId.systemDefault()).toEpochSecond()
        assertTrue("有暂停记录也照样锁", LockEngine.isLockActive(c.copy(lockPausedUntil = sec + 600), at))
        assertTrue("有停止记录也照样锁", LockEngine.isLockActive(c.copy(lockStoppedSeg = "任意"), at))
        assertFalse("强制模式生效中不允许切回温和", LockEngine.canSwitchMode(c, at))
    }

    @Test
    fun `五秒计时向上取整 到零即结束`() {
        assertEquals(5, PageTimer.leftSeconds(5_000))
        assertEquals("还剩 1ms 也算 1 秒", 1, PageTimer.leftSeconds(1))
        assertEquals(5, PageTimer.leftSeconds(4_999))
        assertEquals(1, PageTimer.leftSeconds(1))
        assertEquals(0, PageTimer.leftSeconds(0))
        assertEquals("负数不会倒着走", 0, PageTimer.leftSeconds(-200))
        assertEquals(5, PageTimer.SECONDS)
    }
}
