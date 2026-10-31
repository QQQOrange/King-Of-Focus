package com.qqqorange.kingoffocus.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.BackupSection
import com.qqqorange.kingoffocus.UpdateSection
import com.qqqorange.kingoffocus.appVersion
import com.qqqorange.kingoffocus.core.Caps
import com.qqqorange.kingoffocus.core.GuardEngine
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.core.SleepEngine
import com.qqqorange.kingoffocus.core.StrictBlocker
import com.qqqorange.kingoffocus.core.StrictFlow
import com.qqqorange.kingoffocus.data.CloudCfg
import com.qqqorange.kingoffocus.data.CloudSync
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.SleepSegment
import com.qqqorange.kingoffocus.data.Store
import com.qqqorange.kingoffocus.service.GuardService
import com.qqqorange.kingoffocus.core.KeepAlive
import com.qqqorange.kingoffocus.service.KofAccessibility
import com.qqqorange.kingoffocus.toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.runtime.collectAsState
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import com.qqqorange.kingoffocus.data.Portable
import com.qqqorange.kingoffocus.core.PermId
import com.qqqorange.kingoffocus.core.Permissions
import com.qqqorange.kingoffocus.ui.rememberNotificationRequester

/**
 * 设置页：所有"配置类"的东西都在这里，按主题分组，卡片内一行一个开关/数值。
 *
 * 顺序是有讲究的：先日常会调的（提醒、拦截、锁机、睡眠），再"配一次就不动"的
 * （云同步、备份、更新），最后是危险操作（重置）。
 */
