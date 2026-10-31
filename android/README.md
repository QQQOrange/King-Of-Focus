# King Of Focus · Android

与桌面版同一套自律模型：**自律时段（7×24）→ 番茄（专注/休息循环）→ 名单拦截 → 积分**。
但 Android 的沙箱决定了有些能力**不可能**照搬，下面把每一条都写清楚，避免"看起来一致、实际做不到"。

## 一、能力映射（桌面版 → Android）

| 桌面版功能 | Android 实现 | 说明 |
|---|---|---|
| 规则名单（软件） | ✅ 已安装应用多选（包名） | 名单存在本机 JSON |
| 规则模式（黑/白名单） | ✅ blacklist / whitelist | 白名单自动放行系统壳（桌面、输入法、设置），否则手机会变砖 |
| 自律时段 7×24 小时网格 | ✅ | 整小时粒度；桌面版的"分钟级收窄（from/to）"数据模型保留但界面未提供 |
| 番茄（专注 N / 休息 M） | ✅ 完全一致 | 相位锚点=整点，`offset % (work+brk)` 取模，尾段截断 |
| 阶段提醒 | ✅ 系统通知 | 每个阶段只响一次，剩余时间跳大视为新阶段 |
| 应用拦截 | ⚠️ 前台检测 + 全屏拦截页 | **不能结束别的应用进程**；效果是"切到被拦应用立刻跳回拦截页" |
| 网页拦截（浏览器插件） | ❌ 未实现 | 需要 VPNService 或无障碍服务抓 URL，属高敏感权限，不在本版范围 |
| 专注遮罩（盖住其他窗口） | ⚠️ 拦截页本身即全屏遮罩 | Android 不允许盖住别人的窗口并保持最上层（除悬浮窗，且不能阻止交互） |
| 固化（不可退出、杀任务管理器） | ⚠️ 逻辑保留 | 只能"拒绝在应用内关闭自律"；系统设置里强行停止本应用无法阻止 |
| 任务管理器封杀 / 关机 | ❌ 不可实现 | 平台不提供；桌面版的"睡眠时段关机"在 Android 上是"勿扰/定时静音"的范畴，未做 |
| 全局热键 | ❌ 不可实现 | 改为通知栏常驻 + 桌面快捷方式 |
| 积分（专注每分钟 +1 / 解锁） | ✅ | 解锁期间所有拦截暂停（与桌面版修复后的语义一致） |
| 统计报表 | ❌ 未实现 | 本版只有积分与当前状态；UsageStats 的按应用统计留作后续 |
| 备份 / 同步 / 更新 | ❌ 未实现 | 依赖桌面端的数据目录与 GitHub 更新链路 |

**一句话**：能自律的部分做到了行为一致；涉及"管别的应用 / 管操作系统"的部分，Android 不允许，本版改为"看住前台 + 全屏劝返"。

## 二、权限（为什么每一项都必须）

| 权限 | 用途 | 不给会怎样 |
|---|---|---|
| `PACKAGE_USAGE_STATS`（使用情况访问） | 唯一能读"当前前台是哪个应用"的公开通道 | 无法检测，等于没有拦截 |
| `SYSTEM_ALERT_WINDOW`（悬浮窗） | 部分 ROM 上拦截页需要它才能盖住 | 拦截页可能被目标应用压下去 |
| `POST_NOTIFICATIONS` | 阶段提醒 + 常驻状态 | Android 13+ 收不到提醒 |
| `FOREGROUND_SERVICE(_SPECIAL_USE)` | 每秒守护循环 | 后台被冻结，时段完全不生效 |
| `QUERY_ALL_PACKAGES` | 列出可拦截的应用 | 应用选择器为空 |
| `RECEIVE_BOOT_COMPLETED` | 开机后恢复守护 | 重启后要手动打开一次 |

## 三、构建

前置：JDK 17、Android SDK（platform 35 / build-tools 35.0.0）。

```bash
cd android
# local.properties 里写 sdk.dir，例如 C:\\dev\\android-sdk
gradle assembleDebug          # 产物 app/build/outputs/apk/debug/app-debug.apk
gradle testDebugUnitTest      # 时段/番茄/拦截判定的单测
```

本机使用的工具链：微软 OpenJDK 17 + cmdline-tools 11076708 + Gradle 8.9 + AGP 8.7.3 + Kotlin 2.0.21。

## 四、安装与首次使用

1. `adb install -r app/build/outputs/apk/debug/app-debug.apk`
2. 打开应用 → 总览页按提示授予「使用情况访问」「通知」（悬浮窗视机型）
3. 「时段」页点亮要自律的小时；「规则」页新建规则并勾选应用
4. 回到总览打开「启用自律」→ 常驻通知出现即生效

## 五、已知限制（如实列出）

1. **不能杀进程**：拦截是"拉回拦截页"，用户按 Home 键仍可离开，再次打开会立刻被拉回。
2. **按 Home 可绕过**：这是设计取舍——不给出口会把手机锁死，属故障而非自律。
3. **国产 ROM 会杀后台**：需要在系统设置里给本应用"允许后台运行 / 忽略电池优化"。
4. **卸载或撤销权限即可绕过**：Android 上没有"防卸载"的合规手段。
5. **网页拦截缺失**：需要 VPN/无障碍，本版未做。

## 六、代码结构

```
app/src/main/java/com/qqqorange/kingoffocus/
  data/Model.kt        配置模型（与桌面版字段语义对齐）
  data/Store.kt        原子写 + 损坏留档
  core/ScheduleEngine  时段与番茄（纯函数，单测覆盖）
  core/GuardEngine     规则判定 + 前台应用读取
  service/GuardService 前台服务：每秒一拍、提醒、拉起拦截页
  service/BootReceiver 开机恢复
  ui/BlockActivity     全屏拦截页
  MainActivity.kt      总览 / 设置
  Screens.kt           时段网格 / 规则 / 应用选择
```
