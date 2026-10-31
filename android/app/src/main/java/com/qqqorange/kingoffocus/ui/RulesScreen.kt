package com.qqqorange.kingoffocus.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
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
import com.qqqorange.kingoffocus.AppPickerDialog
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Rule
import com.qqqorange.kingoffocus.data.Store
import java.util.UUID

/**
 * 自律规则：可以有多条，各自独立开关。
 *
 * 每条规则 = 一份名单 + 黑/白模式 + 是否固化。手机端没有"规则自己的时间表"，
 * 什么时候生效统一由「自律时段」决定（和桌面端重构后的模型一致）。
 */
@Composable
fun RulesScreen(cfg: Config) {
    var editing by remember { mutableStateOf<Rule?>(null) }
    var showPicker by remember { mutableStateOf(false) }

    fun newRule(): Rule = Rule(
        id = UUID.randomUUID().toString().take(8),
        name = "新规则 ${cfg.rules.size + 1}",
        mode = "blacklist",
        packages = emptyList(),
        hard = true,
    )

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        PageHeader("自律规则", "名单里的应用在专注段不可用；白名单模式只允许名单内")

        OutlinedButton(onClick = { editing = newRule() }, modifier = Modifier.fillMaxWidth()) {
            Text("新建一条规则")
        }

        if (cfg.rules.isEmpty()) {
            Panel { EmptyHint("还没有规则。新建一条，把想拦的应用加进去。") }
        }

        cfg.rules.forEach { r ->
            Panel {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(r.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(3.dp))
                        Text(
                            (if (r.mode == "whitelist") "白名单 · 只允许名单内" else "黑名单 · 名单内禁止") +
                                " · ${r.packages.size} 个应用" + if (r.hard) " · 固化" else "",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = r.enabled,
                        onCheckedChange = { v ->
                            Store.update { c ->
                                c.copy(rules = c.rules.map { if (it.id == r.id) it.copy(enabled = v) else it })
                            }
                        },
                    )
                }

                if (r.foreign.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "另有 ${r.foreign.size} 个桌面条目（网站 / exe 路径），手机端不拦，备份回桌面时原样带回",
                        fontSize = 10.5.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { editing = r }) { Text("编辑", fontSize = 12.sp) }
                    OutlinedButton(onClick = {
                        val copy = r.copy(id = UUID.randomUUID().toString().take(8), name = r.name + " 副本")
                        Store.update { c -> c.copy(rules = c.rules + copy) }
                    }) { Text("复制", fontSize = 12.sp) }
                    OutlinedButton(onClick = {
                        Store.update { c -> c.copy(rules = c.rules.filterNot { it.id == r.id }) }
                    }) { Text("删除", fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }
                }
            }
        }
        Spacer(Modifier.height(6.dp))
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
                    singleLine = true,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("模式", Modifier.width(42.dp), fontSize = 13.sp)
                    OutlinedButton(onClick = { mode = if (mode == "blacklist") "whitelist" else "blacklist" }) {
                        Text(if (mode == "blacklist") "黑名单（名单内禁止）" else "白名单（只允许名单内）", fontSize = 12.sp)
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("固化", fontSize = 13.sp)
                        Text(
                            "生效期间不允许关闭自律、不允许改设置",
                            fontSize = 10.5.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(checked = hard, onCheckedChange = { hard = it })
                }
                OutlinedButton(onClick = onPickApps, modifier = Modifier.fillMaxWidth()) {
                    Text("选择应用（已选 ${rule.packages.size} 个）", fontSize = 12.sp)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onSave(rule.copy(name = name.ifBlank { "未命名" }, mode = mode, hard = hard))
            }) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}
