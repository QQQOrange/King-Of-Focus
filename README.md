# King of Focus

> 一个 Windows 上的专注 / 自律守护工具：按周计划拦住分心的软件和网页，用一个可调透明度的黑幕把屏幕盖上，并把你每天的时间花在哪记得清清楚楚。

- **版本**：0.0.1
- **开发者**：QQQOrange
- **项目地址**：<https://github.com/QQQOrange/King-Of-Focus>
- **本版本更新时间**：2026-10-26

---

## 一、它能干什么

| 模块 | 一句话说明 |
| --- | --- |
| 规则引擎 | 一条规则 = 一份名单（软件 / 网站分开维护）+ 一张周时间表。只在时间表里才生效。 |
| 黑名单 / 强制模式 | 黑名单：名单里的不许开；强制模式：只有名单里的能开，其他前台窗口一律关掉。 |
| 专注遮罩 | 选一个窗口留下，其余区域全部被纯黑遮罩盖住，透明度可实时调。 |
| 时长统计 | 每秒采样前台窗口，按「自律模式开启 / 未开启」两套数据独立记录。 |
| 统计报告 | 日 / 周 / 月 / 年 + 自定义 N 天，自动生成饼图报告，可随时回看。 |
| 云同步 | 走你自己的 WebDAV（坚果云 / Nextcloud / 群晖），手动或定时同步规则。 |
| 自动更新 | 启动检查 GitHub Releases，弹窗提示 → 下载 → 退出 → 静默安装 → 重新启动。 |

---

## 二、核心概念

### 1. 规则的生效逻辑

```
当前时间  ∈  某条已启用规则的时间表  →  这条规则「生效」
至少一条规则生效                        →  自律模式 = 已开启
```

- 时间表按 **周一 ~ 周日** 划分，每天可以有多段（例如 08:00-11:30、14:00-17:00），支持跨夜。
- **时间表全空 = 7×24 小时生效**，适合"永久封禁"的规则。
- 下周自动循环，不需要重复配置。

### 2. 软件与网站是分开的

| | 软件 | 网站 |
| --- | --- | --- |
| 名单存在哪 | 规则的「软件」页 | 规则的「网站」页 |
| 谁来执行 | Rust 主程序（枚举前台窗口 → 关闭进程） | 浏览器插件（`declarativeNetRequest` 重定向到拦截页） |
| 匹配方式 | exe 完整路径 / 文件夹 / 进程名通配 / 窗口标题 | 域名 / 路径前缀 / `*` 通配 |
| 例外 | — | 「网站例外」页，优先级高于黑名单 |

### 3. 强制模式（白名单）

开启后，生效时段内**只有名单里的软件能被前台显示**，其他有可见窗口的程序会被关闭。

保护机制（这些永远不会被拦）：

