package com.qqqorange.kingoffocus.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.core.ScheduleEngine
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.SchedulePlan
import com.qqqorange.kingoffocus.data.ScheduleRules
import com.qqqorange.kingoffocus.data.Slots
import com.qqqorange.kingoffocus.data.Store
import java.time.LocalDateTime
import java.util.UUID
import kotlinx.coroutines.flow.first

/** 星期表头（横轴）；索引 = 周一 .. 周日 */
private val DAY_NAMES = listOf("一", "二", "三", "四", "五", "六", "日")

/** 左侧时间轴宽度：刚好放得下 "23:00" */
private val AXIS_W = 42.dp

/** 网格可视区高度：约 9 小时，其余靠滚动 */
private val GRID_H = 420.dp

/**
 * 自律时段：多套方案 + 十分钟/十五分钟刻度 + 拖滑多选。
 *
 * ## 坐标方向
 *
 * **时间是纵轴、星期是横轴**：时间从上往下走，7 天从左往右排。
 * 和课程表、日历一致——一天有 24 小时，纵向排得下；横向只放 7 列，
 * 每列都点得准。反过来（7 行 × 24 列）一格只有几毫米宽，根本点不住。
 *
 * ## 拖滑为什么不能一格一个点击
 *
 * 给每个格子单独挂点击，拖过去只会命中按下那一个。所以整块网格当成一个画布：
 * 用指针坐标反算 (星期, 格号)，按下那一刻决定"这次是选还是取消"，
 * 之后划过的格子跟随同一个值。松手才写盘——否则一次长拖会触发几十次磁盘写入。
 *
 * ## 滚动与涂抹的冲突
 *
 * 竖着拖 = 涂抹（这个页面最常用的动作），所以格子区域吃掉手势；
 * 想上下滚动就在**左侧时间刻度条**上滑——那里不接涂抹，交给滚动容器。
 */
