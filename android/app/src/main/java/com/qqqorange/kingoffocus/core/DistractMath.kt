package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.DistractItem
import com.qqqorange.kingoffocus.data.Goal
import com.qqqorange.kingoffocus.data.Slots
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 分心事件的纯逻辑（不碰磁盘、不碰 Context，方便单测）。
 *
 * 与桌面端 `src-tauri/src/distract.rs` 是同一套口径：
 *  · **一段** = 相邻且整段被选中的小时（`to == 60`）；中间缺一格就断开；
 *  · 半小时窗口（09:00–09:45）自成一段；
 *  · 未完成项按 `remindMinutes` 重复提醒，用落盘的 `nudgedAt` 算间隔，
 *    超过 `remindMaxDays` 就不再催（陈年旧账天天弹比不提醒更糟）。
 *
 * 为什么归属要精确到"段"而不是"天"：用户心里的"那一节"是连着坐下来的几小时，
 * 时段结束时的汇总也该按这一段说话（"这一节你记了 3 条"）。
 */
object DistractMath {

    /** 一个自律时段：起止（unix 秒）+ 可读标签 */
    data class Seg(val start: Long, val end: Long, val label: String)

    /** 已经结束、且写了目标的那一段（首页据此问"做到了吗"） */
    data class Ended(val seg: Long, val end: Long, val goal: String, val state: String)

    /**
     * 上一次**已经结束、而且写了目标**的那一段。
     *
     * 与桌面端 `focus::last_ended_goal` 同一套规则：只回溯 [withinHours] 小时——
     * 早上那一段到晚上还追着问，那不叫复盘，叫骚扰。
     */
    fun lastEndedGoal(
        cfg: Config,
        goals: List<Goal>,
        now: LocalDateTime,
        withinHours: Long = 6,
    ): Ended? {
        val nowSec = epoch(now)
        var best: Ended? = null
        for (g in goals) {
            if (g.text.isBlank() || g.seg <= 0) continue
            val at = Instant.ofEpochSecond(g.seg).atZone(ZoneId.systemDefault()).toLocalDateTime()
            val end = segmentBounds(cfg, at)?.end ?: continue
            if (end > nowSec || nowSec - end > withinHours * 3600) continue
            if (best == null || g.seg > best.seg) best = Ended(g.seg, end, g.text, g.state)
        }
        return best
    }

    /** 一条记录归到哪一组（同一天里按段分组用） */
    data class Group(val segStart: Long, val label: String, val items: List<DistractItem>)

    /** 某天的小计 */
    data class DayCount(val total: Int, val done: Int)

    private fun epoch(dt: LocalDateTime): Long =
        dt.atZone(ZoneId.systemDefault()).toEpochSecond()

    /**
     * 某个时刻所在的时段。
     *
     * 往前/往后各最多并 24 小时：排一整天也只是 24 格；再多说明配置异常，
     * 宁可少并也不要在这里死循环。
     */
    fun segmentBounds(cfg: Config, now: LocalDateTime): Seg? {
        if (!cfg.enabled) return null
        val wd = now.dayOfWeek.value - 1
        val hour = now.hour
        val minute = now.minute
        val wins = Slots.windowsOf(cfg.days.getOrNull(wd)?.getOrNull(hour) ?: return null)
        val win = wins.firstOrNull { minute >= it.from && minute < it.to } ?: return null

        val hourStart = now.toLocalDate().atTime(hour, 0)
        var start = hourStart.plusMinutes(win.from.toLong())
        var end = hourStart.plusMinutes(win.to.toLong())

        // 往前接：上一小时必须"整段被选中"（to == 60），否则中间有空隙
        var cursor = hourStart
        var guard = 0
        while (start == cursor && guard++ < 24) {
            val prev = cursor.minusHours(1)
            val pw = Slots.windowsOf(
                cfg.days.getOrNull(prev.dayOfWeek.value - 1)?.getOrNull(prev.hour) ?: break,
            )
            val last = pw.lastOrNull() ?: break
            if (last.to != 60) break
            start = prev.plusMinutes(last.from.toLong())
            cursor = prev
        }

        // 往后接：这一小时顶到整点、下一小时从 0 分开始，才算连着
        cursor = end
        guard = 0
        while (cursor == cursor.withMinute(0).withSecond(0).withNano(0) && guard++ < 24) {
            val nw = Slots.windowsOf(
                cfg.days.getOrNull(cursor.dayOfWeek.value - 1)?.getOrNull(cursor.hour) ?: break,
            )
            val first = nw.firstOrNull() ?: break
            if (first.from != 0) break
            val nxt = cursor.plusMinutes(first.to.toLong())
            if (nxt <= end) break
            end = nxt
            cursor = nxt
        }

        val label = "%02d:%02d–%02d:%02d".format(start.hour, start.minute, end.hour, end.minute)
        return Seg(epoch(start), epoch(end), label)
    }

    /**
     * 该提醒哪些未完成项。
     *
     * 关掉模块 / 间隔为 0 / 已完成 / 刚记下（还没到间隔）/ 超过上限天数 → 都不提醒。
     */
    fun dueOf(items: List<DistractItem>, cfg: Config, nowSec: Long): List<DistractItem> {
        val c = cfg.distract
        if (!c.enabled || c.remindMinutes <= 0) return emptyList()
        val interval = c.remindMinutes * 60
        val maxAge = c.remindMaxDays.coerceAtLeast(1) * 86400
        return items
            .filter { !it.done }
            .filter { nowSec - it.at <= maxAge }
            .filter {
                val last = if (it.nudgedAt > 0) it.nudgedAt else it.at
                nowSec - last >= interval
            }
            .sortedBy { it.at }
    }

    /** 刚结束的那一段里记下的、还没处理的条目（±3 分钟窗口，后台 20 秒一拍也对得上） */
    fun endedSegment(items: List<DistractItem>, nowSec: Long): List<DistractItem> =
        items.filter { !it.done && it.segEnd > 0 && kotlin.math.abs(nowSec - it.segEnd) <= 180 }

    /** 某月的日历计数：`yyyy-MM-dd` → (总数, 已完成) */
    fun monthCounts(items: List<DistractItem>, month: String): Map<String, DayCount> {
        val out = HashMap<String, DayCount>()
        for (it in items) {
            if (!it.day.startsWith(month)) continue
            val old = out[it.day] ?: DayCount(0, 0)
            out[it.day] = DayCount(old.total + 1, old.done + if (it.done) 1 else 0)
        }
        return out
    }

    /** 某天的条目，按时段分组（新 → 旧），组内按时间倒序 */
    fun dayGroups(items: List<DistractItem>, day: String): List<Group> {
        val list = items.filter { it.day == day }.sortedByDescending { it.at }
        val groups = LinkedHashMap<Long, Group>()
        for (it in list) {
            val key = it.segStart
            val g = groups[key]
            groups[key] = if (g == null) {
                Group(key, it.segLabel.ifBlank { "不在自律时段内" }, listOf(it))
            } else {
                g.copy(items = g.items + it)
            }
        }
        return groups.values.sortedByDescending { it.segStart }
    }

    /** 今天（设备本地日期） */
    fun today(): String = LocalDate.now().toString()

    /** 日期串校验：日历只认 `yyyy-MM-dd`，别让奇怪的输入把界面画崩 */
    fun validDay(s: String): Boolean =
        runCatching { LocalDate.parse(s) }.isSuccess
}
