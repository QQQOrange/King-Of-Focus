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
    '**一次全面自检：13 处逻辑缺陷修复（演练模式、睡眠锁、番茄相位、误杀保护）**',
    '',
    '这一版没有加新功能，全部是"功能说的是一回事、代码做的是另一回事"的地方。',
    '按影响面从大到小：',
    '',
    '### 1. 演练模式形同虚设（最严重）',
    '设置里开了「演练模式」，界面写着"只记录不真的关"，但四条路径依然真的动手：',
    '固化期间封杀任务管理器那类工具、普通自律期间封杀任务管理器、',
    '浏览器守护强关浏览器、进入自律时间自动打开程序与网址。',
    '现在四条全部前置守卫：演练模式只写一条「演练：本应……」的事件，不结束进程、不启动程序。',
    '',
    '### 2. 睡眠时段：三种情况永远不会关机 / 一解锁就关机',
    '- **只关机不锁屏**的时段（午睡常见）永远不关机：关机条件错用了"是否被锁屏"。',
    '  改为"在时段内 + 倒计时已启动 + 时间到"，与锁不锁屏无关。',
    '- **积分解锁结束后立刻关机**：解锁期间把计时记录整个扔掉了，解锁一结束又按"段起点"重新武装，',
    '  段起点往往是几小时前，剩余时间立刻为负。现在解锁期间保留记录并把起点推到当下。',
    '- **合盖唤醒后立刻关机**：同上，唤醒后从"现在"重新给满倒计时。',
    '',
    '### 3. 积分解锁可以互相绕过',
    '睡眠时段解锁与自律固化解锁共用了同一个截止时间字段：花积分买断睡眠，',
    '会顺手把自律固化也解除；反过来也一样。现在拆成两个独立字段，各读各的。',
    '（老配置缺字段时按"未解锁"处理，不影响已有数据。）',
    '',
    '### 4. 专注时钟：25/5 这类配置的尾段判错',
    '专注 + 休息小于 60 分钟时，一小时里要跑多轮。旧代码只判一次，',
    '25/5 在 09:30 之后剩余被算成 -10 分钟 → 倒计时卡 0、阶段提醒整段不发、',
    '依赖它的固化判定还会静默失效。改为按 `offset % (专注+休息)` 取模，尾段算专注。',
    '界面上的逐刻度列表也统一成同一个相位锚点（整点），不再出现"显示是专注、实际在休息"。',
    '',
    '### 5. 误杀保护',
    '- **黑名单模式完全不看受保护进程**：名单里写 `*` 或标题规则过宽时会直接结束 explorer / dwm。',
    '  白名单一侧有保护、黑名单没有，现在口径一致。',
    '- **浏览器判定用子串**：`arc` 命中 arcsoft、`opera` 命中 operadriver、`zen` 命中 frozen ——',
    '  浏览器守护会把这些无关进程当浏览器杀掉。改为精确匹配 + 只认数字后缀（360se6）和 `_proxy`。',
    '',
    '### 6. 其它判定与体验',
    '- 时段 `10:00–10:00` 被当成 24 小时、连带拦住第二天；现在视为空段（`00:00–00:00` 仍保留为「全天」）。',
    '- 番茄剩余时间没有按段尾截断：30 分钟的段配 45/15 会报出 34 分钟，现在按段尾封顶。',
    '- 阶段提醒取的是"第一条生效规则"，它没配番茄就完全忽略后面配了番茄的规则；',
    '  现在只认真的配了番茄的规则。',
    '- 关掉提醒那段时间里去重状态被冻结，重新打开后本阶段不再提醒；现在状态照常推进。',
    '- 强杀失败每 700ms 重试一次且永不停止（目标以管理员运行时永远失败）；',
    '  改为指数退避 0.7s → 1.4s → 2.8s → 5.6s → 11s。',
    '- 遮罩的透明度 / 跟随 / 屏蔽点击只改内存不写配置，重启后全部回退；现在改了就落盘。',
    '- 后端发的「自律时段内已禁止退出」提示被前端当成"拦截应用"渲染；补上 warn 类型。',
    '- 锁屏窗口在连不上后台时会保持全屏不透明（没有关闭入口）；连续三次失败后自行让出屏幕。',
    '',
    '### 自检',
    '- Rust 200 → **209**：新增番茄相位取模、时段空段/全天、番茄截断、只关机不锁屏、',
    '  黑名单保护系统进程、浏览器精确匹配共 7 条断言。',
    '- 界面 1010 条断言全绿。',
    '',
    '### 回归检查要点',
    '1. 开演练模式 → 打开黑名单软件，只看事件、进程不被关；',
    '2. 设一段"只关机不锁屏"的睡眠段（倒计时设 1 分钟）→ 到点弹关机提示；',
    '3. 专注时钟设 25/5 → 逐刻度列表与 HUD 倒计时一致，不会卡在 00:00；',
    '4. 黑名单加 `*` → 资源管理器/任务栏不受影响，普通软件照常被拦；',
    '5. 改遮罩透明度后重启 → 值还在。',
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
