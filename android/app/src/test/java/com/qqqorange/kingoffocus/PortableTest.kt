package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.HourWin
import com.qqqorange.kingoffocus.data.Slots
import com.qqqorange.kingoffocus.data.Portable
import com.qqqorange.kingoffocus.data.Rule
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * 跨设备备份格式的单元测试。
 *
 * 关键的一条是 `desktopFixtureParses`：它读的是**桌面端测试也在读的同一份文件**
 * （`tools/fixtures/portable-v1.json`）。两边都过，才谈得上"格式兼容"；
 * 只在本端自说自话地往返，字段名改错了也发现不了。
 */
class PortableTest {

    private fun fixture(name: String): String {
        // 测试的工作目录是 android/app
        val f = File("../../tools/fixtures/$name")
        assertTrue("找不到样例文件：${f.absolutePath}", f.exists())
        return f.readText()
    }

    private fun blank(): Config = Config()

    private fun rule(id: String, name: String, pkgs: List<String>) = Rule(
        id = id,
        name = name,
        enabled = true,
        mode = "blacklist",
        packages = pkgs,
        hard = true,
    )

    @Test
    fun desktopFixtureParses() {
        val p = Portable.parse(fixture("portable-v1.json"))
        assertTrue("新格式不该被当成老格式", !p.legacy)
        val doc = p.doc
        assertEquals(1, doc["schema"]!!.jsonPrimitive.content.toInt())
        val rules = doc["rules"]!!.jsonArray
        assertEquals(2, rules.size)

        val cfg = Portable.overwrite(doc, blank())
        assertEquals(2, cfg.rules.size)
        assertEquals("夜间自律", cfg.rules[0].name)
        // 桌面端是 exe 条目：手机端拦不了，但必须原样保管
        assertEquals(0, cfg.rules[0].packages.size)
        assertEquals(1, cfg.rules[0].foreign.size)
        assertEquals("exe", cfg.rules[0].foreign[0].kind)
        assertEquals("C:/Games/steam.exe", cfg.rules[0].foreign[0].value)
        // 网站条目同样进 foreign
        assertTrue(cfg.rules[1].foreign.any { it.kind == "site" && it.value.contains("bilibili") })
        // 时段 / 总开关 / 积分
        assertTrue(cfg.enabled)
        assertTrue(cfg.days[0][9].on)
        assertTrue(cfg.days[0][19].on)
        assertTrue("周三没选", !cfg.days[2][9].on)
        assertEquals(120, cfg.points)
    }

    @Test
    fun androidFixtureRoundtripsThroughDesktopShape() {
        val p = Portable.parse(fixture("portable-android.json"))
        val cfg = Portable.overwrite(p.doc, blank())
        assertEquals(1, cfg.rules.size)
        assertEquals(listOf("com.example.doomscroll"), cfg.rules[0].packages)

        // 再导出：包名要原样写回去（桌面端读到 kind=pkg 也不该丢）
        val again = Portable.parse(Portable.render(Portable.toDoc(cfg, "Pixel", "0.1.0")))
        val apps = again.doc["rules"]!!.jsonArray[0].jsonObject["apps"]!!.jsonArray
        assertEquals("pkg", apps[0].jsonObject["kind"]!!.jsonPrimitive.content)
        assertEquals("com.example.doomscroll", apps[0].jsonObject["value"]!!.jsonPrimitive.content)
    }

    /** 桌面专属字段（网站、规则时段、例外）不能在"手机转一圈"之后消失 */
    @Test
    fun carryKeepsDesktopOnlyFields() {
        val p = Portable.parse(fixture("portable-v1.json"))
        val cfg = Portable.overwrite(p.doc, blank())
        val out = Portable.toDoc(cfg, "Pixel", "0.1.0")
        val rules = out["rules"]!!.jsonArray
        val site = rules[1].jsonObject
        assertEquals("网站也要管", site["name"]!!.jsonPrimitive.content)
        assertTrue("网站名单丢了", (site["sites"] as JsonArray).isNotEmpty())
        assertTrue("例外名单丢了", (site["exceptions"] as JsonArray).isNotEmpty())
        // 手机端改个名字，桌面专属内容仍然在
        val renamed = cfg.copy(rules = cfg.rules.map { it.copy(name = it.name + "！") })
        val out2 = Portable.toDoc(renamed, "Pixel", "0.1.0")["rules"]!!.jsonArray
        assertTrue((out2[1].jsonObject["sites"] as JsonArray).isNotEmpty())
        assertEquals("网站也要管！", out2[1].jsonObject["name"]!!.jsonPrimitive.content)
    }

