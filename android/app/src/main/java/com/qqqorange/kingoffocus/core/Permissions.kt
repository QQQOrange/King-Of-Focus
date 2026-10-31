package com.qqqorange.kingoffocus.core

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.PermCfg
import com.qqqorange.kingoffocus.service.KofAccessibility

/**
 * 权限清单：**唯一数据源**。
 *
 * 总览页的「限制能力」、设置页的「权限与通知」、以及 `docs/permissions-and-notifications.md`
 * 都读这一份。以前这三处各写一段说明，时间一长就会出现「界面说缺 A、文档说缺 B」，
 * 用户按哪份做都不对。
 *
 * ## 每项都回答同一组问题
 *
 * | 字段 | 回答什么 |
 * |---|---|
 * | [PermSpec.why] | 用途：拿到它能做什么 |
 * | [PermSpec.whenAsk] | 申请时机：什么时候才该弹 / 跳 |
 * | [PermSpec.howAsk] | 申请方式：系统弹窗 / 跳系统设置 / 第三方授权 / 安装即得 |
 * | [PermSpec.impact] | 缺失影响：没有它到底哪里不对 |
 * | [PermSpec.fallback] | 降级：没有它也能怎么用 |
 * | [PermSpec.regrant] | 重新授权：拒绝之后怎么回来 |
 *
 * ## 一条硬规矩：不需要的权限不申请
 *
 * 「照片和视频」在本应用里**没有任何使用场景**（备份走 SAF、报表是文本、锁机背景是纯色），
 * 所以清单里如实标成 [PermState.NOT_NEEDED]。为了清单好看去申请一个读相册的权限，
 * 既过不了商店审核，也是在骗用户。
 */
enum class PermId {
    /** 应用列表（QUERY_ALL_PACKAGES）：应用选择器要能列出所有应用 */
    APP_LIST,

    /** 通知（POST_NOTIFICATIONS）：常驻状态、阶段提醒、完成通知、每日汇总 */
    NOTIFICATION,

    /** 照片和视频（READ_MEDIA_IMAGES/VIDEO）：本应用不需要 */
    MEDIA,

    /** 悬浮窗（SYSTEM_ALERT_WINDOW）：锁机遮罩在后台拉起来 */
    OVERLAY,

    /** 使用情况访问（PACKAGE_USAGE_STATS）：前台应用 + 使用时长统计的唯一公开通道 */
    USAGE,

    /** Shizuku：更准地读前台、真正结束进程、防止被强制停止 */
    SHIZUKU,

    /** 无障碍：切应用即刻识别、全局回桌面 */
    ACCESSIBILITY,
}

/** 申请方式。界面按这个决定点一下是弹窗、跳设置，还是给出别的指引 */
enum class AskKind {
    /** 普通权限，安装即得，用户无法拒绝（但 OEM 可能限制） */
    INSTALL,

    /** 运行时权限：系统弹窗 */
    RUNTIME,

    /** 特殊权限：只能跳到系统设置页手动打开 */
    SETTINGS,

    /** 第三方应用授权（Shizuku Manager） */
    THIRD_PARTY,

    /** 本应用不需要，不申请 */
    NONE,
}

enum class PermState {
    /** 已授予 */
    OK,

    /** 还没给（含从没问过） */
    MISSING,

    /** 问过被拒，仍可能再弹 */
    DENIED,

    /** 永久拒绝：系统不再弹窗，只能去设置里手动开 */
    BLOCKED,

    /** 本应用不需要 */
    NOT_NEEDED,
}

data class PermSpec(
    val id: PermId,
    val title: String,
    val why: String,
    val whenAsk: String,
    val howAsk: String,
    val impact: String,
    val fallback: String,
    val regrant: String,
    val kind: AskKind,
)

data class PermItem(
    val spec: PermSpec,
    val state: PermState,
    /** 界面上那一行状态说明（按状态给不同的话，不是复读 spec） */
    val hint: String,
    /** 「去开启」要跳的地方；null = 没有可跳的 */
    val action: Intent?,
) {
    val ok: Boolean get() = state == PermState.OK || state == PermState.NOT_NEEDED

    /** 需要用户动手才算处理完的项 */
    val needsAttention: Boolean get() = !ok
}

object Permissions {

