package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.ui.Loc
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 英文界面的覆盖率闸门。
 *
 * 为什么需要：`Loc.t("…")` 查不到就回中文——**不会崩、不会显示 key**，
 * 所以"漏翻一条"在运行时完全看不出来。加了一条中文句子却忘了补译文，
 * 英文用户看到的就是一句中文夹在英文界面里，而这只有他自己会发现。
 *
 * 这里直接从源码里把 `Loc.t("…")` 的字面量抠出来，和 `Loc.EN` 对一遍：
 * 漏一条就红。加新文案的人不需要记得这件事，测试会记得。
 */
class LocCoverageTest {

    private fun uiSources(): List<File> {
        // gradle 测试的工作目录是 android/app
        val dir = File("src/main/java/com/qqqorange/kingoffocus")
        assertTrue("找不到源码目录：${dir.absolutePath}", dir.isDirectory)
        return dir.walkTopDown().filter { it.isFile && it.name.endsWith(".kt") && it.name != "Loc.kt" }.toList()
    }

    /**
     * Kotlin 会在编译期把 `\n` 这类转义变成真字符，而测试是从**源码文本**里抓 key 的。
     * 不做这层还原，`"…失效。\n\n"` 这种带换行的句子永远对不上（源里是反斜杠 n，
     * 词典里是真换行）。只还原可能出现的那几种。
     */
    private fun unescape(raw: String): String = raw
        .replace("\\n", "\n")
        .replace("\\t", "\t")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")

    /** `Loc.t("中文")` 里被引用的全部 key */
    private fun usedKeys(): Set<String> {
        val re = Regex("""Loc\.t\(\s*"((?:[^"\\]|\\.)*)"\s*\)""")
        return uiSources()
            .flatMap { f -> re.findAll(f.readText()).map { unescape(it.groupValues[1]) } }
            .toSet()
    }

    @Test
    fun `每个 Loc_t 都有英文`() {
        val used = usedKeys()
        assertTrue("一个 Loc.t 都没扫到，正则或目录变了", used.isNotEmpty())
        val missing = used.filter { it !in Loc.EN }
        assertTrue(
            "这些文案包了 Loc.t 但没有英文译文：\n" + missing.joinToString("\n") { "  \"$it\"" },
            missing.isEmpty(),
        )
    }

    @Test
    fun `词典里没有多余的死条目`() {
        val used = usedKeys()
        // 允许少量"先备着"的条目，但超过 15 条说明有人在堆垃圾
        val dead = Loc.EN.keys.filter { it !in used }
        assertTrue(
            "Loc.EN 里有 ${dead.size} 条没人用（超过 15 条就该清理）：\n" +
                dead.take(20).joinToString("\n") { "  \"$it\"" },
            dead.size <= 15,
        )
    }
}
