/* King Of Focus — 浏览器端拦截后台
 *
 * 两道防线，缺一不可：
 *   1) DNR 静态规则：用户「新打开」黑名单网址时，请求还没发出去就被改写成本地拦截页（最快，零延迟）。
 *   2) 主动清理：规则生效那一刻，把「已经开着」的黑名单标签页直接关掉。
 *      —— DNR 管不到已加载的页面，所以第 2 条必须由 JS 定时扫描 + 事件触发来完成。
 *
 * 主程序连不上时会立刻清空规则并停止清理，避免主程序退出后浏览器被永久锁死。
 */

importScripts('matcher.js', 'sweep.js');

const PORTS = [27315, 27316, 27317, 31415, 8065];
const ALARM = 'kof-tick';
const SCAN_MS = 4000;      // 存活期间主动扫描间隔
const PULL_MS = 12000;     // 拉规则的间隔
const MAX_CLOSE_PER_PASS = 30;

let API = null;
let MATCHERS = [];         // 编译后的匹配器（本地判定用）
let RAW_RULES = [];        // 服务端原始规则
let FINGERPRINT = '';      // DNR 只在规则变化时重写
let CLOSING = new Set();   // 正在关闭的标签，防重入
let lastPull = 0;
let lastClosedAt = 0;
let CLOSE_WINDOW = true;   // 网页被拦时，是否连整个浏览器窗口一起关
const NOTIFY_LEAD_MS = 900; // 通知先露脸，再关页面

/* ---- 网页收尾（休息 → 学习）----
 * 主程序在每次「休息结束」时把 sweepSeq +1；插件每轮 /api/state 比对这个号，
 * 变了就说明"边界刚刚发生"，于是自己做一遍标签页收尾：
 *   soft = 换成拦截页（标签留着，休息回来刷新即可）
 *   hard = 关标签（窗口只剩它一个时连窗口关，沿用 siteCloseBrowser）
 * 首次连上只对齐、不扫，避免刚装插件就把用户正在看的页面全收走。 */
let SWEEP_MODE = 'soft';
let SWEEP_ENABLED = true;
let SWEEP_SEQ = null;      // null = 还没对齐过
let BOUNDARY_TIMER = null;

const BROWSER = (() => {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Firefox/')) return 'Firefox';
  return 'Browser';
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 主程序发现 ---------------- */

async function findPort() {
  if (API) return API;
  const saved = (await chrome.storage.local.get('port')).port;
  const list = saved ? [saved, ...PORTS.filter((p) => p !== saved)] : PORTS;
  for (const p of list) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/ping`, { cache: 'no-store' });
      if (r.ok) {
        API = p;
        chrome.storage.local.set({ port: p });
        return p;
      }
    } catch (e) { /* 换下一个端口 */ }
  }
  API = null;
  return null;
}

async function post(path, body) {
  const p = await findPort();
  if (!p) return false;
  try {
    await fetch(`http://127.0.0.1:${p}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return true;
  } catch (e) {
    API = null;
    return false;
  }
}

/* ---------------- DNR：拦新导航 ---------------- */

function condOf(pattern) {
  const raw = String(pattern || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === '*' || raw === '*.*' || raw === '**') {
    return { urlFilter: '*', resourceTypes: ['main_frame'] };
  }
  const bare = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // 主机部分：去掉 query 与结尾斜杠。
  // 用户常常直接粘贴整条网址（https://www.douyin.com/），不归一化的话它会变成
  // "带路径的精确匹配"，裸域 douyin.com 反而拦不住——DNR 与 JS 判定必须一致。
  const core = bare.split('?')[0].replace(/\/+$/, '');
  const hostOnly = (h) => ({
    requestDomains: [h.replace(/^\./, '').replace(/^www\./, '')],
    resourceTypes: ['main_frame'],
  });
  if (core && !core.includes('/')) {
    if (core.slice(0, 2) === '*.') return hostOnly(core.slice(2)); // 含裸域 + 子域
    if (!core.includes('*')) return hostOnly(core);
  }
  const body = bare.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return { regexFilter: body, resourceTypes: ['main_frame'] };
  } catch (e) {
    return null;
  }
}

