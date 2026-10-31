package com.qqqorange.kingoffocus.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.core.PermId
import com.qqqorange.kingoffocus.core.PermItem
import com.qqqorange.kingoffocus.core.PermState
import com.qqqorange.kingoffocus.core.Permissions
import com.qqqorange.kingoffocus.data.Store

/**
 * 权限清单的渲染 + 「申请一次」的入口。
 *
 * 为什么单独一个文件：
 *  · `core/Permissions` 是数据源，这里只负责画——总览页和设置页共用同一套；
 *  · 通知权限的申请要把「问过几次 / 是否永久拒绝」写回配置，两处必须走同一条流程，
 *    否则会出现「总览页弹过了、设置页又弹一次」，而第二次系统根本不显示弹窗。
 */
@Composable
fun rememberNotificationRequester(onResult: (Boolean) -> Unit = {}): () -> Unit {
    val ctx = LocalContext.current
    val activity = ctx.findActivity()
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        // 拒绝之后系统返回 false = 再也不会弹了，只能去设置里开。
        // 这个判断需要 Activity，所以只能在这里做。
        val blocked = !granted && !Permissions.canAskNotification(activity)
        Store.update { c ->
            c.copy(perm = Permissions.noteNotificationResult(c.perm, granted, blocked))
        }
        UiTick.bump()
        if (!granted) {
            // 已经拒绝：再弹也不会出现，直接带用户去设置
            runCatching { ctx.startActivity(notifySettingsIntent(ctx)) }
        }
        onResult(granted)
    }
    return {
        val cfg = Store.current
        when {
            // 永久拒绝：连弹窗都不会出现，别白弹
            cfg.perm.notifBlocked -> runCatching { ctx.startActivity(notifySettingsIntent(ctx)) }
            Build.VERSION.SDK_INT >= 33 -> launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
            // 13 之前安装即得，用户只能去设置里关；这里直接跳设置
            else -> runCatching { ctx.startActivity(notifySettingsIntent(ctx)) }
        }
    }
}

fun notifySettingsIntent(ctx: Context): Intent =
    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

/** Context 可能被层层包着（Compose 的 LocalContext 不一定是 Activity） */
fun Context.findActivity(): Activity? {
    var c: Context = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}

/**
 * 权限清单：一行一项，点一下展开看「用途 / 申请时机 / 申请方式 / 缺失影响 / 降级 / 重新授权」。
 *
 * 默认折叠的理由和保活体检一样：七项各五六行说明会把页面撑爆，
 * 而用户先要看到的是「哪几项没开」。
 */
@Composable
fun PermList(
    items: List<PermItem>,
    open: PermId?,
    onToggle: (PermId) -> Unit,
    onFix: (PermItem) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth()) {
        items.forEach { item ->
            val expanded = open == item.spec.id
            Column(
                Modifier
                    .fillMaxWidth()
                    // 展开状态由调用方持有：这个列表挂在每秒都会重组的页面上，
                    // 放在内部 remember 里会被"每秒一次的重组"重置（点了没反应）。
                    .clickable { onToggle(item.spec.id) }
                    .padding(vertical = 7.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .size(8.dp)
                            .background(dotColor(item.state), CircleShape),
                    )
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(item.spec.title, fontSize = 13.5.sp)
                        Spacer(Modifier.height(2.dp))
                        Text(
                            item.hint,
                            fontSize = 10.5.sp,
                            lineHeight = 14.sp,
                            color = if (item.state == PermState.OK || item.state == PermState.NOT_NEEDED) {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            } else {
                                MaterialTheme.colorScheme.error
                            },
                        )
                    }
                    if (item.ok) {
                        Text(
                            if (item.state == PermState.NOT_NEEDED) "不需要" else "已授予",
                            fontSize = 11.sp,
                            color = if (item.state == PermState.NOT_NEEDED) {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            } else {
                                Color(0xFF34C759)
                            },
                        )
                    } else {
                        TextButton(onClick = { onFix(item) }) { Text("去开启", fontSize = 12.sp) }
                    }
                }
                if (expanded) {
                    Spacer(Modifier.height(6.dp))
                    DocLine("用途", item.spec.why)
                    DocLine("申请时机", item.spec.whenAsk)
                    DocLine("申请方式", item.spec.howAsk)
                    DocLine("缺失影响", item.spec.impact, warn = true)
                    DocLine("降级方案", item.spec.fallback)
                    if (item.spec.regrant != "—") DocLine("重新授权", item.spec.regrant)
                }
            }
        }
    }
}

/** 一条「标签：内容」；标签固定宽度对齐，扫读更快 */
@Composable
private fun DocLine(label: String, text: String, warn: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        Text(
            label,
            fontSize = 10.5.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(56.dp),
        )
        Text(
            text,
            fontSize = 10.5.sp,
            lineHeight = 15.sp,
            color = if (warn) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
    }
}

private fun dotColor(state: PermState): Color = when (state) {
    PermState.OK -> Color(0xFF34C759)
    PermState.NOT_NEEDED -> Color(0xFF9E9E9E)
    else -> Color(0xFFFF5C5C)
}
