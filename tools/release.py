"""发布 GitHub Release：把构建产物以 King.Of.Focus-x.y.z.exe 上传。

直连（不走系统代理）：urllib 默认会读 *_proxy 环境变量，这里显式给 opener 一个
空的 ProxyHandler，避免被 53041 那个代理拦成 502。
"""
import json
import io
import os
import sys
import urllib.request

VER = sys.argv[1] if len(sys.argv) > 1 else '0.1.22'
TAG = 'v' + VER
CFG = r'D:/software/myself/king of focus data/config.json'
EXE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                   'src-tauri', 'target', 'release', 'king-of-focus.exe')
ASSET = 'King.Of.Focus-%s.exe' % VER

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


notes = (
    'v%s\n\n'
    '- 修复：多个时段同时存在时，拖动 / 移动其中一段会让已有时段从界面上消失'
    '（数据仍在）。根因是拖拽预览每小时只保留"与被拖区间相交"的那个窗口，'
    '其余时段被涂成未选中；而落位走的是不重绘的提交，没人再按数据纠正。\n'
    '- 修复：新建拖选（在空白处拉出新时段）时，当天所有旧时段会一起闪没'
    '（误用不存在的区间做减法）。\n'
    '- 落位后按配置重建受影响的那几天，保证界面与数据始终一致；'
    '相邻时段仍不会融合。\n'
    '- 进入自律时间自动打开的弹窗：「窗口化 / 最大化 / 最小化」改为自绘分段按钮，'
    '三选一看得清、点得到；每项拆成两行，与整体 UI 风格统一。\n'
) % VER

# 已存在就先删掉（重跑发布时）
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
name = os.path.basename(EXE)
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