    @Test
    fun mergeIsAdditiveAndDedups() {
        val base = blank().copy(
            rules = listOf(rule("a", "娱乐", listOf("com.x"))),
        )
        val src = base.copy(
            rules = listOf(
                rule("a", "娱乐（改过）", listOf("com.x", "com.y")), // 同 id → 跳过
                rule("b", "娱乐", listOf("com.x")),                 // 同内容 → 跳过
                rule("c", "娱乐", listOf("com.z")),                 // 同名不同内容 → 冲突
                rule("d", "学习", listOf("com.w")),                 // 新规则 → 追加
            ),
        )
        val doc = Portable.toDoc(src, "x", "0")
        val (out, st) = Portable.merge(doc, base)
        assertEquals(2, st.skipped)
        assertEquals(1, st.conflict)
        assertEquals(1, st.added)
        assertEquals(3, out.rules.size)
        assertEquals("本机那条不能被改", "娱乐", out.rules[0].name)
        assertEquals(1, out.rules[0].packages.size)
        assertTrue("冲突那条要改名", out.rules[1].name.contains("来自备份"))
    }

    @Test
    fun mergeTwiceDoesNotDouble() {
        val doc = Portable.toDoc(
            blank().copy(rules = listOf(rule("a", "娱乐", listOf("com.x")))),
            "x",
            "0",
        )
        val (once, st1) = Portable.merge(doc, blank())
        assertEquals(1, st1.added)
        val (twice, st2) = Portable.merge(doc, once)
        assertEquals(0, st2.added)
        assertEquals(1, twice.rules.size)
    }

    @Test
    fun mergeFillsOnlyEmptyHours() {
        val base = blank().let { c ->
            val days = c.days.map { it.toMutableList() }.toMutableList()
            days[0][9] = HourPlan(true, 50, 10, 0, 60)
            c.copy(days = days)
        }
        val src = blank().let { c ->
            val days = c.days.map { it.toMutableList() }.toMutableList()
            days[0][9] = HourPlan(true, 30, 30, 0, 60)
            days[0][10] = HourPlan(true, 30, 30, 0, 60)
            c.copy(days = days)
        }
        val (out, st) = Portable.merge(Portable.toDoc(src, "x", "0"), base)
        assertEquals("只该补 10:00 这一个小时", 1, st.slots)
        assertEquals("本机已选的不能改", 50, out.days[0][9].work)
        assertEquals("空着的要补上", 30, out.days[0][10].work)
    }

    @Test
    fun mergePointsTakeMaxNotSum() {
        val base = blank().copy(points = 10)
        val src = blank().copy(points = 30)
        assertEquals(30, Portable.merge(Portable.toDoc(src, "x", "0"), base).config.points)
        val low = blank().copy(points = 7)
        assertEquals(10, Portable.merge(Portable.toDoc(low, "x", "0"), base).config.points)
    }