async function syncDnr(rules) {
  const fp = JSON.stringify(rules);
  if (fp === FINGERPRINT) return false;
  FINGERPRINT = fp;

  const add = [];
  let id = 1;
  for (const r of rules) {
    const isWhite = r.mode === 'whitelist';
    const sites = (r.sites || []).map(condOf).filter(Boolean);
    if (isWhite) {
      if (!sites.length) continue; // 空白名单不生效，避免全站封锁
      add.push({
        id: id++,
        priority: 10,
        action: {
          type: 'redirect',
          redirect: { extensionPath: `/blocked.html?mode=white&rule=${encodeURIComponent(r.name)}` },
        },
        condition: { urlFilter: '*', resourceTypes: ['main_frame'] },
      });
      for (const c of sites) add.push({ id: id++, priority: 30, action: { type: 'allow' }, condition: c });
    } else {
      for (const c of sites) {
        add.push({
          id: id++,
          priority: 20,
          action: {
            type: 'redirect',
            redirect: { extensionPath: `/blocked.html?rule=${encodeURIComponent(r.name)}` },
          },
          condition: c,
        });
      }
      for (const e of r.exceptions || []) {
        const c = condOf(e);
        if (c) add.push({ id: id++, priority: 25, action: { type: 'allow' }, condition: c });
      }
    }
  }

  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map((x) => x.id),
    addRules: add.slice(0, 4000),
  });
  return true;
}

/* ---------------- 主动清理：关掉已打开的违规页面 ---------------- */

async function autoCloseOn() {
  const v = await chrome.storage.local.get('autoClose');
  return v.autoClose !== false; // 默认开
}

function blockUrl(rule, url, extra) {
  const q = `rule=${encodeURIComponent(rule || '')}&u=${encodeURIComponent(url || '')}`
    + (extra || '');
  return chrome.runtime.getURL('blocked.html?' + q);
}

