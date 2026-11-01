package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.StakeMath
import com.qqqorange.kingoffocus.data.Stake
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 质押结算规则（与桌面端 `focus.rs::settle_decision` 同一份判定）。
 *
 * 这几条断言是"钱"的规则，改之前先想清楚：任何一条放松都会变成
 * "押了不还"或"押了必赚"，两种都会让这个机制失去意义。
 */
class StakeMathTest {

    private val base = Stake(seg = 1000L, amount = 10, at = 900L)

    @Test
    fun stillInsideSegmentDoesNotSettle() {
        assertNull(StakeMath.settleDecision(base, inThisSeg = true, now = 5000L, blocks = 0))
    }

    @Test
    fun rightAfterPlacingDoesNotSettle() {
        // 刚押上不到一分钟：段边界抖动时不能出现"押完立刻退"
        assertNull(StakeMath.settleDecision(base, inThisSeg = false, now = 1030L, blocks = 0))
    }

    @Test
    fun cleanRunReturnsPrincipalPlusBonus() {
        val back = StakeMath.settleDecision(base, inThisSeg = false, now = 5000L, blocks = 0)
        assertEquals(10 + StakeMath.BONUS, back)
    }

    @Test
    fun interruptedRunReturnsPrincipalOnly() {
        val back = StakeMath.settleDecision(base, inThisSeg = false, now = 5000L, blocks = 3)
        assertEquals(10, back)
    }

    @Test
    fun settledStakeIsNeverTouchedAgain() {
        val done = base.copy(settledAt = 4000L, refunded = 12)
        assertNull(StakeMath.settleDecision(done, inThisSeg = false, now = 9000L, blocks = 0))
    }

    @Test
    fun forfeitVoidsTheStake() {
        val f = StakeMath.forfeited(base, now = 2000L)
        assertTrue(f.void)
        assertEquals(0, f.refunded)
        assertEquals(2000L, f.settledAt)
        // 没收之后不会再被"自然结算"退一次
        assertNull(StakeMath.settleDecision(f, inThisSeg = false, now = 9000L, blocks = 0))
    }

    @Test
    fun settledClearsVoidFlag() {
        val voiced = base.copy(void = true)
        val s = StakeMath.settled(voiced, now = 5000L, back = 12)
        assertFalse(s.void)
        assertEquals(12, s.refunded)
    }

    @Test
    fun zeroSegmentIsIgnored() {
        // seg=0 表示"没挂到任何段上"（老数据 / 脏数据），不能结算
        assertNull(StakeMath.settleDecision(base.copy(seg = 0), false, 5000L, 0))
    }
}
