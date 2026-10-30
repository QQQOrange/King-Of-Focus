"""发布 GitHub Release：把构建产物以 King.Of.Focus-x.y.z.exe 上传。

直连（不走系统代理）：urllib 默认会读 *_proxy 环境变量，这里显式给 opener 一个
空的 ProxyHandler，避免被 53041 那个代理拦成 502。

用法：python tools/release.py 0.1.23
说明写在 NOTES 里，发版前按这一版的内容改它。
"""
import json
import io
import os
import sys
import urllib.parse
import urllib.request

VER = sys.argv[1] if len(sys.argv) > 1 else '0.1.23'
TAG = 'v' + VER
CFG = r'D:/software/myself/king of focus data/config.json'
EXE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                   'src-tauri', 'target', 'release', 'king-of-focus.exe')
ASSET = 'King.Of.Focus-%s.exe' % VER

# 这一版的发布说明（一行一条，拼起来就是 release body）
NOTES = [
    '**关闭主窗口后专注遮罩失效（+ 退出残留、PID 复用串台）**',
    '',
    '### 1. 主 bug：关窗口 = 关遮罩',
    '`main.rs` 的 `CloseRequested` 里写着一句"关窗口 = 收进托盘；遮罩如果开着，顺手关掉，',
    '避免黑屏下找不到人"，直接把 `mask.on` 置成 false。',
    '于是：点 X → 窗口收进托盘（进程还在、自律还在跑）→ 遮罩跟着消失，而且没有任何提示。',
    '',
    '**涉及的三层耦合**',
    '- **窗口生命周期**：主窗口走的是 `prevent_close + hide()`（驻留托盘），不是销毁；',
    '  但那段代码把它当成了"用户要结束专注"，去改遮罩的开关。',
    '- **遮罩与主窗口的绑定**：遮罩线程完全独立（`mask::start` 在 `main.rs:213` 启动，自带消息循环），',
    '  只认 `mask.on`（用户意向）和 `auto_follow && schedule_on`（跟随自律）。',
    '  它不需要主窗口存在，是那段关闭逻辑主动破坏了它。',
    '- **后台状态与计时**：`schedule_on` 由监控线程每拍写入，主窗口隐藏不影响；',
    '  真正的断点只有 `mask.on` 被清零这一处。',
    '',
    '**修法**：删掉这段（窗口生命周期不再碰遮罩开关）。想关遮罩有全局热键和托盘菜单，',
    '不需要靠关窗口兜底。',
    '',
    '### 2. 同场景一并修掉的四处',
    '- **拦截一次弹一次窗口**：`focus_main` 无条件 `show() + set_focus()`，',
    '  主窗口收在托盘时，每拦一个软件就被弹到脸上。现在只在窗口本来可见时才抢焦点。',
    '- **托盘「遮罩」菜单弹窗**：点菜单切遮罩会把主窗口叫出来。现在只在窗口可见时更新置顶。',
    '- **普通退出不还原窗口**：托盘「退出」/设置页「退出」只 `stop_guard()`，',
    '  遮罩抬到最上层的窗口永远不会被还回去（用户的播放器永久挂在 topmost）。',
    '  现在统一走 `cleanup_for_exit`：停守护 → 恢复媒体 → **等遮罩收尾并还原窗口** → 落统计 → 释放互斥体 → 卸钩子。',
    '- **从托盘恢复时状态滞后**：主窗口隐藏期间 WebView 定时器被降频，恢复瞬间会显示旧状态。',
    '  现在窗口 focus 时立刻拉一次状态。',
    '',
    '### 3. 上次遗留的三条，这次一起修了',
    '- **PID 复用串台**（`monitor` 的 pending/logged）：键从裸 pid 改成「pid + 进程创建时间」，',
    '  新进程不会再被当成"已经等够宽限期"而跳过温和关闭、也不会吞掉首次提示。',
    '- **守护进程 pid 文件不校验身份**（`guard`）：`guard.pid` 现在写 `pid 创建时间`，',
    '  PID 被系统复用给别的进程时判定为"守护不在"——既不会漏拉守护，也不会退出时杀错人。',
    '  老格式（只有 pid）仍能读。',
    '- **强制收尾把"消息投递成功"当"已关闭"**（`sweep`）：播放器/Electron 常常忽略 WM_CLOSE，',
    '  以前报告里写"已关闭"但窗口还开着。现在发完等 400ms，还活着就升级强杀。',
    '',
    '### 自检',
    '- Rust 209 → **213**：新增进程创建时间、身份键去重、`guard.pid` 双格式解析共 4 条断言。',
    '- 界面 1010 条断言全绿。',
    '',
    '### 验证（手动，覆盖三个场景）',
    '**A. 开遮罩后关闭主窗口**',
    '1. 打开任意窗口（记事本/浏览器），按 Ctrl+Alt+K 开遮罩 → 该窗口露出来、其余被盖；',
    '2. 点主窗口右上角 X（收进托盘）→ **遮罩保持**，洞还在原来那个窗口上；',
    '3. 托盘右键 → 退出：遮罩立即消失，之前被抬升的窗口恢复正常层级。',
    '',
    '**B. 从后台恢复主窗口**',
    '4. 托盘左键单击 → 主窗口回来，遮罩页显示"已开启"（不是关）；',
    '5. 再按 Ctrl+Alt+K 关遮罩 → 主窗口恢复原置顶设置。',
    '',
    '**C. 退出应用**',
    '6. 遮罩开着时退出：不留黑屏、不留 topmost 残留；',
    '7. 托盘接着退出再启动 → 遮罩默认是关（不记忆），配置里的透明度/跟随保持上次的值。',
    '',
    '**D. 回归**',
    '8. 主窗口收进托盘后打开黑名单软件：只弹提示卡，窗口不会被自己弹出来；',
    '9. 自律时段内点 X：仍然被拦下并提示（这部分逻辑未改动）。',
]

