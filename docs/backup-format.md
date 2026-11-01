# 跨设备备份格式（kof-portable · schema 1）

> **一份文件，两端都能读、都能写、都能恢复，且不区分来源设备。**
>
> - 桌面端实现：`src-tauri/src/portable.rs`（读写与信封在 `backup.rs`）
> - 手机端实现：`android/.../data/Portable.kt`
> - 参考文档：`tools/fixtures/portable-canon.json`（两端都要能读，且读出来的字段集合必须一致）
> - 字段签名：`tools/fixtures/portable-shape.txt`（**两端测试拿同一份当尺子**）
> - 自动校验：`node tools/check_portable.js`

这里说的"备份"包含**四种入口**，它们产出的都是同一个东西：

| 入口 | 桌面端 | 手机端 |
|---|---|---|
| 本地/自动备份 | 「立即备份」→ `king of focus back/kof-<时间>.kofbak` | 自动备份 → `kof-auto-android.kofbak` |
| 手动导出 | 「导出跨设备备份…」→ `kof-backup-<时间>.kofbak` | 「导出备份…」→ 同名规则 |
| 云端 | WebDAV `kof-<时间>.kofbak` | WebDAV `kof-<时间>-android.kofbak` |
| 导入 | 「从文件恢复…」/列表里的「恢复」 | 「从文件恢复…」 |

云端文件名里那段 `-android` **只用于"谁该清谁"的保留策略**（见 `backup::prune_targets`），
读文件的人一个字节都不看它；手动导出的文件名两端逐字相同。

---

## 1. 文件形态

### A. 明文（没设备份密码）

```json
{
  "kof": "king-of-focus",
  "format": "kof-portable",
  "schema": 1,
  "createdAt": 1793510000,
  "source": "desktop",
  "device": "DESKTOP-XXXX",
  "appVersion": "0.1.70",
  "rules": [ ... ],
  "clock": { ... },
  "points": { ... },
  "settings": { ... },
  "stats": { ... }
}
```

`kof` 是识别标记：不是 `king-of-focus` 的一律不碰，避免把别人的 JSON 当备份恢复进去。

### B. 加密（设了备份密码，**两端唯一会写的信封**）

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

- KDF：PBKDF2-HMAC-SHA256，写入 600000 轮；读取**以文件里的 `iter` 为准**（合理区间 10k–4M，
  越界直接拒绝，防止被构造的文件拖死）
- 加密：AES-256-GCM，12 字节 nonce，16 字节 tag（附在密文尾部）
- AAD：`king-of-focus-portable-v1`（写死，两端必须一致，否则解不开）
- 解密后的明文 = 上面那份文档

### C. 旧信封（**只读，不再写**）

| `kofEnc` | 方式 | 谁能打开 |
|---|---|---|
| 1 | Argon2id + AES-256-GCM | 只有桌面端 |
| 2 | Windows DPAPI | 只有创建它的那台机器 / 那个账户 |

这两种是历史遗留，正是"备份只能由生成它的设备读"的根源。现在：

- 写入路径**不再产生** 1/2。桌面端「立即备份」和云端备份以前没有密码就走 DPAPI，
  等于云端那份谁都读不了（换台电脑重装、或拿手机去恢复，只会看到"文件损坏"）。
  现在统一走 `seal_portable`：有密码 → `kofEnc:3`，没密码 → 明文。
- 读取路径仍然认 1/2（用户升级前留下的备份还得能恢复）；手机端遇到会明确提示
  「这份备份是桌面端旧方式加密的，请在桌面端设密码后重新导出」，而不是报"文件损坏"。

> 为什么不继续用 Argon2id：Android `javax.crypto` 自带 `PBKDF2WithHmacSHA256`，没有 Argon2。
> 要"设了密码的文件在手机上也能打开"，两端必须共用同一套 KDF。

---

## 2. 文档结构

### 顶层

| 字段 | 类型 | 说明 |
|---|---|---|
| `kof` | string | 固定 `king-of-focus` |
| `format` | string | 固定 `kof-portable` |
| `schema` | number | 结构版本（见 §5） |
| `createdAt` | number | 生成时刻（unix 秒） |
| `source` | string | `desktop` / `android` —— **只是出处标签** |
| `device` | string | 主机名 / 机型 —— 只用于界面显示 |
| `appVersion` | string | 生成者的版本号（信息性，不参与判定） |
| `rules[]` | array | 自律规则 |
| `clock` | object | 时段（多套方案） |
| `points` | object | 积分账户的四个共享项 |
| `settings` | object | 语言 / 配色 / 提醒 |
| `stats` | object | 对方的统计摘要（不带原始数据） |

