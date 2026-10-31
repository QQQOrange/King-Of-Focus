package com.qqqorange.kingoffocus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.core.ScheduleEngine
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.SchedulePlan
import com.qqqorange.kingoffocus.data.Store
import java.time.LocalDateTime
import java.util.UUID

private val DAY_NAMES = listOf("一", "二", "三", "四", "五", "六", "日")

/**
 * 自律时段：多套方案 + 拖滑多选。
 *
 * 拖滑的实现要点：不能给每个格子单独挂点击——那样拖过去只会命中第一个格子。
 * 这里把整块网格当一个画布，用指针坐标反算 (天, 小时)，按下那一刻决定"这次是选还是取消"，
 * 之后划过的格子全部跟随同一个值。松手才写盘（拖动过程中只改草稿），
 * 否则一次长拖会触发几十次磁盘写入。
 */
@Composable
fun ScheduleScreen(cfg: Config) {
    val plans = cfg.plans.ifEmpty { listOf(SchedulePlan(id = "plan-default", name = "默认方案", days = cfg.days)) }
    val active = plans.firstOrNull { it.id == cfg.activePlan } ?: plans.first()

    var draft by remember(cfg.days) { mutableStateOf(cfg.days) }
    var gridSize by remember { mutableStateOf(IntSize.Zero) }
    var paintTo by remember { mutableStateOf<Boolean?>(null) }

    var renameTarget by remember { mutableStateOf<SchedulePlan?>(null) }
    var renameText by remember { mutableStateOf("") }

    fun commit() {
        Store.update { it.copy(days = draft, defWork = it.defWork, defBrk = it.defBrk) }
    }

    fun applyCell(day: Int, hour: Int, on: Boolean) {
        val rows = draft.map { it.toMutableList() }.toMutableList()
        val old = rows[day][hour]
        rows[day][hour] = if (on) HourPlan(true, cfg.defWork, cfg.defBrk, old.from, old.to) else old.copy(on = false)
        draft = rows
    }

    // 左边那列"一二三…"占掉 18dp，算小时时必须先减掉，否则整块会偏一个多小时
    val labelPx = with(androidx.compose.ui.platform.LocalDensity.current) { 18.dp.toPx() }

    fun cellAt(p: Offset): Pair<Int, Int>? {
        if (gridSize.width <= 0 || gridSize.height <= 0) return null
        val day = (p.y / (gridSize.height / 7f)).toInt().coerceIn(0, 6)
        val usable = (gridSize.width - labelPx).coerceAtLeast(1f)
        val hour = ((p.x - labelPx) / (usable / 24f)).toInt().coerceIn(0, 23)
        return day to hour
    }

    val todayIdx = LocalDateTime.now().dayOfWeek.value - 1
    val selectedToday = draft.getOrNull(todayIdx)?.count { it.on } ?: 0

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PageHeader("自律时段", "按住并拖动可以一次框选多个格子；再划一次就取消")

        // —— 方案 ——
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            plans.forEach { p ->
                val on = p.id == active.id
                Box(
                    Modifier
                        .background(
                            if (on) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.surfaceVariant,
                            RoundedCornerShape(999.dp),
                        )
                        .clickable {
                            if (p.id != active.id) {
                                // 切方案 = 把这套的排班搬到当前的 days 上
                                Store.update {
                                    it.copy(
                                        days = p.days,
                                        defWork = p.defWork,
                                        defBrk = p.defBrk,
                                        activePlan = p.id,
                                    )
                                }
                            }
                        }
                        .padding(horizontal = 14.dp, vertical = 7.dp),
                ) {
                    Text(
                        p.name,
                        fontSize = 12.5.sp,
                        color = if (on) MaterialTheme.colorScheme.onPrimary
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            OutlinedButton(
                onClick = {
                    val id = UUID.randomUUID().toString().take(8)
                    val p = SchedulePlan(
                        id = "plan-$id",
                        name = "方案 ${plans.size + 1}",
                        days = cfg.days,
                        defWork = cfg.defWork,
                        defBrk = cfg.defBrk,
                    )
                    Store.update { it.copy(plans = plans + p, activePlan = p.id) }
                },
                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 4.dp),
            ) { Text("+ 新建", fontSize = 12.sp) }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = {
                renameText = active.name
                renameTarget = active
            }) { Text("重命名", fontSize = 12.sp) }
            TextButton(
                onClick = {
                    if (plans.size <= 1) return@TextButton
                    val rest = plans.filterNot { it.id == active.id }
                    Store.update {
                        it.copy(
                            plans = rest,
                            activePlan = rest.first().id,
                            days = rest.first().days,
                            defWork = rest.first().defWork,
                            defBrk = rest.first().defBrk,
                        )
                    }
                },
            ) { Text("删除这套", fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }
        }

        // —— 网格 ——
        Panel {
            Row(Modifier.fillMaxWidth()) {
                Spacer(Modifier.width(18.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    listOf("0", "6", "12", "18", "23").forEach {
                        Text(it, fontSize = 8.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Spacer(Modifier.height(4.dp))
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(232.dp)
                    .onSizeChanged { gridSize = it }
                    .pointerInput(cfg.activePlan, cfg.defWork, cfg.defBrk) {
                        awaitEachGesture {
                            val down = awaitFirstDown()
                            val cell = cellAt(down.position) ?: return@awaitEachGesture
                            val on = !(draft.getOrNull(cell.first)?.getOrNull(cell.second)?.on ?: false)
                            paintTo = on
                            applyCell(cell.first, cell.second, on)
                            down.consume()

                            var last = cell
                            while (true) {
                                val ev = awaitPointerEvent()
                                val ch = ev.changes.firstOrNull() ?: break
                                if (!ch.pressed) break
                                val c = cellAt(ch.position)
                                if (c != null && c != last) {
                                    last = c
                                    applyCell(c.first, c.second, on)
                                }
                                ch.consume()
                            }
                            paintTo = null
                            // 松手才落盘：拖动过程中一次都不写
                            commit()
                        }
                    },
            ) {
                Column(Modifier.fillMaxSize()) {
                    for (d in 0 until 7) {
                        Row(Modifier.weight(1f).fillMaxWidth()) {
                            Box(Modifier.width(18.dp), contentAlignment = Alignment.Center) {
                                Text(
                                    DAY_NAMES[d],
                                    fontSize = 9.sp,
                                    color = if (d == todayIdx) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Row(Modifier.weight(1f).fillMaxSize()) {
                                for (h in 0 until 24) {
                                    val on = draft.getOrNull(d)?.getOrNull(h)?.on == true
                                    Box(
                                        Modifier
                                            .weight(1f)
                                            .fillMaxSize()
                                            .padding(1.dp)
                                            .background(
                                                if (on) MaterialTheme.colorScheme.primary
                                                else MaterialTheme.colorScheme.surfaceVariant,
                                                RoundedCornerShape(2.5.dp),
                                            ),
                                    )
                                }
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            Text(
                "拖动选择 · 松手保存。今天已选 $selectedToday 小时。",
                fontSize = 10.5.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // —— 番茄参数 ——
        SectionTitle("番茄节奏")
        Panel {
            Stepper("专注", cfg.defWork, 1, 59, " 分钟") { v ->
                Store.update { c -> c.copy(defWork = v, days = applyBulk(c.days) { it.copy(work = v) }) }
            }
            Stepper("休息", cfg.defBrk, 0, 59, " 分钟") { v ->
                Store.update { c -> c.copy(defBrk = v, days = applyBulk(c.days) { it.copy(brk = v) }) }
            }
            Text(
                "改这里会重排整份方案的番茄；只想调某几小时，先选中再改。",
                fontSize = 10.5.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = {
                val rows = draft.mapIndexed { d, row ->
                    if (d != todayIdx) row else row.map { it.copy(on = true, work = cfg.defWork, brk = cfg.defBrk) }
                }
                draft = rows
                commit()
            }) { Text("今天全选", fontSize = 12.sp) }
            OutlinedButton(onClick = {
                val rows = draft.mapIndexed { d, row ->
                    if (d != todayIdx) row else row.map { it.copy(on = false) }
                }
                draft = rows
                commit()
            }) { Text("今天清空", fontSize = 12.sp) }
        }

        // 当前方案概况
        val hours = draft.sumOf { row -> row.count { it.on } }
        Text(
            "这套方案一周共 $hours 小时；当前状态：" +
                (ScheduleEngine.stateAt(cfg, LocalDateTime.now())?.let {
                    if (it.inBreak) "休息中" else "专注中"
                } ?: "未在时段内") +
                if (LockEngine.isLockActive(cfg, LocalDateTime.now())) "（锁机生效）" else "",
            fontSize = 10.5.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(6.dp))
    }

    val target = renameTarget
    if (target != null) {
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text("方案名称") },
            text = {
                OutlinedTextField(
                    value = renameText,
                    onValueChange = { renameText = it },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                Button(onClick = {
                    val name = renameText.trim().ifBlank { "未命名" }
                    Store.update { c ->
                        c.copy(plans = c.plans.map { if (it.id == target.id) it.copy(name = name) else it })
                    }
                    renameTarget = null
                }) { Text("保存") }
            },
            dismissButton = { TextButton(onClick = { renameTarget = null }) { Text("取消") } },
        )
    }
}

/** 批量改番茄参数：只动"已选中"的小时，没选中的保持原样 */
private fun applyBulk(days: List<List<HourPlan>>, f: (HourPlan) -> HourPlan): List<List<HourPlan>> =
    days.map { row -> row.map { p -> if (p.on) f(p) else p } }
