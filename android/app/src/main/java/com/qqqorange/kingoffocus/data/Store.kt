package com.qqqorange.kingoffocus.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import java.io.File

/**
 * 配置读写。
 *
 * 两个刻意的设计：
 * 1. **原子写**：先写 .tmp 再改名。直接覆盖会先把原文件截断成 0 字节，
 *    这期间进程被杀 / 断电，配置就没了 —— Windows 版踩过这个坑（守护进程
 *    读到半截 JSON 会退回默认配置，固化判定静默失效）。
 * 2. **解析失败保底**：损坏的配置改名成 config.broken-<时间戳>.json 留档，
 *    而不是静默覆盖成默认值。
 */
object Store {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = true
    }

    private lateinit var file: File
    private val _state = MutableStateFlow(Config())

    val state: StateFlow<Config> get() = _state
    val current: Config get() = _state.value

    @Synchronized
    fun init(ctx: Context) {
        if (::file.isInitialized) return
        val dir = File(ctx.applicationContext.filesDir, "kof").apply { mkdirs() }
        file = File(dir, "config.json")
        _state.value = normalize(load())
        // 统计目录也在这里初始化：服务、界面、报告都从 StatsStore 读同一份
        com.qqqorange.kingoffocus.core.StatsStore.init(ctx.applicationContext)
        // 分心事件是独立的事件流（不进备份），跟配置分开初始化
        DistractStore.init(ctx.applicationContext)
        GoalStore.init(ctx.applicationContext)
        LedgerStore.init(ctx.applicationContext)
        StakeStore.init(ctx.applicationContext)
        // 权限状态机要把"首次拿到"记下来（用来区分"从没给过"和"被回收"）
        com.qqqorange.kingoffocus.core.UsageAccess.bind { block -> update(block) }
    }

    private fun load(): Config {
        if (!file.exists()) return Config()
        // 读出来就归一化。
        //
        // 以前这里只 decode：老配置里 `cloud.url` 是空串，内存里就一直是空串——
        // 界面输入框看着是空的（只剩 placeholder），而同步那边又各自判"地址为空"。
        // 归一化之后，"空 = 默认地址"这条规则在**第一次读进内存时**就成立，
        // 界面上直接显示默认地址，用户一眼能看到自己在用哪个目录。
        return runCatching { normalize(json.decodeFromString<Config>(file.readText())) }
            .getOrElse {
                // 留档再重置：用户至少还能找回规则
                val bad = File(file.parentFile, "config.broken-${System.currentTimeMillis()}.json")
                runCatching { file.copyTo(bad, overwrite = true) }
                Config()
            }
    }

    @Synchronized
    fun save(cfg: Config) {
        val stamped = normalize(cfg).copy(
            updatedAt = System.currentTimeMillis() / 1000,
        )
        val text = json.encodeToString(Config.serializer(), stamped)
        val tmp = File(file.parentFile, "config.json.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) {
            // rename 失败（跨卷、被占用）：退化成直接写，至少别丢数据
            file.writeText(text)
            tmp.delete()
        }
        _state.value = stamped
    }

    @Synchronized
    fun update(block: (Config) -> Config) {
        val next = normalize(block(_state.value))
        save(next)
        _state.value = next
    }

    /** 只改内存不落盘（拖动滑块这类高频操作先用它，松手再 save） */
    @Synchronized
    fun preview(block: (Config) -> Config) {
        _state.value = normalize(block(_state.value))
    }

    @Synchronized
    fun commit() {
        save(_state.value)
    }
}
