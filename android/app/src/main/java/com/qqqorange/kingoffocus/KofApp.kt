package com.qqqorange.kingoffocus

import android.app.Application
import com.qqqorange.kingoffocus.data.Store

class KofApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Store.init(this)
    }
}
