# 0.1.98

第四批：把"点开就冻住"和"关闭瞬间报错"这类手感问题清掉。

## 1. 点「以管理员身份重启」不再冻住整个界面

`ShellExecuteW(runas)` 在 UAC 弹窗停留期间**不返回**——用户可能几十秒不理它。
而 `restart_as_admin` / `set_run_as_admin` 是同步命令，跑在 Tauri 主线程上：
这段时间里界面不重绘、托盘菜单不响应、1.5 秒一次的轮询全部排队，看起来就是"卡死了"。
现在两条命令都改成 `async` + `spawn_blocking`。

## 2. 关窗那 120ms 里不再弹英文 JS 错误

`closeModal()` 是先给遮罩加 `.closing`、120ms 后才真正清 DOM。这中间按钮还能点，
而 `S.editing` 已经置空，于是「保存」连点两下、或关窗瞬间点标签页/模式/删除，
就会得到一条 `Cannot set properties of null`。
现在：遮罩在关闭中 `pointer-events: none`，`saveEditor` 与几个改动 `S.editing` 的
分支都加了空值守卫。

## 3. 庆祝弹窗不再顶掉正在编辑的规则

段结束时的恭喜弹窗直接写 `#modalRoot`。如果那时规则编辑器开着，编辑器连同
**没保存的改动**会一起消失，没有任何提示。现在编辑中不弹，留在下一拍再弹。

## 4. 「去安装」不再连扫两遍浏览器

`nav('browsers')` 自己就会扫一次，处理函数里又先 `await browserScan()`——
两次窗口枚举（都是 `spawn_blocking`）。现在只走 `nav`。

## 5. 遮罩还原核对进程

`release_raised` 只按窗口句柄还原置顶状态。句柄被系统回收并复用给别的窗口后，
会把别人的窗口从置顶带摘下来（用户看到自己的播放器莫名掉层）。
`Raised` 现在记下 pid，还原前核对。

## 验证

- `cargo test` 289 · `run_itest` **1188 断言 0 失败** · `check_i18n` 752/752
- `check_wiring` / `check_portable` / `test_matcher` 47 / `test_extension_e2e` 11 全过
- 版本：桌面 0.1.98 · Android 0.5.9 · 插件 1.1.2
