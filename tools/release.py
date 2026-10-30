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
    '**新增「时间日历」（周日历 / 月日历）**',
    '- 统计页新增日历卡片，**默认周视图**，右上角「周 / 月」两段按钮随时切换。',
    '- 周视图：7 条 24 小时时间轴（左侧小时刻度），每段连续使用画成一个色块；',
    '  月视图：7×N 网格，每格一条横的 24 小时条，一眼看出哪天用得最多。',
    '- 颜色按「整个窗口内的累计时长」分配，**同一个软件每天都是同一种颜色**。',
    '- 点任意一天展开明细：当天每个软件的**具体时段**（09:12–10:05）、累计时长、占比，',
    '  上方还有一条整天的 24 小时总览。',
    '- 切换周/月时**选中日期保持不变**（切到月视图就显示它所在的那个月）；翻页也不清选中，',
    '  区间会自动把选中日包进来，所以明细始终看得到。',
    '- 桌面端可读性：小时刻度、24 格网格线、等宽数字；窄屏自动缩小列宽与轨道高度。',
    '',
    '**饼图引导线不再有突兀的弯折**',
    '- 根因是画布上下只留 24px：标签被压在最上/最下一行，而顶部扇区的弧点更高，',
    '  线只能先折出去再折回来。',
    '- 现在画布加宽到 660、上下各留 72px，高度同时满足「圆环放得下」与「行数放得下」；',
    '  标签的**理想高度直接等于弧点高度**，落差小的项走**一条直线**（无任何拐点）。',
    '- 真被别的标签挤开时，改用**两端都与水平相切的 S 形曲线**（不再是折线），中途没有尖角；',
    '  线的两端各一个小圆点，明确指出"这条线属于哪个扇区"。',
    '- 左右标签区等宽（各 190px），不会再被一侧挤走。',
    '',
    '**自检**',
    '- Rust 197 项（新增日历相关 2 项）、界面 905 条断言（新增 25 条：默认周视图 / 7 列 /',
    '  切月视图 / 选中保留 / 点某天展开明细 / 翻页 / 收起 / 英文无残留），插件 44 + 端到端 11，全部通过。',
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
