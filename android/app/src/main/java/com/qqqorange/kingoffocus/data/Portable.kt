package com.qqqorange.kingoffocus.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * 跨设备备份（和桌面端同一份格式）。
 *
 * ## 为什么用 JsonObject 而不是 data class
 * 这个文件要读的是**桌面端写出来的**文档：字段比手机端多得多（规则自己的时段表、
 * 锁定方式、网站名单、自启动清单……）。用 data class 意味着每加一个字段就得
 * 两端一起改，而且忽略不掉未知键的嵌套结构。直接走 JsonObject：认识的键取值、
 * 不认识的键原样留着，升级天然向后兼容。
 *
 * ## 三条和桌面端对齐的硬约束（BackupFormat 的语义在两边必须逐字一致）
 * 1. **只读自己认识的字段**，缺的用默认值。
 * 2. **覆盖** = 文档里有的换掉，文档里没有的本机设置不动
 *    （拦截页文案这类手机专属项不会被桌面备份擦掉）。
 * 3. **合并只做加法**：同 id 或同内容跳过、同名不同内容改名并列、时段只补空着的、
 *    积分取较大值。
 *
 * 格式与字段说明见仓库 `docs/backup-format.md`；样例见 `tools/fixtures/`，
 * 桌面端（`src-tauri/src/portable.rs`）和这里读的是同一份文件。
 */
object Portable {
    const val KOF = "king-of-focus"
    const val FORMAT = "kof-portable"
    const val SCHEMA = 1

    /** 写入时用的迭代次数（读取一律以文件里的 `iter` 为准） */
    const val ITER = 600_000
    private const val ITER_MIN = 10_000
    private const val ITER_MAX = 4_000_000
    private val AAD = "king-of-focus-portable-v1".toByteArray(Charsets.UTF_8)

    private val pretty = Json { prettyPrint = true }

    // ---------------------------------------------------------------- 读写

    /** 把当前配置导出成文档 */
    fun toDoc(
        cfg: Config,
        device: String,
        appVersion: String,
        now: Long = System.currentTimeMillis() / 1000,
    ): JsonObject = buildJsonObject {
        put("kof", KOF)
        put("format", FORMAT)
        put("schema", SCHEMA)
        put("createdAt", now)
        put("source", "android")
        put("device", device)
        put("appVersion", appVersion)
        put("rules", JsonArray(cfg.rules.map { ruleToDoc(it) }))
        put(
            "clock",
            buildJsonObject {
                // 手机端只有一个「自律总开关」＋一张 7×24 表，映射到桌面端
                // 的"当前生效方案"上：enabled 就是时段总开关
                put("enabled", cfg.enabled)
                put("applyRules", true)
                put("granularity", 60)
                put("active", PHONE_PROFILE_ID)
                put(
                    "profiles",
                    JsonArray(
                        listOf(
                            buildJsonObject {
                                put("id", PHONE_PROFILE_ID)
                                put("name", "手机时段")
                                put("defWork", cfg.defWork)
                                put("defBrk", cfg.defBrk)
                                put(
                                    "days",
                                    JsonArray(
                                        cfg.days.map { day ->
                                            JsonArray(
                                                day.map { h ->
                                                    buildJsonObject {
                                                        put("on", h.on)
                                                        put("work", h.work)
                                                        put("brk", h.brk)
                                                        put("from", h.from)
                                                        put("to", h.to)
                                                    }
                                                },
                                            )
                                        },
                                    ),
                                )
                                put("bound", JsonArray(emptyList()))
                            },
                        ),
                    ),
                )
            },
        )
        put(
            "points",
            buildJsonObject {
                put("balance", cfg.points)
                put("totalEarned", cfg.points)
                put("unlockUntil", cfg.unlockUntil)
            },
        )
        put(
            "settings",
            buildJsonObject {
                put("lang", "zh-CN")
                put("theme", "system")
                put(
                    "notify",
                    buildJsonObject {
                        put("enabled", cfg.notify.enabled)
                        put("workBefore", cfg.notify.workBefore)
                        put("breakBefore", cfg.notify.breakBefore)
                        put("breakNotify", cfg.notify.breakNotify)
                    },
                )
            },
        )
    }

    /** 文档 → 文本（写盘前的内容） */
    fun render(doc: JsonObject): String = pretty.encodeToString(JsonObject.serializer(), doc)

