package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.Report
import com.qqqorange.kingoffocus.core.StatsMath
import com.qqqorange.kingoffocus.data.CloudSync
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.SchedulePlan
import com.qqqorange.kingoffocus.data.SleepSegment
import com.qqqorange.kingoffocus.data.defaultDays
import com.qqqorange.kingoffocus.data.normalize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime

/**
 * 统计聚合、周报、云同步冲突判定、多方案迁移。
 *
 * 这几块都是纯计算，出错不会崩，但会给出**看起来对、其实错**的数字——
 * 那比崩溃更糟，所以每条口径都钉一个断言。
 */
class AggregationTest {

    private fun day(vararg pairs: Pair<String, IntArray>): Map<String, IntArray> = pairs.toMap()

    private fun buckets(vararg v: Pair<Int, Int>): IntArray {
        val a = IntArray(24)
        v.forEach { (h, s) -> a[h] = s }
        return a
    }

    @Test
    fun hourlySumsAcrossApps() {
        val d = day(
            "a" to buckets(9 to 600, 10 to 300),
            "b" to buckets(9 to 60),
        )
        val h = StatsMath.hourly(d)
        assertEquals(660, h[9])
        assertEquals(300, h[10])
        assertEquals(0, h[11])
        assertEquals(960, StatsMath.total(d))
    }

    @Test
    fun topRanksByTimeAndDropsZero() {
        val d = day(
            "a" to buckets(9 to 60),
            "b" to buckets(9 to 600),
            "c" to IntArray(24),
        )
        val top = StatsMath.top(d, 5)
        assertEquals(listOf("b", "a"), top.map { it.first })
        assertEquals(600, top.first().second)
    }

    @Test
    fun peakAndDurationFormatting() {
        assertEquals(600, StatsMath.peak(buckets(9 to 600, 11 to 60)))
        assertEquals(0, StatsMath.peak(IntArray(24)))
        assertEquals("42 秒", StatsMath.fmtDuration(42))
        assertEquals("5 分钟", StatsMath.fmtDuration(300))
        assertEquals("2 小时", StatsMath.fmtDuration(7200))
        assertEquals("1 小时 1 分", StatsMath.fmtDuration(3660))
    }

    @Test
    fun reportContainsTotalsAndTopApps() {
        val now = LocalDateTime.of(2026, 10, 31, 20, 0)
        val days = listOf(
            LocalDate.of(2026, 10, 30) to day("com.a" to buckets(9 to 3600)),
            LocalDate.of(2026, 10, 31) to day("com.a" to buckets(10 to 1800), "com.b" to buckets(11 to 600)),
        )
        val text = Report.build(now, days, 3, 120) { pkg -> if (pkg == "com.a") "应用甲" else "应用乙" }
        assertTrue(text, text.contains("累计 1 小时 40 分"))
        assertTrue(text, text.contains("应用甲"))
        assertTrue(text, text.contains("自律规则 3 条"))
        assertTrue(text, text.contains("当前积分 120"))
    }

    @Test
    fun reportHandlesEmptyWeek() {
        val text = Report.build(LocalDateTime.now(), emptyList(), 0, 0) { it }
        assertTrue(text, text.contains("还没有统计数据"))
    }

    /** 云同步：谁新听谁的；一样就跳过（避免来回覆盖把 updatedAt 越推越新） */
    @Test
    fun cloudConflictResolution() {
        assertEquals(CloudSync.Side.REMOTE, CloudSync.decide(100, 200))
        assertEquals(CloudSync.Side.LOCAL, CloudSync.decide(300, 200))
        assertEquals(CloudSync.Side.SAME, CloudSync.decide(200, 200))
    }

    /** 多方案：老配置自动迁移；切换方案时 days 跟着换 */
    @Test
    fun plansMigrateAndSwitch() {
        val c0 = Config()
        val c1 = normalize(c0)
        assertEquals(1, c1.plans.size)

        val p2 = SchedulePlan(id = "plan-b", name = "周末", days = defaultDays())
        val c2 = normalize(c1.copy(plans = c1.plans + p2))
        assertEquals(2, c2.plans.size)

        // 切到第二套：days 应该是它自己的（这里把周六全选，验证镜像方向）
        val weekend = c2.plans.first { it.id == "plan-b" }.days.mapIndexed { d, row ->
            if (d == 5) row.map { it.copy(on = true) } else row
        }
        val c3 = normalize(
            c2.copy(
                activePlan = "plan-b",
                days = weekend,
                defWork = 25,
            ),
        )
        assertEquals("plan-b", c3.activePlan)
        assertEquals(24, c3.days[5].count { it.on })
        assertEquals(25, c3.plans.first { it.id == "plan-b" }.defWork)
        // 另一套没有被污染
        val other = c3.plans.first { it.id != "plan-b" }
        assertEquals(0, other.days[5].count { it.on })
    }

    /** 睡眠段的分钟数越界要被夹回来，不能让手改坏的文件把引擎带崩 */
    @Test
    fun sleepSegmentsAreClamped() {
        val c = normalize(
            Config(
                sleep = Config().sleep.copy(
                    segments = listOf(SleepSegment(-10, 5000)),
                    unlockMin = 999,
                    unlockPrice = 999,
                ),
            ),
        )
        assertEquals(0, c.sleep.segments.first().from)
        assertEquals(1440, c.sleep.segments.first().to)
        assertEquals(240, c.sleep.unlockMin)
        assertEquals(100, c.sleep.unlockPrice)
    }

    @Test
    fun hourPlanStaysSevenByTwentyFour() {
        val c = normalize(Config(days = listOf(listOf(HourPlan(on = true)))))
        assertEquals(7, c.days.size)
        assertTrue(c.days.all { it.size == 24 })
        assertTrue("唯一那格保留", c.days[0][0].on)
    }
}