- 本程序自身、`explorer.exe`（桌面/任务栏）
- 路径位于 `C:\Windows\` 下的所有系统进程
- 「设置 → 全局保护名单」里的进程名（默认已内置几十个系统组件）

### 4. 专注遮罩

选一个窗口作为"允许留下的画面"，屏幕其余部分被纯黑遮罩覆盖：

- **不透明度** 20% ~ 100%，滑块拖动即时生效（打开遮罩时可以直接在屏幕上看到效果）
- **边缘留白** 0 ~ 60 px，让目标窗口四周留一点呼吸感
- **屏蔽鼠标操作**（可选）：开了遮罩会吃掉点击，只能操作目标窗口和本程序
- 目标窗口**关闭 / 最小化时遮罩自动退出**，不会把你困在黑屏里
- 全局热键 **Ctrl + Alt + K** 随时开关

---

## 三、技术方案

### 为什么是 Tauri 2 + Rust 原生 Win32

这个工具的核心是"每秒看一眼前台窗口，该关的立刻关掉"，性能与权限是硬指标：

| 方案 | 问题 |
| --- | --- |
| Electron + tasklist 轮询 | 每秒拉起子进程，CPU 抖动明显；杀进程还要走 `taskkill`，延迟 100ms+ |
| 内核驱动（Cold Turkey 的做法） | 拦得最彻底，但要签驱动、蓝屏风险、维护成本极高 |
| **Tauri 2 + 原生 Win32 FFI** | 单次枚举 ~1ms，常驻内存 40MB 左右，无运行时依赖，一个 exe 走天下 |

所以后端是 **纯 Rust**，直接 FFI 调用 `user32` / `kernel32`，没有引入任何 Windows 封装 crate：

```rust
EnumWindows → IsWindowVisible → GetWindowTextW        // 枚举有可见窗口的应用
GetWindowThreadProcessId → OpenProcess → QueryFullProcessImageNameW  // 拿到 exe 路径
PostMessageW(WM_CLOSE) → TerminateProcess             // 两段式关闭
```

### 专注遮罩：4 块分层窗口，不重绘

**没有**用全屏逐像素 alpha 重绘（1920×1080 一帧 8MB，拖窗口时必然卡）。而是：

```
┌──────────────────────────────┐
│            上遮罩             │
├──────┬────────────────┬──────┤
│ 左   │   目标窗口      │ 右   │   ← 四条纯黑 WS_EX_LAYERED 窗口
├──────┴────────────────┴──────┤
│            下遮罩             │
└──────────────────────────────┘
```

- 窗口移动时只做 `SetWindowPos`，**零像素拷贝**，30ms 跟随一次，拖拽缩放跟得上
- 透明度交给 DWM：`SetLayeredWindowAttributes(LWA_ALPHA)`
- 坐标基准是**虚拟桌面**（`SM_XVIRTUALSCREEN` 等），多显示器横竖拼接都对
- 进程声明 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`，混合 DPI 不错位
- `WS_EX_NOACTIVATE` 保证遮罩不抢焦点，`WS_EX_TRANSPARENT` 控制是否吃掉鼠标

### 进程拦截：两段式关闭

1. 先 `PostMessage(WM_CLOSE)` —— 让程序自己退，能保住现场
2. 700ms 后仍在运行 → `TerminateProcess` 强制结束

可以在设置里关掉"先温和关闭"。**拦截失败最常见的原因是权限不足**：目标程序以管理员运行而本程序不是，界面上会明确提示并给"以管理员身份重启"按钮。

### 时长统计：1 秒采样 + 小时桶

```
每秒一次：
  前台窗口 pid → exe 路径
  若前台是浏览器 且 插件 5 分钟内上报过标签页 → 记到「域名」上
  否则                                        → 记到「exe」上
  无操作 ≥ 60 秒                              → 不计时（可关）

落到 stats/days/YYYY-MM-DD.json：
  { "on":  { "app|c:\\…\\chrome.exe": {label, category, secs, hours[24]} },
    "off": { "site|youtube.com":       {…} } }
```

- 内存里累加，**每 15 秒落盘一次**，退出时再 flush 一次
- 日文件按小时分桶（0-23），所以能回溯到"某天某小时"
- 双轨数据在同一个文件里但是两个独立 map，**永不混合**

### 浏览器插件：MV3 + DNR

- `chrome.alarms`（最小 30 秒）拉取 `http://127.0.0.1:27315/api/state`
- 把规则翻译成 `declarativeNetRequest` 动态规则：
  - 黑名单网站 → `priority: 2` 重定向到 `blocked.html`
  - 网站例外 → `priority: 3` `allow`
  - 强制模式 → `priority: 1` 全拦 `*` + `priority: 4` 放行白名单
- 域名用 `requestDomains`（含子域），路径/通配用 `regexFilter`
- 切标签 / 页面加载完成立刻 POST `/api/heartbeat`，把 URL 报给主程序（统计用）
- 主程序侧有「浏览器守护」：要拦网页时插件失联超过 90 秒就关掉浏览器

### 云同步：WebDAV + last-write-wins

```
PUT  {dav 目录}/king-of-focus.json    上传（Basic Auth）
GET  {dav 目录}/king-of-focus.json    下载
```

- 载荷带 `updatedAt` 时间戳：云端更新就拉、本机更新就推、一样就跳过
- 账号密码只留本机，不随配置上传
- 404 视为"云端还没有文件"，自动转为首次上传
- 401/403/409/507 等状态码都翻译成中文提示

### 自动更新：GitHub Releases

```
GET api.github.com/repos/QQQOrange/King-Of-Focus/releases/latest
  → 比较 tag_name 与本机版本（语义化比较）
  → 优先选 *_Setup*.exe 资产
  → 下载到 %TEMP%\KingOfFocus\updates\（校验 MZ 头，防下到错误页）
  → 写一个 apply-update.cmd
  → app.exit(0)
```

