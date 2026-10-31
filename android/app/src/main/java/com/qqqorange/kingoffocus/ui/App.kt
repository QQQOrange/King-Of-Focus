package com.qqqorange.kingoffocus.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.background
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Assessment
import androidx.compose.material.icons.outlined.DateRange
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.List
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.core.Caps
import com.qqqorange.kingoffocus.core.GuardEngine
import com.qqqorange.kingoffocus.core.GuardLevel
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.core.ScheduleEngine
import com.qqqorange.kingoffocus.core.SleepEngine
import com.qqqorange.kingoffocus.core.StatsMath
import com.qqqorange.kingoffocus.core.StatsStore
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.core.PermId
import com.qqqorange.kingoffocus.core.Permissions
import com.qqqorange.kingoffocus.core.ShizukuBridge
import com.qqqorange.kingoffocus.data.Slots
import com.qqqorange.kingoffocus.data.Store
import com.qqqorange.kingoffocus.notificationsAllowed
import com.qqqorange.kingoffocus.service.GuardService
import com.qqqorange.kingoffocus.service.KofAccessibility
import com.qqqorange.kingoffocus.toast
import kotlinx.coroutines.flow.MutableStateFlow
import java.time.LocalDateTime

/** 从系统设置页回来时要重新读权限：MainActivity.onResume 里 +1 即可触发重算 */
object UiTick {
    val n = MutableStateFlow(0)
    fun bump() {
        n.value += 1
    }
}

enum class Tab(val label: String) {
    Home("总览"),
    Schedule("时段"),
    Rules("规则"),
    Stats("统计"),
    Settings("设置"),
}

@Composable
fun AppRoot() {
    val cfg by Store.state.collectAsState()
    var tab by remember { mutableStateOf(Tab.Home) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = {
                            Icon(
                                when (t) {
                                    Tab.Home -> Icons.Outlined.Home
                                    Tab.Schedule -> Icons.Outlined.DateRange
                                    Tab.Rules -> Icons.Outlined.List
                                    Tab.Stats -> Icons.Outlined.Assessment
                                    Tab.Settings -> Icons.Outlined.Settings
                                },
                                contentDescription = t.label,
                            )
                        },
                        label = { Text(t.label, fontSize = 10.sp) },
                    )
                }
            }
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when (tab) {
                Tab.Home -> HomeScreen(cfg)
                Tab.Schedule -> ScheduleScreen(cfg)
                Tab.Rules -> RulesScreen(cfg)
                Tab.Stats -> StatsScreen(cfg)
                Tab.Settings -> SettingsScreen(cfg)
            }
        }
    }
}

// ---------------------------------------------------------------- 总览

