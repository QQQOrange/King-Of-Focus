package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.core.GuardEngine
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.HourPlan
import com.qqqorange.kingoffocus.data.Rule
import com.qqqorange.kingoffocus.data.defaultDays
import com.qqqorange.kingoffocus.data.normalize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

/**
 * 白名单模式与"允许的应用"的单一来源。
 *
 * 这一组守的是"总开关 + 规则 + 名单三者联动"：开关关了什么都不拦、
 * 名单内的放行、名单外的立刻拦、并且**遮罩与拦截读的是同一份名单**。
 */
class GuardEngineTest {

    private fun at(h: Int, m: Int): LocalDateTime = LocalDateTime.of(2026, 10, 26, h, m) // 周一

    /** 09 点整段选中，番茄 60/0（整段都是专注，不会有休息让判定变空） */
    private fun cfg(rules: List<Rule> = emptyList()): Config {
        val days = defaultDays().map { it.toMutableList() }.toMutableList()
        days[0][9] = HourPlan(true, 60, 0, 0, 60)
        return Config(enabled = true, days = days, rules = rules)
    }

    private fun white(vararg pkgs: String) = Rule(
        id = "w", name = "允许的应用", mode = "whitelist", packages = pkgs.toList(),
    )

    @Test
    fun `白名单外的应用立刻被拦`() {
        val c = cfg(listOf(white("com.tencent.mm")))
        val now = at(9, 10)
        assertNull("名单内的放行", GuardEngine.blockedRule(c, now, "com.tencent.mm", "self"))
        assertEquals(
            "名单外的一律拦",
            "w",
            GuardEngine.blockedRule(c, now, "com.example.game", "self")?.id,
        )
        assertNull("系统设置永远放行，不然手机变砖", GuardEngine.blockedRule(c, now, "com.android.settings", "self"))
        assertNull("桌面/启动器放行", GuardEngine.blockedRule(c, now, "com.google.android.apps.nexuslauncher", "self"))
    }

    @Test
    fun `总开关关掉就什么都不拦`() {
        val c = cfg(listOf(white("com.tencent.mm"))).copy(enabled = false)
        assertNull(GuardEngine.blockedRule(c, at(9, 10), "com.example.game", "self"))
        assertTrue(GuardEngine.activeRules(c, at(9, 10)).isEmpty())
    }

    @Test
    fun `规则自己被关掉也不拦`() {
        val c = cfg(listOf(white("com.tencent.mm").copy(enabled = false)))
        assertNull(GuardEngine.blockedRule(c, at(9, 10), "com.example.game", "self"))
    }

    @Test
    fun `不在时段内不拦`() {
        val c = cfg(listOf(white("com.tencent.mm")))
        assertNull("10 点没排计划", GuardEngine.blockedRule(c, at(10, 10), "com.example.game", "self"))
    }

    @Test
    fun `允许名单是多条白名单规则的并集`() {
        val c = cfg(
            listOf(
                white("com.a", "com.b"),
                Rule(id = "w2", name = "第二条", mode = "whitelist", packages = listOf("com.c")),
                Rule(id = "b", name = "黑名单", mode = "blacklist", packages = listOf("com.d")),
                white("com.e").copy(enabled = false),
            ),
        )
        assertEquals(setOf("com.a", "com.b", "com.c"), GuardEngine.allowedPackages(c))
        assertTrue(GuardEngine.hasWhitelistRule(c))
    }

    @Test
    fun `老的锁机白名单会并进规则且只留一份`() {
        // 升级前的配置：lockAllow 有内容，规则里没有白名单
        val old = Config(lockAllow = listOf("com.tencent.mm", "com.android.settings"))
        val fixed = normalize(old)
        assertEquals("老字段必须清空，否则又变成两份名单", emptyList<String>(), fixed.lockAllow)
        val r = fixed.rules.firstOrNull { it.id == "rule-lock-allow" }
        assertNotNull("要生成一条白名单规则", r)
        assertNotNull(r)
        assertEquals("whitelist", r!!.mode)
        assertTrue(r.packages.contains("com.tencent.mm"))
        // 再 normalize 一次不该出现第二条
        assertEquals(fixed.rules.size, normalize(fixed).rules.size)
    }

    @Test
    fun `没有白名单规则时允许名单为空`() {
        val c = cfg(listOf(Rule(id = "b", name = "黑名单", packages = listOf("com.d"))))
        assertTrue(GuardEngine.allowedPackages(c).isEmpty())
        assertFalse(GuardEngine.hasWhitelistRule(c))
    }
}
