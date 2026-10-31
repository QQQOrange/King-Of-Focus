package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.AskKind
import com.qqqorange.kingoffocus.core.PermId
import com.qqqorange.kingoffocus.core.Permissions
import com.qqqorange.kingoffocus.data.PermCfg
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 权限清单的「数据本身」要成立：
 * 六项+无障碍都有四要素、不需要的那项如实标出来、申请历史能正确累计。
 */
class PermissionsTest {

    @Test
    fun `清单覆盖用户要求的每一项`() {
        val ids = Permissions.specs.map { it.id }
        listOf(
            PermId.APP_LIST, PermId.NOTIFICATION, PermId.MEDIA,
            PermId.OVERLAY, PermId.USAGE, PermId.SHIZUKU,
        ).forEach { assertTrue("清单里缺 $it", it in ids) }
    }

    @Test
    fun `每一项都写清了用途时机方式和影响`() {
        Permissions.specs.forEach { s ->
            assertTrue("${s.title} 缺用途", s.why.isNotBlank())
            assertTrue("${s.title} 缺申请时机", s.whenAsk.isNotBlank())
            assertTrue("${s.title} 缺申请方式", s.howAsk.isNotBlank())
            assertTrue("${s.title} 缺缺失影响", s.impact.isNotBlank())
            assertTrue("${s.title} 缺降级方案", s.fallback.isNotBlank())
        }
    }

    @Test
    fun `照片视频不需要申请，且如实标出来`() {
        val m = Permissions.spec(PermId.MEDIA)
        assertEquals("没有相册场景就不该申请", AskKind.NONE, m.kind)
        assertTrue("要在用途里直说不需要", m.why.contains("不需要"))
    }

    @Test
    fun `申请历史：拒绝会累计，授予会清掉永久拒绝标记`() {
        val first = Permissions.noteNotificationResult(PermCfg(), granted = false, blocked = false)
        assertEquals(1, first.notifAsked)
        assertFalse(first.notifBlocked)

        // 第二次拒绝时系统通常已不再弹窗 → blocked
        val second = Permissions.noteNotificationResult(first, granted = false, blocked = true)
        assertEquals(2, second.notifAsked)
        assertTrue(second.notifBlocked)

        // 之后去设置里打开了 → 不该再显示"永久拒绝"
        val back = Permissions.noteNotificationResult(second, granted = true, blocked = false)
        assertEquals("授予不增加拒绝次数", 2, back.notifAsked)
        assertFalse(back.notifBlocked)
    }

    @Test
    fun `授予时不累计拒绝次数`() {
        val p = Permissions.noteNotificationResult(PermCfg(), granted = true, blocked = false)
        assertEquals(0, p.notifAsked)
    }
}
