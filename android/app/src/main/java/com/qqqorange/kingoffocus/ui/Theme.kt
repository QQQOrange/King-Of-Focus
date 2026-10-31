package com.qqqorange.kingoffocus.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** 与桌面版同一个品牌色：冷静的蓝 + 近黑底 */
private val Blue = Color(0xFF4D8DFF)
private val Gold = Color(0xFFFFBE5A)

private val Dark = darkColorScheme(
    primary = Blue,
    onPrimary = Color(0xFF08111F),
    secondary = Gold,
    background = Color(0xFF0B0E11),
    onBackground = Color(0xFFE7ECF3),
    surface = Color(0xFF141920),
    onSurface = Color(0xFFE7ECF3),
    surfaceVariant = Color(0xFF1C232C),
    onSurfaceVariant = Color(0xFF9AA6B5),
)

private val Light = lightColorScheme(
    primary = Color(0xFF2F6BD8),
    onPrimary = Color.White,
    secondary = Color(0xFF9A6B12),
    background = Color(0xFFF6F8FB),
    onBackground = Color(0xFF101720),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF101720),
    surfaceVariant = Color(0xFFEDF1F7),
    onSurfaceVariant = Color(0xFF5A6675),
)

@Composable
fun KofTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) Dark else Light,
        content = content,
    )
}
