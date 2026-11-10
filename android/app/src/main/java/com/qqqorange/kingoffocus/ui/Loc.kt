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

        // ── 设置页 ──
        "所有改动即时保存，不需要点确定" to "Everything saves as you go — no OK button",
        "通知" to "Notifications",
        "去开启通知" to "Turn on notifications",
        "启用通知" to "Enable notifications",
        "关掉后四类都不发；应用内状态与统计照常" to "Off: none of the four are sent; in-app status and tracking still work",
        "常驻状态显示今日进度" to "Ongoing status shows today's progress",
        "通知栏里带「今日已自律 X / 计划 Y 分」和进度条；关掉只留当前状态" to "The notification shows “focused X / planned Y min” with a progress bar; off leaves just the current state",
        "专注结束前提醒" to "Remind before a focus block ends",
        " 分钟" to " min",
        "休息结束前提醒" to "Remind before a break ends",
        "休息也提醒" to "Also remind for breaks",
        "任务完成通知" to "Completion notice",
        "专注段做完 / 休息结束的那一刻发一条，带今日累计" to "One notice the moment a block ends, with today's total",
        "每日使用汇总" to "Daily summary",
        "每天固定时间汇总当天的使用时长与自律时长；当天没记录就不发" to "A fixed-time summary of today's usage and focus time; skipped when there is nothing recorded",
        "汇总时间" to "Summary time",
        " 点" to ":00",
        "系统设置里还能按渠道单独关（自律守护 / 阶段提醒 / 任务完成 / 每日使用汇总），" to "Android settings can also mute each channel separately (guard / stage reminders / completion / daily summary),",
        "那比这里的开关更彻底：关掉渠道后代码里发也不会出现。" to "which is stronger than this switch: a muted channel never shows up at all.",
        "拦截" to "Blocking",
        "开启应用拦截" to "Block apps",
        "打开被禁应用时：回到桌面 + 一条说明。不再盖全屏页面——那层遮罩在手机上盖不严，还容易让人以为卡死。" to "Opening a blocked app: back to home plus an explanation. No full-screen cover any more — on a phone it never covered cleanly and looked like a freeze.",
        "锁机" to "Lock",
        "锁机（回桌面 + 全屏遮罩）" to "Lock (home + full-screen cover)",
        "专注段里离开允许的应用：先回桌面，再盖上遮罩。不杀进程、不关机。" to "Leaving an allowed app during a focus block: back to home, then the cover. No process killing, no shutdown.",
        "锁机需要「在其他应用上层显示」权限，去总览页授予" to "Locking needs “Display over other apps” — grant it on the Overview page",
        "温和模式" to "Gentle",
        "强制锁机进行中，不能切回温和模式；等这一段结束再改" to "A strict lock is running; switch back to gentle after it ends",
        "强制模式" to "Strict",
        "强制模式：暂停与提前结束一律不生效，必须完整走完这一段。" to "Strict: pausing and stopping early do nothing — you must finish the block.",
        "温和模式：可以花积分暂停（到点自动恢复）或提前结束这一段。" to "Gentle: spend points to pause (auto-resumes) or to end the block early.",
        "暂停时长" to "Pause length",
        "暂停消耗" to "Pause cost",
        " 分" to " pts",
        "停止消耗" to "Stop cost",
        "锁机期间的限制范围" to "What the lock covers",
        "整机锁" to "Whole phone",
        "只按规则" to "Rules only",
        "整机锁：除系统界面与输入法，其余一律挡住。要让某个应用能用，" to "Whole phone: everything is blocked except system UI and the keyboard. To allow an app,",
        "去「规则」页建一条白名单规则（名单内的应用锁机时照样能开）。" to "add a whitelist rule on the Rules page (listed apps still open while locked).",
        "只按规则：没有白名单，所以按黑名单来——只有名单内的应用会被挡住，其余照常使用。" to "Rules only: no whitelist, so it behaves as a blacklist — only listed apps are blocked.",
        "只按规则，但一条启用的规则都没有，等于锁机不拦任何应用。" to "Rules only, but no rule is enabled — the lock blocks nothing.",
        "先去「规则」页建一条。" to "Create one on the Rules page first.",
        "开始前提醒" to "Warn before it starts",
        "0 = 不提前提醒，到点直接锁。" to "0 = no warning, it locks right away.",
        "整机锁会打断导航、付款码这类事，留点收尾时间。" to "A lock interrupts navigation and payment codes — leave a little wrap-up time.",
        "结束时提醒" to "Warn when it ends",
        "不提醒" to "No warning",
        "弹窗" to "Dialog",
        "两者" to "Both",
        "到点结束时不提醒，遮罩自己消失。" to "No warning at the end; the cover just disappears.",
        "结束时发一条通知（最稳，任何机型都能到）。" to "Send a notification (most reliable on every device).",
        "但现在拿不到「悬浮窗」或 Shizuku，弹不出来——已降级成通知。去总览页授予后才会真弹。" to "Overlay or Shizuku is missing, so the dialog cannot show — downgraded to a notification. Grant it on the Overview page.",
        "结束时盖一页「锁机结束」，10 秒后自己退场，点一下就关。" to "Show a “lock finished” page for 10 seconds; tap to dismiss.",
        "使用情况访问 / 无障碍" to "Usage access / Accessibility",
        "悬浮窗或 Shizuku" to "Overlay or Shizuku",
        "强制模式已开启：这一段结束前没有暂停与跳过" to "Strict mode is on: no pausing or skipping until this block ends",
        "进入时震动一下" to "Vibrate on entry",
        "锁机 / 睡眠开始的那一刻短震（180ms）。关掉就完全静音进入。" to "A 180 ms buzz the moment a lock or sleep window starts. Off: silent entry.",
        "睡眠" to "Sleep",
        "到了这段就整机锁住（回桌面 + 遮罩），可以用积分解锁一小段。Android 无法关机。" to "This window locks the whole phone (home + cover); points can buy a short unlock. Android cannot power off.",
        "睡眠期间一定锁机（不给关）。可以用下面的积分解锁换一小段，" to "The lock always applies during sleep. The unlock below buys a short window,",
        "比如起夜看时间——那是有代价、有上限、到点自动收回的。" to "e.g. checking the time at night — priced, capped, and taken back automatically.",
        "+ 再加一段" to "+ Add a window",
        "解锁时长" to "Unlock length",
        "每分钟价格" to "Price per minute",
        "价格 0 = 睡眠时段不开放积分解锁。" to "Price 0 = no point-unlock during sleep.",
        "云同步" to "Cloud sync",
        "备份与恢复" to "Backup & restore",
        "分心事件" to "Distractions",
        "打开分心事件" to "Open distractions",
        "日历 + 清单 · 暂时没有欠账" to "Calendar + list · nothing pending",
        "启用分心事件" to "Enable distractions",
        "专注时遮罩上显示「记一笔」；关掉后不再提醒（已记的不受影响）" to "Shows “capture” on the cover while focusing; off stops the reminders (recorded items stay)",
        "每周复盘" to "Weekly review",
        "打开本周复盘" to "Open this week's review",
        "五个问题 + 这一周的数字：自律时长 / 被打断 / 目标完成 / 分心事件 / 质押" to "Five questions plus the week's numbers: focus time / interruptions / goals / distractions / stakes",
        "新手引导" to "Onboarding",
        "重新走一遍引导" to "Run the onboarding again",
        "三步：什么时候学 / 哪些不该开 / 完成。会覆盖向导自己写的那套时段与规则，不动你手建的" to "Three steps: when you study / what to block / done. It replaces what the wizard created, never your own rules",
        "版本与更新" to "Version & updates",
        "保活体检" to "Keep-alive check",
        "数据" to "Data",
        "记录使用时长" to "Record usage time",
        "关掉后不再采样，已有数据保留" to "Off stops sampling; existing data is kept",
        "只看屏幕亮着" to "Count screen-on only",
        "默认算到「亮屏且未锁屏」为止；关掉后还要求 60 秒内有过操作" to "Counts while the screen is on and unlocked; off additionally requires input within 60 s",
        "（未授无障碍权限，这项暂时不生效）" to "(no accessibility permission — this has no effect yet)",
        "保留天数" to "Keep for",
        " 天" to " days",
        "和桌面端同一个默认值 400 天：更久的数据才能回答「去年这个时候我在干什么」。" to "Same 400-day default as desktop: longer history answers “what was I doing this time last year”.",
        "恢复某一块的默认值…" to "Reset one section to defaults…",
        "没有可撤销的恢复" to "Nothing to undo",
        "已撤销上次恢复" to "Last reset undone",
        "撤销上次恢复" to "Undo last reset",
        "关于" to "About",
        "版本" to "Version",
        "累计获得" to "Total earned",
        "平台标识" to "Platform",
        "桌面版的「结束进程 / 关机 / 全局热键 / 网页拦截」在 Android 上不可实现，" to "Desktop features (kill process / shutdown / global hotkeys / web blocking) are not possible on Android,",
        "这里用「时段 + 番茄 + 前台检测 + 锁机」做等价的自律闭环。" to "so this uses schedule + pomodoro + foreground detection + lock to close the same loop.",
        "重置全部配置？" to "Reset everything?",
        "规则、时段、睡眠、积分都会回到默认值。统计数据和备份文件不动。" to "Rules, schedule, sleep and points go back to defaults. Stats and backups are kept.",
        "已重置为默认配置" to "Reset to defaults",
        "重置" to "Reset",
        "取消" to "Cancel",
        "只动这一块，其它设置、规则和积分都不变。恢复前会自动存一份快照，「撤销上次恢复」能回来。" to "Only this section changes; other settings, rules and points stay. A snapshot is taken first, so “undo” works.",
        "恢复默认" to "Restore defaults",
        "删除" to "Delete",
        "起点" to "Start",
        "终点" to "End",
        "分钟数从 0 点算起：23:00 = 1380，07:00 = 420。终点小于起点就是跨夜。" to "Minutes from midnight: 23:00 = 1380, 07:00 = 420. End < start means it spans midnight.",
        "已" to "Done",
        "读取云端…" to "Reading cloud…",
        "云端还没有备份" to "No backup in the cloud yet",
        "（明文，建议设置备份密码）" to "(plain text — set a backup password)",
        "上传…" to "Upload…",
        "已上传" to "Uploaded",
        "这份备份的内容本机都有了" to "This backup adds nothing new",
        "正在合并…" to "Merging…",
        "正在覆盖…" to "Overwriting…",
        "同步中…" to "Syncing…",
        "两端已经是同一版本，无需同步" to "Already identical on both sides",
        "同步失败：云端那份读不出来" to "Sync failed: the cloud copy could not be read",
        "云端还没有备份。先点「上传本机」传一份，或者去桌面端「备份 → 云端」上传。" to "No cloud backup yet. Upload this device first, or use “Backup → Cloud” on desktop.",
        "启用云同步" to "Enable cloud sync",
        "与桌面端共用同一个 WebDAV 目录：手机传的备份桌面能恢复，桌面传的手机能恢复。" to "Shares one WebDAV folder with desktop: either side can restore what the other uploaded.",
        "WebDAV 地址（目录）" to "WebDAV address (folder)",
        "留空 = 用默认地址（坚果云）" to "Empty = default address (Nutstore)",
        "默认地址与桌面端完全相同：坚果云 / KingOfFocus（目录不存在会自动建）。" to "The default matches desktop exactly: Nutstore / KingOfFocus (created automatically).",
        "用别的网盘就把地址改成你自己的，改完点「保存」。" to "Using another provider? Change the address and press Save.",
        "还差账号 / 密码：默认地址用的是坚果云，账号填坚果云的登录邮箱，" to "Account / password missing: the default uses Nutstore — put your Nutstore login email here,",
        "密码填「应用密码」（坚果云 → 安全选项 → 添加应用）。" to "and the app password (Nutstore → Security → Add application).",
        "这个地址是明文 http：账号密码和备份内容在局域网里是可见的。能用 https 就用 https。" to "This address is plain http: credentials and backup content are visible on the LAN. Prefer https.",
        "账号" to "Account",
        "密码 / 应用密码" to "Password / app password",
        "已保存" to "Saved",
        "保存" to "Save",
        "测试连接…" to "Testing…",
        "连接正常（能读能写）" to "Connected (read and write)",
        "测试" to "Test",
        "云端备份" to "Cloud backups",
        "处理中…" to "Working…",
        "立即同步" to "Sync now",
        "恢复云端最新" to "Restore latest from cloud",
        "上传本机" to "Upload this device",
        "刷新列表" to "Refresh list",
        "云端还没有备份。点「上传本机」传一份，桌面端在「备份 → 云端」里就能看到它。" to "No cloud backup yet. Upload this device and it shows up under “Backup → Cloud” on desktop.",
        "（自动）" to " (auto)",
        "回到应用时自动备份" to "Back up when returning to the app",
        "上次成功：" to "Last success: ",
        "云端存的是 .kofbak 跨设备备份，两端格式与加密方式一致。" to "The cloud holds .kofbak cross-device backups; both ends use the same format and encryption.",
        "「备份密码」在下面「备份与恢复」里填，两端要一样，否则解不开。" to "Set the backup password under Backup & restore below; both ends must match or it cannot be opened.",
        "从云端恢复？" to "Restore from the cloud?",
        "（自动备份）" to " (auto backup)",
        "覆盖：用这份备份的规则、时段、积分替换本机，本机多出来的规则会消失。" to "Overwrite: rules, schedule and points from this backup replace yours; extra local rules are dropped.",
        "合并：只补本机没有的规则和时段，已有的一律不改；同名不同内容的规则会改名并列。" to "Merge: only adds what is missing; nothing existing is touched. Same-name rules with different content are renamed and kept side by side.",
        "合并" to "Merge",
        "覆盖" to "Overwrite",
        "删除云端这份备份？" to "Delete this cloud backup?",
        "自律与统计都靠一个常驻前台服务。它被系统清掉时，时段不再判定、规则不再拦截、" to "Discipline and tracking rely on one foreground service. If the system kills it, the schedule stops being evaluated, rules stop blocking,",
        "统计也不再记录——所以下面这些项缺一不可。" to "and tracking stops recording — so none of the items below is optional.",
        "已就绪" to "Ready",
        "缺失" to "Missing",
        "用途：" to "Purpose: ",
        "申请时机：" to "When to ask: ",
        "缺失影响：" to "Impact if missing: ",
        "按提示开启后回到本页，状态会自动刷新" to "Enable it as described and come back — the status refreshes itself",
        "重启守护" to "Restart guard",
        "重新体检" to "Re-check",
        "重启守护服务？" to "Restart the guard service?",
        "会把常驻服务重新拉起来，并重新排上心跳与周期任务。" to "Brings the foreground service back up and re-schedules heartbeats and periodic jobs.",
        "正在进行的专注段不受影响（状态是从配置现算的）。" to "A running focus block is unaffected (state is computed from config).",
        "已请求重启守护" to "Restart requested",
        "重启" to "Restart",
    )
}
