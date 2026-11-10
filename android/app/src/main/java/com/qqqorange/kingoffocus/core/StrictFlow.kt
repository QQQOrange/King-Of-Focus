package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.ui.Loc

/**
 * 开启「强制模式」的三步确认流程（纯函数，可单测）。
 *
 * 为什么要有三道：强制模式一旦开启，**没有暂停、没有跳过、没有积分**，
 * 唯一的出口是等这一段走完（或者长按那行几乎没人知道的紧急解除）。
 * 一个开关就能进这种状态，代价和收益完全不对等——误触一次就是几小时。
 *
 * 三个窗口问的是三件不同的事：
 *  1. 你确定要开？（意图）
 *  2. 你知道开着的时候会发生什么？（知情：不能退出、不能用别的应用）
 *  3. 现在就开？（最后一道，防止前两下是连着点过去的）
 *
 * 状态机只有"第几步"这一个变量：**任何一步选"否"都回到 0**，
 * 且**只有第 3 步选"是"才写配置**。所以取消不会残留任何中间态——
 * 中间态压根不存在于配置里，它只是对话框的序号。
 */
object StrictFlow {

    /** 一共几道确认 */
    const val STEPS = 3

    /** 0 = 没在进行；1..3 = 正在第几道 */
    const val IDLE = 0

    /**
     * 当前这一步选了什么之后，下一个状态是什么。
     *
     * `yes = false` → 一律回 [IDLE]（取消，配置不动）。
     * `yes = true`  → 前两步进入下一步；第 3 步回到 [IDLE]（此时由调用方写配置）。
     */
    fun advance(step: Int, yes: Boolean): Int {
        if (!yes) return IDLE
        if (step >= STEPS) return IDLE
        return step + 1
    }

    /**
     * 这一下"是"是不是**真正开启**的那一下。
     *
     * 单独一个函数而不是在界面里写 `step == 3`：这条判据是"强制模式的唯一入口"，
     * 值得有名字、有断言——写错一个 `>=` 就会变成"第二步就开了"。
     */
    fun enables(step: Int, yes: Boolean): Boolean = yes && step == STEPS

    /** 对话框标题（带"第几步"，让用户知道这不是同一个框弹了三次） */
    fun title(step: Int): String = when (step) {
        1 -> Loc.p("Turn on strict mode? (1/3)", "开启强制模式？（1/3）")
        2 -> Loc.p("What strict mode restricts (2/3)", "强制模式会限制什么（2/3）")
        else -> Loc.p("Final confirmation (3/3)", "最后确认（3/3）")
    }

    /** 每一步的主体文案 */
    fun body(step: Int, workMinutes: Int = 0): String = when (step) {
        1 -> Loc.p("For the next discipline block the phone will be fully locked.", "接下来的一段自律时间里，手机会被完全锁住。") +
            Loc.p("This is not an ordinary lock: once on, it cannot be paused or ended early.", "这不是普通锁机：开了之后不能暂停，也不能提前结束。")

        2 -> buildString {
            append(Loc.p("While strict mode is active:\\n", "强制模式生效期间：\n"))
            append(Loc.p("· no pausing, no skipping, no points for time;\\n", "· 不能暂停、不能跳过、不能用积分换时间；\n"))
            append(Loc.p("· apart from whitelisted apps, nothing opens;\\n", "· 除了白名单里的应用，其它应用都打不开；\n"))
            append(Loc.p("· settings and rules are read-only for the duration;\\n", "· 想改设置、改规则也改不了（这段时间是只读的）；\n"))
            append(Loc.p("· the only way out is to let the block finish.", "· 只能等这一段自然走完。"))
            if (workMinutes > 0) append(Loc.p("\\n\\nWith your settings a block lasts about $workMinutes minutes.", "\n\n按当前设置，一段最长约 $workMinutes 分钟。"))
        }

        else -> Loc.p("Lock yourself in now? There is no way back after confirming,", "确定现在就把自己锁进去吗？确认之后就没有回头路了，") +
            Loc.p("until the block ends.", "直到这一段结束。")
    }

    /** 按钮文案：前两步是"继续"，最后一步必须让人看清楚是"现在开始" */
    fun confirmLabel(step: Int): String =
        if (step >= STEPS) Loc.p("Yes, turn it on", "是，现在开启") else Loc.p("Yes, continue", "是，继续")

    fun cancelLabel(step: Int): String = if (step >= STEPS) Loc.p("No, cancel", "否，取消") else Loc.p("No, do not turn it on", "否，不要开启")
}
