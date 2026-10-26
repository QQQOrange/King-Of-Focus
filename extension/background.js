/* King of Focus — 后台服务
 * 职责：1) 找到本机主程序的端口  2) 拉取生效规则并翻译成 DNR 规则  3) 上报标签页与心跳
 */

const PORTS = [27315, 27316, 27317, 31415, 8065];
const ALARM = 'kof-tick';
let API = null;

const BROWSER = (() => {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Firefox/')) return 'Firefox';
  return 'Browser';
})();

async function findPort() {
  if (API) return API;
  const saved = (await chrome.storage.local.get('port')).port;
  const list = saved ? [saved, ...PORTS] : PORTS;
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

function globToRegex(p) {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const needsHost = !/^https?:/i.test(p) && !p.startsWith('*');
  return '^' + (needsHost ? 'https?://([^/]*\\.)?' : '') + esc;
}

function condOf(pattern) {
  const p = String(pattern || '').trim();
  if (!p) return null;
  if (p === '*' || p === '*.*' || p === '**') {
    return { urlFilter: '*', resourceTypes: ['main_frame'] };
  }
  const bare = p.replace(/^https?:\/\//i, '');
  if (!bare.includes('/') && !bare.includes('*')) {
    return {
      requestDomains: [bare.replace(/^\*\./, '').replace(/^\./, '').toLowerCase()],
      resourceTypes: ['main_frame'],
    };
  }
  return { regexFilter: globToRegex(bare), resourceTypes: ['main_frame'] };
}

async function applyRules(state) {
  let add = [];
  let id = 1;
  const rules = (state && state.rules) || [];

  for (const r of rules) {
    const isWhite = r.mode === 'whitelist';
    if (isWhite) {
      // 强制模式：先全拦
      add.push({
        id: id++,
        priority: 1,
        action: { type: 'redirect', redirect: { extensionPath: `/blocked.html?rule=${encodeURIComponent(r.name)}&mode=white` } },
        condition: { urlFilter: '*', resourceTypes: ['main_frame'] },
      });
      for (const s of r.sites || []) {
        const c = condOf(s);
        if (c) add.push({ id: id++, priority: 4, action: { type: 'allow' }, condition: c });
      }
    } else {
      for (const s of r.sites || []) {
        const c = condOf(s);
        if (c) {
          add.push({
            id: id++,
            priority: 2,
            action: { type: 'redirect', redirect: { extensionPath: `/blocked.html?rule=${encodeURIComponent(r.name)}` } },
            condition: c,
          });
        }
      }
      for (const e of r.exceptions || []) {
        const c = condOf(e);
        if (c) add.push({ id: id++, priority: 3, action: { type: 'allow' }, condition: c });
      }
    }
  }

  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map((x) => x.id),
    addRules: add.slice(0, 4000),
  });
  chrome.storage.local.set({
    lastSync: Date.now(),
    ruleCount: add.length,
    activeRules: rules.map((r) => ({ name: r.name, mode: r.mode, sites: (r.sites || []).length })),
  });
}

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
    return true;
  } catch (e) {
    API = null;
    return false;
  }
}

async function refresh() {
  const p = await findPort();
  if (!p) {
    await applyRules({ rules: [] });
    chrome.storage.local.set({ connected: false });
    return;
  }
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/state`, { cache: 'no-store' });
    const state = await r.json();
    await applyRules(state);
    chrome.storage.local.set({ connected: true, active: !!state.active });
    await beat();
  } catch (e) {
    chrome.storage.local.set({ connected: false });
    API = null;
  }
}

/* 事件 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  refresh();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  refresh();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) {
    chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    refresh();
  }
});

/* 切标签 / 页面变化立刻上报，保证网站时长统计准确 */
chrome.tabs.onActivated.addListener(() => { beat(); });
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'complete' || info.url) { beat(); }
});
chrome.windows.onFocusChanged.addListener(() => { beat(); });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'report') {
    findPort().then((p) => {
      if (!p) return;
      fetch(`http://127.0.0.1:${p}/api/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: msg.url || '', rule: msg.rule || '' }),
      }).catch(() => {});
    });
    reply({ ok: true });
    return true;
  }
  if (msg && msg.type === 'refresh') {
    refresh().then(() => reply({ ok: true }));
    return true;
  }
  if (msg && msg.type === 'status') {
    chrome.storage.local.get(null).then((v) => reply(v));
    return true;
  }
});

refresh();