    /** 顺序就是界面上的顺序：先能不能看见，再能不能拦住，最后能不能持久 */
    val specs: List<PermSpec> = listOf(
        PermSpec(
            id = PermId.APP_LIST,
            title = "应用列表",
            why = "应用选择器要能列出手机上所有应用，才能把它们加进自律规则；" +
                "否则只能看到「已经打开过的」那几个。",
            whenAsk = "安装即得，不需要申请。第一次打开「自律规则 → 添加应用」时使用。",
            howAsk = "清单里声明 QUERY_ALL_PACKAGES，系统安装时自动授予。",
            impact = "极少数 ROM（或商店分发的裁剪版）会限制可见性，" +
                "选择器里只剩部分应用，规则没法覆盖全部。",
            fallback = "仍然可以按包名手动添加；已配置的规则照常生效（判定不需要这个权限）。",
            regrant = "无法在系统设置里单独开关；如果列表明显不全，" +
                "去应用信息里看是否被「应用权限管理」限制。",
            kind = AskKind.INSTALL,
        ),
        PermSpec(
            id = PermId.NOTIFICATION,
            title = "通知",
            why = "四类通知全靠它：常驻状态（含今日进度）、阶段结束前提醒、任务完成、当日使用汇总。",
            whenAsk = "第一次开启「自律总开关」时申请——此时通知才有内容可发；" +
                "也可以在设置页点「开启通知」手动申请。不在启动时就弹，" +
                "避免用户还不知道这应用做什么。",
            howAsk = "Android 13+ 走系统运行时弹窗；更早的版本安装即得。",
            impact = "守护仍在跑，但四类通知都不出现：你看不到剩余时间，" +
                "也收不到完成与汇总提醒。前台服务还会被系统在通知栏折叠成「应用在后台运行」。",
            fallback = "应用内照常显示状态与进度；统计、拦截、锁机都不依赖通知。" +
                "总览页会出现一条提示，说明「通知被关，提醒不会出现」。",
            regrant = "设置页 →「通知」→「去开启」跳到本应用的通知设置；" +
                "若系统已不再弹窗（永久拒绝），只能在这里手动打开。",
            kind = AskKind.RUNTIME,
        ),
        PermSpec(
            id = PermId.MEDIA,
            title = "照片和视频",
            why = "**本应用不需要**：备份文件走系统文件选择器（SAF），报表是文本，" +
                "锁机背景是纯色，没有任何读取相册的场景。",
            whenAsk = "不申请。将来如果做「锁机背景用自己选的照片」或" +
                "「统计图存到相册」，才在用到的那一刻申请（READ_MEDIA_IMAGES / READ_MEDIA_VIDEO）。",
            howAsk = "不申请。真要加时按运行时权限弹窗，且只在用户点「选择照片」时弹。",
            impact = "无（没有功能依赖它）。",
            fallback = "—",
            regrant = "—",
            kind = AskKind.NONE,
        ),
        PermSpec(
            id = PermId.OVERLAY,
            title = "在其他应用上层显示",
            why = "锁机时要把整屏遮罩盖到别的应用上面。" +
                "Android 10+ 还要求它才能在后台拉起界面。",
            whenAsk = "第一次开启「锁机」时；以及锁机生效但遮罩没出来时（会弹一条可点开的提醒）。",
            howAsk = "跳系统设置页「显示在其他应用上层」，由用户手动打开。",
            impact = "锁机不生效：到点只会回桌面 + 一条通知，盖不住屏幕。" +
                "「强制模式」也会因此不可用。",
            fallback = "拦截规则仍靠「回桌面 + 通知」生效；锁机降级为提醒你该休息了。",
            regrant = "设置页 →「在其他应用上层显示」→「去开启」；" +
                "或系统设置 → 应用 → 特殊权限 → 显示在其他应用上层。",
            kind = AskKind.SETTINGS,
        ),
        PermSpec(
            id = PermId.USAGE,
            title = "使用情况访问",
            why = "读取「当前前台是哪个应用」（拦截的判定依据），以及按应用统计使用时长。" +
                "这是 Android 上唯一不需要 root 的公开通道。",
            whenAsk = "第一次开启「记录使用时长」或「自律总开关」时；统计页顶部也会提示。",
            howAsk = "跳系统设置页「使用情况访问」→ 找到本应用 → 允许。没有运行时弹窗。",
            impact = "统计完全停止（不采样、不写盘）；拦截只能靠无障碍，" +
                "没有无障碍时等于什么都拦不住。",
            fallback = "只有无障碍时仍能识别前台并拦截，但统计不到时长；" +
                "页面会明确写「统计已暂停」，不会显示一片 0 让你以为今天没用手机。",
            regrant = "统计页顶部横幅或设置页 →「使用情况访问」→「去授予」；" +
                "被清理软件关掉时，通知栏会收到一条「被收回了」。",
            kind = AskKind.SETTINGS,
        ),
        PermSpec(
            id = PermId.SHIZUKU,
            title = "Shizuku",
            why = "借 ADB 级 shell 权限做无障碍做不到的事：更准地读前台，" +
                "真正结束违规应用（am force-stop），把被关掉的无障碍重新打开，" +
                "阻止在设置里强制停止本应用。",
            whenAsk = "用户主动在设置页点「连接 Shizuku」时；不会自动申请。",
            howAsk = "需要先安装 Shizuku 并用无线调试启动它，" +
                "再在本应用里授权（Shizuku 自己的弹窗）。",
            impact = "降级到无障碍 / 使用情况：拦截只能「回桌面 + 通知」，" +
                "锁机需要悬浮窗，「强制模式」无法启用。",
            fallback = "完整应用不依赖 Shizuku：没有它也能用，只是拦得没那么硬。" +
                "能力等级会显示为「增强」而不是「完整」。",
            regrant = "设置页 →「Shizuku」→「连接」；首次会拉起 Shizuku 的授权弹窗，" +
                "之后每次开机需要 Shizuku 自己在运行。",
            kind = AskKind.THIRD_PARTY,
        ),
        PermSpec(
            id = PermId.ACCESSIBILITY,
            title = "无障碍服务",
            why = "切换应用的那一刻就知道前台是谁（比 1 秒轮询准），" +
                "并且不受后台限制地回桌面。",
            whenAsk = "第一次开启「应用拦截」或「锁机」时；能力不足时总览页会提示。",
            howAsk = "跳系统设置页「无障碍」→ 找到 King Of Focus → 打开。",
            impact = "前台识别退化为 1 秒轮询（需要「使用情况访问」），" +
                "回桌面需要悬浮窗或 Shizuku。",
            fallback = "有「使用情况访问」时仍能拦截，只是慢一拍；锁机靠悬浮窗。",
            regrant = "设置页 →「无障碍服务」→「去开启」；被系统关掉时" +
                "（部分 ROM 会在重启后关），Shizuku 在的话会自动帮你打开。",
            kind = AskKind.SETTINGS,
        ),
    )