cfg = json.load(io.open(CFG, encoding='utf-8'))
up = cfg['settings']['update']
TOKEN = up['token']
REPO = up['repo']

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
API = 'https://api.github.com'


def call(method, path, data=None, ctype='application/json'):
    body = None
    if data is not None:
        body = data if isinstance(data, bytes) else json.dumps(data).encode()
    req = urllib.request.Request(API + path, data=body, method=method)
    req.add_header('Authorization', 'token ' + TOKEN)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('User-Agent', 'kof-release')
    if body is not None:
        req.add_header('Content-Type', ctype)
    with opener.open(req, timeout=120) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


notes = '\n'.join(['v' + VER, ''] + NOTES)

# 已存在就先删掉同名资产（重跑发布时）
try:
    rel = call('GET', '/repos/%s/releases/tags/%s' % (REPO, TAG))
except Exception:
    rel = None
if rel and rel.get('id'):
    for a in rel.get('assets', []):
        if a.get('name') == ASSET:
            call('DELETE', '/repos/%s/releases/assets/%d' % (REPO, a['id']))
    print('已有 Release，复用 id=%s' % rel['id'])
else:
    rel = call('POST', '/repos/%s/releases' % REPO, {
        'tag_name': TAG, 'name': TAG, 'body': notes,
        'draft': False, 'prerelease': False,
    })
    print('新建 Release id=%s' % rel['id'])

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
ASSETS = [(EXE, ASSET)]
EXT_ZIP = os.path.join(ROOT, 'King.Of.Focus-Extension-1.1.0.zip')
if os.path.exists(EXT_ZIP):
    ASSETS.append((EXT_ZIP, os.path.basename(EXT_ZIP)))

# 重跑发布：先把同名旧资产删掉，否则 GitHub 会存成 "name-1.zip" 这种副本
try:
    cur = call('GET', '/repos/%s/releases/%d' % (REPO, rel['id']))
    for a in cur.get('assets', []):
        if any(a.get('name') == n for _, n in ASSETS):
            call('DELETE', '/repos/%s/releases/assets/%d' % (REPO, a['id']))
except Exception as e:
    print('清理旧资产跳过：', e)

for path, name in ASSETS:
    size = os.path.getsize(path)
    upload = ('https://uploads.github.com/repos/%s/releases/%d/assets?name=%s'
              % (REPO, rel['id'], urllib.parse.quote(name)))
    req = urllib.request.Request(upload, data=open(path, 'rb'), method='POST')
    req.add_header('Authorization', 'token ' + TOKEN)
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('User-Agent', 'kof-release')
    req.add_header('Content-Type', 'application/octet-stream')
    req.add_header('Content-Length', str(size))
    with opener.open(req, timeout=600) as r:
        out = json.loads(r.read())
    print('上传完成 %s（%d 字节）state=%s' % (name, size, out.get('state')))
    print('下载地址 ' + out.get('browser_download_url', ''))
