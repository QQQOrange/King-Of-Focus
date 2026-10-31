package com.qqqorange.kingoffocus.data

import com.qqqorange.kingoffocus.data.CloudCfg
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

/**
 * WebDAV 云同步（和桌面端同一套做法：PUT / GET + 比时间戳）。
 *
 * 为什么不共用桌面端那个文件名：两端的 `config.json` **结构不同**（桌面是
 * 完整的 Windows 配置，手机是另一套字段），共用一份会把对方写坏。
 * 所以手机端固定用 `kof-android.json`，同一个 WebDAV 目录下各放各的，
 * 想要跨端搬配置请用「备份与恢复」（`.kofbak`，那是真正格式统一的）。
 *
 * 冲突策略与桌面一致：比 `updatedAt`，新的覆盖旧的；一样就跳过。
 */
object CloudSync {

    const val FILE_NAME = "kof-android.json"

    sealed class Outcome {
        data class Ok(val text: String? = null) : Outcome()
        data class Err(val message: String) : Outcome()
    }

    /** 谁该覆盖谁 */
    enum class Side { LOCAL, REMOTE, SAME }

    fun decide(localUpdatedAt: Long, remoteUpdatedAt: Long): Side = when {
        remoteUpdatedAt > localUpdatedAt -> Side.REMOTE
        localUpdatedAt > remoteUpdatedAt -> Side.LOCAL
        else -> Side.SAME
    }

    private fun target(cfg: CloudCfg): URL {
        val base = cfg.url.trim()
        if (base.isEmpty()) throw IllegalArgumentException("还没填 WebDAV 地址")
        if (!base.startsWith("https://") && !base.startsWith("http://")) {
            throw IllegalArgumentException("地址要以 http:// 或 https:// 开头")
        }
        return URL(if (base.endsWith("/")) base + FILE_NAME else "$base/$FILE_NAME")
    }

    private fun open(cfg: CloudCfg, method: String): HttpURLConnection {
        val conn = target(cfg).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 12_000
        conn.readTimeout = 25_000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "King-Of-Focus-Android")
        if (cfg.user.isNotBlank() || cfg.pass.isNotBlank()) {
            val raw = "${cfg.user}:${cfg.pass}"
            val b64 = Base64.getEncoder().encodeToString(raw.toByteArray(Charsets.UTF_8))
            conn.setRequestProperty("Authorization", "Basic $b64")
        }
        return conn
    }

    fun upload(cfg: CloudCfg, body: String): Outcome = try {
        val conn = open(cfg, "PUT")
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        val bytes = body.toByteArray(Charsets.UTF_8)
        conn.setFixedLengthStreamingMode(bytes.size)
        conn.outputStream.use { it.write(bytes) }
        val code = conn.responseCode
        conn.disconnect()
        if (code in 200..299) Outcome.Ok() else Outcome.Err(describe(code, "上传"))
    } catch (e: IllegalArgumentException) {
        Outcome.Err(e.message ?: "地址不合法")
    } catch (e: IOException) {
        Outcome.Err("连不上服务器：${e.message}")
    }

    fun download(cfg: CloudCfg): Outcome = try {
        val conn = open(cfg, "GET")
        val code = conn.responseCode
        if (code == 404) {
            conn.disconnect()
            Outcome.Err("云端还没有这笔配置（先上传一次）")
        } else if (code in 200..299) {
            val text = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            conn.disconnect()
            Outcome.Ok(text)
        } else {
            conn.disconnect()
            Outcome.Err(describe(code, "下载"))
        }
    } catch (e: IllegalArgumentException) {
        Outcome.Err(e.message ?: "地址不合法")
    } catch (e: IOException) {
        Outcome.Err("连不上服务器：${e.message}")
    }

    /** 目录能不能写：先 PUT 一个空壳再删，成功就说明账号权限够 */
    fun testConnection(cfg: CloudCfg): Outcome {
        val probe = """{"probe":true}"""
        return when (val r = upload(cfg, probe)) {
            is Outcome.Err -> r
            is Outcome.Ok -> {
                runCatching {
                    val conn = open(cfg, "DELETE")
                    conn.responseCode
                    conn.disconnect()
                }
                Outcome.Ok()
            }
        }
    }

    private fun describe(code: Int, what: String): String = when (code) {
        401, 403 -> "$what 失败：账号或密码不对（HTTP $code）"
        404 -> "$what 失败：路径不存在（HTTP 404）"
        405 -> "$what 失败：服务器不允许这种操作（HTTP 405）"
        409 -> "$what 失败：上级目录不存在（HTTP 409）"
        507 -> "$what 失败：云端空间不足（HTTP 507）"
        else -> "$what 失败：HTTP $code"
    }
}
