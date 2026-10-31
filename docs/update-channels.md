# 三端更新通道与跨平台错配防护

三个平台（Windows 桌面、Android、浏览器插件）**共用同一个 Release**，但各自只能拿自己的包。
这份文档说明：更新清单长什么样、平台标识怎么定、校验顺序是什么、失败时用户看到什么。

对应的实现：

| 平台 | 校验逻辑 | 网络/安装 | 界面 |
|---|---|---|---|
| 桌面 | `src-tauri/src/updsel.rs` | `src-tauri/src/update.rs` | 关于页「自动更新」 |
| Android | `android/.../core/Updater.kt` | `core/UpdateClient.kt` | 设置 → 版本与更新 |
| 插件 | `extension/update.js` | `extension/background.js` | 弹窗「版本与更新」 |

三份实现的**错误码逐字相同**，文档是唯一的事实源。

---

## 1. 为什么不能"按扩展名猜"

旧桌面端是这么选包的：在 Release 资产里找 `Setup*.exe` → 找任意 `.exe` → 找 `.msi`。
只有桌面版时没问题；一旦同一个 Release 里挂上 `King.Of.Focus-0.2.1-android.apk`，
任何"找找有没有安装包"的模糊匹配都会在某个边界条件下挑错：

- 发布脚本把桌面包命名成 `.apk`（手滑）→ 桌面端下载后 MZ 校验失败，但用户已经等了几十秒；
- 手机端"找 .apk"时，如果桌面端某天附带了一个叫 `apk-tools.zip` 的东西，也会误判；
- 更糟的是**装错包**：Android 上装不了 exe，但 Windows 上双击 apk 会去调"打开方式"，用户一脸茫然。

所以现在的规则是：**不猜**。清单里写死"哪个平台用哪个文件"，客户端只读写给自己的那一条。

---

## 2. 更新清单（`King.Of.Focus-update.json`）

作为 **Release 资产**上传，和安装包在同一个 Release 里。客户端先取
`/repos/{repo}/releases/latest`，再下载清单，再按清单核对。

```json
{
  "app": "king-of-focus",
  "schema": 1,
  "tag": "v0.1.52",
  "generatedAt": 1793500000,
  "notes": "这一版的说明（可选）",
  "platforms": {
    "windows-x64": {
      "version": "0.1.52",
      "kind": "installer",
      "file": "King.Of.Focus-0.1.52-windows-x64.exe",
      "size": 48234010,
      "sha256": "……64 位十六进制……"
    },
    "android": {
      "version": "0.2.1",
      "kind": "apk",
      "file": "King.Of.Focus-0.2.1-android.apk",
      "size": 16840357,
      "sha256": "……"
    },
    "chrome-extension": {
      "version": "1.1.1",
      "kind": "extension",
      "file": "King.Of.Focus-1.1.1-chrome-extension.zip",
      "size": 48211,
      "sha256": "……"
    }
  }
}
```

要点：

- **`platforms` 的键就是平台标识**，客户端用本机标识精确取值，取不到就报 `E_PLATFORM_MISSING`，
  **不会回退去找别的平台的条目**。
- 每个平台记**自己的版本**（三端版本本来就可以不同：Android 有 versionCode 节奏，
  插件在商店里有自己的版本线）。`tag` 只是仓库的发布锚点，跟桌面端版本一致。
- `size` / `sha256` 必填：这是"下全了"和"下对了"的唯一依据。

清单由 `tools/release_meta.py` 生成，内容全部来自**实际产物**（读源码版本 → 归档产物 → 算哈希），
不接受手写。

---

## 3. 平台标识

| 平台 | 标识 | 来源 |
|---|---|---|
| 桌面 | `windows-x64` / `windows-arm64` / `windows-x86` | `std::env::consts::ARCH` |
| 安卓 | `android` | 常量 `Updater.PLATFORM` |
| 插件 | `chrome-extension` | 常量 `KOFUpd.PLATFORM` |

标识是**编译期定死的**，不读配置文件、不读用户输入。用户能改的只有"检查哪个仓库"，
改不动"我是哪个平台"——否则填个错仓库就能让桌面端去拉安卓包。

---

## 4. 资产命名规范

```
King.Of.Focus-<version>-<platform>.<ext>
```

| 平台 | 允许的扩展名 |
|---|---|
| `windows-*` | `exe`、`msi` |
| `android` | `apk` |
| `chrome-extension` | `zip`、`crx` |

名字里的 **version 必须等于清单里的 version**，**platform 必须等于本机标识**。
这两条不一致就拒绝——发布脚本改版本号漏改包名，是最常见的事故。

---

## 5. 校验顺序与错误码

