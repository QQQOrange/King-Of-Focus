package com.qqqorange.kingoffocus.service

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import androidx.core.app.NotificationCompat
import com.qqqorange.kingoffocus.MainActivity
import com.qqqorange.kingoffocus.R
import com.qqqorange.kingoffocus.core.Caps
import com.qqqorange.kingoffocus.core.DistractMath
import com.qqqorange.kingoffocus.core.GuardEngine
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.core.NotifyPlan
import com.qqqorange.kingoffocus.core.ScheduleEngine
import com.qqqorange.kingoffocus.core.SleepEngine
import com.qqqorange.kingoffocus.core.StatsMath
import com.qqqorange.kingoffocus.core.StatsStore
import com.qqqorange.kingoffocus.data.DistractStore
import com.qqqorange.kingoffocus.data.LedgerStore
import com.qqqorange.kingoffocus.data.StakeStore
import com.qqqorange.kingoffocus.core.StatsTrack
import com.qqqorange.kingoffocus.core.KeepAlive
import com.qqqorange.kingoffocus.core.UsageAccess
import com.qqqorange.kingoffocus.core.ShizukuBridge
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Slots
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
    /** 统计：上一拍的时间（用来算"这一拍实际经过了多少秒"） */
    private var statsAt: LocalDateTime? = null
    private var statsFlushAt = 0L
    /** 已经清理过哪一天的数据，避免每拍都去列目录 */
    private var statsPruneDay = ""

    /** 上次探测「使用情况访问」的时间与状态（用来发现"被回收"） */
    private var usageProbeAt = 0L
    private var lastUsageState: UsageAccess.State? = null

    /** 上一拍的阶段（false = 专注，true = 休息）；null = 不在时段内 / 刚启动 */
    private var prevInBreak: Boolean? = null

    /** 今日进度缓存（已自律分钟, 计划分钟） */
    private var progressAt = 0L
    private var progressCache: Pair<Int, Int>? = null
    private var lastBlockPkg: String? = null
    private var lastBlockAt = 0L
    private var lastLeft = -1L
    private var notifiedPhase = false
    private var lockShownAt = 0L
    /** 已经为哪一段提醒过"缺悬浮窗权限"，避免每秒刷一条通知 */
    private var warnedSeg = ""

    /** 上一拍是否在锁机 / 睡眠中：用来抓"进入"与"结束"这两个瞬间 */
    private var prevLocked = false
    private var prevSleeping = false
    /** 轻档拦截：上一次弹过哪个应用、什么时候（3 秒内不重复弹） */
    private var lastPagePkg: String? = null
    private var lastPageAt = 0L

    /** 已经为哪一次锁机发过"提前提醒"（键 = 类型 + 开始时刻），同一段只提醒一次 */
    private var preSentKey = ""
    private var preCalcAt = 0L
    /** 服务的第一拍：只用来建立"上一拍状态"，不做进入/结束动作 */
    private var firstTick = true

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
        running = true
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
        running = false
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

        // 当日汇总与"现在是不是自律时间"无关：一天快过完了都该告诉用户今天用了多久。
        // 放在最前面，免得被下面的 sleep / locked 提前 return 掉。
        maybeDailySummary(cfg, now)
        // 分心事件：段结束汇总 + 未完成项按间隔提醒（与睡眠/锁机分支无关，先做）
        maybeDistract(cfg, now)
        // 质押到点结算：不依赖界面在不在，关程序跨过结束时刻也能在下次启动补上
        maybeStake(cfg, now)

        // 常驻通知里的今日进度：不必每秒重算（读日文件 + 数分钟），30 秒一次就够
        val progress = if (cfg.notify.enabled && cfg.notify.ongoingProgress) {
            todayProgress(cfg, now)
        } else {
            null
        }
        // 进入/结束锁机的瞬间动作：震动、提前提醒、结束提醒。
        // 放在 updateOngoing 之后、分支 return 之前——睡眠和锁机两条路都要走到。
        onLockTransitions(cfg, now, locked, sleeping)

        updateOngoing(cfg.enabled && st != null, st, locked, sleeping, progress)

        // 睡眠优先：晚上这段整机先别用，和白天那套自律独立
        if (sleeping) {
            lastLeft = -1
            notifiedPhase = false
            prevInBreak = null
            enforceMask(cfg, now, LockActivity.KIND_SLEEP)
            return
        }

        // 锁机其次：开着锁机时，"拦截某个应用"被更彻底的"整台手机先别用"取代。
        // 但用户可以把「展示锁机页面」关掉——那样退成"只拦黑名单应用"的轻档：
        // 桌面随便用，点开黑名单应用才会跳一页 5 秒的提示。
        if (locked) {
            lastLeft = -1
            notifiedPhase = false
            prevInBreak = null
            if (cfg.lock.showPage) {
                enforceMask(cfg, now, LockActivity.KIND_FOCUS)
            } else {
                enforcePage(cfg, now)
            }
            hardenIfStrict(cfg, now)
            return
        }

        if (st == null) {
            lastLeft = -1
            notifiedPhase = false
            prevInBreak = null
            return
        }

        // 专注与休息都要走通知：以前这里只处理专注段，
        // 于是「休息结束前提醒」永远发不出来（st.inBreak 早就 return 了）
        maybeNotify(cfg, st)
        maybeComplete(cfg, st)
        if (!st.inBreak) enforce(cfg, now)
    }

    /**
     * 使用时长采样 —— 口径与桌面端 `stats.rs` 一致：**每一秒结算一次**。
     *
     * 与以前的差别（每 15 秒记一笔固定 15 秒）：
     *  · 按**实际经过的秒数**记账，定时器漂移不会让总时长系统性偏小；
     *  · 跨整点/跨天由 `StatsMath.slices` 切开，23:59:58 的两秒不会算进第二天；
     *  · 双轨：自律生效中的时间记 `on`，其余记 `off`（判定见 `StatsTrack`）；
     *  · 熄屏、锁屏、停在桌面/自家界面一律**不记**，并封口当前连续段；
     *  · `countIdle=false` 时额外要求 60 秒内有过交互（无障碍事件时间戳）。
     *
     * 样本太大就封口：桌面端切窗口就封口，手机端"换应用"靠 key 不同自然分开，
     * 这里只需在"没有在记"的时候明确收尾，避免下次回来被并成一段假的长时段。
     */
    private fun sampleStats(cfg: Config, now: LocalDateTime) {
        val from = statsAt ?: now
        statsAt = now

        // 落盘与清理不依赖"这一拍到底记不记"，否则熄屏一夜就不会 flush
        val t = SystemClock.elapsedRealtime()
        if (t - statsFlushAt > FLUSH_EVERY_MS) {
            statsFlushAt = t
            StatsStore.flush()
        }
        val day = StatsStore.dayKey(now)
        if (day != statsPruneDay) {
            statsPruneDay = day
            StatsStore.prune(cfg.stats.retentionDays)
        }

        if (!cfg.stats.enabled) {
            StatsStore.closeSpan()
            return
        }

        // 权限状态：每 10 秒探一次（AppOps 调用不算便宜），并记录状态迁移。
        // 没有权限时**不采样**，但原因要落到 UsageAccess.last 上，页面上直接显示，
        // 绝不能让用户看着一屏 0 以为是"今天没用手机"。
        if (t - usageProbeAt > USAGE_PROBE_MS) {
            usageProbeAt = t
            val st = UsageAccess.probe(this, cfg)
            if (st.state != lastUsageState) {
                val prev = lastUsageState
                lastUsageState = st.state
                // 只有"从有到无"才提醒：首次没给过由界面卡片引导，不打扰
                if (prev == UsageAccess.State.GRANTED && st.state == UsageAccess.State.REVOKED) {
                    alert(
                        "「使用情况访问」被收回了",
                        "统计已暂停。可能是清理软件或系统更新把它关掉了，点通知回到应用重新授予即可。",
                    )
                }
            }
        }
        val access = UsageAccess.last ?: UsageAccess.probe(this, cfg)
        if (!access.canRecord) {
            StatsStore.closeSpan()
            return
        }

        if (!now.isAfter(from)) return

        // 熄屏 / 锁屏 = 人不在：这一段时间一点都不记（桌面端靠"无输入 60 秒"达到同一效果）
        val pm = getSystemService(android.os.PowerManager::class.java)
        if (pm != null && !pm.isInteractive) {
            StatsStore.closeSpan()
            return
        }
        val km = getSystemService(android.app.KeyguardManager::class.java)
        if (km != null && km.isKeyguardLocked) {
            StatsStore.closeSpan()
            return
        }

        // 严格模式：还要求最近 60 秒内有过交互。
        // 没有无障碍权限时拿不到这个信号——那就只能退回"亮屏即算"，
        // 设置页里已经写清楚这一点，不假装生效。
        if (!cfg.stats.countIdle) {
            val idle = KofAccessibility.idleMillis()
            if (idle != null && idle > IDLE_TIMEOUT_MS) {
                StatsStore.closeSpan()
                return
            }
        }

        val fg = foreground()
        // 桌面（launcher）、自家界面、系统界面都不算"在用某个应用"
        if (fg == null || fg == packageName || fg in SYSTEM_PKGS) {
            StatsStore.closeSpan()
            return
        }

        StatsStore.record(
            from = from,
            to = now,
            key = fg,
            label = labelOf(fg),
            onTrack = StatsTrack.on(cfg, now),
        )
    }

    /** 应用显示名：缓存一次，别每秒去问 PackageManager */
    private val labelCache = HashMap<String, String>()

    private fun labelOf(pkg: String): String = labelCache.getOrPut(pkg) {
        runCatching {
            val pm = packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        }.getOrDefault(pkg)
    }

    /**
     * 锁机相关的三个瞬间。
     *
     * | 瞬间 | 动作 | 为什么在这里做 |
     * |---|---|---|
     * | 进入锁机 / 睡眠 | 震动一下 | 用户可能正低头看别处，震一下是最快的"现在开始了" |
     * | 开始前 N 分钟 | 一条提前提醒 | 整机锁会打断导航、付款码、正在写的消息，得给收尾时间 |
     * | 结束 | 通知 / 弹窗 / 两者 | 结束了却不知道，用户会以为坏了 |
     *
     * "结束"只在**这一段时间真的走完**时算：暂停、停止本段、积分解锁都是用户
     * 主动买来的自由，那时候提示"锁机结束"是噪音（而且会让人以为自律失效了）。
     */
    private fun onLockTransitions(
        cfg: Config,
        now: LocalDateTime,
        locked: Boolean,
        sleeping: Boolean,
    ) {
        // 首拍只记基线：服务被系统重启时（很可能正锁着）不该再震一次、
        // 更不该把"上一段已经结束"当成刚发生。这和"刚启动不算任务完成"是同一条原则。
        if (!firstTick) {
            val startLock = locked && !prevLocked
            val startSleep = sleeping && !prevSleeping
            if (startLock || startSleep) vibrateOnce(cfg)
        }

        val endLock = prevLocked && !locked
        val endSleep = prevSleeping && !sleeping
        if (endLock || endSleep) {
            // 只有"这一段真的走完"才提醒。三种情况都不算走完：
            //  · 暂停买了一会儿自由（仍在专注段里，只是锁机被暂时关掉）；
            //  · 停止本段（用户明确说不锁了）；
            //  · 睡眠用积分解锁（人还醒着，只是买了十分钟）。
            // 判据用**时间本身**而不是"锁机是否还生效"——后者正是被暂停改写的那个值，
            // 拿它判会把"暂停"误报成"结束"（上一版就是这么错的）。
            val stillFocusing = ScheduleEngine.stateAt(cfg, now)?.focusing == true
            val stillInSleepWindow = SleepEngine.active(cfg, now) != null
            val natural = if (endSleep) !stillInSleepWindow else {
                !stillFocusing || !cfg.enabled || !cfg.lock.enabled
            }
            if (natural) notifyLockEnd(cfg, endSleep)
        }
        prevLocked = locked
        prevSleeping = sleeping
        firstTick = false

        maybeLockPreAlert(cfg, now)
    }

    /** 进入锁机/睡眠时短震一下（默认开；关掉后完全静音进入） */
    private fun vibrateOnce(cfg: Config) {
        if (!cfg.lock.vibrate) return
        val v = getSystemService(Vibrator::class.java) ?: return
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(180, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(180)
            }
        }
    }

    /**
     * 锁机开始前的提前提醒：**每一次锁机只提醒一次**。
     *
     * 去重的键是"下一次锁机的开始时刻"，不是"当前时间"：提前 5 分钟意味着有
     * 300 拍都满足"到点了"，不记住"这一次说过了"就会刷出 300 条。
     */
    private fun maybeLockPreAlert(cfg: Config, now: LocalDateTime) {
        val before = cfg.lock.beforeMin
        if (before <= 0 || !cfg.notify.enabled) return
        val t = SystemClock.elapsedRealtime()
        // 向后找"下一次整机不能用"要逐拍试算（最多 720 次 stateAt），20 秒算一次足够
        if (t - preCalcAt < 20_000) return
        preCalcAt = t

        // 两个来源：锁机与睡眠。它们的共同点是"整台手机马上不能用"，
        // 所以共用同一个提前量，取更早的那个提醒（同一时刻只发一条）。
        // 只需要看"提前量 + 一点余量"这么远：超出这个范围的一次锁机，
        // 这一拍本来就不该提醒，多探 12 小时纯属浪费（这是每秒一拍的循环）
        val horizon = (before / 60 + 1).coerceIn(1, 2)
        var bestKey = ""
        var bestSecs = Long.MAX_VALUE
        var bestSleep = false
        LockEngine.secondsUntilStart(cfg, now, horizon)?.takeIf { it > 0 }?.let { secs ->
            val start = now.plusSeconds(secs)
            bestKey = "lock|" + start.toLocalDate() + "|" + start.hour + ":" + start.minute
            bestSecs = secs
        }
        SleepEngine.secondsUntilStart(cfg, now, horizon)?.takeIf { it > 0 }?.let { secs ->
            if (secs < bestSecs) {
                val start = now.plusSeconds(secs)
                bestKey = "sleep|" + start.toLocalDate() + "|" + start.hour + ":" + start.minute
                bestSecs = secs
                bestSleep = true
            }
        }
        if (bestKey.isEmpty()) return
        if (!NotifyPlan.shouldPreAlert(before, bestSecs, bestKey, preSentKey)) return
        preSentKey = bestKey
        notifyOnce(
            CH_LOCK,
            LOCK_PRE_ID,
            if (bestSleep) "睡眠时段即将开始" else "锁机即将开始",
            NotifyPlan.preAlertText(bestSecs, sleep = bestSleep),
        )
    }

    /**
     * 锁机结束提醒。
     *
     * 弹窗要能盖住当前应用，而 Android 10+ 后台拉起界面需要悬浮窗或 Shizuku。
     * 拿不到就**只发通知**并在正文里说明——假装弹过比不弹更糟。
     */
    private fun notifyLockEnd(cfg: Config, sleep: Boolean) {
        val mode = cfg.lock.endNotice
        if (mode == "none") return
        val canDialog = caps().canShowMask()
        val wantDialog = NotifyPlan.endDialog(mode) && canDialog
        val wantNotify = NotifyPlan.endNotify(mode) || (NotifyPlan.endDialog(mode) && !canDialog)
        val title = if (sleep) "睡眠时段结束" else "锁机结束"
        val body = if (sleep) {
            "早上好。睡眠时段已经走完，手机恢复正常使用。"
        } else {
            "这一段锁机走完了，休息一下眼睛。"
        }
        if (wantNotify) {
            notifyOnce(
                CH_LOCK, LOCK_END_ID, title,
                body + if (NotifyPlan.endDialog(mode) && !canDialog) {
                    "（没拿到悬浮窗权限，弹窗提醒改成了通知）"
                } else "",
            )
        }
        if (wantDialog) showLockEnd(title, body)
    }

    /** 盖上"锁机结束"页：只是一个能一眼看懂、点一下就走的提示，不拦任何东西 */
    private fun showLockEnd(title: String, body: String) {
        val intent = Intent(this, LockActivity::class.java)
            .putExtra(LockActivity.EXTRA_KIND, LockActivity.KIND_END)
            .putExtra(LockActivity.EXTRA_END_TITLE, title)
            .putExtra(LockActivity.EXTRA_END_BODY, body)
            .addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
            )
        if (ShizukuBridge.ready()) {
            val comp = "$packageName/${LockActivity::class.java.name}"
            bg.execute {
                val ok = ShizukuBridge.startActivity(
                    comp,
                    "--es ${LockActivity.EXTRA_KIND} ${LockActivity.KIND_END}",
                )
                if (!ok) handler.post { runCatching { startActivity(intent) } }
            }
            return
        }
        runCatching { startActivity(intent) }
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
     * 任务完成通知：**阶段切换那一刻**发一条。
     *
     * 和「结束前提醒」是两件事：那个说「还有 5 分钟」，这个说「这一段做完了」。
     * 只留前者的话，用户放下手机就再也不知道自己完成了。
     *
     * 只在真正跨过阶段边界时发：
     *  · 首次进入时段（prev == null）不发——那是"刚打开应用"，不是"完成"；
     *  · 从时段里出来（st 变 null）不发——可能是手动关了开关或切了方案，发了就是误报。
     */
    private fun maybeComplete(cfg: Config, st: ScheduleEngine.State) {
        val prev = prevInBreak
        prevInBreak = st.inBreak
        // 判定在 NotifyPlan 里：null = 不该发，也保证"刚启动不算完成"
        val title = NotifyPlan.completeTitle(prev, st.inBreak) ?: return
        if (!cfg.notify.enabled || !cfg.notify.done) return
        val now = LocalDateTime.now()
        val head = if (st.inBreak) {
            "这一段做完了，休息 ${st.brk.coerceAtLeast(0)} 分钟"
        } else {
            "开始下一轮专注，先做最重要的那件"
        }
        val plan = Slots.dayMinutes(cfg.days.getOrNull(now.dayOfWeek.value - 1).orEmpty())
        val doneMin = StatsStore.today(now).total(true) / 60
        val tail = if (plan > 0) " · 今日已自律 $doneMin/$plan 分" else ""
        notifyOnce(CH_DONE, DONE_ID, title, head + tail)
    }

    /**
     * 当日使用时长汇总：每天固定时间一条。
     *
     * 三条约束：
     *  · 只在"今天确实有记录"时发（total > 0），否则一天没碰手机也会被打扰；
     *  · **先落盘最后发送**：发到一半服务被杀，也不会整晚重复提醒；
     *  · 时间点可调（默认 22 点），改早了当天立刻会用新时间判断。
     */
    private fun maybeDailySummary(cfg: Config, now: LocalDateTime) {
        val n = cfg.notify
        val today = now.toLocalDate().toString()
        val due = NotifyPlan.shouldSummarize(
            notifyEnabled = n.enabled,
            summaryEnabled = n.dailySummary,
            hourOfDay = now.hour,
            dailyAt = n.dailyAt,
            today = today,
            lastDay = n.lastSummaryDay,
        )
        if (!due) return

        val day = StatsStore.today(now)
        val total = StatsMath.total(day, null)
        // 到点时今天还没有任何记录 → 先不发，**也不记账**：
        // 记了的话，用户 22:00 后才开始用手机，就再也收不到今天的汇总了。
        if (total <= 0) return

        // 真发了才记账：通知被系统静音也算"发过了"，不能每拍重试
        Store.update { c -> c.copy(notify = c.notify.copy(lastSummaryDay = today)) }
        val on = StatsMath.total(day, true)
        val top = StatsMath.top(listOf(now.toLocalDate() to day), null, 3)
        val body = buildString {
            append("自律时段内 ")
            append(StatsMath.fmtDuration(on))
            append("（")
            append(if (total > 0) on * 100 / total else 0)
            append("%）")
            if (top.isNotEmpty()) {
                append(" · 用得最多：")
                append(top.take(2).joinToString("、") { labelOf(it.first) })
            }
        }
        notifyOnce(CH_DAILY, DAILY_ID, "今日使用 " + StatsMath.fmtDuration(total), body, big = true)
    }

    /**
     * 今日进度（已自律分钟 / 计划分钟），供常驻通知显示。
     *
     * 30 秒缓存：`StatsStore.today` 会读日文件，`Slots.dayMinutes` 要遍历 24 小时，
     * 每秒各做一次没必要——这个数字一分钟才变一次量级。
     */
    private fun todayProgress(cfg: Config, now: LocalDateTime): Pair<Int, Int> {
        val t = SystemClock.elapsedRealtime()
        val cached = progressCache
        if (cached != null && t - progressAt < PROGRESS_EVERY_MS) return cached
        progressAt = t
        val plan = Slots.dayMinutes(cfg.days.getOrNull(now.dayOfWeek.value - 1).orEmpty())
        val done = StatsStore.today(now).total(true) / 60
        return (done to plan).also { progressCache = it }
    }

    // ---------------- 专注质押 ----------------

    /**
     * 结算到点的质押。
     *
     * 手机端没有桌面那套 `totalEarned` 记账（积分只有一个余额），所以这里只加余额。
     */
    private fun maybeStake(cfg: Config, now: LocalDateTime) {
        val back = StakeStore.settleDue(cfg, now)
        if (back > 0) {
            Store.update { it.copy(points = it.points + back) }
            notifyOnce(
                CH_ALERT,
                ID_STAKE,
                "这一段的押金退回来了",
                "退回 $back 分（含干净跑完的奖励）",
                true,
            )
        }
    }

    // ---------------- 分心事件 ----------------

    /** 上一拍是不是在专注。段结束只在 true → false 的那一拍处理 */
    private var wasFocusing = false

    /**
     * 分心事件的两条提醒。
     *
     * 判据都用**时间**，不用"遮罩还在不在"：后者会被暂停 / 停止本段改写，
     * 拿它当判据会出现"暂停时误报结束"（桌面端踩过）。
     */
    private fun maybeDistract(cfg: Config, now: LocalDateTime) {
        if (!cfg.distract.enabled) {
            wasFocusing = false
            return
        }
        val focusing = ScheduleEngine.stateAt(cfg, now)?.focusing == true
        val nowSec = System.currentTimeMillis() / 1000

        // 1) 段结束：汇总这一段记下的
        if (wasFocusing && !focusing) {
            // 刚结束的是哪一段：用"一分钟前"去算（翻面的这一刻，这一段已经不在范围里）
            val prev = DistractMath.segmentBounds(cfg, now.minusMinutes(1))
            val goal = if (prev != null) com.qqqorange.kingoffocus.data.GoalStore.of(prev.start) else ""
            val items = DistractMath.endedSegment(DistractStore.items.value, nowSec)
            val parts = ArrayList<String>()
            if (goal.isNotBlank()) parts += "目标：$goal"
            if (items.isNotEmpty()) {
                parts += if (items.size == 1) {
                    "记下 1 条：" + items[0].text.take(18)
                } else {
                    "记下 ${items.size} 条想法，去「分心事件」逐条处理"
                }
            }
            if (parts.isNotEmpty()) {
                notifyOnce(CH_ALERT, ID_DISTRACT_END, "这一段结束了", parts.joinToString(" · "), true)
            }
            if (items.isNotEmpty()) DistractStore.markNudged(items.map { it.id }, nowSec)
        }
        wasFocusing = focusing

        // 2) 未完成项：间隔到点就再提醒一次
        val due = DistractStore.due(cfg, nowSec)
        if (due.isNotEmpty()) {
            val first = due[0].text.take(18)
            val body = if (due.size == 1) {
                "「$first」还没处理"
            } else {
                "还有 ${due.size} 条没处理，最早一条：$first"
            }
            notifyOnce(CH_ALERT, ID_DISTRACT_DUE, "分心事件待处理", body, true)
            DistractStore.markNudged(due.map { it.id }, nowSec)
        }
    }

    /** 发一条独立通知（可被用户划掉；没有通知权限时静默失败，不崩） */
    private fun notifyOnce(
        channel: String,
        id: Int,
        title: String,
        body: String,
        big: Boolean = false,
    ) {
        val nm = getSystemService(NotificationManager::class.java)
        val b = NotificationCompat.Builder(this, channel)
            .setSmallIcon(R.drawable.ic_stat_focus)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(openApp())
        if (big) b.setStyle(NotificationCompat.BigTextStyle().bigText(body))
        runCatching { nm.notify(id, b.build()) }
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 2, Intent(this, MainActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

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
        // 3 秒内同一条重复拦：既保证"马上就退出"，又不至于每秒刷一堆动作
        if (pkg == lastBlockPkg && nowMs - lastBlockAt < 3000) return
        lastBlockPkg = pkg
        lastBlockAt = nowMs

        val label = appLabel(pkg)
        val whitelist = rule.mode == "whitelist"
        // 先回桌面：用户多半正停在这个应用里，先把他送走，再处理那个应用，
        // 否则杀进程的一瞬间会闪一下白屏，看起来像崩了。
        goHome()

        if (whitelist && !GuardEngine.isShell(pkg) && ShizukuBridge.ready()) {
            // "强制退出"真的能做到的唯一路径：shell 身份的 am force-stop。
            // 没有 Shizuku 时 Android 不允许一个应用结束另一个应用，只能回桌面 + 通知。
            bg.execute {
                Log.i(TAG, "白名单外的应用，强制退出 $pkg -> " + ShizukuBridge.forceStop(pkg))
            }
            alert("「$label」现在不能用", "它不在白名单里，已经把它关掉并回到桌面。")
        } else {
            alert("「$label」现在不能用", "命中规则「${rule.name}」。已回到桌面，做点别的。")
        }
        // 账本：只记**真的动手拦了**的这一处；"扫到但放过"不记，否则次数虚高
        LedgerStore.record("app", pkg, label, rule.name)
    }

    /** 只有专注期的拦截才进账本：睡眠期被拦是"该睡觉"，不算分心 */
    private fun fnKind(kind: String): Boolean = kind == LockActivity.KIND_FOCUS

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
        // 没有任何一条路能把遮罩盖上来时：
        //   · 必须说清楚为什么（否则用户以为锁机生效了，其实手机随便用）；
        //   · 但**不能什么都不做**——以前这里直接 return，于是"锁机开着、应用随便开"，
        //     这正是"白名单模式下仍能进入未加白名单应用"的一个真实成因。
        //     现在降级成"回桌面 + 通知"：盖不住屏幕，但至少把人从那个应用里拽出来。
        if (!caps.canShowMask()) {
            val seg = LockEngine.segmentKey(cfg, now)
            if (warnedSeg != seg) {
                warnedSeg = seg
                alert(
                    "锁机没生效：缺「悬浮窗」或 Shizuku",
                    "系统不允许后台拉起遮罩页，已改成回桌面 + 通知。请授予「悬浮窗」，或安装 Shizuku 并授权。",
                    openOverlaySettings = true,
                )
            }
            goHome()
            return
        }
        val fg = foreground()
        // 读不到前台：不知道用户在哪个应用里，但锁机是生效的。
        // 这时**宁可把遮罩盖上**（fail-closed）——盖上之后至少白名单入口还在，
        // 比"因为看不见所以放行"安全得多。
        if (fg.isNullOrEmpty()) {
            showLock(kind)
            return
        }
        if (fg == packageName) return
        // 判定只有一个出口：LockEngine.decision。
        // 睡眠恒为"整机锁"（白名单应用仍可用），锁机按 cfg.lock.scope 走
        // 「整机锁 / 只允许白名单 / 只禁黑名单」三种之一。
        val decision = LockEngine.decision(
            cfg = cfg,
            pkg = fg,
            sleep = kind == LockActivity.KIND_SLEEP,
            selfPkg = packageName,
            imePkgs = imePkgs,
        )
        if (!decision.block) return
        // 锁机把人拽出来也算一次"被打断"（账本自己做了 30 秒去重，
        // 这里每秒判定一次不会把次数刷爆）
        if (fnKind(kind)) LedgerStore.record("app", fg, appLabel(fg), decision.why)
        if (fg !in homePkgs) {
            goHome()
            // 给桌面一点时间完成切换，再压上遮罩；否则遮罩会盖在旧应用上
            handler.postDelayed({ showLock(kind) }, 260)
        } else {
            showLock(kind)
        }
    }

    /**
     * 轻档拦截：「展示锁机页面」关掉时用它。
     *
     * 与 [enforceMask] 的区别是**不整机锁**：桌面、通知栏、别的应用都能正常用，
     * 只有点开黑名单里的应用，才盖一页「这个应用现在不能用」，5 秒后自己回桌面。
     *
     * 拉不起界面时（没有悬浮窗 / Shizuku）退回"回桌面 + 通知"——
     * 这是同一件事的弱化版，比什么都不做强，也比假装拦住了诚实。
     */
    private fun enforcePage(cfg: Config, now: LocalDateTime) {
        val fg = foreground() ?: return
        if (!LockEngine.pageBlocked(cfg, fg, packageName, imePkgs)) return
        val nowMs = SystemClock.elapsedRealtime()
        // 3 秒内同一个应用只弹一次：否则一开就"弹→回来→又被弹"，像坏了
        if (fg == lastPagePkg && nowMs - lastPageAt < PAGE_GAP_MS) return
        lastPagePkg = fg
        lastPageAt = nowMs

        val rule = GuardEngine.lockRules(cfg)
            .firstOrNull { it.mode != "whitelist" && fg in it.packages }
            ?.name.orEmpty()
        if (!caps().canShowMask()) {
            goHome()
            val seg = LockEngine.segmentKey(cfg, now)
            if (warnedSeg != "page|$seg") {
                warnedSeg = "page|$seg"
                alert(
                    "锁机页弹不出来：缺「悬浮窗」或 Shizuku",
                    "系统不允许后台拉起界面，已改成回桌面 + 通知。请在总览页授予悬浮窗，或装 Shizuku 并授权。",
                    openOverlaySettings = true,
                )
            }
            return
        }
        showLock(LockActivity.KIND_PAGE, rule)
        LedgerStore.record("app", fg, appLabel(fg), rule)
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
    private fun showLock(kind: String, rule: String = "") {
        // 800ms 内的重复请求**排到窗口之后**，而不是丢掉。
        // 丢掉的那个很可能正是 goHome() 之后 260ms 补的那一发 ——
        // 结果是"回了桌面但没盖遮罩"，用户看起来就是"锁机没生效"。
        val nowMs = SystemClock.elapsedRealtime()
        val wait = 800 - (nowMs - lockShownAt)
        if (wait > 0) {
            handler.postDelayed({ showLockNow(kind, rule) }, wait + 20)
            return
        }
        showLockNow(kind, rule)
    }

    private fun showLockNow(kind: String, rule: String) {
        lockShownAt = SystemClock.elapsedRealtime()
        val intent = Intent(this, LockActivity::class.java)
            .putExtra(LockActivity.EXTRA_KIND, kind)
            .putExtra(LockActivity.EXTRA_RULE, rule)
            .addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
            )
        if (ShizukuBridge.ready()) {
            val comp = "$packageName/${LockActivity::class.java.name}"
            bg.execute {
                // 失败不能闷着：退回到直接 startActivity（有悬浮窗时它是通的）
                val args = "--es ${LockActivity.EXTRA_KIND} $kind" +
                    if (rule.isEmpty()) "" else " --es ${LockActivity.EXTRA_RULE} $rule"
                if (!ShizukuBridge.startActivity(comp, args)) {
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
        // 完成与汇总单独开渠道：用户可以只关掉"完成"，保留"汇总"（系统设置里按渠道关）
        nm.createNotificationChannel(
            NotificationChannel(CH_DONE, "任务完成", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "专注段做完 / 休息结束时提醒一条"
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_DAILY, "每日使用汇总", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "每天固定时间汇总当天的使用时长与自律时长"
                setShowBadge(false)
            },
        )
        // 锁机开始前 / 结束的提醒单独一个渠道：想只留"结束"、关掉"即将开始"的人有得选
        nm.createNotificationChannel(
            NotificationChannel(CH_LOCK, "锁机提醒", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "锁机开始前的提前提醒与结束提醒"
            },
        )
    }

    private fun buildOngoing(
        active: Boolean,
        st: ScheduleEngine.State?,
        locked: Boolean,
        sleeping: Boolean = false,
        progress: Pair<Int, Int>? = null,
    ): Notification {
        // 锁机 / 睡眠期间点通知回的是遮罩页，而不是主界面：
        // 主界面上有个"启用自律"开关，那等于给遮罩配了一把钥匙。
        val kind = when {
            sleeping -> LockActivity.KIND_SLEEP
            locked -> LockActivity.KIND_FOCUS
            else -> ""
        }
        // 轻档（不展示整机锁机页）时点通知回主界面：这时候本来就没锁整机，
        // 把人带到全屏遮罩反而比他自己设置的更狠
        val open = PendingIntent.getActivity(
            this, 0,
            if (sleeping || (locked && Store.current.lock.showPage)) {
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
            locked -> if (Store.current.lock.showPage) {
                "锁机中 · ${ScheduleEngine.fmtLeft(LockEngine.segmentLeftSeconds(Store.current, now))}"
            } else {
                // 轻档如实说：整机没锁，只是黑名单应用会被弹回去
                "锁机中 · 仅拦黑名单应用"
            }
            // 自律关着、只在记录时长：如实说，别让常驻通知看起来像"自律在跑"
            st == null && !Store.current.enabled -> "自律已关闭 · 正在记录使用时长"
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
        // 今日进度：只在"有计划"时显示，否则 0/0 比不显示更让人困惑
        val p = progress?.takeIf { it.second > 0 }
        val body = if (p != null) "$text · 今日 ${p.first}/${p.second} 分" else text
        val b = NotificationCompat.Builder(this, CH_ONGOING)
            .setSmallIcon(R.drawable.ic_stat_focus)
            .setContentTitle(title)
            .setContentText(body)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
        if (p != null) {
            b.setProgress(100, NotifyPlan.progressPct(p.first, p.second), false)
            b.setSubText("今日自律 ${p.first}/${p.second} 分")
        }
        return b.build()
    }

    private fun updateOngoing(
        active: Boolean,
        st: ScheduleEngine.State?,
        locked: Boolean,
        sleeping: Boolean = false,
        progress: Pair<Int, Int>? = null,
    ) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(FOREGROUND_ID, buildOngoing(active, st, locked, sleeping, progress))
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
        /**
         * 服务是不是活着。
         *
         * 为什么要这个标志：Android 上没有可靠的"我的服务还在吗"查询
         * （`getRunningServices` 对第三方应用早就废了），而"现在到底有没有在守护"
         * 恰恰是用户最需要一眼看清的事——首页那条状态带读的就是它。
         */
        @Volatile
        private var running = false

        fun isRunning(): Boolean = running

        private const val TAG = "KofGuard"
        private const val CH_ONGOING = "kof_ongoing"
        private const val CH_ALERT = "kof_alert"
        private const val CH_DONE = "kof_done"
        private const val CH_DAILY = "kof_daily"
        private const val CH_LOCK = "kof_lock"
        /** 分心事件的两条通知：固定 id，重复提醒只会覆盖不会堆一屏 */
        private const val ID_DISTRACT_END = 7411
        private const val ID_DISTRACT_DUE = 7412
        private const val ID_STAKE = 7413
        /** 锁机提醒两个 id：提醒是"事件"，同一类只留最新一条 */
        private const val LOCK_PRE_ID = 4104
        private const val LOCK_END_ID = 4105
        /** 同一个应用两次轻档拦截的最小间隔 */
        private const val PAGE_GAP_MS = 3_000L
        /** 完成通知与汇总通知的固定 id：同一类只留最新一条，不刷屏 */
        private const val DONE_ID = 4102
        private const val DAILY_ID = 4103
        /** 今日进度缓存时长 */
        private const val PROGRESS_EVERY_MS = 30_000L
        /** 采样式统计里忽略的进程：它们不是"用户在用某个应用" */
        /** 落盘间隔：桌面端 15 秒一次，手机端 60 秒够用（坏一个文件最多丢一分钟） */
        private const val FLUSH_EVERY_MS = 60_000L

        /** 严格空闲阈值：与桌面端 `IDLE_TIMEOUT_SECS` 同一含义 */
        private const val IDLE_TIMEOUT_MS = 60_000L

        /** 多久探一次权限状态 */
        private const val USAGE_PROBE_MS = 10_000L

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
         * 服务该不该跑：**自律开着，或者统计开着**。
         *
         * 以前只有"自律开着"才跑，于是关掉自律之后统计整条停摆——
         * 而统计页是双轨的（自律时段内 / 时段外），关掉自律的那段时间
         * 恰恰是"时段外"数据的主要来源。桌面端的监控器与自律开关本来就是两件事，
         * 手机端现在对齐。
         */
        fun shouldRun(cfg: com.qqqorange.kingoffocus.data.Config): Boolean =
            cfg.enabled || cfg.stats.enabled

        /** 按当前配置把服务与心跳调到应有状态（唯一入口，别各处自己 start/stop） */
        fun sync(ctx: android.content.Context, cfg: com.qqqorange.kingoffocus.data.Config = Store.current) {
            if (shouldRun(cfg)) {
                runCatching { start(ctx) }
                scheduleHeartbeat(ctx)
                // 第二条保活通道：部分 ROM 拦闹钟但放行 Job
                KeepAlive.scheduleJob(ctx, cfg)
            } else {
                stop(ctx)
                cancelHeartbeat(ctx)
                KeepAlive.cancelJob(ctx)
            }
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