async function closeOne(tab, ruleName, solo) {
  const key = tab.id + '|' + (tab.url || '');
  if (CLOSING.has(key)) return false;
  CLOSING.add(key);
  setTimeout(() => CLOSING.delete(key), 5000);

  // 1) 先让主程序弹通知（它会记一条拦截事件、把主界面拉到前台）
  await post('/api/report', { url: tab.url || '', rule: ruleName });
  // 2) 留出通知卡片的出场时间，再动刀
  await sleep(NOTIFY_LEAD_MS);

  // 3) 关掉：整个浏览器窗口 / 单个标签 / 就地显示拦截页
  try {
    if (CLOSE_WINDOW && tab.windowId != null) {
      await chrome.windows.remove(tab.windowId);
    } else if (solo) {
      await chrome.storage.local.set({ lastUrl: tab.url || '' });
      await chrome.tabs.update(tab.id, { url: blockUrl(ruleName, tab.url) });
    } else {
      await chrome.tabs.remove(tab.id);
    }
  } catch (e) {
    return false; // 标签已经没了
  }

  lastClosedAt = Date.now();
  const today = new Date();
  const k = `closed-${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
  const v = await chrome.storage.local.get(k);
  await chrome.storage.local.set({ [k]: (v[k] || 0) + 1, lastClosed: lastClosedAt });
  return true;
}

/** 扫描全部标签页，关掉命中的；返回关闭数量 */
async function sweep(reason) {
  if (!MATCHERS.length) return 0;
  if (!(await autoCloseOn())) return 0;

  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return 0;
  }

  const perWin = {};
  for (const t of tabs) perWin[t.windowId] = (perWin[t.windowId] || 0) + 1;

  let n = 0;
  for (const t of tabs) {
    if (n >= MAX_CLOSE_PER_PASS) break;
    const url = t.url || t.pendingUrl || '';
    if (!/^https?:/i.test(url)) continue;
    let rule = null;
    try {
      rule = self.KOFMatch.match(url, MATCHERS);
    } catch (e) {
      continue;
    }
    if (!rule) continue;
    if (await closeOne(t, rule, (perWin[t.windowId] || 1) <= 1)) n++;
  }

  if (n) {
    chrome.storage.local.set({ lastReason: reason || '', lastCount: n });
    if (chrome.action && chrome.action.setBadgeText) {
      chrome.action.setBadgeBackgroundColor({ color: '#ff4444' }).catch(() => {});
      chrome.action.setBadgeText({ text: String(n) }).catch(() => {});
      setTimeout(() => { try { chrome.action.setBadgeText({ text: '' }); } catch (e) {} }, 4000);
    }
  }
  return n;
}

/* ---------------- 休息结束收尾（网页侧） ---------------- */

/**
 * 按当前模式处理"已经开着"的黑名单标签页。
 *
 * 与 sweep() 的区别：sweep() 是"学到一半也在每 4 秒清一次"（持续执法），
 * 这里是**边界动作**——只在「休息 → 学习」那一刻做一次，
 * 所以它要尊重收尾模式（柔和就不真关，只换成拦截页）。
 *
 * 仍然受「主动清理」开关约束：用户把自动关闭关掉了，就不该趁机关他标签。
 */
async function webSweep(reason) {
  if (!MATCHERS.length) return 0;
  if (!SWEEP_ENABLED) return 0;
  if (!(await autoCloseOn())) return 0;

  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return 0;
  }
  const actions = self.KOFSweep.plan(
    tabs,
    (u) => self.KOFMatch.match(u, MATCHERS),
    { mode: SWEEP_MODE, closeWindow: CLOSE_WINDOW, max: MAX_CLOSE_PER_PASS },
  );
  const sum = self.KOFSweep.summarize(actions);
  let n = 0;

  for (const a of actions) {
    // 先让主程序记一笔（通知 + 日志），再动手：和主动清理保持同一时序
    await post('/api/report', { url: a.url, rule: a.rule });
    await sleep(NOTIFY_LEAD_MS);
    try {
      if (a.action === 'closeWindow') {
        await chrome.windows.remove(a.windowId);
      } else if (a.action === 'close') {
        await chrome.tabs.remove(a.tabId);
      } else {
        // 柔和：换成拦截页，标签保留（带 u 参数，页面才能显示原地址）
        await chrome.storage.local.set({ lastUrl: a.url });
        await chrome.tabs.update(a.tabId, { url: blockUrl(a.rule, a.url, '&sweep=1') });
      }
      n++;
    } catch (e) {
      /* 标签/窗口已经不在，跳过 */
    }
  }

  if (n) {
    lastClosedAt = Date.now();
    chrome.storage.local.set({
      lastSweepAt: lastClosedAt,
      lastSweepCount: n,
      lastSweepMode: SWEEP_MODE,
      lastSweepReason: reason || '',
      lastSweepBlocked: sum.blocked,
      lastSweepClosed: sum.closed,
    });
    if (chrome.action && chrome.action.setBadgeText) {
      chrome.action.setBadgeBackgroundColor({ color: '#4d8dff' }).catch(() => {});
      chrome.action.setBadgeText({ text: String(n) }).catch(() => {});
      setTimeout(() => { try { chrome.action.setBadgeText({ text: '' }); } catch (e) {} }, 4000);
    }
  }
  return n;
}

/** 在"下一个状态翻转"那一刻立刻重拉一次，别等 12 秒轮询。
 *
 *  为什么重要：休息结束后的那几秒最危险——DNR 规则还是上一拍的（休息=空规则），
 *  用户能照常刷视频。按 nextChange 精确定时后，边界一到就重拉+收尾。
 *  SW 可能在定时器触发前被回收，所以闹钟（30 秒）仍作为兜底。 */
function scheduleBoundary(nextChange) {
  try { clearTimeout(BOUNDARY_TIMER); } catch (e) { /* ignore */ }
  const sec = Number(nextChange || 0);
  if (!isFinite(sec) || sec <= 0) return;
  // 夹在 1s–10min：太近立刻做，太远就分几次（避免超长定时器被回收）
  const wait = Math.min(Math.max(sec * 1000 + 600, 1000), 10 * 60 * 1000);
  BOUNDARY_TIMER = setTimeout(() => { refresh({ reason: 'boundary' }); }, wait);
}

/** 单个标签页变化时立刻处理（比等扫描快，覆盖 DNR 漏掉的场景） */async function checkTab(tabId, url) {
  if (!MATCHERS.length) return;
  if (!/^https?:/i.test(url || '')) return;
  if (!(await autoCloseOn())) return;
  let rule = null;
  try {
    rule = self.KOFMatch.match(url, MATCHERS);
  } catch (e) {
    return;
  }
  if (!rule) return;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return;
  }
  const sameWin = await chrome.tabs.query({ windowId: tab.windowId });
  await closeOne(tab, rule, sameWin.length <= 1);
}

/* ---------------- 心跳与状态 ---------------- */

async function currentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return null;
    const url = tab.url || '';
    if (!/^https?:/i.test(url)) return null;
    return { url, title: tab.title || '' };
  } catch (e) {
    return null;
  }
}

async function beat() {
  const p = await findPort();
  if (!p) return false;
  const tab = await currentTab();
  try {
    await fetch(`http://127.0.0.1:${p}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        browser: BROWSER,
        url: tab ? tab.url : '',
        title: tab ? tab.title : '',
      }),
    });
    // 拦截页的"目标地址"靠它兜底：DNR 重定向拿不到原 URL，referrer 也常为空
    if (tab && tab.url) chrome.storage.local.set({ lastUrl: tab.url });
    return true;
  } catch (e) {
    API = null;
    return false;
  }
}

