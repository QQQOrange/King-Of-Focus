# 0.1.114 — 目标完成发奖励分 + 色盲友好 + 死代码清理

## 一、目标第一次真正"参与判定"（发分）

以前「这一段目标做完了」只是一个标记：不影响积分、不影响时长、不影响任何东西，
点一下只是个心理安慰。现在：

- 把某一段的目标标成 **done → +5 分**（立刻、进余额和累计获得）；
- 撤销（done → 其它）**扣回** 5 分，防止「done → 改回 → done」反复刷分；
- partial / missed → done 照发（用户后来补上了，也算做成）；
- 提示里直接带分：「记下了：这一段做完了 · +5 分」。

为什么是固定 5 分而不是可配置：可配置就得改 `Points`/`Settings` 的序列化结构，
而那是跨端备份格式的一部分——为一个整数改动 wire format，两端都要跟着动，
收益远小于风险。等下次真要动格式时一起放开。

判定逻辑抽成纯函数 `bonus_for(prev, next)` 并加了 6 条断言：
积分是钱，不能靠"读一遍觉得对"。

## 二、色盲友好：状态不再只靠颜色

红/绿在红绿色盲眼里几乎一样，而这恰好承载"成功 / 失败"。现在：

| 徽标 | 新增的形 |
|---|---|
| `.badge.green` | ✓ |
| `.badge.red` | ✕ |
| `.badge.gold` | ! |
| `.dx-st.done` | ✓ |
| `.dx-st.missed` | ✕ |

用 `::before` 实现，**几十处调用点一个都不用改**；间距用 `em`，跟着字号缩放。
颜色仍在，视觉上只是多了个小符号——但形状本身就能读出来。

## 三、死代码清理（clippy `never used`）

删掉 10 个确认无人调用的函数/常量：`net::get_json`、`browsers::{clear_cache,
manifest_name_at, info_for_exe}`、`cmds::mask_secret`、`proc::is_minimized`、
`testmode::current_dir`、`autoopen::SW_SHOWNORMAL`、`forcequit::{WM_QUIT,PM_REMOVE}`。

`cargo clippy` 的死代码告警从 **35 条降到 26 条**。

**故意没删的**：`sched::summary`、`clock::active`、`extpage::new_tab_button_matches`、
`backup::CryptProtectData`、`reset::SECTIONS`、`portable::shape` 等——它们只在
`#[cfg(test)]` 里被用到（clippy 不带 `--tests` 会误报），删了就编译不过。
这四个是我删了又用 `git checkout` 还原回来的：**先删、编译、失败、还原**，
比"看着像没用到就删"可靠。

## 四、验证

- `python tools/check_all.py` → **8 道全绿**
- `cargo test` **310 通过**（+1 目标奖励）
- 界面 harness **1188 断言 0 失败** · i18n **842/842**
- 版本：桌面 0.1.114 · Android 0.7.0（未改）· 插件 1.2.3（未改）

## 五、这一轮**没做**的三件（都是"大而机械"，该单独一轮）

1. **`app.js` 拆模块**（11838 行 / 295 个函数）：要动 `index.html` 与 `_harness.html`
   的加载顺序、以及所有跨文件全局依赖。风险不在写，在"漏一个全局变量就白屏"。
2. **统计页局部重绘**（153 处全量 `render()`）：等于重写渲染层。
3. **Android 英文界面**：全部 Compose 文案要抽 `Loc` 层再逐条替换。

三件都不是"顺手"，做完各自都该独立发版、独立验证。