@Composable
private fun HomeScreen(cfg: Config) {
    val ctx = LocalContext.current
    val tick by UiTick.n.collectAsState()
    var now by remember { mutableStateOf(LocalDateTime.now()) }
    var askOverlay by remember { mutableStateOf(false) }
    // 权限清单展开哪一项。放在页面层而不是列表内部：
    // 这个页面每秒重组一次，组件内部的 remember 会被重置成"全折叠"。
    var openPerm by remember { mutableStateOf<PermId?>(null) }

    // 一秒一拍：倒计时、睡眠状态都靠它刷新
    androidx.compose.runtime.LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(1000)
            now = LocalDateTime.now()
        }
    }

    val st = ScheduleEngine.stateAt(cfg, now)
    val sleeping = SleepEngine.isSleeping(cfg, now)
    val locked = LockEngine.isLockActive(cfg, now)

    val usageOk = GuardEngine.hasUsageAccess(ctx)
    val accOk = KofAccessibility.alive()
    val overlayOk = Settings.canDrawOverlays(ctx)
    val notifOk = notificationsAllowed(ctx)
    val level = Caps(accOk, false, usageOk, overlayOk).level()
    // 通知权限的申请入口：只有"第一次开启自律"才有内容可发，那时才该弹
    val askNotify = rememberNotificationRequester()
    // 权限清单的唯一来源（与设置页、docs 同一份）；tick 让"从系统设置回来"后自动刷新
    val permissions = remember(tick, cfg.perm.notifAsked, cfg.perm.notifBlocked) {
        Permissions.audit(ctx, cfg)
    }

    // tick 只是用来让"从设置页回来"时重算上面几个权限
    @Suppress("UNUSED_EXPRESSION")
    tick

    // 总览只要一个总数：两轨相加（细分在「统计」页里看）
    val todaySecs = remember(tick, cfg.stats.enabled) {
        StatsMath.total(StatsStore.today(now), null)
    }

    // 今天排了多少自律——按**分钟**算，不是数整点。
    // 15 分钟刻度和"一小时多段"都必须算准：以前 `count { it.on }` 会把
    // 09:00–09:45 记成 1 小时，越精细的表错得越多。
    val todayPlan = cfg.days.getOrNull(now.dayOfWeek.value - 1).orEmpty()
    val todayPlanMin = Slots.dayMinutes(todayPlan)
    val todaySegs = todayPlan.sumOf { Slots.windowsOf(it).size }
    val todayLongest = todayPlan.flatMap { Slots.windowsOf(it) }
        .maxOfOrNull { it.to - it.from } ?: 0

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PageHeader("King Of Focus", "自律不是折磨自己，是把注意力还给你")

        // —— 状态卡 ——
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        when {
                            sleeping -> "睡眠时段"
                            locked -> "锁机中"
                            st == null -> "自由时间"
                            st.inBreak -> "休息中"
                            else -> "专注中"
                        },
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    Spacer(Modifier.height(3.dp))
                    Text(
                        when {
                            sleeping -> "手机先放一边，早上见"
                            locked -> "整台手机先别用，应用都还在"
                            st == null -> "现在不在自律时段，规则不生效"
                            st.inBreak -> "休息一下，喝水、走两步"
                            else -> "规则生效中，坚持一下"
                        },
                        fontSize = 11.5.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        when {
                            sleeping -> SleepEngine.active(cfg, now)?.leftSeconds?.let { ScheduleEngine.fmtLeft(it) } ?: "--:--"
                            locked -> ScheduleEngine.fmtLeft(LockEngine.segmentLeftSeconds(cfg, now))
                            st != null -> ScheduleEngine.fmtLeft(st.leftSeconds)
                            else -> "--:--"
                        },
                        fontSize = 26.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                    Text(
                        if (sleeping) "距离起床" else "本段剩余",
                        fontSize = 10.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(Modifier.height(12.dp))
            HLine()
            Spacer(Modifier.height(12.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                KV("积分", "${cfg.points}", MaterialTheme.colorScheme.secondary)
                KV("今日使用", StatsMath.fmtDuration(todaySecs))
                KV("今日自律", Slots.fmtMinutes(todayPlanMin))
            }
        }

        ToggleRow(
            title = "自律总开关",
            sub = if (cfg.enabled) "已开启：时段、规则、锁机全部生效" else "关闭时什么都不拦，适合刚开始设置的时候",
            checked = cfg.enabled,
            onChange = { on ->
                if (on && !usageOk && !accOk) {
                    toast(ctx, "先授予「使用情况访问」或「无障碍」，否则不知道你在用哪个应用")
                }
                // 开启自律后才会有"剩余多久""这段做完了"可发，此时申请通知才讲得通；
                // 启动就弹的话用户还不知道这应用做什么，大概率直接拒绝。
                if (on && !notifOk) askNotify()
                Store.update { it.copy(enabled = on) }
                // 统计是独立的：自律关掉后，只要还在记录时长，服务就该继续跑，
                // 否则「时段外」那一轨永远是空的
                GuardService.sync(ctx)
            },
        )

        // —— 今天的时段概览 ——
        SectionTitle("今天")
        Panel {
            val day = cfg.days.getOrNull(now.dayOfWeek.value - 1)
            Row(
                Modifier.fillMaxWidth().height(26.dp),
                horizontalArrangement = Arrangement.spacedBy(1.5.dp),
            ) {
                (0 until 24).forEach { h ->
                    val on = day?.getOrNull(h)?.on == true
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxSize()
                            .background(
                                if (on) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.surfaceVariant,
                                androidx.compose.foundation.shape.RoundedCornerShape(3.dp),
                            ),
                    )
                }
            }
            Spacer(Modifier.height(6.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("0", fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("12", fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("24", fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            // 色条是「几点到几点」，这一行是「一共多久」：同一份排班的两个视角，
            // 所以放在同一个面板里、用和状态卡一样的 KV 层级，而不是另起一张卡。
            Spacer(Modifier.height(10.dp))
            HLine()
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                KV(
                    "今日自律总时长",
                    Slots.fmtMinutes(todayPlanMin),
                    MaterialTheme.colorScheme.primary,
                )
                KV("共几段", if (todaySegs > 0) "$todaySegs 段" else "—")
                KV("最长一段", if (todayLongest > 0) Slots.fmtMinutes(todayLongest) else "—")
            }
            if (todayPlanMin == 0) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "今天还没排自律时段。去「时段」点一格定起点，长按后拖动就是框选。",
                    fontSize = 10.sp,
                    lineHeight = 14.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // —— 权限 ——
        SectionTitle("限制能力")
        Panel {
            Text(
                when (level) {
                    GuardLevel.FULL -> "完整 · 看得见、盖得住、也关不掉"
                    GuardLevel.STRONG -> "增强 · 看得见盖得住，但设置里还能强制停止"
                    GuardLevel.BASIC -> "基础 · 每秒轮询 + 悬浮窗遮罩"
                    GuardLevel.NONE -> "未生效 · 还差下面几项"
                },
                fontSize = 11.5.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(6.dp))
            PermList(
                items = permissions,
                open = openPerm,
                onToggle = { openPerm = if (openPerm == it) null else it },
                onFix = { item ->
                    when (item.spec.id) {
                        // 悬浮窗要先讲清"为什么"再跳，所以走确认弹窗
                        PermId.OVERLAY -> askOverlay = true
                        // 通知走运行时申请（能弹窗就弹，已永久拒绝直接跳设置）
                        PermId.NOTIFICATION -> askNotify()
                        PermId.SHIZUKU -> {
                            ShizukuBridge.request(ctx)
                            toast(ctx, "已请求 Shizuku 授权，允许后回到本页会自动连上")
                        }
                        else -> runCatching {
                            item.action?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { ctx.startActivity(it) }
                        }
                    }
                },
            )

            // 通知被关要单独说一句：守护还在跑，但四类通知都不会出现。
            // 不说的话，用户只会觉得"这软件怎么什么都不提醒"。
            if (!notifOk) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "通知被关：常驻状态、阶段提醒、完成通知、每日汇总都不会出现。"
                        + "统计与拦截仍照常工作。",
                    fontSize = 10.5.sp,
                    lineHeight = 15.sp,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }

    // 悬浮窗权限：先把"为什么"讲清楚，再带用户去系统页
    if (askOverlay) {
        AlertDialog(
            onDismissRequest = { askOverlay = false },
            title = { Text("需要「在其他应用上层显示」") },
            text = {
                Text(
                    "锁机生效时，本应用要在回到桌面后立刻盖上一层遮罩；没有这个权限，"
                        + "系统会拦住后台拉起页面，锁机会静默失效。\n\n"
                        + "开启后回到本页，状态会自动变成「已授予」。",
                    fontSize = 13.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    askOverlay = false
                    runCatching {
                        ctx.startActivity(
                            Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}"))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                }) { Text("去开启") }
            },
            dismissButton = { TextButton(onClick = { askOverlay = false }) { Text("暂不") } },
        )
    }
}

