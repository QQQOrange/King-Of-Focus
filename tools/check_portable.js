#!/usr/bin/env node
/**
 * 跨设备备份格式的自检（两端同一套逻辑的第三只眼睛）
 *
 * 单位测试只能证明"自己写的能读自己写的"。这个脚本检查的是**两端之间**的东西：
 *
 *  1. `KOF` / `FORMAT` / `SCHEMA` 三个常量在桌面端（Rust）与手机端（Kotlin）
 *     源码里逐字相同 —— 这三个字面值一旦分叉，认标记那一步就直接把对方的
 *     文件当成"别人的 JSON"拒掉，用户看到的是"这不是 King Of Focus 的备份"。
 *  2. `tools/fixtures/portable-shape.txt` 确实是 `portable-canon.json` 的字段签名
 *     （这里用 JS 再算一遍：Rust 生成、JS 复核，错的概率极低）。
 *  3. 所有样例都是合法文档：顶层标记、版本、键的类型都对，规则对象用的是
 *     同一套字段（`portable-canon.json` 是基准）。
 *
 * 跑法：`node tools/check_portable.js`（发版前与 `check_i18n.js` 一起跑）
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fx = path.join(root, 'tools', 'fixtures');
const fails = [];
const notes = [];

function fail(msg) {
  fails.push(msg);
}

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    fail(`读不到 ${p}`);
    return '';
  }
}

// ---------------------------------------------------------------- 1. 常量

const rust = read(path.join(root, 'src-tauri', 'src', 'portable.rs'));
const kot = read(
  path.join(
    root,
    'android',
    'app',
    'src',
    'main',
    'java',
    'com',
    'qqqorange',
    'kingoffocus',
    'data',
    'Portable.kt',
  ),
);

function rustConst(name) {
  const m = rust.match(new RegExp(`pub const ${name}\\s*:\\s*&str\\s*=\\s*"([^"]+)"`));
  if (!m) {
    const n = rust.match(new RegExp(`pub const ${name}\\s*:\\s*u32\\s*=\\s*(\\d+)`));
    return n ? n[1] : null;
  }
  return m[1];
}

function kotConst(name) {
  const m = kot.match(new RegExp(`const val ${name}\\s*(?::\\s*\\w+)?\\s*=\\s*(?:"([^"]+)"|(\\d+))`));
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

// Rust 那边叫 KOF_MARK（避免和别的常量撞名），Kotlin 叫 KOF
const PAIRS = [
  ['KOF', 'KOF_MARK'],
  ['FORMAT', 'FORMAT'],
  ['SCHEMA', 'SCHEMA'],
];

for (const [kotName, rustName] of PAIRS) {
  const a = rustConst(rustName);
  const b = kotConst(kotName);
  if (a === null) fail(`src-tauri/src/portable.rs 里找不到 ${rustName}`);
  if (b === null) fail(`Portable.kt 里找不到 ${kotName}`);
  if (a !== null && b !== null && a !== b) {
    fail(`${kotName} 两端不一致：桌面 "${a}" / 手机 "${b}"`);
  }
  if (a !== null && b !== null && a === b) notes.push(`${kotName} = ${a}（两端一致）`);
}

// ---------------------------------------------------------------- 2. 字段签名

/** 与 Rust `portable::shape` / Kotlin `Portable.shape` 逐字对应的实现 */
function shape(v) {
  const out = new Set();
  const typeOf = (x) => {
    if (x === null) return 'null';
    if (Array.isArray(x)) return 'array';
    switch (typeof x) {
      case 'boolean':
        return 'bool';
      case 'number':
        return 'number';
      case 'string':
        return 'string';
      default:
        return 'object';
    }
  };
  const walk = (x, p) => {
    if (Array.isArray(x)) {
      out.add(`${p}[]`);
      for (const item of x) {
        if (item !== null && typeof item === 'object') walk(item, `${p}[]`);
        else out.add(`${p}[]:${typeOf(item)}`);
      }
      return;
    }
    if (x !== null && typeof x === 'object') {
      for (const k of Object.keys(x)) walk(x[k], p ? `${p}.${k}` : k);
      return;
    }
    out.add(`${p}:${typeOf(x)}`);
  };
  walk(v, '');
  return [...out].sort().join('\n');
}