    fun spec(id: PermId): PermSpec = specs.first { it.id == id }

    /**
     * 逐项体检。
     *
     * 只读，不写盘——可以在 Compose 组合期调用。需要写盘的动作（记问过几次）
     * 由申请回调负责（见 `ui/PermUi.kt`）。
     */
    fun audit(ctx: Context, cfg: Config): List<PermItem> = specs.map { s ->
        val r = when (s.id) {
            PermId.APP_LIST -> appList(ctx)
            PermId.NOTIFICATION -> notification(ctx, cfg.perm)
            PermId.MEDIA -> Triple(PermState.NOT_NEEDED, "本应用不需要，已如实不申请", null)
            PermId.OVERLAY -> overlay(ctx)
            PermId.USAGE -> usage(ctx)
            PermId.SHIZUKU -> shizuku(ctx)
            PermId.ACCESSIBILITY -> accessibility(ctx)
        }
        PermItem(s, r.first, r.second, r.third)
    }

    fun item(ctx: Context, cfg: Config, id: PermId): PermItem =
        audit(ctx, cfg).first { it.spec.id == id }

    /** 通知现在到底能不能发（决定界面上要不要提示「提醒不会出现」） */
    fun notificationsUsable(ctx: Context): Boolean = notificationAllowed(ctx)

    // ------------------------------------------------------------ 各项判定

    private fun appList(ctx: Context): Triple<PermState, String, Intent?> {
        val n = runCatching {
            ctx.packageManager.getInstalledApplications(0).size
        }.getOrDefault(0)
        // 包名可见性被限制时，连自己的应用都数不到几个；正常机器至少几十个
        return if (n > 5) {
            Triple(PermState.OK, "已就绪（可见 $n 个应用）", null)
        } else {
            Triple(
                PermState.MISSING,
                "只看到 $n 个应用，可能被系统限制了可见性",
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:" + ctx.packageName)),
            )
        }
    }

