package com.qqqorange.kingoffocus.core

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Process
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Rule
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * 拦截判定。
 *
 * **与 Windows 版的能力差异（如实说明）**：
 * Android 沙箱不允许结束别的应用进程、也不允许把别人的窗口盖掉并保持置顶。
 * 所以这里的"拦截"落到两件做得到的事上：
 *   1. 检测当前前台应用（UsageStats），命中名单就启动全屏拦截页；
 *   2. 拦截页由本应用自己的 Activity 呈现，返回键/最近任务都会回到它。
 * 做不到的部分（杀进程、阻止用户从桌面再次打开）在 README 里明确列出。
 */
object GuardEngine {

    /** 命中返回对应规则；未命中返回 null */
    fun blockedRule(cfg: Config, now: LocalDateTime, pkg: String, selfPkg: String): Rule? {
        if (pkg.isEmpty() || pkg == selfPkg) return null
        val rules = activeRules(cfg, now)
        for (r in rules) {
            when (r.mode) {
                "whitelist" -> {
                    // 白名单：名单外的一律拦；系统壳（桌面/输入法/设置）永远放行
                    if (!isShell(pkg) && pkg !in r.packages) return r
                }
                else -> {
                    if (pkg in r.packages) return r
                }
            }
        }
        return null
    }

    /** 此刻真正生效的规则（iOS/Android 都只有这一处判定入口） */
    fun activeRules(cfg: Config, now: LocalDateTime): List<Rule> {
        if (!cfg.enabled) return emptyList()
        // 积分解锁窗口内：所有拦截暂停（界面承诺"到 xx 之前所有拦截暂停"）
        val ts = now.atZone(ZoneId.systemDefault()).toEpochSecond()
        if (ts < cfg.unlockUntil) return emptyList()
        val st = ScheduleEngine.stateAt(cfg, now) ?: return emptyList()
        if (st.inBreak) return emptyList()
        return cfg.rules.filter { it.enabled }
    }

    /**
     * **允许使用的应用——全应用唯一的一份名单。**
     *
     * 以前这里有两份：锁机遮罩自己有一个 `lockAllow`，白名单规则里又有一份。
     * 于是常出现"遮罩里能点开、规则却把它送回桌面"的矛盾——同一个应用，
     * 两处配置各说各话。现在只有白名单规则这一个来源：
     * 遮罩的允许列表、白名单模式的判定，读的都是它。
     */
    fun allowedPackages(cfg: Config): Set<String> =
        cfg.rules.asSequence()
            .filter { it.enabled && it.mode == "whitelist" }
            .flatMap { it.packages.asSequence() }
            .toSet()

    /** 有没有启用着的白名单规则（总览/规则页用来解释"现在是什么模式"） */
    fun hasWhitelistRule(cfg: Config): Boolean =
        cfg.rules.any { it.enabled && it.mode == "whitelist" }

    /** 系统壳进程：拦了它们等于把手机变砖 */
    private val SHELL = setOf(
        "com.android.systemui",
        "com.android.settings",
        "com.android.launcher",
        "com.android.launcher3",
        "com.google.android.apps.nexuslauncher",
        "com.android.inputmethod.latin",
        "com.google.android.inputmethod.latin",
        "com.qqqorange.kingoffocus",
    )

    fun isShell(pkg: String): Boolean =
        pkg in SHELL || pkg.startsWith("com.android.systemui") || pkg.contains("launcher")

    /** 是否已授予"使用情况访问"权限 */
    fun hasUsageAccess(ctx: Context): Boolean {
        val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return false
        val mode = appOps.unsafeCheckOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            ctx.packageName,
        )
        if (mode == AppOpsManager.MODE_DEFAULT) {
            return ctx.checkCallingOrSelfPermission(
                android.Manifest.permission.PACKAGE_USAGE_STATS,
            ) == PackageManager.PERMISSION_GRANTED
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /**
     * 当前前台应用包名。
     *
     * 用近 10 秒的事件流取最后一次"进入前台"，比 queryUsageStats 的最后使用时间可靠：
     * 后者在同一应用内切换页面时不会变。
     */
    /**
     * 上一次读到的前台包名。
     *
     * 为什么需要它：UsageEvents 里**只有"切换那一刻"才有事件**。用户一直停在同一个
     * 应用里时，10 秒窗口内一个 RESUMED 都没有，queryEvents 返回空——如果直接返回 null，
     * 统计会在"没换应用"的时候停住（实测：切到通讯录后只记了 15 秒就再无增长）。
     * 所以窗口放宽到 3 分钟，并且查不到时沿用上一次的结果。
     * 真正"用户不在了"由采样侧（屏幕熄灭）判断，不靠这里猜。
     */
    @Volatile
    private var lastForeground: String? = null

    fun foregroundPackage(ctx: Context): String? {
        if (!hasUsageAccess(ctx)) return null
        val usm = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager ?: return null
        val end = System.currentTimeMillis()
        val events = usm.queryEvents(end - 180_000, end)
        val e = UsageEvents.Event()
        var last: String? = null
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            // ACTIVITY_RESUMED = 1（旧常量 MOVE_TO_FOREGROUND 同值）
            if (e.eventType == 1) last = e.packageName
        }
        if (last != null) lastForeground = last
        return last ?: lastForeground
    }
}
