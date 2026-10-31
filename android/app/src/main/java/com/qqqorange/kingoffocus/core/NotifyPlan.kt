package com.qqqorange.kingoffocus.core

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
     * 用户打开应用时看到一条"专注完成"只会莫名其妙。
     * `prev == cur` = 同一阶段内的时间流逝，也不是完成。
     */
    fun completeTitle(prevInBreak: Boolean?, inBreak: Boolean): String? = when {
        prevInBreak == null -> null
        prevInBreak == inBreak -> null
        inBreak -> "专注完成"
        else -> "休息结束"
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
