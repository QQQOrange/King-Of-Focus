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
    '**功能审查：修掉 5 处高危断链（数据安全 / 承诺未兑现）**',
    '',
    '这版先做了一次全量功能审查（16 个功能域逐条核对），报告见 `docs/审查报告-2026-10-31.md`。',
    '下面 5 处是"界面承诺了、代码没做到"或"数据会悄悄丢"的问题，已修：',
    '',
    '### 1. 配置写盘不是原子的（数据丢失）',
    '`cfg::save` 用 `fs::write` 直接覆盖，会先把原文件截断成 0 字节。写到一半被强杀/断电，',
    'config.json 就是空文件或半截 JSON —— 规则、备份口令、令牌全丢。',
    '更隐蔽的是守护进程每 2 秒读一次配置，读到半截会退回默认配置（自律时段=关），',
    '于是固化判定失效、守护自行退出。现在改为"先写 .tmp 再改名"，并给损坏文件留档。',
    '',
    '### 2. 云同步把凭据明文上传',
    '`sync::payload` 序列化整份配置，WebDAV 账号密码、备份加密口令、GitHub 令牌都在里面，',
    'PUT 到用户网盘。现在上传前全部清空（下载端本来就保留本机字段，不影响同步）。',
    '',
    '### 3. 固化期间仍然可以退出',
    '热键 / Alt+F4 / 设置页「立即退出」走的是 `force_quit`，而它只检查"会话内是否允许退出"，',
    '没检查固化锁定 —— 只有托盘「退出」走那条判定。于是固化形同虚设。现在统一拦截并提示。',
    '',
    '### 4. 积分解锁不解拦截',
    '界面写"解锁 N 分钟自由时间""到 xx 之前所有拦截暂停"，实际只有"能否退出/改设置"被放开：',
    '软件照拦、网页照拦、遮罩照盖。用户在花钱买了个寂寞。',
    '现在在拦截判定的唯一入口 `active_rules` 里加解锁判定，一处生效、四处同步',
    '（拦软件 / 下发网页规则 / 自动打开 / 遮罩跟随自律）。',
    '',
    '### 5. 「固化」开关没有界面入口',
    '`hardToggle` 和它的点击分支都在，但没有任何元素触发它；新建规则一律 `hard: true`，',
    '等于"所有规则永久固化且关不掉"。现在「固化」页有真正的开关了。',
    '',
    '### 自检',
    '- Rust 213 → **215**：新增"上传体不含凭据""解锁期间没有规则生效"两条断言。',
    '- 界面 1010 条断言全绿。',
    '',
    '### 审查里还没修的部分',
    '报告第三节列了 20 条（守护自愈、统计日文件被覆盖、更新校验强度、自启失败无提示、',
    '遮罩窗口残留 topmost、白名单下网站例外不生效等），按高→低给了建议顺序。',
    '这版只动"会丢数据 / 承诺明确落空"的 5 处，其余留到下一轮，避免一次改太多。',
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
