package com.qqqorange.kingoffocus.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 更新包选择：**平台标识 + 包类型 + 版本号**三重校验。
 *
 * 和桌面端 `src-tauri/src/updsel.rs`、插件 `extension/update.js` 是同一套规则，
 * 错误码逐字相同（见 `docs/update-channels.md`）。任何一端"猜"包都会出事：
 * 桌面端猜错会把 apk 下载下来，手机端猜错会把 exe 当安装包。
 *
 * 所以这里只认清单里写给自己的那一条，并且逐项核对：
 *  1. `app` 必须是 king-of-focus、`schema` 是本端读得懂的版本；
 *  2. `platforms["android"]` 必须存在；
 *  3. 包名必须是 `King.Of.Focus-<版本>-android.apk`，**版本和平台都要与清单一致**；
 *  4. 扩展名必须是 apk（exe / zip / crx 一律拒绝）；
 *  5. 版本必须比当前安装的新；
 *  6. 这个文件必须真的出现在同一个 Release 的资产列表里。
 */
object Updater {

    /** 本机的平台标识。**这就是"我是谁"**，任何选择都必须拿它比对。 */
    const val PLATFORM = "android"
    const val APP_ID = "king-of-focus"
    const val MANIFEST_NAME = "King.Of.Focus-update.json"
    const val NAME_PREFIX = "King.Of.Focus-"
    const val SCHEMA_MAX = 1

    /** 本平台允许的安装包扩展名。别的平台的一律拒绝。 */
    fun allowedExts(platform: String): List<String> = when (platform) {
        "android" -> listOf("apk")
        "chrome-extension" -> listOf("zip", "crx")
        else -> listOf("exe", "msi")
    }

    fun platformLabel(platform: String): String = when (platform) {
        "android" -> "Android"
        "chrome-extension" -> "浏览器插件"
        "windows-x64" -> "Windows 64 位"
        else -> "未知平台"
    }

    /** 校验结果。`NoUpdate` 不是错误，只是"本来就最新"。 */
    sealed class Outcome {
        data class Ok(
            val version: String,
            val file: String,
            val size: Long,
            val sha256: String,
        ) : Outcome()

        data class NoUpdate(val latest: String) : Outcome()

        data class Rejected(val code: String, val message: String) : Outcome()
    }

    /**
     * 版本比较：逐段按**数字**比，缺的段补 0。
     * 按字符串比 `0.10.0` 会小于 `0.9.0`，用户就永远收不到更新。
     */
    fun compareVer(a: String, b: String): Int {
        fun parse(s: String): List<Int> =
            s.trim().trimStart('v', 'V').split('.', '-', '+').take(3)
                .map { it.toIntOrNull() ?: 0 }

        val pa = parse(a)
        val pb = parse(b)
        for (i in 0 until 3) {
            val x = pa.getOrElse(i) { 0 }
            val y = pb.getOrElse(i) { 0 }
            if (x != y) return if (x > y) 1 else -1
        }
        return 0
    }

    /** 版本号必须是三段纯数字；`1.2`、`1.2.3-beta` 拒绝（比大小会得出错误的结论） */
    fun validVersion(v: String): Boolean {
        val parts = v.split('.')
        return parts.size == 3 &&
            parts.all { it.isNotEmpty() && it.length <= 4 && it.all { c -> c.isDigit() } }
    }

    /** 名字是否严格等于 `King.Of.Focus-<version>-<platform>.<允许的扩展名>` */
    fun nameMatches(file: String, version: String, platform: String): Boolean {
        val lower = file.lowercase()
        if (!lower.startsWith(NAME_PREFIX.lowercase())) return false
        val rest = lower.removePrefix(NAME_PREFIX.lowercase())
        val dot = rest.lastIndexOf('.')
        if (dot <= 0) return false
        val stem = rest.substring(0, dot)
        val ext = rest.substring(dot + 1)
        if (ext !in allowedExts(platform)) return false
        return stem == "${version.lowercase()}-$platform"
    }

