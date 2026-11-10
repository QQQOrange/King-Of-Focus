package com.qqqorange.kingoffocus.ui

import java.util.Locale

/**
 * Android 界面的中英切换。
 *
 * ## 为什么现在才做、为什么只做了这一部分
 *
 * 桌面端从 0.1.x 起就是中英双语（词典 842 条），手机端一直是纯中文：
 * 全部文案内联在 Compose 里，共 **1657 条唯一中文字面量**。抽语言层不难，
 * 难的是把这 1657 条逐条翻译——那是一次纯人工的翻译工程，不该和功能改动混在一起。
 *
 * 所以这里先立好**机制**，再按屏幕分批填：
 *
 *   · `Loc.t("中文")` —— 查词典，没有就原样返回中文（不会崩、不会显示 key）；
 *   · `Loc.isEn` —— 带插值的句子用它做分支，避免把 Kotlin 模板拆成格式串；
 *   · 语言跟随系统（`Locale.getDefault()`）：手机是英文系统就用英文，
 *     中文系统一个字都不变，**不引入任何配置字段**，也不碰跨端备份格式。
 *
 * 目前已覆盖：底部导航、总览页。（其余页面的 `Text("…")` 仍是中文，
 * 逐步替换即可，替换时把对应条目补进 `EN` 就行。）
 */
object Loc {
    @Volatile
    private var lang: String = "zh"

    fun init() {
        lang = if (Locale.getDefault().language == "en") "en" else "zh"
    }

    /** 测试用：强制切语言 */
    fun setForTest(l: String) {
        lang = l
    }

    val isEn: Boolean get() = lang == "en"

    /** 查词典；没翻译就回中文（宁可中文，也不显示一个 key） */
    fun t(zh: String): String = if (lang == "en") EN[zh] ?: zh else zh

    /** 词典覆盖情况（给自检用） */
    fun coverage(keys: Collection<String>): Pair<Int, Int> {
        val miss = keys.count { it !in EN }
        return (keys.size - miss) to keys.size
    }

    val EN: Map<String, String> = mapOf(
        // ── 底部导航 ──
        "总览" to "Overview",
        "时段" to "Schedule",
        "规则" to "Rules",
        "统计" to "Stats",
        "设置" to "Settings",
        // ── 总览：今日条 ──
        "上一段的目标" to "Last window's goal",
        "做完了" to "Done",
        "做了一半" to "Half",
        "没做成" to "Missed",
        "守护中" to "Guarding",
        "现在没有在守护" to "Not guarding right now",
        "守护服务没有在运行" to "The guard service is not running",
        " 缺失" to " missing",
        "点一下立刻把它拉起来" to "Tap to start it now",
        "权限齐备 · 拦截与统计都在跑" to "All permissions granted · blocking and tracking are running",
        "去修复" to "Fix",
        "自律不是折磨自己，是把注意力还给你" to "Discipline is not self-punishment; it gives your attention back",
        // ── 总览：状态 ──
        "睡眠时段" to "Sleep hours",
        "锁机中" to "Locked",
        "自由时间" to "Free time",
        "休息中" to "On break",
        "专注中" to "Focusing",
        "手机先放一边，早上见" to "Phone down — see you in the morning",
        "整台手机先别用，应用都还在" to "The whole phone is off-limits; your apps are still there",
        "现在不在自律时段，规则不生效" to "Outside your discipline hours — rules are idle",
        "休息一下，喝水、走两步" to "Take a break: water, a few steps",
        "规则生效中，坚持一下" to "Rules are active — hang in there",
        "距离起床" to "Until you get up",
        "本段剩余" to "Left in this block",
        "积分" to "Points",
        "今日使用" to "Used today",
        "今日自律" to "Focus today",
        // ── 总览：试用 ──
        "想现在试一下？" to "Want to try it now?",
        "立刻跑 25 分钟：规则照常生效、锁机遮罩也会盖上来，结束后自动还原" to
            "Run 25 minutes now: rules apply as usual, the lock screen comes up, and everything reverts afterwards",
        "已开始 25 分钟试用，到点自动还原" to "25-minute trial started; it reverts automatically",
        "现在正在专注段里，先跑完这一段" to "You are in a focus block — finish it first",
        "试 25 分钟" to "Try 25 min",
        "自律总开关" to "Master switch",
        "已开启：时段、规则、锁机全部生效" to "On: schedule, rules and lock are all active",
        "关闭时什么都不拦，适合刚开始设置的时候" to "Off: nothing is blocked — good while you are still setting things up",
        "先授予「使用情况访问」或「无障碍」，否则不知道你在用哪个应用" to
            "Grant Usage Access or Accessibility first, otherwise the app cannot tell which app you are in",
        // ── 总览：今日 ──
        "今天" to "Today",
        "今日自律总时长" to "Total focus time today",
        " · 最长一段 " to " · longest ",
        "今天还没有排班" to "Nothing scheduled today",
        "今天还没排自律时段。去「时段」点一格就选中；按住空白处拖动可以一次刷好几格。" to
            "No discipline hours today. Open “Schedule” and tap a cell to select it; press and drag to paint several at once.",
        // ── 总览：限制能力 ──
        "限制能力" to "Blocking strength",
        "完整 · 看得见、盖得住、也关不掉" to "Full · visible, covered, and not killable",
        "增强 · 看得见盖得住，但设置里还能强制停止" to "Enhanced · visible and covered, but you can still force-stop it in Settings",
        "基础 · 每秒轮询 + 悬浮窗遮罩" to "Basic · per-second polling + overlay mask",
        "未生效 · 还差下面几项" to "Inactive · missing the items below",
        "已请求 Shizuku 授权，允许后回到本页会自动连上" to
            "Shizuku permission requested; come back to this page and it connects automatically",
        "通知被关：常驻状态、阶段提醒、完成通知、每日汇总都不会出现。" to
            "Notifications are off: the ongoing status, stage reminders, completion notices and daily summary will not appear.",
        "统计与拦截仍照常工作。" to "Tracking and blocking still work.",
        "需要「在其他应用上层显示」" to "Needs “Display over other apps”",
        "锁机生效时，本应用要在回到桌面后立刻盖上一层遮罩；没有这个权限，" to
            "While the lock is active this app has to put a cover over the screen the moment you go home; without this permission,",
        "开启后回到本页，状态会自动变成「已授予」。" to "Turn it on and come back — the status flips to “granted”.",
        "系统会拦住后台拉起页面，锁机会静默失效。\n\n" to
            "the system blocks it from bringing the page up and the lock silently stops working.\n\n",
        "去开启" to "Turn on",
        "暂不" to "Not now",
    )
}
