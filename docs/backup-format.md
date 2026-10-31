# 跨设备备份格式（v1）

> 一份备份，电脑和手机都能读、都能写、都能恢复。
> 桌面端实现：`src-tauri/src/portable.rs`（读写在 `backup.rs`）
> 手机端实现：`android/app/src/main/java/com/qqqorange/kingoffocus/data/Portable.kt`
> 共享样例：`tools/fixtures/`（**两端测试都读同一份**，这是"兼容"的硬约束）

---

## 1. 文件长什么样

备份文件（`.kofbak`）只有两种形态：

### A. 明文（没设备份密码）

文件本身就是那份 JSON 文档：

```json
{
  "kof": "king-of-focus",
  "format": "kof-portable",
  "schema": 1,
  "createdAt": 1793510000,
  "source": "desktop",
  "device": "DESKTOP-XXXX",
  "appVersion": "0.1.51",
  "rules": [ ... ],
  "clock": { ... },
  "points": { ... },
  "settings": { ... }
}
```

`kof` 是识别标记：不是这个值的一律不碰，避免把别人的 JSON 当成备份恢复进去。

### B. 加密（设了备份密码）

```json
{
  "kofEnc": 3,
  "kdf": "pbkdf2-sha256",
  "iter": 600000,
  "salt": "<base64 16B>",
  "nonce": "<base64 12B>",
  "data": "<base64 密文>"
}
```

- KDF：PBKDF2-HMAC-SHA256，`iter` 默认 600000（读取时以文件里的值为准，合理区间 10k–4M）
- 加密：AES-256-GCM，12 字节 nonce，16 字节 tag（附加在密文尾部）
- AAD：`king-of-focus-portable-v1`（**写死**，两端必须一致，否则解不开）
- 解密后的明文 = 上面那份文档

### C. 旧信封（只读，不再写）

| `kofEnc` | 方式 | 谁解不开 |
|---|---|---|
| 1 | Argon2id + AES-256-GCM | 手机（无 Argon2 实现） |
| 2 | Windows DPAPI | 除本机以外的任何设备 |

桌面端仍能解开 1/2（老备份不废）；手机端遇到会明确提示
「请在桌面端设置备份密码后重新备份」，而不是报"文件损坏"。

> 为什么设了密码统一走 PBKDF2 而不是继续用 Argon2id：手机端 `javax.crypto`
> 自带 `PBKDF2WithHmacSHA256`，没有 Argon2。要"设了密码的备份能直接在手机
> 上打开"，两端必须共用同一套 KDF。600000 轮 PBKDF2-SHA256 是 OWASP
> 的推荐档位，强度仍然在线。

---

## 2. 文档结构（两端逐字段对齐）

### `rules[]`（自律规则，桌面端结构的超集）

| 字段 | 类型 | 说明 | 手机端 |
|---|---|---|---|
| `id` | string | 稳定标识 | 原样保存 |
| `name` | string | 显示名（也参与去重指纹） | ✔ |
| `enabled` | bool | 是否启用 | ✔ |
| `mode` | string | `blacklist` / `whitelist` / `both` | `both` 先按 `blacklist` 处理，原值随 `carry` 保留 |
| `hard` | bool | 固化 | ✔ |
| `apps[]` | array | 名单，`kind` ∈ `exe` `dir` `name` `title` `pkg` | 只认 `pkg`（= 包名），其余进 `foreign` 保管 |
| `sites[]` | array | 网站名单 `{pattern,label}` | 不支持，进 `foreign` |
| `exceptions[]` | string[] | 网站例外 | 不支持，随 `carry` 保留 |
| `schedule[7][]` | array | 规则自己的时段表 | 不支持，随 `carry` 保留 |
| `lock` | object | 解锁方式（timer/password/text） | 不支持，随 `carry` 保留 |
| `color` | string | 列表色标 | 不支持，随 `carry` 保留 |
| `extraProtected` | string[] | 额外保护进程 | 不支持，随 `carry` 保留 |
| `brk` | object | 番茄参数 | 不支持，随 `carry` 保留 |
| `autolaunch` | object | 进专注段自动打开 | 不支持，随 `carry` 保留 |

手机端的三条"保管"通道，就是为了**无损往返**：

- `apps` 里 `kind == "pkg"` 的 → `Rule.packages`（真正生效的名单）
- 其它 `apps` + 全部 `sites` → `Rule.foreign`（不参与判定，只保管，界面上显示"另有 N 个桌面条目"）
- 其余桌面专属字段 → `Rule.carry`（这条规则原始 JSON；导出时叠回手机端可改的几项）

于是：桌面 → 手机（改个名字 / 开关） → 桌面，时段表、网站名单、例外、颜色都还在。

### `clock`（时段）

```json
{
  "enabled": true,            // 自律时段总开关
  "applyRules": true,
  "granularity": 15,
  "active": "p1",
  "profiles": [
    { "id": "p1", "name": "默认时段", "defWork": 50, "defBrk": 10,
      "days": [ [ {"on":true,"work":50,"brk":10,"from":0,"to":60}, ...24 ], ...7 ] }
  ]
}
```

- 桌面端可以有多套方案；**手机端只有一套**（7×24 平铺），恢复时取 `active` 指向的那套，
  导出时写回一套固定 id `p1` 的方案。
- 桌面端"一小时里两段"（`wins`）手机端表达不了：读入时取外包区间（`min(from) … max(to)`），
  宁可多盖一点也不漏。
- `enabled` 在手机端就是「启用自律」总开关。

