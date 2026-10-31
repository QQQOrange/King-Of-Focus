package com.qqqorange.kingoffocus.ui

import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.data.AppInfo
import com.qqqorange.kingoffocus.data.Store
import com.qqqorange.kingoffocus.loadLaunchableApps
import com.qqqorange.kingoffocus.toast
import kotlinx.coroutines.delay
import java.time.LocalDateTime

/**
 * 锁机遮罩。
 *
 * 形态是"覆盖全屏的 Activity"，不是悬浮窗：
 *   · 悬浮窗（TYPE_APPLICATION_OVERLAY）能盖住别人，但点它上面的按钮再拉起应用
 *     会撞上"后台启动 Activity"的限制，机型差异大；
 *   · 用自己的 Activity 就是前台可见界面，点白名单应用是**用户点击**触发的跳转，
 *     不受后台限制，返回时还天然回到这一页（"白名单跳转后返回遮罩仍在"）。
 *
 * 唯一必须守住的一条：**不能把手机锁死**。所以除了花积分的两个出口，
 * 底部还留了"长按强制解除"——不光彩，但比让人打不出电话要好。
 */
class LockActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 锁屏之上也要显示：否则熄屏再亮就是系统锁屏，遮罩被藏到后面
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        // 返回键无效：按一下就能退出的话，这个遮罩没有任何意义
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // 什么都不做
            }
        })

        setContent {
            KofTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFF12151B)) {
                    LockScreen(onDone = { finish() })
                }
            }
        }
    }
}

@Composable
private fun LockScreen(onDone: () -> Unit) {
    val ctx = LocalContext.current
    val cfg by Store.state.collectAsState()
    var now by remember { mutableStateOf(LocalDateTime.now()) }
    var showAllow by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf(false) }

    // 一秒一拍：刷新倒计时；锁机结束（暂停 / 停止 / 到点 / 关掉自律）时自己退场，
    // 这样"状态变了遮罩立刻跟着变"，不需要服务端再发指令。
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            now = LocalDateTime.now()
            if (!LockEngine.isLockActive(Store.current, now) && !done) {
                done = true
                onDone()
                return@LaunchedEffect
            }
        }
    }

    val price = LockEngine.pausePrice(cfg)
    val stopCost = LockEngine.stopPrice(cfg)
    val left = fmtLeft(LockEngine.segmentLeftSeconds(cfg, now))
    val allowed = remember(cfg.lockAllow) {
        val want = cfg.lockAllow.toSet()
        loadLaunchableApps(ctx).filter { it.pkg in want }
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("🔒", fontSize = 34.sp)
        Spacer(Modifier.height(6.dp))
        Text("锁机中", fontSize = 30.sp, fontWeight = FontWeight.Bold, color = Color(0xFFF2F4F8))
        Spacer(Modifier.height(8.dp))
        Text(
            "现在是专注时段，手机先放一边。应用都还在，只是被挡在这层遮罩后面。",
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
            color = Color(0xFF9AA4B2),
        )
        Spacer(Modifier.height(26.dp))
        Text(left, fontSize = 46.sp, fontWeight = FontWeight.SemiBold, color = Color(0xFFF7C948))
        Text("本段剩余", fontSize = 12.sp, color = Color(0xFF9AA4B2))
        Spacer(Modifier.height(22.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("积分 ", fontSize = 13.sp, color = Color(0xFF9AA4B2))
            Text("${cfg.points}", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = Color(0xFFF2F4F8))
            Text(" 分", fontSize = 13.sp, color = Color(0xFF9AA4B2))
        }
        if (LockEngine.isPaused(cfg, now)) {
            Spacer(Modifier.height(6.dp))
            Text(
                "已暂停（还剩 ${LockEngine.pauseLeftSeconds(cfg, now) / 60} 分钟），到点会自动重新锁机",
                fontSize = 11.sp,
                color = Color(0xFF7FB4FF),
            )
        }
        Spacer(Modifier.height(24.dp))

        // —— 两个出口，价格写在按钮上，点之前就知道要付多少 ——
        OutlinedButton(
            onClick = {
                if (!LockEngine.canAfford(cfg, price.cost)) {
                    toast(ctx, "积分不足：暂停需要 ${price.cost} 分，当前 ${cfg.points} 分")
                    return@OutlinedButton
                }
                val until = System.currentTimeMillis() / 1000 + price.minutes * 60L
                Store.update {
                    it.copy(
                        points = (it.points - price.cost).coerceAtLeast(0),
                        lockPausedUntil = until,
                    )
                }
                toast(ctx, "已暂停 ${price.minutes} 分钟，扣 ${price.cost} 分")
                if (!done) { done = true; onDone() }
            },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFCFE3FF)),
        ) { Text("暂停锁机 · ${price.cost} 分 / ${price.minutes} 分钟") }

        Spacer(Modifier.height(10.dp))
        Button(
            onClick = {
                if (!LockEngine.canAfford(cfg, stopCost)) {
                    toast(ctx, "积分不足：停止需要 $stopCost 分，当前 ${cfg.points} 分")
                    return@Button
                }
                val seg = LockEngine.segmentKey(cfg, LocalDateTime.now())
                Store.update {
                    it.copy(
                        points = (it.points - stopCost).coerceAtLeast(0),
                        lockStoppedSeg = seg,
                    )
                }
                toast(ctx, "已停止本次锁机，扣 $stopCost 分；下一段专注会重新锁机")
                if (!done) { done = true; onDone() }
            },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(
                containerColor = Color(0xFF2A3240),
                contentColor = Color(0xFFF2F4F8),
            ),
        ) { Text("停止锁机 · $stopCost 分") }

        // —— 白名单：允许的应用，点了直接打开 ——
        if (cfg.lockAllow.isNotEmpty()) {
            Spacer(Modifier.height(18.dp))
            OutlinedButton(
                onClick = { showAllow = !showAllow },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFF9AA4B2)),
            ) {
                Text(if (showAllow) "收起允许的应用" else "允许的应用（${allowed.size}）")
            }
            if (showAllow) {
                Spacer(Modifier.height(10.dp))
                AllowGrid(
                    apps = allowed,
                    onPick = { pkg ->
                        val launch = ctx.packageManager.getLaunchIntentForPackage(pkg)
                        if (launch == null) {
                            toast(ctx, "这个应用打不开")
                        } else {
                            // 不加 NEW_TASK：让它落在本任务里，返回时直接回到遮罩
                            launch.removeFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            runCatching { ctx.startActivity(launch) }
                                .onFailure { toast(ctx, "这个应用打不开") }
                        }
                    },
                )
            }
        }

        Spacer(Modifier.height(20.dp))
        Text(
            "长按这行可强制解除（不计分，仅限紧急）",
            fontSize = 11.sp,
            color = Color(0xFF5A6472),
            modifier = Modifier
                .fillMaxWidth()
                .pointerInput(Unit) {
                    detectTapGestures(onLongPress = {
                        val seg = LockEngine.segmentKey(Store.current, LocalDateTime.now())
                        Store.update { it.copy(lockStoppedSeg = seg) }
                        toast(ctx, "已强制解除本次锁机")
                        if (!done) { done = true; onDone() }
                    })
                }
                .padding(vertical = 8.dp),
            textAlign = TextAlign.Center,
        )
    }
}

