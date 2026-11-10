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
import com.qqqorange.kingoffocus.ui.Loc

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

    /** GitHub API 配额（每小时能调多少次） */
    data class Quota(val remaining: Int, val limit: Int)

    /**
     * 查一次配额。**失败返回 null 而不是抛异常**——这只是给界面显示"还能查几次"的
     * 附加信息，查不到不该让整个更新流程失败。
     */
    fun quota(token: String): Quota? = try {
        val text = getText("https://api.github.com/rate_limit", token)
        val core = json.parseToJsonElement(text).jsonObject["resources"]
            ?.jsonObject?.get("core")?.jsonObject
        val remain = core?.get("remaining")?.jsonPrimitive?.content?.toIntOrNull() ?: -1
        val limit = core?.get("limit")?.jsonPrimitive?.content?.toIntOrNull() ?: -1
        if (limit > 0) Quota(remain, limit) else null
    } catch (e: Exception) {
        null
    }

    /**
     * 把 HTTP 状态码翻译成"人话 + 该怎么办"。
     *
     * 401 / 403 是最容易让人一头雾水的两种：都只显示"HTTP 403"，
     * 用户看不出是**令牌错了**还是**被别人把配额用完了**。
     */
    fun httpMessage(code: Int, hasToken: Boolean): String? = when (code) {
        401 -> Loc.p("The GitHub token is invalid or expired — enter a new one under Version & updates", "GitHub 令牌无效或已过期，请到「版本与更新」重新填一个")
        403 -> if (hasToken) {
            Loc.p("GitHub API quota exhausted (5000/hour with a token) — try again later", "GitHub API 次数用尽（带令牌是每小时 5000 次），过一会儿再试")
        } else {
            Loc.p("GitHub API quota exhausted (anonymous calls are 60/hour and shared networks burn through them).", "GitHub API 次数用尽（匿名每小时只有 60 次，共用网络时很容易被用光）。") +
                Loc.p("A personal access token raises it to 5000/hour", "填一个个人访问令牌可以提到 5000 次")
        }
        429 -> Loc.p("Too many requests — GitHub is rate limiting; try again in a minute", "请求太频繁，被 GitHub 临时限流，过一分钟再试")
        else -> null
    }

    /** 从异常信息里认出 HTTP 状态码（getText 抛的是 "HTTP 403" 这种） */
    fun httpCodeOf(message: String?): Int? =
        Regex("HTTP (\\d{3})").find(message.orEmpty())?.groupValues?.get(1)?.toIntOrNull()

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
            val http = httpCodeOf(e.message)
            return when {
                http == 404 -> fail(
                    current, "E_NO_RELEASE", Loc.p("The repository has no published Release (only tags), so auto-update is unavailable", "仓库还没有发布 Release（只有标签），无法自动更新"),
                )
                http == 401 || http == 403 || http == 429 -> fail(
                    current,
                    if (http == 401) "E_AUTH" else "E_RATE",
                    httpMessage(http, token.isNotBlank()) ?: Loc.p("GitHub rejected the request (HTTP $http)", "GitHub 拒绝了请求（HTTP $http）"),
                )
                else -> fail(current, "E_NETWORK", Loc.p("Cannot reach GitHub: ${e.message ?: "unknown error"}", "连不上 GitHub：${e.message ?: "未知错误"}"))
            }
        }
        val rel = try {
            json.parseToJsonElement(relText).jsonObject
        } catch (e: Exception) {
            return fail(current, "E_BAD_RELEASE", Loc.p("Cannot parse the Release returned by GitHub: ${e.message}", "GitHub 返回的 Release 格式读不懂：${e.message}"))
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
                ?: return fail(current, "E_PLATFORM_MISSING", Loc.p("This release has no Android package (and no manifest)", "这次发布里没有 Android 安装包（也没有更新清单）"))
            if (Updater.compareVer(tag, current) <= 0) {
                return Result(
                    true, false, current, tag, notes, null, pick, 0, "", "",
                    Loc.p("Already up to date.", "已经是最新版本。"), "asset-scan",
                )
            }
            val url = assets?.mapNotNull { it as? JsonObject }
                ?.firstOrNull { it["name"]?.jsonPrimitive?.content == pick }
                ?.get("browser_download_url")?.jsonPrimitive?.content
            return Result(
                true, true, current, tag, notes, url, pick, 0, "", "",
                Loc.p("This release has no manifest, so verification fell back to the file name (other platforms excluded).", "这次发布没带更新清单，已按文件名兜底校验（其他平台的包一律排除）。"), "asset-scan",
            )
        }

        val manText = try {
            // 清单走的是浏览器下载地址（会 302 到 objects.githubusercontent.com），
            // **不要把令牌带过去**：令牌只该发给 api.github.com。
            // 这个地址是公开的、也不计入 API 配额，带过去只会多一次泄露面。
            getText(manUrl, "")
        } catch (e: Exception) {
            return fail(current, "E_MANIFEST_FETCH", Loc.p("Cannot read the manifest: ${e.message}", "读不到更新清单：${e.message}"))
        }
        val manifest = try {
            json.parseToJsonElement(manText).jsonObject
        } catch (e: Exception) {
            return fail(current, "E_BAD_MANIFEST", Loc.p("The manifest is malformed: ${e.message}", "更新清单格式坏了：${e.message}"))
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
            throw IllegalStateException(Loc.p("Invalid download URL", "下载地址不合法"))
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
            if (code !in 200..299) throw IllegalStateException(Loc.p("Download failed (HTTP $code)", "下载失败（HTTP $code）"))
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
                    Loc.p("Downloaded size mismatch (${done / 1024} / ${expectedSize / 1024} KB) — discarded", "下载的文件大小不符（${done / 1024} / ${expectedSize / 1024} KB），已丢弃"),
                )
            }
            if (done < 100 * 1024) {
                dest.delete()
                throw IllegalStateException(Loc.p("The downloaded file is too small — probably an error page; try again later", "下载到的文件太小，可能是错误页面，请稍后重试"))
            }
            // APK 的 zip 头：PK\x03\x04。下到 HTML 错误页时这一步会拦住
            val head = ByteArray(4)
            dest.inputStream().use { it.read(head) }
            if (!(head[0] == 0x50.toByte() && head[1] == 0x4B.toByte())) {
                dest.delete()
                throw IllegalStateException(Loc.p("The downloaded file is not an APK (zip header check failed)", "下载的文件不是 APK（zip 头校验失败）"))
            }
            if (sha256.isNotBlank()) {
                val got = sha256Of(dest)
                if (!got.equals(sha256, ignoreCase = true)) {
                    dest.delete()
                    throw IllegalStateException(
                        Loc.p("Checksum mismatch (manifest ${sha256.take(8)}… / actual ${got.take(8)}…) — deleted", "安装包校验和对不上（清单 ${sha256.take(8)}… / 实际 ${got.take(8)}…），已删除"),
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
