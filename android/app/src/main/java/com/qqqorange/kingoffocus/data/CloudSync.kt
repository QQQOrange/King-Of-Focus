package com.qqqorange.kingoffocus.data

import java.io.IOException
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Base64
import java.util.Date
import java.util.Locale
import com.qqqorange.kingoffocus.ui.Loc

/**
 * WebDAV 云同步 —— **跨端互通走的就是这一条**。
 *
 * ## 为什么不各传各的 JSON
 *
 * 以前手机端固定上传 `kof-android.json`（手机自己的 `Config` 序列化），桌面端同步的是
 * `king-of-focus.json`（桌面的 `Config`）。两份文件、两套结构，**互相读不了**：
 * 手机上排好的时段，桌面上永远看不到。
 *
 * 真正两端都认的只有一种东西：**跨设备备份文档**（`Portable`，`kof-portable` schema 1），
 * 也就是桌面的 `.kofbak`。所以这里把它当成同步载荷：
 *
 * | 动作 | 服务器上的东西 | 另一端 |
 * |---|---|---|
 * | 手机上传 | `kof-<时间>-android.kofbak` | 桌面在「备份 → 云端」里能看到并恢复 |
 * | 桌面备份 | `kof-<时间>.kofbak` | 手机在列表里能看到并恢复 |
 *
 * 这不只是"能互通"，还是**唯一不需要改格式**的做法：桌面端的 `cloud_list` /
 * `cloud_restore` 早就在以 `.kofbak` 为单位工作了。
 *
 * ## 为什么是快照而不是"实时覆盖一份文件"
 *
 * 一份快照 = 一个明确的时间点：坏了能回退，有冲突时能选「合并」还是「覆盖」。
 * 实时覆盖同一份文件的话，任何一次误操作都会同时毁掉两台设备上的配置。
 * 想省事可以用「自动备份」：它只覆盖固定名字那一份，不会堆出一堆。
 */
object CloudSync {

    /** 与桌面端 `backup::EXT` 一致 */
    const val EXT = ".kofbak"
    private const val PREFIX = "kof-"
    /** 手机上传的文件名都带这个标记：桌面端据此标来源，并跳过清理 */
    const val TAG_ANDROID = "android"
    /** 自动备份用的固定名字：覆盖写，不堆积 */
    const val AUTO_NAME = "kof-auto-android.kofbak"

