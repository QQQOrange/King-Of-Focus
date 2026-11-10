package com.qqqorange.kingoffocus.core

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import com.qqqorange.kingoffocus.ui.Loc

/**
 * 使用报告：**与桌面端 `report_out::blocks` 同一套结构、同一套算法**。
 *
 * 写这份时刻意没有另起一种排版。桌面端导出的 Markdown / 纯文本 / Word 都从
 * `Blk` 这个中间结构渲染，段落顺序与层级是固定的：
 *
 * ```
 * 标题
 * 周报 | 统计区间 … ~ … | 生成于 …
 * 时长总览      （双轨 + 合计 + 占比）
 * 开启时段的分布  （分类 → 明细，每类最多 8 条）
 * 未开启时段的分布
 * 说明
 * ```
 *
 * 手机端照抄这五段，于是同一个人同一天在两端看到的数字和句子能对上：
 * 「自律模式已开启 X / 未开启 Y / 合计 Z / 占比 P%」这一组是两端共用的口径，
 * 百分比保留一位小数，时长写成「X 小时 Y 分」（不足一小时写「Y 分钟」）。
 *
 * 两处**平台差异**（不是 bug，写在这里免得以后被当成对齐失误去"修"）：
 *  1. 分类：桌面端分「网站 / 程序」，手机端只记应用包名，所以恒为「程序」——
 *     但共用同一张 `cat_name` 映射，桌面端导出的报告拿到手机上看也是同样的词；
 *  2. 秒级零头：两端都按分钟报（`hhmm` 丢弃秒），所以「42 秒」显示成「0 分钟」。
 *     统计里秒仍然照存，只是报告不显示——桌面端一直如此。
 */
object Report {

    private val md = DateTimeFormatter.ofPattern("MM-dd")
    private val ymdHm = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

    /** 报告周期。与桌面端 `period_name` 的取值一一对应。 */
    enum class Period(val title: String) {
        DAILY(Loc.p("Daily", "日报")),
        WEEKLY(Loc.p("Weekly", "周报")),
        MONTHLY(Loc.p("Monthly", "月报")),
        CUSTOM(Loc.p("Custom report", "自定义报告")),
    }

    /**
     * 生成报告正文（纯文本）。
     *
     * @param onTrack `true` 只看自律生效中、`false` 只看时段外、`null` 两轨合计。
     * @param period 周期，只影响标题那两行；数据范围由 `days` 决定。
     */
    fun build(
        now: LocalDateTime,
        days: List<Pair<LocalDate, StatsDay>>,
        onTrack: Boolean?,
        ruleCount: Int,
        points: Int,
        period: Period = Period.WEEKLY,
        labelOf: (String) -> String,
    ): String {
        if (days.isEmpty()) return Loc.p("No data yet. Turn on discipline and use the phone normally — it accumulates by itself.", "还没有统计数据。开启自律后在手机上正常使用，数据会自己攒起来。")

        val total = StatsMath.total(days, onTrack)
        val on = StatsMath.total(days, true)
        val off = StatsMath.total(days, false)
        val lines = ArrayList<String>()

        lines.add(Loc.p("King Of Focus usage report", "King Of Focus 使用报告"))
        lines.add(
            period.title + Loc.p(" | range ", "　|　统计区间 ") + days.first().first.format(md) +
                " ~ " + days.last().first.format(md) + Loc.p(" | generated ", "　|　生成于 ") + now.format(ymdHm),
        )
        lines.add("")

        // ---------------- 时长总览 ----------------
        lines.add(Loc.p("Duration overview", "时长总览"))
        lines.add(Loc.p("· discipline on: ", "· 自律模式已开启：") + hhmm(on))
        lines.add(Loc.p("· discipline off: ", "· 自律模式未开启：") + hhmm(off))
        lines.add(Loc.p("· total: ", "· 合计：") + hhmm(total))
        lines.add(Loc.p("· on share: ", "· 开启占比：") + pct(on, total))
        lines.add("")

        // ---------------- 两侧分布 ----------------
        pushSide(lines, Loc.p("Distribution while on", "开启时段的分布"), side(days, true), on, labelOf)
        lines.add("")
        pushSide(lines, Loc.p("Distribution while off", "未开启时段的分布"), side(days, false), off, labelOf)
        lines.add("")

        // ---------------- 说明 ----------------
        lines.add(Loc.p("Notes", "说明"))
        lines.add(
            Loc.p("This report is generated locally from hourly samples; it contains no window titles or page content,", "本报告由 King Of Focus 在本地按小时采样生成，不包含任何窗口标题或网页内容，") +
                Loc.p("only package names and display names.", "只统计应用包名与显示名。"),
        )
        lines.add(
            Loc.p("“On” means discipline was active (inside a focus block or locked — either counts).", "「已开启」指自律模式生效（自律时段专注中 / 锁机中，任一成立）。") +
                Loc.p("Pomodoro breaks count as “off” — that time was always yours.", "番茄休息段算「未开启」——那本来就是给你的自由时间。"),
        )
        if (ruleCount > 0 || points > 0) {
            lines.add(Loc.p("$ruleCount rules · $points points", "自律规则 $ruleCount 条 · 当前积分 $points"))
        }
        lines.add(Loc.p("Exported: ", "导出时间：") + LocalDateTime.now().format(ymdHm))
        return lines.joinToString("\n")
    }

