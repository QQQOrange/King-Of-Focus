package com.qqqorange.kingoffocus.core

import android.content.Context
import com.qqqorange.kingoffocus.data.Config
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.io.File
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * 一段**连续使用**：当天的分钟数（`0..1440`，`t` 不含）。
 *
 * 小时桶只回答"这一小时用了多久"，回答不了"几点到几点在用"——
 * 同一小时里先后用了两个应用，桶里看不出先后。明细要的就是这个。
 * 与桌面端 `stats.rs` 的 `Span` 同形，这样两端的备份/报表能对上。
 */
data class Span(val f: Int, val t: Int) {
    val mins: Int get() = (t - f).coerceAtLeast(0)
}

/** 一天里某一个条目（应用）的累计 */
class Acc(
    var label: String = "",
    /** `app`（手机端目前只有应用；域名统计需要浏览器插件，见 README） */
    var category: String = "app",
) {
    var secs: Int = 0
    /** 24 个小时桶 */
    val hours = IntArray(24)
    /** 这一天里的连续使用段（按分钟，已排序、已合并相邻） */
    val spans = ArrayList<Span>()

    fun copyOf(): Acc = Acc(label, category).also {
        it.secs = secs
        hours.copyInto(it.hours)
        it.spans.addAll(spans)
    }
}

/**
 * 一天的数据 —— **双轨**，与桌面端 `DayFile` 一致。
 *
 * 为什么必须分两轨：统计页要回答"自律时段里我在干什么"和"放松时我在干什么"。
 * 只留一个总数的话，这两件事永远分不开；而分轨之后「自律时段内的娱乐时长」
 * 才是个有意义的数字（也是这套工具唯一值得看的数字之一）。
 */
class StatsDay(val date: String) {
    val on = LinkedHashMap<String, Acc>()
    val off = LinkedHashMap<String, Acc>()

    fun map(onTrack: Boolean): LinkedHashMap<String, Acc> = if (onTrack) on else off

    fun acc(key: String, onTrack: Boolean, label: String, category: String = "app"): Acc =
        map(onTrack).getOrPut(key) { Acc(label, category) }

    fun total(onTrack: Boolean): Int = map(onTrack).values.sumOf { it.secs }
    fun totalAll(): Int = total(true) + total(false)

    /** 深拷贝：落盘快照要能安全地加"还没封口的那一段"而不动内存里的真数据 */
    fun copyOf(): StatsDay = StatsDay(date).also { d ->
        on.forEach { (k, a) -> d.on[k] = a.copyOf() }
        off.forEach { (k, a) -> d.off[k] = a.copyOf() }
    }
}

/**
 * 使用时长统计的存储。
 *
 * 口径与桌面端一致（`src-tauri/src/stats.rs`）：
 *  · **双轨**：自律生效中 / 其余时间，两套完全隔离；
 *  · **只算"在用"**：熄屏、锁屏不计；亮屏且前台不是自家界面才算；
 *  · **按小时装桶** + **连续使用段**，一天一个文件；
 *  · 一次结算按**实际经过的秒数**记账，跨整点/跨天会切开——
 *    桌面端是每秒采样一次，手机端也按秒结算（见 `StatsMath.slices`）。
 *
 * 与桌面端的两处平台差异（都写在注释里，别当 bug 修）：
 *  1. 桌面用 `GetLastInputInfo` 判断"人还在不在"，Android 没有等价 API。
 *     这里用"亮屏 + 未锁屏"当活跃信号；要更严格可开 `countIdle=false`，
 *     此时额外要求 60 秒内有过无障碍事件（没有无障碍权限就退回亮屏判定）。
 *  2. 手机端把桌面/启动器/系统界面排除在外：停留在桌面上不算"在用某个应用"。
 */
object StatsStore {

    private val fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd")
    private val json = Json { ignoreUnknownKeys = true }

    @Volatile
    private var dir: File? = null
    private val cache = LinkedHashMap<String, StatsDay>()
    private var dirty = HashSet<String>()
    private val lock = Any()

    /** 内存里正在累积的那一段（切应用/熄屏/空闲时封口） */
    private var curSpan: CurSpan? = null

    private data class CurSpan(
        val date: String,
        val key: String,
        val on: Boolean,
        var f: Int,
        var t: Int,
    )

    fun init(ctx: Context) {
        if (dir != null) return
        val d = File(ctx.applicationContext.filesDir, "kof/stats").apply { mkdirs() }
        dir = d
    }

    fun dayKey(now: LocalDateTime): String = now.toLocalDate().format(fmt)

