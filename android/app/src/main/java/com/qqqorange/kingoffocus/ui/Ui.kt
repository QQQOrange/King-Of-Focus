package com.qqqorange.kingoffocus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 统一的界面零件。
 *
 * 之前每个页面各写各的间距、字号、圆角，看起来像三个人做的。这里把它们收成一套：
 * 标题 18sp/半粗、卡片 18dp 圆角、内容 12dp 内边距、说明文字 11.5sp 次要色。
 * 改一次，所有页面一起变。
 */

val CardShape = RoundedCornerShape(18.dp)

/** 页面大标题 + 一句说明 */
@Composable
fun PageHeader(title: String, sub: String? = null) {
    Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        Text(title, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        if (!sub.isNullOrBlank()) {
            Spacer(Modifier.height(4.dp))
            Text(sub, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** 小节标题 */
@Composable
fun SectionTitle(text: String) {
    Spacer(Modifier.height(10.dp))
    Text(
        text,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 2.dp),
    )
}

/** 一张卡片：所有设置项都套在它里面，视觉上才成组 */
@Composable
fun Panel(
    modifier: Modifier = Modifier,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = CardShape,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), content = content)
    }
}

/** 一行开关：左边标题+说明，右边 Switch */
@Composable
fun ToggleRow(
    title: String,
    sub: String? = null,
    checked: Boolean,
    divider: Boolean = false,
    onChange: (Boolean) -> Unit,
) {
    if (divider) HLine()
    Row(
        Modifier.fillMaxWidth().padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp)
            if (!sub.isNullOrBlank()) {
                Spacer(Modifier.height(2.dp))
                Text(sub, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.width(8.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/** 一行数值调节：− 值 + */
@Composable
fun Stepper(
    title: String,
    value: Int,
    min: Int,
    max: Int,
    unit: String,
    step: Int = 1,
    enabled: Boolean = true,
    onChange: (Int) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title,
            Modifier.weight(1f),
            fontSize = 14.sp,
            color = if (enabled) MaterialTheme.colorScheme.onSurface
            else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
        )
        StepBtn("−", enabled) { onChange((value - step).coerceIn(min, max)) }
        Text(
            "$value$unit",
            fontSize = 13.sp,
            modifier = Modifier.width(64.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        StepBtn("+", enabled) { onChange((value + step).coerceIn(min, max)) }
    }
}

@Composable
private fun StepBtn(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier
            .size(30.dp)
            .background(
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (enabled) 1f else 0.45f),
                CircleShape,
            )
            .clickable(enabled = enabled) { onClick() },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, fontSize = 15.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** 细分割线 */
@Composable
fun HLine() {
    Box(
        Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant),
    )
}

/** 状态小胶囊 */
@Composable
fun Pill(text: String, color: Color = MaterialTheme.colorScheme.primary) {
    Box(
        Modifier
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(999.dp))
            .padding(horizontal = 9.dp, vertical = 3.dp),
    ) {
        Text(text, fontSize = 10.5.sp, color = color, fontWeight = FontWeight.Medium)
    }
}

/** 一行"标签 — 值" */
@Composable
fun RowScope.KV(label: String, value: String, valueColor: Color = MaterialTheme.colorScheme.onSurface) {
    Column(Modifier.weight(1f)) {
        Text(label, fontSize = 10.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(2.dp))
        Text(value, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = valueColor)
    }
}

/** 空状态 */
@Composable
fun EmptyHint(text: String) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** 一行：左侧文字 + 右侧次要文字（不可点） */
@Composable
fun InfoRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontSize = 12.5.sp, fontWeight = FontWeight.Medium)
    }
}
