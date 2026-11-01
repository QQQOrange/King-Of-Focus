/* 跨端常量一致性检查：默认 WebDAV 地址
 *
 *   node tools/check_dav_url.js
 *
 * 为什么要有这个脚本：默认地址必须**两端逐字相同**，否则用户在两台机器上
 * 「什么都不填」会落到两个不同目录 —— 各自都能同步，但永远看不到对方那份，
 * 表现就是"云同步好像没用"。这类问题在界面和日志里都看不出来，
 * 只能靠"把两个源文件里的常量抠出来比一比"。
 *
 * 检查三件事：
 *   1. PC  `src-tauri/src/model.rs` 的 DEFAULT_SYNC_URL
 *   2. 手机 `android/.../data/CloudSync.kt` 的 DEFAULT_URL
 *   3. 两者相等，且是 https、以 / 结尾、没有空格
 *
 * 退出码 1 = 不一致（可当 CI 用）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PC = path.join(ROOT, 'src-tauri', 'src', 'model.rs');
const ANDROID = path.join(
  ROOT,
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'qqqorange',
  'kingoffocus',
  'data',
  'CloudSync.kt',
);
const UI = path.join(ROOT, 'ui', 'app.js');

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

/** 从源码里抠出某个常量的字符串值（两种语言的写法都覆盖） */
function grab(src, patterns) {
  for (const re of patterns) {
    const m = re.exec(src);
    if (m) return m[1];
  }
  return null;
}

const pcSrc = readText(PC);
const rmSrc = readText(ANDROID);

let bad = 0;
const fail = (msg) => {
  console.error('  ✗ ' + msg);
  bad += 1;
};
const ok = (msg) => console.log('  ✓ ' + msg);

const pc = pcSrc
  ? grab(pcSrc, [/pub const DEFAULT_SYNC_URL: &str = "([^"]*)"/])
  : null;
const android = rmSrc ? grab(rmSrc, [/const val DEFAULT_URL = "([^"]*)"/]) : null;

console.log('默认 WebDAV 地址检查');
if (pc === null) fail('PC 端找不到 DEFAULT_SYNC_URL（src-tauri/src/model.rs）');
if (android === null) fail('手机端找不到 DEFAULT_URL（data/CloudSync.kt）');

if (pc !== null && android !== null) {
  console.log('  PC     ' + pc);
  console.log('  手机   ' + android);
  if (pc === android) ok('两端常量完全一致');
  else fail('两端常量不一致（用户"不填地址"会落到两个不同目录）');

  const url = pc;
  if (!/^https:\/\//.test(url)) fail('默认地址必须是 https（WebDAV 传的是账号密码）');
  else ok('协议是 https');
  if (!url.endsWith('/')) fail('默认地址必须以 / 结尾（拼文件名靠它）');
  else ok('以 / 结尾');
  if (/\s/.test(url)) fail('默认地址里不能有空白');
  else ok('没有空白字符');
}

// 前端不应该再抄一份默认值：抄了就会漂
const uiSrc = readText(UI);
if (uiSrc) {
  const hits = (uiSrc.match(/dav\.jianguoyun\.com\/dav\/KingOfFocus/g) || []).length;
  if (hits === 0) {
    ok('ui/app.js 里没有第二处硬编码（从后端读实际值）');
  } else {
    // 说明文字里出现一次是可接受的（告诉用户默认是什么），参与逻辑的才算问题
    console.log(`  · ui/app.js 里出现 ${hits} 次默认地址（仅作说明文字可以，别用来做判断）`);
  }
}

if (bad > 0) {
  console.error(`\n失败 ${bad} 项`);
  process.exit(1);
}
console.log('\n全部通过');