    /**
     * 解析文本：新格式文档、桌面端老格式（整份 Config）都认。
     *
     * 老格式没有 `kof` 标记，但键名一样（`rules` / `settings.focusClock` / `points`），
     * 所以抬成同一套读取逻辑；差别只在"老格式的覆盖是整份替换"，
     * 这里用 `legacy` 标出来给上层决定。
     */
    fun parse(text: String): Parsed {
        val v = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject
            ?: throw IllegalArgumentException("这不是备份文件：内容不是合法的 JSON")
        if (v.str("kof") == KOF) {
            val schema = v.int("schema", SCHEMA)
            if (schema > SCHEMA) {
                throw IllegalArgumentException("这份备份来自更新的版本（schema $schema），请先升级本应用")
            }
            return Parsed(v, false)
        }
        val hasRules = v["rules"] is JsonArray || v["lists"] is JsonArray
        if (v["settings"] is JsonObject && hasRules) {
            return Parsed(legacyToDoc(v), true)
        }
        throw IllegalArgumentException("这不是 King Of Focus 的备份文件")
    }

    /** 老格式（桌面端整份 Config）抬成文档 */
    private fun legacyToDoc(v: JsonObject): JsonObject = buildJsonObject {
        put("kof", KOF)
        put("format", FORMAT)
        put("schema", SCHEMA)
        put("createdAt", v.long("updatedAt", 0))
        put("source", "desktop")
        put("device", "")
        put("appVersion", "")
        put("rules", (v["rules"] ?: v["lists"]) ?: JsonArray(emptyList()))
        val st = v["settings"] as? JsonObject
        put("clock", st?.get("focusClock") ?: JsonObject(emptyMap()))
        put("points", v["points"] ?: JsonObject(emptyMap()))
        put(
            "settings",
            buildJsonObject {
                put("lang", st?.str("lang") ?: "zh-CN")
                put("theme", st?.str("theme") ?: "system")
                put("notify", st?.get("notify") ?: JsonObject(emptyMap()))
            },
        )
    }

    // ---------------------------------------------------------------- 覆盖

    /** **覆盖模式**：文档里有的统统换掉，手机专属设置（拦截页文案）保持不动 */
    fun overwrite(doc: JsonObject, base: Config): Config {
        val clock = doc.obj("clock")
        val points = doc.obj("points")
        val st = doc.obj("settings")
        val notify = st?.obj("notify")
        val days = docDays(doc) ?: base.days
        val prof = activeProfile(doc)
        val next = base.copy(
            enabled = clock?.bool("enabled", base.enabled) ?: base.enabled,
            days = days,
            defWork = prof?.int("defWork", base.defWork)?.coerceIn(1, 59) ?: base.defWork,
            defBrk = prof?.int("defBrk", base.defBrk)?.coerceIn(1, 59) ?: base.defBrk,
            rules = normalizeRules(docRules(doc)),
            points = (points?.int("balance", base.points) ?: base.points).coerceAtLeast(0),
            unlockUntil = points?.long("unlockUntil", base.unlockUntil) ?: base.unlockUntil,
            notify = if (notify == null) base.notify else NotifyCfg(
                enabled = notify.bool("enabled", base.notify.enabled),
                workBefore = notify.int("workBefore", base.notify.workBefore).coerceIn(0, 120),
                breakBefore = notify.int("breakBefore", base.notify.breakBefore).coerceIn(0, 120),
                breakNotify = notify.bool("breakNotify", base.notify.breakNotify),
            ),
        )
        return normalize(next)
    }

    // ---------------------------------------------------------------- 合并

