package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.data.PeerApp
import com.qqqorange.kingoffocus.data.PeerDay
import java.time.LocalDate

/**
 * 统计摘要：**给跨设备同步用的那一小份**。
 *
 * 为什么不是原始日文件：桌面与手机的日文件结构完全不同（桌面按 acc/hours/spans，
 * 手机按应用 + 24 小时桶），原样互传另一端也读不懂。而"今天用了多久、其中自律
 * 时段多久、用得最多的三个应用"这两端都能算出来，文件还小（30 天约 3 KB）。
 *
 * 口径与统计页一致：`total` = 双轨相加，`on` = 自律轨道，`top` 按名字合并两轨后取前三。
 */
object PeerDigest {

    /** 默认带多少天。30 天足够看出"对方最近在干嘛"，再长会让备份文件翻倍 */
    const val DEFAULT_DAYS = 30

    fun of(days: Int = DEFAULT_DAYS, today: LocalDate = LocalDate.now()): List<PeerDay> {
        val n = days.coerceIn(1, 120)
        val out = ArrayList<PeerDay>()
        for (i in 0 until n) {
            val d = today.minusDays(i.toLong())
            val day = StatsStore.day(d)
            val on = day.on.values.sumOf { it.secs.toLong() }
            val off = day.off.values.sumOf { it.secs.toLong() }
            val total = on + off
            // 没有数据的那天不进列表：否则"最近 7 天"会算进一堆空白天
            if (total <= 0L) continue
            val merged = LinkedHashMap<String, Long>()
            for ((k, a) in day.on) merged[k] = (merged[k] ?: 0L) + a.secs
            for ((k, a) in day.off) merged[k] = (merged[k] ?: 0L) + a.secs
            val top = merged.entries
                .sortedByDescending { it.value }
                .take(3)
                // 存 key 原样（手机是包名、桌面是友好名）。展示层再换名字：
                // 这里是 core 层，没有 Context，硬塞一个 labeler 只会让调用链变长。
                .map { PeerApp(name = it.key, secs = it.value) }
            out += PeerDay(day = d.toString(), total = total, on = on, top = top)
        }
        return out
    }
}
