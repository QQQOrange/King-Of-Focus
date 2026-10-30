/* ══════════════ 多语言（简体中文 / English） ══════════════
 *
 * 为什么用"中文原文当 key"而不是给每条文案编一个 id：
 *   这个界面已经有 5000 多行模板、上千句中文。给每句编 key 意味着模板里
 *   到处插 t('a.b.c')，改一处要看三个文件；而中文原文本身就是唯一的 key，
 *   漏翻译时还能干净地回落到中文，不会出现 "settings.lang.title" 这种鬼东西。
 *
 * 翻译发生在 DOM 上，而不是把模板改写成函数调用：
 *   render() 把 HTML 落地后，applyLang() 走一遍文本节点与 title/placeholder，
 *   用精确词典 + 正则规则替换。这样新增页面漏了翻译最多是"这一句还是中文"，
 *   不会像改模板那样直接语法错、白屏。
 *
 * 切回中文时不需要重绘：每个被动过的节点都在 SAVED 里存了原文。
 */
(function (global) {
  'use strict';

  /* ---------- 精确词典：中文原文 → 英文 ---------- */
  var EN = {
    /* —— 导航 / 页面标题 —— */
    '总览': 'Overview',
    '自律时段': 'Hours',
    '自律规则': 'Rules',
    '专注遮罩': 'Focus mask',
    '浏览器插件': 'Extension',
    '统计报告': 'Reports',
    '历史报告': 'History',
    '云同步': 'Cloud sync',
    '设置': 'Settings',
    '帮助': 'Help',
    '使用手册': 'Manual',
    '浏览器与配套插件': 'Browsers & extension',
    '自律时段守护': 'Hours guard',
    '自律积分': 'Focus points',
    '专注由你掌控': 'Stay in control',
    '专注遮罩 / FOCUS MASK': 'FOCUS MASK',

    /* —— 通用按钮 / 动作 —— */
    '保存': 'Save',
    '保存配置': 'Save',
    '保存名单': 'Save list',
    '保存为默认': 'Save as default',
    '取消': 'Cancel',
    '删除': 'Delete',
    '删除这套': 'Delete this set',
    '重命名': 'Rename',
    '刷新': 'Refresh',
    '添加': 'Add',
    '清空全部': 'Clear all',
    '立即同步': 'Sync now',
    '立即备份': 'Back up now',
    '立即生成': 'Generate now',
    '立即强制退出': 'Quit now',
    '立即退出程序': 'Quit app',
    '上传当前配置': 'Upload config',
    '上传本机 → 云端': 'This PC → Cloud',
    '云端 → 覆盖本机': 'Cloud → Overwrite this PC',
    '切换': 'Switch',
    '复制路径': 'Copy path',
    '复制这套': 'Duplicate',
    '换一条': 'Next quote',
    '去安装': 'Install',
    '重新检测': 'Rescan',
    '稍后再说': 'Later',
    '重新检测': 'Rescan',
    '‹ 返回': '‹ Back',
    '展开完整图表 ›': 'Open full chart ›',
    '点击展开完整图表': 'Tap to open the full chart',
    '启用 / 停用': 'Enable / Disable',
    '启用 / 停用自律时段': 'Enable / disable hours',
    '暂停': 'Pause',
    '手写': 'Manual',
    '自定义': 'Custom',
    '全部': 'All',
    '查看项目主页': 'Project home',
    '打开文件夹': 'Open folder',
    '打开目录': 'Open folder',
    '打开插件目录': 'Open extension folder',
    '打开数据目录': 'Open data folder',
    '打开配置目录': 'Open config folder',
    '打开备份目录': 'Open backup folder',
    '保存': 'Save',
    '确定': 'OK',
    '关闭': 'Close',
    '编辑': 'Edit',
    '新增': 'Add',
    '导入': 'Import',
    '导出': 'Export',
    '知道了': 'Got it',

    /* —— 状态 / 短语 —— */
    '已开启': 'On',
    '已启用': 'Enabled',
    '已安装': 'Installed',
    '已注册': 'Registered',
    '未安装': 'Not installed',
    '被停用': 'Disabled',
    '已选中（整块同色）': 'Selected (one solid color)',
    '不会': 'No',
    '当前已是管理员': 'Already elevated',
    '当前状态': 'Status',
    '当前状态：': 'Status: ',
    '当前窗口': 'Current window',
    '当前最上层（正在用）的窗口': 'Window on top (in use)',
    '目标窗口': 'Target window',
    '跟随当前窗口': 'Follow active window',
    '专注': 'Focus',
    '专注中': 'Focusing',
    '休息': 'Break',
    '休息段': 'Break window',
    '今日': 'Today',
    '本周': 'This week',
    '本月': 'This month',
    '今年': 'This year',
    '天': 'd',
    '日': 'Day',
    '周报': 'Week',
    '月报': 'Month',
    '年报': 'Year',
    '日报': 'Day',
    '每日报告': 'Daily report',
    '每周报告': 'Weekly report',
    '每月报告': 'Monthly report',
    '每年报告': 'Yearly report',
    '自定义周期': 'Custom period',
    '我写的': 'Mine',
    '激励语录': 'Motivation',
    '我的激励语录': 'My quotes',

    /* —— 总览 —— */
    '今日概览': 'Today',
    '时长统计': 'Time tracked',
    '使用时长统计': 'Time tracked',
    '使用时长分布 ·': 'Usage distribution ·',
    '今日拦截网页': 'Sites blocked today',
    '今日拦截软件': 'Apps blocked today',
    '最近拦截': 'Recent blocks',
    '积分兑换': 'Redeem points',
    '用积分解锁': 'Unlock with points',
    '想临时放过自己？': 'Need a break?',
    '解除只有两条路：': 'Only two ways out:',
    '用「总览 → 积分兑换」解锁，或者把自律规则开关关掉（固化了就关不掉）。':
      'Redeem points in Overview, or switch the rules off (not possible while hard-locked).',
    '还在': 'still',
    '两种状态汇总': 'Both states combined',
    '只统计自律模式开启时段': 'Only while discipline is on',
    '汇总口径：把「已开启」与「未开启」两个数据集里同一个应用 / 同一个域名的秒数直接相加，不做任何加权；扇区大小 = 该项在所选时间段内的前台使用总时长占比。':
      'How it adds up: seconds for the same app / domain are summed across "on" and "off" with no weighting; slice size = that share of foreground time.',
    '共': 'in total',
    '个页面': 'pages',
    '合计': 'Total',
    '官网': 'Website',
    '本周专注': 'Focus this week',
    '今日专注': 'Focus today',

    /* —— 自律时段 —— */
    '启用提醒': 'Enable reminders',
    '生效时间段 · 完整图表': 'Active hours · full chart',
    '时段名称，例如：晚自习': 'Name, e.g. Evening study',
    '新建自律时段': 'New hours set',
    '星期时段': 'Weekly hours',
    '通用时长': 'Default rhythm',
    '每次选择的时长': 'Rhythm for new selections',
    '再排一套星期时段': 'Add another set',
    '切换到「周末轻松」': 'Switch to Weekend light',
    '切换到「工作日强化」': 'Switch to Weekday focus',
    '周末轻松': 'Weekend light',
    '工作日强化': 'Weekday focus',
    '这套时段生效的自律规则': 'Rules active in this set',
    '这套时段用上全部已启用的自律规则': 'Use every enabled rule in this set',
    '同一时刻只有一套在生效；卡片顶部的开关管的是「自律时段」整体，与选哪套无关。':
      'Only one set is active at a time. The switch on top controls discipline hours as a whole.',
    '换方案 = 换时间表 + 换管哪些分组。比如「工作日」那套只绑工作类， 「周末」那套只绑娱乐类，互不干扰。':
      'Switching a set switches both its timetable and which rules it governs.',
    '同一天相邻的时段会连成一整块；块里的空白就是没选中的分钟':
      'Adjacent windows on the same day merge into one block; gaps are unselected minutes.',
    /* —— 休息结束时的收尾 —— */
    '休息结束时的收尾': 'Break-end cleanup',
    '休息段里黑名单是放行的；回到学习的那一刻，把休息里开着的那些收起来。':
      'Blocked apps are allowed during breaks; when study starts, those windows get tucked away.',
    '回到学习时自动收尾': 'Tidy up when study starts',
    '只在「休息 → 学习」的边界执行一次；学习中新打开的应用照常拦截。':
      'Runs once at each break → study boundary; apps opened during study are still blocked as usual.',
    '处理方式': 'How to handle them',
    '柔和 · 最小化': 'Gentle · Minimize',
    '强制 · 关闭': 'Strict · Close',
    '收尾已关闭，这两种方式都不会执行。':
      'Cleanup is off, so neither option runs.',
    '窗口收进任务栏、程序留着；网页换成拦截页（标签还在）。学习期间不再强杀，但点开就按拦截处理。':
      'The window goes to the taskbar and the app stays alive; web tabs become the block page (tab kept). Nothing is force-closed during study, but reopening it gets it blocked.',
    '直接关掉：先请程序自己退出，不退出再强制结束；网页直接关掉标签页。':
      'Close it right away: ask the app to quit first, force-end it if it refuses; web tabs are closed.',
    '播放中的媒体一并暂停': 'Pause media that is playing',
    '只有确实在播放才暂停；已暂停、已停止、状态读不到都不动，也永远不会自动恢复播放。':
      'Pauses only when playback is confirmed; paused, stopped or unreadable states are left alone, and playback is never resumed automatically.',
    '作用对象：被自律规则判为「不能开」的软件（黑名单命中的，或白名单之外且不是保护进程的），与拦截用的是同一份判定。':
      'Targets: apps the rules block (on the blacklist, or outside the whitelist and not protected) — the very same test used for blocking.',
    '网页由浏览器插件按标签页执行同一种收尾：柔和 = 换成拦截页（标签保留，休息回来点刷新即可），强制 = 直接关掉标签页；不会因为一个标签连坐整个浏览器。':
      'Web tabs get the same cleanup through the extension: gentle = switch to the block page (tab kept, reload after the break), strict = close the tab. One tab never takes the whole browser down.',
    '执行时机：只在「休息 → 学习」的那一次边界执行；开机或唤醒时如果已经在上课段，不会补做。':
      'Timing: only at the break → study boundary; if you boot or wake up already inside a study window, nothing is done retroactively.',
    '收起窗口，程序留着，随时可以还原': 'Tuck the window away, keep the app, restore any time',
    '直接关闭应用': 'Close the app',
    '先打开上面的收尾': 'Turn on cleanup first',
    '自律时段生效中，不能改': 'Locked while discipline hours are running',
    /* 完整图表的分步说明：被 <b> 切成多段，逐段翻 */
    '空白处按住拖动': 'Drag on empty space',
    '= 新建一段（按当前粒度吸附，夹在 0:00–24:00，最少一格）；':
      'to create a window (snaps to the current step, clamped to 0:00–24:00, at least one cell);',
    '在已有的条上按住拖动': 'Drag an existing strip',
    '= 整段搬走，长度不变，撞到日界会贴边停下；':
      'to move the whole window — same length, it stops at the day boundary;',
    '单击': 'A single click',
    '= 只记下选区，': 'only remembers the selection, ',
    '不改': 'never changes',
    '时段的数量与结构；': 'the number or shape of windows;',
    '右键格子': 'Right-click a cell',
    '= 细调专注 / 休息时长与起止分钟。': 'to fine-tune focus / break length and exact minutes.',
    '点任意一条会打开独立弹窗，用图表方式查看和调整时间分布。':
      'Tap any entry to open a chart and adjust the distribution.',
    '只影响「自律时段」页怎么排时间，不改变判定口径。':
      'Only affects how this page is laid out, not how blocking is decided.',
    '每一次选择': 'Each selection',
    '每套时段还能各自绑定分组': 'Each set can bind its own rules',
    '没绑任何分组 = 全部生效（默认）': 'No rules bound = all rules apply (default)',
    '无效的时段': 'Invalid window',
    '周一': 'Mon',
    '周二': 'Tue',
    '周三': 'Wed',
    '周四': 'Thu',
    '周五': 'Fri',
    '周六': 'Sat',
    '周日': 'Sun',
    '周四·今': 'Thu·Now',
    '小时': 'h',
    '分钟': 'min',
    '秒': 's',
    '毫秒': 'ms',
    '起': 'from',
    '至': 'to',
    '强度': 'Intensity',

    /* —— 自律规则 —— */
    '+ 新建自律规则': '+ New rule',
    '新自律规则': 'New rule',
    '+ 从运行中的程序添加': '+ From running app',
    '+ 整个文件夹': '+ Whole folder',
    '+ 选择 exe': '+ Pick exe',
    '软件': 'Apps',
    '网页': 'Sites',
    '进程名': 'Process',
    '窗口标题': 'Window title',
    '该 exe': 'This exe',
    '该域名': 'This domain',
    '通配（如': 'Wildcard (e.g.',
    '全局保护名单': 'Global allowlist',
    '白名单下，这些进程永远不会被拦截。用逗号分隔（进程名，不带 .exe）。':
      'These processes are never blocked. Comma-separated, no .exe.',
    '优先级（从高到低）：': 'Priority (high to low):',
    '匹配顺序：': 'Match order:',
    '按 exe 完整路径比对；': 'Matches the full exe path;',
    '匹配该目录下所有 exe；': 'matches every exe under that folder;',
    '按包含关系匹配，适合拦网页标题。': 'Substring match, good for page titles.',
    '（一律不拦） >': '(never blocked) >',
    '（一律放行） > 自律规则时间范围 > 手动开关。':
      '(always allowed) > rule time window > manual switch.',
    '生效类型': 'Type',
    '黑名单': 'Blocklist',
    '白名单': 'Allowlist',
    '两者同时': 'Both',
    '黑名单 + 白名单': 'Blocklist + Allowlist',
    '黑名单 + 白名单同时生效': 'Blocklist + allowlist together',
    '两者是包含关系': 'How the two relate',
    '一条自律规则 = 一份名单 + 一张周时间表。': 'A rule = one list + one weekly schedule.',
    '名单里的软件 / 网站会被拦下，其余放行':
      'Listed apps and sites are blocked, everything else passes',
    '只有名单里的能用，其余一律拦掉': 'Only listed items are allowed, everything else is blocked',
    '名单里的照样拦，「例外」里的放行': 'Listed items are blocked; exceptions pass',
    '黑名单：名单里的软件 / 网站会被拦下，其余放行':
      'Blocklist: listed apps and sites are blocked, everything else passes',
    '全局默认': 'Global default',
    '例外': 'Exception',
    '例外的软件 / 网站': 'Exception apps / sites',
    '生效时间不在这里设：': 'Active hours are set elsewhere:',
    '自律规则只在': 'Rules only run',
    '：自律规则只在「自律时段」的专注段内生效， 其余时间（含番茄休息段）一律不拦。下面的开关可以先配好，到点自动生效。':
      ': rules only apply during focus windows, never during breaks. You can prepare them now; they take effect on schedule.',
    '时间表全空 = 自律时间内全程生效': 'Empty schedule = active for the whole window',
    '时间表是在这之上再收窄——全空 = 自律时间内全程生效，画了格子就只在格子里生效。':
      'The schedule narrows it further: empty means the whole window, painted cells mean only those.',
    '内置': 'Built-in',
    '软件 / 网站': 'Apps / sites',
    '条': 'items',
    '暂无生效自律规则。到「自律规则」里新建一条——它只会在自律时间内生效。':
      'No active rules. Create one under Rules — it only applies during discipline hours.',
    '当前没有生效的自律规则': 'No rule is active right now',
    '修改立即生效': 'Changes apply immediately',
    '改动会立即生效；点保存才会写进配置，下次启动沿用':
      'Changes apply immediately; saving writes them to the config for next launch.',
    '删除这条规则': 'Delete this rule',
    '启用这条规则': 'Enable this rule',
    '固化': 'Hard lock',
    '已锁定': 'Locked',
    '未绑定': 'Unbound',
    '绑定': 'Bind',
    '个软件': 'apps',
    '个网站': 'sites',
    '条例外': 'exceptions',
    '已恢复': 'Restored',
    '已恢复默认': 'Reset to default',

    /* —— 专注遮罩 —— */
    '遮罩参数': 'Mask settings',
    '不透明度': 'Opacity',
    '透明度': 'Opacity',
    '留白': 'Inset',
    '圆角': 'Corner radius',
    '动画时长': 'Animation',
    '跟随系统': 'System',
    '浅色': 'Light',
    '深色': 'Dark',
    '外观': 'Appearance',
    '语言': 'Language',
    '语言 · Language': 'Language',
    // WebDAV 示例地址里的中文占位符
    'https://dav.jianguoyun.com/dav/目录/': 'https://dav.jianguoyun.com/dav/folder/',
    'https://你的域名/remote.php/dav/files/用户名/目录/':
      'https://your-domain/remote.php/dav/files/username/folder/',
    '简体中文': 'Simplified Chinese',
    '浏览器插件会跟随这里的语言；默认简体中文。':
      'The browser extension follows this setting. Default is Simplified Chinese.',
    '已切换到 English': 'Switched to English',
    '已切换回简体中文': 'Switched back to Simplified Chinese',
    '语言保存失败': 'Could not save the language',
    '切换外观': 'Theme',
    '显示位置': 'Position',
    '左上': 'Top left',
    '右上': 'Top right',
    '左下': 'Bottom left',
    '右下': 'Bottom right',
    '停靠到左上角': 'Dock top left',
    '停靠到右上角': 'Dock top right',
    '停靠到左下角': 'Dock bottom left',
    '停靠到右下角': 'Dock bottom right',
    '专注遮罩已开启': 'Focus mask is on',
    '专注遮罩跟随自律模式': 'Follow discipline mode',
    '两种开启方式：全局快捷键（默认': 'Two ways to start: hotkey (default',
    '全局快捷键': 'Global hotkey',
    '快捷键': 'Hotkey',
    '当前路径：D:\\x': 'Current path: D:\\x',
    '当前：C:\\Fake\\msedge.exe': 'Now: C:\\Fake\\msedge.exe',
    '测试模式': 'Test mode',
    '演练模式': 'Dry run',
    '预览只是看一眼效果，会自动结束，不会改变主开关。':
      'Preview is temporary and does not change the main switch.',
    '选一个目标窗口，其余区域被遮罩盖住，遮罩从窗口边缘扩散到铺满整块显示器。 透明度 / 留白 / 圆角 / 动画时长都能实时调。':
      'Pick a target window and everything else is covered; the mask expands from the window edge. Opacity, inset, radius and duration are adjustable live.',
    '打开后不用选目标窗口：遮罩自动盯住':
      'No target needed: the mask follows',
    '取消窗口置顶': 'Unpin window',
    '主窗口置顶': 'Keep main window on top',
    '摘掉其他置顶浮窗的“总在最前”属性': 'Drop the always-on-top flag of other floating windows',
    '点击遮罩空白处不穿透': 'Clicks on the mask do not pass through',
    '选中窗口本身永远正常可点': 'The selected window always stays clickable',
    '桌面 HUD': 'Desktop HUD',
    '显示桌面 HUD': 'Show desktop HUD',
    '自律期间在屏幕右上角浮一个小窗：已经专注多久、还有多久结束，下面一句励志短语。 窗口置顶、不进任务栏，跟着浅色/深色主题走。':
      'A small always-on-top window showing elapsed time, time left and a short quote. Follows the theme.',
    '切换间隔': 'Rotation interval',
    '短语切换间隔': 'Quote rotation',
    '联网取一句（一言），失败时用内置句子轮换':
      'Fetch a quote online (Hitokoto); fall back to built-in lines',

    /* —— 统计 / 报告 —— */
    '统计报告': 'Reports',
    '报告在日/周/月/年结束后自动生成（程序没开会下次启动补齐），也可以手动生成。 三种口径：只看开启、只看未开启、两者汇总（同一应用/域名秒数直接相加）。':
      'Reports are generated automatically after each period (catch-up on next launch), or on demand.',
    '开启下面的自动生成，或者点「立即生成」。':
      'Enable auto-generation below, or click Generate now.',
    '还没有生成过报告。': 'No reports yet.',
    '暂无数据': 'No data',
    '这个时间段还没有数据。': 'No data for this period.',
    '统计每秒采样一次前台窗口，用一会儿就会有了。':
      'The foreground window is sampled every second; data appears shortly.',
    '保留在本地，可随时回看、导出或删除': 'Stored locally; view, export or delete anytime',
    '导出报告': 'Export report',
    '删除这份报告？': 'Delete this report?',
    '原始日数据不受影响': 'Raw daily data is not affected',
    '自动生成设置': 'Auto-generation',
    '数据保留天数': 'Data retention',
    '超期的日文件与报告会在启动时清理': 'Expired files are pruned at startup',
    '只记录最近 240 条，含时间、类型、对象与命中自律规则。':
      'Only the latest 240 entries are kept, with time, type, target and matched rule.',
    '还没有拦截记录。等你设置的时段到了，这里会出现被拦下的应用和网页。':
      'No blocks yet. Blocked apps and sites will appear here once your hours begin.',
    '总量': 'Total',
    '平均': 'Average',
    '峰值': 'Peak',
    '趋势': 'Trend',
    '分类': 'Category',
    '全部应用': 'All apps',

    /* —— 云同步 / 备份 —— */
    '云同步': 'Cloud sync',
    'WebDAV 云同步': 'WebDAV sync',
    'WebDAV 目录地址': 'WebDAV URL',
    '账号': 'Account',
    '邮箱 / 用户名': 'Email / user',
    '密码 / 应用密码': 'Password / app password',
    '备份密码': 'Backup password',
    '留空 = 用本机 DPAPI 加密': 'Empty = encrypt with local DPAPI',
    '本地备份': 'Local backup',
    '启动时自动备份': 'Auto backup on launch',
    '自动同步': 'Auto sync',
    '自动恢复': 'Auto restore',
    '立即同步': 'Sync now',
    '上次同步：': 'Last sync: ',
    '从未同步': 'Never synced',
    '尚未连接': 'Not connected',
    '还没有同步记录': 'No sync records yet',
    '查看云端备份 / 恢复': 'Browse cloud backups',
    '同步自律规则': 'Sync rules',
    '冲突时不会静默丢掉任何一边。': 'Conflicts never silently drop either side.',
    '优先用云端': 'Prefer cloud',
    '优先用本机': 'Prefer local',
    '保持两边都留': 'Keep both',
    '冲突处理': 'Conflicts',
    '云端备份': 'Cloud backup',
    '还没有本地备份。点「立即备份」生成第一份。':
      'No local backups yet. Click Back up now to create the first one.',
    '先在下面填写 WebDAV 地址': 'Fill in the WebDAV URL below first',
    '上传本机': 'Upload local',
    '下载到本机': 'Download to local',
    '数据在哪？': 'Where is my data?',
    '配置文件': 'Config file',
    '数据': 'Data',
    '目录': 'Folder',
    '已同步': 'Synced',
    '同步失败': 'Sync failed',
    '备份失败': 'Backup failed',
    '恢复': 'Restore',
    '恢复失败': 'Restore failed',

    /* —— 设置 —— */
    '提醒': 'Reminders',
    '启用提醒': 'Enable reminders',
    '休息也提醒': 'Remind before breaks',
    '休息结束前提醒': 'Remind before break ends',
    '学习结束前提醒': 'Remind before focus ends',
    '总开关，关掉后两种提醒都不发': 'Master switch for both reminders',
    '关掉后只提醒学习结束，休息结束不打扰': 'Off = only remind when focus ends',
    '系统': 'System',
    '开机自动启动': 'Launch at startup',
    '写入 HKCU 的 Run 项，不需要管理员': 'Writes to HKCU\\Run; no admin needed',
    '以管理员模式启动': 'Run as administrator',
    '打开后会弹 UAC 并重启成管理员。管理员权限下，遮罩可以':
      'Prompts for UAC and restarts elevated, so the mask can',
    '关闭窗口时收进托盘': 'Minimize to tray on close',
    '主窗口置顶': 'Keep window on top',
    '开启后主界面始终浮在其它窗口之上，不会被别的窗口盖住；点一下这里就能立刻生效':
      'Keeps the window above others; takes effect immediately.',
    '自律时段内允许退出': 'Allow quitting during hours',
    '任何方式都退不掉': 'cannot be quit by any means',
    '媒体管控': 'Media control',
    '暂停': 'Pause',
    '拦截行为': 'Blocking behaviour',
    '拦截引擎在托盘里继续工作': 'The engine keeps running in the tray',
    '检测频率': 'Detection interval',
    '扫描间隔': 'Scan interval',
    '插件心跳容忍': 'Heartbeat tolerance',
    '超过这个时间没收到插件心跳，就认为插件被停用了':
      'If no heartbeat arrives within this window, the extension is treated as disabled.',
    '越小越灵敏，占用也越高': 'Smaller is more responsive but uses more CPU.',
    '启用浏览器巡检': 'Monitor browsers',
    '每次打开软件都识别一遍浏览器与插件状态': 'Detect browsers and extensions on every launch',
    '启动时自动检测': 'Detect on launch',
    '自动关闭': 'Auto close',
    '网页被拦时关闭整个浏览器': 'Close the whole browser when a site is blocked',
    '关闭后，自律时段里不会因为插件状态而关浏览器':
      'Off = browsers are not closed because of the extension state.',
    '只记录不真的关闭，用来先验证名单是否写对了':
      'Log only, do not actually close — useful to verify the list.',
    '先弹一张卡片说明原因和剩余秒数，再关闭':
      'Show a card with the reason and countdown, then close.',
    '先温和关闭': 'Graceful close first',
    '关闭前弹提示': 'Warn before closing',
    '关闭前宽限': 'Grace period',
    '先给程序发关闭信号，0.7 秒不退再强制结束，能保住一部分现场':
      'Ask the app to close; force-kill after 0.7 s if it refuses.',
    '启用统计': 'Track usage',
    '关闭后不再采样，已有数据保留': 'Off = stop sampling; existing data is kept.',
    '计入无操作时间': 'Count idle time',
    '关掉时，超过 60 秒没碰键鼠就不计时': 'Off = pause tracking after 60 s idle.',
    '数据保留天数': 'Keep data for',
    '自动生成设置': 'Auto-generation',
    '外观': 'Appearance',
    '语言': 'Language',
    '语言与地区': 'Language',
    '订阅支持': 'Support',
    '关于': 'About',
    '版本': 'Version',
    '检查更新': 'Check for updates',
    '更新检测': 'Updates',

    /* —— 拖拽与语录设置 —— */
    '移动': 'Move',
    '调整': 'Resize',
    '选中 / 拖动中': 'Selected / dragging',
    '已放置（已保存）': 'Placed (saved)',
    '同一个色相，只差 5% 明度：拖的时候亮一点点，松手后轻微加深就是存好了。同一天相邻的时段会连成一整块':
      'Same hue, 5% darker once saved — dragging looks slightly brighter. Adjacent windows on one day merge into a single block.',
    '选中': 'Select',
    '这些句子会和联网取到的「一言」一起在 Hub 顶部轮换，每条都会标明来源。 最多 60 条、每条 120 字；这里改完立刻生效，不用打开 Hub。':
      'These rotate at the top of the Hub together with online quotes, each labelled with its source. Up to 60 lines of 120 characters; changes apply immediately.',
    '还没有自己写的语录。': 'No custom quotes yet.',
    '删除': 'Delete',

    /* —— 自定义浏览器 —— */
    '＋ 添加': '+ Add',
    '直接写一句新的': 'Write a new one',
    '（来自 hitokoto.cn 公开接口）': ' (from the hitokoto.cn public API)',
    '内置句子': 'Built-in line',
    '自定义浏览器': 'Custom browser',
    '名称': 'Name',
    '主程序路径': 'Executable path',
    '选择 exe': 'Pick exe',
    '添加': 'Add',
    '路径有效': 'Path OK',
    '路径失效': 'Path missing',
    '自定义添加': 'Added manually',
    '插件需自检': 'Check manually',
    '还没有登记任何自定义浏览器。': 'No custom browser registered yet.',
    '当作浏览器': 'treated as a browser',
    '处理：自律时段里打开它同样会被关闭， 「浏览器巡检」也认得它。插件状态无法自动探测，需要你自己确认。':
      ': it gets closed during discipline hours too, and the browser scan counts it. The extension state cannot be probed automatically, so check it yourself.',
    '清单里没有的浏览器（公司内部壳、某些国产套壳）在这里登记主程序路径。 登记后它会被':
      'Register the executable of a browser that is not in the built-in list (in-house shells, minor Chromium forks). Once registered it is',
    '保存时会校验 .exe 是否存在；登记后立即重新检测，不需要重启软件。':
      'The .exe is verified when saving; a rescan runs immediately, no restart needed.',
    '删除这个自定义浏览器？只是不再登记它，不会动浏览器本身。':
      'Remove this custom browser? It only stops being registered; the browser itself is untouched.',
    '已添加，正在重新检测…': 'Added — rescanning…',
    '已删除': 'Removed',
    '先给这个浏览器起个名字': 'Give this browser a name first',
    '先选择或粘贴主程序路径': 'Pick or paste the executable path first',
    '最多登记 16 个自定义浏览器': 'Up to 16 custom browsers',

    /* —— 关于页 —— */
    '本版本更新时间': 'Released',
    '开发者': 'Author',
    '项目': 'Project',
    '项目地址': 'Repository',
    '点击可直接在浏览器中打开': 'Opens in your browser',
    '打开': 'Open',
    '自动更新': 'Auto update',
    '启动时检查 GitHub Releases，有新版本会弹窗提示；下载完成后自动退出、安装并重新启动。':
      'Checks GitHub Releases at launch and prompts when a newer version exists; then quits, installs and restarts.',
    '启动时检查更新': 'Check for updates at launch',
    '最近一次检查：还没检查过': 'Last check: never',
    'GitHub 个人访问令牌': 'GitHub personal access token',
    '填了可以提升 API 额度（未登录 60 次/小时，登录后 5000 次/小时）':
      'Raises the API limit (60/h anonymous, 5000/h authenticated)',
    '剩余额度 读取失败': 'Could not read the remaining quota',
    '刷新额度': 'Refresh quota',
    '令牌只保存在本机，界面上': 'The token stays on this machine and is',
    '不回显任何字符': 'never echoed',
    '，输入框始终是暗文。当前': ', the field always stays masked. Currently',
    '未设置': 'not set',
    '。点': '. Click',
    '打开 GitHub 官方教程。': 'to open the official GitHub guide.',
    '当前没有跳过任何版本': 'No versions are skipped',
    '立即检查': 'Check now',

    /* —— 侧栏 / 状态 —— */
    '当前没有生效的自律规则': 'No rule is active right now',
    '浏览器插件：未连接': 'Extension: not connected',
    '浏览器插件：已连接': 'Extension: connected',
    '统计口径：只计入你在电脑前的时间；离开超过 1 分钟（无键鼠输入）的那段不计入。':
      'Counting only time you were at the computer: any gap over 1 minute without keyboard or mouse input is excluded.',
    '自律模式已开启': 'Discipline is on',
    '自律模式未开启': 'Discipline is off',
    '未以管理员身份运行': 'Not running as administrator',
    '☾ 深色': '☾ Dark',
    '☀ 浅色': '☀ Light',
    '◐ 跟随系统（深）': '◐ System (dark)',
    '◐ 跟随系统（浅）': '◐ System (light)',
    // 微缩图的星期表头只取一个字（周一 → 一），英文用两位缩写
    '一': 'Mo',
    '二': 'Tu',
    '三': 'We',
    '四': 'Th',
    '五': 'Fr',
    '六': 'Sa',
    '日': 'Su',
    '生效时段：': 'Active window: ',
    '（专注中）': ' (focus)',
    '生效中的自律规则：': 'Active rules: ',
    '假期模式': 'Holiday mode',
    '不足 1 轮': 'less than 1 round',
    // 侧栏状态被 <b> 切成三段，逐段翻
    '当前不在自律时间：自律规则不拦截，下一个选中时段：':
      'Outside discipline hours; nothing is blocked. Next window: ',
    '（本小时）': ' (this hour)',
    '自律规则：': 'Rules: ',

    /* —— 帮助 —— */
    '以下都是实际实现口径，不是宣传语。': 'These are the actual behaviours, not marketing copy.',
    '数据在哪？': 'Where is my data?',
    '统计只存在本机，不上传任何数据。': 'Statistics stay on this machine; nothing is uploaded.',
    '全部数据都在软件目录下的': 'Everything lives under the app folder: ',
    '里 —— 原始日数据存': ' — raw daily data in ',
    '里按扩展名找到本插件： 完全找不到 =': ' finds the extension by folder: missing =',
    '； 找到但被停用 =': '; found but disabled =',
    '；找到且': '; found and ',
    '：读各浏览器用户目录下每个配置档的': ': reads each profile under the browser user data folder',
    '个浏览器装了但插件没启用。缺少这个插件会有两个后果：':
      'browser(s) have the extension installed but disabled. Without it:',
    '① 网页自律规则拦不住（插件负责在请求层拦截，并在自律时段扫掉已打开的标签页）':
      '① Site rules cannot be enforced (the extension intercepts requests and closes open tabs).',
    '② 自律时段里打开这些浏览器会被': '② During hours, opening these browsers will be',
    '自动关闭它，并记一条拦截记录。装了插件且已启用则完全不受影响。':
      'closed automatically and logged. With the extension enabled this never happens.',
    '（因为无法确认网页是否违规）': '(the site cannot be verified)',
    '自律规则里可以设「专注 N 分钟 / 休息 M 分钟」，循环锚点是从该时段的起点开始算。 休息期间这条自律规则不拦截，时间到自动锁回。':
      'Rules can use a focus/break rhythm anchored to the start of each window; nothing is blocked during breaks.',
    '判定与检测说明': 'How it decides',
    '状态判定': 'State logic',
    '生效 = 主开关 OR（跟随自律 AND 自律生效中）':
      'Active = master switch OR (follow discipline AND discipline is on)',
    '采集口径：': 'What is tracked: ',
    '每秒采样一次前台窗口；按「自律模式开启 / 未开启」两套数据独立记录，互不混合。 前台是浏览器且插件上报过，就记到域名上，否则记到 exe 上。':
      'The foreground window is sampled every second and recorded separately for discipline on/off. Browser activity is attributed to domains when reported, otherwise to the exe.',
    '摘要': 'Summary',
    '常见问题': 'FAQ',
    '拦截没反应？': 'Nothing gets blocked?',
    '网页没拦住？': 'Sites still open?',
    '支持范围': 'Supported',
    '支持': 'Supports',
    '系统要求': 'Requirements',
    '已知限制': 'Known limits',
    '更新日志': 'Changelog',
    '许可': 'License',
    '反馈': 'Feedback',
    '作者': 'Author'
  };

  /* ---------- 补编：长句与模板碎片 ----------
   * 这些大多是被 <b> 切开后的文本节点，一段一段翻才是准确的；
   * 拼接后读起来仍是一句通顺的英文。
   */
  var EXTRA = {
    /* —— 统计页：扇图展开面板 / 日历 —— */
    '类型': 'Type',
    '占比': 'Share',
    '时长': 'Duration',
    '使用时间': 'When',
    '使用时段': 'Time ranges',
    '这一版开始才有分段记录，更早的数据只有小时分布。':
      'Minute-level ranges are recorded from this version on; older data only has hourly totals.',
    '统计口径：只计入你在电脑前的时间；离开超过 1 分钟（无键鼠输入）的那段不计入。':
      'Counting only time you were at the computer: any gap over 1 minute without keyboard or mouse input is excluded.',
    '其他': 'Others',
    '累计前台时长': 'Cumulative foreground time',
    /* —— 时间日历 —— */
    '时间日历': 'Activity calendar',
    '周': 'Week',
    '月': 'Month',
    '今天': 'Today',
    '每个色块就是一种软件；点任意一天，右边「当日日历」就跟着换到那天。':
      'Each colour is one app; clicking a day moves the day view on the right to it.',
    /* —— 当日日历（饼图右侧的单日时间轴） —— */
    '当日日历': 'Day view',
    '空闲': 'Idle',
    '前一天': 'Previous day',
    '后一天': 'Next day',
    '取消聚焦': 'Clear focus',
    '按时间轴看这一天做了什么': 'What you did today, on a timeline',
    '正在载入…': 'Loading…',
    '这段时间还没有数据。': 'No data in this period.',
    '这一天没有使用记录。': 'No activity on this day.',
    '周一': 'Mon',
    '周二': 'Tue',
    '周三': 'Wed',
    '周四': 'Thu',
    '周五': 'Fri',
    '周六': 'Sat',
    '周日': 'Sun',
    '+ 新建': '+ New',
    '5 秒内': 'within 5 s',
    '= 一份软件 / 网站名单 + 一张周时间表。': '= one app/site list + one weekly schedule.',
    '= 细调专注 / 休息时长与起止分钟。': '= fine-tune focus/break length and start/end minutes.',
    'Ctrl+Alt+K（留空=不注册）': 'Ctrl+Alt+K (empty = not registered)',
    '· 「云端 → 覆盖本机」是强制拉取，会丢掉本机未上传的改动，请谨慎使用。':
      '· "Cloud → Overwrite" force-pulls and discards local changes that were never uploaded.',
    '· 「立即同步」会先读云端再比较：云端新就下载，本机新就上传，一样就跳过。':
      '· Sync now reads the cloud first: newer cloud data is downloaded, newer local data is uploaded, identical data is skipped.',
    '· 常见地址格式：坚果云': '· Common formats: Nutstore',
    '· 每份配置都带': '· Every config carries',
    '· 账号密码只保存在本机配置文件里，不随配置上传。':
      '· Credentials stay in the local config file and are never uploaded.',
    '—— 自律接管期间主开关置灰（不能手动关），自律一结束立刻回到你自己按的状态， 两者不会再互相打架。':
      '— while discipline takes over the master switch is greyed out, then returns to your own setting.',
    '① 到「自律规则」新建一条 → ② 加软件 / 加网站 → ③ 拖出它在自律时间内的生效范围。 打开开关后，':
      '① Create a rule → ② add apps/sites → ③ paint when it applies. Once the switch is on,',
    '☾ 深色': '☾ Dark',
    '。 专注每分钟 +1 分，解锁单价 15 分/分钟、当天第 n 次 ×1.4。':
      '. 1 focus minute = +1 pt; unlocking costs 15 pt/min, ×1.4 per unlock that day.',
    '「自律时段」决定什么时候进入自律时间': 'Hours decide when discipline runs',
    '「跟随系统」会实时响应 Windows 的浅色 / 深色切换，不用重启。':
      'System follows the Windows light/dark setting live, no restart needed.',
    '一条': 'One',
    '上传，避免动辄几十 MB 的日文件把网盘撑爆。':
      'uploaded, so multi-megabyte daily files never bloat your drive.',
    '上；否则记到': '; otherwise it goes to',
    '不在自律时间': 'Outside discipline hours',
    '不论开关，': 'Regardless of the switch,',
    '且没有': 'and no',
    '也行）。': 'works too).',
    '云端备份走你自己的 WebDAV：上传后可以列出所有历史版本，任选一份恢复。 「立即同步」只同步自律规则和设置，不做版本归档。':
      'Cloud backups use your own WebDAV: every version is listed and restorable. Sync now only syncs rules and settings.',
    '先把手上的这一段做完。': 'Finish what is in your hands first.',
    '全在软件目录的': 'all live under',
    '关掉则点击会穿透到被遮罩的窗口，方便临时操作，但点到别的应用会让它变成前台， 遮罩会跟着换目标。':
      'Off lets clicks pass through to the covered window; clicking another app makes it the target.',
    '关掉后，自律时段只负责"进入自律状态"（遮罩 / HUD / 积分 / 成绩），自律规则完全不拦。':
      'Off: hours only switch discipline on (mask, HUD, points, stats); rules never block.',
    '关闭失败': 'Close failed',
    '内的前台使用时长，与"未开启"的数据完全隔离。':
      ' foreground time, kept fully separate from discipline-off data.',
    '单击': 'Click',
    '只作用于「工作日强化」这套：之后新框选 / 单击选中的时段都沿用这套时长；右键菜单里改也能顺手更新它':
      'Applies to Weekday focus only: new selections reuse this rhythm; the context menu updates it too.',
    '只在自律时间（专注段）内生效': 'Only during focus windows',
    '只有自律时间内': 'Only during hours',
    '右键格子': 'Right-click a cell',
    '同步到你自己的网盘（坚果云 / Nextcloud / 群晖 / 阿里云盘 WebDAV 等）。 统计原始数据':
      'Synced to your own drive (Nutstore, Nextcloud, Synology, Aliyun WebDAV). Raw stats',
    '在 Chrome / Edge 的扩展页打开"开发者模式"，载入已解压的扩展':
      'Enable Developer mode in Chrome/Edge and load the unpacked extension',
    '在扩展管理页点「加载已解压的扩展程序」，把上面这个路径粘到地址栏回车后选中该文件夹即可。':
      'Click Load unpacked in the extensions page, paste the path above and select the folder.',
    '存储方式：': 'Storage: ',
    '存在软件目录下的': 'stored under',
    '它和「自律规则」的关系': 'How it relates to rules',
    '它才会拦；自律时间之外完全静默。': 'it blocks; outside hours it stays silent.',
    '安装引导': 'Setup guide',
    '安装插件': 'Install extension',
    '已开启 · 自律模式接管中': 'On · discipline in control',
    '开启后，点遮罩空白区域没有任何反应，也不会把别的窗口切到前台——专心时最稳。':
      'On: clicks on the mask do nothing and never bring another window forward.',
    '开：命中自律规则网页先弹通知，然后把整个浏览器窗口关掉；关：只关掉那一个标签页':
      'On: notify first, then close the whole browser; Off: close only that tab.',
    '当前不在自律时间': 'Outside discipline hours',
    '慢一点没关系，方向对就行。': 'Slow is fine, as long as the direction is right.',
    '所有功能（拦截、遮罩、统计、报告）都': 'All features (blocking, mask, stats, reports)',
    '手动开关遮罩的另一种方式。自动化请用上方的「跟随自律模式」，不再按应用逐个配置。':
      'Another way to toggle the mask. For automation use Follow discipline mode above.',
    '扩展文件夹': 'Extension folder',
    '扩展页': 'Extensions page',
    '报告在周期结束后的': 'Reports are generated after each period at',
    '拖一下 / 点一下代表多少分钟。改成 10 分钟能排得更细，代价是日历更高、要滚动； 已经排好的时段不会被改动。':
      'How many minutes one drag/click covers. 10 min is finer but makes the calendar taller; existing windows stay untouched.',
    '按下就是一段': 'Press to start a window',
    '换一条（自己写的和联网的都会轮换）': 'Next (rotates your own and online quotes)',
    '推荐用「从运行中的程序添加」，一次点选最省事。': 'From running app is the quickest way.',
    '插件': 'Extension',
    '插件已启用': 'Extension enabled',
    '插件未安装': 'Extension not installed',
    '插件没装或没连上，看侧边栏「浏览器插件」状态。':
      'Extension missing or disconnected — check the Extension page.',
    '播放。只动我们暂停过的， 你自己手动暂停的不会被乱动；归因不到的后台音乐一律不碰。':
      ' playback. Only media we paused is resumed; anything you paused yourself is left alone.',
    '文件夹': 'Folder',
    '新的覆盖旧的': 'Newer overwrites older',
    '时段结束': 'Window ends',
    '时间戳，同步时': 'timestamp; on sync',
    '未找到主程序': 'App not found',
    '本地备份在软件目录下的': 'Local backups live under',
    '检测到': 'Detected',
    '每 15 秒落盘一次，关掉窗口也不会丢。': 'Flushed every 15 s; closing the window loses nothing.',
    /* —— 睡眠管理 —— */
    '睡眠管理': 'Sleep hours',
    '和「自律时段」是两件事：那边管白天什么时候不许玩，这里管夜里这台机器该关着了。':
      'Separate from discipline hours: those govern daytime focus, this governs when the machine should be off.',
    '到了睡眠时段，开机 / 唤醒后会限制所有功能，倒计时结束自动关机；想现在用，只能用积分解锁。':
      'Booting or waking up inside sleep hours locks everything down and shuts down when the countdown ends; points are the only way to use it now.',
    '睡眠时段': 'Sleep window',
    /* —— 多段睡眠 + 生效周期 —— */
    '睡眠到点后会锁定、会关机，但': 'Sleep hours lock the screen and shut down, but they never',
    '替你开机——软件叫不醒一台关着的电脑（那要在 BIOS 里设定时开机）。':
      'power the machine on — software cannot wake a powered-off PC (set an RTC alarm in the BIOS for that).',
    '想在自律时自动开好工作窗口，用「自律规则 → 自动打开」：那里会在每个专注段开始时把软件 / 网页摆好。':
      'To have work windows ready during focus time, use Rules → Auto-open: it arranges apps / pages at the start of every focus block.',    '现在不在任何睡眠时段内': 'Not inside any sleep window right now',
    '生效周期': 'Repeat',
    /* —— 进入自律时间自动打开 —— */
    '自动打开': 'Auto-open',
    '进入自律时间时自动打开': 'Open on entering focus time',
    '每到': 'At the start of',
    '一个专注段的开始': 'every focus block',
    '（含番茄休息结束回到专注）就对齐一次：': ' (including after a pomodoro break):',
    '已经开着的窗口直接切到最上层，没开的才启动；软件启动时正好在自律时间里，也会立刻对齐。':
      'Windows already open are brought to the front; only missing ones are launched. If the app starts while inside focus time, it aligns immediately.',
    '软件': 'App',
    '网页': 'Web page',
    '窗口化': 'Windowed',
    '最大化': 'Maximized',
    '最小化': 'Minimized',
    '参数': 'Args',
    '浏览器（可空）': 'Browser (optional)',
    '＋ 添加一项': '+ Add item',
    '序号就是桌面上的从左到右顺序；窗口形式支持窗口化 / 最大化 / 最小化。':
      'The number is the left-to-right order on screen; window mode supports windowed / maximized / minimized.',
    '网页的「已打开就切过去」靠窗口标题里的域名判断，属于尽力而为；判不出来会新开一个标签页。':
      'For web pages, "switch to it if already open" matches the domain in the window title — best effort; otherwise a new tab opens.',
    '最多 12 项；网页必须是 http(s) 地址': 'Up to 12 items; web addresses must be http(s)',
    '还没有目标。点下面的「＋ 添加一项」，可以加软件，也可以加网页。':
      'Nothing yet. Use "+ Add item" to add an app or a web page.',
    '可以有多段：比如午睡 13:00–14:00 只关机不锁屏，夜间 23:00–07:00 才全屏锁定。点「＋ 添加时段」就多一段。':
      'Multiple windows are allowed: a 13:00–14:00 nap that only shuts down, plus 23:00–07:00 that also locks the screen.',
    '每段都能单独设「生效周期」：每天、仅工作日、指定星期几。':
      'Each window has its own Repeat: every day, workdays only, or specific days.',
    '每天适合固定作息；仅工作日适合周末晚睡晚起；指定适合「只在周日晚上早睡」这类安排。':
      'Every day suits a fixed routine; workdays only suits later weekends; pick-days suits something like "early sleep on Sunday only".',
    '切周期只改「哪几天生效」，时间、锁屏、开机后多久关机都不会被改动。':
      'Switching the repeat only changes which days apply — times, locking and the countdown stay untouched.',
    '每段还有自己的「睡眠结束后自动启动」：默认关闭，打开后按清单打开软件 / 网页，睡眠结束后自动拉起。':
      'Each window also has its own "launch after sleep": off by default; once on it opens the listed apps / pages when that window ends.',
    '每天': 'Every day',
    '仅工作日': 'Workdays only',
    '指定': 'Pick days',
    '＋ 添加时段': '+ Add window',
    '判定只看当前时刻是否落在任一段睡眠时段内，与自律时段、自律规则完全独立。':
      'Only the current time decides, across any sleep window; independent of discipline hours and rules.',
    '共 ': 'Total ',
    ' 段睡眠': ' sleep windows',
    '编辑中': 'Editing',
    '编辑': 'Edit',
    '锁屏': 'Lock',
    '关机': 'Shut down',
    '不锁': 'No lock',
    '不关': 'No shutdown',
    '至少保留一段；完全不想管就把右上角的开关关掉':
      'Keep at least one window; switch off the toggle at the top right if you want none at all.',
    '至少要选一天；想每天都生效请切到「每天」':
      'Pick at least one day; use "Every day" if it should always apply.',
    '最多 8 段睡眠，先删掉一段': 'At most 8 sleep windows; remove one first.',
    '积分解锁': 'Points unlock',
    '至': 'to',
    '（结束填 00:00 = 到次日 0 点，例如 23:00 – 00:00）': '(end 00:00 = next midnight, e.g. 23:00 – 00:00)',
    '开机后': 'After boot',
    '分钟内自动关机': 'min until shutdown',
    '分 / 分钟，一次买': 'pts / min, buy',
    '分钟': 'min',
    '到点关机': 'Shutdown',
    '真的执行关机（关掉 = 只锁定、不关机）': 'Really shut down (off = lock only)',
    '限制功能': 'Lock down',
    '睡眠时段内全屏锁定（关掉就只剩倒计时关机）': 'Full-screen lock during sleep hours (off = countdown only)',
    '保存睡眠设置': 'Save sleep settings',
    '判定只看当前时刻是否在睡眠时段内，与自律时段、自律规则完全独立。':
      'Only the current time decides; independent of discipline hours and rules.',
    '关机指令发出后 30 秒内仍可用积分解锁撤回；解锁到期后如果还在时段内，会重新开始倒计时。':
      'Points can still cancel the shutdown within 30 s; once an unlock expires inside the window the countdown restarts.',
    '（价格填 0 = 这段睡眠不许用积分解锁）': '(0 = points unlock disabled)',
    '未启用：睡眠时段内开机不会被限制': 'Off: booting during sleep hours is not restricted',
    '在睡眠时段内（未锁定：请检查「锁定屏幕」开关或测试模式）':
      'Inside sleep hours (not locked: check the lock toggle or test mode)',
    '现在是睡眠时间': 'It is sleep time',
    '这台电脑该关着了。睡眠时段内的一切功能都被限制。': 'This machine should be off. Everything is locked during sleep hours.',
    '后自动关机': 'until shutdown',
    '（只锁定，不关机）': '(lock only, no shutdown)',
    '这段睡眠没有开启积分解锁': 'Points unlock is disabled',
    '积分不够': 'Not enough points',
    '解锁到期后如果还在睡眠时段内，会自动重新锁定。': 'When the unlock expires inside the window it locks again automatically.',
    '显示范围': 'Shown range',
    '从': 'From',
    '到': 'To',
    '全天': 'Full day',
    '睡眠时段已用积分解锁至': 'Sleep hours unlocked until',
    /* —— 积分 / 帮助 / 关于（右键语义、睡眠、显示范围）—— */
    '专注 1 分钟 = 1 分。': '1 focus minute = 1 point.',
    '积分只用来解开正在生效的那一段时间：自律时段按分钟买，睡眠时段按整段买断。':
      'Points only unlock the window running right now: discipline hours by the minute, sleep hours as a fixed block.',
    '都只影响当下这一轮，不会改排班，也不会连带别的时段。':
      'Both affect only the current round; your schedule and other windows stay untouched.',
    '分/分钟': 'pts/min',
    '未开启': 'Off',
    '在「自律时段 → 睡眠管理」里开启': 'Enable it under Hours → Sleep hours',
    '4 · 生效时间段：右键改哪里，就只改哪里': '4 · Right-click edits exactly what you clicked',
    '完整图表里有三种右键目标，每张菜单顶部都写着"作用于 …"，三档互不越界。':
      'The full chart has three right-click targets; every menu states "Applies to …" and never crosses levels.',
    '右键日期表头（周一 / 周二…）= 整天：弹出来第一眼就是这一天排了什么（每段的起止、时长、节奏，可逐段取消），下面才是「选中整天」「清空整天」这类整天级操作，只作用于这一天 0:00–24:00。':
      'Right-click a day header: the first thing you see is what is already scheduled that day (start/end, length, rhythm, removable one by one), then the whole-day actions — 0:00–24:00 that day only.',
    '图表右上角的「完整展示」开关：开着时整张表一次铺满、不用滚动；关掉回到固定行高，可以滚着看细节。':
      'The "Fit all" switch at the top-right of the chart: on = the whole grid fits at once; off = fixed row height with scrolling.',
    '右键某一段 = 时段：只作用于这一段（段首到段尾，跨小时也完整），可改时长、起止分钟，或「取消这一段」（两步确认）。':
      'Right-click a window: that window only (start to end, whole hours included) — change rhythm, start/end minutes, or remove it.',
    '右键空白格 = 格子：只作用于这一小时，把它选上并设定起止分钟。':
      'Right-click an empty cell: that hour only — select it and set its start/end minutes.',
    '按住某一段的上边缘或下边缘（5px 内，光标变成上下箭头）可以拉长或缩短它；最短一格，最长到显示范围的尽头。':
      'Drag the top or bottom edge (within 5px, cursor turns into a vertical arrow) to lengthen or shorten it; minimum one slot, maximum the whole visible range.',
    '一句话：点得越具体，作用范围越小——不会出现"右键一段、却把一整天重排"的情况。':
      'In short: the more specific the click, the smaller the scope — no more "right-clicked one window, re-arranged the whole day".',
    '拖选是"从起点到终点的一段连续区间"，松手即提交；贴着 0:00 / 24:00 的段只属于当天，不会牵连相邻那天。':
      'Dragging selects one continuous span and commits on release; windows touching 0:00 / 24:00 belong to that day alone.',
    '图表顶部还能设「显示范围」：只看 07:00–23:00 也行，只影响显示，范围外的时段照样生效。':
      'The chart can show a sub-range too (e.g. 07:00–23:00); display only — windows outside still apply.',
    '5 · 睡眠管理': '5 · Sleep hours',
    '和自律时段是两件事：那边管"白天什么时候不许玩"，这里管"夜里这台机器该关着了"。':
      'Separate from discipline hours: those govern daytime play, this governs when the machine should be off.',
    '到了睡眠时段，开机 / 唤醒后会全屏锁定、限制所有功能，倒计时（默认 10 分钟，可改）结束自动关机。':
      'Inside sleep hours, booting or waking up locks the screen and limits everything; a countdown (10 min by default) ends in a shutdown.',
    '锁定期内设置改不了、程序也退不掉。想现在用，只能用积分解锁买断一段时间（价格在卡片里配）。':
      'While locked, settings cannot change and the app cannot quit; points are the only way to buy time (price is set in the card).',
    '前提是程序在运行；睡眠时段之外它什么都不做。':
      'It only works while the app is running, and does nothing outside the window.',
    '「固化」打开后，生效期间不能退出程序、不能改任何设置，任务管理器会被自动关掉；进程被杀掉会被守护进程在 2 秒内拉回来。':
      'With hard lock on you cannot quit or change settings while it is active; Task Manager is closed and a guard restarts the app within 2 s if killed.',
    '解除只有两条路：时段结束，或者用积分解锁。':
      'Only two ways out: the window ends, or you unlock it with points.',
    '专注每分钟 +1 分；自律时段按分钟买（15 分/分钟起，当天第 n 次 ×1.4）。':
      '+1 point per focus minute; discipline hours are bought per minute (from 15 pts/min, ×1.4 for the n-th unlock of the day).',
    '睡眠时段按段买断（单价 × 分钟数，各自在卡片里配）。':
      'Sleep hours are bought as a block (price × minutes, configured in the card).',
    '固化只在自律时间内生效，且自律时段本身的结束时间就是最晚解封时刻，不会把自己永久锁死。':
      'Hard lock only applies during hours and never outlives the window itself.',
    '选一个目标窗口，其余区域被遮罩盖住；不透明度 20%–100% 实时可调，没有任何动画，开关是瞬时到位。':
      'Pick a target window and everything else is covered; opacity 20%–100% is live and there is no animation — toggling is instant.',
    '两种开启方式：全局快捷键（默认 Ctrl+Alt+K，可在遮罩页改，被占用会报错），或者「跟随自律模式」——自律一开始自动开、结束自动关。':
      'Two ways to turn it on: the global hotkey (Ctrl+Alt+K by default, editable on the mask page) or "follow discipline mode" — on when discipline starts, off when it ends.',
    '右键怎么只改了一段？': 'Why did right-click change only one window?',
    '这是设计：段右键只管那一段；要改整天请右键日期表头。':
      'By design: a window menu touches only that window; right-click the day header for the whole day.',
    '用「总览 → 积分兑换」解锁当前这一段（固化了才需要）。':
      'Use Overview → Points to unlock the current window (only needed under hard lock).',
    '右键怎么用、积分怎么算、睡眠时段怎么生效，都在这里':
      'How right-click works, how points are priced, how sleep hours behave',
    '这个版本改了什么': 'What changed in this version',
    '只列会改变你手感的几条，细节看「帮助」。': 'Only the changes you can feel; see Help for details.',
    '修复': 'Fixes',
    '跨天拖动不再在中间那天多出幽灵时段（02:10–03:10 拖走就是拖走）':
      'Cross-day drags no longer leave ghost windows on days you merely passed',
    '交互': 'Interaction',
    '右键分三档：表头 = 整天、段 = 只这一段、空白格 = 这一格':
      'Right-click has three levels: day header = whole day, window = that window, empty cell = that cell',
    '图表显示范围；睡眠时段（锁定 + 倒计时关机 + 积分解锁）':
      'Chart display range; sleep hours (lock + countdown shutdown + points unlock)',
    /* —— 语录来源 —— */
    '卡片里还有「睡眠结束后自动启动」：默认关闭，打开后可以按星期配一组要打开的软件 / 网页，睡眠结束后自动拉起。':
      'The card also has "Launch after sleep": off by default; once on you can list apps / pages (optionally per weekday) to open when sleep hours end.',
    '软件名': 'app name',
    '页面标题': 'page title',    '统计页显示的是': 'The stats page shows the',
    '（取自程序版本信息）和': '(read from the exe version info) and the',
    '，同一个网址下的多个页面会按网址归并成一行。': '; pages under the same domain are merged into one row.',    '睡眠结束后自动启动': 'Launch after sleep',
    '睡眠时段结束后，等系统真的恢复过来，按下面的清单打开软件 / 网页。':
      'When sleep hours end and the system is really back, open the apps / pages listed below.',
    '默认关闭；每一轮只跑一次，重复启动会被拦掉。':
      'Off by default; each round runs once — repeated launches are suppressed.',
    '恢复后等待': 'Wait after resume',
    '秒再启动': 's before launch',
    '叫醒系统': 'Wake the system',
    '到点把电脑从睡眠里叫醒（需要管理员权限；失败也不影响你已经醒着的场景）':
      'Wake the machine from sleep at that moment (needs admin; if it fails, the already-awake case still works)',
    '软件': 'App',
    '网页': 'Web',
    '启动参数（可空）': 'Arguments (optional)',
    '＋ 添加一项': '+ Add an item',
    '星期不选 = 每天；软件请填 exe 全路径。': 'Leave weekdays empty for every day; use the full exe path for apps.',
    '删除没保存成功': 'Delete was not saved',
    '开关没保存成功': 'The switch was not saved',
        '完整展示': 'Fit all',
    '开': 'On',
    '关': 'Off',
    '一次铺满，不用滚动': 'Fits at once, no scrolling',
    '固定行高，可滚动': 'Fixed rows, scrollable',
    '每日时长': 'Daily total',
    '已排时段': 'Scheduled windows',
    '取消这段': 'Remove this',
    '再点一次确认': 'Click again to confirm',
    '整小时': 'Whole hour',
    '只选': 'Select only',
    '分钟': 'min',
    '这一天还没有任何自律时段。可以点下面的「选中整天」，也可以在图上按住拖动来新建。':
      'No windows on this day yet. Use "Select whole day" below, or drag on the chart to create one.',
    '从': 'From',
    '到': 'to',
    '现在每格': 'Each cell is',
    '一小时': 'per hour',
        '右键可换来源': 'Right-click to switch source',
    '换一条': 'Another one',
    '正在获取…': 'Fetching…',
    '我的语录': 'My quotes',
    '内置精选': 'Curated picks',
    '一言 · 励志': 'Hitokoto · Motivation',
    '一言 · 诗词': 'Hitokoto · Poetry',
    '离线 · 本地精选': 'Offline · curated',
    '来源': 'Source',
    '语录来源': 'Quote sources',
    '用它': 'Use this',
    '当前': 'Current',
    '使用中': 'In use',
    '内置': 'Built-in',
    '本地': 'Local',
    '联网 · JSON': 'Online · JSON',
    '联网 · 纯文本': 'Online · plain text',
    '添加自定义来源': 'Add a custom source',
    '名称（显示在语录下方）': 'Name (shown under the quote)',
    '本地预置': 'Local preset',
    '永不联网': 'never online',
    '右键语录随时回到这里': 'Right-click the quote to come back here',
    '关闭': 'Close',
    /* —— 三张右键菜单（帧内文案，弹窗出现时才渲染）—— */
    '时段设置': 'Window settings',
    '格子设置': 'Cell settings',
    '整天设置': 'Whole-day settings',
    '选中整天': 'Select whole day',
    '清空整天': 'Clear whole day',
    '应用到整天': 'Apply to whole day',
    '取消这一段': 'Remove this window',
    '再点一次，确认取消': 'Click again to confirm',
    '应用': 'Apply',
    '作用于 ': 'Applies to ',
    ' 段）': ' windows)',
    ' 段 · ': ' windows · ',
    '一段': 'one window',
    '一整天': 'one whole day',
    '。菜单只改这一段，': '. The menu only edits this window,',
    '不会': 'and never ',
    '动这一天的其它时段，也没有整天级别的选项。': 'touches the rest of the day — there is no whole-day option here.',
    '：只作用于': ': applies to ',
    '，不会牵连相邻那天。': ' only, never the neighbouring day.',
    '起止分钟只改这一段的首 / 尾小时（': 'Start/end minutes only touch the first / last hour of this window (',
    ' 与 ': ' and ',
    ' 那两格），中间小时保持整点。': '), the hours in between stay on the hour.',
    '同时设为通用时长（之后新选的时段沿用）': 'Also save as the default rhythm',
    '休息期间不拦截、不遮罩；排不满 60 分钟的尾段算继续专注。':
      'Breaks are never blocked or masked; a short tail counts as more focus.',
    '这一格是': 'This cell is ',
    '空白的': 'empty',
    '）没选中）。应用会把它选上；只想改别的范围请在图上拖一段，再右键那一段。':
      '). Applying selects it; to edit a range, drag it on the chart first.',
    '起止分钟只对': 'Start/end minutes apply to ',
    '这一格': 'this cell',
    '生效：0 和 60 就是整小时（例如 8:15–8:45）。': ' only: 0 and 60 mean the whole hour (e.g. 8:15–8:45).',
    '想改一整段？右键那一段。想改一整天？右键顶部日期表头。':
      'Want a whole window? Right-click it. A whole day? Right-click the day header.',
    '这是': 'This is ',
    '，其余六天原样不动。': '; the other six days stay untouched.',
    '想改某一段的起止分钟，请直接在图上右键那一段。':
      'To change start/end minutes of one window, right-click that window on the chart.',
    '「应用到整天」只改': '"Apply to whole day" only changes ',
    '，不会动已有时段的起止分钟（例如 02:10–03:10 仍然是 02:10 开始）。要让整天变成整点，用「选中整天」重排。':
      ', leaving existing start/end minutes alone (02:10–03:10 still starts at 02:10). To snap the day to whole hours, use "Select whole day".',
    '专注 ': 'Focus ',
    '休息 ': 'Break ',
    ' 分': ' min',
    '每 N 天生成一次，从锚点日算起，报告覆盖上一个完整 N 天':
      'Every N days from the anchor date, covering the previous N full days',
    '每个「自律周期」和每段「休息」结束前各提醒一次：主界面弹提示，HUD 上对应的倒计时会变金色闪烁。':
      'One reminder before each focus window and each break ends; the HUD countdown turns gold.',
    '每日时长': 'Daily time',
    '每次选择': 'Per selection',
    '没找到主程序，点这里手动指定 .exe': 'App not found — click to pick the .exe manually',
    '注意：固化只在自律时间内生效，且自律时段本身的结束时间就是最晚解封时刻，不会把自己永久锁死。':
      'Note: hard lock only applies during hours and never outlives the window itself.',
    '浏览器守护': 'Browser guard',
    '浏览器插件还没就绪': 'Extension not ready',
    '浏览器插件：未连接': 'Extension: not connected',
    '点了安装之后': 'After clicking Install',
    '生效中的自律规则': 'Active rules',
    '生效前提是自律时间': 'Requires discipline hours',
    '目录已就绪': 'Folder ready',
    '目标程序是管理员权限，就右键以管理员身份运行本程序。':
      'If the target runs elevated, run this app as administrator too.',
    '真实生效': 'Actually enforce',
    '程序': 'App',
    // 被模板切开的单位与虚词（各自是独立文本节点，不会误伤整句）
    '分': 'min',
    '时': 'h',
    '或': 'or',
    '每': 'Every',
    '把': 'Put',
    '立刻结束本程序：先停守护、还原被暂停的媒体、销毁遮罩并落盘统计，不弹确认框。快捷键':
      'Quits immediately: stops the guard, resumes paused media, destroys the mask and saves stats — no confirmation. Hotkey',
    '自律时段是总开关，自律规则是执法工具。': 'Hours are the master switch; rules do the enforcing.',
    '自律时段生效期间，专注遮罩如果开了「跟随自律模式」就会跟着自动打开，此时主开关显示为接管、不能手动切。':
      'While hours run, a mask set to follow discipline opens automatically and the switch shows as taken over.',
    '自律时段自动出现，结束后自动隐藏': 'Appears during hours, hides afterwards',
    '自律时段里打开它们会被自动关闭——先把插件装上或启用，才不会被拦。':
      'Opening them during hours closes them — install or enable the extension first.',
    '自律时间': 'Discipline hours',
    '自律时间内启用自律规则': 'Enforce rules during hours',
    '自律时间里，名单里的软件 / 网站会被拦下，其余放行':
      'During hours, listed apps/sites are blocked; the rest pass',
    '自律时间（自律规则正在生效）里，只要你打开浏览器而插件没装或被停用，会在':
      'During hours, if you open a browser while the extension is missing or disabled, it will be',
    '自律期间禁止打开任务管理器': 'Block Task Manager during hours',
    '自律模式一开始，遮罩自动打开；自律模式一结束，遮罩自动关闭。 组合条件只有一条：':
      'The mask opens with discipline and closes with it. The only condition is:',
    '自律模式已开启': 'Discipline is on',
    '自律模式接管中，不能手动切换': 'Discipline is in control; cannot switch manually',
    '自律模式未开启': 'Discipline is off',
    '自律模式正在生效，遮罩由它自动接管：自律结束时遮罩会自己关掉。':
      'Discipline is active and controls the mask; it closes automatically when discipline ends.',
    '自律模式生效时间段': 'Discipline hours',
    '自律模式生效时（自律时段专注段 / 自律规则生效中），一发现任务管理器就关掉；「固化」锁定期间无论如何都会关':
      'Closes Task Manager whenever discipline is active; always closed while hard-locked.',
    '自律规则与设置': 'Rules & settings',
    '自律规则开了「固化」时更严：固化锁定期间即使这里开着，也退不掉。':
      'Hard lock is stricter: while locked, quitting is refused even if this is on.',
    '自律规则里的软件与网页已被拦住：': 'The following are blocked by your rules:',
    '自查': 'Self-check',
    '被盖住（非前台/非呈现）窗口的媒体播放； 窗口回到前台、或遮罩关闭时':
      'media playing in covered windows; resumed when the window returns or the mask closes',
    '要拦网页时，如果插件失联，直接关掉浏览器（需先装插件）':
      'If the extension is unreachable when a site should be blocked, close the browser.',
    '解锁期间所有拦截暂停，倒计时结束自动恢复':
      'All blocking pauses during an unlock and resumes when it ends.',
    '设置路径': 'Settings path',
    '距状态变化': 'since change',
    '还没有添加软件。': 'No apps added yet.',
    '这些设置对所有自律规则生效。': 'These apply to every rule.',
    '这段时间主开关不能手动切': 'The master switch is locked during this window',
    '这里': 'here',
    '这里的句子会和联网取到的「一言」一起在 Hub 顶部轮换，每条下面都会标明来源。':
      'These rotate at the top of the Hub together with online quotes; each shows its source.',
    '这里（自律时段）': 'here (Hours)',
    '进入测试模式': 'Enter test mode',
    '遮罩生效时，自动': 'While the mask is on, automatically',
    '预览效果（5 秒）': 'Preview (5 s)',
    '（一份报告一个 JSON，含两种状态各自的扇区数据）。 默认保留':
      '(one JSON per report with slices for both states). Kept for',
    '（一天一个 JSON，按小时分桶）；报告存': '(one JSON per day, bucketed by hour); reports go to',
    '（只有名单里的能开，其他前台窗口都会被关）、':
      '(only listed apps may run; other foreground windows get closed), ',
    '（名单里的不许开）、': '(listed items are not allowed), ',
    '（名单里的照样拦，例外里的放行）。': '(listed items are still blocked; exceptions pass).',
    '（程序没开着的话，下次启动会补齐）。 生成的报告不会自动删除，除非超过「数据保留天数」。':
      '(catch-up on next launch). Reports are never deleted unless older than the retention limit.',
    '（窗口在前台时': '(while the window is in front',
    '（自律时段的专注段）内生效，其余时间一律静默。':
      '(focus windows of your hours); silent otherwise.',
    '， 今天第 n 次解锁单价 ×1.4（第 1 次 15，第 2 次 21，第 3 次 29）。':
      ', and ×1.4 per unlock that day (15, then 21, then 29).',
    '， 像 lazytyper 那种小横条会被一次性盖住，不再来回闪。 同时也能拦住以管理员运行的程序。':
      ', so floating bars like lazytyper are covered once and stop flickering. Elevated apps are covered too.',
    '， 在': ', in',
    '， 这里只决定"自律时间里不能打开什么"。':
      '; this only decides what cannot open during hours.',
    '，其余时间一律静默。': '; silent otherwise.',
    '，写盘前加密（设了密码用 AES-256-GCM， 没设密码用本机 DPAPI）。只保留最近 10 份、7 天内的，超出自动删。':
      ', encrypted before writing (AES-256-GCM with a password, DPAPI without). Only the latest 10 within 7 days are kept.',
    '，写盘前就加密：设了密码用 AES-256-GCM（可跨机恢复）， 没设密码用本机 Windows DPAPI。只保留最近 10 份、且 7 天内的。':
      ', encrypted before writing: AES-256-GCM with a password (restorable elsewhere) or Windows DPAPI without. Only the latest 10 within 7 days are kept.',
    '，只留它可见、其他全压暗。 切换窗口时洞口平滑移过去，拖动 / 缩放时 1:1 完全跟手。':
      ', leaving it visible and dimming the rest. The hole follows switches and tracks drags 1:1.',
    '，可在设置里调整。报告可以随时点开回看，也可以手动删除。':
      ', adjustable in Settings. Reports can be opened or deleted anytime.',
    '，可在遮罩页改，被占用会报错）； 或者「进入指定应用自动开启」——切到这些应用就自己盖、切走自动关。':
      ', editable on the mask page) or start automatically for specific apps.',
    '，唯一区别是自律模式可以随时开关。 配置与统计写在独立目录，退出时可选「保留」或「丢弃」，都不会污染正式数据。':
      '; the only difference is discipline can be toggled freely. Config and stats go to a separate folder.',
    '，整个文件夹拷走就能迁移。': '; copy the whole folder to migrate.',
    '：Chrome、Edge、Brave、Vivaldi、Opera、Chromium、360 极速、QQ 浏览器、搜狗高速 （这些都能装本插件）；Firefox 会被识别出来，但它不支持 Chromium 扩展，所以只显示、不参与拦截。':
      ': Chrome, Edge, Brave, Vivaldi, Opera, Chromium, 360, QQ and Sogou all support this extension; Firefox is detected but cannot install it.',
    '：上面「这套时段生效的自律规则」勾了哪几组，这套时段就只管那几组。':
      ': this set only governs the rules ticked above.',
    '：会给 10 分钟保护期，这期间不会因为插件状态去关浏览器，避免你正开着扩展管理页就被关掉。':
      ': a 10-minute grace window prevents closing browsers while you set up the extension.',
    '：先发关闭信号，0.4 秒不退再强制结束；如果仍失败（多半是浏览器以管理员运行、而本程序不是）， 会记一条「关闭失败」，每 60 秒重试一次，并提示你以管理员身份运行。':
      ': asks the browser to close, force-kills after 0.4 s; if it still fails it logs Close failed, retries every 60 s and suggests running as admin.',
    '：决定"什么时候进入自律时间"。按周排、每周重复，每格 15 分钟。':
      ': decides when discipline runs. Weekly, repeating, 15 minutes per cell.',
    '：只有「自律时段」正在专注时才可能拦人；': ': only blocks while a focus window is running;',
    '：只有名单，没有自己的时间表。它': ': just a list, no schedule of its own. It',
    '：启动时全量扫一次；之后后台每 20 秒刷新一次缓存；打开本页或点「重新检测」立即扫。 自律时段里每个轮询周期（默认 1 秒）都会用最新缓存判定一次。':
      ': full scan at startup, cache refreshed every 20 s, immediate rescan here. Re-evaluated every polling cycle (1 s).',
    '：按住后立刻选中一格（15 分钟），不松手上下滑就能伸缩， 经过的时间自动并入同一段；拖动中显示起止时间与总时长，到 0 点 / 24 点会提示。':
      ': press to select one cell (15 min), keep holding and drag to extend; limits at 0:00 / 24:00.',
    '：自律时间之外的时段、以及番茄休息段，自律规则都不拦。':
      ': rules never block outside hours or during breaks.',
    '；否则只在画出来的格子里生效。 时间表按周循环，下周自动重复；要让每天一样，就在「时间表」里点「周一 → 全部」。 每条自律规则都有明确的':
      '; otherwise only painted cells apply. The schedule repeats weekly; use Mon → All to copy a day. Every rule carries a clear'
  };
  Object.keys(EXTRA).forEach(function (k) { EN[k] = EXTRA[k]; });

  /* ---------- 正则规则：带数字 / 时间的句子 ---------- */
  var WD = { '一': 'Mon', '二': 'Tue', '三': 'Wed', '四': 'Thu', '五': 'Fri', '六': 'Sat', '日': 'Sun' };
  function wd(s) { return WD[s] || s; }

  /** 「本小时 / 3 小时后 / 2 天后」这类相对时间 */
  function whenText(s) {
    if (s === '本小时') return 'this hour';
    var m0 = /^(\d+) 小时后$/.exec(s);
    if (m0) return 'in ' + m0[1] + ' h';
    var m1 = /^(\d+) 天后$/.exec(s);
    if (m1) return 'in ' + m1[1] + ' d';
    return s;
  }

  var RULES = [
    /* —— 统计页的动态文案 —— */
    [/^使用时段 · 共 (\d+) 段（列出 (\d+) 段）$/, 'Time ranges · $1 total (listing $2)'],
    [/^使用时段 · 共 (\d+) 段$/, 'Time ranges · $1 total'],
    [/^这一块含 (\d+) 项：(.+)$/, 'This slice covers $1 items: $2'],
    /* —— 自动打开 —— */
    [/^规则「(.+)」$/, 'Rule "$1"'],
    [/^ · 自动打开 (\d+) 项$/, ' · auto-opens $1'],
    /* —— 多段睡眠的动态文案 —— */
    [/^共 (\d+) 段睡眠$/, '$1 sleep windows'],
    [/^正在编辑第 (\d+) 段 · (.+)$/, 'Editing window $1 · $2'],
    [/^周[一二三四五六日](、周[一二三四五六日])*$/,
      function (m) {
        var WD = { '一': 'Mon', '二': 'Tue', '三': 'Wed', '四': 'Thu', '五': 'Fri', '六': 'Sat', '日': 'Sun' };
        return m.replace(/周([一二三四五六日])/g, function (_, d) { return WD[d] || d; }).replace(/、/g, ', ');
      }],
    /* —— 语录 —— */
    [/^来源 · 一言 · 励志$/, 'Source · Hitokoto · Motivation'],
    [/^来源 · 一言 · 诗词$/, 'Source · Hitokoto · Poetry'],
    [/^来源 · 内置精选$/, 'Source · Curated picks'],
    [/^来源 · (.+)$/, 'Source · $1'],
    [/^正在获取…$/, 'Fetching…'],
    /* —— 积分 / 关于 里的动态文案 —— */
    [/^今天第 n 次 ×1\.4（第 1 次 (\d+)，第 2 次 (\d+)，第 3 次 (\d+)）$/,
      'n-th unlock ×1.4 today (1st $1, 2nd $2, 3rd $3)'],
    [/^剩余额度 (.+)$/, 'Remaining quota $1'],
    /* —— 睡眠管理 —— */
    [/^锁定中 · (\d+) 分 (\d+) 秒后自动关机$/, 'Locked · shuts down in $1 min $2 s'],
    [/^锁定中 · 只锁屏，不关机（([0-9]{2}:[0-9]{2}) – ([0-9]{2}:[0-9]{2})）$/, 'Locked · no shutdown ($1 – $2)'],
    [/^已用积分解锁至 ([0-9]{2}:[0-9]{2})，到点后重新锁定$/, 'Unlocked with points until $1, then locks again'],
    [/^现在不在睡眠时段，下次锁定 ([0-9]{2}:[0-9]{2})$/, 'Not in sleep hours · next lock at $1'],
    [/^用 (\d+) 积分解锁 (\d+) 分钟$/, 'Unlock $2 min for $1 pts'],
    [/^积分余额 (\d+)$/, 'Balance $1 pts'],
    [/^现在只看 ([0-9]{2}:[0-9]{2}) – ([0-9]{2}:[0-9]{2})：只影响显示，范围外的时段照样生效（另有 (\d+) 段在范围外）。$/,
      'Showing $1 – $2 only; display-only, windows outside still apply ($3 outside).'],
    [/^现在只看 ([0-9]{2}:[0-9]{2}) – ([0-9]{2}:[0-9]{2})：只影响显示，范围外的时段照样生效。$/,
      'Showing $1 – $2 only; display-only, windows outside still apply.'],
    // 时段格子标题（7 天 × 24 小时，最占量的一条）
    [/^周(.) (\d\d:\d\d) – (\d\d:\d\d)（未选中，拖动或右键可设置）$/,
      function (m, p1, p2, p3) { return wd(p1) + ' ' + p2 + ' – ' + p3 + ' (empty; drag or right-click)'; }],
    // 悬停在已选格子上：比旧版多一句「本段 08:00–12:00（共 4 小时）」
    [/^周(.) (\d\d:\d\d) – (\d\d:\d\d) · 本段 (\d\d:\d\d)–(\d\d:\d\d)（共 (.+)） · 专注 (\d+) 分 \/ 休息 (\d+) 分，右键可改$/,
      function (m, p1, p2, p3, s1, s2, dur, p4, p5) {
        return wd(p1) + ' ' + p2 + ' – ' + p3 + ' · window ' + s1 + '–' + s2 + ' (' + dur
          + ') · focus ' + p4 + ' / break ' + p5 + ' min, right-click to edit';
      }],
    [/^周(.) (\d\d:\d\d) – (\d\d:\d\d) · 专注 (\d+) 分 \/ 休息 (\d+) 分，右键可改$/,
      function (m, p1, p2, p3, p4, p5) { return wd(p1) + ' ' + p2 + ' – ' + p3 + ' · focus ' + p4 + ' / break ' + p5 + ' min, right-click to edit'; }],
    [/^周(.) 共 (\d+) 小时（(.+)）$/, function (m, p1, p2, p3) { return wd(p1) + ': ' + p2 + ' h (' + p3 + ')'; }],
    [/^周(.) (\d\d:\d\d)$/, function (m, p1, p2) { return wd(p1) + ' ' + p2; }],

    // 侧栏的动态状态
    [/^第 (\d+) 段$/, 'Window $1'],
    [/^第 (\d+) 段休息中$/, 'Window $1 · break'],

    // 时长与计数
    [/^(\d+) 分钟$/, '$1 min'],
    [/^(\d+) 分$/, '$1 min'],
    [/^(\d+) 小时$/, '$1 h'],
    [/^(\d+) 秒$/, '$1 s'],
    [/^(\d+) 毫秒$/, '$1 ms'],
    [/^(\d+) 天$/, '$1 d'],
    [/^(\d+) 段$/, '$1 windows'],
    [/^(\d+) 份$/, '$1 files'],
    [/^(\d+) 条$/, '$1 entries'],
    [/^(\d+) 次拦截$/, '$1 blocks'],
    [/^(\d+) 个小时段$/, '$1 hours'],
    [/^已选 (\d+) 个小时段$/, '$1 hour(s) selected'],
    [/^合计 (\d+) 秒$/, 'Total $1 s'],
    [/^合计 (\d+) 小时$/, 'Total $1 h'],
    [/^合计 (\d+) 分钟$/, 'Total $1 min'],
    [/^(\d+) 小时 (\d+) 分后$/, 'in $1 h $2 min'],
    [/^(\d+) 分后$/, 'in $1 min'],
    [/^(\d+) 秒后$/, 'in $1 s'],
    [/^(\d+) 个软件 · (\d+) 个网站 · (\d+) 条例外$/, '$1 apps · $2 sites · $3 exceptions'],
    [/^(\d+) 个软件 · (\d+) 个网站$/, '$1 apps · $2 sites'],
    [/^自律时间：(\d+) 个软件 · (\d+) 个网站$/, 'During hours: $1 apps · $2 sites'],
    [/^(\d+) 次$/, '$1 times'],
    [/^(\d+) 份$/, '$1 files'],
    [/^网站 \((\d+)\)$/, 'Sites ($1)'],
    [/^网站例外 \((\d+)\)$/, 'Site exceptions ($1)'],
    [/^软件 \((\d+)\)$/, 'Apps ($1)'],
    [/^例外 \((\d+)\)$/, 'Exceptions ($1)'],
    [/^我的语录 · (\d+)$/, 'My quotes · $1'],
    [/^每周 (\d+) 小时 · (\d+) 段$/, '$1 h / week · $2 windows'],
    [/^每周 (\d+) 小时 (\d+) 分 · (\d+) 段$/, '$1 h $2 min / week · $3 windows'],
    [/^每周 (\d+) 分钟 · (\d+) 段$/, '$1 min / week · $2 windows'],
    [/^专注 (\d+) 分 \/ 休息 (\d+) 分 · 不足 1 轮$/, 'Focus $1 / break $2 min · less than 1 round'],
    [/^专注 (\d+) 分 \/ 休息 (\d+) 分 · 不足 1 轮 · (\d+) 分钟$/, 'Focus $1 / break $2 min · under 1 round · $3 min'],
    [/^专注 (\d+) 分 \/ 休息 (\d+) 分 · 不足 1 轮 · (\d+) 小时$/, 'Focus $1 / break $2 min · under 1 round · $3 h'],
    [/^每一格代表 (\d+) 分钟$/, 'Each cell = $1 min'],
    [/^每格 (\d+) 分钟，一小时 (\d+) 格$/, '$1 min per cell, $2 cells per hour'],
    [/^现在每格 (\d+) 分钟，一小时 (\d+) 格。切到 (\d+) 分钟更细（格子变多、日历变高），已排好的时段不受影响。$/,
      'Each cell is $1 min ($2 per hour). Switching to $3 min is finer — the calendar gets taller, existing windows stay untouched.'],
    [/^专注 (\d+) 分 \/ 休息 (\d+) 分 · (\d+) 个番茄 · (\d+) 小时$/,
      'Focus $1 / break $2 min · $3 pomodoros · $4 h'],
    [/^专注 (\d+) 分 \/ 休息 (\d+) 分$/, 'Focus $1 / break $2 min'],
    [/^专注 (\d+) 分钟 = (\d+) 分。用积分可以强行解锁：当前单价/,
      '1 focus minute = $2 pt. Redeem points to force an unlock; current price'],
    [/^每分钟 \+(\d+) 分 · 今日已解锁 (\d+) 次$/, '+$1 pt/min · unlocked $2× today'],
    [/^(\d+) 分 \/ 分钟$/, '$1 pt / min'],
    [/^(\d+)% 起（再低就看不清了）。松手即保存，改动马上生效。$/,
      'From $1% (below that it is unreadable). Release to save; applies immediately.'],
    [/^(\d+) = 不提醒；范围 (\d+)~(\d+) 分钟$/, '$1 = off; range $2–$3 min'],
    [/^范围 (\d+)~(\d+) 分钟$/, 'Range $1–$2 min'],
    [/^已安装 (\d+) 个浏览器，(\d+) 个插件就绪，(\d+) 个需要处理$/,
      '$1 browser(s) found, $2 extension(s) ready, $3 need attention'],
    [/^有 (\d+) 个浏览器的插件没就绪。$/, '$1 browser(s) have an extension that is not ready.'],
    [/^点「去安装」会打开对应浏览器的扩展管理页，并给你 (\d+) 分钟安装时间（这期间不会关浏览器）。$/,
      'Install opens the browser extension page and gives you $1 minutes (browsers are not closed meanwhile).'],
    [/^每天 (\d+:\d\d) 生成前一天的日报$/, 'Daily report generated at $1'],
    [/^每周(.) (\d+:\d\d) 生成上周（周(.) ~ 周(.)）的周报$/,
      function (m, p1, p2, p3, p4) { return 'Weekly report every ' + wd(p1) + ' at ' + p2 + ' (' + wd(p3) + '–' + wd(p4) + ')'; }],
    [/^每月 (\d+) 日 (\d+:\d\d) 生成上个月的月报$/, 'Monthly report on day $1 at $2'],
    [/^每年 (\d+) 月 (\d+) 日生成上一年的年报$/, 'Yearly report on $1/$2'],
    [/^第一个 (\d+:\d\d) 自动生成$/, 'First auto-generated at $1'],
    [/^每 (\d+) 天生成一次，从锚点日算起，报告覆盖上一个完整 (\d+) 天$/,
      'Every $1 days from the anchor date, covering the previous $2 full days'],
    [/^(\d+) · 三步开始$/, '$1 · Three steps'],
    [/^(\d+) · 自律规则与生效$/, '$1 · Rules and scope'],
    [/^(\d+) · 番茄与提醒$/, '$1 · Pomodoro and reminders'],
    [/^(\d+) · 固化与积分$/, '$1 · Hard lock and points'],
    [/^(\d+) · 专注遮罩$/, '$1 · Focus mask'],
    [/^(\d+) · 统计与报告$/, '$1 · Stats and reports'],
    [/^(\d+) · 备份与云同步$/, '$1 · Backups and sync'],
    [/^(\d+) · 常见问题$/, '$1 · FAQ'],
    [/^(\d+) \/ (\d+)$/, '$1 / $2'],
    [/^(\d+)~(\d+)$/, '$1–$2'],
    [/^(\d+)~(\d+) 分钟$/, '$1–$2 min'],
    [/^(\d+) 天$/, '$1 days'],
    [/^(\d+) 条规则$/, '$1 rules'],
    [/^(\d+) 项$/, '$1 items'],
    [/^(\d+) 分钟前$/, '$1 min ago'],
    [/^(\d+) 小时前$/, '$1 h ago'],
    [/^(\d+) 天前$/, '$1 d ago'],
    [/^(\d+) 秒前$/, '$1 s ago'],
    [/^(\d+) 月 (\d+) 日$/, '$1/$2'],
    [/^(\d+)-(\d+)-(\d+)$/, '$1-$2-$3'],
    [/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/, '$1-$2-$3 $4'],
    [/^(= 开关那 (\d+) 分钟；从已有条上按下 = 取消；)$/, '= toggle that $2-minute cell; press on an existing block = cancel;'],
    [/^挨着哪个角落（边距 (\d+)\/(\d+) 像素）。挑一个不压住主要内容的位置就行； 专注遮罩打开时 HUD 会自动收起，不会盖在遮罩上。$/,
      'Corner offset ($1/$2 px). Pick a spot that does not cover your content; the HUD hides while the mask is on.'],
    [/^拖动即时生效——遮罩开着的时候，你可以直接在屏幕上看到效果。动画速度就是"从窗口边缘铺满全屏"用多久，数值越大越慢，(\d+) = 瞬间出现。$/,
      'Changes apply live while the mask is on. Speed is how long the mask takes to fill the screen; $1 = instant.'],
    [/^提醒在「设置 → 提醒」：学习结束前 X 分钟、休息结束前 Y 分钟各响一次（(\d+)~(\d+) 分钟，(\d+) = 不发）， 休息提醒可以单独关。触发时主界面弹提示、HUD 上的倒计时变金色闪烁。$/,
      'Configure reminders in Settings. Focus and break reminders fire before each ends ($1–$2 min, $3 = off). The countdown on the HUD turns gold.'],
    [/^把加密后的备份传到上面的 WebDAV 目录，可以列出历史版本任选一份恢复。 保留策略和本地一致：最近 (\d+) 份、(\d+) 天内。$/,
      'Encrypted backups go to the WebDAV folder above and can be restored per version. Retention matches local: latest $1, within $2 days.'],
    [/^「固化」打开后，生效期间不能退出程序、不能改任何设置，任务管理器会被自动关掉； 进程被杀掉会被守护进程在 (\d+) 秒内拉回来。$/,
      'While hard-locked you cannot quit or change settings; Task Manager is closed. If the process is killed it is restarted within $1 s.'],
    [/^上。无操作超过 (\d+) 秒不计时（可在设置里改）。 日文件按小时分桶，可回溯到"某天某小时"。$/,
      '. Idle over $1 s is not counted (configurable). Daily files are bucketed by hour.'],
    [/^· 与 v([\d.]+) 同步更新（(\d+)-(\d+)-(\d+)）。改动了功能，这一页会跟着一起改。$/,
      '· Updated with v$1 ($2-$3-$4). This page changes along with the app.'],
    [/^——热键、Alt\+F(\d)、关闭窗口、下面的按钮全部被拒绝，直到这一段结束。$/,
      '— hotkey, Alt+F$1, closing the window and the button below are all refused until this window ends.'],
    [/^开：自律时间里仍可以用 Ctrl\+Alt\+F(\d)、Alt\+F(\d) 或下面的按钮退出。 关：自律时段内$/,
      'On: you can quit during hours with Ctrl+Alt+F$1, Alt+F$2 or the button below.'],
    [/^写一句给自己的话（最多 (\d+) 字），回车即可添加$/,
      'Write something for yourself (up to $1 chars), press Enter to add'],
    [/^只记录最近 (\d+) 条，含时间、类型、对象与命中自律规则。$/,
      'Keeps the latest $1 entries with time, type, target and matched rule.'],
    [/^已安装 (\d+) 个浏览器，(\d+) 个插件就绪，(\d+) 个需要处理$/,
      '$1 browsers, $2 extensions ready, $3 need attention'],
    [/^先给程序发关闭信号，([\d.]+) 秒不退再强制结束，能保住一部分现场$/,
      'Asks the app to close, force-kills after $1 s — saves more state.'],
    [/^留给你的反应时间；加上轮询间隔后总耗时不超过 (\d+) 秒（上限 (\d+)ms）$/,
      'Grace period; total stays under $1 s (cap $2 ms).'],
    [/^横轴一周七天，纵轴 (\d+)–(\d+) 点，一小时再竖着分成若干格。 哪几天、哪几段要自律，直接在格子上拖出来——选中的部分就是一条从上到下的横条，条子的长度就是时长。 到点自动进入自律模式，到点自动退出；自律规则、浏览器巡检、专注遮罩都会跟着这段状态走。 需要多套排班时，做成几套「星期时段」方案，每套还能各自绑定不同的自律规则分组。$/,
      'Seven days across, $1–$2 o\'clock down, each hour split into cells. Drag on the grid to choose; the strip you paint is the duration. Discipline starts and stops on time, and rules, browser scans and the mask all follow it. Use several hour sets for different schedules, each bound to its own rules.'],
    [/^每秒采样一次前台窗口。若前台是受支持的浏览器、且插件在 (\d+) 分钟内上报过当前标签页， 这一秒记到$/,
      'The foreground window is sampled every second. If it is a supported browser and the extension reported within $1 min, this second is attributed to'],
    [/^当前不在自律时间：自律规则不拦截，下一个选中时段：周(.) (\d\d:\d\d)（(.+)）$/,
      function (m, p1, p2, p3) {
        return 'Outside discipline hours; nothing is blocked. Next window: '
          + wd(p1) + ' ' + p2 + ' (' + whenText(p3) + ')';
      }],
    [/^在 (\d+) 分钟后开始$/, 'starts in $1 min'],
    [/^还有 (\d+) 分 (\d+) 秒$/, '$1 min $2 s left'],
    [/^还有 (\d+) 分$/, '$1 min left'],
    [/^还有 (\d+) 秒$/, '$1 s left'],
    [/^(.+) 分钟后$/, 'in $1 min'],
    /* 日历明细的「共 5 小时 12 分」 */
    [/^共 (.+)$/, 'Total $1'],
  ];

  /* ---------- 语言状态与译文查表 ---------- */
  var LANG = 'zh-CN';
  function getLang() { return LANG; }
  function setLang(l) { LANG = (l === 'en') ? 'en' : 'zh-CN'; }

  function lookup(core) {
    if (Object.prototype.hasOwnProperty.call(EN, core)) return EN[core];
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (!r[0].test(core)) continue;
      var rep = r[1];
      if (typeof rep === 'function') return core.replace(r[0], rep);
      return core.replace(r[0], rep);
    }
    return null;
  }

  /** 翻译一段可能带前后空白的文本；查不到就原样返回（回落中文）。 */
  function tr(raw) {
    if (LANG === 'zh-CN' || raw == null) return raw;
    var s = String(raw);
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    if (!m || !m[2]) return raw;
    var hit = lookup(m[2].replace(/\s+/g, ' ').trim());
    return hit == null ? raw : m[1] + hit + m[3];
  }

  /* ---------- DOM 应用 / 还原 ---------- */
  var SAVED = new WeakMap();     // 文本节点或元素 → 原文

  function walk(root, fn) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = w.nextNode())) {
      var p = n.parentElement;
      if (p && (p.tagName === 'SCRIPT' || p.tagName === 'STYLE')) continue;
      fn(n);
    }
  }

  /** 把一棵子树翻成当前语言（幂等；切回中文时用备份还原）。 */
  function apply(root) {
    var r = root || document.body;
    if (!r) return;
    if (LANG === 'zh-CN') { restore(r); return; }

    walk(r, function (n) {
      if (!SAVED.has(n)) SAVED.set(n, n.nodeValue);
      var raw = SAVED.get(n);
      var out = tr(raw);
      if (out !== n.nodeValue) n.nodeValue = out;
    });

    var els = (r.querySelectorAll ? r.querySelectorAll('[title],[placeholder],[aria-label]') : []);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!SAVED.has(el)) SAVED.set(el, {});
      var box = SAVED.get(el);
      ['title', 'placeholder', 'aria-label'].forEach(function (a) {
        if (!el.hasAttribute(a)) return;
        if (!(a in box)) box[a] = el.getAttribute(a);
        var src = box[a];
        if (src == null) return;
        var hit = lookup(String(src).replace(/\s+/g, ' ').trim());
        if (hit != null) el.setAttribute(a, hit);
      });
    }
  }

  /** 还原成中文原文（切语言时用）。 */
  function restore(root) {
    var r = root || document.body;
    if (!r) return;
    walk(r, function (n) {
      if (SAVED.has(n)) {
        var raw = SAVED.get(n);
        if (n.nodeValue !== raw) n.nodeValue = raw;
      }
    });
    var els = (r.querySelectorAll ? r.querySelectorAll('[title],[placeholder],[aria-label]') : []);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!SAVED.has(el)) continue;
      var box = SAVED.get(el);
      Object.keys(box).forEach(function (a) {
        if (el.getAttribute(a) !== box[a]) el.setAttribute(a, box[a]);
      });
    }
  }

  global.I18N = {
    getLang: getLang,
    setLang: setLang,
    t: tr,
    apply: apply,
    restore: restore,
    /** 词典里有多少条（自测用） */
    size: function () { return Object.keys(EN).length + RULES.length; },
    has: function (s) { return lookup(String(s).replace(/\s+/g, ' ').trim()) != null; }
  };
})(window);