**`source` / `device` 不许参与任何读写分支。** 恢复流程只有一条：
`parse → to_config（覆盖）/ merge（合并）`，两端完全一样。手机导出的文件在电脑上恢复、
电脑导出的文件在手机上恢复，走的是同一段代码。

### `rules[]`

桌面端 `Rule` 的完整形状，手机端**一个键都不少地写出来**（没有的用默认值）：

| 字段 | 类型 | 说明 | 手机端 |
|---|---|---|---|
| `id` | string | 稳定标识 | ✔ |
| `name` | string | 显示名（也参与去重指纹） | ✔ |
| `enabled` | bool | 是否启用 | ✔ |
| `mode` | string | `blacklist` / `whitelist` / `both` | ✔（`both` 的两张名单见下） |
| `hard` | bool | 固化 | ✔ |
| `apps[]` | array | `{id,kind,value,label}`，`kind` ∈ `exe` `dir` `name` `title` `pkg` | 只认 `pkg`，其余进 `foreign` 保管 |
| `sites[]` | array | `{id,pattern,label}` | 不支持，进 `foreign` |
| `exceptions[]` | string[] | 网站例外 | 不支持，随 `carry` 保留 |
| `schedule[7][]` | array | 规则自己的时段表，元素 `{start,end}` | 不支持，随 `carry` 保留 |
| `lock` | object | `{kind,until,password,chars}` | 不支持，随 `carry` 保留 |
| `color` | string | 列表色标 | 不支持，随 `carry` 保留 |
| `extraProtected[]` | string[] | 额外保护进程 | 不支持，随 `carry` 保留 |
| `brk` | object | `{kind,workMin,breakMin}` | 不支持，随 `carry` 保留 |
| `autolaunch` | object | `{enabled,items[]}`，`items` 元素 `{id,kind,target,args,window,browser}` | 不支持，随 `carry` 保留 |

手机端三条"保管"通道保证**无损往返**：

- `apps` 里 `kind == "pkg"` → `Rule.packages`（真正生效的名单）
- 其它 `apps` + 全部 `sites` → `Rule.foreign`（不参与判定，只保管）
- 其余桌面专属字段 → `Rule.carry`（这条规则原始 JSON，导出时叠回去）

于是：桌面 → 手机（改个名字 / 开关）→ 桌面，时段表、网站名单、例外、颜色都还在。

### `clock`

```json
{
  "enabled": true,
  "applyRules": true,
  "granularity": 15,
  "viewFrom": 0,
  "viewTo": 1440,
  "fitAll": true,
  "active": "p1",
  "profiles": [
    { "id": "p1", "name": "默认时段", "defWork": 50, "defBrk": 10, "defCap": 0,
      "bound": [],
      "days": [ [ {"on":true,"work":50,"brk":10,"from":0,"to":60}, ...24 ], ...7 ] }
  ]
}
```

- 多套方案：`profiles` 是数组，`active` 指向生效的那套；两端都完整保留。
- 一小时多段：`{"wins":[{"from":0,"to":15,"seg":"s-a"},{"from":30,"to":45,"seg":"s-b"}]}`，
  非空时以它为准；`on/from/to/seg` 是单段情况下的等价表示（给老代码读）。
- `defCap` = 每小时累计休息上限（0 = 不限），**始终写出来**（省略会让另一端分不清"没有上限"与"没这个键"）。
- `viewFrom` / `viewTo` / `fitAll` 是桌面端的纯展示参数，手机端没有对应界面，
  但键要写（默认值），否则两端的文件在字段上就不一样了；手机上读到时忽略。

### `points`

`balance`、`totalEarned`、`unlockUntil`（积分解锁到何时）、`sleepUnlockUntil`（睡眠时段买断到何时）。

桌面端的 `unlockCountToday` / `day`（今天用了几次）**不进文档**：那是本机记账，
跟着备份跑到另一台机器上只会算错，恢复时也不许把本机的计数清零。

### `settings`