### `points`

`balance`（余额）、`totalEarned`、`unlockUntil`（积分解锁截止时间）。
手机端只有 `balance` + `unlockUntil`，导出时 `totalEarned` 填当前余额。

### `settings`（两端都说得通的设置）

`lang`、`theme`、`notify{enabled,workBefore,breakBefore,breakNotify}`。

**不在文档里的**（各平台自己的，备份不碰）：
桌面端 —— 遮罩、HUD、端口、轮询间隔、开机自启、管理员权限、云同步/更新凭据、备份密码；
手机端 —— 拦截页文案、是否允许在拦截页结束自律。

---

## 3. 覆盖（overwrite）

> 用备份里的内容**替换**本机对应内容。

做：
- `rules` → 整体替换（备份空了就是空了）
- `clock` → 整体替换（含 `enabled` / `applyRules` / 粒度 / 全部方案）
- `points` → 整体替换
- `settings.lang` / `theme` / `notify` → 替换（`notify.focusWindow` 是桌面专属，保留本机）

不做：
- 平台专属设置（见上）一个字都不改
- 备份密码、云同步账号、更新令牌不动（否则恢复一份朋友的备份就把自己的账号顶掉了）

老的桌面备份（`kofEnc:1/2`，载荷是整份 `Config`）走覆盖时保持老语义：**整份替换**
（只保留本机的 sync/backup/update/theme）。这是它当初的承诺，不能悄悄改。

纪律校验：覆盖会让规则变弱，所以桌面端在自律时段内会拒绝——和"改配置"同一套判定
（`guard::config_replace_blocked`）。

---

## 4. 合并（merge）

> 只做加法：**只会变多，不会变样**。

### 规则

对备份里的每一条规则（按文件顺序）：

| 情况 | 判定 | 结果 |
|---|---|---|
| 本机已有同 `id` 的规则 | 已存在 | 跳过（`skipped++`），本机那条**一个字段都不改** |
| 内容指纹相同（名字+模式+名单） | 已存在 | 跳过（`skipped++`） |
| 名字相同但内容不同 | 冲突 | 追加副本，名字改为「原名（来自备份）」/「（来自备份 2）」…（`conflict++`） |
| 其它 | 新增 | 原样追加（`added++`） |

内容指纹（两端同一套算法）：

```
lower(trim(name)) + "|" + trim(mode) + "|" + sorted(lower(trim(apps[].value))) + "|" + sorted(lower(trim(sites[].pattern)))
```

为什么不用"时段 + 颜色 + 固化"一起算指纹：这些是"强度/外观"，不是"这条规则是什么"。
同一份名单 + 同一个名字就是同一条，否则两份排班不同的备份一合就会出现一对孪生规则。

保证：**同一份备份合并两次，结果和一次一样**（幂等）。

### 时段

逐小时：本机这一小时**没选中**且备份里选中 → 用备份的那一小时补上（`slots++`）；
本机已选中的小时**一个字都不改**（番茄参数、起止分钟都不动）。

### 积分

`balance` / `totalEarned` 取两边**较大值**，不累加——否则来回导入几次就能刷分。
`unlockUntil`（解冻到什么时候）以本机为准，合并不会延长已买的解锁。

### 其余设置

不动。合并的承诺是"只加不减"，改设置就违背了。

---

## 5. 兼容策略

1. **只读认识的字段**：多出来的键忽略，缺的键用默认值（`schema` 只做加法演进）。
2. `schema > 1` 直接拒绝并提示升级，不试图"猜着读一半"。
3. 手机端保存的配置里，规则多两个字段（`foreign` / `carry`），都是备份往返用的，
   老配置没有它们时默认为空——不需要迁移。
4. 指纹算法、AAD、字段名：**任一端改动都必须同步另一端**，并同时跑
   `tools/fixtures/` 的样例测试。

---

## 6. 怎么验证「真的互通」

| 检查 | 位置 |
|---|---|
| 桌面端读桌面端样例 | `portable::tests::shared_fixture_parses` |
| 桌面端读**手机**样例（含 `pkg` 条目） | 同上（`portable-android.json`） |
| 手机端读桌面样例（含 `exe` / `site` 条目） | `PortableTest.desktopFixtureParses` |
| 手机端读**桌面端加密**的备份 | `PortableTest.desktopEncryptedBackupDecrypts` |
| 手机转一圈不丢桌面专属字段 | `PortableTest.carryKeepsDesktopOnlyFields` |
| 合并幂等 / 去重 / 冲突改名 | 两端各一组 |
| 覆盖不动平台专属设置 | 两端各一组 |

`portable-enc.json` 是桌面端代码加密出来的（密码 `kof-demo-2026`），
重新生成：`cd src-tauri && cargo test __gen_interop_fixture -- --ignored`。

---

## 7. 界面上的两条路径

**桌面端**（设置 → 备份与云同步）
- 「立即备份」：写进 `king of focus back/`，保留最近 10 份且 7 天内
- 「导出跨设备备份…」：自选位置，`.kofbak`，可拷到手机
- 「从文件恢复…」：选任意 `.kofbak`
- 本地 / 云端列表里的「恢复」：同样先问覆盖还是合并

**手机端**（设置 → 备份与恢复）
- 「备份密码」：和桌面端填同一个即可互通；留空 = 明文
- 「导出备份…」：系统文件选择器（SAF），不需要存储权限
- 「从文件恢复…」：选文件 → 选覆盖/合并 → 结果写在按钮下方
