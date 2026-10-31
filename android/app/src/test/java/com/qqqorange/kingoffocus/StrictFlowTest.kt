package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.StrictFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 强制模式的三步确认。
 *
 * 这三条断言对应三个承诺：
 *  1. 任何一步取消都回到起点（不存在"取消到一半"的状态）；
 *  2. 只有第三步的"是"才算开启（写错 `>=` 就会变成第二步就开）；
 *  3. 中途关掉对话框（按返回 / 点外面）等同于取消。
 */
class StrictFlowTest {

    @Test
    fun `前两步的是只进入下一步 不算开启`() {
        assertEquals(2, StrictFlow.advance(1, yes = true))
        assertEquals(3, StrictFlow.advance(2, yes = true))
        assertFalse("第一步还不能开", StrictFlow.enables(1, yes = true))
        assertFalse("第二步也不能开", StrictFlow.enables(2, yes = true))
        assertTrue("第三步才是真正的开关", StrictFlow.enables(3, yes = true))
    }

    @Test
    fun `任何一步取消都回到起点`() {
        for (step in 1..StrictFlow.STEPS) {
            assertEquals("第 $step 步取消", StrictFlow.IDLE, StrictFlow.advance(step, yes = false))
            assertFalse(StrictFlow.enables(step, yes = false))
        }
    }

    @Test
    fun `第三步确认之后回到起点 但这一次是真开启`() {
        assertEquals("开完就回到 0，不留中间态", StrictFlow.IDLE, StrictFlow.advance(3, yes = true))
        assertTrue(StrictFlow.enables(3, yes = true))
    }

    @Test
    fun `走满三步只开启一次`() {
        var step = 1
        var enabled = 0
        repeat(3) {
            if (StrictFlow.enables(step, yes = true)) enabled += 1
            step = StrictFlow.advance(step, yes = true)
        }
        assertEquals(1, enabled)
        assertEquals(StrictFlow.IDLE, step)
    }

    @Test
    fun `第二步必须说清限制`() {
        val body = StrictFlow.body(2, workMinutes = 50)
        assertTrue(body, body.contains("不能暂停"))
        assertTrue(body, body.contains("白名单"))
        assertTrue(body, body.contains("50 分钟"))
    }
}