`apply-update.cmd` 干这四件事：**等进程退出 → 删掉旧安装包 → `/S` 静默安装新包 → 启动新版本**，最后删掉自己和安装包。

GitHub 未登录的 API 额度是 60 次/小时，登录后 5000 次/小时。「关于」页可以填个人访问令牌提升额度，输入框是掩码，旁边 `?` 直接打开官方创建教程，并实时显示 `剩余 / 总额度`。

---

## 四、项目结构

```
king-of-focus/
├── src-tauri/                     # Rust 后端
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json            # 窗口 / 打包 / 版本号
│   ├── capabilities/default.json   # Tauri 2 权限声明
│   ├── icons/                      # 图标（脚本生成，见 tools/make_icon.py）
│   └── src/
│       ├── main.rs                 # 入口：单实例、托盘、线程装配、命令注册
│       ├── version.rs              # 版本 / 作者 / 仓库地址 / 发版日期
│       ├── model.rs                # 全部数据结构（serde，camelCase）
│       ├── cfg.rs                  # 配置读写 + 兜底修正
│       ├── shared.rs               # 跨线程共享状态（配置 / 运行态 / 当日统计）
│       ├── sched.rs                # 周时间表引擎（生效判定、下次翻转时间）
│       ├── proc.rs                 # Win32：窗口枚举、进程终止、软关闭
│       ├── matcher.rs              # 通配符匹配、软件/网站条目匹配、保护名单
│       ├── monitor.rs              # 拦截主循环（1 秒一拍）
│       ├── mask.rs                 # 专注遮罩（4 块分层窗口 + 热键）
│       ├── stats.rs                # 时长采样、日文件、聚合、报告与定时生成
│       ├── server.rs               # 127.0.0.1 本地 HTTP（给插件用）
│       ├── net.rs                  # HTTP 封装（ureq + native-tls + base64）
│       ├── sync.rs                 # WebDAV 同步（上传 / 下载 / 智能 / 定时）
│       ├── update.rs               # 自动更新（检查 / 下载 / 安装）
│       └── cmds.rs                 # 全部 #[tauri::command]
├── ui/                             # 前端（原生 HTML/CSS/JS，无构建步骤）
│   ├── index.html
│   ├── app.css                     # 深色 + 大圆角视觉
│   └── app.js                      # 六个视图 + 规则编辑器 + 饼图
├── extension/                      # Chrome / Edge 插件（MV3）
│   ├── manifest.json
│   ├── background.js               # 规则拉取、DNR 翻译、心跳
│   ├── blocked.html/.css/.js       # 拦截页
│   ├── popup.html/.js              # 状态小面板
│   └── icons/
├── tools/
│   └── make_icon.py                # 纯标准库生成 PNG/ICO 图标
└── README.md
```

### 运行时数据位置

