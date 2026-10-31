package com.qqqorange.kingoffocus.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * 更新检测的"跑腿"部分：发 HTTP、读清单、下包、算哈希。
 *
 * 判定逻辑一行都不在这里——全在 [Updater]（纯函数、有单测）。这里只干三件事：
 *  1. 取 `/releases/latest`，找到**同一个 Release** 里的更新清单；
 *  2. 把清单交给 [Updater.select]，拿它的结论；
 *  3. 下载并按清单核对大小 + sha256。
 *
 * 刻意不做的事：**不扫资产列表找"看起来像 apk 的文件"**。桌面端以前就是这么干的，
 * 一旦同一个 Release 里混了别的平台的包，迟早会挑错。
 */
object UpdateClient {

    private const val UA = "King-Of-Focus-Android"
    private val json = Json { ignoreUnknownKeys = true }

    data class Result(
        val ok: Boolean,
        val hasUpdate: Boolean,
        val current: String,
        val latest: String,
        val notes: String,
        /** 下载地址；没有可安装的包时为 null */
        val url: String?,
        val file: String,
        val size: Long,
        val sha256: String,
        /** 失败时的稳定错误码（成功时为空串） */
        val code: String,
        /** 给人看的一句话 */
        val message: String,
        val source: String,
    )

    private fun fail(current: String, code: String, message: String): Result = Result(
        ok = false, hasUpdate = false, current = current, latest = "", notes = "",
        url = null, file = "", size = 0, sha256 = "", code = code, message = message,
        source = "manifest",
    )

    /** 检查更新。任何异常都转成一条人能读懂的话，不往外抛。 */
    fun check(repo: String, current: String, token: String = ""): Result {
        val r = repo.trim().ifEmpty { "QQQOrange/King-Of-Focus" }
        val relUrl = "https://api.github.com/repos/$r/releases/latest"
        val relText = try {
            getText(relUrl, token)
        } catch (e: Exception) {
            // 404 = 还没发 Release（只有 tag）。这种情况明确说清楚，不要伪装成"已是最新"。
            return if (e.message?.contains("404") == true) {
                fail(current, "E_NO_RELEASE", "仓库还没有发布 Release（只有标签），无法自动更新")
            } else {
                fail(current, "E_NETWORK", "连不上 GitHub：${e.message ?: "未知错误"}")
            }
        }
        val rel = try {
            json.parseToJsonElement(relText).jsonObject
        } catch (e: Exception) {
            return fail(current, "E_BAD_RELEASE", "GitHub 返回的 Release 格式读不懂：${e.message}")
        }

        val tag = rel["tag_name"]?.jsonPrimitive?.content.orEmpty()
        val notes = rel["body"]?.jsonPrimitive?.content.orEmpty()
        val assets = rel["assets"]?.jsonArray
        val names = Updater.assetNames(assets)

        // 清单资产 → 它的下载地址
        val manUrl = assets
            ?.mapNotNull { it as? JsonObject }
            ?.firstOrNull {
                it["name"]?.jsonPrimitive?.content
                    ?.equals(Updater.MANIFEST_NAME, ignoreCase = true) == true
            }
            ?.get("browser_download_url")?.jsonPrimitive?.content

        if (manUrl.isNullOrBlank()) {
            // 老发布兜底：只认 apk，且排除别的平台的包
            val pick = Updater.legacyPick(names, Updater.PLATFORM)
                ?: return fail(current, "E_PLATFORM_MISSING", "这次发布里没有 Android 安装包（也没有更新清单）")
            if (Updater.compareVer(tag, current) <= 0) {
                return Result(
                    true, false, current, tag, notes, null, pick, 0, "", "",
                    "已经是最新版本。", "asset-scan",
                )
            }
            val url = assets?.mapNotNull { it as? JsonObject }
                ?.firstOrNull { it["name"]?.jsonPrimitive?.content == pick }
                ?.get("browser_download_url")?.jsonPrimitive?.content
            return Result(
                true, true, current, tag, notes, url, pick, 0, "", "",
                "这次发布没带更新清单，已按文件名兜底校验（其他平台的包一律排除）。", "asset-scan",
            )
        }

        val manText = try {
            getText(manUrl, token)
        } catch (e: Exception) {
            return fail(current, "E_MANIFEST_FETCH", "读不到更新清单：${e.message}")
        }
        val manifest = try {
            json.parseToJsonElement(manText).jsonObject
        } catch (e: Exception) {
            return fail(current, "E_BAD_MANIFEST", "更新清单格式坏了：${e.message}")
        }

        return when (val out = Updater.select(manifest, Updater.PLATFORM, current, names)) {
            is Updater.Outcome.Ok -> {
                val url = assets?.mapNotNull { it as? JsonObject }
                    ?.firstOrNull { it["name"]?.jsonPrimitive?.content?.equals(out.file, true) == true }
                    ?.get("browser_download_url")?.jsonPrimitive?.content
                Result(
                    ok = true, hasUpdate = true, current = current, latest = out.version,
                    notes = notes, url = url, file = out.file, size = out.size,
                    sha256 = out.sha256, code = "", message = "", source = "manifest",
                )
            }
            is Updater.Outcome.NoUpdate -> Result(
                ok = true, hasUpdate = false, current = current, latest = out.latest,
                notes = notes, url = null, file = "", size = 0, sha256 = "",
                code = "", message = "已经是最新版本。", source = "manifest",
            )
            is Updater.Outcome.Rejected -> fail(current, out.code, out.message)
        }
    }

