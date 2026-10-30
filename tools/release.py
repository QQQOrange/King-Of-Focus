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
    '**统计页：饼图右侧新增「当日日历」**',
    '- 原本"日历下面的当日明细表"挪到扇图右边，改成一根 24 小时竖时间轴：',
    '  色块的位置 = 什么时候开始，高度 = 用了多久；短到写不下字的块靠悬停读数补全。',
    '- **点扇区即时联动**：日历立刻切到这一项用时最多的那天，并把它的每一段都描边高亮，',
    '  其余段压暗；不刷新页面、也不再把页面滚走（右侧就是日历）。',
    '- **反向联动**：点日历里的色块（或图例）同样会聚焦该分类，扇图同步描边。',
    '- 空档（≥30 分钟）铺淡斜纹并标「空闲」，一眼分得清"没记录"和"是别的软件"。',
    '- 越界的段（t>24:00、倒挂、零长）先夹进 00:00–24:00，绝不会画到轨道外面。',
    '- 看今天时多一根"现在"的竖线；不在今天时给「今天」入口。',
    '',
    '**删掉的东西**',
    '- 移除统计页的「明细清单」整块表格，以及日历下方的「当日明细列表」，',
    '  连同它们的渲染函数、样式和词条一起清掉 —— 同一份数据不再看两遍。',
    '',
    '**口径一致**',
    '- 扇图 / 周月网格 / 当日日历共用一份状态筛选（已开启 / 未开启 / 汇总）与一个"聚焦分类"，',
    '  切筛选、切日期、翻页三处一起走；日期不在窗口里时窗口会自动跟过去。',
    '- 换一天只动那一侧：顶部的统计区间和扇图不受影响（区间聚合不该被单日点击改掉）。',
    '- 当日日历优先复用周/月网格已经取到的同一天，不给同一份数据发第二次请求。',
    '',
    '**自检**',
    '- 界面 920 → 965 条断言（新增：并排几何、09:00 落在 9/24、轨道高度 480、',
    '  点扇区切天并高亮全部时段、点色块反向聚焦、悬停读数、无数据日空状态、',
    '  越界段夹取、切筛选日期不漂、三项删除回归），全部通过；Rust 197。',
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
