package com.qqqorange.kingoffocus.data

import android.content.Context
import android.os.Build
import com.qqqorange.kingoffocus.appVersion

/**
 * 自动备份 —— 「同步」里省事的那一半。
 *
 * 手动上传能让两台设备互通，但每次改完都要记得点一次，实际用起来就会漏。
 * 这里的做法刻意保守：
 *
 * - **只在回到应用时**试（`onResume`），不做后台定时网络请求——省电，也不会
 *   在用户不知情时反复写网盘；
 * - 距上次尝试不足 10 分钟就跳过；
 * - 云端那份的**名字时间戳**已经不早于本机 `updatedAt` 时跳过（没有改动就不传）；
 * - 固定覆盖 `kof-auto-android.kofbak`，**不堆积**——自动备份多了只会让人
 *   分不清哪份能用；
 * - 失败原因写回 `cloud.lastStatus`，界面上能看见，而不是静默失败。
 */
object CloudAuto {

    /** 两次尝试之间的最小间隔 */
    private const val MIN_GAP_MS = 10 * 60_000L

    @Volatile
    private var lastTry = 0L

    fun maybeUpload(ctx: Context) {
        val cfg = Store.current
        if (!cfg.cloud.enabled || !cfg.cloud.auto) return
        if (cfg.cloud.url.isBlank()) return
        val now = System.currentTimeMillis()
        if (now - lastTry < MIN_GAP_MS) return
        lastTry = now

        val app = ctx.applicationContext
        Thread {
            val msg = runCatching {
                val cur = Store.current
                val list = (CloudSync.list(cur.cloud) as? CloudSync.Outcome.Ok)?.entries.orEmpty()
                val remote = list.firstOrNull { it.name == CloudSync.AUTO_NAME }
                // 云端那份已经是这次改动之后的了 → 没有新东西可传
                if (remote != null && remote.at >= cur.updatedAt) {
                    null
                } else {
                    val doc = Portable.toDoc(cur, Build.MODEL ?: "Android", appVersion(app))
                    val body = Portable.seal(Portable.render(doc), cur.backup.password)
                    when (val r = CloudSync.put(cur.cloud, CloudSync.AUTO_NAME, body)) {
                        is CloudSync.Outcome.Err -> r.message
                        is CloudSync.Outcome.Ok -> "已自动备份（" + stamp() + "）"
                    }
                }
            }.getOrElse { "自动备份失败：${it.message ?: "未知错误"}" }

            if (msg != null) {
                Store.update { c ->
                    c.copy(
                        cloud = c.cloud.copy(
                            lastStatus = msg,
                            lastSync = if (msg.startsWith("已")) System.currentTimeMillis() / 1000
                            else c.cloud.lastSync,
                        ),
                    )
                }
            }
        }.start()
    }

    private fun stamp(): String =
        java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.US)
            .format(java.util.Date())
}
