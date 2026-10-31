/* i18n 体检：node tools/check_i18n.js [--json]
 *
 * 三件事：
 *   1. 找 EN 与 EXTRA 的**键冲突**（同 key 不同值）——EXTRA 在运行时覆盖 EN，
 *      冲突会让某些句子被另一句的译文替换掉（历史上出过 '"不会" → "and never "' 这种）。
 *   2. 扫 ui/app.js 里可见的中文文本，检查词典是否覆盖（英文界面残留中文）。
 *   3. 统计覆盖率，给一个可当 CI 用的退出码（有冲突或缺失 → 退出码 1）。
 *
 * 只统计"用户真的会看到"的文本：模板里的文本节点、title / placeholder / aria-label。
 * 带 ${...} 插值的碎片跳过 —— 它们要在渲染后才成形，静态翻译一定翻错。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const I18N = path.join(ROOT, 'ui', 'i18n.js');
const APP = path.join(ROOT, 'ui', 'app.js');

const src = fs.readFileSync(I18N, 'utf8');

/** 从源码里抠出 `var NAME = { ... };` 的对象字面量并求值 */
function extractObject(name) {
  const re = new RegExp('var\\s+' + name + '\\s*=\\s*\\{');
  const m = re.exec(src);
  if (!m) return null;
  const start = src.indexOf('{', m.index);
  let depth = 0;
  let i = start;
  let inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = src.slice(start, i + 1);
  // eslint-disable-next-line no-eval
  return eval('(' + body + ')');
}

const EN = extractObject('EN') || {};
const EXTRA = extractObject('EXTRA') || {};

const conflicts = [];
for (const k of Object.keys(EXTRA)) {
  if (Object.prototype.hasOwnProperty.call(EN, k) && EN[k] !== EXTRA[k]) {
    conflicts.push({ key: k, en: EN[k], extra: EXTRA[k] });
  }
}

/* ---------- 扫 app.js 的可见中文 ---------- */
const app = fs.readFileSync(APP, 'utf8');
const HAN = /[\u4e00-\u9fa5]/;

const seen = new Map(); // 文本 -> 首次出现的行号

function addText(t, line) {
  const v = t.replace(/\s+/g, ' ').trim();
  if (!v || v.length < 2 || v.length > 80) return;
  if (!HAN.test(v)) return;
  if (v.includes('${')) return;       // 插值碎片，静态翻译不可靠
  // 反引号 / 花括号 / ASCII 引号出现在"文本"里，说明抓到的是模板语法残留
  // （跨行模板被行首正则截断的那种），不是用户会看到的整句
  if (/[`{}'"]/.test(v)) return;
  if (/^[\s\d.,:;%+\-—/()（）]*$/.test(v)) return;
  if (!seen.has(v)) seen.set(v, line);
}

const lines = app.split('\n');
let pendingTemplate = null; // 跨行模板：记起始行
for (let n = 0; n < lines.length; n++) {
  const line = lines[n];

  // 模板里的文本节点：>中文<
  const textRe = />([^<>]*[\u4e00-\u9fa5][^<>]*)</g;
  let m;
  while ((m = textRe.exec(line)) !== null) addText(m[1], n + 1);

  // 属性：title / placeholder / aria-label
  const attrRe = /\b(?:title|placeholder|aria-label)="([^"]*[\u4e00-\u9fa5][^"]*)"/g;
  while ((m = attrRe.exec(line)) !== null) addText(m[1], n + 1);

  // 单引号/反引号包住的整句（toast/confirm 之类），仅当整行就是这一句时收
  const soloRe = /^\s*(?:toast|confirm)\(\s*['`]([^'`]*[\u4e00-\u9fa5][^'`]*)['`]/;
  if ((m = soloRe.exec(line)) !== null) addText(m[1], n + 1);
}

// 用真实的 I18N 判断覆盖：词典 + 正则规则都算
global.self = global;
global.window = global;
require(I18N);
const has = (s) => global.I18N.has(s);
const missing = [];
for (const [text, line] of seen) {
  if (!has(text)) missing.push({ text, line });
}

const total = seen.size;
const covered = total - missing.length;
const pct = total ? ((covered / total) * 100).toFixed(1) : '100.0';

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, covered, pct, conflicts, missing }, null, 2));
} else {
  console.log(`可见中文 ${total} 条，已覆盖 ${covered} 条（${pct}%），缺失 ${missing.length} 条`);
  if (conflicts.length) {
    console.log(`\n键冲突 ${conflicts.length} 处（EXTRA 会覆盖 EN）：`);
    for (const c of conflicts) {
      console.log(`  ${JSON.stringify(c.key)}\n    EN   = ${JSON.stringify(c.en)}\n    EXTRA= ${JSON.stringify(c.extra)}`);
    }
  }
  if (missing.length) {
    console.log(`\n未翻译 ${missing.length} 条（文件:行）：`);
    for (const x of missing) console.log(`  app.js:${x.line}  ${JSON.stringify(x.text)}`);
  }
}

process.exit(conflicts.length || missing.length ? 1 : 0);
