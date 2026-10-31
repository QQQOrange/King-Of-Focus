package com.qqqorange.kingoffocus.core

import android.app.ActivityManager
import android.app.AppOpsManager
import android.app.NotificationManager
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.service.GuardJobService
import com.qqqorange.kingoffocus.service.GuardService

/**
 * 保活体检 + 自愈。
 *
 * ## 为什么手机上的"自律"必须先解决保活
 *
 * 这套东西的运行方式是**常驻前台服务每秒采样**。服务一旦被系统清掉：
 * 时段不再判定、规则不再拦截、统计不再记录——界面上却仍然显示"已开启"。
 * 那比崩溃更糟：用户以为自己被管着，其实没有。
 *
 * ## 需要的权限 / 系统设置（每一项都有明确的"缺了会怎样"）
 *
 * | 项 | 用途 | 申请时机 | 缺失影响 |
 * |---|---|---|---|
 * | 使用情况访问 | 读"当前前台是哪个应用" | 首次开启统计 / 统计页提示 | 统计无法开始（Android 没有别的跨进程接口） |
 * | 无障碍服务 | 切应用**即时**识别、全局回桌面、强模式挡住设置页 | 首次进总览 / 缺能力时 | 退回 1 秒轮询，切应用有几秒延迟；强模式防绕过失效 |
 * | 悬浮窗 | 后台拉不起 Activity 时，用悬浮窗把锁机遮罩盖上来 | 首次开锁机 | 锁机**静默失效**（系统拦截后台启动 Activity） |
 * | 通知 | 常驻状态、阶段提醒、锁机通知 | 首次启动（Android 13+ 运行时权限） | 前台服务通知不显示、提醒收不到 |
 * | 电池优化白名单 | 不在 Doze 里被冻结 | 服务被冻结后 / 保活体检 | 息屏几分钟后采样与拦截停摆 |
 * | 自启动（厂商设置） | 开机、被清理后能自己回来 | 保活体检（无标准 API，只能引导） | 重启后要手动打开一次 |
 *
 * ## 保活措施组合（单靠任何一条都不够）
 *
 * 1. **前台服务 + 常驻通知**（`specialUse`）——正常情况下的主力；
 * 2. **START_STICKY**——被系统回收后由系统尽力重建；
 * 3. **onTaskRemoved 补一发闹钟**——从最近任务划掉时立刻拉回；
 * 4. **AlarmManager 15 分钟心跳**——被清理软件清掉后的兜底；
 * 5. **JobScheduler 周期任务**——第二条独立通道，某些 ROM 只放行 Job 不放行 Alarm；
 * 6. **开机 / 应用更新广播**——冷启动路径；
 * 7. **电池优化白名单**——不让 Doze 把服务冻住；
 * 8. **界面前台自愈**——每次回到应用都检查服务是否还活着，不活着就拉起来。
 *
 * 这套组合的定位是"尽量活"，不是"绝对杀不死"：Android 上任何应用都做不到后者，
 * 所以体检结果必须**如实展示**，缺哪一项就写清缺了会怎样。
 */
object KeepAlive {

    data class Item(
        val title: String,
        /** 用途 */
        val purpose: String,
        /** 申请时机 */
        val whenAsk: String,
        /** 缺失影响 */
        val impact: String,
        val ok: Boolean,
        /** 点"去设置"要跳的地方；null = 没有可直接跳的页面 */
        val action: Intent?,
    )

