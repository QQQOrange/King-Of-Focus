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
    '**统计页：修掉三处"用起来别扭"的地方**',
    '',
    '**① 选中当日日历里的某一块会闪一下**',
    '- 根因：选中时把整块当日日历（连带下面整张周/月网格）的 innerHTML 重写了一遍 ——',
    '  节点全换新、过渡从零开始、布局重排，眼睛看到的就是一闪；聚焦条插进来还会把时间轴顶下去 24px。',
    '- 现在选中/切换/取消只切 class（高亮与压暗走 .13s 过渡），节点一个都不换；',
    '  聚焦条固定占一行，出现与消失都不改变轨道位置。',
    '',
    '**② 扇图顶在上沿、左下角一大片空**',
    '- 右列（当日日历）比扇图高得多，扇图却按顶对齐。现在扇图在整列里垂直居中，上下留白对等。',
    '- 顺带把扇图的展开面板移到分栏下面：面板开关不再改变这一列的高度，图也不会跟着上下跳。',
    '- 并排门槛从 900px 提到 1140px：窗口再窄就叠成上下，扇图占满宽度，不会把标签压到读不清。',
    '',
    '**③ 在时间日历里点一天，上面没反应**',
    '- 以前点某天只换日历，上面的饼图还停在旧区间，数字和日期对不上。',
    '- 现在点一天会把整块「使用时长分布」切到那天（区间变成「自定义 某天 ~ 某天」），',
    '  并平滑滚到这张卡、让当日日历脉冲一下 —— 想回到整周/整月点「本周 / 本月」即可。',
    '- 扇图、当日日历、网格三处同一口径；接口打嗝时保留上一次的图表，不会突然变成"没有数据"。',
    '',
    '**自检**',
    '- 界面 965 → 979 条断言（新增：选中/切换/取消时节点不被重建、时间轴位置不变、',
    '  扇图上下留白对等、点日期切区间并跳转），全部通过；Rust 197。',
    '- 布局在 1440 / 1206 / 1166 / 1066 / 826 五个宽度实测：并排时居中、无横向溢出，',
    '  窄屏自动叠列；点击前后各区域坐标零位移。',
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
