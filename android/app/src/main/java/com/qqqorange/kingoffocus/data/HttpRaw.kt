package com.qqqorange.kingoffocus.data

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * 极简 HTTP/1.1 客户端 —— 存在的唯一理由是：**要发 `PROPFIND`**。
 *
 * Android 的 `HttpURLConnection` 把方法名限定在
 * `[OPTIONS, GET, HEAD, POST, PUT, DELETE, TRACE, PATCH]` 里，
 * 发 PROPFIND 会直接抛：
 *
 * ```
 * ProtocolException: Expected one of [OPTIONS, GET, HEAD, POST, PUT, DELETE, TRACE, PATCH]
 *                     but was PROPFIND
 * ```
 *
 * 而 WebDAV **列目录只有 PROPFIND 这一个办法**——不做这件事，手机就只能
 * 盲传一个固定文件，看不见桌面端传上来的备份，"互通"就只剩一半。
 *
 * 引一个 WebDAV 库（OkHttp / Sardine）为了一个请求不值当，所以这里手写一条：
 * 只处理这一种场景需要的东西（请求行、头、定长或 chunked 响应、一次重定向）。
 * 不追求通用，也不该被当成通用 HTTP 客户端用。
 */
internal object HttpRaw {

    data class Response(val code: Int, val headers: Map<String, String>, val body: String)

    private val REDIRECTS = setOf(301, 302, 303, 307, 308)

    fun request(
        url: URL,
        method: String,
        headers: Map<String, String>,
        body: ByteArray? = null,
        connectTimeoutMs: Int = 12_000,
        readTimeoutMs: Int = 25_000,
    ): Response {
        var cur = url
        var hops = 0
        while (true) {
            val r = once(cur, method, headers, body, connectTimeoutMs, readTimeoutMs)
            val loc = r.headers["location"]
            if (hops < 3 && r.code in REDIRECTS && !loc.isNullOrBlank()) {
                cur = URL(cur, loc)
                hops++
                continue
            }
            return r
        }
    }

    private fun once(
        url: URL,
        method: String,
        headers: Map<String, String>,
        body: ByteArray?,
        connectTimeoutMs: Int,
        readTimeoutMs: Int,
    ): Response {
        val https = url.protocol.equals("https", true)
        val port = if (url.port > 0) url.port else if (https) 443 else 80
        val host = url.host
        val path = buildString {
            append(if (url.path.isNullOrEmpty()) "/" else url.path)
            if (!url.query.isNullOrEmpty()) append('?').append(url.query)
        }

        var sock: Socket = Socket()
        sock.connect(InetSocketAddress(host, port), connectTimeoutMs)
        sock.soTimeout = readTimeoutMs
        if (https) {
            val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory)
                .createSocket(sock, host, port, true) as SSLSocket
            // 不做主机名校验的 TLS 等于没有 TLS：这里显式打开，证书不对就握手失败
            val p = ssl.sslParameters
            p.endpointIdentificationAlgorithm = "HTTPS"
            ssl.sslParameters = p
            ssl.startHandshake()
            sock = ssl
        }

        sock.use { s ->
            val out = BufferedOutputStream(s.getOutputStream())
            val head = StringBuilder()
            head.append(method).append(' ').append(path).append(" HTTP/1.1\r\n")
            head.append("Host: ").append(if (port == 80 || port == 443) host else "$host:$port").append("\r\n")
            for ((k, v) in headers) head.append(k).append(": ").append(v).append("\r\n")
            if (body != null) head.append("Content-Length: ").append(body.size).append("\r\n")
            head.append("Connection: close\r\n\r\n")
            out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
            if (body != null) out.write(body)
            out.flush()

            val input = BufferedInputStream(s.getInputStream())
            val status = readLine(input)
                ?: throw IllegalStateException("服务器没有返回任何内容")
            val code = status.split(' ').getOrNull(1)?.toIntOrNull()
                ?: throw IllegalStateException("看不懂服务器返回的状态行：$status")

            val hs = LinkedHashMap<String, String>()
            while (true) {
                val line = readLine(input) ?: break
                if (line.isEmpty()) break
                val i = line.indexOf(':')
                if (i > 0) {
                    hs[line.substring(0, i).trim().lowercase()] = line.substring(i + 1).trim()
                }
            }
            return Response(code, hs, readBody(input, hs))
        }
    }

    /** 逐字节读到 CRLF（不能用 BufferedReader：它会把二进制响应也当文本解码） */
    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(b.toChar())
        }
    }

    private fun readBody(input: InputStream, headers: Map<String, String>): String {
        val te = headers["transfer-encoding"].orEmpty().lowercase()
        if (te.contains("chunked")) {
            val sb = StringBuilder()
            while (true) {
                val line = readLine(input) ?: break
                val n = line.trim().substringBefore(';').toIntOrNull(16) ?: break
                if (n <= 0) {
                    readLine(input) // 结尾那个空行
                    break
                }
                sb.append(String(readN(input, n), Charsets.UTF_8))
                readLine(input) // chunk 后的 CRLF
            }
            return sb.toString()
        }
        val len = headers["content-length"]?.toLongOrNull()
        if (len != null) {
            if (len <= 0) return ""
            if (len > 16L * 1024 * 1024) throw IllegalStateException("响应太大（$len 字节）")
            return String(readN(input, len.toInt()), Charsets.UTF_8)
        }
        // 没有长度也没有 chunked：读到断开为止（我们发的就是 Connection: close）
        return input.readBytes().toString(Charsets.UTF_8)
    }

    private fun readN(input: InputStream, n: Int): ByteArray {
        val buf = ByteArray(n)
        var read = 0
        while (read < n) {
            val r = input.read(buf, read, n - read)
            if (r < 0) break
            read += r
        }
        return if (read == n) buf else buf.copyOf(read)
    }
}
