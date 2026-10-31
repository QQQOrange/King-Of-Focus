package com.qqqorange.kingoffocus.service

import android.accessibilityservice.AccessibilityService
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import com.qqqorange.kingoffocus.core.LockEngine
import com.qqqorange.kingoffocus.data.Store
import java.time.LocalDateTime

/**
 * 无障碍服务：三个"即时性"能力，都是 UsageStats + Activity 做不到的。
 *
 * 1. **前台应用实时识别**：`TYPE_WINDOW_STATE_CHANGED` 一来就知道切到了谁，
 *    不用等 1 秒轮询，也不会因为"同一应用内换页"而判错。
 * 2. **全局动作回桌面**：`GLOBAL_ACTION_HOME` 不受"后台启动 Activity"限制，
 *    不需要悬浮窗权限也能把用户送回桌面。
 * 3. **强制模式下的防绕过**：用户进到系统设置里想关无障碍 / 强制停止本应用时，
 *    这一页会出现"King Of Focus"字样——直接在那一页按返回。
 *
 * 边界写清楚：无障碍**不能**结束别的应用进程、**不能**阻止卸载本应用、
 * 也**不能**在安全模式下生效。它的定位是"看得见 + 按得动导航键"，
 * 真正的"锁死"要靠 Shizuku（见 [com.qqqorange.kingoffocus.core.ShizukuBridge]）。
 */
