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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.BackupSection
import com.qqqorange.kingoffocus.UpdateSection
import com.qqqorange.kingoffocus.appVersion
import com.qqqorange.kingoffocus.core.GuardEngine
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.core.SleepEngine
import com.qqqorange.kingoffocus.data.CloudCfg
import com.qqqorange.kingoffocus.data.CloudSync
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.SleepSegment
import com.qqqorange.kingoffocus.data.Store
import com.qqqorange.kingoffocus.service.GuardService
import com.qqqorange.kingoffocus.service.KofAccessibility
import com.qqqorange.kingoffocus.toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

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

        // ---------------- 提醒 ----------------
        SectionTitle("提醒")
        Panel {
            ToggleRow("启用提醒", "在阶段结束前提醒你", cfg.notify.enabled) { v ->
                Store.update { it.copy(notify = it.notify.copy(enabled = v)) }
            }
            Stepper("专注结束前", cfg.notify.workBefore, 0, 120, " 分钟", step = 1) { v ->
                Store.update { it.copy(notify = it.notify.copy(workBefore = v)) }
            }
            Stepper("休息结束前", cfg.notify.breakBefore, 0, 120, " 分钟", step = 1) { v ->
                Store.update { it.copy(notify = it.notify.copy(breakBefore = v)) }
            }
            ToggleRow("休息也提醒", null, cfg.notify.breakNotify, divider = true) { v ->
                Store.update { it.copy(notify = it.notify.copy(breakNotify = v)) }
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
                Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ModeButton("温和模式", !strict, Modifier.weight(1f)) {
                        if (!LockEngine.canSwitchMode(cfg, java.time.LocalDateTime.now())) {
                            toast(ctx, "强制锁机进行中，不能切回温和模式；等这一段结束再改")
                        } else {
                            Store.update { it.copy(lock = it.lock.copy(mode = LockEngine.MODE_GENTLE)) }
                        }
                    }
                    ModeButton("强制模式", strict, Modifier.weight(1f)) {
                        Store.update { it.copy(lock = it.lock.copy(mode = LockEngine.MODE_STRICT)) }
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
                // 允许名单只有一份：白名单规则。这里只读展示，改的地方在「规则」页。
                val allowList = GuardEngine.allowedPackages(cfg)
                Text(
                    if (allowList.isEmpty()) {
                        "允许使用的应用：还没有。锁机期间除系统界面与输入法，其余一律挡住；" +
                            "要让某个应用能用，去「规则」页建一条白名单规则。"
                    } else {
                        "允许使用的应用：${allowList.size} 个，来自「规则」页的白名单。" +
                            "遮罩上的可点列表和这里的拦截判定读的是同一份，不会两处打架。"
                    },
                    fontSize = 10.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
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
                ToggleRow("锁屏", "关掉只算统计、不锁", cfg.sleep.lockScreen, divider = true) { v ->
                    Store.update { it.copy(sleep = it.sleep.copy(lockScreen = v)) }
                }

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

    val json = remember {
        Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
            prettyPrint = false
        }
    }

    fun persist(extra: CloudCfg.() -> CloudCfg = { this }) {
        Store.update { c ->
            c.copy(cloud = c.cloud.copy(url = url, user = user, pass = pass).extra())
        }
    }

    fun run(label: String, block: () -> String) = scope.launch {
        busy = true
        status = "$label…"
        val msg = withContext(Dispatchers.IO) { runCatching(block).getOrElse { "出错：${it.message}" } }
        status = msg
        Store.update { c ->
            c.copy(
                cloud = c.cloud.copy(
                    lastStatus = msg,
                    lastSync = if (msg.startsWith("已")) System.currentTimeMillis() / 1000 else c.cloud.lastSync,
                ),
            )
        }
        busy = false
    }

    Panel {
        ToggleRow(
            "启用云同步",
            "只同步本机配置（规则/时段/积分）。备份文件请用下面的「备份与恢复」。",
            cfg.cloud.enabled,
        ) { v -> Store.update { it.copy(cloud = it.cloud.copy(enabled = v)) } }

        if (cfg.cloud.enabled) {
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("WebDAV 地址（目录）") },
                placeholder = { Text("https://dav.jianguoyun.com/dav/king-of-focus/") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = user,
                onValueChange = { user = it },
                label = { Text("账号") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = pass,
                onValueChange = { pass = it },
                label = { Text("密码 / 应用密码") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
            )
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { persist(); toast(ctx, "已保存") }, enabled = !busy) {
                    Text("保存", fontSize = 12.sp)
                }
                OutlinedButton(
                    onClick = { persist(); run("测试连接") { when (val r = CloudSync.testConnection(Store.current.cloud)) {
                        is CloudSync.Outcome.Ok -> "连接正常"
                        is CloudSync.Outcome.Err -> r.message
                    } } },
                    enabled = !busy,
                ) { Text("测试", fontSize = 12.sp) }
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = {
                        persist()
                        run("上传") {
                            val c = Store.current
                            // 凭据不上云：密码留在本机
                            val safe = c.copy(
                                cloud = c.cloud.copy(pass = "", lastStatus = ""),
                                backup = c.backup.copy(password = ""),
                            )
                            when (val r = CloudSync.upload(Store.current.cloud, json.encodeToString(Config.serializer(), safe))) {
                                is CloudSync.Outcome.Ok -> "已上传（v${appVersion(ctx)}）"
                                is CloudSync.Outcome.Err -> r.message
                            }
                        }
                    },
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                ) { Text("上传本机", fontSize = 12.sp) }
                OutlinedButton(
                    onClick = {
                        persist()
                        run("下载") {
                            val cloud = Store.current.cloud
                            when (val r = CloudSync.download(cloud)) {
                                is CloudSync.Outcome.Err -> r.message
                                is CloudSync.Outcome.Ok -> {
                                    val text = r.text ?: ""
                                    val remote = runCatching { json.decodeFromString(Config.serializer(), text) }
                                        .getOrElse { return@run "云端文件读不懂，已放弃（本机没变）" }
                                    when (CloudSync.decide(Store.current.updatedAt, remote.updatedAt)) {
                                        CloudSync.Side.SAME -> "两边一样，不需要同步"
                                        CloudSync.Side.LOCAL -> "本机更新，先上传再下载"
                                        CloudSync.Side.REMOTE -> {
                                            // 凭据与平台专属设置仍以本机为准
                                            val local = Store.current
                                            val merged = remote.copy(
                                                cloud = local.cloud.copy(
                                                    url = local.cloud.url,
                                                    user = local.cloud.user,
                                                    pass = local.cloud.pass,
                                                    enabled = true,
                                                ),
                                                update = local.update,
                                                stats = local.stats,
                                            )
                                            Store.save(merged)
                                            "已下载并覆盖本机（远端 ${SimpleDateFormat("MM-dd HH:mm", Locale.US).format(Date(remote.updatedAt * 1000))}）"
                                        }
                                    }
                                }
                            }
                        }
                    },
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                ) { Text("下载覆盖", fontSize = 12.sp) }
            }
            if (status.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(status, fontSize = 11.sp, color = MaterialTheme.colorScheme.primary)
            }
            if (cfg.cloud.lastSync > 0) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "上次同步：" + SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date(cfg.cloud.lastSync * 1000)),
                    fontSize = 10.5.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Text(
                "同一个 WebDAV 目录下，手机写 kof-android.json，桌面写它自己的配置文件，互不覆盖。",
                fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
