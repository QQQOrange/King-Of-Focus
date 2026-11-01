package com.qqqorange.kingoffocus.ui

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.clickable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
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
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.qqqorange.kingoffocus.core.GuardEngine
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.core.SleepEngine
import com.qqqorange.kingoffocus.data.AppInfo
import com.qqqorange.kingoffocus.data.DistractStore
import com.qqqorange.kingoffocus.data.StakeStore
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

    /** 轻档提示页剩余秒数（Compose 直接读它，改了就会重组） */
    private val pageLeft = mutableIntStateOf(PageTimer.SECONDS)
    private var pageRemainMs = PageTimer.SECONDS * 1000L
    private var pageResumeAt = 0L
    private var pageActive = false
    private val handler = Handler(Looper.getMainLooper())
    private val pageTicker = object : Runnable {
        override fun run() = tickPage()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 锁屏之上也要显示：否则熄屏再亮就是系统锁屏，遮罩被藏到后面
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        val kind = intent?.getStringExtra(EXTRA_KIND) ?: KIND_FOCUS
        val title = intent?.getStringExtra(EXTRA_END_TITLE).orEmpty()
        val body = intent?.getStringExtra(EXTRA_END_BODY).orEmpty()
        val rule = intent?.getStringExtra(EXTRA_RULE).orEmpty()

        // 返回键：
        //  · 锁机/睡眠遮罩 → 彻底无效（按一下就能退出，遮罩没有意义）；
        //  · 轻档提示页 → **直接回桌面**：这一页本来就不拦人，退回到底下的黑名单应用才更糟；
        //  · 结束页 → 不拦（那只是报信，不该被一句结束语困住）。
        if (kind == KIND_FOCUS || kind == KIND_SLEEP) {
            onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    // 什么都不做
                }
            })
        } else if (kind == KIND_PAGE) {
            onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() = goHomeAndFinish()
            })
        }

        pageActive = kind == KIND_PAGE
        setContent {
            KofTheme {
                Box(Modifier.fillMaxSize()) {
                Surface(modifier = Modifier.fillMaxSize(), color = Color(0xFF12151B)) {
                    when {
                        kind == KIND_END -> LockEndScreen(
                            title = title.ifBlank { "锁机结束" },
                            body = body.ifBlank { "这一段时间走完了。" },
                            onDone = { finish() },
                        )
                        kind == KIND_PAGE -> PageScreen(
                            left = pageLeft.intValue,
                            rule = rule,
                            onHome = { goHomeAndFinish() },
                        )
                        else -> LockScreen(kind = kind, onDone = { finish() })
                    }
                }
                // 记一笔浮在整个遮罩之上：位置四角可选（默认左上角）
                DistractOverlay(kind)
                }
            }
        }
    }

    /**
     * 轻档提示页的计时。
     *
     * 规则：**只在前台计时**。切后台（按 Home、来通知、下拉状态栏）就停下，
     * 回到前台继续用剩下的时间——否则"切个后台再回来，倒计时已经跑完了"，
     * 用户根本没看到那 5 秒，等于没提醒。
     */
    private fun tickPage() {
        if (!pageActive) return
        val elapsed = SystemClock.elapsedRealtime() - pageResumeAt
        val left = pageRemainMs - elapsed
        pageLeft.intValue = PageTimer.leftSeconds(left)
        if (left <= 0) {
            goHomeAndFinish()
        } else {
            handler.postDelayed(pageTicker, 120)
        }
    }

    override fun onResume() {
        super.onResume()
        if (!pageActive) return
        pageResumeAt = SystemClock.elapsedRealtime()
        handler.removeCallbacks(pageTicker)
        handler.post(pageTicker)
    }

    override fun onPause() {
        super.onPause()
        if (!pageActive) return
        // 结算已经用掉的时间，剩下的留给下一次回到前台
        pageRemainMs = (pageRemainMs - (SystemClock.elapsedRealtime() - pageResumeAt)).coerceAtLeast(0)
        handler.removeCallbacks(pageTicker)
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    /** 回桌面并退出：轻档提示页的所有出口都走这里（超时、按返回、点按钮） */
    private fun goHomeAndFinish() {
        runCatching {
            startActivity(
                Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
        finish()
    }

    companion object {
        const val EXTRA_KIND = "kof.lock.kind"
        const val KIND_FOCUS = "focus"
        const val KIND_SLEEP = "sleep"
        /** 锁机结束的提示页：只报个信，不拦任何东西，点一下就退 */
        const val KIND_END = "end"
        /**
         * 轻档提示页：配置里关掉「展示锁机页面」时用它。
         * 不是遮罩——不整机锁，只在点开黑名单应用时盖 5 秒，然后自己回桌面。
         */
        const val KIND_PAGE = "page"
        /** 命中的规则名（只用于提示页上那句"命中规则「…」"） */
        const val EXTRA_RULE = "kof.lock.rule"
        const val EXTRA_END_TITLE = "kof.lock.end.title"
        const val EXTRA_END_BODY = "kof.lock.end.body"
    }
}

/**
 * 「锁机结束」页。
 *
 * 和锁机遮罩是两个东西：遮罩拦人，这一页只报信。所以它**不**拦返回键、
 * 不盖住白名单应用、10 秒后自己退场——用户可能正忙着，不该被一句"结束了"困住。
 * 之所以还要一个页面而不是只发通知：通知容易被划掉或没看见，
 * 而结束这件事（尤其睡眠结束）在早上是重要信息。
 */
@Composable
private fun LockEndScreen(title: String, body: String, onDone: () -> Unit) {
    // 10 秒自动退场：这是提示，不是界面
    LaunchedEffect(Unit) {
        delay(10_000)
        onDone()
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("✓", fontSize = 40.sp, color = Color(0xFF34C759))
            Spacer(Modifier.height(12.dp))
            Text(title, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = Color(0xFFF2F4F8))
            Spacer(Modifier.height(8.dp))
            Text(
                body,
                fontSize = 13.sp,
                lineHeight = 20.sp,
                textAlign = TextAlign.Center,
                color = Color(0xFFA8B0BE),
            )
            Spacer(Modifier.height(22.dp))
            Button(onClick = onDone, colors = ButtonDefaults.buttonColors()) {
                Text("知道了")
            }
        }
    }
}

/**
 * 遮罩上的「记一笔」。
 *
 * 为什么按钮要浮在锁机页之上而不是画进锁机页里：锁机页本身是"你别动手机"
 * 的全屏态度，任何多余元素都会削弱它；只有这一颗按钮是**明确邀请**用户动一下的，
 * 所以单独一层、带明确边界，位置还能四角切换。
 *
 * 记录完立刻关闭对话框，不跳页、不追问分类——念头还在嘴里时，
 * 多一次点击就多一次"算了不记了"。
 */
@Composable
private fun DistractOverlay(kind: String) {
    val cfg by Store.state.collectAsState()
    // 只在"专注锁机"这一档出现：睡眠遮罩、轻档提示、结束页都不该有输入框
    if (kind != LockActivity.KIND_FOCUS || !cfg.distract.enabled) return

    var open by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf("") }
    // 段目标：遮罩上也要能写/看到。每 30 秒重算一次"现在属于哪一段"，
    // 免得跨段之后还显示上一段的目标。
    var now by remember { mutableStateOf(java.time.LocalDateTime.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            kotlinx.coroutines.delay(30_000)
            now = java.time.LocalDateTime.now()
        }
    }
    val seg = com.qqqorange.kingoffocus.core.DistractMath.segmentBounds(cfg, now)
    val goal = seg?.let { com.qqqorange.kingoffocus.data.GoalStore.of(it.start) }.orEmpty()
    var goalOpen by remember { mutableStateOf(false) }
    var goalText by remember { mutableStateOf("") }
    val align = when (cfg.distract.buttonCorner) {
        "tr" -> Alignment.TopEnd
        "bl" -> Alignment.BottomStart
        "br" -> Alignment.BottomEnd
        else -> Alignment.TopStart
    }

    Box(Modifier.fillMaxSize().padding(16.dp)) {
        // 目标条：顶部居中、压在按钮下面一行，避免和小圆钮抢位置
        if (seg != null) {
            Surface(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 38.dp)
                    .clickable {
                        goalText = goal
                        goalOpen = true
                    },
                shape = RoundedCornerShape(999.dp),
                color = Color.White.copy(alpha = if (goal.isBlank()) 0.06f else 0.10f),
            ) {
                Text(
                    if (goal.isBlank()) "＋ 写这一段的目标" else "目标：$goal",
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 7.dp),
                    fontSize = 12.sp,
                    color = if (goal.isBlank()) Color(0xFFB9C0CC) else Color(0xFFEDEFF5),
                )
            }
        }
        Surface(
            modifier = Modifier.align(align).clickable { open = true },
            shape = RoundedCornerShape(999.dp),
            color = Color.White.copy(alpha = 0.10f),
        ) {
            Text(
                "＋ 记一笔",
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
                fontSize = 13.sp,
                color = Color(0xFFEDEFF5),
            )
        }
    }

    if (open) {
        AlertDialog(
            onDismissRequest = { open = false },
            title = { Text("记一笔") },
            text = {
                Column {
                    Text(
                        "想到什么先放这儿，记完就回到刚才那件事上。",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = text,
                        onValueChange = { if (it.length <= 500) text = it },
                        placeholder = { Text("例如：查一下那个报错") },
                        maxLines = 3,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val added = DistractStore.add(cfg, text)
                    if (added != null) {
                        text = ""
                        open = false
                    }
                }) { Text("记下") }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text("取消") } },
        )
    }

    if (goalOpen && seg != null) {
        AlertDialog(
            onDismissRequest = { goalOpen = false },
            title = { Text("这一段要做什么") },
            text = {
                Column {
                    Text(
                        "写一句就够。时段结束时会把目标和被打断次数一起汇总给你。",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = goalText,
                        onValueChange = { if (it.length <= 200) goalText = it },
                        placeholder = { Text("例如：把登录页写完") },
                        maxLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    com.qqqorange.kingoffocus.data.GoalStore.set(
                        seg.start,
                        goalText,
                        day = now.toLocalDate().toString(),
                    )
                    goalOpen = false
                }) { Text("保存") }
            },
            dismissButton = {
                TextButton(onClick = {
                    // 清空 = 这一段不写目标，不是"删错了"
                    com.qqqorange.kingoffocus.data.GoalStore.set(seg.start, "")
                    goalOpen = false
                }) { Text("清空") }
            },
        )
    }
}

