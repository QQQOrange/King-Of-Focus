"""在 github.com 的 git 端口不可达时，用 API 把本地提交"搬"上去。

为什么需要它：本次发布时 github.com:443 被阻断（api.github.com 正常，
git smart HTTP 走不了），但本地已经有完整提交。于是用 Git Data API
按同样的内容建 blobs → tree → commit，再更新 main 并打 tag。

安全措施：
  1. 远端 main 必须仍等于本地 HEAD~1，**或者**两者"树完全相同、只有 SHA 不同"
     （上一次也是用这个脚本推的，就会出现这种情况）——树不一样才放弃；
  2. 建好 tree 后**逐个文件比对** blob sha 与本地 `git ls-tree -r HEAD`，
     不一致就放弃，绝不 force。

用法：python tools/api_push.py v0.1.51
"""
import base64
import io
import json
import subprocess
import sys
import urllib.request

TOKEN = json.load(
    io.open(r'D:/software/myself/king of focus data/config.json', encoding='utf-8')
)['settings']['update']['token']
REPO = 'QQQOrange/King-Of-Focus'
API = 'https://api.github.com'
TAG = sys.argv[1] if len(sys.argv) > 1 else 'v0.1.51'

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path,
        method=method,
        data=data,
        headers={
            'Authorization': 'token ' + TOKEN,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'kof-release',
        },
    )
    try:
        with opener.open(req, timeout=60) as r:
            return json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        raise SystemExit('HTTP %s %s\n%s' % (e.code, path, e.read().decode()[:500]))


def git(*args):
    return subprocess.check_output(['git'] + list(args), cwd='.').decode().strip()


def git_bytes(*args):
    return subprocess.check_output(['git'] + list(args), cwd='.')


head = git('rev-parse', 'HEAD')
parent_local = git('rev-parse', 'HEAD~1')
msg = git('log', '-1', '--pretty=%B')
print('本地 HEAD   ', head)
print('本地 HEAD~1 ', parent_local)

ref = api('GET', '/repos/%s/git/ref/heads/main' % REPO)
remote_head = ref['object']['sha']
print('远端 main   ', remote_head)
if remote_head != parent_local:
    # 上次用 API 推过：远端 commit 的 SHA 与本地不同，但内容（树）一样。
    # 这种情况必须放行，否则这个兜底脚本只能用一次。
    same_tree = (
        api('GET', '/repos/%s/git/commits/%s' % (REPO, remote_head))['tree']['sha']
        == git('rev-parse', 'HEAD~1^{tree}')
    )
    if not same_tree:
        raise SystemExit('远端 main 已经分叉（树都不同），放弃（请改用正常 push）')
    print('  远端与本地 HEAD~1 树相同、SHA 不同（上次走的是 API），按内容继续')

base_tree = api('GET', '/repos/%s/git/commits/%s' % (REPO, remote_head))['tree']['sha']
changed = [p for p in git('diff', '--name-only', parent_local, head).splitlines() if p]
print('变更文件 %d 个' % len(changed))

entries = []
for path in changed:
    # 必须用 HEAD 里的字节，而不是工作区文件：工作区可能被 CRLF 转换过，
    # 两边字节不同 → blob sha 不同 → 造出来的树和本地提交不是同一棵树
    raw = git_bytes('cat-file', 'blob', head + ':' + path)
    blob = api('POST', '/repos/%s/git/blobs' % REPO,
               {'content': base64.b64encode(raw).decode(), 'encoding': 'base64'})
    entries.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    print('  blob', path, len(raw), 'B')

tree = api('POST', '/repos/%s/git/trees' % REPO, {'base_tree': base_tree, 'tree': entries})
print('新 tree', tree['sha'])

# 逐个文件核对：远端造出来的树必须和本地 HEAD 的树一模一样
want = {}
for line in git('-c', 'core.quotepath=off', 'ls-tree', '-r', 'HEAD').splitlines():
    meta, path = line.split('\t', 1)
    mode, typ, sha = meta.split()
    if typ == 'blob':
        want[path] = sha
got = {}
for item in api('GET', '/repos/%s/git/trees/%s?recursive=1' % (REPO, tree['sha']))['tree']:
    if item['type'] == 'blob':
        got[item['path']] = item['sha']
only_local = sorted(set(want) - set(got))
only_remote = sorted(set(got) - set(want))
diff = sorted(p for p in set(want) & set(got) if want[p] != got[p])
if only_local or only_remote or diff:
    raise SystemExit('树不一致：缺 %s / 多 %s / 不同 %s' % (only_local[:5], only_remote[:5], diff[:5]))
print('树核对通过：%d 个文件全部一致' % len(want))

commit = api('POST', '/repos/%s/git/commits' % REPO,
             {'message': msg, 'tree': tree['sha'], 'parents': [remote_head]})
print('新 commit', commit['sha'])

api('PATCH', '/repos/%s/git/refs/heads/main' % REPO, {'sha': commit['sha'], 'force': False})
print('main 已更新')

try:
    api('POST', '/repos/%s/git/refs' % REPO,
        {'ref': 'refs/tags/' + TAG, 'sha': commit['sha']})
    print('tag', TAG, '已创建')
except SystemExit as e:
    print('tag 创建失败（可能已存在）：', e)