    /** 覆盖不能碰手机专属设置（拦截页文案） */
    /**
     * 十分钟刻度 + 一小时两段，跨设备来回一圈必须原样回来。
     *
     * 以前手机端只有一对 from/to，桌面端带过来的 `wins` 会被压成"外包区间"，
     * 等于把中间的休息时间也锁上；粒度则被写死成 60，桌面端打开手机备份时
     * 网格会退回整小时。
     */
    @Test
    fun windowsAndGranularitySurviveRoundTrip() {
        val days = (0 until 7).map { d ->
            (0 until 24).map { h ->
                when {
                    d == 0 && h == 9 -> Slots.pack(
                        listOf(HourWin(0, 10), HourWin(30, 40)), 45, 15,
                    )
                    d == 0 && h == 10 -> Slots.pack(listOf(HourWin(15, 45)), 45, 15)
                    else -> HourPlan()
                }
            }
        }
        val cfg = blank().copy(days = days, granularity = 10)
        val doc = Portable.toDoc(cfg, "x", "0")

        val clock = doc["clock"]!!.jsonObject
        assertEquals("10 分钟刻度要原样带出去", 10, clock["granularity"]!!.jsonPrimitive.content.toInt())
        val day0 = clock["profiles"]!!.jsonArray[0].jsonObject["days"]!!.jsonArray[0].jsonArray
        val h9 = day0[9].jsonObject
        assertEquals("一小时两段必须写 wins", 2, (h9["wins"] as JsonArray).size)
        assertNull("单段不该写 wins（形状与桌面端一致）", day0[10].jsonObject["wins"])

        val back = Portable.overwrite(doc, blank())
        assertEquals(10, back.granularity)
        assertEquals(2, back.days[0][9].wins.size)
        // 09 点是 10+10=20 分钟，10 点是 30 分钟，合起来 50
        assertEquals(50, Slots.dayMinutes(back.days[0]))
        assertFalse("中间那 20 分钟不能算选中", Slots.covers(back.days[0][9], 20))
    }

    @Test
    fun overwriteKeepsPhoneOnlySettings() {
        val base = blank().copy(
            overlay = com.qqqorange.kingoffocus.data.OverlayCfg(allowStop = true, message = "别刷了"),
        )
        val doc = Portable.toDoc(blank(), "x", "0")
        val out = Portable.overwrite(doc, base)
        assertTrue(out.overlay.allowStop)
        assertEquals("别刷了", out.overlay.message)
    }

