package com.qqqorange.kingoffocus.data

import android.content.Context
import com.qqqorange.kingoffocus.core.ReviewMath
import com.qqqorange.kingoffocus.core.StatsMath
import com.qqqorange.kingoffocus.core.StatsStore
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 周复盘：一周五条回答 + 那一周的数据快照。
 *
 * 与桌面端 `review.rs` 同义：产出不是文档，是"下周改什么"那一句。
 * 数据全部来自已有文件（统计日文件、账本、目标、质押、分心事件），
 * 不新建采样——复盘看到的数字必须和统计页是同一份。
 */
@Serializable
data class Review(
    /** 这一周的周一（YYYY-MM-DD），唯一键 */
    val week: String = "",
    val answers: List<String> = emptyList(),
    val at: Long = 0,
)

@Serializable
data class ReviewDoc(
    val schema: Int = 1,
    val items: List<Review> = emptyList(),
)

object ReviewStore {
    /** 固定五问：加问题要同时改界面，所以写成常量 */
    const val Q_COUNT = 5

    private const val MAX_WEEKS = 200

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private lateinit var file: File
    private var items: List<Review> = emptyList()

    @Synchronized
    fun init(ctx: Context) {
        if (::file.isInitialized) return
        val dir = File(ctx.applicationContext.filesDir, "kof").apply { mkdirs() }
        file = File(dir, "reviews.json")
        items = runCatching {
            if (file.exists()) json.decodeFromString<ReviewDoc>(file.readText()).items else emptyList()
        }.getOrElse { emptyList() }
    }

    private fun save() {
        if (!::file.isInitialized) return
        val tmp = File(file.parentFile, "reviews.json.tmp")
        runCatching {
            tmp.writeText(json.encodeToString(ReviewDoc.serializer(), ReviewDoc(items = items)))
            if (file.exists()) file.delete()
            tmp.renameTo(file)
        }
    }

    /** 某一周的回答，补齐到五条（少传不该被当成"格式坏了"） */
    @Synchronized
    fun answersOf(week: String): List<String> {
        val got = items.firstOrNull { it.week == week }?.answers.orEmpty()
        return (0 until Q_COUNT).map { got.getOrNull(it).orEmpty() }
    }

    @Synchronized
    fun saveAnswers(week: String, answers: List<String>, now: Long = System.currentTimeMillis() / 1000) {
        if (week.length != 10) return
        val clean = (0 until Q_COUNT).map { answers.getOrNull(it).orEmpty().trim() }
        val rest = items.filter { it.week != week }
        items = rest + Review(week = week, answers = clean, at = now)
        if (items.size > MAX_WEEKS) {
            items = items.sortedBy { it.week }.takeLast(MAX_WEEKS)
        }
        save()
    }
}

/** 一周的快照（界面只读这个） */
data class WeekSnapshot(
    val weekStart: LocalDate,
    val weekEnd: LocalDate,
    val onSecs: Int = 0,
    val offSecs: Int = 0,
    val prevOnSecs: Int = 0,
    val bestDayLabel: String = "",
    val bestOn: Int = 0,
    val diversions: List<Hit> = emptyList(),
    val diverTotal: Int = 0,
    val goal: GoalStat = GoalStat(),
    val goalDays: Int = 0,
    val staked: Int = 0,
    val stakeClean: Int = 0,
    val stakeVoid: Int = 0,
    val distractTotal: Int = 0,
    val distractDone: Int = 0,
    val answers: List<String> = emptyList(),
)

object ReviewData {

    private fun epoch(d: LocalDate): Long =
        d.atStartOfDay(ZoneId.systemDefault()).toInstant().epochSecond

    fun build(offset: Long = 1, now: LocalDateTime = LocalDateTime.now()): WeekSnapshot {
        val sp = ReviewMath.week(now.toLocalDate(), offset)
        val days = StatsStore.range(sp.start, sp.end)
        val on = StatsMath.total(days, true)
        val off = StatsMath.total(days, false)
        val best = ReviewMath.bestDay(days.map { (d, st) -> d to StatsMath.total(st, null) })

        val prev = ReviewMath.prev(sp)
        val prevOn = StatsMath.total(StatsStore.range(prev.start, prev.end), true)

        // 被打断的来源
        val hits = LedgerStore.range(sp.startKey, sp.endKey)
        val diver = hits.take(3)
        val diverTotal = hits.sumOf { it.n }

        // 目标完成情况
        val goal = GoalStore.stats(sp.startKey, sp.endKey)
        val goalDays = GoalStore.daysWithGoal(sp.startKey, sp.endKey)

        // 质押：这一周里结算过的
        val from = epoch(sp.start)
        val to = epoch(sp.end.plusDays(1))
        val stakes = StakeStore.all().filter { it.seg >= from && it.seg < to && it.settledAt > 0 }
        val clean = stakes.count { !it.`void` && it.refunded > it.amount }
        val voided = stakes.count { it.`void` }

        // 分心事件
        val dis = DistractStore.items.value.filter { it.day >= sp.startKey && it.day <= sp.endKey }

        return WeekSnapshot(
            weekStart = sp.start,
            weekEnd = sp.end,
            onSecs = on,
            offSecs = off,
            prevOnSecs = prevOn,
            bestDayLabel = best?.first?.let { ReviewMath.weekdayShort(it.dayOfWeek) } ?: "",
            bestOn = best?.second ?: 0,
            diversions = diver,
            diverTotal = diverTotal,
            goal = goal,
            goalDays = goalDays,
            staked = stakes.size,
            stakeClean = clean,
            stakeVoid = voided,
            distractTotal = dis.size,
            distractDone = dis.count { it.done },
            answers = ReviewStore.answersOf(sp.startKey),
        )
    }
}
