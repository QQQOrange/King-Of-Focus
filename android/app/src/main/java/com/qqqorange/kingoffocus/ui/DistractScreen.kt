package com.qqqorange.kingoffocus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.core.DistractMath
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.DistractItem
import com.qqqorange.kingoffocus.data.DistractStore
import com.qqqorange.kingoffocus.data.LedgerStore
import com.qqqorange.kingoffocus.data.Store
import java.time.LocalDate
import java.time.YearMonth

/**
 * 分心事件页。
 *
 * 结构与桌面端同一套：上面是周/月日历，下面是当天的清单（按时段分组），
 * 最下面是记录按钮与提醒的设置。
 *
 * 手机上为什么还要一个"周视图"：屏幕窄，月历一天只有几毫米，周视图能给出
 * 更清楚的"这一周哪天欠得多"。两者共用同一个选中日。
 */
@Composable
fun DistractScreen(cfg: Config, onBack: () -> Unit) {
    val items by DistractStore.items.collectAsState()
    var day by remember { mutableStateOf(DistractMath.today()) }
    var view by remember { mutableStateOf("month") }
    var month by remember { mutableStateOf(day.take(7)) }
    val scroll = rememberScrollState()

    val monthData = remember(items, month) { DistractMath.monthCounts(items, month) }
    val groups = remember(items, day) { DistractMath.dayGroups(items, day) }
    val dayItems = remember(items, day) { items.filter { it.day == day } }
    val pending = items.count { !it.done }

    Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(horizontal = 14.dp, vertical = 8.dp)) {
        // —— 顶部：返回 + 标题 ——
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text(Loc.t("‹ 返回"), fontSize = 14.sp) }
            Spacer(Modifier.width(2.dp))
            Text(Loc.t("分心事件"), fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.weight(1f))
            if (pending > 0) Pill("待处理 $pending", MaterialTheme.colorScheme.secondary)
        }
        Text(
            Loc.t("专注时冒出的零散想法，先记下来就好。记下这个动作本身就算把它从脑子里搬出来了。"),
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 2.dp, top = 2.dp, bottom = 8.dp),
        )

        // —— 日历 ——
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(
                    onClick = { view = "week" },
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(10.dp),
                ) { Text(if (view == "week") Loc.t("● 周视图") else Loc.t("周视图"), fontSize = 12.sp) }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(
                    onClick = { view = "month" },
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(10.dp),
                ) { Text(if (view == "month") Loc.t("● 月视图") else Loc.t("月视图"), fontSize = 12.sp) }
            }
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = {
                    if (view == "month") {
                        month = YearMonth.parse(month).minusMonths(1).toString()
                    } else {
                        val d = LocalDate.parse(day).minusWeeks(1)
                        day = d.toString(); month = day.take(7)
                    }
                }) { Text("‹", fontSize = 16.sp) }
                Text(
                    if (view == "month") "${month.take(4)} 年 ${month.substring(5).toInt()} 月" else "${day} 那周",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
                TextButton(onClick = {
                    if (view == "month") {
                        month = YearMonth.parse(month).plusMonths(1).toString()
                    } else {
                        val d = LocalDate.parse(day).plusWeeks(1)
                        day = d.toString(); month = day.take(7)
                    }
                }) { Text("›", fontSize = 16.sp) }
                TextButton(onClick = {
                    day = DistractMath.today(); month = day.take(7)
                }) { Text(Loc.t("今天"), fontSize = 12.sp) }
            }
            Spacer(Modifier.height(6.dp))
            if (view == "month") {
                MonthGrid(
                    month = month,
                    counts = monthData,
                    sel = day,
                    today = DistractMath.today(),
                    onPick = { day = it; month = it.take(7) },
                )
            } else {
                WeekRow(
                    day = day,
                    counts = monthData,
                    today = DistractMath.today(),
                    onPick = { day = it; month = it.take(7) },
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(
                Loc.t("点任意一天查看那天的全部记录；绿点表示当天都处理完了。"),
                fontSize = 10.5.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // —— 当天清单 ——
        SectionTitle("$day · 当天清单（${dayItems.size} 条）")
        Panel {
            if (groups.isEmpty()) {
                EmptyHint("这天还没有记录。\n专注时想到什么，在遮罩上点「记一笔」就行。")
            } else {
                groups.forEachIndexed { gi, g ->
                    if (gi > 0) Spacer(Modifier.height(10.dp))
                    // 这一段当时写的目标：让"我要做什么 → 记了什么 → 做成没有"在同一处对得上
                    val gGoal = com.qqqorange.kingoffocus.data.GoalStore.of(g.segStart)
                    if (gGoal.isNotBlank()) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                "目标：$gGoal",
                                fontSize = 10.sp,
                                color = MaterialTheme.colorScheme.primary,
                                maxLines = 1,
                                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            val gState = com.qqqorange.kingoffocus.data.GoalStore.stateOf(g.segStart)
                            if (gState.isNotBlank()) {
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    when (gState) {
                                        "done" -> Loc.t("做完了")
                                        "partial" -> Loc.t("一半")
                                        else -> Loc.t("没做成")
                                    },
                                    fontSize = 9.sp,
                                    color = when (gState) {
                                        "done" -> Color(0xFF3FBF7F)
                                        "missed" -> Color(0xFFE05A5A)
                                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                                    },
                                )
                            }
                        }
                        Spacer(Modifier.height(2.dp))
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(g.label, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.width(8.dp))
                        Box(
                            Modifier.weight(1f).height(1.dp)
                                .background(MaterialTheme.colorScheme.surfaceVariant),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text("${g.items.size} 条", fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    g.items.forEach { row -> ItemRow(row) }
                }
                val doneCount = dayItems.count { it.done }
                if (doneCount > 0) {
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = { DistractStore.clearDone(day) }) {
                        Text("清掉这天的已完成（$doneCount 条）", fontSize = 12.sp)
                    }
                }
            }
        }

        // —— 设置 ——
        SectionTitle(Loc.t("记录按钮与提醒"))
        Panel {
            ToggleRow(
                title = Loc.t("启用分心事件"),
                sub = Loc.t("关掉后遮罩上不出现「记一笔」，也不再提醒（已记的都还在）"),
                checked = cfg.distract.enabled,
                onChange = { v -> Store.update { it.copy(distract = it.distract.copy(enabled = v)) } },
            )
            HLine()
            Text(
                Loc.t("按钮位置（遮罩上的「记一笔」）"),
                fontSize = 12.sp,
                modifier = Modifier.padding(top = 10.dp),
            )
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("tl" to Loc.t("左上"), "tr" to Loc.t("右上"), "bl" to Loc.t("左下"), "br" to Loc.t("右下")).forEach { (v, label) ->
                    val on = cfg.distract.buttonCorner == v
                    Box(
                        Modifier
                            .weight(1f)
                            .background(
                                if (on) MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)
                                else Color.Transparent,
                                RoundedCornerShape(10.dp),
                            )
                            .clickable {
                                Store.update { it.copy(distract = it.distract.copy(buttonCorner = v)) }
                            }
                            .padding(vertical = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            label,
                            fontSize = 12.sp,
                            fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (on) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            HLine()
            Stepper(
                title = Loc.t("重复提醒间隔"),
                value = cfg.distract.remindMinutes,
                min = 0,
                max = 720,
                unit = Loc.t(" 分"),
                step = 30,
                onChange = { v ->
                    Store.update { it.copy(distract = it.distract.copy(remindMinutes = v)) }
                },
            )
            Text(
                if (cfg.distract.remindMinutes == 0) Loc.t("0 = 只在时段结束时提醒一次")
                else "时段结束后每 ${cfg.distract.remindMinutes} 分钟提醒一次未完成项",
                fontSize = 10.5.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Stepper(
                title = Loc.t("最多追"),
                value = cfg.distract.remindMaxDays,
                min = 1,
                max = 30,
                unit = Loc.t(" 天"),
                onChange = { v ->
                    Store.update { it.copy(distract = it.distract.copy(remindMaxDays = v)) }
                },
            )
            Text(
                Loc.t("超过这么多天就不再提醒，避免陈年旧账天天弹"),
                fontSize = 10.5.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // —— 账本：今天被什么打断 ——
        // 与桌面端同一个概念，只是手机端的"拦下"是回桌面 / 盖拦截页。
        SectionTitle(Loc.t("今天被什么打断"))
        Panel {
            val today = DistractMath.today()
            val hits = remember(items) { LedgerStore.day(today, 6) }
            val total = hits.sumOf { it.n }
            if (hits.isEmpty()) {
                Text(
                    Loc.t("今天还没被拦过。要么很自律，要么规则没生效——去总览看看守护状态。"),
                    fontSize = 11.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text(
                    "共 $total 次。次数最多的那一个，就是最值得关掉的那一个。",
                    fontSize = 10.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(6.dp))
                hits.forEach { h ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Pill(if (h.kind == "site") Loc.t("网页") else Loc.t("软件"), MaterialTheme.colorScheme.secondary)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            h.label,
                            fontSize = 12.5.sp,
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        if (h.rule.isNotBlank()) {
                            Text(
                                h.rule,
                                fontSize = 10.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        Text(
                            "${h.n} 次",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

/** 一条记录：方框勾选 + 正文 + 写入时刻 */
@Composable
private fun ItemRow(it: DistractItem) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 7.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(
            Modifier
                .padding(top = 2.dp)
                .size(17.dp)
                .background(
                    if (it.done) Color(0xFF3FBF7F) else Color.Transparent,
                    RoundedCornerShape(5.dp),
                )
                .border(
                    1.dp,
                    if (it.done) Color(0xFF3FBF7F) else MaterialTheme.colorScheme.surfaceVariant,
                    RoundedCornerShape(5.dp),
                )
                .clickable { DistractStore.setDone(it.id, !it.done) },
            contentAlignment = Alignment.Center,
        ) {
            if (it.done) Text("✓", fontSize = 11.sp, color = Color.White)
        }
        Spacer(Modifier.width(9.dp))
        Column(Modifier.weight(1f)) {
            Text(
                it.text,
                fontSize = 13.sp,
                textDecoration = if (it.done) TextDecoration.LineThrough else TextDecoration.None,
                color = if (it.done) MaterialTheme.colorScheme.onSurfaceVariant
                else MaterialTheme.colorScheme.onSurface,
            )
            Spacer(Modifier.height(2.dp))
            Text(
                "${hhmm(it.at)} 写入" + (if (it.segLabel.isBlank()) Loc.t(" · 不在自律时段内") else " · 时段 ${it.segLabel}"),
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(onClick = { DistractStore.delete(it.id) }) {
            Text(Loc.t("删"), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun hhmm(sec: Long): String {
    val t = java.time.Instant.ofEpochSecond(sec).atZone(java.time.ZoneId.systemDefault())
    return "%02d:%02d".format(t.hour, t.minute)
}

@Composable
private fun MonthGrid(
    month: String,
    counts: Map<String, DistractMath.DayCount>,
    sel: String,
    today: String,
    onPick: (String) -> Unit,
) {
    val ym = YearMonth.parse(month)
    val offset = (LocalDate.of(ym.year, ym.monthValue, 1).dayOfWeek.value + 6) % 7
    val days = ym.lengthOfMonth()
    val cells = ArrayList<Pair<Int, String?>>()
    for (i in 0 until offset) cells += 0 to null
    for (d in 1..days) cells += d to "%s-%02d".format(month, d)
    while (cells.size % 7 != 0) cells += 0 to null

    Column {
        Row(Modifier.fillMaxWidth()) {
            listOf(Loc.t("一"), Loc.t("二"), Loc.t("三"), Loc.t("四"), Loc.t("五"), Loc.t("六"), Loc.t("日")).forEach {
                Text(
                    it, fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
        Spacer(Modifier.height(3.dp))
        cells.chunked(7).forEach { row ->
            Row(Modifier.fillMaxWidth()) {
                row.forEach { (d, key) -> DayCell(d, key, counts, sel, today, onPick, Modifier.weight(1f)) }
            }
            Spacer(Modifier.height(4.dp))
        }
    }
}

@Composable
private fun DayCell(
    d: Int,
    key: String?,
    counts: Map<String, DistractMath.DayCount>,
    sel: String,
    today: String,
    onPick: (String) -> Unit,
    modifier: Modifier,
) {
    if (key == null) {
        Box(modifier.height(38.dp))
        return
    }
    val c = counts[key]
    val total = c?.total ?: 0
    val allDone = total > 0 && (c?.done ?: 0) >= total
    val isSel = key == sel
    val isToday = key == today
    Box(
        modifier
            .padding(horizontal = 1.dp)
            .height(38.dp)
            .background(
                if (isSel) MaterialTheme.colorScheme.primary.copy(alpha = 0.14f) else Color.Transparent,
                RoundedCornerShape(8.dp),
            )
            .clickable { onPick(key) },
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                "$d",
                fontSize = 11.5.sp,
                fontWeight = if (isToday || isSel) FontWeight.SemiBold else FontWeight.Normal,
                color = if (isToday) MaterialTheme.colorScheme.primary
                else if (isSel) MaterialTheme.colorScheme.onSurface
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (total > 0) {
                Spacer(Modifier.height(2.dp))
                Box(
                    Modifier.size(4.dp).background(
                        if (allDone) Color(0xFF3FBF7F) else MaterialTheme.colorScheme.primary,
                        CircleShape,
                    ),
                )
            }
        }
    }
}

@Composable
private fun WeekRow(
    day: String,
    counts: Map<String, DistractMath.DayCount>,
    today: String,
    onPick: (String) -> Unit,
) {
    val base = LocalDate.parse(day)
    val monday = base.minusDays(((base.dayOfWeek.value + 6) % 7).toLong())
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf(Loc.t("一"), Loc.t("二"), Loc.t("三"), Loc.t("四"), Loc.t("五"), Loc.t("六"), Loc.t("日")).forEachIndexed { i, w ->
            val d = monday.plusDays(i.toLong())
            val key = d.toString()
            val c = counts[key]
            val total = c?.total ?: 0
            val done = c?.done ?: 0
            val isSel = key == day
            Column(
                Modifier
                    .weight(1f)
                    .background(
                        if (isSel) MaterialTheme.colorScheme.primary.copy(alpha = 0.14f) else Color.Transparent,
                        RoundedCornerShape(10.dp),
                    )
                    .clickable { onPick(key) }
                    .padding(vertical = 7.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("周$w", fontSize = 9.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    "${d.dayOfMonth}",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (key == today) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    if (total == 0) "—" else "$done/$total",
                    fontSize = 9.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
