package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.UsageAccess
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「使用情况访问」的四种状态与降级档位。
 *
 * 这几种情况在真机上看起来都是"统计不动了"，但处理方式完全不同：
 * 从没给过要引导、被回收要说清楚、只靠无障碍要提醒"会漏"。
 * 判定写错就会变成"明明没权限却显示正常"，或者"给了权限还一直提示去授权"。
 */
class UsageAccessTest {

    private fun decide(granted: Boolean, acc: Boolean, once: Boolean, asked: Boolean) =
        UsageAccess.decide(granted, acc, once, asked)

    @Test
    fun `给了权限就是正常`() {
        val s = decide(granted = true, acc = true, once = true, asked = true)
        assertEquals(UsageAccess.State.GRANTED, s.state)
        assertEquals(UsageAccess.Source.FULL, s.source)
        assertTrue(s.canRecord)
        assertFalse("已授权不该再提示", s.needsAttention)
    }

    @Test
    fun `给了权限但没开无障碍：能记，只是不够准`() {
        val s = decide(granted = true, acc = false, once = true, asked = true)
        assertEquals(UsageAccess.Source.USAGE_ONLY, s.source)
        assertTrue(s.canRecord)
        assertFalse("这一项不影响「能不能记」，不该提示", s.needsAttention)
        assertTrue("但要说清楚后台切换会慢", s.summary().contains("无障碍"))
    }

    @Test
    fun `从没给过：还未询问`() {
        val s = decide(granted = false, acc = false, once = false, asked = false)
        assertEquals(UsageAccess.State.NOT_ASKED, s.state)
        assertEquals(UsageAccess.Source.NONE, s.source)
        assertFalse("不能记就要明确说不能记", s.canRecord)
        assertTrue(s.needsAttention)
    }

    @Test
    fun `解释过但没给：不再反复弹`() {
        val s = decide(granted = false, acc = false, once = false, asked = true)
        assertEquals(UsageAccess.State.DENIED, s.state)
        assertFalse(s.canRecord)
    }

    @Test
    fun `给过又被回收：要能区分出来`() {
        val s = decide(granted = false, acc = false, once = true, asked = true)
        assertEquals(UsageAccess.State.REVOKED, s.state)
        assertEquals(UsageAccess.Source.NONE, s.source)
        assertFalse(s.canRecord)
        assertTrue("被回收的文案要提到暂停", s.summary().contains("暂停"))
    }

    @Test
    fun `被回收但无障碍还在：降级继续记，并说清楚会漏`() {
        val s = decide(granted = false, acc = true, once = true, asked = true)
        assertEquals(UsageAccess.State.REVOKED, s.state)
        assertEquals(UsageAccess.Source.ACCESSIBILITY_ONLY, s.source)
        assertTrue("降级也要能记", s.canRecord)
        assertTrue(s.summary().contains("漏"))
    }

    @Test
    fun `只有无障碍时也算降级可用`() {
        val s = decide(granted = false, acc = true, once = false, asked = false)
        assertEquals(UsageAccess.Source.ACCESSIBILITY_ONLY, s.source)
        assertTrue(s.canRecord)
        assertTrue("没有使用情况访问还是要引导", s.needsAttention)
    }

    @Test
    fun `来源名称能读`() {
        assertEquals(
            "使用情况访问 + 无障碍",
            decide(true, true, true, true).sourceName(),
        )
        assertEquals("无（已暂停）", decide(false, false, false, false).sourceName())
    }
}