    /**
     * **合并模式**：只加法。
     *
     * 规则：同 id 或同内容 → 跳过；同名不同内容 → 改名并列；其余追加。
     * 时段：只补本机空着的小时，已选中的一小时都不改。
     * 积分：取较大值（不累加，否则来回导入就能刷分）。
     * 其余设置：不动——合并的承诺是"只会多，不会变"。
     */
    fun merge(doc: JsonObject, base: Config): MergeOut {
        var added = 0
        var skipped = 0
        var conflict = 0
        var slots = 0

        val rules = base.rules.toMutableList()
        val ids = rules.map { it.id }.toMutableSet()
        val sigs = rules.map { sig(it) }.toMutableSet()

        // 注意：这里**不**预先补 id —— 补出来的 "bk1" 很可能跟本机某条撞车，
        // 撞上就会被当成"已存在"而跳过。只在确认本机没有这个 id 后再补。
        for (r0 in docRules(doc)) {
            var r = if (r0.id.isBlank()) r0.copy(id = newId(ids)) else r0
            val s = sig(r)
            if (r.id in ids || s in sigs) {
                skipped++
                continue
            }
            if (r.name.isNotBlank() && rules.any { it.name.trim() == r.name.trim() }) {
                r = r.copy(name = uniqueName(rules, r.name))
                conflict++
            } else {
                added++
            }
            ids += r.id
            sigs += sig(r)
            rules += r
        }

        val dd = docDays(doc)
        val days = if (dd == null) {
            base.days
        } else {
            (0 until 7).map { d ->
                (0 until 24).map { h ->
                    val cur = base.days.getOrNull(d)?.getOrNull(h) ?: HourPlan()
                    val inc = dd[d][h]
                    if (!cur.on && inc.on) {
                        slots++
                        inc
                    } else {
                        cur
                    }
                }
            }
        }

        val docBalance = doc.obj("points")?.int("balance", 0) ?: 0
        val next = base.copy(
            rules = rules,
            days = days,
            points = maxOf(base.points, docBalance).coerceAtLeast(0),
        )
        return MergeOut(normalize(next), MergeStats(added, skipped, conflict, slots))
    }

    // ---------------------------------------------------------------- 加密

    /**
     * 加密信封。
     *
     * - 密码为空 → 原样返回明文（桌面端的 DPAPI 出了那台机器就打不开，
     *   所以"没密码"只能给明文，界面必须把这句话说出来）
     * - 有密码 → `{"kofEnc":3,"kdf":"pbkdf2-sha256",...}`，AES-256-GCM
     */
    fun seal(plain: String, pass: String, iter: Int = ITER): String {
        if (pass.isBlank()) return plain
        val rnd = SecureRandom()
        val salt = ByteArray(16).also { rnd.nextBytes(it) }
        val nonce = ByteArray(12).also { rnd.nextBytes(it) }
        val key = pbkdf2(pass, salt, iter)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(AAD)
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return buildJsonObject {
            put("kofEnc", 3)
            put("kdf", "pbkdf2-sha256")
            put("iter", iter)
            put("salt", b64(salt))
            put("nonce", b64(nonce))
            put("data", b64(ct))
        }.toString()
    }

    /**
     * 把一段备份文本变成明文载荷：是信封就解开，是明文就原样返回。
     *
     * 桌面端早期用 Argon2id（kofEnc:1）或 DPAPI（kofEnc:2）加密，
     * 手机端都没有对应实现——这种情况给一句能指导操作的错误，
     * 而不是"文件损坏"（那会让人以为备份坏了，其实只是方式不同）。
     */
    fun unlock(text: String, pass: String): String {
        val v = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject
            ?: return text
        val kind = v.int("kofEnc", 0)
        if (kind == 0) return text
        if (kind != 3) {
            throw IllegalArgumentException(
                "这份备份是桌面端旧方式加密的（kofEnc: $kind），手机解不开。" +
                    "请在桌面端设置备份密码后重新「立即备份」或「导出跨设备备份」。",
            )
        }
        if (pass.isBlank()) throw IllegalArgumentException("这份备份用密码加密了，请先填写备份密码")
        val iter = v.int("iter", 0)
        if (iter < ITER_MIN || iter > ITER_MAX) {
            throw IllegalArgumentException("备份文件的加密参数不在合理范围内（可能被改动过）")
        }
        val salt = b64d(v.str("salt"))
        val nonce = b64d(v.str("nonce"))
        if (salt.size != 16 || nonce.size != 12) throw IllegalArgumentException("备份文件已损坏")
        val key = pbkdf2(pass, salt, iter)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(AAD)
        val plain = try {
            cipher.doFinal(b64d(v.str("data")))
        } catch (e: Exception) {
            throw IllegalArgumentException("密码不对，或者备份文件被改动过")
        }
        return String(plain, Charsets.UTF_8)
    }

    private fun pbkdf2(pass: String, salt: ByteArray, iter: Int): ByteArray {
        val spec = PBEKeySpec(pass.toCharArray(), salt, iter, 256)
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    }

