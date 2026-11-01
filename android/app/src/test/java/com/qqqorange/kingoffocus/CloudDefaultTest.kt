package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.data.CloudCfg
import com.qqqorange.kingoffocus.data.CloudSync
import com.qqqorange.kingoffocus.data.Config
import com.qqqorange.kingoffocus.data.normalize
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 默认 WebDAV 地址：**不看界面也要能用**。
 *
 * 这一批断言对应一个真实 bug：设置页把地址写在 placeholder（灰字）里，
 * 配置里其实是空串 —— 用户看着"已经填好了"，一点同步就报"还没填 WebDAV 地址"。
 */
class CloudDefaultTest {

    /** 必须与桌面端 `model::DEFAULT_SYNC_URL` 逐字相同，两端才看得到同一批备份 */
    private val expected = "https://dav.jianguoyun.com/dav/KingOfFocus/"

    @Test
    fun `默认地址与桌面端完全一致`() {
        assertEquals(expected, CloudSync.DEFAULT_URL)
        assertEquals("新配置默认就该带地址", expected, CloudCfg().url)
    }

    @Test
    fun `空地址自动落到默认值`() {
        assertEquals(expected, CloudSync.urlOf(CloudCfg(url = "")))
        assertEquals(expected, CloudSync.urlOf(CloudCfg(url = "   ")))
        assertEquals(expected, CloudSync.urlOf(CloudCfg(url = "\n\t")))
    }

    @Test
    fun `自定义地址不会被默认值覆盖`() {
        val custom = "https://nas.local:5006/dav/kof/"
        assertEquals(custom, CloudSync.urlOf(CloudCfg(url = custom)))
        // 首尾空白只 trim，内容是用户的，一个字都不改
        assertEquals(custom, CloudSync.urlOf(CloudCfg(url = "  $custom  ")))
    }

    @Test
    fun `加载老配置后被清洗成默认地址`() {
        val old = normalize(Config(cloud = CloudCfg(url = "")))
        assertEquals("空 = 默认，不该继续空着", expected, old.cloud.url)

        val mine = normalize(Config(cloud = CloudCfg(url = "https://dav.example.com/dav")))
        assertEquals("自定义只补末尾斜杠", "https://dav.example.com/dav/", mine.cloud.url)
    }

    @Test
    fun `手机端录入的地址第一次保存就会补上末尾斜杠`() {
        // 不补的话 base() 每次都要拼，而 CloudSync.pruneTargets 之类按前缀比对的地方会错
        val c = normalize(Config(cloud = CloudCfg(url = "https://dav.example.com/dav/kof")))
        assertTrue(c.cloud.url.endsWith("/"))
    }

    @Test
    fun `云端最新一份取时间最大的那份`() {
        val list = listOf(
            CloudSync.Entry("kof-20261031-090000.kofbak", "", 0, "", CloudSync.stampOf("kof-20261031-090000.kofbak")),
            CloudSync.Entry("kof-20261101-220000-android.kofbak", "", 0, "", CloudSync.stampOf("kof-20261101-220000-android.kofbak")),
            CloudSync.Entry("kof-20261030-220000.kofbak", "", 0, "", CloudSync.stampOf("kof-20261030-220000.kofbak")),
        )
        assertEquals("kof-20261101-220000-android.kofbak", CloudSync.latest(list)?.name)
        assertNull("云端空列表不能崩", CloudSync.latest(emptyList()))
    }

    @Test
    fun `清理只删本机手动传的旧备份`() {
        // 手机端传了 7 份 + 1 份自动 + 2 份桌面：只该删手机端最早那 2 份
        val names = (0 until 7).map { i ->
            "kof-2026110${i + 1}-100000-android.kofbak"
        }
        val list = names.map { CloudSync.Entry(it, "", 0, "", CloudSync.stampOf(it)) } +
            CloudSync.Entry("kof-auto-android.kofbak", "", 0, "", 0L) +
            listOf(
                CloudSync.Entry("kof-20261001-100000.kofbak", "", 0, "", CloudSync.stampOf("kof-20261001-100000.kofbak")),
                CloudSync.Entry("kof-20261002-100000.kofbak", "", 0, "", CloudSync.stampOf("kof-20261002-100000.kofbak")),
            )
        val targets = CloudSync.pruneTargets(list, keep = 5)
        assertEquals("最早的两份手机备份", 2, targets.size)
        assertTrue(targets.contains("kof-20261101-100000-android.kofbak"))
        assertTrue(targets.contains("kof-20261102-100000-android.kofbak"))
        assertFalse("自动备份不参与清理", targets.contains("kof-auto-android.kofbak"))
        assertFalse("桌面传的一份都不许删", targets.any { it == "kof-20261001-100000.kofbak" })
    }

    @Test
    fun `不足保留份数时什么都不删`() {
        val list = (0 until 3).map { i ->
            val n = "kof-2026110${i + 1}-100000-android.kofbak"
            CloudSync.Entry(n, "", 0, "", CloudSync.stampOf(n))
        }
        assertTrue(CloudSync.pruneTargets(list, keep = 5).isEmpty())
    }
}
