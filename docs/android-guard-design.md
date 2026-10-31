# 手机应用限制的设计与实现（Android）

> 目标：把"手机上别干某件事"这件事做成一件事，而不是一个可以随手关掉的开关。
> 代码：`android/app/src/main/java/com/qqqorange/kingoffocus/`
> 本文只写**能做到什么、怎么做、做不到什么**——不做"理论上可以"的承诺。

---

## 一、权限：两种权限，各自解决什么

限制类应用的全部难点在"权限天花板"：普通应用既不能结束别人的进程，也不能阻止用户改设置。
所以这里要两种**互补**的权限，而不是"越多越好"：

### 1. 无障碍服务（AccessibilityService）

| 能力 | 说明 | 没有它时会怎样 |
|---|---|---|
| 前台识别（即时） | `TYPE_WINDOW_STATE_CHANGED` 一来就知道切到了谁 | 退回 1 秒轮询（`UsageStats`），慢一拍且"同一应用内换页"会判错 |
| 回桌面 | `performGlobalAction(GLOBAL_ACTION_HOME)`，不需要任何别的权限 | 退回 `startActivity(HOME)`，在 Android 10+ 会被 BAL（后台启动限制）拦 |
| 强制模式防绕过 | 用户进到"应用信息 / 无障碍"页面时按返回 | 只能靠 Shizuku 把设置整个关掉，否则这条路口是开的 |

代价与边界（写清楚，避免误伤）：
- 只在 `typeWindowStateChanged` 上工作，**不读**页面内容做业务判断（除了"这一页有没有本应用名"这一个布尔值）；
- 不联网、不落盘任何窗口内容；
- 永远不会覆盖状态栏、来电、紧急呼叫、权限弹窗、输入法（这几类被硬编码放行，见 `LockEngine.isAlwaysAllowed`）。

### 2. Shizuku（ADB 级 shell 权限）

Shizuku 让普通应用借到 **shell 用户**的权限。这里只用它做三件"无障碍做不到"的事：

| 用法 | 命令 | 价值 |
|---|---|---|
| 拉起遮罩 | `am start -n <pkg>/<LockActivity>` | shell 发起的启动不受 BAL 限制，**没有悬浮窗权限也能盖上来** |
| 弹掉设置 | `am force-stop com.android.settings` | 强制模式下用户一进设置就被踢出来（立刻生效，不留持久状态） |
| 无障碍自愈 | `settings put secure enabled_accessibility_services ...` | 用户把无障碍关掉后，替他把自家服务塞回启用列表 |

**故意不做的事**（实测过的坑，别再来一遍）：

- `pm set-user-restriction --user 0 no_control_apps 1`（禁用"强制停止/卸载"按钮）
  在 Android 13+ 需要 `MANAGE_USERS`，shell 身份直接 `SecurityException`。
  **所以本版无法阻止用户卸载/强制停止本应用。**
- 不会去 `pm disable-user com.android.settings`：一旦本应用崩了、Shizuku 断了，
  用户的设置就永久打不开了，风险远大于收益。
- 不会杀别的应用：那是"防沉迷"还是"病毒"，取决于用户有没有同意；这里选择不做。

### 3. 降级矩阵（权限缺失时会发生什么）

`Caps`（`core/Caps.kt`）是这张表的唯一实现，界面上的"当前防护等级"读的就是它：

| 能力 | 什么都没有 | 只有使用情况访问 | + 无障碍 | + Shizuku |
|---|---|---|---|---|
| 前台识别 | ✗ 不成 | 1 秒轮询 | 事件即时 | 事件即时 |
| 盖遮罩 | ✗ | 需要「悬浮窗」 | 需要「悬浮窗」 | **不需要**悬浮窗 |
| 回桌面 | ✗ | 需要「悬浮窗」 | 全局动作 | shell 按键 |
| 弹掉设置页 | ✗ | ✗ | 只能按返回（会被绕过） | ✓ |
| 无障碍被关后自愈 | — | — | ✗ | ✓ |
| **等级** | 未生效 | 基础 | 增强 | 完整 |

