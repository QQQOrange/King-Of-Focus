package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.UpdateClient
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Portable
import com.qqqorange.kingoffocus.data.normalize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 更新通道的令牌：**能用、别泄露、出错时说得明白**。
 *
 * 令牌是最容易被"顺手"带到别处去的东西（备份 / 云同步 / 日志 / 界面回显），
 * 所以每一条都要有断言，而不是只靠"我记得没写"。
 */
class UpdateTokenTest {

    @Test
    fun `401 和 403 给的是两句不同的话`() {
        val unauth = UpdateClient.httpMessage(401, hasToken = true).orEmpty()
        assertTrue(unauth, unauth.contains("令牌"))

        val rateAnon = UpdateClient.httpMessage(403, hasToken = false).orEmpty()
        assertTrue("没填令牌时要提示能提到 5000 次", rateAnon.contains("60"))
        assertTrue(rateAnon.contains("5000"))

        val rateToken = UpdateClient.httpMessage(403, hasToken = true).orEmpty()
        assertTrue(rateToken, rateToken.contains("5000"))
        assertFalse("已经带令牌了就别再劝他填一个", rateToken.contains("填一个"))
    }

    @Test
    fun `无关状态码不翻译`() {
        assertNull(UpdateClient.httpMessage(500, false))
        assertNull(UpdateClient.httpMessage(404, true))
    }

    @Test
    fun `能从异常文案里认出状态码`() {
        assertEquals(403, UpdateClient.httpCodeOf("HTTP 403"))
        assertEquals(401, UpdateClient.httpCodeOf("读不到更新清单：HTTP 401"))
        assertNull(UpdateClient.httpCodeOf("timeout"))
        assertNull(UpdateClient.httpCodeOf(null))
    }

    @Test
    fun `令牌首尾空白会被清掉 避免看起来像无效`() {
        val c = normalize(Config(update = Config().update.copy(token = "  ghp_abc\n")))
        assertEquals("ghp_abc", c.update.token)
    }

    @Test
    fun `令牌绝不进备份`() {
        val cfg = normalize(
            Config(update = Config().update.copy(token = "ghp_SECRET_TOKEN_123456")),
        )
        val doc = Portable.render(Portable.toDoc(cfg, "测试机", "0.4.3"))
        val text = doc.toString()
        assertFalse("备份里不该出现令牌", text.contains("ghp_SECRET_TOKEN_123456"))
        assertFalse("连字段名都不该有", text.contains("\"token\""))
    }
}
