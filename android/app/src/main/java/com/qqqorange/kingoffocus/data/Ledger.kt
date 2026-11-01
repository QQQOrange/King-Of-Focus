package com.qqqorange.kingoffocus.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * 分心账本：谁打断得最多。
 *
 * 与桌面端 `ledger.rs` 同口径：只记**真的被拦下**的东西（回桌面 / 盖拦截页），
 * 只是扫到没动手的不记——那不算打断，记进去次数会虚高。
 *
 * 与桌面端唯一的差别：Android 的拦截判定是每秒轮询的，同一个应用会连续命中很多拍。
 * 所以这里自带 **30 秒去重**（同 key 30 秒内只算一次）。桌面端的调用点自己已经有节流，
 * 不需要这一层；而 Android 如果不去重，"被打断 300 次"这种数字会直接让账本报废。
 *
 * 为什么不进跨设备备份：这是事件流，两台设备各记各的才说得通。
 */
@Serializable
data class Hit(
    val key: String = "",
    val label: String = "",
    /** app | site */
    val kind: String = "app",
    val n: Int = 0,
    /** 最近一次命中的时间（unix 秒） */
    val last: Long = 0,
    /** 最近一次命中的规则名 */
    val rule: String = "",
)

@Serializable
data class LedgerDay(
    val schema: Int = 1,
    val day: String = "",
    val hits: List<Hit> = emptyList(),
)

object LedgerStore {
    /** 一天最多留这么多条：超出丢"最久没出现"的，而不是拒记新的 */
    private const val MAX = 200

    /** 同一个目标多久算一次（见类注释） */
    private const val DEDUP_SEC = 30L

    /** 留着给报告按月统计 */
    private const val KEEP_DAYS = 400

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private lateinit var dir: File

    @Synchronized
    fun init(ctx: Context) {
        if (::dir.isInitialized) return
        dir = File(File(ctx.applicationContext.filesDir, "kof"), "ledger").apply { mkdirs() }
    }

    private fun dayOf(ts: Long): String =
        Instant.ofEpochSecond(ts).atZone(ZoneId.systemDefault()).toLocalDate().toString()

    private fun fileOf(day: String) = File(dir, "$day.json")

    private fun load(day: String): LedgerDay = runCatching {
        val f = fileOf(day)
        if (f.exists()) json.decodeFromString<LedgerDay>(f.readText()) else LedgerDay(day = day)
    }.getOrElse { LedgerDay(day = day) }

    private fun save(d: LedgerDay) {
        if (!::dir.isInitialized) return
        val f = fileOf(d.day)
        val tmp = File(dir, "${d.day}.json.tmp")
        runCatching {
            tmp.writeText(json.encodeToString(LedgerDay.serializer(), d))
            if (f.exists()) f.delete()
            tmp.renameTo(f)
        }
    }

    /** 记一次拦截。key 由调用方决定：应用用包名，网页用域名 */
    @Synchronized
    fun record(
        kind: String,
        key: String,
        label: String,
        rule: String,
        now: Long = System.currentTimeMillis() / 1000,
    ) {
        if (key.isBlank() || !::dir.isInitialized) return
        val day = dayOf(now)
        val d = load(day)
        val old = d.hits.firstOrNull { it.key == key }
        if (old != null && now - old.last < DEDUP_SEC) {
            // 30 秒内的重复命中：只把"最近一次"往后挪，不涨次数
            if (now > old.last) save(d.copy(hits = d.hits.map { if (it.key == key) it.copy(last = now) else it }))
            return
        }
        val hits = if (old != null) {
            d.hits.map { if (it.key == key) it.copy(n = it.n + 1, last = now, rule = rule) else it }
        } else {
            d.hits + Hit(key = key, label = label.ifBlank { key }, kind = kind, n = 1, last = now, rule = rule)
        }
        // 超量丢"最久没出现"的
        val kept = if (hits.size <= MAX) hits else hits.sortedByDescending { it.last }.take(MAX)
        save(d.copy(hits = kept))
        prune(now)
    }

    /** 保留 KEEP_DAYS 天；顺手清临时文件 */
    private fun prune(now: Long) {
        if (!::dir.isInitialized) return
        val cutoff = dayOf(now - KEEP_DAYS * 86400L)
        runCatching {
            dir.listFiles()?.forEach { f ->
                val name = f.name.removeSuffix(".json").removeSuffix(".tmp")
                if (name.length == 10 && name < cutoff) f.delete()
            }
        }
    }

    /** 某天的账本，按次数从多到少 */
    @Synchronized
    fun day(day: String, limit: Int = 50): List<Hit> =
        if (!::dir.isInitialized) emptyList()
        else load(day).hits.sortedByDescending { it.n }.take(limit)

    /**
     * 一段时间内被打断几次（质押结算要问的就是这个）。
     *
     * `untilSec` 必须有：结算时问的是"**这一节**里被打断几次"。
     * 只给起点的话，之后那几节的打断会把这一节的"干净跑完"奖励吃掉——
     * 用户看到的是"我明明一次没被打断，凭什么只退本金"。
     */
    @Synchronized
    fun countBetween(
        fromSec: Long,
        untilSec: Long,
        now: Long = System.currentTimeMillis() / 1000,
    ): Int {
        if (fromSec <= 0 || !::dir.isInitialized) return 0
        val to = if (untilSec <= 0) now else untilSec
        var total = 0
        var day = LocalDate.parse(dayOf(fromSec))
        val lastDay = LocalDate.parse(dayOf(maxOf(to, fromSec)))
        while (!day.isAfter(lastDay)) {
            total += load(day.toString()).hits.sumOf { h ->
                if (h.last >= fromSec && h.last <= to) h.n else 0
            }
            day = day.plusDays(1)
        }
        return total
    }

    /** 区间合计（报告用）：按 key 合并后按次数排 */
    @Synchronized
    fun range(start: String, end: String): List<Hit> {
        if (!::dir.isInitialized) return emptyList()
        val s = runCatching { LocalDate.parse(start) }.getOrNull() ?: return emptyList()
        val e = runCatching { LocalDate.parse(end) }.getOrNull() ?: return emptyList()
        val map = LinkedHashMap<String, Hit>()
        var d = s
        while (!d.isAfter(e)) {
            for (h in load(d.toString()).hits) {
                val cur = map[h.key]
                map[h.key] = if (cur == null) {
                    h
                } else {
                    cur.copy(n = cur.n + h.n, last = maxOf(cur.last, h.last))
                }
            }
            d = d.plusDays(1)
        }
        return map.values.sortedByDescending { it.n }
    }
}
