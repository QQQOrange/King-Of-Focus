#!/usr/bin/env node
/**
 * 前后端接线自检（"按钮点了没反应"这一类 bug 的自动化体检）
 *
 * 三件事：
 *  1. `ui/*.js` 里 `invoke('xxx')` 的命令名，必须在 `main.rs` 的
 *     `generate_handler![...]` 里注册过 —— 否则点下去只会在控制台报
 *     "command not found"，界面上毫无反馈。
 *  2. `invoke` 传的键必须和后端函数的形参对得上（Tauri 把 JS 的 camelCase
 *     映射到 Rust 的 snake_case；`app` / `window` / `state` 这类是注入参数，不传）。
 *     多传一个键、少传一个必填键，Tauri 都会直接 reject。
 *  3. `data-act="xxx"` 必须在事件分发器里有对应分支，反之亦然。
 *     前者是"死按钮"，后者是"死代码"。
 *
 * 跑法：`node tools/check_wiring.js`（退出码 0 = 干净）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const rustDir = path.join(root, 'src-tauri', 'src');
const uiDir = path.join(root, 'ui');

const problems = [];
const notes = [];

const snakeToCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/* ------------------------------------------------------------------ Rust */

const rustFiles = fs.readdirSync(rustDir).filter((f) => f.endsWith('.rs'));
const src = {};
for (const f of rustFiles) src[f] = fs.readFileSync(path.join(rustDir, f), 'utf8');

// generate_handler![...] → 注册表
const mainSrc = src['main.rs'] || '';
const handlerBlock = mainSrc.match(/generate_handler!\s*\[([\s\S]*?)\]/);
const registered = new Set();
if (handlerBlock) {
  for (const m of handlerBlock[1].matchAll(/(?:cmds|[a-z_]+)::([a-z0-9_]+)/g)) registered.add(m[1]);
} else {
  problems.push('main.rs 里找不到 generate_handler![...]，无法核对命令注册');
}

/** 把参数列表按顶层逗号切开（忽略 <> () [] 与字符串里的逗号）
 *
 *  注意：Rust 的**生命周期**写作 `'a`、`'_`，所以这里绝不能把单引号当字符串引号，
 *  否则 `State<'_, Arc<Shared>>` 会把后面的参数全部吞进同一个片段，
 *  整条命令的形参就解析成空 —— 这个工具第一版就栽在这里。 */
function splitParams(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === '\\') { cur += s[++i] || ''; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; cur += ch; continue; }
    if ('<([{'.includes(ch)) depth++;
    // 注意 `>` 也要配对：`State<'_, Arc<Shared>>` 只加不减的话，
    // 后面所有逗号都被当成"尖括号里面"，整条命令就解析成一个参数。
    else if (')]}>'.includes(ch) && depth > 0) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** 命令名 → { required:[camel], optional:[camel] } */
