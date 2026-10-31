package com.qqqorange.kingoffocus.shell

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Shizuku 用户服务：这个类会被 Shizuku **以 shell 用户的身份**加载，
 * 所以 `exec` 里跑的命令带 ADB 级权限（`pm`、`am`、`settings` 都能用）。
 *
 * 它本身不做任何判断——判断全在主进程（[com.qqqorange.kingoffocus.core.ShizukuBridge]），
 * 这里只当"手"。权限最小化的意思就是：能被执行的事情越少越好。
 */
class ShellService : Service() {

    private val binder = object : IShell.Stub() {
        override fun exec(cmd: String): String = try {
            val p = ProcessBuilder("sh", "-c", cmd).redirectErrorStream(true).start()
            val out = p.inputStream.bufferedReader().use { it.readText() }
            p.waitFor()
            out
        } catch (t: Throwable) {
            "ERR:" + (t.message ?: t.javaClass.simpleName)
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder
}
