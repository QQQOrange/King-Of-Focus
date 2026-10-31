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
    '**第三轮：更新链路与界面的最后一批遗留项**',
    '',
    '### 更新',
    '1. **下载完整性校验形同虚设**：原来只在"服务器回了 Content-Length"时比对大小。',
    '   走 chunked 编码时 `total = 0`，这段检查整段跳过 —— 截断的安装包照样能过 MZ 校验',
    '   （PE 头就在文件开头）。现在用 Release 资产清单里的 `size` 再核对一次，',
    '   这个值与服务器怎么传输无关。前端已经把 size 一路传下来了。',
    '2. **安装失败静默**：脚本不管 `ERRORLEVEL`，装失败也删包、起旧版本，界面显示"更新完成"，',
    '   用户只看到版本号没变。现在失败会写一个 marker，下次启动明确提示',
    '   "上次更新没有安装成功（可能取消了 UAC 授权或安装包被拦截）"。',
    '',
    '### 界面：把"配了不生效"的入口去掉',
    '3. 规则编辑器的「休息」页已移除。自律规则改版后不再有自己的时间表，',
    '   `pomodoro_state` 恒返回 (false, 0)，这一页配了也不会生效 —— 留着只会误导。',
    '   番茄仍在「自律时段」页按小时配置，那里是真的生效的。',
    '4. 随之去掉规则卡片上的「番茄 50/10」徽标（同一个原因）。',
    '5. 删除规则「锁定」（时长/密码/文字）的前端残留：界面上没有入口，后端也零校验，',
    '   直接改配置就能绕过。与其留一个假装存在的锁，不如先拿掉，等真做时连后端一起做。',
    '',
    '### 说明',
    '6. 5 条"无界面入口"的后端命令（`test_mode_status` / `hide_window` / `show_main` /',
    '   `stats_flush` / `browser_check_path` / `quit_app`）保留，并在注册处写清各自用途与',
    '   替代入口 —— 它们是预留，不是漏接。',
    '',
    '### 自检',
    '- Rust **215** 通过 · 插件匹配器 **47** 条 · 界面 **1010** 条全绿',
    '',
    '### 到这里，审查报告里"能马上做"的都做完了',
    '只剩两类：一是需要跨版本设计的大改（更新包签名校验、备份恢复快照与回滚），',
    '二是纯工作量（英文界面约 180 条缺失词条）。',
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
