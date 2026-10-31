package com.qqqorange.kingoffocus.core

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * 周报：把统计数字翻成一段人能读的话。
 *
 * 纯函数（`labelOf` 由界面传进来，避免这里依赖 PackageManager），
 * 方便单测，也方便以后换成"分享成图片"。
 *
 * 口径与桌面端的报表一致：**双轨分开报**。
 * 只报一个总数的话，「自律时段里我到底在干什么」这个问题永远回答不了——
 * 而那恰好是这套工具存在的意义。
 */
object Report {

    private val md = DateTimeFormatter.ofPattern("MM-dd")

    fun build(
        now: LocalDateTime,
        days: List<Pair<LocalDate, StatsDay>>,
        /** `true` = 只看自律生效中；`false` = 只看时段外；`null` = 两轨合计 */
        onTrack: Boolean?,
        ruleCount: Int,
        points: Int,
        labelOf: (String) -> String,
    ): String {
        if (days.isEmpty()) return "还没有统计数据。开启自律后在手机上正常使用，数据会自己攒起来。"

        val total = StatsMath.total(days, onTrack)
        val first = days.first().first
        val last = days.last().first
        val lines = ArrayList<String>()
        lines.add("King Of Focus · 使用报告")
        lines.add("${first.format(md)} – ${last.format(md)}")
        lines.add("")
        lines.add("累计 ${fmtDuration(total)}，日均 ${fmtDuration(total / days.size)}")

        // 双轨对比：这是报表里最有用的一段，单看总数看不出"自律有没有起作用"。
        // 只在「汇总」时写——已经选了单轨的报表再来一句"其余 X"会让人以为统计口径不一致。
        val on = StatsMath.total(days, true)
        val off = StatsMath.total(days, false)
        if (onTrack == null && on + off > 0) {
            val pct = on * 100 / (on + off)
            lines.add("自律生效中 ${fmtDuration(on)}（占 $pct%），其余 ${fmtDuration(off)}")
        }

        // 最长的一天（按当前这一轨报，别拿汇总去比）
        val totals = days.map { StatsMath.total(it.second, onTrack) }
        val peakDay = totals.indices.maxByOrNull { totals[it] }
        if (peakDay != null && totals[peakDay] > 0) {
            lines.add("最长的一天：${days[peakDay].first.format(md)}（${fmtDuration(totals[peakDay])}）")
        }

        val top = StatsMath.top(days, onTrack, 6)
        if (top.isNotEmpty()) {
            lines.add("")
            lines.add("用得最多")
            for ((key, sec) in top) {
                val pct = if (total > 0) sec * 100 / total else 0
                lines.add("· ${labelOf(key)}  ${fmtDuration(sec)}（$pct%）")
            }
        }

        // 今天的分时：一句话点出"最常在几点用手机"
        val hourly = StatsMath.hourly(days.last().second, onTrack)
        val peakHour = hourly.indices.maxByOrNull { hourly[it] }
        if (peakHour != null && hourly[peakHour] > 0) {
            lines.add("")
            lines.add("今天 $peakHour 点用得最多（${fmtDuration(hourly[peakHour])}）")
        }

        lines.add("")
        lines.add("自律规则 $ruleCount 条 · 当前积分 $points")
        lines.add("生成于 ${now.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))}")
        return lines.joinToString("\n")
    }
}
