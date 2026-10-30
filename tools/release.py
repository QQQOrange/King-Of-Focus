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
    '**遮罩在"没有选中窗口"时仍然盖住全部窗口（一个都没留出来）**',
    '',
    '**复现**：跟随前台开启遮罩 → 把被高亮的窗口最小化 / 让前台短暂变成读不到的状态',
    '（点任务栏、切虚拟桌面、焦点丢给系统任务栏等）→ 遮罩继续整屏盖住，',
    '但屏幕上**没有一个窗口**是露出来的，只剩一片遮罩。',
    '',
    '**根因**：洞口矩形和被抬升的窗口句柄是两套状态，其中一套被清零了。',
    '- `target_now` 拿不到前台时回退到 `last_hole`（上一帧的洞口矩形），所以"洞"还在；',
    '- 但同一行代码 `followed_key = follow_now.map(..).unwrap_or(0)` 把"要抬起来的窗口句柄"清成了 0。',
    '- 结果：遮罩照画（`paint_cover` 整屏），而 `ensure_above` 因为 tgt=0 一个窗口都没抬 ——',
    '  洞口画在了看不见的层下面，等于整屏全覆盖、没有任何窗口处于突出状态。',
    '',
    '**修法（最小改动，只动目标判定与渲染闸门）**',
    '- `followed_key` 不再清零：只在**真的拿到前台窗口**时更新，拿不到就沿用上一次的；',
    '- 沿用上一帧洞口时，矩形从**那个窗口**重新算（`hole_bounds`），窗口挪了就跟着挪，',
    '  窗口没了/不可见/最小化了就当没有洞口；',
    '- 新增 `hole_bounds()`：窗口不存在 / 不可见 / 已最小化 → 不能当洞口',
    '  （最小化的窗口 `GetWindowRect` 会返回 -32000 附近的坐标，画上去就是纯黑全覆盖）；',
    '- 新增渲染闸门 `can_paint(on, 有洞口, 有可抬升窗口)`：三者缺一就不画，',
    '  并且洞口无效时**不再沿用**上一帧的洞，直接收起（1.5s 后照旧自动退出并提示）；',
    '- 再补一道：洞口必须与某块屏幕相交，防止"把窗口移到屏幕外当隐藏"的程序让洞挖在屏幕外。',
    '',
    '**行为保证**',
    '- 没有选中/可用的目标窗口 → 不渲染遮罩（不再出现整屏遮盖）；',
    '- 有选中窗口 → 它被抬到遮罩之上，不被覆盖；',
    '- 其余窗口 → 正常被遮罩覆盖（弹窗与放行程序的浮条仍随主窗口一起放行）。',
    '',
    '**自检**',
    '- Rust 200 → 202：新增渲染闸门四组合（无洞无窗/有洞无窗/有窗无洞/两者齐备）与空句柄用例；',
    '  另留 `probe_hole_bounds_real_window`（`--ignored`）用真实窗口验证三态，',
    '  实测：隐藏→不是洞口、显示→洞口 800x600、最小化→又不是洞口。',
    '- 界面 1010 条断言全绿。',
    '',
    '**回归检查要点**',
    '1. 跟随前台开遮罩 → 正常窗口：它露出来，其余被盖；',
    '2. 把那个窗口最小化 → 遮罩立刻收起（不再整屏盖住）；恢复窗口 → 遮罩自动回来；',
    '3. 遮罩期间点任务栏 / 切虚拟桌面再切回 → 不会出现"什么都没有露出来"的全屏遮盖；',
    '4. 打开任务管理器看 z 序（或用「自查」里的 `跟随窗口=0x...`）：只要显示已绘制，该值必须非 0。',
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
