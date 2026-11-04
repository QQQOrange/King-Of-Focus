package com.qqqorange.kingoffocus.ui

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qqqorange.kingoffocus.data.ReviewData
import com.qqqorange.kingoffocus.data.ReviewStore
import com.qqqorange.kingoffocus.data.WeekSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 周复盘（手机端）。
 *
 * 与桌面端同一套：五个问题，每题前面挂着已算好的数字。
 * 报告是数据，复盘是决定——一份周报可以从头看到尾然后什么都不改，
 * 而这里必须落成一句"下周改什么"。
 *
 * 读盘（统计/账本/目标的汇总）放在 IO 线程：一周要把七天的日文件都读一遍，
 * 主线程读会卡一下，而这一下正好落在"点进来"最敏感的时刻。
 */
@Composable
fun ReviewScreen(onBack: () -> Unit, onOpenDistract: () -> Unit) {
    val ctx = LocalContext.current
    var offset by remember { mutableStateOf(1L) }
    var snap by remember { mutableStateOf<WeekSnapshot?>(null) }
    var loading by remember { mutableStateOf(true) }
    var texts by remember(offset) { mutableStateOf<List<String>?>(null) }
    var reload by remember { mutableStateOf(0) }

    LaunchedEffect(offset, reload) {
        loading = true
        val s = withContext(Dispatchers.IO) { ReviewData.build(offset) }
        snap = s
        if (texts == null) texts = s.answers
        loading = false
    }

    val scroll = rememberScrollState()
    val t = texts ?: List(ReviewStore.Q_COUNT) { "" }

    Column(
        Modifier.fillMaxSize().verticalScroll(scroll).padding(horizontal = 14.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("‹ 返回", fontSize = 14.sp) }
            Spacer(Modifier.width(2.dp))
            Text("周复盘", fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        Text(
            "五个问题，数字已经填好。每题用一两句回答就行——那一两句才是复盘的全部产出。",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 2.dp, top = 2.dp, bottom = 8.dp),
        )

        Panel {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(0L to "本周", 1L to "上周").forEach { (v, label) ->
                    val on = offset == v
                    Box(
                        Modifier
                            .weight(1f)
                            .background(
                                if (on) MaterialTheme.colorScheme.secondary.copy(alpha = 0.16f)
                                else Color.Transparent,
                                RoundedCornerShape(10.dp),
                            )
                            .clickable { offset = v }
                            .padding(vertical = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            label,
                            fontSize = 12.5.sp,
                            fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                            color = if (on) MaterialTheme.colorScheme.secondary
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            val s = snap
            if (loading || s == null) {
                Text("正在汇总这一周…", fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Text(
                    "${s.weekStart} ~ ${s.weekEnd}",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        val s = snap
        if (s != null) {
            val qs = questions(s)
            qs.forEachIndexed { i, q ->
                Panel {
                    Text(q.data, fontSize = 11.5.sp, lineHeight = 19.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(5.dp))
                    Text(q.ask, fontSize = 13.sp, lineHeight = 20.sp)
                    Spacer(Modifier.height(6.dp))
                    OutlinedTextField(
                        value = t[i],
                        onValueChange = { v ->
                            if (v.length <= 300) {
                                texts = t.toMutableList().also { it[i] = v }
                            }
                        },
                        placeholder = { Text(q.hint, fontSize = 11.sp) },
                        minLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = {
                    ReviewStore.saveAnswers(s.weekStart.toString(), t)
                    Toast.makeText(ctx, "复盘已保存：下次打开还能看到这几句", Toast.LENGTH_SHORT).show()
                    reload++
                }) { Text("保存复盘") }
                if ((s.distractTotal - s.distractDone) > 0) {
                    OutlinedButton(onClick = onOpenDistract) {
                        Text("去处理这 ${s.distractTotal - s.distractDone} 条", fontSize = 12.sp)
                    }
                }
            }
        }
        Spacer(Modifier.height(30.dp))
    }
}

private data class Question(val data: String, val ask: String, val hint: String)

private fun questions(s: WeekSnapshot): List<Question> = listOf(
    Question(
        data = "本周自律 ${fmtHm(s.onSecs)}，上周 ${fmtHm(s.prevOnSecs)}。最投入的是 ${s.bestDayLabel.ifBlank { "—" }}（${fmtHm(s.bestOn)}）。",
        ask = "这周最好的一天是哪天？那天你做对了什么？",
        hint = "例如：周二，手机放到了另一个房间",
    ),
    Question(
        data = if (s.diverTotal > 0) {
            val top = s.diversions.firstOrNull()
            "被打断 ${s.diverTotal} 次，最多来自 ${top?.label ?: "—"}（${top?.n ?: 0} 次）。"
        } else {
            "这周一次都没被拦过。要么很自律，要么规则没生效。"
        },
        ask = if (s.diverTotal > 0) "下周要不要把它关掉？关不掉的话，替代办法是什么？"
        else "要不要去首页看一眼守护状态，确认规则真的在生效？",
        hint = "例如：卸载掉 / 只在 21 点后允许",
    ),
    Question(
        data = if (s.goal.total > 0) {
            "写了 ${s.goal.total} 个段目标：做完 ${s.goal.done}、一半 ${s.goal.partial}、" +
                "没做成 ${s.goal.missed}、还没答 ${s.goal.none}。"
        } else {
            "这周一个段目标都没写——你量到的只有“坐了多久”。"
        },
        ask = if (s.goal.missed + s.goal.none > 0) "没做成 / 还没答的那几个，是目标定太大了，还是时间选得不对？"
        else "做完的那几个，凭什么做得完？",
        hint = "例如：「写完登录页」两小时能做完，「学完前端」不能",
    ),
    Question(
        data = "记下 ${s.distractTotal} 条分心事件，处理了 ${s.distractDone} 条。",
        ask = if (s.distractTotal - s.distractDone > 0) {
            "还剩 ${s.distractTotal - s.distractDone} 条，哪一条值得现在就处理？"
        } else {
            "都处理完了。这些念头里有什么规律？"
        },
        hint = "例如：那条“晚点去查文档”",
    ),
    Question(
        data = "质押结算 ${s.staked} 笔，干净跑完 ${s.stakeClean} 笔，被没收 ${s.stakeVoid} 笔。",
        ask = "下周只改一件事——改哪件？",
        hint = "只写一件。写两件等于没写。",
    ),
)

private fun fmtHm(sec: Int): String {
    val h = sec / 3600
    val m = (sec % 3600) / 60
    return if (h > 0) "${h}h${m.toString().padStart(2, '0')}m" else "${m}m"
}
