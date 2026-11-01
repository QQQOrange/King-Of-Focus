package com.qqqorange.kingoffocus

import com.qqqorange.kingoffocus.data.GoalStore
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 段目标的存取规则。
 *
 * 这里只测"一段一条、再写即覆盖"以及长度上限——落盘路径（`init` + 临时文件改名）
 * 依赖 Android Context，在 JVM 单测里跑不到，由真机自测覆盖。
 * `set()` 在未 init 时只在内存里改，正好可以用来做纯逻辑断言。
 */
class GoalStoreTest {

    @Test
    fun oneGoalPerSegmentAndOverwrite() {
        val seg = 1_700_000_000L
        GoalStore.set(seg, "先写登录页")
        assertEquals("先写登录页", GoalStore.of(seg))
        GoalStore.set(seg, "先写登录页（改）")
        assertEquals("先写登录页（改）", GoalStore.of(seg))
        // 别的段各写各的
        GoalStore.set(seg + 3600, "背单词")
        assertEquals("先写登录页（改）", GoalStore.of(seg))
        assertEquals("背单词", GoalStore.of(seg + 3600))
    }

    @Test
    fun emptyClearsGoal() {
        val seg = 1_700_100_000L
        GoalStore.set(seg, "做点事")
        GoalStore.set(seg, "   ")
        assertEquals("", GoalStore.of(seg))
    }

    @Test
    fun lengthIsCapped() {
        val seg = 1_700_200_000L
        val long = "字".repeat(260)
        GoalStore.set(seg, long)
        assertEquals(200, GoalStore.of(seg).length)
    }

    @Test
    fun zeroSegmentIsIgnored() {
        // seg = 0 = "不在时段里"，不该写进去（否则会有一条谁都对不上的记录）
        assertEquals("", GoalStore.set(0, "无效"))
        assertEquals("", GoalStore.of(0))
    }
}