    /**
     * 只给单测用：把存储目录指到临时目录（[init] 需要 Context，JVM 测试里拿不到）。
     * 顺手清掉缓存与未封口的段，避免上一个用例的数据漏进来。
     */
    internal fun useDirForTest(d: File) {
        dir = d
        synchronized(lock) {
            cache.clear()
            dirty.clear()
            curSpan = null
        }
    }

    // ---------------- 采样 ----------------

    /**
     * 记一笔：把 `[from, to)` 这段真实时间记到 [key] 上。
     *
     * 为什么按"实际经过的秒数"而不是固定 15 秒：定时器会漂，服务被系统压过之后
     * 一次 tick 可能隔着好几秒。记固定值会让总时长系统性偏小（或偏大），
     * 而"总时长"正是这个页面唯一的硬指标。
     *
     * 跨整点/跨天由 [StatsMath.slices] 切开，所以 23:59:58 的两秒不会被算进第二天。
     */
    fun record(
        from: LocalDateTime,
        to: LocalDateTime,
        key: String,
        label: String,
        onTrack: Boolean,
        category: String = "app",
    ) {
        if (key.isBlank()) return
        val parts = StatsMath.slices(from, to)
        if (parts.isEmpty()) return
        synchronized(lock) {
            for (p in parts) {
                val day = cache.getOrPut(p.date) { load(p.date) }
                val acc = day.acc(key, onTrack, label, category)
                acc.secs += p.secs
                acc.hours[p.hour.coerceIn(0, 23)] += p.secs
                dirty.add(p.date)
            }
        }
        // 段按"这次时间的起点"记：跨天的那一两秒归属前一天，与桶口径一致。
        // 结束分钟**向上取整**：桌面端每记 1 秒就把 t 推到 min+1，段永远覆盖整分钟；
        // 这里如果直接取 to.minute，一段 30 秒的样本会变成 0 分钟（看着像没记）。
        val fMin = from.hour * 60 + from.minute
        val tMin = to.hour * 60 + to.minute + if (to.second > 0) 1 else 0
        touchSpan(dayKey(from), key, onTrack, fMin, tMin)
    }

    /** 把这一分钟并进当前段；换应用/换轨/隔了不止一分钟就封口再开新段 */
    private fun touchSpan(date: String, key: String, on: Boolean, f: Int, t: Int) {
        synchronized(lock) {
            val cur = curSpan
            val same = cur != null && cur.date == date && cur.key == key && cur.on == on &&
                f <= cur.t + 1
            if (same) {
                if (t > cur!!.t) cur.t = t
                return
            }
            if (cur != null) pushSpan(cur)
            curSpan = CurSpan(date, key, on, f, maxOf(t, f + 1))
        }
    }

    /** 封口当前段（切应用、熄屏、开始空闲、退出时调用） */
    fun closeSpan() {
        synchronized(lock) {
            curSpan?.let { pushSpan(it) }
            curSpan = null
        }
    }

    private fun pushSpan(c: CurSpan) {
        if (c.t <= c.f) return
        val day = cache.getOrPut(c.date) { load(c.date) }
        val acc = day.map(c.on)[c.key] ?: return
        // 和上一段挨着就并起来：秒级抖动否则会把一天切成几百个 1 分钟碎片
        appendSpan(acc, Span(c.f, c.t))
        dirty.add(c.date)
    }

    /**
     * 把内存里的改动落盘（守护服务每分钟调一次；退出时也调一次）。
     *
     * **要把"还没封口的那一段"一起写进去**：它平时只存在内存里（桌面端也一样，
     * 只在切窗口时封口），但那样页面上"明细"就会永远缺最后一段——
     * 用户一看"我明明在用，怎么没有这一段"。这里只在快照里补，不动内存里的开口段，
     * 所以不会影响后续的合并逻辑。
     */
    fun flush() {
        val base = dir ?: return
        val snapshot: Map<String, StatsDay>
        synchronized(lock) {
            if (dirty.isEmpty()) return
            val snap = LinkedHashMap<String, StatsDay>()
            for (k in dirty) {
                val d = cache[k] ?: continue
                snap[k] = d.copyOf()
            }
            curSpan?.let { c ->
                val d = snap[c.date] ?: cache[c.date]?.copyOf()
                if (d != null) {
                    d.acc(c.key, c.on, c.key)
                    appendSpan(d.map(c.on)[c.key]!!, Span(c.f, c.t))
                    snap[c.date] = d
                }
            }
            snapshot = snap
            dirty.clear()
        }
        for ((_, day) in snapshot) write(base, day)
    }