    /** 名字里带别的平台痕迹时返回那个平台（对付"清单写错了一条"的最坏情况） */
    fun foreignType(file: String, platform: String): String? {
        val lower = file.lowercase()
        val ext = lower.substringAfterLast('.', "")
        val isApk = ext == "apk" || lower.contains("-android")
        val isExt = ext == "zip" || ext == "crx" ||
            lower.contains("-extension") || lower.contains("-chrome")
        val isWin = ext == "exe" || ext == "msi"
        return when {
            isApk && platform != "android" -> "android"
            isExt && platform != "chrome-extension" -> "chrome-extension"
            isWin && !platform.startsWith("windows") -> "windows"
            else -> null
        }
    }

    private fun JsonObject.str(key: String): String =
        (this[key] as? JsonPrimitive)?.content ?: ""

    private fun JsonObject.long(key: String): Long =
        (this[key] as? JsonPrimitive)?.content?.toLongOrNull() ?: 0L

    /**
     * 从清单里挑出本平台那一条并跑完校验。
     *
     * @param assets 本 Release 里真实存在的资产名（用来核对"这个文件真的在"）
     */
    fun select(
        manifest: JsonObject,
        platform: String,
        current: String,
        assets: List<String>,
    ): Outcome {
        if (manifest.str("app") != APP_ID) {
            return Outcome.Rejected(
                "E_BAD_APP",
                "这不是 King Of Focus 的更新清单（app = \"${manifest.str("app")}\"）",
            )
        }
        val schema = manifest.long("schema")
        if (schema < 1 || schema > SCHEMA_MAX) {
            return Outcome.Rejected(
                "E_BAD_SCHEMA",
                "更新清单版本 $schema 本机读不懂，请手动下载新版",
            )
        }

        val platforms = manifest["platforms"] as? JsonObject
        val entry = platforms?.get(platform) as? JsonObject
            ?: return Outcome.Rejected(
                "E_PLATFORM_MISSING",
                "这次发布没有 ${platformLabel(platform)}（$platform）的安装包，本机不会去装别的平台的包",
            )

        val version = entry.str("version").trim()
        if (!validVersion(version)) {
            return Outcome.Rejected(
                "E_BAD_VERSION",
                "清单里的版本号不是 x.y.z 形式：\"$version\" 不能拿来比大小",
            )
        }
        val file = entry.str("file").trim()
        if (file.isEmpty()) {
            return Outcome.Rejected("E_BAD_MANIFEST", "清单里没有写包名")
        }

        if (!nameMatches(file, version, platform)) {
            return Outcome.Rejected(
                "E_NAME_MISMATCH",
                "包名和清单对不上：$file 应该叫 $NAME_PREFIX$version-$platform.<" +
                    allowedExts(platform).joinToString("/") + ">",
            )
        }
        foreignType(file, platform)?.let { bad ->
            return Outcome.Rejected(
                "E_TYPE_MISMATCH",
                "这是 ${platformLabel(bad)} 的安装包，不能装在 ${platformLabel(platform)} 上",
            )
        }
        if (compareVer(version, current) <= 0) {
            return Outcome.NoUpdate(version)
        }

        val size = entry.long("size")
        if (size <= 0) {
            return Outcome.Rejected("E_BAD_SIZE", "清单里没写文件大小，无法校验下载完整性")
        }
        val sha = entry.str("sha256").trim().lowercase()
        if (sha.length != 64 || !sha.all { it.isDigit() || it in 'a'..'f' }) {
            return Outcome.Rejected("E_BAD_HASH", "清单里的 sha256 不合法，拒绝下载")
        }
        if (assets.none { it.equals(file, ignoreCase = true) }) {
            return Outcome.Rejected(
                "E_ASSET_MISSING",
                "Release 里找不到 $file，清单和发布资产不一致",
            )
        }
        return Outcome.Ok(version, file, size, sha)
    }

    /**
     * 老发布没有清单时的兜底：只接受本平台扩展名，且名字里不能有别的平台的痕迹。
     * **只在清单缺失时走**，界面上要明说"这次发布没带清单"。
     */
    fun legacyPick(assets: List<String>, platform: String): String? {
        val exts = allowedExts(platform)
        return assets.firstOrNull { name ->
            val ext = name.substringAfterLast('.', "").lowercase()
            ext in exts && foreignType(name, platform) == null
        }
    }

    /** 从资产数组里取出名字列表（GitHub API 的形状） */
    fun assetNames(assets: JsonArray?): List<String> =
        assets?.mapNotNull { a -> (a as? JsonObject)?.str("name")?.takeIf { it.isNotEmpty() } }
            ?: emptyList()
}
