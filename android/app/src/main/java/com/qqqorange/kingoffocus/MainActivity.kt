package com.qqqorange.kingoffocus

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings as SysSettings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.qqqorange.kingoffocus.data.Portable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import com.qqqorange.kingoffocus.core.Caps
import com.qqqorange.kingoffocus.core.UpdateClient
import com.qqqorange.kingoffocus.core.Updater
import com.qqqorange.kingoffocus.core.UpdateHub
import com.qqqorange.kingoffocus.core.StrictBlocker
import com.qqqorange.kingoffocus.core.GuardEngine
import com.qqqorange.kingoffocus.core.GuardLevel
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.core.ShizukuBridge
import com.qqqorange.kingoffocus.service.KofAccessibility
import com.qqqorange.kingoffocus.core.ScheduleEngine
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Store
import com.qqqorange.kingoffocus.service.GuardService
import com.qqqorange.kingoffocus.ui.KofTheme
import com.qqqorange.kingoffocus.ui.LockActivity
import kotlinx.coroutines.delay
import java.time.LocalDateTime

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.init(this)
        // 锁机期间打开本应用 = 直接进遮罩。
        // 不这么拦的话，"回桌面 + 遮罩"就有一个后门：从图标进来关掉自律即可。
        if (LockEngine.isLockActive(Store.current, LocalDateTime.now())) {
            runCatching { GuardService.start(this) }
            startActivity(Intent(this, LockActivity::class.java))
            finish()
            return
        }
        // 用户开着自律时打开应用：确保守护在跑（Android 12+ 允许前台应用启动前台服务）
        if (Store.current.enabled) {
            runCatching { GuardService.start(this) }
        }
        // 自动检查更新：只查不装。安装永远要用户自己点一下——
        // 一个"自律"应用更要守住这条：不能背着人静默装东西。
        if (Store.current.update.autoCheck) {
            lifecycleScope.launch {
                val c = Store.current
                val nowSec = System.currentTimeMillis() / 1000
                if (!UpdateHub.due(c.update.lastCheck, c.update.intervalHours, nowSec)) return@launch
                UpdateHub.busy.value = true
                val r = withContext(Dispatchers.IO) {
                    UpdateClient.check(UpdateHub.REPO, appVersion(this@MainActivity))
                }
                Store.update { it.copy(update = it.update.copy(lastCheck = nowSec)) }
                UpdateHub.last.value = r
                UpdateHub.busy.value = false
            }
        }
        setContent {
            KofTheme {
                Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
                    AppRoot()
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // 用户可能刚从 Shizuku 授权页 / 无障碍设置回来：
        // 已经授权的话这里补一次连接，界面上的等级立刻跟着变
        runCatching { ShizukuBridge.connect(this) }
    }
}

private enum class Tab(val label: String) {
    Home("总览"), Schedule("时段"), Rules("规则"), Settings("设置")
}

@Composable
private fun AppRoot() {
    val cfg by Store.state.collectAsState()
    var tab by remember { mutableStateOf(Tab.Home) }
    Scaffold(
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Box(Modifier.size(6.dp)) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad)) {
            when (tab) {
                Tab.Home -> HomePage(cfg)
                Tab.Schedule -> SchedulePage(cfg)
                Tab.Rules -> RulesPage(cfg)
                Tab.Settings -> SettingsPage(cfg)
            }
        }
    }
}

// ---------------------------------------------------------------- 总览

