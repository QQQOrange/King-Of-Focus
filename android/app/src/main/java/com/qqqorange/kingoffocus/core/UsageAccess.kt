package com.qqqorange.kingoffocus.core

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.StatsCfg
import com.qqqorange.kingoffocus.service.KofAccessibility

/**
 * 「使用情况访问」权限的状态机 —— 申请、拒绝、被回收，以及**每种情况怎么降级**。
 *
 * ## 为什么不能只判一个布尔
 *
 * `AppOpsManager` 只能回答"现在有没有"。可是三种"没有"要三种不同的处理：
 *
 * | 情况 | 事实 | 该做什么 |
 * |---|---|---|
 * | 从没给过 | 大概率是新用户 | 解释一次 + 跳系统设置；拒绝后不再骚扰 |
 * | 给过又被回收 | 清理软件/系统更新干的 | 明确告诉用户"统计已暂停"，并给一键恢复 |
 * | 给了但无障碍没开 | 只有使用情况访问 | 能统计，但**切到后台后识别会慢一拍** |
 *
 * 所以这里记两个持久标志（`usageGrantedOnce` / `usageAsked`）来推断"回收"与"已问过"。
 *
 * ## 降级顺序（能记就记，记不了就说清楚）
 *
 * 1. 使用情况访问 + 无障碍 → 最准：无障碍即时知道切应用，使用情况访问兜住后台。
 * 2. 只有使用情况访问 → 仍能统计；后台切换靠 3 分钟事件窗口，可能漏几秒。
 * 3. 只有无障碍 → 能统计**前台**，但服务被系统冻结时可能漏段（会标"降级"）。
 * 4. 两个都没有 → **停止采样**并把原因写进状态，页面上直接说"统计已暂停"，
 *    绝不能让用户看着一屏 0 以为自己在自律。
 */
object UsageAccess {

    enum class State {
        /** 已授予使用情况访问 */
        GRANTED,

        /** 以前有、现在没了（被用户或清理软件收回） */
        REVOKED,

        /** 解释过、用户没给 */
        DENIED,

        /** 还没问过 */
        NOT_ASKED,
    }

    /** 采样能力：决定"还能不能记"，以及"记的准不准" */
    enum class Source {
        /** 使用情况访问 + 无障碍：最准 */
        FULL,

        /** 只有使用情况访问：后台切换可能慢一拍 */
        USAGE_ONLY,

        /** 只有无障碍：前台能记，服务被冻结时会漏 */
        ACCESSIBILITY_ONLY,

        /** 都没有：不采样 */
        NONE,
    }

    data class Status(
        val state: State,
        val source: Source,
        val usageGranted: Boolean,
        val accAlive: Boolean,
    ) {
        /** 还能不能记录 */
        val canRecord: Boolean get() = source != Source.NONE

        /** 是否需要向用户展示"要授权"的提示 */
        val needsAttention: Boolean get() = state != State.GRANTED

        fun sourceName(): String = when (source) {
            Source.FULL -> "使用情况访问 + 无障碍"
            Source.USAGE_ONLY -> "仅使用情况访问"
            Source.ACCESSIBILITY_ONLY -> "仅无障碍（降级）"
            Source.NONE -> "无（已暂停）"
        }

        /** 一句话说明现在是什么情况、会有什么影响 */
        fun summary(): String = when {
            state == State.REVOKED && source == Source.ACCESSIBILITY_ONLY ->
                "「使用情况访问」被收回了，现在只靠无障碍识别前台：前台还能记，切到后台可能漏记。"
            state == State.REVOKED && source == Source.NONE ->
                "「使用情况访问」被收回，且无障碍没开——统计已暂停，这段时间不会被记录。"
            state == State.GRANTED && source == Source.USAGE_ONLY ->
                "已授予使用情况访问。开启无障碍后切应用能即时识别，统计更准。"
            state == State.GRANTED -> "使用情况访问已授予，统计正常。"
            source == Source.ACCESSIBILITY_ONLY ->
                "还没有「使用情况访问」，现在靠无障碍识别前台：前台能记，后台可能漏。"
            else -> "还没有「使用情况访问」，系统不允许任何应用跨进程读取前台应用——统计无法开始。"
        }
    }

    /**
     * **纯判定**（可单测）：给定四个事实，得出状态与降级档位。
     *
     * 顺序很重要：先看现在有没有，再看历史上有没有（判断是否被回收），最后才看问没问过。
     */
    fun decide(
        usageGranted: Boolean,
        accAlive: Boolean,
        grantedOnce: Boolean,
        asked: Boolean,
    ): Status {
        val state = when {
            usageGranted -> State.GRANTED
            grantedOnce -> State.REVOKED
            asked -> State.DENIED
            else -> State.NOT_ASKED
        }
        val source = when {
            usageGranted && accAlive -> Source.FULL
            usageGranted -> Source.USAGE_ONLY
            accAlive -> Source.ACCESSIBILITY_ONLY
            else -> Source.NONE
        }
        return Status(state, source, usageGranted, accAlive)
    }

    @Volatile
    var last: Status? = null
        private set

    /**
     * 只读判定：给界面用（组合期间不能写盘）。
     * 与 [probe] 的区别只在于不落 `usageGrantedOnce` 那个标志。
     */
    fun read(ctx: Context, cfg: Config): Status = decide(
        usageGranted = GuardEngine.hasUsageAccess(ctx),
        accAlive = KofAccessibility.alive(),
        grantedOnce = cfg.stats.usageGrantedOnce,
        asked = cfg.stats.usageAsked,
    )

    /** 探测一次并缓存（界面与采样循环都读 [last]，避免每次几十毫秒的 AppOps 调用） */
    fun probe(ctx: Context, cfg: Config): Status {
        val granted = GuardEngine.hasUsageAccess(ctx)
        val acc = KofAccessibility.alive()
        val st = decide(
            usageGranted = granted,
            accAlive = acc,
            grantedOnce = cfg.stats.usageGrantedOnce,
            asked = cfg.stats.usageAsked,
        )
        last = st
        // 首次拿到就永久记下来：以后"没有"就意味着被回收了
        if (granted && !cfg.stats.usageGrantedOnce) {
            Store0.patch { c -> c.copy(stats = c.stats.copy(usageGrantedOnce = true)) }
        }
        return st
    }

    /** 曾经给过、现在没有 → 收回；用来决定要不要弹"已暂停" */
    fun wasRevoked(status: Status): Boolean = status.state == State.REVOKED

    /** 打系统设置（使用情况访问列表） */
    fun settingsIntent(): Intent =
        Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** 部分 ROM 支持直达本应用的使用情况页；失败就退回总列表 */
    fun appSettingsIntent(ctx: Context): Intent =
        Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
            .setData(Uri.parse("package:${ctx.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    fun accessibilityIntent(): Intent =
        Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** 记下"已经解释过"，之后不再自动弹，只在页面上留一条可点的提示 */
    fun markAsked(cfg: StatsCfg) {
        if (cfg.usageAsked) return
        Store0.patch { c -> c.copy(stats = c.stats.copy(usageAsked = true)) }
    }

    /**
     * 写配置的间接层。
     *
     * 这里不直接依赖 `Store`（它在 data 包，且 init 需要 Context），
     * 由 `Store` 启动时把实现塞进来——单测里就不需要 Android 环境。
     */
    private object Store0 {
        @Volatile
        var patch: ((Config) -> Config) -> Unit = {}
    }

    /** 由 `Store.init` 调用：把真正的写入口接上（单测里就不需要 Android 环境） */
    fun bind(writer: ((Config) -> Config) -> Unit) {
        Store0.patch = writer
    }
}
