"""三端统一发布：版本校验 + 产物归档 + 生成更新清单。

为什么需要它
------------
同一个 Release 里现在挂着三种包（Windows exe、Android apk、插件 zip）。
客户端如果靠"在资产列表里找像安装包的东西"来更新，迟早会挑错——桌面端
下到 apk、手机端下到 exe。所以发布时必须产出一份**更新清单**，把
"哪个平台该用哪个文件、多大、sha256 多少"写死，客户端只认写给自己的那一条。

它同时是"发布前的一致性闸门"：三端版本、产物命名、清单条目任意一条对不上，
就直接以非 0 退出，不让残缺的发布溜出去。

用法
----
    python tools/release_meta.py check                 # 只校验（发版前跑这个）
    python tools/release_meta.py build --notes notes.md  # 归档产物 + 生成清单
    python tools/release_meta.py check --require-same  # 额外要求三端版本号相同

产物（都在 dist/ 下，dist 不进版本库）：
    King.Of.Focus-<ver>-windows-x64.exe
    King.Of.Focus-<ver>-android.apk
    King.Of.Focus-<ver>-chrome-extension.zip
    King.Of.Focus-update.json
"""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import sys
import time
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
DIST = os.path.join(ROOT, 'dist')

APP_ID = 'king-of-focus'
MANIFEST_NAME = 'King.Of.Focus-update.json'
NAME_PREFIX = 'King.Of.Focus-'
SCHEMA = 1

# 平台标识 → (允许的扩展名, 中文名)
PLATFORMS = {
    'windows-x64': (['exe', 'msi'], 'Windows 64 位（桌面端）'),
    'android': (['apk'], 'Android（手机端）'),
    'chrome-extension': (['zip', 'crx'], '浏览器插件'),
}


def die(msg):
    print('✗ ' + msg)
    sys.exit(1)


# ---------------------------------------------------------------- 读版本

def read_desktop_version():
    p = os.path.join(ROOT, 'src-tauri', 'Cargo.toml')
    for line in io.open(p, encoding='utf-8'):
        m = re.match(r'^\s*version\s*=\s*"([^"]+)"', line)
        if m:
            return m.group(1)
    die('src-tauri/Cargo.toml 里找不到 version')


def read_android_version():
    p = os.path.join(ROOT, 'android', 'app', 'build.gradle.kts')
    name = code = None
    for line in io.open(p, encoding='utf-8'):
        m = re.search(r'versionName\s*=\s*"([^"]+)"', line)
        if m:
            name = m.group(1)
        m = re.search(r'versionCode\s*=\s*(\d+)', line)
        if m:
            code = int(m.group(1))
    if not name:
        die('android/app/build.gradle.kts 里找不到 versionName')
    return name, code


def read_extension_version():
    p = os.path.join(ROOT, 'extension', 'manifest.json')
    with io.open(p, encoding='utf-8') as f:
        return json.load(f)['version']


def versions():
    av, acode = read_android_version()
    return {
        'windows-x64': read_desktop_version(),
        'android': av,
        'chrome-extension': read_extension_version(),
        '_android_code': acode,
    }


def valid_version(v):
    return bool(re.match(r'^\d{1,4}\.\d{1,4}\.\d{1,4}$', str(v)))


# ---------------------------------------------------------------- 归档产物

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def target_name(platform, version):
    ext = PLATFORMS[platform][0][0]
    return '%s%s-%s.%s' % (NAME_PREFIX, version, platform, ext)


def build_extension_zip(version):
    """把 extension/ 打成一个 zip。排除开发期才用得上的东西。"""
    dest = os.path.join(DIST, target_name('chrome-extension', version))
    src = os.path.join(ROOT, 'extension')
    skip = {'_test_matcher.js', 'extension_key.pem'}
    with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as z:
        for base, _dirs, files in os.walk(src):
            for f in sorted(files):
                full = os.path.join(base, f)
                rel = os.path.relpath(full, src).replace('\\', '/')
                if f in skip or f.endswith('.pem'):
                    continue
                z.write(full, rel)
    return dest


def stage_desktop(version):
    dest = os.path.join(DIST, target_name('windows-x64', version))
    exe = os.path.join(ROOT, 'src-tauri', 'target', 'release', 'king-of-focus.exe')
    if not os.path.exists(exe):
        die('桌面端产物不存在：%s（先跑 cargo build --release）' % exe)
    shutil.copy2(exe, dest)
    return dest


def stage_android(version):
    dest = os.path.join(DIST, target_name('android', version))
    cands = [
        os.path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
        os.path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
    ]
    apk = next((c for c in cands if os.path.exists(c)), None)
    if not apk:
        die('安卓产物不存在（先跑 gradlew assembleDebug / assembleRelease）')
    shutil.copy2(apk, dest)
    return dest


# ---------------------------------------------------------------- 生成清单

def build_manifest(notes_path=None):
    v = versions()
    os.makedirs(DIST, exist_ok=True)

    files = {
        'windows-x64': stage_desktop(v['windows-x64']),
        'android': stage_android(v['android']),
        'chrome-extension': build_extension_zip(v['chrome-extension']),
    }
    kind = {'windows-x64': 'installer', 'android': 'apk', 'chrome-extension': 'extension'}

    notes = ''
    if notes_path and os.path.exists(notes_path):
        notes = io.open(notes_path, encoding='utf-8').read()

    manifest = {
        'app': APP_ID,
        'schema': SCHEMA,
        # 发布标签跟桌面端版本走：它是仓库的主产品，tag 只是给人看的锚点。
        # 每个平台真正的版本在 platforms.<id>.version 里，各端只信自己那一条。
        'tag': 'v' + v['windows-x64'],
        'generatedAt': int(time.time()),
        'notes': notes,
        'platforms': {},
    }
    for plat, path in files.items():
        manifest['platforms'][plat] = {
            'version': v[plat],
            'kind': kind[plat],
            'file': os.path.basename(path),
            'size': os.path.getsize(path),
            'sha256': sha256_of(path),
        }

    out = os.path.join(DIST, MANIFEST_NAME)
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return out, manifest


