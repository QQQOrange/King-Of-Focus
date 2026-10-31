package com.qqqorange.kingoffocus.core

import java.time.LocalDate

/**
 * 统计的**三项指标**：时长、次数、时段。
 *
 * 为什么是这三项：任何"屏幕时间"问题都能拆成三问——
 * 用了多久（时长）、起了多少次（次数）、什么时候用（时段）。
 * 只报时长会看不出"一次看了两小时"和"一天翻四十次"的区别，而那两种行为
 * 对自律的意义完全相反。桌面端的三个卡片（时长分布 / 时间日历 / 24 小时分布）
 * 恰好也是这三个维度，这里把它抽成可测的计算层。
 *
 * 双轨不变：每个指标都分别算「自律时段内」「时段外」和「汇总」，
 * 三档各自完整，不是"只有汇总才是全的"。
 */
object StatsMetrics {

    /**
     * 一项（应用）在某个范围、某个档位下的指标。
     *
     * 字段口径：
     *  · [secs] 来自小时桶（秒级，最准）；
     *  · [sessions]/[longestSec]/[firstMin]/[lastMin] 来自连续段（分钟粒度），
     *    没有段的老数据这些值为 0 / -1，界面要显示"—"而不是 0。
     */
    data class Item(
        val key: String,
        val label: String,
        val secs: Int,
        val sessions: Int,
        val longestSec: Int,
        val avgSec: Int,
        /** 最早开始（当天分钟，-1 = 没有段） */
        val firstMin: Int,
        /** 最晚结束（当天分钟，-1 = 没有段） */
        val lastMin: Int,
        /** 24 个小时桶（按当前档位） */
        val hours: IntArray,
    ) {
        // data class 带 IntArray 必须手写 equals/hashCode，否则每次比较都是 false
        override fun equals(other: Any?): Boolean =
            other is Item && other.key == key && other.secs == secs &&
                other.sessions == sessions && other.longestSec == longestSec

        override fun hashCode(): Int =
            (((key.hashCode() * 31 + secs) * 31 + sessions) * 31 + longestSec)
    }

    /** 一个范围 + 一个档位的完整指标 */
    data class Scope(
        val secs: Int,
        val sessions: Int,
        val avgSec: Int,
        val longestSec: Int,
        /** 峰值小时（0..23）；没有数据时为 -1 */
        val peakHour: Int,
        val peakSecs: Int,
        /** 有数据的整点数 */
        val activeHours: Int,
        /** 最早开始 / 最晚结束（当天分钟，-1 = 没有段） */
        val firstMin: Int,
        val lastMin: Int,
        val hourly: IntArray,
        val items: List<Item>,
        val days: Int,
    ) {
        val empty: Boolean get() = secs <= 0 && sessions == 0
    }

    /**
     * 算一个范围 + 档位的指标。
     *
     * [onTrack]：`true` 自律时段内、`false` 时段外、`null` 两档合并（汇总）。
     * 合并时同名应用的段要合到一条时间轴上再算次数——
     * 否则"自律时段内用了 20 分钟、时段外接着用了 10 分钟"会被算成 2 次。
     */
    fun scope(days: List<Pair<LocalDate, StatsDay>>, onTrack: Boolean?): Scope {
        val hourly = IntArray(24)
        val acc = LinkedHashMap<String, Accum>()

        for ((_, day) in days) {
            fun take(map: Map<String, com.qqqorange.kingoffocus.core.Acc>) {
                for ((k, a) in map) {
                    if (a.secs <= 0 && a.spans.isEmpty()) continue
                    for (h in 0 until 24) hourly[h] += a.hours[h]
                    val cur = acc.getOrPut(k) { Accum(a.label.ifBlank { k }) }
                    cur.secs += a.secs
                    for (h in 0 until 24) cur.hours[h] += a.hours[h]
                    cur.spans.addAll(a.spans)
                }
            }
            if (onTrack != false) take(day.on)
            if (onTrack != true) take(day.off)
        }

        var sessions = 0
        var secs = 0
        var longest = 0
        var first = -1
        var last = -1
        val items = acc.entries
            .map { (k, a) ->
                val merged = StatsMath.mergeSpans(a.spans)
                sessions += merged.size
                secs += a.secs
                if (merged.isNotEmpty()) {
                    val lo = merged.minOf { it.f }
                    val hi = merged.maxOf { it.t }
                    if (first < 0 || lo < first) first = lo
                    if (hi > last) last = hi
                }
                for (sp in merged) if (sp.mins * 60 > longest) longest = sp.mins * 60
                Item(
                    key = k,
                    label = a.label,
                    secs = a.secs,
                    sessions = merged.size,
                    longestSec = merged.maxOfOrNull { it.mins * 60 } ?: 0,
                    avgSec = if (merged.isEmpty()) 0 else {
                        (merged.sumOf { it.mins } * 60) / merged.size
                    },
                    firstMin = merged.minOfOrNull { it.f } ?: -1,
                    lastMin = merged.maxOfOrNull { it.t } ?: -1,
                    hours = a.hours,
                )
            }
            .sortedWith(compareByDescending<Item> { it.secs }.thenBy { it.label })

        val peakHour = hourly.indices.maxByOrNull { hourly[it] } ?: -1
        val peakSecs = if (peakHour >= 0) hourly[peakHour] else 0
        return Scope(
            secs = secs,
            sessions = sessions,
            // 平均一次用多久 = 总时长 / 次数（次数来自段，分钟粒度）
            avgSec = if (sessions == 0) 0 else secs / sessions,
            longestSec = longest,
            peakHour = if (peakSecs > 0) peakHour else -1,
            peakSecs = peakSecs,
            activeHours = hourly.count { it > 0 },
            firstMin = first,
            lastMin = last,
            hourly = hourly,
            items = items,
            days = days.size,
        )
    }

    /** 两档各自的每小时分布，用来画叠加柱状（自律时段内 / 时段外） */
    fun hourlyBoth(days: List<Pair<LocalDate, StatsDay>>): Pair<IntArray, IntArray> {
        val on = IntArray(24)
        val off = IntArray(24)
        for ((_, day) in days) {
            for (a in day.on.values) for (h in 0 until 24) on[h] += a.hours[h]
            for (a in day.off.values) for (h in 0 until 24) off[h] += a.hours[h]
        }
        return on to off
    }

    /** 某个小时里各应用占了多少（点柱状看明细用），按用时降序 */
    fun atHour(days: List<Pair<LocalDate, StatsDay>>, onTrack: Boolean?, hour: Int): List<Item> =
        scope(days, onTrack).items
            .filter { it.hours.getOrElse(hour) { 0 } > 0 }
            .map { it.copy(secs = it.hours[hour]) }
            .sortedByDescending { it.secs }

    private class Accum(val label: String) {
        var secs = 0
        val hours = IntArray(24)
        val spans = ArrayList<Span>()
    }
}
