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
    '**点击「跟随系统」不再卡一下**',
    '- 根因：切主题走的是 `saveConfig()`，它末尾会 `pull()`（第二个 IPC，把整份状态拉回来，',
    '  并可能顺手重绘一次当前视图），紧接着又 `render()` 把整页重建一遍——',
    '  一次点击 = 两个 IPC + 两次全量重绘。',
    '- 现在主题只做「改 `data-theme` + 落盘」：颜色是 CSS 变量驱动的，DOM 一个都不重建，',
    '  滚动位置和输入焦点都保住了；落盘走静默通道，不再回拉状态。',
    '- 切换瞬间临时关掉过渡（只活两帧）：避免几百个节点同时插值造成的掉帧。',
    '',
    '**「前往浏览器扩展页」在 Edge 上不再失效**',
    '- 根因一：浏览器**最小化**时窗口尺寸算出来是 0，被「面积下限」过滤掉 →',
    '  软件以为没窗口 → 再启动一次浏览器（已在运行，新进程什么都不做）→ 看起来「点了没反应」。',
    '  现在最小化的窗口照收，先 `ShowWindow(SW_RESTORE)` 还原再操作。',
    '- 根因二：Edge 的新建标签按钮叫 `EdgeNewTabButton`，而页面上还有个「开启 Infinity 新标签页 (Pro)」',
    '  的开关名字也能命中，且排在前面。以前取「第一个像的」就点到那个开关上，点不动 →',
    '  报「找不到新建标签页按钮」。现在按 class 优先打分，取分最高的真按钮，并重试「找到并点下去」。',
    '- 根因三：UIA 失败后无条件 `spawn` 一次浏览器，只会留下一个停在新建标签页的窗口。',
    '  现在只有「一个窗口都没有」（启动提速的常驻进程）才补启动，其余直接如实报错。',
    '- 地址栏打分：`地址和搜索栏` 同时含「地址」和「搜索」，以前会被「搜索」那条规则扣成负分；',
    '  现在先判是不是地址栏，只在没有地址特征时才当搜索框扣分。',
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