    private val stampFmt = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)
    private val showFmt = SimpleDateFormat("MM-dd HH:mm", Locale.US)

    /** 云端的一份备份 */
    data class Entry(
        val name: String,
        val href: String,
        val size: Long,
        /** 服务器给的 Last-Modified（原样显示，解析不出就用它兜底） */
        val modified: String,
        /** 从文件名解析出的时间戳（秒）；解析失败为 0 */
        val at: Long,
    ) {
        val fromAndroid: Boolean get() = name.contains("-$TAG_ANDROID")
        val auto: Boolean get() = name.startsWith("kof-auto-")
        val sourceLabel: String get() = if (fromAndroid) Loc.p("Phone", "手机") else Loc.p("Desktop", "桌面")
        val timeLabel: String get() = when {
            auto -> if (at > 0) showFmt.format(Date(at * 1000)) else Loc.p("Auto backup", "自动备份")
            at > 0 -> showFmt.format(Date(at * 1000))
            modified.isNotBlank() -> modified
            else -> name
        }
    }

    sealed class Outcome {
        data class Ok(val text: String? = null, val entries: List<Entry> = emptyList()) : Outcome()
        data class Err(val message: String) : Outcome()
    }

    /** 谁该覆盖谁（比更新时间；「自动备份」按这个决定要不要传） */
    enum class Side { LOCAL, REMOTE, SAME }

    fun decide(localUpdatedAt: Long, remoteUpdatedAt: Long): Side = when {
        remoteUpdatedAt > localUpdatedAt -> Side.REMOTE
        localUpdatedAt > remoteUpdatedAt -> Side.LOCAL
        else -> Side.SAME
    }

    // ------------------------------------------------------------ 文件名

    fun isBackup(name: String): Boolean = name.endsWith(EXT) && !name.contains('/')

    /** `kof-20261031-210000-android.kofbak`；`source` 留空则与桌面端同形 */
    fun backupName(now: Long = System.currentTimeMillis(), source: String = TAG_ANDROID): String {
        val stamp = stampFmt.format(Date(now))
        val tag = if (source.isBlank()) "" else "-$source"
        return "$PREFIX$stamp$tag$EXT"
    }

    /**
     * 从文件名里抠出时间戳。
     *
     * 桌面端的名字是 `kof-20261031-210000.kofbak`，手机端多一段 `-android`。
     * 两段都要认——否则手机端会把自己传的那几份排到最后（看起来像"没传上去"）。
     */
    /**
     * 默认 WebDAV 目录。**必须与桌面端 `model::DEFAULT_SYNC_URL` 一模一样**——
     * 两端同一串字符，用户在一台机器上什么都不填，另一台也能看到同一批备份。
     *
     * 以前默认地址只写进了设置页输入框的 placeholder（灰字），配置里还是空串：
     * 用户看着"地址有了"，一点上传就报"还没填 WebDAV 地址"。
     */
    const val DEFAULT_URL = "https://dav.jianguoyun.com/dav/KingOfFocus/"

    /** 实际生效的地址：配置里空/空白 → 默认（与桌面端 `sync::url_of` 同义） */
    fun urlOf(cfg: CloudCfg): String {
        val u = cfg.url.trim()
        return if (u.isEmpty()) DEFAULT_URL else u
    }

    fun stampOf(name: String): Long {
        if (!name.startsWith(PREFIX)) return 0
        val body = name.removePrefix(PREFIX).removeSuffix(EXT)
        // 时间戳固定 15 个字符：yyyyMMdd-HHmmss
        val head = body.take(15)
        return runCatching { stampFmt.parse(head)?.time?.div(1000) ?: 0L }.getOrDefault(0L)
    }

    /** 云端最新的一份（时间倒序第一条）；空列表 → null */
    fun latest(entries: List<Entry>): Entry? = sortDesc(entries).firstOrNull()

    /**
     * 手动备份的清理目标（**只删本机传的**）。
     *
     * 与桌面端 `backup::prune_targets` 同一个思路：
     *  · 桌面传的（`fromAndroid = false`）一律不动——那是另一台机器的备份；
     *  · 自动备份（固定名覆盖）不动——它本来就不堆积；
     *  · 本机手动传的，只保留最近 [keep] 份。
     *
     * 不清理的话，每次点「上传本机」都会多一份，几个月后云端几十个同名不同时间的
     * 文件，用户根本分不清哪份是现在用的。
     */
    fun pruneTargets(entries: List<Entry>, keep: Int = KEEP_MANUAL): List<String> {
        val mine = sortDesc(entries).filter { it.fromAndroid && !it.auto }
        return mine.drop(keep.coerceAtLeast(1)).map { it.name }
    }

    /** 手动备份保留份数（与桌面端 KEEP_COUNT 同量级） */
    const val KEEP_MANUAL = 5

    /** 时间新的在前；同时间按名字，保证刷新时顺序不跳动 */
    fun sortDesc(list: List<Entry>): List<Entry> =
        list.sortedWith(compareByDescending<Entry> { it.at }.thenByDescending { it.name })

    // ------------------------------------------------------------ HTTP

    private fun base(cfg: CloudCfg): String {
        // 空 = 默认地址（不再抛"还没填地址"：那句报错以前在默认值缺失时必现）
        val url = urlOf(cfg)
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
            throw IllegalArgumentException(Loc.p("The address must start with http:// or https:// : $url", "地址要以 http:// 或 https:// 开头：$url"))
        }
        return if (url.endsWith("/")) url else "$url/"
    }

    /**
     * 逐一补建目录（MKCOL），**失败不报错**。
     *
     * 默认地址带一层子目录（`/dav/KingOfFocus/`），而 WebDAV 的 PUT 不会自动建父目录，
     * 目录不在时服务端回 409 → 用户看到"上传失败"，却不知道要自己去网盘里建文件夹。
     * 桌面端 `net::ensure_dir` 做的是同一件事。
     */
    private fun ensureDir(cfg: CloudCfg) {
        val b = base(cfg)
        val hostEnd = b.indexOf("://") + 3
        val pathStart = b.indexOf('/', hostEnd)
        if (hostEnd < 3 || pathStart < 0) return
        val head = b.substring(0, pathStart + 1)
        val segs = b.substring(pathStart + 1).split('/').filter { it.isNotEmpty() }
        var acc = head
        for (seg in segs) {
            acc += seg + "/"
            runCatching {
                HttpRaw.request(URL(acc), "MKCOL", headers(cfg), null)
            }
        }
    }

    /** 文件名要编码：中文目录、空格、括号都会把 URL 弄坏 */
    private fun urlFor(cfg: CloudCfg, name: String): URL {
        val enc = URLEncoder.encode(name, "UTF-8").replace("+", "%20")
        return URL(base(cfg) + enc)
    }

    private fun headers(cfg: CloudCfg, extra: Map<String, String> = emptyMap()): Map<String, String> {
        val h = LinkedHashMap<String, String>()
        h["User-Agent"] = "King-Of-Focus-Android"
        h["Accept"] = "*/*"
        if (cfg.user.isNotBlank() || cfg.pass.isNotBlank()) {
            val raw = "${cfg.user}:${cfg.pass}"
            h["Authorization"] = "Basic " +
                Base64.getEncoder().encodeToString(raw.toByteArray(Charsets.UTF_8))
        }
        h.putAll(extra)
        return h
    }

    /**
     * 统一把异常翻成一句人话。
     *
     * 网络错误有好几种（DNS、超时、证书、明文被拦），`toString()` 里全是类名，
     * 用户看到只会以为是软件坏了。
     */
    private fun wrap(what: String, block: () -> Outcome): Outcome = try {
        block()
    } catch (e: IllegalArgumentException) {
        Outcome.Err(e.message ?: Loc.p("Invalid address", "地址不合法"))
    } catch (e: IOException) {
        Outcome.Err(Loc.p("Cannot reach the server: ${e.message ?: e.javaClass.simpleName}", "连不上服务器：${e.message ?: e.javaClass.simpleName}"))
    } catch (e: Exception) {
        Outcome.Err(Loc.p("$what failed: ${e.message ?: e.javaClass.simpleName}", "$what 失败：${e.message ?: e.javaClass.simpleName}"))
    }

    /**
     * 列出目录里的所有 `.kofbak`（含桌面端传的）。
     *
     * `PROPFIND Depth: 1` 是 WebDAV 列目录的标准做法，坚果云 / Nextcloud / Synology
     * 都支持；返回 207 Multi-Status。请求走 [HttpRaw]——`HttpURLConnection`
     * 不接受 PROPFIND 这个方法名。
     */
    fun list(cfg: CloudCfg): Outcome = wrap(Loc.p("List", "列目录")) {
        // 先确保目录存在。首次使用默认地址时目录还没建，PROPFIND 会直接 404 ——
        // 那会让"第一次点同步"永远失败，用户只能自己去网盘里手动建文件夹。
        ensureDir(cfg)
        val body = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop>
<d:getcontentlength/><d:getlastmodified/>
</d:prop></d:propfind>"""
        val r = HttpRaw.request(
            URL(base(cfg)),
            "PROPFIND",
            headers(
                cfg,
                mapOf(
                    "Depth" to "1",
                    "Content-Type" to "application/xml; charset=utf-8",
                ),
            ),
            body.toByteArray(Charsets.UTF_8),
        )
        if (r.code !in 200..299) {
            Outcome.Err(describe(r.code, Loc.p("List", "列目录")))
        } else {
            Outcome.Ok(entries = sortDesc(parseMultiStatus(r.body)))
        }
    }

    fun put(cfg: CloudCfg, name: String, body: String): Outcome = wrap(Loc.p("Upload", "上传")) {
        if (!isBackup(name)) throw IllegalArgumentException(Loc.p("Invalid file name", "文件名不合法"))
        ensureDir(cfg)
        val r = HttpRaw.request(
            urlFor(cfg, name),
            "PUT",
            headers(cfg, mapOf("Content-Type" to "application/octet-stream")),
            body.toByteArray(Charsets.UTF_8),
        )
        if (r.code in 200..299) Outcome.Ok() else Outcome.Err(describe(r.code, Loc.p("Upload", "上传")))
    }

    fun get(cfg: CloudCfg, name: String): Outcome = wrap(Loc.p("Download", "下载")) {
        if (!isBackup(name)) throw IllegalArgumentException(Loc.p("Invalid file name", "文件名不合法"))
        val r = HttpRaw.request(urlFor(cfg, name), "GET", headers(cfg), null)
        if (r.code in 200..299) Outcome.Ok(r.body) else Outcome.Err(describe(r.code, Loc.p("Download", "下载")))
    }

    fun delete(cfg: CloudCfg, name: String): Outcome = wrap(Loc.p("Delete", "删除")) {
        if (!isBackup(name)) throw IllegalArgumentException(Loc.p("Invalid file name", "文件名不合法"))
        val r = HttpRaw.request(urlFor(cfg, name), "DELETE", headers(cfg), null)
        if (r.code in 200..299) Outcome.Ok() else Outcome.Err(describe(r.code, Loc.p("Delete", "删除")))
    }

    /**
     * 目录能不能读写：PUT 一个探针再删掉。
     *
     * 只做 GET/PROPFIND 不够——有些网盘挂了只读账号，列表能看、上传全 403，
     * 用户会在Loc.p("Upload", "上传")那一刻才发现。
     */
    fun testConnection(cfg: CloudCfg): Outcome {
        val probe = """{"probe":true}"""
        val name = backupName(source = "probe")
        return when (val r = put(cfg, name, probe)) {
            is Outcome.Err -> r
            is Outcome.Ok -> {
                // 删不掉不算失败：能写不能删的账号照样能用，只是清理得自己来
                delete(cfg, name)
                Outcome.Ok()
            }
        }
    }

    // ------------------------------------------------------------ XML

    /**
     * 解析 207 Multi-Status。
     *
     * 手写解析而不是引 XML 库，原因和 `Portable` 一样：这里只要三个字段，而不同服务器
     * 的命名空间前缀（`d:` `D:` `lp1:` 或干脆没有）差别很大，正则比"先猜命名空间"稳。
     */
    fun parseMultiStatus(xml: String): List<Entry> {
        val out = ArrayList<Entry>()
        val blocks = Regex(
            "<(?:[\\w.-]+:)?response\\b[\\s\\S]*?</(?:[\\w.-]+:)?response>",
            RegexOption.IGNORE_CASE,
        ).findAll(xml)
        for (b in blocks) {
            val s = b.value
            val href = Regex(
                "<(?:[\\w.-]+:)?href\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?href>",
                RegexOption.IGNORE_CASE,
            ).find(s)?.groupValues?.getOrNull(1)?.trim().orEmpty()
            if (href.isEmpty()) continue
            // 目录本身（以 / 结尾）不是备份
            val raw = href.trimEnd('/').substringAfterLast('/')
            val name = decode(raw)
            if (!isBackup(name)) continue
            val size = Regex(
                "<(?:[\\w.-]+:)?getcontentlength\\b[^>]*>(\\d+)<",
                RegexOption.IGNORE_CASE,
            ).find(s)?.groupValues?.getOrNull(1)?.toLongOrNull() ?: 0L
            val modified = Regex(
                "<(?:[\\w.-]+:)?getlastmodified\\b[^>]*>([^<]*)<",
                RegexOption.IGNORE_CASE,
            ).find(s)?.groupValues?.getOrNull(1)?.trim().orEmpty()
            out += Entry(name = name, href = href, size = size, modified = modified, at = stampOf(name))
        }
        // 有的服务器把同一个文件列两次（按 href 和按 displayname）
        return out.distinctBy { it.name }
    }

    /** href 里的文件名可能是百分号编码的；`+` 在路径里是字面量，不能解成空格 */
    private fun decode(s: String): String = runCatching {
        URLDecoder.decode(s.replace("+", "%2B"), "UTF-8")
    }.getOrDefault(s)

    private fun describe(code: Int, what: String): String = when (code) {
        401, 403 -> Loc.p("$what failed: wrong account or password (HTTP $code)", "$what 失败：账号或密码不对（HTTP $code）")
        404 -> Loc.p("$what failed: path not found (HTTP 404)", "$what 失败：路径不存在（HTTP 404）")
        405 -> Loc.p("$what failed: the server does not allow this (HTTP 405)", "$what 失败：服务器不允许这种操作（HTTP 405）")
        409 -> Loc.p("$what failed: parent folder missing (HTTP 409)", "$what 失败：上级目录不存在（HTTP 409）")
        507 -> Loc.p("$what failed: no space left in the cloud (HTTP 507)", "$what 失败：云端空间不足（HTTP 507）")
        else -> Loc.p("$what failed: HTTP $code", "$what 失败：HTTP $code")
    }
}
