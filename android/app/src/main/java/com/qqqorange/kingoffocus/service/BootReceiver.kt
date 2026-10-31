package com.qqqorange.kingoffocus.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.qqqorange.kingoffocus.data.Store

/**
 * 开机 / 应用更新后把守护服务拉起来。
 *
 * 只在"总开关开着"时启动：用户关掉自律之后重启手机，不该冒出常驻通知。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent?) {
        Store.init(ctx)
        if (Store.current.enabled) {
            runCatching { GuardService.start(ctx) }
        }
    }
}
