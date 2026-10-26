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
};

const PALETTE = ['#ffb020', '#ff7a45', '#f759ab', '#b37feb', '#5b8cff', '#36cfc9',
  '#52c41a', '#a0d911', '#faad14', '#ff5c5c', '#40a9ff', '#9254de'];

const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const VIEW_TITLES = {
  overview: '总览', rules: '规则', mask: '专注遮罩',
  stats: '时长统计', reports: '统计报告', sync: '云同步',
  settings: '设置', about: '关于',
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

/* ---------------- 状态拉取 ---------------- */
async function pull() {
  try {
    S.data = await invoke('get_state');
    renderChrome();
    if (S.view === 'overview' && !S.editing) render();
    if (S.data && S.data.mask && S.data.mask.notice) {
      toast(S.data.mask.notice);
    }
  } catch (e) {
    console.error(e);
  }
}

function renderChrome() {
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
  parts.push(on ? `生效规则：<b>${d.runtime.active.map((a) => esc(a.name)).join('、')}</b>` : '当前没有生效的规则');
  parts.push(ext ? '浏览器插件：已连接' : '<span class="warn">浏览器插件：未连接</span>');
  if (!d.admin) parts.push('<span class="warn">未以管理员身份运行</span>');
  $('#sideStatus').innerHTML = parts.join('<br>');
}

/* ---------------- 视图：总览 ---------------- */
function viewOverview() {
  const d = S.data;
  if (!d) return '<div class="empty">加载中…</div>';
  const rt = d.runtime;
  const on = rt.disciplineOn;
  const next = rt.nextChange;

  const chips = rt.active.length
    ? rt.active.map((a) => `<span class="rule-chip"><span class="dot"></span>${esc(a.name)}
        <span class="badge ${a.mode === 'whitelist' ? 'red' : 'gold'}">${a.mode === 'whitelist' ? '强制模式' : '黑名单'}</span></span>`).join('')
    : '<span class="muted">暂无生效规则。到「规则」里新建一条，并设置生效时段。</span>';

  const evs = (rt.events || []).slice(0, 7);
  const evHtml = evs.length
    ? evs.map((e) => `<div class="ev">
        <span class="t">${hhmm(e.ts)}</span>
        <span class="badge ${e.kind === 'site' ? 'blue' : 'gold'}">${e.kind === 'site' ? '网页' : '软件'}</span>
        <span class="n" title="${esc(e.target)}">${esc(e.target)}</span>
        <span class="muted" style="font-size:11px">${esc(e.rule)}</span>
      </div>`).join('')
    : '<div class="empty">还没有拦截记录。等你设置的时段到了，这里会出现被拦下的应用和网页。</div>';

  const maskOn = d.mask.on;

  return `
  <div class="hero">
    <div class="hero-main">
      <div class="hero-label">当前状态</div>
      <div class="hero-state ${on ? 'on' : ''}">${on ? '专注进行中' : '自由时间'}</div>
      <div class="hero-desc">${on
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
        <div class="l">专注遮罩</div>
        <div class="v" style="color:${maskOn ? 'var(--gold)' : 'var(--text-2)'}">${maskOn ? '已开启' : '未开启'}</div>
        <div class="l" style="margin-top:6px">${maskOn ? esc(d.config.settings.mask.targetTitle || '目标窗口') : '选一个窗口，把其他都盖住'}</div>
      </div>
      <div class="mini">
        <div class="l">当前前台网页</div>
        <div class="v" style="font-size:13px;font-weight:600">${rt.siteUrl ? esc(rt.siteUrl.replace(/^https?:\/\//, '').slice(0, 30)) : '—'}</div>
        <div class="l" style="margin-top:6px">${rt.siteUrl ? '来自浏览器插件上报' : '安装插件后可识别具体网页'}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">生效中的规则</div>
    <div class="card-sub">规则的生效完全由时间表决定，不在时段内时它是完全静默的。</div>
    <div>${chips}</div>
  </div>

  <div class="grid-2" style="margin-top:14px;align-items:start">
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
        <div class="ev"><span class="t">数据</span><span class="n muted" style="font-size:11px">${esc(d.configPath)}</span></div>
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
  const cards = lists.length
    ? lists.map((l) => `
      <div class="rule-card ${activeNames.has(l.name) ? 'active' : ''}" data-act="edit-rule" data-id="${l.id}">
        <div class="rule-bar" style="background:${esc(l.color || '#ffb020')}"></div>
        <div style="flex:1;min-width:0">
          <div class="rule-name">${esc(l.name)}
            ${l.mode === 'whitelist'
              ? '<span class="badge red">强制模式 · 只能开白名单</span>'
              : '<span class="badge gold">黑名单 · 这些不能开</span>'}
            ${activeNames.has(l.name) ? '<span class="badge green">生效中</span>' : ''}
            ${l.lock && l.lock.kind !== 'none' ? '<span class="badge">已锁定</span>' : ''}
          </div>
          <div class="rule-meta">${l.apps.length} 个软件 · ${l.sites.length} 个网站 · ${l.exceptions.length} 条例外<br>
            <span class="muted">${esc(schedSummary(l.schedule))}</span></div>
        </div>
        <div class="rule-actions">
          <div class="switch" data-act="toggle-rule" data-id="${l.id}" title="启用 / 停用">
            <input type="checkbox" ${l.enabled ? 'checked' : ''}><i></i>
          </div>
          <button class="btn btn-sm" data-act="del-rule" data-id="${l.id}">删除</button>
        </div>
      </div>`).join('')
    : '<div class="empty">还没有规则。点右上角「新建规则」开始。</div>';

  return `
  <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:16px">
    <div class="hint" style="max-width:640px">
      一条规则 = 一个黑名单（或白名单）+ 一张周时间表。<b>只有落在时间表里的时段，规则才会生效</b>；
      时间表全空表示 7×24 小时生效。软件与网站分别维护，互不影响。
    </div>
    <button class="btn btn-primary" data-act="new-rule">+ 新建规则</button>
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
    ['lock', '锁定'],
  ];

  let body = '';
  if (S.editorTab === 'apps') body = tabApps(r);
  if (S.editorTab === 'sites') body = tabSites(r);
  if (S.editorTab === 'exceptions') body = tabExceptions(r);
  if (S.editorTab === 'schedule') body = tabSchedule(r);
  if (S.editorTab === 'lock') body = tabLock(r);

  const html = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal wide" onclick="event.stopPropagation()">
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

function tabLock(r) {
  const k = r.lock.kind;
  const until = r.lock.until ? new Date(r.lock.until * 1000).toLocaleString() : '';
  return `
    <div class="hint" style="margin-bottom:14px">
      锁定是为了防止自己在生效期间随手把规则关掉。锁定中的规则不能关闭、不能删除、不能改名单。
    </div>
    <div class="seg" style="margin-bottom:16px">
      <button class="${k === 'none' ? 'active' : ''}" data-act="lock-kind" data-k="none">不锁定</button>
      <button class="${k === 'timer' ? 'active' : ''}" data-act="lock-kind" data-k="timer">定时解锁</button>
      <button class="${k === 'password' ? 'active' : ''}" data-act="lock-kind" data-k="password">密码</button>
      <button class="${k === 'text' ? 'active' : ''}" data-act="lock-kind" data-k="text">抄写文字</button>
    </div>
    ${k === 'timer' ? `<div class="row" style="align-items:center;gap:10px">
        <span class="hint">锁定时长（分钟）</span>
        <input type="number" id="lockMins" value="60" min="1" style="width:110px" />
        <span class="hint">${until ? '当前解锁时间：' + esc(until) : ''}</span>
      </div>` : ''}
    ${k === 'password' ? `<div class="row" style="align-items:center;gap:10px">
        <span class="hint">解锁密码</span>
        <input type="text" id="lockPwd" value="${esc(r.lock.password || '')}" style="width:220px" placeholder="保存后生效" />
      </div>` : ''}
    ${k === 'text' ? `<div class="row" style="align-items:center;gap:10px">
        <span class="hint">需要抄写的字符数</span>
        <input type="number" id="lockChars" value="${r.lock.chars || 20}" min="1" max="999" style="width:110px" />
      </div>` : ''}
    ${k !== 'none' ? '<div class="note" style="margin-top:16px">锁定一旦保存，在解锁条件满足前无法绕过。请务必记住密码。</div>' : ''}`;
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

/* ---------------- 视图：专注遮罩 ---------------- */
function viewMask() {
  const d = S.data;
  if (!d) return '';
  const m = d.mask;
  const target = d.config.settings.mask.targetTitle || '';
  const op = m.opacity, mg = m.margin;
  return `
  <div class="mask-hero">
    <div style="flex:1">
      <div class="hero-label">专注遮罩 / FOCUS MASK</div>
      <div class="hero-state ${m.on ? 'on' : ''}" style="font-size:22px">${m.on ? '遮罩已开启' : '遮罩未开启'}</div>
      <div class="hero-desc" style="margin-top:6px">
        ${m.on
          ? `正锁定在：<b style="color:var(--gold)">${esc(target || '目标窗口')}</b>`
          : '选一个窗口作为"允许留下的画面"，其余区域会被纯黑遮罩盖住。'}
      </div>
      <div style="margin-top:18px;display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn btn-primary" data-act="pick-target">${target ? '重新选择窗口' : '选择目标窗口'}</button>
        ${target ? `<button class="btn ${m.on ? 'btn-danger' : ''}" data-act="toggle-mask">${m.on ? '关闭遮罩' : '开启遮罩'}</button>` : ''}
      </div>
      <div class="hint" style="margin-top:14px">热键 <b>Ctrl + Alt + K</b> 可随时开关遮罩，防止自己被困在黑屏里。</div>
    </div>
    <div class="mask-preview">
      <div class="screen"></div>
      <div class="dim" id="previewDim" style="opacity:${op / 100}"></div>
      <div class="hole">${esc((target || '目标窗口').slice(0, 10))}</div>
    </div>
  </div>

  <div class="card" style="margin-top:14px">
    <div class="card-title">遮罩参数</div>
    <div class="card-sub">拖动即时生效——遮罩开着的时候，你可以直接在屏幕上看到效果。</div>
    <div class="slider-row">
      <span class="lab">不透明度</span>
      <input type="range" min="20" max="100" step="1" value="${op}" id="opRange" />
      <span class="val" id="opVal">${op}%</span>
    </div>
    <div class="slider-row">
      <span class="lab">边缘留白</span>
      <input type="range" min="0" max="60" step="1" value="${mg}" id="mgRange" />
      <span class="val" id="mgVal">${mg}px</span>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <div>
        <div style="font-size:12.5px">同时屏蔽鼠标操作</div>
        <div class="hint" style="margin-top:4px">开启后，遮罩会吃掉所有点击，只有目标窗口和本程序可用。想只是"看不见但能点"，就关掉它。</div>
      </div>
      <div class="switch" data-act="toggle-click">
        <input type="checkbox" ${m.blockClick ? 'checked' : ''}><i></i>
      </div>
    </div>
  </div>

  <div class="note" style="margin-top:14px">
    <b>工作原理：</b>遮罩由 4 块分层窗口（上/下/左/右）环绕目标窗口拼成，窗口一动只挪位置、不重绘，
    所以拖拽缩放时能跟得上；坐标基于「虚拟桌面」，多显示器、混合 DPI 也不会错位。
    目标窗口关闭或最小化时遮罩会自动退出。
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
    <b>存储方式：</b>原始日数据存在 <code>%APPDATA%\\KingOfFocus\\stats\\days\\</code>（一天一个 JSON，按小时分桶）；
    报告存在 <code>stats\\reports\\</code>（一份报告一个 JSON，含两种状态各自的扇区数据）。
    默认保留 <b>${s.retentionDays || 400} 天</b>，可在下方设置里调整。报告可以随时点开回看，也可以手动删除。
    <div style="margin-top:8px"><button class="btn btn-sm" data-act="open-stats-dir">打开数据目录</button></div>
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
  const masked = d.maskedToken || '';
  const quotaTxt = S.quota ? (S.quota.ok ? `${S.quota.remaining} / ${S.quota.limit}` : '读取失败') : '读取中…';

  return `
  <div class="mask-hero" style="align-items:center">
    <div style="display:flex;gap:18px;align-items:center">
      <div class="brand-mark" style="width:64px;height:64px;border-radius:16px;font-size:30px">王</div>
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
        <input type="password" id="ghToken" placeholder="${masked ? esc(masked) + '（已保存，留空则不修改）' : 'ghp_xxxxxxxxxxxx 未设置'}" autocomplete="off" />
        <button class="btn" data-act="token-doc" title="如何获取令牌">?</button>
        <button class="btn btn-primary" data-act="save-token">保存</button>
        <button class="btn btn-sm" data-act="quota-refresh">刷新额度</button>
      </div>
      <div class="hint" style="margin-top:8px">
        令牌只保存在本机配置文件里，以掩码形式显示。点 <b>?</b> 打开 GitHub 官方的令牌创建教程。
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
    <div class="modal" onclick="event.stopPropagation()">
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
            <div id="upBar" style="height:100%;width:0;background:linear-gradient(90deg,#ffb020,#ff8a1c);transition:width .2s"></div>
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

/* ---------------- 视图：设置 ---------------- */
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
    <div class="card-title">拦截行为</div>
    <div class="card-sub">这些设置对所有规则生效。</div>
    ${sw('dryRun', st.dryRun, '演练模式', '只记录不真的关闭，用来先验证名单是否写对了')}
    ${sw('softClose', st.softClose, '先温和关闭', '先给程序发关闭信号，0.7 秒不退再强制结束，能保住一部分现场')}
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
    <div class="card-title">系统</div>
    ${sw('autostart', st.autostart, '开机自动启动', '写入 HKCU 的 Run 项，不需要管理员')}
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

  if (sum <= 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
    ctx.strokeStyle = '#232a3a';
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
      ctx.strokeStyle = '#0f1219';
      ctx.lineWidth = 2;
      ctx.stroke();
      ang += a;
    }
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = '#e8ecf4';
  ctx.font = '600 19px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(opts && opts.center ? opts.center : fmtDurShort(total).replace('h', ' 小时 ').replace('m', ' 分'), cx, cy + 2);
  ctx.fillStyle = '#6b7488';
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
  if (S.view === 'mask') html = viewMask();
  if (S.view === 'stats') html = viewStats();
  if (S.view === 'reports') html = viewReports();
  if (S.view === 'sync') html = viewSync();
  if (S.view === 'settings') html = viewSettings();
  if (S.view === 'about') html = viewAbout();
  $('#content').innerHTML = html;

  if (S.view === 'stats') {
    const cur = currentSlices();
    drawPie($('#pie'), cur.slices, cur.total, { sub: '累计前台时长' });
  }
}

/* ---------------- 动作 ---------------- */
const Act = window.Act = {
  async nav(view) {
    S.view = view;
    if (view === 'stats' && !S.stats) await loadStats();
    if (view === 'reports') await loadReports();
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

  async pickTarget() {
    S.pickerFor = 'mask';
    const list = await invoke('list_windows');
    S.picker = list;
    renderPicker();
  },

  async toggleMask() {
    const d = S.data;
    if (!d) return;
    if (d.mask.on) {
      await invoke('mask_stop');
      toast('遮罩已关闭');
      await pull();
      render();
    } else {
      const pid = d.config.settings.mask.targetPid;
      if (!pid) { Act.pickTarget(); return; }
      try {
        await invoke('mask_start', { pid, title: d.config.settings.mask.targetTitle || '' });
        toast('遮罩已开启，Ctrl+Alt+K 可随时退出', 'ok');
        await pull();
        render();
      } catch (e) {
        toast(String(e), 'err');
      }
    }
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

  async saveCustomDays() {
    const v = +(($('#customDays') || {}).value || 0);
    S.data.config.settings.stats.customDays = Math.max(0, Math.min(365, v));
    if (!S.data.config.settings.stats.customAnchor) S.data.config.settings.stats.customAnchor = todayStr();
    await saveConfig();
    toast(v > 0 ? `已设置每 ${v} 天生成一次报告` : '已关闭自定义周期', 'ok');
  },

  async cfgSwitch(k) {
    const st = S.data.config.settings;
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

  async saveNum(k) {
    const map = {
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

  /* ---- 自动更新 ---- */
  async checkUpdate() {
    toast('正在检查更新…');
    try {
      const r = await invoke('update_check');
      await pull();
      render();
      if (!r.ok) { toast('检查失败：' + r.error, 'err'); return; }
      if (r.newer) showUpdateModal(r, true);
      else toast('已经是最新版本 v' + r.current, 'ok');
    } catch (e) { toast('检查失败：' + e, 'err'); }
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
  await invoke('save_config', { config: S.data.config });
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

/* ---------------- 弹层 ---------------- */
function closeModal() { $('#modalRoot').innerHTML = ''; }

function renderPicker() {
  const list = (S.picker || []).filter((w) => w.title);
  const html = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" onclick="event.stopPropagation()">
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
    <div class="modal wide" onclick="event.stopPropagation()" style="width:940px">
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
        ctx.strokeStyle = '#0f1219'; ctx.lineWidth = 2; ctx.stroke();
        ang += a;
      }
    } else {
      ctx.beginPath(); ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
      ctx.strokeStyle = '#232a3a'; ctx.lineWidth = rOut - rIn; ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e8ecf4'; ctx.font = '600 15px "Microsoft YaHei UI", sans-serif';
    ctx.fillText(fmtDurShort(tot), cx, cy + 1);
    ctx.fillStyle = '#6b7488'; ctx.font = '10px "Microsoft YaHei UI", sans-serif';
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
    S.editing.mode = el.dataset.mode;
    renderEditor(); return;
  }
  if (act === 'editor-tab') { S.editorTab = el.dataset.tab; renderEditor(); return; }
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
  if (act === 'pick-target') { await Act.pickTarget(); return; }
  if (act === 'pick-item') {
    const w = (S.picker || []).filter((x) => x.title)[+el.dataset.i];
    if (!w) return;
    if (S.pickerFor === 'mask') {
      closeModal();
      try {
        await invoke('mask_start', { pid: w.pid, title: w.title });
        await pull(); render();
        toast('遮罩已开启，Ctrl+Alt+K 可随时退出', 'ok');
      } catch (err) { toast(String(err), 'err'); }
    } else {
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
  if (act === 'toggle-click') { await Act.toggleClick(); return; }
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
  if (act === 'save-protected') { await Act.saveProtected(); return; }
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

/* 输入框回车 */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modalRoot').innerHTML) { S.editing = null; closeModal(); }
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
});

/* 启动 */
(async function boot() {
  await pull();
  await loadReports();
  if (!S.data) { $('#content').innerHTML = '<div class="empty">无法连接后台服务</div>'; return; }
  S.customStart = todayStr();
  S.customEnd = todayStr();
  render();
  setInterval(pull, 1500);

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