@Composable
private fun LockScreen(kind: String, onDone: () -> Unit) {
    val ctx = LocalContext.current
    val sleep = kind == LockActivity.KIND_SLEEP
    val cfg by Store.state.collectAsState()
    var now by remember { mutableStateOf(LocalDateTime.now()) }
    var showAllow by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf(false) }
    // 只在进入遮罩时探一次：这里只是给底部那行字用，不需要实时性
    val shizukuReady = remember { com.qqqorange.kingoffocus.core.ShizukuBridge.ready() }

    // 一秒一拍：刷新倒计时；锁机结束（暂停 / 停止 / 到点 / 关掉自律）时自己退场，
    // 这样"状态变了遮罩立刻跟着变"，不需要服务端再发指令。
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            now = LocalDateTime.now()
            val still = if (sleep) {
                SleepEngine.isSleeping(Store.current, now)
            } else {
                LockEngine.isLockActive(Store.current, now)
            }
            if (!still && !done) {
                done = true
                onDone()
                return@LaunchedEffect
            }
        }
    }

    val strict = LockEngine.isStrict(cfg)
    val price = LockEngine.pausePrice(cfg)
    val stopCost = LockEngine.stopPrice(cfg)
    val left = fmtLeft(LockEngine.segmentLeftSeconds(cfg, now))
    // 允许名单的唯一来源：白名单规则（锁机这边不再有自己的副本）。
    // 展示时补上"显示名 + 能不能启动"：白名单里可能有卸载了 / 没有界面的包，
    // 那也要如实列出来（只读地说明"不能启动"），而不是悄悄从列表里消失。
    val allowPkgs = GuardEngine.allowedPackages(cfg)
    val allowItems = remember(allowPkgs) {
        val launchable = loadLaunchableApps(ctx).associateBy { it.pkg }
        allowPkgs
            .map { pkg ->
                WhitelistItem(
                    pkg = pkg,
                    label = launchable[pkg]?.label ?: appLabelOf(ctx, pkg),
                    canLaunch = launchable.containsKey(pkg),
                )
            }
            .sortedWith(compareBy({ it.label.lowercase() }, { it.pkg }))
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(if (sleep) "🌙" else "🔒", fontSize = 34.sp)
        Spacer(Modifier.height(6.dp))
        Text(
            if (sleep) "睡眠中" else "锁机中",
            fontSize = 30.sp,
            fontWeight = FontWeight.Bold,
            color = Color(0xFFF2F4F8),
        )
        Spacer(Modifier.height(6.dp))
        Text(
            when {
                sleep -> "现在是睡眠时段 · 手机放一边"
                strict -> "强制模式 · 不可暂停 / 不可跳过"
                else -> "温和模式 · 可用积分暂停或提前结束"
            },
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            color = when {
                sleep -> Color(0xFF9C8CFF)
                strict -> Color(0xFFFF8A65)
                else -> Color(0xFF7FB4FF)
            },
        )
        Spacer(Modifier.height(8.dp))
        Text(
            when {
                sleep -> "这个时段是留给你睡觉的。真要看时间或处理急事，可以用积分解锁一小段。"
                strict -> "这一段必须完整走完。没有暂停、没有跳过，也没有积分可以买时间。"
                else -> "现在是专注时段，手机先放一边。应用都还在，只是被挡在这层遮罩后面。"
            },
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
            color = Color(0xFF9AA4B2),
        )
        Spacer(Modifier.height(26.dp))
        Text(
            if (sleep) {
                fmtLeft(SleepEngine.active(cfg, now)?.leftSeconds ?: 0)
            } else {
                left
            },
            fontSize = 46.sp,
            fontWeight = FontWeight.SemiBold,
            color = Color(0xFFF7C948),
        )
        Text(if (sleep) "距离起床" else "本段剩余", fontSize = 12.sp, color = Color(0xFF9AA4B2))
        Spacer(Modifier.height(22.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("积分 ", fontSize = 13.sp, color = Color(0xFF9AA4B2))
            Text("${cfg.points}", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = Color(0xFFF2F4F8))
            Text(" 分", fontSize = 13.sp, color = Color(0xFF9AA4B2))
        }
        // 质押：押一笔，跑完退回来（一次没被打断还加一点）。
        // 放在积分下面而不是藏进设置，是因为"押了没押"必须在锁机这一屏就能看见——
        // 看不见的承诺不算承诺。
        if (!sleep) {
            val sn = StakeStore.snapshot(cfg, now)
            Spacer(Modifier.height(8.dp))
            if (sn.amount > 0) {
                Text(
                    "已押 ${sn.amount} 分 · 跑完退 ${sn.amount + sn.bonus}",
                    fontSize = 11.5.sp,
                    color = Color(0xFFF7C948),
                )
            } else {
                OutlinedButton(
                    onClick = {
                        val r = StakeStore.place(cfg, sn.unit)
                        val ok = r.getOrNull()
                        if (ok == null) {
                            toast(ctx, r.exceptionOrNull()?.message ?: "押注失败")
                        } else {
                            Store.update { it.copy(points = (it.points - ok.amount).coerceAtLeast(0)) }
                            toast(ctx, "已押 ${ok.amount} 分：跑完退 ${ok.amount + sn.bonus}")
                        }
                    },
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFCFE3FF)),
                ) {
                    Text(
                        "押 ${sn.unit} 分 · 跑完退 ${sn.unit + sn.bonus}",
                        fontSize = 11.5.sp,
                    )
                }
            }
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

        // —— 出口：价格写在按钮上，点之前就知道要付多少 ——
        // 强制模式下这两个按钮**不存在**（不是置灰）：承诺是"没有任何提前结束的方式"，
        // 留一个灰按钮只会让人反复去点，以为是自己积分不够。
        // 睡眠时段只有"积分解锁一小段"：睡眠本身不该被"停止"。
        if (sleep) {
            val price = SleepEngine.unlockPrice(cfg)
            Spacer(Modifier.height(14.dp))
            Button(
                onClick = {
                    if (price <= 0) {
                        toast(ctx, "睡眠时段没有开放积分解锁")
                        return@Button
                    }
                    if (cfg.points < price) {
                        toast(ctx, "积分不足：解锁需要 $price 分，当前 ${cfg.points} 分")
                        return@Button
                    }
                    val until = SleepEngine.unlockUntil(Store.current, LocalDateTime.now())
                    Store.update {
                        it.copy(
                            points = (it.points - price).coerceAtLeast(0),
                            sleepUnlockUntil = until,
                        )
                    }
                    toast(ctx, "已解锁 ${cfg.sleep.unlockMin} 分钟，扣 $price 分")
                    if (!done) { done = true; onDone() }
                },
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF2A3240),
                    contentColor = Color(0xFFF2F4F8),
                ),
            ) {
                Text(
                    if (price > 0) "解锁 ${cfg.sleep.unlockMin} 分钟 · $price 分"
                    else "睡眠时段不开放解锁",
                )
            }
        }

        if (!strict && !sleep) {
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
                // 花积分暂停 = 提前退出这一段：押的分没收（质押唯一的惩罚出口）
                StakeStore.forfeit(Store.current)
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
                StakeStore.forfeit(Store.current)
                toast(ctx, "已停止本次锁机，扣 $stopCost 分；下一段专注会重新锁机")
                if (!done) { done = true; onDone() }
            },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(
                containerColor = Color(0xFF2A3240),
                contentColor = Color(0xFFF2F4F8),
            ),
        ) { Text("停止锁机 · $stopCost 分") }
        }

        // —— 白名单应用入口 ——
        //
        // 只读：这一页回答"我现在能用什么"，不是"我要改什么"。
        // 锁机页如果能改名单，它自己就成了绕过的钥匙（加一个游戏进去就解锁了）。
        // 增删一律在「自律规则」里，且那里在自律时段内是只读的（见 RulesScreen）。
        Spacer(Modifier.height(16.dp))
        WhitelistEntry(
            count = allowItems.size,
            onClick = { showAllow = true },
        )
        if (showAllow) {
            WhitelistDialog(
                items = allowItems,
                onPick = { item ->
                    showAllow = false
                    if (!item.canLaunch) {
                        toast(ctx, "「${item.label}」没有可打开的界面")
                    } else {
                        // 先把列表收掉再跳：否则从应用返回时它还开着，像"没关上"
                        val launch = ctx.packageManager.getLaunchIntentForPackage(item.pkg)
                        if (launch == null) {
                            toast(ctx, "这个应用打不开")
                        } else {
                            // 不加 NEW_TASK：让它落在本任务里，返回时直接回到遮罩
                            launch.removeFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            runCatching { ctx.startActivity(launch) }
                                .onFailure { toast(ctx, "这个应用打不开") }
                        }
                    }
                },
                onDismiss = { showAllow = false },
            )
        }

        Spacer(Modifier.height(20.dp))
        if (!sleep && strict) {
            Text(
                if (shizukuReady) {
                    "有 Shizuku：你一进设置就会被弹出来；但卸载本应用仍然拦不住（那需要设备管理员）"
                } else {
                    "缺 Shizuku：只能靠无障碍把设置页按回去；这一页之外没有别的锁"
                },
                fontSize = 11.sp,
                color = Color(0xFF5A6472),
                textAlign = TextAlign.Center,
            )
        } else {
            Text(
                if (sleep) "长按这行可紧急解除（不计分，仅限急事）" else "长按这行可强制解除（不计分，仅限紧急）",
                fontSize = 11.sp,
                color = Color(0xFF5A6472),
                modifier = Modifier
                    .fillMaxWidth()
                    .pointerInput(sleep) {
                        detectTapGestures(onLongPress = {
                            if (sleep) {
                                val until = SleepEngine.active(Store.current, LocalDateTime.now())
                                    ?.let { it.end.atZone(java.time.ZoneId.systemDefault()).toEpochSecond() }
                                    ?: 0L
                                Store.update { it.copy(sleepUnlockUntil = until) }
                                toast(ctx, "已紧急解除本次睡眠锁定")
                            } else {
                                val seg = LockEngine.segmentKey(Store.current, LocalDateTime.now())
                                Store.update { it.copy(lockStoppedSeg = seg) }
                                toast(ctx, "已强制解除本次锁机")
                            }
                            if (!done) { done = true; onDone() }
                        })
                    }
                    .padding(vertical = 8.dp),
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** 白名单列表里的一项（只读展示用） */
private data class WhitelistItem(val pkg: String, val label: String, val canLaunch: Boolean)

/**
 * 白名单应用入口。
 *
 * 样式：整宽描边按钮，左侧 2×2 圆点图标（应用格子的隐喻），右侧计数徽标。
 * 状态：
 *  · 可用：描边与文字用次级色，徽标用主色数字；
 *  · 禁用（白名单为空）：整体降透明度、`enabled=false`，右侧写「暂无」，
 *    点不动——点了弹一个空列表比点不动更让人困惑。
 */
@Composable
private fun WhitelistEntry(count: Int, onClick: () -> Unit) {
    val enabled = count > 0
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().height(46.dp),
        colors = ButtonDefaults.outlinedButtonColors(
            contentColor = Color(0xFFCFE3FF),
            disabledContentColor = Color(0xFF5A6472),
        ),
        shape = RoundedCornerShape(12.dp),
    ) {
        // 2×2 圆点：不引 material-icons（那会给包体加一个图标库，只为一个按钮不值）
        Canvas(Modifier.size(16.dp)) {
            val r = size.minDimension * 0.19f
            val gap = size.minDimension * 0.16f
            val step = r * 2 + gap
            val x0 = (size.width - step) / 2
            val y0 = (size.height - step) / 2
            for (i in 0..1) {
                for (j in 0..1) {
                    drawCircle(
                        color = if (enabled) Color(0xFFCFE3FF) else Color(0xFF5A6472),
                        radius = r,
                        center = androidx.compose.ui.geometry.Offset(
                            x0 + r + i * step,
                            y0 + r + j * step,
                        ),
                    )
                }
            }
        }
        Spacer(Modifier.width(10.dp))
        Text("白名单应用", fontSize = 13.5.sp, fontWeight = FontWeight.Medium)
        Spacer(Modifier.weight(1f))
        Text(
            if (enabled) "$count 个 ›" else "暂无",
            fontSize = 12.sp,
            color = if (enabled) Color(0xFF7FB4FF) else Color(0xFF5A6472),
        )
    }
}

/**
 * 白名单列表（只读弹窗）。
 *
 * 数据来源：`GuardEngine.allowedPackages(cfg)`——启用中、且被当前时段方案绑定的
 * 白名单规则并集。排序：显示名（忽略大小写）升序，同名再按包名，保证每次打开顺序一样。
 * 空状态：入口按钮本身就是禁用的，正常进不来；这里仍然写清楚"去哪儿加"。
 */
@Composable
private fun WhitelistDialog(
    items: List<WhitelistItem>,
    onPick: (WhitelistItem) -> Unit,
    onDismiss: () -> Unit,
) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 18.dp)
                .background(Color(0xFF151A22), RoundedCornerShape(18.dp))
                .padding(horizontal = 16.dp, vertical = 16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        "白名单应用",
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color(0xFFF2F4F8),
                    )
                    Spacer(Modifier.height(3.dp))
                    Text(
                        if (items.isEmpty()) "还没有任何应用在白名单里"
                        else "共 ${items.size} 个 · 点一个直接打开",
                        fontSize = 11.sp,
                        color = Color(0xFF9AA4B2),
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
            Text(
                "只读：要增删白名单应用，请到「自律规则」里改；自律时段内那边也是只读的。",
                fontSize = 10.5.sp,
                lineHeight = 15.sp,
                color = Color(0xFF7C8798),
            )
            Spacer(Modifier.height(12.dp))

            if (items.isEmpty()) {
                // 正常路径进不来（入口是禁用的），但万一名单在这一页打开期间被清空，
                // 也要说清楚"去哪儿加"，而不是给一片空白
                Column(
                    Modifier.fillMaxWidth().padding(vertical = 22.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("白名单是空的", fontSize = 13.sp, color = Color(0xFFE6EAF2))
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "去「自律规则」建一条白名单规则，把锁机时允许用的应用加进去。",
                        fontSize = 11.sp,
                        lineHeight = 15.sp,
                        textAlign = TextAlign.Center,
                        color = Color(0xFF9AA4B2),
                    )
                }
            } else {
                Box(Modifier.fillMaxWidth().heightIn(max = 380.dp)) {
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(3),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(items, key = { it.pkg }) { a ->
                            Column(
                                Modifier
                                    .background(
                                        if (a.canLaunch) Color(0xFF1B2029) else Color(0xFF171B22),
                                        RoundedCornerShape(12.dp),
                                    )
                                    .padding(vertical = 10.dp, horizontal = 6.dp)
                                    .pointerInput(a.pkg, a.canLaunch) {
                                        detectTapGestures(onTap = { onPick(a) })
                                    },
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
                                        color = if (a.canLaunch) Color(0xFFCFE3FF) else Color(0xFF7C8798),
                                    )
                                }
                                Spacer(Modifier.height(6.dp))
                                Text(
                                    a.label,
                                    fontSize = 11.sp,
                                    maxLines = 1,
                                    color = if (a.canLaunch) Color(0xFFE6EAF2) else Color(0xFF8A94A4),
                                )
                                if (!a.canLaunch) {
                                    Text(
                                        "不可启动",
                                        fontSize = 9.sp,
                                        color = Color(0xFF7C8798),
                                    )
                                }
                            }
                        }
                    }
                }
            }
            Spacer(Modifier.height(14.dp))
            OutlinedButton(
                onClick = onDismiss,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFCFE3FF)),
            ) { Text("关闭") }
        }
    }
}

