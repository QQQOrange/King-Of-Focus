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

    // tick 只是用来让"从设置页回来"时重算上面几个权限
    @Suppress("UNUSED_EXPRESSION")
    tick

    val todaySecs = remember(tick, cfg.stats.enabled) {
        StatsMath.total(StatsStore.today(now))
    }

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
                KV("今日自律", "${cfg.days.getOrNull(now.dayOfWeek.value - 1)?.count { it.on } ?: 0} 小时")
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
                Store.update { it.copy(enabled = on) }
                if (on) {
                    runCatching { GuardService.start(ctx) }
                    GuardService.scheduleHeartbeat(ctx)
                } else {
                    GuardService.stop(ctx)
                    GuardService.cancelHeartbeat(ctx)
                }
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
            Spacer(Modifier.height(4.dp))
            PermRow("使用情况访问", "知道当前前台是哪个应用", usageOk) {
                runCatching {
                    ctx.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }
            PermRow("无障碍服务", "切应用即刻识别；回桌面不受后台限制", accOk) {
                runCatching {
                    ctx.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }
            PermRow("在其他应用上层显示", "锁机遮罩靠它在后台拉起来（缺了锁机不生效）", overlayOk) {
                askOverlay = true
            }
            PermRow("通知", "阶段提醒与常驻状态", notifOk) {
                runCatching {
                    ctx.startActivity(
                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                }
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

@Composable
private fun PermRow(title: String, sub: String, ok: Boolean, onFix: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp)
            .let { m ->
                if (ok) m else m
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(8.dp)
                .background(
                    if (ok) Color(0xFF34C759) else MaterialTheme.colorScheme.error,
                    CircleShape,
                ),
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 13.5.sp)
            Spacer(Modifier.height(2.dp))
            Text(sub, fontSize = 10.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (ok) {
            Text("已授予", fontSize = 11.sp, color = Color(0xFF34C759))
        } else {
            TextButton(onClick = onFix) { Text("去开启", fontSize = 12.sp) }
        }
    }
}
