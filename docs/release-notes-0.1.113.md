# 0.1.113 — 工程卫生：一条命令的门禁 + CI + 三处代码问题

这一版没有新功能，全是"以后不再犯同样的错"。

## 一、`tools/check_all.py`：一条命令跑完 8 道门禁

以前发布前要记得挨个跑：`cargo test`、`run_itest.js`、`check_i18n.js`、
`check_wiring.js`、`test_matcher.js`、`test_update.js`、`check_portable.js`、
`check_dav_url.js`。漏一道就是一次"线上才发现"。

现在：

```
python tools/check_all.py            # 桌面端 8 道，约 145 秒
python tools/check_all.py --android  # 连 Android 单测
python tools/check_all.py --list     # 只列出会跑什么
```

- 任何一项失败会**继续跑完**，最后一次性列出所有问题（不是发现一个就停）；
- 工具链不在 PATH 也能跑（按"先 PATH、再已知位置"探测 node/cargo/gradle）；
- 子进程输出强制 UTF-8：Windows 默认 GBK，cargo 的中文输出会让读线程直接抛
  `UnicodeDecodeError`，而主进程只看到 stdout 为 None——这个坑我当场踩了一次。

## 二、CI（`.github/workflows/ci.yml`）

push / PR 自动跑 6 道快门禁（Rust 单测 + i18n + 接线 + 匹配 + 更新清单 +
备份格式），一分钟内。界面 harness 要 140 秒且依赖 Runner 上的 Edge，留在本地。

这套针对的是这个项目 2026 年最常见的失败模式：**改了一处、另一处没跟上**
（命令没注册、文案没翻译、清单两边不一致）。人都能看，但不会每次都看。

## 三、接线上多一道守卫：分区重置清单不能各写一份

`reset.rs` 的 `SECTIONS` 和 `app.js` 的 `RESET_SECTIONS` 是同一份清单的两个副本。
分叉时不会报错：

- 后端多一个 → 界面看不到，等于没做；
- 前端多一个 → 用户点了报「未知分区」，看着像坏了。

现在 `check_wiring.js` 会把两边逐项比对，缺一项直接失败。

## 四、三处代码问题（来自 clippy 复查）

1. `stats.rs` 的 `span_touch`：`let mut old = None` 之后再赋值，初始值永远读不到，
   而且"到底有没有赋值"要读完整段才确认。改成从块里返回，一眼可读。
2. `distract.rs` 用了 chrono 已弃用的 `NaiveDateTime::timestamp()`（它把 naive 值当 UTC，
   语义容易误读）。换成 `and_utc().timestamp()`，行为逐位一致但意图写明。
3. `browsers::def_by_exe` 是 `pub(crate)`，返回类型 `Def` 却是私有的（`private_interfaces`）。
   把 `Def` 提到 `pub(crate)` 并写清原因。

## 五、验证

- `python tools/check_all.py` → **8 道全绿**（Rust 309 · harness 1188 · i18n 842/842）
- 版本：桌面 0.1.113 · Android 0.7.0（未改）· 插件 1.2.3（未改）

## 六、这次没动、但复查出来的（列进待办，不是忘了）

见本轮对话里的评估清单。最值得做的三条：把 `app.js`（11838 行）按视图拆模块、
把 36 处直接 `cfg.write()` 收拢到 `update_config`、以及 31 处死代码清理。
它们都属于"改动面大、收益是长期"的重构，不该和一个发版混在一起。
