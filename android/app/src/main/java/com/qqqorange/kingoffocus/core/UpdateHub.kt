package com.qqqorange.kingoffocus.core

import kotlinx.coroutines.flow.MutableStateFlow

/**
 * 更新检查的共享状态。
 *
 * 为什么要一个全局对象：自动检查发生在 `MainActivity.onCreate`（那时界面还没建好），
 * 而结果显示在「设置 → 版本与更新」里。两边要是各存一份，就会出现
 * "启动时查到了新版，进设置却什么都没显示"。
 */
object UpdateHub {
    /** 更新源仓库。三端各填各的，桌面端填了别的仓库也不会影响这里。 */
    const val REPO = "QQQOrange/King-Of-Focus"

    /** 最近一次检查的结果（自动 / 手动都写这里） */
    val last = MutableStateFlow<UpdateClient.Result?>(null)

    /** 正在检查或下载 */
    val busy = MutableStateFlow(false)

    /**
     * 该不该自动检查：距离上次检查超过间隔（默认 6 小时）才查。
     * 每次启动都打一次 GitHub 既慢又容易被限流。
     */
    fun due(lastCheck: Long, intervalHours: Int, nowSec: Long): Boolean {
        if (lastCheck <= 0) return true
        val gap = nowSec - lastCheck
        if (gap < 0) return true // 用户改过系统时间，按"该查了"处理
        return gap >= intervalHours.coerceIn(1, 168) * 3600L
    }
}