const canonPath = path.join(fx, 'portable-canon.json');
const shapePath = path.join(fx, 'portable-shape.txt');
let canon = null;
try {
  canon = JSON.parse(read(canonPath));
} catch (e) {
  fail('portable-canon.json 不是合法 JSON');
}

if (canon) {
  const want = read(shapePath).trim();
  const got = shape(canon);
  if (want === 'placeholder') {
    fail('portable-shape.txt 还是占位内容：跑 cargo test __gen_canon_fixture -- --ignored');
  } else if (want !== got) {
    const w = new Set(want.split('\n'));
    const g = new Set(got.split('\n'));
    const miss = [...w].filter((x) => !g.has(x));
    const extra = [...g].filter((x) => !w.has(x));
    fail(
      `portable-shape.txt 与 portable-canon.json 对不上（少 ${miss.length} 行 / 多 ${extra.length} 行）` +
        (miss.length ? `\n      少：${miss.slice(0, 5).join(', ')}` : '') +
        (extra.length ? `\n      多：${extra.slice(0, 5).join(', ')}` : ''),
    );
  } else {
    notes.push(`字段签名 ${got.split('\n').length} 行，与 canon 一致`);
  }
}

// ---------------------------------------------------------------- 3. 样例

const TOP = new Set([
  'kof',
  'format',
  'schema',
  'createdAt',
  'source',
  'device',
  'appVersion',
  'rules',
  'clock',
  'points',
  'settings',
  'stats',
]);

/** 规则的标准字段集合（以 canon 为准；老样例允许缺，不允许乱加） */
const RULE_KEYS = canon && canon.rules && canon.rules[0] ? Object.keys(canon.rules[0]) : [];
const SHARED_RULE = new Set(['id', 'name', 'enabled', 'mode', 'hard', 'apps', 'sites', 'exceptions']);

for (const f of fs.readdirSync(fx).filter((x) => x.endsWith('.json'))) {
  const p = path.join(fx, f);
  let v;
  try {
    v = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`${f}: 不是合法 JSON`);
    continue;
  }
  // 加密信封不是文档，跳过
  if (v && typeof v === 'object' && 'kofEnc' in v) {
    if (v.kofEnc !== 3) notes.push(`${f}: 旧信封 kofEnc=${v.kofEnc}（只读）`);
    else if (!v.iter || !v.salt || !v.nonce || !v.data) fail(`${f}: kofEnc:3 缺字段`);
    continue;
  }
  if (v.kof !== 'king-of-focus') {
    fail(`${f}: kof 标记不对`);
    continue;
  }
  if (v.format !== 'kof-portable') fail(`${f}: format 不是 kof-portable`);
  if (v.schema > 1) fail(`${f}: schema=${v.schema} 超出了当前实现`);
  for (const k of Object.keys(v)) {
    if (!TOP.has(k)) fail(`${f}: 顶层出现未定义的键 "${k}"`);
  }
  for (const k of ['rules', 'clock', 'points', 'settings']) {
    if (!(k in v)) fail(`${f}: 缺 ${k}`);
  }
  const rules = Array.isArray(v.rules) ? v.rules : [];
  const isCanon = f === 'portable-canon.json';
  for (const [i, r] of rules.entries()) {
    for (const k of Object.keys(r)) {
      if (!RULE_KEYS.includes(k)) fail(`${f}: rules[${i}] 出现未定义的键 "${k}"`);
    }
    // 老样例（升级前导出的）允许缺键——读取端必须用默认值兜住；
    // 但"我们现在的输出"必须一个键都不少，所以只对 canon 严格。
    if (!isCanon) continue;
    for (const k of SHARED_RULE) {
      if (!(k in r)) fail(`${f}: rules[${i}] 缺 ${k}`);
    }
  }
  const clock = v.clock || {};
  if (!Array.isArray(clock.profiles)) fail(`${f}: clock.profiles 必须是数组`);
}

if (!fails.length) {
  for (const n of notes) console.log('  · ' + n);
  console.log(`跨设备备份格式自检通过（样例 ${fs.readdirSync(fx).filter((x) => x.endsWith('.json')).length} 个）`);
  process.exit(0);
}

console.error('跨设备备份格式自检失败：');
for (const f of fails) console.error('  ✗ ' + f);
process.exit(1);