`lang`、`theme`、`notify{enabled,workBefore,breakBefore,breakNotify}`。

- `lang` / `theme` **空串 = "这台设备没有这个概念，别改对端的"**。
  手机端没有语言/配色切换，导出时写 `""`；桌面端读到 `""` 会保持本机原样。
  （以前手机端硬写 `zh-CN` / `system`，一份手机备份就能把桌面调好的英文界面 +
  深色配色一键还原。）
- `notify` 只有四项共用；桌面的 `focusWindow`（提醒时拉窗口到前台）不进文档。

### `stats`

```json
{ "schema": 1, "source": "android", "device": "Pixel", "at": 1793510000,
  "days": [ { "day": "2026-11-01", "total": 7200, "on": 3600,
              "top": [ { "name": "微信", "secs": 1800 } ] } ] }
```

只带摘要（每天总时长 / 自律时长 / 前三个应用，30 天），不带原始日文件——
两端存储结构不同，原样互传没人读得懂，而且相加没有意义。
接收端存成 `peer_stats`，**不并入本机统计**，统计页单独一行展示。

收下它时有三个条件：不空、`at` 比本机已有的新、不是本机自己导出的。

### 不在文档里的（各平台自己的，备份不碰）

- 桌面端：遮罩、HUD、端口、轮询间隔、开机自启、管理员权限、云同步/更新凭据、备份密码
- 手机端：拦截页文案、是否允许在拦截页结束、通知细项（完成/汇总/进度）、权限申请历史

---

## 3. 覆盖（overwrite）

> 用备份里的内容**替换**本机对应内容。

做：`rules` 整体替换；`clock` 整体替换（含开关、粒度、全部方案）；
`points` 的四个共享项替换；`settings.lang/theme/notify` 按"有值才换"的规则替换。

不做：平台专属设置（见上）一个字都不改；备份密码、云同步账号、更新令牌不动
（否则恢复一份朋友的备份就把自己的账号顶掉了）；`points` 的本机记账不动。

老的桌面备份（`kofEnc:1/2`，载荷是整份 `Config`）走覆盖时保持老语义：**整份替换**
（只保留本机的 sync/backup/update）。这是它当初的承诺，不能悄悄改。

纪律校验：覆盖会让规则变弱，桌面端在自律时段内会拒绝——和"改配置"同一套判定
（`guard::config_replace_blocked`）。

---

## 4. 合并（merge）

> 只做加法：**只会变多，不会变样**。

| 情况 | 判定 | 结果 |
|---|---|---|
| 本机已有同 `id` 的规则 | 已存在 | 跳过（`skipped++`），本机那条一个字段都不改 |
| 内容指纹相同 | 已存在 | 跳过（`skipped++`） |
| 名字相同但内容不同 | 冲突 | 追加副本，名字改为「原名（来自备份）」/「（来自备份 2）」…（`conflict++`） |
| 其它 | 新增 | 原样追加（`added++`） |

内容指纹（两端同一套算法，`portable::sig` ↔ `Portable.sig`）：

```
lower(trim(name)) + "|" + trim(mode) + "|" + sorted(lower(trim(apps[].value))) + "|" + sorted(lower(trim(sites[].pattern)))
```

时段：逐小时，本机没选中且备份选中 → 补上（`slots++`）；本机已选中的一个字都不改。
积分：`balance` / `totalEarned` 取两边**较大值**（不累加，否则来回导入就能刷分）；
`unlockUntil` 以本机为准。其余设置不动。

保证：**同一份备份合并两次，结果和一次一样**（幂等）。

---

## 5. 兼容性与版本管理

### 版本号怎么编

| 编号 | 位置 | 变化条件 |
|---|---|---|
| `schema` | 文档顶层 | **破坏性**改动才 +1 |
| `format` | 文档顶层 | 永不变（`kof-portable`）；真要换血就换名，老实现会直接说不认识 |
| `kofEnc` | 信封 | 加密方式编号，独立于 `schema`（目前写入只用 3） |

**加字段不升 `schema`**。原因：`schema` 是"读它需要的最低版本"，而加字段不改变
老字段的含义——老版本读新文件时忽略多出来的键，照样正确恢复它认识的部分。
反过来，只要**改语义 / 删字段 / 改类型**，就必须 +1，否则老版本会"读一半、乱一半"。

