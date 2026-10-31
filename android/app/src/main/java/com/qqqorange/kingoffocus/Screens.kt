package com.qqqorange.kingoffocus

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.data.AppInfo

@Composable
internal fun AppPickerDialog(selected: List<String>, onDismiss: () -> Unit, onConfirm: (List<String>) -> Unit) {
    val ctx = androidx.compose.ui.platform.LocalContext.current
    val apps = remember { loadLaunchableApps(ctx) }
    var query by remember { mutableStateOf("") }
    val picked = remember { mutableStateOf(selected.toSet()) }
    val shown = apps.filter {
        query.isBlank() || it.label.contains(query, ignoreCase = true) || it.pkg.contains(query, ignoreCase = true)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("选择应用") },
        text = {
            Column {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text("搜索") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Spacer(Modifier.height(8.dp))
                LazyColumn(Modifier.height(360.dp)) {
                    items(shown, key = { it.pkg }) { a ->
                        val on = a.pkg in picked.value
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    picked.value = if (on) picked.value - a.pkg else picked.value + a.pkg
                                }
                                .padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Switch(
                                checked = on,
                                onCheckedChange = { v ->
                                    picked.value = if (v) picked.value + a.pkg else picked.value - a.pkg
                                },
                            )
                            Spacer(Modifier.width(10.dp))
                            Column {
                                Text(a.label, fontSize = 13.sp)
                                Text(a.pkg, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(picked.value.toList()) }) { Text("确定（${picked.value.size}）") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

/** 只列有启动图标的应用：系统组件、服务类包名对"自律"没有意义 */
internal fun loadLaunchableApps(ctx: Context): List<AppInfo> {
    val pm = ctx.packageManager
    val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    return runCatching {
        pm.queryIntentActivities(intent, 0)
            .mapNotNull { ri ->
                val pkg = ri.activityInfo?.packageName ?: return@mapNotNull null
                if (pkg == ctx.packageName) return@mapNotNull null
                AppInfo(pkg, ri.loadLabel(pm).toString())
            }
            .distinctBy { it.pkg }
            .sortedBy { it.label }
    }.getOrDefault(emptyList())
}