    /** 体检：逐项列出状态与"缺了会怎样" */
    fun audit(ctx: Context, cfg: Config): List<Item> = listOf(
        Item(
            title = "使用情况访问",
            purpose = "读取当前前台是哪个应用（统计的唯一来源）",
            whenAsk = "首次开启统计、统计页提示里",
            impact = "统计无法开始；拦截仍可用（靠无障碍）",
            ok = GuardEngine.hasUsageAccess(ctx),
            action = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        ),
        Item(
            title = "无障碍服务",
            purpose = "切应用即刻识别、全局回桌面、强制模式防绕过",
            whenAsk = "首次进总览、缺能力时",
            impact = "退回 1 秒轮询（切应用延迟数秒），强制模式挡不住去设置里关",
            ok = com.qqqorange.kingoffocus.service.KofAccessibility.alive() ||
                isAccessibilityEnabled(ctx),
            action = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        ),
        Item(
            title = "在其他应用上层显示",
            purpose = "后台拉不起页面时，用悬浮窗把锁机遮罩盖上来",
            whenAsk = "首次开启锁机",
            impact = "锁机静默失效（系统会拦截后台启动 Activity）",
            ok = Settings.canDrawOverlays(ctx),
            action = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                android.net.Uri.parse("package:${ctx.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        ),
        Item(
            title = "通知",
            purpose = "前台服务常驻状态、阶段提醒、锁机提示",
            whenAsk = "首次启动（Android 13+ 运行时权限）",
            impact = "常驻通知不显示（部分 ROM 会因此限制前台服务）、提醒收不到",
            ok = notificationsAllowed(ctx),
            action = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        ),
        Item(
            title = "忽略电池优化",
            purpose = "别在 Doze 里把守护服务冻结",
            whenAsk = "保活体检、服务被冻结之后",
            impact = "息屏几分钟后采样与拦截停摆，直到下次点亮",
            ok = isIgnoringBattery(ctx),
            action = batteryIntent(ctx),
        ),
        Item(
            title = "自启动 / 后台运行",
            purpose = "开机或被清理之后能自己回来（厂商设置，没有标准 API）",
            whenAsk = "保活体检（只能引导，不能自动申请）",
            impact = "重启后不会自动运行，需要手动打开一次",
            // 没有标准接口能读这个状态：如实标成"未确认"（false），
            // 而不是查不到就假装打了勾
            ok = false,
            action = autoStartIntent(ctx),
        ),
    )

    fun isIgnoringBattery(ctx: Context): Boolean {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }

    /** 电池优化白名单：优先走"直接请求豁免"，没有该权限/不支持时退回列表页 */
    fun batteryIntent(ctx: Context): Intent =
        runCatching {
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(android.net.Uri.parse("package:${ctx.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }.getOrElse {
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

    /**
     * 厂商自启动管理页。
     *
     * 没有统一入口，按常见 ROM 逐个试；一个都跳不动就退回"应用详情"，
     * 让用户自己在"自启动 / 后台管理"里找——总比什么都不给好。
     */
    fun autoStartIntent(ctx: Context): Intent {
        val candidates = listOf(
            "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
            "com.samsung.android.lool" to "com.samsung.android.sm.ui.battery.BatteryActivity",
            "com.letv.android.letvsafe" to "com.letv.android.letvsafe.AutobootManageActivity",
            "com.asus.mobilemanager" to "com.asus.mobilemanager.entry.FunctionActivity",
        )
        for ((pkg, cls) in candidates) {
            val i = Intent().setClassName(pkg, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (ctx.packageManager.resolveActivity(i, 0) != null) return i
        }
        return appDetailsIntent(ctx)
    }

    fun appDetailsIntent(ctx: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
            .setData(android.net.Uri.parse("package:${ctx.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** 无障碍是否在系统里被勾选（服务没连上时也能判断"用户已授权但被系统杀了"） */
    fun isAccessibilityEnabled(ctx: Context): Boolean = runCatching {
        val enabled = Settings.Secure.getInt(
            ctx.contentResolver,
            Settings.Secure.ACCESSIBILITY_ENABLED,
            0,
        ) == 1
        if (!enabled) return false
        val list = Settings.Secure.getString(
            ctx.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        list.split(':').any { it.contains(ctx.packageName) }
    }.getOrDefault(false)

    /** 自己的服务还在不在（只查自己，避免 Android 10+ 的限制） */
    fun isServiceRunning(ctx: Context): Boolean = runCatching {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        @Suppress("DEPRECATION")
        am.getRunningServices(200).any {
            it.service.packageName == ctx.packageName &&
                it.service.className == GuardService::class.java.name
        }
    }.getOrDefault(false)

    /**
     * 界面回到前台时的自愈：该跑却没跑 → 拉起来。
     *
     * 这是最后一道保险：心跳最密也是 15 分钟一次，而用户点开应用的那一刻
     * 就该恢复——不然他会看到"已开启"却什么都没发生。
     */
    fun ensureService(ctx: Context, cfg: Config): Boolean {
        if (!GuardService.shouldRun(cfg)) return false
        if (isServiceRunning(ctx)) return false
        runCatching { GuardService.start(ctx) }
        runCatching { GuardService.scheduleHeartbeat(ctx) }
        scheduleJob(ctx, cfg)
        return true
    }

    // ---------------- JobScheduler：第二条保活通道 ----------------

    private const val JOB_ID = 0x4B4F46 // "KOF"

    /**
     * 注册周期任务。
     *
     * 为什么还要它：心跳是 AlarmManager（不精确闹钟），部分 ROM 会拦；
     * JobScheduler 走的是另一条调度路径，两者同时被拦的概率小得多。
     * 最小周期就是 15 分钟（系统下限），再密也不会更快。
     */
    fun scheduleJob(ctx: Context, cfg: Config) {
        if (!GuardService.shouldRun(cfg)) return
        runCatching {
            val js = ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return
            val comp = ComponentName(ctx, GuardJobService::class.java)
            if (js.getPendingJob(JOB_ID) != null) return
            val info = JobInfo.Builder(JOB_ID, comp)
                .setPeriodic(15 * 60_000L)
                .setPersisted(true) // 重启后仍然有效（需要 RECEIVE_BOOT_COMPLETED）
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_NONE)
                .setOverrideDeadline(20 * 60_000L)
                .build()
            js.schedule(info)
        }
    }

    fun cancelJob(ctx: Context) {
        runCatching {
            (ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler)?.cancel(JOB_ID)
        }
    }

    /** 通知渠道是否开着（Android 8+ 用户可以把渠道单独关掉） */
    fun notificationsAllowed(ctx: Context): Boolean {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return false
        if (!nm.areNotificationsEnabled()) return false
        val ch = nm.getNotificationChannel(CHANNEL_ONGOING)
        return ch == null || ch.importance != NotificationManager.IMPORTANCE_NONE
    }

    /** 与 GuardService 里的常驻渠道同名 */
    private const val CHANNEL_ONGOING = "kof_ongoing"

    /** 给界面用：一句话概括"现在能不能活" */
    fun healthLine(ctx: Context, cfg: Config): String {
        val items = audit(ctx, cfg).filter { it.title != "自启动 / 后台运行" }
        val missing = items.count { !it.ok }
        val running = isServiceRunning(ctx)
        return when {
            !GuardService.shouldRun(cfg) -> "没有被要求常驻（自律与统计都关着）"
            !running -> "服务没在跑——点「重启守护」立刻拉起来"
            missing == 0 -> "守护在跑，需要的权限都齐了"
            else -> "守护在跑，但有 $missing 项权限缺失（缺了会在后台被系统清掉）"
        }
    }

    /** 电池优化是否被关掉（部分 ROM 里 `isIgnoringBatteryOptimizations` 恒为 true，仅供参考） */
    @Suppress("unused")
    fun batteryHint(ctx: Context): String =
        if (isIgnoringBattery(ctx)) "已加入白名单" else "未加入白名单（息屏后可能被冻结）"
}
