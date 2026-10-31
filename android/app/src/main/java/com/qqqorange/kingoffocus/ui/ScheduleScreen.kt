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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
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
import com.qqqorange.kingoffocus.data.defaultDays
import java.time.LocalDateTime
import java.util.UUID
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull

/** 星期表头（横轴）；索引 = 周一 .. 周日 */
private val DAY_NAMES = listOf("一", "二", "三", "四", "五", "六", "日")

/** 左侧时间轴宽度：刚好放得下 "23:00" */
private val AXIS_W = 42.dp

/** 最多几套方案（与桌面端 CC_MAX_PROFILES 一致）：防止误点「新建」堆出上百套 */
private const val MAX_PLANS = 12

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
 * ## 手势：点一下定起点，长按之后才能拖
 *
 * 网格比屏幕高，要滚动就必须能在格子上起手。所以"涂抹"不能抢占普通滑动：
 *
 * | 动作 | 结果 |
 * |---|---|
 * | 点一下 | 切换这一格，并把它记作**拖选起点**（起点会画一圈描边） |
 * | 长按（约 0.5 秒） | 进入拖选状态，伴随一次触感反馈 |
 * | 长按后上下拖 | 从起点到当前格整段框选；反方向拖回去即撤销 |
 * | 直接上下滑 | **一格都不改**，交给页面滚动 |
 *
 * 鼠标与触控走同一条判定：按下 → 等长按超时 → 才进入拖选；
 * 期间指针移动超过 touchSlop 就当作滚动意图直接放弃，绝不"顺手改一笔"。
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
    // "把通用时长套到已选时段"的二次确认（会改到已有计划，不能一点就干）
    var applyAsk by remember { mutableStateOf(false) }

    val density = LocalDensity.current
    // 长按进入拖选时给一次触感：否则用户不知道"现在已经可以拖了"
    val haptic = LocalHapticFeedback.current
    val rowPx = with(density) { rowH.toPx() }
    val hourPx = with(density) { hourH.toPx() }

    /**
     * 现在是不是"专注段生效中，时段只读"。
     *
     * 每次调用都重新算（不缓存），因为页面可能停留很久——用户在看表的时候
     * 专注段开始/结束了，缓存值会让判断反过来。真正的拦截在写入口，不只靠界面灰。
     */
    fun frozenNow(): Boolean = ScheduleEngine.frozen(Store.current, LocalDateTime.now())

    fun commit() {
        val next = draftState.value
        Store.update { it.copy(days = next) }
    }

    /**
     * 这套时段绑定哪些自律规则。
     *
     * 空 = 全部（默认，也是老配置的语义）。非空 = 只让列出的那几条生效，
     * 其余即使开着也不参与拦截。判定在 `GuardEngine.activeRules`，
     * 这里只负责写：**名单存在方案里**，所以换方案就换了管辖范围。
     */
    fun setBound(ids: List<String>) {
        if (frozenNow()) return
        Store.update { c ->
            // 极端情况下 plans 还是空的（老配置刚读进来），先用界面上这套兜住
            val list = c.plans.ifEmpty { listOf(active) }
            c.copy(plans = list.map { if (it.id == active.id) it.copy(bound = ids) else it })
        }
    }

    fun planAt(day: Int, hour: Int): HourPlan =
        draftState.value.getOrNull(day)?.getOrNull(hour) ?: HourPlan()

    /** 这一格现在算不算"已选"（半格也算选着，再点一下才是取消） */
    fun isOn(day: Int, slot: Int): Boolean {
        val h = Slots.hourOfSlot(slot, step)
        val off = Slots.offsetOfSlot(slot, step)
        return Slots.covers(planAt(day, h), off)
    }

    fun applySlot(day: Int, slot: Int, on: Boolean, segId: String = "") {
        if (frozenNow()) return
        val cur = draftState.value
        val dayPlan = cur.getOrNull(day) ?: return
        // 落盘前再过一次规则：界面已经拦了"点不动"，但写入口不能只靠界面拦
        val painted = ScheduleRules.paint(
            day, todayIdx, dayPlan, slot, step, on, cfg.defWork, cfg.defBrk, segId,
        )
        draftState.value = cur.toMutableList().also { it[day] = painted }
    }

    // 拖选的起点与"这次是选中还是取消"。没有起点就没有拖选——
    // 这是关键：以前一按下就涂，于是任何一次想滚动页面的滑动都会改数据。
    var anchor by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    var anchorOn by remember { mutableStateOf(true) }
    var dragging by remember { mutableStateOf(false) }
    // 本次手势共用的段 id（拖动结束清空）
    var dragSeg by remember { mutableStateOf("") }

    /** 这一格现在落在哪一段里（用于"扩展已有段"时沿用 id） */
    fun segIdAt(day: Int, slot: Int): String {
        val lo = slot * step
        return Slots.segIdIn(draftState.value.getOrNull(day).orEmpty(), lo, lo + step)
    }

    /** 点一下：切换这一格，并把它记作"起点"（下一次长按拖选的锚点） */
    fun tapCell(day: Int, slot: Int) {
        if (frozenNow()) return
        val on = !isOn(day, slot)
        // 只有"点中的这一格已经在某段里"才沿用那个 id；否则新建一段。
        // 于是"紧挨着已有段再点一格"会得到两段——和桌面端一致（相邻不等于同一段）。
        val segId = if (on) segIdAt(day, slot) else ""
        applySlot(day, slot, on, segId)
        anchor = day to slot
        anchorOn = on
        dragSeg = segId.ifEmpty { if (on) Slots.newSegId() else "" }
        commit()
    }

    /**
     * 长按进入拖选。
     *
     * **长按本身不改数据**——只把这一格设为起点、把状态切成"拖选"。
     * 以前这里顺手把它涂了一下，结果"手滑长按"就会悄悄删掉一格计划。
     *
     * 涂成"选中"还是"取消"由起点当前的状态决定：
     *   · 长按一个没选的格子 → 拖出来是选中（最常见）；
     *   · 先点一下把它取消（起点变"取消"态），再长按同一个格子 → 拖出来是擦除。
     * 这正好对应"先选中起始时段，再长按拖选"的用法。
     */
    fun beginDrag(day: Int, slot: Int) {
        if (frozenNow()) return
        if (anchor != (day to slot)) {
            anchor = day to slot
            anchorOn = true
        }
        // 一次拖动算一段：整个手势复用同一个 id，否则拖出来的会是十几个小段
        if (dragSeg.isEmpty()) dragSeg = segIdAt(day, slot)
        if (anchorOn && dragSeg.isEmpty()) dragSeg = Slots.newSegId()
        dragging = true
    }

    /** 拖到某格：同一天就按"起点↔当前"整段涂；跨列只涂那一格并把起点挪过去 */
    fun dragTo(day: Int, slot: Int) {
        val a = anchor ?: return
        if (day == a.first) {
            for (k in Slots.dragRange(a.second, slot)) {
                applySlot(day, k, anchorOn, dragSeg)
            }
        } else {
            applySlot(day, slot, anchorOn, dragSeg)
            anchor = day to slot
        }
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
    val cs = MaterialTheme.colorScheme
    val frozen = frozenNow()

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PageHeader(
            "自律时段",
            "纵向是时间、横向是星期；点一格定起点，长按后可上下拖动框选，直接上下滑只滚动页面",
        )

        // 专注段生效中：整页只读。这与桌面端一致——自律期间能改表，锁机就只是建议
        if (frozen) {
            Text(
                "专注段生效中：这一页暂时只读。等这一段结束再改；"
                    + "或者用积分解锁 / 暂停锁机 / 停止本段，之后就能改。",
                fontSize = 11.5.sp,
                color = cs.error,
            )
        }

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
                        .clickable(enabled = !frozen) {
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
                enabled = !frozen,
                onClick = {
                    if (plans.size >= MAX_PLANS) return@OutlinedButton
                    val id = UUID.randomUUID().toString().take(8)
                    // 新方案从**空表**开始（桌面端 clockProfNew 也是这样）：
                    // 复制一份旧排班再让人一格一格擦掉，比重新拖要费事得多。
                    val p = SchedulePlan(
                        id = "plan-$id",
                        name = "方案 ${plans.size + 1}",
                        days = defaultDays(),
                        defWork = cfg.defWork,
                        defBrk = cfg.defBrk,
                    )
                    Store.update {
                        it.copy(plans = plans + p, activePlan = p.id, days = p.days)
                    }
                },
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
            ) { Text(if (plans.size >= MAX_PLANS) "最多 $MAX_PLANS 套" else "+ 新建", fontSize = 12.sp) }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(enabled = !frozen, onClick = {
                renameText = active.name
                renameTarget = active
            }) { Text("重命名", fontSize = 12.sp) }
            // 复制这套：连排班带番茄时长一起复制（桌面端 clockProfDup 同义）
            TextButton(
                enabled = !frozen,
                onClick = {
                    if (plans.size >= MAX_PLANS) return@TextButton
                    val id = "plan-" + UUID.randomUUID().toString().take(8)
                    val copy = active.copy(id = id, name = (active.name + " 副本").take(30))
                    Store.update {
                        it.copy(
                            plans = plans + copy,
                            activePlan = id,
                            days = copy.days,
                            defWork = copy.defWork,
                            defBrk = copy.defBrk,
                        )
                    }
                },
            ) {
                Text(
                    if (plans.size >= MAX_PLANS) "最多 $MAX_PLANS 套" else "复制这套",
                    fontSize = 12.sp,
                )
            }
            TextButton(
                enabled = !frozen,
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
            ) { Text("删除这套", fontSize = 12.sp, color = cs.error) }
        }

        // —— 这套时段管哪些自律规则（桌面端 ClockProfile.bound） ——
        //
        // 为什么必须有：自律规则可以有"工作 / 娱乐 / 深夜"好几组，时段又能存好几套。
        // 「周末那套只该管娱乐，不该管工作软件」靠一个全局开关表达不出来，
        // 只能让每套时段各自挑分组。空 = 全部（老配置的语义）。
        Panel {
            Text("这套时段生效的自律规则", fontSize = 14.sp)
            Text(
                if (active.bound.isEmpty()) "没绑任何分组 = 全部生效（默认）"
                else "已绑 ${active.bound.size} 组，其余分组这套时段不管",
                fontSize = 11.sp,
                color = cs.onSurfaceVariant,
            )
            Spacer(Modifier.height(6.dp))
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PickChip("全部", active.bound.isEmpty(), enabled = !frozen) { setBound(emptyList()) }
                cfg.rules.forEach { r ->
                    PickChip(r.name.ifBlank { "未命名" }, r.id in active.bound, enabled = !frozen) {
                        setBound(
                            if (r.id in active.bound) active.bound - r.id
                            else active.bound + r.id,
                        )
                    }
                }
            }
            if (cfg.rules.isEmpty()) {
                Text(
                    "还没有自律规则分组，先去「自律规则」建一组。",
                    fontSize = 10.5.sp,
                    color = cs.onSurfaceVariant,
                )
            } else {
                Text(
                    "换方案 = 换时间表 + 换管哪些分组。比如「工作日」那套只绑工作类，"
                        + "「周末」那套只绑娱乐类，互不干扰。",
                    fontSize = 10.5.sp,
                    color = cs.onSurfaceVariant,
                )
            }
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
                                .clickable(enabled = !frozen) {
                                    if (!on) Store.update { it.copy(granularity = v) }
                                }
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
                    // 格子区：整块一个画布。
                    //
                    // 手势分工（按需求定的，别再改回"按下即涂"）：
                    //   · 点一下        → 切换这一格，并记作拖选起点
                    //   · 长按（≥500ms）→ 进入拖选；之后上下拖动才框选
                    //   · 直接上下滑    → 一格都不改，交还给页面滚动
                    //
                    // 为什么必须等长按：网格比屏幕高，要滚动就得从格子上起手。
                    // 以前一按下就涂，等于把"滚动"这条路堵死了，用户只能误改时段。
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
                                    val start = cellAt(down.position)
                                    // 已经过去的星期是锁的：不涂、不吃手势（交还给滚动），
                                    // 想改就等下周——点表头会说明原因
                                    // 冻结（专注段生效中）时同样不吃手势：手一滑只滚动，
                                    // 不会留下一笔"改了但没生效"的假象
                                    if (!editable[start.first] || frozenNow()) return@awaitEachGesture

                                    val slop = viewConfiguration.touchSlop
                                    val longMs = viewConfiguration.longPressTimeoutMillis
                                    var dragMode = false
                                    var lastCell = start

                                    while (true) {
                                        // 手指按住不动时不会有新的指针事件，长按只能靠超时来判。
                                        // 进入拖选之后就不再需要超时，无限等下一个事件即可。
                                        val ev = if (dragMode) {
                                            awaitPointerEvent()
                                        } else {
                                            val left = (down.uptimeMillis + longMs -
                                                android.os.SystemClock.uptimeMillis()).coerceAtLeast(1L)
                                            withTimeoutOrNull(left) { awaitPointerEvent() }
                                        }

                                        if (ev == null) {
                                            // 超时 = 长按成立：进拖选，并给一次触感反馈
                                            dragMode = true
                                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                            beginDrag(start.first, start.second)
                                            lastCell = start
                                            continue
                                        }

                                        val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
                                        val moved = (ch.position - down.position).getDistance()

                                        if (!ch.pressed) {
                                            // 抬手：没进入拖选、也没怎么移动 = 一次点击
                                            if (!dragMode && moved <= slop) {
                                                tapCell(start.first, start.second)
                                            }
                                            break
                                        }

                                        if (!dragMode) {
                                            // 还没长按就滑走了 → 这是滚动意图。
                                            // 注意：这里**不消费**手势，一格都不碰。
                                            if (moved > slop) return@awaitEachGesture
                                            continue
                                        }

                                        val c = cellAt(ch.position)
                                        if (c != lastCell && editable[c.first]) {
                                            lastCell = c
                                            dragTo(c.first, c.second)
                                        }
                                        ch.consume()
                                    }

                                    dragging = false
                                    dragSeg = ""
                                    if (dragMode) commit()
                                }
                            },
                    ) {
                        val cellsW = size.width
                        val colW = cellsW / 7f
                        val gap = 1.dp.toPx()
                        val grid = draftState.value
                        val dragAnchor = anchor
                        val isDragging = dragging

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

                        // 拖选时把起点圈出来，用户才知道"这一段是从哪一格拉过来的"
                        val a = dragAnchor
                        if (isDragging && a != null && editable[a.first]) {
                            drawRect(
                                color = cs.primary,
                                topLeft = Offset(a.first * colW + gap, a.second * rowPx),
                                size = Size(colW - gap * 2, rowPx),
                                style = androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx()),
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
                    "；点一格定起点，长按后拖动才是框选，直接上下滑只滚动。浅色格表示旧边界" +
                    "跨在格子中间，重涂一下就会对齐；灰色的星期已经过去。",
                fontSize = 10.5.sp,
                color = cs.onSurfaceVariant,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(enabled = !frozen, onClick = {
                val rows2 = draftState.value.toMutableList()
                rows2[todayIdx] = Slots.paintDay(rows2[todayIdx], true, cfg.defWork, cfg.defBrk)
                draftState.value = rows2
                commit()
            }) { Text("今天全选", fontSize = 12.sp) }
            OutlinedButton(enabled = !frozen, onClick = { clearAsk = todayIdx }) {
                Text("今天清空", fontSize = 12.sp)
            }
        }

        // —— 番茄参数 ——
        //
        // 语义与桌面端一致：这里是**通用时长**，只决定"之后新选的时段用什么节奏"，
        // 已经排好的时段各自保留自己的时长。
        // 以前改这里会把整份方案重排——用户只是想把默认值从 45/15 改成 50/10，
        // 结果所有手调过的小时被一起抹平，且没有任何提示。
        SectionTitle("番茄节奏")
        Panel {
            Stepper("专注", cfg.defWork, 1, 59, " 分钟", enabled = !frozen) { v ->
                val brk = if (cfg.defBrk > 0) cfg.defBrk.coerceAtMost(60 - v) else cfg.defBrk
                Store.update { c -> c.copy(defWork = v, defBrk = brk) }
            }
            // 休息的上限随时跟着专注走：一轮番茄不能超过一小时
            Stepper("休息", cfg.defBrk, 0, 60 - cfg.defWork, " 分钟", enabled = !frozen) { v ->
                Store.update { c -> c.copy(defBrk = v) }
            }
            Text(
                "只作用于这套方案的默认值：之后新框选 / 新点选的时段沿用这套时长，"
                    + "已经排好的时段保持原样（它们各自记着自己的节奏）。要统一改，用下面的按钮。",
                fontSize = 10.5.sp,
                color = cs.onSurfaceVariant,
            )
            Spacer(Modifier.height(2.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(enabled = !frozen, onClick = {
                    // 桌面端右键菜单的「顺带更新通用时长」：整段套用，所以二次确认
                    applyAsk = true
                }) { Text("应用到已选时段", fontSize = 12.sp) }
            }
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
                                enabled = !frozen,
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
                                enabled = !frozen,
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

    // —— 二次确认：把通用时长套到这套方案里所有已选中的小时 ——
    if (applyAsk) {
        val onHours = draft.flatten().count { it.on }
        AlertDialog(
            onDismissRequest = { applyAsk = false },
            title = { Text("套用到已选时段？") },
            text = {
                Text(
                    "这套方案里已选中的 $onHours 个小时会全部改成 专注 ${cfg.defWork} 分 / " +
                        "休息 ${cfg.defBrk} 分，各自原来手调过的时长会被覆盖。",
                    fontSize = 13.sp,
                )
            },
            confirmButton = {
                Button(onClick = {
                    val rows = draftState.value.toMutableList()
                    for (d in rows.indices) {
                        rows[d] = ScheduleRules.retime(
                            d, todayIdx, rows[d],
                            work = cfg.defWork, brk = cfg.defBrk,
                        )
                    }
                    draftState.value = rows
                    commit()
                    applyAsk = false
                }) { Text("套用") }
            },
            dismissButton = { TextButton(onClick = { applyAsk = false }) { Text("取消") } },
        )
    }
}

/** 单选芯片：绑规则分组用（"全部" + 每个分组，选中的高亮） */
@Composable
private fun PickChip(text: String, on: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    val cs = MaterialTheme.colorScheme
    Box(
        Modifier
            .background(
                if (on) cs.primary.copy(alpha = if (enabled) 1f else 0.45f)
                else cs.surfaceVariant.copy(alpha = if (enabled) 1f else 0.45f),
                RoundedCornerShape(999.dp),
            )
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Text(
            text,
            fontSize = 12.sp,
            color = if (on) cs.onPrimary else cs.onSurfaceVariant,
        )
    }
}
