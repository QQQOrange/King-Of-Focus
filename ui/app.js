/* King of Focus — 前端逻辑 */
'use strict';

const T = window.__TAURI__;
const invoke = T && T.core ? T.core.invoke : async () => { throw new Error('需要在 King of Focus 中运行'); };

const S = {
  view: 'overview',
  data: null,
  editing: null,
  editingNew: false,
  editorTab: 'apps',
  statsTab: 'on',
  range: 'today',
  customStart: '',
  customEnd: '',
  stats: null,
  reports: [],
  reportView: null,
  picker: null,
  pickerFor: null,
  dragging: false,
  paint: null,
  ccDrag: null,
  ccRect: null,
  browsers: null,
  browserScanning: false,
};

const PALETTE = ['#ffb020', '#ff7a45', '#f759ab', '#b37feb', '#5b8cff', '#36cfc9',
  '#52c41a', '#a0d911', '#faad14', '#ff5c5c', '#40a9ff', '#9254de'];

const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const VIEW_TITLES = {
  overview: '总览', rules: '规则', clock: '自律时段', mask: '专注遮罩', browsers: '浏览器插件',
  stats: '时长统计', reports: '统计报告', sync: '云同步',
  settings: '设置', about: '关于', help: '帮助',
};

/* ---------------- 工具 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');

function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return dateStr(new Date()); }
function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }

function fmtDur(secs) {
  secs = Math.round(secs || 0);
  if (secs < 60) return secs + ' 秒';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h} 小时 ${pad(m)} 分`;
  return `${m} 分`;
}
function fmtDurShort(secs) {
  secs = Math.round(secs || 0);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h${pad(m)}m`;
  if (m > 0) return `${m}m`;
  return secs + 's';
}
function fmtCountdown(sec) {
  if (!sec || sec <= 0) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分后`;
  if (m > 0) return `${m} 分钟后`;
  return `${Math.max(1, sec)} 秒后`;
}
function hhmm(ts) {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function mins(m) { return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`; }
function sliceTotal(arr) { return (arr || []).reduce((a, b) => a + (b.secs || 0), 0); }

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = msg;
  $('#toastRoot').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------------- 主题 ---------------- */
const themeMedia = window.matchMedia('(prefers-color-scheme: light)');

function cssVar(n) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return themeMedia.matches ? 'light' : 'dark';
}

function applyTheme() {
  const pref = (S.data && S.data.config && S.data.config.settings.theme) || 'system';
  const t = resolveTheme(pref);
  if (document.documentElement.dataset.theme !== t) {
    document.documentElement.dataset.theme = t;
    // 主题切换后重绘饼图（canvas 颜色是算出来的）
    if (S.view === 'stats') {
      const cur = currentSlices();
      drawPie($('#pie'), cur.slices, cur.total, { sub: '累计前台时长' });
    }
    if ($('#pieOn')) renderReportModal();
  }
}

themeMedia.addEventListener('change', () => {
  const pref = (S.data && S.data.config && S.data.config.settings.theme) || 'system';
  if (pref === 'system') {
    applyTheme();
    if (S.view === 'settings') render();
  }
});

/* ---------------- 状态拉取 ---------------- */
async function pull() {
  try {
    S.data = await invoke('get_state');
    applyTheme();
    renderChrome();
    if (S.view === 'overview' && !S.editing) render();
    // 浏览器插件页：状态一变就重画（插件装上/被停用/启动浏览器都能在 1.5s 内反映出来），
    // 状态没变就不重画，避免把用户正在输入的宽限毫秒清掉
    if (S.view === 'browsers' && !S.browserScanning) {
      const sig = (S.data.browsers || [])
        .map((b) => `${b.key}:${b.ext}:${b.running ? 1 : 0}:${b.installed ? 1 : 0}`)
        .join('|');
      if (sig !== S.browsersSig) {
        S.browsersSig = sig;
        render();
      }
    }
    if (S.data && S.data.mask && S.data.mask.notice) {
      toast(S.data.mask.notice);
    }
    if (S.data && S.data.runtime && S.data.runtime.notice) {
      toast(S.data.runtime.notice, 'err');
    }
    if (S.data && S.data.runtime && S.data.runtime.celebrate) {
      showCelebrate(S.data.runtime.celebrate);
    }
  } catch (e) {
    console.error(e);
  }
}

function renderChrome() {
  const tbn = $('#testBanner');
  if (tbn) tbn.classList.toggle('hidden', !(S.data && S.data.testMode));
  const d = S.data;
  if (!d) return;
  const on = d.runtime.disciplineOn;
  const pill = $('#statePill');
  pill.className = 'pill' + (on ? ' on' : '');
  pill.innerHTML = `<span class="dot"></span>${on ? '自律模式已开启' : '自律模式未开启'}`;

  const now = new Date();
  $('#clock').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  $('#sideVersion').textContent = 'v' + d.version;

  const ext = d.runtime.hb > 0 && (Date.now() / 1000 - d.runtime.hb) < 120;
  const parts = [];
  if (d.runtime.clockOn) {
    parts.push(`生效时段：<b>第 ${d.runtime.clockHour} 段</b>（专注中）`);
  } else if (d.runtime.clockBreak) {
    parts.push(`生效时段：<b>第 ${d.runtime.clockHour} 段休息中</b>`);
  }
  if (d.runtime.active.length) {
    parts.push(`生效规则：<b>${d.runtime.active.map((a) => esc(a.name)).join('、')}</b>`);
  } else if (!d.runtime.clockOn && !d.runtime.clockBreak) {
    parts.push('当前没有生效的规则');
  }
  parts.push(ext ? '浏览器插件：已连接' : '<span class="warn">浏览器插件：未连接</span>');
  if (!d.admin) parts.push('<span class="warn">未以管理员身份运行</span>');
  $('#sideStatus').innerHTML = parts.join('<br>');

  const tb = $('#themeBtn');
  if (tb) {
    const pref = (d.config && d.config.settings.theme) || 'system';
    const cur = resolveTheme(pref);
    const label = pref === 'system' ? `◐ 跟随系统（${cur === 'light' ? '浅' : '深'}）` : cur === 'light' ? '☀ 浅色' : '☾ 深色';
    tb.textContent = label;
  }
}

/* ---------------- 视图：总览 ---------------- */
function viewOverview() {
  const d = S.data;
  if (!d) return '<div class="empty">加载中…</div>';
  const rt = d.runtime;
  const on = rt.disciplineOn;
  const next = rt.nextChange;
  const locked = !!rt.locked;
  const pts = d.points || { balance: 0, price: 15, count: 0, unlockUntil: 0 };

  const phase = rt.breakOn ? '休息中' : on ? '专注中' : '自由时间';
  const phaseLeft = rt.breakLeft || 0;
  const mmss = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;

  const lockBanner = locked ? `
    <div class="note" style="border-left:3px solid var(--red);background:rgba(255,92,92,.07);border-color:rgba(255,92,92,.22);margin-bottom:16px">
      <b style="color:var(--red)">🔒 自律固化中</b>
      ${esc(rt.lockNames.join('、'))} 正在生效，<b>${esc(rt.lockUntilText || '时段结束')}</b> 之前：
      无法退出程序、无法修改任何设置，任务管理器 / 进程管理器会被自动关闭。
      <div style="margin-top:6px;color:var(--text-3)">想提前结束，只能用积分解锁。</div>
    </div>` : '';

  const unlockBanner = pts.unlockUntil && pts.unlockUntil * 1000 > Date.now() ? `
    <div class="note" style="margin-bottom:16px">
      <b>已用积分解锁</b> · 到 ${new Date(pts.unlockUntil * 1000).toLocaleTimeString()} 之前所有拦截暂停。
    </div>` : '';

  const chips = rt.active.length
    ? rt.active.map((a) => `<span class="rule-chip"><span class="dot"></span>${esc(a.name)}
        <span class="badge ${a.mode === 'whitelist' ? 'red' : 'gold'}">${a.mode === 'whitelist' ? '强制模式' : '黑名单'}</span></span>`).join('')
    : '<span class="muted">暂无生效规则。到「规则」里新建一条，并设置生效时段。</span>';

  const evs = (rt.events || []).slice(0, 7);
  const evHtml = evs.length
    ? evs.map((e) => `<div class="ev">
        <span class="t">${hhmm(e.ts)}</span>
        <span class="badge ${e.kind === 'site' ? 'blue' : e.kind === 'browser' ? 'blue' : 'gold'}">${e.kind === 'site' ? '网页' : e.kind === 'browser' ? '浏览器' : '软件'}</span>
        <span class="n" title="${esc(e.target)}">${esc(e.target)}</span>
        <span class="muted" style="font-size:11px">${esc(e.rule)}</span>
      </div>`).join('')
    : '<div class="empty">还没有拦截记录。等你设置的时段到了，这里会出现被拦下的应用和网页。</div>';

  const maskOn = d.mask.on;

  return `
  ${lockBanner}${unlockBanner}
  <div class="hero">
    <div class="hero-main">
      <div class="hero-label">当前状态</div>
      <div class="hero-state ${on || rt.breakOn ? 'on' : ''}">${phase}</div>
      <div class="hero-desc">${rt.breakOn
        ? `休息 ${mmss(phaseLeft)}，这段时间黑名单是放开的，时间到自动锁回去。`
        : on
          ? `黑名单里的软件与网页已被拦住：${esc(rt.active.map((a) => a.name).join('、'))}`
          : '所有规则都在等待它自己的生效时段。'}</div>
      <div class="hero-count">
        <div><div class="n">${rt.blockedApps}</div><div class="l">今日拦截软件</div></div>
        <div><div class="n">${rt.blockedSites}</div><div class="l">今日拦截网页</div></div>
        <div><div class="n">${on ? fmtCountdown(next).replace(' 后', '') : '—'}</div><div class="l">${on ? '距状态变化' : '下次生效'}</div></div>
      </div>
    </div>
    <div class="stat-mini">
      <div class="mini">
        <div class="l">自律积分</div>
        <div class="v" style="color:var(--gold)">${pts.balance}</div>
        <div class="l" style="margin-top:6px">每分钟 +1 分 · 今日已解锁 ${pts.count} 次</div>
      </div>
      <div class="mini">
        <div class="l">专注遮罩</div>
        <div class="v" style="color:${maskOn ? 'var(--gold)' : 'var(--text-2)'}">${maskOn ? '已开启' : '未开启'}</div>
        <div class="l" style="margin-top:6px">${maskOn ? esc(d.config.settings.mask.targetTitle || '目标窗口') : '选一个窗口，把其他都盖住'}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">积分兑换 <span class="badge gold">${pts.balance} 分</span></div>
    <div class="card-sub">
      专注 1 分钟 = 1 分。用积分可以强行解锁：当前单价 <b>${pts.price} 分 / 分钟</b>，
      今天第 n 次解锁单价 ×1.4（第 1 次 ${pts.price}，第 2 次 ${Math.round(pts.price * 1.4)}，第 3 次 ${Math.round(pts.price * 1.96)}）。
    </div>
    <div class="row" style="align-items:center">
      <button class="btn btn-primary" data-act="open-unlock">用积分解锁</button>
      <span class="hint">${on || rt.breakOn ? '解锁期间所有拦截暂停，倒计时结束自动恢复' : '现在没有生效的规则，暂时不需要解锁'}</span>
    </div>
  </div>

  <div class="card">
    <div class="card-title">生效中的规则</div>
    <div class="card-sub">规则的生效完全由时间表决定，不在时段内时它是完全静默的。</div>
    <div>${chips}</div>
  </div>

  <div class="grid-2" style="margin-top:16px;align-items:start">
    <div class="card">
      <div class="card-title">最近拦截</div>
      <div class="card-sub">只记录最近 240 条，含时间、类型、对象与命中规则。</div>
      <div class="evlist">${evHtml}</div>
    </div>
    <div class="card">
      <div class="card-title">今日概览</div>
      <div class="card-sub">每 15 秒落盘一次，关掉窗口也不会丢。</div>
      <div class="evlist">
        <div class="ev"><span class="t">软件</span><span class="n">${rt.blockedApps} 次拦截</span></div>
        <div class="ev"><span class="t">网页</span><span class="n">${rt.blockedSites} 次拦截</span></div>
        <div class="ev"><span class="t">插件</span><span class="n">${rt.hb ? `${esc(rt.hbBrowser || '浏览器')} · ${Math.max(0, Math.round(Date.now() / 1000 - rt.hb))} 秒前心跳` : '尚未连接'}</span></div>
        <div class="ev"><span class="t">数据</span><span class="n muted" style="font-size:11px">${esc(d.dataPath || '')}</span></div>
      </div>
    </div>
  </div>`;
}

/* ---------------- 视图：规则 ---------------- */
function schedSummary(sched) {
  if (!sched || sched.every((d) => !d.length)) return '全天生效';
  const out = [];
  sched.forEach((slots, i) => {
    if (!slots.length) return;
    out.push(DAYS[i] + slots.map((s) => `${mins(s.start)}-${mins(s.end)}`).join(','));
  });
  return out.join('  ');
}

function viewRules() {
  const d = S.data;
  if (!d) return '';
  const lists = d.config.lists;
  const activeNames = new Set((d.runtime.active || []).map((a) => a.name));
  const locked = !!d.runtime.locked;
  const cards = lists.length
    ? lists.map((l) => `
      <div class="rule-card ${activeNames.has(l.name) ? 'active' : ''}" data-act="edit-rule" data-id="${l.id}">
        <div class="rule-bar" style="background:${esc(l.color || '#4d8dff')}"></div>
        <div style="flex:1;min-width:0">
          <div class="rule-name">${esc(l.name)}
            ${l.mode === 'whitelist'
              ? '<span class="badge red">强制模式 · 只能开白名单</span>'
              : '<span class="badge gold">黑名单 · 这些不能开</span>'}
            ${l.hard ? '<span class="badge red">固化</span>' : ''}
            ${l.brk && l.brk.kind === 'pomodoro' ? `<span class="badge blue">番茄 ${l.brk.workMin}/${l.brk.breakMin}</span>` : ''}
            ${activeNames.has(l.name) ? '<span class="badge green">生效中</span>' : ''}
          </div>
          <div class="rule-meta">${l.apps.length} 个软件 · ${l.sites.length} 个网站 · ${l.exceptions.length} 条例外<br>
            <span class="muted">${esc(schedSummary(l.schedule))}</span></div>
        </div>
        <div class="rule-actions">
          <div class="switch" data-act="toggle-rule" data-id="${l.id}"
               style="${locked ? 'pointer-events:none;opacity:.32' : ''}"
               title="${locked ? '自律固化中，开关已锁定' : '启用 / 停用'}">
            <input type="checkbox" ${l.enabled ? 'checked' : ''}><i></i>
          </div>
          <button class="btn btn-sm" data-act="del-rule" data-id="${l.id}"
            ${locked ? 'disabled' : ''}>删除</button>
        </div>
      </div>`).join('')
    : '<div class="empty">还没有规则。点右上角「新建规则」开始。</div>';

  return `
  ${locked ? `<div class="note" style="border-left:3px solid var(--red);background:rgba(255,92,92,.07);border-color:rgba(255,92,92,.22);margin-bottom:16px">
    <b style="color:var(--red)">🔒 自律固化中</b>：${esc((d.runtime.lockNames || []).join('、'))} 正在生效，
    <b>${esc(d.runtime.lockUntilText || '时段结束')}</b> 之前所有开关都已置灰，改不了也关不掉。
  </div>` : ''}
  <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:16px">
    <div class="hint" style="max-width:640px">
      一条规则 = 一个黑名单（或白名单）+ 一张周时间表。<b>只有落在时间表里的时段，规则才会生效</b>；
      时间表全空表示 7×24 小时生效。软件与网站分别维护，互不影响。
    </div>
    <button class="btn btn-primary" data-act="new-rule" ${locked ? 'disabled' : ''}>+ 新建规则</button>
  </div>
  <div style="display:flex;flex-direction:column;gap:10px">${cards}</div>`;
}

/* ---------------- 规则编辑器 ---------------- */
function openEditor(id, isNew) {
  const d = S.data;
  if (!d) return;
  let rule;
  if (isNew) {
    rule = {
      id: 'r' + Date.now().toString(36),
      name: '新规则',
      enabled: false,
      mode: 'blacklist',
      apps: [],
      sites: [],
      exceptions: [],
      schedule: [[], [], [], [], [], [], []],
      lock: { kind: 'none', until: 0, password: '', chars: 20 },
      color: PALETTE[Math.floor(Math.random() * 4)],
      extraProtected: [],
      brk: { kind: 'none', workMin: 25, breakMin: 5 },
      hard: true,
    };
  } else {
    rule = JSON.parse(JSON.stringify(d.config.lists.find((x) => x.id === id)));
  }
  S.editing = rule;
  S.editingNew = !!isNew;
  S.editorTab = 'apps';
  renderEditor();
}

