package com.qqqorange.kingoffocus.data

/**
 * 时段窗口的算术：一小时里的若干段 `[from, to)`（分钟），每段带一个**段标识 `seg`**。
 *
 * 这套语义是照着桌面端搬过来的（`ui/app.js` 的 `hourWins` / `ccSetHourWins` /
 * `ccWinsAfter` / `ccSegIdIn`，`src-tauri` 的 `HourPlan::windows`）。手机端之前只有
 * "窗口"，没有"段"，于是有两个桌面端早就修过的毛病：
 *
 *  1. **相邻的两段会被并成一段**。09:00–10:00 和 10:00–11:00 明明是两个独立安排，
 *     只要时间贴合就会被当成一个整体——锁机里"停止本段"于是会一次停掉两段。
 *  2. **一小时里只能有一段**。`on/from/to` 只能表达一个区间，
 *     09:00–09:30 与 09:30–10:00 会被撑成整小时。
 *
 * 现在一律以 `wins` 为准（每段带自己的 `seg`），`on/from/to/seg` 只是"第一段的近似"，
 * 给老配置和老备份读。判定的唯一出口是 [windowsOf]。
 *
 * ## 三条不许破的规则（与桌面端逐字一致）
 *
 *  · **只有同一个 `seg` 的相接窗口才合并**；id 不同就是两段，哪怕严丝合缝。
 *  · 两边都没有 id（老数据）才退回"按连续性合并"，否则升级后旧排班会碎成一小时一段。
 *  · 一边有一边没有，按"不同段"处理——宁可多分一段，也不要把用户分开的东西合起来。
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

    // ---------------------------------------------------------------- 窗口

    /**
     * 这一小时里所有生效的窗口（**唯一出口**：`wins` 优先，否则退回旧的单窗口字段）。
     * 返回的列表按 `from` 升序，和桌面端 `hourWins()` 一致。
     */
    fun windowsOf(p: HourPlan): List<HourWin> {
        if (!p.on) return emptyList()
        if (p.wins.isNotEmpty()) {
            return p.wins
                .map { HourWin(it.from.coerceIn(0, 59), it.to.coerceIn(1, 60), it.seg) }
                .filter { it.to > it.from }
                .sortedBy { it.from }
        }
        val from = p.from.coerceIn(0, 59)
        // `to == 0` 只在一种情况下出现：老配置里这个字段整个缺失（serde 默认 0）。
        // 桌面端 `hour_end()` 把它当整点结束，这里必须一样——否则整小时会被当成
        // "只选到第 1 分钟"，升级一次就把排班清空。
        val to = if (p.to == 0) 60 else p.to.coerceIn(1, 60)
        if (to <= from) return emptyList()
        return listOf(HourWin(from, to, p.seg))
    }

    /**
     * 把窗口列表写回一小时。只剩一个窗口时收回 `wins`、只留 `from/to/seg`，
     * 避免配置无谓膨胀（桌面端 `ccSetHourWins` 也是这么做的）。
     */
    fun pack(wins: List<HourWin>, work: Int, brk: Int): HourPlan {
        val list = wins
            .map { HourWin(it.from.coerceIn(0, 59), it.to.coerceIn(1, 60), it.seg) }
            .filter { it.to > it.from }
            .sortedBy { it.from }
        if (list.isEmpty()) {
            return HourPlan(
                on = false,
                work = work.coerceIn(0, 60),
                brk = brk.coerceIn(0, 60),
                from = 0,
                to = 60,
                wins = emptyList(),
                seg = "",
            )
        }
        return HourPlan(
            on = true,
            work = work.coerceIn(0, 60),
            brk = brk.coerceIn(0, 60),
            // 旧字段记"总范围"，给只读旧字段的地方一个近似
            from = list.first().from,
            to = list.last().to,
            wins = if (list.size > 1) list else emptyList(),
            seg = list.first().seg,
        )
    }

    /** 相邻两段是否属于同一段（与桌面端 `ccSameSegId` 同义） */
    fun sameSeg(a: String?, b: String?): Boolean {
        val x = a.orEmpty()
        val y = b.orEmpty()
        if (x.isEmpty() && y.isEmpty()) return true      // 老数据：退回按连续性合并
        return x.isNotEmpty() && x == y
    }

    private var segSeq = 0

    /** 新段 id：只要求"同一毫秒内也不撞"，不做持久化解析 */
    fun newSegId(): String {
        segSeq += 1
        return "s" + System.currentTimeMillis().toString(36) + "_" + Integer.toString(segSeq, 36)
    }

    /**
     * 在 `[lo, hi)`（当天绝对分钟）里找**已经选中**的那段用过的 id。
     *
     * 用途：扩展一段已有安排时沿用它的 id，这样整体还是一段；
     * 区间里本来什么都没有就返回空字符串 = 新建一段。
     *
     * 注意只看区间**内部**：紧挨着另一段不算"同一段"，这正是"相邻不合并"的关键。
     * 而且必须按窗口判断，不能按小时——09:00–09:30 与 09:30–10:00 在同一小时里，
     * 按小时判断会让第二段"借用"第一段的 id，然后被合并。
     */
    fun segIdIn(day: List<HourPlan>, lo: Int, hi: Int): String {
        for (h in 0 until 24) {
            val hs = h * 60
            if (hi <= hs || lo >= hs + 60) continue
            for (w in windowsOf(day.getOrNull(h) ?: continue)) {
                val a = hs + w.from
                val b = hs + w.to
                if (b > lo && a < hi && w.seg.isNotEmpty()) return w.seg
            }
        }
        return ""
    }

    /**
     * 把 `[from, to)` 并进这一小时的窗口列表（桌面端 `ccWinsAfter` 的 `add`）。
     *
     * · 同一段相接 → 连起来；
     * · 不同段相接 → 各留各的（两条窗口）；
     * · 不同段重叠 → 新段覆盖中间，旧段两侧截断。
     */
    fun add(wins: List<HourWin>, from: Int, to: Int, seg: String): List<HourWin> {
        val a = from.coerceIn(0, 59)
        val b = to.coerceIn(1, 60)
        if (b <= a) return wins.sortedBy { it.from }

        var nf = a
        var nt = b
        var nseg = seg
        val out = mutableListOf<HourWin>()
        for (w in wins.sortedBy { it.from }) {
            val overlap = w.from < nt && w.to > nf
            val touching = w.to == nf || w.from == nt
            val same = sameSeg(w.seg, nseg)
            if (!overlap && !(touching && same)) {
                out += w
                continue
            }
            if (overlap && !same) {
                if (w.from < nf) out += HourWin(w.from, nf, w.seg)
                if (w.to > nt) out += HourWin(nt, w.to, w.seg)
                continue
            }
            nf = minOf(nf, w.from)
            nt = maxOf(nt, w.to)
            if (w.seg.isNotEmpty()) nseg = w.seg
        }
        out += HourWin(nf, nt, nseg)
        return out.sortedBy { it.from }
    }

    /** 从窗口列表里减去 `[from, to)`（**两侧都留**，一小时能存多段之后不需要只留较长一侧） */
    fun remove(wins: List<HourWin>, from: Int, to: Int): List<HourWin> {
        val a = from.coerceIn(0, 59)
        val b = to.coerceIn(1, 60)
        if (b <= a) return wins.sortedBy { it.from }
        val out = mutableListOf<HourWin>()
        for (w in wins.sortedBy { it.from }) {
            if (b <= w.from || a >= w.to) {
                out += w
                continue
            }
            if (w.from < a) out += HourWin(w.from, a, w.seg)
            if (w.to > b) out += HourWin(b, w.to, w.seg)
        }
        return out.sortedBy { it.from }
    }

    // ---------------------------------------------------------------- 涂格子

    /**
     * 涂一格。
     *
     * `segId` 由调用方给（一次拖动算一个 id），这样"从 9 点拖到 12 点"是**一段**，
     * 而不是 12 个各自独立的小段。为空时新建一个。
     *
     * `on` 时如果这一小时本来就选着一部分，沿用原来的番茄参数——
     * 多拖一格不该把手调过的 25/5 重置成默认值。
     */
    fun paintSlot(
        day: List<HourPlan>,
        slot: Int,
        step: Int,
        on: Boolean,
        work: Int,
        brk: Int,
        segId: String = "",
    ): List<HourPlan> {
        val h = hourOfSlot(slot, step)
        val off = offsetOfSlot(slot, step)
        return day.mapIndexed { i, p ->
            if (i != h) {
                p
            } else if (on) {
                val w = if (p.on) p.work else work
                val b = if (p.on) p.brk else brk
                val id = segId.ifEmpty { newSegId() }
                pack(add(windowsOf(p), off, off + step, id), w, b)
            } else {
                pack(remove(windowsOf(p), off, off + step), p.work, p.brk)
            }
        }
    }

    /** 拖选区间：从起点到当前格（**含两端**），与拖动方向无关 */
    fun dragRange(anchorSlot: Int, slot: Int): IntRange =
        minOf(anchorSlot, slot)..maxOf(anchorSlot, slot)

    /** 一整段连续格子涂成一样：全选 / 清空 / 按范围一次涂完（一整段共用一个 seg） */
    fun paintRange(
        day: List<HourPlan>,
        slots: IntRange,
        step: Int,
        on: Boolean,
        work: Int,
        brk: Int,
        segId: String = "",
    ): List<HourPlan> {
        var out = day
        val id = if (on) segId.ifEmpty { newSegId() } else ""
        for (s in slots) {
            out = paintSlot(out, s, step, on, work, brk, id)
        }
        return out
    }

    /** 整天涂成一样：全选 / 清空（整天算一段） */
    fun paintDay(day: List<HourPlan>, on: Boolean, work: Int, brk: Int, segId: String = ""): List<HourPlan> {
        val id = if (on) segId.ifEmpty { newSegId() } else ""
        return day.map { p ->
            if (on) pack(listOf(HourWin(0, 60, id)), work, brk)
            else pack(emptyList(), p.work, p.brk)
        }
    }

    // ---------------------------------------------------------------- 统计

    /** 这一天一共选中多少分钟 */
    fun dayMinutes(day: List<HourPlan>): Int = day.sumOf { p -> windowsOf(p).sumOf { it.to - it.from } }

    /** 这一小时选中的分钟数（画半格用） */
    fun hourMinutes(p: HourPlan): Int = windowsOf(p).sumOf { it.to - it.from }

    /** 某一分钟是否被选中（判定与画"当前时刻"线都用它） */
    fun covers(p: HourPlan, minute: Int): Boolean =
        windowsOf(p).any { minute >= it.from && minute < it.to }

    /** 当前这一分钟命中的窗口（判定"在时段内"用；找不到 = 不在时段内） */
    fun windowAt(p: HourPlan, minute: Int): HourWin? =
        windowsOf(p).firstOrNull { minute >= it.from && minute < it.to }

    /** "3 小时 20 分" 这种读法 */
    fun fmtMinutes(total: Int): String {
        val m = total.coerceAtLeast(0)
        return if (m < 60) "$m 分钟" else "${m / 60} 小时" + if (m % 60 == 0) "" else " ${m % 60} 分"
    }
}
