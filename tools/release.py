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
    '**引导线全部改成直线**',
    '- 去掉了 S 形曲线与所有拐点：每条线只从扇区外缘**直接连到标签锚点**，一线到底。',
    '- 上下留白（72px）把标签高度对齐到弧点，所以绝大多数线是水平或微斜的，和名称标签严格对齐。',
    '- 命中测试与绘制共用同一份起止点，直线也能整段点中。',
    '',
    '**点扇区 → 跳到「时间日历」并高亮**',
    '- 点饼图任意扇区，页面会平滑滚动到「时间日历」卡片，卡片外圈闪两下；',
    '  该软件在周/月视图里的**每一个色块都会加一圈描边**，一眼看出"它在哪天、什么时段出现过"。',
    '- 日历窗口会自动切到"这个软件最近有记录的那一天"所在的周/月，保证跳过去不是一片空白。',
    '- 点「其他」这种聚合项时只做定位、不做逐块描边（它没有单一对应软件）。',
    '- 收起饼图明细时，日历那边的描边一起撤掉，不会留下不明所以的高亮。',
    '- 高亮用"字色描边"：深色主题下是浅边、浅色主题下是深边，两边都清楚；',
    '  卡片脉冲跟随「减少动态效果」自动降级。',
    '',
    '**自检**',
    '- 界面 905 → 913 条断言（新增：连线只有起止两点 / 精确指向标签锚点 / 点击后滚动到位 /',
    '  卡片脉冲 / 对应色块描边且只落在被点那一项 / 明细里那一行同样点亮），全部通过；',
    '  Rust 197、插件 44 + 端到端 11。',
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
