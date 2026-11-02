"""发版后一眼看清"线上、线下、源码"三边是否同一份东西。

三个问题，一次回答：

1. **线上资产 = 本地产物 = 本机部署？** 逐个核 sha256（不是看文件名、不是看大小）。
2. **线上源码 = 本地源码？** 比 tree，不比 commit SHA。
   为什么：github.com 的 git 端口常被封，发版走 `tools/api_push.py` 用 Git Data API
   把内容搬上去，GitHub 会**另建一个 commit**。所以两边 SHA 天生不同、内容可以完全一致。
   判定标准只有一个 —— tree 相同（= 每个文件的 blob sha 与 mode 全等）。
3. **tag 指向的源码 = 现在这份？** tag 可能比 main 旧，也可能被重打过。

用法：
    python tools/check_sync.py              # 核当前 tag（读清单里的）
    python tools/check_sync.py v0.1.88      # 核指定 tag
    python tools/check_sync.py --offline    # 不联网，只核本地（清单/产物/部署）

退出码 0 = 全一致，1 = 有问题（逐条列出）。
"""
import base64
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import urllib.request

REPO = 'QQQOrange/King-Of-Focus'
API = 'https://api.github.com'
CONFIG = r'D:/software/myself/king of focus data/config.json'
DEPLOY = {
    'windows-x64': r'D:/software/myself/King Of Focus.exe',
    'android': r'D:/software/myself/King Of Focus.apk',
}

OFFLINE = '--offline' in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith('--')]
TAG_ARG = args[0] if args else None

problems = []
warns = []


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def git(*a):
    r = subprocess.run(['git'] + list(a), capture_output=True, text=True)
    return r.stdout.strip()


def opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(path):
    token = json.load(io.open(CONFIG, encoding='utf-8'))['settings']['update']['token']
    req = urllib.request.Request(
        API + path,
        headers={
            'Authorization': 'token ' + token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'kof-release',
        },
    )
    with opener().open(req, timeout=60) as r:
        return json.loads(r.read().decode() or '{}')


def local_tree_files():
    """HEAD 里所有 blob：path -> (mode, sha)。"""
    out = {}
    for line in git('-c', 'core.quotepath=off', 'ls-tree', '-r', 'HEAD').splitlines():
        meta, path = line.split('\t', 1)
        mode, typ, sha = meta.split()
        if typ == 'blob':
            out[path] = (mode, sha)
    return out


def check_assets(man, tag):
    print('\n① 产物：本地 dist / 清单 / 线上 Release / 本机部署')
    release = None
    if not OFFLINE:
        try:
            release = api('/repos/%s/releases/tags/%s' % (REPO, tag))
        except Exception as e:                                    # noqa: BLE001
            problems.append('线上没有 tag %s 的 Release（%s）' % (tag, e))
    online = {a['name']: a for a in (release or {}).get('assets', [])}

    for plat, e in sorted(man['platforms'].items()):
        f, want = e['file'], e['sha256']
        path = os.path.join('dist', f)
        local_ok = os.path.exists(path) and sha256_of(path) == want
        if not os.path.exists(path):
            problems.append('%s：dist 里没有 %s' % (plat, f))
        elif not local_ok:
            problems.append('%s：dist 产物被改过（sha256 与清单不符）' % plat)

        line = '  %-16s %-46s 本地 %s' % (plat, f, 'OK' if local_ok else '不一致')

        if release is not None:
            a = online.get(f)
            if not a:
                problems.append('%s：Release 里缺资产 %s' % (plat, f))
                line += '  线上 缺失'
            else:
                dig = (a.get('digest') or '').replace('sha256:', '')
                up_ok = dig == want and a['size'] == e['size']
                if not up_ok:
                    problems.append('%s：线上资产与清单不符（size %s / digest %s）'
                                    % (plat, a['size'], (dig or '无')[:12]))
                line += '  线上 %s' % ('OK' if up_ok else '不一致')

        dst = DEPLOY.get(plat)
        if dst:
            if not os.path.exists(dst):
                warns.append('%s：本机部署文件不存在（%s）' % (plat, dst))
                line += '  部署 缺失'
            else:
                dep_ok = sha256_of(dst) == want
                if not dep_ok:
                    problems.append('%s：本机部署的文件不是这一版（%s）' % (plat, dst))
                line += '  部署 %s' % ('OK' if dep_ok else '不一致')
        print(line)

    known = {e['file'] for e in man['platforms'].values()} | {'King.Of.Focus-update.json'}
    extra = sorted(n for n in online if n not in known)
    if extra:
        warns.append('Release 里有多余资产：%s' % '、'.join(extra))