# ---------------------------------------------------------------- 校验

def check(require_same=False, tag=None):
    v = versions()
    problems = []
    warnings = []

    print('版本来源（单一事实源就是这三个文件，脚本只读不写）')
    print('  src-tauri/Cargo.toml              %s' % v['windows-x64'])
    print('  android/app/build.gradle.kts      %s (versionCode %s)' % (v['android'], v['_android_code']))
    print('  extension/manifest.json           %s' % v['chrome-extension'])

    for plat, ver in (('windows-x64', v['windows-x64']), ('android', v['android']),
                      ('chrome-extension', v['chrome-extension'])):
        if not valid_version(ver):
            problems.append('%s 的版本号不是 x.y.z：%s' % (plat, ver))

    uniq = {v['windows-x64'], v['android'], v['chrome-extension']}
    if len(uniq) > 1:
        msg = '三端版本不一致：%s' % ' / '.join(sorted(uniq))
        if require_same:
            problems.append(msg)
        else:
            warnings.append(msg + '（清单里各平台记自己的版本，客户端只校验自己那一条）')

    # 产物 + 清单
    man_path = os.path.join(DIST, MANIFEST_NAME)
    if not os.path.exists(man_path):
        problems.append('还没有更新清单：先跑 python tools/release_meta.py build')
        report(problems, warnings)
        return 1

    with io.open(man_path, encoding='utf-8') as f:
        man = json.load(f)

    if man.get('app') != APP_ID:
        problems.append('清单的 app 字段不是 %s' % APP_ID)
    if man.get('schema') != SCHEMA:
        problems.append('清单 schema 不是 %d' % SCHEMA)
    if tag and man.get('tag') != tag:
        problems.append('清单 tag 是 %s，与要求的 %s 不一致' % (man.get('tag'), tag))

    print('\n各平台条目')
    for plat, (exts, label) in PLATFORMS.items():
        entry = (man.get('platforms') or {}).get(plat)
        if not entry:
            problems.append('清单里缺少 %s 这一条' % plat)
            continue
        ver = str(entry.get('version', ''))
        f = str(entry.get('file', ''))
        size = int(entry.get('size') or 0)
        sha = str(entry.get('sha256') or '')
        want = target_name(plat, ver)
        ok_name = (f == want)
        ok_ver = (ver == v[plat])
        path = os.path.join(DIST, f)
        ok_file = os.path.exists(path)
        ok_size = ok_file and os.path.getsize(path) == size
        ok_sha = ok_file and sha256_of(path) == sha
        print('  %-16s v%-8s %-46s %8.1f MB' % (plat, ver, f, size / 1024 / 1024))
        if not ok_name:
            problems.append('%s 的包名不符合规范：%s（应为 %s）' % (plat, f, want))
        if not ok_ver:
            problems.append('%s 清单版本 %s 与源码版本 %s 不一致' % (plat, ver, v[plat]))
        if not ok_file:
            problems.append('%s 的产物不在 dist/ 里：%s' % (plat, f))
        elif not ok_size:
            problems.append('%s 的产物大小与清单不符' % plat)
        elif not ok_sha:
            problems.append('%s 的产物 sha256 与清单不符（产物被替换过？）' % plat)
        # 包类型必须是本平台允许的那几种
        ext = f.rsplit('.', 1)[-1].lower() if '.' in f else ''
        if ext not in exts:
            problems.append('%s 的包类型是 .%s，不在允许集合 %s 里' % (plat, ext, exts))
        if label and not ok_name:
            warnings.append('%s 的命名不符合 %s 的约定' % (plat, label))

    # 老名字的遗留产物会让发布脚本重复上传，这里点出来
    for f in os.listdir(DIST):
        if f.startswith(NAME_PREFIX) and f != MANIFEST_NAME:
            if not any(f == target_name(p, v[p]) for p in PLATFORMS):
                warnings.append('dist/ 里有个多余的产物：%s（不会被上传）' % f)

    return report(problems, warnings)


def report(problems, warnings):
    if warnings:
        print('\n提醒')
        for w in warnings:
            print('  ! ' + w)
    if problems:
        print('\n不能发布：')
        for p in problems:
            print('  ✗ ' + p)
        return 1
    print('\n✓ 一致性校验通过：三端产物齐全、命名规范、清单与产物一一对应')
    return 0


def main():
    ap = argparse.ArgumentParser(description='三端统一发布：校验版本与产物，生成更新清单')
    ap.add_argument('action', choices=['check', 'build'])
    ap.add_argument('--notes', help='发布说明文件（写进清单与 Release）')
    ap.add_argument('--tag', help='要求清单里的 tag 必须等于它，例如 v0.1.52')
    ap.add_argument('--require-same', action='store_true',
                    help='额外要求三端版本号完全相同（严格统一版本时用）')
    a = ap.parse_args()

    if a.action == 'build':
        out, man = build_manifest(a.notes)
        print('已生成 %s' % out)
        for plat, e in man['platforms'].items():
            print('  %-16s v%-8s %-46s %8.1f MB' % (
                plat, e['version'], e['file'], e['size'] / 1024 / 1024))
        print('\n接下来：python tools/release.py %s（会把这些资产和清单一起传上去）'
              % man['tag'].lstrip('v'))
        return 0

    return check(require_same=a.require_same, tag=a.tag)


if __name__ == '__main__':
    sys.exit(main())