    private fun b64(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
    private fun b64d(s: String): ByteArray =
        runCatching { Base64.getDecoder().decode(s) }
            .getOrElse { throw IllegalArgumentException("备份文件已损坏（base64 解不开）") }

    // ---------------------------------------------------------------- 规则映射

    /** 文档里的规则 → 手机端规则（认包名，其余存进 foreign / carry） */
    fun ruleToAndroid(rj: JsonObject): Rule {
        val apps = rj.arr("apps").mapNotNull { it as? JsonObject }
        val pkgs = apps.filter { it.str("kind") == "pkg" }
            .map { it.str("value").trim() }
            .filter { it.isNotEmpty() }
            .distinct()
        val foreign = apps
            .filter { it.str("kind") != "pkg" && it.str("value").isNotBlank() }
            .map { PtApp(it.str("kind"), it.str("value"), it.str("label")) } +
            rj.arr("sites").mapNotNull { it as? JsonObject }
                .filter { it.str("pattern").isNotBlank() }
                .map { PtApp("site", it.str("pattern"), it.str("label")) }
        val mode = when (rj.str("mode")) {
            "whitelist" -> "whitelist"
            else -> "blacklist" // both / 未知值：判定与 blacklist 一致
        }
        return Rule(
            id = rj.str("id").trim(),
            name = rj.str("name").trim().ifBlank { "未命名" },
            enabled = rj.bool("enabled", true),
            mode = mode,
            packages = pkgs,
            hard = rj.bool("hard", true),
            foreign = foreign,
            carry = if (needsCarry(rj)) rj.toString() else "",
        )
    }

    /** 手机端规则 → 文档里的规则（把 carry 里桌面专属的字段原样带回去） */
    fun ruleToDoc(r: Rule): JsonObject {
        val base = if (r.carry.isBlank()) {
            JsonObject(emptyMap())
        } else {
            runCatching { Json.parseToJsonElement(r.carry) as? JsonObject }.getOrNull()
                ?: JsonObject(emptyMap())
        }
        val kept = base.arr("apps").mapNotNull { it as? JsonObject }
            .filter { it.str("kind") != "pkg" }
        val apps = kept + r.packages.filter { it.isNotBlank() }.distinct().map {
            buildJsonObject {
                put("kind", "pkg")
                put("value", it)
                put("label", "")
            }
        }
        // "both" 是桌面端的三值之一（黑名单 + 例外白名单同时生效），
        // 手机端只认两值；原始值在 carry 里，别把它降级掉
        val mode = if (base.str("mode") == "both" && r.mode == "blacklist") "both" else r.mode
        return buildJsonObject {
            base.forEach { (k, v) -> if (k !in OVERLAY_KEYS) put(k, v) }
            put("id", r.id)
            put("name", r.name)
            put("enabled", r.enabled)
            put("mode", mode)
            put("hard", r.hard)
            put("apps", JsonArray(apps))
        }
    }

    /** 有没有手机端表达不了的内容（有才值得存 carry，免得白占配置体积） */
    private fun needsCarry(rj: JsonObject): Boolean {
        if (rj.str("mode") == "both") return true
        if (rj.arr("sites").isNotEmpty() || rj.arr("exceptions").isNotEmpty()) return true
        if (rj.arr("extraProtected").isNotEmpty()) return true
        if (rj.arr("schedule").any { it is JsonArray && it.isNotEmpty() }) return true
        val lock = rj.obj("lock")
        if (lock != null && lock.str("kind").let { it.isNotEmpty() && it != "none" }) return true
        if (rj.obj("brk")?.str("kind") == "pomodoro") return true
        if (rj.obj("autolaunch")?.bool("enabled", false) == true) return true
        return false
    }

    private val OVERLAY_KEYS = setOf("id", "name", "enabled", "mode", "hard", "apps")

    private fun docRules(doc: JsonObject): List<Rule> =
        doc.arr("rules").mapNotNull { it as? JsonObject }.map { ruleToAndroid(it) }

    /** 补 id / 去重 id：前端一律按 id 定位，撞车就会同时改到两条 */
    private fun normalizeRules(list: List<Rule>): List<Rule> {
        val out = ArrayList<Rule>()
        val ids = HashSet<String>()
        for (r in list.take(200)) {
            var x = r
            if (x.id.isBlank() || !ids.add(x.id)) {
                var n = 1
                var cand = "bk$n"
                while (!ids.add(cand)) {
                    n++
                    cand = "bk$n"
                }
                x = x.copy(id = cand)
            }
            out += x
        }
        return out
    }

    private fun newId(taken: Set<String>): String {
        var n = 1
        while (taken.contains("bk$n")) n++
        return "bk$n"
    }

    /** 内容指纹：名称 + 模式 + 名单（和桌面端 `portable::sig` 同一套规则） */
    fun sig(r: Rule): String {
        val apps = r.packages.map { it.trim().lowercase() }
            .filter { it.isNotEmpty() }.sorted().distinct()
        return "${r.name.trim().lowercase()}|${r.mode.trim()}|${apps.joinToString(",")}|"
    }

    private fun uniqueName(taken: List<Rule>, base: String): String {
        val b = base.trim().ifBlank { "未命名" }
        var cand = "$b（来自备份）"
        var n = 2
        while (taken.any { it.name.trim() == cand }) {
            cand = "$b（来自备份 $n）"
            n++
        }
        return cand
    }

    // ---------------------------------------------------------------- 时段映射

    private const val PHONE_PROFILE_ID = "p1"

    private fun activeProfile(doc: JsonObject): JsonObject? {
        val clock = doc.obj("clock") ?: return null
        val profiles = clock.arr("profiles").mapNotNull { it as? JsonObject }
        val active = clock.str("active")
        return profiles.firstOrNull { it.str("id") == active } ?: profiles.firstOrNull()
    }

    /** 文档里的 7×24 排班（取当前生效的方案） */
    fun docDays(doc: JsonObject): List<List<HourPlan>>? {
        val prof = activeProfile(doc) ?: return null
        val days = prof.arr("days")
        if (days.isEmpty()) return null
        return (0 until 7).map { d ->
            val row = days.getOrNull(d) as? JsonArray
            (0 until 24).map { h -> hourFrom(row?.getOrNull(h) as? JsonObject) }
        }
    }

    private fun hourFrom(o: JsonObject?): HourPlan {
        if (o == null) return HourPlan()
        var from = o.int("from", 0).coerceIn(0, 59)
        var to = o.int("to", 60).coerceIn(1, 60)
        // 桌面端能表达"一小时里两段"（wins）；手机端只有首尾，取外包区间，
        // 宁可多盖一点也不能把那半小时漏掉
        val wins = o.arr("wins").mapNotNull { it as? JsonObject }
        if (wins.isNotEmpty()) {
            from = wins.minOf { it.int("from", 0) }.coerceIn(0, 59)
            to = wins.maxOf { it.int("to", 60) }.coerceIn(1, 60)
        }
        if (from >= to) {
            from = 0
            to = 60
        }
        return HourPlan(
            on = o.bool("on", false),
            work = o.int("work", 45).coerceIn(0, 60),
            brk = o.int("brk", 15).coerceIn(0, 60),
            from = from,
            to = to,
        )
    }

    // ---------------------------------------------------------------- 小工具

    private fun JsonObject.obj(k: String): JsonObject? = this[k] as? JsonObject
    private fun JsonObject.arr(k: String): JsonArray = (this[k] as? JsonArray) ?: JsonArray(emptyList())

    private fun JsonObject.str(k: String): String =
        (this[k] as? JsonPrimitive)?.content ?: ""

    private fun JsonObject.bool(k: String, d: Boolean): Boolean =
        (this[k] as? JsonPrimitive)?.content?.let {
            when (it.lowercase()) {
                "true", "1" -> true
                "false", "0" -> false
                else -> d
            }
        } ?: d

    private fun JsonObject.int(k: String, d: Int): Int =
        (this[k] as? JsonPrimitive)?.content?.toDoubleOrNull()?.toInt() ?: d

    private fun JsonObject.long(k: String, d: Long): Long =
        (this[k] as? JsonPrimitive)?.content?.toDoubleOrNull()?.toLong() ?: d
}

/** 解析结果：文档 + 是不是桌面端老格式（老格式的覆盖是"整份替换"） */
class Parsed(val doc: JsonObject, val legacy: Boolean)

/** 合并结果 */
data class MergeOut(val config: Config, val stats: MergeStats)

/** 合并计数，界面据此给出"新增 3 条 / 跳过 2 条 / 冲突 1 条" */
data class MergeStats(val added: Int, val skipped: Int, val conflict: Int, val slots: Int) {
    val noop: Boolean get() = added == 0 && conflict == 0 && slots == 0
}
