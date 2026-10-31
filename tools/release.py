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
    '**桌面端与手机端备份互通：一份 `.kofbak`，两边都能读写、都能恢复。**',
    '',
    '以前备份只是"把 Config 原样加密写盘"，只有桌面版认得。现在中间多了一层',
    '**两端共用的文档**（`kof-portable`），规则、时段、积分、共用设置都在里面。',
    '',
    '### 格式（`docs/backup-format.md`）',
    '- 明文 = 那份 JSON 本身；设了密码 = `{"kofEnc":3}` 信封',
    '- KDF 换成 **PBKDF2-HMAC-SHA256（600000 轮）+ AES-256-GCM**：手机端 `javax.crypto`',
    '  原生就有它（Argon2id 没有）。设了密码的备份从此可以直接拷到手机上打开。',
    '- 老信封（`kofEnc:1` Argon2id / `kofEnc:2` DPAPI）继续读得懂，只是不再往里写。',
    '',
    '### 两种恢复方式（两端一致）',
    '- **覆盖**：用备份里的规则、时段、积分、提醒、语言替换本机；平台专属设置',
    '  （遮罩/HUD/端口、手机拦截页文案）一个字都不动，备份密码和云账号也不动。',
    '- **合并**：只加法。同 id 或同内容（名称+模式+名单）跳过，同名不同内容改名并列，',
    '  时段只补本机空着的小时，积分取较大值不累加。**同一份导入两次不会翻倍**。',
    '',
    '### 桌面端',
    '- 新增「导出跨设备备份…」「从文件恢复…」；本地/云端列表里的「恢复」也会先问覆盖还是合并',
    '- 结果用一句话报清：新增/跳过/冲突各几条、补了几个小时段',
    '',
    '### 手机端（Android 0.1.1）',
    '- 设置 → 备份与恢复：备份密码、导出备份…、从文件恢复…（系统文件选择器，免存储权限）',
    '- 桌面端那条规则里的 exe / 网站 / 规则自有时间段手机端拦不了，但会**原样保管**，',
    '  备份回桌面时一并带回（规则页会标明"另有 N 个桌面条目"）',
    '',
    '### 互通是测出来的，不是口头承诺',
    '- `tools/fixtures/` 下的样例两端测试都读同一份',
    '- `portable-enc.json` 是**桌面端代码加密**的，手机端单测真的解开它',
    '- `portable-enc-android.json` 是**真机导出**的（600000 轮），桌面端单测真的解开它',
    '- 全量：Rust 229、UI 1032、插件 47 + e2e 11、i18n 651/651、Android 26',
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
