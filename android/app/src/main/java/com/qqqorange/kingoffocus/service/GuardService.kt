package com.qqqorange.kingoffocus.service

import android.app.AlarmManager
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
import com.qqqorange.kingoffocus.core.Caps
import com.qqqorange.kingoffocus.core.GuardEngine
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.core.ScheduleEngine
import com.qqqorange.kingoffocus.core.SleepEngine
import com.qqqorange.kingoffocus.core.StatsStore
import com.qqqorange.kingoffocus.core.ShizukuBridge
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Store
import com.qqqorange.kingoffocus.ui.LockActivity
import java.time.LocalDateTime

/**
 * 常驻守护服务。
 *
 * 每秒一拍：算时段 → 看当前前台应用 → 命中就拉起全屏拦截页。
 * 为什么是前台服务：Android 8 之后后台服务会被随时冻结，
 * 只有前台服务（带常驻通知）能稳定每秒跑；这也是"自律"这个场景必须付的代价。
 *
 * ## 三档能力，同一个循环
 * 每一拍都要问三个问题：**谁在前台**、**能不能盖住它**、**能不能把用户送回桌面**。
 * 三件事各有三条路，按"能拿到的最强的那条"走，拿不到就退一档（见 [Caps]）：
 *
 * | 问题 | 第一选择 | 退路 | 再退 |
 * |---|---|---|---|
 * | 谁在前台 | 无障碍事件（即时） | 使用情况访问（1 秒轮询） | 放弃这一拍 |
 * | 盖遮罩 | Shizuku `am start`（不受后台限制） | 直接 startActivity（要悬浮窗） | 只发通知 |
 * | 回桌面 | 无障碍 `GLOBAL_ACTION_HOME` | startActivity(HOME) | Shizuku `input keyevent` |
 *
 * 降级不是"坏了"，是"弱一点"——所以每一档都要能正常工作，而不是抛异常。
 */
class GuardService : Service() {

    private val handler = Handler(Looper.getMainLooper())

