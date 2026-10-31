package com.qqqorange.kingoffocus.data

import kotlinx.serialization.Serializable

/**
 * 一小时里的一个窗口：`[from, to)` 分钟。
 *
 * 手机端以前的网格是整小时一格，所以只需要一对 `from`/`to`；现在刻度可以细到
 * 10 / 15 分钟，同一小时里完全可能有"0–15 和 30–45"这种两段，那时 `wins` 非空、
 * 以它为准（见 [Slots]）。
 */
@Serializable
data class HourWin(
    val from: Int = 0,
    val to: Int = 60,
)

/**
 * 一小时里的一段计划。
 *
 * 语义与 Windows 版保持一致：
 *  · `on` 决定这一小时是否被选中；
 *  · `from`/`to` 只收窄"这一小时的哪几分钟可见"，**不改变相位**；
 *  · `work`/`brk` 是番茄参数，相位锚点是整点（09:00 起算），不是窗口起点。
 *  · `wins` 非空时是窗口的**权威数据**（一小时可以有好几段）；为空时退回 `from`/`to`。
 */
@Serializable
data class HourPlan(
    val on: Boolean = false,
    val work: Int = 45,
    val brk: Int = 15,
    val from: Int = 0,
    val to: Int = 60,
    val wins: List<HourWin> = emptyList(),
)

/**
 * 一条自律规则 = 一份应用名单 + 模式 + 是否固化。
 *
 * Android 上没有"规则自己的时间表"这一层：什么时候生效完全由「自律时段」决定，
 * 规则只管名单。这与 Windows 版重构后的模型一致。
 */
@Serializable
data class Rule(
    val id: String = "",
    val name: String = "",
    val enabled: Boolean = true,
    /** blacklist = 名单内禁止；whitelist = 只允许名单内 */
    val mode: String = "blacklist",
    val packages: List<String> = emptyList(),
    /** 固化：生效期间不允许关闭自律、不允许改设置 */
    val hard: Boolean = true,
    /**
     * 从桌面端备份带过来的、手机端表达不了的条目（exe 路径 / 文件夹 / 进程名 / 网站）。
     *
     * 为什么要留着：手机端只能按包名拦应用，桌面端那套 `C:\Games\x.exe`、
     * `*.bilibili.com` 在这里没有任何作用，但**不能丢**——用户拿着手机备份
     * 回桌面时，这些条目必须原样回去，否则一来一回就把桌面端的名单洗没了。
     * 它们不参与手机端判定，只做保管。
     */
    val foreign: List<PtApp> = emptyList(),
    /**
     * 这条规则原始的跨设备 JSON（仅在含桌面专属内容时非空）。
     *
     * `foreign` 只保管名单，`carry` 把时段表、锁定方式、颜色、例外这些
     * 手机端根本没有字段可放的东西整条存下来，导出时再叠回手机端可改的几项。
     * 这样"桌面 → 手机 → 桌面"才是真正无损的。
     */
    val carry: String = "",
)

/** 跨设备备份里的一个名单条目（kind: exe / dir / name / title / pkg / site） */
@Serializable
data class PtApp(
    val kind: String = "",
    val value: String = "",
    val label: String = "",
)

@Serializable
data class NotifyCfg(
    val enabled: Boolean = true,
    /** 专注结束前多少分钟提醒，0 = 不提醒 */
    val workBefore: Int = 5,
    /** 休息结束前多少分钟提醒，0 = 不提醒 */
    val breakBefore: Int = 2,
    val breakNotify: Boolean = true,
)

@Serializable
data class OverlayCfg(
    val blockEnabled: Boolean = true,
    val message: String = "这段时间在自律中，这个应用不在允许范围内。",
    /** 允许在拦截页上直接结束这一段（Android 端无法真正阻止，做成显式按钮更诚实） */
    val allowStop: Boolean = false,
)

/**
 * 备份设置。
 *
 * `password` 为空 = 导出的备份是明文 JSON（界面上会警告）；
 * 非空 = PBKDF2-HMAC-SHA256 + AES-256-GCM 信封，桌面上同一套参数解得开。
 * 它和桌面端的"备份密码"是同一个东西：两端各自保存本机的口令，
 * 想互通就得填同一个。
 */
/**
 * 自动更新配置。三端各有一份，**互不共享**：桌面端的更新设置不会同步到手机，
 * 手机端也不会因为桌面端改了源就跟着换。这是刻意的——每台设备的更新通道
 * 由它自己决定，出问题时也能各自排查。
 */
@Serializable
data class UpdateCfg(
    /** 打开应用时自动检查（不会自动装，安装永远要用户点一下） */
    val autoCheck: Boolean = true,
    /** 上次检查时间（unix 秒），用来避免每次启动都打一次 GitHub */
    val lastCheck: Long = 0L,
    /** 用户选择跳过的版本 */
    val skippedVersion: String = "",
    /** 自动检查的最小间隔（小时） */
    val intervalHours: Int = 6,
)

@Serializable
data class BackupCfg(val password: String = "")