    /**
     * 下载并校验。**大小不对或哈希不对一律删文件并报错**——
     * 这是防止"装上一个不属于本平台的包"的最后一道闸。
     */
    fun download(
        url: String,
        dest: File,
        expectedSize: Long,
        sha256: String,
        onProgress: (Long, Long) -> Unit = { _, _ -> },
    ): File {
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            throw IllegalStateException("下载地址不合法")
        }
        dest.parentFile?.mkdirs()
        if (dest.exists()) dest.delete()

        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 60_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", UA)
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("下载失败（HTTP $code）")
            val total = conn.contentLengthLong.takeIf { it > 0 } ?: expectedSize
            var done = 0L
            var lastReport = 0L
            conn.inputStream.use { input ->
                dest.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        done += n
                        val now = System.currentTimeMillis()
                        if (now - lastReport > 200) {
                            lastReport = now
                            onProgress(done, total)
                        }
                    }
                    out.flush()
                }
            }
            onProgress(done, total)
            if (expectedSize > 0 && done != expectedSize) {
                dest.delete()
                throw IllegalStateException(
                    "下载的文件大小不符（${done / 1024} / ${expectedSize / 1024} KB），已丢弃",
                )
            }
            if (done < 100 * 1024) {
                dest.delete()
                throw IllegalStateException("下载到的文件太小，可能是错误页面，请稍后重试")
            }
            // APK 的 zip 头：PK\x03\x04。下到 HTML 错误页时这一步会拦住
            val head = ByteArray(4)
            dest.inputStream().use { it.read(head) }
            if (!(head[0] == 0x50.toByte() && head[1] == 0x4B.toByte())) {
                dest.delete()
                throw IllegalStateException("下载的文件不是 APK（zip 头校验失败）")
            }
            if (sha256.isNotBlank()) {
                val got = sha256Of(dest)
                if (!got.equals(sha256, ignoreCase = true)) {
                    dest.delete()
                    throw IllegalStateException(
                        "安装包校验和对不上（清单 ${sha256.take(8)}… / 实际 ${got.take(8)}…），已删除",
                    )
                }
            }
            return dest
        } finally {
            conn.disconnect()
        }
    }

    fun sha256Of(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n <= 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    private fun getText(url: String, token: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 12_000
            readTimeout = 20_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", UA)
            setRequestProperty("Accept", "application/vnd.github+json")
            if (token.isNotBlank()) setRequestProperty("Authorization", "Bearer ${token.trim()}")
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            return conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }
}
