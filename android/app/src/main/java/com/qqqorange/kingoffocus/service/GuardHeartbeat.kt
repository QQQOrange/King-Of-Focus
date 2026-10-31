package com.qqqorange.kingoffocus.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.qqqorange.kingoffocus.data.Store

/**
 * 心跳：确认"该跑的东西还在跑"。
 *
 * 三种情况会把守护弄丢，一颗 15 分钟的心跳能全部兜住：
 *  1. 被 ROM 的清后台策略连前台服务一起干掉；
 *  2. 从最近任务里划掉（`onTaskRemoved` 已经补了一发 1.5 秒的，但可能又被干掉）；
 *  3. 开机时 `BOOT_COMPLETED` 被某些 ROM 拦了（心跳是另一条独立的路径）。
 *
 * 什么都不做才是对的：**没在自律就绝不拉起服务**，不能拿心跳当"自动启动"用。
 */
class GuardHeartbeat : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent?) {
        Store.init(ctx)
        if (!GuardService.shouldRun(Store.current)) return
        GuardService.start(ctx)
        GuardService.scheduleHeartbeat(ctx)
    }
}