/**
 * 锁机。
 *
 * 和「被拦应用 → 全屏拦截页」不是一回事：
 *   · 拦截页处理的是"你打开了某个不该开的应用"；
 *   · 锁机处理的是"现在是专注段，整台手机暂时不属于你"——
 *     走的是"回桌面 + 立刻盖上全屏遮罩"，不杀进程、不关机
 *     （Android 本来也不允许一个应用结束另一个应用）。
 *
 * 两个出口都要花积分，价格写在配置里、执行前先摆出来：
 *   · 暂停：花 [pauseCost] 分，换 [pauseMinutes] 分钟自由；
 *   · 停止：花 [stopCost] 分，把**当前这一段**的锁机整个关掉（换段自动恢复）。
 */
@Serializable
data class LockCfg(
    /** 默认关：升级后不该突然把用户锁在门外 */
    val enabled: Boolean = false,
    /**
     * gentle = 温和：可以花积分暂停或提前结束这一段；
     * strict = 强制：暂停/跳过一律不生效，必须等这一段自然走完。
     */
    val mode: String = "gentle",
    val pauseMinutes: Int = 10,
    val pauseCost: Int = 10,
    val stopCost: Int = 30,
)

/**
 * 一套自律时段方案（7×24 的排班 + 默认番茄参数）。
 *
 * 桌面端早就是"多套方案"，手机端之前只有一套。现在对齐：
 * `plans` 存全部方案，`Config.days / defWork / defBrk` 是**当前生效那一套**的镜像，
 * 这样引擎、备份、统计这些地方一行都不用改。
 */
@Serializable
data class SchedulePlan(
    val id: String = "",
    val name: String = "方案",
    val days: List<List<HourPlan>> = defaultDays(),
    val defWork: Int = 45,
    val defBrk: Int = 15,
)

/** 一段睡眠窗口。`to <= from` 表示跨夜（23:00 → 07:00） */
@Serializable
data class SleepSegment(
    /** 起点：一天里的第几分钟 0..1439 */
    val from: Int = 1380,
    /** 终点：0..1440（1440 = 当天 24:00） */
    val to: Int = 420,
)

/**
 * 睡眠时段。
 *
 * 桌面端的语义是"到点关机"；Android 杀不掉别的应用也关不了机，所以这里落地成
 * **睡眠期间整机锁住**（回桌面 + 遮罩），并且可以用积分换一小段（比如起夜看时间）。
 * 「关机」这个动作不承诺——那是骗人。
 */
@Serializable
data class SleepCfg(
    val enabled: Boolean = false,
    val segments: List<SleepSegment> = listOf(SleepSegment()),
    val lockScreen: Boolean = true,
    /** 积分解锁一次能买多少分钟 */
    val unlockMin: Int = 10,
    /** 每分钟多少分；0 = 这段睡眠不许用积分解锁 */
    val unlockPrice: Int = 1,
)

/**
 * WebDAV 云同步（与桌面端同一个目录、同一份 config 语义）。
 *
 * 冲突策略和桌面端一致：比 `updatedAt`，新的覆盖旧的。
 * 密码只存本机配置文件里，**不随配置上传**。
 */
@Serializable
data class CloudCfg(
    val enabled: Boolean = false,
    val url: String = "",
    val user: String = "",
    val pass: String = "",
    val lastSync: Long = 0L,
    val lastStatus: String = "",
)

@Serializable
data class StatsCfg(
    /** 关掉就完全不采样（不写盘、不算）*/
    val enabled: Boolean = true,
)

@Serializable
data class Config(
    val version: Int = 1,
    /** 自律总开关：关掉时时段不生效、不拦截 */
    val enabled: Boolean = false,
    /** 7 天 × 24 小时 */
    val days: List<List<HourPlan>> = defaultDays(),
    /**
     * 时段网格的刻度（分钟）：10 或 15。
     *
     * 只影响**怎么画、怎么点**，不影响判定：窗口永远按分钟存。所以从 15 改成 10
     * 不会让已排好的时段失效——旧边界会跨在新格子中间，界面上画成半格，重涂即对齐。
     */
    val granularity: Int = 15,
    val defWork: Int = 45,
    val defBrk: Int = 15,
    val rules: List<Rule> = emptyList(),
    val points: Int = 0,
    /** 积分解锁到什么时候（unix 秒）；解锁期间所有拦截暂停 */
    val unlockUntil: Long = 0L,
    val notify: NotifyCfg = NotifyCfg(),
    val overlay: OverlayCfg = OverlayCfg(),
    val backup: BackupCfg = BackupCfg(),
    val update: UpdateCfg = UpdateCfg(),
    val lock: LockCfg = LockCfg(),
    /** 锁机期间允许使用的应用（遮罩上的白名单，点了能直接打开） */
    val lockAllow: List<String> = emptyList(),
    /** 暂停到什么时候（unix 秒）；期间不锁、不拦 */
    val lockPausedUntil: Long = 0L,
    /**
     * 已经"停止"的那一段锁机的标识（[com.qqqorange.kingoffocus.core.LockEngine.segmentKey]）。
     * 用段标识而不是时间戳：这样"停止"只作用于这一段，下一段专注自动恢复锁机。
     */
    val lockStoppedSeg: String = "",
    /** 多套时段方案 */
    val plans: List<SchedulePlan> = emptyList(),
    /** 当前生效方案的 id；空 = 用第一套 */
    val activePlan: String = "",
    val sleep: SleepCfg = SleepCfg(),
    val cloud: CloudCfg = CloudCfg(),
    val stats: StatsCfg = StatsCfg(),
    /** 睡眠时段用积分解锁到什么时候（unix 秒） */
    val sleepUnlockUntil: Long = 0L,
    /** 整份配置的最后修改时间（unix 秒）；云同步靠它判断谁新 */
    val updatedAt: Long = 0L,
)

