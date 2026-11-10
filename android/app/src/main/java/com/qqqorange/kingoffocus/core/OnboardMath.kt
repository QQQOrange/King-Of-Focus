package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.Rule
import com.qqqorange.kingoffocus.data.defaultDays
import com.qqqorange.kingoffocus.ui.Loc

/**
 * 首用向导的纯逻辑：把「周几 + 几点到几点」变成一张 7×24 的时段表。
 *
 * 与桌面端 `onboard::build_profile` 是同一件事，规则也一致：
 *  · 整段共用一个 seg（用户心里"这一段"是连着的，中途断开就不是一段）；
 *  · `to` 是开区间上界（20–22 点 = hour 20、21 两格）；
 *  · 起点给反了至少保住一小时——写出空方案等于"什么都没发生"，比写错更让人困惑。
 *
 * 为什么单独抽出来：向导要靠这个写排班，而排班写错是**静默**的
 * （界面看起来有格子，判定却不生效），必须有单测钉住。
 */
object OnboardMath {

    /** 向导默认节奏：25 分钟专注 + 5 分钟休息 */
    const val WORK = 25
    const val BRK = 5

    /** 整段共用的段标识（与桌面 `onboard-seg` 同义，只是两端各自一份数据） */
    const val SEG = "onboard-seg"

    fun buildDays(
        weekdays: List<Int>,
        fromHour: Int,
        toHour: Int,
        work: Int = WORK,
        brk: Int = BRK,
    ): List<List<HourPlan>> {
        val a = fromHour.coerceIn(0, 23)
        val b = toHour.coerceIn(a + 1, 24)
        val grid = defaultDays().map { it.toMutableList() }.toMutableList()
        for (wd in weekdays) {
            if (wd !in 0..6) continue
            for (h in a until b) {
                grid[wd][h] = HourPlan(
                    on = true,
                    work = work,
                    brk = brk,
                    from = 0,
                    to = 60,
                    seg = SEG,
                    wins = emptyList(),
                )
            }
        }
        return grid
    }

    /** 这套表排了多少分钟（给向导的摘要用） */
    fun minutesOf(days: List<List<HourPlan>>): Int =
        days.sumOf { row -> row.sumOf { if (it.on) (it.to - it.from).coerceIn(0, 60) else 0 } }
}

/**
 * 向导建的那条规则。
 *
 * **不能固化**（`hard = false`）：`Rule` 的 `hard` 默认是 true，而写给新手的规则
 * 一旦固化，到点连关都关不掉——新用户还没有积分可解锁，那就不是自律而是陷阱。
 */
fun buildRule(packages: List<String>, id: String = RULE_ID): Rule = Rule(
    id = id,
    name = Loc.t("开始时选的"),
    enabled = true,
    mode = "blacklist",
    packages = packages,
    hard = false,
)

/** 「开始时选的」这条规则的固定 id：重走向导时是覆盖，不是堆积 */
const val RULE_ID = "onboard-rule"
