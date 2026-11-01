package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Portable
import com.qqqorange.kingoffocus.data.defaultDays
import com.qqqorange.kingoffocus.data.lastDays
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * **电脑排好「当天」→ 手机应用后必须一模一样**。
 *
 * 读的是桌面端测试也在读的同一份样例（`tools/fixtures/portable-desktop-day.json`）：
 * 任何一端改了字段名，这条就会红。这是"多端配置不一致"最省事的保险，
 * 比"各自测各自"可靠得多。
 */
class SyncScopeTest {

    private fun fixture(name: String): String {
        val f = File("../../tools/fixtures/$name")
        assertTrue("找不到样例文件：${f.absolutePath}", f.exists())
        return f.readText()
    }

    private fun applied(): Config {
        val doc = Portable.parse(fixture("portable-desktop-day.json")).doc
        return Portable.overwrite(doc, Config(days = defaultDays()))
    }

    @Test
    fun `时段方案连同节奏与分组一起搬过来`() {
        val c = applied()
        val plan = c.plans.firstOrNull { it.id == "p-day" }
        assertTrue("方案要一起搬过来", plan != null)
        plan!!
        assertEquals("当天", plan.name)
        assertEquals("专注 25 分", 25, plan.defWork)
        assertEquals("休息 5 分", 5, plan.defBrk)
        assertEquals("每小时休息上限也要带过来", 15, plan.defCap)
        assertEquals("方案绑定的规则不能丢", listOf("r-work"), plan.bound)
        assertEquals("当前方案要指到它", "p-day", c.activePlan)
        assertEquals("网格刻度要一致", 15, c.granularity)
    }

    @Test
    fun `周一 9 到 12 点落在正确的小时上 相邻小时不受影响`() {
        val c = applied()
        val monday = c.days[0]
        for (h in 9..11) {
            assertTrue("周一 $h 点应该选中", monday[h].on)
            assertEquals("节奏要跟着小时走", 25, monday[h].work)
            assertEquals(5, monday[h].brk)
        }
        assertFalse("8 点没选，不能凭空多出来", monday[8].on)
        assertFalse("12 点没选，不能凭空多出来", monday[12].on)
        assertFalse("周二不该被周一的排班溅到", c.days[1][9].on)
    }

    @Test
    fun `规则跟着搬过来 且是白名单模式`() {
        val c = applied()
        assertEquals(1, c.rules.size)
        assertEquals("工作类", c.rules[0].name)
        assertEquals("whitelist", c.rules[0].mode)
        // 桌面规则是按 exe 路径写的，手机没有"exe"这个概念：
        // 条目落在 `foreign`（桌面专属，原样带回去），**不会**变成手机的包名名单。
        // 这不是丢数据，是两端应用标识不同——手机的名单要靠手机自己加。
        assertEquals(1, c.rules[0].foreign.size)
        assertEquals("C:/Tools/vscode.exe", c.rules[0].foreign[0].value)
    }

    @Test
    fun `统计摘要一起过来 但不并在本机统计里`() {
        val c = applied()
        assertEquals(2, c.peerStats.days.size)
        assertEquals("desktop", c.peerStats.source)
        val (total, on) = c.peerStats.lastDays(7)
        assertEquals("两天合计 9000 秒", 9000L, total)
        assertEquals("其中自律 4500 秒", 4500L, on)
    }

    @Test
    fun `合并模式同样能拿到规则与时段 但不覆盖本机已选的格子`() {
        // 本机周一 9 点已经自己排了别的节奏
        val base = Config(days = defaultDays()).let { b ->
            val d = b.days.map { it.toMutableList() }.toMutableList()
            d[0][9] = d[0][9].copy(on = true, work = 45, brk = 15)
            b.copy(days = d)
        }
        val doc = Portable.parse(fixture("portable-desktop-day.json")).doc
        val out = Portable.merge(doc, base)
        assertEquals("已选中的格子一个字都不改", 45, out.config.days[0][9].work)
        assertTrue("空着的格子要补上", out.config.days[0][10].on)
        assertEquals("规则会补进来", 1, out.config.rules.size)
    }
}