function renderEditor() {
  const r = S.editing;
  if (!r) return;
  const tabs = [
    ['apps', `软件 (${r.apps.length})`],
    ['sites', `网站 (${r.sites.length})`],
    ['exceptions', `网站例外 (${r.exceptions.length})`],
    ['schedule', '时间表'],
    ['break', '休息'],
    ['lock', '固化'],
  ];

  let body = '';
  if (S.editorTab === 'apps') body = tabApps(r);
  if (S.editorTab === 'sites') body = tabSites(r);
  if (S.editorTab === 'exceptions') body = tabExceptions(r);
  if (S.editorTab === 'schedule') body = tabSchedule(r);
  if (S.editorTab === 'break') body = tabBreak(r);
  if (S.editorTab === 'lock') body = tabLock(r);

  const html = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal wide">
      <div class="modal-hd">
        <h3>${S.editingNew ? '新建规则' : '编辑规则'}</h3>
        <button class="close-x" data-act="close-editor">×</button>
      </div>
      <div class="modal-bd">
        <div class="row" style="gap:10px;margin-bottom:16px;align-items:center">
          <input type="text" id="ruleName" value="${esc(r.name)}" style="flex:1;font-size:14px;font-weight:600" placeholder="规则名称，例如：晚自习" />
          <div class="seg">
            <button class="${r.mode === 'blacklist' ? 'active gold' : ''}" data-act="mode" data-mode="blacklist">黑名单</button>
            <button class="${r.mode === 'whitelist' ? 'active' : ''}" data-act="mode" data-mode="whitelist">强制模式（白名单）</button>
          </div>
        </div>
        ${r.mode === 'whitelist' ? `<div class="note" style="margin-bottom:14px">
          <b>强制模式</b>：生效时段内，只有下面名单里的软件可以打开，其他所有前台窗口都会被关掉。
          系统进程、资源管理器、本程序自身以及「设置 → 全局保护」里的进程不会被拦截。
        </div>` : ''}
        <div class="tabs">${tabs.map(([k, n]) => `<button class="tab ${S.editorTab === k ? 'active' : ''}" data-act="editor-tab" data-tab="${k}">${n}</button>`).join('')}</div>
        ${body}
      </div>
      <div class="modal-ft">
        <button class="btn" data-act="close-editor">取消</button>
        <button class="btn btn-primary" data-act="save-editor">保存</button>
      </div>
    </div>
  </div>`;
  $('#modalRoot').innerHTML = html;
  if (S.editorTab === 'schedule') paintSchedule();
}

function tabApps(r) {
  const rows = r.apps.length
    ? r.apps.map((a, i) => `<div class="list-row">
        <span class="badge">${a.kind === 'exe' ? '程序' : a.kind === 'dir' ? '文件夹' : a.kind === 'name' ? '进程名' : '窗口标题'}</span>
        <span class="grow">${esc(a.label || a.value)}<div class="path">${esc(a.value)}</div></span>
        <button class="x" data-act="del-app" data-i="${i}">×</button>
      </div>`).join('')
    : '<div class="empty">还没有添加软件。<br>推荐用「从运行中的程序添加」，一次点选最省事。</div>';
  return `
    <div class="add-row">
      <button class="btn" data-act="pick-running-app">+ 从运行中的程序添加</button>
      <button class="btn" data-act="pick-file">+ 选择 exe</button>
      <button class="btn" data-act="pick-dir">+ 整个文件夹</button>
    </div>
    <div class="list-box">${rows}</div>
    <div class="hint" style="margin-top:12px">
      匹配顺序：<b>程序</b>按 exe 完整路径比对；<b>文件夹</b>匹配该目录下所有 exe；
      <b>进程名</b>支持 <code>*</code> 通配（如 <code>*steam*</code>）；<b>窗口标题</b>按包含关系匹配，适合拦网页标题。
    </div>`;
}

function tabSites(r) {
  const rows = r.sites.length
    ? r.sites.map((s, i) => `<div class="list-row">
        <span class="badge blue">网站</span>
        <span class="grow">${esc(s.pattern)}</span>
        <button class="x" data-act="del-site" data-i="${i}">×</button>
      </div>`).join('')
    : '<div class="empty">还没有添加网站。<br>可以填 <code>youtube.com</code>、<code>bilibili.com/video</code> 或 <code>*porn*</code></div>';
  return `
    <div class="add-row">
      <input type="text" id="siteInput" placeholder="输入域名 / 路径 / 通配符，回车添加" />
      <button class="btn btn-primary" data-act="add-site">添加</button>
    </div>
    <div style="margin-bottom:12px">
      <button class="chip-btn" data-act="quick-site" data-v="*.*">整个互联网 *.*</button>
      <button class="chip-btn" data-act="quick-site" data-v="youtube.com">YouTube</button>
      <button class="chip-btn" data-act="quick-site" data-v="bilibili.com">哔哩哔哩</button>
      <button class="chip-btn" data-act="quick-site" data-v="weibo.com">微博</button>
      <button class="chip-btn" data-act="quick-site" data-v="douyin.com">抖音</button>
      <button class="chip-btn" data-act="quick-site" data-v="zhihu.com">知乎</button>
    </div>
    <div class="list-box">${rows}</div>
    <div class="hint" style="margin-top:12px">
      网站拦截由浏览器插件执行。填 <code>youtube.com</code> 会连子域名一起拦；
      填 <code>youtube.com/shorts</code> 只拦路径前缀；用 <code>*</code> 表示任意字符。
      需要放行某个页面时，到「网站例外」里加。
    </div>`;
}

function tabExceptions(r) {
  const rows = r.exceptions.length
    ? r.exceptions.map((v, i) => `<div class="list-row">
        <span class="badge green">放行</span>
        <span class="grow">${esc(v)}</span>
        <button class="x" data-act="del-exc" data-i="${i}">×</button>
      </div>`).join('')
    : '<div class="empty">没有例外。例外只在当前这条规则内生效。</div>';
  return `
    <div class="add-row">
      <input type="text" id="excInput" placeholder="要放行的网站，例如 mail.google.com" />
      <button class="btn btn-primary" data-act="add-exc">添加</button>
    </div>
    <div class="list-box">${rows}</div>
    <div class="hint" style="margin-top:12px">
      例外的优先级高于网站黑名单。想把「整个互联网」都拦掉、只放几个站点，
      就在网站页添加 <code>*.*</code>，再在这里把要放行的站点加进来。
    </div>`;
}

function tabSchedule(r) {
  const head = Array.from({ length: 24 }, (_, i) => `<span>${pad(i)}</span>`).join('');
  const rows = DAYS.map((d, di) => {
    const cells = Array.from({ length: 48 }, (_, ci) => {
      const on = slotHas(r.schedule[di], ci * 30);
      return `<div class="cell ${on ? 'on' : ''} ${ci % 2 === 0 ? 'hour' : ''}" data-day="${di}" data-idx="${ci}"></div>`;
    }).join('');
    return `<div class="sched-row"><div class="sched-day">${d}</div><div class="cells">${cells}</div></div>`;
  }).join('');
  return `
    <div class="sched">
      <div class="sched-head">${head}</div>
      ${rows}
    </div>
    <div class="sched-tools">
      <button class="chip-btn" data-act="sched-copy" data-from="0" data-to="1,2,3,4">周一 → 工作日</button>
      <button class="chip-btn" data-act="sched-copy" data-from="0" data-to="0,1,2,3,4,5,6">周一 → 全部</button>
      <button class="chip-btn" data-act="sched-clear">清空</button>
      <span class="hint" style="align-self:center">拖动鼠标可以刷时段（每格 30 分钟）</span>
    </div>
    <div class="hint" style="margin-top:12px">
      时间表全空 = 全天生效。规则<b>只在这些时段内</b>拦截，其余时间完全静默。
      下周会自动循环，不需要重复设置。
    </div>`;
}

function tabBreak(r) {
  const b = r.brk || { kind: 'none', workMin: 25, breakMin: 5 };
  const pomo = b.kind === 'pomodoro';
  return `
    <div class="hint" style="margin-bottom:14px">
      开启番茄后，生效时段会被切成「专注 → 休息 → 专注 …」的循环。
      <b>休息期间这条规则不拦截</b>（黑名单里的软件和网页都能用），时间一到自动锁回去。
      循环从时段的起点开始算。
    </div>
    <div class="seg" style="margin-bottom:18px">
      <button class="${!pomo ? 'active gold' : ''}" data-act="break-kind" data-k="none">不休息</button>
      <button class="${pomo ? 'active gold' : ''}" data-act="break-kind" data-k="pomodoro">番茄休息</button>
    </div>
    ${pomo ? `
    <div class="row" style="gap:22px;align-items:flex-end;margin-bottom:16px">
      <div>
        <div class="hint" style="margin-bottom:6px">专注多久（分钟）</div>
        <input type="number" id="workMin" min="1" max="240" value="${b.workMin || 25}" style="width:110px" />
      </div>
      <div>
        <div class="hint" style="margin-bottom:6px">休息多久（分钟）</div>
        <input type="number" id="breakMin" min="1" max="120" value="${b.breakMin || 5}" style="width:110px" />
      </div>
      <div class="hint" style="padding-bottom:9px">例如 50 / 10 = 每专注 50 分钟放你 10 分钟</div>
    </div>
    <div class="note">
      生效时段建议留够整轮时间，比如 19:00-21:30 配 50/10，能跑完 2 轮多一点。<br>
      休息期间积分<b>不加</b>，但程序可以正常退出（休息不算自律时间）。
    </div>` : '<div class="hint">不设置休息时，整段生效时间都会处于拦截状态。</div>'}`;
}

function tabLock(r) {
  const locked = !!(S.data && S.data.runtime && S.data.runtime.locked);
  return `
    <div class="hint" style="margin-bottom:14px">
      「固化」开关在<b>「固化」标签页</b>里控制：开启后生效期间程序不可退出、设置不可修改、任务管理器会被关闭。
    </div>
    ${locked ? `<div class="note" style="border-left:3px solid var(--red);background:rgba(255,92,92,.07)">
      当前正在固化中（${esc(S.data.runtime.lockUntilText || '时段结束')} 结束），期间无法保存任何修改。
    </div>` : '<div class="note">当前不在固化时段，设置可以自由修改。</div>'}
    <div class="hint" style="margin-top:16px">
      <b>解除方式</b>：时段自然结束，或用积分强行解锁（到「总览 → 积分兑换」）。
      积分按专注时长发放，每专注 1 分钟 1 分，解锁单价随当天解锁次数递增。
    </div>`;
}

/* 拖动刷时段 */
function slotHas(slots, minute) {
  return (slots || []).some((s) => {
    const end = s.end <= s.start ? 1440 : s.end;
    return minute >= s.start && minute < end;
  });
}
function normalize(slots) {
  const arr = slots.filter((s) => s.end !== s.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of arr) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}
function addRange(slots, a, b) { return normalize([...(slots || []), { start: a, end: b }]); }
function subRange(slots, a, b) {
  const out = [];
  for (const s of slots || []) {
    if (s.end <= a || s.start >= b) { out.push(s); continue; }
    if (s.start < a) out.push({ start: s.start, end: a });
    if (s.end > b) out.push({ start: b, end: s.end });
  }
  return normalize(out);
}
function paintSchedule() {
  const r = S.editing;
  if (!r) return;
  document.querySelectorAll('.cell').forEach((c) => {
    const d = +c.dataset.day, i = +c.dataset.idx;
    c.classList.toggle('on', slotHas(r.schedule[d], i * 30));
  });
}

/* ---------------- 视图：自律时段（7 列 × 24 小时柱状图） ---------------- */
const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const CC_DEF_W = 50, CC_DEF_B = 10; // 配置里没有通用时长时的兜底值

/** 归一化 focusClock：7 天 × 24 小时（兼容旧版"全周共用 24 段"的 hours） */
function clockCfg() {
  const s = S.data && S.data.config && S.data.config.settings;
  if (!s) return { enabled: false, applyRules: true, days: [], defWork: CC_DEF_W, defBrk: CC_DEF_B };
  if (!s.focusClock) s.focusClock = { enabled: false, applyRules: true, days: [] };
  const fc = s.focusClock;
  if (!Array.isArray(fc.days)) fc.days = [];
  // 通用默认时长：新框选/单击选中的时段沿用这套专注/休息（右键菜单可更新）
  fc.defWork = Math.max(1, Math.min(60, Math.round(fc.defWork || CC_DEF_W)));
  fc.defBrk = Math.max(0, Math.min(60, Math.round(fc.defBrk || CC_DEF_B)));
  if (fc.defBrk > 0 && fc.defWork + fc.defBrk > 60) fc.defBrk = 60 - fc.defWork;
  // 新时段的默认值跟着通用时长走
  const fresh = () => ({ on: false, work: fc.defWork, brk: fc.defBrk });
  // 旧结构迁移：hours（全周共用）→ 复制到 7 天（后端 sanitize 也会做，这里兜底）
  if (!fc.days.length && Array.isArray(fc.hours) && fc.hours.length) {
    const legacy = [];
    for (let h = 0; h < 24; h++) {
      const p = fc.hours[h] || {};
      legacy.push({ on: !!p.on, work: +(p.work || CC_DEF_W), brk: +(p.brk || CC_DEF_B) });
    }
    fc.days = Array.from({ length: 7 }, () => legacy.map((p) => ({ ...p })));
  }
  while (fc.days.length < 7) fc.days.push(Array.from({ length: 24 }, fresh));
  fc.days.length = 7;
  fc.days.forEach((day, d) => {
    if (!Array.isArray(day)) fc.days[d] = Array.from({ length: 24 }, fresh);
    const dd = fc.days[d];
    while (dd.length < 24) dd.push(fresh());
    dd.length = 24;
    for (const p of dd) {
      p.work = Math.max(0, Math.min(60, Math.round(p.work || 0)));
      p.brk = Math.max(0, Math.min(60, Math.round(p.brk || 0)));
      if (p.brk > 0) {
        p.work = Math.max(1, Math.min(59, p.work));
        if (p.work + p.brk > 60) p.brk = 60 - p.work;
      }
    }
  });
  delete fc.hours;
  return fc;
}

/** 连通判定：格子 (d,h) 的上下左右有选中的邻居，那条边就不画接缝，
 * 于是一片连在一起的选中时段在柱状图上看起来就是连成一片的。 */
function ccJoins(fc, d, h) {
  const on = (dd, hh) => !!(fc.days[dd] && fc.days[dd][hh] && fc.days[dd][hh].on);
  return { jt: on(d, h + 1), jb: on(d, h - 1), jl: on(d - 1, h), jr: on(d + 1, h) };
}

/** 把连通类名写到 DOM 上（渲染和拖选预览共用） */
function ccApplyJoins(root) {
  const fc = clockCfg();
  const onCells = new Set();
  root.querySelectorAll('.cc-cell').forEach((c) => {
    if (c.classList.contains('on')) onCells.add(`${+c.dataset.d},${+c.dataset.h}`);
  });
  const isOn = (d, h) => onCells.has(`${d},${h}`);
  root.querySelectorAll('.cc-cell').forEach((c) => {
    const d = +c.dataset.d, h = +c.dataset.h, on = isOn(d, h);
    c.classList.toggle('jt', on && isOn(d, h + 1));
    c.classList.toggle('jb', on && isOn(d, h - 1));
    c.classList.toggle('jl', on && isOn(d - 1, h));
    c.classList.toggle('jr', on && isOn(d + 1, h));
  });
}

/** 已选时段总数（小时数） */
function clockCountOn(fc) {
  return (fc || clockCfg()).days.reduce((n, day) => n + day.filter((p) => p.on).length, 0);
}

/** 一天里选中的小时合并成区间文案 */
function ccDayRanges(day) {
  const parts = [];
  let i = 0;
  while (i < 24) {
    if (!day[i].on) { i++; continue; }
    const start = i;
    while (i + 1 < 24 && day[i + 1].on) i++;
    parts.push(`${pad(start)}:00–${pad(i + 1)}:00`);
    i++;
  }
  return parts;
}

/** 已选摘要：七天一样 → "每天 …"，否则逐天列（与后端 summary 口径一致） */
function clockRangeText(fc) {
  const c = fc || clockCfg();
  const first = ccDayRanges(c.days[0]);
  if (first.length && c.days.every((d) => ccDayRanges(d).join('|') === first.join('|'))) {
    return `每天 ${first.join('、')}`;
  }
  const parts = [];
  c.days.forEach((day, d) => {
    const r = ccDayRanges(day);
    if (r.length) parts.push(`${WD[d]} ${r.join('、')}`);
  });
  return parts.length ? parts.join('；') : '未选择任何时段';
}

/** 矩形区域文案：周三 08:00–12:00 / 周三 – 周五 08:00–12:00 */
function ccRectText(d0, d1, h0, h1) {
  const days = d0 === d1 ? WD[d0] : `${WD[d0]} – ${WD[d1]}`;
  return `${days} ${pad(h0)}:00 – ${pad(h1 + 1)}:00`;
}

/** 从当前时刻起，下一个被选中的时段（含本周稍后与下周），没有则返回 '' */
function ccNextSlotText(fc, wdNow, hourNow) {
  for (let step = 0; step < 7 * 24; step++) {
    const d = (wdNow + Math.floor((hourNow + step) / 24)) % 7;
    const h = (hourNow + step) % 24;
    if (fc.days[d] && fc.days[d][h] && fc.days[d][h].on) {
      const when = step < 24 ? (step === 0 ? '本小时' : `${step} 小时后`) : `${Math.floor(step / 24)} 天后`;
      return `，下一个选中时段：${WD[d]} ${pad(h)}:00（${when}）`;
    }
  }
  return '';
}

function viewClock() {
  const d = S.data;
  if (!d) return '';
  const fc = clockCfg();
  const rt = d.runtime || {};
  const wdNow = (new Date().getDay() + 6) % 7; // 0=周一
  const hourNow = new Date().getHours();
  const n = clockCountOn(fc);

  // 当前状态一句话
  let stateTxt = '当前不在生效时段';
  let stateCls = '';
  if (fc.enabled && rt.clockInWindow) {
    const left = Math.max(0, rt.clockLeft || 0);
    const mm = Math.floor(left / 60), ss = left % 60;
    if (rt.clockBreak) {
      stateTxt = `休息中 · 还剩 ${mm} 分 ${pad(ss)} 秒（这段时间不拦截、不遮罩）`;
      stateCls = 'gold';
    } else {
      stateTxt = `专注中 · 还剩 ${mm} 分 ${pad(ss)} 秒（规则正在生效，应用 / 网页会被关闭）`;
      stateCls = 'green';
    }
  } else if (!fc.enabled) {
    stateTxt = '未启用：下面选中的时段不会生效';
  } else if (!n) {
    stateTxt = '还没有选择任何时段';
  } else if (rt.clockInWindow === undefined || rt.clockInWindow === null) {
    stateTxt = '正在读取时钟状态…';
  } else {
    stateTxt = `当前不在生效时段：这段时间规则不拦截${ccNextSlotText(fc, wdNow, hourNow)}`;
  }

  // 柱状图：第 1 行星期表头，下面 24 行小时格（自上而下 0 → 23，左上角标 0）
  let grid = `<div class="cc-corner">0</div>` + WD.map((w, i) =>
    `<div class="cc-dh${i === wdNow ? ' today' : ''}">${w}${i === wdNow ? '·今' : ''}</div>`).join('');
  for (let h = 0; h < 24; h++) {
    grid += `<div class="cc-hlab">${h}</div>`;
    for (let dd = 0; dd < 7; dd++) {
      const p = fc.days[dd][h];
      const w = Math.max(0, Math.min(60, p.work || 0));
      const b = Math.max(0, Math.min(60 - w, p.brk || 0));
      const t = Math.max(0, 60 - w - b); // 没排满的尾段，引擎里算继续专注
      const bar = p.on
        ? `<span class="cc-bar"><i class="w" style="height:${Math.round((w / 60) * 100)}%"></i><i class="b" style="height:${Math.round((b / 60) * 100)}%"></i><i class="t" style="height:${Math.round((t / 60) * 100)}%"></i></span>`
        : '';
      // 连在一起的选中时段：有选中邻居的那几条边去掉接缝，视觉上连成一片
      const j = p.on ? ccJoins(fc, dd, h) : {};
      const jc = ['jt', 'jb', 'jl', 'jr'].filter((k) => j[k]).map((k) => ' ' + k).join('');
      grid += `<div class="cc-cell${p.on ? ' on' : ''}${jc}${dd === wdNow && h === hourNow ? ' now' : ''}" data-d="${dd}" data-h="${h}"
        title="${WD[dd]} ${pad(h)}:00 – ${pad(h + 1)}:00${p.on ? ` · 专注 ${w} 分 / 休息 ${b} 分${t ? `（尾段 ${t} 分继续专注）` : ''}，右键可改` : '（未选中，拖动或右键可设置）'}">${bar}</div>`;
    }
  }

  return `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:14px">
      <div>
        <div class="card-title">自律模式生效时间段</div>
        <div class="card-sub">
          一周七天各一根柱子，纵轴 0–24 点。哪几天、哪几段要自律，拖出来就行；到点自动进入自律模式，到点自动退出；
          规则里的黑白名单、浏览器巡检、专注遮罩都会跟着这段状态走。
        </div>
      </div>
      <div class="switch" data-act="clock-enable"><input type="checkbox" ${fc.enabled ? 'checked' : ''}><i></i></div>
    </div>

    <div class="clock-state ${stateCls}">
      <span class="cs-dot"></span>
      <span>${esc(stateTxt)}</span>
      ${fc.enabled && n ? `<span class="badge">已选 ${n} 个小时段</span>` : ''}
    </div>

    <div class="cc" id="ccGrid">${grid}</div>
    <div class="cc-legend">
      <span><i class="sw w"></i>专注</span>
      <span><i class="sw b"></i>休息</span>
      <span><i class="sw t"></i>继续专注（时段没排满的尾段）</span>
      <span class="hint">连在一起的选中时段会连成一片显示</span>
    </div>
    <div class="cc-def">
      <span class="cc-def-lab">通用时长</span>
      <label>专注 <input type="number" id="defW" min="1" max="60" step="1" value="${fc.defWork}"> 分</label>
      <label>休息 <input type="number" id="defB" min="0" max="60" step="1" value="${fc.defBrk}"> 分</label>
      <button class="btn btn-sm" data-act="clock-def-save">保存</button>
      <span class="hint">之后新框选 / 单击选中的时段都沿用这套时长；右键菜单里改也能顺手更新它</span>
    </div>
    <div class="tl-legend">
      <span class="hint">按住拖动 = 框选一片时段（从灰格起笔＝选中，从蓝格起笔＝取消，新选的时段沿用上面的通用时长）；单击格子 = 单独开关那一小时；<b>右键格子 = 设置这一片的专注 / 休息时长</b>。</span>
      <button class="btn btn-sm" data-act="clock-clear">清空全部</button>
    </div>
    <div class="tl-range">已选：<b id="clockLive">${esc(clockRangeText(fc))}</b></div>
  </div>

  <div class="card">
    <div class="card-title">它和「规则」的关系</div>
    <div class="card-sub">两条时间轴各管一件事，不用二选一。</div>
    <div class="note" style="line-height:1.95">
      <b>这里（自律时段）</b>：决定"什么时候进入自律模式"。粒度 1 小时，按周排，每周重复。<br>
      <b>规则页的时段</b>：决定"某条规则在哪几天、哪几个时间点生效"，粒度到分钟，可以跨夜。<br>
      <b>两者叠加</b>：自律时段内会强制让所有「已启用」的规则立刻生效（可以在下面关掉这个行为）；
      自律时段外，规则还是按它自己的时段走。
      <div class="row" style="justify-content:space-between;align-items:center;margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
        <div>
          <div style="font-size:12.5px">时段内让已启用的规则立即生效</div>
          <div class="hint" style="margin-top:4px">关掉后，自律时段只负责"进入自律状态"（遮罩 / HUD / 积分 / 成绩），规则仍按自己的时段拦截。</div>
        </div>
        <div class="switch" data-act="clock-apply-rules"><input type="checkbox" ${fc.applyRules ? 'checked' : ''}><i></i></div>
      </div>
      <div style="margin-top:12px" class="hint">
        优先级（从高到低）：<b>休息段</b>（一律放行） &gt; 自律时段 / 规则时段 &gt; 手动开关。<br>
        自律时段生效期间，专注遮罩如果开了「跟随自律模式」就会跟着自动打开，此时主开关显示为接管、不能手动切。
      </div>
    </div>
  </div>`;
}

/* ---------------- 视图：专注遮罩 ---------------- */
function viewMask() {
  const d = S.data;
  if (!d) return '';
  const m = d.mask;
  const target = d.config.settings.mask.targetTitle || '';
  const op = m.opacity, mg = m.margin;
  const rad = m.radius == null ? 28 : m.radius;
  const dur = m.duration == null ? 420 : m.duration;
  const rt = d.runtime;
  // on  = 最终生效（用户意向 OR 自律接管）
  // userOn = 用户自己按的开关；autoOn = 自律模式正在接管
  const on = !!m.on;
  const previewing = (m.previewLeft || 0) > 0;
  const followed = !!m.followSchedule;
  const autoOn = !!m.autoOn;
  const autonomy = rt.disciplineOn || rt.active.length > 0 || !!rt.locked;
  // 主开关只反映"真实启用"：预览期间不算开启
  const stateOn = on && !previewing;
  const powerState = previewing ? 'preview' : stateOn ? 'on' : 'off';
  const stateTitle = previewing
    ? `预览中 · ${m.previewLeft} 秒后自动结束`
    : autoOn
      ? '已开启 · 自律模式接管中'
      : stateOn
        ? '已开启 · 正在遮罩'
        : '已关闭';
  const stateDesc = previewing
    ? '这只是临时预览，几秒后会自动收起；它<b>不会</b>改变主开关，也不会让遮罩"一直开着"。'
    : autoOn
      ? '自律模式正在生效，遮罩由它自动接管：自律结束时遮罩会自己关掉。<b>这段时间主开关不能手动切</b>。'
      : stateOn
        ? '这是<b>真实生效</b>的状态：其他窗口与任务栏都被压暗，只有当前最上层窗口（含本软件自己）完整可见。'
        : followed
          ? '遮罩当前没有生效。<b>跟随自律模式</b>开着，自律一开始就会自动打开它。'
          : '遮罩当前<b>没有生效</b>。打开下面的开关后，除当前窗口外的区域会立刻被压暗。';
  return `
  <div class="mask-hero">
    <div style="flex:1;min-width:0">
      <div class="hero-label">专注遮罩 / FOCUS MASK</div>

      <div class="mask-power ${powerState}">
        <div class="switch big ${autoOn ? 'locked' : ''}" data-act="toggle-mask" title="${autoOn ? '自律模式接管中，不能手动切换' : ''}">
          <input type="checkbox" ${stateOn ? 'checked' : ''} ${autoOn ? 'disabled' : ''}><i></i>
        </div>
        <div style="flex:1;min-width:0">
          <div class="mp-title">${stateOn ? '专注遮罩已开启' : '专注遮罩已关闭'}</div>
          <div class="hint" style="margin-top:4px">${stateDesc}</div>
        </div>
        <span class="badge ${powerState === 'on' ? 'green' : powerState === 'preview' ? 'gold' : ''}">${stateTitle}</span>
      </div>

      <div class="row" style="align-items:center;gap:9px;margin-top:12px;flex-wrap:wrap">
        <button class="btn" data-act="mask-preview">${previewing ? `结束预览（剩 ${m.previewLeft}s）` : '预览效果（5 秒）'}</button>
        <button class="btn" data-act="mask-diag">自查</button>
        <span class="hint">预览只是看一眼效果，会自动结束，不会改变主开关。</span>
      </div>

      <div class="mask-link">
        <div class="row" style="align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div style="font-size:12.5px">专注遮罩跟随自律模式</div>
            <div class="hint" style="margin-top:4px">
              自律模式一开始，遮罩自动打开；自律模式一结束，遮罩自动关闭。
              组合规则只有一条：<b>生效 = 主开关 OR（跟随自律 AND 自律生效中）</b>——
              自律接管期间主开关置灰（不能手动关），自律一结束立刻回到你自己按的状态，
              两者不会再互相打架。
            </div>
          </div>
          <div class="switch" data-act="toggle-follow-schedule"><input type="checkbox" ${followed ? 'checked' : ''}><i></i></div>
        </div>
        <div class="row" style="align-items:center;justify-content:space-between;gap:14px;margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
          <div>
            <div style="font-size:12.5px">跟随当前窗口</div>
            <div class="hint" style="margin-top:4px">
              决定"哪一块留出来"：只留当前最上层（正在用）的窗口，其他全部压暗。切换窗口时高亮会平滑移过去，拖动窗口时实时跟随。
            </div>
          </div>
          <div class="switch" data-act="toggle-follow"><input type="checkbox" ${m.follow ? 'checked' : ''}><i></i></div>
        </div>
      </div>
    </div>

    <div class="mask-preview">
      <div class="screen"></div>
      <div class="dim" id="previewDim" style="opacity:${op / 100}"></div>
      <div class="hole" id="previewHole" style="border-radius:${Math.max(2, Math.round(rad / 3))}px">当前窗口</div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="row" style="align-items:center;justify-content:space-between">
      <div>
        <div style="font-size:13px;font-weight:600">跟随当前窗口</div>
        <div class="hint" style="margin-top:4px">
          打开后不用选目标窗口：遮罩会自动盯住<b>当前最上层（正在用）的窗口</b>，
          只留它可见，其他窗口全被盖住。切换窗口时洞口平滑移过去，拖动窗口时 1:1 跟随。
        </div>
      </div>
      <div class="switch" data-act="toggle-follow">
        <input type="checkbox" ${m.follow ? 'checked' : ''}><i></i>
      </div>
    </div>
    <div class="card-title" style="margin-top:16px">遮罩参数</div>
    <div class="card-sub">拖动即时生效——遮罩开着的时候，你可以直接在屏幕上看到效果。动画速度就是"从窗口边缘铺满全屏"用多久，数值越大越慢，0 = 瞬间出现。</div>
    <div class="slider-row">
      <span class="lab">不透明度</span>
      <input type="range" min="20" max="100" step="1" value="${op}" id="opRange" />
      <span class="val" id="opVal">${op}%</span>
    </div>
    <div class="slider-row">
      <span class="lab">边缘留白（0=紧贴）</span>
      <input type="range" min="0" max="60" step="1" value="${mg}" id="mgRange" />
      <span class="val" id="mgVal">${mg}px</span>
    </div>
    <div class="slider-row">
      <span class="lab">圆角半径</span>
      <input type="range" min="0" max="80" step="1" value="${rad}" id="radRange" />
      <span class="val" id="radVal">${rad}px</span>
    </div>
    <div class="slider-row">
      <span class="lab">动画速度</span>
      <input type="range" min="0" max="3000" step="20" value="${dur}" id="durRange" />
      <span class="val" id="durVal">${dur}ms</span>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <div>
        <div style="font-size:12.5px">同时屏蔽鼠标操作</div>
        <div class="hint" style="margin-top:4px">开启后，遮罩会吃掉所有点击，只有目标窗口和本程序可用。关掉则是纯粹"看不见"，鼠标可以穿透。</div>
      </div>
      <div class="switch" data-act="toggle-click">
        <input type="checkbox" ${m.blockClick ? 'checked' : ''}><i></i>
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;margin-top:10px;border-top:1px solid var(--line);padding-top:14px">
      <div>
        <div style="font-size:12.5px">高清圆角（逐像素）</div>
        <div class="hint" style="margin-top:4px">
          打开后圆角有抗锯齿，边缘更细腻。它和默认的「区域挖洞」是两套互斥的画法，
          切换时会重建覆盖层；<b>万一你的机器/远程桌面不支持，会自动降级回区域挖洞并在这里提示</b>，不会再出现"一开就整块消失"。
        </div>
        ${m.smoothFallback ? `<div class="badge gold" style="margin-top:8px">已自动降级为区域挖洞</div>` : ''}
      </div>
      <div class="switch" data-act="toggle-smooth">
        <input type="checkbox" ${m.smooth ? 'checked' : ''}><i></i>
      </div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn btn-sm" data-act="mask-save">保存为默认</button>
      <span class="hint" style="align-self:center">改动会立即生效；点保存才会写进配置，下次启动沿用</span>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-title">快捷键</div>
    <div class="card-sub">
      手动开关遮罩的另一种方式。自动化请用上方的「跟随自律模式」，不再按应用逐个配置。
    </div>
    <div class="row" style="align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
      <span class="hint" style="width:88px">全局快捷键</span>
      <input type="text" id="hkInput" value="${esc(m.hotkey || '')}" placeholder="Ctrl+Alt+K（留空=不注册）" style="flex:1;max-width:270px" />
      <button class="btn btn-sm" data-act="save-hotkey">保存</button>
      <span class="badge ${m.hotkeyOk ? 'green' : 'red'}">${m.hotkeyOk ? '已注册' : '未注册'}</span>
    </div>
    <div class="hint" style="margin-bottom:14px">
      格式：修饰键 + 一个键，如 <code>Ctrl+Alt+K</code>、<code>Ctrl+Shift+F2</code>、<code>Win+Alt+1</code>。
      被别的程序占用会直接报错并保留原来的组合。
    </div>
  <div class="note" style="margin-top:16px">
    <b>扩散动画：</b>开启动画时，遮罩从目标窗口的边缘向外扩展，直到铺满它所在的显示器；
    关闭时反向收回。圆角半径全程保持一致，窗口拖动 / 缩放时遮罩会实时跟随，多显示器和混合 DPI 下按各自的物理分辨率等比适配。
  </div>`;
}

/* ---------------- 视图：时长统计 ---------------- */
function boundsOf(range) {
  const now = new Date();
  if (range === 'today') return [todayStr(), todayStr()];
  if (range === 'week') {
    const dow = (now.getDay() + 6) % 7;
    const mon = addDays(now, -dow);
    return [dateStr(mon), dateStr(addDays(mon, 6))];
  }
  if (range === 'month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return [dateStr(first), dateStr(last)];
  }
  if (range === 'year') {
    return [`${now.getFullYear()}-01-01`, `${now.getFullYear()}-12-31`];
  }
  return [S.customStart || todayStr(), S.customEnd || todayStr()];
}

function mergeSlices(a, b) {
  const map = new Map();
  for (const s of [...a, ...b]) {
    const cur = map.get(s.key) || { key: s.key, label: s.label, category: s.category, secs: 0 };
    cur.secs += s.secs;
    map.set(s.key, cur);
  }
  return [...map.values()].sort((x, y) => y.secs - x.secs);
}

function currentSlices() {
  const st = S.stats;
  if (!st) return { slices: [], total: 0, label: '' };
  if (S.statsTab === 'on') return { slices: st.on, total: st.onSecs, label: '自律模式已开启' };
  if (S.statsTab === 'off') return { slices: st.off, total: st.offSecs, label: '自律模式未开启' };
  const m = mergeSlices(st.on, st.off);
  return { slices: m, total: st.onSecs + st.offSecs, label: '两种状态汇总' };
}

function viewStats() {
  const st = S.stats;
  const cur = currentSlices();
  const hourly = st ? (S.statsTab === 'off' ? st.offHourly : S.statsTab === 'all'
    ? st.onHourly.map((v, i) => v + st.offHourly[i]) : st.onHourly) : new Array(24).fill(0);
  const maxH = Math.max(1, ...hourly);

  const ranges = [['today', '今日'], ['week', '本周'], ['month', '本月'], ['year', '今年'], ['custom', '自定义']];
  const segs = [
    ['on', '自律模式已开启', 'gold'],
    ['off', '自律模式未开启', ''],
    ['all', '两种状态汇总', ''],
  ];

  const rows = cur.slices.length
    ? cur.slices.slice(0, 30).map((s, i) => `<tr>
        <td><span class="badge ${s.category === 'site' ? 'blue' : 'gold'}">${s.category === 'site' ? '网页' : '软件'}</span></td>
        <td>${esc(s.label)}</td>
        <td class="tnum">${fmtDur(s.secs)}</td>
        <td class="tnum muted">${cur.total ? ((s.secs / cur.total) * 100).toFixed(1) : '0.0'}%</td>
      </tr>`).join('')
    : '';

  return `
  <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
    <div class="seg">
      ${segs.map(([k, n, c]) => `<button class="${S.statsTab === k ? 'active ' + c : ''}" data-act="stats-tab" data-tab="${k}">${n}</button>`).join('')}
    </div>
    <div class="hint">当前状态：<b>${S.data && S.data.runtime.disciplineOn ? '自律模式已开启' : '自律模式未开启'}</b></div>
  </div>

  <div class="range-row">
    ${ranges.map(([k, n]) => `<button class="chip-btn ${S.range === k ? 'active' : ''}" data-act="range" data-r="${k}">${n}</button>`).join('')}
    ${S.range === 'custom' ? `<input type="date" id="cStart" value="${esc(S.customStart || todayStr())}"/>
      <span class="muted">至</span>
      <input type="date" id="cEnd" value="${esc(S.customEnd || todayStr())}"/>
      <button class="btn btn-sm" data-act="range-apply">应用</button>` : ''}
    <span class="muted" id="rangeLabel" style="margin-left:auto;font-size:11.5px">${st ? st.start + ' ~ ' + st.end : ''}</span>
    <button class="btn btn-sm" data-act="stats-refresh">刷新</button>
  </div>

  <div class="card">
    <div class="card-title">
      使用时长分布 · ${cur.label}
      <span class="badge">合计 ${fmtDur(cur.total)}</span>
    </div>
    <div class="card-sub">
      ${S.statsTab === 'on'
        ? '这里<b>只统计自律模式开启时段</b>内的前台使用时长，与"未开启"的数据完全隔离。'
        : S.statsTab === 'off'
          ? '这里<b>只统计自律模式未生效时段</b>内的前台使用时长，与"已开启"的数据完全隔离。'
          : '汇总口径：把「已开启」与「未开启」两个数据集里<b>同一个应用 / 同一个域名</b>的秒数直接相加，不做任何加权；扇区大小 = 该项在所选时间段内的前台使用总时长占比。'}
    </div>
    ${cur.slices.length ? `
    <div class="chart-wrap">
      <canvas id="pie" width="280" height="280"></canvas>
      <div class="legend" id="legend"></div>
    </div>` : `<div class="empty">这个时间段还没有数据。<br>统计每秒采样一次前台窗口，用一会儿就会有了。</div>`}
  </div>

  ${cur.slices.length ? `
  <div class="card">
    <div class="card-title">24 小时分布</div>
    <div class="card-sub">每个小时累计的秒数，可以看出你在什么时间最投入。</div>
    <div class="hourly">
      ${hourly.map((v) => `<div class="hbar ${v === 0 ? 'zero' : ''}" style="height:${Math.max(1, (v / maxH) * 100)}%" title="${Math.round(v / 60)} 分钟"></div>`).join('')}
    </div>
    <div class="hlabels">${Array.from({ length: 24 }, (_, i) => `<span>${i}</span>`).join('')}</div>
  </div>

  <div class="card">
    <div class="card-title">明细（前 30 项）</div>
    <table class="tbl">
      <thead><tr><th style="width:70px">类型</th><th>名称</th><th style="width:120px">时长</th><th style="width:90px">占比</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>` : ''}

  <div class="note" style="margin-top:14px">
    <b>采集口径：</b>每秒采样一次前台窗口。若前台是受支持的浏览器、且插件在 5 分钟内上报过当前标签页，
    这一秒记到<b>该域名</b>上；否则记到<b>该 exe</b>上。无操作超过 60 秒不计时（可在设置里改）。
    日文件按小时分桶，可回溯到"某天某小时"。
  </div>`;
}

/* ---------------- 视图：统计报告 ---------------- */
function viewReports() {
  const d = S.data;
  const s = d ? d.config.settings.stats : {};
  const list = S.reports.length
    ? S.reports.map((r) => `<div class="rep-item" data-act="open-report" data-id="${r.id}">
        <span class="badge ${r.period === 'daily' ? 'gold' : r.period === 'weekly' ? 'blue' : 'green'}">${
          { daily: '日报', weekly: '周报', monthly: '月报', yearly: '年报', custom: '自定义' }[r.period] || r.period}</span>
        <div style="flex:1">
          <div class="ttl">${esc(r.title)}</div>
          <div class="sub">${r.start} ~ ${r.end} · 生成于 ${new Date(r.created * 1000).toLocaleString()}</div>
        </div>
        <div style="text-align:right">
          <div class="tnum" style="font-size:13px">${fmtDur(r.onSecs + r.offSecs)}</div>
          <div class="sub">开启 ${fmtDurShort(r.onSecs)} · 未开启 ${fmtDurShort(r.offSecs)}</div>
        </div>
      </div>`).join('')
    : '<div class="empty">还没有生成过报告。<br>开启下面的自动生成，或者点「立即生成」。</div>';

  const sw = (k, v, t, sub) => `<div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #1a202c">
      <div><div style="font-size:12.5px">${t}</div><div class="hint" style="margin-top:3px">${sub}</div></div>
      <div class="switch" data-act="stat-toggle" data-k="${k}"><input type="checkbox" ${v ? 'checked' : ''}><i></i></div>
    </div>`;

  return `
  <div class="card">
    <div class="card-title">自动生成设置</div>
    <div class="card-sub">
      报告在周期结束后的<b>第一个 00:00 自动生成</b>（程序没开着的话，下次启动会补齐）。
      生成的报告不会自动删除，除非超过「数据保留天数」。
    </div>
    ${sw('autoDaily', s.autoDaily, '每日报告', '每天 00:00 生成前一天的日报')}
    ${sw('autoWeekly', s.autoWeekly, '每周报告', '每周一 00:00 生成上周（周一 ~ 周日）的周报')}
    ${sw('autoMonthly', s.autoMonthly, '每月报告', '每月 1 日 00:00 生成上个月的月报')}
    ${sw('autoYearly', s.autoYearly, '每年报告', '每年 1 月 1 日生成上一年的年报')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div>
        <div style="font-size:12.5px">自定义周期</div>
        <div class="hint" style="margin-top:3px">每 N 天生成一次，从锚点日算起，报告覆盖上一个完整 N 天</div>
      </div>
      <div class="row" style="align-items:center;gap:8px">
        <span class="hint">每</span>
        <input type="number" id="customDays" min="0" max="365" value="${s.customDays || 0}" style="width:76px" />
        <span class="hint">天</span>
        <button class="btn btn-sm" data-act="save-custom-days">保存</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
      <div>
        <div class="card-title" style="margin:0">历史报告</div>
        <div class="hint" style="margin-top:4px">保留在本地，随时可以回看</div>
      </div>
      <div class="row" style="gap:8px">
        <select id="genPeriod">
          <option value="daily">日报</option>
          <option value="weekly">周报</option>
          <option value="monthly">月报</option>
          <option value="yearly">年报</option>
        </select>
        <button class="btn btn-primary btn-sm" data-act="gen-report">立即生成</button>
        <button class="btn btn-sm" data-act="reports-refresh">刷新</button>
      </div>
    </div>
    <div>${list}</div>
  </div>

  <div class="note" style="margin-top:14px">
    <b>存储方式：</b>全部数据都在软件目录下的 <code>king of focus data</code> 里 —— 原始日数据存
    <code>stats\\days\\</code>（一天一个 JSON，按小时分桶）；报告存 <code>stats\\reports\\</code>
    （一份报告一个 JSON，含两种状态各自的扇区数据）。
    默认保留 <b>${s.retentionDays || 400} 天</b>，可在设置里调整。报告可以随时点开回看，也可以手动删除。
    <div class="hint" style="margin-top:8px;word-break:break-all">当前路径：${esc(d.dataPath || '')}</div>
    <div style="margin-top:10px"><button class="btn btn-sm" data-act="open-stats-dir">打开数据目录</button></div>
  </div>`;
}

/* ---------------- 视图：云同步 ---------------- */
function viewSync() {
  const d = S.data;
  if (!d) return '';
  const sy = d.config.settings.sync || {};
  const last = sy.lastSync ? new Date(sy.lastSync * 1000).toLocaleString() : '从未同步';
  const err = sy.lastError || '';
  const okMsg = sy.lastResult || '';

  return `
  <div class="card">
    <div class="card-title">WebDAV 云同步</div>
    <div class="card-sub">
      把<b>规则与设置</b>同步到你自己的网盘（坚果云 / Nextcloud / 群晖 / 阿里云盘 WebDAV 等）。
      统计原始数据<b>不会</b>上传，避免动辄几十 MB 的日文件把网盘撑爆。
    </div>

    <div style="display:grid;grid-template-columns:1fr;gap:12px;max-width:640px">
      <div>
        <div class="hint" style="margin-bottom:6px">WebDAV 目录地址</div>
        <input type="text" id="davUrl" style="width:100%" value="${esc(sy.url || '')}"
          placeholder="https://dav.jianguoyun.com/dav/KingOfFocus/" />
      </div>
      <div class="row">
        <div style="flex:1">
          <div class="hint" style="margin-bottom:6px">账号</div>
          <input type="text" id="davUser" style="width:100%" value="${esc(sy.username || '')}" placeholder="邮箱 / 用户名" />
        </div>
        <div style="flex:1">
          <div class="hint" style="margin-bottom:6px">密码 / 应用密码</div>
          <input type="password" id="davPass" style="width:100%" value="${esc(sy.password || '')}" placeholder="••••••••" />
        </div>
      </div>
      <div class="row" style="align-items:center;gap:18px">
        <label class="row" style="align-items:center;gap:8px;cursor:pointer">
          <div class="switch" data-act="sync-auto"><input type="checkbox" ${sy.auto ? 'checked' : ''}><i></i></div>
          <span style="font-size:12.5px">自动同步</span>
        </label>
        <div class="row" style="align-items:center;gap:8px">
          <span class="hint">每</span>
          <input type="number" id="davMins" value="${sy.autoMinutes || 30}" min="5" max="1440" style="width:82px" />
          <span class="hint">分钟</span>
        </div>
      </div>
      <div class="row">
        <button class="btn btn-primary" data-act="sync-save">保存配置</button>
        <button class="btn" data-act="sync-now" ${sy.url ? '' : 'disabled'}>立即同步</button>
        <button class="btn" data-act="sync-up" ${sy.url ? '' : 'disabled'}>上传本机 → 云端</button>
        <button class="btn" data-act="sync-down" ${sy.url ? '' : 'disabled'}>云端 → 覆盖本机</button>
      </div>
    </div>

    <div class="note" style="margin-top:18px">
      <b>上次同步：</b>${esc(last)}<br>
      ${err ? `<b style="color:var(--red)">失败：</b>${esc(err)}` : okMsg ? `<b style="color:var(--green)">结果：</b>${esc(okMsg)}` : '<span class="muted">还没有同步记录</span>'}
    </div>
  </div>

  <div class="card">
    <div class="card-title">本地备份 <span class="badge">${(S.backups || []).length} 份</span></div>
    <div class="card-sub">
      存在软件目录下的 <code>king of focus back</code>，写盘前就加密：设了密码用 AES-256-GCM（可跨机恢复），
      没设密码用本机 Windows DPAPI。只保留最近 10 份、且 7 天内的。
    </div>
    <div class="row" style="gap:9px;flex-wrap:wrap;margin-bottom:14px">
      <button class="btn btn-primary btn-sm" data-act="backup-make">立即备份</button>
      <button class="btn btn-sm" data-act="backup-dir">打开备份目录</button>
    </div>
    <div class="row" style="align-items:center;gap:9px;margin-bottom:14px;flex-wrap:wrap">
      <span class="hint" style="width:74px">备份密码</span>
      <input type="password" id="bkPass" style="flex:1;max-width:280px"
        placeholder="${(d.config.settings.backup || {}).password ? '已设置（留空 = 不修改）' : '留空 = 用本机 DPAPI 加密'}" />
      <label class="row" style="align-items:center;gap:6px;font-size:11.5px;cursor:pointer">
        <input type="checkbox" id="bkAuto" ${(d.config.settings.backup || {}).autoOnStart ? 'checked' : ''} /> 启动时自动备份
      </label>
      <button class="btn btn-sm" data-act="backup-pass">保存</button>
    </div>
    ${(S.backups || []).length ? (S.backups || []).map((f) => `<div class="list-row">
        <span class="badge gold">${esc(f.name)}</span>
        <span class="grow muted" style="font-size:10.5px">${new Date((f.mtime || 0) * 1000).toLocaleString()} · ${Math.round((f.size || 0) / 1024)} KB</span>
        <button class="btn btn-sm" data-act="backup-restore" data-path="${esc(f.path)}">恢复</button>
        <button class="x" data-act="backup-del" data-path="${esc(f.path)}">×</button>
      </div>`).join('') : '<div class="empty">还没有本地备份。点「立即备份」生成第一份。</div>'}
  </div>

  <div class="card">
    <div class="card-title">云端备份</div>
    <div class="card-sub">
      把加密后的备份传到上面的 WebDAV 目录，可以列出历史版本任选一份恢复。
      保留策略和本地一致：最近 10 份、7 天内。
    </div>
    <div class="row" style="gap:9px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" data-act="cloud-upload" ${sy.url ? '' : 'disabled'}>上传当前配置</button>
      <button class="btn btn-sm" data-act="cloud-list" ${sy.url ? '' : 'disabled'}>查看云端备份 / 恢复</button>
    </div>
    ${sy.url ? '' : '<div class="hint" style="margin-top:10px">先在下面填写 WebDAV 地址</div>'}
  </div>

  <div class="card">
    <div class="card-title">同步规则</div>
    <div class="card-sub">冲突时不会静默丢掉任何一边。</div>
    <div class="hint" style="line-height:2">
      · 每份配置都带 <code>updatedAt</code> 时间戳，同步时<b>新的覆盖旧的</b>（last-write-wins）。<br>
      · 「立即同步」会先读云端再比较：云端新就下载，本机新就上传，一样就跳过。<br>
      · 「云端 → 覆盖本机」是强制拉取，会丢掉本机未上传的改动，请谨慎使用。<br>
      · 账号密码只保存在本机配置文件里，不随配置上传。<br>
      · 常见地址格式：坚果云 <code>https://dav.jianguoyun.com/dav/目录/</code>、
        Nextcloud <code>https://你的域名/remote.php/dav/files/用户名/目录/</code>。
    </div>
  </div>`;
}

/* ---------------- 视图：关于 / 开发者 ---------------- */
function viewAbout() {
  const d = S.data;
  if (!d) return '';
  const st = d.config.settings.update || {};
  const hasToken = !!d.hasToken;
  const quotaTxt = S.quota ? (S.quota.ok ? `${S.quota.remaining} / ${S.quota.limit}` : '读取失败') : '读取中…';

  return `
  <div class="mask-hero" style="align-items:center">
    <div style="display:flex;gap:18px;align-items:center">
      <div class="brand-mark" style="width:72px;height:72px;border-radius:20px"><img src="logo.png" alt="" /></div>
      <div>
        <div style="font-size:22px;font-weight:700;letter-spacing:.3px">${esc(d.appName || 'King of Focus')}</div>
        <div class="hint" style="margin-top:6px">
          版本 <b style="color:var(--gold)">v${esc(d.version)}</b>
          <span class="muted">·</span> 本版本更新时间 <b>${esc(d.buildDate)}</b>
        </div>
      </div>
    </div>
    <div style="text-align:right">
      <div class="hint">开发者</div>
      <div style="font-size:16px;font-weight:600;margin-top:4px">${esc(d.developer)}</div>
    </div>
  </div>

  <div class="card" style="margin-top:14px">
    <div class="card-title">项目</div>
    <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0">
      <div>
        <div style="font-size:12.5px">项目地址</div>
        <div class="hint" style="margin-top:4px">点击可直接在浏览器中打开</div>
      </div>
      <a href="#" data-act="open-repo" style="color:var(--gold);font-size:12.5px;text-decoration:none">${esc(d.repoUrl)} ↗</a>
    </div>
    <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid #1a202c">
      <div><div style="font-size:12.5px">配置文件</div><div class="hint" style="margin-top:4px">${esc(d.configPath)}</div></div>
      <button class="btn btn-sm" data-act="open-cfg">打开</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">自动更新</div>
    <div class="card-sub">启动时检查 GitHub Releases，有新版本会弹窗提示；下载完成后自动退出、安装并重新启动。</div>

    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #1a202c">
      <div>
        <div style="font-size:12.5px">启动时检查更新</div>
        <div class="hint" style="margin-top:3px">最近一次检查：${st.lastCheck ? new Date(st.lastCheck * 1000).toLocaleString() : '还没检查过'}</div>
      </div>
      <div class="switch" data-act="update-enabled"><input type="checkbox" ${st.enabled ? 'checked' : ''}><i></i></div>
    </div>

    <div style="padding:12px 0;border-bottom:1px solid #1a202c">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
        <div>
          <div style="font-size:12.5px">GitHub 个人访问令牌</div>
          <div class="hint" style="margin-top:3px">填了可以提升 API 额度（未登录 60 次/小时，登录后 5000 次/小时）</div>
        </div>
        <div class="badge ${S.quota && S.quota.ok && S.quota.remaining > 100 ? 'green' : 'red'}">
          剩余额度 ${esc(quotaTxt)}
        </div>
      </div>
      <div class="add-row" style="margin-bottom:0">
        <input type="password" id="ghToken" placeholder="${hasToken ? '已设置（留空则不修改）' : '粘贴 ghp_ 开头的令牌'}" autocomplete="off" spellcheck="false" />
        <button class="btn" data-act="token-doc" title="如何获取令牌">?</button>
        <button class="btn btn-primary" data-act="save-token">保存</button>
        <button class="btn btn-sm" data-act="quota-refresh">刷新额度</button>
        ${hasToken ? '<button class="btn btn-sm btn-danger" data-act="clear-token">清除</button>' : ''}
      </div>
      <div class="hint" style="margin-top:8px">
        令牌只保存在本机，界面上<b>不回显任何字符</b>，输入框始终是暗文。${hasToken ? '当前<b>已设置</b>。' : '当前<b>未设置</b>。'}点 <b>?</b> 打开 GitHub 官方教程。
      </div>
    </div>

    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div>
        <div style="font-size:12.5px">检查更新</div>
        <div class="hint" style="margin-top:3px">${st.skippedVersion ? '已跳过版本：' + esc(st.skippedVersion) : '当前没有跳过任何版本'}</div>
      </div>
      <div class="row" style="gap:8px">
        ${st.skippedVersion ? '<button class="btn btn-sm" data-act="clear-skip">取消跳过</button>' : ''}
        <button class="btn btn-primary btn-sm" data-act="check-update">立即检查</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- 更新弹窗 ---------------- */
function showUpdateModal(info, manual) {
  const a = info.asset || {};
  const size = a.size ? (a.size / 1024 / 1024).toFixed(1) + ' MB' : '未知大小';
  const notes = (info.notes || '').slice(0, 1200);
  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal">
      <div class="modal-hd">
        <h3>发现新版本 v${esc(info.latest)}</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="row" style="gap:10px;margin-bottom:14px">
          <span class="badge gold">当前 v${esc(info.current)}</span>
          <span class="badge green">最新 v${esc(info.latest)}</span>
          <span class="badge">${esc(size)}</span>
          ${a.name ? `<span class="badge blue">${esc(a.name)}</span>` : ''}
        </div>
        ${notes ? `<div class="note" style="max-height:220px;overflow:auto;white-space:pre-wrap">${esc(notes)}</div>`
                : '<div class="hint">这个版本没有写更新说明。</div>'}
        ${!a.url ? '<div class="note" style="border-left-color:var(--red);margin-top:12px">该版本还没有上传安装包，暂时无法自动更新。</div>' : ''}
        <div id="upProgressWrap" class="hidden" style="margin-top:16px">
          <div style="height:6px;background:#232a3a;border-radius:4px;overflow:hidden">
            <div id="upBar" style="height:100%;width:0;background:linear-gradient(90deg,#4d8dff,#2f6df0);transition:width .2s"></div>
          </div>
          <div class="hint" id="upText" style="margin-top:8px">准备下载…</div>
        </div>
      </div>
      <div class="modal-ft">
        ${manual ? '' : `<button class="btn" data-act="skip-version" data-v="${esc(info.latest)}">跳过这个版本</button>`}
        <button class="btn" data-act="close-modal">稍后提醒</button>
        <button class="btn btn-primary" data-act="do-update"
          data-url="${esc(a.url || '')}" data-name="${esc(a.name || 'KingOfFocus-Setup.exe')}">
          下载并安装
        </button>
      </div>
    </div>
  </div>`;
}

function setProgress(pct, text) {
  const w = $('#upProgressWrap');
  if (w) w.classList.remove('hidden');
  const b = $('#upBar');
  if (b) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
  const t = $('#upText');
  if (t && text) t.textContent = text;
}

/* ---------------- 自律结束 · 恭喜弹窗 ---------------- */
const PRAISE = [
  '你今天的样子，比昨天更像你想成为的人。',
  '这一段专注，已经赢了昨天刷手机的自己。',
  '能坐下来的人，最后都走得挺远。',
  '自律不是煎熬，是你终于开始对自己好。',
  '别人看不见的这段时间，会变成看得见的差距。',
  '你没有辜负这段时间，一次都没有。',
  '保持住——这已经是很多人做不到的事了。',
  '专注的每一分钟，都在给你攒底气。',
  '这就是「说到做到」的样子。',
  '很棒，真的。继续。',
  '你证明了自己能行，这比什么都重要。',
  '今天这一局，你赢了。',
  '安静的坚持最狠，你正在做这件事。',
  '没有白坐的，都在长成你的本事。',
];

function showCelebrate(c) {
  const secs = c.secs || 0;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  const dur = h > 0 ? `${h} 小时 ${m} 分` : `${Math.max(1, m)} 分钟`;
  const praise = PRAISE[Math.floor(Math.random() * PRAISE.length)];

  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="width:520px;text-align:center">
      <div class="modal-bd" style="padding:38px 34px 26px">
        <div style="font-size:44px;line-height:1;margin-bottom:14px">🎉</div>
        <div style="font-size:13px;color:var(--text-3);letter-spacing:2px">本 轮 完 成</div>
        <div style="font-size:30px;font-weight:750;margin:12px 0 4px;color:var(--gold);font-variant-numeric:tabular-nums">
          ${dur}
        </div>
        <div style="font-size:12.5px;color:var(--text-2);margin-bottom:22px">
          ${esc(c.rules || '自律规则')} · 全程没有破功
        </div>
        <div class="note" style="text-align:left;font-size:13px;line-height:1.9">
          ${esc(praise)}
        </div>
        <div class="hint" style="margin-top:16px">
          这一段的专注已经换成积分，去「总览」看看你现在攒了多少。
        </div>
      </div>
      <div class="modal-ft" style="justify-content:center">
        <button class="btn btn-primary" data-act="close-modal">继续加油</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- 视图：帮助 ---------------- */
function viewHelp() {
  const d = S.data;
  const v = d ? d.version : '0.0.1';
  const dt = d ? d.buildDate : '';
  const sec = (t, body) => `<div class="card">
      <div class="card-title">${t}</div>
      <div class="card-sub" style="margin-bottom:8px">${body}</div>
    </div>`;

  return `
  <div class="note" style="margin-bottom:16px">
    <b>使用手册</b> · 与 v${esc(v)} 同步更新（${esc(dt)}）。改动了功能，这一页会跟着一起改。
  </div>

  ${sec('1 · 三步开始', `
    ① 到「规则」新建一条规则 → ② 加软件 / 加网站 → ③ 在「时间表」里拖出你要的时段。
    打开规则开关，到了时段它就会自己开始拦；不在时段内完全静默。
  `)}

  ${sec('2 · 规则、时间表与生效', `
    一条规则 = 一份名单 + 一张周时间表。<b>时间表全空 = 全天生效</b>；否则只在画出来的格子里生效。
    时间表按周循环，下周自动重复；要让每天一样，就在「时间表」里点「周一 → 全部」。
    黑名单 = 名单里的不许开；强制模式 = 只有名单里的能开，其他前台窗口都会被关。
  `)}

  ${sec('3 · 番茄与提醒', `
    规则里可以设「专注 N 分钟 / 休息 M 分钟」，循环锚点是从该时段的起点开始算。
    休息期间这条规则不拦截，时间到自动锁回。<br>
    提醒在「设置 → 提醒」：学习结束前 X 分钟、休息结束前 Y 分钟各响一次（0~120 分钟，0 = 不发），
    休息提醒可以单独关。触发时主界面弹提示、HUD 上的倒计时变金色闪烁。
  `)}

  ${sec('4 · 固化与积分', `
    「固化」打开后，生效期间不能退出程序、不能改任何设置，任务管理器会被自动关掉；
    进程被杀掉会被守护进程在 2 秒内拉回来。<br>
    解除只有两条路：<b>时段结束</b> 或 <b>用积分解锁</b>。
    专注每分钟 +1 分，解锁单价 15 分/分钟、当天第 n 次 ×1.4。
    <br>注意：时间表留空（全天生效）的规则不会触发固化，否则会把自己永久锁死。
  `)}

  ${sec('5 · 专注遮罩', `
    选一个目标窗口，其余区域被遮罩盖住，遮罩从窗口边缘扩散到铺满整块显示器。
    透明度 / 留白 / 圆角 / 动画时长都能实时调。<br>
    两种开启方式：全局快捷键（默认 <b>Ctrl+Alt+K</b>，可在遮罩页改，被占用会报错）；
    或者「进入指定应用自动开启」——切到这些应用就自己盖、切走自动关。
  `)}

  ${sec('6 · 统计与报告', `
    每秒采样一次前台窗口；按「自律模式开启 / 未开启」两套数据独立记录，互不混合。
    前台是浏览器且插件上报过，就记到域名上，否则记到 exe 上。<br>
    报告在日/周/月/年结束后自动生成（程序没开会下次启动补齐），也可以手动生成。
    三种口径：只看开启、只看未开启、两者汇总（同一应用/域名秒数直接相加）。
  `)}

  ${sec('7 · 备份与云同步', `
    本地备份在软件目录下的 <code>king of focus back</code>，写盘前加密（设了密码用 AES-256-GCM，
    没设密码用本机 DPAPI）。只保留最近 10 份、7 天内的，超出自动删。<br>
    云端备份走你自己的 WebDAV：上传后可以列出所有历史版本，任选一份恢复。
    「立即同步」只同步规则和设置，不做版本归档。
  `)}

  ${sec('8 · 常见问题', `
    <b>拦截没反应？</b> 目标程序是管理员权限，就右键以管理员身份运行本程序。<br>
    <b>网页没拦住？</b> 插件没装或没连上，看侧边栏「浏览器插件」状态。<br>
    <b>想临时放过自己？</b> 用「总览 → 积分兑换」解锁，或者把规则开关关掉（固化了就关不掉）。<br>
    <b>数据在哪？</b> 全在软件目录的 <code>king of focus data</code>，整个文件夹拷走就能迁移。
  `)}

  <div class="row" style="gap:9px;margin-top:4px">
    <button class="btn" data-act="open-repo">查看项目主页</button>
    <button class="btn" data-act="open-cfg">打开配置目录</button>
  </div>`;
}

/* ---------------- 视图：设置 ---------------- */
/* ---------------- 浏览器插件 ---------------- */

/// 设置页通用的开关行（viewSettings 里那个 sw 是局部函数，这里需要一份全局的）
function cfgSwitchRow(k, v, title, sub) {
  return `<div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">${title}</div><div class="hint" style="margin-top:3px">${sub}</div></div>
      <div class="switch" data-act="cfg-switch" data-k="${k}"><input type="checkbox" ${v ? 'checked' : ''}><i></i></div>
    </div>`;
}

function browserMeta(ext) {
  if (ext === 'enabled') return { txt: '插件已启用', cls: 'green' };
  if (ext === 'disabled') return { txt: '插件被停用', cls: 'gold' };
  if (ext === 'unsupported') return { txt: '不支持本插件', cls: '' };
  return { txt: '插件未安装', cls: 'red' };
}

function viewBrowsers() {
  const d = S.data;
  if (!d) return '';
  const list = (d.browsers || []) || [];
  const g = (d.config.settings.browserGuard) || { enabled: true, notify: true, graceMs: 1200, detectOnStart: true };
  const installed = list.filter((b) => b.installed);
  const broken = installed.filter((b) => b.ext === 'notInstalled' || b.ext === 'disabled');
  const ok = installed.filter((b) => b.ext === 'enabled');

  const rows = list.length
    ? list.map((b) => {
      const m = browserMeta(b.ext);
      const canInstall = b.installed && (b.ext === 'notInstalled' || b.ext === 'disabled');
      const act = !b.installed
        ? '<span class="muted" style="font-size:12px">未安装</span>'
        : b.ext === 'unsupported'
          ? '<span class="muted" style="font-size:12px">无需安装</span>'
          : canInstall
            ? `<button class="btn btn-sm btn-primary" data-act="browser-install" data-k="${b.key}">${b.ext === 'disabled' ? '去启用' : '安装插件'}</button>
               <button class="btn btn-sm" data-act="browser-page" data-k="${b.key}">扩展页</button>`
            : `<button class="btn btn-sm" data-act="browser-page" data-k="${b.key}">扩展页</button>`;
      const hits = (b.hits || []).length
        ? `<div class="hint">命中配置档：${b.hits.map((h) => `${esc(h.profile)}（${h.enabled ? '启用' : '停用'}）`).join('、')}</div>`
        : '';
      return `<div class="brow">
        <div class="brow-ico">${b.installed ? '◉' : '○'}</div>
        <div class="brow-main">
          <div class="brow-name">
            <span class="bname">${esc(b.name)}</span>
            <span class="badge ${b.installed ? 'green' : ''}">${b.installed ? '已安装' : '未安装'}</span>
            ${b.installed ? `<span class="badge ${m.cls}">${m.txt}</span>` : ''}
            ${b.running ? '<span class="badge blue">运行中</span>' : ''}
          </div>
          <div class="hint">${esc(b.note || '')}</div>
          ${hits}
        </div>
        <div class="brow-act">${act}</div>
      </div>`;
    }).join('')
    : '<div class="empty">还没检测。点右上角「重新检测」。</div>';

  const sum = !list.length
    ? '正在检测…'
    : installed.length
      ? `已安装 ${installed.length} 个浏览器，${ok.length} 个插件就绪${broken.length ? `，${broken.length} 个需要处理` : ''}`
      : '这台机器上没有检测到受支持的浏览器';

  return `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <div class="card-title">浏览器与配套插件</div>
        <div class="card-sub">${esc(sum)}</div>
      </div>
      <button class="btn btn-sm" data-act="browser-scan" ${S.browserScanning ? 'disabled' : ''}>${S.browserScanning ? '检测中…' : '重新检测'}</button>
    </div>
    ${broken.length ? `<div class="note" style="border-left-color:var(--gold);margin:12px 0 4px">
      <b>有 ${broken.length} 个浏览器的插件没就绪。</b>自律时段里打开它们会被自动关闭——先把插件装上或启用，才不会被拦。
      <div style="margin-top:8px"><button class="btn btn-sm btn-primary" data-act="browser-guide">安装引导</button></div>
    </div>` : ''}
    ${extFolderPanel(d.extInfo)}
    <div style="margin-top:6px">${rows}</div>
  </div>

  <div class="card">
    <div class="card-title">自律时段守护</div>
    <div class="card-sub">
      自律时间（任意规则处于生效状态）里，只要你打开浏览器而插件没装或被停用，会在
      <b>5 秒内</b>自动关闭它，并记一条拦截记录。装了插件且已启用则完全不受影响。
    </div>
    ${cfgSwitchRow('browserGuard.enabled', g.enabled, '启用浏览器巡检', '关闭后，自律时段里不会因为插件状态而关浏览器')}
    ${cfgSwitchRow('browserGuard.notify', g.notify, '关闭前弹提示', '先弹一张卡片说明原因和剩余秒数，再关闭')}
    ${cfgSwitchRow('browserGuard.detectOnStart', g.detectOnStart, '启动时自动检测', '每次打开软件都识别一遍浏览器与插件状态')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div>
        <div style="font-size:12.5px">关闭前宽限</div>
        <div class="hint" style="margin-top:3px">留给你的反应时间；加上轮询间隔后总耗时不超过 5 秒（上限 3500ms）</div>
      </div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="bgGrace" value="${g.graceMs}" min="300" max="3500" step="100" style="width:96px" />
        <span class="hint">毫秒</span>
        <button class="btn btn-sm" data-act="browser-grace-save">保存</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">判定与检测说明</div>
    <div class="card-sub">以下都是实际实现口径，不是宣传语。</div>
    <div class="note" style="line-height:1.95">
      <b>支持范围</b>：Chrome、Edge、Brave、Vivaldi、Opera、Chromium、360 极速、QQ 浏览器、搜狗高速
      （这些都能装本插件）；Firefox 会被识别出来，但它不支持 Chromium 扩展，所以只显示、不参与拦截。<br>
      <b>状态判定</b>：读各浏览器用户目录下每个配置档的 <code>Preferences</code>，
      在 <code>extensions.settings</code> 里按扩展名找到本插件：
      完全找不到 = <b>未安装</b>；找到且 <code>state=1</code> 且没有 <code>disable_reasons</code> = <b>已启用</b>；
      找到但被停用 = <b>被停用</b>。<br>
      <b>检测频率</b>：启动时全量扫一次；之后后台每 20 秒刷新一次缓存；打开本页或点「重新检测」立即扫。
      自律时段里每个轮询周期（默认 1 秒）都会用最新缓存判定一次。<br>
      <b>关闭失败</b>：先发关闭信号，0.4 秒不退再强制结束；如果仍失败（多半是浏览器以管理员运行、而本程序不是），
      会记一条「关闭失败」，每 60 秒重试一次，并提示你以管理员身份运行。<br>
      <b>点了安装之后</b>：会给 10 分钟保护期，这期间不会因为插件状态去关浏览器，避免你正开着扩展管理页就被关掉。
    </div>
  </div>`;
}
function viewSettings() {
  const d = S.data;
  if (!d) return '';
  const st = d.config.settings;
  const sw = (k, v, t, sub) => `<div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #1a202c">
      <div><div style="font-size:12.5px">${t}</div><div class="hint" style="margin-top:3px">${sub}</div></div>
      <div class="switch" data-act="cfg-switch" data-k="${k}"><input type="checkbox" ${v ? 'checked' : ''}><i></i></div>
    </div>`;

  return `
  ${!d.admin ? `<div class="note" style="border-left-color:var(--red);margin-bottom:14px">
    <b>当前不是管理员权限。</b>拦截普通程序没问题，但要关掉以管理员身份运行的程序（比如某些游戏、安装程序）会失败。
    <div style="margin-top:8px"><button class="btn btn-sm btn-danger" data-act="restart-admin">以管理员身份重启</button></div>
  </div>` : ''}

  <div class="card">
    <div class="card-title">外观</div>
    <div class="card-sub">「跟随系统」会实时响应 Windows 的浅色 / 深色切换，不用重启。</div>
    <div class="seg">
      <button class="${(st.theme || 'system') === 'system' ? 'active gold' : ''}" data-act="theme" data-v="system">跟随系统</button>
      <button class="${st.theme === 'light' ? 'active gold' : ''}" data-act="theme" data-v="light">浅色</button>
      <button class="${st.theme === 'dark' ? 'active gold' : ''}" data-act="theme" data-v="dark">深色</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">拦截行为</div>
    <div class="card-sub">这些设置对所有规则生效。</div>
    ${sw('dryRun', st.dryRun, '演练模式', '只记录不真的关闭，用来先验证名单是否写对了')}
    ${sw('softClose', st.softClose, '先温和关闭', '先给程序发关闭信号，0.7 秒不退再强制结束，能保住一部分现场')}
    ${sw('siteCloseBrowser', st.siteCloseBrowser, '网页被拦时关闭整个浏览器', '开：命中黑名单网页先弹通知，然后把整个浏览器窗口关掉；关：只关掉那一个标签页')}
    ${sw('guardBrowser', st.guardBrowser, '浏览器守护', '要拦网页时，如果插件失联，直接关掉浏览器（需先装插件）')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #1a202c">
      <div><div style="font-size:12.5px">扫描间隔</div><div class="hint" style="margin-top:3px">越小越灵敏，占用也越高</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="pollMs" value="${st.pollMs}" min="300" max="5000" step="100" style="width:90px" />
        <span class="hint">毫秒</span>
        <button class="btn btn-sm" data-act="save-num" data-k="pollMs">保存</button>
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div><div style="font-size:12.5px">插件心跳容忍</div><div class="hint" style="margin-top:3px">超过这个时间没收到插件心跳，就认为插件被停用了</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="graceSecs" value="${st.graceSecs}" min="20" max="600" style="width:90px" />
        <span class="hint">秒</span>
        <button class="btn btn-sm" data-act="save-num" data-k="graceSecs">保存</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">使用时长统计</div>
    <div class="card-sub">统计只存在本机，不上传任何数据。</div>
    ${sw('statsEnabled', d.config.settings.stats.enabled, '启用统计', '关闭后不再采样，已有数据保留')}
    ${sw('countIdle', d.config.settings.stats.countIdle, '计入无操作时间', '关掉时，超过 60 秒没碰键鼠就不计时')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div><div style="font-size:12.5px">数据保留天数</div><div class="hint" style="margin-top:3px">超期的日文件与报告会在启动时清理</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="retentionDays" value="${d.config.settings.stats.retentionDays}" min="30" max="3650" style="width:96px" />
        <span class="hint">天</span>
        <button class="btn btn-sm" data-act="save-num" data-k="retentionDays">保存</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">提醒</div>
    <div class="card-sub">
      每个「自律周期」和每段「休息」结束前各提醒一次：主界面弹提示，HUD 上对应的倒计时会变金色闪烁。
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #1a202c">
      <div><div style="font-size:12.5px">启用提醒</div><div class="hint" style="margin-top:3px">总开关，关掉后两种提醒都不发</div></div>
      <div class="switch"><input type="checkbox" id="ntEnabled" ${(d.config.settings.notify || {}).enabled ? 'checked' : ''}><i></i></div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #1a202c">
      <div><div style="font-size:12.5px">学习结束前提醒</div><div class="hint" style="margin-top:3px">0 = 不提醒；范围 0~120 分钟</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="ntWork" min="0" max="120" value="${(d.config.settings.notify || {}).workBefore ?? 5}" style="width:88px" />
        <span class="hint">分钟</span>
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #1a202c">
      <div><div style="font-size:12.5px">休息结束前提醒</div><div class="hint" style="margin-top:3px">范围 0~120 分钟</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="ntBreak" min="0" max="120" value="${(d.config.settings.notify || {}).breakBefore ?? 2}" style="width:88px" />
        <span class="hint">分钟</span>
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div><div style="font-size:12.5px">休息也提醒</div><div class="hint" style="margin-top:3px">关掉后只提醒学习结束，休息结束不打扰</div></div>
      <div class="row" style="align-items:center;gap:10px">
        <div class="switch"><input type="checkbox" id="ntBreakOn" ${(d.config.settings.notify || {}).breakNotify ? 'checked' : ''}><i></i></div>
        <button class="btn btn-sm" data-act="save-notify">保存</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">桌面 HUD</div>
    <div class="card-sub">
      自律期间在屏幕右上角浮一个小窗：已经专注多久、还有多久结束，下面一句励志短语。
      窗口置顶、不进任务栏，跟着浅色/深色主题走。
    </div>
    ${sw('hudEnabled', (d.config.settings.hud || {}).enabled, '显示桌面 HUD', '自律时段自动出现，结束后自动隐藏')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div><div style="font-size:12.5px">短语切换间隔</div><div class="hint" style="margin-top:3px">联网取一句（一言），失败时用内置句子轮换</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="quoteMins" min="5" max="1440" value="${(d.config.settings.hud || {}).quoteMinutes || 60}" style="width:90px" />
        <span class="hint">分钟</span>
        <button class="btn btn-sm" data-act="save-quote-mins">保存</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">系统</div>
    ${sw('autostart', st.autostart, '开机自动启动', '写入 HKCU 的 Run 项，不需要管理员')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">测试模式
          ${d.testMode ? '<span class="badge gold" style="margin-left:6px">正在测试中</span>' : ''}
        </div>
        <div class="hint" style="margin-top:4px">
          所有功能（拦截、遮罩、统计、报告）都<b>真实生效</b>，唯一区别是自律模式可以随时开关。
          配置与统计写在独立目录，退出时可选「保留」或「丢弃」，都不会污染正式数据。
        </div>
      </div>
      ${d.testMode
        ? '<div class="row" style="gap:8px"><button class="btn btn-sm" data-act="test-exit-keep">退出并保留</button><button class="btn btn-sm btn-danger" data-act="test-exit-discard">退出并丢弃</button></div>'
        : '<button class="btn btn-sm btn-primary" data-act="test-enter">进入测试模式</button>'}
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">以管理员模式启动
          <span class="badge ${d.admin ? 'green' : 'red'}" style="margin-left:6px">${d.admin ? '当前已是管理员' : '当前是普通权限'}</span>
        </div>
        <div class="hint" style="margin-top:4px">
          打开后会弹 UAC 并重启成管理员。管理员权限下，遮罩可以<b>摘掉其他置顶浮窗的“总在最前”属性</b>，
          像 lazytyper 那种小横条会被一次性盖住，不再来回闪。
          同时也能拦住以管理员运行的程序。
        </div>
      </div>
      <div class="switch" data-act="cfg-switch" data-k="runAsAdmin"><input type="checkbox" ${st.runAsAdmin ? 'checked' : ''}><i></i></div>
    </div>
    ${sw('closeToTray', st.closeToTray, '关闭窗口时收进托盘', '拦截引擎在托盘里继续工作')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid #1a202c">
      <div><div style="font-size:12.5px">浏览器插件</div><div class="hint" style="margin-top:3px">在 Chrome / Edge 的扩展页打开"开发者模式"，载入已解压的扩展</div></div>
      <button class="btn btn-sm" data-act="open-ext">打开插件目录</button>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div><div style="font-size:12.5px">配置文件</div><div class="hint" style="margin-top:3px">${esc(d.configPath)}</div></div>
      <button class="btn btn-sm" data-act="open-cfg">打开目录</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">全局保护名单</div>
    <div class="card-sub">强制模式下，这些进程永远不会被拦截。用逗号分隔（进程名，不带 .exe）。</div>
    <textarea id="protectedList" style="width:100%;height:88px;background:#0e121b;border:1px solid var(--line-2);border-radius:8px;color:var(--text);padding:10px;font-size:12px;resize:vertical;user-select:text">${esc((st.protected || []).join(', '))}</textarea>
    <div style="margin-top:10px"><button class="btn btn-sm" data-act="save-protected">保存名单</button></div>
  </div>`;
}

/* ---------------- 饼图 ---------------- */
function drawPie(canvas, slices, total, opts) {
  if (!canvas) return;
  const size = 280;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  // 只画前 8 项，其余合并
  let items = slices.slice(0, 8).map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }));
  const rest = slices.slice(8).reduce((a, b) => a + b.secs, 0);
  if (rest > 0) items.push({ label: '其他', secs: rest, color: '#4a5468' });

  const sum = items.reduce((a, b) => a + b.secs, 0);
  const cx = size / 2, cy = size / 2, rOut = 118, rIn = 74;
  const cText = cssVar('--text');
  const cDim = cssVar('--text-3');
  const cStroke = cssVar('--panel-a');

  if (sum <= 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
    ctx.strokeStyle = cssVar('--line-2');
    ctx.lineWidth = rOut - rIn;
    ctx.stroke();
  } else {
    let ang = -Math.PI / 2;
    for (const it of items) {
      const a = (it.secs / sum) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rOut, ang, ang + a);
      ctx.arc(cx, cy, rIn, ang + a, ang, true);
      ctx.closePath();
      ctx.fillStyle = it.color;
      ctx.fill();
      ctx.strokeStyle = cStroke;
      ctx.lineWidth = 2;
      ctx.stroke();
      ang += a;
    }
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = cText;
  ctx.font = '600 19px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(opts && opts.center ? opts.center : fmtDurShort(total).replace('h', ' 小时 ').replace('m', ' 分'), cx, cy + 2);
  ctx.fillStyle = cDim;
  ctx.font = '11px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(opts && opts.sub ? opts.sub : '合计', cx, cy + 22);

  // HTML 图例
  const legend = $('#legend');
  if (legend) {
    legend.innerHTML = items.map((it) => `<div class="leg">
      <span class="sw" style="background:${it.color}"></span>
      <span class="nm" title="${esc(it.label)}">${esc(it.label)}${it.category === 'site' ? ' <span class="badge blue" style="font-size:9px;padding:1px 4px">网页</span>' : ''}</span>
      <span class="vv">${fmtDurShort(it.secs)}</span>
      <span class="pp">${sum ? ((it.secs / sum) * 100).toFixed(1) : 0}%</span>
    </div>`).join('');
  }
}

/* ---------------- 渲染调度 ---------------- */
function render() {
  if (!S.data && S.view !== 'reports') { $('#content').innerHTML = '<div class="empty">加载中…</div>'; return; }
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
  $('#pageTitle').textContent = VIEW_TITLES[S.view];

  let html = '';
  if (S.view === 'overview') html = viewOverview();
  if (S.view === 'rules') html = viewRules();
  if (S.view === 'clock') html = viewClock();
  if (S.view === 'mask') html = viewMask();
  if (S.view === 'browsers') html = viewBrowsers();
  if (S.view === 'stats') html = viewStats();
  if (S.view === 'reports') html = viewReports();
  if (S.view === 'sync') html = viewSync();
  if (S.view === 'settings') html = viewSettings();
  if (S.view === 'help') html = viewHelp();
  if (S.view === 'about') html = viewAbout();
  $('#content').innerHTML = html;

  if (S.view === 'stats') {
    const cur = currentSlices();
    drawPie($('#pie'), cur.slices, cur.total, { sub: '累计前台时长' });
  }
}

/* ---------------- 复制与扩展目录面板 ---------------- */

/** 给任意 Promise 加一个上限时间。有的系统调用（拉起浏览器 / 读别的浏览器配置）
 *  在特定环境下会卡很久，卡住时也必须给用户一个明确的结论，不能让界面停在"加载中"。 */
function withTimeout(p, ms, hint) {
  let tid = 0;
  const timeout = new Promise((_, rej) => {
    tid = setTimeout(() => rej(new Error(hint || '操作超时')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(tid));
}

/** 复制文本：优先 clipboard API，失败回退到隐藏 textarea + execCommand */async function copyText(text) {
  const t = String(text || '');
  if (!t) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (e) { /* 有些 webview 不给权限，走回退 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

/** 安装引导里的"扩展文件夹"面板：标题、路径、按钮各占一行，任何宽度都不会挤在一起 */
function extFolderPanel(info) {
  const i = info || (S.data && S.data.extInfo) || {};
  const exists = !!i.exists;
  return `<div class="ext-box">
    <div class="ext-head">
      <div class="ext-title">扩展文件夹</div>
      <span class="badge ${exists ? 'green' : 'red'}">${exists ? '目录已就绪' : '目录未找到'}</span>
    </div>
    <div class="ext-path" id="extPath">${esc(i.path || '（未知路径）')}</div>
    <div class="ext-actions">
      <button class="btn btn-sm btn-primary" data-act="ext-copy">复制路径</button>
      <button class="btn btn-sm" data-act="ext-open">打开文件夹</button>
    </div>
    <div class="hint" id="extNote">
      ${exists
        ? '在扩展管理页点「加载已解压的扩展程序」，把上面这个路径粘到地址栏回车后选中该文件夹即可。'
        : `这个路径下没找到 manifest.json。程序目录是 <code>${esc(i.exeDir || '')}</code>，${i.crx ? '同目录里还有 CRX 安装包，可以直接拖进扩展页。' : '请重新解压完整安装包，或到 GitHub 下载最新版。'}`}
    </div>
  </div>`;
}

/* ---------------- 启动时的浏览器巡检提示 ---------------- */
async function promptBrowserSetup() {
  if (S.data && S.data.config.settings.browserGuard && S.data.config.settings.browserGuard.detectOnStart === false) return;
  let list = [];
  try {
    const r = await invoke('browsers_scan');
    list = r.list || [];
    S.browsers = list;
  } catch (e) { return; }
  const broken = list.filter((b) => b.installed && (b.ext === 'notInstalled' || b.ext === 'disabled'));
  if (!broken.length) return;
  // 一次启动只弹一次：本次点"稍后再说"后不再打扰
  if (sessionStorage.getItem('kof-browser-prompt') === '1') return;
  sessionStorage.setItem('kof-browser-prompt', '1');

  const rows = broken.map((b) => `
    <div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)">
      <span>${esc(b.name)}</span>
      <span class="badge ${b.ext === 'disabled' ? 'gold' : 'red'}">${b.ext === 'disabled' ? '插件被停用' : '插件未安装'}</span>
    </div>`).join('');

  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal">
      <div class="modal-hd">
        <h3>浏览器插件还没就绪</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="note" style="margin-bottom:12px">
          检测到 <b>${broken.length}</b> 个浏览器装了但插件没启用。缺少这个插件会有两个后果：
          <div style="margin-top:8px;line-height:1.9">
            ① 网页黑名单拦不住（插件负责在请求层拦截，并在自律时段扫掉已打开的标签页）<br>
            ② 自律时段里打开这些浏览器会被<b>自动关闭</b>（因为无法确认网页是否违规）
          </div>
        </div>
        <div style="font-size:12.5px">${rows}</div>
        <div class="hint" style="margin-top:10px">
          点「去安装」会打开对应浏览器的扩展管理页，并给你 10 分钟安装时间（这期间不会关浏览器）。
        </div>
      </div>
      <div class="modal-ft">
        <button class="btn" data-act="close-modal">稍后再说</button>
        <button class="btn btn-primary" data-act="browser-prompt-go">去安装</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- 动作 ---------------- */
const Act = window.Act = {
  async nav(view) {
    S.view = view;
    if (view === 'stats' && !S.stats) await loadStats();
    if (view === 'reports') await loadReports();
    if (view === 'sync') { await loadBackups(); }
    if (view === 'browsers') { await Act.browserScan(); return; }
    if (view === 'about') await loadQuota();
    render();
  },

  async loadQuota() { await loadQuota(); render(); },

  async toggleRule(id) {
    const l = S.data.config.lists.find((x) => x.id === id);
    if (!l) return;
    if (l.lock && l.lock.kind !== 'none' && l.enabled) { toast('这条规则已锁定，不能直接关闭', 'err'); render(); return; }
    l.enabled = !l.enabled;
    await saveConfig();
    render();
  },

  async delRule(id) {
    const l = S.data.config.lists.find((x) => x.id === id);
    if (!l) return;
    if (l.lock && l.lock.kind !== 'none') { toast('已锁定的规则不能删除', 'err'); return; }
    if (!confirm(`确定删除规则「${l.name}」？`)) return;
    S.data.config.lists = S.data.config.lists.filter((x) => x.id !== id);
    await saveConfig();
    render();
  },

  async saveEditor() {
    const r = S.editing;
    syncEditorInputs();
    const nameEl = $('#ruleName');
    if (nameEl) r.name = nameEl.value.trim() || '未命名规则';
    if (S.editorTab === 'lock') {
      if (r.lock.kind === 'timer') {
        const m = +(($('#lockMins') || {}).value || 60);
        r.lock.until = Math.floor(Date.now() / 1000) + m * 60;
      }
      if (r.lock.kind === 'password') r.lock.password = ($('#lockPwd') || {}).value || '';
      if (r.lock.kind === 'text') r.lock.chars = +(($('#lockChars') || {}).value || 20);
    }
    const lists = S.data.config.lists;
    const i = lists.findIndex((x) => x.id === r.id);
    if (i >= 0) lists[i] = r; else lists.push(r);
    await saveConfig();
    S.editing = null;
    closeModal();
    render();
    toast('规则已保存', 'ok');
  },

  async pickRunningApp() {
    S.pickerFor = 'app';
    const list = await invoke('list_windows');
    S.picker = list;
    renderPicker();
  },

  async pickFile(kind) {
    const p = await invoke('pick_path', { kind: kind || 'file' });
    if (!p) return;
    if (!S.editing) return;
    const label = p.split(/[\\/]/).pop().replace(/\.exe$/i, '');
    S.editing.apps.push({ id: 'a' + Date.now().toString(36), kind: 'exe', value: p, label });
    renderEditor();
  },

  async pickDir() {
    await Act.pickFile('dir');
  },

  addSite() {
    const el = $('#siteInput');
    if (!el || !S.editing) return;
    const v = el.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!v) return;
    if (S.editing.sites.some((s) => s.pattern === v)) { el.value = ''; return; }
    S.editing.sites.push({ id: 's' + Date.now().toString(36), pattern: v, label: v });
    renderEditor();
  },

  quickSite(v) {
    if (!S.editing) return;
    if (!S.editing.sites.some((s) => s.pattern === v)) {
      S.editing.sites.push({ id: 's' + Date.now().toString(36), pattern: v, label: v });
      renderEditor();
    }
  },

  addExc() {
    const el = $('#excInput');
    if (!el || !S.editing) return;
    const v = el.value.trim().replace(/^https?:\/\//, '');
    if (!v) return;
    S.editing.exceptions.push(v);
    renderEditor();
  },

  async toggleMask() {
    const d = S.data;
    if (!d) return;
    // 只有"自律正在接管"时才不能手动切；跟随自律开着但自律没生效时，开关照常可用
    if (d.mask.autoOn) {
      toast('自律模式生效中，遮罩由自律模式接管；把「跟随自律模式」关掉才能手动切', 'err');
      return;
    }
    const next = !(d.mask.userOn && !(d.mask.previewLeft > 0));
    try {
      await invoke('mask_set_on', { on: next });
      toast(next ? '遮罩已开启（真实生效），Ctrl+Alt+K 可随时关闭' : '遮罩已关闭', 'ok');
      await pull();
      render();
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
  },

  async maskDiag() {
    let info = '';
    try { info = await invoke('mask_diag'); } catch (e) { info = String(e); }
    const lines = String(info || '（无数据）').split(' | ');
    $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal">
        <div class="modal-hd">
          <h3>遮罩自查</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          <div class="hint" style="margin-bottom:12px">
            这是遮罩线程最后一帧的真实状态。点「测试效果」后再看，<b>painted=true</b> 且
            <b>可见=1</b> 就说明遮罩已经在屏幕上生效；如果显示 on=false，说明它被自动退出了。
          </div>
          <div class="note" style="font-size:12px;line-height:1.9;word-break:break-all">${esc(lines.join('\n')).replace(/\n/g, '<br>')}</div>
        </div>
        <div class="modal-ft">
          <button class="btn" data-act="close-modal">关闭</button>
        </div>
      </div>
    </div>`;
  },

  async maskPreview() {
    try {
      const left = await invoke('mask_preview');
      await pull();
      render();
      toast(left > 0 ? `预览中：${left} 秒后自动结束，不会改变主开关` : '预览已结束', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
  },

  async toggleFollowSchedule() {
    const on = !S.data.config.settings.mask.followSchedule;
    try {
      await invoke('mask_follow_schedule', { enabled: on });
      await pull();
      render();
      toast(on ? '已开启跟随自律：自律开始时自动打开遮罩，结束时自动关闭' : '已关闭跟随自律：遮罩回到手动/快捷键控制', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
  },

  async setOpacity(v) {
    $('#opVal').textContent = v + '%';
    const dim = $('#previewDim');
    if (dim) dim.style.opacity = v / 100;
    await invoke('mask_set', { opacity: +v });
  },
  async setMargin(v) {
    $('#mgVal').textContent = v + 'px';
    await invoke('mask_set', { margin: +v });
  },
  async setRadius(v) {
    $('#radVal').textContent = v + 'px';
    const h = $('#previewHole');
    if (h) h.style.borderRadius = Math.max(2, Math.round(v / 3)) + 'px';
    await invoke('mask_set', { radius: +v });
  },
  async setDuration(v) {
    $('#durVal').textContent = v + 'ms';
    await invoke('mask_set', { durationMs: +v });
  },
  async maskSave() {
    const m = S.data.config.settings.mask;
    const cur = S.data.mask;
    m.opacity = cur.opacity;
    m.margin = cur.margin;
    m.radius = cur.radius;
    m.durationMs = cur.duration;
    m.blockClick = cur.blockClick;
    m.smooth = !!cur.smooth;
    m.follow = !!cur.follow;
    try {
      await saveConfig();
      toast('遮罩参数已保存', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },

  /* ---- 积分 ---- */
  openUnlock() {
    const p = S.data.points;
    const opts = [5, 10, 15];
    $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal" style="width:560px">
        <div class="modal-hd">
          <h3>用积分解锁</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          <div class="row" style="gap:14px;margin-bottom:16px">
            <div class="mini" style="flex:1"><div class="l">当前积分</div><div class="v" style="color:var(--gold)">${p.balance}</div></div>
            <div class="mini" style="flex:1"><div class="l">当前单价</div><div class="v">${p.price} <span style="font-size:12px;font-weight:400">分/分钟</span></div></div>
          </div>
          ${opts.map((m) => {
            const cost = p.price * m;
            const ok = p.balance >= cost;
            return `<div class="list-row" style="cursor:pointer;${ok ? '' : 'opacity:.45'}"
                data-act="${ok ? 'do-unlock' : 'noop'}" data-min="${m}">
              <span class="badge ${ok ? 'gold' : 'red'}">${m} 分钟</span>
              <span class="grow">解锁 ${m} 分钟自由时间</span>
              <span class="tnum" style="color:${ok ? 'var(--gold)' : 'var(--red)'}">${cost} 分</span>
            </div>`;
          }).join('')}
          <div class="note" style="margin-top:14px">
            解锁期间所有拦截暂停、可以退出程序；倒计时结束自动恢复固化。<br>
            今天已经解锁 ${p.count} 次，每多一次单价 ×1.4。提前结束不退还积分。
          </div>
        </div>
        <div class="modal-ft"><button class="btn" data-act="close-modal">取消</button></div>
      </div>
    </div>`;
  },
  async pointsUnlock(min) {
    try {
      const r = await invoke('points_unlock', { minutes: min });
      closeModal();
      await pull();
      render();
      toast(`已解锁 ${min} 分钟，消耗 ${r.spent} 分`, 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },

  hardToggle() {
    syncEditorInputs();
    S.editing.hard = !S.editing.hard;
    renderEditor();
  },
  breakKind(k) {
    syncEditorInputs();
    S.editing.brk = S.editing.brk || { kind: 'none', workMin: 25, breakMin: 5 };
    S.editing.brk.kind = k;
    renderEditor();
  },
  async enterTestMode() {
    try {
      const r = await invoke('test_mode_enter');
      await pull(); await loadReports(); render();
      toast('已进入测试模式：数据写在 ' + (r.dataDir || '独立目录') + '，自律开关可随时切换', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },

  async exitTestMode(keep) {
    try {
      await invoke('test_mode_exit', { keep });
      await pull(); await loadReports(); render();
      toast(keep ? '已退出测试模式，测试期间的设置与数据已并入正式环境' : '已退出测试模式，测试数据已丢弃', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },

  async askExitTest(keep) {
    $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal">
        <div class="modal-hd"><h3>${keep ? '退出并保留测试数据' : '退出并丢弃测试数据'}</h3>
          <button class="close-x" data-act="close-modal">×</button></div>
        <div class="modal-bd">
          <div class="note">${keep
            ? '测试期间的规则、设置、统计会<b>合并进正式环境</b>，回到正式模式后可以看到。正式环境原有的其它数据不会被删除。'
            : '测试期间产生的配置与统计会<b>全部删除</b>，正式环境保持进入测试模式前的样子。'}</div>
        </div>
        <div class="modal-ft">
          <button class="btn" data-act="close-modal">取消</button>
          <button class="btn ${keep ? 'btn-primary' : 'btn-danger'}" data-act="test-exit-do" data-keep="${keep ? 1 : 0}">确认退出</button>
        </div>
      </div>
    </div>`;
  },

  async toggleFollow() {
    const on = !S.data.mask.follow;
    await invoke('mask_set', { follow: on });
    await pull();
    render();
    toast(on ? '已开启跟随：遮罩会跟着当前最上层窗口走' : '已关闭跟随', 'ok');
  },

  async toggleSmooth() {
    const on = !S.data.mask.smooth;
    await invoke('mask_set', { smooth: on });
    S.data.mask.smooth = on;
    render();
    toast(on ? '已切到逐像素高清圆角；若遮罩消失就关掉它' : '已切回区域挖洞（兼容性优先）', 'ok');
  },

  async toggleClick() {
    const on = !S.data.mask.blockClick;
    await invoke('mask_set', { blockClick: on });
    S.data.mask.blockClick = on;
    render();
  },

  async statsTab(k) {
    S.statsTab = k;
    if (!S.stats) await loadStats();
    render();
  },
  async setRange(r) {
    S.range = r;
    if (r === 'custom') { render(); return; }
    await loadStats();
    render();
  },
  async applyRange() {
    S.customStart = ($('#cStart') || {}).value || todayStr();
    S.customEnd = ($('#cEnd') || {}).value || todayStr();
    await loadStats();
    render();
  },
  async refreshStats() { await loadStats(); render(); },

  async genReport() {
    const period = ($('#genPeriod') || {}).value || 'daily';
    const now = new Date();
    let start, end;
    if (period === 'daily') { const y = addDays(now, -1); start = end = dateStr(y); }
    if (period === 'weekly') {
      const dow = (now.getDay() + 6) % 7;
      const mon = addDays(addDays(now, -dow), -7);
      start = dateStr(mon); end = dateStr(addDays(mon, 6));
    }
    if (period === 'monthly') {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      start = dateStr(first); end = dateStr(last);
    }
    if (period === 'yearly') { start = `${now.getFullYear() - 1}-01-01`; end = `${now.getFullYear() - 1}-12-31`; }
    try {
      await invoke('report_generate', { period, start, end });
      await loadReports();
      render();
      toast('报告已生成', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },

  async openReport(id) {
    const r = await invoke('report_get', { id });
    if (!r) { toast('报告读取失败', 'err'); return; }
    S.reportView = r;
    renderReportModal();
  },

  /* ---- 遮罩：快捷键 / 自动触发 ---- */
  async saveHotkey() {
    const v = ($('#hkInput') || {}).value || '';
    try {
      await invoke('mask_hotkey', { combo: v });
      await pull(); render();
      toast(v ? `快捷键已设为 ${v}` : '已取消快捷键', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
  },
  /* ---- 备份 ---- */
  async backupMake() {
    try {
      const r = await invoke('backup_make');
      await loadBackups();
      render();
      toast(`已生成备份 ${r.name}（${r.encrypted ? '密码加密' : 'DPAPI 加密'}）`, 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },
  async backupRestore(path) {
    if (!confirm('用这份备份覆盖当前配置？当前配置会被替换。')) return;
    try {
      const msg = await invoke('backup_restore', { path });
      closeModal(); await pull(); render();
      toast(msg, 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },
  async backupDelete(path) {
    if (!confirm('删除这份备份文件？')) return;
    await invoke('backup_delete', { path });
    await loadBackups(); render();
  },
  async backupSavePass() {
    const v = ($('#bkPass') || {}).value || '';
    await invoke('backup_save', { password: v, autoOnStart: !!($('#bkAuto') || {}).checked });
    await pull(); render();
    toast(v ? '备份密码已保存（之后都用它加密）' : '已改为本机 DPAPI 加密', 'ok');
  },
  async cloudList() {
    toast('正在读取云端备份…');
    try {
      S.cloud = await invoke('backup_cloud_list');
      renderCloudModal();
    } catch (e) { toast('读取失败：' + e, 'err'); }
  },
  async cloudUpload() {
    try {
      const msg = await invoke('backup_cloud_upload');
      S.cloud = await invoke('backup_cloud_list');
      await loadBackups();
      render();
      toast(msg, 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },
  async cloudRestore(name) {
    if (!confirm('用云端的 ' + name + ' 覆盖当前配置？')) return;
    try {
      const msg = await invoke('backup_cloud_restore', { name });
      closeModal(); await pull(); render();
      toast(msg, 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },

  async saveNotify() {
    const enabled = !!($('#ntEnabled') || {}).checked;
    const work = +(($('#ntWork') || {}).value || 0);
    const brk = +(($('#ntBreak') || {}).value || 0);
    const brkOn = !!($('#ntBreakOn') || {}).checked;
    try {
      await invoke('notify_save', {
        enabled,
        workBefore: Math.max(0, Math.min(120, work)),
        breakBefore: Math.max(0, Math.min(120, brk)),
        breakNotify: brkOn,
      });
      await pull();
      render();
      toast('提醒设置已保存', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },

  async saveQuoteMins() {    const v = +(($('#quoteMins') || {}).value || 60);
    await invoke('hud_save', {
      enabled: !!(S.data.config.settings.hud || {}).enabled,
      quoteMinutes: v,
    });
    await pull();
    render();
    toast(`短语每 ${v} 分钟换一次`, 'ok');
  },

  async saveCustomDays() {    const v = +(($('#customDays') || {}).value || 0);
    S.data.config.settings.stats.customDays = Math.max(0, Math.min(365, v));
    if (!S.data.config.settings.stats.customAnchor) S.data.config.settings.stats.customAnchor = todayStr();
    await saveConfig();
    toast(v > 0 ? `已设置每 ${v} 天生成一次报告` : '已关闭自定义周期', 'ok');
  },

  async cfgSwitch(k) {
    const st = S.data.config.settings;
    if (k.indexOf('.') > 0) {
      // 嵌套配置（如 browserGuard.enabled）：按点号路径取字段并取反
      const [group, field] = k.split('.');
      if (!st[group]) st[group] = {};
      st[group][field] = !st[group][field];
      await saveConfig();
      render();
      return;
    }
    if (k === 'hudEnabled') {
      const h = st.hud || (st.hud = { enabled: true, quoteMinutes: 60 });
      h.enabled = !h.enabled;
      await invoke('hud_save', { enabled: h.enabled, quoteMinutes: h.quoteMinutes || 60 });
      await pull(); render(); return;
    }
    if (k === 'runAsAdmin') {
      st.runAsAdmin = !st.runAsAdmin;
      try {
        await invoke('set_run_as_admin', { enabled: st.runAsAdmin });
        toast(st.runAsAdmin ? '已保存，正在以管理员身份重启…' : '已关闭管理员模式（下次启动生效）', 'ok');
      } catch (e) { toast(String(e), 'err'); return; }
      await saveConfig();
      await pull(); render(); return;
    }
    if (k === 'autostart') {
      st.autostart = !st.autostart;
      await invoke('set_autostart', { enabled: st.autostart });
    } else if (k === 'statsEnabled') {
      st.stats.enabled = !st.stats.enabled;
    } else if (k === 'countIdle') {
      st.stats.countIdle = !st.stats.countIdle;
    } else {
      st[k] = !st[k];
    }
    await saveConfig();
    render();
  },

  async statToggle(k) {
    const s = S.data.config.settings.stats;
    s[k] = !s[k];
    await saveConfig();
    render();
  },

  async saveNum(k) {    const map = {
      pollMs: ['settings', 'pollMs', 300, 5000],
      graceSecs: ['settings', 'graceSecs', 20, 600],
      retentionDays: ['stats', 'retentionDays', 30, 3650],
    };
    const m = map[k];
    if (!m) return;
    const el = $('#' + k);
    const v = +(el ? el.value : 0);
    const obj = m[0] === 'settings' ? S.data.config.settings : S.data.config.settings.stats;
    obj[m[1]] = Math.max(m[2], Math.min(m[3], v || m[2]));
    await saveConfig();
    render();
    toast('已保存', 'ok');
  },

  async saveProtected() {
    const el = $('#protectedList');
    if (!el) return;
    S.data.config.settings.protected = el.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    await saveConfig();
    toast('保护名单已保存', 'ok');
  },

  async setTheme(v) {
    S.data.config.settings.theme = v;
    await saveConfig();
    applyTheme();
    render();
    toast(v === 'system' ? '已跟随系统外观' : v === 'light' ? '已切换到浅色' : '已切换到深色', 'ok');
  },
  async cycleTheme() {
    const cur = S.data.config.settings.theme || 'system';
    const next = cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system';
    await Act.setTheme(next);
  },

  async restartAdmin() { await invoke('restart_as_admin'); },
  async openExt() { try { await invoke('open_extension_dir'); } catch (e) { toast(String(e), 'err'); } },
  async openCfg() { await invoke('open_config_dir'); },
  async openStatsDir() { const p = await invoke('stats_dir_path'); await invoke('open_path', { path: p }); },

  /* ---- 云同步 ---- */
  syncAuto() {
    S.data.config.settings.sync.auto = !S.data.config.settings.sync.auto;
    render();
  },
  async syncSave() {
    const url = ($('#davUrl') || {}).value || '';
    const username = ($('#davUser') || {}).value || '';
    const password = ($('#davPass') || {}).value || '';
    const autoMinutes = +(($('#davMins') || {}).value || 30);
    const auto = !!S.data.config.settings.sync.auto;
    try {
      await invoke('sync_save', {
        url, username, password, auto, autoMinutes,
        enabled: !!url.trim(),
      });
      await pull(); render();
      toast('同步配置已保存', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },
  async syncRun(kind) {
    const cmd = { now: 'sync_now', up: 'sync_upload', down: 'sync_download' }[kind];
    try {
      const msg = await invoke(cmd);
      await pull(); render();
      toast(msg || '同步完成', 'ok');
    } catch (e) {
      await pull(); render();
      toast('同步失败：' + e, 'err');
    }
  },

  /* ---- 浏览器插件 ---- */
  async browserScan() {
    S.browserScanning = true;
    render();
    try {
      const r = await invoke('browsers_scan');
      S.browsers = r.list || [];
      await pull();
    } catch (e) {
      toast(String(e), 'err');
    }
    S.browserScanning = false;
    render();
  },

  /** 打开扩展管理页。所有等待路径都有终态，不会出现"点完就没了" */
  async browserPage(key, el) {
    const status = (txt, cls) => {
      const s = $('#extOpenStatus');
      if (s) { s.className = 'ext-status ' + (cls || ''); s.innerHTML = txt; }
    };
    const btn = el && el.classList ? el : null;
    const oldTxt = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '正在打开…'; }
    status('正在打开扩展管理页…', 'busy');
    try {
      // 12 秒兜底：进程真起不来也得给个结论，不能让按钮一直转
      const msg = await withTimeout(
        invoke('browser_open_ext', { key }),
        12000,
        '等待浏览器响应超时'
      );
      toast(msg + '（10 分钟内不会因为插件状态关浏览器）', 'ok');
      status('✓ ' + esc(msg), 'ok');
      return true;
    } catch (e) {
      const m = String(e).replace(/^Error:\s*/, '');
      toast('打不开扩展管理页：' + m, 'err');
      status(
        '✗ 打不开扩展管理页。' + esc(m) +
        '<br>可以点下面的「打开文件夹」，在浏览器里手动打开扩展页 → 开发者模式 → 加载已解压的扩展程序。',
        'err'
      );
      return false;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldTxt || '扩展页'; }
    }
  },

  async browserInstall(key) {
    // 顺序很重要：先出弹窗（用户立刻看到"正在做什么"），再去拉起浏览器。
    // 以前是先 await 拉起浏览器 → 进程卡住时界面一片死寂，看起来就是"卡死"。
    await Act.browserGuide(key);
    await Act.browserPage(key, $('#instOpenBtn'));
  },

  async browserGuide(key) {
    const list = (S.data && S.data.browsers) || S.browsers || [];
    const name = (list.find((b) => b.key === key) || {}).name || '浏览器';
    let info = (S.data && S.data.extInfo) || {};
    try {
      info = await withTimeout(invoke('browser_ext_info'), 8000, '读取扩展目录超时');
    } catch (e) { /* 用状态里的旧值，不影响后面的步骤 */ }
    $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal">
        <div class="modal-hd">
          <h3>给 ${esc(name)} 装插件</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          <div id="extOpenStatus" class="ext-status ${key ? 'busy' : ''}">${key ? '正在打开扩展管理页…' : '按下面三步装好即可。'}</div>
          <ol class="ext-steps">
            <li>在扩展页右上角打开 <b>开发者模式</b></li>
            <li>点 <b>加载已解压的扩展程序</b>，选中下面这个文件夹</li>
            <li>回到这里点 <b>完成，重新检测</b>，状态会变成「插件已启用」</li>
          </ol>
          ${extFolderPanel(info)}
          <div class="hint" style="margin-top:10px">
            也可以把 <code>${esc(((info.crx || 'KingOfFocus-Extension.crx').split('\\').pop()) || '')}</code>
            直接拖进扩展页（同样要先开开发者模式）。装的时候不会关你的浏览器。
          </div>
        </div>
        <div class="modal-ft">
          <button class="btn" data-act="close-modal">稍后</button>
          <button class="btn" data-act="ext-open">打开文件夹</button>
          <button class="btn btn-primary" id="rescanBtn" data-act="browser-rescan">完成，重新检测</button>
        </div>
      </div>
    </div>`;
  },

  /** 弹窗里的"完成，重新检测"：一定有结果，并且会自己关掉弹窗 */
  async browserRescan() {
    const btn = $('#rescanBtn');
    const st = $('#extOpenStatus');
    if (btn) { btn.disabled = true; btn.textContent = '检测中…'; }
    if (st) { st.className = 'ext-status busy'; st.textContent = '正在重新读取各浏览器的插件记录…'; }
    try {
      const r = await withTimeout(invoke('browsers_scan'), 15000, '检测超时');
      const list = r.list || [];
      S.browsers = list;
      const ready = list.filter((b) => b.installed && b.ext === 'enabled');
      const broken = list.filter((b) => b.installed && (b.ext === 'notInstalled' || b.ext === 'disabled'));
      closeModal();
      await pull();
      if (S.view === 'browsers') await Act.browserScan(); else render();
      if (ready.length) {
        toast(`检测完成：${ready.length} 个浏览器的插件已就绪`, 'ok');
      } else if (broken.length) {
        toast('还是没检测到插件。确认文件夹选对后，点「重新检测」再看一次', 'err');
      } else {
        toast('检测完成：没有发现受支持的浏览器', '');
      }
    } catch (e) {
      const m = String(e).replace(/^Error:\s*/, '');
      if (btn) { btn.disabled = false; btn.textContent = '完成，重新检测'; }
      if (st) {
        st.className = 'ext-status err';
        st.innerHTML = '✗ 检测失败：' + esc(m) + '<br>可以稍后再试，或直接看下面的扩展文件夹路径手动确认。';
      }
      toast('检测失败：' + m, 'err');
    }
  },

  async extCopy() {
    const info = S.data.extInfo || {};
    const ok = await copyText(info.path || '');
    const note = $('#extNote');
    if (ok) {
      toast('扩展路径已复制到剪贴板', 'ok');
      if (note) note.innerHTML = `<b style="color:var(--gold)">已复制。</b>在资源管理器地址栏 Ctrl+V 回车，再选中 extension 文件夹。`;
    } else {
      // 复制多半失败于 webview 权限：退化成"让用户手动选"
      toast('复制失败（剪贴板不可用），可以点「打开文件夹」直接从地址栏复制', 'err');
      if (note) note.innerHTML = `<b style="color:var(--red)">复制失败。</b>请点「打开文件夹」，在资源管理器地址栏里复制路径；或手动输入：<code>${esc(info.path || '')}</code>`;
    }
  },

  async browserOpenFolder() {
    const note = $('#extNote');
    const btns = document.querySelectorAll('[data-act="ext-open"],[data-act="browser-open-folder"]');
    if (note) { note.className = 'hint busy'; note.textContent = '正在打开资源管理器…'; }
    btns.forEach((b) => { b.disabled = true; });
    try {
      const msg = await withTimeout(invoke('browser_open_folder'), 12000, '打开资源管理器超时');
      toast(msg, 'ok');
      if (note) note.innerHTML = `<b style="color:var(--green, #52c41a)">${esc(msg)}</b>`;
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, '').replace(/\n/g, ' ');
      toast('打开失败，已给出替代方案', 'err');
      if (note) note.innerHTML = `<b style="color:var(--red)">打不开扩展文件夹。</b>${esc(msg)}`;
    } finally {
      btns.forEach((b) => { b.disabled = false; });
      if (note) note.classList.remove('busy');
    }
  },

  async browserGraceSave() {
    const el = $('#bgGrace');
    const v = Math.max(300, Math.min(3500, Number(el.value) || 1200));
    S.data.config.settings.browserGuard.graceMs = v;
    await saveConfig();
    toast(`关闭前宽限已设为 ${v}ms`, 'ok');
  },

  /* ---- 自律时段（24 段） ---- */
  async clockEnable() {
    const fc = clockCfg();
    fc.enabled = !fc.enabled;
    await saveConfig();
    render();
    toast(
      fc.enabled
        ? '自律时段已启用：到了选中的时间会自动进入自律模式'
        : '自律时段已关闭：选中的时间段不再自动开启自律模式',
      'ok'
    );
  },

  async clockApplyRules() {
    const fc = clockCfg();
    fc.applyRules = !fc.applyRules;
    await saveConfig();
    render();
    toast(fc.applyRules ? '时段内会让已启用的规则立即生效' : '时段内不再强制规则，只负责进入自律状态', 'ok');
  },

  async clockClear() {
    const fc = clockCfg();
    let n = 0;
    fc.days.forEach((day) => day.forEach((p) => { if (p.on) { p.on = false; n++; } }));
    await saveConfig();
    render();
    toast(n ? `已清空 ${n} 个小时段` : '当前没有已选时段', n ? 'ok' : 'err');
  },

  /** 提交一次框选：矩形区域 [d0..d1]×[h0..h1] 整体选中（add）或取消（sub） */
  async clockCommitRect(d0, d1, h0, h1, mode) {
    const fc = clockCfg();
    const on = mode === 'add';
    let n = 0;
    for (let d = d0; d <= d1; d++) {
      for (let h = h0; h <= h1; h++) {
        const p = fc.days[d][h];
        if (p.on !== on) n++;
        // 新选中的时段沿用「通用」专注/休息；已选中的保留原值，不冲掉自定义
        if (on && !p.on) { p.work = fc.defWork; p.brk = fc.defBrk; }
        p.on = on;
      }
    }
    await saveConfig();
    render();
    if (n) toast(on ? `已选上 ${n} 个小时段（专注 ${fc.defWork} 分 / 休息 ${fc.defBrk} 分）` : `已取消 ${n} 个小时段`, 'ok');
  },

  /** 右键菜单应用：给矩形区域设置专注 / 休息时长（顺带开启这些时段）。
   *  defToo = 同时把这一套更新成「通用」时长，之后新选的时段沿用 */
  async clockSetWB(d0, d1, h0, h1, w, b, defToo) {
    const fc = clockCfg();
    let n = 0;
    for (let d = d0; d <= d1; d++) {
      for (let h = h0; h <= h1; h++) {
        const p = fc.days[d][h];
        p.on = true;
        p.work = w;
        p.brk = b;
        n++;
      }
    }
    if (defToo) { fc.defWork = w; fc.defBrk = b; }
    await saveConfig();
    render();
    // 改到了「正在进行中的时段」：它会立刻按新时长重新划分专注 / 休息，提醒一句
    const wdNow = (new Date().getDay() + 6) % 7;
    const hourNow = new Date().getHours();
    const liveTip = (d0 <= wdNow && wdNow <= d1 && h0 <= hourNow && hourNow <= h1)
      ? '；当前进行中的时段会立即按新时长重新划分'
      : '';
    toast(`${ccRectText(d0, d1, h0, h1)}：专注 ${w} 分${b ? ` / 休息 ${b} 分` : '（不休息）'}，共 ${n} 段${defToo ? '；已更新为通用时长' : ''}${liveTip}`, 'ok');
  },

  /** 保存「通用时长」：之后新选中的时段都沿用这套专注 / 休息 */
  async clockDefSave() {
    const fc = clockCfg();
    let w = Math.round(Number($('#defW').value) || 0);
    let b = Math.round(Number($('#defB').value) || 0);
    w = Math.max(1, Math.min(60, w));
    b = Math.max(0, Math.min(60, b));
    if (b > 0 && w + b > 60) b = 60 - w;
    fc.defWork = w;
    fc.defBrk = b;
    await saveConfig();
    render();
    // 如果当前正处在某个选中时段里，提醒一句：这个时段会立刻按新时长重新划分
    const wdNow = (new Date().getDay() + 6) % 7;
    const hourNow = new Date().getHours();
    const cur = fc.days[wdNow] && fc.days[wdNow][hourNow];
    const liveTip = cur && cur.on
      ? `；当前时段会立即按新时长重新划分（本小时 ${pad(hourNow)}:00–${pad(w)} 专注${b ? `、${pad(hourNow)}:${pad(w)}–${pad(w + b)} 休息` : ''}）`
      : '';
    toast(`通用时长已设为 专注 ${w} 分${b ? ` / 休息 ${b} 分` : '（不休息）'}：之后新选的时段都会沿用${liveTip}`, 'ok');
  },

  /* ---- 自动更新 ---- */
  async checkUpdate() {
    toast('正在检查更新…');
    try {
      // 把输入框里刚填、还没保存的令牌一起带上——否则等于用旧令牌去检测
      const typed = ($('#ghToken') && $('#ghToken').value.trim()) || '';
      const r = await invoke('update_check', { token: typed || null });
      await pull();
      render();
      if (!r.ok) { toast('检查失败：' + r.error, 'err'); return; }
      if (r.newer) {
        showUpdateModal(r, true);
      } else if (!r.asset) {
        // 仓库只打了 tag、没有 Release 安装包：如实说明，别谎称"已是最新"
        toast(`远端最新 ${r.latest}，当前 v${r.current}。${r.note || '没有可自动下载的安装包。'}`,
          r.latest ? '' : 'ok');
      } else {
        toast('已经是最新版本 v' + r.current, 'ok');
      }
    } catch (e) { toast('检查失败：' + e, 'err'); }
  },
  async clearToken() {
    try {
      await invoke('update_save', { token: '' });
      await pull(); render();
      toast('令牌已清除', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },
  async saveToken() {
    const el = $('#ghToken');
    const v = el ? el.value.trim() : '';
    if (!v) { toast('请先粘贴令牌', 'err'); return; }
    try {
      await invoke('update_save', { token: v });
      await pull(); await loadQuota(); render();
      toast('令牌已保存（只在本机，界面掩码显示）', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },
  async tokenDoc() { await invoke('open_url', { url: S.data.tokenDocUrl }); },
  async openRepo() { await invoke('open_url', { url: S.data.repoUrl }); },
  async quotaRefresh() { await loadQuota(); render(); },
  async updateEnabled() {
    await invoke('update_save', { enabled: !S.data.config.settings.update.enabled });
    await pull(); render();
  },
  async skipVersion(v) {
    await invoke('update_save', { skip: v });
    closeModal(); await pull();
    toast('已跳过 v' + v + '，下次有新版本还会提醒');
  },
  async clearSkip() {
    await invoke('update_save', { skip: '' });
    await pull(); render();
    toast('已取消跳过');
  },
  async doUpdate(url, name) {
    if (!url) { toast('这个版本没有可下载的安装包', 'err'); return; }
    try {
      setProgress(2, '开始下载…');
      const path = await invoke('update_download', { url, name });
      setProgress(100, '下载完成，正在退出并安装…');
      await new Promise((r) => setTimeout(r, 900));
      await invoke('update_apply', { installer: path });
    } catch (e) {
      setProgress(0, '');
      toast('更新失败：' + e, 'err');
    }
  },

  schedCopy(from, to) {
    const r = S.editing;
    const src = JSON.parse(JSON.stringify(r.schedule[+from]));
    for (const d of String(to).split(',')) r.schedule[+d] = JSON.parse(JSON.stringify(src));
    paintSchedule();
  },
  schedClear() {
    S.editing.schedule = [[], [], [], [], [], [], []];
    paintSchedule();
  },
};

async function saveConfig() {
  try {
    await invoke('save_config', { config: S.data.config });
  } catch (e) {
    toast(String(e).replace(/^Error:\s*/, ''), 'err');
  }
  await pull();
}

async function loadStats() {
  const [start, end] = boundsOf(S.range);
  try {
    S.stats = await invoke('stats_range', { start, end });
  } catch (e) { console.error(e); }
}
async function loadReports() {
  try { S.reports = await invoke('report_list'); } catch (e) { S.reports = []; }
}
async function loadQuota() {
  try { S.quota = await invoke('update_quota'); } catch (e) { S.quota = { ok: false }; }
}
async function loadBackups() {
  try { S.backups = await invoke('backup_list'); } catch (e) { S.backups = []; }
}

function renderCloudModal() {
  const list = S.cloud || [];
  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="width:620px">
      <div class="modal-hd">
        <h3>云端备份（${list.length} 份）</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        ${list.length ? list.map((f) => `<div class="list-row">
            <span class="badge gold">${esc(f.name)}</span>
            <span class="grow muted" style="font-size:10.5px">${esc(f.url || '')}</span>
            <button class="btn btn-sm" data-act="cloud-restore" data-name="${esc(f.name)}">恢复</button>
          </div>`).join('') : '<div class="empty">云端还没有备份。<br>先点「上传当前配置」。</div>'}
        <div class="hint" style="margin-top:14px">
          只保留最近 ${10} 份、且 7 天内的备份；超出范围的会在上传时自动清理。
        </div>
      </div>
      <div class="modal-ft"><button class="btn" data-act="close-modal">关闭</button></div>
    </div>
  </div>`;
}

/* 保住在编辑器里已经输入但还没保存的内容 */
function syncEditorInputs() {
  const r = S.editing;
  if (!r) return;
  const nm = $('#ruleName');
  if (nm) r.name = nm.value;
  const wm = $('#workMin');
  if (wm && r.brk) r.brk.workMin = +(wm.value || 25);
  const bm = $('#breakMin');
  if (bm && r.brk) r.brk.breakMin = +(bm.value || 5);
}

/* ---------------- 弹层 ---------------- */
function closeModal() { $('#modalRoot').innerHTML = ''; }

function renderPicker() {
  const list = (S.picker || []).filter((w) => w.title);
  const html = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal">
      <div class="modal-hd">
        <h3>${S.pickerFor === 'mask' ? '选择要保留显示的窗口' : '选择要拦截的程序'}</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="add-row"><input type="text" id="pickerSearch" placeholder="搜索窗口标题或进程名…" /></div>
        <div class="picker-list" id="pickerList">
          ${list.length ? list.map((w, i) => `<div class="picker-item" data-act="pick-item" data-i="${i}">
            <span class="badge ${w.title ? 'gold' : ''}">${esc(w.name || '?')}</span>
            <div style="flex:1;min-width:0">
              <div class="nm">${esc(w.title || '(无标题)')}</div>
              <div class="ti">${esc(w.path || '')}</div>
            </div>
          </div>`).join('') : '<div class="empty">没有找到带窗口的程序</div>'}
        </div>
        <div class="hint" style="margin-top:12px">列表只显示当前有可见窗口的进程。想拦截的游戏可以先打开它，再回来这里选。</div>
      </div>
    </div>
  </div>`;
  $('#modalRoot').innerHTML = html;
  const s = $('#pickerSearch');
  if (s) s.addEventListener('input', () => {
    const q = s.value.toLowerCase();
    document.querySelectorAll('#pickerList .picker-item').forEach((el) => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

function renderReportModal() {
  const r = S.reportView;
  if (!r) return;
  const total = r.onSecs + r.offSecs;
  const merged = mergeSlices(r.on || [], r.off || []);
  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal wide" style="width:940px">
      <div class="modal-hd">
        <h3>${esc(r.title)} <span class="badge">${r.start} ~ ${r.end}</span></h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="grid-3" style="margin-bottom:16px">
          <div class="mini"><div class="l">自律模式已开启</div><div class="v" style="color:var(--gold)">${fmtDur(r.onSecs)}</div></div>
          <div class="mini"><div class="l">自律模式未开启</div><div class="v">${fmtDur(r.offSecs)}</div></div>
          <div class="mini"><div class="l">合计</div><div class="v">${fmtDur(total)}</div></div>
        </div>
        <div class="grid-2">
          <div>
            <div class="card-title">已开启</div>
            <canvas id="pieOn" width="240" height="240"></canvas>
            <div class="legend" id="legOn"></div>
          </div>
          <div>
            <div class="card-title">未开启</div>
            <canvas id="pieOff" width="240" height="240"></canvas>
            <div class="legend" id="legOff"></div>
          </div>
        </div>
        <div style="margin-top:18px">
          <div class="card-title">汇总（两状态直接相加）</div>
          <div class="row" style="gap:20px;align-items:flex-start">
            <canvas id="pieAll" width="240" height="240"></canvas>
            <div class="legend" id="legAll" style="flex:1"></div>
          </div>
        </div>
      </div>
      <div class="modal-ft">
        <button class="btn btn-danger" data-act="del-report" data-id="${r.id}">删除这份报告</button>
        <button class="btn" data-act="close-modal">关闭</button>
      </div>
    </div>
  </div>`;

  const draw = (sel, legSel, slices, tot) => {
    const cv = $(sel);
    if (!cv) return;
    const old = $('#legend');
    drawPie(cv, slices, tot, { sub: fmtDurShort(tot) });
  };
  // 逐个画，图例临时切换目标
  const legBackup = ['#legend'];
  const paint = (canvasSel, legSel, slices, tot) => {
    const cv = $(canvasSel);
    if (!cv) return;
    const size = 240;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size * dpr; cv.height = size * dpr;
    cv.style.width = size + 'px'; cv.style.height = size + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    let items = slices.slice(0, 7).map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }));
    const rest = slices.slice(7).reduce((a, b) => a + b.secs, 0);
    if (rest > 0) items.push({ label: '其他', secs: rest, color: '#4a5468' });
    const sum = items.reduce((a, b) => a + b.secs, 0);
    const cx = size / 2, cy = size / 2, rOut = 100, rIn = 62;
    if (sum > 0) {
      let ang = -Math.PI / 2;
      for (const it of items) {
        const a = (it.secs / sum) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, rOut, ang, ang + a);
        ctx.arc(cx, cy, rIn, ang + a, ang, true);
        ctx.closePath();
        ctx.fillStyle = it.color; ctx.fill();
        ctx.strokeStyle = cssVar('--panel-a'); ctx.lineWidth = 2; ctx.stroke();
        ang += a;
      }
    } else {
      ctx.beginPath(); ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
      ctx.strokeStyle = cssVar('--line-2'); ctx.lineWidth = rOut - rIn; ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = cssVar('--text'); ctx.font = '600 15px "Microsoft YaHei UI", sans-serif';
    ctx.fillText(fmtDurShort(tot), cx, cy + 1);
    ctx.fillStyle = cssVar('--text-3'); ctx.font = '10px "Microsoft YaHei UI", sans-serif';
    ctx.fillText('合计', cx, cy + 18);

    const lg = $(legSel);
    if (lg) lg.innerHTML = items.map((it) => `<div class="leg">
      <span class="sw" style="background:${it.color}"></span>
      <span class="nm">${esc(it.label)}</span>
      <span class="vv">${fmtDurShort(it.secs)}</span>
      <span class="pp">${sum ? ((it.secs / sum) * 100).toFixed(1) : 0}%</span>
    </div>`).join('');
  };

  paint('#pieOn', '#legOn', r.on || [], r.onSecs);
  paint('#pieOff', '#legOff', r.off || [], r.offSecs);
  paint('#pieAll', '#legAll', merged, total);
}

/* ---------------- 事件绑定 ---------------- */
document.addEventListener('click', async (e) => {
  const nav = e.target.closest('.nav-item');
  if (nav) { await Act.nav(nav.dataset.view); return; }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  if (act === 'close-modal-bg' && e.target.closest('.modal-mask') === el && e.target === el) { closeModal(); return; }
  if (act === 'close-modal' || act === 'close-editor') {
    if (act === 'close-editor') S.editing = null;
    closeModal(); return;
  }
  if (act === 'new-rule') { openEditor(null, true); return; }
  if (act === 'edit-rule') {
    if (e.target.closest('[data-act="toggle-rule"]') || e.target.closest('[data-act="del-rule"]')) return;
    openEditor(el.dataset.id, false); return;
  }
  if (act === 'toggle-rule') {
    const sw = el.querySelector('input');
    if (sw) sw.checked = !sw.checked;
    await Act.toggleRule(el.dataset.id); return;
  }
  if (act === 'del-rule') { await Act.delRule(el.dataset.id); return; }
  if (act === 'mode') {
    syncEditorInputs();
    S.editing.mode = el.dataset.mode;
    renderEditor(); return;
  }
  if (act === 'editor-tab') { syncEditorInputs(); S.editorTab = el.dataset.tab; renderEditor(); return; }
  if (act === 'hard-toggle') { Act.hardToggle(); return; }
  if (act === 'break-kind') { Act.breakKind(el.dataset.k); return; }
  if (act === 'mask-save') { await Act.maskSave(); return; }
  if (act === 'open-unlock') { Act.openUnlock(); return; }
  if (act === 'do-unlock') { await Act.pointsUnlock(+el.dataset.min); return; }
  if (act === 'noop') { toast('积分不够，先去专注赚点分', 'err'); return; }
  if (act === 'save-editor') { await Act.saveEditor(); return; }
  if (act === 'del-app') { S.editing.apps.splice(+el.dataset.i, 1); renderEditor(); return; }
  if (act === 'del-site') { S.editing.sites.splice(+el.dataset.i, 1); renderEditor(); return; }
  if (act === 'del-exc') { S.editing.exceptions.splice(+el.dataset.i, 1); renderEditor(); return; }
  if (act === 'pick-running-app') { await Act.pickRunningApp(); return; }
  if (act === 'pick-file') { await Act.pickFile('file'); return; }
  if (act === 'pick-dir') { await Act.pickDir(); return; }
  if (act === 'add-site') { Act.addSite(); return; }
  if (act === 'quick-site') { Act.quickSite(el.dataset.v); return; }
  if (act === 'add-exc') { Act.addExc(); return; }
  if (act === 'sched-copy') { Act.schedCopy(el.dataset.from, el.dataset.to); return; }
  if (act === 'sched-clear') { Act.schedClear(); return; }
  if (act === 'lock-kind') { S.editing.lock.kind = el.dataset.k; renderEditor(); return; }
  if (act === 'pick-item') {
    const w = (S.picker || []).filter((x) => x.title)[+el.dataset.i];
    if (!w) return;
    {
      const label = (w.name || '').replace(/\.exe$/i, '') || (w.title || '').slice(0, 20);
      S.editing.apps.push({
        id: 'a' + Date.now().toString(36),
        kind: w.path ? 'exe' : 'name',
        value: w.path || w.name,
        label,
      });
      closeModal();
      renderEditor();
    }
    return;
  }
  if (act === 'toggle-mask') { await Act.toggleMask(); return; }
  if (act === 'clock-enable') { await Act.clockEnable(); return; }
  if (act === 'clock-apply-rules') { await Act.clockApplyRules(); return; }
  if (act === 'clock-clear') { await Act.clockClear(); return; }
  if (act === 'clock-def-save') { await Act.clockDefSave(); return; }
  if (act === 'mask-diag') { await Act.maskDiag(); return; }
  if (act === 'mask-preview') { await Act.maskPreview(); return; }
  if (act === 'toggle-follow-schedule') { await Act.toggleFollowSchedule(); return; }
  if (act === 'toggle-click') { await Act.toggleClick(); return; }
  if (act === 'toggle-smooth') { await Act.toggleSmooth(); return; }
  if (act === 'toggle-follow') { await Act.toggleFollow(); return; }
  if (act === 'test-enter') { await Act.enterTestMode(); return; }
  if (act === 'test-exit-keep') { await Act.askExitTest(true); return; }
  if (act === 'test-exit-discard') { await Act.askExitTest(false); return; }
  if (act === 'test-exit-do') { closeModal(); await Act.exitTestMode(el.dataset.keep === '1'); return; }
  if (act === 'stats-tab') { await Act.statsTab(el.dataset.tab); return; }
  if (act === 'range') { await Act.setRange(el.dataset.r); return; }
  if (act === 'range-apply') { await Act.applyRange(); return; }
  if (act === 'stats-refresh') { await Act.refreshStats(); return; }
  if (act === 'gen-report') { await Act.genReport(); return; }
  if (act === 'open-report') { await Act.openReport(el.dataset.id); return; }
  if (act === 'reports-refresh') { await loadReports(); render(); return; }
  if (act === 'save-custom-days') { await Act.saveCustomDays(); return; }
  if (act === 'del-report') {
    if (!confirm('删除这份报告？原始日数据不受影响。')) return;
    await invoke('report_delete', { id: el.dataset.id });
    closeModal(); await loadReports(); render(); return;
  }
  if (act === 'stat-toggle') { await Act.statToggle(el.dataset.k); return; }
  if (act === 'cfg-switch') { await Act.cfgSwitch(el.dataset.k); return; }
  if (act === 'save-num') { await Act.saveNum(el.dataset.k); return; }
  if (act === 'save-quote-mins') { await Act.saveQuoteMins(); return; }
  if (act === 'save-notify') { await Act.saveNotify(); return; }
  if (act === 'save-hotkey') { await Act.saveHotkey(); return; }
  if (act === 'backup-make') { await Act.backupMake(); return; }
  if (act === 'backup-restore') { await Act.backupRestore(el.dataset.path); return; }
  if (act === 'backup-del') { await Act.backupDelete(el.dataset.path); return; }
  if (act === 'backup-pass') { await Act.backupSavePass(); return; }
  if (act === 'cloud-list') { await Act.cloudList(); return; }
  if (act === 'cloud-upload') { await Act.cloudUpload(); return; }
  if (act === 'cloud-restore') { await Act.cloudRestore(el.dataset.name); return; }
  if (act === 'backup-dir') { await invoke('backup_open_dir'); return; }
  if (act === 'save-protected') { await Act.saveProtected(); return; }
  if (act === 'theme') { await Act.setTheme(el.dataset.v); return; }
  if (act === 'cycle-theme') { await Act.cycleTheme(); return; }
  if (act === 'restart-admin') { await Act.restartAdmin(); return; }
  if (act === 'open-ext') { await Act.openExt(); return; }
  if (act === 'open-cfg') { await Act.openCfg(); return; }
  if (act === 'open-stats-dir') { await Act.openStatsDir(); return; }
  /* 云同步 */
  if (act === 'sync-auto') { Act.syncAuto(); return; }
  if (act === 'sync-save') { await Act.syncSave(); return; }
  if (act === 'sync-now') { await Act.syncRun('now'); return; }
  if (act === 'sync-up') { await Act.syncRun('up'); return; }
  if (act === 'sync-down') { await Act.syncRun('down'); return; }
  /* 更新 / 关于 */
  if (act === 'check-update') { await Act.checkUpdate(); return; }
  if (act === 'save-token') { await Act.saveToken(); return; }
  if (act === 'token-doc') { await Act.tokenDoc(); return; }
  if (act === 'clear-token') { await Act.clearToken(); return; }
  if (act === 'browser-scan') { await Act.browserScan(); return; }
  if (act === 'browser-page') { await Act.browserPage(el.dataset.k, el); return; }
  if (act === 'browser-install') { await Act.browserInstall(el.dataset.k); return; }
  if (act === 'browser-rescan') { await Act.browserRescan(); return; }
  if (act === 'browser-guide') { await Act.browserGuide(null); return; }
  if (act === 'browser-open-folder') { await Act.browserOpenFolder(); return; }
  if (act === 'ext-copy') { await Act.extCopy(); return; }
  if (act === 'ext-open') { await Act.browserOpenFolder(); return; }
  if (act === 'browser-grace-save') { await Act.browserGraceSave(); return; }
  if (act === 'browser-prompt-go') { closeModal(); await Act.browserScan(); Act.nav('browsers'); return; }
  if (act === 'open-repo') { e.preventDefault(); await Act.openRepo(); return; }
  if (act === 'quota-refresh') { await Act.quotaRefresh(); return; }
  if (act === 'update-enabled') { await Act.updateEnabled(); return; }
  if (act === 'skip-version') { await Act.skipVersion(el.dataset.v); return; }
  if (act === 'clear-skip') { await Act.clearSkip(); return; }
  if (act === 'do-update') { await Act.doUpdate(el.dataset.url, el.dataset.name); return; }
});

/* 时段拖动 */
document.addEventListener('mousedown', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell || !S.editing) return;
  e.preventDefault();
  const day = +cell.dataset.day, idx = +cell.dataset.idx;
  S.paint = { day, from: idx, to: idx, mode: cell.classList.contains('on') ? 'remove' : 'add' };
  document.querySelectorAll(`.cell[data-day="${day}"]`).forEach((c) => {
    const i = +c.dataset.idx;
    const isOn = S.paint.mode === 'add' ? (i >= idx && i <= idx) : false;
    c.classList.toggle('on', S.paint.mode === 'add' ? i === idx : slotHas(S.editing.schedule[day], i * 30));
  });
});
document.addEventListener('mouseover', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell || !S.paint || +cell.dataset.day !== S.paint.day) return;
  S.paint.to = +cell.dataset.idx;
  const a = Math.min(S.paint.from, S.paint.to), b = Math.max(S.paint.from, S.paint.to);
  document.querySelectorAll(`.cell[data-day="${S.paint.day}"]`).forEach((c) => {
    const i = +c.dataset.idx;
    const inRange = i >= a && i <= b;
    if (S.paint.mode === 'add') c.classList.toggle('on', inRange || slotHas(S.editing.schedule[S.paint.day], i * 30));
    else c.classList.toggle('on', inRange ? false : slotHas(S.editing.schedule[S.paint.day], i * 30));
  });
});
document.addEventListener('mouseup', () => {
  if (!S.paint || !S.editing) { S.paint = null; return; }
  const { day, from, to, mode } = S.paint;
  const a = Math.min(from, to) * 30, b = (Math.max(from, to) + 1) * 30;
  const cur = S.editing.schedule[day] || [];
  S.editing.schedule[day] = mode === 'add' ? addRange(cur, a, b) : subRange(cur, a, b);
  S.paint = null;
  paintSchedule();
});

/* 自律时段：7 列 × 24 小时柱状图，二维矩形拖选
 * 口径：格子 = 某一天的一个小时。按住拖动框出一片矩形（可跨天、跨小时）；
 * 从灰格起笔 = 选中整片，从蓝格起笔 = 取消整片；单击（不拖动）= 单独开关那一格。
 * 右键格子 = 弹出"专注 / 休息"设置，作用于右键时选中的范围。 */
function paintCcDrag() {
  const dg = S.ccDrag;
  if (!dg) return;
  const fc = clockCfg();
  const d0 = Math.min(dg.d0, dg.d1), d1 = Math.max(dg.d0, dg.d1);
  const h0 = Math.min(dg.h0, dg.h1), h1 = Math.max(dg.h0, dg.h1);
  document.querySelectorAll('.cc-cell').forEach((c) => {
    const d = +c.dataset.d, h = +c.dataset.h;
    const inRect = d >= d0 && d <= d1 && h >= h0 && h <= h1;
    const on = inRect ? dg.mode === 'add' : !!fc.days[d][h].on;
    c.classList.toggle('on', on);
    c.classList.toggle('edge', dg.moved && inRect && (d === d0 || d === d1 || h === h0 || h === h1));
  });
  // 预览态也要重算连通类名，否则拖过的接缝擦不干净
  ccApplyJoins(document);
  const lab = $('#clockLive');
  if (lab) lab.textContent = ccRectText(d0, d1, h0, h1);
}

document.addEventListener('mousedown', (e) => {
  const cell = e.target.closest('.cc-cell');
  if (!cell || e.button !== 0) return;
  e.preventDefault();
  const d = +cell.dataset.d, h = +cell.dataset.h;
  S.ccDrag = { d0: d, h0: h, d1: d, h1: h, mode: cell.classList.contains('on') ? 'sub' : 'add', moved: false };
  paintCcDrag();
});

document.addEventListener('mouseover', (e) => {
  const dg = S.ccDrag;
  if (!dg) return;
  const cell = e.target.closest('.cc-cell');
  if (!cell) return;
  const d = +cell.dataset.d, h = +cell.dataset.h;
  if (d === dg.d1 && h === dg.h1) return;
  dg.d1 = d;
  dg.h1 = h;
  dg.moved = true;
  paintCcDrag();
});

document.addEventListener('mouseup', async () => {
  const dg = S.ccDrag;
  if (!dg) return;
  S.ccDrag = null;
  S.ccRect = { d0: dg.d0, d1: dg.d1, h0: dg.h0, h1: dg.h1 };
  await Act.clockCommitRect(
    Math.min(dg.d0, dg.d1), Math.max(dg.d0, dg.d1),
    Math.min(dg.h0, dg.h1), Math.max(dg.h0, dg.h1),
    dg.mode);
});

/* ---- 自律时段：右键设置某片区域的专注 / 休息 ---- */
let ccMenu = null;

function ccCloseMenu() {
  if (ccMenu) { ccMenu.remove(); ccMenu = null; }
}

function ccOpenMenu(d, h, x, y) {
  ccCloseMenu();
  const fc = clockCfg();
  const r = S.ccRect;
  const hasRect = !!r;
  // 默认目标：这一格在上次框选的矩形里 → 整个矩形；否则只作用这一格
  let t = { d0: d, d1: d, h0: h, h1: h };
  if (hasRect && d >= Math.min(r.d0, r.d1) && d <= Math.max(r.d0, r.d1)
    && h >= Math.min(r.h0, r.h1) && h <= Math.max(r.h0, r.h1)) {
    t = { d0: Math.min(r.d0, r.d1), d1: Math.max(r.d0, r.d1), h0: Math.min(r.h0, r.h1), h1: Math.max(r.h0, r.h1) };
  }
  const p = fc.days[d][h];
  // 输入框预填：只作用这一格且这一格已选中 → 用这一格的值；否则用「通用」时长
  const prefill = (single) => {
    const one = single && p.on;
    return { w: one ? (p.work || CC_DEF_W) : fc.defWork, b: one ? (p.brk || CC_DEF_B) : fc.defBrk };
  };
  const pre = prefill(t.d0 === t.d1 && t.h0 === t.h1);
  const el = document.createElement('div');
  el.className = 'cc-menu';
  el.innerHTML = `
    <div class="cc-menu-hd">专注 / 休息<b class="x" data-act="cc-close" title="关闭">×</b></div>
    <div class="cc-menu-tgt">作用于 <b id="ccTgt">${esc(ccRectText(t.d0, t.d1, t.h0, t.h1))}</b>（共 <b id="ccCnt">${(t.d1 - t.d0 + 1) * (t.h1 - t.h0 + 1)}</b> 段）</div>
    <div class="cc-menu-scope">
      <button class="chip-btn${hasRect ? ' active' : ''}" data-scope="rect"${hasRect ? '' : ' disabled title="先拖动框选一片区域"'}>当前框选</button>
      <button class="chip-btn${hasRect ? '' : ' active'}" data-scope="cell">这一格</button>
      <button class="chip-btn" data-scope="col">这一列（一整天）</button>
    </div>
    <div class="cc-menu-row">
      <label>专注 <input type="number" id="ccW" min="1" max="60" step="1" value="${pre.w}"> 分</label>
      <label>休息 <input type="number" id="ccB" min="0" max="60" step="1" value="${pre.b}"> 分</label>
    </div>
    <div class="cc-menu-scope">
      ${[[25, 5], [45, 15], [50, 10], [60, 0]].map(([w, b]) =>
        `<button class="chip-btn" data-wb="${w},${b}">${b ? `${w} / ${b}` : '不休息'}</button>`).join('')}
    </div>
    <label class="cc-menu-def"><input type="checkbox" id="ccDefToo" checked> 同时设为通用时长（之后新选的时段沿用）</label>
    <div class="cc-menu-hint">应用后会顺便开启这些时段；休息期间不拦截、不遮罩。排不满 60 分钟的尾段算继续专注。</div>
    <div class="cc-menu-ft">
      <button class="btn btn-sm" data-act="cc-close">取消</button>
      <button class="btn btn-sm btn-primary" id="ccApply">应用</button>
    </div>`;
  document.body.appendChild(el);
  // 定位，注意别溢出窗口
  const w = el.offsetWidth, ht = el.offsetHeight;
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - ht - 8)) + 'px';
  ccMenu = el;

  const tgt = $('#ccTgt', el);
  const cnt = $('#ccCnt', el);
  const updTgt = (scope) => {
    if (scope === 'cell') t = { d0: d, d1: d, h0: h, h1: h };
    else if (scope === 'col') t = { d0: d, d1: d, h0: 0, h1: 23 };
    else if (hasRect) t = { d0: Math.min(r.d0, r.d1), d1: Math.max(r.d0, r.d1), h0: Math.min(r.h0, r.h1), h1: Math.max(r.h0, r.h1) };
    else return;
    tgt.textContent = ccRectText(t.d0, t.d1, t.h0, t.h1);
    cnt.textContent = (t.d1 - t.d0 + 1) * (t.h1 - t.h0 + 1);
    // 目标范围变了，输入框也跟着换：单格看这一格的值，多格看通用时长
    const q = prefill(t.d0 === t.d1 && t.h0 === t.h1);
    $('#ccW', el).value = q.w;
    $('#ccB', el).value = q.b;
  };

  el.addEventListener('click', async (e) => {
    const sc = e.target.closest('[data-scope]');
    if (sc && !sc.disabled) {
      el.querySelectorAll('[data-scope]').forEach((b) => b.classList.toggle('active', b === sc));
      updTgt(sc.dataset.scope);
      return;
    }
    const wb = e.target.closest('[data-wb]');
    if (wb) {
      const [w2, b2] = wb.dataset.wb.split(',').map(Number);
      $('#ccW', el).value = w2;
      $('#ccB', el).value = b2;
      return;
    }
    if (e.target.closest('#ccApply')) {
      let w2 = Math.round(Number($('#ccW', el).value) || 0);
      let b2 = Math.round(Number($('#ccB', el).value) || 0);
      w2 = Math.max(1, Math.min(60, w2));
      b2 = Math.max(0, Math.min(60, b2));
      if (b2 > 0 && w2 + b2 > 60) b2 = 60 - w2;
      await Act.clockSetWB(t.d0, t.d1, t.h0, t.h1, w2, b2, $('#ccDefToo', el).checked);
      ccCloseMenu();
      return;
    }
    if (e.target.closest('[data-act="cc-close"]')) ccCloseMenu();
  });
  $('#ccW', el).focus();
}

document.addEventListener('contextmenu', (e) => {
  const cell = e.target.closest('.cc-cell');
  if (!cell) { ccCloseMenu(); return; }
  e.preventDefault();
  ccOpenMenu(+cell.dataset.d, +cell.dataset.h, e.clientX, e.clientY);
});

// 点菜单外面 = 关菜单
document.addEventListener('mousedown', (e) => {
  if (ccMenu && !e.target.closest('.cc-menu')) ccCloseMenu();
});

/* 输入框回车 */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (typeof ccCloseMenu === 'function') ccCloseMenu();
    if ($('#modalRoot').innerHTML) { S.editing = null; closeModal(); }
  }
  if (e.key === 'Enter') {
    if (e.target.id === 'siteInput') { e.preventDefault(); Act.addSite(); }
    if (e.target.id === 'excInput') { e.preventDefault(); Act.addExc(); }
    if (e.target.id === 'ruleName') { e.preventDefault(); Act.saveEditor(); }
  }
});

/* 遮罩滑块：实时预览 */
document.addEventListener('input', async (e) => {
  if (e.target.id === 'opRange') await Act.setOpacity(e.target.value);
  if (e.target.id === 'mgRange') await Act.setMargin(e.target.value);
  if (e.target.id === 'radRange') await Act.setRadius(e.target.value);
  if (e.target.id === 'durRange') await Act.setDuration(e.target.value);
});

/* 启动 */
document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

(async function boot() {
  await pull();
  await loadReports();
  await loadBackups();
  if (!S.data) { $('#content').innerHTML = '<div class="empty">无法连接后台服务</div>'; return; }
  S.customStart = todayStr();
  S.customEnd = todayStr();
  render();
  setInterval(pull, 1500);
  // 启动时自动识别浏览器与插件状态，缺失就弹一次安装引导
  promptBrowserSetup();

  // 下载进度
  if (T && T.event) {
    T.event.listen('update-progress', (ev) => {
      const p = ev.payload || {};
      const pct = p.total ? (p.done / p.total) * 100 : 0;
      const mb = (n) => (n / 1024 / 1024).toFixed(1);
      setProgress(
        pct,
        p.total
          ? `已下载 ${mb(p.done)} / ${mb(p.total)} MB`
          : `已下载 ${mb(p.done)} MB`
      );
    });

    // 拦截触发 → 自动跳回首页
    T.event.listen('goto-home', () => {
      if (S.editing) return;
      S.view = 'overview';
      render();
    });
  }

  // 启动时检查更新（延迟一下，先让界面出来）
  setTimeout(async () => {
    if (!S.data || !S.data.config.settings.update.enabled) return;
    try {
      const r = await invoke('update_check');
      if (r.ok && r.hasUpdate) showUpdateModal(r, false);
    } catch (e) { /* 网络失败静默，不打扰用户 */ }
  }, 2600);
})();