@Composable
fun ScheduleScreen(cfg: Config) {
    val step = Slots.stepOf(cfg.granularity)
    val rows = Slots.slotsPerDay(step)
    // 一格多高：一小时固定占 44dp（15 分钟 4 格）或 48dp（10 分钟 6 格），
    // 两种刻度下"一小时"看着一样长，切换不会让整块高度乱跳
    val rowH = if (step == 15) 11.dp else 8.dp
    val hourH = rowH * (60 / step)

    val plans = cfg.plans.ifEmpty {
        listOf(SchedulePlan(id = "plan-default", name = "默认方案", days = cfg.days))
    }
    val active = plans.firstOrNull { it.id == cfg.activePlan } ?: plans.first()

    // 今天星期几（0 = 周一）。**今天之前的列不许编辑**——点不动，写入也会被拒。
    val todayIdx = LocalDateTime.now().dayOfWeek.value - 1
    val editable = ScheduleRules.editableDays(todayIdx)

    // 草稿用稳定的 state 持有：pointerInput 里捕获的是这个对象。
    // 如果每次 cfg.days 变了就换一个新 state，正在拖的手势会写进旧对象。
    val draftState = remember { mutableStateOf(cfg.days) }
    LaunchedEffect(cfg.days) {
        if (draftState.value != cfg.days) draftState.value = cfg.days
    }

    val vScroll = rememberScrollState()
    var renameTarget by remember { mutableStateOf<SchedulePlan?>(null) }
    var renameText by remember { mutableStateOf("") }
    // 点表头打开的那一天；clearAsk = 正在二次确认"清空哪一天"
    var dayAction by remember { mutableStateOf<Int?>(null) }
    var clearAsk by remember { mutableStateOf<Int?>(null) }

    val density = LocalDensity.current
    val rowPx = with(density) { rowH.toPx() }
    val hourPx = with(density) { hourH.toPx() }

    fun commit() {
        val next = draftState.value
        Store.update { it.copy(days = next) }
    }

    fun planAt(day: Int, hour: Int): HourPlan =
        draftState.value.getOrNull(day)?.getOrNull(hour) ?: HourPlan()

    /** 这一格现在算不算"已选"（半格也算选着，再点一下才是取消） */
    fun isOn(day: Int, slot: Int): Boolean {
        val h = Slots.hourOfSlot(slot, step)
        val off = Slots.offsetOfSlot(slot, step)
        return Slots.covers(planAt(day, h), off)
    }

    fun applySlot(day: Int, slot: Int, on: Boolean) {
        val cur = draftState.value
        val dayPlan = cur.getOrNull(day) ?: return
        // 落盘前再过一次规则：界面已经拦了"点不动"，但写入口不能只靠界面拦
        val painted = ScheduleRules.paint(
            day, todayIdx, dayPlan, slot, step, on, cfg.defWork, cfg.defBrk,
        )
        draftState.value = cur.toMutableList().also { it[day] = painted }
    }

    // 开局滚到 06:00 附近：凌晨那段绝大多数人是空的，先看有用的部分
    LaunchedEffect(step) {
        val target = (6 * hourPx).toInt()
        // 等第一次布局完成——maxValue 还是 0 时 scrollTo 会被夹回顶部
        snapshotFlow { vScroll.maxValue }.first { it > 0 }
        vScroll.scrollTo(target.coerceIn(0, vScroll.maxValue))
    }

    val nowMinute = LocalDateTime.now().let { it.hour * 60 + it.minute }
    val draft = draftState.value
    val selectedToday = Slots.dayMinutes(draft.getOrNull(todayIdx).orEmpty())

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PageHeader(
            "自律时段",
            "纵向是时间、横向是星期；在格子上拖动即框选，在左侧刻度条上滑动可滚动",
        )

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
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
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

        // —— 刻度 ——
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("刻度", fontSize = 14.sp)
                    Text(
                        "一格代表多久。只是画得细，已经排好的时段不会因此失效。",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(15, 10).forEach { v ->
                        val on = step == v
                        Box(
                            Modifier
                                .background(
                                    if (on) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.surfaceVariant,
                                    RoundedCornerShape(999.dp),
                                )
                                .clickable { if (!on) Store.update { it.copy(granularity = v) } }
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                        ) {
                            Text(
                                "$v 分钟",
                                fontSize = 12.sp,
                                color = if (on) MaterialTheme.colorScheme.onPrimary
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }

        // —— 网格 ——
        val cs = MaterialTheme.colorScheme
        Panel {
            // 表头：星期（横轴）
            Row(Modifier.fillMaxWidth()) {
                Spacer(Modifier.width(AXIS_W))
                for (d in 0 until 7) {
                    Box(
                        Modifier.weight(1f).clickable { dayAction = d },
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                DAY_NAMES[d],
                                fontSize = 11.sp,
                                fontWeight = if (d == todayIdx) FontWeight.SemiBold else FontWeight.Normal,
                                color = when {
                                    d == todayIdx -> cs.primary
                                    !editable[d] -> cs.onSurfaceVariant.copy(alpha = 0.45f)
                                    else -> cs.onSurfaceVariant
                                },
                            )
                            if (!editable[d]) {
                                Text(
                                    "锁",
                                    fontSize = 7.sp,
                                    color = cs.onSurfaceVariant.copy(alpha = 0.55f),
                                )
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(4.dp))

            Box(Modifier.fillMaxWidth().height(GRID_H)) {
                Row(Modifier.fillMaxWidth().verticalScroll(vScroll)) {
                    // 时间轴（纵轴）：自己不吃手势，在这里滑就是滚动
                    Column(Modifier.width(AXIS_W)) {
                        for (h in 0 until 24) {
                            Box(
                                Modifier.fillMaxWidth().height(hourH),
                                contentAlignment = Alignment.TopStart,
                            ) {
                                Text(
                                    "%02d:00".format(h),
                                    fontSize = 8.5.sp,
                                    color = cs.onSurfaceVariant,
                                    modifier = Modifier.padding(top = 1.dp, start = 1.dp),
                                )
                            }
                        }
                    }
                    // 格子区：整块一个画布，手势在这里涂抹
                    Canvas(
                        Modifier
                            .weight(1f)
                            .height(rowH * rows)
                            .pointerInput(step, cfg.defWork, cfg.defBrk) {
                                awaitEachGesture {
                                    val w = size.width.toFloat()
                                    val hPx = size.height.toFloat()
                                    if (w <= 0f || hPx <= 0f) return@awaitEachGesture

                                    fun cellAt(p: Offset): Pair<Int, Int> {
                                        val day = (p.x / (w / 7f)).toInt().coerceIn(0, 6)
                                        val slot = (p.y / rowPx).toInt().coerceIn(0, rows - 1)
                                        return day to slot
                                    }

                                    val down = awaitFirstDown(requireUnconsumed = false)
                                    val first = cellAt(down.position)
                                    // 已经过去的星期是锁的：不涂、不吃手势（交还给滚动），
                                    // 想改就等下周——点表头会说明原因
                                    if (!editable[first.first]) return@awaitEachGesture
                                    val on = !isOn(first.first, first.second)
                                    applySlot(first.first, first.second, on)
                                    down.consume()

                                    var lastDay = first.first
                                    var lastSlot = first.second
                                    while (true) {
                                        val ev = awaitPointerEvent()
                                        val ch = ev.changes.firstOrNull() ?: break
                                        if (!ch.pressed) break
                                        val (d, s) = cellAt(ch.position)
                                        if (d != lastDay || s != lastSlot) {
                                            // 拖得快会跳过中间几格：同一列就把中间补齐，
                                            // 否则 6:00 拉到 18:00 会变成一串断点
                                            if (d == lastDay) {
                                                for (k in minOf(lastSlot, s)..maxOf(lastSlot, s)) {
                                                    applySlot(d, k, on)
                                                }
                                            } else {
                                                applySlot(d, s, on)
                                            }
                                            lastDay = d
                                            lastSlot = s
                                        }
                                        ch.consume()
                                    }
                                    // 松手才落盘：拖动过程中一次都不写
                                    commit()
                                }
                            },
                    ) {
                        val cellsW = size.width
                        val colW = cellsW / 7f
                        val gap = 1.dp.toPx()
                        val grid = draftState.value

                        // 1) 底轨：每一天一条淡淡的竖带，没有它空白一片看不出格子
                        for (d in 0 until 7) {
                            drawRect(
                                color = if (d == todayIdx) cs.primary.copy(alpha = 0.07f)
                                else cs.surfaceVariant.copy(alpha = 0.75f),
                                topLeft = Offset(d * colW + gap, 0f),
                                size = Size(colW - gap * 2, size.height),
                            )
                        }

                        // 2) 已选：一格一格画。半格（旧边界跨在格子中间）画浅一点，
                        //    而不是四舍五入——那等于偷偷改用户的时段
                        for (d in 0 until 7) {
                            val row = grid.getOrNull(d).orEmpty()
                            for (slot in 0 until rows) {
                                val h = Slots.hourOfSlot(slot, step)
                                val off = Slots.offsetOfSlot(slot, step)
                                val p = row.getOrNull(h) ?: continue
                                val hit = Slots.windowsOf(p).sumOf {
                                    maxOf(0, minOf(it.to, off + step) - maxOf(it.from, off))
                                }
                                if (hit <= 0) continue
                                drawRect(
                                    color = cs.primary.copy(alpha = if (hit >= step) 1f else 0.45f),
                                    topLeft = Offset(d * colW + gap, slot * rowPx),
                                    size = Size(colW - gap * 2, rowPx - gap * 0.5f),
                                )
                            }
                        }

                        // 3) 小时线与星期分隔线
                        for (h in 0..24) {
                            val y = h * hourPx
                            if (y > size.height) break
                            drawLine(
                                color = cs.outlineVariant.copy(alpha = if (h % 6 == 0) 0.55f else 0.25f),
                                start = Offset(0f, y),
                                end = Offset(size.width, y),
                                strokeWidth = if (h % 6 == 0) 1f else 0.6f,
                            )
                        }
                        for (d in 0..7) {
                            val x = d * colW
                            drawLine(
                                color = cs.outlineVariant.copy(alpha = 0.18f),
                                start = Offset(x, 0f),
                                end = Offset(x, size.height),
                                strokeWidth = 0.6f,
                            )
                        }

                        // 4) 锁住的列（今天之前）：盖一层底色，看起来就是"动不了"
                        for (d in 0 until 7) {
                            if (editable[d]) continue
                            drawRect(
                                color = cs.background.copy(alpha = 0.62f),
                                topLeft = Offset(d * colW, 0f),
                                size = Size(colW, size.height),
                            )
                        }

                        // 5) 现在几点：今天那一列里的一条横线
                        val yNow = nowMinute * rowPx / step
                        if (yNow <= size.height) {
                            drawLine(
                                color = cs.primary.copy(alpha = 0.85f),
                                start = Offset(todayIdx * colW, yNow),
                                end = Offset((todayIdx + 1) * colW, yNow),
                                strokeWidth = 1.6f,
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.height(8.dp))
            Text(
                "一格 = $step 分钟。今天已选 " + Slots.fmtMinutes(selectedToday) +
                    "；浅色格表示旧边界跨在格子中间，重涂一下就会对齐。" +
                    "灰色的星期已经过去，点表头可以看原因或清空那一天。",
                fontSize = 10.5.sp,
                color = cs.onSurfaceVariant,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = {
                val rows2 = draftState.value.toMutableList()
                rows2[todayIdx] = Slots.paintDay(rows2[todayIdx], true, cfg.defWork, cfg.defBrk)
                draftState.value = rows2
                commit()
            }) { Text("今天全选", fontSize = 12.sp) }
            OutlinedButton(onClick = { clearAsk = todayIdx }) {
                Text("今天清空", fontSize = 12.sp)
            }
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
                "改这里会重排整份方案的番茄；只想调某几格，先在网格上选中再改。",
                fontSize = 10.5.sp,
                color = cs.onSurfaceVariant,
            )
        }

        // 当前方案概况
        val totalMinutes = draft.sumOf { Slots.dayMinutes(it) }
        Text(
            "这套方案一周共 " + Slots.fmtMinutes(totalMinutes) + "；当前状态：" +
                (ScheduleEngine.stateAt(cfg, LocalDateTime.now())?.let {
                    if (it.inBreak) "休息中" else "专注中"
                } ?: "未在时段内") +
                if (LockEngine.isLockActive(cfg, LocalDateTime.now())) "（锁机生效）" else "",
            fontSize = 10.5.sp,
            color = cs.onSurfaceVariant,
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

    // —— 每天的操作：点表头打开（全选 / 清空 / 说明为什么锁着） ——
    val act = dayAction
    if (act != null) {
        val name = "周" + DAY_NAMES[act]
        val mins = Slots.dayMinutes(draft.getOrNull(act).orEmpty())
        AlertDialog(
            onDismissRequest = { dayAction = null },
            title = { Text(name) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("已选 " + Slots.fmtMinutes(mins), fontSize = 13.sp)
                    if (!editable[act]) {
                        Text(
                            ScheduleRules.lockReason(name) + "。原有计划照常生效，只是不能再改。",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(
                                onClick = {
                                    val rows = draftState.value.toMutableList()
                                    rows[act] = ScheduleRules.paintAll(
                                        act, todayIdx, rows[act], true, cfg.defWork, cfg.defBrk,
                                    )
                                    draftState.value = rows
                                    commit()
                                    dayAction = null
                                },
                            ) { Text("全选", fontSize = 12.sp) }
                            OutlinedButton(
                                onClick = {
                                    dayAction = null
                                    clearAsk = act
                                },
                            ) {
                                Text("清空这一天", fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { dayAction = null }) { Text("关闭") } },
        )
    }

    // —— 二次确认：清空一整天的计划不是能撤销的操作 ——
    val ask = clearAsk
    if (ask != null) {
        val name = "周" + DAY_NAMES[ask]
        val mins = Slots.dayMinutes(draft.getOrNull(ask).orEmpty())
        AlertDialog(
            onDismissRequest = { clearAsk = null },
            title = { Text("清空$name？") },
            text = {
                Text(
                    "$name 现在的 " + Slots.fmtMinutes(mins) + " 计划会全部移除，这一步不能撤销。",
                    fontSize = 13.sp,
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        val rows = draftState.value.toMutableList()
                        rows[ask] = ScheduleRules.paintAll(
                            ask, todayIdx, rows[ask], false, cfg.defWork, cfg.defBrk,
                        )
                        draftState.value = rows
                        commit()
                        clearAsk = null
                    },
                    colors = androidx.compose.material3.ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                    ),
                ) { Text("清空") }
            },
            dismissButton = { TextButton(onClick = { clearAsk = null }) { Text("取消") } },
        )
    }
}

/** 批量改番茄参数：只动"已选中"的小时，没选中的保持原样 */
private fun applyBulk(days: List<List<HourPlan>>, f: (HourPlan) -> HourPlan): List<List<HourPlan>> =
    days.map { row -> row.map { p -> if (p.on) f(p) else p } }
