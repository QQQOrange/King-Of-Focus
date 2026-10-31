package com.qqqorange.kingoffocus.data

/**
 * 时段窗口的算术：一小时里的若干段 `[from, to)`（分钟）。
 *
 * ## 为什么还要有 wins
 *
 * `HourPlan` 原本只有一对 `from`/`to`，于是"这一小时里的第 0–15 分钟和第 30–45 分钟"
 * 表达不出来——只能写成 0–45，多钟就要多锁。桌面端早就是 `wins`（一小时多段），
 * 手机端这次跟着对齐：`wins` 非空时以它为准，为空时退回 `from`/`to`（老配置和单段）。
 *
 * ## 粒度只影响画法，不影响数据
 *
 * 刻度 10 / 15 分钟只是"格子多宽"，窗口本身永远按分钟存。所以把 15 改成 10
 * 不会让已排好的时段失效，只是旧边界（:15 / :30）会跨在新格子里——界面上画成半格，
 * 重涂一下就对齐了。反过来如果自动四舍五入，用户会莫名其妙发现自己多锁或少锁了时间。
 */
object Slots {

    /** 合法的刻度：10 或 15，其它值一律当 15 */
    fun stepOf(granularity: Int): Int = if (granularity == 10) 10 else 15

    /** 一天多少格 */
    fun slotsPerDay(step: Int): Int = 1440 / step

    /** 第几格 → 落在第几小时（10 和 15 都能整除 60，所以一格不会跨小时） */
    fun hourOfSlot(slot: Int, step: Int): Int = (slot * step) / 60

    /** 第几格 → 这一小时里的第几分钟 */
    fun offsetOfSlot(slot: Int, step: Int): Int = (slot * step) % 60

    /** 某小时的某个分钟 → 它在当前刻度下的格子序号（当天 0..slotsPerDay-1） */
    fun slotOfMinute(minute: Int, step: Int): Int = minute / step

    fun windowsOf(p: HourPlan): List<HourWin> = when {
        p.wins.isNotEmpty() -> p.wins
        p.on -> listOf(HourWin(p.from.coerceIn(0, 59), p.to.coerceIn(1, 60)))
        else -> emptyList()
    }

    /** 合并重叠/相接的窗口，夹到 0..60，丢掉空窗口 */
    fun normalize(raw: List<HourWin>): List<HourWin> {
        val sorted = raw
            .map { HourWin(it.from.coerceIn(0, 59), it.to.coerceIn(1, 60)) }
            .filter { it.to > it.from }
            .sortedBy { it.from }
        val out = mutableListOf<HourWin>()
        for (w in sorted) {
            val last = out.lastOrNull()
            if (last != null && w.from <= last.to) {
                out[out.size - 1] = HourWin(last.from, maxOf(last.to, w.to))
            } else {
                out += w
            }
        }
        return out
    }

    /**
     * 把窗口列表写回 `HourPlan`。
     *
     * `on` / `from` / `to` 保留成"外包区间"，给老代码、老备份和桌面端不认识
     * `wins` 的那一版看；只有一段时干脆不写 `wins`，序列化形状和以前一样。
     */
    fun pack(wins: List<HourWin>, work: Int, brk: Int): HourPlan {
        val w = normalize(wins)
        return HourPlan(
            on = w.isNotEmpty(),
            work = work.coerceIn(0, 60),
            brk = brk.coerceIn(0, 60),
            from = w.firstOrNull()?.from ?: 0,
            to = w.lastOrNull()?.to ?: 60,
            wins = if (w.size <= 1) emptyList() else w,
        )
    }

    fun add(wins: List<HourWin>, from: Int, to: Int): List<HourWin> =
        normalize(wins + HourWin(from, to))

    fun remove(wins: List<HourWin>, from: Int, to: Int): List<HourWin> =
        normalize(
            wins.flatMap { w ->
                when {
                    to <= w.from || from >= w.to -> listOf(w)
                    from <= w.from && to >= w.to -> emptyList()
                    else -> buildList {
                        if (from > w.from) add(HourWin(w.from, from))
                        if (to < w.to) add(HourWin(to, w.to))
                    }
                }
            },
        )

    /**
     * 涂一格。`on` 时如果这一小时本来就选着一部分，沿用原来的番茄参数——
     * 用户在网格上多拖一格，不该把他手调过的 25/5 重置成默认的 45/15。
     */
    fun paintSlot(
        day: List<HourPlan>,
        slot: Int,
        step: Int,
        on: Boolean,
        work: Int,
        brk: Int,
    ): List<HourPlan> {
        val h = hourOfSlot(slot, step)
        val off = offsetOfSlot(slot, step)
        return day.mapIndexed { i, p ->
            if (i != h) {
                p
            } else if (on) {
                val w = if (p.on) p.work else work
                val b = if (p.on) p.brk else brk
                pack(add(windowsOf(p), off, off + step), w, b)
            } else {
                pack(remove(windowsOf(p), off, off + step), p.work, p.brk)
            }
        }
    }

    /**
     * 拖选区间：从起点到当前格（**含两端**），与拖动方向无关。
     *
     * 抽出来是为了让"往上拖和往下拖结果一样"这件事有断言可测——
     * 以前在界面里写 `for (k in min..max)`，改一行就可能变成单向的。
     */
    fun dragRange(anchorSlot: Int, slot: Int): IntRange =
        minOf(anchorSlot, slot)..maxOf(anchorSlot, slot)

    /** 整天涂成一样：全选 / 清空 */
    fun paintDay(day: List<HourPlan>, on: Boolean, work: Int, brk: Int): List<HourPlan> =
        day.map { p ->
            if (on) pack(listOf(HourWin(0, 60)), work, brk) else pack(emptyList(), p.work, p.brk)
        }

    /** 这一天一共选中多少分钟 */
    fun dayMinutes(day: List<HourPlan>): Int = day.sumOf { p -> windowsOf(p).sumOf { it.to - it.from } }

    /** 这一小时选中的分钟数（画半格用） */
    fun hourMinutes(p: HourPlan): Int = windowsOf(p).sumOf { it.to - it.from }

    /** 某一分钟是否被选中（判定与画"当前时刻"线都用它） */
    fun covers(p: HourPlan, minute: Int): Boolean =
        windowsOf(p).any { minute >= it.from && minute < it.to }

    /** "3 小时 20 分" 这种读法 */
    fun fmtMinutes(total: Int): String {
        val m = total.coerceAtLeast(0)
        return if (m < 60) "$m 分钟" else "${m / 60} 小时" + if (m % 60 == 0) "" else " ${m % 60} 分"
    }
}
