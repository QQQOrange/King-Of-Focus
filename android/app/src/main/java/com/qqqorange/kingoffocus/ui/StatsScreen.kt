package com.qqqorange.kingoffocus.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.core.CalDay
import com.qqqorange.kingoffocus.core.Report
import com.qqqorange.kingoffocus.core.Slice
import com.qqqorange.kingoffocus.core.Span
import com.qqqorange.kingoffocus.core.StatsCal
import com.qqqorange.kingoffocus.core.StatsDay
import com.qqqorange.kingoffocus.core.StatsMath
import com.qqqorange.kingoffocus.core.StatsStore
import com.qqqorange.kingoffocus.core.fmtDuration
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.loadLaunchableApps
import com.qqqorange.kingoffocus.toast
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import kotlin.math.atan2
import kotlin.math.min
import kotlin.math.sqrt

/**
 * 使用统计 —— 与桌面端「统计」页同一套结构，按手机屏幕重排成纵向四段。
 *
 * ```
 * ┌ 双轨 tab：自律时段内 / 时段外 / 汇总
 * ├ 视图：[按日][按周][按月]   + 周期 ‹ ›
 * ├ 饼图（甜甜圈 + 合计 + 前几名图例）
 * ├ 日历（跟着视图变：24 小时竖轨 / 7 列周轨 / 月网格）
 * ├ 明细（每一项：色点 · 名称 · 时长 · 占比，点开看连续使用段）
 * └ 报告（可复制 / 分享）
 * ```
 *
 * 为什么三块必须联动：它们回答的是同一个问题——"这段时间我都在干什么"。
 * 饼图给比例、日历给分布、明细给清单；任何一块换个周期而别的没换，
 * 读者就会看到"上面 3 小时、下面 5 小时"。所以周期只有一个状态（[view] + [anchor]），
 * 三块都从它算出来（与桌面 `statsTabKey()` / `calRange()` 的单一来源思路一致）。
 *
 * 配色也只有一个来源：饼图前 8 名先占色，日历与明细沿用同一份
 * （[StatsCal.colorSlots]），所以同一个应用在三处永远是同一个颜色。
 */
