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
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.core.OnboardMath
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Rule
import com.qqqorange.kingoffocus.data.Store
import com.qqqorange.kingoffocus.loadLaunchableApps
import com.qqqorange.kingoffocus.service.GuardService

/**
 * 首用向导（三步）。
 *
 * 为什么手机端更需要它：装完是空的，而手机上"从哪开始"比电脑更难猜——
 * 底部五个 tab、设置里十几项，用户不知道该先点哪个。
 *
 * 三步都落到**既有结构**里，不新造数据：
 *   ① 几点学  → 直接写 `Config.days`（就是「自律时段」页那张表）
 *   ② 哪些别开 → 写一条 `Rule`（就是「自律规则」页里那条）
 *   ③ 完成     → 打开自律总开关并记 `onboarded = true`
 *
 * 与桌面端 `onboard::apply` 同一套语义；排班由 `OnboardMath` 生成，有单测钉住。
 */
@Composable
fun OnboardScreen(cfg: Config, onExit: () -> Unit) {
    val ctx = LocalContext.current
    var step by remember { mutableStateOf(0) }
    var days by remember { mutableStateOf(listOf(0, 1, 2, 3, 4)) }
    var from by remember { mutableStateOf(20) }
    var to by remember { mutableStateOf(22) }
    var picked by remember { mutableStateOf(setOf<String>()) }
    // 只列前 40 个：几百个应用滚到底反而没人选
    val apps = remember { loadLaunchableApps(ctx).take(40) }
    val scroll = rememberScrollState()

    val nameOf = { i: Int -> listOf("一", "二", "三", "四", "五", "六", "日")[i] }
    val daysText = when (days.sorted().joinToString(",")) {
        "0,1,2,3,4" -> "工作日"
        "0,1,2,3,4,5,6" -> "每天"
        "5,6" -> "周末"
        "" -> "还没选"
        else -> days.sorted().joinToString(" ") { nameOf(it) }
    }

    fun apply() {
        Store.update {
            it.copy(
                enabled = true,
                days = OnboardMath.buildDays(days, from, to),
                defWork = OnboardMath.WORK,
                defBrk = OnboardMath.BRK,
                // 覆盖向导自己写的那条，不动用户手建的其他规则
                rules = it.rules.filter { r -> r.id != RULE_ID } +
                    Rule(
                        id = RULE_ID,
                        name = "开始时选的",
                        enabled = true,
                        mode = "blacklist",
                        packages = picked.toList(),
                    ),
                onboarded = true,
            )
        }
        // 打开自律后服务要真的跑起来，否则"到点拦住"只是嘴上说说
        GuardService.sync(ctx)
    }

    Surface(color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(scroll)
                .padding(horizontal = 18.dp, vertical = 16.dp),
        ) {
            // 步骤条：知道"还有几步"的人才不会半路放弃
            Row(verticalAlignment = Alignment.CenterVertically) {
                repeat(3) { i ->
                    Box(
                        Modifier
                            .padding(end = 6.dp)
                            .size(width = 22.dp, height = 4.dp)
                            .background(
                                when {
                                    i == step -> MaterialTheme.colorScheme.secondary
                                    i < step -> MaterialTheme.colorScheme.secondary.copy(alpha = 0.4f)
                                    else -> MaterialTheme.colorScheme.surfaceVariant
                                },
                                RoundedCornerShape(2.dp),
                            ),
                    )
                }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = {
                    Store.update { it.copy(onboarded = true) }
                    onExit()
                }) { Text("跳过", fontSize = 12.sp) }
            }

            Spacer(Modifier.height(18.dp))

            when (step) {
                0 -> {
                    OnboardTitle("你打算什么时候学？")
                    OnboardSub("这段时间里，「不该开的东西」会被挡住；需要的话，锁机遮罩也会盖上来。先选一个你真能做到的时间——小一点没关系。")
                    Spacer(Modifier.height(18.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        (0..6).forEach { i ->
                            val on = days.contains(i)
                            Box(
                                Modifier
                                    .weight(1f)
                                    .background(
                                        if (on) MaterialTheme.colorScheme.secondary.copy(alpha = 0.16f)
                                        else Color.Transparent,
                                        RoundedCornerShape(10.dp),
                                    )
                                    .border(
                                        1.dp,
                                        if (on) MaterialTheme.colorScheme.secondary
                                        else MaterialTheme.colorScheme.surfaceVariant,
                                        RoundedCornerShape(10.dp),
                                    )
                                    .clickable {
                                        days = if (on) days - i else days + i
                                    }
                                    .padding(vertical = 10.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    nameOf(i),
                                    fontSize = 13.sp,
                                    fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                                    color = if (on) MaterialTheme.colorScheme.secondary
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(18.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("从", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(8.dp))
                        HourPicker(from, 6, 23) { v -> from = v.coerceAtMost(to - 1) }
                        Spacer(Modifier.width(14.dp))
                        Text("到", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(8.dp))
                        HourPicker(to, 7, 24) { v -> to = v.coerceAtLeast(from + 1) }
                    }
                    Spacer(Modifier.height(14.dp))
                    Text(
                        "$daysText ${fmtHour(from)}–${fmtHour(to)} · 每天 ${to - from} 小时",
                        fontSize = 12.5.sp,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                }

                1 -> {
                    OnboardTitle("这些时候，哪些不该打开？")
                    OnboardSub("只在你刚选的时间段里挡住它们，别的时间照常使用。")
                    Spacer(Modifier.height(14.dp))
                    if (apps.isEmpty()) {
                        Text(
                            "没读到应用列表（有时需要权限）。这一步可以跳过，以后在「自律规则」里随时能加。",
                            fontSize = 11.5.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        apps.forEach { a ->
                            val on = picked.contains(a.pkg)
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        picked = if (on) picked - a.pkg else picked + a.pkg
                                    }
                                    .padding(vertical = 9.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Box(
                                    Modifier
                                        .size(18.dp)
                                        .background(
                                            if (on) MaterialTheme.colorScheme.secondary else Color.Transparent,
                                            RoundedCornerShape(5.dp),
                                        )
                                        .border(
                                            1.dp,
                                            if (on) MaterialTheme.colorScheme.secondary
                                            else MaterialTheme.colorScheme.surfaceVariant,
                                            RoundedCornerShape(5.dp),
                                        ),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    if (on) Text("✓", fontSize = 11.sp, color = Color.White)
                                }
                                Spacer(Modifier.width(10.dp))
                                Text(a.label, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }

                else -> {
                    OnboardTitle("就这样，可以开始了")
                    OnboardSub("到点会自动开始：被选的软件会被挡住，锁机遮罩也会盖上来。想改随时去「时段」「规则」页。")
                    Spacer(Modifier.height(16.dp))
                    Panel {
                        PlanLine("$daysText ${fmtHour(from)}–${fmtHour(to)}", "每周约 ${(to - from) * days.size} 小时")
                        PlanLine(
                            if (picked.isEmpty()) "这一步先跳过（以后可以加）" else "挡住 ${picked.size} 个应用",
                            "",
                        )
                        PlanLine("自律总开关：完成后打开", "")
                    }
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "提示：真正拦住应用还需要「使用情况访问」或「无障碍」权限。完成后回到首页，守护状态带会告诉你缺哪个。",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(Modifier.height(26.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (step > 0) {
                    OutlinedButton(onClick = { step-- }) { Text("上一步") }
                }
                Spacer(Modifier.weight(1f))
                if (step < 2) {
                    Button(
                        onClick = { step++ },
                        enabled = step != 0 || days.isNotEmpty(),
                    ) { Text("下一步") }
                } else {
                    Button(onClick = {
                        apply()
                        onExit()
                    }) { Text("完成") }
                }
            }
            Spacer(Modifier.height(40.dp))
        }
    }
}

private const val RULE_ID = "onboard-rule"

private fun fmtHour(h: Int): String = if (h >= 24) "24:00" else h.toString().padStart(2, '0') + ":00"

@Composable
private fun OnboardTitle(t: String) {
    Text(t, fontSize = 22.sp, fontWeight = FontWeight.Bold, lineHeight = 30.sp)
}

@Composable
private fun OnboardSub(t: String) {
    Spacer(Modifier.height(8.dp))
    Text(t, fontSize = 12.5.sp, lineHeight = 20.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun PlanLine(a: String, b: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(a, fontSize = 12.5.sp)
        Spacer(Modifier.weight(1f))
        if (b.isNotEmpty()) {
            Text(b, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** 小时选择器：一个按钮循环往前，够用且不用引入下拉菜单 */
@Composable
private fun HourPicker(value: Int, min: Int, max: Int, onChange: (Int) -> Unit) {
    Box(
        Modifier
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f), RoundedCornerShape(10.dp))
            .clickable {
                val next = if (value >= max) min else value + 1
                onChange(next)
            }
            .padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Text(fmtHour(value), fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}
