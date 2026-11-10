package com.qqqorange.kingoffocus

import android.app.Application
import com.qqqorange.kingoffocus.data.Store
import com.qqqorange.kingoffocus.ui.Loc

class KofApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // 先定语言再建界面：所有文案都在 Compose 里，晚一步就会先闪一帧中文
        Loc.init()
        Store.init(this)
    }
}
