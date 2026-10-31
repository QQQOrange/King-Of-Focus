package com.qqqorange.kingoffocus.core

import android.content.Context
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * 使用时长统计。
 *
 * 口径与桌面端一致：**只统计"在用的那段"**，按小时装桶。
 * 采样点在守护服务里（每 15 秒一拍，读前台包名），聚合与查询在这里。
 *
 * 存盘形状刻意简单（一天一个文件）：
 * ```
 * {"date":"2026-10-31","apps":{"com.android.chrome":[0,0,...,120]}}
 * ```
 * 24 个整数 = 那一小时里的秒数。这样"今天/本周/按应用"都能原地算出来，
 * 不需要数据库，也不怕文件写坏——坏一个最多丢一天。
 */
object StatsStore {

    private const val KEEP_DAYS = 90
    private val fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd")
    private val json = Json { ignoreUnknownKeys = true }

    @Volatile
    private var dir: File? = null
    private val cache = LinkedHashMap<String, MutableMap<String, IntArray>>()
    private var dirty = HashSet<String>()
    private val lock = Any()

    fun init(ctx: Context) {
        if (dir != null) return
        val d = File(ctx.applicationContext.filesDir, "kof/stats").apply { mkdirs() }
        dir = d
        prune(d)
    }

    private fun dateKey(now: LocalDateTime): String = now.toLocalDate().format(fmt)

    // ---------------- 采样 ----------------

    /**
     * 记一笔。`seconds` 是这一拍实际代表的时长（采样间隔），不是"1 秒"。
     * 调用方保证同一拍只调一次，避免重复计数。
     */
    fun add(now: LocalDateTime, pkg: String, seconds: Int) {
        if (pkg.isBlank() || seconds <= 0) return
        synchronized(lock) {
            val key = dateKey(now)
            val day = cache.getOrPut(key) { loadInto(key) }
            val buckets = day.getOrPut(pkg) { IntArray(24) }
            buckets[now.hour.coerceIn(0, 23)] += seconds
            dirty.add(key)
        }
    }

    /** 把内存里的改动落盘（守护服务每分钟调一次；退出时也调一次） */
    fun flush() {
        val d = dir ?: return
        val snapshot: Map<String, Map<String, IntArray>>
        synchronized(lock) {
            if (dirty.isEmpty()) return
            snapshot = dirty.associateWith { k -> cache[k]?.mapValues { it.value.copyOf() } ?: emptyMap() }
            dirty.clear()
        }
        for ((key, apps) in snapshot) {
            write(d, key, apps)
        }
    }

    // ---------------- 查询 ----------------

    fun day(date: LocalDate): Map<String, IntArray> {
        val key = date.format(fmt)
        synchronized(lock) {
            cache[key]?.let { return it.mapValues { e -> e.value.copyOf() } }
            val loaded = load(key)
            cache[key] = loaded
            return loaded.mapValues { e -> e.value.copyOf() }
        }
    }

    fun today(now: LocalDateTime = LocalDateTime.now()): Map<String, IntArray> = day(now.toLocalDate())

    /** 最近 n 天（按日期升序），缺失的天给空 */
    fun recent(n: Int, now: LocalDateTime = LocalDateTime.now()): List<Pair<LocalDate, Map<String, IntArray>>> {
        val today = now.toLocalDate()
        return (n - 1 downTo 0).map { back ->
            val d = today.minusDays(back.toLong())
            d to day(d)
        }
    }

    private fun load(key: String): MutableMap<String, IntArray> {
        val f = File(dir ?: return LinkedHashMap(), "$key.json")
        if (!f.exists()) return LinkedHashMap()
        return runCatching {
            val root = json.parseToJsonElement(f.readText()).jsonObject
            val apps = LinkedHashMap<String, IntArray>()
            (root["apps"] as? JsonObject)?.forEach { (pkg, arr) ->
                val buckets = IntArray(24)
                (arr as? JsonArray)?.forEachIndexed { i, v ->
                    if (i < 24) buckets[i] = runCatching { (v as JsonPrimitive).int }.getOrDefault(0)
                }
                apps[pkg] = buckets
            }
            apps
        }.getOrElse { LinkedHashMap() }
    }

    /** 只读、不改缓存：init 时用它加载 */
    private fun loadInto(key: String): MutableMap<String, IntArray> = load(key)

    private fun write(base: File, key: String, apps: Map<String, IntArray>) {
        val appsObj = JsonObject(
            apps.mapValues { (_, v) ->
                JsonArray((0 until 24).map { h -> JsonPrimitive(v.getOrElse(h) { 0 }) })
            },
        )
        val root = JsonObject(
            mapOf(
                "date" to JsonPrimitive(key),
                "apps" to appsObj,
            ),
        )
        val text = runCatching { json.encodeToString(JsonElement.serializer(), root) }.getOrElse { return }
        val f = File(base, "$key.json")
        val tmp = File(base, "$key.json.tmp")
        runCatching {
            tmp.writeText(text)
            if (!tmp.renameTo(f)) {
                f.writeText(text)
                tmp.delete()
            }
        }
    }

    /** 只保留最近 90 天：再久的数据对"自律"没有意义，还占地方 */
    private fun prune(base: File) {
        val files = base.listFiles { f -> f.name.endsWith(".json") } ?: return
        if (files.size <= KEEP_DAYS) return
        files.sortedBy { it.name }.dropLast(KEEP_DAYS).forEach { runCatching { it.delete() } }
    }
}

/**
 * 统计的纯计算部分：不碰文件、不碰 Android，可以直接单测。
 * 输入是"某一天的 应用 → 24 个小时桶（秒）"。
 */
object StatsMath {

    fun total(apps: Map<String, IntArray>): Int =
        apps.values.sumOf { arr -> arr.sum() }

    /** 一天里每个小时的总秒数 */
    fun hourly(apps: Map<String, IntArray>): IntArray {
        val out = IntArray(24)
        for (arr in apps.values) {
            for (h in 0 until 24) out[h] += arr.getOrElse(h) { 0 }
        }
        return out
    }

    /** 按应用排前 n 名 */
    fun top(apps: Map<String, IntArray>, n: Int = 6): List<Pair<String, Int>> =
        apps.entries
            .map { it.key to it.value.sum() }
            .filter { it.second > 0 }
            .sortedByDescending { it.second }
            .take(n)

    /** 连续 n 天的总时长（秒），按日期升序 */
    fun dailyTotals(days: List<Map<String, IntArray>>): List<Int> = days.map { total(it) }

    /** 峰值小时（用来给柱状图定高度；全 0 时返回 0） */
    fun peak(hourly: IntArray): Int = hourly.maxOrNull() ?: 0

    /** "1 小时 23 分" */
    fun fmtDuration(sec: Int): String {
        val s = sec.coerceAtLeast(0)
        if (s < 60) return "${s} 秒"
        val m = s / 60
        if (m < 60) return "${m} 分钟"
        val h = m / 60
        val mm = m % 60
        return if (mm == 0) "${h} 小时" else "${h} 小时 ${mm} 分"
    }
}
