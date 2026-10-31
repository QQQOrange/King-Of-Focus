package com.qqqorange.kingoffocus.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import com.qqqorange.kingoffocus.MainActivity
import com.qqqorange.kingoffocus.R
import com.qqqorange.kingoffocus.core.GuardEngine
import com.qqqorange.kingoffocus.core.ScheduleEngine
import com.qqqorange.kingoffocus.data.Store
import com.qqqorange.kingoffocus.ui.BlockActivity
import java.time.LocalDateTime

/**
 * 常驻守护服务。
 *
 * 每秒一拍：算时段 → 看当前前台应用 → 命中就拉起全屏拦截页。
 * 为什么是前台服务：Android 8 之后后台服务会被随时冻结，
 * 只有前台服务（带常驻通知）能稳定每秒跑；这也是"自律"这个场景必须付的代价。
 */
class GuardService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var started = false
    private var lastBlockPkg: String? = null
    private var lastBlockAt = 0L
    private var lastLeft = -1L
    private var notifiedPhase = false

    private val ticker = object : Runnable {
        override fun run() {
            try {
                tick()
            } catch (t: Throwable) {
                Log.w(TAG, "tick 失败", t)
            }
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        Store.init(this)
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(FOREGROUND_ID, buildOngoing(Store.current.enabled, null))
        if (!started) {
            started = true
            handler.post(ticker)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        started = false
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---------------- 主循环 ----------------

    private fun tick() {
        val cfg = Store.current
        val now = LocalDateTime.now()
        val st = ScheduleEngine.stateAt(cfg, now)

        updateOngoing(cfg.enabled && st != null, st)

        if (st == null || st.inBreak) {
            lastLeft = -1
            notifiedPhase = false
            return
        }

        maybeNotify(cfg, st)
        enforce(cfg, now)
    }

    /** 阶段提醒：每个阶段只响一次，剩余时间跳大即视为进入新阶段 */
    private fun maybeNotify(cfg: com.qqqorange.kingoffocus.data.Config, st: ScheduleEngine.State) {
        val n = cfg.notify
        val left = st.leftSeconds
        if (left > lastLeft + 5) notifiedPhase = false
        lastLeft = left
        if (!n.enabled) return
        val threshold = when {
            st.inBreak -> if (n.breakNotify) n.breakBefore.coerceIn(0, 120) * 60 else 0
            else -> n.workBefore.coerceIn(0, 120) * 60
        }
        if (threshold <= 0 || notifiedPhase || left > threshold) return
        notifiedPhase = true
        val mins = ((left + 59) / 60).coerceAtLeast(1)
        val text = if (st.inBreak) "休息还剩 $mins 分钟，准备回到专注" else "本轮专注还剩 $mins 分钟，坚持一下"
        alert("阶段提醒", text)
    }

    /** 拦截：命中名单就拉起全屏拦截页（同一个包 3 秒内不重复拉） */
    private fun enforce(cfg: com.qqqorange.kingoffocus.data.Config, now: LocalDateTime) {
        if (!cfg.overlay.blockEnabled) return
        val pkg = GuardEngine.foregroundPackage(this) ?: return
        val rule = GuardEngine.blockedRule(cfg, now, pkg, packageName) ?: return
        val nowMs = SystemClock.elapsedRealtime()
        if (pkg == lastBlockPkg && nowMs - lastBlockAt < 3000) return
        lastBlockPkg = pkg
        lastBlockAt = nowMs
        val i = Intent(this, BlockActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(BlockActivity.EXTRA_PKG, pkg)
            .putExtra(BlockActivity.EXTRA_RULE, rule.name)
        startActivity(i)
    }

    // ---------------- 通知 ----------------

    private fun createChannels() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CH_ONGOING, "自律守护", NotificationManager.IMPORTANCE_LOW).apply {
                description = "显示当前自律状态，关闭它会停止守护"
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_ALERT, "阶段提醒", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "专注 / 休息结束前的提醒"
            },
        )
    }

    private fun buildOngoing(active: Boolean, st: ScheduleEngine.State?): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = when {
            st == null -> "当前不在自律时段"
            st.inBreak -> "休息中 · ${ScheduleEngine.fmtLeft(st.leftSeconds)}"
            else -> "专注中 · ${ScheduleEngine.fmtLeft(st.leftSeconds)}"
        }
        return NotificationCompat.Builder(this, CH_ONGOING)
            .setSmallIcon(R.drawable.ic_stat_focus)
            .setContentTitle(if (active) "King Of Focus · 自律中" else "King Of Focus")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateOngoing(active: Boolean, st: ScheduleEngine.State?) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(FOREGROUND_ID, buildOngoing(active, st))
    }

    private fun alert(title: String, body: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(
            ALERT_ID,
            NotificationCompat.Builder(this, CH_ALERT)
                .setSmallIcon(R.drawable.ic_stat_focus)
                .setContentTitle(title)
                .setContentText(body)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .build(),
        )
    }

    companion object {
        private const val TAG = "KofGuard"
        private const val CH_ONGOING = "kof_ongoing"
        private const val CH_ALERT = "kof_alert"
        private const val FOREGROUND_ID = 1001
        private const val ALERT_ID = 1002

        fun start(ctx: android.content.Context) {
            val i = Intent(ctx, GuardService::class.java)
            ctx.startForegroundService(i)
        }

        fun stop(ctx: android.content.Context) {
            ctx.stopService(Intent(ctx, GuardService::class.java))
        }
    }
}
