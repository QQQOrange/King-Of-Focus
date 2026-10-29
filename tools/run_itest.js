/**
 * UI 交互回归运行器
 *
 * 用法：node tools/run_itest.js
 *
 * 为什么要单独写一个跑批器：
 *   `ui/_harness.html?itest=1` 里的断言是**异步**的（要等 render、等动画帧、
 *   等 saveConfig 落盘），整轮大约 20–30 秒。用 `msedge --dump-dom` 抓，
 *   浏览器在 load 事件后就把 DOM 吐出来了，断言还没跑完，永远抓不到结果。
 *   所以这里用 CDP（远程调试协议）连上去，轮询到 `pre#itest` 出现为止。
 *
 * 前置：Windows 上的 Edge（路径见 EDGE，可用环境变量 KOF_EDGE 覆盖）。
 * 输出：逐条失败的断言；退出码 0 = 全绿。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = process.env.KOF_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const HARNESS = 'file:///' + ROOT.replace(/\\/g, '/') + '/ui/_harness.html?itest=1';
const PORT = +(process.env.KOF_CDP_PORT || 9362);
const prof = path.join(os.tmpdir(), 'kof_itest_' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--window-size=1440,1000',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, HARNESS,
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      list = await r.json();
      if (list.some((t) => t.type === 'page' && t.url.includes('_harness'))) break;
    } catch (e) { /* 还没起来 */ }
  }
  const page = (list || []).find((t) => t.type === 'page' && t.url.includes('_harness'));
  if (!page) {
    console.error('页面没有起来：检查 Edge 路径（KOF_EDGE）');
    proc.kill();
    process.exit(2);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  });
  await Promise.race([new Promise((r) => ws.addEventListener('open', r)), sleep(8000)]);
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('Runtime.enable');

  const expr = `(async () => {
    for (let i = 0; i < 400; i++) {
      const p = document.getElementById('itest');
      if (p) return p.textContent;
      const e = document.getElementById('itest-err') || document.getElementById('boot-err');
      if (e) return 'ERR:' + e.textContent;
      await new Promise(r => setTimeout(r, 250));
    }
    return 'TIMEOUT';
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const val = r.result && r.result.result && r.result.result.value;
  ws.close(); proc.kill();

  if (!val || val === 'TIMEOUT') { console.error('没有结果：用例可能卡住了'); process.exit(2); }
  if (val.startsWith('ERR:')) { console.error('页面内抛异常:\n' + val.slice(4, 2500)); process.exit(2); }

  let rows;
  try { rows = JSON.parse(val); } catch (e) { console.error('结果解析失败', val.slice(0, 400)); process.exit(2); }

  const norm = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v)
    : typeof v === 'string' ? v.trim() : v);
  const bad = [];
  for (const row of rows) {
    if (row.length < 3) continue;          // 两元素的是"仅记录"行
    const [name, got, exp] = row;
    if (norm(got) !== norm(exp)) bad.push([name, got, exp]);
  }
  const total = rows.filter((x) => x.length >= 3).length;
  console.log(`断言 ${total} 条，失败 ${bad.length}`);
  for (const [name, got, exp] of bad) {
    console.log(`  FAIL ${name}\n       实际=${JSON.stringify(got)}\n       期望=${JSON.stringify(exp)}`);
  }
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(3); });
