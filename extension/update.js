/* King Of Focus — 插件更新校验（纯函数，可在 node 里单测）
 *
 * 和桌面端 `src-tauri/src/updsel.rs`、安卓端 `core/Updater.kt` 是同一套规则，
 * 错误码逐字相同（见 `docs/update-channels.md`）。
 *
 * 为什么插件也要校验：同一个 Release 里挂着桌面 exe、安卓 apk、插件 zip。
 * 只要有一端"按扩展名猜"，迟早会挑错。这里只认清单里 `chrome-extension` 那一条，
 * 并且核对包名里的版本与平台、扩展名、版本新旧、资产是否真的在发布里。
 */
(function (root) {
  'use strict';

  const APP_ID = 'king-of-focus';
  const PLATFORM = 'chrome-extension';
  const MANIFEST_NAME = 'King.Of.Focus-update.json';
  const NAME_PREFIX = 'King.Of.Focus-';
  const SCHEMA_MAX = 1;

  function allowedExts(platform) {
    if (platform === 'android') return ['apk'];
    if (platform === 'chrome-extension') return ['zip', 'crx'];
    return ['exe', 'msi'];
  }

  function platformLabel(platform) {
    if (platform === 'android') return 'Android';
    if (platform === 'chrome-extension') return '浏览器插件';
    if (platform === 'windows-x64') return 'Windows 64 位';
    return '未知平台';
  }

  /** 逐段按数字比，缺的段补 0；按字符串比会让 0.10.0 < 0.9.0 */
  function compareVer(a, b) {
    const parse = (s) =>
      String(s == null ? '' : s)
        .trim()
        .replace(/^[vV]/, '')
        .split(/[.\-+]/)
        .slice(0, 3)
        .map((x) => parseInt(x, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < 3; i += 1) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  /** 必须是三段纯数字：1.2 / 1.2.3-beta 一律拒绝 */
  function validVersion(v) {
    const parts = String(v == null ? '' : v).split('.');
    return parts.length === 3 && parts.every((p) => /^\d{1,4}$/.test(p));
  }

  /** 名字是否严格等于 King.Of.Focus-<version>-<platform>.<允许的扩展名> */
  function nameMatches(file, version, platform) {
    const lower = String(file || '').toLowerCase();
    const prefix = NAME_PREFIX.toLowerCase();
    if (!lower.startsWith(prefix)) return false;
    const rest = lower.slice(prefix.length);
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) return false;
    const stem = rest.slice(0, dot);
    const ext = rest.slice(dot + 1);
    if (!allowedExts(platform).includes(ext)) return false;
    return stem === `${String(version).toLowerCase()}-${platform}`;
  }

  /** 名字里带别的平台痕迹时返回那个平台 */
  function foreignType(file, platform) {
    const lower = String(file || '').toLowerCase();
    const ext = lower.slice(lower.lastIndexOf('.') + 1);
    const isApk = ext === 'apk' || lower.includes('-android');
    const isExt = ext === 'zip' || ext === 'crx' ||
      lower.includes('-extension') || lower.includes('-chrome');
    const isWin = ext === 'exe' || ext === 'msi';
    if (isApk && platform !== 'android') return 'android';
    if (isExt && platform !== 'chrome-extension') return 'chrome-extension';
    if (isWin && !platform.startsWith('windows')) return 'windows';
    return null;
  }

  function reject(code, message) {
    return { status: 'reject', code, message };
  }

  /**
   * 从清单里挑出本平台那一条并校验。
   * @returns {{status:'ok',version,file,size,sha256}}
   *        | {{status:'none',latest}}
   *        | {{status:'reject',code,message}}
   */
  function select(manifest, platform, current, assets) {
    const list = Array.isArray(assets) ? assets : [];
    if (!manifest || typeof manifest !== 'object') {
      return reject('E_BAD_MANIFEST', '更新清单读不出来');
    }
    if (manifest.app !== APP_ID) {
      return reject('E_BAD_APP', `这不是 King Of Focus 的更新清单（app = "${manifest.app}"）`);
    }
    const schema = Number(manifest.schema) || 0;
    if (schema < 1 || schema > SCHEMA_MAX) {
      return reject('E_BAD_SCHEMA', `更新清单版本 ${schema} 本机读不懂，请手动下载新版`);
    }
    const table = manifest.platforms || {};
    const entry = table[platform];
    if (!entry || typeof entry !== 'object') {
      return reject(
        'E_PLATFORM_MISSING',
        `这次发布没有 ${platformLabel(platform)}（${platform}）的安装包，本机不会去装别的平台的包`,
      );
    }

    const version = String(entry.version || '').trim();
    if (!validVersion(version)) {
      return reject('E_BAD_VERSION', `清单里的版本号不是 x.y.z 形式："${version}" 不能拿来比大小`);
    }
    const file = String(entry.file || '').trim();
    if (!file) return reject('E_BAD_MANIFEST', '清单里没有写包名');

    if (!nameMatches(file, version, platform)) {
      return reject(
        'E_NAME_MISMATCH',
        `包名和清单对不上：${file} 应该叫 ${NAME_PREFIX}${version}-${platform}.<${allowedExts(platform).join('/')}>`,
      );
    }
    const bad = foreignType(file, platform);
    if (bad) {
      return reject('E_TYPE_MISMATCH', `这是 ${platformLabel(bad)} 的安装包，不能装在 ${platformLabel(platform)} 上`);
    }
    if (compareVer(version, current) <= 0) {
      return { status: 'none', latest: version };
    }

    const size = Number(entry.size) || 0;
    if (size <= 0) return reject('E_BAD_SIZE', '清单里没写文件大小，无法校验下载完整性');
    const sha256 = String(entry.sha256 || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      return reject('E_BAD_HASH', '清单里的 sha256 不合法，拒绝下载');
    }
    const present = list.some((n) => String(n).toLowerCase() === file.toLowerCase());
    if (!present) {
      return reject('E_ASSET_MISSING', `Release 里找不到 ${file}，清单和发布资产不一致`);
    }
    return { status: 'ok', version, file, size, sha256 };
  }

  /** 老发布没有清单时的兜底：只认本平台类型，且排除别的平台的痕迹 */
  function legacyPick(assets, platform) {
    const exts = allowedExts(platform);
    const list = Array.isArray(assets) ? assets : [];
    for (let i = 0; i < list.length; i += 1) {
      const name = String(list[i]);
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      if (exts.includes(ext) && foreignType(name, platform) === null) return name;
    }
    return null;
  }

  const API = {
    APP_ID,
    PLATFORM,
    MANIFEST_NAME,
    NAME_PREFIX,
    SCHEMA_MAX,
    allowedExts,
    platformLabel,
    compareVer,
    validVersion,
    nameMatches,
    foreignType,
    select,
    legacyPick,
  };

  root.KOFUpd = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
}(typeof globalThis !== 'undefined' ? globalThis : this));
