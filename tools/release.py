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
    '**休息结束时的收尾**（自律时段页新卡片）',
    '- 只在「休息 → 学习」的边界执行一次：休息里打开的黑名单软件按选定方式处理。',
    '- 柔和（默认）：最小化窗口，学习期间不再反复强杀；点开它才按常规拦截关掉。',
    '- 强制：直接关闭（先请程序自己退出，不退出再强制结束）。',
    '- 媒体：先读系统媒体会话状态，只有确实在播放才暂停；已暂停 / 已停止 / 读不到状态一律不动，'
    '也永远不会自动恢复播放。',
    '- 作用对象与拦截同源（黑名单命中，或白名单外且非保护进程）；网页不在此处理——'
    '外部进程看不到标签页，由浏览器插件按标签页精确拦截。',
    '',
    '**时段拖拽的碰撞限制**',
    '- 拖动撞到相邻时段就停在它的边缘：不压缩、不缩短、不推移对方。',
    '- 不能把一个时段塞进另一个的中间（不会把对方切成两段）。',
    '- 同一天内任何时段都不会重叠 / 覆盖；拖动过程中其它时段的数据与布局完全不变。',
    '- 边缘缩放同样受约束：只长到邻居边上，邻居一个字都不改。',
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

size = os.path.getsize(EXE)
upload = ('https://uploads.github.com/repos/%s/releases/%d/assets?name=%s'
          % (REPO, rel['id'], urllib.parse.quote(ASSET)))
req = urllib.request.Request(upload, data=open(EXE, 'rb'), method='POST')
req.add_header('Authorization', 'token ' + TOKEN)
req.add_header('Accept', 'application/vnd.github+json')
req.add_header('User-Agent', 'kof-release')
req.add_header('Content-Type', 'application/octet-stream')
req.add_header('Content-Length', str(size))
with opener.open(req, timeout=600) as r:
    out = json.loads(r.read())
print('上传完成 %s（%d 字节）state=%s' % (ASSET, size, out.get('state')))
print('下载地址 ' + out.get('browser_download_url', ''))
