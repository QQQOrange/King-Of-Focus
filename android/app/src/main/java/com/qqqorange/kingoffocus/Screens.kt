package com.qqqorange.kingoffocus

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.data.AppInfo
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.Rule
import com.qqqorange.kingoffocus.data.Store
import java.util.UUID

private val DAY_NAMES = listOf("一", "二", "三", "四", "五", "六", "日")

// ---------------------------------------------------------------- 时段

@Composable
internal fun SchedulePage(cfg: Config) {
    var work by remember { mutableStateOf(cfg.defWork) }
    var brk by remember { mutableStateOf(cfg.defBrk) }
    val selectedToday = cfg.days.getOrNull(java.time.LocalDate.now().dayOfWeek.value - 1)
        ?.count { it.on } ?: 0

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("自律时段", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(
            "点亮的小时会生效：专注 N 分钟 → 休息 M 分钟循环，休息段不拦截。",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("新选中格子的番茄", Modifier.weight(1f), fontSize = 13.sp)
            TextButton(onClick = { work = (work - 5).coerceAtLeast(1) }) { Text("−") }
            Text("$work", fontSize = 13.sp, modifier = Modifier.width(28.dp))
            TextButton(onClick = { work = (work + 5).coerceIn(1, 59) }) { Text("+") }
            Text("/", fontSize = 13.sp)
            TextButton(onClick = { brk = (brk - 5).coerceAtLeast(1) }) { Text("−") }
            Text("$brk", fontSize = 13.sp, modifier = Modifier.width(28.dp))
            TextButton(onClick = { brk = (brk + 5).coerceIn(1, 59) }) { Text("+") }
        }

        // 7 天 × 24 小时
        cfg.days.forEachIndexed { d, hours ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(DAY_NAMES[d], fontSize = 11.sp, modifier = Modifier.width(14.dp))
                hours.forEachIndexed { h, p ->
                    Box(
                        Modifier
                            .weight(1f)
                            .aspectRatio(1f)
                            .padding(1.dp)
                            .background(
                                color = if (p.on) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.surfaceVariant,
                                shape = RoundedCornerShape(3.dp),
                            )
                            .clickable {
                                Store.update { c ->
                                    val days = c.days.map { it.toMutableList() }.toMutableList()
                                    val old = days[d][h]
                                    days[d][h] = if (!old.on) {
                                        HourPlan(true, work, brk, 0, 60)
                                    } else {
                                        old.copy(on = false)
                                    }
                                    c.copy(days = days, defWork = work, defBrk = brk)
                                }
                            },
                    )
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = {
                    Store.update { c ->
                        val days = c.days.map { it.toMutableList() }.toMutableList()
                        for (h in 0 until 24) days[0][h] = HourPlan(true, work, brk, 0, 60)
                        c.copy(days = days)
                    }
                },
            ) { Text("周一全天") }
            OutlinedButton(
                onClick = {
                    Store.update { c ->
                        val days = c.days.map { it.toMutableList() }.toMutableList()
                        for (h in 0 until 24) days[0][h] = HourPlan(false, work, brk, 0, 60)
                        c.copy(days = days)
                    }
                },
            ) { Text("清空周一") }
        }
        Text(
            "今天已选 $selectedToday 小时。目前只支持整小时（桌面版的分钟级收窄没有搬过来）。",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
    }
}

// ---------------------------------------------------------------- 规则

@Composable
internal fun RulesPage(cfg: Config) {
    var editing by remember { mutableStateOf<Rule?>(null) }
    var showPicker by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxSize()
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("自律规则", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text(
                    "名单里的应用在专注段不可用；白名单模式则只允许名单内。",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Button(onClick = {
                editing = Rule(
                    id = UUID.randomUUID().toString(),
                    name = "新规则",
                    mode = "blacklist",
                    packages = emptyList(),
                    hard = true,
                )
            }) { Text("新建") }
        }

        if (cfg.rules.isEmpty()) {
            Text(
                "还没有规则。新建一条，把想拦的应用加进去。",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp),
            )
        }

        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(cfg.rules, key = { it.id }) { r ->
                Card {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                r.name,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.weight(1f),
                            )
                            Switch(
                                checked = r.enabled,
                                onCheckedChange = { v ->
                                    Store.update { c ->
                                        c.copy(rules = c.rules.map { if (it.id == r.id) it.copy(enabled = v) else it })
                                    }
                                },
                            )
                        }
                        Text(
                            (if (r.mode == "whitelist") "白名单 · 只允许名单内" else "黑名单 · 名单内禁止") +
                                " · ${r.packages.size} 个应用" + if (r.hard) " · 固化" else "",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = { editing = r }) { Text("编辑") }
                            OutlinedButton(onClick = {
                                Store.update { c -> c.copy(rules = c.rules.filterNot { it.id == r.id }) }
                            }) { Text("删除") }
                        }
                    }
                }
            }
        }
    }

    val cur = editing
    if (cur != null) {
        RuleDialog(
            rule = cur,
            onPickApps = { showPicker = true },
            onDismiss = { editing = null },
            onSave = { updated ->
                Store.update { c ->
                    val exists = c.rules.any { it.id == updated.id }
                    c.copy(rules = if (exists) c.rules.map { if (it.id == updated.id) updated else it } else c.rules + updated)
                }
                editing = null
            },
        )
    }

    if (showPicker && cur != null) {
        AppPickerDialog(
            selected = cur.packages,
            onDismiss = { showPicker = false },
            onConfirm = { pkgs ->
                editing = cur.copy(packages = pkgs)
                showPicker = false
            },
        )
    }
}

@Composable
private fun RuleDialog(
    rule: Rule,
    onPickApps: () -> Unit,
    onDismiss: () -> Unit,
    onSave: (Rule) -> Unit,
) {
    var name by remember { mutableStateOf(rule.name) }
    var mode by remember { mutableStateOf(rule.mode) }
    var hard by remember { mutableStateOf(rule.hard) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("编辑规则") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("名称") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("模式", Modifier.width(48.dp), fontSize = 13.sp)
                    OutlinedButton(
                        onClick = { mode = if (mode == "blacklist") "whitelist" else "blacklist" },
                    ) { Text(if (mode == "blacklist") "黑名单（名单内禁止）" else "白名单（只允许名单内）") }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("固化", fontSize = 13.sp)
                        Text(
                            "生效期间不允许关闭自律、不允许改设置",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(checked = hard, onCheckedChange = { hard = it })
                }
                OutlinedButton(onClick = onPickApps, modifier = Modifier.fillMaxWidth()) {
                    Text("选择应用（已选 ${rule.packages.size} 个）")
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(rule.copy(name = name.ifBlank { "未命名" }, mode = mode, hard = hard)) }) {
                Text("保存")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun AppPickerDialog(selected: List<String>, onDismiss: () -> Unit, onConfirm: (List<String>) -> Unit) {
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
