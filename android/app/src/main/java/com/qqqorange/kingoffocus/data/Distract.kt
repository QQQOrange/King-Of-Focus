package com.qqqorange.kingoffocus.data

import android.content.Context
import com.qqqorange.kingoffocus.core.DistractMath
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.time.LocalDateTime

/**
 * 一条分心事件：学习当中突然冒出的零散想法。
 *
 * 落盘字段与桌面端 `distract::Item` 逐个对齐（camelCase），
 * 这样两端排查问题时看的是同一套名字。
 */
@Serializable
data class DistractItem(
    val id: String = "",
    /** 用户写下的那句话（原样保存） */
    val text: String = "",
    /** 记录时刻（unix 秒） */
    val at: Long = 0,
    /** 本地日期 yyyy-MM-dd：日历按它归组，换时区也不会串天 */
    val day: String = "",
    /** 所属自律时段的起止（unix 秒）；不在时段里记的为 0 */
    val segStart: Long = 0,
    val segEnd: Long = 0,
    /** 时段的可读标签，如 09:00–12:00 */
    val segLabel: String = "",
    val done: Boolean = false,
    val doneAt: Long = 0,
    /** 上次提醒时刻：重复提醒按它算间隔（落盘，重启不打乱节奏） */
    val nudgedAt: Long = 0,
)

@Serializable
data class DistractDoc(
    val schema: Int = 1,
    val items: List<DistractItem> = emptyList(),
)

/**
 * 分心事件的存储。
 *
 * 为什么和 `Store`（配置）分开：
 *  · 它是**事件流**，一天几十条，跟配置的读写频率完全不同；
 *  · 它不进跨设备备份（各记各的才说得通），也就不能塞进 config.json 跟着同步走。
 *
 * 写法沿用 `Store` 的两条纪律：先写 .tmp 再改名（断电不留半截 JSON），
 * 解析失败留档而不是静默清空。
 */
object DistractStore {
    /** 超过就丢最老的**已完成**条目。未完成的是"欠自己的账"，一条都不丢 */
    const val MAX_ITEMS = 5000

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private lateinit var file: File
    private val _items = MutableStateFlow<List<DistractItem>>(emptyList())
    val items: StateFlow<List<DistractItem>> get() = _items

    @Synchronized
    fun init(ctx: Context) {
        if (::file.isInitialized) return
        val dir = File(ctx.applicationContext.filesDir, "kof").apply { mkdirs() }
        file = File(dir, "distract.json")
        _items.value = load()
    }

    private fun load(): List<DistractItem> {
        if (!::file.isInitialized || !file.exists()) return emptyList()
        return runCatching { json.decodeFromString<DistractDoc>(file.readText()).items }
            .getOrElse {
                val bad = File(file.parentFile, "distract.broken-${System.currentTimeMillis()}.json")
                runCatching { file.copyTo(bad, overwrite = true) }
                emptyList()
            }
    }

    @Synchronized
    private fun commit(list: List<DistractItem>) {
        _items.value = list
        if (!::file.isInitialized) return
        val tmp = File(file.parentFile, "distract.json.tmp")
        runCatching {
            tmp.writeText(json.encodeToString(DistractDoc.serializer(), DistractDoc(items = list)))
            if (file.exists()) file.delete()
            tmp.renameTo(file)
        }
    }

    /** 只丢最老的已完成条目 */
    private fun prune(list: List<DistractItem>): List<DistractItem> {
        if (list.size <= MAX_ITEMS) return list
        val over = list.size - MAX_ITEMS
        var removed = 0
        val out = ArrayList<DistractItem>(list.size)
        for (it in list) {
            if (removed < over && it.done) {
                removed++
                continue
            }
            out += it
        }
        return out
    }

    // ---------------------------------------------------------------- 写

    /** 记一条。返回 null 表示内容为空（界面上就是"什么都没写"） */
    @Synchronized
    fun add(cfg: Config, text: String, now: LocalDateTime = LocalDateTime.now()): DistractItem? {
        val t = text.trim()
        if (t.isEmpty()) return null
        val body = if (t.length > 500) t.take(500) else t
        val seg = DistractMath.segmentBounds(cfg, now)
        val epoch = now.atZone(java.time.ZoneId.systemDefault()).toEpochSecond()
        val list = _items.value
        var n = 0
        var id = "d$epoch$n"
        while (list.any { it.id == id }) {
            n++
            id = "d$epoch$n"
        }
        val item = DistractItem(
            id = id,
            text = body,
            at = epoch,
            day = now.toLocalDate().toString(),
            segStart = seg?.start ?: 0,
            segEnd = seg?.end ?: 0,
            segLabel = seg?.label ?: "",
        )
        commit(prune(list + item))
        return item
    }

    @Synchronized
    fun setDone(id: String, done: Boolean, now: Long = System.currentTimeMillis() / 1000) {
        val list = _items.value.map {
            if (it.id != id) it
            // 处理掉之后不该再被提醒；取消勾选 = 重新欠账，间隔从这一刻重新算
            else it.copy(done = done, doneAt = if (done) now else 0, nudgedAt = if (done) 0 else now)
        }
        commit(list)
    }

    @Synchronized
    fun delete(id: String) {
        commit(_items.value.filter { it.id != id })
    }

    @Synchronized
    fun clearDone(day: String): Int {
        val before = _items.value.size
        commit(_items.value.filter { !(it.day == day && it.done) })
        return before - _items.value.size
    }

    @Synchronized
    fun markNudged(ids: List<String>, now: Long) {
        if (ids.isEmpty()) return
        commit(_items.value.map { if (ids.contains(it.id)) it.copy(nudgedAt = now) else it })
    }

    // ---------------------------------------------------------------- 读

    fun pending(): Int = _items.value.count { !it.done }

    fun ofDay(day: String): List<DistractItem> =
        _items.value.filter { it.day == day }.sortedByDescending { it.at }

    fun due(cfg: Config, now: Long = System.currentTimeMillis() / 1000): List<DistractItem> =
        DistractMath.dueOf(_items.value, cfg, now)
}
