package com.qqqorange.kingoffocus.data

import android.content.Context
import com.qqqorange.kingoffocus.core.DistractMath
import com.qqqorange.kingoffocus.core.StakeMath
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 一次质押：这一段押了多少分、结算了没有。
 *
 * 字段与桌面端 `focus.rs::Stake` 一一对应（不影响备份，纯本机数据）。
 */
@Serializable
data class Stake(
    /** 所属时段的起点（unix 秒） */
    val seg: Long = 0,
    val amount: Int = 0,
    val at: Long = 0,
    /** 结算时间（0 = 还没结算） */
    val settledAt: Long = 0,
    /** 返还了多少（含奖励）；提前退出时为 0 */
    val refunded: Int = 0,
    /** 是否被没收 */
    val `void`: Boolean = false,
)

@Serializable
data class StakeDoc(
    val schema: Int = 1,
    val stakes: List<Stake> = emptyList(),
)

/**
 * 质押的存取与结算。
 *
 * 为什么值得做：积分以前只有"花掉买断"这一个方向，属于纯惩罚性消耗；
 * 押一笔、跑完退回来（还加一点），才让"坐下来这一小时"变成有回报的事。
 */
object StakeStore {
    private const val MAX = 200

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private lateinit var file: File
    private var list: List<Stake> = emptyList()

    @Synchronized
    fun init(ctx: Context) {
        if (::file.isInitialized) return
        val dir = File(ctx.applicationContext.filesDir, "kof").apply { mkdirs() }
        file = File(dir, "stakes.json")
        list = runCatching {
            if (file.exists()) json.decodeFromString<StakeDoc>(file.readText()).stakes else emptyList()
        }.getOrElse { emptyList() }
    }

    private fun save() {
        if (!::file.isInitialized) return
        val tmp = File(file.parentFile, "stakes.json.tmp")
        runCatching {
            tmp.writeText(json.encodeToString(StakeDoc.serializer(), StakeDoc(stakes = list)))
            if (file.exists()) file.delete()
            tmp.renameTo(file)
        }
    }

    private fun epoch(dt: LocalDateTime): Long =
        dt.atZone(ZoneId.systemDefault()).toEpochSecond()

    /** 全部质押记录（周复盘用） */
    @Synchronized
    fun all(): List<Stake> = list

    /** 当前这一段押的那笔（没押 / 已结算 → null） */
    @Synchronized
    fun current(cfg: Config, now: LocalDateTime = LocalDateTime.now()): Stake? {
        val seg = DistractMath.segmentBounds(cfg, now)?.start ?: return null
        return list.firstOrNull { it.seg == seg && it.settledAt == 0L }
    }

    /**
     * 押一笔。返回押注记录；余额不足 / 不在时段里 / 这段已经押过都会明确报错。
     *
     * 调用方负责把返回的分数从 Config.points 里扣掉（这里只管账本），
     * 这样"扣分"这件事仍然只有一个地方写（`Store.update`），不会两处各扣一次。
     */
    @Synchronized
    fun place(
        cfg: Config,
        amount: Int = StakeMath.STAKE,
        now: LocalDateTime = LocalDateTime.now(),
    ): Result<Stake> {
        val seg = DistractMath.segmentBounds(cfg, now)?.start
            ?: return Result.failure(IllegalStateException("现在不在自律时段里，先开始一段再押"))
        val amt = amount.coerceIn(1, 100)
        if (list.any { it.seg == seg && it.settledAt == 0L }) {
            return Result.failure(IllegalStateException("这一段已经押过了"))
        }
        if (cfg.points < amt) {
            return Result.failure(IllegalStateException("积分不够：押 $amt 分，你现在有 ${cfg.points} 分"))
        }
        val s = Stake(seg = seg, amount = amt, at = epoch(now))
        list = (list + s).takeLast(MAX)
        save()
        return Result.success(s)
    }

    /**
     * 提前退出（花积分解锁 / 暂停 / 停止本段）：这一笔没收。
     *
     * 三个按钮各调一次即可；没有押注时什么都不做。
     */
    @Synchronized
    fun forfeit(cfg: Config, now: LocalDateTime = LocalDateTime.now()) {
        val seg = DistractMath.segmentBounds(cfg, now)?.start ?: return
        val current = list.filter { it.seg == seg && it.settledAt == 0L }
        if (current.isEmpty()) return
        val ts = epoch(now)
        list = list.map { if (it.seg == seg && it.settledAt == 0L) StakeMath.forfeited(it, ts) else it }
        save()
    }

    /**
     * 到点结算：自然结束退本金，一次没被打断再加奖励。返回总共该退多少分。
     *
     * 由服务每拍调用——不依赖界面在不在、也不依赖那条"这一段结束了"的通知有没有发出去。
     * 关程序跨过结束时刻的情况，下次启动第一拍就补上。
     */
    @Synchronized
    fun settleDue(
        cfg: Config,
        now: LocalDateTime = LocalDateTime.now(),
    ): Int {
        val nowSec = epoch(now)
        val inSeg = DistractMath.segmentBounds(cfg, now)?.start
        var total = 0
        var changed = false
        val next = list.map { x ->
            // 只数"这一节"里的打断：段的起止都能从排班算出来（段早就结束了也能算）
            val segEnd = if (x.settledAt == 0L) {
                val at = java.time.Instant.ofEpochSecond(x.seg)
                    .atZone(ZoneId.systemDefault()).toLocalDateTime()
                DistractMath.segmentBounds(cfg, at)?.end ?: 0L
            } else {
                0L
            }
            val blocks = if (x.settledAt == 0L) LedgerStore.countBetween(x.seg, segEnd, nowSec) else 0
            val back = StakeMath.settleDecision(x, inSeg != null && inSeg == x.seg, nowSec, blocks)
            if (back == null) {
                x
            } else {
                total += back
                changed = true
                StakeMath.settled(x, nowSec, back)
            }
        }
        if (changed) {
            list = next
            save()
        }
        return total
    }

    /** 给界面的一小包：当前押了多少、上次结果 */
    @Synchronized
    fun snapshot(cfg: Config, now: LocalDateTime = LocalDateTime.now()): Snapshot {
        val cur = current(cfg, now)
        val last = list.lastOrNull { it.settledAt > 0 }
        return Snapshot(
            amount = cur?.amount ?: 0,
            unit = StakeMath.STAKE,
            bonus = StakeMath.BONUS,
            lastVoid = last?.`void` ?: false,
            lastRefunded = last?.refunded ?: 0,
        )
    }

    data class Snapshot(
        val amount: Int,
        val unit: Int,
        val bonus: Int,
        val lastVoid: Boolean,
        val lastRefunded: Int,
    )
}