const commands = new Map();
for (const [file, text] of Object.entries(src)) {
  const marks = [...text.matchAll(/#\[tauri::command\]/g)].map((m) => m.index);
  for (const at of marks) {
    const rest = text.slice(at, at + 4000);
    const fn = rest.match(/\n\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z0-9_]+)\s*\(/);
    if (!fn) continue;
    const name = fn[1];
    const start = rest.indexOf('(', fn.index + fn[0].length - 1);
    let depth = 0;
    let end = -1;
    for (let i = start; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const params = splitParams(rest.slice(start + 1, end));
    const required = [];
    const optional = [];
    for (const p of params) {
      const m = p.match(/^\s*([a-z0-9_]+)\s*:\s*([\s\S]+)$/);
      if (!m) continue;
      const ident = m[1];
      const ty = m[2];
      // 注入参数：前端不传
      if (/AppHandle|State\s*<|WebviewWindow|Window\s*<|Window$|Emitter/.test(ty)) continue;
      const camel = snakeToCamel(ident);
      if (/^Option\s*</.test(ty.trim())) optional.push(camel);
      else required.push(camel);
    }
    commands.set(name, { file, required, optional });
  }
}

/* --------------------------------------------------------------------- JS */

const jsFiles = fs.readdirSync(uiDir).filter((f) => f.endsWith('.js'));
const uiSrc = {};
for (const f of jsFiles) uiSrc[f] = fs.readFileSync(path.join(uiDir, f), 'utf8');
// 只扫真正会被加载的页面；_harness.html 是测试用的模拟页面
const htmlFiles = fs.readdirSync(uiDir).filter((f) => f.endsWith('.html') && !f.startsWith('_'));
for (const f of htmlFiles) uiSrc[f] = fs.readFileSync(path.join(uiDir, f), 'utf8');

/** 从 `{ ... }` 里取顶层键名（同时支持 `k: v` 与对象简写 `{ id }`） */
function topKeys(text, openIdx) {
  const keys = [];
  const push = (seg) => {
    const t = seg.trim();
    if (!t || t.startsWith('...')) return;
    const m = t.match(/^([A-Za-z0-9_$]+)\s*:/) || t.match(/^([A-Za-z0-9_$]+)\s*$/);
    if (m) keys.push(m[1]);
  };
  let depth = 0;
  let i = openIdx;
  let seg = '';
  let quote = null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      if (depth === 1) { seg = ''; continue; }
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      if (depth === 0) { push(seg); break; }
      continue;
    }
    if (depth === 1) {
      if (ch === ',') { push(seg); seg = ''; continue; }
      seg += ch;
    }
  }
  return keys;
}

