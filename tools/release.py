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
    '**专注遮罩的「媒体管控」完全没生效**',
    '',
    '**现象**：打开开关、遮罩也正常盖住窗口，但被盖住的视频/音乐照放，回到前台也不会恢复（因为根本没暂停过）。',
    '',
    '**根因（三个叠在一起）**',
    '- **节流计时器被共用**：媒体检查用的是 `popup_t`，而弹窗扫描每 500ms 就会把它重置一次 ——',
    '  于是"距上次 ≥ 500ms"在媒体这一侧永远是 false，媒体管控只剩"放行窗口冒出来"那一帧有机会跑，等于没跑。',
    '- **`was_playing` 读得太晚**：原先在 `TryPauseAsync()` **之后**才读播放状态，读到的多半已经是"已暂停"，',
    '  于是记成"本来就没在播"，恢复时永远不会 `TryPlay` —— 媒体停了就再也回不来。',
    '- **会话归因只比进程名**：SMTC 会话的 AUMID 有时是产品名（"MicrosoftEdge"），有时是简称（"Chrome"），',
    '  只拿 exe 名去比会漏掉一部分播放器。',
    '',
    '**修法**',
    '- 媒体检查改用**独立的** `media_t` 计时器（500ms），与弹窗扫描彻底解耦；',
    '- 暂停前先记下"原本在不在播"，恢复时才有依据（还在把它写进 `PAUSED_BY_US`）；',
    '- 归因同时收"进程名"和"版本信息里的产品名"，并做双向包含匹配（短名不参与反向匹配，避免误伤）；',
    '- 进程名做了缓存（按被盖住的 pid 名单），500ms 一轮不会反复读版本信息；',
    '- 补了线程级 COM(MTA) 初始化（防御性，老系统上没初始化可能拿不到 WinRT 对象）；',
    '- **自查里能看见了**：遮罩页「自查」新增 `媒体=[开 · 暂停中 1 · 上次检查 0.4s 前 会话 2 个，暂停了 MSEdge]`，',
    '  以后"到底卡在哪一步"一眼可查。',
    '',
    '**自检**',
    '- Rust 197 → 200：新增 AUMID 归因（Edge 产品名 / Chrome 简称 / 短名不误伤）、归一化、诊断串用例；',
    '  另留了一个 `probe_sessions`（`--ignored`）随时打印本机 SMTC 会话，实测拿到 `aumid="MSEdge"`。',
    '- 界面 1010 条断言全绿（新增开关下的说明文案，英文界面无残留中文）。',
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