### 读写规则（两端逐字一致）

1. **只读自己认识的字段**：多出来的键忽略，缺的键按"没意见"处理（不是"恢复默认值"）。
   `lang`/`theme` 的空串就是这条规则的具体实现。
2. `schema > 当前实现` → 直接拒绝，提示"请先升级本软件"。
   「拒绝」比「猜着读」安全：读一半写回去，等于把用户的规则洗掉一半。
3. 没有 `kof` 标记、但有 `settings` + `rules`/`lists` 的，按**老格式**（整份 `Config`）
   处理：`parse` 返回 `legacy: Some(cfg)`，覆盖时整份替换，合并时按新文档的加法规则。
   这条分支只进不出——再导出一定是新格式。
4. `appVersion` 只用于界面显示"这份来自 0.1.70"，**不参与任何判定**：
   否则一旦靠版本号分支，就变成"新版能读旧版、旧版读不了新版"的老问题。

### 两端怎么保证"同一套逻辑"

改一个字段名、少写一个键，另一端仍能用默认值读出来——这种错不会报错，
只会让用户的设置悄悄变样。所以用三层机器校验把它钉死：

1. **同一份参考文档**：`tools/fixtures/portable-canon.json`（桌面端
   `cargo test __gen_canon_fixture -- --ignored` 生成）。
2. **同一份字段签名**：`tools/fixtures/portable-shape.txt`，每行一个 `路径:类型`。
   - 桌面端 `export_shape_matches_reference`：自己导出的文档必须量出这个签名。
   - 手机端 `exportShapeMatchesReference`：把参考文档落到手机配置再导出，也必须量出这个签名。
   两端对着同一把尺子量自己，传递下去就等于两端互相比对。
3. **同一套恒定值**：`node tools/check_portable.js` 检查
   `KOF` / `FORMAT` / `SCHEMA` 在两侧源码里逐字相同、所有样例的顶层键与类型合法、
   样例里的规则对象用的是同一套字段。

字段变了怎么办：改 `rich_config()` → 重跑生成器 → 两端测试都会红 →
补齐另一端的实现 → 全绿。这是**唯一**正确的顺序，不要手工改 `portable-shape.txt`。

---

## 6. 验证矩阵

| 检查 | 位置 |
|---|---|
| 桌面端读桌面样例 | `portable::tests::shared_fixture_parses` |
| 桌面端读**手机**样例（含 `pkg` 条目） | 同上（`portable-android.json`） |
| 桌面端读手机**真机导出**的加密备份 | `backup::tests::android_envelope_opens_on_desktop` |
| 手机端读桌面样例（含 `exe` / `site` 条目） | `PortableTest.desktopFixtureParses` |
| 手机端读**桌面端加密**的备份 | `PortableTest.desktopEncryptedBackupDecrypts` |
| 两端字段集合一致 | `export_shape_matches_reference` / `exportShapeMatchesReference` |
| 空 `lang`/`theme` 不改本机 | `empty_lang_and_theme_keep_local_values` |
| 手机转一圈不丢桌面专属字段 | `PortableTest.carryKeepsDesktopOnlyFields` |
| 备份**不再**产生 DPAPI 信封 | `backup::tests::legacy_dpapi_envelope_still_opens_but_is_never_written` |
| 合并幂等 / 去重 / 冲突改名 | 两端各一组 |
| 覆盖不动平台专属设置 | 两端各一组 |

`portable-enc.json` 是桌面端代码加密出来的（密码 `kof-demo-2026`），
重新生成：`cd src-tauri && cargo test __interop_fixture -- --ignored`。

---

## 7. 界面上的两条路径

**桌面端**（设置 → 备份与云同步）
- 「立即备份」：写进 `king of focus back/`，保留最近 10 份且 7 天内
- 「导出跨设备备份…」：自选位置，`.kofbak`
- 「从文件恢复…」：选任意 `.kofbak`（电脑的、手机的、云端的都行）
- 本地 / 云端列表里的「恢复」：同样先问覆盖还是合并

**手机端**（设置 → 备份与恢复）
- 「备份密码」：和桌面端填同一个即可互通；留空 = 明文
- 「导出备份…」：系统文件选择器（SAF），不需要存储权限
- 「从文件恢复…」：选文件 → 选覆盖/合并 → 结果写在按钮下方
