package com.qqqorange.kingoffocus.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.core.Report
import com.qqqorange.kingoffocus.core.Span
import com.qqqorange.kingoffocus.core.StatsMath
import com.qqqorange.kingoffocus.core.StatsStore
import com.qqqorange.kingoffocus.core.fmtDuration
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.loadLaunchableApps
import com.qqqorange.kingoffocus.toast
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters

/**
 * 使用统计。
 *
 * 页面结构与桌面端「统计」一致，只是把三个 tab 放成了手机上的胶囊：
 *
 * | tab | 含义 |
 * |---|---|
 * | 自律时段内 | 规则生效 / 时段专注 / 锁机 期间的前台使用 |
 * | 时段外 | 其余时间 |
 * | 汇总 | 两轨直接相加，不做加权 |
 *
 * 口径（与 `src-tauri/src/stats.rs` 同义）：只算"你在用"的时间——
 * 熄屏、锁屏、停在桌面都不计；每一次结算按真实经过的秒数记账。
 *
 * 「明细」用连续使用段回答"几点到几点在用它"：小时桶能说"这小时用了多久"，
 * 说不出先后，这也是桌面端加 `spans` 的原因。
 */
@Composable
fun StatsScreen(cfg: Config) {
    val ctx = LocalContext.current
    var bump by remember { mutableStateOf(0) }
    val now = LocalDateTime.now()

    // tab：true = 自律生效中，false = 时段外，null = 汇总（与桌面 statsTab 三档同义）
    var tab by remember { mutableStateOf<Boolean?>(null) }
    // 范围：今日 / 本周 / 本月（桌面还有今年与自定义，手机上先给三个常用的）
    var range by remember { mutableStateOf(1) }
    var openKey by remember { mutableStateOf<String?>(null) }

    val days = remember(bump, range) {
        when (range) {
            1 -> StatsStore.recent(7, now)
            2 -> {
                val end = now.toLocalDate()
                StatsStore.range(end.withDayOfMonth(1), end)
            }
            else -> StatsStore.range(monthStart(now.toLocalDate(), 2), now.toLocalDate())
        }
    }
    val today = remember(bump) { StatsStore.today(now) }

    val tracks = listOf<Boolean?>(true, false, null)
    val trackNames = listOf("自律时段内", "时段外", "汇总")
    val rangeNames = listOf("近 7 天", "本月", "近 60 天")

    // 分时、排行、合计都跟着所选范围走（桌面端 `stats_hourly` 也是按范围算的）；
    // "今天"只作为第一格数字单独显示，方便一眼看当前进度
    val hourlyRange = remember(days, tab) { StatsMath.hourly(days, tab) }
    val todayTotal = remember(today, tab) { StatsMath.total(today, tab) }
    val peak = remember(hourlyRange) { StatsMath.peak(hourlyRange) }
    val rangeTotal = remember(days, tab) { StatsMath.total(days, tab) }
    val top = remember(days, tab) { StatsMath.top(days, tab, 8) }
    val labels = remember { loadLaunchableApps(ctx).associate { it.pkg to it.label } }
    fun labelOf(pkg: String) = labels[pkg] ?: pkg.ifBlank { "未知应用" }

    // 双轨各自多少：一句话说清"自律时段里占了多少"
    val onSecs = remember(days) { StatsMath.total(days, true) }
    val offSecs = remember(days) { StatsMath.total(days, false) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PageHeader("使用统计", "只算你在用的时间：熄屏、锁屏、停在桌面都不计")

        // —— 双轨切换 ——
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            tracks.forEachIndexed { i, t ->
                val on = tab == t
                Box(
                    Modifier
                        .weight(1f)
                        .background(
                            if (on) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.surfaceVariant,
                            RoundedCornerShape(999.dp),
                        )
                        .clickable { tab = t }
                        .padding(vertical = 7.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        trackNames[i],
                        fontSize = 11.5.sp,
                        color = if (on) MaterialTheme.colorScheme.onPrimary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        // —— 范围 ——
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            rangeNames.forEachIndexed { i, name ->
                val on = range == i + 1
                Box(
                    Modifier
                        .background(
                            if (on) MaterialTheme.colorScheme.secondary.copy(alpha = 0.18f)
                            else MaterialTheme.colorScheme.surfaceVariant,
                            RoundedCornerShape(999.dp),
                        )
                        .clickable { range = i + 1 }
                        .padding(horizontal = 12.dp, vertical = 5.dp),
                ) {
                    Text(
                        name,
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                    )
                }
            }
        }

        // —— 数字 ——
        Panel {
            Row(Modifier.fillMaxWidth()) {
                KV("今天", fmtDuration(todayTotal), MaterialTheme.colorScheme.secondary)
                KV("所选范围", fmtDuration(rangeTotal))
                KV("日均", fmtDuration(rangeTotal / days.size.coerceAtLeast(1)))
            }
            if (onSecs + offSecs > 0) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "自律时段内 " + fmtDuration(onSecs) + "（" +
                        (onSecs * 100 / (onSecs + offSecs)) + "%），其余 " + fmtDuration(offSecs),
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // —— 今天的分时 ——
        SectionTitle("分时 · " + (rangeNames.getOrNull(range - 1) ?: ""))
        Panel {
            if (rangeTotal == 0) {
                EmptyHint(
                    if (!cfg.stats.enabled) "统计已关闭，去「设置 → 使用统计」打开"
                    else "还没有这一档的数据。换一个 tab 看看，或者正常用一会儿手机。",
                )
            } else {
                Row(
                    Modifier.fillMaxWidth().height(110.dp),
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    hourlyRange.forEach { sec ->
                        val frac = if (peak > 0) sec.toFloat() / peak else 0f
                        Box(
                            Modifier
                                .weight(1f)
                                .fillMaxHeight(if (frac < 0.02f) 0.02f else frac)
                                .background(
                                    if (sec > 0) MaterialTheme.colorScheme.primary.copy(alpha = 0.85f)
                                    else MaterialTheme.colorScheme.surfaceVariant,
                                    RoundedCornerShape(3.dp),
                                ),
                        )
                    }
                }
                Spacer(Modifier.height(5.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    listOf("0", "6", "12", "18", "23").forEach {
                        Text(it, fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }

        // —— 排行（点开看连续使用段） ——
        SectionTitle("用得最多 · " + (rangeNames.getOrNull(range - 1) ?: ""))
        Panel {
            if (top.isEmpty()) {
                EmptyHint("这个范围里还没有记录")
            } else {
                top.forEach { (pkg, sec) ->
                    val frac = if (rangeTotal > 0) sec.toFloat() / rangeTotal else 0f
                    val expanded = openKey == pkg
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable { openKey = if (expanded) null else pkg }
                            .padding(vertical = 5.dp),
                    ) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(
                                labelOf(pkg),
                                fontSize = 12.5.sp,
                                maxLines = 1,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            Text(
                                fmtDuration(sec),
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Spacer(Modifier.height(4.dp))
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .height(5.dp)
                                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(3.dp)),
                        ) {
                            Box(
                                Modifier
                                    .fillMaxWidth(frac.coerceIn(0.01f, 1f))
                                    .fillMaxHeight()
                                    .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(3.dp)),
                            )
                        }
                        if (expanded) {
                            SpanList(pkg, days, labelOf(pkg))
                        }
                    }
                }
            }
        }

        // —— 每天 ——
        SectionTitle("每天")
        Panel {
            val max = days.maxOfOrNull { StatsMath.total(it.second, tab) } ?: 0
            Row(
                Modifier.fillMaxWidth().height(84.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                days.forEach { (d, day) ->
                    val sec = StatsMath.total(day, tab)
                    val frac = if (max > 0) sec.toFloat() / max else 0f
                    Column(
                        Modifier.weight(1f).fillMaxHeight(),
                        verticalArrangement = Arrangement.Bottom,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .fillMaxHeight(if (frac < 0.03f) 0.03f else frac)
                                .background(
                                    if (d == now.toLocalDate()) MaterialTheme.colorScheme.secondary
                                    else MaterialTheme.colorScheme.primary.copy(alpha = 0.55f),
                                    RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp),
                                ),
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            d.format(DateTimeFormatter.ofPattern("MM-dd")).substring(3),
                            fontSize = 8.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        // —— 报告 ——
        SectionTitle("本周报告")
        Panel {
            val text = remember(bump, tab, cfg.rules.size, cfg.points, days.size) {
                Report.build(now, days, tab, cfg.rules.size, cfg.points) { pkg -> labelOf(pkg) }
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

/**
 * 一个应用的连续使用段明细。
 *
 * 为什么值得单独一块：这些段回答的是"我几点到几点在刷它"。
 * 光看总时长会把"一天里翻了 40 次、每次 30 秒"和"一口气看了 20 分钟"
 * 变成同一个数字，而这两种行为对自律的意义完全不同。
 */
@Composable
private fun SpanList(pkg: String, days: List<Pair<LocalDate, com.qqqorange.kingoffocus.core.StatsDay>>, label: String) {
    val spans: List<Pair<LocalDate, Span>> = remember(pkg, days) { StatsStore.spansOf(pkg, days) }
    val cs = MaterialTheme.colorScheme
    if (spans.isEmpty()) {
        Text(
            "没有明细（这一段数据是分轨之前记的，只有小时桶）",
            fontSize = 10.5.sp,
            color = cs.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp),
        )
        return
    }
    val totalMin = spans.sumOf { it.second.mins }
    Text(
        // 段按分钟取整（与桌面端的 Span 一致），所以合计会略大于秒级总时长 → 写"约"
        "共 ${spans.size} 段，合计约 " + fmtDuration(totalMin * 60),
        fontSize = 10.5.sp,
        color = cs.onSurfaceVariant,
        modifier = Modifier.padding(top = 6.dp),
    )
    // 最多列 40 段：一天切来切去很容易上百段，页面上没人看得了那么多
    spans.take(40).forEach { (d, s) ->
        Row(Modifier.fillMaxWidth().padding(top = 2.dp)) {
            Text(
                d.format(DateTimeFormatter.ofPattern("MM-dd")),
                fontSize = 10.5.sp,
                color = cs.onSurfaceVariant,
                modifier = Modifier.width(48.dp),
            )
            Text(
                StatsMath.fmtSpan(s),
                fontSize = 10.5.sp,
                color = cs.onSurface,
            )
            Spacer(Modifier.weight(1f))
            Text(
                "${s.mins} 分",
                fontSize = 10.5.sp,
                color = cs.onSurfaceVariant,
            )
        }
    }
    if (spans.size > 40) {
        Text("…… 其余 ${spans.size - 40} 段未列出", fontSize = 10.sp, color = cs.onSurfaceVariant)
    }
}

/** 往前数 n 个月的 1 号 */
private fun monthStart(today: LocalDate, back: Int): LocalDate =
    today.with(TemporalAdjusters.firstDayOfMonth()).minusMonths(back.toLong())
