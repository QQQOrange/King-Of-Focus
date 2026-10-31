package com.qqqorange.kingoffocus.core

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters

/** 日历里的一天里的一项（周/月网格用，与桌面 `CalItem` 同义） */
data class CalItem(
    val key: String,
    val label: String,
    val secs: Int,
    val spans: List<Span>,
)

/** 日历里的一天（与桌面 `CalDay` 同义） */
data class CalDay(
    val date: LocalDate,
    val secs: Int,
    val items: List<CalItem>,
)

/** 饼图的一片 */
data class Slice(
    val key: String,
    val label: String,
    val secs: Int,
    /** 调色板下标（同一个应用在饼图和日历里必须是同一个颜色） */
    val colorSlot: Int = 0,
)

/**
 * 日历与饼图的纯计算：窗口、按轨合并、配色。
 *
 * 口径照搬桌面端（`ui/app.js` 的 `calWindow` / `calColors` / `calWindowDays`）：
 *  · **一周从周一开始**，与时段表一致；
 *  · **月视图铺满整周**（`weekStart(1 号)` 到 `weekStart(月末)+6`），
 *    所以网格永远是 7 的倍数，不会出现"月末那几天挤成半行"；
 *  · 饼图与日历**共用同一份配色**：同一个应用在上面是橙的，在下面日历里也必须是橙的，
 *    否则每换一个图都要重新"对颜色"。
 */
object StatsCal {

    /** 一周从周一开始 */
    fun weekStart(d: LocalDate): LocalDate =
        d.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))

    /** 周窗口：周一到周日 */
    fun weekWindow(anchor: LocalDate): Pair<LocalDate, LocalDate> {
        val s = weekStart(anchor)
        return s to s.plusDays(6)
    }

    /** 月窗口：覆盖整月的完整周（可能跨到上月末/下月初） */
    fun monthWindow(anchor: LocalDate): Pair<LocalDate, LocalDate> {
        val first = anchor.withDayOfMonth(1)
        val last = anchor.with(TemporalAdjusters.lastDayOfMonth())
        return weekStart(first) to weekStart(last).plusDays(6)
    }

    /**
     * 某一天按轨展开：`onTrack = null` 表示两轨相加。
     *
     * 同一个应用可能"自律时段内用了 20 分钟、时段外用了 10 分钟"——
     * 汇总视图下必须是一条 30 分钟（段也要合到一条时间轴上），
     * 而不是两条各自 20/10 互相盖住。
     */
    fun day(day: StatsDay, onTrack: Boolean?): CalDay {
        val merged = LinkedHashMap<String, CalItem>()
        fun add(map: Map<String, Acc>) {
            for ((k, a) in map) {
                if (a.secs <= 0 && a.spans.isEmpty()) continue
                val old = merged[k]
                merged[k] = if (old == null) {
                    CalItem(k, a.label.ifBlank { k }, a.secs, a.spans.toList())
                } else {
                    CalItem(
                        k,
                        old.label.ifBlank { a.label },
                        old.secs + a.secs,
                        StatsMath.mergeSpans(old.spans + a.spans),
                    )
                }
            }
        }
        if (onTrack != false) add(day.on)
        if (onTrack != true) add(day.off)
        val items = merged.values
            .map { it.copy(spans = StatsMath.mergeSpans(it.spans)) }
            .sortedWith(compareByDescending<CalItem> { it.secs }.thenBy { it.label })
        // StatsDay.date 是 "yyyy-MM-dd" 字符串（落盘形状），这里换成日期对象给网格用
        val date = runCatching { LocalDate.parse(day.date) }.getOrElse { LocalDate.now() }
        return CalDay(date, items.sumOf { it.secs }, items)
    }

    /**
     * 饼图切片：前 [limit] 名各自一片，其余合成「其他 N 项」。
     *
     * 桌面端也是这么做的——手机屏幕更小，把三十个应用摊进一圈饼图没有意义。
     */
    fun slices(
        days: List<Pair<LocalDate, StatsDay>>,
        onTrack: Boolean?,
        limit: Int = 8,
        labelOf: (String) -> String,
    ): List<Slice> {
        val top = StatsMath.top(days, onTrack, Int.MAX_VALUE)
        if (top.isEmpty()) return emptyList()
        val head = top.take(limit)
        val rest = top.drop(limit)
        val out = head.mapIndexed { i, (k, secs) ->
            Slice(k, labelOf(k), secs, i)
        }.toMutableList()
        if (rest.isNotEmpty()) {
            out.add(
                Slice(
                    key = "__rest",
                    label = "其他 ${rest.size} 项",
                    secs = rest.sumOf { it.second },
                    colorSlot = limit,
                ),
            )
        }
        return out
    }

    /**
     * 日历用的配色：先沿用饼图前 8 名的颜色，剩下的按累计时长接着排。
     *
     * 返回 `key -> 调色板下标`；界面按下标取实际颜色（`PALETTE[i % n]`），
     * 这样"颜色"这件事只有一处定义，饼图与日历不会各配各的。
     */
    fun colorSlots(
        pieSlices: List<Slice>,
        calTotals: Map<String, Int>,
        paletteSize: Int = 12,
    ): Map<String, Int> {
        val out = LinkedHashMap<String, Int>()
        val used = HashSet<Int>()
        for (s in pieSlices) {
            if (s.key.isEmpty() || s.key == "__rest") continue
            // 饼图的 slot 已经按排名给好了，直接用；越界的绕回
            val slot = ((s.colorSlot % paletteSize) + paletteSize) % paletteSize
            out[s.key] = slot
            used.add(slot)
        }
        // 只在日历里出现的（别的天/别的时段才用到的）按累计时长续排，避开已占用的槽
        val restKeys = calTotals.entries
            .filter { it.key !in out && it.value > 0 }
            .sortedByDescending { it.value }
        var k = 0
        for ((key, _) in restKeys) {
            while (k < paletteSize && k in used) k++
            val slot = k % paletteSize
            out[key] = slot
            used.add(slot)
            k++
        }
        return out
    }
}