| 内容 | 路径 |
| --- | --- |
| 配置（规则、设置、令牌） | `%APPDATA%\KingOfFocus\config.json` |
| 每日统计原始数据 | `%APPDATA%\KingOfFocus\stats\days\YYYY-MM-DD.json` |
| 统计报告 | `%APPDATA%\KingOfFocus\stats\reports\{period}_{start}_{end}.json` |
| 报告生成记录 | `%APPDATA%\KingOfFocus\stats\sched.json` |
| 更新临时目录 | `%TEMP%\KingOfFocus\updates\` |

数据保留默认 **400 天**（可改），超期的日文件与报告在启动时清理。

---

## 五、时长统计与报告的完整口径

### 采集

| 项目 | 说明 |
| --- | --- |
| 采样频率 | 1 秒 |
| 归属对象 | 当前**前台窗口**（不是所有运行中的程序） |
| 软件字段 | `label`（进程名）、`category="app"`、`secs`、`hours[24]` |
| 网页字段 | `label`（域名）、`category="site"`、`secs`、`hours[24]` |
| 计入条件 | 有键鼠操作；或开启了"计入无操作时间" |
| 排除 | 拿不到 exe 路径的进程 |

> 浏览器当前打开的网址由插件上报（切换标签、页面加载完成时立即上报）。所以**网页时长依赖插件**；没装插件时，浏览器的时间会记到 `chrome.exe` / `msedge.exe` 上。

### 两种状态

| 状态 | 判定 | 存储 |
| --- | --- | --- |
| 自律模式**已开启** | 至少一条规则处于生效时段 | 日文件里的 `on` |
| 自律模式**未开启** | 没有任何规则生效 | 日文件里的 `off` |

两者采集方式完全相同，但落在**两个独立的 map**，互不混合。

### 报告生成时机

| 周期 | 覆盖范围 | 生成时间 |
| --- | --- | --- |
| 日报 | 前一天 | 每天 00:00 |
| 周报 | 上周一 ~ 上周日 | 每周一 00:00 |
| 月报 | 上一个自然月 | 每月 1 日 00:00 |
| 年报 | 上一个自然年 | 每年 1 月 1 日 |
| 自定义 | 上一个完整 N 天 | 每个第 N 天的 00:00 |

- 判定循环每 30 秒跑一次，用 `sched.json` 记住"已经生成到哪一期"，所以**程序没开着也不会漏，下次启动自动补齐**
- 同一期只会生成一次，可在「统计报告」页手动重新生成
- 报告可以随时点开回看（含两份独立饼图 + 一份汇总饼图），也可单独删除

### 汇总口径

「两种状态汇总」这张饼图 = 把 `on` 和 `off` 两个数据集里**同一个应用 / 同一个域名**的秒数**直接相加**，不做任何加权、不做时间轴对齐。

扇区含义：该项在所选时间段内占全部前台时长的比例。

---

## 六、构建与运行

### 环境

- Windows 10 / 11（x64）
- Rust 1.77+（MSVC toolchain）
- Visual Studio Build Tools（提供 `link.exe`）
- 不需要 Node.js —— 前端是手写 HTML/CSS/JS，Tauri 会把 `ui/` 打进 exe

### 命令

```powershell
cd src-tauri
cargo build --release
# 产物：src-tauri/target/release/king-of-focus.exe
```

想用官方 CLI 打包安装包（NSIS）：

```powershell
npx @tauri-apps/cli build
# 产物：src-tauri/target/release/bundle/nsis/*.exe
```

### 首次运行

1. 右键 exe → **以管理员身份运行**（拦截管理员程序需要；普通程序不提权也能拦）
2. 程序收进托盘，双击托盘图标打开主界面
3. 到「规则」新建一条规则 → 加软件 / 加网站 → 画时间表 → 打开开关

### 安装浏览器插件

1. 主界面「设置 → 浏览器插件 → 打开插件目录」
2. Chrome / Edge 打开 `chrome://extensions` 或 `edge://extensions`
3. 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选 `extension` 文件夹
4. 回到主界面确认侧边栏显示"浏览器插件：已连接"
5. 建议在扩展详情里打开「允许访问文件地址」和「在无痕模式下启用」

插件默认连 `127.0.0.1:27315`，找不到会自动尝试相邻端口。

---

## 七、已知限制

- **只在 Windows 上工作**：大量 Win32 调用，没有跨平台打算。
- **不是内核级拦截**：和驱动级方案（Cold Turkey）比，理论上可以用"另一个管理员程序抢先"这类方式绕过。对自律场景够用，对"防别人破解"不够。
- **强制模式偏激进**：只关闭"有可见窗口"的进程，所以后台服务不受影响；但仍建议先开「演练模式」跑一天，确认名单没写错。
- **统计依赖前台窗口**：同一屏并排看两个窗口时，只有当前选中的那个计时。
- **令牌与密码是明文存在配置文件里**：只在本机，界面掩码显示。后续可以接 Windows DPAPI 加密。
- **云同步只同步规则与设置**：原始统计（几十 MB）不上传，避免把小网盘塞满。
- **更新需要 Release 里带 `*Setup*.exe` 资产**：没有安装包时弹窗会提示"该版本还没有上传安装包"。

---

## 八、发版流程

1. 改 `src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的版本号
2. 改 `src-tauri/src/version.rs` 里的 `BUILD_DATE`（关于页显示"本版本更新时间"）
3. `cargo build --release`，打包 NSIS 安装包
4. 在 GitHub 建一个 tag（如 `v0.0.2`），上传 `KingOfFocus-Setup-0.0.2.exe`
5. 老版本启动时会自动检测到并提示更新

---

## 九、许可

个人自用项目。要拿去改随意，出问题别找我。
