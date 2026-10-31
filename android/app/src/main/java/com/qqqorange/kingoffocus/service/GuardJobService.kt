package com.qqqorange.kingoffocus.service

import android.app.job.JobParameters
import android.app.job.JobService
import com.qqqorange.kingoffocus.core.KeepAlive
import com.qqqorange.kingoffocus.data.Store

/**
 * 保活用的第二条通道：JobScheduler 周期任务。
 *
 * ## 为什么 AlarmManager 之外还要它
 *
 * 心跳是 `AlarmManager` 的不精确闹钟。部分 ROM（尤其省电模式下的国产 ROM）
 * 会拦掉第三方应用的闹钟，或者把它们攒到很晚才发；而 JobScheduler 走的是
 * 系统作业调度器，两条路径同时被拦的概率小得多。
 *
 * ## 它不做什么
 *
 * 不采样、不拦截——只确认守护服务还活着，不活着就拉起来。
 * 所有业务判定都留在 [GuardService]，避免两处各自算一套状态。
 */
class GuardJobService : JobService() {

    override fun onStartJob(params: JobParameters?): Boolean {
        Store.init(applicationContext)
        val cfg = Store.current
        if (!GuardService.shouldRun(cfg)) {
            // 自律与统计都关着：别让作业再把自己拉起来
            KeepAlive.cancelJob(this)
            jobFinished(params, false)
            return false
        }
        if (!KeepAlive.isServiceRunning(this)) {
            runCatching { GuardService.start(this) }
        }
        jobFinished(params, false)
        return false
    }

    override fun onStopJob(params: JobParameters?): Boolean = false
}
