/**
 * 插件端到端测试（无头浏览器 + 假主程序）
 *
 * 跑法：node tools/test_extension_e2e.js
 *
 * 为什么需要它：
 *   matcher/sweep 的单测只证明"判定对"，证明不了"插件真的会这么做"。
 *   这里起一个假的主程序（真的 27315 端口 + 真接口），把仓库里的 extension/
 *   以 unpacked 方式塞进无头 Edge，然后**真的开标签页**，看它会不会被换成拦截页/关掉。
 *
 * 流程（对应真实的一次休息 → 学习）：
 *   1. 休息中：没有生效规则 → 打开两个黑名单站点，标签页应该照常存在
 *   2. 学习开始 + 柔和：插件拉到 sweepSeq 变化 → 标签换成拦截页（带 sweep=1）
 *   3. 再一个边界 + 强制：新开的黑名单标签页应该被关掉
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const EDGE = process.env.KOF_EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const PORT = 27315;   // 假主程序
const SITE = 27316;   // 假"黑名单网站"：本机就能访问，测试不依赖外网/DNS
const CDP = 9501;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function eq(actual, expect, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { pass++; } else { fail++; console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expect)}  实际 ${JSON.stringify(actual)}`); }
}

/* ---------- 假主程序 ---------- */
const STATE = {
  active: false,
  rules: [],
  sweep: { enabled: true, mode: 'soft' },
  sweepSeq: 1,
  clockOn: false,
  clockBreak: true,
  clockLeft: 600,
  nextChange: 0,
  siteCloseBrowser: false,
  lang: 'zh-CN',
};
const REPORTS = [];

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const send = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj));
  };
  if (url === '/api/ping') return send({ ok: true, app: 'King Of Focus' });
  if (url === '/api/state') return send(STATE);
  if (url === '/api/heartbeat') {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => send({ ok: true }));
    return undefined;
  }
  if (url === '/api/report') {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      try { REPORTS.push(JSON.parse(b || '{}')); } catch (e) { REPORTS.push({ raw: b }); }
      send({ ok: true });
    });
    return undefined;
  }
  res.writeHead(404); res.end('{}');
  return undefined;
});

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<html><body><h1>distracting site</h1></body></html>');
});

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await new Promise((r) => site.listen(SITE, '127.0.0.1', r));
  const prof = path.join(os.tmpdir(), 'kof_ext_' + Date.now());
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate',
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--remote-debugging-port=' + CDP, '--user-data-dir=' + prof, 'about:blank',
  ], { stdio: 'ignore' });

  // 等浏览器起来
  let ver = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/version`);
      ver = await r.json();
      if (ver && ver.webSocketDebuggerUrl) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!ver) { console.error('浏览器没起来'); return finish(2); }

  const browser = await connect(ver.webSocketDebuggerUrl);
  // 等 service worker 出现（MV3 起得比页面慢）
  let sw = null;
  for (let i = 0; i < 40; i++) {
    const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((r) => r.json());
    sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
    if (sw) break;
    await sleep(300);
  }
  if (!sw) { console.error('插件的 service worker 没起来'); return finish(2); }
  console.log('插件已加载：', sw.url.slice(0, 60) + '…');

  const w = await connect(sw.webSocketDebuggerUrl);
  await w.send('Runtime.enable');
  const evalIn = async (expr) => {
    const r = await w.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      console.log('  ! 插件内异常', JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    }
    return r.result && r.result.result && r.result.result.value;
  };

  const open = async (url) => {
    const r = await browser.send('Target.createTarget', { url });
    return r.result && r.result.targetId;
  };
  const urlOf = async (id) => {
    const list = await fetch(`http://127.0.0.1:${CDP}/json/list`).then((x) => x.json());
    const t = list.find((x) => x.id === id);
    return t ? t.url : '(已关闭)';
  };

  // ---- 1) 休息中：没有生效规则，黑名单站点能开 ----
  await evalIn('refresh({reason:"test"})');
  await sleep(600);
  const t1 = await open(`http://127.0.0.1:${SITE}/hit-1`);
  const t2 = await open(`http://127.0.0.1:${SITE}/hit-2`);
  await sleep(1200);
  eq(new RegExp(`127\\.0\\.0\\.1:${SITE}`).test(await urlOf(t1)), true, '休息中：黑名单标签没被处理');
  eq(new RegExp(`127\\.0\\.0\\.1:${SITE}`).test(await urlOf(t2)), true, '休息中：第二个标签也没被处理');

  // ---- 2) 学习开始（柔和）：标签换成拦截页，且带 sweep=1 ----
  STATE.active = true;
  STATE.sweepSeq = 2;
  STATE.clockOn = true;
  STATE.clockBreak = false;
  STATE.sweep = { enabled: true, mode: 'soft' };
  STATE.rules = [{ name: '学习时间', mode: 'blacklist', sites: ['127.0.0.1'], exceptions: [] }];
  await evalIn('refresh({reason:"test"})');
  await sleep(4200);   // 每个标签前有 900ms 的通知提前量，两个标签要排队
  const u1 = await urlOf(t1);
  eq(/blocked\.html/.test(u1) && /sweep=1/.test(u1), true, '柔和收尾：标签换成拦截页（带 sweep=1）');
  eq((await urlOf(t2)).includes('blocked.html'), true, '柔和收尾：第二个标签也一样处理');
  eq(REPORTS.length >= 2, true, '收尾时向主程序上报了拦截（' + REPORTS.length + ' 次）');
  eq(REPORTS.every((x) => x.rule === '学习时间'), true, '上报里带着命中的规则名');

  // ---- 3) 再来一次边界（强制）：新开的黑名单标签应该被关掉 ----
  // 先回到"休息"：规则清空，这样新标签能真的打开（否则会被 DNR 直接重定向）
  STATE.active = false;
  STATE.rules = [];
  STATE.clockOn = false;
  STATE.clockBreak = true;
  await evalIn('refresh({reason:"test"})');
  await sleep(500);
  const t3 = await open(`http://127.0.0.1:${SITE}/hit-3`);
  await sleep(700);
  eq(new RegExp(`127\\.0\\.0\\.1:${SITE}`).test(await urlOf(t3)), true, '休息中：第三个标签开得起来');

  // 再进学习（强制）
  STATE.active = true;
  STATE.rules = [{ name: '学习时间', mode: 'blacklist', sites: ['127.0.0.1'], exceptions: [] }];
  STATE.clockOn = true;
  STATE.clockBreak = false;
  STATE.sweepSeq = 3;
  STATE.sweep = { enabled: true, mode: 'hard' };
  await evalIn('refresh({reason:"test"})');
  await sleep(3200);
  const u3 = await urlOf(t3);
  eq(u3 === '(已关闭)' || /chrome-error|blocked\.html/.test(u3), true, '强制收尾：标签被关掉（或被拦成错误页）');

  // ---- 4) 并发刷新不打架（12s 轮询 + 边界定时器 + 弹窗可能同时触发） ----
  await Promise.all([
    evalIn('refresh({reason:"race1"})'),
    evalIn('refresh({reason:"race2"})'),
  ]);
  eq(await evalIn('SWEEP_SEQ'), STATE.sweepSeq, '并发刷新后序号仍与主程序一致');
  eq(await evalIn('SWEEPING'), false, '扫描结束后互斥锁已释放');

  // ---- 5) 插件状态：seq 只增不减，重启清零不当作边界 ----
  const b1 = await evalIn('KOFSweep.boundary(3, 4)');
  const b2 = await evalIn('KOFSweep.boundary(9, 0)');
  eq([b1, b2], [true, false], '边界判定：变大才触发，清零不触发');

  await w.send('Runtime.evaluate', { expression: '1' });
  browser.close();
  w.close();
  proc.kill();
  return finish(fail ? 1 : 0);
}

function finish(code) {
  server.close();
  site.close();
  console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / ${pass + fail}`);
  setTimeout(() => process.exit(code), 100);
  return code;
}

function connect(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pend = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    });
    ws.addEventListener('open', () => resolve({
      send: (method, params = {}) => new Promise((res) => {
        const i = ++id;
        pend.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
      }),
      close: () => ws.close(),
    }));
  });
}

main().catch((e) => { console.error(e); finish(3); });
