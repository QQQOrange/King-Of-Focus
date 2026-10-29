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
    '**全局复盘后的加固**（功能不变，主要是"别出 bug"和"细节"）',
    '- 本地接口的请求体加上限（64 KB）：以前 `read_to_string` 读到 EOF，本机任意进程灌一个超大 body 就能把主程序内存吃满。',
    '- 插件的 refresh / sweep 串行化：12 秒轮询、边界定时器、弹窗按钮、4 秒扫描会互相叠，叠起来可能让 DNR 停在上一次的旧规则、或对同一批标签重复上报。',
    '- 插件端到端测试改用本机站点（不再依赖外网/DNS），并补了并发刷新与互斥锁的断言。',
    '',
    '**界面细节**',
    '- 输入框聚焦环改用独立颜色（原来复用的是 10% 透明度的底色，深色下几乎看不见）。',
    '- 数字输入框去掉原生上下箭头（深色里像两个灰点），数字改用等宽，插入符与原生控件（复选/滑块）统一主色。',
    '- 长路径 / 长网址允许任意位置折行，不再撑破卡片。',
    '- 悬停在已选格子上时，提示里补上「本段 08:00–12:00（共 4 小时）」。',
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
