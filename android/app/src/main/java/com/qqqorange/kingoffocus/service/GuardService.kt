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
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.core.ScheduleEngine
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Store
import com.qqqorange.kingoffocus.ui.BlockActivity
import com.qqqorange.kingoffocus.ui.LockActivity
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
    private var lockShownAt = 0L
    /** 已经为哪一段提醒过"缺悬浮窗权限"，避免每秒刷一条通知 */
    private var warnedSeg = ""

    /** 桌面包名（可能有多个启动器）。缓存一次，别每秒去问 PackageManager */
    private val homePkgs: Set<String> by lazy {
        runCatching {
            packageManager.queryIntentActivities(
                Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME),
                0,
            ).mapNotNull { it.activityInfo?.packageName }.toSet()
        }.getOrDefault(emptySet())
    }

    /** 当前启用的输入法包名：盖住输入法会让"任何要打字的地方都点不动" */
    private val imePkgs: Set<String> by lazy {
        runCatching {
            val imm = getSystemService(android.view.inputmethod.InputMethodManager::class.java)
            imm?.enabledInputMethodList?.mapNotNull { it.packageName }?.toSet() ?: emptySet()
        }.getOrDefault(emptySet())
    }

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
        startForeground(FOREGROUND_ID, buildOngoing(Store.current.enabled, null, false))
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
        val locked = LockEngine.isLockActive(cfg, now)

        updateOngoing(cfg.enabled && st != null, st, locked)

        // 锁机优先：开着锁机时，"拦截某个应用"这件事被更彻底的"整台手机先别用"取代
        if (locked) {
            lastLeft = -1
            notifiedPhase = false
            enforceLock(cfg, now)
            return
        }

        if (st == null || st.inBreak) {
            lastLeft = -1
            notifiedPhase = false
            return
        }

        maybeNotify(cfg, st)
        enforce(cfg, now)
    }

    /**
     * 锁机：先回桌面，再立刻盖上全屏遮罩。
     *
     * 为什么不直接盖：直接盖等于把用户正在看的应用"冻"在下面，看起来像卡死；
     * 先回桌面，遮罩就是"从桌面上盖上来"，用户一眼明白"我现在被关在外面"。
     * 这里不杀进程、不关机——Android 也不允许，而且那样会毁掉用户手上的东西。
     */
    private fun enforceLock(cfg: Config, now: LocalDateTime) {
        // 没有悬浮窗权限时，"后台启动 Activity"会被系统拦掉（BAL），遮罩根本拉不起来。
        // 这种情况必须说出来——用户以为锁机生效了，其实手机随便用，那比没有这个功能更糟。
        if (!android.provider.Settings.canDrawOverlays(this)) {
            val seg = LockEngine.segmentKey(cfg, now)
            if (warnedSeg != seg) {
                warnedSeg = seg
                alert(
                    "锁机没生效：缺「悬浮窗」权限",
                    "系统不允许后台拉起遮罩页。请到设置 → 权限里授予「悬浮窗」，或点这条通知去开启。",
                    openOverlaySettings = true,
                )
            }
            return
        }
        val fg = GuardEngine.foregroundPackage(this)
        if (!LockEngine.shouldMask(cfg, now, fg, packageName, imePkgs)) return
        if (fg != null && fg !in homePkgs) {
            goHome()
            // 给桌面一点时间完成切换，再压上遮罩；否则遮罩会盖在旧应用上
            handler.postDelayed({ showLock() }, 260)
        } else {
            showLock()
        }
    }

    private fun goHome() {
        runCatching {
            startActivity(
                Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }

    /** 拉起遮罩。已经在前面时不重复拉（前台是自己 → shouldMask 为 false，本来也不会走到这） */
    private fun showLock() {
        val nowMs = SystemClock.elapsedRealtime()
        if (nowMs - lockShownAt < 800) return
        lockShownAt = nowMs
        runCatching {
            startActivity(
                Intent(this, LockActivity::class.java).addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
                ),
            )
        }
    }

    /** 阶段提醒：每个阶段只响一次，剩余时间跳大即视为进入新阶段 */
    private fun maybeNotify(cfg: Config, st: ScheduleEngine.State) {
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
    private fun enforce(cfg: Config, now: LocalDateTime) {
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

    private fun buildOngoing(active: Boolean, st: ScheduleEngine.State?, locked: Boolean): Notification {
        // 锁机期间点通知回的是遮罩页，而不是主界面：
        // 主界面上有个"启用自律"开关，那等于给遮罩配了一把钥匙。
        val open = PendingIntent.getActivity(
            this, 0,
            if (locked) Intent(this, LockActivity::class.java) else Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val text = when {
            locked -> "锁机中 · ${ScheduleEngine.fmtLeft(LockEngine.segmentLeftSeconds(Store.current, LocalDateTime.now()))}"
            st == null -> "当前不在自律时段"
            st.inBreak -> "休息中 · ${ScheduleEngine.fmtLeft(st.leftSeconds)}"
            else -> "专注中 · ${ScheduleEngine.fmtLeft(st.leftSeconds)}"
        }
        val title = when {
            locked -> "King Of Focus · 锁机中"
            active -> "King Of Focus · 自律中"
            else -> "King Of Focus"
        }
        return NotificationCompat.Builder(this, CH_ONGOING)
            .setSmallIcon(R.drawable.ic_stat_focus)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateOngoing(active: Boolean, st: ScheduleEngine.State?, locked: Boolean) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(FOREGROUND_ID, buildOngoing(active, st, locked))
    }

    private fun alert(title: String, body: String, openOverlaySettings: Boolean = false) {
        val nm = getSystemService(NotificationManager::class.java)
        val b = NotificationCompat.Builder(this, CH_ALERT)
            .setSmallIcon(R.drawable.ic_stat_focus)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
        if (openOverlaySettings) {
            val i = Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
                .setData(android.net.Uri.parse("package:$packageName"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            b.setContentIntent(
                PendingIntent.getActivity(
                    this, 1, i,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
        }
        nm.notify(ALERT_ID, b.build())
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