@Composable
private fun HomePage(cfg: Config) {
    val ctx = LocalContext.current
    var now by remember { mutableStateOf(LocalDateTime.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            now = LocalDateTime.now()
        }
    }
    val st = ScheduleEngine.stateAt(cfg, now)
    val unlocked = now.atZone(java.time.ZoneId.systemDefault()).toEpochSecond() < cfg.unlockUntil
    val usageOk = GuardEngine.hasUsageAccess(ctx)
    val notifOk = notificationsAllowed(ctx)
    val overlayOk = SysSettings.canDrawOverlays(ctx)
    val accOk = KofAccessibility.alive()
    // Shizuku 的"能用"要三件事齐：服务在、已授权、用户服务已连上
    val shzOk = runCatching { ShizukuBridge.granted() && ShizukuBridge.ready() }.getOrDefault(false)
    val level = Caps(accOk, shzOk, usageOk, overlayOk).level()
    val levelText = when (level) {
        GuardLevel.FULL -> "完整"
        GuardLevel.STRONG -> "增强"
        GuardLevel.BASIC -> "基础"
        GuardLevel.NONE -> "未生效"
    }
    var showUnlock by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("King Of Focus", fontSize = 22.sp, fontWeight = FontWeight.Bold)
        Text(
            "自律时段 + 番茄 + 应用拦截，全部在本机完成，不联网。",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // 状态卡
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val (title, tone) = when {
                    unlocked -> "已解锁" to MaterialTheme.colorScheme.secondary
                    st == null -> "未在自律时段" to MaterialTheme.colorScheme.onSurfaceVariant
                    st.inBreak -> "休息中" to MaterialTheme.colorScheme.secondary
                    else -> "专注中" to MaterialTheme.colorScheme.primary
                }
                Text(title, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = tone)
                Text(
                    if (st != null) ScheduleEngine.fmtLeft(st.leftSeconds) else "--:--",
                    fontSize = 40.sp,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    when {
                        unlocked -> "积分解锁中，拦截已暂停"
                        st == null -> "编辑「时段」页，把要自律的小时点亮"
                        st.inBreak -> "休息段不拦截，好好休息"
                        else -> "番茄 ${st.work}/${st.brk} · 被拦应用会立刻跳到拦截页"
                    },
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (cfg.unlockUntil > 0 && unlocked) {
                    val left = cfg.unlockUntil - now.atZone(java.time.ZoneId.systemDefault()).toEpochSecond()
                    Text("解锁剩余 ${left / 60} 分钟", fontSize = 12.sp)
                }
            }
        }

        // 总开关
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("启用自律", fontWeight = FontWeight.SemiBold)
                Text(
                    "关闭后时段与拦截全部停止",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = cfg.enabled,
                onCheckedChange = { on ->
                    Store.update { it.copy(enabled = on) }
                    if (on) {
                        if (!usageOk && !accOk) {
                            toast(ctx, "还需要「使用情况访问」或「无障碍」，否则不知道你在用哪个应用")
                        }
                        GuardService.start(ctx)
                        GuardService.scheduleHeartbeat(ctx)
                    } else {
                        GuardService.stop(ctx)
                        // 关掉自律就别再让心跳把服务拉起来了，否则通知会自己冒出来
                        GuardService.cancelHeartbeat(ctx)
                    }
                },
            )
        }

        // 权限
        SectionTitle("限制能力与权限")

        PermRow(
            "使用情况访问",
            "知道「当前前台是哪个应用」。没有它就要靠无障碍；两个都没有，限制基本失效",
            usageOk,
        ) {
            runCatching { ctx.startActivity(Intent(SysSettings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        PermRow(
            "无障碍服务",
            "① 切应用即刻识别（不用等 1 秒轮询）② 回桌面不受后台限制 ③ 强制模式下挡住" +
                "「去设置里关掉它」这一页",
            accOk,
        ) {
            runCatching {
                ctx.startActivity(
                    Intent(SysSettings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }
        PermRow(
            "Shizuku",
            "① 拉起遮罩不受系统限制（不需要悬浮窗）② 强制模式下你一进设置就把设置关掉 " +
                "③ 无障碍被关掉后自动恢复",
            shzOk,
        ) {
            if (ShizukuBridge.available()) {
                ShizukuBridge.request(ctx)
            } else {
                toast(ctx, "先安装并启动 Shizuku（或通过 adb 启动它的服务）")
                runCatching {
                    ctx.startActivity(
                        ctx.packageManager.getLaunchIntentForPackage("moe.shizuku.privileged.api")
                            ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                }
            }
        }
        PermRow("通知", "阶段提醒与常驻状态", notifOk) {
            runCatching {
                ctx.startActivity(
                    Intent(SysSettings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(SysSettings.EXTRA_APP_PACKAGE, ctx.packageName)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }
        PermRow("悬浮窗", "没有 Shizuku 时，遮罩只能靠它在后台拉起来", overlayOk) {
            runCatching {
                ctx.startActivity(
                    Intent(SysSettings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }
        Text(
            "当前防护等级：$levelText —— " + when (level) {
                GuardLevel.FULL -> "看得见、盖得住、也关不掉，强制模式才有意义"
                GuardLevel.STRONG -> "看得见也盖得住，但用户仍能在系统设置里强制停止本应用"
                GuardLevel.BASIC -> "每秒轮询 + 悬浮窗遮罩，系统一收紧就可能失效"
                GuardLevel.NONE -> "还差前面几项，现在限制不住任何东西"
            },
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp),
        )

        // 积分
        SectionTitle("积分")
        Card {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("余额", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(8.dp))
                    Text("${cfg.points} 分", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.weight(1f))
                    OutlinedButton(onClick = { showUnlock = true }) { Text("解锁") }
                }
                Text(
                    "专注每满 1 分钟 +1 分；解锁按 1 分 = 1 分钟，解锁期间所有拦截暂停。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Text(
            "Android 限制：本应用不能结束其他应用进程，也不能阻止你从桌面再次打开它们。\n" +
                "「拦截」的实际效果是——每次切到被拦的应用都会立刻回到拦截页；卸载本应用、撤销权限即可绕过。",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
    }

    if (showUnlock) {
        UnlockDialog(
            balance = cfg.points,
            onDismiss = { showUnlock = false },
            onPick = { mins ->
                showUnlock = false
                val cost = mins
                if (cfg.points < cost) {
                    toast(ctx, "积分不够：需要 $cost 分")
                } else {
                    val until = LocalDateTime.now().atZone(java.time.ZoneId.systemDefault()).toEpochSecond() + mins * 60L
                    Store.update { it.copy(points = it.points - cost, unlockUntil = until) }
                    toast(ctx, "已解锁 $mins 分钟")
                }
            },
        )
    }
}

@Composable
private fun UnlockDialog(balance: Int, onDismiss: () -> Unit, onPick: (Int) -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("用积分解锁") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("当前 $balance 分。1 分换 1 分钟，解锁期间所有拦截暂停。", fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(5, 10, 15).forEach { m ->
                        OutlinedButton(onClick = { onPick(m) }, enabled = balance >= m) { Text("$m 分钟") }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

// ---------------------------------------------------------------- 设置

@Composable
private fun SettingsPage(cfg: Config) {
    val ctx = LocalContext.current
    var showAllow by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("设置", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        SectionTitle("提醒")
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("启用提醒", Modifier.weight(1f))
            Switch(
                checked = cfg.notify.enabled,
                onCheckedChange = { v -> Store.update { it.copy(notify = it.notify.copy(enabled = v)) } },
            )
        }
        Stepper("专注结束前", cfg.notify.workBefore, 0, 120, "分钟") { v ->
            Store.update { it.copy(notify = it.notify.copy(workBefore = v)) }
        }
        Stepper("休息结束前", cfg.notify.breakBefore, 0, 120, "分钟") { v ->
            Store.update { it.copy(notify = it.notify.copy(breakBefore = v)) }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("休息也提醒", Modifier.weight(1f))
            Switch(
                checked = cfg.notify.breakNotify,
                onCheckedChange = { v -> Store.update { it.copy(notify = it.notify.copy(breakNotify = v)) } },
            )
        }

        SectionTitle("拦截")
        OutlinedTextField(
            value = cfg.overlay.message,
            onValueChange = { v -> Store.update { it.copy(overlay = it.overlay.copy(message = v)) } },
            label = { Text("拦截页文案") },
            modifier = Modifier.fillMaxWidth(),
            maxLines = 3,
        )
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("拦截页允许结束自律")
                Text(
                    "默认关闭。打开后拦截页上会出现「结束本次自律」，方便你不在时段里时脱身。",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = cfg.overlay.allowStop,
                onCheckedChange = { v -> Store.update { it.copy(overlay = it.overlay.copy(allowStop = v)) } },
            )
        }

        SectionTitle("锁机")
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("锁机（回桌面 + 全屏遮罩）")
                Text(
                    "专注段里离开允许的应用时：先回桌面，再立刻盖上遮罩。不杀进程、不关机。",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Switch(
                checked = cfg.lock.enabled,
                onCheckedChange = { v ->
                    Store.update { it.copy(lock = it.lock.copy(enabled = v)) }
                    if (v) {
                        if (!GuardEngine.hasUsageAccess(ctx)) {
                            toast(ctx, "还需要授予「使用情况访问」，否则不知道你在用什么应用")
                        }
                        if (!SysSettings.canDrawOverlays(ctx)) {
                            // 不是"建议"而是硬性前置：没有它，后台拉起遮罩会被系统拦掉
                            toast(ctx, "锁机需要「悬浮窗」权限，现在带你过去授予")
                            runCatching {
                                ctx.startActivity(
                                    Intent(SysSettings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}"))
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                )
                            }
                        }
                    }
                },
            )
        }
        if (cfg.lock.enabled) {
            // —— 温和 / 强制 ——
            val strict = LockEngine.isStrict(cfg)
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                ModeChoice("温和模式", selected = !strict) {
                    if (!LockEngine.canSwitchMode(cfg, LocalDateTime.now())) {
                        toast(ctx, "强制锁机进行中，不能切回温和模式；等这一段结束再改")
                    } else {
                        Store.update { it.copy(lock = it.lock.copy(mode = LockEngine.MODE_GENTLE)) }
                    }
                }
                ModeChoice("强制模式", selected = strict) {
                    Store.update { it.copy(lock = it.lock.copy(mode = LockEngine.MODE_STRICT)) }
                }
            }
            Text(
                if (strict) {
                    "强制模式：暂停与提前结束一律不生效，必须完整走完这一段。"
                } else {
                    "温和模式：可以花积分暂停（到点自动恢复）或提前结束这一段。"
                },
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            val blocker = Caps(
                KofAccessibility.alive(),
                runCatching { ShizukuBridge.ready() }.getOrDefault(false),
                GuardEngine.hasUsageAccess(ctx),
                SysSettings.canDrawOverlays(ctx),
            ).strictBlocker()
            if (strict && blocker != null) {
                Text(
                    "⚠ " + when (blocker) {
                        StrictBlocker.NO_FOREGROUND -> "缺前台识别：请开启「无障碍」或授予「使用情况访问」，否则不知道该拦谁"
                        StrictBlocker.NO_MASK -> "盖不上遮罩：请授予「悬浮窗」，或安装 Shizuku 并授权"
                        StrictBlocker.NO_APP_CONTROL -> "缺 Shizuku：去设置里关掉本应用只能靠无障碍按返回，" +
                            "中途切走或无障碍被停用就拦不住了"
                    },
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            if (!strict) {
                Stepper("暂停时长", cfg.lock.pauseMinutes, 1, 120, " 分钟") { v ->
                    Store.update { it.copy(lock = it.lock.copy(pauseMinutes = v)) }
                }
                Stepper("暂停消耗", cfg.lock.pauseCost, 1, 500, " 分") { v ->
                    Store.update { it.copy(lock = it.lock.copy(pauseCost = v)) }
                }
                Stepper("停止消耗", cfg.lock.stopCost, 1, 500, " 分") { v ->
                    Store.update { it.copy(lock = it.lock.copy(stopCost = v)) }
                }
            }
            OutlinedButton(
                onClick = { showAllow = true },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("允许使用的应用（${cfg.lockAllow.size}）") }
            Text(
                "遮罩上会列出这些应用，点一下直接打开；它们不会被挡在遮罩后面。",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                if (strict) {
                    "强制模式下没有「暂停/停止」，积分在这里不起作用；白名单是唯一能用的应用。"
                } else {
                    "「停止」只对当前这一段生效，下一段专注会重新锁机；「暂停」到点自动恢复。"
                },
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        SectionTitle("备份与恢复")
        BackupSection(cfg)

        SectionTitle("版本与更新")
        UpdateSection(cfg)

        SectionTitle("数据")
        OutlinedButton(
            onClick = {
                Store.update { Config() }
                GuardService.stop(ctx)
                toast(ctx, "已重置为默认配置")
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("重置全部配置") }

        SectionTitle("关于")
        Text("King Of Focus · Android 0.2.1", fontSize = 13.sp)
        Text(
            "桌面版的能力（结束进程、封杀任务管理器、关机、全局热键）在 Android 上不可实现，" +
                "这里用「时段 + 番茄 + 前台检测 + 全屏拦截页」做等价的自律闭环。",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
    }

    if (showAllow) {
        AppPickerDialog(
            selected = cfg.lockAllow,
            onDismiss = { showAllow = false },
            onConfirm = { pkgs ->
                Store.update { it.copy(lockAllow = pkgs) }
                showAllow = false
            },
        )
    }
}

// ---------------------------------------------------------------- 备份（跨设备）

/**
 * 备份与恢复。
 *
 * 三件事必须同时成立，缺一个"互通"就是空话：
 * 1. 文件格式和桌面端一致（`data/Portable.kt`，两端读同一份样例断言）；
 * 2. 加密方式两端都算得出来（PBKDF2-HMAC-SHA256 + AES-256-GCM）；
 * 3. 恢复时让用户明确选「覆盖」还是「合并」，并把结果说清楚。
 *
 * 文件读写走 SAF（系统文件选择器）：不需要存储权限，用户自己决定放在哪。
 */
@Composable
private fun BackupSection(cfg: Config) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }
    var pending by remember { mutableStateOf<Uri?>(null) }
    var askMode by remember { mutableStateOf(false) }

    fun runExport(uri: Uri) = scope.launch {
        busy = true
        status = "正在导出…"
        try {
            val pass = Store.current.backup.password
            val text = withContext(Dispatchers.IO) {
                val doc = Portable.toDoc(
                    Store.current,
                    android.os.Build.MODEL ?: "Android",
                    appVersion(ctx),
                )
                Portable.seal(Portable.render(doc), pass)
            }
            withContext(Dispatchers.IO) {
                (ctx.contentResolver.openOutputStream(uri)
                    ?: error("这个位置写不进去")).use { it.write(text.toByteArray(Charsets.UTF_8)) }
            }
            val n = Store.current.rules.size
            status = if (pass.isBlank()) {
                "已导出 $n 条规则（明文文件，请妥善保管）"
            } else {
                "已导出 $n 条规则（密码加密）"
            }
        } catch (e: Exception) {
            status = "导出失败：${e.message ?: "未知错误"}"
        } finally {
            busy = false
        }
    }

    fun runImport(mode: String, uri: Uri) = scope.launch {
        busy = true
        status = if (mode == "merge") "正在合并…" else "正在覆盖…"
        try {
            val msg = withContext(Dispatchers.IO) {
                val text = (ctx.contentResolver.openInputStream(uri)
                    ?: error("读不到这个文件")).use { it.readBytes().toString(Charsets.UTF_8) }
                val plain = Portable.unlock(text, Store.current.backup.password)
                val parsed = Portable.parse(plain)
                val base = Store.current
                if (mode == "merge") {
                    val out = Portable.merge(parsed.doc, base)
                    if (out.stats.noop) {
                        "没有需要合并的内容：这些规则本机已经有了"
                    } else {
                        val st = out.stats
                        Store.update { out.config }
                        "合并完成：新增 ${st.added} 条规则，跳过 ${st.skipped} 条，" +
                            "冲突 ${st.conflict} 条，补上 ${st.slots} 个小时段"
                    }
                } else {
                    val next = Portable.overwrite(parsed.doc, base)
                    Store.update { next }
                    "已覆盖：现在有 ${next.rules.size} 条规则" +
                        if (parsed.legacy) "（旧版备份，整份恢复）" else ""
                }
            }
            status = msg
            // 规则和时段可能整批换了，守护服务要按新配置重来一遍
            if (Store.current.enabled) runCatching { GuardService.start(ctx) }
        } catch (e: Exception) {
            status = "恢复失败：${e.message ?: "未知错误"}"
        } finally {
            busy = false
        }
    }

    val exportLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("application/octet-stream"),
    ) { uri -> if (uri != null) runExport(uri) }

    val importLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri != null) {
            pending = uri
            askMode = true
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = cfg.backup.password,
            onValueChange = { v -> Store.update { it.copy(backup = it.backup.copy(password = v)) } },
            label = { Text("备份密码") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
        )
        Text(
            "两端填同一个密码，导出的备份就能互相恢复。留空 = 明文文件（任何人都能打开）。",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { exportLauncher.launch(defaultBackupName()) },
                enabled = !busy,
            ) { Text("导出备份…") }
            OutlinedButton(
                onClick = { importLauncher.launch(arrayOf("*/*")) },
                enabled = !busy,
            ) { Text("从文件恢复…") }
        }
        Text(
            "导出的 .kofbak 桌面端可直接恢复；桌面端导出的文件也能在这里选。",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (status.isNotBlank()) {
            Text(status, fontSize = 12.sp)
        }
    }

    if (askMode && pending != null) {
        val uri = pending
        AlertDialog(
            onDismissRequest = { askMode = false; pending = null },
            title = { Text("怎么应用这份备份？") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "覆盖：用备份里的规则、时段、积分、提醒替换本机，本机多出来的规则会消失。" +
                            "拦截页文案这类手机专属设置不受影响。",
                        fontSize = 12.sp,
                    )
                    Text(
                        "合并：只补本机没有的规则和时段，已有的一律不改；同名不同内容的规则会改名并列，" +
                            "积分取两边较大值。",
                        fontSize = 12.sp,
                    )
                }
            },
            confirmButton = {
                Row {
                    TextButton(onClick = {
                        askMode = false; pending = null
                        if (uri != null) runImport("merge", uri)
                    }) { Text("合并") }
                    TextButton(onClick = {
                        askMode = false; pending = null
                        if (uri != null) runImport("overwrite", uri)
                    }) { Text("覆盖") }
                }
            },
            dismissButton = {
                TextButton(onClick = { askMode = false; pending = null }) { Text("取消") }
            },
        )
    }
}

// ---------------------------------------------------------------- 版本与更新

/**
 * 自动更新配置 + 检查 + 安装。
 *
 * 两条硬规则：
 * 1. **只认本平台的包**——判定在 [Updater]（纯函数、单测覆盖），这里只管显示；
 * 2. **查到 ≠ 装上**：永远要用户点「下载并安装」，绝不静默安装。
 *
 * 失败时把错误码一起显示出来（`E_PLATFORM_MISSING` / `E_TYPE_MISMATCH` / `E_HASH…`），
 * 用户截图报问题就能直接对到 `docs/update-channels.md` 里的那一条。
 */
@Composable
private fun UpdateSection(cfg: Config) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val busy by UpdateHub.busy.collectAsState()
    val autoRes by UpdateHub.last.collectAsState()
    var res by remember { mutableStateOf<UpdateClient.Result?>(null) }
    var status by remember { mutableStateOf("") }
    var isErr by remember { mutableStateOf(false) }
    var progress by remember { mutableStateOf(0) }

    // 启动时的自动检查结果：进设置页就把它接过来显示，不用再查一遍
    LaunchedEffect(autoRes) { if (autoRes != null) res = autoRes }

    val current = appVersion(ctx)
    val skipped = cfg.update.skippedVersion

    fun setStatus(text: String, err: Boolean = false) {
        status = text
        isErr = err
    }

    fun checkNow() = scope.launch {
        UpdateHub.busy.value = true
        setStatus("正在检查…")
        val r = withContext(Dispatchers.IO) { UpdateClient.check(UpdateHub.REPO, current) }
        Store.update { it.copy(update = it.update.copy(lastCheck = System.currentTimeMillis() / 1000)) }
        UpdateHub.last.value = r
        res = r
        UpdateHub.busy.value = false
        setStatus("")
    }

    fun download(r: UpdateClient.Result) = scope.launch {
        val url = r.url
        if (url.isNullOrBlank()) {
            setStatus("这个版本没有可下载的安装包，请到 GitHub 手动下载", true)
            return@launch
        }
        UpdateHub.busy.value = true
        progress = 0
        setStatus("正在下载 ${r.file}…")
        try {
            val dest = File(ctx.cacheDir, "updates/${r.file}")
            withContext(Dispatchers.IO) {
                UpdateClient.download(url, dest, r.size, r.sha256) { done, total ->
                    if (total > 0) {
                        val pct = ((done * 100) / total).toInt().coerceIn(0, 100)
                        scope.launch(Dispatchers.Main) { progress = pct }
                    }
                }
            }
            setStatus("下载完成，正在打开系统安装器…")
            installApk(ctx, dest)
        } catch (e: Exception) {
            setStatus("更新失败：${e.message}", true)
        } finally {
            UpdateHub.busy.value = false
            progress = 0
        }
    }

    // 自动检查开关
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text("自动检查更新")
            Text(
                "打开应用时检查一次（最多每 " + cfg.update.intervalHours +
                    " 小时一次）。只检查，不会自己装。",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(
            checked = cfg.update.autoCheck,
            onCheckedChange = { v ->
                Store.update { it.copy(update = it.update.copy(autoCheck = v)) }
            },
        )
    }
    Stepper("检查间隔", cfg.update.intervalHours, 1, 168, " 小时") { v ->
        Store.update { it.copy(update = it.update.copy(intervalHours = v)) }
    }

    // 当前通道：平台标识 + 版本，一眼能看出"我只收哪个平台的包"
    Text(
        "更新通道：" + Updater.platformLabel(Updater.PLATFORM) + "（" + Updater.PLATFORM + "）" +
            " · 当前 v" + current,
        fontSize = 11.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Text(
        if (cfg.update.lastCheck > 0) {
            "上次检查：" + java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US)
                .format(java.util.Date(cfg.update.lastCheck * 1000))
        } else {
            "还没检查过"
        },
        fontSize = 11.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { checkNow() }, enabled = !busy, modifier = Modifier.weight(1f)) {
            Text(if (busy) "处理中…" else "立即检查")
        }
        if (skipped.isNotEmpty()) {
            OutlinedButton(
                onClick = { Store.update { it.copy(update = it.update.copy(skippedVersion = "")) } },
                modifier = Modifier.weight(1f),
            ) { Text("取消跳过") }
        }
    }

    if (status.isNotEmpty()) {
        Text(
            status + if (progress in 1..99) "（$progress%）" else "",
            fontSize = 12.sp,
            color = if (isErr) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
        )
    }

    val r = res ?: return

    when {
        // ---- 校验失败：原话 + 错误码 ----
        !r.ok -> Text(
            r.message + if (r.code.isNotEmpty()) "（${r.code}）" else "",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.error,
        )

        // ---- 已是最新 ----
        !r.hasUpdate -> Text(
            if (r.latest.isNotEmpty() && r.latest == skipped) {
                "已跳过 v${r.latest}（有新版本时还会提醒）"
            } else {
                "已经是最新版本 v$current"
            },
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // ---- 有新版本 ----
        else -> Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("发现新版本 v${r.latest}", fontWeight = FontWeight.SemiBold)
                Text(
                    r.file + " · " + if (r.size > 0) "${r.size / 1024 / 1024} MB" else "大小未知" +
                        " · 平台 " + Updater.PLATFORM,
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "包名、类型、版本、sha256 四项都和更新清单核对过；对不上就不会下载。",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (r.notes.isNotBlank()) {
                    Text(
                        r.notes.take(600),
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (r.source == "asset-scan") {
                    Text(
                        "注意：这次发布没带更新清单，是按文件名兜底校验的。",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { download(r) }, enabled = !busy) { Text("下载并安装") }
                    OutlinedButton(
                        onClick = {
                            Store.update { it.copy(update = it.update.copy(skippedVersion = r.latest)) }
                        },
                        enabled = !busy,
                    ) { Text("跳过这个版本") }
                }
            }
        }
    }
}

/**
 * 交给系统安装器。Android 8+ 需要用户在系统里允许「安装未知应用」，
 * 缺这个权限时不要假装失败得莫名其妙——直接把用户带到那一页。
 */
private fun installApk(ctx: Context, apk: File) {
    if (!apk.exists()) {
        toast(ctx, "安装包已不存在，请重新下载")
        return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !ctx.packageManager.canRequestPackageInstalls()
    ) {
        toast(ctx, "请先允许「安装未知应用」，再点一次下载并安装")
        runCatching {
            ctx.startActivity(
                Intent(SysSettings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
        return
    }
    val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", apk)
    val i = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { ctx.startActivity(i) }
        .onFailure { toast(ctx, "打不开安装器：${it.message}") }
}

private fun appVersion(ctx: Context): String = runCatching {
    ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "0.1.0"
}.getOrDefault("0.1.0")

private fun defaultBackupName(): String =
    "kof-backup-" + java.text.SimpleDateFormat("yyyyMMdd-HHmm", java.util.Locale.US)
        .format(java.util.Date()) + ".kofbak"

// ---------------------------------------------------------------- 小部件

@Composable
private fun SectionTitle(text: String) {
    Spacer(Modifier.height(6.dp))
    Text(
        text,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
}

@Composable
private fun PermRow(title: String, sub: String, ok: Boolean, onFix: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .size(8.dp)
                .padding(0.dp),
        ) {
            Surface(
                color = if (ok) Color(0xFF3FBF7F) else MaterialTheme.colorScheme.secondary,
                shape = CircleShape,
                modifier = Modifier.size(8.dp),
            ) {}
        }
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            Text(sub, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (ok) {
            Text("已授予", fontSize = 12.sp, color = Color(0xFF3FBF7F))
        } else {
            TextButton(onClick = onFix) { Text("去授予") }
        }
    }
}

/** 二选一的模式按钮：选中的是实心，未选中的是描边 */
@Composable
private fun RowScope.ModeChoice(label: String, selected: Boolean, onClick: () -> Unit) {
    if (selected) {
        Button(onClick = onClick, modifier = Modifier.weight(1f)) { Text(label) }
    } else {
        OutlinedButton(onClick = onClick, modifier = Modifier.weight(1f)) { Text(label) }
    }
}

@Composable
private fun Stepper(label: String, value: Int, min: Int, max: Int, unit: String, onChange: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        TextButton(onClick = { onChange((value - 1).coerceAtLeast(min)) }, enabled = value > min) { Text("−") }
        Text("$value$unit", fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.width(64.dp))
        TextButton(onClick = { onChange((value + 1).coerceAtMost(max)) }, enabled = value < max) { Text("+") }
    }
}

internal fun notificationsAllowed(ctx: Context): Boolean {
    if (Build.VERSION.SDK_INT >= 33) {
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }
    return true
}

internal fun toast(ctx: Context, msg: String) {
    Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show()
}
