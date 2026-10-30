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
    '**扇图连线：从"一团斜线"改成"零交叉扇线"**',
    '- 每条线现在只有两段：从扇区外缘斜拉到本行拐点，再水平进标签（拐点带圆角）。',
    '- 零交叉靠两条不变式：同侧标签的**行序与扇区角序严格一致**，且每条线的拐点各自占一列（每行外扩 2.4px）。',
    '  已用几何求交验证：7 项 / 9 项 / 一项占 95% 的极端倾斜 / 只有 1 项，**可见交叉数都是 0**。',
    '- 线身仍先描一层底色再压本色，并行处也不会糊在一起。',
    '',
    '**悬停：真的放大 + 平滑过渡 + 触屏也一致**',
    '- 悬停项名称 11.5 → 13px 加粗并染成扇区色，时长行 10.5 → 11px；其余项压暗到 38%，扇区外扩 5px 并加一道亮边。',
    '- 字号放大不会带来布局跳动：位置在布局阶段算死，canvas 也不回流；标签宽度已按放大后预留，不会"一悬停就变成省略号"。',
    '- 用指数逼近做过渡（约 120ms），移开平滑恢复；触屏上"移动不点亮、抬手不粘住"，桌面与移动端行为一致。',
    '- 命中区域按真实几何算：扇区本体、两行文字（按实测字宽）、引导线的斜线段与水平段都能点中，画布空白处不误触。',
    '',
    '**点击展开：这一项到底在哪些时间段用过**',
    '- 面板列出**全部**时段（列表自身可滚动），并按日期分组；「其他」也能点开，会写明它包含哪几项。',
    '- 后端每项的时段上限 20 → 400（单日/单周/单月都不会触顶），并新增 `spanCount` 记录裁剪前的真实段数——',
    '  真被裁剪时界面如实写「共 N 段（列出 M 段）」，不再让人以为"就这几段"。',
    '',
    '**明细清单：逐项列清、含使用时间**',
    '- 统计页明细从「前 30 项、只有名称/时长/占比」改为「全部条目 + 使用时间」：',
    '  每项给出名称、时长、占比，以及按「日期 + 时刻」成组的具体时段（精确到分钟），末尾带合计行。',
    '',
    '**自检**',
    '- Rust 195 项、界面 874 条断言、插件单测 44 + 端到端 11，全部通过。',
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
