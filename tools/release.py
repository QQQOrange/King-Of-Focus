"""发布 GitHub Release：把**三个平台**的产物 + 更新清单一并上传。

资产名与版本都来自 dist/King.Of.Focus-update.json（由 tools/release_meta.py 生成），
这里不再自己拼名字。上传前逐个核 sha256：传错包是这套方案里最难查的事故。

直连（不走系统代理）：urllib 默认会读 *_proxy 环境变量，这里显式给 opener 一个
空的 ProxyHandler，避免被 53041 那个代理拦成 502。

用法：
    python tools/release_meta.py build --notes notes.md   # 归档产物 + 生成清单
    python tools/release_meta.py check                    # 一致性校验
    python tools/release.py 0.1.23                        # 上传（版本要与清单 tag 一致）

说明优先取清单里的 notes；没写时退回下面的 NOTES。
"""
import hashlib
import json
import io
import os
import sys
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
DIST = os.path.join(ROOT, 'dist')
MANIFEST_NAME = 'King.Of.Focus-update.json'

# 版本与资产都听清单的：清单是 tools/release_meta.py 按三端源码版本 + 实际产物生成的，
# 发布脚本不再自己拼名字（以前写死 "King.Of.Focus-Extension-1.1.0.zip"，
# 升版本时忘了改就会把旧插件传上去）。
man_path = os.path.join(DIST, MANIFEST_NAME)
if not os.path.exists(man_path):
    raise SystemExit('找不到 %s，先跑 python tools/release_meta.py build' % man_path)
with io.open(man_path, encoding='utf-8') as f:
    MANIFEST = json.load(f)

if len(sys.argv) > 1:
    VER = sys.argv[1]
    if MANIFEST['tag'] != 'v' + VER:
        raise SystemExit('清单 tag 是 %s，与参数 %s 不一致（先重新 build 清单）'
                         % (MANIFEST['tag'], 'v' + VER))
else:
    VER = MANIFEST['tag'].lstrip('v')
TAG = 'v' + VER
CFG = r'D:/software/myself/king of focus data/config.json'

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


notes_body = (MANIFEST.get('notes') or '').strip() or '\n'.join(NOTES)
notes = '\n'.join(['v' + VER, '', notes_body])

# 资产清单来自 update.json：三个平台的包 + 清单本身。
# 每个文件都先核 sha256 —— 传错包是这一整套方案里最难查的事故。
ASSETS = []
for _plat, _e in MANIFEST['platforms'].items():
    _p = os.path.join(DIST, _e['file'])
    if not os.path.exists(_p):
        raise SystemExit('清单里的产物不存在：%s（先重新 build）' % _p)
    _h = hashlib.sha256(open(_p, 'rb').read()).hexdigest()
    if _h != _e['sha256']:
        raise SystemExit('产物 %s 的 sha256 与清单不符，拒绝上传' % _e['file'])
    ASSETS.append((_p, _e['file']))
ASSETS.append((man_path, MANIFEST_NAME))

# 已存在就复用（重跑发布），并把说明刷新成这一版的
try:
    rel = call('GET', '/repos/%s/releases/tags/%s' % (REPO, TAG))
except Exception:
    rel = None
if rel and rel.get('id'):
    rel = call('PATCH', '/repos/%s/releases/%d' % (REPO, rel['id']), {
        'name': TAG, 'body': notes, 'draft': False, 'prerelease': False,
    })
    print('已有 Release，复用并更新说明 id=%s' % rel['id'])
else:
    rel = call('POST', '/repos/%s/releases' % REPO, {
        'tag_name': TAG, 'name': TAG, 'body': notes,
        'draft': False, 'prerelease': False,
    })
    print('新建 Release id=%s' % rel['id'])

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