    /** 把一段并进条目（相邻/重叠就合并），供落盘快照与封口共用 */
    private fun appendSpan(acc: Acc, span: Span) {
        if (span.t <= span.f) return
        val last = acc.spans.lastOrNull()
        if (last != null && span.f <= last.t + 1) {
            if (span.t > last.t) acc.spans[acc.spans.lastIndex] = Span(last.f, span.t)
            return
        }
        acc.spans.add(span)
    }

    // ---------------- 查询 ----------------

    /** 某一天（on / off 两轨都在里面） */
    fun day(date: LocalDate): StatsDay {
        val key = date.format(fmt)
        synchronized(lock) {
            cache[key]?.let { return it }
            val loaded = load(key)
            cache[key] = loaded
            return loaded
        }
    }

    fun today(now: LocalDateTime = LocalDateTime.now()): StatsDay = day(now.toLocalDate())

    /** 最近 n 天（按日期升序），缺失的天给空 */
    fun recent(n: Int, now: LocalDateTime = LocalDateTime.now()): List<Pair<LocalDate, StatsDay>> {
        val today = now.toLocalDate()
        return (n - 1 downTo 0).map { back ->
            val d = today.minusDays(back.toLong())
            d to day(d)
        }
    }

    /** 区间内的天（含两端），按日期升序 */
    fun range(start: LocalDate, end: LocalDate): List<Pair<LocalDate, StatsDay>> {
        if (end < start) return emptyList()
        val out = ArrayList<Pair<LocalDate, StatsDay>>()
        var d = start
        var guard = 0
        while (d <= end && guard++ < 800) {
            out.add(d to day(d))
            d = d.plusDays(1)
        }
        return out
    }

    /**
     * 某个条目在区间内的连续使用段（带日期），按时间排序。
     *
     * [onTrack] 必须和页面上选的那一档一致：
     *  · `null`（汇总）= 两轨合并——同一个应用"自律时段内 20 分钟 + 时段外 10 分钟"
     *    是一段连续的使用历史，不该被轨切开；
     *  · `true/false` = 只看那一轨。曾经这里无条件合并，于是在「自律时段内」点开某一项，
     *    明细列出的却包含时段外的段，和上面的总时长对不上。
     */
    fun spansOf(
        key: String,
        days: List<Pair<LocalDate, StatsDay>>,
        onTrack: Boolean? = null,
    ): List<Pair<LocalDate, Span>> {
        val out = ArrayList<Pair<LocalDate, Span>>()
        for ((d, day) in days) {
            val all = ArrayList<Span>()
            if (onTrack != false) day.on[key]?.spans?.let { all.addAll(it) }
            if (onTrack != true) day.off[key]?.spans?.let { all.addAll(it) }
            if (all.isEmpty()) continue
            all.sortBy { it.f }
            out.addAll(StatsMath.mergeSpans(all).map { d to it })
        }
        return out
    }

    private fun load(key: String): StatsDay {
        val day = StatsDay(key)
        val f = File(dir ?: return day, "$key.json")
        if (!f.exists()) return day
        return runCatching {
            val root = json.parseToJsonElement(f.readText()).jsonObject
            (root["on"] as? JsonObject)?.forEach { (k, v) -> readAcc(day.on, k, v) }
            (root["off"] as? JsonObject)?.forEach { (k, v) -> readAcc(day.off, k, v) }
            // 老格式（只有一个 apps 映射、没有轨）：那时的数据没记录自律状态，
            // 无法事后判断，一律归到「时段外」。界面上会说明这一点。
            (root["apps"] as? JsonObject)?.forEach { (k, v) ->
                val acc = day.off.getOrPut(k) { Acc(k, "app") }
                (v as? JsonArray)?.forEachIndexed { i, e ->
                    val n = runCatching { (e as JsonPrimitive).int }.getOrDefault(0)
                    if (i < 24) {
                        acc.hours[i] += n
                        acc.secs += n
                    }
                }
            }
            day
        }.getOrElse { StatsDay(key) }
    }

