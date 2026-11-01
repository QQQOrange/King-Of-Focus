package com.qqqorange.kingoffocus.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
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
        /**
         * 统计摘要。默认读本机统计；测试里可以注入固定的一份，
         * 这样"两端导出的形状是否一致"才能不依赖真实使用数据。
         */
        digest: List<PeerDay> = com.qqqorange.kingoffocus.core.PeerDigest.of(),
    ): JsonObject = buildJsonObject {
        put("kof", KOF)
        put("format", FORMAT)
        put("schema", SCHEMA)
        put("createdAt", now)
        // `source` / `device` 只是"这份来自哪台机器"的标签：读写路径上一处都不许
        // 拿它做分支，否则就又变成"只有生成备份的设备能读"了。
        put("source", "android")
        put("device", device)
        put("appVersion", appVersion)
        // 统计摘要：只带"每天用了多久/自律多久/前三个应用"，
        // 不带原始日文件（两端结构不同，互传读不懂且会重复计数）。
        put(
            "stats",
            buildJsonObject {
                put("schema", 1)
                put("source", "android")
                put("device", device)
                put("at", System.currentTimeMillis() / 1000)
                put(
                    "days",
                    JsonArray(
                        digest.map { d ->
                            buildJsonObject {
                                put("day", d.day)
                                put("total", d.total)
                                put("on", d.on)
                                put(
                                    "top",
                                    JsonArray(
                                        d.top.map { a ->
                                            buildJsonObject {
                                                put("name", a.name)
                                                put("secs", a.secs)
                                            }
                                        },
                                    ),
                                )
                            }
                        },
                    ),
                )
            },
        )
        put("rules", JsonArray(cfg.rules.map { ruleToDoc(it) }))
        put(
            "clock",
            buildJsonObject {
                // 手机端只有一个「自律总开关」＋一张 7×24 表，映射到桌面端
                // 的"当前生效方案"上：enabled 就是时段总开关
                put("enabled", cfg.enabled)
                put("applyRules", true)
                // 手机端的刻度（10/15）原样带出去：桌面端读同一份清单，
                // 打开网格时用的就是手机这边设的刻度
                put("granularity", cfg.granularity)
                // 桌面端的"图上只看这段""整屏铺满"是**纯展示**参数，手机端没有；
                // 但键必须写（值取桌面端的默认），否则两端的文件在字段上就不一样了。
                put("viewFrom", 0)
                put("viewTo", 1440)
                put("fitAll", true)
                // 多套方案原样带出去：桌面端 `clock.profiles` 本来就是数组，
                // 只导当前这一套等于把用户在手机上排的其它方案丢掉。
                val exportPlans = cfg.plans.ifEmpty {
                    listOf(
                        SchedulePlan(
                            id = PHONE_PROFILE_ID,
                            name = "手机时段",
                            days = cfg.days,
                            defWork = cfg.defWork,
                            defBrk = cfg.defBrk,
                            defCap = cfg.defCap,
                        ),
                    )
                }
                val activeId = exportPlans.firstOrNull { it.id == cfg.activePlan }?.id
                    ?: exportPlans.first().id
                put("active", activeId)
                put(
                    "profiles",
                    JsonArray(
                        exportPlans.map { plan ->
                            // `cfg.days / defWork / defBrk` 是"当前方案"的权威数据
                            // （用户刚在网格上改完，还没经过 normalize 回填）
                            val isActive = plan.id == activeId
                            buildJsonObject {
                                put("id", plan.id)
                                put("name", plan.name)
                                put("defWork", if (isActive) cfg.defWork else plan.defWork)
                                put("defBrk", if (isActive) cfg.defBrk else plan.defBrk)
                                // 每小时累计休息上限（0 = 不限）；桌面端同名 defCap
                                put("defCap", if (isActive) cfg.defCap else plan.defCap)
                                // 这套时段绑定的规则 id（空 = 全部），桌面端 ClockProfile.bound
                                put("bound", JsonArray(plan.bound.map { JsonPrimitive(it) }))
                                put("days", daysToDoc(if (isActive) cfg.days else plan.days))
                            }
                        },
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
                // 睡眠时段解锁：两端都有这个概念，不写的话"手机恢复桌面备份"
                // 会顺手把桌面已经买断的睡眠解锁清掉。
                put("sleepUnlockUntil", cfg.sleepUnlockUntil)
            },
        )
        put(
            "settings",
            buildJsonObject {
                // 空串 = "这台设备没有这个概念"（手机端没有语言/配色切换）。
                // **不能**写 "zh-CN" / "system"：那不是"没意见"，而是明确要求
                // 对端改成中文 + 跟随系统，一份手机备份就能把桌面调好的
                // 英文界面 + 深色配色一键还原。桌面端读到空串会保持原样。
                put("lang", "")
                put("theme", "")
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
     * 文档的「字段签名」：每个键的路径 + 类型，排序后一行一个。
     *
     * 桌面端有一份逐字对应的实现（`portable::shape`），两端拿**同一份**
     * `tools/fixtures/portable-shape.txt` 当尺子：自己导出的文档必须量出同样的
     * 签名。少写一个键、多写一个键、把类型改了，都会当场红——
     * 否则"两端格式一致"只是一句没人验证的口号（少个键照样能用默认值读出来）。
     *
     * 数组统一记成 `path[]`，元素是对象/数组时继续往里走（同一数组的多个元素
     * 取并集），所以签名与"这次数据里有几条"无关。
     */
    fun shape(el: JsonElement): String {
        val out = sortedSetOf<String>()
        walkShape(el, "", out)
        return out.joinToString("\n")
    }

    private fun walkShape(el: JsonElement, path: String, out: MutableSet<String>) {
        when (el) {
            is JsonObject -> el.forEach { (k, v) ->
                walkShape(v, if (path.isEmpty()) k else "$path.$k", out)
            }
            is JsonArray -> {
                out += "$path[]"
                for (v in el) {
                    when (v) {
                        is JsonNull -> out += "$path[]:null"
                        is JsonObject, is JsonArray -> walkShape(v, "$path[]", out)
                        is JsonPrimitive -> out += "$path[]:${typeOf(v)}"
                    }
                }
            }
            JsonNull -> out += "$path:null"
            is JsonPrimitive -> out += "$path:${typeOf(el)}"
        }
    }

    private fun typeOf(p: JsonPrimitive): String = when {
        p.isString -> "string"
        p.content == "true" || p.content == "false" -> "bool"
        p.content == "null" -> "null"
        else -> "number"
    }

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
        val (docPlans, docActive) = docPlans(doc)
        // 文档带了方案数组 → 整套换掉（桌面端的"覆盖"就是这个意思）；
        // 老格式没有 profiles 数组 → 只换当前这套的排班，别把本机其它方案删掉。
        val plans = if (docPlans.isEmpty()) {
            base.plans.map { p ->
                if (p.id != base.activePlan) p
                else p.copy(
                    days = days,
                    defWork = prof?.int("defWork", p.defWork)?.coerceIn(1, 59) ?: p.defWork,
                    defBrk = prof?.int("defBrk", p.defBrk)?.coerceIn(0, 59) ?: p.defBrk,
                    defCap = prof?.int("defCap", p.defCap)?.coerceIn(0, 60) ?: p.defCap,
                    bound = if (prof == null) p.bound else docBound(prof),
                )
            }.ifEmpty {
                listOf(
                    SchedulePlan(
                        id = base.activePlan.ifBlank { "plan-default" },
                        name = "默认方案",
                        days = days,
                        defWork = prof?.int("defWork", base.defWork)?.coerceIn(1, 59) ?: base.defWork,
                        defBrk = prof?.int("defBrk", base.defBrk)?.coerceIn(0, 59) ?: base.defBrk,
                        defCap = prof?.int("defCap", base.defCap)?.coerceIn(0, 60) ?: base.defCap,
                        bound = if (prof == null) emptyList() else docBound(prof),
                    ),
                )
            }
        } else {
            docPlans
        }
        val next = base.copy(
            enabled = clock?.bool("enabled", base.enabled) ?: base.enabled,
            // 粒度是"怎么画"，不是"怎么判定"：跟文档走，但只认 10/15
            granularity = Slots.stepOf(clock?.int("granularity", base.granularity) ?: base.granularity),
            days = days,
            defWork = prof?.int("defWork", base.defWork)?.coerceIn(1, 59) ?: base.defWork,
            // 休息可以是 0（= 整段不休息），别夹成 1——那会凭空多出一次休息
            defBrk = prof?.int("defBrk", base.defBrk)?.coerceIn(0, 59) ?: base.defBrk,
            defCap = prof?.int("defCap", base.defCap)?.coerceIn(0, 60) ?: base.defCap,
            // 方案级 bound 也带回来：只在"覆盖"时整体接受（合并时不动本机分组）
            plans = plans,
            activePlan = if (docPlans.isEmpty()) base.activePlan.ifBlank { "plan-default" } else docActive,
            rules = normalizeRules(docRules(doc)),
            // 对方的统计摘要：本机统计一个字节都不动，只是多存一份"另一台设备"的
            peerStats = adoptStats(docStats(doc), base) ?: base.peerStats,
            points = (points?.int("balance", base.points) ?: base.points).coerceAtLeast(0),
            unlockUntil = points?.long("unlockUntil", base.unlockUntil) ?: base.unlockUntil,
            // 睡眠时段的买断时间也要跟着备份走：不然"手机恢复桌面备份"会把
            // 桌面已经花积分买断的那一段重新锁上。
            sleepUnlockUntil = points?.long("sleepUnlockUntil", base.sleepUnlockUntil)
                ?: base.sleepUnlockUntil,
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
            // 统计摘要也收下：它不属于"规则/时段"，收它不违背"只会多、不会变"
            // 的承诺（本机统计一个字节都不动，只是多存了对方那份）
            peerStats = adoptStats(docStats(doc), base) ?: base.peerStats,
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
        // 桌面端的三值语义：blacklist / whitelist / both（apps 命中即拦，另一侧交给插件）。
        // 手机端现在也有 both，但含义是"允许名单 + 禁止名单"：
        // 桌面端的 both 名单在软件侧等价于黑名单，所以导进来落在**禁止名单**里，
        // 允许名单留空 —— 这样两端的拦截结果一致（宁可更严，不放松）。
        val mode = when (rj.str("mode")) {
            "whitelist" -> "whitelist"
            "both" -> "both"
            else -> "blacklist"
        }
        return Rule(
            id = rj.str("id").trim(),
            name = rj.str("name").trim().ifBlank { "未命名" },
            enabled = rj.bool("enabled", true),
            mode = mode,
            packages = if (mode == "both") emptyList() else pkgs,
            deny = if (mode == "both") pkgs else emptyList(),
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
        // both 且没有允许名单时，"名单"指的是禁止名单
        val localPkgs = if (r.mode == "both" && r.packages.isEmpty()) r.deny else r.packages
        val apps = kept + localPkgs.filter { it.isNotBlank() }.distinct().map {
            buildJsonObject {
                // `id` 必须有：桌面端 `AppEntry` 的字段是 `{id, kind, value, label}`，
                // 少一个键，两端导出的文件就不再是同一种结构了（前端按 id 定位）。
                put("id", "")
                put("kind", "pkg")
                put("value", it)
                put("label", "")
            }
        }
        // 手机端的 both（允许 + 禁止两张名单）在桌面端表达不了：
        //  · 没有允许名单 → 导成 both，apps 放禁止名单，两端结果一致；
        //  · 有允许名单   → 导成 whitelist（只允许这些），并把禁止名单并进 apps？
        //    不行——桌面端 whitelist 会把 apps 当"允许"，并进去等于放开。
        //    所以这里选"更严的那一侧"：只导允许名单，禁止名单留在手机端本地，
        //    并在规则名前加标记，避免用户以为桌面端也禁了那几个。
        val mode = when {
            r.mode != "both" -> r.mode
            r.packages.isEmpty() -> "both"
            else -> "whitelist"
        }
        return buildJsonObject {
            // 先铺一层"桌面端 Rule 的完整形状"的默认值，再叠 carry，最后盖手机端
            // 能改的几项。顺序不能反：没有 carry 的手机原生规则否则会缺
            // schedule / lock / color / autolaunch 这些键，导出的文件就和桌面端
            // 那份"长得不一样"，两端就不再是同一种备份了。
            put("sites", JsonArray(emptyList()))
            put("exceptions", JsonArray(emptyList()))
            put("schedule", JsonArray(List(7) { JsonArray(emptyList()) }))
            put(
                "lock",
                buildJsonObject {
                    put("kind", "none")
                    put("until", 0)
                    put("password", "")
                    put("chars", 20)
                },
            )
            put("color", "#ff9f43")
            put("extraProtected", JsonArray(emptyList()))
            put(
                "brk",
                buildJsonObject {
                    put("kind", "none")
                    put("workMin", 25)
                    put("breakMin", 5)
                },
            )
            put(
                "autolaunch",
                buildJsonObject {
                    put("enabled", false)
                    put("items", JsonArray(emptyList()))
                },
            )
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
        return profileDays(prof)
    }

    /** 某一套方案里的 7×24 排班 */
    private fun profileDays(prof: JsonObject): List<List<HourPlan>>? {
        val days = prof.arr("days")
        if (days.isEmpty()) return null
        return (0 until 7).map { d ->
            val row = days.getOrNull(d) as? JsonArray
            (0 until 24).map { h -> hourFrom(row?.getOrNull(h) as? JsonObject) }
        }
    }

    /** 一套方案绑定的规则 id（空 = 全部） */
    /**
     * 解析文档里的**统计摘要**。
     *
     * 只在两端都有"每天总时长 / 自律时长"这个量级的概念时才谈得上互通；
     * 逐应用逐小时的原始数据不解析——结构不同，硬塞会算错。
     */
    private fun docStats(doc: JsonObject): PeerStats? {
        val s = doc.obj("stats") ?: return null
        val days = s.arr("days").mapNotNull { it as? JsonObject }.mapNotNull { o ->
            val day = o.str("day").trim()
            if (day.isEmpty()) {
                null
            } else {
                PeerDay(
                    day = day,
                    total = o.long("total", 0).coerceAtLeast(0),
                    on = o.long("on", 0).coerceAtLeast(0),
                    top = o.arr("top").mapNotNull { it as? JsonObject }.mapNotNull { a ->
                        val n = a.str("name").trim()
                        if (n.isEmpty()) null else PeerApp(n, a.long("secs", 0).coerceAtLeast(0))
                    }.take(3),
                )
            }
        }
        if (days.isEmpty()) return null
        return PeerStats(
            schema = 1,
            source = s.str("source").ifBlank { "desktop" },
            device = s.str("device"),
            at = s.long("at", 0),
            days = days,
        )
    }

    /**
     * 收下对方的统计摘要，三条不收：
     *  · 空的（对方刚装、还没数据）；
     *  · 旧的（`at` 不比本机已有的新，说明看过了）；
     *  · **自己导出的**（同型号手机恢复自己的备份，不该在"另一台设备"里看到自己）。
     */
    private fun adoptStats(st: PeerStats?, base: Config): PeerStats? {
        if (st == null || st.days.isEmpty()) return null
        if (st.at <= base.peerStats.at) return null
        if (st.source == "android" && st.device.isNotBlank()
            && st.device == (android.os.Build.MODEL ?: "")
        ) {
            return null
        }
        return st
    }

    private fun docBound(prof: JsonObject): List<String> =
        prof.arr("bound").mapNotNull { (it as? JsonPrimitive)?.content }
            .filter { it.isNotBlank() }.distinct()

    /**
     * 文档里的**全部**方案与其生效 id。
     *
     * 返回空列表 = 文档没有 `profiles` 数组（很老的格式）：调用方只换当前这套的排班，
     * 不能因为"文档里没有方案"就把本机其它方案删掉。
     */
    private fun docPlans(doc: JsonObject): Pair<List<SchedulePlan>, String> {
        val clock = doc.obj("clock") ?: return emptyList<SchedulePlan>() to ""
        val raw = clock.arr("profiles").mapNotNull { it as? JsonObject }
        val list = raw.mapIndexedNotNull { i, o ->
            val days = profileDays(o) ?: return@mapIndexedNotNull null
            SchedulePlan(
                id = o.str("id").ifBlank { "plan-" + (i + 1) },
                name = o.str("name").ifBlank { "方案 " + (i + 1) },
                days = days,
                defWork = o.int("defWork", 50).coerceIn(1, 59),
                defBrk = o.int("defBrk", 10).let { b ->
                    if (b > 0) b.coerceIn(0, 59).coerceAtMost(60 - o.int("defWork", 50).coerceIn(1, 59)) else 0
                },
                defCap = o.int("defCap", 0).coerceIn(0, 60),
                bound = docBound(o),
            )
        }.distinctBy { it.id }
        if (list.isEmpty()) return emptyList<SchedulePlan>() to ""
        val want = clock.str("active")
        val active = list.firstOrNull { it.id == want }?.id ?: list.first().id
        return list to active
    }

    /**
     * 7×24 排班 → 文档形状。
     *
     * 形状必须和桌面端的序列化一致：单段只写 `from/to/seg`，一小时多段才写 `wins`。
     * 多写一个空 `wins` 不影响对方读，但"单段带 seg"必须写——段标识丢了之后，
     * 相邻的两段在桌面端会退回"一条连续段"，用户分开排的东西就被并掉了。
     */
    private fun daysToDoc(days: List<List<HourPlan>>): JsonArray =
        JsonArray(
            days.map { day ->
                JsonArray(
                    day.map { h ->
                        buildJsonObject {
                            put("on", h.on)
                            put("work", h.work)
                            put("brk", h.brk)
                            put("from", h.from)
                            put("to", h.to)
                            if (h.seg.isNotEmpty()) put("seg", h.seg)
                            val w = Slots.windowsOf(h)
                            if (w.size > 1) {
                                put(
                                    "wins",
                                    JsonArray(
                                        w.map { one ->
                                            buildJsonObject {
                                                put("from", one.from)
                                                put("to", one.to)
                                                if (one.seg.isNotEmpty()) put("seg", one.seg)
                                            }
                                        },
                                    ),
                                )
                            }
                        }
                    },
                )
            },
        )

    private fun hourFrom(o: JsonObject?): HourPlan {
        if (o == null) return HourPlan()
        val on = o.bool("on", false)
        var from = o.int("from", 0).coerceIn(0, 59)
        // `to = 0` 是"老配置缺这个字段"的落值，桌面端当整点结束（`hour_end()`）
        val rawTo = o.int("to", 60)
        var to = if (rawTo == 0) 60 else rawTo.coerceIn(1, 60)
        if (from >= to) {
            from = 0
            to = 60
        }
        // 桌面端的 `wins`（一小时多段）现在也收下来——手机端自己也会产生多段，
        // 以前退化成"外包区间"等于把中间的休息时间也锁上
        val seg = o.str("seg")
        val wins = o.arr("wins").mapNotNull { it as? JsonObject }
            .map { HourWin(it.int("from", 0), it.int("to", 60), it.str("seg").ifEmpty { seg }) }
        val all = when {
            wins.isNotEmpty() -> wins
            on -> listOf(HourWin(from, to, seg))
            else -> emptyList()
        }
        return Slots.pack(
            all,
            // 默认值是桌面端 `HourPlan::default()` 的 50/10，不是老的 45/15
            o.int("work", 50).coerceIn(0, 60),
            o.int("brk", 10).coerceIn(0, 60),
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