const calls = [];
for (const [file, text] of Object.entries(uiSrc)) {
  const re = /invoke\(\s*(['"])([a-z0-9_]+)\1/g;
  for (const m of text.matchAll(re)) {
    const name = m[2];
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i++;
    let keys = [];
    if (text[i] === ',') {
      i++;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === '{') keys = topKeys(text, i);
    }
    const line = text.slice(0, m.index).split('\n').length;
    calls.push({ file, line, name, keys });
  }
}

const invoked = new Set(calls.map((c) => c.name));

for (const c of calls) {
  if (!registered.has(c.name)) {
    problems.push(`${c.file}:${c.line} invoke('${c.name}') —— 后端没有注册这条命令（点下去只会报错）`);
    continue;
  }
  const sig = commands.get(c.name);
  if (!sig) continue;
  const has = new Set(c.keys);
  for (const k of sig.required) {
    if (!has.has(k)) {
      problems.push(
        `${c.file}:${c.line} invoke('${c.name}') 少了必填参数 "${k}"（后端签名：${sig.required.join(', ')}${sig.optional.length ? ' | 可选 ' + sig.optional.join(', ') : ''}）`,
      );
    }
  }
  for (const k of c.keys) {
    if (!sig.required.includes(k) && !sig.optional.includes(k)) {
      problems.push(
        `${c.file}:${c.line} invoke('${c.name}') 传了后端不认识的键 "${k}"（后端只接受：${[...sig.required, ...sig.optional].join(', ') || '无参数'}）`,
      );
    }
  }
}

for (const name of registered) {
  if (!invoked.has(name)) notes.push(`后端命令 "${name}" 没有前端调用（可能是预留入口，确认一下）`);
}

/* ------------------------------------------------------------ data-act */

const actsUsed = new Map(); // act → { where, label }
const actsHandled = new Set();

for (const [file, text] of Object.entries(uiSrc)) {
  const re = /data-act="([a-z0-9-]+)"/g;
  for (const m of text.matchAll(re)) {
    if (actsUsed.has(m[1])) continue;
    // 往前找最近的标签名：<label class="switch" data-act=...> 自带原生开关行为，
    // 不需要分发器分支（点 label 就会切换里面的 checkbox）。
    const before = text.slice(Math.max(0, m.index - 200), m.index);
    const lt = before.lastIndexOf('<');
    const tag = lt >= 0 ? (before.slice(lt + 1).match(/^([a-zA-Z0-9]+)/) || [])[1] : '';
    actsUsed.set(m[1], {
      where: `${file}:${text.slice(0, m.index).split('\n').length}`,
      label: (tag || '').toLowerCase() === 'label',
    });
  }
}

// 前端拆成 app-core / app-views / … 多份之后，分发器分支可能落在任何一个里。
// 这里把所有 ui/*.js 拼起来找——按文件找 app.js 会在拆分那天直接 ENOENT。
const appJs = Object.keys(uiSrc)
  .filter((f) => f.endsWith('.js'))
  .map((f) => uiSrc[f])
  .join('\n');
for (const m of appJs.matchAll(/\bact\s*===\s*'([a-z0-9-]+)'/g)) actsHandled.add(m[1]);
for (const m of appJs.matchAll(/\bact\s*===\s*"([a-z0-9-]+)"/g)) actsHandled.add(m[1]);
// 也认 switch(act) 的 case
for (const m of appJs.matchAll(/case\s+'([a-z0-9-]+)':/g)) actsHandled.add(m[1]);
// 有些控件由专属监听器处理（closest('[data-act="x"]')），不走统一分发器
for (const m of appJs.matchAll(/\[data-act="([a-z0-9-]+)"\]/g)) actsHandled.add(m[1]);

for (const [act, info] of actsUsed) {
  if (actsHandled.has(act)) continue;
  if (info.label) {
    notes.push(`${info.where} data-act="${act}" 挂在 <label> 上，靠原生开关行为生效（不需要分发器分支）`);
  } else {
    problems.push(`${info.where} data-act="${act}" —— 事件分发器里没有对应分支（死按钮）`);
  }
}
for (const act of actsHandled) {
  if (!actsUsed.has(act)) notes.push(`分发器里的分支 "${act}" 没有任何元素触发（死代码）`);
}

/* ------------------------------------------------ 分区重置清单不能各写一份 */

/*
 * `reset.rs` 的 `SECTIONS` 与 `app.js` 的 `RESET_SECTIONS` 是同一份清单的两个副本。
 * 它们分叉时不会报错：
 *   · 后端多一个 → 界面上看不到，等于没做；
 *   · 前端多一个 → 用户点了弹「未知分区」，看着像坏了。
 * 两边都是字符串数组，正确性只能靠断言守住，所以放进这道闸里比。
 */
const resetSrc = src['reset.rs'] || '';
const sectionsBlock = resetSrc.match(/pub const SECTIONS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/);
const rustSections = sectionsBlock
  ? [...sectionsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  : [];
const appSrc = appJs;
const jsBlock = appSrc.match(/const RESET_SECTIONS = \[([\s\S]*?)\n\];/);
const jsSections = jsBlock
  ? [...jsBlock[1].matchAll(/^\s*\['([a-z]+)'/gm)].map((m) => m[1])
  : [];
if (!rustSections.length) {
  problems.push('reset.rs 里找不到 SECTIONS（分区重置清单）');
} else if (!jsSections.length) {
  problems.push('前端 app-*.js 里找不到 RESET_SECTIONS（分区重置清单）');
} else {
  const onlyRust = rustSections.filter((k) => !jsSections.includes(k));
  const onlyJs = jsSections.filter((k) => !rustSections.includes(k));
  for (const k of onlyRust) problems.push(`分区重置："${k}" 后端能重置，但界面上没有这一项`);
  for (const k of onlyJs) problems.push(`分区重置：界面上有 "${k}"，后端不认（点了会报未知分区）`);
  if (rustSections.join() !== jsSections.join()) {
    // 顺序不影响功能，但会导致界面顺序和注释里的"顺序就是界面顺序"对不上
    notes.push(`分区重置顺序与后端不一致：后端 [${rustSections.join(',')}]`);
  }
}

/* ---------------------------------------------------------------- 输出 */

console.log(`命令注册 ${registered.size} 条 · invoke 调用点 ${calls.length} 处 · data-act ${actsUsed.size} 个`);
if (notes.length) {
  console.log('\n提示（不阻断）：');
  for (const n of notes) console.log('  · ' + n);
}
if (problems.length) {
  console.error('\n接线问题：');
  for (const p of problems) console.error('  ✗ ' + p);
  console.error(`\n共 ${problems.length} 处`);
  process.exit(1);
}
console.log('\n✅ 前后端接线一致');
process.exit(0);
