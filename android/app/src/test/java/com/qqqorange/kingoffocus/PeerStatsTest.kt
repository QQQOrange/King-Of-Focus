package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.Portable
import com.qqqorange.kingoffocus.data.defaultDays
import com.qqqorange.kingoffocus.data.lastDays
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 统计摘要的跨端接收。
 *
 * 边界只有三条，但每条错了都会让人误判：
 *  · 收下 → 统计页要能说出"另一台设备最近用了多久"；
 *  · 旧的别覆盖 → 否则来回同步几次，数字会退回到几天前；
 *  · 空的别收 → 对方刚装还没数据时，不该多出一张空卡片。
 */
class PeerStatsTest {

    /** 造一份带统计摘要的文档（其它字段借用真实导出，避免构造出非法结构） */
    private fun docWith(at: Long, days: Int, device: String = "QQQORANGE"): JsonObject {
        val base = Portable.toDoc(Config(days = defaultDays()), "Pixel", "0.4.4")
        val stats = buildJsonObject {
            put("schema", 1)
            put("source", "desktop")
            put("device", device)
            put("at", at)
            put(
                "days",
                buildJsonArray {
                    for (i in 0 until days) {
                        add(
                            buildJsonObject {
                                put("day", "2026-11-0${i + 1}")
                                put("total", 3600)
                                put("on", 1800)
                                put(
                                    "top",
                                    buildJsonArray {
                                        add(buildJsonObject { put("name", "微信"); put("secs", 1200) })
                                    },
                                )
                            },
                        )
                    }
                },
            )
        }
        val map = base.toMutableMap()
        map["stats"] = stats
        return JsonObject(map)
    }

    @Test
    fun `覆盖模式会收下对方的统计摘要`() {
        val base = Config(days = defaultDays())
        val out = Portable.overwrite(docWith(at = 1000, days = 2), base)
        assertEquals(2, out.peerStats.days.size)
        assertEquals("desktop", out.peerStats.source)
        assertEquals("QQQORANGE", out.peerStats.device)
        // 7 天合计：两天各 3600 / 1800
        val (total, on) = out.peerStats.lastDays(7)
        assertEquals(7200L, total)
        assertEquals(3600L, on)
    }

    @Test
    fun `合并模式也收摘要 但不碰本机规则与时段`() {
        val base = Config(days = defaultDays(), rules = emptyList())
        val out = Portable.merge(docWith(at = 1000, days = 1), base)
        assertEquals(1, out.config.peerStats.days.size)
        assertEquals("合并只做加法", 0, out.config.rules.size)
    }

    @Test
    fun `更旧的摘要不会覆盖已有的`() {
        val base = Config(days = defaultDays())
        val first = Portable.overwrite(docWith(at = 2000, days = 3), base)
        assertEquals(3, first.peerStats.days.size)

        // 又同步来一份更旧的：天数更少、时间更早 → 不该把 3 天替换成 1 天
        val second = Portable.overwrite(docWith(at = 1000, days = 1), first)
        assertEquals("旧摘要不该覆盖新摘要", 3, second.peerStats.days.size)
        assertEquals(2000L, second.peerStats.at)
    }

    @Test
    fun `没有数据的摘要不产生卡片`() {
        val base = Config(days = defaultDays())
        val out = Portable.overwrite(docWith(at = 1000, days = 0), base)
        assertTrue("空摘要不该被收下", out.peerStats.days.isEmpty())
    }

    @Test
    fun `文档里没有 stats 段时本机摘要原样保留`() {
        val base = Portable.overwrite(docWith(at = 1000, days = 2), Config(days = defaultDays()))
        val plain = Portable.toDoc(Config(days = defaultDays()), "Pixel", "0.4.4")
        val map = plain.toMutableMap().apply { remove("stats") }
        val out = Portable.overwrite(JsonObject(map), base)
        assertEquals("没有新摘要就留着旧的", 2, out.peerStats.days.size)
    }
}
