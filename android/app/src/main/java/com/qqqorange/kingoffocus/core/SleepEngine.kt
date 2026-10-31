package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.SleepSegment
import java.time.Duration
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 睡眠时段（纯函数，可单测）。
 *
 * 桌面端到了睡眠时段会倒数关机；Android 既关不了机也杀不掉别的应用，
 * 所以这里落地成**整机锁住**：回桌面 + 全屏遮罩，配一个积分解锁出口
 * （起夜看时间、吃药提醒这类事不能真的把人锁死）。
 *
 * 语义与桌面 `sleep.rs` 对齐的点：
 *  · `to <= from` 表示跨夜（23:00 → 07:00）；
 *  · 支持多段；
 *  · 睡眠时段独立于「自律时段」——自律关着，睡眠照样生效（它就是用来管晚上的）。
 */
object SleepEngine {

    /** 一段正在生效的睡眠窗口 */
    data class Window(
        val start: LocalDateTime,
        val end: LocalDateTime,
        val leftSeconds: Long,
    )

    private fun epoch(now: LocalDateTime): Long =
        now.atZone(ZoneId.systemDefault()).toEpochSecond()

    /** 把「一天里的第几分钟」拼到某个基准日上 */
    private fun at(base: LocalDateTime, minuteOfDay: Int): LocalDateTime {
        val m = minuteOfDay.coerceIn(0, 1440)
        // 1440 表示当天 24:00，等价于次日 00:00
        return base.toLocalDate().atStartOfDay().plusMinutes(m.toLong())
    }

    /**
     * 某一段在 `now` 这一刻的窗口；不在窗口内返回 null。
     *
     * 跨夜段的判定要分两半：`now` 在午夜前属于"今天开始、明天结束"，
     * 在午夜后属于"昨天开始、今天结束"。用同一个函数把两半写在一个地方，
     * 免得两处逻辑各写一遍、总有一处忘记跨夜。
     */
    fun windowOf(seg: SleepSegment, now: LocalDateTime): Window? {
        val from = seg.from.coerceIn(0, 1439)
        val to = seg.to.coerceIn(0, 1440)
        if (from == to) {
            // from == to：24 小时？不，这里按"空段"处理，避免一个手滑把整机锁一整天
            return null
        }
        val minute = now.hour * 60 + now.minute
        val start: LocalDateTime
        val end: LocalDateTime
        if (to > from) {
            // 同日段：09:00 → 12:00
            if (minute < from || minute >= to) return null
            start = at(now, from)
            end = at(now, to)
        } else {
            // 跨夜段：23:00 → 07:00
            if (minute >= from) {
                start = at(now, from)
                end = at(now, to).plusDays(1)
            } else if (minute < to) {
                start = at(now, from).minusDays(1)
                end = at(now, to)
            } else {
                return null
            }
        }
        val left = Duration.between(now, end).seconds.coerceAtLeast(0)
        return Window(start, end, left)
    }

    /** 当前落在哪一段睡眠里（不管解锁状态） */
    fun active(cfg: Config, now: LocalDateTime): Window? {
        if (!cfg.sleep.enabled) return null
        for (seg in cfg.sleep.segments) {
            windowOf(seg, now)?.let { return it }
        }
        return null
    }

    /** 睡眠期间要不要把整机锁住 */
    fun isSleeping(cfg: Config, now: LocalDateTime): Boolean {
        if (!cfg.sleep.enabled || !cfg.sleep.lockScreen) return false
        active(cfg, now) ?: return false
        // 用积分买的那一小段
        if (epoch(now) < cfg.sleepUnlockUntil) return false
        return true
    }

    /** 解锁一次的价格（0 = 这段睡眠不许解锁） */
    fun unlockPrice(cfg: Config): Int {
        val perMin = cfg.sleep.unlockPrice.coerceAtLeast(0)
        if (perMin == 0) return 0
        return perMin * cfg.sleep.unlockMin.coerceIn(1, 240)
    }

    fun canUnlock(cfg: Config, now: LocalDateTime): Boolean {
        val price = unlockPrice(cfg)
        if (price <= 0) return false
        return cfg.points >= price && isSleeping(cfg, now)
    }

    /** 解锁到什么时候（unix 秒）：不超过这一段睡眠的终点 */
    fun unlockUntil(cfg: Config, now: LocalDateTime): Long {
        val w = active(cfg, now) ?: return 0
        val want = epoch(now) + cfg.sleep.unlockMin.coerceIn(1, 240) * 60L
        val end = epoch(w.end)
        return minOf(want, end)
    }

    /** "23:00 – 07:00" 这种给人看的写法 */
    fun fmtSegment(seg: SleepSegment): String {
        fun hhmm(m: Int): String {
            // 1440 = 当天 24:00，显示成 24:00 比 00:00 更好懂（否则 0–1440 会写成 00:00–00:00）
            if (m == 1440) return "24:00"
            val mm = ((m % 1440) + 1440) % 1440
            return "%02d:%02d".format(mm / 60, mm % 60)
        }
        return hhmm(seg.from) + " – " + hhmm(seg.to)
    }
}