    /**
     * 一侧（开 / 未开）的分布：先分类汇总，再列明细。
     *
     * 每类最多 8 条明细，剩下折成「…… 另有 N 项未列出」。桌面端也是 8 条——
     * 手机屏幕更小，把三十个应用摊进报告没人看得下去。
     */
    private fun pushSide(
        lines: MutableList<String>,
        name: String,
        days: List<Pair<LocalDate, StatsDay>>,
        total: Int,
        labelOf: (String) -> String,
    ) {
        lines.add(name)
        val rows = itemsOf(days)
        if (rows.isEmpty()) {
            lines.add(Loc.p("No activity was recorded in this period.", "这一段时间里没有记录到任何活动。"))
            return
        }
        // 分类（保持首次出现顺序），再按占用时间从多到少
        val cats = LinkedHashMap<String, Int>()
        for (r in rows) cats[r.category] = (cats[r.category] ?: 0) + r.secs
        for ((cat, secs) in cats.entries.sortedByDescending { it.value }) {
            lines.add("· " + catName(cat) + "：" + hhmm(secs) + "（" + pct(secs, total) + "）")
            val mine = rows.filter { it.category == cat }.sortedByDescending { it.secs }
            for (r in mine.take(8)) {
                lines.add(
                    "  - " + labelOf(r.key) + " — " + hhmm(r.secs) + "（" + pct(r.secs, total) + "）",
                )
            }
            if (mine.size > 8) lines.add(Loc.p("  - … ${mine.size - 8} more not listed", "  - …… 另有 ${mine.size - 8} 项未列出"))
        }
    }

    private data class Row(val key: String, val category: String, val secs: Int)

    /** 把若干天按应用合并（同名应用跨天相加），并带上分类 */
    private fun itemsOf(days: List<Pair<LocalDate, StatsDay>>): List<Row> {
        val acc = LinkedHashMap<String, Row>()
        for ((_, day) in days) {
            for (map in listOf(day.on, day.off)) {
                for ((k, a) in map) {
                    if (a.secs <= 0) continue
                    val old = acc[k]
                    acc[k] = if (old == null) Row(k, a.category, a.secs)
                    else Row(k, old.category, old.secs + a.secs)
                }
            }
        }
        return acc.values.sortedByDescending { it.secs }
    }

    /**
     * 取一侧的数据：只留需要的那一轨。
     *
     * 为什么不直接过滤行：`StatsMath.total(days, onTrack)` 是按轨算的，
     * 明细必须来自同一轨，否则会出现"分类加起来比合计多"的报告。
     */
    private fun side(
        days: List<Pair<LocalDate, StatsDay>>,
        wantOn: Boolean,
    ): List<Pair<LocalDate, StatsDay>> = days.map { (d, day) ->
        val copy = StatsDay(day.date)
        if (wantOn) {
            day.on.forEach { (k, a) -> copy.on[k] = a }
        } else {
            day.off.forEach { (k, a) -> copy.off[k] = a }
        }
        d to copy
    }

    /** 与桌面端 `hhmm` 逐字一致：不足一小时写「N 分钟」，整小时写「N 小时」 */
    fun hhmm(secs: Int): String {
        val m = secs.coerceAtLeast(0) / 60
        val h = m / 60
        val mm = m % 60
        return when {
            h > 0 && mm > 0 -> Loc.p("${h}h ${mm}m", "$h 小时 $mm 分")
            h > 0 -> Loc.p("${h}h", "$h 小时")
            else -> Loc.p("${mm}m", "$mm 分钟")
        }
    }

    /** 与桌面端 `pct` 一致：一位小数，分母为 0 时给 0.0% */
    fun pct(part: Int, total: Int): String {
        if (total <= 0) return "0.0%"
        return String.format("%.1f%%", part * 100.0 / total)
    }

    /** 与桌面端 `cat_name` 同一张表：site → 网站、app → 程序、其余 → 其他 */
    fun catName(c: String): String = when (c) {
        "site" -> Loc.p("Sites", "网站")
        "app" -> Loc.p("Apps", "程序")
        else -> Loc.p("Other", "其他")
    }
}
