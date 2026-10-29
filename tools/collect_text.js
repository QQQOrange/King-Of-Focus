/* 采集 harness 实际渲染出的中文文案（用于生成 i18n 词典）。
 * 用法：node tools/collect_text.js > /tmp/texts.json
 *
 * 为什么要采集"渲染结果"而不是源码字面量：
 *   源码里 1000+ 条中文字面量大多是模板碎片（`共 ${n} 分钟` 这类），
 *   直接翻译碎片既翻不准也对不上；渲染后的文本才是用户真正看到的那一句。
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const URL_ = 'file:///' + path.join(ROOT, 'ui', '_harness.html').replace(/\\/g, '/');
const PORT = 9411;
const PROF = path.join(os.tmpdir(), 'kof_collect_' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROF}`, URL_,
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (list.some((t) => t.type === 'page' && t.url.includes('_harness'))) break;
    } catch (e) { /* 还没起来 */ }
  }
  const page = (list || []).find((t) => t.type === 'page' && t.url.includes('_harness'));
  if (!page) { console.error('页面没起来'); proc.kill(); process.exit(2); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable');

  // 等 harness 初始化（它自己会把 STATE 铺好）
  const expr = `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 80; i++) { if (window.STATE && window.render) break; await wait(200); }
    const out = new Set();
    const add = (t) => {
      if (!t) return;
      const s = String(t).replace(/\\s+/g, ' ').trim();
      if (!s || !/[\\u4e00-\\u9fa5]/.test(s)) return;
      if (s.length > 300) return;   // 超长说明整段，单独处理
      out.add(s);
    };
    const grab = (root) => {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        const p = n.parentElement;
        if (!p) continue;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') continue;
        add(n.textContent);
      }
      root.querySelectorAll('*').forEach((el) => {
        ['title', 'placeholder', 'aria-label', 'data-hint'].forEach((a) => {
          const v = el.getAttribute && el.getAttribute(a);
          if (v) add(v);
        });
        if (el.tagName === 'INPUT') add(el.value);
      });
    };

    const views = ['overview', 'clock', 'rules', 'mask', 'browsers', 'stats', 'reports', 'sync', 'settings', 'help'];
    for (const v of views) {
      try { await Act.nav(v); await wait(420); } catch (e) { }
      grab(document.body);
    }

    // 弹窗与浮层：能开就开一遍，采完关掉
    const openers = [
      ['quote-manage', 'overview'], ['new-rule', 'rules'], ['cc-open', 'clock'],
      ['report-export-open', 'reports'],
    ];
    for (const [act, v] of openers) {
      try {
        await Act.nav(v); await wait(320);
        const btn = document.querySelector('[data-act="' + act + '"]');
        if (btn) { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })); await wait(400); grab(document.body); }
      } catch (e) { }
      try { closeModal(); } catch (e) { }
      await wait(150);
    }
    return JSON.stringify([...out].sort());
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  ws.close();
  proc.kill();
  const val = r.result && r.result.result && r.result.result.value;
  if (!val) { console.error('无结果', JSON.stringify(r.result && r.result.result).slice(0, 400)); process.exit(2); }
  console.log(val);
})().catch((e) => { console.error(e); process.exit(3); });