@Composable
fun StatsScreen(cfg: Config) {
    val ctx = LocalContext.current
    var bump by remember { mutableStateOf(0) }
    val now = LocalDateTime.now()
    val today = now.toLocalDate()

    // 双轨：true = 自律生效中，false = 时段外，null = 汇总
    var tab by remember { mutableStateOf<Boolean?>(null) }
    // 视图与锚点：三块共用（唯一状态）
    var view by remember { mutableStateOf(StatsView.DAY) }
    var anchor by remember { mutableStateOf(today) }
    // 选中项：饼图/日历点选后，明细里高亮并展开
    var picked by remember { mutableStateOf<String?>(null) }

    val window: Pair<LocalDate, LocalDate> = remember(view, anchor) {
        when (view) {
            StatsView.DAY -> anchor to anchor
            StatsView.WEEK -> StatsCal.weekWindow(anchor)
            StatsView.MONTH -> StatsCal.monthWindow(anchor)
        }
    }
    val days: List<Pair<LocalDate, StatsDay>> = remember(bump, window) {
        StatsStore.range(window.first, window.second)
    }
    val calDays: List<Pair<LocalDate, CalDay>> = remember(days, tab) {
        days.map { (d, day) -> d to StatsCal.day(day, tab) }
    }
    val total = remember(days, tab) { StatsMath.total(days, tab) }
    val onSecs = remember(days) { StatsMath.total(days, true) }
    val offSecs = remember(days) { StatsMath.total(days, false) }
    // 日均按"窗口里真实有几天"算（月视图铺满整周，但不能把日均摊到 35 天上）
    val avgBase = remember(window) {
        val real = if (view == StatsView.MONTH) anchor.lengthOfMonth() else 0
        if (real > 0) real else {
            (window.second.toEpochDay() - window.first.toEpochDay() + 1).toInt().coerceAtLeast(1)
        }
    }

    val labels = remember { loadLaunchableApps(ctx).associate { it.pkg to it.label } }
    fun labelOf(key: String): String = when (key) {
        "__rest" -> "其他"
        else -> labels[key] ?: key.ifBlank { "未知应用" }
    }

    val slices = remember(days, tab) { StatsCal.slices(days, tab, 8) { labelOf(it) } }
    val slotOf = remember(slices, calDays) {
        val calTotals = HashMap<String, Int>()
        for ((_, d) in calDays) for (it in d.items) {
            calTotals[it.key] = (calTotals[it.key] ?: 0) + it.secs
        }
        StatsCal.colorSlots(slices, calTotals, PALETTE.size)
    }
    fun colorOf(key: String): Color {
        val slot = slotOf[key] ?: (PALETTE.lastIndex)
        return PALETTE[((slot % PALETTE.size) + PALETTE.size) % PALETTE.size]
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PageHeader("使用统计", "只算你在用的时间：熄屏、锁屏、停在桌面都不计")

        // —— 双轨 ——
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val names = listOf("自律时段内", "时段外", "汇总")
            listOf<Boolean?>(true, false, null).forEachIndexed { i, t ->
                Pill(names[i], on = tab == t, modifier = Modifier.weight(1f)) {
                    tab = t
                    picked = null
                }
            }
        }

        // —— 视图 + 周期 ——
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            StatsView.entries.forEach { v ->
                Pill(v.title, on = view == v, compact = true) {
                    view = v
                    picked = null
                }
            }
            Spacer(Modifier.weight(1f))
            TextButton(
                onClick = { anchor = shift(anchor, view, -1); picked = null },
                contentPadding = PAD0,
            ) { Text("‹", fontSize = 18.sp) }
            Text(
                periodLabel(view, window, anchor),
                fontSize = 11.5.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
            TextButton(
                onClick = { anchor = shift(anchor, view, 1); picked = null },
                contentPadding = PAD0,
            ) { Text("›", fontSize = 18.sp) }
            if (anchor != today) {
                TextButton(onClick = { anchor = today; picked = null }, contentPadding = PAD0) {
                    Text("今天", fontSize = 11.sp, color = MaterialTheme.colorScheme.primary)
                }
            }
        }

        // —— 饼图 ——
        Panel {
            if (total <= 0) {
                EmptyHint(
                    if (!cfg.stats.enabled) "统计已关闭，去「设置 → 使用统计」打开"
                    else "这段时间还没有这一档的数据。换一个状态看看，或者正常用一会儿手机。",
                )
            } else {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    DonutChart(
                        slices = slices,
                        total = total,
                        colorOf = { colorOf(it) },
                        picked = picked,
                        modifier = Modifier.size(148.dp),
                        onPick = { picked = if (picked == it) null else it },
                    )
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(fmtDuration(total), fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
                        Text(
                            "日均 " + fmtDuration(total / avgBase),
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        // 只有「汇总」才谈得上占比：分档看的时候这一行没有意义
                        if (tab == null && onSecs + offSecs > 0) {
                            Text(
                                "自律时段内 " + (onSecs * 100 / (onSecs + offSecs)) + "%",
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Spacer(Modifier.height(2.dp))
                        // 图例只列前 4：再多就和下面的明细重复了
                        slices.take(4).forEach { s ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Dot(colorOf(s.key))
                                Text(
                                    s.label,
                                    fontSize = 11.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                Text(
                                    "  " + pct(s.secs, total) + "%",
                                    fontSize = 10.5.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }

        // —— 日历（随视图切换） ——
        SectionTitle(
            when (view) {
                StatsView.DAY -> "这一天"
                StatsView.WEEK -> "这一周"
                StatsView.MONTH -> "这个月"
            } + " · " + trackName(tab),
        )
        Panel {
            when (view) {
                StatsView.DAY -> {
                    val d = calDays.firstOrNull { it.first == anchor }?.second
                        ?: CalDay(anchor, 0, emptyList())
                    DayTimeline(
                        day = d,
                        colorOf = { colorOf(it) },
                        picked = picked,
                        onPick = { picked = if (picked == it) null else it },
                    )
                }

                StatsView.WEEK -> WeekCalendar(
                    window = window,
                    days = calDays,
                    today = today,
                    picked = picked,
                    colorOf = { colorOf(it) },
                    onOpenDay = { d ->
                        view = StatsView.DAY
                        anchor = d
                        picked = null
                    },
                )

                StatsView.MONTH -> MonthCalendar(
                    month = anchor,
                    window = window,
                    days = calDays,
                    today = today,
                    colorOf = { colorOf(it) },
                    onOpenDay = { d ->
                        view = StatsView.DAY
                        anchor = d
                        picked = null
                    },
                )
            }
        }

        // —— 明细列表 ——
        SectionTitle("耗时明细")
        Panel {
            if (slices.isEmpty()) {
                EmptyHint("这段时间没有记录")
            } else {
                slices.forEach { s ->
                    DetailRow(
                        slice = s,
                        total = total,
                        color = colorOf(s.key),
                        expanded = picked == s.key,
                        onClick = { picked = if (picked == s.key) null else s.key },
                        spans = if (picked == s.key) StatsStore.spansOf(s.key, days, tab) else emptyList(),
                    )
                }
            }
        }

        // —— 报告 ——
        SectionTitle("报告")
        Panel {
            // 键里必须带 window：只按 days.size 记会串期（10-30 与 10-31 都是 1 天），
            // 翻页后报告还写着前一天
            val text = remember(bump, tab, window, cfg.rules.size, cfg.points) {
                Report.build(now, days, tab, cfg.rules.size, cfg.points) { k -> labelOf(k) }
            }
            Text(text, fontSize = 11.5.sp, lineHeight = 18.sp, color = MaterialTheme.colorScheme.onSurface)
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = {
                    val cm = ctx.getSystemService(ClipboardManager::class.java)
                    cm?.setPrimaryClip(ClipData.newPlainText("King Of Focus 使用报告", text))
                    toast(ctx, "报告已复制")
                }) { Text("复制", fontSize = 12.sp) }
                OutlinedButton(onClick = {
                    runCatching {
                        ctx.startActivity(
                            Intent.createChooser(
                                Intent(Intent.ACTION_SEND).apply {
                                    type = "text/plain"
                                    putExtra(Intent.EXTRA_TEXT, text)
                                },
                                "分享报告",
                            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                }) { Text("分享", fontSize = 12.sp) }
                OutlinedButton(onClick = { bump += 1 }) { Text("刷新", fontSize = 12.sp) }
            }
        }
        Spacer(Modifier.height(6.dp))
    }
}

// ------------------------------------------------------------------ 视图模型

private enum class StatsView(val title: String) {
    DAY("按日"),
    WEEK("按周"),
    MONTH("按月"),
}

private val PAD0 = PaddingValues(horizontal = 4.dp, vertical = 2.dp)

/** 桌面端同一套 12 色（`PALETTE`）：两端截图摆在一起时颜色也对得上 */
private val PALETTE = listOf(
    Color(0xFFFFB020), Color(0xFFFF7A45), Color(0xFFF759AB), Color(0xFFB37FEB),
    Color(0xFF5B8CFF), Color(0xFF36CFC9), Color(0xFF52C41A), Color(0xFFA0D911),
    Color(0xFFFAAD14), Color(0xFFFF5C5C), Color(0xFF40A9FF), Color(0xFF9254DE),
)

private val WEEKDAYS = listOf("周一", "周二", "周三", "周四", "周五", "周六", "周日")

private fun shift(anchor: LocalDate, view: StatsView, dir: Long): LocalDate = when (view) {
    StatsView.DAY -> anchor.plusDays(dir)
    StatsView.WEEK -> anchor.plusWeeks(dir)
    StatsView.MONTH -> anchor.plusMonths(dir)
}

private fun periodLabel(view: StatsView, w: Pair<LocalDate, LocalDate>, anchor: LocalDate): String =
    when (view) {
        StatsView.DAY -> anchor.format(DateTimeFormatter.ofPattern("MM-dd")) +
            " " + WEEKDAYS[anchor.dayOfWeek.value - 1]
        StatsView.WEEK -> w.first.format(DateTimeFormatter.ofPattern("MM-dd")) + " ~ " +
            w.second.format(DateTimeFormatter.ofPattern("MM-dd"))
        StatsView.MONTH -> anchor.year.toString() + " 年 " + anchor.monthValue + " 月"
    }

private fun trackName(tab: Boolean?): String = when (tab) {
    true -> "自律时段内"
    false -> "时段外"
    null -> "汇总"
}

private fun pct(sec: Int, total: Int): Int = if (total <= 0) 0 else (sec * 100 / total)

// ------------------------------------------------------------------ 组件

@Composable
private fun Pill(
    text: String,
    on: Boolean,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
    onClick: () -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Box(
        modifier
            .background(if (on) cs.primary else cs.surfaceVariant, RoundedCornerShape(999.dp))
            .clickable(onClick = onClick)
            .padding(
                horizontal = if (compact) 10.dp else 8.dp,
                vertical = if (compact) 4.dp else 7.dp,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            fontSize = if (compact) 11.sp else 11.5.sp,
            color = if (on) cs.onPrimary else cs.onSurfaceVariant,
        )
    }
}

@Composable
private fun Dot(color: Color) {
    Box(
        Modifier
            .padding(end = 6.dp)
            .size(8.dp)
            .clip(CircleShape)
            .background(color),
    )
}

/**
 * 甜甜圈。
 *
 * 为什么不做成实心饼：手机上那一圈粗细正好能容下高亮（点某项时那一块加厚），
 * 中间还能放合计——桌面 620×360 的画布才撑得开引导线，手机没有那个空间。
 * 点圆环上的某一块 = 选中这一项（明细里高亮并展开），点空洞不响应。
 */
@Composable
private fun DonutChart(
    slices: List<Slice>,
    total: Int,
    colorOf: (String) -> Color,
    picked: String?,
    modifier: Modifier = Modifier,
    onPick: (String) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Canvas(
        modifier.pointerInput(slices, picked) {
            detectTapGestures { p ->
                val r = size.width / 2f
                val dx = p.x - r
                val dy = p.y - r
                val dist = sqrt(dx * dx + dy * dy)
                if (dist < r * 0.42f || dist > r) return@detectTapGestures
                var ang = Math.toDegrees(atan2(dy.toDouble(), dx.toDouble())).toFloat() + 90f
                if (ang < 0) ang += 360f
                var acc = 0f
                for (s in slices) {
                    val sweep = 360f * s.secs / total.coerceAtLeast(1)
                    if (ang >= acc && ang < acc + sweep) {
                        onPick(s.key)
                        return@detectTapGestures
                    }
                    acc += sweep
                }
            }
        },
    ) {
        val stroke = size.minDimension * 0.20f
        val inset = stroke / 2f + 2f
        val arcSize = Size(size.width - inset * 2, size.height - inset * 2)
        var start = -90f
        for (s in slices) {
            val sweep = 360f * s.secs / total.coerceAtLeast(1)
            val on = picked == null || picked == s.key
            drawArc(
                color = if (on) colorOf(s.key) else colorOf(s.key).copy(alpha = 0.22f),
                startAngle = start,
                sweepAngle = if (slices.size > 1) (sweep - 1.2f).coerceAtLeast(0.6f) else sweep,
                useCenter = false,
                topLeft = Offset(inset, inset),
                size = arcSize,
                style = Stroke(width = if (picked == s.key) stroke else stroke * 0.86f),
            )
            start += sweep
        }
        // 中心留白：甜甜圈中间是"洞"，不画任何东西
        drawCircle(color = cs.surface, radius = size.minDimension / 2f - stroke - 3f)
    }
}

/**
 * 当日 24 小时竖轨。
 *
 * 一块 = 一段连续使用：位置是开始时刻，高度是用了多久。
 * 这比列表快得多——是清晨还是深夜、一段是长是短，一眼就出来。
 */
@Composable
private fun DayTimeline(
    day: CalDay,
    colorOf: (String) -> Color,
    picked: String?,
    onPick: (String) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().height(320.dp)) {
        // 左侧刻度：0 / 6 / 12 / 18 / 24 点
        Column(
            Modifier.width(26.dp).fillMaxHeight(),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            listOf(0, 6, 12, 18).forEach {
                Text("%02d".format(it), fontSize = 8.5.sp, color = cs.onSurfaceVariant)
            }
            Text("", fontSize = 8.5.sp)
        }
        Box(Modifier.weight(1f).fillMaxHeight()) {
            Canvas(
                Modifier
                    .fillMaxSize()
                    .pointerInput(day, picked) {
                        detectTapGestures { p ->
                            val minute = (p.y / size.height * 1440f).toInt()
                            val hit = day.items.firstOrNull { item ->
                                item.spans.any { minute >= it.f && minute < it.t }
                            }
                            if (hit != null) onPick(hit.key)
                        }
                    },
            ) {
                drawRoundRect(
                    color = cs.surfaceVariant,
                    cornerRadius = CornerRadius(6f, 6f),
                )
                for (h in 0..24) {
                    val y = size.height * h / 24f
                    drawLine(
                        color = cs.outlineVariant.copy(alpha = if (h % 6 == 0) 0.5f else 0.18f),
                        start = Offset(0f, y),
                        end = Offset(size.width, y),
                        strokeWidth = if (h % 6 == 0) 1f else 0.6f,
                    )
                }
                // 短段后画：长段先铺底，短段不会被盖住
                for (item in day.items.sortedByDescending { it.secs }) {
                    val on = picked == null || picked == item.key
                    val c = colorOf(item.key)
                    for (sp in item.spans) {
                        val y = size.height * sp.f / 1440f
                        val h = (size.height * (sp.t - sp.f) / 1440f).coerceAtLeast(2.2f)
                        drawRoundRect(
                            color = if (on) c else c.copy(alpha = 0.25f),
                            topLeft = Offset(1f, y),
                            size = Size(size.width - 2f, h),
                            cornerRadius = CornerRadius(3f, 3f),
                        )
                    }
                }
            }
            if (day.secs <= 0) {
                Text(
                    "这一天没有记录",
                    fontSize = 11.sp,
                    color = cs.onSurfaceVariant,
                    modifier = Modifier.align(Alignment.Center),
                )
            }
        }
    }
    Spacer(Modifier.height(6.dp))
    Text(
        "共 " + fmtDuration(day.secs) + "，点色块看是哪一项",
        fontSize = 10.sp,
        color = cs.onSurfaceVariant,
    )
}

/** 周视图：7 列，每列一条 24 小时竖轨（与桌面 `calWeekHtml` 同构） */
@Composable
private fun WeekCalendar(
    window: Pair<LocalDate, LocalDate>,
    days: List<Pair<LocalDate, CalDay>>,
    today: LocalDate,
    picked: String?,
    colorOf: (String) -> Color,
    onOpenDay: (LocalDate) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    val byDate = days.associate { it.first to it.second }
    val seq = (0..6).map { window.first.plusDays(it.toLong()) }
    Row(Modifier.fillMaxWidth().height(210.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        seq.forEach { d ->
            val day = byDate[d] ?: CalDay(d, 0, emptyList())
            val isToday = d == today
            Column(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clickable { onOpenDay(d) },
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    WEEKDAYS[d.dayOfWeek.value - 1].removePrefix("周"),
                    fontSize = 9.sp,
                    color = if (isToday) cs.primary else cs.onSurfaceVariant,
                    fontWeight = if (isToday) FontWeight.SemiBold else FontWeight.Normal,
                )
                Text("${d.dayOfMonth}", fontSize = 10.sp, color = cs.onSurface)
                Spacer(Modifier.height(3.dp))
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    Canvas(Modifier.fillMaxSize()) {
                        drawRoundRect(
                            color = cs.surfaceVariant,
                            cornerRadius = CornerRadius(4f, 4f),
                        )
                        for (item in day.items.sortedByDescending { it.secs }) {
                            val on = picked == null || picked == item.key
                            val c = colorOf(item.key)
                            for (sp in item.spans) {
                                val y = size.height * sp.f / 1440f
                                val h = (size.height * (sp.t - sp.f) / 1440f).coerceAtLeast(1.6f)
                                drawRect(
                                    color = if (on) c else c.copy(alpha = 0.25f),
                                    topLeft = Offset(0f, y),
                                    size = Size(size.width, h),
                                )
                            }
                        }
                    }
                }
                Spacer(Modifier.height(3.dp))
                Text(
                    if (day.secs > 0) fmtShort(day.secs) else "",
                    fontSize = 8.sp,
                    color = cs.onSurfaceVariant,
                )
            }
        }
    }
    Spacer(Modifier.height(6.dp))
    Text("点某一列看那一天", fontSize = 10.sp, color = cs.onSurfaceVariant)
}

/** 月视图：7 列网格，每格一条横的 24 小时条（与桌面 `calMonthHtml` 同构） */
@Composable
private fun MonthCalendar(
    month: LocalDate,
    window: Pair<LocalDate, LocalDate>,
    days: List<Pair<LocalDate, CalDay>>,
    today: LocalDate,
    colorOf: (String) -> Color,
    onOpenDay: (LocalDate) -> Unit,
) {
    val cs = MaterialTheme.colorScheme
    val byDate = days.associate { it.first to it.second }
    val base = month.withDayOfMonth(1)

    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        WEEKDAYS.forEach {
            Text(
                it.removePrefix("周"),
                fontSize = 9.sp,
                color = cs.onSurfaceVariant,
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.Center,
            )
        }
    }
    Spacer(Modifier.height(3.dp))

    val seq = ArrayList<LocalDate>()
    var d = window.first
    while (d <= window.second) {
        seq.add(d)
        d = d.plusDays(1)
    }
    seq.chunked(7).forEach { row ->
        Row(
            Modifier.fillMaxWidth().padding(vertical = 1.dp),
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            row.forEach { date ->
                val day = byDate[date] ?: CalDay(date, 0, emptyList())
                val inMonth = date.monthValue == base.monthValue
                val isToday = date == today
                Column(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(4.dp))
                        .background(if (isToday) cs.primary.copy(alpha = 0.10f) else Color.Transparent)
                        .clickable { onOpenDay(date) }
                        .padding(vertical = 3.dp, horizontal = 2.dp),
                ) {
                    Text(
                        "${date.dayOfMonth}",
                        fontSize = 9.5.sp,
                        color = when {
                            isToday -> cs.primary
                            inMonth -> cs.onSurface
                            else -> cs.onSurfaceVariant.copy(alpha = 0.45f)
                        },
                        fontWeight = if (isToday) FontWeight.SemiBold else FontWeight.Normal,
                    )
                    Text(
                        if (day.secs > 0) fmtShort(day.secs) else " ",
                        fontSize = 7.5.sp,
                        color = cs.onSurfaceVariant.copy(alpha = if (inMonth) 1f else 0.5f),
                        maxLines = 1,
                    )
                    Spacer(Modifier.height(2.dp))
                    Canvas(Modifier.fillMaxWidth().height(3.dp)) {
                        drawRoundRect(
                            color = cs.surfaceVariant,
                            cornerRadius = CornerRadius(2f, 2f),
                        )
                        for (item in day.items.sortedByDescending { it.secs }) {
                            val c = colorOf(item.key)
                            for (sp in item.spans) {
                                val x = size.width * sp.f / 1440f
                                val w = (size.width * (sp.t - sp.f) / 1440f).coerceAtLeast(0.8f)
                                drawRect(
                                    color = if (inMonth) c else c.copy(alpha = 0.35f),
                                    topLeft = Offset(x, 0f),
                                    size = Size(min(w, size.width - x), size.height),
                                )
                            }
                        }
                    }
                }
            }
            // 最后一行不满时补占位，格子不会被拉宽
            repeat(7 - row.size) { Spacer(Modifier.weight(1f)) }
        }
    }
    Spacer(Modifier.height(6.dp))
    Text("点某一天看当日时间轴", fontSize = 10.sp, color = cs.onSurfaceVariant)
}

/**
 * 明细一行：色点 · 名称 · 时长 · 占比 + 占比条；点开看连续使用段。
 *
 * 桌面端的明细是"饼图旁的点选面板"；手机上放不下，
 * 索性把三件事（比例、时长、时段）压进同一行，点开就地展开。
 */
@Composable
private fun DetailRow(
    slice: Slice,
    total: Int,
    color: Color,
    expanded: Boolean,
    onClick: () -> Unit,
    spans: List<Pair<LocalDate, Span>>,
) {
    val cs = MaterialTheme.colorScheme
    val share = if (total > 0) slice.secs.toFloat() / total else 0f
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Dot(color)
            Text(
                slice.label,
                fontSize = 12.5.sp,
                fontWeight = if (expanded) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Text(fmtDuration(slice.secs), fontSize = 12.sp, color = cs.onSurface)
            Text(
                "  " + pct(slice.secs, total) + "%",
                fontSize = 10.5.sp,
                color = cs.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(4.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .height(4.dp)
                .background(cs.surfaceVariant, RoundedCornerShape(2.dp)),
        ) {
            Box(
                Modifier
                    .fillMaxWidth(share.coerceIn(0.005f, 1f))
                    .fillMaxHeight()
                    .background(color, RoundedCornerShape(2.dp)),
            )
        }
        if (expanded) {
            if (spans.isEmpty()) {
                Text(
                    "没有分段明细（这一段数据是分轨之前记的，只有小时桶）",
                    fontSize = 10.5.sp,
                    color = cs.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
            } else {
                Text(
                    "共 ${spans.size} 段，合计约 " + fmtDuration(spans.sumOf { it.second.mins } * 60),
                    fontSize = 10.5.sp,
                    color = cs.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
                spans.take(40).forEach { (d, s) ->
                    Row(Modifier.fillMaxWidth().padding(top = 2.dp)) {
                        Text(
                            d.format(DateTimeFormatter.ofPattern("MM-dd")),
                            fontSize = 10.5.sp,
                            color = cs.onSurfaceVariant,
                            modifier = Modifier.width(42.dp),
                        )
                        Text(StatsMath.fmtSpan(s), fontSize = 10.5.sp, color = cs.onSurface)
                        Spacer(Modifier.weight(1f))
                        Text("${s.mins} 分", fontSize = 10.5.sp, color = cs.onSurfaceVariant)
                    }
                }
                if (spans.size > 40) {
                    Text(
                        "…… 其余 ${spans.size - 40} 段未列出",
                        fontSize = 10.sp,
                        color = cs.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

/** 小格子里的时长：80 秒 → `1分`，5400 秒 → `1.5时` */
private fun fmtShort(sec: Int): String {
    if (sec <= 0) return ""
    if (sec < 60) return "${sec}秒"
    val m = sec / 60
    if (m < 60) return "${m}分"
    val h = m / 60f
    return if (h >= 10) "${h.toInt()}时" else String.format("%.1f时", h)
}