/** 包名 → 显示名；查不到就退回包名，别让列表里出现空字符串 */
private fun appLabelOf(ctx: Context, pkg: String): String = runCatching {
    val pm = ctx.packageManager
    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
}.getOrDefault(pkg)

/**
 * 轻档提示页的计时口径（纯函数，可单测）。
 *
 * 为什么抽出来：5 秒这件事写在 UI 里就只能靠手点着表验证；抽出来之后
 * "4999ms 显示几秒""到 0 算不算结束"这些都是断言。
 */
internal object PageTimer {
    /** 停留秒数：需求写死 5 秒，不做成可配（可配就会有人设成 1 秒，等于没提醒） */
    const val SECONDS = 5

    /** 剩余毫秒 → 显示的秒数（向上取整：还剩 1ms 也显示 1 秒，不会突然跳到 0） */
    fun leftSeconds(remainingMs: Long): Int =
        ((remainingMs.coerceAtLeast(0) + 999) / 1000).toInt()
}

/** 轻档提示页：不拦人，只把"这个应用现在不能用"说清楚，5 秒后自己回桌面 */
@Composable
private fun PageScreen(left: Int, rule: String, onHome: () -> Unit) {
    val ctx = LocalContext.current
    // 被拦下的那一刻，最该看到的不是"你不能用这个"，而是"你本来要干什么"。
    // 段目标就存在本机，读一次即可（这一页活不过几秒，不必缓存）。
    val cfg = com.qqqorange.kingoffocus.data.Store.current
    // 段目标 + 这一节被打断几次。被拦下的这一刻，"这是第 3 次"比任何说教都管用——
    // 计数用账本口径（同一目标 30 秒内只算一次），和质押结算问的是同一个数。
    val segInfo = remember {
        val at = java.time.LocalDateTime.now()
        val seg = com.qqqorange.kingoffocus.core.DistractMath.segmentBounds(cfg, at)
        if (seg == null) {
            "" to 0
        } else {
            com.qqqorange.kingoffocus.data.GoalStore.of(seg.start) to
                com.qqqorange.kingoffocus.data.LedgerStore.countBetween(
                    seg.start,
                    at.atZone(java.time.ZoneId.systemDefault()).toEpochSecond(),
                )
        }
    }
    val goal = segInfo.first
    val blocks = segInfo.second
    Column(
        Modifier.fillMaxSize().padding(horizontal = 28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("🔒", fontSize = 34.sp)
        Spacer(Modifier.height(10.dp))
        Text(
            "这个应用现在不能用",
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
            color = Color(0xFFF2F4F8),
            textAlign = TextAlign.Center,
        )
        if (rule.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text("命中规则「$rule」", fontSize = 12.sp, color = Color(0xFF9AA4B2))
        }
        // 被打断的次数就摆在被拦下的这一页：数字本身比"请专注"更有说服力，
        // 而且它和时段结束时的汇总、周复盘的账本是同一个来源，不会被质疑"哪来的数"。
        if (blocks > 0) {
            Spacer(Modifier.height(8.dp))
            Text("这一节第 $blocks 次被打断", fontSize = 12.sp, color = Color(0xFFE8A9A0))
        }
        // 替代动作：把"那我该做什么"直接写在页面上
        Spacer(Modifier.height(16.dp))
        if (goal.isNotBlank()) {
            Text(
                "这一段要做的是",
                fontSize = 11.sp,
                color = Color(0xFF7C8798),
            )
            Spacer(Modifier.height(4.dp))
            Text(
                goal,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                color = Color(0xFFF2F4F8),
                textAlign = TextAlign.Center,
            )
        } else {
            OutlinedButton(
                onClick = {
                    // 打开主界面去写目标（这一页本来就要走了，不必留着）
                    runCatching {
                        ctx.startActivity(
                            android.content.Intent(
                                ctx,
                                com.qqqorange.kingoffocus.MainActivity::class.java,
                            ).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                        onHome()
                    }
                },
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFF9AA4B2)),
            ) { Text("这一段还没写目标", fontSize = 11.sp) }
        }
        Spacer(Modifier.height(20.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            Text(
                "$left",
                fontSize = 44.sp,
                fontWeight = FontWeight.SemiBold,
                color = Color(0xFFF7C948),
            )
            Text(" 秒后返回桌面", fontSize = 12.sp, color = Color(0xFF9AA4B2))
        }
        Spacer(Modifier.height(6.dp))
        Text(
            "整机没有被锁：桌面和其它应用都能正常用。",
            fontSize = 11.sp,
            color = Color(0xFF7C8798),
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(22.dp))
        OutlinedButton(
            onClick = onHome,
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(0xFFCFE3FF)),
        ) { Text("立即返回桌面") }
    }
}

/** 倒计时格式：不足一小时显示 mm:ss，超过就 h:mm:ss *//** 倒计时格式：不足一小时显示 mm:ss，超过就 h:mm:ss */
private fun fmtLeft(seconds: Long): String {
    val s = seconds.coerceAtLeast(0)
    val m = s / 60
    val h = m / 60
    return if (h > 0) "%d:%02d:%02d".format(h, m % 60, s % 60) else "%02d:%02d".format(m, s % 60)
}
