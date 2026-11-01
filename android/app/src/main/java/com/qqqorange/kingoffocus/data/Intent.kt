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
    /**
     * 这一段做完没有：""（还没答）/ done / partial / missed。
     *
     * 与桌面端 `focus.rs::Goal.state` 同义。只要三档、不做"进度条 + 数量"：
     * 那会变成一个小型任务管理器，而这里要回答的是"这一段有没有真的做出东西"。
     */
    val state: String = "",
)

@Serializable
data class GoalDoc(
    val schema: Int = 1,
    val goals: List<Goal> = emptyList(),
)

/** 一段日子里的目标完成情况 */
data class GoalStat(
    val total: Int = 0,
    val done: Int = 0,
    val partial: Int = 0,
    val missed: Int = 0,
    val none: Int = 0,
)

object GoalStore {
    /** 三档判定 + 空串（撤销）；写别的会让完成率变成假的 */
    private val STATE_OK = setOf("", "done", "partial", "missed")

    val STATES = listOf("done", "partial", "missed")

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

    /** 全部目标（首页"上一段做到了吗"要用） */
    @Synchronized
    fun all(): List<Goal> = list

    /** 某一段的判定（没写目标 / 没答 → 空串） */
    @Synchronized
    fun stateOf(seg: Long): String = list.firstOrNull { it.seg == seg }?.state.orEmpty()

    /**
     * 给某一段打勾 / 改判 / 撤销（空串）。
     *
     * 只允许改**有目标**的段：没写目标的段没有"做没做完"可言，
     * 给它记一个状态只会让完成率变成假的。
     */
    @Synchronized
    fun setState(seg: Long, state: String): Boolean {
        if (seg <= 0 || state !in STATE_OK) return false
        if (list.none { it.seg == seg }) return false
        list = list.map { if (it.seg == seg) it.copy(state = state) else it }
        save()
        return true
    }

    /** 目标在某段日子里的完成情况：(总, 做完, 一半, 没做成, 没答)，只算写了目标的段 */
    @Synchronized
    fun stats(from: String, to: String): GoalStat {
        val goals = list.filter { it.day >= from && it.day <= to && it.text.isNotBlank() }
        return GoalStat(
            total = goals.size,
            done = goals.count { it.state == "done" },
            partial = goals.count { it.state == "partial" },
            missed = goals.count { it.state == "missed" },
            none = goals.count { it.state !in STATES },
        )
    }

    /** 写了目标的那些天（周复盘要回答"有几天写了"） */
    @Synchronized
    fun daysWithGoal(from: String, to: String): Int =
        list.filter { it.day >= from && it.day <= to && it.text.isNotBlank() }
            .map { it.day }
            .distinct()
            .size

    /** 写/清空某一段的目标；返回写完之后的文本 */
    @Synchronized
    fun set(seg: Long, text: String, day: String = "", now: Long = System.currentTimeMillis() / 1000): String {
        if (seg <= 0) return ""
        val t = text.trim().take(200)
        // 改文案不清掉已有判定：用户多半只是把"写登录页"改成"写完登录页"
        val keep = list.firstOrNull { it.seg == seg }?.state.orEmpty()
        val next = list.filter { it.seg != seg }.toMutableList()
        if (t.isNotEmpty()) next += Goal(seg = seg, text = t, at = now, day = day, state = keep)
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
