# 0.1.87 / Android 0.5.5

这一版没有新功能，是一次**全盘审视**：把这一周加的东西逐项对了一遍，改了 6 处问题。
下面按"问题 → 为什么是问题 → 怎么改的"写。

## 1. 向导建的规则默认是「固化」（严重）

`Rule` 的 `hard` 默认是 `true`。桌面向导用 `..Rule::default()`、手机端也没显式写，
于是**给新手建的第一条规则是固化的**：到了点关不掉自律、改不了设置，
而新用户积分是 0，连"积分解锁"这条缝都没有——那不是自律，是陷阱。

改：两端都显式 `hard = false`，并把规则的构造抽成 `onboard::build_rule` /
`OnboardMath.buildRule`，各加一条单测钉住（`onboard_rule_is_never_hard` /
`onboardRuleIsNeverHard`）。

## 2. 试用结束后"自律总开关"没还原（功能错误）

试用要能真的拦人，所以开始时会打开总开关（桌面还顺手打开"跟随自律自动开遮罩"）。
但结束时只还原了排班，没还原这两个开关：本来关着自律在试用的用户，**试完被静默打开**。

改：`TrialCfg` / `Trial` 记下 `originalEnabled`（桌面还有 `prevClockEnabled`、
`prevFollow`），还原时一并写回。老数据缺这些键时用 `#[serde(default)]` 兜住。

## 3. HUD 每秒解析一次 intents.json（性能）

`hud_state` 每秒轮询，而它读"这一段的目标"要解析整个目标文件。
改成单格缓存（`GOAL_CACHE`：只记最后一个 `seg → 文本`，换段自动失效），
写路径（`set_goal` / `set_state`）负责作废。

## 4. 试用开始/结束后总览不刷新（体验）

`today_brief` 有 20 秒缓存，而 `onboard::apply/trial/tick_trial` 没作废它，
于是"现在在专注中"要等最多 20 秒才变。三处都补了 `brief_invalidate()`。

## 5. 四个命令写了却没人调（死代码）

`focus_goal_day`、`focus_snapshot`、`onboard_reset` 从没被前端调用，直接删。
`ledger_range` 也没人调——但它对应的是当初承诺过的「本期被打断 Top」，
所以不是删掉，而是**接到统计页**（见下一条）。

## 6. 「本期被什么打断」终于落地（补完承诺）

统计页底部长出一张卡：本期共被打断几次、按次数排出前八名（软件 / 网页徽标 + 命中规则）。
数据来自 `ledger_range`，与「分心事件」页那张今日卡同一份账本。

顺手修了两处文案/实现不一致：
- 卡片里写的去重是"40 秒"，代码里是 30 秒 → 改成 30；
- 手机端备份模块的注释还写着"桌面端的 DPAPI 出了那台机器就打不开"，而桌面端
  0.1.70 起就没再写过 DPAPI → 改成"两端都没密码就是明文"。

## 另外两处小整理

- `onboard::apply` 里给 `active` 赋值时有一个永远走不到的分支（两条路最后都落在同一个 id），
  直接写死，避免以后看错。
- `distract.rs` 两处 `let Ok(hm) = u32::try_from(x.hour()) else { break }` 是
  unreachable（`hour()` 本来就返回 u32），换成直接取值。编译警告 55 → 52。

## 验证

- 桌面 `cargo test` **288 通过**（+1：向导规则禁止固化）
- 安卓 `gradle testDebugUnitTest` **306 通过**（+1：同上）
- `run_itest.js` **1103 断言 0 失败**（+2：统计页有账本卡、按次数排序）
- `check_i18n.js` **731 条 100%**；`check_portable.js` 通过（备份格式未动）
- 命令注册与前端调用交叉核对：95 个命令、79 个调用点，无孤儿、无缺失
- 版本号三处一致；`.kofbak` 不含 `onboarded` / `trial` / `distract`（已用 grep 核过）
