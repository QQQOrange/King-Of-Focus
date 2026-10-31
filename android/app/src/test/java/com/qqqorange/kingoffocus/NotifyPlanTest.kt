package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.NotifyPlan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 通知判定：什么算「完成」、什么时候该「汇总」、进度怎么算。
 *
 * 这些规则以前埋在服务里，只能靠真机看通知栏验证；抽出来后每条都有断言。
 */
class NotifyPlanTest {

    @Test
    fun `只有跨过阶段边界才算完成`() {
        assertNull("首次进入时段（刚启动）不算完成", NotifyPlan.completeTitle(null, false))
        assertNull("同一阶段内不算完成", NotifyPlan.completeTitle(false, false))
        assertNull("休息中也一样", NotifyPlan.completeTitle(true, true))
        assertEquals("专注 → 休息", "专注完成", NotifyPlan.completeTitle(false, true))
        assertEquals("休息 → 专注", "休息结束", NotifyPlan.completeTitle(true, false))
    }

    @Test
    fun `汇总要四个条件同时成立`() {
        val today = "2026-10-31"
        assertTrue(
            "到点、开着、今天还没发",
            NotifyPlan.shouldSummarize(true, true, 22, 22, today, ""),
        )
        assertFalse("没到点", NotifyPlan.shouldSummarize(true, true, 21, 22, today, ""))
        assertFalse("总开关关着", NotifyPlan.shouldSummarize(false, true, 23, 22, today, ""))
        assertFalse("汇总关着", NotifyPlan.shouldSummarize(true, false, 23, 22, today, ""))
        assertFalse("今天已经发过", NotifyPlan.shouldSummarize(true, true, 23, 22, today, today))
    }

    @Test
    fun `跨天后汇总重新变得可以发`() {
        assertTrue(
            "昨天发过不影响今天",
            NotifyPlan.shouldSummarize(true, true, 22, 22, "2026-11-01", "2026-10-31"),
        )
    }

    @Test
    fun `汇总时间被规范化到 0 到 23 点`() {
        // 配置被手改坏（比如 99）时不该整晚不发
        assertTrue(NotifyPlan.shouldSummarize(true, true, 23, 99, "2026-10-31", ""))
        assertFalse(NotifyPlan.shouldSummarize(true, true, 0, -5, "2026-10-31", "").not())
    }

    @Test
    fun `锁机开始前提醒只在窗口内发一次`() {
        // 提前 5 分钟：300 秒到点才算；同一段只提醒一次
        assertTrue(NotifyPlan.shouldPreAlert(5, 300, "segA", ""))
        assertTrue("已经在 5 分钟内", NotifyPlan.shouldPreAlert(5, 60, "segA", ""))
        assertFalse("还早", NotifyPlan.shouldPreAlert(5, 301, "segA", ""))
        assertFalse("这一段提醒过了", NotifyPlan.shouldPreAlert(5, 60, "segA", "segA"))
        assertFalse("关掉提前量", NotifyPlan.shouldPreAlert(0, 60, "segA", ""))
        assertFalse("已经锁着了", NotifyPlan.shouldPreAlert(5, 0, "segA", ""))
        assertFalse("未来没有锁机", NotifyPlan.shouldPreAlert(5, null, "segA", ""))
        assertTrue("下一段还是要提醒", NotifyPlan.shouldPreAlert(5, 60, "segB", "segA"))
    }

    @Test
    fun `提前提醒的文案不出现零分钟`() {
        assertTrue(NotifyPlan.preAlertText(30).contains("还有 1 分钟"))
        assertTrue(NotifyPlan.preAlertText(300).contains("还有 5 分钟"))
        assertTrue(NotifyPlan.preAlertText(300, sleep = true).contains("睡眠"))
    }

    @Test
    fun `结束提醒的四种模式`() {
        assertFalse(NotifyPlan.endNotify("none"))
        assertFalse(NotifyPlan.endDialog("none"))
        assertTrue(NotifyPlan.endNotify("notify"))
        assertFalse(NotifyPlan.endDialog("notify"))
        assertFalse(NotifyPlan.endNotify("dialog"))
        assertTrue(NotifyPlan.endDialog("dialog"))
        assertTrue(NotifyPlan.endNotify("both"))
        assertTrue(NotifyPlan.endDialog("both"))
    }

    @Test
    fun `进度百分比不会越界`() {
        assertEquals(50, NotifyPlan.progressPct(30, 60))
        assertEquals("超额也封顶 100", 100, NotifyPlan.progressPct(90, 60))
        assertEquals("没排计划时不显示进度", 0, NotifyPlan.progressPct(10, 0))
        assertEquals("负数当成 0", 0, NotifyPlan.progressPct(-5, 60))
    }
}
