package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.StatsTrack
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.clampEnd
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime

/**
 * 双端口径对齐的回归测试。
 *
 * 这两条都是「桌面端已经修了、手机端没跟上」的漂移：
 *   1. 积分解锁期间，统计不该再算「自律生效中」（桌面 0.1.97）；
 *   2. 账本区间最多 366 天（桌面 0.1.97 夹过，手机端不夹会在主线程上开几百万个文件）。
 *
 * 2026-10-26 是周一（`Config.days[0]`）。
 */
class CrossDeviceParityTest {

    private val mon = 0

    /** 周一 9 点开一格专注，其余默认 */
    private fun cfg(enabled: Boolean = true, unlockUntil: Long = 0L): Config {
        val base = Config()
        val days = base.days.map { it.toMutableList() }.toMutableList()
        days[mon][9] = HourPlan(true, 45, 15, 0, 60)
        return base.copy(enabled = enabled, days = days, unlockUntil = unlockUntil)
    }

    private fun epochOf(y: Int, m: Int, d: Int, h: Int, min: Int): Long =
        LocalDateTime.of(y, m, d, h, min).atZone(java.time.ZoneId.systemDefault()).toEpochSecond()

    @Test
    fun `解锁窗口内不算自律生效中`() {
        val now = LocalDateTime.of(2026, 10, 26, 9, 30)
        // 到 10:00 才到期：09:30 明确落在窗口内（判定是 `<`，正好等于边界算已过期）
        val unlocked = cfg(unlockUntil = epochOf(2026, 10, 26, 10, 0))
        // 时段内本来会判 true；解锁把这段时间让出来了，统计必须跟着改口
        assertFalse("解锁期间应记为未开启", StatsTrack.on(unlocked, now))
    }

    @Test
    fun `解锁到期后恢复判定`() {
        val now = LocalDateTime.of(2026, 10, 26, 9, 30)
        val expired = cfg(unlockUntil = epochOf(2026, 10, 26, 9, 0) + 10 * 60)
        assertTrue("解锁已过期，时段内应恢复为自律中", StatsTrack.on(expired, now))
    }

    @Test
    fun `总开关关掉时永远不算自律中`() {
        val now = LocalDateTime.of(2026, 10, 26, 9, 30)
        assertFalse(StatsTrack.on(cfg(enabled = false), now))
    }

    @Test
    fun `账本区间被夹到 366 天`() {
        val s = LocalDate.of(2026, 1, 1)
        val e = clampEnd(s, LocalDate.of(9999, 12, 31))
        assertEquals(s.plusDays(366), e)
    }

    @Test
    fun `正常区间不被改短`() {
        val s = LocalDate.of(2026, 10, 1)
        val e = LocalDate.of(2026, 10, 31)
        assertEquals(e, clampEnd(s, e))
    }
}
