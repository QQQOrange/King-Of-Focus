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
    '**统计页：修掉三处"说不出哪里不对"的错位**',
    '- **周视图的小时刻度和时间轴对不上**：刻度是按整列（含表头与当日合计）的高度算百分比的，',
    '  而色块是按"轨道"算的 —— 00:00 高出轨道 22px、06:00 偏 12px。',
    '  现在表头/合计高度固定、刻度放进与轨道等高的内层容器，五个刻度与轨道误差 ≤ 1.5px。',
    '- **周/月范围标签会被"选中日"撑宽**：点了饼图上某个软件后，选中日可能落在别的周，',
    '  标签就会显示成两周（例如 10-26 ~ 11-09）。现在标签只按视图自己的窗口算，永远是 7 天 / 整月。',
    '- **时间范围与日历不同步**：上面选「今日」，下面日历仍停在原来的周，两边数字自然对不上。',
    '  现在切换今日 / 本周 / 本月 / 今年 / 自定义，日历会跟着落到同一周期（周视图落在该周、月视图落在该月）。',
    '',
    '**顺带统一配色**',
    '- 同一个软件在扇图和日历里颜色可能不一样（两张图各自排序）。现在日历优先沿用饼图的配色，',
    '  只在日历里出现的项再按累计时长补色，并避开已占用的颜色。',
    '',
    '**自检**',
    '- 界面 913 → 920 条断言（新增：00:00 / 24:00 与轨道两端对齐、6/12/18 点落在正确高度、',
    '  范围标签恒为 7 天、切「本月 / 今日」后日历跟着走、饼图与日历同色），全部通过；',
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