    @Test
    fun sealUnlockRoundtrip() {
        val plain = """{"kof":"king-of-focus","rules":[]}"""
        val env = Portable.seal(plain, "pw123", 10_000)
        assertTrue(env.contains("\"kofEnc\":3"))
        assertTrue("明文泄漏", !env.contains("rules"))
        assertEquals(plain, Portable.unlock(env, "pw123"))
        try {
            Portable.unlock(env, "nope")
            fail("错密码必须拒绝")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("密码不对"))
        }
        // 没填密码要给能指导操作的提示
        try {
            Portable.unlock(env, "")
            fail("空密码必须提示")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("密码"))
        }
    }

    @Test
    fun plainTextPassesThrough() {
        val plain = """{"kof":"king-of-focus","schema":1,"rules":[]}"""
        assertEquals(plain, Portable.seal(plain, ""))
        assertEquals(plain, Portable.unlock(plain, ""))
    }

    /** 桌面端旧信封（Argon2id / DPAPI）要明确说"解不开、怎么补救" */
    @Test
    fun oldEnvelopeExplainsItself() {
        val env = """{"kofEnc":1,"kdf":"argon2id","salt":"","nonce":"","data":""}"""
        try {
            Portable.unlock(env, "pw")
            fail("旧信封不该被当成可解")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("kofEnc"))
            assertTrue(e.message!!.contains("导出跨设备备份"))
        }
    }

    /**
     * 真正的互通证明：这份 `portable-enc.json` 是**桌面端代码**加密出来的
     * （`cargo test __gen_interop_fixture -- --ignored` 生成的），
     * 密码 `kof-demo-2026`。这里能解开、能落地，就说明两端的
     * KDF / 迭代次数 / AAD / 字段名都对得上，而不只是"自己跟自己往返"。
     */
    @Test
    fun desktopEncryptedBackupDecrypts() {
        val env = fixture("portable-enc.json")
        assertTrue("应该是 kofEnc:3 信封", env.contains("\"kofEnc\":3"))
        val plain = Portable.unlock(env, "kof-demo-2026")
        val p = Portable.parse(plain)
        assertEquals("desktop", p.doc["source"]!!.jsonPrimitive.content)
        val cfg = Portable.overwrite(p.doc, blank())
        assertEquals(2, cfg.rules.size)
        assertEquals("夜间自律", cfg.rules[0].name)
        assertEquals(120, cfg.points)
        assertTrue(cfg.enabled)

        try {
            Portable.unlock(env, "kof-demo-2027")
            fail("错密码必须拒绝")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("密码不对"))
        }
    }

    @Test
    fun rejectsGarbageAndFutureSchema() {
        try {
            Portable.parse("not json")
            fail()
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("JSON"))
        }
        try {
            Portable.parse("""{"hello":1}""")
            fail()
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("King Of Focus"))
        }
        try {
            Portable.parse("""{"kof":"king-of-focus","schema":99}""")
            fail()
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("升级"))
        }
    }

    /** 桌面端老格式（整份 Config，没有 kof 标记）也要能读出规则 */
    @Test
    fun legacyDesktopPayloadIsUnderstood() {
        val old = """
        {"version":2,
         "rules":[{"id":"seed","name":"旧规则","mode":"blacklist","enabled":true,
                   "apps":[{"kind":"exe","value":"C:/a.exe"}]}],
         "settings":{"focusClock":{"enabled":true,"profiles":[{"id":"p1","days":[]}]},"lang":"en"},
         "points":{"balance":5},"updatedAt":1793000000}
        """.trimIndent()
        val p = Portable.parse(old)
        assertTrue(p.legacy)
        val cfg = Portable.overwrite(p.doc, blank())
        assertEquals(1, cfg.rules.size)
        assertEquals("旧规则", cfg.rules[0].name)
        assertEquals(5, cfg.points)
    }

    /** 空 id 的规则要补上唯一 id；重复 id 要换掉 */
    @Test
    fun idsAreRepaired() {
        val doc = JsonObject(
            mapOf(
                "kof" to kotlinx.serialization.json.JsonPrimitive("king-of-focus"),
                "schema" to kotlinx.serialization.json.JsonPrimitive(1),
                "rules" to JsonArray(
                    listOf(
                        JsonObject(mapOf("name" to kotlinx.serialization.json.JsonPrimitive("A"))),
                        JsonObject(mapOf("id" to kotlinx.serialization.json.JsonPrimitive("x"), "name" to kotlinx.serialization.json.JsonPrimitive("B"))),
                        JsonObject(mapOf("id" to kotlinx.serialization.json.JsonPrimitive("x"), "name" to kotlinx.serialization.json.JsonPrimitive("C"))),
                    ),
                ),
            ),
        )
        val cfg = Portable.overwrite(doc, blank())
        val ids = cfg.rules.map { it.id }
        assertEquals(3, ids.size)
        assertEquals(3, ids.toSet().size)
        assertNull(ids.firstOrNull { it.isBlank() })
        assertNotNull(cfg.rules[0].name)
    }

    /** 手机端写出的文档结构必须和桌面端读得懂的那份一致（键名钉死） */
    @Test
    fun emittedDocHasAgreedKeys() {
        val doc = Portable.toDoc(
            blank().copy(rules = listOf(rule("r1", "测试", listOf("com.a")))),
            "Pixel",
            "0.1.0",
        )
        for (k in listOf("kof", "format", "schema", "createdAt", "source", "device", "appVersion",
            "rules", "clock", "points", "settings")) {
            assertTrue("缺少 $k", doc.containsKey(k))
        }
        assertEquals("android", doc["source"]!!.jsonPrimitive.content)
        val clock = doc["clock"]!!.jsonObject
        assertTrue((clock["profiles"] as JsonArray).isNotEmpty())
        val days = (clock["profiles"] as JsonArray)[0].jsonObject["days"]!!.jsonArray
        assertEquals(7, days.size)
        assertEquals(24, days[0].jsonArray.size)
    }

    /** 手写的空配置也要能解析（用户拿别的工具改过） */
    @Test
    fun toleratesMissingFields() {
        val doc = Json.parseToJsonElement("""{"kof":"king-of-focus"}""").jsonObject
        val cfg = Portable.overwrite(doc, blank())
        assertEquals(0, cfg.rules.size)
        assertEquals(7, cfg.days.size)
    }
}
