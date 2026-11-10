package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.ui.Loc

/**
 * 通知的判定规则（纯函数，可单测）。
 *
 * 抽出来的原因：这些判断散在 `GuardService` 里时，"什么算完成""什么时候该汇总"
 * 只能靠跑真机看通知栏，改一行就可能悄悄变语义。放在这里之后，每条规则都有断言。
 */
object NotifyPlan {

    /**
     * 阶段切换 → 该不该发「完成」通知，发的话标题是什么。
     *
     * `prev == null` = 刚启动或刚进入时段，**不算完成**：
     * 用户打开应用时看到一条Loc.t("专注完成")只会莫名其妙。
     * `prev == cur` = 同一阶段内的时间流逝，也不是完成。
     */
    fun completeTitle(prevInBreak: Boolean?, inBreak: Boolean): String? = when {
        prevInBreak == null -> null
        prevInBreak == inBreak -> null
        inBreak -> Loc.t("专注完成")
        else -> Loc.t("休息结束")
    }

    /**
     * 今天的汇总该不该发。
     *
     * 四个条件缺一不可：通知开着、汇总开着、时间到了、今天还没发过。
     * `lastDay` 比较的是日期字符串，跨天自动失效——不需要额外清状态。
     */
    fun shouldSummarize(
        notifyEnabled: Boolean,
        summaryEnabled: Boolean,
        hourOfDay: Int,
        dailyAt: Int,
        today: String,
        lastDay: String,
    ): Boolean {
        if (!notifyEnabled || !summaryEnabled) return false
        if (hourOfDay < dailyAt.coerceIn(0, 23)) return false
        return lastDay != today
    }

    /**
     * 锁机开始前要不要提醒。
     *
     * 三个条件：提前量开着、已经在提前窗口里、**这一段**还没提醒过。
     * 用段标识去重而不是时间戳：同一次锁机只要有 5 分钟提前量，就会连续 300 拍
     * 都满足"到点了"，只有记住"这一段已经说过"才不会刷出 300 条通知。
     *
     * [secondsToStart] 为 null = 未来 12 小时内不会再锁机（排班空着 / 锁机关着），不发。
     * 已经锁着（0 秒）也不发：那时候该说的是"锁机开始"，而不是"还有 0 分钟"。
     */
    fun shouldPreAlert(
        beforeMin: Int,
        secondsToStart: Long?,
        segKey: String,
        sentSeg: String,
    ): Boolean {
        if (beforeMin <= 0) return false
        if (secondsToStart == null || secondsToStart <= 0) return false
        if (segKey.isEmpty() || segKey == sentSeg) return false
        return secondsToStart <= beforeMin * 60L
    }

    /** 提前提醒的正文："还有 3 分钟"（不足 1 分钟按 1 分钟说，不要出现"还有 0 分钟"） */
    fun preAlertText(secondsToStart: Long, sleep: Boolean = false): String {
        val mins = ((secondsToStart.coerceAtLeast(0) + 59) / 60).coerceAtLeast(1)
        return if (sleep) {
            Loc.p("Sleep hours start in $mins min; the whole phone will be locked first.", Loc.p("Sleep hours start in $mins min; the whole phone will be locked first.", Loc.p("Sleep hours start in $mins min; the whole phone will be locked first.", "还有 $mins 分钟进入睡眠时段，整台手机会先锁上。")))
        } else {
            Loc.p("The lock starts in $mins min — wrap up what you are doing.", Loc.p("The lock starts in $mins min — wrap up what you are doing.", Loc.p("The lock starts in $mins min — wrap up what you are doing.", "还有 $mins 分钟进入锁机时段，先把手上的事收个尾。")))
        }
    }

    /**
     * 锁机结束时怎么提醒。
     *
     * 弹窗要能盖住当前应用（后台拉起界面需要悬浮窗或 Shizuku），所以分成两个开关：
     * 通知永远发得出去，弹窗要看能力。能力不够时由服务降级成通知——**不假装弹过**。
     */
    fun endNotify(mode: String): Boolean = mode == "notify" || mode == "both"

    fun endDialog(mode: String): Boolean = mode == "dialog" || mode == "both"

    /**
     * 常驻通知的进度百分比。
     *
     * `plan <= 0`（今天没排时段）时返回 0：界面上会据此不显示进度，
     * 避免出现 "0/0 分" 这种既没意义又让人焦虑的文案。
     */
    fun progressPct(doneMin: Int, planMin: Int): Int {
        if (planMin <= 0) return 0
        return (doneMin.coerceAtLeast(0) * 100 / planMin).coerceIn(0, 100)
    }
}
