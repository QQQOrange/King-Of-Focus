package com.qqqorange.kingoffocus.data

import android.content.Context
import kotlinx.serialization.json.Json
import java.io.File

/**
 * 「恢复默认」和「重置全部」之前的**安全网**。
 *
 * 桌面端 0.1.104 起就有这个能力（分区重置 + 快照 + 撤销）。手机端以前只有
 * 一个「重置全部配置」按钮，点下去直接 `Store.update { Config() }`：
 * 规则、时段、积分一起没，**没有任何退路**——真按错了只能去翻备份文件，
 * 而多数人根本没有备份。
 *
 * 这里做最小但足够的一件事：动配置之前先把手上的整份配置存成一个 json 放本机，
 * 界面上一键「撤销上次恢复」。文件只有一个（后一次覆盖前一次），
 * 因为"撤销"就该是往回退一步，不是时间机器。
 */
object ResetStore {
    private lateinit var file: File
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    fun init(ctx: Context) {
        file = File(ctx.filesDir, "pre-reset.json")
    }

    /** 动配置前调用：失败也不阻止重置，但会返回 false 让调用方提示"没存下后路" */
    fun save(cfg: Config): Boolean = runCatching {
        if (!::file.isInitialized) return false
        file.writeText(json.encodeToString(Config.serializer(), cfg))
        true
    }.getOrDefault(false)

    fun load(): Config? {
        if (!::file.isInitialized) return null
        if (!file.isFile) return null
        return runCatching { json.decodeFromString(Config.serializer(), file.readText()) }.getOrNull()
    }

    fun has(): Boolean = ::file.isInitialized && file.isFile

    fun clear() {
        if (!::file.isInitialized) return
        runCatching { file.delete() }
    }
}