    private fun readAcc(into: LinkedHashMap<String, Acc>, key: String, v: JsonElement) {
        val o = v as? JsonObject ?: return
        val acc = into.getOrPut(key) { Acc(key, "app") }
        acc.label = (o["label"] as? JsonPrimitive)?.content ?: acc.label
        acc.category = (o["category"] as? JsonPrimitive)?.content ?: acc.category
        acc.secs = runCatching { (o["secs"] as? JsonPrimitive)?.int ?: 0 }.getOrDefault(0)
        (o["hours"] as? JsonArray)?.forEachIndexed { i, e ->
            if (i < 24) acc.hours[i] = runCatching { (e as JsonPrimitive).int }.getOrDefault(0)
        }
        (o["spans"] as? JsonArray)?.forEach { e ->
            val s = e as? JsonObject ?: return@forEach
            val f = runCatching { (s["f"] as? JsonPrimitive)!!.int }.getOrNull() ?: return@forEach
            val t = runCatching { (s["t"] as? JsonPrimitive)!!.int }.getOrNull() ?: return@forEach
            if (t > f) acc.spans.add(Span(f, t))
        }
    }

    private fun write(base: File, day: StatsDay) {
        // 目录可能已经不在了（清数据、脚本删过、备份恢复后）：补一次，
        // 否则下面每一次写入都会静默失败，页面上就是"统计一直是 0"。
        runCatching { base.mkdirs() }
        fun accObj(accs: Map<String, Acc>): JsonObject = JsonObject(
            accs.mapValues { (_, a) ->
                buildJsonObjectOf(
                    "label" to JsonPrimitive(a.label),
                    "category" to JsonPrimitive(a.category),
                    "secs" to JsonPrimitive(a.secs),
                    "hours" to JsonArray((0 until 24).map { h -> JsonPrimitive(a.hours.getOrElse(h) { 0 }) }),
                    "spans" to JsonArray(
                        a.spans.map {
                            buildJsonObjectOf(
                                "f" to JsonPrimitive(it.f),
                                "t" to JsonPrimitive(it.t),
                            )
                        },
                    ),
                )
            },
        )
        val root = buildJsonObjectOf(
            "date" to JsonPrimitive(day.date),
            "on" to accObj(day.on),
            "off" to accObj(day.off),
        )
        val text = runCatching { json.encodeToString(JsonElement.serializer(), root) }.getOrElse { return }
        val f = File(base, "${day.date}.json")
        val tmp = File(base, "${day.date}.json.tmp")
        runCatching {
            tmp.writeText(text)
            if (!tmp.renameTo(f)) {
                f.writeText(text)
                tmp.delete()
            }
        }
    }

    private fun buildJsonObjectOf(vararg pairs: Pair<String, JsonElement>): JsonObject =
        JsonObject(pairs.toMap())

    /**
     * 只保留最近 [keepDays] 天。
     *
     * 与桌面端的 `retention_days` 同一个旋钮（默认 400 天）：手机空间小，
     * 但"去年的这个时候我在干什么"是这套东西的长期价值，砍到 90 天太短了。
     */
    fun prune(keepDays: Int) {
        val base = dir ?: return
        val files = base.listFiles { f -> f.name.endsWith(".json") } ?: return
        val keep = keepDays.coerceIn(7, 3650)
        if (files.size <= keep) return
        files.sortedBy { it.name }.dropLast(keep).forEach { runCatching { it.delete() } }
    }
}

/**
 * 统计的纯计算部分：不碰文件、不碰 Android，可以直接单测。
 */
object StatsMath {

    /** `[from, to)` 按小时边界切开后的一段 */
    data class Slice(val date: String, val hour: Int, val secs: Int)

    private val fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd")

    /**
     * 把一段时间按**小时边界**切开，返回 (日期, 小时, 秒数)。
     *
     * 为什么必须切：桌面端每秒记 1 秒，天然不会跨桶；手机端一次结算可能隔几秒，
     * 23:59:57–00:00:02 这段如果不切，5 秒会全算到第二天。
     *
     * [capSeconds] 防的是系统把服务冻结很久后一次补账（比如休眠唤醒后
     * `elapsedRealtime` 跳了几小时）——那种"时间"人根本不在，不该计入。
     */
    fun slices(from: LocalDateTime, to: LocalDateTime, capSeconds: Int = 300): List<Slice> {
        if (!to.isAfter(from)) return emptyList()
        var left = Duration.between(from, to).seconds.toInt().coerceAtMost(capSeconds)
        if (left <= 0) return emptyList()
        var cur = from.withNano(0)
        val out = ArrayList<Slice>()
        var guard = 0
        while (left > 0 && guard++ < 64) {
            val nextHour = cur.truncatedTo(ChronoUnit.HOURS).plusHours(1)
            val take = minOf(left.toLong(), Duration.between(cur, nextHour).seconds).toInt()
            if (take <= 0) break
            out.add(Slice(cur.toLocalDate().format(fmt), cur.hour, take))
            left -= take
            cur = cur.plusSeconds(take.toLong())
        }
        return out
    }