/** 拉规则 → 更新 DNR → 立刻扫一遍已打开的标签页 */
async function refresh(opts) {
  lastPull = Date.now();
  const p = await findPort();
  if (!p) {
    MATCHERS = [];
    RAW_RULES = [];
    FINGERPRINT = '';
    SWEEP_SEQ = null;   // 断连后重新连上要重新对齐，不能把"重连"当成边界
    await applyEmptyDnr();
    chrome.storage.local.set({ connected: false, active: false, ruleCount: 0, activeRules: [], sweepEnabled: false });
    return { closed: 0 };
  }

  let state;
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/state`, { cache: 'no-store' });
    state = await r.json();
  } catch (e) {
    API = null;
    MATCHERS = [];
    RAW_RULES = [];
    FINGERPRINT = '';
    SWEEP_SEQ = null;   // 断连后重新连上要重新对齐，不能把"重连"当成边界
    await applyEmptyDnr();
    chrome.storage.local.set({ connected: false, active: false, ruleCount: 0, activeRules: [], sweepEnabled: false });
    return { closed: 0 };
  }

  RAW_RULES = (state && state.rules) || [];
  // 语言跟着主程序走：弹窗与拦截页打开时读这个值
  const LANG = (state && state.lang) === 'en' ? 'en' : 'zh-CN';
  MATCHERS = self.KOFMatch.compile(RAW_RULES);
  CLOSE_WINDOW = state.siteCloseBrowser !== false;
  // 收尾契约：enabled/mode/sweepSeq/nextChange/clockLeft
  const sw = (state && state.sweep) || {};
  SWEEP_ENABLED = sw.enabled !== false;
  SWEEP_MODE = sw.mode === 'hard' ? 'hard' : 'soft';
  const seq = Number((state && state.sweepSeq) || 0);
  // 首次连上只对齐、不扫（SWEEP_SEQ 为 null 时 boundary 返回 false）：
  // 否则刚装插件就会把用户正开着的页面全收走。
  // 判定放进纯函数：seq 变小 = 主程序重启过（计数清零），只当重新对齐。
  const boundary = self.KOFSweep.boundary(SWEEP_SEQ, seq);
  SWEEP_SEQ = seq;
  await syncDnr(RAW_RULES);
  chrome.storage.local.set({
    connected: true,
    lang: LANG,
    active: !!state.active,
    ruleCount: RAW_RULES.length,
    activeRules: RAW_RULES.map((r) => ({
      name: r.name,
      mode: r.mode,
      sites: (r.sites || []).length,
    })),
    // 拦截页 / 弹窗要用的运行态
    clockOn: !!(state && state.clockOn),
    clockBreak: !!(state && state.clockBreak),
    clockLeft: Number((state && state.clockLeft) || 0),
    sweepEnabled: SWEEP_ENABLED,
    sweepMode: SWEEP_MODE,
    sweepSeq: seq,
    nextChange: Number((state && state.nextChange) || 0),
    lastSync: Date.now(),
  });
  scheduleBoundary(state && state.nextChange);
  await beat();
  // 边界那一刻：先做网页收尾（柔和=换拦截页 / 强制=关），再做一轮常规清理。
  // 顺序不能反：常规清理走的是"直接关"，会把柔和模式该保留的标签也关掉。
  let swept = 0;
  if (boundary) swept = await webSweep('boundary');
  const closed = await sweep(opts && opts.reason ? opts.reason : 'refresh');
  return { closed, swept };
}

async function applyEmptyDnr() {
  try {
    const old = await chrome.declarativeNetRequest.getDynamicRules();
    if (old.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: old.map((x) => x.id),
        addRules: [],
      });
    }
  } catch (e) { /* ignore */ }
}

/* ---------------- 定时器 ---------------- */

function startTimers() {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  try {
    clearInterval(globalThis.__kofScan);
    clearInterval(globalThis.__kofPull);
    globalThis.__kofScan = setInterval(() => { sweep('timer'); }, SCAN_MS);
    globalThis.__kofPull = setInterval(() => { refresh({ reason: 'timer' }); }, PULL_MS);
  } catch (e) { /* SW 即将休眠 */ }
}

chrome.runtime.onInstalled.addListener(() => {
  startTimers();
  refresh({ reason: 'install' });
});
chrome.runtime.onStartup.addListener(() => {
  startTimers();
  refresh({ reason: 'startup' });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  // 闹钟醒来后补一次；若规则已很久没更新则重新拉取
  if (Date.now() - lastPull > PULL_MS) refresh({ reason: 'alarm' });
  else sweep('alarm');
});

/* 切标签、页面地址变化、窗口切换 —— 立刻检查，不等定时器 */
chrome.tabs.onActivated.addListener(() => { beat(); });
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url) checkTab(id, info.url);
  if (info.status === 'complete') {
    beat();
    if (tab && tab.url) checkTab(id, tab.url);
  }
});
chrome.windows.onFocusChanged.addListener(() => { beat(); });

/* 新开标签时也看一眼 */
chrome.tabs.onCreated.addListener((tab) => {
  if (tab && tab.id != null && tab.url) checkTab(tab.id, tab.url);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return false;

  if (msg.type === 'report') {
    // 拦截页上报：先让主程序弹通知，稍等再把页面/浏览器关掉
    const tabId = sender && sender.tab ? sender.tab.id : null;
    const winId = sender && sender.tab ? sender.tab.windowId : null;
    post('/api/report', { url: msg.url || '', rule: msg.rule || '' }).then(async () => {
      if (tabId == null) return;
      const key = 'nav' + tabId;
      if (CLOSING.has(key)) return;
      CLOSING.add(key);
      setTimeout(() => CLOSING.delete(key), 8000);
      await sleep(NOTIFY_LEAD_MS);
      try {
        if (CLOSE_WINDOW && winId != null) await chrome.windows.remove(winId);
        else await chrome.tabs.remove(tabId);
      } catch (e) { /* 已经关了 */ }
    });
    reply({ ok: true });
    return true;
  }
  if (msg.type === 'refresh') {
    refresh({ reason: 'manual' }).then((r) => reply({ ok: true, closed: r.closed }));
    return true;
  }
  if (msg.type === 'status') {
    chrome.storage.local.get(null).then((v) => reply(v));
    return true;
  }
  if (msg.type === 'sweep') {
    sweep('manual').then((n) => reply({ ok: true, closed: n }));
    return true;
  }
  if (msg.type === 'sweepWeb') {
    // 手动"现在收尾"：弹窗里的按钮，按当前模式处理已打开的标签页
    webSweep('manual').then((n) => reply({ ok: true, swept: n }));
    return true;
  }
  if (msg.type === 'setAutoClose') {
    chrome.storage.local.set({ autoClose: !!msg.value }).then(async () => {
      const closed = msg.value ? await sweep('enable') : 0;
      reply({ ok: true, closed });
    });
    return true;
  }
  return false;
});

/* Service worker 启动就跑一遍 */
startTimers();
refresh({ reason: 'boot' });