/** 白名单应用的小格子：点一下直接跳过去 */
@Composable
private fun AllowGrid(apps: List<AppInfo>, onPick: (String) -> Unit) {
    if (apps.isEmpty()) {
        Text(
            "白名单里的应用都没装上（或都不可启动）",
            fontSize = 11.sp,
            color = Color(0xFF9AA4B2),
        )
        return
    }
    Box(Modifier.fillMaxWidth().height(220.dp)) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(apps, key = { it.pkg }) { a ->
                Column(
                    Modifier
                        .background(Color(0xFF1B2029), RoundedCornerShape(12.dp))
                        .padding(vertical = 10.dp, horizontal = 6.dp)
                        .pointerInput(a.pkg) { detectTapGestures(onTap = { onPick(a.pkg) }) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(
                        Modifier
                            .size(34.dp)
                            .background(Color(0xFF2A3240), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            a.label.take(1),
                            fontSize = 15.sp,
                            fontWeight = FontWeight.Bold,
                            color = Color(0xFFCFE3FF),
                        )
                    }
                    Spacer(Modifier.height(6.dp))
                    Text(
                        a.label,
                        fontSize = 11.sp,
                        maxLines = 1,
                        color = Color(0xFFE6EAF2),
                    )
                }
            }
        }
    }
}

/** 倒计时格式：不足一小时显示 mm:ss，超过就 h:mm:ss */
private fun fmtLeft(seconds: Long): String {
    val s = seconds.coerceAtLeast(0)
    val m = s / 60
    val h = m / 60
    return if (h > 0) "%d:%02d:%02d".format(h, m % 60, s % 60) else "%02d:%02d".format(m, s % 60)
}
