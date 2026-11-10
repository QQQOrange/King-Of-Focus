# 0.1.125 / Android 0.7.9 — 英文界面收尾：Android 端中文清零

这一版把最后约 50 行中文包完。**到此 Android 端不再有未包裹的中文文案**。

## 这一批

| 文件 | 内容 | 处数 |
|---|---|---|
| `MainActivity.kt` | 备份导出/导入结果、更新检查与下载状态、API 配额、发现新版本、安装器错误 | 15 |
| `ResetSections.kt` | 八个分区恢复默认的名称与后果说明 | 16 |
| `ReviewMath.kt` | 周一～周日 | 7 |
| `Model.kt` | 锁机提示文案、默认方案名、允许的应用 | 3 |
| `Screens.kt` | 选择应用 / 搜索 / 取消 | 3 |
| `LockEngine.kt` | 三种拦截原因（禁止名单 / 整机锁 / 不在允许名单） | 3 |
| `NotifyPlan.kt` | 专注完成 / 休息结束 / 两条提前提醒 | 5 |
| `SettingsScreen.kt` | 云同步六条错误路径 | 6 |
| 零散 | `BriefMath`（不到 1 分钟）、`OnboardMath`、`DistractMath`、`Stats.kt`（秒/分/小时）、`StatsCal`、`CloudAuto`、`HttpRaw`、`KeepAlive` | 12 |

## 本轮的三次翻车（都定位并修了）

1. **PowerShell 的 `\n` 又钻了一次**：用 `.Replace(...)` 改 Python 脚本时，
   双引号里的 `\n` 变成**字面反斜杠 n**，把一段代码压成了一行，报 `IndentationError`。
   教训和之前一样：**改文件用工具，不用 PowerShell 字符串拼接**。
2. **`HttpRaw.kt` 不在 `core/`**（在 `data/`），脚本报 FileNotFound 才发现。
3. **词典漏了「提醒」**：`LocCoverageTest` 立刻报「包了 Loc.t 但没有英文译文」——
   而这一条正是"讲提醒设置"的分区标题，漏了它在英文界面里会突兀地冒出中文。

## 覆盖率（实测）

- `Loc.t` 词典 **737 条**，`LocCoverageTest` 两条断言全绿
- `Loc.p` 就地双语 约 300 处
- 未包裹中文：**0**（扫描脚本判定"非注释行、且不在 `Loc.t`/`Loc.p` 里"的结果为空）

## 三端状态

| 端 | 版本 | 语言 |
|---|---|---|
| 桌面 | 0.1.125 | 中/英（842 条词典，切换即时生效） |
| Android | **0.7.9（code 46）** | 中/英（跟随系统语言，737 条 + 300 处就地双语） |
| 插件 | 1.2.3 | 中文为主 |

## 验证

- Android `cleanTestDebugUnitTest`：**329 通过**
- 版本：桌面 0.1.125 · Android 0.7.9 · 插件 1.2.3（未改）