    /** 某一轨的总秒数 */
    fun total(day: StatsDay, onTrack: Boolean?): Int =
        if (onTrack == null) day.totalAll() else day.total(onTrack)

    /** 区间合计 */
    fun total(days: List<Pair<LocalDate, StatsDay>>, onTrack: Boolean?): Int =
        days.sumOf { total(it.second, onTrack) }

    /** 一天里每个小时的总秒数（`null` = 两轨相加） */
    fun hourly(day: StatsDay, onTrack: Boolean?): IntArray {
        val out = IntArray(24)
        fun add(map: Map<String, Acc>) {
            for (a in map.values) for (h in 0 until 24) out[h] += a.hours[h]
        }
        if (onTrack != false) add(day.on)
        if (onTrack != true) add(day.off)
        return out
    }

    /** 区间里每个小时的总秒数 */
    fun hourly(days: List<Pair<LocalDate, StatsDay>>, onTrack: Boolean?): IntArray {
        val out = IntArray(24)
        for ((_, d) in days) {
            val h = hourly(d, onTrack)
            for (i in 0 until 24) out[i] += h[i]
        }
        return out
    }

    /** 区间内按条目排行前 n（`null` = 两轨相加） */
    fun top(days: List<Pair<LocalDate, StatsDay>>, onTrack: Boolean?, n: Int = 6): List<Pair<String, Int>> {
        val merged = LinkedHashMap<String, Int>()
        for ((_, d) in days) {
            fun add(map: Map<String, Acc>) {
                for ((k, a) in map) merged[k] = (merged[k] ?: 0) + a.secs
            }
            if (onTrack != false) add(d.on)
            if (onTrack != true) add(d.off)
        }
        return merged.entries
            .filter { it.value > 0 }
            .sortedByDescending { it.value }
            .take(n)
            .map { it.key to it.value }
    }

    /** 把相邻/重叠的段合并（双轨合并到一条时间轴上时用） */
    fun mergeSpans(spans: List<Span>): List<Span> {
        if (spans.isEmpty()) return emptyList()
        val sorted = spans.sortedBy { it.f }
        val out = ArrayList<Span>()
        for (s in sorted) {
            val last = out.lastOrNull()
            if (last != null && s.f <= last.t + 1) {
                if (s.t > last.t) out[out.lastIndex] = Span(last.f, s.t)
            } else {
                out.add(s)
            }
        }
        return out
    }

    /** 峰值小时（用来给柱状图定高度；全 0 时返回 0） */
    fun peak(hourly: IntArray): Int = hourly.maxOrNull() ?: 0

    /** 每天的总时长（秒），按传入顺序 */
    fun dailyTotals(days: List<Pair<LocalDate, StatsDay>>, onTrack: Boolean?): List<Int> =
        days.map { total(it.second, onTrack) }

    /** 兼容旧调用点：`StatsMath.fmtDuration`（实现见文件末尾的同名顶层函数） */
    fun fmtDuration(sec: Int): String = com.qqqorange.kingoffocus.core.fmtDuration(sec)

    /** `540..605` → `09:00–10:05` */
    fun fmtSpan(s: Span): String = "${hhmm(s.f)}–${hhmm(s.t)}"

    fun hhmm(minute: Int): String {
        val m = minute.coerceIn(0, 1440)
        return "%02d:%02d".format(m / 60, m % 60)
    }
}

/** `1 小时 23 分` */
fun fmtDuration(sec: Int): String {
    val s = sec.coerceAtLeast(0)
    if (s < 60) return "${s} 秒"
    val m = s / 60
    if (m < 60) return "${m} 分钟"
    val h = m / 60
    val mm = m % 60
    return if (mm == 0) "${h} 小时" else "${h} 小时 ${mm} 分"
}

/**
 * 这一刻算"自律生效中"吗 —— **与拦截/锁机同一个口径**。
 *
 * 桌面端是 `!active.is_empty() || clock_on || locked`（见 `monitor.rs`）。
 * 早期手机端漏了"只配时段、没配规则"这一支，于是明明在专注，
 * 时长却全被记到「时段外」——这正是要分双轨的那个数字。
 */
object StatsTrack {
    fun on(cfg: Config, now: LocalDateTime): Boolean {
        if (!cfg.enabled) return false
        if (GuardEngine.activeRules(cfg, now).isNotEmpty()) return true
        if (ScheduleEngine.stateAt(cfg, now)?.focusing == true) return true
        return LockEngine.isLockActive(cfg, now)
    }
}
