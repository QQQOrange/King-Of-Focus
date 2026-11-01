package com.qqqorange.kingoffocus.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/**
 * 一段的目标（"这一段要做什么"）。
 *
 * 和桌面端 `focus.rs::Goal` 是同一个概念：**一段一条**，同段再写就是覆盖。
 * 它不进跨设备备份——这是"这一节课的笔记"，不是配置。
 *
 * 为什么不塞进 Config：目标每天写好几条，跟着配置走会让每次保存都重写一遍
 * 全部规则与排班；而且它天然是"按天累积"的数据，更适合单独一个文件。
 */
@Serializable
data class Goal(
    /** 所属时段的起点（unix 秒） */
    val seg: Long = 0,
    val text: String = "",
    val at: Long = 0,
    val day: String = "",
)

@Serializable
data class GoalDoc(
    val schema: Int = 1,
    val goals: List<Goal> = emptyList(),
)

object GoalStore {
    private const val MAX = 2000

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private lateinit var file: File
    private var list: List<Goal> = emptyList()

    @Synchronized
    fun init(ctx: Context) {
        if (::file.isInitialized) return
        val dir = File(ctx.applicationContext.filesDir, "kof").apply { mkdirs() }
        file = File(dir, "intents.json")
        list = runCatching {
            if (file.exists()) json.decodeFromString<GoalDoc>(file.readText()).goals else emptyList()
        }.getOrElse { emptyList() }
    }

    /** 某一段的目标（没有就是空串） */
    @Synchronized
    fun of(seg: Long): String = list.firstOrNull { it.seg == seg }?.text ?: ""

    /** 写/清空某一段的目标；返回写完之后的文本 */
    @Synchronized
    fun set(seg: Long, text: String, day: String = "", now: Long = System.currentTimeMillis() / 1000): String {
        if (seg <= 0) return ""
        val t = text.trim().take(200)
        val next = list.filter { it.seg != seg }.toMutableList()
        if (t.isNotEmpty()) next += Goal(seg = seg, text = t, at = now, day = day)
        list = if (next.size > MAX) next.sortedBy { it.at }.takeLast(MAX) else next
        save()
        return t
    }

    private fun save() {
        if (!::file.isInitialized) return
        val tmp = File(file.parentFile, "intents.json.tmp")
        runCatching {
            tmp.writeText(json.encodeToString(GoalDoc.serializer(), GoalDoc(goals = list)))
            if (file.exists()) file.delete()
            tmp.renameTo(file)
        }
    }
}
