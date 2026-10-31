package com.qqqorange.kingoffocus.core

/**
 * 能力矩阵：把"装了哪些权限"翻译成"能做什么"。
 *
 * 为什么单独抽出来：权限组合有四档，每一档能做的事不一样，
 * 而这些判断如果散落在服务里，迟早会出现"界面说能用、实际用不了"。
 * 这里全是纯函数，能单测，也是界面上那张"能力对照表"的唯一数据来源。
 *
 * | 能力 | 无 | 使用情况访问 | +无障碍 | +Shizuku |
 * |---|---|---|---|---|
 * | 前台识别 | ✗ | 1 秒轮询 | 事件即时 | 事件即时 |
 * | 遮罩拉起 | ✗ | 需悬浮窗 | 需悬浮窗 | 不需要悬浮窗 |
 * | 回桌面 | ✗ | 需悬浮窗 | 全局动作 | shell 按键 |
 * | 挡住"强制停止/卸载" | ✗ | ✗ | 只能试着按返回 | ✓ |
 * | 无障碍被关后自愈 | ✗ | ✗ | ✗ | ✓ |
 */
data class Caps(
    /** 无障碍服务正在运行 */
    val accessibility: Boolean,
    /** Shizuku 已授权且用户服务已连上 */
    val shizuku: Boolean,
    /** 有「使用情况访问」权限 */
    val usageStats: Boolean,
    /** 有「悬浮窗」权限 */
    val overlay: Boolean,
) {
    /** 前台应用从哪来（越靠前越即时、越省电） */
    fun fgSource(): FgSource = when {
        accessibility -> FgSource.ACCESSIBILITY
        usageStats -> FgSource.USAGE_STATS
        else -> FgSource.NONE
    }

    /** 能不能把遮罩盖上来：Shizuku 的 am start 不受后台限制，否则必须有悬浮窗 */
    fun canShowMask(): Boolean = shizuku || overlay

    /** 能不能真的关掉系统设置里的"强制停止 / 卸载 / 清除数据" */
    fun canBlockAppControl(): Boolean = shizuku

    /** 用户把无障碍关掉之后，能不能替他打开 */
    fun canSelfHealAccessibility(): Boolean = shizuku

    fun level(): GuardLevel = when {
        shizuku && accessibility -> GuardLevel.FULL
        accessibility -> GuardLevel.STRONG
        usageStats && overlay -> GuardLevel.BASIC
        else -> GuardLevel.NONE
    }

    /**
     * 现在开强制模式还差什么（null = 齐了）。
     *
     * 强制模式的承诺是"任何操作都不能提前结束"，所以它至少需要：
     * 看得见前台、盖得上遮罩、挡得住"去设置里强制停止"。
     * 缺哪一条就直说，而不是先让用户打开，再默默降级。
     */
    fun strictBlocker(): StrictBlocker? = when {
        fgSource() == FgSource.NONE -> StrictBlocker.NO_FOREGROUND
        !canShowMask() -> StrictBlocker.NO_MASK
        !canBlockAppControl() -> StrictBlocker.NO_APP_CONTROL
        else -> null
    }
}

enum class FgSource { ACCESSIBILITY, USAGE_STATS, NONE }

enum class GuardLevel { NONE, BASIC, STRONG, FULL }

/** 强制模式缺的那一块（界面按这个给出一句话和"去开启"） */
enum class StrictBlocker {
    /** 完全不知道前台是谁 */
    NO_FOREGROUND,

    /** 知道是谁，但盖不上遮罩 */
    NO_MASK,

    /** 盖得上，但用户能进设置强制停止本应用 */
    NO_APP_CONTROL,
}
