package com.qqqorange.kingoffocus.core

import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * 周报：把统计数字翻成一段人能读的话。
 *
 * 纯函数（`labelOf` 由界面传进来，避免这里依赖 PackageManager），
 * 方便单测，也方便以后换成"分享成图片"。
 */
object Report {

    private val md = DateTimeFormatter.ofPattern("MM-dd")

    fun build(
        now: LocalDateTime,
        days: List<Pair<LocalDate, Map<String, IntArray>>>,
        ruleCount: Int,
        points: Int,
        labelOf: (String) -> String,
    ): String {
        if (days.isEmpty()) return "还没有统计数据。开启自律后在手机上正常使用，数据会自己攒起来。"

        val totals = days.map { (_, apps) -> StatsMath.total(apps) }
        val sum = totals.sum()
        val first = days.first().first
        val last = days.last().first
        val lines = ArrayList<String>()
        lines.add("King Of Focus · 使用报告")
        lines.add("${first.format(md)} – ${last.format(md)}")
        lines.add("")
        lines.add("累计 ${StatsMath.fmtDuration(sum)}，日均 ${StatsMath.fmtDuration(sum / days.size)}")

        // 最专注的一天（只报有数据的日子）
        days.indices.maxByOrNull { totals[it] }?.let { i ->
            if (totals[i] > 0) {
                lines.add("最长的一天：${days[i].first.format(md)}（${StatsMath.fmtDuration(totals[i])}）")
            }
        }

        // 把整周按应用合起来排名
        val merged = HashMap<String, Int>()
        for ((_, apps) in days) {
            for ((pkg, arr) in apps) merged[pkg] = (merged[pkg] ?: 0) + arr.sum()
        }
        val top = merged.entries
            .filter { it.value > 0 }
            .sortedByDescending { it.value }
            .take(6)
        if (top.isNotEmpty()) {
            lines.add("")
            lines.add("用得最多")
            for ((pkg, sec) in top) {
                val pct = if (sum > 0) sec * 100 / sum else 0
                lines.add("· ${labelOf(pkg)}  ${StatsMath.fmtDuration(sec)}（$pct%）")
            }
        }

        // 今天的小时分布：一句话点出"你最常在几点用手机"
        val today = days.last().second
        val hourly = StatsMath.hourly(today)
        val peak = hourly.indices.maxByOrNull { hourly[it] }
        if (peak != null && hourly[peak] > 0) {
            lines.add("")
            lines.add("今天 ${peak} 点用得最多（${StatsMath.fmtDuration(hourly[peak])}）")
        }

        lines.add("")
        lines.add("自律规则 $ruleCount 条 · 当前积分 $points")
        lines.add("生成于 ${now.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))}")
        return lines.joinToString("\n")
    }
}
