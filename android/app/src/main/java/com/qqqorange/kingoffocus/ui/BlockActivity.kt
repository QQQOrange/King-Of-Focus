package com.qqqorange.kingoffocus.ui

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.OnBackPressedCallback
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.core.ScheduleEngine
import com.qqqorange.kingoffocus.data.Store
import kotlinx.coroutines.delay
import java.time.LocalDateTime

/**
 * 全屏拦截页。
 *
 * Android 的限制决定了它的形态：只能"盖住"、不能"杀掉"。
 * 所以这里做三件事：说清楚为什么被拦、给出剩余时间、留一个回桌面的出口
 * （不给出口会把手机卡死，这不是自律，是故障）。
 */
class BlockActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pkg = intent.getStringExtra(EXTRA_PKG).orEmpty()
        val rule = intent.getStringExtra(EXTRA_RULE).orEmpty()
        val label = runCatching {
            val pm = packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        }.getOrDefault(pkg)

        // 返回键不结束页面：结束它等于给了"绕过"按钮
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // 什么都不做：想离开只能点"回到桌面"
            }
        })

        setContent {
            KofTheme {
                var left by remember { mutableStateOf(currentLeft()) }
                LaunchedTick { left = currentLeft() }
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(28.dp),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text("自律中", fontSize = 30.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "「$label」不在此刻的允许范围内",
                            fontSize = 15.sp,
                            textAlign = TextAlign.Center,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "规则：$rule",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(24.dp))
                        Text(left, fontSize = 44.sp, fontWeight = FontWeight.SemiBold)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "本阶段剩余",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(36.dp))
                        Text(
                            Store.current.overlay.message,
                            fontSize = 13.sp,
                            textAlign = TextAlign.Center,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(36.dp))
                        Button(
                            onClick = {
                                val home = Intent(Intent.ACTION_MAIN)
                                    .addCategory(Intent.CATEGORY_HOME)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                startActivity(home)
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text("回到桌面") }

                        if (Store.current.overlay.allowStop) {
                            Spacer(Modifier.height(10.dp))
                            OutlinedButton(
                                onClick = {
                                    Store.update { it.copy(enabled = false) }
                                    finish()
                                },
                                modifier = Modifier.fillMaxWidth(),
                            ) { Text("结束本次自律") }
                        }
                        Spacer(Modifier.height(16.dp))
                        Text(
                            "Android 不允许一个应用结束另一个应用，「拦截」在这里意味着：每次切到被拦的应用都会回到这一页。",
                            fontSize = 11.sp,
                            textAlign = TextAlign.Center,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }

    private fun currentLeft(): String {
        val st = ScheduleEngine.stateAt(Store.current, LocalDateTime.now())
        return if (st != null) ScheduleEngine.fmtLeft(st.leftSeconds) else "--:--"
    }

    companion object {
        const val EXTRA_PKG = "pkg"
        const val EXTRA_RULE = "rule"
    }
}

@Composable
private fun LaunchedTick(onTick: () -> Unit) {
    androidx.compose.runtime.LaunchedEffect(Unit) {
        while (true) {
            delay(1000)
            onTick()
        }
    }
}