class KofAccessibility : AccessibilityService() {

    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        // 这一句不能少：无障碍服务可能**独立**于主界面被系统拉起（开机后、进程被杀后重建），
        // 那时没人调过 Store.init，读到的就是默认配置（enabled=false）——
        // 防绕过会因此静默失效，而且看起来"服务明明在跑"。
        Store.init(applicationContext)
        inst = this
    }

    override fun onDestroy() {
        if (inst === this) inst = null
        super.onDestroy()
    }

    override fun onInterrupt() {}

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val pkg = event.packageName?.toString() ?: return
        // 自家的遮罩/主界面不算"用户在用别的应用"，否则服务会以为自己在前台而不动手
        if (pkg == packageName) return

        lastPkg = pkg
        lastAt = SystemClock.elapsedRealtime()

        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        guardSettingsPage(pkg, event)
    }

    /**
     * 强制模式下挡住"去设置里关掉它"这条路。
     *
     * 判定分两层，宁可漏一次也不能误伤：
     *  1. **内容证据**：当前窗口属于系统设置，且窗口里能找到本应用名 / 包名；
     *  2. **标题兜底**：窗口标题是「App info / 应用信息 / Accessibility / 无障碍」这类
     *     "能关掉本应用"的页面。
     *
     * 为什么要标题兜底：系统设置新版是 Compose 写的，窗口刚出来时无障碍树是空的
     * （实测 `childCount=1`、搜不到任何文案），只靠内容判定会一直判不到；
     * 而这时候窗口标题已经可用了。两层叠加既能把路堵上，也不会把普通的设置页卷进来。
     *
     * 只在这几页按返回，其余设置页一概不动——宁可漏一次，也不要让设置变得没法用。
     */
    private fun guardSettingsPage(pkg: String, event: AccessibilityEvent) {
        if (pkg != SETTINGS_PKG) return
        if (!strictLockActive()) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastBackAt < 1500) return
        val title = event.text?.joinToString(" ").orEmpty()
        val fromEvent = collectText(event)
        handler.postDelayed({ verifyAndBlock(0, fromEvent, title) }, 150)
    }

    private fun verifyAndBlock(depth: Int, fromEvent: String, title: String) {
        if (!strictLockActive()) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastBackAt < 1500) return

        val root = runCatching { rootInActiveWindow }.getOrNull()
        // 只在"当前窗口还是系统设置"时才动手：用户可能已经切走了，
        // 这时候按返回会把人家正常的应用给退掉。
        if (root?.packageName?.toString() != SETTINGS_PKG) return

        val byContent = containsUs(root, fromEvent)
        val byTitle = BLOCK_TITLES.any { title.contains(it, ignoreCase = true) }
        if (byContent || byTitle) {
            lastBackAt = now
            Log.i(TAG, "强制模式：挡住设置页（内容=$byContent 标题=$byTitle [${title.take(24)}]）")
            performGlobalAction(GLOBAL_ACTION_BACK)
            return
        }
        if (depth < 3) handler.postDelayed({ verifyAndBlock(depth + 1, fromEvent, title) }, 300)
    }

    /** 强制锁机正在进行中？（每次都要重新读配置：用户可能刚切了模式） */
    private fun strictLockActive(): Boolean {
        val cfg = Store.current
        return LockEngine.isStrict(cfg) && LockEngine.isLockActive(cfg, LocalDateTime.now())
    }

    private fun containsUs(root: android.view.accessibility.AccessibilityNodeInfo?, fromEvent: String): Boolean {
        if (fromEvent.contains(APP_LABEL) || fromEvent.contains(packageName)) return true
        if (root == null) return false
        val byLabel = runCatching { root.findAccessibilityNodeInfosByText(APP_LABEL) }.getOrNull()
        val byPkg = runCatching { root.findAccessibilityNodeInfosByText(packageName) }.getOrNull()
        return !byLabel.isNullOrEmpty() || !byPkg.isNullOrEmpty()
    }

    private fun collectText(e: AccessibilityEvent): String {
        val sb = StringBuilder()
        runCatching {
            e.text?.forEach { sb.append(it).append(' ') }
            e.contentDescription?.let { sb.append(it).append(' ') }
            val src = e.source
            if (src != null) {
                src.text?.let { sb.append(it).append(' ') }
                src.contentDescription?.let { sb.append(it).append(' ') }
            }
        }
        return sb.toString()
    }

    companion object {
        private const val TAG = "KofAccess"
        private const val SETTINGS_PKG = "com.android.settings"
        private const val APP_LABEL = "King Of Focus"

        /**
         * 这些标题对应的页面都能"关掉本应用"：
         * · App info / 应用信息：强制停止、卸载、清除数据都在这里；
         * · Accessibility / 无障碍：关掉本服务的地方。
         * 英文 / 中文都要列，ROM 的翻译不一定跟系统语言一致。
         */
        private val BLOCK_TITLES = listOf(
            "App info", "App details", "Application info",
            "应用信息", "应用详情",
            "Accessibility", "无障碍",
        )

        @Volatile
        private var inst: KofAccessibility? = null

        @Volatile
        private var lastPkg: String? = null

        @Volatile
        private var lastAt = 0L

        @Volatile
        private var lastBackAt = 0L

        fun alive(): Boolean = inst != null

        /** 无障碍看到的当前前台包名；超过 3 秒没新事件就当不知道 */
        fun latest(): String? =
            if (SystemClock.elapsedRealtime() - lastAt <= 3000) lastPkg else null

        /**
         * 距离上一次无障碍事件过了多少毫秒；没连接时返回 null。
         *
         * 这是手机端最接近桌面 `GetLastInputInfo` 的东西：点一下、切窗口、改文本
         * 都会产生事件。它**只能说明"有过交互"**，不能当"最后一次触摸"用
         * （看视频时一帧都不产生事件也是正常的），所以只在
         * `stats.countIdle=false` 这种"我就要更严格"的场合才采信。
         */
        fun idleMillis(): Long? {
            if (inst == null) return null
            val at = lastAt
            if (at <= 0L) return null
            return (SystemClock.elapsedRealtime() - at).coerceAtLeast(0L)
        }

        /** 全局动作回桌面：不受后台启动 Activity 限制 */
        fun goHome(): Boolean =
            inst?.performGlobalAction(GLOBAL_ACTION_HOME) == true
    }
}
