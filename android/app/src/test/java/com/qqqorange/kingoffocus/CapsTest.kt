package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.Caps
import com.qqqorange.kingoffocus.core.FgSource
import com.qqqorange.kingoffocus.core.GuardLevel
import com.qqqorange.kingoffocus.core.StrictBlocker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 能力矩阵的单元测试。
 *
 * 这张表是界面上"当前防护等级 / 开强制模式还差什么"的唯一来源，
 * 判错了会让用户以为自己在被管着，其实换个应用就绕过去了。
 */
class CapsTest {

    @Test
    fun fgSourcePrefersAccessibility() {
        assertEquals(FgSource.ACCESSIBILITY, Caps(true, false, true, false).fgSource())
        assertEquals(FgSource.USAGE_STATS, Caps(false, false, true, false).fgSource())
        assertEquals("两个都没有就等于瞎的", FgSource.NONE, Caps(false, false, false, true).fgSource())
    }

    @Test
    fun maskNeedsOverlayOrShizuku() {
        assertTrue(Caps(false, true, true, false).canShowMask())
        assertTrue(Caps(false, false, true, true).canShowMask())
        assertFalse("两个都没有时遮罩拉不起来", Caps(false, false, true, false).canShowMask())
    }

    @Test
    fun levels() {
        assertEquals(GuardLevel.FULL, Caps(true, true, true, true).level())
        assertEquals(GuardLevel.STRONG, Caps(true, false, true, true).level())
        assertEquals(GuardLevel.BASIC, Caps(false, false, true, true).level())
        assertEquals(GuardLevel.NONE, Caps(false, false, false, false).level())
    }

    @Test
    fun strictBlockerReportsTheFirstMissingPiece() {
        assertEquals(StrictBlocker.NO_FOREGROUND, Caps(false, false, false, true).strictBlocker())
        assertEquals(StrictBlocker.NO_MASK, Caps(true, false, true, false).strictBlocker())
        assertEquals(
            "只有 Shizuku 才能挡住'强制停止'",
            StrictBlocker.NO_APP_CONTROL,
            Caps(true, false, true, true).strictBlocker(),
        )
        assertNull("齐了才允许说'可以强制'", Caps(true, true, true, false).strictBlocker())
    }

    @Test
    fun onlyShizukuCanBlockAppControlAndSelfHeal() {
        assertFalse(Caps(true, false, true, true).canBlockAppControl())
        assertTrue(Caps(true, true, true, true).canBlockAppControl())
        assertFalse(Caps(true, false, true, true).canSelfHealAccessibility())
        assertTrue(Caps(true, true, true, true).canSelfHealAccessibility())
    }
}
