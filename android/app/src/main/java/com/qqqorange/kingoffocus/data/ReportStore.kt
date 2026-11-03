package com.qqqorange.kingoffocus.data

import android.content.Context
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * 手机端的「报告存档」。
 *
 * 桌面端每生成一份报告就落一个 json，能在列表里翻出来重看/导出/删除。
 * 手机端以前只有"当场生成一段文本，复制或者分享出去"——关掉页面就没了。
 * 这里补上最小可用的那一半：**把当前这份存下来，之后还能再打开/分享/删掉**。
 *
 * 为什么不学桌面端存 json：手机端报告本来就是给人看的纯文本（[Report.build]），
 * 存 txt 最直接，也不需要为了渲染再解析一次结构。
 *
 * 文件名带日期与周期（`2026-11-03-weekly.txt`），列表按修改时间倒序。
 * 上限 60 份，超了从最旧的开始删——报告是"留个证据"，不是数据库。
 */
object ReportStore {
    private const val MAX = 60
    private lateinit var dir: File

    fun init(ctx: Context) {
        dir = File(ctx.filesDir, "reports")
        runCatching { dir.mkdirs() }
    }

    /** 一份存档的摘要（列表用） */
    data class Item(
        val name: String,
        val title: String,
        val at: Long,
        val size: Int,
    )

    private fun safeName(s: String): String =
        s.replace(Regex("[^0-9A-Za-z._-]"), "_").take(80).ifBlank { "report" }

    /**
     * 保存一份报告，返回最终文件名（空串表示失败）。
     *
     * 同一天同一周期的再存一次会**覆盖**（`day-weekly.txt`），
     * 因为用户多点一次"保存"不该在列表里堆出五份一样的。
     */
    fun save(title: String, text: String): String {
        if (!::dir.isInitialized) return ""
        return runCatching {
            val f = File(dir, safeName(title) + ".txt")
            f.writeText(text)
            prune()
            f.name
        }.getOrDefault("")
    }

    fun list(): List<Item> {
        if (!::dir.isInitialized) return emptyList()
        val fmt = DateTimeFormatter.ofPattern("MM-dd HH:mm")
        return dir.listFiles { f -> f.isFile && f.name.endsWith(".txt") }
            ?.map { f ->
                Item(
                    name = f.name,
                    // 标题取第一行（Report.build 的第一行就是「2026-11-03 日报」这类）
                    title = runCatching { f.useLines { it.firstOrNull() } }.getOrNull().orEmpty()
                        .ifBlank { f.nameWithoutExtension },
                    at = f.lastModified(),
                    size = f.length().toInt(),
                )
            }
            ?.sortedByDescending { it.at }
            ?: emptyList()
    }

    fun read(name: String): String {
        if (!::dir.isInitialized) return ""
        val f = File(dir, safeName(name.removeSuffix(".txt")) + ".txt")
        return runCatching { if (f.isFile) f.readText() else "" }.getOrDefault("")
    }

    fun delete(name: String): Boolean {
        if (!::dir.isInitialized) return false
        val f = File(dir, safeName(name.removeSuffix(".txt")) + ".txt")
        return runCatching { f.delete() }.getOrDefault(false)
    }

    /** 给人看的「11-03 14:20」 */
    fun whenText(at: Long): String =
        Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofPattern("MM-dd HH:mm"))

    private fun prune() {
        val all = dir.listFiles { f -> f.isFile && f.name.endsWith(".txt") }
            ?.sortedBy { it.lastModified() } ?: return
        if (all.size <= MAX) return
        all.take(all.size - MAX).forEach { runCatching { it.delete() } }
    }
}