fun defaultDays(): List<List<HourPlan>> = List(7) { List(24) { HourPlan() } }

/** 补齐 7×24 的形状：老配置、手工改坏的文件都不至于让界面崩掉 */
fun normalizeDays(raw: List<List<HourPlan>>): List<List<HourPlan>> =
    (0 until 7).map { d ->
        val row = raw.getOrNull(d).orEmpty()
        (0 until 24).map { h ->
            val p = row.getOrNull(h) ?: HourPlan()
            var work = p.work.coerceIn(0, 60)
            var brk = p.brk.coerceIn(0, 60)
            if (brk > 0) {
                work = work.coerceIn(1, 59)
                if (work + brk > 60) brk = 60 - work
            }
            // 窗口统一走 Slots.pack：老配置只有 from/to 的会补成单窗口，
            // 手改坏的（from ≥ to）会被丢掉，多段的重叠会被合并
            val wins = if (p.wins.isNotEmpty()) {
                p.wins
            } else if (p.on) {
                listOf(HourWin(p.from.coerceIn(0, 59), p.to.coerceIn(1, 60)))
            } else {
                emptyList()
            }
            Slots.pack(wins, work, brk)
        }
    }

fun normalize(cfg: Config): Config {
    val days = normalizeDays(cfg.days)
    // ---- 多套方案：老配置只有一套 days，迁移成 plans[0] ----
    val oldPlans = cfg.plans.map { p ->
        p.copy(
            id = p.id.ifBlank { "plan-" + p.name.hashCode().toString(16) },
            name = p.name.ifBlank { "方案" },
            days = normalizeDays(p.days),
            defWork = p.defWork.coerceIn(1, 59),
            defBrk = p.defBrk.coerceIn(0, 59),
        )
    }.ifEmpty {
        listOf(
            SchedulePlan(
                id = "plan-default",
                name = "默认方案",
                days = days,
                defWork = cfg.defWork.coerceIn(1, 59),
                defBrk = cfg.defBrk.coerceIn(0, 59),
            ),
        )
    }.distinctBy { it.id }

    val activeId = oldPlans.firstOrNull { it.id == cfg.activePlan }?.id ?: oldPlans.first().id
    // days 是"当前方案"的权威数据：用户刚在网格上改完，以它为准回填进 plans
    val plans = oldPlans.map { p ->
        if (p.id == activeId) {
            p.copy(
                days = days,
                defWork = cfg.defWork.coerceIn(1, 59),
                defBrk = cfg.defBrk.coerceIn(0, 59),
            )
        } else {
            p
        }
    }

    return cfg.copy(
        days = days,
        granularity = Slots.stepOf(cfg.granularity),
        plans = plans,
        activePlan = activeId,
        sleep = cfg.sleep.copy(
            segments = cfg.sleep.segments.ifEmpty { listOf(SleepSegment()) }.map {
                SleepSegment(it.from.coerceIn(0, 1439), it.to.coerceIn(0, 1440))
            },
            unlockMin = cfg.sleep.unlockMin.coerceIn(1, 240),
            unlockPrice = cfg.sleep.unlockPrice.coerceIn(0, 100),
        ),
        cloud = cfg.cloud.copy(
            url = cfg.cloud.url.trim().let { u -> if (u.isNotEmpty() && !u.endsWith("/")) "$u/" else u },
        ),
        points = cfg.points.coerceAtLeast(0),
        update = cfg.update.copy(
            intervalHours = cfg.update.intervalHours.coerceIn(1, 168),
            lastCheck = cfg.update.lastCheck.coerceAtLeast(0),
        ),
        lock = cfg.lock.copy(
            mode = if (cfg.lock.mode == "strict") "strict" else "gentle",
            pauseMinutes = cfg.lock.pauseMinutes.coerceIn(1, 120),
            pauseCost = cfg.lock.pauseCost.coerceIn(0, 2000),
            stopCost = cfg.lock.stopCost.coerceIn(0, 5000),
        ),
        lockAllow = cfg.lockAllow.map { it.trim() }.filter { it.isNotEmpty() }.distinct(),
    )
}

/** 应用选择器里的一项：包名 + 显示名（不参与序列化） */
data class AppInfo(val pkg: String, val label: String)