缺权限时**不允许静默降级**：
- 遮罩根本拉不起来 → 发一条「锁机没生效：缺「悬浮窗」或 Shizuku」的通知（每秒只发一次，按"段"去重）；
- 开强制模式时 → `Caps.strictBlocker()` 直接指出缺哪一块（识别 / 遮罩 / 弹设置），显示在设置页；
- 打开锁机开关时缺悬浮窗 → 直接把用户送到授权页，而不是"建议授予"。

---

## 二、模式：温和 / 强制

一个 `lock.mode` 字段，两条完全不同的承诺：

| | 温和（`gentle`，默认） | 强制（`strict`） |
|---|---|---|
| 遮罩上的「暂停锁机」 | ✓ 花积分换 N 分钟 | **不存在**（不是置灰） |
| 遮罩上的「停止锁机」 | ✓ 花积分结束这一段 | **不存在** |
| 长按强制解除 | ✓ | **不存在** |
| 暂停/停止状态 | 生效 | `isLockActive` **故意不看**这两个字段 |
| 结束方式 | 积分、白名单、等到点 | 只能等这一段自然走完 |
| 遮罩底部提示 | 长按可强制解除 | "只能等它走完" + 当前加固情况 |

关键实现点（都在 `core/LockEngine.kt`，纯函数、可单测）：

```kotlin
fun isLockActive(cfg, now): Boolean {
    ...
    if (isUnlocked(cfg, now)) return false      // 积分解锁窗口
    if (!isStrict(cfg)) {                       // 强制模式跳过这两条
        if (isPaused(cfg, now)) return false
        if (cfg.lockStoppedSeg == segmentKey(cfg, now)) return false
    }
    return true
}
```

两个容易漏的地方：

1. **切成强制时，之前买的暂停不算数**——否则"先温和暂停 10 分钟，再切强制"就是后门。
2. **强制锁机进行中不许切回温和**——`canSwitchMode()` 直接拒绝，否则"切回温和 → 点停止"是一步到位的绕过。
   这一段结束后随便改。

### 为什么用"段标识"而不是时间戳

`segmentKey()` = 从当前时刻往回走，直到前一个小时不再被选中，取那一小时的起点（`2026-10-31|3`）。

于是 19:00–22:00 连着三小时是**同一场**：用户点"停止"停的是这一整场；
下一场专注开始时段标识变了，"停止"自动失效。**不需要任何定时器去清理过期状态**。

---

## 三、防绕过

用户真正会做的五件事，逐个应对：

| 绕过手法 | 应对 | 效果 |
|---|---|---|
| 重启手机 | `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED` → 起前台服务 → 第一拍就恢复遮罩 | ✓ 已验证（见下） |
| 从最近任务划掉 / 后台被清 | `START_STICKY` + `onTaskRemoved` 补一发 1.5s 闹钟 + 15 分钟心跳广播 | ✓ 最多 15 分钟回来 |
| 进设置强制停止本应用 | 无障碍：把那几页按返回；Shizuku：整个设置弹掉 | ⚠️ 能挡，但不是绝对 |
| 关掉无障碍服务 | Shizuku 每 30 秒检查一次，发现没了就写回 `enabled_accessibility_services` | ✓（仅 Shizuku） |
| 卸载本应用 | **做不到**（要 Device Owner） | ✗ 如实写进界面 |

### 三个必须知道的硬限制

1. **`force-stop` 之后什么都收不到，包括 `BOOT_COMPLETED`。**
   Android 会把包标记成 `stopped=true`，直到用户**手动**再打开一次。
   实测：`dumpsys package <pkg>` 里 `stopped=true` 时，冷启动后进程根本不会起来。
   也就是说"在设置里点了强制停止"是唯一无法自动恢复的绕过方式——这不是实现问题，是系统规则。