    private fun notificationAllowed(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 33) {
            // 13 之前没有运行时权限，但用户仍可在系统设置里关掉通知
            return runCatching {
                NotificationManagerCompat.from(ctx).areNotificationsEnabled()
            }.getOrDefault(true)
        }
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun notification(
        ctx: Context,
        p: PermCfg,
    ): Triple<PermState, String, Intent?> {
        val action = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
        if (notificationAllowed(ctx)) {
            return Triple(PermState.OK, "已就绪", null)
        }
        // 三种「没有」要三句话：从没问过 / 拒过一次 / 系统不再弹
        return when {
            p.notifBlocked -> Triple(
                PermState.BLOCKED,
                "已被永久拒绝：系统不再弹窗，只能去设置里打开",
                action,
            )
            p.notifAsked > 0 -> Triple(
                PermState.DENIED,
                "已拒绝 ${p.notifAsked} 次：提醒和常驻状态都不会出现，可以去设置里打开",
                action,
            )
            else -> Triple(
                PermState.MISSING,
                "还没开启：四类通知都不会出现（守护仍在跑）",
                action,
            )
        }
    }

    private fun overlay(ctx: Context): Triple<PermState, String, Intent?> {
        val ok = runCatching { Settings.canDrawOverlays(ctx) }.getOrDefault(false)
        return if (ok) {
            Triple(PermState.OK, "已就绪", null)
        } else {
            Triple(
                PermState.MISSING,
                "没开启：锁机只能回桌面 + 通知，盖不住屏幕",
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
                    .setData(Uri.parse("package:" + ctx.packageName)),
            )
        }
    }

    private fun usage(ctx: Context): Triple<PermState, String, Intent?> = when {
        GuardEngine.hasUsageAccess(ctx) ->
            Triple(PermState.OK, "已就绪", null)

        else -> Triple(
            PermState.MISSING,
            "没开启：统计完全停止，拦截只能靠无障碍",
            Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS),
        )
    }

    private fun shizuku(ctx: Context): Triple<PermState, String, Intent?> {
        val available = ShizukuBridge.available()
        val granted = available && ShizukuBridge.granted()
        val ready = granted && ShizukuBridge.ready()
        return when {
            ready -> Triple(PermState.OK, "已连接（v${ShizukuBridge.version()}）", null)
            !available -> Triple(
                PermState.MISSING,
                "没装 Shizuku：装好并用无线调试启动后再回来连接",
                null,
            )
            !granted -> Triple(
                PermState.MISSING,
                "已装但还没授权：点「连接」会弹 Shizuku 的授权框",
                null,
            )
            else -> Triple(
                PermState.MISSING,
                "已授权但没连上：Shizuku 可能被系统停掉了，重新打开它",
                null,
            )
        }
    }

    private fun accessibility(ctx: Context): Triple<PermState, String, Intent?> =
        if (KofAccessibility.alive()) {
            Triple(PermState.OK, "已就绪", null)
        } else {
            Triple(
                PermState.MISSING,
                "没开启：前台识别退化为 1 秒轮询（需要「使用情况访问」）",
                Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
            )
        }

    // ------------------------------------------------------------ 申请结果回写

    /**
     * 记录一次通知权限申请的结果。
     *
     * `blocked` 由调用方用 `shouldShowRequestPermissionRationale` 判断：
     * 拒绝之后系统返回 false，意味着再也不会弹了，只能去设置里开。
     * 这个判断需要 Activity，所以放在 UI 层（`ui/PermUi.kt`），这里只负责写。
     */
    fun noteNotificationResult(p: PermCfg, granted: Boolean, blocked: Boolean): PermCfg =
        p.copy(
            notifAsked = if (granted) p.notifAsked else p.notifAsked + 1,
            notifBlocked = if (granted) false else blocked,
        )

    /** 系统弹窗是否还会出现（false = 已永久拒绝，别再白弹一次） */
    fun canAskNotification(activity: Activity?): Boolean {
        if (activity == null) return true
        if (Build.VERSION.SDK_INT < 33) return false
        return ActivityCompat.shouldShowRequestPermissionRationale(
            activity,
            Manifest.permission.POST_NOTIFICATIONS,
        )
    }
}
