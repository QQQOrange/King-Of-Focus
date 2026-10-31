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
    '**英文界面补全：可见文案覆盖率 67% → 100%**',
    '',
    '这条一直是"常驻断言"（英文界面零残留中文），但从来没人量化过。这次先把尺子做出来，再补。',
    '',
    '### 新增 `tools/check_i18n.js`',
    '一个可当 CI 用的体检工具，做三件事：',
    '- 扫 `ui/app.js` 里**用户真的会看到**的中文（模板文本节点、title/placeholder/aria-label、',
    '  单独的 toast/confirm 整句），跳过 `${...}` 插值碎片与模板语法残留；',
    '- 用真实的 `I18N.has()` 判断覆盖，输出缺失清单（带文件行号）；',
    '- 检测 `EN` 与 `EXTRA` 的**键冲突** —— 运行时 EXTRA 覆盖 EN，同键不同值会让某句被另一句的译文顶掉。',
    '  有冲突或缺失时退出码为 1，可以直接挂到流水线上。',
    '',
    '### 修了什么',
    '- **6 处键冲突**，其中一处是真错译：`不会` 在 EN 里是 "No"、EXTRA 里是 "and never "，',
    '  最终生效的是后者，于是「它<b>不会</b>改变主开关」渲染成「它and never 改变主开关」。',
    '  统一成 "Won’t"，两处都通顺。另外 `软件`/`网页`/`单击`/`换一条`/一处长句也做了对齐。',
    '- **补齐 210 条缺失译文**：加载/固化/时段明细/睡眠/更新/备份/扩展引导/报表导出等页面全覆盖。',
    '- 覆盖率从 **67.3%（442/657）到 100%（644/644）**，键冲突 6 → 0。',
    '',
    '### 自检',
    '- `node tools/check_i18n.js` → 覆盖 100%、冲突 0、退出码 0',
    '- 界面 **1010** 条断言全绿（英文界面零残留中文这条仍在其中）',
    '- Rust **215** · 插件匹配器 **47**',
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
