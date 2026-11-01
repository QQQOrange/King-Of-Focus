package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.data.Stake

/**
 * 专注质押的结算规则（纯逻辑，方便单测）。
 *
 * 与桌面端 `focus.rs::settle_decision` 是同一份判定，**改一处必须改另一处**：
 *
 *  · 还在这一段里，或记账不到一分钟 → 不结算（否则会出现"押完立刻退"）；
 *  · 时段自然结束、一次都没被打断 → 退本金 + 20%；
 *  · 时段自然结束但被打断过 → 只退本金；
 *  · 用积分提前退出（暂停 / 停止 / 解锁）→ 没收，走的是 [forfeited]。
 *
 * 为什么"提前退出"定义得这么窄：手机上能叫"主动离开这一段"的只有那三个花积分的按钮。
 * 锁屏、没电、系统把服务杀了都不该判违约——否则会变成"忘了充电就扣分"。
 */
object StakeMath {

    /** 押多少：固定值，不给输入框——押注这一步不该出现新的算术题 */
    const val STAKE = 10

    /** 干净跑完的额外返还（本金 + 20%） */
    const val BONUS = 2

    /**
     * 该退多少分。`null` = 这一拍不结算。
     *
     * @param inThisSeg 现在是否还在这一笔对应的段里
     * @param blocks    这一段被打断过几次（来自账本口径的计数）
     */
    fun settleDecision(
        x: Stake,
        inThisSeg: Boolean,
        now: Long,
        blocks: Int,
    ): Int? {
        if (x.settledAt != 0L || x.seg <= 0L) return null
        if (inThisSeg || now - x.seg < 60) return null
        return if (blocks == 0) x.amount + BONUS else x.amount
    }

    /** 没收（提前退出）：把这一笔标成已结算、返还 0 */
    fun forfeited(x: Stake, now: Long): Stake =
        x.copy(settledAt = now, void = true, refunded = 0)

    /** 自然结算：把这一笔标成已结算、记下返还额 */
    fun settled(x: Stake, now: Long, back: Int): Stake =
        x.copy(settledAt = now, void = false, refunded = back)
}
