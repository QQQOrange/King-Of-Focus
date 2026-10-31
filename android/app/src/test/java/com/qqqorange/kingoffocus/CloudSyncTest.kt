package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.data.CloudSync
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 云端备份的纯逻辑：文件名、来源、排序、207 解析。
 *
 * 这几条决定了"手机能不能看见桌面传的那份"——一旦解析错，列表就是空的，
 * 而用户只会以为是"网盘没配好"。
 */
class CloudSyncTest {

    @Test
    fun `手机备份名带来源标记，且时间戳能还原`() {
        val t = 1793000000L
        val name = CloudSync.backupName(t * 1000, "android")
        assertTrue("要带 .kofbak 后缀，桌面端才认", name.endsWith(".kofbak"))
        assertTrue("要带 -android，桌面端才知道这是手机传的", name.contains("-android"))
        assertEquals("时间戳必须能原样还原", t, CloudSync.stampOf(name))
    }

    @Test
    fun `桌面备份名没有来源标记，也要能解析`() {
        // 桌面端 `backup::make` 生成的是 kof-<yyyyMMdd-HHmmss>.kofbak
        val t = CloudSync.stampOf("kof-20261031-210000.kofbak")
        assertTrue("解析不出时间，列表会把桌面那份排到最后", t > 0)
        assertEquals(
            "手机与桌面同一时刻的名字，时间戳必须相同",
            t,
            CloudSync.stampOf("kof-20261031-210000-android.kofbak"),
        )
    }

    @Test
    fun `解析 207：目录项要跳过，文件要出来，来源要分对`() {
        val xml = """<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/kof/</d:href>
    <d:propstat><d:prop><d:getcontentlength/></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/kof/kof-20261031-210000.kofbak</d:href>
    <d:propstat><d:prop>
      <d:getcontentlength>2048</d:getcontentlength>
      <d:getlastmodified>Sat, 31 Oct 2026 13:00:00 GMT</d:getlastmodified>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/kof/kof-20261031-211500-android.kofbak</d:href>
    <d:propstat><d:prop>
      <d:getcontentlength>4096</d:getcontentlength>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/kof/readme.txt</d:href>
    <d:propstat><d:prop><d:getcontentlength>12</d:getcontentlength></d:prop></d:propstat>
  </d:response>
</d:multistatus>"""
        val list = CloudSync.parseMultiStatus(xml)
        assertEquals("目录、txt 都不算备份", 2, list.size)
        assertEquals("kof-20261031-210000.kofbak", list[0].name)
        assertEquals(2048L, list[0].size)
        assertEquals("桌面", list[0].sourceLabel)
        assertFalse(list[0].fromAndroid)
        assertEquals("手机", list[1].sourceLabel)
        assertTrue(list[1].fromAndroid)
        assertEquals(4096L, list[1].size)
    }

    @Test
    fun `服务器用大写前缀或百分号编码也要认`() {
        // Synology / 坚果云 的前缀和编码各不相同：`D:`、`%20`、甚至没有前缀
        val xml = """<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/kof/kof-20261031-220000-android.kofbak</D:href>
    <D:propstat><D:prop>
      <D:getcontentlength>8192</D:getcontentlength>
    </D:prop></D:propstat>
  </D:response>
  <response>
    <href>/dav/kof/kof-20261031-230000.kofbak</href>
    <propstat><prop><getcontentlength>1024</getcontentlength></prop></propstat>
  </response>
</D:multistatus>"""
        val list = CloudSync.parseMultiStatus(xml)
        assertEquals("两种写法都要解析出来", 2, list.size)
        val desktop = list.first { it.name == "kof-20261031-230000.kofbak" }
        val phone = list.first { it.name.endsWith("-android.kofbak") }
        assertEquals(1024L, desktop.size)
        assertEquals(8192L, phone.size)
    }

    @Test
    fun `列表按时间倒序，手机与桌面混排`() {
        val a = CloudSync.Entry("kof-20261031-090000.kofbak", "", 0, "", CloudSync.stampOf("kof-20261031-090000.kofbak"))
        val b = CloudSync.Entry("kof-20261031-220000-android.kofbak", "", 0, "", CloudSync.stampOf("kof-20261031-220000-android.kofbak"))
        val c = CloudSync.Entry("kof-20261030-220000.kofbak", "", 0, "", CloudSync.stampOf("kof-20261030-220000.kofbak"))
        val sorted = CloudSync.sortDesc(listOf(a, c, b))
        // b 10-31 22:00 > a 10-31 09:00 > c 10-30 22:00
        assertEquals("最新的在最上面（手机那份）", b.name, sorted[0].name)
        assertEquals(a.name, sorted[1].name)
        assertEquals(c.name, sorted[2].name)
    }

    @Test
    fun `文件名不能带路径，避免写到别的目录`() {
        assertFalse(CloudSync.isBackup("../evil.kofbak"))
        assertFalse(CloudSync.isBackup("sub/dir.kofbak"))
        assertTrue(CloudSync.isBackup("kof-20261031-210000-android.kofbak"))
        assertFalse("不是备份后缀", CloudSync.isBackup("kof-android.json"))
    }

    @Test
    fun `自动备份靠固定名字识别`() {
        val e = CloudSync.Entry(
            CloudSync.AUTO_NAME, "", 0, "",
            CloudSync.stampOf(CloudSync.AUTO_NAME),
        )
        assertTrue("自动备份要能被标出来，否则列表里看起来像一份普通备份", e.auto)
        assertTrue(e.fromAndroid)
    }
}
