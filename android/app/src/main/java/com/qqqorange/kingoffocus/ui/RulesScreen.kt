package com.qqqorange.kingoffocus.ui

import androidx.compose.foundation.background
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.AppPickerDialog
import com.qqqorange.kingoffocus.toast
import com.qqqorange.kingoffocus.core.ScheduleEngine
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
    /** 这次打开选择器是选"允许名单"还是"禁止名单" */
    var pickerTarget by remember { mutableStateOf("allow") }

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

        // 自律时段内**规则与时段都只读**（含番茄休息）。
        // 理由：能改名单就能把想玩的应用加进白名单，锁机立刻形同虚设。
        // 三个付费出口仍然有效（积分解锁 / 暂停 / 停止本段），见 ScheduleEngine.frozen。
        val ctx = LocalContext.current
        val now = java.time.LocalDateTime.now()
        val frozen = ScheduleEngine.frozen(cfg, now)

        fun refuse() {
            toast(ctx, "自律时段内不能改规则：等这一段结束，或用积分解锁 / 暂停 / 停止本段")
        }

        // 为什么"规则配了却不拦"：绝大多数时候是这三件事没同时成立。
        // 与其让人猜，不如把当前状态摆出来。
        val status = when {
            !cfg.enabled -> "自律总开关是关的 —— 规则一条都不会生效"
            ScheduleEngine.stateAt(cfg, now) == null -> "现在不在自律时段内 —— 规则只在时段里生效"
            ScheduleEngine.stateAt(cfg, now)?.inBreak == true -> "现在是番茄的休息段 —— 休息时规则暂停"
            now.atZone(java.time.ZoneId.systemDefault()).toEpochSecond() < cfg.unlockUntil ->
                "你正在用积分解锁的这段时间 —— 所有拦截暂停"
            else -> "生效中：规则正在按「时段」执行"
        }
        Panel {
            Text(status, fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (frozen) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "自律时段生效中（含番茄休息）：规则与本页开关暂时只读。",
                    fontSize = 10.5.sp,
                    lineHeight = 15.sp,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        // —— 锁机页展示方式 ——
        //
        // 两个模式是**互斥**的两档，不是叠加：
        //  · 开：整机锁（回桌面 + 全屏遮罩），一直是默认行为；
        //  · 关：不锁整机，只在点开黑名单应用时弹 5 秒提示页，然后回桌面。
        // 关闭时白名单不参与判定（没有整机锁，"只允许名单内"没有意义），文案里写明。
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("展示锁机页面", fontSize = 14.sp)
                    Text(
                        if (cfg.lock.showPage) {
                            "开启：专注段里整台手机锁住（回桌面 + 全屏遮罩），按现有锁机逻辑拦。"
                        } else {
                            "关闭：不锁整机。桌面随便用，点开黑名单应用才弹 5 秒提示页并自动回桌面。"
                        },
                        fontSize = 10.5.sp,
                        lineHeight = 15.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = cfg.lock.showPage,
                    enabled = !frozen,
                    onCheckedChange = { v ->
                        if (frozen) {
                            refuse()
                        } else {
                            Store.update { it.copy(lock = it.lock.copy(showPage = v)) }
                            toast(
                                ctx,
                                if (v) "已开启：专注段内整机锁机" else "已关闭：只拦黑名单应用，点开时弹 5 秒提示",
                            )
                        }
                    },
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                if (cfg.lock.showPage) {
                    "白名单应用在锁机页仍可打开；黑名单与「只按规则」的范围照旧生效。"
                } else {
                    "这一档只看黑名单：白名单规则不参与判定（因为没有整机锁）。"
                },
                fontSize = 10.5.sp,
                lineHeight = 15.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        OutlinedButton(
            onClick = { if (frozen) refuse() else editing = newRule() },
            enabled = !frozen,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("新建一条规则")
        }

        if (cfg.rules.isEmpty()) {
            Panel { EmptyHint("还没有规则。新建一条，把想拦的应用加进去。") }
        }

        cfg.rules.forEach { r ->
            Panel {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    /* 桌面端给这条规则配的颜色。手机端不能改色，但显示出来，
                     * 两端列表才"对得上号"——以前颜色只藏在 carry 里，看不见。 */
                    ruleColor(r.color)?.let { c ->
                        Box(
                            Modifier
                                .padding(end = 10.dp)
                                .size(10.dp)
                                .clip(CircleShape)
                                .background(c),
                        )
                    }
                    Column(Modifier.weight(1f)) {
                        Text(r.name, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(3.dp))
                        Text(
                            when (r.mode) {
                                "whitelist" -> "白名单 · 只允许名单内 ${r.packages.size} 个"
                                "both" -> "白名单 + 黑名单 · 允许 ${r.packages.size} / 禁止 ${r.deny.size}"
                                else -> "黑名单 · 名单内禁止 ${r.packages.size} 个"
                            } + if (r.hard) " · 固化" else "",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = r.enabled,
                        enabled = !frozen,
                        onCheckedChange = { v ->
                            if (frozen) {
                                refuse()
                            } else {
                                Store.update { c ->
                                    c.copy(rules = c.rules.map { if (it.id == r.id) it.copy(enabled = v) else it })
                                }
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
                    OutlinedButton(
                        onClick = { if (frozen) refuse() else editing = r },
                        enabled = !frozen,
                    ) { Text("编辑", fontSize = 12.sp) }
                    OutlinedButton(
                        onClick = {
                            if (frozen) {
                                refuse()
                            } else {
                                val copy = r.copy(id = UUID.randomUUID().toString().take(8), name = r.name + " 副本")
                                Store.update { c -> c.copy(rules = c.rules + copy) }
                            }
                        },
                        enabled = !frozen,
                    ) { Text("复制", fontSize = 12.sp) }
                    OutlinedButton(
                        onClick = {
                            if (frozen) {
                                refuse()
                            } else {
                                Store.update { c -> c.copy(rules = c.rules.filterNot { it.id == r.id }) }
                            }
                        },
                        enabled = !frozen,
                    ) { Text("删除", fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }
                }
            }
        }
        Spacer(Modifier.height(6.dp))
    }

    val cur = editing
    if (cur != null) {
        RuleDialog(
            rule = cur,
            onPickApps = { target ->
                pickerTarget = target
                showPicker = true
            },
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
        val deny = pickerTarget == "deny"
        AppPickerDialog(
            selected = if (deny) cur.deny else cur.packages,
            onDismiss = { showPicker = false },
            onConfirm = { pkgs ->
                editing = if (deny) cur.copy(deny = pkgs) else cur.copy(packages = pkgs)
                showPicker = false
            },
        )
    }
}

@Composable
private fun RuleDialog(
    rule: Rule,
    onPickApps: (String) -> Unit,
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
                // 模式：三选一。用三个横排按钮而不是"点一下循环"——
                // 循环切到第三态时，用户不知道自己按了几次。
                Column {
                    Text("模式", fontSize = 13.sp)
                    Spacer(Modifier.height(6.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf(
                            "blacklist" to "黑名单",
                            "whitelist" to "白名单",
                            "both" to "两者",
                        ).forEach { (k, label) ->
                            OutlinedButton(
                                onClick = { mode = k },
                                modifier = Modifier.weight(1f),
                                colors = androidx.compose.material3.ButtonDefaults.outlinedButtonColors(
                                    contentColor = if (mode == k) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                                ),
                            ) { Text(if (mode == k) "● $label" else label, fontSize = 11.5.sp) }
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(
                        when (mode) {
                            "whitelist" -> "只允许名单内的应用，其余一律拦。"
                            "both" -> "允许名单放行、禁止名单拦截；两边都写了同一个应用时**以禁止为准**。"
                            else -> "只拦名单内的应用，其余照常使用。"
                        },
                        fontSize = 10.5.sp,
                        lineHeight = 15.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
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
                OutlinedButton(
                    onClick = { onPickApps("allow") },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        if (mode == "whitelist") "选择允许的应用（${rule.packages.size} 个）"
                        else "选择名单（${rule.packages.size} 个）",
                        fontSize = 12.sp,
                    )
                }
                if (mode == "both") {
                    OutlinedButton(
                        onClick = { onPickApps("deny") },
                        modifier = Modifier.fillMaxWidth(),
                        colors = androidx.compose.material3.ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.error,
                        ),
                    ) {
                        Text("选择禁止的应用（${rule.deny.size} 个）", fontSize = 12.sp)
                    }
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

/**
 * 把 `#rrggbb` / `#aarrggbb` 解析成 Compose 的 Color。
 *
 * 解析不了就返回 null（不画点）——桌面端的历史配置里可能有空串或旧格式，
 * 那种情况宁可不显示，也不要因为一个颜色把整个规则列表画崩。
 */
private fun ruleColor(s: String): Color? {
    val t = s.trim().trimStart('#')
    if (t.length != 6 && t.length != 8) return null
    val v = t.toLongOrNull(16) ?: return null
    return if (t.length == 6) Color(0xFF000000L or v) else Color(v)
}
