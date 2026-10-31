package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.UpdateHub
import com.qqqorange.kingoffocus.core.Updater
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 更新包选择的单元测试。
 *
 * 这些断言防的不是"代码写错"，而是**跨平台错配**：桌面端装了安卓包、
 * 手机端装了插件包、或者发布脚本把版本号写错导致"永远没有更新"。
 * 每一条都对应 `docs/update-channels.md` 里的一个错误码。
 */
class UpdaterTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun manifest(
        platform: String = "android",
        version: String = "9.9.9",
        file: String = "King.Of.Focus-9.9.9-android.apk",
        size: Long = 12_345,
        sha: String = "a".repeat(64),
        app: String = "king-of-focus",
        schema: Int = 1,
    ): JsonObject = json.parseToJsonElement(
        """
        {
          "app": "$app",
          "schema": $schema,
          "tag": "v$version",
          "platforms": {
            "$platform": {
              "version": "$version", "kind": "apk", "file": "$file",
              "size": $size, "sha256": "$sha"
            }
          }
        }
        """.trimIndent(),
    ) as JsonObject

    @Test
    fun acceptsMatchingAndroidEntry() {
        val m = manifest()
        val out = Updater.select(m, "android", "0.2.0", listOf("King.Of.Focus-9.9.9-android.apk"))
        assertTrue(out is Updater.Outcome.Ok)
        out as Updater.Outcome.Ok
        assertEquals("9.9.9", out.version)
        assertEquals(12_345L, out.size)
    }

    /** 清单里只有桌面条目时，手机必须明确说"没有安卓包"，不能去装 exe */
    @Test
    fun androidRefusesWhenOnlyDesktopEntryExists() {
        val m = manifest(
            platform = "windows-x64",
            file = "King.Of.Focus-9.9.9-windows-x64.exe",
        )
        val out = Updater.select(m, "android", "0.2.0", listOf("King.Of.Focus-9.9.9-windows-x64.exe"))
        out as Updater.Outcome.Rejected
        assertEquals("E_PLATFORM_MISSING", out.code)
        assertTrue(out.message.contains("不会去装别的平台的包"))
    }

    /** 清单把 exe 写在 android 那一条里（发布脚本手滑）→ 必须拒绝 */
    @Test
    fun androidRefusesExeListedUnderAndroid() {
        val m = manifest(file = "King.Of.Focus-9.9.9-android.exe")
        val out = Updater.select(m, "android", "0.2.0", listOf("King.Of.Focus-9.9.9-android.exe"))
        out as Updater.Outcome.Rejected
        assertTrue(
            "扩展名不在允许集合里，应该先被包名规则拦下：" + out.code,
            out.code == "E_NAME_MISMATCH" || out.code == "E_TYPE_MISMATCH",
        )
    }

    @Test
    fun rejectsNameVersionMismatch() {
        val m = manifest(file = "King.Of.Focus-9.9.8-android.apk")
        val out = Updater.select(m, "android", "0.2.0", listOf("King.Of.Focus-9.9.8-android.apk"))
        out as Updater.Outcome.Rejected
        assertEquals("E_NAME_MISMATCH", out.code)
    }

    @Test
    fun rejectsNamePlatformMismatch() {
        val m = manifest(version = "9.9.9", file = "King.Of.Focus-9.9.9-windows-x64.apk")
        val out = Updater.select(m, "android", "0.2.0", listOf("King.Of.Focus-9.9.9-windows-x64.apk"))
        out as Updater.Outcome.Rejected
        assertEquals("E_NAME_MISMATCH", out.code)
    }

    /** 清单自洽，但 Release 里没有这个文件：不能拿相近的包顶替 */
    @Test
    fun rejectsWhenAssetAbsentFromRelease() {
        val m = manifest()
        val out = Updater.select(m, "android", "0.2.0", listOf("King.Of.Focus-9.9.9-android.apk.sig"))
        out as Updater.Outcome.Rejected
        assertEquals("E_ASSET_MISSING", out.code)
    }

    @Test
    fun sameOrOlderVersionIsNotAnUpdate() {
        val m = manifest(version = "0.2.0", file = "King.Of.Focus-0.2.0-android.apk")
        val out = Updater.select(m, "android", "0.2.0", listOf("King.Of.Focus-0.2.0-android.apk"))
        assertTrue(out is Updater.Outcome.NoUpdate)
    }

    @Test
    fun rejectsBrokenHashAndSize() {
        val m1 = manifest(sha = "zz")
        val o1 = Updater.select(m1, "android", "0.2.0", listOf("King.Of.Focus-9.9.9-android.apk"))
        o1 as Updater.Outcome.Rejected
        assertEquals("E_BAD_HASH", o1.code)

        val m2 = manifest(size = 0)
        val o2 = Updater.select(m2, "android", "0.2.0", listOf("King.Of.Focus-9.9.9-android.apk"))
        o2 as Updater.Outcome.Rejected
        assertEquals("E_BAD_SIZE", o2.code)
    }

    @Test
    fun rejectsForeignManifestAndFutureSchema() {
        val m1 = manifest(app = "something-else")
        (Updater.select(m1, "android", "0.2.0", emptyList()) as Updater.Outcome.Rejected)
            .let { assertEquals("E_BAD_APP", it.code) }

        val m2 = manifest(schema = 9)
        (Updater.select(m2, "android", "0.2.0", emptyList()) as Updater.Outcome.Rejected)
            .let { assertEquals("E_BAD_SCHEMA", it.code) }
    }

    /** 老发布兜底：只挑 apk，exe / zip 一律跳过 */
    @Test
    fun legacyPickOnlyTakesApk() {
        val assets = listOf(
            "King.Of.Focus-0.1.52.exe",
            "King.Of.Focus-Extension-1.1.1.zip",
            "King.Of.Focus-0.2.1-android.apk",
        )
        assertEquals("King.Of.Focus-0.2.1-android.apk", Updater.legacyPick(assets, "android"))
        assertNull(
            "只有桌面包时宁可返回 null，也不能拿 exe 充数",
            Updater.legacyPick(listOf("King.Of.Focus-0.1.52.exe"), "android"),
        )
    }

    /** 版本按数字比，不能按字符串比 */
    @Test
    fun versionCompareIsNumeric() {
        assertEquals(1, Updater.compareVer("0.10.0", "0.9.0"))
        assertEquals(-1, Updater.compareVer("0.9.0", "0.10.0"))
        assertEquals(0, Updater.compareVer("v1.2.3", "1.2.3"))
        assertEquals(0, Updater.compareVer("1.2", "1.2.0"))
        assertTrue(Updater.validVersion("0.2.1"))
        assertFalse(Updater.validVersion("0.2"))
        assertFalse(Updater.validVersion("0.2.1-beta"))
    }

    /** 自动检查的间隔：不能每次启动都打一次 GitHub */
    @Test
    fun autoCheckIntervalIsRespected() {
        val now = 1_800_000_000L
        assertTrue(UpdateHub.due(0, 6, now))
        assertFalse(UpdateHub.due(now - 5 * 3600, 6, now))
        assertTrue(UpdateHub.due(now - 6 * 3600, 6, now))
        // 用户把系统时间调回去了：宁可多查一次，也不要永远不查
        assertTrue(UpdateHub.due(now + 86_400, 6, now))
    }
}
