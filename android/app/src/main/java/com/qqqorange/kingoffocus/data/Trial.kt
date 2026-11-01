package com.qqqorange.kingoffocus.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import com.qqqorange.kingoffocus.core.TrialMath
import java.io.File
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 正在进行的"试用 25 分钟"。
 *
 * 存的东西只有两样：**什么时候结束**、以及**试用之前那张表长什么样**。
 * 后者是必须落盘的——进程被杀之后要靠它把排班还回去，光靠内存就等于把用户
 * 手排的时段永久换成了试用的那一小段。
 */
@Serializable
data class TrialCfg(
    /** 结束时刻（unix 秒） */
    val until: Long = 0,
    /** 试用之前的 7×24 表 */
    val originalDays: List<List<HourPlan>> = emptyList(),
    /**
     * 试用之前的「自律总开关」。
     *
     * 试用要能真的拦人，所以开始时会把它打开；但**用完必须放回去**——
     * 否则用户本来就是关着自律在试，试完被静默打开，会突然开始被拦。
     */
    val originalEnabled: Boolean = true,
)

object TrialStore {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private lateinit var file: File
    private var cur: TrialCfg? = null

    @Synchronized
    fun init(ctx: Context) {
        if (::file.isInitialized) return
        val dir = File(ctx.applicationContext.filesDir, "kof").apply { mkdirs() }
        file = File(dir, "trial.json")
        cur = runCatching {
            if (file.exists()) json.decodeFromString<TrialCfg>(file.readText()) else null
        }.getOrNull()
    }

    @Synchronized
    fun get(): TrialCfg? = cur

    /** 正在试用（没结束） */
    @Synchronized
    fun active(now: Long = System.currentTimeMillis() / 1000): Boolean =
        cur?.let { it.until > now } == true

    @Synchronized
    fun save(t: TrialCfg) {
        cur = t
        if (!::file.isInitialized) return
        runCatching {
            val tmp = File(file.parentFile, "trial.json.tmp")
            tmp.writeText(json.encodeToString(TrialCfg.serializer(), t))
            if (file.exists()) file.delete()
            tmp.renameTo(file)
        }
    }

    @Synchronized
    fun clear() {
        cur = null
        if (!::file.isInitialized) return
        runCatching { if (file.exists()) file.delete() }
    }
}

/**
 * 试用的一次性流程：开始 / 到点还原。
 *
 * 「不吃掉用户排班」是这个功能唯一不能错的地方——所以原始表在开始那一刻就落盘，
 * 还原走的是"把那张表写回去"，而不是"清空重排"。
 */
object TrialRunner {

    private fun epoch(dt: LocalDateTime): Long =
        dt.atZone(ZoneId.systemDefault()).toEpochSecond()

    /** 现在开始试 [minutes] 分钟。已经在试用 / 已经在专注段里时返回 false */
    @Synchronized
    fun start(now: LocalDateTime = LocalDateTime.now(), minutes: Int = TrialMath.MINUTES): Boolean {
        if (TrialStore.active(epoch(now))) return false
        val cfg = Store.current
        // 已经在自律段里就别插一段试用：那会把"上一段做到了吗"搅乱
        if (com.qqqorange.kingoffocus.core.ScheduleEngine.stateAt(cfg, now) != null) return false
        val grid = TrialMath.buildDays(now, minutes)
        TrialStore.save(
            TrialCfg(
                until = epoch(now) + minutes * 60L,
                originalDays = cfg.days,
                originalEnabled = cfg.enabled,
            ),
        )
        Store.update { it.copy(days = grid, enabled = true) }
        return true
    }

    /** 到点就把原表还回去；返回 true 表示这一拍刚还原（调用方负责说一句话） */
    @Synchronized
    fun restoreIfDue(now: LocalDateTime = LocalDateTime.now()): Boolean {
        val t = TrialStore.get() ?: return false
        if (t.until > epoch(now)) return false
        Store.update { it.copy(days = t.originalDays, enabled = t.originalEnabled) }
        TrialStore.clear()
        return true
    }

    /** 还剩多少秒（没在试用 = 0） */
    fun leftSeconds(now: LocalDateTime = LocalDateTime.now()): Long {
        val t = TrialStore.get() ?: return 0
        return (t.until - epoch(now)).coerceAtLeast(0)
    }
}
