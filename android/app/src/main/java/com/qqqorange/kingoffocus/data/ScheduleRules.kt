package com.qqqorange.kingoffocus.data

/**
 * 时段编辑的规则（纯函数，可单测）。
 *
 * ## 为什么"今天之前的星期"要锁住
 *
 * 网格是一周 7 列。列在**本周**里的位置如果已经过去（比如今天是周六，那周一至周五
 * 都已经过完了），就不允许再改——避免回头把已经过去的日子"改出一副好看的计划"。
 * 这套限制**每周一自动解除**：周一那天七列全部解锁。
 *
 * ## 为什么校验要放在这里，而不是只写在界面上
 *
 * 界面只负责"点不动"；真正落盘的那一步必须自己再判一次。否则换个入口
 * （比如以后加个批量操作、或者脚本直接调）就绕过去了。所以 UI 写盘一律走
 * [paint] / [paintAll]，被锁的日子返回原样。
 *
 * 恢复备份、切方案这些"整体替换"不走这里：那不是"编辑某一天"，
 * 而是把一份完整数据搬进来，拦它只会让用户恢复不了自己的计划。
 */
object ScheduleRules {

    /** 第 [dayIdx] 列（0 = 周一）现在能不能编辑；[todayIdx] 同样是 0 = 周一 */
    fun canEdit(dayIdx: Int, todayIdx: Int): Boolean = dayIdx >= todayIdx

    /** 七列的可编辑状态，给界面画"灰掉"用 */
    fun editableDays(todayIdx: Int): List<Boolean> = (0 until 7).map { canEdit(it, todayIdx) }

    /** 涂一格；被锁的日子原样返回 */
    fun paint(
        dayIdx: Int,
        todayIdx: Int,
        day: List<HourPlan>,
        slot: Int,
        step: Int,
        on: Boolean,
        work: Int,
        brk: Int,
    ): List<HourPlan> =
        if (!canEdit(dayIdx, todayIdx)) {
            day
        } else {
            Slots.paintSlot(day, slot, step, on, work, brk)
        }

    /** 整天全选 / 清空；被锁的日子原样返回 */
    fun paintAll(
        dayIdx: Int,
        todayIdx: Int,
        day: List<HourPlan>,
        on: Boolean,
        work: Int,
        brk: Int,
    ): List<HourPlan> =
        if (!canEdit(dayIdx, todayIdx)) {
            day
        } else {
            Slots.paintDay(day, on, work, brk)
        }

    /** 界面上那句提示：为什么这一列点不动 */
    fun lockReason(dayName: String): String =
        "$dayName 已经过去了，这一列不能再改（下周一自动解锁）"
}
