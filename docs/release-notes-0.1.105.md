# 0.1.105 / Android 0.7.0 — 全盘一轮：积分口径、崩溃面、恢复默认

这一轮 Desktop 与 Android 两边一起过，重点不是加功能，而是把**口径不一致**和
**一碰就崩的地方**收掉。

## 一、Android 终于会发积分了（这是最实在的一条）

桌面端一直是「自律生效时段里每分钟 +1 分」，而手机端**从来没有**这条逻辑：
积分只会因为"质押退回来"而增加。也就是说，一个不押注的新用户永远攒不到分，
也就永远买不起解锁——功能在，但用不上。

现在 `GuardService` 里按桌面同一口径计时：

- 每拍用 `elapsedRealtime` 的**差值**累加，切后台、被冻结都不会多算；
- 单拍最多认 3 秒，所以"息屏一夜回来 +500 分"不可能发生；
- 判定直接用 `StatsTrack.on()`——它从 0.6.0 起已经排除了"积分解锁窗口"，
  等于和桌面一样：**解锁出来的自由时间不给分**；
- 不在自律时段里时计数清零，零碎时间不会攒到下一段。

## 二、累计获得不再拿余额顶

手机端没有 `totalEarned` 字段，导出时写的是 `put("totalEarned", cfg.points)`。
余额会被解锁消费拉低，于是**手机备份一恢复，桌面的「累计获得」也跟着变小**——
那是一本只增不减的账，变小就是数据坏了。

现在：

- Android 加了真字段 `totalEarned`，赚钱的地方（每分钟 +1、质押退回）两边一起加；
- 导出写真实值；导入时老备份没有这个键就**沿用本机值**，绝不拿余额顶；
- `normalize` 保证 `totalEarned >= points`（老配置读进来是 0，余额可能已经几百）；
- 设置页「关于」多一行「累计获得 N 分（余额 M）」。

三条单测：导出不等于余额、老文档不覆盖本机、normalize 抬高到余额。

## 三、Android 也能「分区恢复默认」了

以前只有一个「重置全部配置」：点下去规则、时段、积分一起没，**没有任何退路**。

现在对齐桌面 0.1.104：

- 8 个分区：规则 / 时段 / 锁机 / 睡眠 / 统计口径 / 提醒 / 分心事件 / 全部；
- 动手前把整份配置存成 `pre-reset.json`（`ResetStore`），卡片上直接能「撤销上次恢复」；
- 撤销时**不回滚积分**——那不是设置，回滚等于没收这段时间赚的分；
- 逻辑放在 `data/ResetSections.kt`（不在 Compose 里），6 条单测守"恢复 A 不动 B"。

## 四、桌面：两处可能让整个程序消失的地方

`panic = "abort"`，所以任何一次 panic 都是**进程直接没了**，没有对话框、没有日志
（0.1.103 之前连日志都没有）。这轮收掉两处：

1. `get_state` 里的 `shared.rt.lock().unwrap()`：只要有人持锁时 panic 过一次，
   这个锁就被毒化，此后**每 1.5 秒一次**的状态查询都会 panic。改成
   `unwrap_or_else(|e| e.into_inner())`（和代码库其它地方一致）。
2. 遮罩主循环里的 `target.unwrap()`：靠"上游 `can_paint` 已经保证 Some"才安全，
   一旦语义漂移就是崩。改成 `let Some(t) = target else { continue }`。

## 五、Android 另外三处硬化

- `GuardService.start()` 内部包 `runCatching` 并返回 Boolean：Android 12+ 从后台
  拉起前台服务会抛 `ForegroundServiceStartNotAllowedException`，以前 `GuardHeartbeat`
  与 `App` 两个调用点没包，系统一收紧就是"打开就闪退"。
- `Store.save()` 先 `fsync` 再 rename：`writeText` 只把数据交给内核，
  断电后可能出现"文件名换了、内容还是半截"的配置文件——那是整个 App 的状态。
- 去掉两处 `!!`（`Stats.kt` 分段合并、`ReviewScreen` 快照判空）：Kotlin 没法通过
  布尔变量反推非空，语义一变就是 NPE。

## 验证

- 桌面 `cargo test` **299 通过**
- `run_itest` **1188 断言 0 失败** · `check_i18n` **820/820** · `check_wiring` 一致
- Android `testDebugUnitTest` 通过（新增 3 条累计获得 + 6 条分区隔离）
- APK **0.7.0（versionCode 37）**
- 版本：桌面 0.1.105 · Android 0.7.0 · 插件 1.1.2