def check_source(tag, man):
    print('\n② 源码：线上 main / 本地 HEAD / tag')
    local = git('rev-parse', 'HEAD')
    local_tree = git('rev-parse', 'HEAD^{tree}')
    dirty = git('status', '--porcelain')
    if dirty:
        problems.append('工作区有未提交改动，本地源码不是"已发布"的状态：\n      '
                        + dirty.replace('\n', '\n      ')[:600])
    print('  本地 HEAD   %s  tree %s  %s'
          % (local[:12], local_tree[:12], '干净' if not dirty else '有改动'))

    if OFFLINE:
        print('  --offline：跳过线上比对')
        return

    ref = api('/repos/%s/git/ref/heads/main' % REPO)['object']
    if ref['type'] == 'tag':
        ref = api('/repos/%s/git/tags/%s' % (REPO, ref['sha']))['object']
    remote = ref['sha']
    remote_tree = api('/repos/%s/git/commits/%s' % (REPO, remote))['tree']['sha']
    same_tree = remote_tree == local_tree
    print('  线上 main   %s  tree %s' % (remote[:12], remote_tree[:12]))
    if remote != local:
        print('  SHA 不同（预期：发版走 API 推送，GitHub 另建 commit），按 tree 判定')
    if not same_tree:
        problems.append('线上 main 与本地内容不同（tree %s != %s）—— 有改动没推上去'
                        % (remote_tree[:12], local_tree[:12]))
        # 逐文件找差异，比"树不同"有用得多
        want = local_tree_files()
        got = {i['path']: ('%o' % i['mode'], i['sha'])
               for i in api('/repos/%s/git/trees/%s?recursive=1' % (REPO, remote_tree))['tree']
               if i['type'] == 'blob'}
        only_local = sorted(set(want) - set(got))
        only_remote = sorted(set(got) - set(want))
        diff = sorted(p for p in set(want) & set(got) if want[p] != got[p])
        if only_local:
            print('    只在本地：%s' % '、'.join(only_local[:8]))
        if only_remote:
            print('    只在线上：%s' % '、'.join(only_remote[:8]))
        if diff:
            print('    内容不同：%s' % '、'.join(diff[:8]))

    tref = api('/repos/%s/git/ref/tags/%s' % (REPO, tag))['object']
    if tref['type'] == 'tag':
        tref = api('/repos/%s/git/tags/%s' % (REPO, tref['sha']))['object']
    tag_commit, tag_tree = tref['sha'], api(
        '/repos/%s/git/commits/%s' % (REPO, tref['sha']))['tree']['sha']
    print('  线上 tag    %s -> %s  tree %s' % (tag, tag_commit[:12], tag_tree[:12]))
    # tag 只要求"是这一版的内容"，不要求等于 HEAD —— 发版后 main 继续前进是常态。
    # 判据：tag 树里带着这一版的发版说明，且 Cargo.toml 的 version 与清单一致。
    notes = 'docs/release-notes-%s.md' % man['platforms']['windows-x64']['version']
    paths = {i['path'] for i in api(
        '/repos/%s/git/trees/%s?recursive=1' % (REPO, tag_tree))['tree']}
    items = api('/repos/%s/git/trees/%s?recursive=1' % (REPO, tag_tree))['tree']
    blob_of = {i['path']: i['sha'] for i in items if i['type'] == 'blob'}
    if notes not in blob_of:
        problems.append('tag %s 的源码里没有 %s —— tag 打错了版本' % (tag, notes))
    else:
        print('  tag 内容：含 %s ✓' % notes)
        # 再核一次版本号本身：说明文件可能是上一版复制来的
        want_version = man['platforms']['windows-x64']['version']
        text = base64.b64decode(
            api('/repos/%s/git/blobs/%s' % (REPO, blob_of['src-tauri/Cargo.toml']))['content']
        ).decode('utf-8', 'replace')
        m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
        got_version = m.group(1) if m else '?'
        if got_version != want_version:
            problems.append('tag %s 里 Cargo.toml 是 %s，清单是 %s'
                            % (tag, got_version, want_version))
        else:
            print('  tag 内容：Cargo.toml version = %s ✓' % got_version)
    if tag_tree == local_tree:
        print('  tag 就在本地 HEAD 上')
    elif tag_tree != local_tree:
        local_tag = git('rev-parse', 'refs/tags/' + tag + '^{commit}')
        if local_tag and local_tag != tag_commit:
            warns.append('本地 tag %s 指向 %s，线上指向 %s（内容可一致，SHA 因 API 推送不同）'
                         % (tag, local_tag[:12], tag_commit[:12]))


def check_versions(man):
    print('\n③ 版本：清单与三端源文件')
    print('  清单 tag %s，各平台 %s' % (
        man.get('tag'),
        ' / '.join('%s %s' % (p, e['version']) for p, e in sorted(man['platforms'].items()))))
    r = subprocess.run([sys.executable, 'tools/release_meta.py', 'check', '--tag', man['tag']],
                       capture_output=True, text=True)
    tail = [l for l in r.stdout.splitlines() if l.startswith(('✓', '✗', '  ✗'))]
    print('  release_meta check: %s' % (tail[-1] if tail else r.stdout.strip()[-200:]))
    if r.returncode != 0:
        problems.append('release_meta.py check 未通过（版本/命名/清单不一致）')


def main():
    if not os.path.isdir('dist'):
        raise SystemExit('先在本仓库根目录跑（找不到 dist/）')
    mpath = 'dist/King.Of.Focus-update.json'
    man = json.load(io.open(mpath, encoding='utf-8'))
    tag = TAG_ARG or man.get('tag')
    if not tag:
        raise SystemExit('清单里没有 tag，请显式传一个，如 v0.1.88')
    print('核对对象：%s（%s）' % (tag, '离线' if OFFLINE else '含线上'))
    check_assets(man, tag)
    check_source(tag, man)
    check_versions(man)

    print()
    for w in warns:
        print('  ! ' + w)
    if problems:
        print('\n✗ 有 %d 处不一致：' % len(problems))
        for p in problems:
            print('  - ' + p)
        return 1
    print('\n✓ 线上资产、本机部署、源码内容三边一致。')
    return 0


sys.exit(main())