@Composable
fun SettingsScreen(cfg: Config) {
    val ctx = LocalContext.current
    var confirmReset by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PageHeader("设置", "所有改动即时保存，不需要点确定")

        // ---------------- 通知 ----------------
        //
        // 四类通知各自独立可关：常驻状态 / 阶段结束前 / 任务完成 / 每日汇总。
        // 只有"总开关"会把它们一起关掉——单个用户不需要的就不该强迫接受。
        SectionTitle("通知")
        Panel {
            val askNotify = rememberNotificationRequester()
            val notifPerm = Permissions.item(ctx, cfg, PermId.NOTIFICATION)
            if (!notifPerm.ok) {
                // 通知权限被拒时，下面所有开关都是"看起来开着、其实发不出去"，
                // 所以先说清楚，再给一键去开启。
                Text(
                    notifPerm.hint,
                    fontSize = 11.sp,
                    lineHeight = 15.sp,
                    color = MaterialTheme.colorScheme.error,
                )
                TextButton(
                    onClick = { askNotify() },
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp),
                ) { Text("去开启通知", fontSize = 12.sp) }
                Spacer(Modifier.height(4.dp))
            }

            ToggleRow(
                "启用通知",
                "关掉后四类都不发；应用内状态与统计照常",
                cfg.notify.enabled,
            ) { v -> Store.update { it.copy(notify = it.notify.copy(enabled = v)) } }

            if (cfg.notify.enabled) {
                // —— 常驻 ——
                ToggleRow(
                    "常驻状态显示今日进度",
                    "通知栏里带「今日已自律 X / 计划 Y 分」和进度条；关掉只留当前状态",
                    cfg.notify.ongoingProgress,
                    divider = true,
                ) { v -> Store.update { it.copy(notify = it.notify.copy(ongoingProgress = v)) } }

                // —— 阶段结束前 ——
                Stepper("专注结束前提醒", cfg.notify.workBefore, 0, 120, " 分钟", step = 1) { v ->
                    Store.update { it.copy(notify = it.notify.copy(workBefore = v)) }
                }
                Stepper("休息结束前提醒", cfg.notify.breakBefore, 0, 120, " 分钟", step = 1) { v ->
                    Store.update { it.copy(notify = it.notify.copy(breakBefore = v)) }
                }
                ToggleRow("休息也提醒", null, cfg.notify.breakNotify, divider = true) { v ->
                    Store.update { it.copy(notify = it.notify.copy(breakNotify = v)) }
                }

                // —— 完成 ——
                ToggleRow(
                    "任务完成通知",
                    "专注段做完 / 休息结束的那一刻发一条，带今日累计",
                    cfg.notify.done,
                    divider = true,
                ) { v -> Store.update { it.copy(notify = it.notify.copy(done = v)) } }

                // —— 每日汇总 ——
                ToggleRow(
                    "每日使用汇总",
                    "每天固定时间汇总当天的使用时长与自律时长；当天没记录就不发",
                    cfg.notify.dailySummary,
                    divider = true,
                ) { v -> Store.update { it.copy(notify = it.notify.copy(dailySummary = v)) } }
                if (cfg.notify.dailySummary) {
                    Stepper("汇总时间", cfg.notify.dailyAt, 0, 23, " 点", step = 1) { v ->
                        Store.update { it.copy(notify = it.notify.copy(dailyAt = v)) }
                    }
                }

                Spacer(Modifier.height(4.dp))
                Text(
                    "系统设置里还能按渠道单独关（自律守护 / 阶段提醒 / 任务完成 / 每日使用汇总），"
                        + "那比这里的开关更彻底：关掉渠道后代码里发也不会出现。",
                    fontSize = 10.sp,
                    lineHeight = 14.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // ---------------- 拦截 ----------------
        SectionTitle("拦截")
        Panel {
            ToggleRow(
                "开启应用拦截",
                "打开被禁应用时：回到桌面 + 一条说明。不再盖全屏页面——那层遮罩在手机上盖不严，还容易让人以为卡死。",
                cfg.overlay.blockEnabled,
            ) { v -> Store.update { it.copy(overlay = it.overlay.copy(blockEnabled = v)) } }
        }

        // ---------------- 锁机 ----------------
        SectionTitle("锁机")
        Panel {
            ToggleRow(
                "锁机（回桌面 + 全屏遮罩）",
                "专注段里离开允许的应用：先回桌面，再盖上遮罩。不杀进程、不关机。",
                cfg.lock.enabled,
            ) { v ->
                Store.update { it.copy(lock = it.lock.copy(enabled = v)) }
                if (v && !android.provider.Settings.canDrawOverlays(ctx)) {
                    toast(ctx, "锁机需要「在其他应用上层显示」权限，去总览页授予")
                }
            }
            if (cfg.lock.enabled) {
                val strict = LockEngine.isStrict(cfg)
                // 三步确认的"当前第几步"：只是对话框的序号，**不进配置**。
                // 所以任何一步取消都没有中间态可以残留（0 = 没在进行）。
                var strictStep by remember { mutableStateOf(StrictFlow.IDLE) }
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ModeButton("温和模式", !strict, Modifier.weight(1f)) {
                        if (!LockEngine.canSwitchMode(cfg, java.time.LocalDateTime.now())) {
                            toast(ctx, "强制锁机进行中，不能切回温和模式；等这一段结束再改")
                        } else {
                            Store.update { it.copy(lock = it.lock.copy(mode = LockEngine.MODE_GENTLE)) }
                        }
                    }
                    ModeButton("强制模式", strict, Modifier.weight(1f)) {
                        if (strict) return@ModeButton
                        // 一点就开太轻了：先走三道确认，最后一步才写配置
                        strictStep = 1
                    }
                }
                Text(
                    if (strict) "强制模式：暂停与提前结束一律不生效，必须完整走完这一段。"
                    else "温和模式：可以花积分暂停（到点自动恢复）或提前结束这一段。",
                    fontSize = 10.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!strict) {
                    Stepper("暂停时长", cfg.lock.pauseMinutes, 1, 120, " 分钟", step = 5) { v ->
                        Store.update { it.copy(lock = it.lock.copy(pauseMinutes = v)) }
                    }
                    Stepper("暂停消耗", cfg.lock.pauseCost, 0, 500, " 分", step = 5) { v ->
                        Store.update { it.copy(lock = it.lock.copy(pauseCost = v)) }
                    }
                    Stepper("停止消耗", cfg.lock.stopCost, 0, 500, " 分", step = 5) { v ->
                        Store.update { it.copy(lock = it.lock.copy(stopCost = v)) }
                    }
                }
                // —— 锁机期间限制哪些应用 ——
                //
                // 两种模式互斥，不是叠加：整机锁 = 除白名单外全盖住；
                // 只按规则 = 有白名单就"只允许名单内"，只有黑名单就"只禁黑名单"。
                Text("锁机期间的限制范围", fontSize = 13.sp)
                Spacer(Modifier.height(4.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ModeButton("整机锁", cfg.lock.scope != "rules", Modifier.weight(1f)) {
                        Store.update { it.copy(lock = it.lock.copy(scope = "all")) }
                    }
                    ModeButton("只按规则", cfg.lock.scope == "rules", Modifier.weight(1f)) {
                        Store.update { it.copy(lock = it.lock.copy(scope = "rules")) }
                    }
                }
                Spacer(Modifier.height(4.dp))
                // 允许名单只有一份：白名单规则。这里只读展示，改的地方在「规则」页。
                val allowList = GuardEngine.allowedPackages(cfg)
                val hasWhite = GuardEngine.hasWhitelistRule(cfg)
                val hasBlack = cfg.rules.any { it.enabled && it.mode != "whitelist" }
                Text(
                    when {
                        cfg.lock.scope != "rules" && allowList.isEmpty() ->
                            "整机锁：除系统界面与输入法，其余一律挡住。要让某个应用能用，" +
                                "去「规则」页建一条白名单规则（名单内的应用锁机时照样能开）。"
                        cfg.lock.scope != "rules" ->
                            "整机锁：白名单里的 ${allowList.size} 个应用照样能用，其余一概挡住。"
                        hasWhite ->
                            "只按规则：只允许白名单里的 ${allowList.size} 个应用，其它一律挡住。"
                        hasBlack ->
                            "只按规则：没有白名单，所以按黑名单来——只有名单内的应用会被挡住，其余照常使用。"
                        else ->
                            "只按规则，但一条启用的规则都没有，等于锁机不拦任何应用。" +
                                "先去「规则」页建一条。"
                    },
                    fontSize = 10.5.sp,
                    lineHeight = 15.sp,
                    color = if (cfg.lock.scope == "rules" && !hasWhite && !hasBlack) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )

                // —— 提醒 ——
                Stepper("开始前提醒", cfg.lock.beforeMin, 0, 60, " 分钟", step = 1) { v ->
                    Store.update { it.copy(lock = it.lock.copy(beforeMin = v)) }
                }
                Text(
                    if (cfg.lock.beforeMin == 0) "0 = 不提前提醒，到点直接锁。"
                    else "锁机开始前 ${cfg.lock.beforeMin} 分钟提醒一次（每次锁机只提醒一次）。"
                        + "整机锁会打断导航、付款码这类事，留点收尾时间。",
                    fontSize = 10.5.sp,
                    lineHeight = 15.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(8.dp))
                Text("结束时提醒", fontSize = 13.sp)
                Spacer(Modifier.height(4.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("none" to "不提醒", "notify" to "通知", "dialog" to "弹窗", "both" to "两者").forEach { (k, label) ->
                        Box(Modifier.weight(1f)) {
                            ModeButton(label, cfg.lock.endNotice == k, Modifier.fillMaxWidth()) {
                                Store.update { it.copy(lock = it.lock.copy(endNotice = k)) }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
                val canDialog = canShowDialog(ctx)
                Text(
                    when {
                        cfg.lock.endNotice == "none" -> "到点结束时不提醒，遮罩自己消失。"
                        cfg.lock.endNotice == "notify" -> "结束时发一条通知（最稳，任何机型都能到）。"
                        !canDialog -> "选的是「${if (cfg.lock.endNotice == "both") "两者" else "弹窗"}」，" +
                            "但现在拿不到「悬浮窗」或 Shizuku，弹不出来——已降级成通知。去总览页授予后才会真弹。"
                        else -> "结束时盖一页「锁机结束」，10 秒后自己退场，点一下就关。"
                    },
                    fontSize = 10.5.sp,
                    lineHeight = 15.sp,
                    color = if (!canDialog && cfg.lock.endNotice != "notify" && cfg.lock.endNotice != "none") {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )

                // —— 三重确认 ——
                //
                // 三个窗口共用同一个对话框，靠 strictStep 决定显示哪一步：
                // 少写两套样式的重复，也让"第 2 步"不可能被跳过。
                if (strictStep != StrictFlow.IDLE) {
                    val step = strictStep
                    val blocker = capsOf(ctx).strictBlocker()
                    AlertDialog(
                        onDismissRequest = { strictStep = StrictFlow.IDLE },
                        title = { Text(StrictFlow.title(step), fontSize = 16.sp) },
                        text = {
                            Column {
                                Text(
                                    StrictFlow.body(step, LockEngine.longestSegmentMinutes(cfg)),
                                    fontSize = 13.sp,
                                    lineHeight = 20.sp,
                                )
                                if (step >= 2 && blocker != null) {
                                    Spacer(Modifier.height(8.dp))
                                    Text(
                                        "注意：现在缺「${when (blocker) {
                                            StrictBlocker.NO_FOREGROUND -> "使用情况访问 / 无障碍"
                                            StrictBlocker.NO_MASK -> "悬浮窗或 Shizuku"
                                            StrictBlocker.NO_APP_CONTROL -> "Shizuku"
                                        }}」，强制模式会打折：这仍然拦得住你，但拦不干净。",
                                        fontSize = 11.sp,
                                        lineHeight = 16.sp,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                }
                            }
                        },
                        confirmButton = {
                            TextButton(onClick = {
                                if (StrictFlow.enables(step, yes = true)) {
                                    strictStep = StrictFlow.IDLE
                                    Store.update { it.copy(lock = it.lock.copy(mode = LockEngine.MODE_STRICT)) }
                                    toast(ctx, "强制模式已开启：这一段结束前没有暂停与跳过")
                                } else {
                                    strictStep = StrictFlow.advance(step, yes = true)
                                }
                            }) { Text(StrictFlow.confirmLabel(step), fontSize = 13.sp) }
                        },
                        dismissButton = {
                            TextButton(onClick = {
                                // 取消：回到 IDLE。配置一个字都没改，所以不存在"回退到中间态"
                                strictStep = StrictFlow.advance(step, yes = false)
                            }) { Text(StrictFlow.cancelLabel(step), fontSize = 13.sp) }
                        },
                    )
                }

                ToggleRow(
                    "进入时震动一下",
                    "锁机 / 睡眠开始的那一刻短震（180ms）。关掉就完全静音进入。",
                    cfg.lock.vibrate,
                    divider = true,
                ) { v -> Store.update { it.copy(lock = it.lock.copy(vibrate = v)) } }
            }
        }

        // ---------------- 睡眠 ----------------
        SectionTitle("睡眠")
        Panel {
            ToggleRow(
                "睡眠时段",
                "到了这段就整机锁住（回桌面 + 遮罩），可以用积分解锁一小段。Android 无法关机。",
                cfg.sleep.enabled,
            ) { v -> Store.update { it.copy(sleep = it.sleep.copy(enabled = v)) } }
            if (cfg.sleep.enabled) {
                // 睡眠期间的锁机**不给关**：这段的功能就是"晚上手机不能用"，
                // 关掉之后它就只剩一条统计记录，"睡眠时段"这个名字就名不副实了。
                // 真要留一个口子，用下面的积分解锁（有代价、有上限、会自己结束）。
                Text(
                    "睡眠期间一定锁机（不给关）。可以用下面的积分解锁换一小段，"
                        + "比如起夜看时间——那是有代价、有上限、到点自动收回的。",
                    fontSize = 10.5.sp,
                    lineHeight = 15.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                cfg.sleep.segments.forEachIndexed { i, seg ->
                    SleepSegRow(
                        index = i,
                        seg = seg,
                        canRemove = cfg.sleep.segments.size > 1,
                        onChange = { ns ->
                            Store.update { c ->
                                c.copy(sleep = c.sleep.copy(segments = c.sleep.segments.toMutableList().also { it[i] = ns }))
                            }
                        },
                        onRemove = {
                            Store.update { c ->
                                c.copy(sleep = c.sleep.copy(segments = c.sleep.segments.filterIndexed { idx, _ -> idx != i }))
                            }
                        },
                    )
                }
                OutlinedButton(
                    onClick = {
                        Store.update { c ->
                            c.copy(sleep = c.sleep.copy(segments = c.sleep.segments + SleepSegment(1380, 420)))
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("+ 再加一段", fontSize = 12.sp) }

                Stepper("解锁时长", cfg.sleep.unlockMin, 1, 240, " 分钟", step = 5) { v ->
                    Store.update { it.copy(sleep = it.sleep.copy(unlockMin = v)) }
                }
                Stepper("每分钟价格", cfg.sleep.unlockPrice, 0, 20, " 分") { v ->
                    Store.update { it.copy(sleep = it.sleep.copy(unlockPrice = v)) }
                }
                Text(
                    if (cfg.sleep.unlockPrice == 0) "价格 0 = 睡眠时段不开放积分解锁。"
                    else "解锁一次要 ${SleepEngine.unlockPrice(cfg)} 分。",
                    fontSize = 10.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // ---------------- 云同步 ----------------
        SectionTitle("云同步")
        CloudSection(cfg)

        // ---------------- 备份 / 更新 ----------------
        SectionTitle("备份与恢复")
        BackupSection(cfg)

        SectionTitle("版本与更新")
        UpdateSection(cfg)

        // ---------------- 保活体检 ----------------
        SectionTitle("保活体检")
        KeepAliveSection(cfg)

        // ---------------- 数据 ----------------
        SectionTitle("数据")
        Panel {
            ToggleRow("记录使用时长", "关掉后不再采样，已有数据保留", cfg.stats.enabled) { v ->
                Store.update { it.copy(stats = it.stats.copy(enabled = v)) }
                // 统计和自律任意一个开着，服务就得跑（统计页的「时段外」全靠它）
                GuardService.sync(ctx)
            }
            if (cfg.stats.enabled) {
                // 与桌面端同名开关（stats.countIdle）。桌面用"最后一次键鼠输入"判断人还在不在，
                // 手机上没有这个 API，所以默认按"亮屏即算"；关掉则要求 60 秒内有过交互。
                ToggleRow(
                    "只看屏幕亮着",
                    "默认算到「亮屏且未锁屏」为止；关掉后还要求 60 秒内有过操作" +
                        if (KofAccessibility.alive()) "" else "（未授无障碍权限，这项暂时不生效）",
                    cfg.stats.countIdle,
                    divider = true,
                ) { v ->
                    Store.update { it.copy(stats = it.stats.copy(countIdle = v)) }
                }
                Stepper(
                    "保留天数",
                    cfg.stats.retentionDays,
                    7,
                    3650,
                    " 天",
                    step = 30,
                ) { v ->
                    Store.update { it.copy(stats = it.stats.copy(retentionDays = v)) }
                }
                Text(
                    "和桌面端同一个默认值 400 天：更久的数据才能回答「去年这个时候我在干什么」。",
                    fontSize = 10.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(6.dp))
            OutlinedButton(onClick = { confirmReset = true }, modifier = Modifier.fillMaxWidth()) {
                Text("重置全部配置", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
            }
        }

        SectionTitle("关于")
        Panel {
            InfoRow("版本", "Android ${appVersion(ctx)}")
            InfoRow("平台标识", "android")
            Text(
                "桌面版的「结束进程 / 关机 / 全局热键 / 网页拦截」在 Android 上不可实现，"
                    + "这里用「时段 + 番茄 + 前台检测 + 锁机」做等价的自律闭环。",
                fontSize = 10.5.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(10.dp))
    }

    if (confirmReset) {
        AlertDialog(
            onDismissRequest = { confirmReset = false },
            title = { Text("重置全部配置？") },
            text = { Text("规则、时段、睡眠、积分都会回到默认值。统计数据和备份文件不动。", fontSize = 13.sp) },
            confirmButton = {
                TextButton(onClick = {
                    Store.update { Config() }
                    // 重置后统计默认是开的，所以"服务是否该跑"要按新配置重算
                    GuardService.sync(ctx)
                    confirmReset = false
                    toast(ctx, "已重置为默认配置")
                }) { Text("重置", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmReset = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun ModeButton(label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    if (selected) {
        androidx.compose.material3.Button(onClick = onClick, modifier = modifier) {
            Text(label, fontSize = 12.sp)
        }
    } else {
        OutlinedButton(onClick = onClick, modifier = modifier) { Text(label, fontSize = 12.sp) }
    }
}

@Composable
private fun SleepSegRow(
    index: Int,
    seg: SleepSegment,
    canRemove: Boolean,
    onChange: (SleepSegment) -> Unit,
    onRemove: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("第 ${index + 1} 段", Modifier.weight(1f), fontSize = 13.sp)
            Text(SleepEngine.fmtSegment(seg), fontSize = 12.sp, color = MaterialTheme.colorScheme.secondary)
            if (canRemove) {
                TextButton(onClick = onRemove) { Text("删除", fontSize = 11.sp, color = MaterialTheme.colorScheme.error) }
            }
        }
        Stepper("起点", seg.from, 0, 1439, " 分", step = 30) { v -> onChange(seg.copy(from = v)) }
        Stepper("终点", seg.to, 0, 1440, " 分", step = 30) { v -> onChange(seg.copy(to = v)) }
        Text(
            "分钟数从 0 点算起：23:00 = 1380，07:00 = 420。终点小于起点就是跨夜。",
            fontSize = 10.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HLine()
    }
}

/**
 * 云同步：WebDAV。
 *
 * 与桌面端同一套做法（PUT/GET + 比 updatedAt），但**文件名不同**：
 * 手机和桌面的配置结构不一样，共用一份会互相写坏。
 */
@Composable
private fun CloudSection(cfg: Config) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var url by remember(cfg.cloud.url) { mutableStateOf(cfg.cloud.url) }
    var user by remember(cfg.cloud.user) { mutableStateOf(cfg.cloud.user) }
    var pass by remember(cfg.cloud.pass) { mutableStateOf(cfg.cloud.pass) }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf(cfg.cloud.lastStatus) }
    var entries by remember { mutableStateOf<List<CloudSync.Entry>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var picked by remember { mutableStateOf<CloudSync.Entry?>(null) }
    var confirmDelete by remember { mutableStateOf<CloudSync.Entry?>(null) }

    fun persist() {
        Store.update { c ->
            c.copy(cloud = c.cloud.copy(url = url.trim(), user = user.trim(), pass = pass))
        }
    }

    fun note(msg: String) {
        status = msg
        Store.update { c ->
            c.copy(
                cloud = c.cloud.copy(
                    lastStatus = msg,
                    lastSync = if (msg.startsWith("已")) System.currentTimeMillis() / 1000
                    else c.cloud.lastSync,
                ),
            )
        }
    }

    fun refresh() = scope.launch {
        busy = true
        status = "读取云端…"
        val r = withContext(Dispatchers.IO) {
            runCatching { CloudSync.list(Store.current.cloud) }
                .getOrElse { CloudSync.Outcome.Err("出错：${it.message ?: "未知错误"}") }
        }
        when (r) {
            is CloudSync.Outcome.Err -> note(r.message)
            is CloudSync.Outcome.Ok -> {
                entries = r.entries
                loaded = true
                status = if (r.entries.isEmpty()) "云端还没有备份" else "云端 ${r.entries.size} 份备份"
            }
        }
        busy = false
    }

    fun upload() {
        persist()
        scope.launch {
            busy = true
            status = "上传…"
            val msg = withContext(Dispatchers.IO) {
                runCatching {
                    val c = Store.current
                    val name = CloudSync.backupName()
                    // 载荷是**跨设备文档**（与桌面端同一份格式），不是手机自己的 config.json：
                    // 后者桌面读不懂，传上去也只是一份没人能用的文件。
                    val doc = Portable.toDoc(c, android.os.Build.MODEL ?: "Android", appVersion(ctx))
                    val body = Portable.seal(Portable.render(doc), c.backup.password)
                    when (val r = CloudSync.put(c.cloud, name, body)) {
                        is CloudSync.Outcome.Err -> r.message
                        is CloudSync.Outcome.Ok -> {
                            val hint = if (c.backup.password.isBlank()) {
                                "（明文，建议设置备份密码）"
                            } else {
                                ""
                            }
                            "已上传 $name$hint"
                        }
                    }
                }.getOrElse { "上传失败：${it.message ?: "未知错误"}" }
            }
            note(msg)
            busy = false
            if (msg.startsWith("已上传")) refresh()
        }
    }

    fun restore(entry: CloudSync.Entry, mode: String) {
        persist()
        scope.launch {
            busy = true
            status = if (mode == "merge") "正在合并…" else "正在覆盖…"
            val msg = withContext(Dispatchers.IO) {
                runCatching {
                    val c = Store.current
                    val text = when (val r = CloudSync.get(c.cloud, entry.name)) {
                        is CloudSync.Outcome.Err -> return@runCatching r.message
                        is CloudSync.Outcome.Ok -> r.text ?: ""
                    }
                    val plain = Portable.unlock(text, c.backup.password)
                    val parsed = Portable.parse(plain)
                    val base = Store.current
                    if (mode == "merge") {
                        val out = Portable.merge(parsed.doc, base)
                        if (out.stats.noop) {
                            "这份备份的内容本机都有了"
                        } else {
                            Store.update { out.config }
                            "合并完成：新增 ${out.stats.added} 条规则、补上 ${out.stats.slots} 个小时段"
                        }
                    } else {
                        val next = Portable.overwrite(parsed.doc, base)
                        Store.update { next }
                        "已用${entry.sourceLabel}的备份覆盖本机（${next.rules.size} 条规则）"
                    }
                }.getOrElse { "恢复失败：${it.message ?: "未知错误"}" }
            }
            note(msg)
            busy = false
            // 规则和时段可能整批换了，守护服务要按新配置重来一遍
            if (GuardService.shouldRun(Store.current)) runCatching { GuardService.start(ctx) }
        }
    }

    Panel {
        ToggleRow(
            "启用云同步",
            "与桌面端共用同一个 WebDAV 目录：手机传的备份桌面能恢复，桌面传的手机能恢复。",
            cfg.cloud.enabled,
        ) { v ->
            Store.update { it.copy(cloud = it.cloud.copy(enabled = v)) }
            if (v) {
                refresh()
            } else {
                entries = emptyList()
                loaded = false
            }
        }

        if (cfg.cloud.enabled) {
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("WebDAV 地址（目录）") },
                placeholder = { Text("https://dav.jianguoyun.com/dav/king-of-focus/") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            if (url.trim().startsWith("http://")) {
                Text(
                    "这个地址是明文 http：账号密码和备份内容在局域网里是可见的。能用 https 就用 https。",
                    fontSize = 10.sp,
                    lineHeight = 14.sp,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = user,
                    onValueChange = { user = it },
                    label = { Text("账号") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = pass,
                    onValueChange = { pass = it },
                    label = { Text("密码 / 应用密码") },
                    modifier = Modifier.weight(1f),
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { persist(); toast(ctx, "已保存") }, enabled = !busy) {
                    Text("保存", fontSize = 12.sp)
                }
                OutlinedButton(
                    onClick = {
                        persist()
                        scope.launch {
                            busy = true
                            status = "测试连接…"
                            val msg = withContext(Dispatchers.IO) {
                                when (val r = CloudSync.testConnection(Store.current.cloud)) {
                                    is CloudSync.Outcome.Ok -> "连接正常（能读能写）"
                                    is CloudSync.Outcome.Err -> r.message
                                }
                            }
                            note(msg)
                            busy = false
                        }
                    },
                    enabled = !busy,
                ) { Text("测试", fontSize = 12.sp) }
            }

            Spacer(Modifier.height(10.dp))
            Text("云端备份", fontSize = 12.5.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { upload() }, enabled = !busy) {
                    Text("上传本机", fontSize = 12.sp)
                }
                OutlinedButton(onClick = { refresh() }, enabled = !busy) {
                    Text("刷新列表", fontSize = 12.sp)
                }
            }

            if (loaded) {
                Spacer(Modifier.height(6.dp))
                if (entries.isEmpty()) {
                    Text(
                        "云端还没有备份。点「上传本机」传一份，桌面端在「备份 → 云端」里就能看到它。",
                        fontSize = 10.5.sp,
                        lineHeight = 15.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    entries.forEach { e ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable(enabled = !busy) { picked = e }
                                .padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(
                                Modifier
                                    .size(7.dp)
                                    .clip(CircleShape)
                                    .background(
                                        if (e.fromAndroid) MaterialTheme.colorScheme.primary
                                        else MaterialTheme.colorScheme.tertiary,
                                    ),
                            )
                            Spacer(Modifier.width(7.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    e.sourceLabel + " · " + e.timeLabel +
                                        if (e.auto) "（自动）" else "",
                                    fontSize = 12.sp,
                                )
                                Text(
                                    e.name + if (e.size > 0) " · ${e.size / 1024} KB" else "",
                                    fontSize = 9.5.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            TextButton(
                                onClick = { confirmDelete = e },
                                enabled = !busy,
                                contentPadding = PaddingValues(horizontal = 8.dp),
                            ) { Text("删除", fontSize = 11.sp) }
                        }
                    }
                }
            }

            Spacer(Modifier.height(4.dp))
            ToggleRow(
                "回到应用时自动备份",
                "只在配置有改动时上传，覆盖 $AUTO_HINT 这一份，不会堆积",
                cfg.cloud.auto,
                divider = true,
            ) { v -> Store.update { it.copy(cloud = it.cloud.copy(auto = v)) } }

            if (status.isNotBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(status, fontSize = 11.sp, color = MaterialTheme.colorScheme.primary)
            }
            if (cfg.cloud.lastSync > 0) {
                Text(
                    "上次成功：" + SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)
                        .format(Date(cfg.cloud.lastSync * 1000)),
                    fontSize = 10.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(2.dp))
            Text(
                "云端存的是 .kofbak 跨设备备份，两端格式与加密方式一致。"
                    + "「备份密码」在下面「备份与恢复」里填，两端要一样，否则解不开。",
                fontSize = 10.sp,
                lineHeight = 14.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    // —— 从云端恢复：合并 / 覆盖 ——
    picked?.let { e ->
        AlertDialog(
            onDismissRequest = { picked = null },
            title = { Text("从云端恢复？") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "${e.sourceLabel} · ${e.timeLabel}" + if (e.auto) "（自动备份）" else "",
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        "覆盖：用这份备份的规则、时段、积分替换本机，本机多出来的规则会消失。",
                        fontSize = 12.sp,
                    )
                    Text(
                        "合并：只补本机没有的规则和时段，已有的一律不改；同名不同内容的规则会改名并列。",
                        fontSize = 12.sp,
                    )
                }
            },
            confirmButton = {
                Row {
                    TextButton(onClick = { picked = null; restore(e, "merge") }) { Text("合并") }
                    TextButton(onClick = { picked = null; restore(e, "overwrite") }) { Text("覆盖") }
                }
            },
            dismissButton = {
                TextButton(onClick = { picked = null }) { Text("取消") }
            },
        )
    }

    // —— 删除云端备份（不可撤销，二次确认） ——
    confirmDelete?.let { e ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("删除云端这份备份？") },
            text = {
                Text(
                    "${e.name} 会从网盘上删掉，本机配置不受影响。删了就找不回来了。",
                    fontSize = 12.sp,
                )
            },
            confirmButton = {
                Button(onClick = {
                    confirmDelete = null
                    scope.launch {
                        busy = true
                        val msg = withContext(Dispatchers.IO) {
                            when (val r = CloudSync.delete(Store.current.cloud, e.name)) {
                                is CloudSync.Outcome.Err -> r.message
                                is CloudSync.Outcome.Ok -> "已删除 ${e.name}"
                            }
                        }
                        note(msg)
                        busy = false
                        refresh()
                    }
                }) { Text("删除") }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = null }) { Text("取消") }
            },
        )
    }
}

/** 自动备份的文件名，写在提示里和实际用的保持一致 */
private const val AUTO_HINT = "kof-auto-android.kofbak"

/**
 * 保活体检：逐项列出权限/系统设置的状态，展开能看到"用途 / 申请时机 / 缺了会怎样"。
 *
 * 为什么默认折叠：这一屏有 6 项，每项三行说明会把页面撑爆；
 * 而用户真正需要先看到的是"哪几项没开"。
 */
@Composable
private fun KeepAliveSection(cfg: Config) {
    val ctx = LocalContext.current
    val tick by UiTick.n.collectAsState()
    var open by remember { mutableStateOf<String?>(null) }
    var confirmRestart by remember { mutableStateOf(false) }

    val items = remember(tick, cfg.enabled, cfg.stats.enabled) { KeepAlive.audit(ctx, cfg) }
    val running = remember(tick) { KeepAlive.isServiceRunning(ctx) }
    val should = GuardService.shouldRun(cfg)

    Panel {
        Text(
            KeepAlive.healthLine(ctx, cfg),
            fontSize = 11.5.sp,
            color = if (running || !should) MaterialTheme.colorScheme.onSurface
            else MaterialTheme.colorScheme.error,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "自律与统计都靠一个常驻前台服务。它被系统清掉时，时段不再判定、规则不再拦截、"
                + "统计也不再记录——所以下面这些项缺一不可。",
            fontSize = 10.5.sp,
            lineHeight = 15.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))

        items.forEach { item ->
            val expanded = open == item.title
            Column(
                Modifier
                    .fillMaxWidth()
                    .clickable { open = if (expanded) null else item.title }
                    .padding(vertical = 6.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .size(7.dp)
                            .clip(CircleShape)
                            .background(
                                if (item.ok) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.error,
                            ),
                    )
                    Spacer(Modifier.width(7.dp))
                    Text(
                        item.title,
                        fontSize = 12.5.sp,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        if (item.ok) "已就绪" else "缺失",
                        fontSize = 10.5.sp,
                        color = if (item.ok) MaterialTheme.colorScheme.onSurfaceVariant
                        else MaterialTheme.colorScheme.error,
                    )
                }
                if (expanded) {
                    Spacer(Modifier.height(5.dp))
                    Text("用途：" + item.purpose, fontSize = 10.5.sp, lineHeight = 15.sp)
                    Text(
                        "申请时机：" + item.whenAsk,
                        fontSize = 10.5.sp,
                        lineHeight = 15.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "缺失影响：" + item.impact,
                        fontSize = 10.5.sp,
                        lineHeight = 15.sp,
                        color = MaterialTheme.colorScheme.error,
                    )
                    if (!item.ok) {
                        Spacer(Modifier.height(4.dp))
                        OutlinedButton(
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                                horizontal = 10.dp, vertical = 2.dp,
                            ),
                            onClick = {
                                item.action?.let { runCatching { ctx.startActivity(it) } }
                                toast(ctx, "按提示开启后回到本页，状态会自动刷新")
                            },
                        ) { Text("去开启", fontSize = 11.5.sp) }
                    }
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { confirmRestart = true }) {
                Text("重启守护", fontSize = 12.sp)
            }
            OutlinedButton(onClick = { UiTick.bump() }) {
                Text("重新体检", fontSize = 12.sp)
            }
        }
    }

    if (confirmRestart) {
        AlertDialog(
            onDismissRequest = { confirmRestart = false },
            title = { Text("重启守护服务？") },
            text = {
                Text(
                    "会把常驻服务重新拉起来，并重新排上心跳与周期任务。"
                        + "正在进行的专注段不受影响（状态是从配置现算的）。",
                    fontSize = 13.sp,
                )
            },
            confirmButton = {
                Button(onClick = {
                    confirmRestart = false
                    runCatching { GuardService.stop(ctx) }
                    runCatching { GuardService.sync(ctx) }
                    KeepAlive.ensureService(ctx, Store.current)
                    UiTick.bump()
                    toast(ctx, "已请求重启守护")
                }) { Text("重启") }
            },
            dismissButton = { TextButton(onClick = { confirmRestart = false }) { Text("取消") } },
        )
    }
}

/** 当前能力矩阵：强制模式确认框用它提示"会打折" */
private fun capsOf(ctx: android.content.Context): Caps = Caps(
    accessibility = KofAccessibility.alive(),
    shizuku = com.qqqorange.kingoffocus.core.ShizukuBridge.ready(),
    usageStats = GuardEngine.hasUsageAccess(ctx),
    overlay = android.provider.Settings.canDrawOverlays(ctx),
)

/** 现在有没有能力从后台拉起一个界面（悬浮窗或 Shizuku 之一）：结束弹窗要靠它 */
private fun canShowDialog(ctx: android.content.Context): Boolean =
    android.provider.Settings.canDrawOverlays(ctx) ||
        com.qqqorange.kingoffocus.core.ShizukuBridge.ready()
