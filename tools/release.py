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
    '**当日日历：点一个应用，却像"全选 + 全都变成同一个颜色"**',
    '',
    '**复现**：时长统计 → 右下「当日日历」→ 点任意一个色块。',
    '看到的：被点的那几段变成一片白边、其余应用一片灰，颜色全丢，像"所有应用都被选中了"。',
    '',
    '**根因（两处）**',
    '- 选择状态本身没问题：`S.calHit` 只是一个字符串，同一时刻只可能命中一个应用。真正出问题的是**画法**：',
    '  未选中项被压到 `opacity: .34`（在深色轨道上几乎糊成同一种暗色），',
    '  选中项又套了一道 2~3px 的近白描边 —— 薄色块被描边整个吃掉，只剩白边。',
    '  十几个应用于是变成"一片白 + 一片灰"，看起来就是全选 + 同色。',
    '- 另一处：配色表是按"整周窗口"建的，一旦当天渲染的条目不在那张表里，',
    '  就会全部回落到 `--line-2`（同一种灰）—— 这是能真正让所有色块变成同一个颜色的路径。',
    '',
    '**修法**',
    '- 未选中：`opacity` 从 .34 提到 .58 —— 明显退到背景里，但**色相还在**，一眼仍认得出是哪个应用。',
    '- 选中：保持它自己的颜色并提亮（`brightness 1.14 / saturate 1.06`）+ 左右各放宽 3px + 一圈 1px 描边；',
    '  很薄的段（< 8px）改用外发光，避免描边把它本身的颜色盖掉。',
    '- 配色表无条件并入"当天"的所有条目，保证每一块都拿到自己的颜色，任何情况下都不会回落成同一种灰。',
    '  颜色映射（同一应用在扇图/日历/当日日历同色）完全没动。',
    '',
    '**自检**',
    '- 界面 987 → 1010 条断言，新增一组"单选与配色"：三块三色、命中的 key 只有一个、',
    '  未选中项颜色一一对应且只是变淡、选中块宽 6px 且有描边、取消后逐块颜色与选中前完全一致。',
    '- 三种交互（选中 / 取消 / 切换）都已覆盖；Rust 197 全绿。',
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