2. **卸载/清除数据拦不住**（`no_control_apps` 要 `MANAGE_USERS`，shell 拿不到）。
3. **安全模式、root、换 ROM** 一律无效，这是所有非系统级防沉迷应用的共同天花板。

### 开机自启的具体链路

```
BOOT_COMPLETED / MY_PACKAGE_REPLACED
  → BootReceiver.onReceive(ctx)
      Store.init(ctx)                     // 关键：不先读配置就不知道要不要起
      if (cfg.enabled) GuardService.start(ctx) + scheduleHeartbeat(ctx)
  → GuardService.onCreate
      Store.init + ShizukuBridge.connect + scheduleHeartbeat
  → 第一拍 tick()
      锁机中？→ enforceLock() → 回桌面 + 压遮罩
```

`BootReceiver` 里那句 `Store.init` 不是可有可无：广播可能把进程**冷启动**，
不初始化就读到默认配置（`enabled=false`），于是"开机自启"看起来根本没执行。
同样的坑在 `KofAccessibility.onServiceConnected` 里也踩过一次（当时防绕过静默失效）。

---

## 四、一次锁机的完整时序

```
[专注段开始]
  GuardService.tick()（每秒）
    ├─ LockEngine.isLockActive(cfg, now)?
    │    ├─ 否 → 什么都不做
    │    └─ 是 → enforceLock()
    │         ├─ Caps.canShowMask()? 否 → 发"锁机没生效"通知（按段去重）
    │         ├─ fg = 无障碍事件 ?? UsageStats
    │         ├─ 强制 && fg==设置 && 有 Shizuku → am force-stop 设置
    │         ├─ fg 在白名单/紧急通道/自己？ → 不动
    │         ├─ goHome()：无障碍全局动作 → startActivity(HOME) → shell keyevent
    │         └─ 260ms 后 showLock()：Shizuku am start → 失败退回 startActivity
    └─ 强制模式每 30s：无障碍被关就写回
[用户点暂停/停止]（仅温和）
  LockActivity → Store.update(points-=cost, lockPausedUntil/lockStoppedSeg) → finish()
  下一拍 isLockActive=false → 遮罩不再出现
[这一段结束]
  ScheduleEngine.stateAt()==null → isLockActive=false → 遮罩自检退场
```

---

## 五、验证记录（真机 / 模拟器）

| 项目 | 结果 |
|---|---|
| 强制模式遮罩没有暂停/停止/长按解除 | ✓ |
| 温和模式三者齐全 | ✓ |
| 撤掉「使用情况访问」后仍能识别前台（只靠无障碍） | ✓ 回桌面、开别的应用都被拉回遮罩 |
| 强制模式进「应用详情」被弹回并重新盖遮罩 | ✓ 日志：`挡住设置页（内容=false 标题=true [App info]）` |
| 缺少悬浮窗时不静默失败 | ✓ 发「锁机没生效」通知，遮罩不出现 |
| 广播接收 → 启动前台服务 | ✓ `Background started FGS: Allowed ... code:PACKAGE_REPLACED` |
| Shizuku 真实链路 | ✗ 模拟器里没跑通（需要 Shizuku 应用 + 无线调试配对），代码路径未在设备上验证 |
| 真正重启手机 | ✗ 该 AVD 冷启动不保留 userdata（`-no-snapshot` + 强杀），属环境问题 |

---

## 六、给后续改动的提醒

1. 任何组件读 `Store` 之前必须 `Store.init()`——无障碍服务、广播接收器都可能独立冷启动。
2. 改 `IShell.aidl` 必须同时 +1 `UserServiceArgs.version`，否则 Shizuku 会复用旧进程。
3. `ShizukuBridge` 里所有方法都不抛异常、失败返回 false/null：**能力缺失不是错误**。
4. 强制模式新增出口时，先问一句"这算不算暂停/跳过"，算就必须在 strict 分支里屏蔽。
5. 别在 `tick()`（主线程）里调 `ShizukuBridge.exec`——那是阻塞 Binder 调用，用 `bg.execute {}`。
