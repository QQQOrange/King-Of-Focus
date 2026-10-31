package com.qqqorange.kingoffocus.core

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log
import com.qqqorange.kingoffocus.shell.IShell
import com.qqqorange.kingoffocus.shell.ShellService
import rikka.shizuku.Shizuku

/**
 * Shizuku 通道：借 shell 权限做**无障碍做不到**的事。
 *
 * 三件事（正好对应"防绕过"里最难的三个点）：
 *  1. `am start` 拉起遮罩 —— 不受"后台启动 Activity"限制，没悬浮窗权限也能盖上来；
 *  2. `pm set-user-restriction no_control_apps 1` —— 让系统设置里的
 *     「强制停止 / 卸载 / 清除数据」按钮直接不可用（这是唯一能真正挡住手抖和手快的办法）；
 *  3. `settings put secure enabled_accessibility_services ...` ——
 *     用户把无障碍关掉后，替他把自家服务塞回去。
 *
 * **任何一步失败都必须安静地退回去**：没有 Shizuku 只是"能力弱一点"，
 * 不是"功能坏了"。所以所有方法都返回 Boolean / null，从不抛。
 */
object ShizukuBridge {

    private const val TAG = "KofShizuku"
    private const val REQ_CODE = 4310
    /** AIDL 变了就要 +1（见 IShell 的注释） */
    private const val SERVICE_VERSION = 1

    @Volatile
    private var shell: IShell? = null

    @Volatile
    private var connecting = false

    private var listenerBound = false

    /** Shizuku 服务本身在不在（装了且启动了） */
    fun available(): Boolean = runCatching { Shizuku.pingBinder() }.getOrDefault(false)

    /** 有没有拿到授权（用户在 Shizuku 里点了"允许"） */
    fun granted(): Boolean {
        if (!available()) return false
        return runCatching {
            Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED
        }.getOrDefault(false)
    }

    /** 真正可用 = 服务在 + 已授权 + 用户服务已连上 */
    fun ready(): Boolean = shell != null

    fun version(): Int = runCatching { Shizuku.getVersion() }.getOrDefault(0)

    /**
     * 申请授权。会弹 Shizuku 自己的确认框（不是系统权限框）。
     * 从后台调用会被 Shizuku 拒绝，所以只应在界面上点按钮时调。
     */
    fun request(ctx: Context) {
        bindListeners()
        if (!available()) {
            toastHint(ctx, "Shizuku 没在运行：请先打开 Shizuku 应用并启动服务")
            return
        }
        if (granted()) {
            connect(ctx)
            return
        }
        runCatching { Shizuku.requestPermission(REQ_CODE) }
            .onFailure { toastHint(ctx, "申请失败：" + (it.message ?: "Shizuku 拒绝")) }
    }

    /** 连接用户服务（幂等）。连上之后 [exec] 才可用 */
    fun connect(ctx: Context) {
        if (!granted() || shell != null || connecting) return
        connecting = true
        bindListeners()
        val args = Shizuku.UserServiceArgs(
            ComponentName(ctx.applicationContext, ShellService::class.java),
        )
            .daemon(false)
            .processNameSuffix("shell")
            .debuggable(false)
            .version(SERVICE_VERSION)
        runCatching { Shizuku.bindUserService(args, conn) }
            .onFailure {
                connecting = false
                Log.w(TAG, "绑定用户服务失败", it)
            }
    }

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            connecting = false
            shell = binder?.let { IShell.Stub.asInterface(it) }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            connecting = false
            shell = null
        }
    }

    /** Shizuku 被重启 / 授权变化时要重新连 */
    private fun bindListeners() {
        if (listenerBound) return
        listenerBound = true
        runCatching {
            Shizuku.addBinderReceivedListener { shell = null; connecting = false }
            Shizuku.addBinderDeadListener { shell = null; connecting = false }
            Shizuku.addRequestPermissionResultListener { _, grantResult ->
                if (grantResult == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    // 授权刚拿到，等主进程下次 connect() 时再绑
                    shell = null
                    connecting = false
                }
            }
        }.onFailure { listenerBound = false }
    }

    /**
     * 执行一条 shell 命令。**会阻塞**，调用方必须在后台线程。
     *
     * 返回 null 表示通道不可用（不是命令失败）——调用方据此决定降级，
     * 而不是把"没权限"和"命令报错"混为一谈。
     */
    fun exec(cmd: String): String? {
        val s = shell ?: return null
        return runCatching { s.exec(cmd) }.onFailure { Log.w(TAG, "exec 失败: $cmd", it) }.getOrNull()
    }

    // ---------------- 三个具体动作 ----------------

    private fun String?.ok(): Boolean = this != null && !this.startsWith("ERR:")

    /** 用 shell 拉起一个 Activity：不受 BAL 限制。`args` 是 am 的附加参数（如 `--es k v`） */
    fun startActivity(component: String, args: String = ""): Boolean =
        exec("am start -n $component $args".trim()).ok()

    /** 回桌面（shell 版，兜底用） */
    fun goHome(): Boolean = exec("input keyevent KEYCODE_HOME").ok()

    /**
     * 强制关闭一个包（`am force-stop`）。
     *
     * 强制模式里用来处理"用户跑进系统设置想关掉本应用"这件事：
     * 设置页会被立刻关掉，而且**不留任何持久状态**——不像禁用应用那样，
     * 一旦本应用崩了、Shizuku 断了，用户还得想办法把设置解禁。
     *
     * 做不到的那部分照实说：**无法阻止"强制停止/卸载本应用"本身**。
     * `pm set-user-restriction no_control_apps` 需要 MANAGE_USERS 权限，
     * shell 身份（Shizuku）在 Android 13+ 上会被 SecurityException 拒绝——
     * 这一点是实测出来的，不是猜的。真要锁死只有两条路：设备管理员（Device Owner，
     * 需要一次性 adb 命令）或 root，都不在本版范围内。
     */
    fun forceStop(pkg: String): Boolean = exec("am force-stop $pkg").ok()

    /**
     * 把本应用的无障碍服务重新塞回启用列表（用户手动关掉后自愈）。
     *
     * 不能直接覆盖 `enabled_accessibility_services`：那会把别的无障碍服务一起干掉，
     * 比如输入法、屏幕朗读。所以先读、再按需追加。
     */
    fun reenableAccessibility(component: String): Boolean {
        val cur = exec("settings get secure enabled_accessibility_services")?.trim().orEmpty()
        if (cur.startsWith("ERR:") || cur == "null") return false
        val list = cur.split(':').map { it.trim() }.filter { it.isNotEmpty() }.toMutableList()
        if (list.contains(component)) {
            // 已经在列表里但没生效，说明是总开关被关了
            return exec("settings put secure accessibility_enabled 1").ok()
        }
        list.add(component)
        val joined = list.joinToString(":")
        exec("settings put secure enabled_accessibility_services $joined")
        exec("settings put secure accessibility_enabled 1")
        val after = exec("settings get secure enabled_accessibility_services")?.trim().orEmpty()
        return after.contains(component)
    }

    private fun toastHint(ctx: Context, msg: String) {
        runCatching {
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_SHORT).show()
            }
        }
    }
}