三端实现严格按这个顺序，遇到第一条不满足就停（不会"再往下找找"）：

| # | 检查 | 失败码 | 用户看到的话 |
|---|---|---|---|
| 1 | 清单 `app == king-of-focus` | `E_BAD_APP` | 这不是 King Of Focus 的更新清单 |
| 2 | `schema` 在支持范围内 | `E_BAD_SCHEMA` | 更新清单版本 N 本机读不懂，请手动下载新版 |
| 3 | `platforms[本机标识]` 存在 | `E_PLATFORM_MISSING` | 这次发布没有 <平台> 的安装包，本机不会去装别的平台的包 |
| 4 | `version` 是 `x.y.z` | `E_BAD_VERSION` | 清单里的版本号不是 x.y.z 形式 |
| 5 | 包名符合规范且版本一致 | `E_NAME_MISMATCH` | 包名和清单对不上：… 应该叫 … |
| 6 | 扩展名属于本平台 | `E_TYPE_MISMATCH` | 这是 <别的平台> 的安装包，不能装在 <本平台> 上 |
| 7 | `version > current` | `E_NOT_NEWER` | （不是错误）已经是最新版本 |
| 8 | `size > 0` | `E_BAD_SIZE` | 清单里没写文件大小 |
| 9 | `sha256` 是 64 位十六进制 | `E_BAD_HASH` | 清单里的 sha256 不合法，拒绝下载 |
| 10 | 该文件确实在这个 Release 的资产里 | `E_ASSET_MISSING` | Release 里找不到 …，清单和发布资产不一致 |

运行时/网络类的额外错误码：

| 码 | 含义 |
|---|---|
| `E_MANIFEST_FETCH` | 清单资产下载失败 |
| `E_BAD_MANIFEST` | 清单 JSON 坏了 |
| `E_NO_RELEASE` | 仓库还没有 Release（只有 tag） |
| `E_NETWORK` | 连不上 GitHub |

下载后的**二次校验**（不是"额外保险"，是最后一道闸）：

| 检查 | 失败表现 |
|---|---|
| 字节数 == 清单 `size` | 丢弃文件，提示"下载的文件大小不符" |
| `sha256(文件) == 清单 sha256` | 丢弃文件，提示"校验和对不上" |
| 文件头是本平台格式（桌面 `MZ`、安卓 `PK\x03\x04`） | 丢弃文件，提示"不是安装包" |

---

## 6. 老发布（没有清单）怎么办

`E_PLATFORM_MISSING` 会让老版本用户永远收不到更新——因为旧 Release 里没有清单。
所以留了一条**兜底路径**：清单缺失时，按扩展名扫资产，但必须满足两条：

1. 扩展名属于本平台（桌面 exe/msi、安卓 apk、插件 zip/crx）；
2. 文件名里不能出现别的平台的痕迹（`-android`、`.apk`、`-extension`、`-chrome`、`-windows`、`.exe`）。

并且界面上明说"这次发布没带更新清单，已按文件名兜底校验"。
新发布一律带清单，这条路径只为兼容历史版本。

---

## 7. 各平台差异（能做什么、不能做什么）

### 桌面
- 检测 → 下载（带进度）→ 退出 → 静默安装 → 重新启动。
- 装之前核 size + sha256 + `MZ` 头。

### Android
- 检测 → 下载到 `cacheDir/updates/` → 校验 → 交给系统安装器（`FileProvider`）。
- 需要「安装未知应用」授权：缺了就直接把用户带到那一页，不静默失败。
- **不静默安装**：查到新版本只是提示，装不装由用户点。

### 浏览器插件
- 检测 → 提示新版本 + 给出**本平台**包的下载地址。
- **不能自己装自己**：未打包安装的扩展没有静默更新通道（商店托管才有）。
  所以插件只做到"发现问题并把人送到正确的地方"，界面上明确写了这一句。

---

## 8. 发布前的一致性闸门

```bash
python tools/release_meta.py check          # 三端版本、产物命名、清单与哈希是否对得上
python tools/release_meta.py build --notes notes.md
python tools/release_meta.py check
python tools/release.py 0.1.52              # 按清单上传（本身就是核 sha 后才传）
```

`check` 会拦下这些情况：

- 三端版本号不是 `x.y.z`；
- 清单版本与源码版本不一致（改了版本号没重新 build 清单）；
- 产物缺失、名字不符合规范、扩展名不属于该平台；
- 产物大小或 sha256 与清单不符（说明产物被替换过）；
- Release 里缺清单或缺某个平台的包。

`--require-same` 可以额外要求三端版本号完全相同；默认只警告不失败，
因为三端本来就可能跑在不同的版本节奏上（`platforms.<id>.version` 各记各的）。
