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
    '**第二轮：把审查报告里的"会丢数据 / 承诺落空"再修 13 处**',
    '',
    '上一版修了 5 处最狠的，这版把剩下同一档次的都清了。仍然没有新功能。',
    '',
    '### 数据安全',
    '1. **统计日文件被空对象覆盖**：日文件解析失败时返回空对象，下一次落盘把它写回同名文件，',
    '   那一天的数据永久变 0。现在解析失败先把原文件改名成 `.json.bad-<时间戳>` 留档。',
    '2. **跨天轮转覆盖已有数据**：时区往西改 / 时间回拨 / 唤醒后 NTP 校正，都会让"今天"重新出现，',
    '   以前无条件换成空对象，下一次 flush 就把那天清掉。现在先 `load_day` 读回来。',
    '3. **自动日报只补一天且失败也记账**：程序停三天再启动，中间两天永远不补；生成失败（磁盘满）',
    '   也把那天标记成"已生成"。现在从上次的下一天逐日补，写成功才推进游标。',
    '4. **同步下载会覆盖机器专属字段**：`backup.password`（之后所有本地备份都用别人的口令）、',
    '   `update.token`、`run_as_admin`、`autostart` 全被云端覆盖；且写盘失败被吞掉。',
    '   现在这些字段一律保留本机，保存失败直接报错。',
    '5. **`updated_at` 不刷新导致本地改动被云端冲掉**：改遮罩/提醒/积分不刷这个字段，',
    '   自动同步判定"云端更新"，下一轮把本地改动盖回去。现在 `cfg::save` 统一刷新。',
    '6. **配置损坏无提示**：GUI 子系统里 `eprintln` 没有宿主，用户只看到"规则全没了"。',
    '   现在留档文件名带时间戳，并在启动后弹一条提示说明去哪找。',
    '',
    '### 自愈',
    '7. **孤儿守护**：`stop_guard` 终止失败（权限不足）仍删 pid 文件，此后再也定位不到它，',
    '   它会按心跳把主进程反复复活。现在失败就保留 pid。',
    '8. **守护被杀后不再拉起**：`guard_running` 只置位不复位，任务管理器杀掉守护后，',
    '   "被强杀就复活"这条保护静默失效。现在每 5 拍复核一次进程是否还在。',
    '9. **备份写不进去还不知道**：备份目录绑死 exe 所在目录（装在 Program Files 时数据已回落到',
    '   APPDATA，备份却往不可写的安装目录写），且错误被 `let _ =` 吞掉。现在跟随数据目录，失败就提示。',
    '10. **开机自启静默失败**：`reg add` 的返回值被丢弃，组策略/杀软拦截时界面照样显示"已开启"。',
    '    现在会明确报"写入失败"。',
    '',
    '### 承诺落空',
    '11. **白名单模式下网站例外完全无效**：判定层只看 `sites`，声明式规则层也不给 `exceptions`',
    '    加 allow —— 配了例外照拦。两层都补上了（判定层与 DNR 层），并加了 3 条匹配器断言。',
    '12. **固化判定忽略方案绑定**：把「周末」方案只绑「娱乐」组，工作组里的固化规则照样锁人，',
    '    提示里还显示一条此刻并不生效的规则名。现在与 `active_rules` 同口径按绑定过滤。',
    '13. 描述与实现对齐：`apply_autostart` 改为返回 `Result`，失败能一路传到界面。',
    '',
    '### 自检',
    '- Rust **215** 通过（本版未新增，改动以行为修正为主，由既有断言兜底）',
    '- 插件匹配器 **47** 条（新增 3 条：白名单+例外）',
    '- 界面 **1010** 条全绿',
    '',
    '### 仍未处理（报告第三节剩余项）',
    '更新包完整性校验（chunked 响应下等于不校验）、安装失败无回滚、遮罩 topmost 残留不自愈、',
    '`Rule.lock` 前端残留、6 条死命令、英文界面约 180 条缺失词条 —— 都还在。',
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