    /**
     * Shizuku 的 exec 是阻塞的 Binder 调用，绝不能放在这个每秒一拍的循环里。
     * 单线程足够：这些命令都是"发一条、等结果"，并发反而会互相打架。
     */
    private val bg = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "kof-shell").apply { isDaemon = true }
    }

    private var started = false
    private var lastHardenAt = 0L
    /** 统计采样：每 15 拍（约 15 秒）记一笔，每分钟落一次盘 */
    private var statsTick = 0
    private var statsFlushAt = 0L
    private var lastStatsPkg: String? = null
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
        // Shizuku 可能已经在跑（比如上次就授权过）：先连上，服务里才有 shell 可用
        ShizukuBridge.connect(this)
        scheduleHeartbeat(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(FOREGROUND_ID, buildOngoing(Store.current.enabled, null, false, false))
        if (!started) {
            started = true
            handler.post(ticker)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        started = false
        handler.removeCallbacksAndMessages(null)
        StatsStore.flush()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---------------- 主循环 ----------------

    private fun tick() {
        val cfg = Store.current
        val now = LocalDateTime.now()

        // 统计先采：它不依赖自律是否生效（自由时间用手机一样该被记录）
        sampleStats(cfg, now)

        val st = ScheduleEngine.stateAt(cfg, now)
        val locked = LockEngine.isLockActive(cfg, now)
        val sleeping = SleepEngine.isSleeping(cfg, now)

        updateOngoing(cfg.enabled && st != null, st, locked, sleeping)

        // 睡眠优先：晚上这段整机先别用，和白天那套自律独立
        if (sleeping) {
            lastLeft = -1
            notifiedPhase = false
            enforceMask(cfg, now, LockActivity.KIND_SLEEP)
            return
        }

        // 锁机其次：开着锁机时，"拦截某个应用"被更彻底的"整台手机先别用"取代
        if (locked) {
            lastLeft = -1
            notifiedPhase = false
            enforceMask(cfg, now, LockActivity.KIND_FOCUS)
            hardenIfStrict(cfg, now)
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
     * 使用时长采样：每 15 拍（≈15 秒）给"当前前台应用"记 15 秒。
     *
     * 为什么不是每拍都记：写盘和加锁的成本要摊薄；15 秒的粒度对"今天用了多久"
     * 完全够用，误差最多 15 秒。
     */
    private fun sampleStats(cfg: Config, now: LocalDateTime) {
        if (!cfg.stats.enabled) return
        statsTick += 1
        if (statsTick % 15 != 0) return
        // 熄屏不算"在用"：否则一整晚的待机都会被算进最后一个应用
        val pm = getSystemService(android.os.PowerManager::class.java)
        if (pm != null && !pm.isInteractive) return
        val fg = foreground() ?: return
        if (fg == packageName) return
        if (fg in SYSTEM_PKGS) return
        StatsStore.add(now, fg, 15)
        lastStatsPkg = fg
        val t = SystemClock.elapsedRealtime()
        if (t - statsFlushAt > 60_000) {
            statsFlushAt = t
            StatsStore.flush()
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

    /**
     * 拦截：命中名单就**把用户送回桌面**，并发一条说明。
     *
     * 这里刻意不再拉起全屏拦截页：那层"专注遮罩"是从桌面端照搬过来的，
     * 在手机上既盖不严（系统随时能把它顶掉），又容易让人以为应用卡死。
     * 回桌面 + 通知同样能挡住，而且更诚实：你随时能看到自己在哪、能做什么。
     */
    private fun enforce(cfg: Config, now: LocalDateTime) {
        if (!cfg.overlay.blockEnabled) return
        val pkg = foreground() ?: return
        if (pkg == packageName) return
        val rule = GuardEngine.blockedRule(cfg, now, pkg, packageName) ?: return
        val nowMs = SystemClock.elapsedRealtime()
        if (pkg == lastBlockPkg && nowMs - lastBlockAt < 5000) return
        lastBlockPkg = pkg
        lastBlockAt = nowMs

        val label = appLabel(pkg)
        goHome()
        alert("「$label」现在不能用", "命中规则「${rule.name}」。已回到桌面，做点别的。")
    }

    private fun appLabel(pkg: String): String = runCatching {
        val pm = packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)

    /** 当前这一刻的能力矩阵（界面上的"当前等级"读的也是它） */
    private fun caps(): Caps = Caps(
        accessibility = KofAccessibility.alive(),
        shizuku = ShizukuBridge.ready(),
        usageStats = GuardEngine.hasUsageAccess(this),
        overlay = android.provider.Settings.canDrawOverlays(this),
    )

    /** 谁在前台：无障碍事件优先（即时），退回使用情况访问（1 秒轮询） */
    private fun foreground(): String? =
        KofAccessibility.latest() ?: GuardEngine.foregroundPackage(this)

    /**
     * 锁机：先回桌面，再立刻盖上全屏遮罩。
     *
     * 为什么不直接盖：直接盖等于把用户正在看的应用"冻"在下面，看起来像卡死；
     * 先回桌面，遮罩就是"从桌面上盖上来"，用户一眼明白"我现在被关在外面"。
     * 这里不杀进程、不关机——Android 也不允许，而且那样会毁掉用户手上的东西。
     */
    private fun enforceMask(cfg: Config, now: LocalDateTime, kind: String) {
        val caps = caps()
        // 没有任何一条路能把遮罩盖上来时，必须说出来——
        // 用户以为锁机生效了，其实手机随便用，那比没有这个功能更糟。
        if (!caps.canShowMask()) {
            val seg = LockEngine.segmentKey(cfg, now)
            if (warnedSeg != seg) {
                warnedSeg = seg
                alert(
                    "锁机没生效：缺「悬浮窗」或 Shizuku",
                    "系统不允许后台拉起遮罩页。请授予「悬浮窗」，或安装 Shizuku 并授权。",
                    openOverlaySettings = true,
                )
            }
            return
        }
        val fg = foreground()
        // 睡眠时段没有白名单：只留紧急通道和输入法，其它一概不盖不到
        if (fg.isNullOrEmpty() || fg == packageName) return
        if (kind == LockActivity.KIND_FOCUS && fg in cfg.lockAllow) return
        if (LockEngine.isAlwaysAllowed(fg, imePkgs)) return
        if (fg !in homePkgs) {
            goHome()
            // 给桌面一点时间完成切换，再压上遮罩；否则遮罩会盖在旧应用上
            handler.postDelayed({ showLock(kind) }, 260)
        } else {
            showLock(kind)
        }
    }

    /**
     * 回桌面。三条路，按能力从强到弱试：
     * 无障碍全局动作（最稳，不需要权限） → 直接 startActivity（要悬浮窗） → Shizuku 按键。
     */
    private fun goHome() {
        if (KofAccessibility.goHome()) return
        val caps = caps()
        if (caps.overlay) {
            runCatching {
                startActivity(
                    Intent(Intent.ACTION_MAIN)
                        .addCategory(Intent.CATEGORY_HOME)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
            return
        }
        if (caps.shizuku) bg.execute { ShizukuBridge.goHome() }
    }

    /**
     * 拉起遮罩。
     *
     * 有 Shizuku 就走 `am start`：shell 身份发起的 Activity 启动不受
     * "后台启动 Activity"限制，连悬浮窗权限都不需要。
     * 没有就只能直接 startActivity——这条路要求悬浮窗权限，否则会被 BAL 拦掉。
     */
    private fun showLock(kind: String) {
        val nowMs = SystemClock.elapsedRealtime()
        if (nowMs - lockShownAt < 800) return
        lockShownAt = nowMs
        val intent = Intent(this, LockActivity::class.java).putExtra(LockActivity.EXTRA_KIND, kind).addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
        )
        if (ShizukuBridge.ready()) {
            val comp = "$packageName/${LockActivity::class.java.name}"
            bg.execute {
                // 失败不能闷着：退回到直接 startActivity（有悬浮窗时它是通的）
                if (!ShizukuBridge.startActivity(comp, "--es ${LockActivity.EXTRA_KIND} $kind")) {
                    handler.post { runCatching { startActivity(intent) } }
                }
            }
            return
        }
        runCatching { startActivity(intent) }
    }

    /**
     * 强制模式的"加固"：拿 Shizuku 把后路堵上。
     *
     * 只有一件事：**无障碍被关掉后自愈**——替用户把自家服务塞回启用列表。
     * （设置页已经在 [enforceLock] 里用 `am force-stop` 处理掉了。）
     *
     * 这里**没有** `no_control_apps`：那条命令要 MANAGE_USERS，shell 身份拿不到
     * （`pm set-user-restriction` 在 Android 13+ 直接 SecurityException，实测）。
     * 所以"防卸载"本版做不到，界面上照实写。
     *
     * 30 秒最多做一次：这些命令要起 shell 进程，每秒执行纯属浪费电。
     */
    private fun hardenIfStrict(cfg: Config, now: LocalDateTime) {
        if (!LockEngine.isStrict(cfg)) return
        if (!ShizukuBridge.ready()) return
        if (KofAccessibility.alive()) return
        val nowMs = SystemClock.elapsedRealtime()
        if (nowMs - lastHardenAt < 30_000) return
        lastHardenAt = nowMs
        bg.execute {
            val comp = "$packageName/${KofAccessibility::class.java.name}"
            Log.i(TAG, "重新启用无障碍 -> " + ShizukuBridge.reenableAccessibility(comp))
        }
    }

    /**
     * 用户从最近任务里把本应用划掉：系统可能顺手回收服务。
     * 这里补一发 1.5 秒后的闹钟把自己叫回来——START_STICKY 是"尽力而为"，
     * 而这个场景（自律）不能"尽力而为"。
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (!Store.current.enabled) return
        val am = getSystemService(AlarmManager::class.java) ?: return
        val pi = PendingIntent.getBroadcast(
            this, 42, Intent(this, GuardHeartbeat::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        runCatching {
            am.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + 1500,
                pi,
            )
        }
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

    private fun buildOngoing(
        active: Boolean,
        st: ScheduleEngine.State?,
        locked: Boolean,
        sleeping: Boolean = false,
    ): Notification {
        // 锁机 / 睡眠期间点通知回的是遮罩页，而不是主界面：
        // 主界面上有个"启用自律"开关，那等于给遮罩配了一把钥匙。
        val kind = when {
            sleeping -> LockActivity.KIND_SLEEP
            locked -> LockActivity.KIND_FOCUS
            else -> ""
        }
        val open = PendingIntent.getActivity(
            this, 0,
            if (locked || sleeping) {
                Intent(this, LockActivity::class.java).putExtra(LockActivity.EXTRA_KIND, kind)
            } else {
                Intent(this, MainActivity::class.java)
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val now = LocalDateTime.now()
        val text = when {
            sleeping -> "睡眠时段 · 还有 " +
                ScheduleEngine.fmtLeft(SleepEngine.active(Store.current, now)?.leftSeconds ?: 0)
            locked -> "锁机中 · ${ScheduleEngine.fmtLeft(LockEngine.segmentLeftSeconds(Store.current, now))}"
            st == null -> "当前不在自律时段"
            st.inBreak -> "休息中 · ${ScheduleEngine.fmtLeft(st.leftSeconds)}"
            else -> "专注中 · ${ScheduleEngine.fmtLeft(st.leftSeconds)}"
        }
        val title = when {
            sleeping -> "King Of Focus · 睡眠中"
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

    private fun updateOngoing(
        active: Boolean,
        st: ScheduleEngine.State?,
        locked: Boolean,
        sleeping: Boolean = false,
    ) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(FOREGROUND_ID, buildOngoing(active, st, locked, sleeping))
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
        /** 采样式统计里忽略的进程：它们不是"用户在用某个应用" */
        private val SYSTEM_PKGS = setOf(
            "com.android.systemui",
            "com.android.launcher3",
            "com.google.android.apps.nexuslauncher",
        )

        internal const val SETTINGS_PKG = "com.android.settings"
        private const val FOREGROUND_ID = 1001
        private const val ALERT_ID = 1002

        fun start(ctx: android.content.Context) {
            val i = Intent(ctx, GuardService::class.java)
            ctx.startForegroundService(i)
        }

        /**
         * 心跳：每 15 分钟给自己发一次广播。
         *
         * 为什么还要它（前台服务不是已经常驻了吗）：
         * 国产 ROM 会在熄屏后把前台服务一起清掉，且 START_STICKY 并不保证回来。
         * 一个不精确的周期闹钟成本极低，却能把"清掉之后再也不回来"变成"最多 15 分钟回来"。
         * 不需要精确闹钟权限（那是 Android 12 之后要单独申请的东西）。
         */
        fun scheduleHeartbeat(ctx: android.content.Context) {
            val am = ctx.getSystemService(android.app.AlarmManager::class.java) ?: return
            val pi = android.app.PendingIntent.getBroadcast(
                ctx, 41, Intent(ctx, GuardHeartbeat::class.java),
                android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
            )
            runCatching {
                am.setInexactRepeating(
                    android.app.AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    android.os.SystemClock.elapsedRealtime() + HEARTBEAT_MS,
                    HEARTBEAT_MS,
                    pi,
                )
            }
        }

        fun cancelHeartbeat(ctx: android.content.Context) {
            val am = ctx.getSystemService(android.app.AlarmManager::class.java) ?: return
            val pi = android.app.PendingIntent.getBroadcast(
                ctx, 41, Intent(ctx, GuardHeartbeat::class.java),
                android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT,
            )
            runCatching { am.cancel(pi) }
        }

        private const val HEARTBEAT_MS = 15 * 60 * 1000L

        fun stop(ctx: android.content.Context) {
            ctx.stopService(Intent(ctx, GuardService::class.java))
        }
    }
}
