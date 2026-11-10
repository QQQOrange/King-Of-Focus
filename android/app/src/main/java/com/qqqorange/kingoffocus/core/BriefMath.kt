package com.qqqorange.kingoffocus.core

import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Slots
import java.time.LocalDateTime
import java.time.temporal.ChronoUnit
import com.qqqorange.kingoffocus.ui.Loc

/**
 * 总览页那两个"现在/接下来"的小问题（纯函数，可单测）。
 *
 * 桌面端在 `focus::next_segment` 里算同一件事，然后一起塞进 `today_brief`。
 * 手机上**不能另算一份**：它和遮罩、锁机用的是同一份排班（`Slots.windowsOf`），
 * 只要口径差一格，用户就会看到"显示下一段 10:00，可遮罩 09:45 就盖下来了"。
 *
 * 所以这里逐小时扫、最多 7 天，和桌面一模一样的笨办法：
 * 一小时里有两段时（09:00–09:20 与 09:40–10:00），只看"起点还在未来"的那一段，
 * 正在跑的这一段不算"下一段"。
 */
object BriefMath {

    /** 下一段：还有多少秒、几点开始、整段是什么样子（`14:00–16:00`） */
    data class Next(val inSecs: Long, val at: String, val label: String)

    /**
     * 往后找"下一个还没开始的段"。
     *
     * 返回 null 只有两种情况：自律总开关关着，或者未来 7 天一格都没排
     * （后者在向导之前很常见——空排班的用户不该看到"下一段"永远不来的暗示）。
     */
    fun nextSegment(cfg: Config, now: LocalDateTime): Next? {
        if (!cfg.enabled) return null
        // 锚在整点：桌面用 `now.with_minute(0)` 再 +step 小时，这里必须一样，
        // 否则 09:30 起步时第二天的窗口会整体错开半小时。
        val anchor = now.truncatedTo(ChronoUnit.HOURS)
        for (step in 0 until 168) {
            val base = anchor.plusHours(step.toLong())
            val wd = base.dayOfWeek.value - 1
            val p = cfg.days.getOrNull(wd)?.getOrNull(base.hour) ?: continue
            for (w in Slots.windowsOf(p)) {
                val start = base.plusMinutes(w.from.toLong())
                // `windowsOf` 已按 from 排序，所以第一个"起点在未来"的就是最近的那段。
                // 正在跑的那段（start <= now）跳过——它已经在状态卡上倒计时了。
                if (!start.isAfter(now)) continue
                val end = base.plusMinutes(w.to.toLong())
                return Next(
                    inSecs = ChronoUnit.SECONDS.between(now, start),
                    at = hhmm(start),
                    label = "${hhmm(start)}–${hhmm(end)}",
                )
            }
        }
        return null
    }

    /**
     * "还有多久"的人话版本。
     *
     * 不到一分钟单独说一句：直接显示"0 分钟"会让人以为算错了。
     */
    fun fmtLeft(secs: Long): String {
        val s = secs.coerceAtLeast(0)
        if (s < 60) return Loc.t("不到 1 分钟")
        return Slots.fmtMinutes((s / 60).toInt())
    }

    private fun hhmm(t: LocalDateTime): String =
        "%02d:%02d".format(t.hour, t.minute)
}
