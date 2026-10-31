/* 更新校验单测：node tools/test_update.js
 *
 * 这些断言防的是**跨平台错配**：插件装了桌面 exe、或者发布脚本把版本号写错
 * 导致"永远没有更新"。每条都对应 docs/update-channels.md 里的一个错误码。
 */
const U = require('../extension/update.js');

let pass = 0;
let fail = 0;
function eq(actual, expect, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expect)}  实际 ${JSON.stringify(actual)}`);
  }
}

function manifest(opt) {
  const o = Object.assign({
    platform: 'chrome-extension',
    version: '9.9.9',
    file: 'King.Of.Focus-9.9.9-chrome-extension.zip',
    size: 12345,
    sha: 'a'.repeat(64),
    app: 'king-of-focus',
    schema: 1,
  }, opt || {});
  const m = {
    app: o.app,
    schema: o.schema,
    tag: 'v' + o.version,
    platforms: {},
  };
  m.platforms[o.platform] = {
    version: o.version,
    kind: 'extension',
    file: o.file,
    size: o.size,
    sha256: o.sha,
  };
  return m;
}

const PLAT = 'chrome-extension';
const okAsset = ['King.Of.Focus-9.9.9-chrome-extension.zip'];

// ---- 正常路径 ----
const good = U.select(manifest(), PLAT, '1.1.0', okAsset);
eq(good.status, 'ok', '正常清单能选中');
eq(good.version, '9.9.9', '选中版本取自清单');
eq(good.file, okAsset[0], '选中的文件就是清单里写的那一个');
eq(good.sha256.length, 64, 'sha256 一起带出来');

// ---- 平台隔离 ----
eq(
  U.select(manifest({ platform: 'android', file: 'King.Of.Focus-9.9.9-android.apk' }), PLAT, '1.1.0',
    ['King.Of.Focus-9.9.9-android.apk']).code,
  'E_PLATFORM_MISSING',
  '清单里只有安卓条目时，插件必须拒绝而不是找别的包',
);

const wrongType = U.select(
  manifest({ file: 'King.Of.Focus-9.9.9-chrome-extension.exe' }),
  PLAT, '1.1.0', ['King.Of.Focus-9.9.9-chrome-extension.exe'],
);
eq(
  wrongType.code === 'E_NAME_MISMATCH' || wrongType.code === 'E_TYPE_MISMATCH',
  true,
  '写在插件条目里的 exe 必须被拒（错误码 ' + wrongType.code + '）',
);

// ---- 名字与版本/平台一致性 ----
eq(
  U.select(manifest({ file: 'King.Of.Focus-9.9.8-chrome-extension.zip' }), PLAT, '1.1.0',
    ['King.Of.Focus-9.9.8-chrome-extension.zip']).code,
  'E_NAME_MISMATCH',
  '包名版本与清单版本不一致必须拒绝',
);
eq(
  U.select(manifest({ file: 'King.Of.Focus-9.9.9-windows-x64.zip' }), PLAT, '1.1.0',
    ['King.Of.Focus-9.9.9-windows-x64.zip']).code,
  'E_NAME_MISMATCH',
  '包名平台与清单平台不一致必须拒绝',
);
eq(
  U.select(manifest(), PLAT, '1.1.0', ['King.Of.Focus-9.9.9-chrome-extension.crx']).code,
  'E_ASSET_MISSING',
  '清单里的文件不在 Release 里时不能拿相近的顶替',
);

// ---- 版本比较 ----
eq(U.select(manifest({ version: '1.1.0', file: 'King.Of.Focus-1.1.0-chrome-extension.zip' }),
  PLAT, '1.1.0', ['King.Of.Focus-1.1.0-chrome-extension.zip']).status, 'none', '同版本不算更新');
eq(U.compareVer('0.10.0', '0.9.0'), 1, '版本按数字比，不是按字符串');
eq(U.compareVer('1.2', '1.2.0'), 0, '缺的段按 0 补');
eq(U.validVersion('1.1.0'), true, 'x.y.z 合法');
eq(U.validVersion('1.1'), false, '两段不算合法版本');
eq(U.validVersion('1.1.0-beta'), false, '预发布串不参与比较');

// ---- 清单本身坏了 ----
eq(U.select(manifest({ app: 'other' }), PLAT, '1.1.0', okAsset).code, 'E_BAD_APP', '不是本项目的清单');
eq(U.select(manifest({ schema: 9 }), PLAT, '1.1.0', okAsset).code, 'E_BAD_SCHEMA', '读不懂的 schema');
eq(U.select(null, PLAT, '1.1.0', okAsset).code, 'E_BAD_MANIFEST', '空清单');
eq(U.select(manifest({ sha: 'zz' }), PLAT, '1.1.0', okAsset).code, 'E_BAD_HASH', 'sha256 不合法');
eq(U.select(manifest({ size: 0 }), PLAT, '1.1.0', okAsset).code, 'E_BAD_SIZE', '没写大小');

// ---- 老发布兜底：只认自己的类型 ----
eq(
  U.legacyPick([
    'King.Of.Focus-0.1.52.exe',
    'King.Of.Focus-0.2.1-android.apk',
    'King.Of.Focus-1.1.1-chrome-extension.zip',
  ], PLAT),
  'King.Of.Focus-1.1.1-chrome-extension.zip',
  '兜底时跳过 exe 与 apk',
);
eq(
  U.legacyPick(['King.Of.Focus-0.1.52.exe', 'King.Of.Focus-0.2.1-android.apk'], PLAT),
  null,
  '没有插件包时宁可返回 null，也不能拿 exe 充数',
);
eq(
  U.legacyPick(['King.Of.Focus-Extension-1.1.0.zip'], PLAT),
  'King.Of.Focus-Extension-1.1.0.zip',
  '老命名（King.Of.Focus-Extension-x.y.z.zip）仍能识别',
);

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
