package com.qqqorange.kingoffocus.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import androidx.compose.foundation.background
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
import com.qqqorange.kingoffocus.core.StatsMath
import com.qqqorange.kingoffocus.core.StatsStore
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.loadLaunchableApps
import com.qqqorange.kingoffocus.toast
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * 统计与报告。
 *
 * 数据来自守护服务的采样（[StatsStore]），这里只做展示：
 * 今天的分时柱状、应用排行、最近 7 天趋势，以及一段可以复制/分享的周报。
 */
@Composable
fun StatsScreen(cfg: Config) {
    val ctx = LocalContext.current
    var bump by remember { mutableStateOf(0) }
    val now = LocalDateTime.now()
    val today = remember(bump) { StatsStore.today(now) }
    val week = remember(bump) { StatsStore.recent(7, now) }

    val hourly = remember(today) { StatsMath.hourly(today) }
    val total = remember(today) { StatsMath.total(today) }
    val peak = remember(hourly) { StatsMath.peak(hourly) }
    val top = remember(today) { StatsMath.top(today, 6) }
    val labels = remember { loadLaunchableApps(ctx).associate { it.pkg to it.label } }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PageHeader("使用统计", "只统计你在用的时间，离开手机不计入")

        Panel {
            Row(Modifier.fillMaxWidth()) {
                KV("今日", StatsMath.fmtDuration(total), MaterialTheme.colorScheme.secondary)
                KV("最长一天", StatsMath.fmtDuration(week.maxOfOrNull { StatsMath.total(it.second) } ?: 0))
                KV("7 天合计", StatsMath.fmtDuration(week.sumOf { StatsMath.total(it.second) }))
            }
        }

        SectionTitle("今天的分时")
        Panel {
            if (total == 0) {
                EmptyHint(
                    if (!cfg.stats.enabled) "统计已关闭，去「设置 → 统计」打开"
                    else "还没有今天的数据。开着自律服务正常用手机，几分钟后这里就有内容。",
                )
            } else {
                Row(
                    Modifier.fillMaxWidth().height(110.dp),
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    hourly.forEachIndexed { h, sec ->
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

        SectionTitle("今天用得最多")
        Panel {
            if (top.isEmpty()) {
                EmptyHint("今天还没有记录")
            } else {
                top.forEach { (pkg, sec) ->
                    val frac = if (total > 0) sec.toFloat() / total else 0f
                    Column(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(
                                labels[pkg] ?: pkg,
                                fontSize = 12.5.sp,
                                maxLines = 1,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            Text(
                                StatsMath.fmtDuration(sec),
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
                    }
                }
            }
        }

        SectionTitle("最近 7 天")
        Panel {
            val max = week.maxOfOrNull { StatsMath.total(it.second) } ?: 0
            Row(
                Modifier.fillMaxWidth().height(84.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                week.forEach { (d, apps) ->
                    val sec = StatsMath.total(apps)
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
                            fontSize = 8.5.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        SectionTitle("本周报告")
        Panel {
            val text = remember(bump, cfg.rules.size, cfg.points) {
                Report.build(now, week, cfg.rules.size, cfg.points) { pkg -> labels[pkg] ?: pkg }
            }
            Text(text, fontSize = 11.5.sp, lineHeight = 18.sp, color = MaterialTheme.colorScheme.onSurface)
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = {
                    val cm = ctx.getSystemService(ClipboardManager::class.java)
                    cm?.setPrimaryClip(ClipData.newPlainText("King Of Focus 周报", text))
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
