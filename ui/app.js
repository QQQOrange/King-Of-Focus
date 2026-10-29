/* King Of Focus — 前端逻辑 */
'use strict';

const T = window.__TAURI__;
const invoke = T && T.core ? T.core.invoke : async () => { throw new Error('需要在 King Of Focus 中运行'); };

/* 多语言：I.t 查词典，I.apply 在每次渲染后翻译 DOM。
 * 用 I 而不是 T，因为 T 已经被 Tauri 的全局对象占了。 */
const I = window.I18N || {
  getLang: () => 'zh-CN',
  setLang: () => {},
  apply: () => {},
  restore: () => {},
  t: (s) => s,
  has: () => false,
};
/** 单句翻译（toast、动态文案用；DOM 里的由 I.apply 统一处理） */
const L = (s) => I.t(s);

/** 当前语言偏好：只有 zh-CN / en 两种，默认简体中文 */
function langPref() {
  const v = (S.data && S.data.config && S.data.config.settings && S.data.config.settings.lang) || 'zh-CN';
  return v === 'en' ? 'en' : 'zh-CN';
}

/** 全量应用语言：启动与切换语言时调用（zh 时相当于还原） */
function applyLang() {
  const l = langPref();
  I.setLang(l);
  document.documentElement.lang = l === 'en' ? 'en' : 'zh-CN';
  I.apply(document.body);
}

/** 渲染后只处理内容区：骨架的翻译是持久的，重绘的只有 #content。
 *  这样每 1.5 秒的轮询重绘不会把整棵树再遍历一遍。 */
function applyLangView() {
  const l = langPref();
  I.setLang(l);
  if (l === 'en') {
    // render 会同时改写这几个区域，它们都不在 #content 里：
    //   页面标题、侧栏状态、顶部状态胶囊、主题按钮
    ['#content', '#pageTitle', '#sideStatus', '#statePill', '#themeBtn'].forEach((sel) => {
      const el = $(sel);
      if (el) I.apply(el);
    });
  }
}

const S = {
  view: 'overview',
  data: null,
  editing: null,
  editingNew: false,
  editorTab: 'apps',
  modalMode: 'editor',   // 'editor' | 'slot'
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
  tkDrag: null,
  tkBase: null,
  ccDrag: null,
  ccRect: null,
  ccHover: null,
  browsers: null,
  browserScanning: false,
};

const PALETTE = ['#ffb020', '#ff7a45', '#f759ab', '#b37feb', '#5b8cff', '#36cfc9',
  '#52c41a', '#a0d911', '#faad14', '#ff5c5c', '#40a9ff', '#9254de'];

const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const VIEW_TITLES = {
  overview: '总览', rules: '自律规则', clock: '自律时段', mask: '专注遮罩', browsers: '浏览器插件',
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
  el.textContent = L(msg);
  $('#toastRoot').appendChild(el);
  // 先播退场（淡出 + 上移），再真正移除——直接 remove 会"啪"地消失
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 150);
  }, 3050);
}

/* ---------------- 动效偏好 ----------------
 * 两条降级路径，规则写在 app.css 末尾的「动效规范」一节：
 *   · 系统开了"减少动态效果" → 装饰性动画全部关掉
 *   · 低配设备（核数、内存都低）→ 同上，但保留拖拽/落位这类功能性过渡
 * 只降不删：信息与可操作性一点不少，只是不动了。
 */
function applyMotionPref() {
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const cores = navigator.hardwareConcurrency || 8;
  const mem = navigator.deviceMemory || 8;
  const low = reduce || (cores <= 4 && mem <= 4);
  document.documentElement.dataset.motion = low ? 'low' : 'full';
}

/* ---------------- 自律权限 ----------------
 *
 * 非测试模式下，只要处在自律时段里（含休息段），就不许动纪律相关的开关：
 * 不能关自律规则、不能切换自律规则开关、不能关「自律时段」总开关、不能切/删方案、
 * 不能取消已选时段。界面先置灰一道，后端 save_config 再拦一道——直接调命令也绕不过去。
 *
 * 门槛用 clockInWindow 而不是 clockOn：50/10 的小时段里，
 * 只在专注段锁定等于"每小时送你 10 分钟随便改"。
 */
function settingsFrozen() {
  const d = S.data;
  if (!d) return false;
  if (d.testMode) return false;        // 测试模式的意义就是"随时开关"
  const rt = d.runtime || {};
  return !!(rt.clockOn || rt.clockInWindow || rt.locked);
}

/** 自律时段（专注段）正在生效 */
function clockRunning() {
  const d = S.data;
  if (!d || d.testMode) return false;
  return !!(d.runtime && d.runtime.clockOn);
}

/** 界面层拦一道：返回 true 表示"这次操作被拒绝了" */
function guardDiscipline(what) {
  if (!settingsFrozen()) return false;
  toast(`自律时段生效中，${what || '这个设置'}改不了；等这一段结束再改`, 'err');
  return true;
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
    parts.push(`生效中的自律规则：<b>${d.runtime.active.map((a) => esc(a.name)).join('、')}</b>`);
  } else if (!d.runtime.clockOn && !d.runtime.clockBreak) {
    parts.push('当前没有生效的自律规则');
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

  // 侧栏与状态胶囊刚被重写成中文（每秒都会走一遍），英文界面下要立刻翻回来
  applyLangView();
}

/* ---------------- 激励语录（Hub 顶部） ----------------
 *
 * 语录有两个来源，界面上必须能一眼分清：
 *   · 自己写的（设置里存的那几条，滚动轮换）
 *   · 联网取到的（一言 hitokoto，后台按「语录刷新间隔」更新）
 * 自己写的优先排在前面——用户写的话本来就该先看到自己那句。
 */
const QUOTE_SRC = {
  custom: '我写的',
  // 联网的句子来自「一言」公开接口，把站点写出来，用户一眼知道出处
  net: '一言 · hitokoto.cn',
  local: '内置句子',
  empty: '还没有语录',
};

function quotePool() {
  const st = (S.data && S.data.config && S.data.config.settings) || {};
  const rt = (S.data && S.data.runtime) || {};
  const pool = (st.customQuotes || []).filter(Boolean).map((t, i) => ({
    key: 'c' + i, text: t, from: '', src: 'custom',
  }));
  if (rt.quote) {
    // 有 from 才说明这条是联网取回来的；没有 from 的是本地兜底句
    pool.push({ key: 'net', text: rt.quote, from: rt.quoteFrom || '', src: rt.quoteFrom ? 'net' : 'local' });
  }
  return pool;
}

/** 当前要显示的那一条。选了哪条记在 S.quoteAt，刷新页面/切页回来不会跳。 */
function quoteView() {
  const pool = quotePool();
  if (!pool.length) {
    return { key: '', text: '把想对自己说的话写下来，每次打开 Hub 都能看到。', from: '', src: 'empty' };
  }
  let it = pool.find((x) => x.key === S.quoteAt);
  if (!it) {
    it = pool[0];
    S.quoteAt = it.key;
  }
  return it;
}

/* ---------------- 视图：总览 ---------------- */
function viewOverview() {
  const d = S.data;
  if (!d) return '<div class="empty is-loading">加载中…</div>';
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
        ${ruleBadge(a)}</span>`).join('')
    : '<span class="muted">暂无生效自律规则。到「自律规则」里新建一条——它只会在自律时间内生效。</span>';

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

  const q = quoteView();
  const qN = ((d.config.settings || {}).customQuotes || []).length;
  return `
  ${lockBanner}${unlockBanner}
  <section class="hub-quote" aria-label="激励语录">
    <div class="qmark">“</div>
    <div class="qbody">
      <div class="qtext">${esc(q.text)}</div>
      <div class="qmeta">
        <span class="qsrc ${q.src}">${QUOTE_SRC[q.src] || q.src}</span>
        ${q.from ? `<span class="qfrom">—— ${esc(q.from)}</span>` : ''}
        ${q.src === 'net' ? '<span class="qhint">（来自 hitokoto.cn 公开接口）</span>' : ''}
      </div>
    </div>
    <div class="qops">
      <button class="btn btn-sm" data-act="quote-next" title="换一条（自己写的和联网的都会轮换）">换一条</button>
      <button class="btn btn-sm" data-act="quote-manage">我的语录${qN ? ` · ${qN}` : ''}</button>
      <button class="btn btn-sm" data-act="quote-add-new" title="直接写一句新的">＋ 添加</button>
    </div>
  </section>

  <div class="hero">
    <div class="hero-main">
      <div class="hero-label">当前状态</div>
      <div class="hero-state ${on || rt.breakOn ? 'on' : ''}">${phase}</div>
      <div class="hero-desc">${rt.breakOn
        ? `休息 ${mmss(phaseLeft)}，这段时间自律规则是放开的，时间到自动锁回去。`
        : on
          ? `自律规则里的软件与网页已被拦住：${esc(rt.active.map((a) => a.name).join('、'))}`
          : '现在不在自律时间，自律规则静默中。'}</div>
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
      <span class="hint">${on || rt.breakOn ? '解锁期间所有拦截暂停，倒计时结束自动恢复' : '现在没有生效的自律规则，暂时不需要解锁'}</span>
    </div>
  </div>

  <div class="card">
    <div class="card-title">生效中的自律规则</div>
    <div class="card-sub">自律规则只在<b>自律时间</b>（自律时段的专注段）内生效，其余时间一律静默。</div>
    <div>${chips}</div>
  </div>

  <div class="grid-2" style="margin-top:16px;align-items:start">
    <div class="card">
      <div class="card-title">最近拦截</div>
      <div class="card-sub">只记录最近 240 条，含时间、类型、对象与命中自律规则。</div>
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

/** 一条自律规则的「生效类型」。
 *
 * 三档，列表、卡片、编辑器标题都用这一份，避免三处各写一套 if：
 *   blacklist 自律规则       —— 名单里的软件 / 网站被拦下，其余放行
 *   whitelist 白名单       —— 只有名单里的能用，其余全拦
 *   both      两者同时生效 —— 名单里照样拦，同时「例外」作为白名单放行
 */
const RULE_KINDS = {
  blacklist: {
    label: '黑名单',
    short: '黑名单',
    cls: 'gold',
    note: '名单里的软件 / 网站会被拦下，其余放行',
  },
  whitelist: {
    label: '白名单',
    short: '白名单',
    cls: 'red',
    note: '只有名单里的能用，其余一律拦掉',
  },
  both: {
    label: '黑名单 + 白名单',
    short: '黑+白',
    cls: 'blue',
    note: '名单里的照样拦，「例外」里的放行',
  },
};
const ruleKind = (r) => RULE_KINDS[(r && r.mode) || 'blacklist'] || RULE_KINDS.blacklist;
/** 列表里那个一眼能认出来的类型标记 */
function ruleBadge(r) {
  const k = ruleKind(r);
  return `<span class="badge kind" title="${esc(k.label)}：${esc(k.note)}">`
    + `<i class="kd ${k.cls}"></i>${k.label}</span>`;
}

/* ---------------- 视图：自律规则 ---------------- */
/** 把一段 [a,b) 按番茄配置切成「专注 / 休息」交替的连续小段。
 *  口径与后端 sched::pomodoro_state 一致：周期从时段起点开始算。 */
function slSplit(r, a, b) {
  const brk = (r && r.brk) || {};
  const work = +brk.workMin || 0, rest = +brk.breakMin || 0;
  const pomo = brk.kind === 'pomodoro' && work > 0 && rest > 0;
  if (!pomo) return [{ a, b, type: 'focus' }];
  const cycle = work + rest;
  const out = [];
  let cur = a;
  while (cur < b) {
    const phase = (cur - a) % cycle;
    const isBreak = phase >= work;
    let nxt;
    if (isBreak) nxt = cur + (cycle - phase);
    else nxt = cur + (work - phase);
    if (nxt > b) nxt = b;
    out.push({ a: cur, b: nxt, type: isBreak ? 'break' : 'focus' });
    cur = nxt;
  }
  return out;
}
/** 某一天的色块序列（跨夜时段算到次日 00:00 之前） */
function slDaySegs(r, day) {
  const slots = ((r && r.schedule) || [])[day] || [];
  const out = [];
  for (const s of slots) {
    const end = s.end <= s.start ? 1440 : s.end;
    for (const seg of slSplit(r, s.start, end)) out.push(seg);
  }
  out.sort((x, y) => x.a - y.a);
  return out;
}

/* 把一周的时段压成「每天 / 工作日 / 周一」这类人话摘要 */
function schedCompact(sched) {
  if (!sched || sched.every((d) => !d || !d.length)) return '全天生效';
  const groups = [];
  for (let i = 0; i < 7; i++) {
    const slots = (sched[i] || []).map((s) => `${mins(s.start)}-${mins(s.end)}`).join(',');
    if (!slots) continue;
    let g = groups.find((x) => x.slots === slots);
    if (!g) { g = { slots, days: [] }; groups.push(g); }
    g.days.push(i);
  }
  return groups.map((g) => {
    let dn;
    if (g.days.length === 7) dn = '每天';
    else if (g.days.join() === '0,1,2,3,4') dn = '工作日';
    else if (g.days.join() === '5,6') dn = '周末';
    else dn = g.days.map((i) => DAYS[i]).join('/');
    return `${dn} ${g.slots}`;
  }).join('　');
}

/* 单条自律时段的迷你时间分布图（7 列 = 周一~周日，色块按专注/休息区分） */
function slMini(r) {
  const cols = DAYS.map((d, di) => {
    const bs = slDaySegs(r, di).map((s) => {
      const top = (s.a / 1440) * 100;
      const h = Math.max(3, ((s.b - s.a) / 1440) * 100);
      const bg = s.type === 'break' ? 'var(--green)' : (r.color || '#4d8dff');
      return `<i style="top:${top.toFixed(2)}%;height:${h.toFixed(2)}%;background:${esc(bg)}"></i>`;
    }).join('');
    return `<div class="sl-mini-col" title="${DAYS[di]}">${bs}</div>`;
  }).join('');
  return `<div class="sl-mini">${cols}</div>`;
}

function viewRules() {
  const d = S.data;
  if (!d) return '';
  const rules = d.config.rules;
  const activeNames = new Set((d.runtime.active || []).map((a) => a.name));
  const hardLocked = !!d.runtime.locked;
  const locked = settingsFrozen();      // 固化中 或 自律时段生效中

  // 自律规则条目 = 纯名单：名称 + 软件 / 网站 / 例外 + 开关。
  // **不显示任何"时间范围"** —— 什么时候生效由「自律时段」统一决定，
  // 自律规则只管"自律时间里不能开什么"，两件事不混在一起。
  const item = (l) => `
    <div class="sl-item ${activeNames.has(l.name) ? 'active' : ''}" data-act="edit-rule" data-id="${l.id}">
      <div class="sl-item-bar" style="background:${esc(l.color || '#4d8dff')}"></div>
      <div class="sl-item-main">
        <div class="sl-item-name">${esc(l.name)}
          ${ruleBadge(l)}
          ${l.hard ? '<span class="badge red">固化</span>' : ''}
          ${l.brk && l.brk.kind === 'pomodoro' ? `<span class="badge blue">番茄 ${l.brk.workMin}/${l.brk.breakMin}</span>` : ''}
          ${activeNames.has(l.name) ? '<span class="badge green">生效中</span>' : ''}
        </div>
        <div class="sl-item-meta">
          ${l.apps.length} 个软件 · ${l.sites.length} 个网站 · ${l.exceptions.length} 条例外
        </div>
      </div>
      <div class="sl-item-act">
        <div class="switch${locked ? ' locked' : ''}" data-act="toggle-rule" data-id="${l.id}"
             style="${locked ? 'pointer-events:none;opacity:.32' : ''}"
             title="${locked ? (hardLocked ? '自律固化中，开关已锁定' : '自律时段生效中，开关已锁定') : '启用 / 停用'}">
          <input type="checkbox" ${l.enabled ? 'checked' : ''}><i></i>
        </div>
        <button class="btn btn-sm" data-act="del-rule" data-id="${l.id}" ${locked ? 'disabled' : ''}>删除</button>
      </div>
    </div>`;

  const groups = [];
  const push = (title, note, arr) => {
    if (!arr.length) return;
    groups.push(`<div class="sl-group">
      <div class="sl-group-hd"><span class="sl-group-title">${title}</span><span class="muted">${note}</span></div>
      <div class="sl-grid">${arr.map(item).join('')}</div>
    </div>`);
  };
  // 按"生效类型"分组：三档各一组，顺序固定（黑 → 白 → 两者）
  push('黑名单', '自律时间里，名单里的软件 / 网站会被拦下，其余放行',
    rules.filter((l) => (l.mode || 'blacklist') === 'blacklist'));
  push('白名单', '自律时间里，只有名单里的能用，其余一律拦掉',
    rules.filter((l) => l.mode === 'whitelist'));
  push('黑名单 + 白名单同时生效', '名单里的照样拦，同时「例外」作为白名单放行',
    rules.filter((l) => l.mode === 'both'));

  const body = rules.length
    ? groups.join('')
    : '<div class="empty">还没有自律规则。点右上角「新建自律规则」开始。</div>';

  const banner = hardLocked
    ? `<div class="note" style="border-left:3px solid var(--red);background:rgba(255,92,92,.07);border-color:rgba(255,92,92,.22);margin-bottom:16px">
    <b style="color:var(--red)">🔒 自律固化中</b>：${esc((d.runtime.lockNames || []).join('、'))} 正在生效，
    <b>${esc(d.runtime.lockUntilText || '时段结束')}</b> 之前所有开关都已置灰，改不了也关不掉。
  </div>`
    : (clockRunning() ? `<div class="note" style="border-left:3px solid var(--red);background:rgba(255,92,92,.07);border-color:rgba(255,92,92,.22);margin-bottom:16px">
    <b style="color:var(--red)">🔒 自律时段生效中</b>：这段时间自律规则开关整体锁定（开、关都不行），也不能删除条目、
    不能关掉「自律时段」本身——等这一段结束（或用积分解锁）之后才能改。
  </div>` : '');

  // 顶部常驻状态条：让"只在自律时间生效"这件事一眼可见，而不是藏在帮助里
  const fc = d.config.settings.focusClock || {};
  const statusBar = !fc.enabled
    ? `<div class="note" style="border-left:3px solid var(--gold);margin-bottom:14px">
        <b>自律时段没启用</b>：自律规则<b>只在自律时间内生效</b>，现在这个功能是整体静默的。
        先去「自律时段」把要自律的时段画出来，这里才会开始拦。
      </div>`
    : (d.runtime.clockOn
      ? `<div class="note" style="border-left:3px solid var(--green);margin-bottom:14px">
          <b style="color:var(--green)">● 自律时间进行中</b>：第 ${d.runtime.clockHour} 段专注中，下面的自律规则正在生效。
        </div>`
      : `<div class="note" style="border-left:3px solid var(--line);margin-bottom:14px">
          <b>当前不在自律时间</b>：自律规则只在「自律时段」的专注段内生效，
          其余时间（含番茄休息段）一律不拦。下面的开关可以先配好，到点自动生效。
        </div>`);

  return `
  ${banner}
  ${statusBar}
  <div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:16px">
    <div class="hint" style="max-width:660px">
      一条<b>自律规则</b> = 一份软件 / 网站名单 + 一张周时间表。<br>
      <b>生效前提是自律时间</b>：只有「自律时段」正在专注时才可能拦人；<br>
      时间表是在这之上再收窄——全空 = 自律时间内全程生效，画了格子就只在格子里生效。<br>
      点任意一条会打开独立弹窗，用图表方式查看和调整时间分布。
    </div>
    <button class="btn btn-primary" data-act="new-rule" ${hardLocked ? 'disabled' : ''}>+ 新建自律规则</button>
  </div>
  ${body}`;
}

/* ---------------- 自律规则条目编辑器 ---------------- */
/** 打开某条自律时段的独立弹窗（滴答清单图表式） */
function openSlotModal(id) {
  const d = S.data;
  if (!d) return;
  const src = d.config.rules.find((x) => x.id === id);
  if (!src) return;
  S.editing = JSON.parse(JSON.stringify(src));
  S.editingNew = false;
  S.editorTab = 'slot';
  S.modalMode = 'slot';
  renderSlotModal();
}

function renderSlotModal() {
  const r = S.editing;
  if (!r) return;
  // 自律规则弹窗 = **纯名单编辑**，不再有周时间表。
  // 时间只在「自律时段」排一次；这里只管"自律时间里不能开什么"。
  const html = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal wide tk-modal">
      <div class="modal-hd">
        <h3>${esc(r.name || '自律规则')}
          ${ruleBadge(r)}
          ${r.hard ? '<span class="badge red">固化</span>' : ''}
          ${r.brk && r.brk.kind === 'pomodoro' ? `<span class="badge blue">番茄 ${r.brk.workMin}/${r.brk.breakMin}</span>` : ''}
          ${r.enabled ? '<span class="badge green">已启用</span>' : '<span class="badge">未启用</span>'}
        </h3>
        <button class="close-x" data-act="close-editor">×</button>
      </div>
      <div class="modal-bd">
        <div class="row" style="gap:10px;margin-bottom:12px;align-items:center">
          <input type="text" id="ruleName" value="${esc(r.name)}" style="flex:1;font-size:14.5px;font-weight:650" placeholder="名字，例如：短视频与游戏" />
        </div>
        <div class="rule-kind-row">
          <span class="rk-lab">生效类型</span>
          <div class="seg">
            ${[['blacklist', '黑名单'], ['whitelist', '白名单'], ['both', '两者同时']].map(([v, t]) =>
              `<button class="${(r.mode || 'blacklist') === v ? 'active' : ''}" data-act="mode" data-mode="${v}"
                 title="${esc(RULE_KINDS[v].note)}">${t}</button>`).join('')}
          </div>
          <span class="rk-note">${esc(ruleKind(r).note)}</span>
        </div>
        <div class="note" style="margin-bottom:14px">
          生效时间由「<b>自律时段</b>」统一决定：<b>自律时间里，按上面的类型生效</b>；
          自律时间之外一律不拦。所以这里不需要、也不提供时间设置。
        </div>
        <div class="tk-info">
          <div><b>${r.apps.length}</b> 个软件</div>
          <div><b>${r.sites.length}</b> 个网站</div>
          <div><b>${r.exceptions.length}</b> 条例外</div>
          <div><b>${r.extraProtected && r.extraProtected.length ? r.extraProtected.length : 0}</b> 项额外保护</div>
        </div>
      </div>
      <div class="modal-ft">
        <button class="btn" data-act="slot-more">编辑名单…</button>
        <button class="btn" data-act="close-editor">取消</button>
        <button class="btn btn-primary" data-act="save-slot">保存</button>
      </div>
    </div>
  </div>`;
  $('#modalRoot').innerHTML = html;
}

function openEditor(id, isNew) {
  const d = S.data;
  if (!d) return;
  let rule;
  if (isNew) {
    rule = {
      id: 'r' + Date.now().toString(36),
      name: '新自律规则',
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
    rule = JSON.parse(JSON.stringify(d.config.rules.find((x) => x.id === id)));
  }
  S.editing = rule;
  S.editingNew = !!isNew;
  S.editorTab = 'apps';
  S.modalMode = 'editor';
  renderEditor();
}

function renderEditor() {
  if (S.modalMode === 'slot') { renderSlotModal(); return; }
  renderFullEditor();
}

function renderFullEditor() {
  const r = S.editing;
  if (!r) return;
  const tabs = [
    ['apps', `软件 (${r.apps.length})`],
    ['sites', `网站 (${r.sites.length})`],
    ['exceptions', `网站例外 (${r.exceptions.length})`],
    ['break', '休息'],
    ['lock', '固化'],
  ];

  let body = '';
  if (S.editorTab === 'apps') body = tabApps(r);
  if (S.editorTab === 'sites') body = tabSites(r);
  if (S.editorTab === 'exceptions') body = tabExceptions(r);
  if (S.editorTab === 'break') body = tabBreak(r);
  if (S.editorTab === 'lock') body = tabLock(r);

  const html = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal wide tk-modal">
      <div class="modal-hd">
        <h3>${S.editingNew ? '新建自律时段' : esc(r.name)}
          ${ruleBadge(r)}
          ${r.hard ? '<span class="badge red">固化</span>' : ''}
          ${r.brk && r.brk.kind === 'pomodoro' ? `<span class="badge blue">番茄 ${r.brk.workMin}/${r.brk.breakMin}</span>` : ''}
        </h3>
        <button class="close-x" data-act="close-editor">×</button>
      </div>
      <div class="modal-bd">
        <div class="row" style="gap:10px;margin-bottom:14px;align-items:center">
          <input type="text" id="ruleName" value="${esc(r.name)}" style="flex:1;font-size:14px;font-weight:600" placeholder="时段名称，例如：晚自习" />
          <div class="seg">
            ${[['blacklist', '黑名单'], ['whitelist', '白名单'], ['both', '两者同时']].map(([v, t]) =>
              `<button class="${(r.mode || 'blacklist') === v ? 'active' : ''}" data-act="mode" data-mode="${v}"
                 title="${esc(RULE_KINDS[v].note)}">${t}</button>`).join('')}
          </div>
        </div>
        ${r.mode === 'both' ? `<div class="note" style="margin-bottom:14px">
          <b>黑名单 + 白名单同时生效</b>：名单里的软件 / 网站照样被拦下；
          同时「例外」当作白名单用 —— 例外里的条目永远不会被这条规则拦。
        </div>` : ''}
        ${r.mode === 'whitelist' ? `<div class="note" style="margin-bottom:14px">
          <b>白名单</b>：生效时段内，只有下面名单里的软件可以打开，其他所有前台窗口都会被关掉。
          系统进程、资源管理器、本程序自身以及「设置 → 全局保护」里的进程不会被拦截。
        </div>` : ''}
        <div class="note" style="margin-bottom:14px">
          生效时间不在这里设：<b>「自律时段」决定什么时候进入自律时间</b>，
          这里只决定"自律时间里不能打开什么"。
        </div>
        <div class="tabs" style="margin-top:18px">${tabs.map(([k, n]) => `<button class="tab ${S.editorTab === k ? 'active' : ''}" data-act="editor-tab" data-tab="${k}">${n}</button>`).join('')}</div>
        ${body}
      </div>
      <div class="modal-ft">
        <button class="btn" data-act="close-editor">取消</button>
        <button class="btn btn-primary" data-act="save-editor">保存</button>
      </div>
    </div>
  </div>`;
  $('#modalRoot').innerHTML = html;
}

/* 滴答清单图表式时间分布：横轴 = 周一~周日，纵轴 = 00:00~24:00，色块 = 生效区间 */
function tkTimeVal(m) {
  const x = Math.max(0, Math.min(1440, +m || 0));
  if (x === 1440) return '24:00';
  return `${pad(Math.floor(x / 60) % 24)}:${pad(x % 60)}`;
}
function tkTimeParse(v) {
  const mt = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!mt) return null;
  const h = +mt[1], mm = +mt[2];
  if (h === 24 && mm === 0) return 1440;
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

function tabChart(r) {
  const axis = [];
  for (let h = 0; h <= 24; h += 3) {
    // 最后一格是 24:00（一天的结束），不能 %24 变成 00:00——
    // 那会让纵轴首尾都是 00:00，看起来像"刻度重复/错位"。
    const label = h === 24 ? '24:00' : `${pad(h)}:00`;
    const cls = h === 24 ? ' class="tk-axis-end"' : '';
    axis.push(`<span${cls} style="top:${(h / 24) * 100}%">${label}</span>`);
  }
  const cols = DAYS.map((d, di) => {
    const segs = slDaySegs(r, di);
    const blocks = segs.map((s) => {
      const top = (s.a / 1440) * 100;
      const h = Math.max(1.2, ((s.b - s.a) / 1440) * 100);
      const bg = s.type === 'break'
        ? 'repeating-linear-gradient(135deg, rgba(53,208,127,.85) 0 6px, rgba(53,208,127,.5) 6px 12px)'
        : esc(r.color || '#4d8dff');
      const label = `${mins(s.a)} - ${mins(s.b)}`;
      return `<div class="tk-seg ${s.type}" style="top:${top.toFixed(3)}%;height:${h.toFixed(3)}%;background:${bg}" title="${label}"><em>${label}</em></div>`;
    }).join('');
    const slots = (r.schedule[di] || []);
    const hint = slots.length
      ? slots.map((s) => `${mins(s.start)}-${mins(s.end)}`).join('、')
      : '未设置';
    return `<div class="tk-col">
      <div class="tk-track" data-day="${di}" title="${d}：${esc(hint)}">${blocks}</div>
      <div class="tk-col-day">${d}</div>
    </div>`;
  }).join('');

  const slotRows = DAYS.map((d, di) => {
    const slots = (r.schedule[di] || []).map((s, i) => `
      <div class="tk-slot">
        <span class="tk-slot-day">${d}</span>
        <input type="text" class="tk-time" value="${tkTimeVal(s.start)}" data-act="tk-slot-start" data-day="${di}" data-i="${i}" size="5" maxlength="5" />
        <span class="muted">→</span>
        <input type="text" class="tk-time" value="${tkTimeVal(s.end)}" data-act="tk-slot-end" data-day="${di}" data-i="${i}" size="5" maxlength="5" />
        <button class="x" data-act="tk-slot-del" data-day="${di}" data-i="${i}">×</button>
      </div>`).join('');
    return slots;
  }).join('');

  return `
    <div class="tk-chart">
      <div class="tk-axis">${axis.join('')}</div>
      <div class="tk-cols">${cols}</div>
    </div>
    <div class="tk-tools">
      <button class="chip-btn" data-act="sched-copy" data-from="0" data-to="1,2,3,4">周一 → 工作日</button>
      <button class="chip-btn" data-act="sched-copy" data-from="0" data-to="0,1,2,3,4,5,6">周一 → 全部</button>
      <button class="chip-btn" data-act="sched-clear">清空</button>
      <span class="hint" style="align-self:center">在某一列上<b>按住拖动</b>即可圈出时段；再次拖过同一段可取消。</span>
    </div>
    <div class="tk-legend">
      <span><i class="lg-focus"></i>生效区间</span>
      <span><i class="lg-break"></i>番茄休息（不拦截）</span>
      <span class="muted">时间表全空 = 全天生效；色块只在这条自律时段真正生效的时间段出现。</span>
    </div>
    <div class="tk-slots">
      <div class="tk-slots-hd">时段明细<span class="muted">（可精确到 15 分钟）</span></div>
      ${slotRows || '<div class="empty" style="padding:14px">还没有时段。在上方图表里拖动即可创建。</div>'}
    </div>`;
}

/* 图表重绘（拖动时实时刷新色块） */
function paintChart() {
  const r = S.editing;
  if (!r) return;
  document.querySelectorAll('.tk-track').forEach((track) => {
    const di = +track.dataset.day;
    const segs = slDaySegs(r, di);
    track.innerHTML = segs.map((s) => {
      const top = (s.a / 1440) * 100;
      const h = Math.max(1.2, ((s.b - s.a) / 1440) * 100);
      const bg = s.type === 'break'
        ? 'repeating-linear-gradient(135deg, rgba(53,208,127,.85) 0 6px, rgba(53,208,127,.5) 6px 12px)'
        : esc(r.color || '#4d8dff');
      const label = `${mins(s.a)} - ${mins(s.b)}`;
      return `<div class="tk-seg ${s.type}" style="top:${top.toFixed(3)}%;height:${h.toFixed(3)}%;background:${bg}" title="${label}"><em>${label}</em></div>`;
    }).join('');
  });
}

/* ---------------- 图表拖选（纵轴 00:00~24:00，15 分钟粒度） ---------------- */
const TK_STEP = 15;
function tkMinuteAt(track, clientY) {
  const rect = track.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
  const raw = ratio * 1440;
  return Math.max(0, Math.min(1440 - TK_STEP, Math.round(raw / TK_STEP) * TK_STEP));
}
function tkSlotAt(r, day, minute) {
  return ((r.schedule[day]) || []).some((s) => {
    const end = s.end <= s.start ? 1440 : s.end;
    return minute >= s.start && minute < end;
  });
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
    : '<div class="empty">没有例外。例外只在当前这条自律规则内生效。</div>';
  return `
    <div class="add-row">
      <input type="text" id="excInput" placeholder="要放行的网站，例如 mail.google.com" />
      <button class="btn btn-primary" data-act="add-exc">添加</button>
    </div>
    <div class="list-box">${rows}</div>
    <div class="hint" style="margin-top:12px">
      例外的优先级高于网站自律规则。想把「整个互联网」都拦掉、只放几个站点，
      就在网站页添加 <code>*.*</code>，再在这里把要放行的站点加进来。
    </div>`;
}

function tabBreak(r) {
  const b = r.brk || { kind: 'none', workMin: 25, breakMin: 5 };
  const pomo = b.kind === 'pomodoro';
  return `
    <div class="hint" style="margin-bottom:14px">
      开启番茄后，生效时段会被切成「专注 → 休息 → 专注 …」的循环。
      <b>休息期间这条自律规则不拦截</b>（自律规则里的软件和网页都能用），时间一到自动锁回去。
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
/* 图表拖动：在某一列上按住拖动 = 圈一段时段；拖过的区间若已在表内则取消 */
document.addEventListener('mousedown', (e) => {
  const track = e.target.closest('.tk-track');
  if (!track || !S.editing) return;
  e.preventDefault();
  const day = +track.dataset.day;
  const m = tkMinuteAt(track, e.clientY);
  const covered = tkSlotAt(S.editing, day, m);
  S.tkBase = JSON.parse(JSON.stringify(S.editing.schedule[day] || []));
  S.tkDrag = { day, from: m, to: m, mode: covered ? 'remove' : 'add' };
  tkDragApply(S.tkDrag);
});
document.addEventListener('mousemove', (e) => {
  if (!S.tkDrag) return;
  const track = document.querySelector(`.tk-track[data-day="${S.tkDrag.day}"]`);
  if (!track) return;
  const m = tkMinuteAt(track, e.clientY);
  if (m === S.tkDrag.to) return;
  S.tkDrag.to = m;
  tkDragApply(S.tkDrag);
});
document.addEventListener('mouseup', () => {
  if (!S.tkDrag || !S.editing) { S.tkDrag = null; return; }
  const { day, from, to } = S.tkDrag;
  S.editing.schedule[day] = tkApplyRange(S.tkBase || [], from, to);
  S.tkDrag = null;
  S.tkBase = null;
  renderEditor();
});

/** 把 [a,b) 这段按 15 分钟粒度"翻转"到 base 上：原本有就删、没有就加。
 *
 *  边界是**左闭右开**：拖 09:00→12:00 得到的就是 09:00-12:00。
 *  这里之所以抽成独立函数，是因为鼠标移动（预览）、松开（落定）两条路径
 *  各写一遍时曾经跑偏过 —— 预览用 `m <= b`，落定用另一套，结果落定后
 *  多出 12:00-12:15 一格，用户看到的是"拖不准"。
 */
function tkApplyRange(base, from, to) {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  const inBase = (m) => (base || []).some((s) => {
    const e2 = s.end <= s.start ? 1440 : s.end;
    return m >= s.start && m < e2;
  });
  let cur = base;
  if (a === b) {
    // 单击（没拖动）= 切换这一格
    cur = inBase(a) ? subRange(cur, a, a + TK_STEP) : addRange(cur, a, a + TK_STEP);
  } else {
    for (let m = a; m < b; m += TK_STEP) {
      cur = inBase(m) ? subRange(cur, m, m + TK_STEP) : addRange(cur, m, m + TK_STEP);
    }
  }
  return cur;
}

/** 拖动过程中的临时预览（基于拖动起点快照，避免反复叠加） */
function tkDragApply(drag) {
  const r = S.editing;
  if (!r) return;
  r.schedule[drag.day] = tkApplyRange(S.tkBase || [], drag.from, drag.to);
  paintChart();
}

/* ---------------- 视图：自律时段（7 列 × 24 小时柱状图） ---------------- */
const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const CC_DEF_W = 50, CC_DEF_B = 10; // 配置里没有通用时长时的兜底值
const CC_MAX_PROFILES = 12;         // 与后端 model::MAX_CLOCK_PROFILES 对齐
/** 一天切成 24 小时，每小时再竖向切成若干格 —— **格子的高度就是时间**。
 *
 * 为什么是竖向切（历史教训）：以前每小时从左到右切成 4 个方块，
 * 但判定点击落在哪一格用的是 `clientY`（纵向坐标），于是点最左边那格
 * 得到的是"中间那 15 分钟"，点第二格反而落到更上面一格 —— 方块的顺序
 * 和横条的位置对不上。现在方块本身也是竖向排布，看得见的顺序、
 * 点到的位置、画出来的横条三者用同一个坐标轴，不可能再错位。
 *
 * 粒度（每格多少分钟）由设置决定：10 或 15。它只影响"怎么画、怎么点"，
 * 判定永远按 from/to 的绝对分钟走，所以改粒度不会让已排好的时段失效。
 */
const CC_GRANS = [10, 15];
/** 当前粒度（分钟）：10 或 15 */
function ccStep() {
  const s = S.data && S.data.config && S.data.config.settings;
  const g = s && s.focusClock ? +s.focusClock.granularity : 15;
  return g === 10 ? 10 : 15;
}
/** 一小时被切成几格（15 分钟 → 4 格，10 分钟 → 6 格） */
const ccQCnt = () => 60 / ccStep();
/** 每小时的行高（px）：保证每格至少 13px，才点得准 */
const ccHourH = () => ccQCnt() * 13;
const qStart = (q) => q * ccStep();          // 第 q 格 → 起点分钟
const qEnd = (q) => (q + 1) * ccStep();      // 第 q 格 → 终点分钟
/** 夹到合法区间并把边界落回当前粒度（from 向下取整、to 向上取整）。
 *  只做对齐，不偷偷把非法区间翻成整小时——「起 >= 止」原样透出，
 *  由调用方（右键菜单 / clockSetWB）拦截并提示，避免非法输入被静默改写。 */
function ccSnapWin(f, t) {
  let a = Math.max(0, Math.min(59, Math.round(f || 0)));
  let b = Math.max(1, Math.min(60, Math.round(t == null ? 60 : t)));
  a = Math.floor(a / ccStep()) * ccStep();
  b = Math.ceil(b / ccStep()) * ccStep();
  if (b > 60) b = 60;
  return { f: a, t: b };
}

/** 归一化一套方案：7 天 × 24 小时 + 时长夹紧 */
function ccNormProfile(p, idx) {
  if (!p || typeof p !== 'object') p = {};
  if (!p.id) p.id = `p${idx + 1}`;
  if (!p.name) p.name = `方案 ${idx + 1}`;
  // 通用时长：新框选/单击选中的时段沿用（右键菜单可更新）
  p.defWork = Math.max(1, Math.min(60, Math.round(p.defWork || CC_DEF_W)));
  p.defBrk = Math.max(0, Math.min(60, Math.round(p.defBrk || CC_DEF_B)));
  if (p.defBrk > 0 && p.defWork + p.defBrk > 60) p.defBrk = 60 - p.defWork;
  const fresh = () => ({ on: false, work: p.defWork, brk: p.defBrk, from: 0, to: 60 });
  if (!Array.isArray(p.days)) p.days = [];
  while (p.days.length < 7) p.days.push(Array.from({ length: 24 }, fresh));
  p.days.length = 7;
  p.days.forEach((day, d) => {
    if (!Array.isArray(day)) p.days[d] = Array.from({ length: 24 }, fresh);
    const dd = p.days[d];
    while (dd.length < 24) dd.push(fresh());
    dd.length = 24;
    for (const h of dd) {
      h.work = Math.max(0, Math.min(60, Math.round(h.work || 0)));
      h.brk = Math.max(0, Math.min(60, Math.round(h.brk || 0)));
      // 起止分钟：夹到合法区间并对齐 15 分钟刻度；起始不早于结束，否则按整小时算
      const snap = ccSnapWin(h.from, h.to);
      h.from = snap.f;
      h.to = snap.t;
      if (h.brk > 0) {
        h.work = Math.max(1, Math.min(59, h.work));
        if (h.work + h.brk > 60) h.brk = 60 - h.work;
      }
    }
  });
  return p;
}

/** 归一化 focusClock：多套「星期时段」方案（兼容旧版单套 days / 更旧的 hours） */
function clockCfg() {
  const s = S.data && S.data.config && S.data.config.settings;
  if (!s) return { enabled: false, applyRules: true, active: 'p1', profiles: [] };
  if (!s.focusClock) s.focusClock = { enabled: false, applyRules: true, active: 'p1', profiles: [] };
  const fc = s.focusClock;
  if (!Array.isArray(fc.profiles)) fc.profiles = [];
  // 旧版迁移：单套方案摊在 focusClock.days（更旧的是 hours）上，搬进第一套
  if (!fc.profiles.length) {
    let legacyDays = null;
    if (Array.isArray(fc.days) && fc.days.length) {
      legacyDays = fc.days;
    } else     if (Array.isArray(fc.hours) && fc.hours.length) {
      const one = [];
      for (let h = 0; h < 24; h++) {
        const p = fc.hours[h] || {};
        one.push({ on: !!p.on, work: +(p.work || CC_DEF_W), brk: +(p.brk || CC_DEF_B), from: 0, to: 60 });
      }
      legacyDays = Array.from({ length: 7 }, () => one.map((p) => ({ ...p })));
    }
    fc.profiles.push({
      id: 'p1',
      name: '默认时段',
      days: legacyDays || [],
      defWork: fc.defWork,
      defBrk: fc.defBrk,
    });
    fc.active = 'p1';
  }
  fc.profiles.forEach((p, i) => ccNormProfile(p, i));
  if (!fc.profiles.some((p) => p.id === fc.active)) fc.active = fc.profiles[0].id;
  // 旧字段不再参与任何逻辑，留着只会造成"两份真相"
  delete fc.days;
  delete fc.hours;
  delete fc.defWork;
  delete fc.defBrk;
  return fc;
}

/** 当前生效的那套方案 */
function clockProfile() {
  const fc = clockCfg();
  return fc.profiles.find((p) => p.id === fc.active) || fc.profiles[0];
}

/** 把 DOM 里 `.cc-cell` 的选中态按「每列连续分钟」画成整块覆盖层。
 *
 * 为什么不在格子上画：格子之间有 3px 间距，半透明底色在间距里叠两次会
 * 变成一条亮缝，几个连续小时看起来就像几块独立的小方块。
 * 这里改成用 grid 跨行跨列的覆盖层——一个连续段就是**一个**圆角块，
 * 中间没有任何接缝；格子仍然负责命中、hover 与右键。
 *
 * 三件事让"连续"真的连续：
 * 1. 相邻的块（只隔 3px 网格间距）互相缝合：共享的那一侧不画圆角和描边，
 *    并由后侧的块用负边距把间距补上——看起来就是一整块，而不是一块块拼的。
 * 2. 选中窗口是分钟区间 [from,to)（右键或细分刻度设置），整块按**均匀分钟格**
 *    切片：与格子边界无关，所以 11:10–12:20 这种零碎时间也是一条整带，
 *    不会因为跨小时被切开。未选中的分钟用与格子同色的占位带让开。
 * 3. 整块只用一种颜色：块里不再按 专注/休息 切出不同深浅的色带，
 *    未选中的分钟用透明占位带让开（这是"没选满"，不是另一种颜色）。
 *
 * `override(d,h)` 传入时，用它的返回值代替配置里的值（拖选预览用）。 */
function ccRenderRuns(root, override) {
  const host = root || document;
  const grid = host.querySelector('#ccGrid') || document.getElementById('ccGrid');
  if (!grid) return;
  grid.querySelectorAll('.cc-run, .cc-drag').forEach((el) => el.remove());
  const fc = clockProfile();
  // `override(d,h)` 让拖拽预览可以临时替换某天的窗口，而不去改配置：
  //   返回 undefined = 用配置；{f,t} = 用这个窗口；null = 这一小时不选中。
  // 预览和提交共用同一个 ccHourResult，所以"看到什么"就是"写下什么"。
  const hourAt = (d, h) => {
    const base = (fc.days[d] && fc.days[d][h]) || { on: false, work: 0, brk: 0, from: 0, to: 60 };
    if (!override) return base;
    const ov = override(d, h);
    if (ov === undefined) return base;
    if (ov === null) return { ...base, on: false };
    return { ...base, on: true, from: ov.f, to: ov.t };
  };
  const clampW = (v) => Math.max(0, Math.min(60, Math.round(v || 0)));

  // 按列收集选中小时（以 DOM 为准：拖选预览用的是同一套 DOM 状态）
  const cols = new Map();
  grid.querySelectorAll('.cc-cell.on').forEach((c) => {
    const d = +c.dataset.d, h = +c.dataset.h;
    if (!cols.has(d)) cols.set(d, new Set());
    cols.get(d).add(h);
  });

  // 1) 每列先算出连续段，并记录这一段的「专注/休息配方」——
  //    配方不同的两天不能横向合并，否则色带会画错。
  //    分割点看「有效边界」：上一小时没到整点、或这一小时没从整点开始，
  //    中间就有没选中的分钟，必须切开——那个洞渲染时要让出来。
  //    切完的段只有首小时可以 from>0、尾小时可以 to<60，中间都是整小时。
  const segs = [];
  const pushSeg = (d, h0, h1) => {
    const mins = [];
    for (let i = h0; i <= h1; i++) {
      const p = hourAt(d, i);
      const w = p.on ? clampW(p.work) : clampW(fc.defWork);
      const b = p.on ? Math.max(0, Math.min(60 - w, clampW(p.brk))) : Math.min(clampW(fc.defBrk), 60 - w);
      mins.push(`${w}/${b}`);
    }
    segs.push({
      d, h0, h1,
      sig: mins.join(','),
      f0: Math.max(0, Math.min(59, Math.round(hourAt(d, h0).from || 0))),
      t1: Math.max(1, Math.min(60, Math.round(hourAt(d, h1).to == null ? 60 : hourAt(d, h1).to))),
    });
  };
  cols.forEach((hs, d) => {
    let h = 0;
    while (h < 24) {
      if (!hs.has(h)) { h++; continue; }
      const from = h;
      while (h + 1 < 24 && hs.has(h + 1)) h++;
      const to = h;
      let start = from;
      for (let i = from + 1; i <= to; i++) {
        const prev = hourAt(d, i - 1), cur = hourAt(d, i);
        const cont = (prev.to == null ? 60 : prev.to) >= 60 && (cur.from || 0) <= 0;
        if (!cont) {
          pushSeg(d, start, i - 1);
          start = i;
        }
      }
      pushSeg(d, start, to);
      h++;
    }
  });

  // 2) 每个「当天的一段连续小时」就是一块，**不再把相邻日期合并**。
  //
  //    以前会把"周一–周五 8–12、起止分钟和配方都一样"的那几天合成一块横跨五列的
  //    大色块。问题是：一旦和隔壁那天接上，圆角就只剩下最外沿那两个，中间全是
  //    直角——看起来像两块被硬粘在一起，也分不清哪块是周几。
  //    现在一天一块、各自四角圆润，日历的列感也回来了。

  const addBlock = (d0, h0, h1, f0, t1) => {
    const t1Min = t1;   // 尾小时的结束分钟，用于色块上的时长文字
    const n = h1 - h0 + 1;
    // 块内统一按「分钟」切片，但**每格只发一条同色带**：
    // 以前把一小时拆成 专注/休息/尾段 三条不同颜色，块里就成了调色盘。
    // 现在整块只有一种颜色（CSS 里 --cc-block），起止分钟之外才是透明的"没选满"。
    const unit = 100 / (n * 60);
    const parts = [];   // { gap, pct }
    for (let k = 0; k < n; k++) {
      const f = k === 0 ? f0 : 0;      // 首小时的起始分钟
      const t = k === n - 1 ? t1 : 60; // 尾小时的结束分钟
      if (f > 0) parts.push({ gap: true, pct: f * unit });
      if (t > f) parts.push({ gap: false, pct: (t - f) * unit });
      if (t < 60) parts.push({ gap: true, pct: (60 - t) * unit });
    }
    // 圆角要画在**填色带**上，而不是外层容器上：
    // 容器是整格高度、透明，01:15–01:45 这种块只占了中间一半，
    // 容器那四个角根本没有颜色，圆角自然"看不见"——这正是"非整点区间没圆角"的原因。
    // 于是一条连续块的三段（首/中/尾）分别取：上圆角、不带圆角、下圆角，
    // 拼起来就是一条上下圆润、中间无缝的色块。
    const solid = parts.filter((x) => !x.gap);
    solid.forEach((b, i) => {
      // 4px：格子本身只有 52px 高、一列不到 100px 宽，7px 显得太"胖"，
      // 4px 更贴合日历这种密集网格的精致感。
      b.radius = solid.length === 1 ? '4px'
        : i === 0 ? '4px 4px 0 0'
          : i === solid.length - 1 ? '0 0 4px 4px'
            : '0';
    });
    const bands = parts.map((b) => (b.gap
      ? `<i class="cc-gap" style="flex:0 0 ${b.pct.toFixed(3)}%"></i>`
      : `<i class="f" style="flex:0 0 ${b.pct.toFixed(3)}%;border-radius:${b.radius}"></i>`)).join('');
    const run = document.createElement('div');
    run.className = 'cc-run';
    run.dataset.d = String(d0);
    run.dataset.d1 = String(d0);
    run.dataset.h0 = String(h0);
    run.dataset.h1 = String(h1);
    run.dataset.f0 = String(f0);
    run.dataset.t1 = String(t1);
    // 第 1 行是星期表头、第 1 列是小时刻度 → 数据行/列都从 2 开始
    run.style.gridColumn = `${d0 + 2}`;
    run.style.gridRow = `${h0 + 2} / ${h1 + 3}`;
    // 色块上的时长文字（滴答清单风格）：09:00 – 12:00。
    // 注意结束分钟可能是 60，那是"到下一小时整点"，必须进成 12:00，
    // 不能直接写成 11:60（非法时间，之前真出现过）。
    const labStart = `${pad(h0)}:${pad(f0)}`;
    const eMin = Math.round(t1Min);
    const labEnd = eMin >= 60
      ? `${pad(Math.min(24, h1 + 1))}:00`
      : `${pad(h1)}:${pad(eMin)}`;
    // 时间文字：**任何长度都要显示**。
    // 10 / 15 分钟这种短块只有 13px 高，用常规字号会顶出去，
    // 于是分两档：足够高用常规字号；不够高换成 .tight（8.5px、行高 1.1），
    // 在 13px 里正好放得下一行。位置跟着首个填色带走，
    // 不然 01:15 开始的块会把字写在上面那截空白里。
    const spanPx = ((n * 60 - f0 - (60 - t1)) / 60) * ccHourH();
    const labTop = (f0 * unit).toFixed(3);
    const tight = spanPx < 20;
    const label = `<span class="cc-run-txt${tight ? ' tight' : ''}"`
      + ` style="top:calc(${labTop}% + ${tight ? 2 : 3}px)">${labStart} – ${labEnd}</span>`;
    run.innerHTML = label + bands;
    grid.appendChild(run);
  };

  // 一天一段：直接铺，不做跨天/跨段合并
  for (const s of segs) addBlock(s.d, s.h0, s.h1, s.f0, s.t1);

}

/** 已选时段总数（小时数）——只算当前生效的那套方案 */
function clockCountOn(fc) {
  const p = fc ? (fc.profiles.find((x) => x.id === fc.active) || fc.profiles[0]) : clockProfile();
  return p.days.reduce((n, day) => n + day.filter((h) => h.on).length, 0);
}

/** 一天里选中的小时合并成区间文案。
 *  带起止分钟（08:15–11:45）；中间小时的窗口不完整时会把区间断开——
 *  那个洞是真的没选中，文本不能假装连着（与后端 day_ranges 口径一致）。
 *
 *  分段逻辑统一走 `ccSegs`：以前这里和微缩图各写了一份"怎么算连续"，
 *  改一处忘另一处就会出现"摘要写 2 段、微缩图列 3 段"这种对不上的情况。 */
function ccDayRanges(day) {
  return ccSegs(day).map((s) => s.range);
}

/** 已选摘要：七天一样 → "每天 …"，否则逐天列（与后端 summary 口径一致） */
/** 一天里选中的总分钟数 */
function ccDayMinutes(day) {
  return day.reduce((n, p) => {
    if (!p.on) return n;
    const f = Math.max(0, Math.min(59, p.from || 0));
    const t = Math.max(1, Math.min(60, p.to == null ? 60 : p.to));
    return n + Math.max(0, t - f);
  }, 0);
}

/** 一句话概括当前排班。
 *
 *  刻意按"天"聚合，不再把每一段当成一个独立条目罗列 ——
 *  同一天有多段时读起来是"周三 共 3 小时（08:00–09:00、14:00–16:00）"，
 *  而不是一串并列的"周三 08:00–09:00、周三 14:00–16:00"。 */
function clockRangeText(fc) {
  const c = fc || clockCfg();
  const p = c.profiles.find((x) => x.id === c.active) || c.profiles[0];
  const ranges = p.days.map((d) => ccDayRanges(d));
  const mins = p.days.map((d) => ccDayMinutes(d));
  if (!ranges.some((r) => r.length)) return '未选择任何时段';
  const dur = (m) => ccMinText(0, m).dur;
  const same = ranges.every((r) => r.join('|') === ranges[0].join('|'));
  if (same) {
    return `每天 ${ranges[0].join('、')}（共 ${dur(mins[0])}）`;
  }
  return ranges
    .map((r, d) => (r.length ? `${WD[d]} 共 ${dur(mins[d])}（${r.join('、')}）` : null))
    .filter(Boolean)
    .join('；');
}

/** 矩形区域文案：周三 08:00–12:00 / 周三 – 周五 08:00–12:00。
 *  传了起止分钟且不是整点时带分钟：周三 08:15–11:45（结束分钟 60 或省略 = 整点）。 */
function ccRectText(d0, d1, h0, h1, fromMin, toMin) {
  const days = d0 === d1 ? WD[d0] : `${WD[d0]} – ${WD[d1]}`;
  const f = fromMin > 0 ? `:${pad(fromMin)}` : ':00';
  const endH = (toMin == null ? 60 : toMin) >= 60 ? h1 + 1 : h1;
  const t = (toMin == null ? 60 : toMin) >= 60 ? ':00' : `:${pad(toMin)}`;
  return `${days} ${pad(h0)}${f} – ${pad(endH)}${t}`;
}

/** 从当前时刻起，下一个被选中的时段（含本周稍后与下周），没有则返回 '' */
function ccNextSlotText(fc, wdNow, hourNow) {
  const p = fc.profiles.find((x) => x.id === fc.active) || fc.profiles[0];
  for (let step = 0; step < 7 * 24; step++) {
    const d = (wdNow + Math.floor((hourNow + step) / 24)) % 7;
    const h = (hourNow + step) % 24;
    const one = p.days[d] && p.days[d][h];
    if (one && one.on) {
      const when = step < 24 ? (step === 0 ? '本小时' : `${step} 小时后`) : `${Math.floor(step / 24)} 天后`;
      const snap = ccSnapWin(one.from, one.to);
      const hm = snap.f > 0 ? `:${pad(snap.f)}` : ':00';
      return `，下一个选中时段：${WD[d]} ${pad(h)}${hm}（${when}）`;
    }
  }
  return '';
}

/** 方案命名弹层：新建时给个「方案 N」的默认名，重命名时带出原名。
 *  WebView 里 window.prompt 不可靠，统一走项目自己的 modal。 */
function ccNameDialog(mode) {
  const fc = clockCfg();
  const p = clockProfile();
  const isNew = mode === 'new';
  const val = isNew ? `方案 ${fc.profiles.length + 1}` : p.name;
  $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal" style="max-width:430px">
        <div class="modal-hd">
          <h3>${isNew ? '新建星期时段方案' : '重命名方案'}</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          <div class="add-row"><input type="text" id="ccNameInput" maxlength="30" value="${esc(val)}"
            placeholder="例如：工作日强化 / 周末轻松 / 考试冲刺"></div>
          <div class="hint" style="margin-top:8px">
            名字只用于区分方案，不影响判定。${isNew
              ? '新建后会自动切到这套，排班表是空的，拖出要自律的时段即可。'
              : '重命名不改排班，也不会影响正在生效的那套。'}
          </div>
        </div>
        <div class="modal-ft">
          <button class="btn" data-act="close-modal">取消</button>
          <button class="btn btn-primary" data-act="cc-name-ok" data-mode="${mode}">${isNew ? '创建' : '保存'}</button>
        </div>
      </div>
    </div>`;
  const inp = $('#ccNameInput');
  if (inp) { inp.focus(); inp.select(); }
}

/* ---------------- 生效时间段：微缩图 + 完整页（两级形态） ----------------
 *
 * 为什么分成两级：
 *   一张 7×24 的日历占掉大半个屏幕，而这个页面还要放方案、绑定、通用时长……
 *   于是"看排班"这件事被挤到很下面。现在页面里只留一张**微缩概览**，
 *   想看细节就点开**完整页**：那里才有刻度、拖选、明细数据。
 *   两处读的是同一份 `prof.days`，所以不会出现"微缩图和完整页不一致"。
 *
 * 微缩图不是"把主窗口按比例缩小"：那样只剩一团色块，什么也读不出来。
 * 它由两部分组成——
 *   · 左边/上面一条 7 列时间轴：只回答"哪天、大概几点到几点"（形状）
 *   · 下面逐条列出每段的摘要：时间范围 + 节奏 + 番茄轮数 + 时长（内容）
 * 概览的定位不变（不标坐标、不可交互、一眼看完），但读得懂"这一段是干什么的"。
 */

/** 把一天拆成若干"连续时段"，连同摘要需要的统计值一起算出来。
 *  和 `ccDayRanges` 同一套连续性判据（上一小时排到整点、下一小时从整点开始）。 */
function ccSegs(day) {
  const out = [];
  let i = 0;
  while (i < 24) {
    if (!day[i].on) { i++; continue; }
    const start = i;
    let end = i;
    while (end + 1 < 24 && day[end + 1].on
      && (day[end].to == null ? 60 : day[end].to) >= 60
      && (day[end + 1].from || 0) <= 0) end++;
    const f = Math.max(0, Math.min(59, day[start].from || 0));
    const t = Math.max(1, Math.min(60, day[end].to == null ? 60 : day[end].to));
    let mins = 0;
    for (let h = start; h <= end; h++) {
      const a = h === start ? f : 0;
      const b = h === end ? t : 60;
      mins += Math.max(0, b - a);
    }
    // 节奏取这一段的起点小时（同一段内通常一致）；番茄轮数按时长估算。
    // 不足一轮就是 0：写"1 个番茄"是骗人的，15 分钟的段撑不起一整轮。
    const work = Math.max(1, Math.min(60, day[start].work || 50));
    const brk = Math.max(0, Math.min(60 - work, day[start].brk || 0));
    const rounds = Math.floor(mins / Math.max(1, work + brk));
    const endH = t >= 60 ? end + 1 : end;
    out.push({
      h0: start, h1: end, f0: f, t1: t, mins, work, brk, rounds,
      range: `${pad(start)}:${pad(f)}–${pad(endH)}:${t >= 60 ? '00' : pad(t)}`,
    });
    i = end + 1;
  }
  return out;
}

/** 一段的概括性内容：节奏 + 轮数 + 时长，一句话 */
function ccSegBrief(sg) {
  const rhythm = sg.brk ? `专注 ${sg.work} 分 / 休息 ${sg.brk} 分` : `连续专注 ${sg.work} 分`;
  const rounds = sg.rounds > 0 ? `${sg.rounds} 个番茄` : '不足 1 轮';
  return `${rhythm} · ${rounds} · ${ccMinText(0, sg.mins).dur}`;
}

/** 微缩周视图：时间轴（形状）+ 时段摘要（内容），都没有坐标 / 刻度 / 交互 */
function ccMiniHtml(prof, wdNow) {
  const cols = prof.days.map((day, d) => {
    let bars = '';
    day.forEach((p, h) => {
      if (!p.on) return;
      const f = Math.max(0, Math.min(59, p.from || 0));
      const t = Math.max(1, Math.min(60, p.to == null ? 60 : p.to));
      bars += `<i style="top:${((h * 60 + f) / 1440 * 100).toFixed(2)}%;`
        + `height:${((t - f) / 1440 * 100).toFixed(2)}%"></i>`;
    });
    return `<div class="cc-mini-col${d === wdNow ? ' today' : ''}">${bars}</div>`;
  }).join('');

  // 逐段摘要：按周一到周日、按时间先后排
  const rows = [];
  prof.days.forEach((day, d) => {
    for (const sg of ccSegs(day)) rows.push({ d, sg });
  });
  const CAP = 6;
  const shown = rows.slice(0, CAP);
  const rest = rows.length - shown.length;
  const list = shown.map(({ d, sg }) => `
      <div class="cc-mini-row${d === wdNow ? ' today' : ''}">
        <span class="dw">${WD[d]}</span>
        <span class="rg">${sg.range}</span>
        <span class="br">${ccSegBrief(sg)}</span>
      </div>`).join('') + (rest > 0
    ? `<div class="cc-mini-row more">还有 ${rest} 段，点开完整图表查看</div>` : '');

  const total = prof.days.reduce((n, d) => n + ccDayMinutes(d), 0);
  const head = WD.map((w, i) => `<span class="${i === wdNow ? 'today' : ''}">${w.slice(1)}</span>`).join('');
  return `
    <div class="cc-mini" data-act="cc-open" role="button" tabindex="0" title="点击展开完整图表">
      <div class="cc-mini-hd">${head}</div>
      <div class="cc-mini-body">${cols}</div>
      <div class="cc-mini-list">${rows.length ? list : '<div class="cc-mini-row more">还没排任何时段</div>'}</div>
      <div class="cc-mini-ft">
        <span class="nm">${esc(prof.name)}</span>
        <span class="sum">${total ? `每周 ${ccMinText(0, total).dur} · ${rows.length} 段` : '还没排任何时段'}</span>
        <span class="go">展开完整图表 ›</span>
      </div>
    </div>`;
}

/** 大日历的格子 HTML —— 只在完整页里生成（折叠时不算这 168 个格子） */
function ccGridHtml(prof, wdNow, hourNow) {
  const step = ccStep();
  const qn = ccQCnt();
  const hourH = ccHourH();
  let grid = `<div class="cc-corner" style="grid-row:1;grid-column:1">时</div>` + WD.map((w, i) =>
    `<div class="cc-dh${i === wdNow ? ' today' : ''}" style="grid-row:1;grid-column:${i + 2}">${w}${i === wdNow ? '·今' : ''}</div>`).join('');
  for (let h = 0; h < 24; h++) {
    grid += `<div class="cc-hlab" style="grid-row:${h + 2};grid-column:1">${h}</div>`;
    for (let dd = 0; dd < 7; dd++) {
      const p = prof.days[dd][h];
      const w = Math.max(0, Math.min(60, p.work || 0));
      const b = Math.max(0, Math.min(60 - w, p.brk || 0));
      const t = Math.max(0, 60 - w - b);
      const snap = ccSnapWin(p.from, p.to);
      const pf = p.on ? snap.f : 0, pt = p.on ? snap.t : 60;
      const winTxt = pf > 0 || pt < 60
        ? `${WD[dd]} ${pad(h)}:${pad(pf)} – ${pad(h)}:${pad(pt)}`
        : `${WD[dd]} ${pad(h)}:00 – ${pad(h + 1)}:00`;
      let qs = '';
      for (let q = 0; q < qn; q++) {
        const a = qStart(q), bq = qEnd(q);
        const onQ = p.on && pf < bq && a < pt;
        qs += `<i class="cc-q${onQ ? ' on' : ''}" data-q="${q}" data-a="${a}" data-b="${bq}"
          style="top:${(q * 100 / qn).toFixed(4)}%;height:${(100 / qn).toFixed(4)}%"></i>`;
      }
      grid += `<div class="cc-cell${p.on ? ' on' : ''}${dd === wdNow && h === hourNow ? ' now' : ''}"
        style="grid-row:${h + 2};grid-column:${dd + 2}" data-d="${dd}" data-h="${h}"
        title="${winTxt}${p.on ? ` · 专注 ${w} 分 / 休息 ${b} 分${t ? `（尾段 ${t} 分继续专注）` : ''}，右键可改` : '（未选中，拖动或右键可设置）'}">${qs}</div>`;
    }
  }
  return { grid, hourH, step, qn };
}

/** 完整页：大日历（可拖选 / 右键）+ 粒度 + 每日明细 */
function ccDetailHtml(prof, wdNow, hourNow, frozen) {
  const { grid, hourH, step, qn } = ccGridHtml(prof, wdNow, hourNow);
  const totalMins = prof.days.reduce((n, d) => n + ccDayMinutes(d), 0);
  const dayRows = prof.days.map((day, d) => {
    const m = ccDayMinutes(day);
    const seg = ccDayRanges(day);
    return `<div class="cc-day${d === wdNow ? ' today' : ''}">
      <span class="d">${WD[d]}</span>
      <span class="bar"><i style="width:${(m / 1440 * 100).toFixed(1)}%"></i></span>
      <span class="v">${m ? ccMinText(0, m).dur : '—'}</span>
      <span class="s">${seg.length ? `${seg.length} 段` : ''}</span>
    </div>`;
  }).join('');
  return `
  <div class="cc-detail" id="ccDetail">
    <div class="cc-detail-hd">
      <button class="btn btn-sm" data-act="cc-close">‹ 返回</button>
      <div class="cc-detail-title">生效时间段 · 完整图表<span class="badge">${esc(prof.name)}</span></div>
      <div class="cc-detail-live" id="clockLive">${esc(clockRangeText())}</div>
    </div>
    <div class="cc-detail-bd">
      <div class="cc-gran">
        <span class="cc-gran-lab">每次选择</span>
        ${CC_GRANS.map((g) => `<button class="cc-gran-btn${g === step ? ' active' : ''}"
          data-act="clock-gran" data-v="${g}" ${frozen ? 'disabled' : ''}
          title="每一格代表 ${g} 分钟">${g} 分钟</button>`).join('')}
        <span class="hint">现在每格 ${step} 分钟，一小时 ${qn} 格。切到 10 分钟更细（格子变多、日历变高），已排好的时段不受影响。</span>
      </div>
      <div class="cc-scroll"><div class="cc" id="ccGrid" style="--cc-hour-h:${hourH}px">${grid}</div></div>
      <div class="cc-legend">
        <span><i class="sw"></i>已选中（整块同色）</span>
        <span class="hint">同一天相邻的时段会连成一整块；块里的空白就是没选中的分钟</span>
      </div>
      <div class="cc-days">
        <div class="cc-days-hd"><span>每日时长</span><span>合计 ${ccMinText(0, totalMins).dur}</span></div>
        ${dayRows}
      </div>
      <div class="tl-legend">
        <span class="hint">
          <b>空白处按住拖动</b> = 新建一段（按当前粒度吸附，夹在 0:00–24:00，最少一格）；
          <b>在已有的条上按住拖动</b> = 整段搬走，长度不变，撞到日界会贴边停下；
          <b>单击</b> = 只记下选区，<b>不改</b>时段的数量与结构；
          <b>右键格子</b> = 细调专注 / 休息时长与起止分钟。
        </span>
        <button class="btn btn-sm" data-act="clock-clear" ${frozen ? 'disabled' : ''}>清空全部</button>
      </div>
    </div>
  </div>`;
}

function viewClock() {
  const d = S.data;
  if (!d) return '';
  const fc = clockCfg();
  const prof = clockProfile();
  const rt = d.runtime || {};
  const wdNow = (new Date().getDay() + 6) % 7; // 0=周一
  const hourNow = new Date().getHours();
  const n = clockCountOn(fc);
  const multi = fc.profiles.length > 1;
  // 这套时段绑定哪些自律规则（空 = 全部）
  const allRules = (S.data.config.rules || []);
  const bound = Array.isArray(prof.bound) ? prof.bound : [];

  // 自律时段生效中（且非测试模式）：与纪律相关的控件置灰
  const frozen = settingsFrozen();
  // 「自律时间内启用自律规则」只有"关掉"是削弱纪律，"打开"是加强 → 只在已打开时置灰
  const applyFrozen = frozen && fc.applyRules;

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
      stateTxt = `专注中 · 还剩 ${mm} 分 ${pad(ss)} 秒（自律规则正在生效，应用 / 网页会被关闭）`;
      stateCls = 'green';
    }
  } else if (!fc.enabled) {
    stateTxt = '未启用：下面选中的时段不会生效';
  } else if (!n) {
    stateTxt = '还没有选择任何时段';
  } else if (rt.clockInWindow === undefined || rt.clockInWindow === null) {
    stateTxt = '正在读取时钟状态…';
  } else {
    stateTxt = `当前不在自律时间：自律规则不拦截${ccNextSlotText(fc, wdNow, hourNow)}`;
  }

  // 方案切换条：同一时刻只有一套在生效，切过去立刻按新方案判定
  const chips = fc.profiles.map((p) => {
    const on = p.id === fc.active;
    const cnt = p.days.reduce((m, day) => m + day.filter((h) => h.on).length, 0);
    return `<button class="cc-prof${on ? ' active' : ''}${frozen ? ' locked' : ''}" data-act="clock-prof" data-id="${esc(p.id)}"
      title="${frozen ? '自律时段生效中，不能切换方案' : `切换到「${esc(p.name)}」`}">
      <span class="nm">${esc(p.name)}</span><span class="n">${cnt} 段</span></button>`;
  }).join('');

  // 周日历：第 1 行星期表头，下面 24 行小时格（自上而下 0 → 23）。
  // 所有格子都**显式定位**：连续时段的整块是按行号覆盖上去的，
  // 只要格子还是自动流，自动布局就会绕开被覆盖块占住的位置，整张表会错行。
  // 左上角是「纵轴单位」，不再重复标一个 0（第一个小时标签已经是 0 了）。
  //
  // 每一小时内部**自上而下**再切成若干格（粒度 15 分钟 = 4 格，10 分钟 = 6 格）：
  // 格子是竖向的、位置就是时间顺序；选中的时段画成同样竖向的横条，
  // 两者共用一条纵轴，所以"点哪一格"和"条子出现在哪"必然一致。
  return `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:14px">
      <div>
        <div class="card-title">自律模式生效时间段</div>
        <div class="card-sub">
          横轴一周七天，纵轴 0–24 点，一小时再竖着分成若干格。
          哪几天、哪几段要自律，直接在格子上拖出来——选中的部分就是一条从上到下的横条，条子的长度就是时长。
          到点自动进入自律模式，到点自动退出；自律规则、浏览器巡检、专注遮罩都会跟着这段状态走。
          需要多套排班时，做成几套「星期时段」方案，每套还能各自绑定不同的自律规则分组。
        </div>
      </div>
      <div class="switch${frozen ? ' locked' : ''}" data-act="clock-enable"
           title="${frozen ? '自律时段生效中，开关已锁定' : '启用 / 停用自律时段'}"><input type="checkbox" ${fc.enabled ? 'checked' : ''}><i></i></div>
    </div>

    ${frozen ? `<div class="note" style="border-left:3px solid var(--red);background:rgba(255,92,92,.07);border-color:rgba(255,92,92,.22);margin:14px 0 0">
      <b style="color:var(--red)">🔒 自律时段生效中</b>：这段时间「自律时段」开关和「自律规则」开关都点不动，
      不能切换 / 删除方案，也不能取消已选中的时段或改这一小时的专注 / 休息时长；
      其它时段照常可以安排。等这一段结束（或用积分解锁）之后再改。
    </div>` : ''}

    <div class="cc-profiles">
      <span class="cc-prof-lab">星期时段</span>
      ${chips}
      <button class="cc-prof-add" data-act="clock-prof-new"
        ${frozen || fc.profiles.length >= CC_MAX_PROFILES ? 'disabled' : ''}
        title="${frozen ? '自律时段生效中，不能新建方案' : fc.profiles.length >= CC_MAX_PROFILES ? `最多 ${CC_MAX_PROFILES} 套方案` : '再排一套星期时段'}">+ 新建</button>
    </div>
    <div class="cc-prof-ops">
      <button class="btn btn-sm" data-act="clock-prof-rename" ${frozen ? 'disabled' : ''}>重命名</button>
      <button class="btn btn-sm" data-act="clock-prof-dup" ${frozen || fc.profiles.length >= CC_MAX_PROFILES ? 'disabled' : ''}>复制这套</button>
      <button class="btn btn-sm btn-danger" data-act="clock-prof-del" ${frozen || !multi ? 'disabled' : ''}>删除这套</button>
      <span class="hint">同一时刻只有一套在生效；卡片顶部的开关管的是「自律时段」整体，与选哪套无关。</span>
    </div>

    <div class="cc-bind">
      <div class="cc-bind-hd">
        <span class="cc-bind-title">这套时段生效的自律规则</span>
        <span class="hint">${bound.length ? `已绑 ${bound.length} 组，其余分组这套时段不管` : '没绑任何分组 = 全部生效（默认）'}</span>
      </div>
      <div class="cc-bind-list">
        <button class="cc-bind-chip${bound.length ? '' : ' active'}" data-act="clock-bind" data-id=""
          title="这套时段用上全部已启用的自律规则">全部</button>
        ${allRules.map((l) => `<button class="cc-bind-chip${bound.includes(l.id) ? ' active' : ''}"
          data-act="clock-bind" data-id="${esc(l.id)}"
          title="${esc(l.name)}：${l.apps.length} 个软件 · ${l.sites.length} 个网站${l.enabled ? '' : '（这条没启用，绑了也不会拦）'}">
          ${esc(l.name)}</button>`).join('') || '<span class="hint">还没有自律规则分组，先去「自律规则」建一组</span>'}
      </div>
      <div class="hint" style="margin-top:6px">
        换方案 = 换时间表 + 换管哪些分组。比如「工作日」那套只绑工作类，
        「周末」那套只绑娱乐类，互不干扰。
      </div>
    </div>


    <div class="clock-state ${stateCls}">
      <span class="cs-dot"></span>
      <span>${esc(stateTxt)}</span>
      ${fc.enabled && n ? `<span class="badge">已选 ${n} 个小时段</span>` : ''}
    </div>

    ${ccMiniHtml(prof, wdNow)}
    <div class="cc-def">
      <span class="cc-def-lab">通用时长</span>
      <label>专注 <input type="number" id="defW" min="1" max="60" step="1" value="${prof.defWork}"> 分</label>
      <label>休息 <input type="number" id="defB" min="0" max="60" step="1" value="${prof.defBrk}"> 分</label>
      <button class="btn btn-sm" data-act="clock-def-save">保存</button>
      <span class="hint">只作用于「${esc(prof.name)}」这套：之后新框选 / 单击选中的时段都沿用这套时长；右键菜单里改也能顺手更新它</span>
    </div>
  </div>

  <div class="card">
    <div class="card-title">它和「自律规则」的关系</div>
    <div class="card-sub">自律时段是总开关，自律规则是执法工具。</div>
    <div class="note" style="line-height:1.95">
      <b>这里（自律时段）</b>：决定"什么时候进入自律时间"。按周排、每周重复，每格 ${ccStep()} 分钟。<br>
      <b>自律规则</b>：只有名单，没有自己的时间表。它<b>只在自律时间（专注段）内生效</b>，其余时间一律静默。<br>
      <b>两者是包含关系</b>：自律时间之外的时段、以及番茄休息段，自律规则都不拦。<br>
      <b>每套时段还能各自绑定分组</b>：上面「这套时段生效的自律规则」勾了哪几组，这套时段就只管那几组。
      <div class="row" style="justify-content:space-between;align-items:center;margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
        <div>
          <div style="font-size:12.5px">自律时间内启用自律规则</div>
          <div class="hint" style="margin-top:4px">关掉后，自律时段只负责"进入自律状态"（遮罩 / HUD / 积分 / 成绩），自律规则完全不拦。</div>
        </div>
        <div class="switch${applyFrozen ? ' locked' : ''}" data-act="clock-apply-rules"
             title="${applyFrozen ? '自律时段生效中，不能关掉' : '切换'}"><input type="checkbox" ${fc.applyRules ? 'checked' : ''}><i></i></div>
      </div>
      <div style="margin-top:12px" class="hint">
        优先级（从高到低）：<b>不在自律时间</b>（一律不拦） &gt; <b>休息段</b>（一律放行） &gt; 自律规则时间范围 &gt; 手动开关。<br>
        自律时段生效期间，专注遮罩如果开了「跟随自律模式」就会跟着自动打开，此时主开关显示为接管、不能手动切。
      </div>
    </div>
  </div>
  ${S.ccFull ? ccDetailHtml(prof, wdNow, hourNow, frozen) : ''}`;
}

/* ---------------- 视图：专注遮罩 ---------------- */
function viewMask() {
  const d = S.data;
  if (!d) return '';
  const m = d.mask;
  const target = d.config.settings.mask.targetTitle || '';
  const op = m.opacity;
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
              组合条件只有一条：<b>生效 = 主开关 OR（跟随自律 AND 自律生效中）</b>——
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
              打开后不用选目标窗口：遮罩自动盯住<b>当前最上层（正在用）的窗口</b>，只留它可见、其他全压暗。
              切换窗口时洞口平滑移过去，拖动 / 缩放时 1:1 完全跟手。
            </div>
          </div>
          <div class="switch" data-act="toggle-follow"><input type="checkbox" ${m.follow ? 'checked' : ''}><i></i></div>
        </div>
        <div class="row" style="align-items:center;justify-content:space-between;gap:14px;margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
          <div>
            <div style="font-size:12.5px">媒体管控</div>
            <div class="hint" style="margin-top:4px">
              遮罩生效时，自动<b>暂停</b>被盖住（非前台/非呈现）窗口的媒体播放；
              窗口回到前台、或遮罩关闭时<b>自动恢复</b>播放。只动我们暂停过的，
              你自己手动暂停的不会被乱动；归因不到的后台音乐一律不碰。
            </div>
          </div>
          <div class="switch" data-act="toggle-media-pause"><input type="checkbox" ${m.mediaPause ? 'checked' : ''}><i></i></div>
        </div>
      </div>
    </div>

    <div class="mask-preview">
      <div class="screen"></div>
      <div class="dim" id="previewDim" style="opacity:${op / 100}"></div>
      <div class="hole" id="previewHole">当前窗口</div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-title">遮罩参数</div>
    <div class="card-sub">拖动即时生效——遮罩开着的时候，你可以直接在屏幕上看到效果。动画速度就是"从窗口边缘铺满全屏"用多久，数值越大越慢，0 = 瞬间出现。</div>
    <div class="slider-row">
      <span class="lab">不透明度</span>
      <input type="range" min="20" max="100" step="1" value="${op}" id="opRange" />
      <span class="val" id="opVal">${op}%</span>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <div>
        <div style="font-size:12.5px">点击遮罩空白处不穿透</div>
        <div class="hint" style="margin-top:4px">
          开启后，点遮罩空白区域没有任何反应，也不会把别的窗口切到前台——专心时最稳。<br>
          关掉则点击会穿透到被遮罩的窗口，方便临时操作，但点到别的应用会让它变成前台，
          遮罩会跟着换目标。<br>
          不论开关，<b>选中窗口本身永远正常可点</b>。
        </div>
      </div>
      <div class="switch" data-act="toggle-click">
        <input type="checkbox" ${m.blockClick ? 'checked' : ''}><i></i>
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
  // 报告类型用分段按钮，不用原生 <select>：原生下拉在深色界面里会掉出
  // 一套系统配色（白底 / 系统蓝高亮），和整个页面完全不搭。
  const PERIODS = [['daily', '日报'], ['weekly', '周报'], ['monthly', '月报'], ['yearly', '年报']];
  const curP = S.genPeriod || 'daily';
  const seg = `<div class="seg" id="genPeriod">${PERIODS.map(([v, t]) =>
    `<button class="seg-btn${v === curP ? ' active' : ''}" data-act="gen-period" data-v="${v}">${t}</button>`).join('')}</div>`;

  const list = S.reports.length
    ? S.reports.map((r) => `<div class="rep-item" data-act="open-report" data-id="${esc(r.id)}">
        <span class="badge ${r.period === 'daily' ? 'gold' : r.period === 'weekly' ? 'blue' : 'green'}">${
          { daily: '日报', weekly: '周报', monthly: '月报', yearly: '年报', custom: '自定义' }[r.period] || r.period}</span>
        <div class="rep-main">
          <div class="ttl">${esc(r.title)}</div>
          <div class="sub">${r.start} ~ ${r.end} · 生成于 ${new Date(r.created * 1000).toLocaleString()}</div>
        </div>
        <div class="rep-stat">
          <div class="tnum">${fmtDur(r.onSecs + r.offSecs)}</div>
          <div class="sub">开启 ${fmtDurShort(r.onSecs)} · 未开启 ${fmtDurShort(r.offSecs)}</div>
        </div>
        <div class="rep-ops">
          <button class="btn btn-sm" data-act="report-export-open" data-id="${esc(r.id)}"
            title="导出为 Markdown / 纯文本 / Word">导出</button>
          <button class="btn btn-sm danger-ghost" data-act="report-del-ask" data-id="${esc(r.id)}"
            title="删除这份报告（会先确认）">删除</button>
        </div>
      </div>`).join('')
    : '<div class="empty"><span class="ico">▤</span>还没有生成过报告。<br>开启下面的自动生成，或者点「立即生成」。</div>';

  const sw = (k, v, t, sub) => `<div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
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
    <div class="rep-hd">
      <div>
        <div class="card-title" style="margin:0">历史报告</div>
        <div class="hint" style="margin-top:4px">保留在本地，可随时回看、导出或删除${
          S.reports.length ? ` · 共 ${S.reports.length} 份` : ''}</div>
      </div>
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        ${seg}
        <button class="btn btn-primary btn-sm" data-act="gen-report">立即生成</button>
        <button class="btn btn-sm" data-act="reports-refresh">刷新</button>
      </div>
    </div>
    <div class="rep-list">${list}</div>
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
      把<b>自律规则与设置</b>同步到你自己的网盘（坚果云 / Nextcloud / 群晖 / 阿里云盘 WebDAV 等）。
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
    <div class="card-title">同步自律规则</div>
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
        <div style="font-size:22px;font-weight:700;letter-spacing:.3px">${esc(d.appName || 'King Of Focus')}</div>
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
    <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
      <div><div style="font-size:12.5px">配置文件</div><div class="hint" style="margin-top:4px">${esc(d.configPath)}</div></div>
      <button class="btn btn-sm" data-act="open-cfg">打开</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">自动更新</div>
    <div class="card-sub">启动时检查 GitHub Releases，有新版本会弹窗提示；下载完成后自动退出、安装并重新启动。</div>

    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">启动时检查更新</div>
        <div class="hint" style="margin-top:3px">最近一次检查：${st.lastCheck ? new Date(st.lastCheck * 1000).toLocaleString() : '还没检查过'}</div>
      </div>
      <div class="switch" data-act="update-enabled"><input type="checkbox" ${st.enabled ? 'checked' : ''}><i></i></div>
    </div>

    <div style="padding:12px 0;border-bottom:1px solid var(--line)">
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
          <div style="height:6px;background:var(--inset-bg);border-radius:4px;overflow:hidden">
            <div id="upBar" style="height:100%;width:0;background:var(--cc-fill);transition:width .2s"></div>
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
          ${esc(c.rules || '自律自律规则')} · 全程没有破功
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
  const v = d ? d.version : '0.0.2';
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
    ① 到「自律规则」新建一条 → ② 加软件 / 加网站 → ③ 拖出它在自律时间内的生效范围。
    打开开关后，<b>只有自律时间内</b>它才会拦；自律时间之外完全静默。
  `)}

  ${sec('2 · 自律规则与生效', `
    一条自律规则 = 一份名单 + 一张周时间表。<b>时间表全空 = 自律时间内全程生效</b>；否则只在画出来的格子里生效。
    时间表按周循环，下周自动重复；要让每天一样，就在「时间表」里点「周一 → 全部」。
    每条自律规则都有明确的<b>生效类型</b>：<b>黑名单</b>（名单里的不许开）、
    <b>白名单</b>（只有名单里的能开，其他前台窗口都会被关）、
    <b>两者同时</b>（名单里的照样拦，例外里的放行）。
  `)}

  ${sec('3 · 番茄与提醒', `
    自律规则里可以设「专注 N 分钟 / 休息 M 分钟」，循环锚点是从该时段的起点开始算。
    休息期间这条自律规则不拦截，时间到自动锁回。<br>
    提醒在「设置 → 提醒」：学习结束前 X 分钟、休息结束前 Y 分钟各响一次（0~120 分钟，0 = 不发），
    休息提醒可以单独关。触发时主界面弹提示、HUD 上的倒计时变金色闪烁。
  `)}

  ${sec('4 · 固化与积分', `
    「固化」打开后，生效期间不能退出程序、不能改任何设置，任务管理器会被自动关掉；
    进程被杀掉会被守护进程在 2 秒内拉回来。<br>
    解除只有两条路：<b>时段结束</b> 或 <b>用积分解锁</b>。
    专注每分钟 +1 分，解锁单价 15 分/分钟、当天第 n 次 ×1.4。
    <br>注意：固化只在自律时间内生效，且自律时段本身的结束时间就是最晚解封时刻，不会把自己永久锁死。
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
    「立即同步」只同步自律规则和设置，不做版本归档。
  `)}

  ${sec('8 · 常见问题', `
    <b>拦截没反应？</b> 目标程序是管理员权限，就右键以管理员身份运行本程序。<br>
    <b>网页没拦住？</b> 插件没装或没连上，看侧边栏「浏览器插件」状态。<br>
    <b>想临时放过自己？</b> 用「总览 → 积分兑换」解锁，或者把自律规则开关关掉（固化了就关不掉）。<br>
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
  // 自定义浏览器：用户数据目录不一定在标准位置，扩展状态没法可靠探测，
  // 与其瞎猜"未安装"，不如老实写"需自行确认"
  if (ext === 'manual') return { txt: '插件需自检', cls: 'blue' };
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

  const customs = list.filter((b) => b.custom);
  const customRows = customs.length
    ? customs.map((b) => `<div class="brow">
        <div class="brow-ico">${b.installed ? '◉' : '○'}</div>
        <div class="brow-main">
          <div class="brow-name">
            <span class="bname">${esc(b.name)}</span>
            <span class="badge ${b.installed ? 'green' : 'red'}">${b.installed ? '路径有效' : '路径失效'}</span>
            <span class="badge blue">自定义添加</span>
            ${b.running ? '<span class="badge blue">运行中</span>' : ''}
          </div>
          <div class="hint" style="word-break:break-all">${esc(b.exe || '')}</div>
        </div>
        <div class="brow-act">
          ${b.extPage ? `<button class="btn btn-sm" data-act="browser-page" data-k="${esc(b.key)}">扩展页</button>` : ''}
          <button class="btn btn-sm danger-ghost" data-act="custom-browser-del" data-id="${esc(String(b.key).replace('custom:', ''))}">删除</button>
        </div>
      </div>`).join('')
    : '<div class="hint" style="margin-top:10px">还没有登记任何自定义浏览器。</div>';

  const rows = list.length
    ? list.map((b) => {
      const m = browserMeta(b.ext);
      const canInstall = b.installed && (b.ext === 'notInstalled' || b.ext === 'disabled');
      // 「设置路径」一直可见：装在非默认目录时自动检测找不到主程序，
      // 这正是"扩展页"按钮打不开的常见原因，得让用户当场能补救。
      // 已设自定义路径时提示"可改/留空清除"，让入口既能设也能清。
      const pathTitle = b.exe
        ? `当前：${b.exe}${b.exeSource === 'custom' ? '（自定义，点此重新选择；在弹出的输入框留空可清除、回退自动检测）' : ''}`
        : '没找到主程序，点这里手动指定 .exe';
      const pathBtn = b.custom
        ? `<button class="btn btn-sm danger-ghost" data-act="custom-browser-del" data-id="${esc(String(b.key).replace('custom:', ''))}">删除</button>`
        : `<button class="btn btn-sm btn-ghost" data-act="browser-setpath" data-k="${b.key}" title="${esc(pathTitle)}">${b.exeSource === 'custom' ? '重设路径' : '设置路径'}</button>`;
      const act = !b.installed
        ? `<span class="muted" style="font-size:12px">未安装</span>${pathBtn}`
        : b.ext === 'unsupported'
          ? '<span class="muted" style="font-size:12px">无需安装</span>'
          : canInstall
            ? `<button class="btn btn-sm btn-primary" data-act="browser-install" data-k="${b.key}">${b.ext === 'disabled' ? '去启用' : '安装插件'}</button>
               <button class="btn btn-sm" data-act="browser-page" data-k="${b.key}">扩展页</button>${pathBtn}`
            : `<button class="btn btn-sm" data-act="browser-page" data-k="${b.key}">扩展页</button>${pathBtn}`;
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
            ${b.custom ? '<span class="badge blue">自定义添加</span>' : (b.exeSource === 'custom' ? '<span class="badge blue">自定义路径</span>' : '')}
            ${b.exeSource === 'none' && b.installed ? '<span class="badge">未找到主程序</span>' : ''}
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
    <div class="card-title">自定义浏览器</div>
    <div class="card-sub">
      清单里没有的浏览器（公司内部壳、某些国产套壳）在这里登记主程序路径。
      登记后它会被<b>当作浏览器</b>处理：自律时段里打开它同样会被关闭，
      「浏览器巡检」也认得它。插件状态无法自动探测，需要你自己确认。
    </div>
    ${customRows}
    <div class="row" style="gap:8px;margin-top:14px;align-items:flex-end;flex-wrap:wrap">
      <label style="flex:1;min-width:150px">
        <div class="hint" style="margin-bottom:4px">名称</div>
        <input type="text" id="cbName" maxlength="40" placeholder="例如：公司内部浏览器" style="width:100%" />
      </label>
      <label style="flex:2;min-width:240px">
        <div class="hint" style="margin-bottom:4px">主程序路径</div>
        <input type="text" id="cbExe" placeholder="C:\\...\\browser.exe" style="width:100%" />
      </label>
      <button class="btn btn-sm" data-act="custom-browser-pick">选择 exe</button>
      <button class="btn btn-sm btn-primary" data-act="custom-browser-save">添加</button>
    </div>
    <div class="hint" style="margin-top:8px">
      保存时会校验 .exe 是否存在；登记后立即重新检测，不需要重启软件。
    </div>
  </div>

  <div class="card">
    <div class="card-title">自律时段守护</div>
    <div class="card-sub">
      自律时间（自律规则正在生效）里，只要你打开浏览器而插件没装或被停用，会在
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
  // HUD 的角与透明度：老配置没有这两个字段时按默认（右上 / 92%）
  const hud = {
    offsetX: (st.hud && st.hud.offsetX) ?? 20,
    offsetY: (st.hud && st.hud.offsetY) ?? 20,
  };
  const hudCorner = ['tl', 'tr', 'bl', 'br'].includes((st.hud || {}).corner) ? st.hud.corner : 'tr';
  const hudOpacity = Math.max(30, Math.min(100, +((st.hud || {}).opacity) || 92));
  // 「自律时段内允许退出」：开关关掉 + 现在正好在生效时段里 = 怎么都退不掉。
  // 用 runtime.clockInWindow（整个生效时段，含休息段）而不是 clockOn（专注段），
  // 和后端 guard::session_quit_locked 的判定保持同一口径。
  const quitAllowed = st.allowQuitInSession !== false;
  const quitLocked = !quitAllowed && !!((d.runtime || {}).clockInWindow || (d.runtime || {}).clockOn);
  const sw = (k, v, t, sub) => `<div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">${t}</div><div class="hint" style="margin-top:3px">${sub}</div></div>
      <div class="switch" data-act="cfg-switch" data-k="${k}"><input type="checkbox" ${v ? 'checked' : ''}><i></i></div>
    </div>`;

  return `
  ${!d.admin ? `<div class="note" style="border-left-color:var(--red);margin-bottom:14px">
    <b>当前不是管理员权限。</b>拦截普通程序没问题，但要关掉以管理员身份运行的程序（比如某些游戏、安装程序）会失败。
    <div style="margin-top:8px"><button class="btn btn-sm btn-danger" data-act="restart-admin">以管理员身份重启</button></div>
  </div>` : ''}

  <div class="card">
    <div class="card-title">自律时段</div>
    <div class="card-sub">只影响「自律时段」页怎么排时间，不改变判定口径。</div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div>
        <div style="font-size:12.5px">每次选择的时长</div>
        <div class="hint" style="margin-top:3px">
          拖一下 / 点一下代表多少分钟。改成 10 分钟能排得更细，代价是日历更高、要滚动；
          已经排好的时段不会被改动。
        </div>
      </div>
      <div class="row" style="align-items:center;gap:6px">
        ${[10, 15].map((g) => `<button class="cc-gran-btn${(st.focusClock && +st.focusClock.granularity === g) || (!(st.focusClock && st.focusClock.granularity) && g === 15) ? ' active' : ''}"
          data-act="clock-gran" data-v="${g}">${g} 分钟</button>`).join('')}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">外观</div>
    <div class="card-sub">「跟随系统」会实时响应 Windows 的浅色 / 深色切换，不用重启。</div>
    <div class="seg">
      <button class="${(st.theme || 'system') === 'system' ? 'active gold' : ''}" data-act="theme" data-v="system">跟随系统</button>
      <button class="${st.theme === 'light' ? 'active gold' : ''}" data-act="theme" data-v="light">浅色</button>
      <button class="${st.theme === 'dark' ? 'active gold' : ''}" data-act="theme" data-v="dark">深色</button>
    </div>
    <div class="hint" style="margin:14px 0 8px">语言 · Language</div>
    <div class="seg">
      <button class="${langPref() === 'zh-CN' ? 'active gold' : ''}" data-act="lang" data-v="zh-CN">简体中文</button>
      <button class="${langPref() === 'en' ? 'active gold' : ''}" data-act="lang" data-v="en">English</button>
    </div>
    <div class="hint" style="margin-top:8px">浏览器插件会跟随这里的语言；默认简体中文。</div>
  </div>

  <div class="card">
    <div class="card-title">激励语录</div>
    <div class="card-sub">
      这些句子会和联网取到的「一言」一起在 Hub 顶部轮换，每条都会标明来源。
      最多 60 条、每条 120 字；这里改完立刻生效，不用打开 Hub。
    </div>
    ${(st.customQuotes || []).length
      ? `<div class="qlist" style="margin-top:10px">${(st.customQuotes || []).map((t, i) => `
          <div class="qrow">
            <span class="n">${i + 1}</span>
            <span class="t">${esc(t)}</span>
            <button class="btn btn-sm danger-ghost" data-act="set-quote-del" data-i="${i}">删除</button>
          </div>`).join('')}</div>`
      : '<div class="hint" style="margin-top:10px">还没有自己写的语录。</div>'}
    <div class="row" style="gap:8px;margin-top:12px">
      <input type="text" id="setQuoteNew" maxlength="120" style="flex:1"
        placeholder="写一句给自己的话（最多 120 字），回车即可添加" />
      <button class="btn btn-sm btn-primary" data-act="set-quote-add">添加</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">拦截行为</div>
    <div class="card-sub">这些设置对所有自律规则生效。</div>
    ${sw('dryRun', st.dryRun, '演练模式', '只记录不真的关闭，用来先验证名单是否写对了')}
    ${sw('softClose', st.softClose, '先温和关闭', '先给程序发关闭信号，0.7 秒不退再强制结束，能保住一部分现场')}
    ${sw('siteCloseBrowser', st.siteCloseBrowser, '网页被拦时关闭整个浏览器', '开：命中自律规则网页先弹通知，然后把整个浏览器窗口关掉；关：只关掉那一个标签页')}
    ${sw('guardBrowser', st.guardBrowser, '浏览器守护', '要拦网页时，如果插件失联，直接关掉浏览器（需先装插件）')}
    ${sw('blockTaskmgr', st.blockTaskmgr !== false, '自律期间禁止打开任务管理器', '自律模式生效时（自律时段专注段 / 自律规则生效中），一发现任务管理器就关掉；「固化」锁定期间无论如何都会关')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
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
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">启用提醒</div><div class="hint" style="margin-top:3px">总开关，关掉后两种提醒都不发</div></div>
      <div class="switch"><input type="checkbox" id="ntEnabled" ${(d.config.settings.notify || {}).enabled ? 'checked' : ''}><i></i></div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">学习结束前提醒</div><div class="hint" style="margin-top:3px">0 = 不提醒；范围 0~120 分钟</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="ntWork" min="0" max="120" value="${(d.config.settings.notify || {}).workBefore ?? 5}" style="width:88px" />
        <span class="hint">分钟</span>
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
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
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-top:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">显示位置</div>
        <div class="hint" style="margin-top:3px">
          挨着哪个角落（边距 ${hud.offsetX}/${hud.offsetY} 像素）。挑一个不压住主要内容的位置就行；
          专注遮罩打开时 HUD 会自动收起，不会盖在遮罩上。
        </div>
      </div>
      <div class="row" style="align-items:center;gap:6px">
        ${[['tl', '左上'], ['tr', '右上'], ['bl', '左下'], ['br', '右下']].map(([k, n]) =>
          `<button class="cc-gran-btn${hudCorner === k ? ' active' : ''}" data-act="hud-corner" data-v="${k}"
            title="停靠到${n}角">${n}</button>`).join('')}
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-top:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">透明度</div>
        <div class="hint" style="margin-top:3px">30% 起（再低就看不清了）。松手即保存，改动马上生效。</div>
      </div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="range" id="hudOpacity" min="30" max="100" step="2" value="${hudOpacity}" style="width:140px" />
        <b id="hudOpacityVal" style="font-size:12px;min-width:38px;text-align:right">${hudOpacity}%</b>
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
        : `<button class="btn btn-sm btn-primary" data-act="test-enter" ${settingsFrozen() ? 'disabled title="自律时段生效中，不能进入测试模式"' : ''}>进入测试模式</button>`}
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
          ${settingsFrozen() && !d.admin ? '<br><b>自律时段生效中：切换要重启程序，先等这段结束。</b>' : ''}
        </div>
      </div>
      <div class="switch${settingsFrozen() && !d.admin ? ' locked' : ''}" data-act="cfg-switch" data-k="runAsAdmin"><input type="checkbox" ${st.runAsAdmin ? 'checked' : ''}><i></i></div>
    </div>
    ${sw('alwaysOnTop', st.alwaysOnTop, '主窗口置顶', '开启后主界面始终浮在其它窗口之上，不会被别的窗口盖住；点一下这里就能立刻生效')}
    ${sw('closeToTray', st.closeToTray, '关闭窗口时收进托盘', '拦截引擎在托盘里继续工作')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">浏览器插件</div><div class="hint" style="margin-top:3px">在 Chrome / Edge 的扩展页打开"开发者模式"，载入已解压的扩展</div></div>
      <button class="btn btn-sm" data-act="open-ext">打开插件目录</button>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">自律时段内允许退出</div>
        <div class="hint" style="margin-top:3px">
          开：自律时间里仍可以用 Ctrl+Alt+F4、Alt+F4 或下面的按钮退出。
          关：自律时段内<b>任何方式都退不掉</b>——热键、Alt+F4、关闭窗口、下面的按钮全部被拒绝，直到这一段结束。
          <br>自律规则开了「固化」时更严：固化锁定期间即使这里开着，也退不掉。
          ${quitLocked ? '<br><b style="color:var(--red)">这一段生效期间不能再打开这个开关。</b>' : ''}
        </div>
      </div>
      <div class="switch${quitLocked ? ' locked' : ''}" data-act="cfg-switch" data-k="allowQuitInSession">
        <input type="checkbox" ${quitAllowed ? 'checked' : ''}><i></i>
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">立即退出程序</div>
        <div class="hint" style="margin-top:3px">
          ${quitLocked
            ? '<b style="color:var(--red)">自律时段生效中，且已关闭「自律时段内允许退出」——现在退不掉。</b>'
            : `立刻结束本程序：先停守护、还原被暂停的媒体、销毁遮罩并落盘统计，不弹确认框。快捷键 <b>Ctrl + Alt + F4</b>${quitAllowed ? '（窗口在前台时 <b>Alt + F4</b> 也行）' : ''}。`}
        </div>
      </div>
      <button class="btn btn-sm btn-danger" data-act="force-quit" ${quitLocked ? 'disabled' : ''}>立即强制退出</button>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div><div style="font-size:12.5px">配置文件</div><div class="hint" style="margin-top:3px">${esc(d.configPath)}</div></div>
      <button class="btn btn-sm" data-act="open-cfg">打开目录</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">全局保护名单</div>
    <div class="card-sub">白名单下，这些进程永远不会被拦截。用逗号分隔（进程名，不带 .exe）。</div>
    <textarea id="protectedList" style="width:100%;height:88px;background:var(--input-bg);border:1px solid var(--line-2);border-radius:8px;color:var(--text);padding:10px;font-size:12px;resize:vertical;user-select:text">${esc((st.protected || []).join(', '))}</textarea>
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
  if (!S.data && S.view !== 'reports') { $('#content').innerHTML = '<div class="empty is-loading">加载中…</div>'; return; }
  // 只有真的换了页面才播入场：数据每 1.5s 刷一次，动画不能跟着重播
  const viewChanged = S._renderedView !== S.view;
  S._renderedView = S.view;
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

  // 连续时段要画成整块：格子是静态的，覆盖层得在 DOM 落地后再算
  if (S.view === 'clock') ccRenderRuns();

  if (S.view === 'stats') {
    const cur = currentSlices();
    drawPie($('#pie'), cur.slices, cur.total, { sub: '累计前台时长' });
  }

  // 内容区刚重绘，节点是中文原文；英文界面下立刻翻一遍
  applyLangView();

  if (viewChanged) {
    const box = $('#content');
    if (box) {
      box.classList.remove('view-in');
      void box.offsetWidth;          // 强制重排，让动画能重新播放
      box.classList.add('view-in');
      clearTimeout(S._viewInTimer);
      // 动画最长 340 + 72(错峰) ≈ 412ms，600ms 后撤类，避免影响后续 hover
      S._viewInTimer = setTimeout(() => box.classList.remove('view-in'), 600);
    }
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
  return `<div class="ext-box reveal-in">
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
            ① 网页自律规则拦不住（插件负责在请求层拦截，并在自律时段扫掉已打开的标签页）<br>
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
    // 完整图表页是"自律时段"的下一层：换页面就收起来，免得下次进来还停在那层
    if (view !== 'clock') S.ccFull = false;
    if (view === 'stats' && !S.stats) await loadStats();
    if (view === 'reports') await loadReports();
    if (view === 'sync') { await loadBackups(); }
    if (view === 'browsers') { await Act.browserScan(); return; }
    if (view === 'about') await loadQuota();
    render();
  },

  async loadQuota() { await loadQuota(); render(); },

  async toggleRule(id) {
    const l = S.data.config.rules.find((x) => x.id === id);
    if (!l) return;
    if (l.lock && l.lock.kind !== 'none' && l.enabled) { toast('这条自律规则已锁定，不能直接关闭', 'err'); render(); return; }
    // 时段进行中（含休息段）：自律规则开关整体锁死，开、关都不许动
    if (settingsFrozen()) { guardDiscipline('切换自律规则开关'); render(); return; }
    l.enabled = !l.enabled;
    await saveConfig();
    render();
  },

  async delRule(id) {
    const l = S.data.config.rules.find((x) => x.id === id);
    if (!l) return;
    if (l.lock && l.lock.kind !== 'none') { toast('已锁定的自律规则不能删除', 'err'); return; }
    if (settingsFrozen()) { guardDiscipline('删除自律规则'); return; }
    if (!confirm(`确定删除自律规则「${l.name}」？`)) return;
    S.data.config.rules = S.data.config.rules.filter((x) => x.id !== id);
    await saveConfig();
    render();
  },

  async saveEditor() {
    const r = S.editing;
    syncEditorInputs();
    const nameEl = $('#ruleName');
    if (nameEl) r.name = nameEl.value.trim() || '未命名自律规则';
    if (S.editorTab === 'lock') {
      if (r.lock.kind === 'timer') {
        const m = +(($('#lockMins') || {}).value || 60);
        r.lock.until = Math.floor(Date.now() / 1000) + m * 60;
      }
      if (r.lock.kind === 'password') r.lock.password = ($('#lockPwd') || {}).value || '';
      if (r.lock.kind === 'text') r.lock.chars = +(($('#lockChars') || {}).value || 20);
    }
    const rules = S.data.config.rules;
    const i = rules.findIndex((x) => x.id === r.id);
    if (i >= 0) rules[i] = r; else rules.push(r);
    const ok = await saveConfig();
    if (!ok) {
      // 后端拒绝了（多为自律时段里删了已生效的条目）。
      // 保留编辑器不关，用户看得到提示、也能把改动改回去。
      render();
      return;
    }
    S.editing = null;
    closeModal();
    render();
    toast('自律规则已保存', 'ok');
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
  async maskSave() {
    const m = S.data.config.settings.mask;
    const cur = S.data.mask;
    m.opacity = cur.opacity;
    m.blockClick = cur.blockClick;
    m.follow = !!cur.follow;
    m.mediaPause = !!cur.mediaPause;
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
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
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
            ? '测试期间的自律规则、设置、统计会<b>合并进正式环境</b>，回到正式模式后可以看到。正式环境原有的其它数据不会被删除。'
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

  async toggleMediaPause() {
    const on = !S.data.mask.mediaPause;
    try {
      await invoke('mask_media_pause', { enabled: on });
      await pull();
      render();
      toast(on ? '已开启媒体管控：遮罩生效时自动暂停被盖住窗口的媒体，回到前台自动恢复' : '已关闭媒体管控，已暂停的媒体会自动恢复', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
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
    const period = S.genPeriod || 'daily';
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

  /* ---- Hub：激励语录 ---- */

  /** 换一条：在自己写的和联网的那条之间轮换 */
  quoteNext() {
    const pool = quotePool();
    if (pool.length <= 1) {
      toast('现在只有这一条，可以在「我的语录」里多写几句', '');
      return;
    }
    const i = pool.findIndex((x) => x.key === S.quoteAt);
    S.quoteAt = pool[(i + 1) % pool.length].key;
    render();
  },

  /** 设置页里直接维护语录：加一条 / 删一条都立即写盘并重绘 */
  async setQuoteAdd() {
    const inp = $('#setQuoteNew');
    const v = ((inp && inp.value) || '').trim();
    if (!v) { if (inp) inp.focus(); return; }
    if (v.length > 120) { toast('一句话最多 120 字', 'err'); return; }
    const list = (S.data.config.settings.customQuotes || []).slice();
    if (list.includes(v)) { toast('这句已经加过了', ''); return; }
    if (list.length >= 60) { toast('最多 60 条，先删掉几条吧', 'err'); return; }
    list.push(v);
    await Act.setQuotes(list);
  },

  async setQuoteDel(i) {
    const list = (S.data.config.settings.customQuotes || []).slice();
    if (i < 0 || i >= list.length) return;
    list.splice(i, 1);
    await Act.setQuotes(list);
  },

  async setQuotes(list) {
    S.data.config.settings.customQuotes = list.slice(0, 60);
    const ok = await saveConfig();
    S.quoteAt = '';
    render();
    toast(ok ? '语录已保存' : '保存失败', ok ? 'ok' : 'err');
  },

  /** 直接从 Hub 写一句新的：打开面板并把光标放进输入框 */
  quoteAddNew() {
    Act.quoteManage();
    setTimeout(() => {
      const inp = $('#quoteNew');
      if (inp) { inp.focus(); inp.scrollIntoView({ block: 'nearest' }); }
    }, 60);
  },

  quoteManage() {
    S.quoteEdit = ((S.data.config.settings || {}).customQuotes || []).slice();
    renderQuoteModal();
  },

  quoteAdd() {
    const inp = $('#quoteNew');
    const v = ((inp && inp.value) || '').trim();
    if (!v) { if (inp) inp.focus(); return; }
    if (v.length > 120) { toast('一句话最多 120 字', 'err'); return; }
    if ((S.quoteEdit || []).includes(v)) { toast('这句已经加过了', ''); return; }
    if ((S.quoteEdit || []).length >= 60) { toast('最多 60 条，先删掉几条吧', 'err'); return; }
    S.quoteEdit = [...(S.quoteEdit || []), v];
    renderQuoteModal();
  },

  quoteDel(i) {
    S.quoteEdit = (S.quoteEdit || []).filter((_, k) => k !== i);
    renderQuoteModal();
  },

  async quoteSave() {
    S.data.config.settings.customQuotes = (S.quoteEdit || []).slice();
    const ok = await saveConfig();      // 内部会 pull + 用后端真实状态回填
    closeModal();
    S.quoteAt = '';
    render();
    toast(ok ? '语录已保存' : '保存失败', ok ? 'ok' : 'err');
  },

  /* ---- 历史报告：类型选择 / 导出 / 删除 ---- */

  genPeriodSet(v) {
    S.genPeriod = v;
    render();
  },

  /** 打开导出面板：三种格式让用户选 */
  repExportOpen(id) {
    const r = S.reports.find((x) => x.id === id);
    if (!r) { toast('报告不存在，可能已被删除', 'err'); return; }
    S.repExport = id;
    $('#modalRoot').innerHTML = `
      <div class="modal-mask" data-act="close-modal-bg">
        <div class="modal" style="width:520px">
          <div class="modal-hd">
            <h3>导出报告</h3>
            <button class="close-x" data-act="close-modal">×</button>
          </div>
          <div class="modal-bd">
            <div class="hint" style="margin-bottom:12px;line-height:1.7">
              ${esc(r.title)}<br>${r.start} ~ ${r.end}
            </div>
            <div class="exp-fmts">
              <button class="exp-fmt" data-act="report-export-do" data-f="md">
                <span class="ic">MD</span>
                <span class="tx"><b>Markdown</b><i>.md · 标题与列表层级完整，适合笔记软件</i></span>
              </button>
              <button class="exp-fmt" data-act="report-export-do" data-f="txt">
                <span class="ic">TXT</span>
                <span class="tx"><b>纯文本</b><i>.txt · 无格式符号，任何设备都能打开</i></span>
              </button>
              <button class="exp-fmt" data-act="report-export-do" data-f="docx">
                <span class="ic">DOC</span>
                <span class="tx"><b>Word 文档</b><i>.docx · 带标题样式与两级项目符号，可直接打印</i></span>
              </button>
            </div>
          </div>
          <div class="modal-ft">
            <button class="btn" data-act="close-modal">取消</button>
          </div>
        </div>
      </div>`;
  },

  async repExportDo(fmt) {
    const id = S.repExport;
    if (!id) return;
    const btns = [...document.querySelectorAll('.exp-fmt')];
    btns.forEach((b) => { b.disabled = true; });
    const cur = document.querySelector(`.exp-fmt[data-f="${fmt}"]`);
    if (cur) cur.classList.add('busy');
    try {
      const p = await invoke('report_export', { id, format: fmt });
      closeModal();
      toast(`已导出：${p}`, 'ok');
    } catch (e) {
      const msg = String(e || '');
      // 用户在系统对话框里点了取消，不算失败
      if (msg.includes('已取消')) toast('已取消导出', '');
      else toast(`导出失败：${msg}`, 'err');
      btns.forEach((b) => { b.disabled = false; });
      if (cur) cur.classList.remove('busy');
    }
  },

  /** 删除前二次确认：删的是报告，原始日数据不动 */
  repDeleteAsk(id) {
    const r = S.reports.find((x) => x.id === id);
    if (!r) { toast('报告不存在，可能已被删除', 'err'); return; }
    S.repDelete = id;
    $('#modalRoot').innerHTML = `
      <div class="modal-mask" data-act="close-modal-bg">
        <div class="modal" style="width:460px">
          <div class="modal-hd">
            <h3>删除这份报告？</h3>
            <button class="close-x" data-act="close-modal">×</button>
          </div>
          <div class="modal-bd">
            <div style="font-size:13px;line-height:1.8">
              <b>${esc(r.title)}</b><br>
              <span class="hint">${r.start} ~ ${r.end} · 生成于 ${new Date(r.created * 1000).toLocaleString()}</span>
            </div>
            <div class="hint" style="margin-top:12px">删除后无法恢复。原始逐日统计数据不受影响，需要的话可以重新生成。</div>
          </div>
          <div class="modal-ft">
            <button class="btn" data-act="close-modal">取消</button>
            <button class="btn btn-danger" data-act="report-del-do">确认删除</button>
          </div>
        </div>
      </div>`;
  },

  async repDeleteDo() {
    const id = S.repDelete;
    if (!id) return;
    const btn = document.querySelector('[data-act="report-del-do"]');
    if (btn) { btn.disabled = true; btn.textContent = '正在删除…'; }
    try {
      await invoke('report_delete', { id });
      S.repDelete = null;
      closeModal();
      await loadReports();
      render();
      toast('已删除该报告', 'ok');
    } catch (e) {
      toast(`删除失败：${String(e)}`, 'err');
      if (btn) { btn.disabled = false; btn.textContent = '确认删除'; }
    }
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
    if (k === 'alwaysOnTop') {
      // 窗口层级必须由后端改（前端只能存一个布尔值）。
      // 这里不做乐观更新：等后端真的把窗口设成置顶之后再刷新界面，
      // 免得出现"开关亮了但窗口还在下面"的假象。
      const next = !st.alwaysOnTop;
      try {
        await invoke('set_always_on_top', { enabled: next });
        st.alwaysOnTop = next;
        toast(next ? '主窗口已置顶' : '已取消置顶', 'ok');
      } catch (e) {
        toast('切换置顶失败：' + e, 'err');
      }
      await pull(); render(); return;
    }
    if (k === 'hudEnabled') {
      const h = st.hud || (st.hud = { enabled: true, quoteMinutes: 60 });
      h.enabled = !h.enabled;
      await invoke('hud_save', { enabled: h.enabled, quoteMinutes: h.quoteMinutes || 60 });
      await pull(); render(); return;
    }
    if (k === 'runAsAdmin') {
      const turningOn = !st.runAsAdmin;
      // 开启要重启进程 = 退出程序。自律时段里这条路必须堵死，
      // 否则"点一下开关"就成了绕过「自律期间不能退出」的后门。
      if (turningOn && settingsFrozen() && !S.data.admin) {
        toast('自律时段生效中，切换管理员模式要重启程序，先等这段结束', 'err');
        return;
      }
      st.runAsAdmin = turningOn;
      try {
        await invoke('set_run_as_admin', { enabled: st.runAsAdmin });
      } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); return; }
      if (st.runAsAdmin) {
        if (S.data.admin) {
          // 已经是管理员 → 后端不会重启，别骗用户说"正在重启"
          toast('已开启：当前已经是管理员，下次启动同样以管理员运行', 'ok');
          await pull(); render(); return;
        }
        // 后端已经落盘 + 拉起了提权副本，本进程 350ms 后退出。
        // 这里不要再 saveConfig / pull —— 进程随时会走，调用会失败并弹红条。
        toast('已保存，正在以管理员身份重启…', 'ok');
        return;
      }
      toast('已关闭管理员模式（下次启动生效）', 'ok');
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
  /** 切换界面语言：写配置 → 重绘内容 → 全量应用。
   *  先 render 再 applyLang：重绘出来的节点是中文原文，切换/还原都走同一条路。 */
  async setLang(v) {
    const want = v === 'en' ? 'en' : 'zh-CN';
    if (langPref() === want) return;
    S.data.config.settings.lang = want;
    const ok = await saveConfig();
    render();
    applyLang();
    toast(ok
      ? (want === 'en' ? '已切换到 English' : '已切换回简体中文')
      : '语言保存失败', ok ? 'ok' : 'err');
  },
  async cycleTheme() {
    const cur = S.data.config.settings.theme || 'system';
    const next = cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system';
    await Act.setTheme(next);
  },

  async restartAdmin() { await invoke('restart_as_admin'); },
  async openExt() { try { await invoke('open_extension_dir'); } catch (e) { toast(String(e), 'err'); } },
  async forceQuit() {
    // 强制退出不弹确认框（语义就是"立刻走"），但要有一次防误触的确认，
    // 否则点一下界面就整个程序没了。
    if (!confirm('确定要强制退出 King Of Focus 吗？\n（等同于按 Ctrl+Alt+F4）')) return;
    try { await invoke('force_quit'); } catch (e) { toast(String(e), 'err'); }
  },
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

  /** 手动指定浏览器主程序路径。
   *  主通道走后端 `pick_path`（tauri_plugin_dialog 原生文件选择框，与自律规则页"选择 exe"同一条已验证链路）。
   *  后端对话框不可用时退回输入框，保证任何情况下都能设/清除，不被一个对话框堵死。 */
  /** 自定义浏览器：选 exe（选择器优先，取不到就退回粘贴） */
  async customBrowserPick() {
    let picked = null;
    try {
      picked = await withTimeout(
        invoke('pick_path', { kind: 'file' }),
        300000,
        '选择文件超时'
      );
    } catch (e) {
      picked = null;
    }
    if (!picked) return;
    const box = $('#cbExe');
    if (box) box.value = String(picked);
    const nm = $('#cbName');
    if (nm && !nm.value.trim()) {
      // 名称空着就先用文件名兜底，省得用户再想一个
      nm.value = String(picked).split(/[\\/]/).pop().replace(/\.exe$/i, '');
    }
  },

  async customBrowserSave() {
    const name = (($('#cbName') || {}).value || '').trim();
    const exe = (($('#cbExe') || {}).value || '').trim();
    if (!name) { toast('先给这个浏览器起个名字', 'err'); return; }
    if (!exe) { toast('先选择或粘贴主程序路径', 'err'); return; }
    try {
      await invoke('browser_custom_save', { id: '', name, exe, extPage: '' });
      if ($('#cbName')) $('#cbName').value = '';
      if ($('#cbExe')) $('#cbExe').value = '';
      toast('已添加，正在重新检测…', 'ok');
      await Act.browserScan();
    } catch (e) {
      toast(String(e && e.message ? e.message : e), 'err');
    }
  },

  async customBrowserDel(id) {
    if (!id) return;
    if (!confirm('删除这个自定义浏览器？只是不再登记它，不会动浏览器本身。')) return;
    try {
      await invoke('browser_custom_remove', { id });
      toast('已删除', 'ok');
      await Act.browserScan();
    } catch (e) {
      toast(String(e && e.message ? e.message : e), 'err');
    }
  },

  async browserSetPath(key) {
    let picked = null;
    try {
      picked = await withTimeout(
        invoke('pick_path', { kind: 'file' }),
        300000,
        '选择文件超时'
      );
    } catch (e) {
      picked = null;
    }
    // pick_path 有效返回 → 用它；返回 null/空 = 用户点了取消或对话框不可用，
    // 再走输入框让用户粘路径（留空=清除）。两条路都不会无声失败。
    if (!picked) {
      picked = window.prompt(
        '粘贴浏览器主程序（.exe）的完整路径：\n例如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n\n留空并确定 = 清除自定义设置、改为自动检测',
        ''
      );
    }
    if (picked === null) return;
    try {
      const msg = await invoke('browser_set_path', { key, path: String(picked) });
      toast(msg, 'ok');
      await pull();
      render();
    } catch (e) {
      const m = String(e).replace(/^Error:\s*/, '');
      toast('这个路径不能用：' + m, 'err');
      const s = $('#extOpenStatus');
      if (s) {
        s.className = 'ext-status err';
        s.innerHTML = '✗ 路径无效：' + esc(m) + '<br>请重新选择该浏览器的 .exe 主程序。';
      }
    }
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
        '<br>如果原因是"找不到主程序"，点「设置路径」手动选中该浏览器的 .exe 即可。<br>' +
        '也可以点「打开文件夹」，然后在浏览器里手动打开扩展页 → 开发者模式 → 加载已解压的扩展程序。',
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

  /* ---- 自律时段（多套「星期时段」方案 × 24 段） ---- */
  async clockEnable() {
    const fc = clockCfg();
    // 时段进行中（含休息段）：开关整体锁死，两个方向都不许动
    if (settingsFrozen()) { guardDiscipline('切换「自律时段」开关'); render(); return; }
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
    // 生效中不能关掉"自律时间内启用自律规则"（打开是加强，不拦）
    if (fc.applyRules && settingsFrozen()) { guardDiscipline('关闭「自律时间内启用自律规则」'); render(); return; }
    fc.applyRules = !fc.applyRules;
    await saveConfig();
    render();
    toast(fc.applyRules ? '自律时间内启用自律规则' : '自律时间内不再启用自律规则，只负责进入自律状态', 'ok');
  },

  async clockClear() {
    const prof = clockProfile();
    if (settingsFrozen()) { guardDiscipline('清空已选时段'); return; }
    let n = 0;
    prof.days.forEach((day) => day.forEach((p) => { if (p.on) { p.on = false; n++; } }));
    await saveConfig();
    render();
    toast(n ? `已清空 ${n} 个小时段` : '当前没有已选时段', n ? 'ok' : 'err');
  },

  /** 提交一次自由拖选：[lo,hi) 是当天的一段连续分钟区间。
   *
   *  `mode = 'add'` → 并入这一天的选中范围；`'sub'` → 从原有选中里抹掉这一段。
   *  每个小时各自只存一个窗口 [from,to)，所以同一小时里的两段会被并成一段
   *  （这是数据模型的固有限制，右键菜单里仍可以精细改起止分钟）。
   */
  /** 把某一天 [from,to) 这一段整体平移到 [nFrom,nTo)。
   *
   *  先清原区间、再写新区间，全程只写一次盘、只重绘一次；
   *  两段重叠也没关系——顺序是"先删后加"，重叠部分最后是被写上的。 */
  async clockMoveSeg(d, from, to, nFrom, nTo) {
    const prof = clockProfile();
    if (settingsFrozen()) { guardDiscipline('调整已选中的时段'); render(); return; }
    const days = prof.days[d];
    const put = (lo, hi, mode) => {
      for (let h = 0; h < 24; h++) {
        const hs = h * 60;
        if (hi <= hs || lo >= hs + 60) continue;
        const p = days[h];
        const r = ccHourResult(p, h, lo, hi, mode);
        if (!r) {
          if (p.on) { p.on = false; p.from = 0; p.to = 60; }
          continue;
        }
        if (!p.on) { p.work = prof.defWork; p.brk = prof.defBrk; }
        p.on = true;
        p.from = r.f;
        p.to = r.t;
      }
    };
    put(from, to, 'sub');
    put(nFrom, nTo, 'add');
    await saveConfig();
    render();
    const t = ccMinText(nFrom, nTo);
    toast(`已把 ${WD[d]} 的时段移到 ${t.range}（共 ${t.dur}）`, 'ok');
  },

  async clockCommitRange(d, lo, hi, mode) {
    const prof = clockProfile();
    if (mode === 'sub' && settingsFrozen()) { guardDiscipline('取消已选中的时段'); render(); return; }
    const days = prof.days[d];
    let changed = 0;
    for (let h = 0; h < 24; h++) {
      const hs = h * 60;
      if (hi <= hs || lo >= hs + 60) continue;   // 不涉及这一小时
      const p = days[h];
      const r = ccHourResult(p, h, lo, hi, mode);
      if (!r) {
        if (p.on) { p.on = false; p.from = 0; p.to = 60; changed++; }
        continue;
      }
      const wasOn = p.on;
      const wasWin = p.on ? `${p.from || 0}-${p.to == null ? 60 : p.to}` : '';
      if (!p.on) { p.work = prof.defWork; p.brk = prof.defBrk; }
      p.on = true;
      p.from = r.f;
      p.to = r.t;
      if (!wasOn || wasWin !== `${r.f}-${r.t}`) changed++;
    }
    if (!changed) { render(); return; }   // 没有实际变化就别写盘
    await saveConfig();
    render();
    const t = ccMinText(lo, hi);
    toast(mode === 'sub'
      ? `已取消 ${WD[d]} ${t.range}`
      : `已选中 ${WD[d]} ${t.range}（共 ${t.dur}）`, 'ok');
  },

  /** 单击 = 单独开关一个 15 分钟刻度（与整小时窗口做并/差） */
  async clockToggleQ(d, h, q) {
    const prof = clockProfile();
    const p = prof.days[d][h];
    const a = qStart(q), b = qEnd(q);
    const pf = p.on ? (p.from || 0) : 0;
    const pt = p.on ? (p.to == null ? 60 : p.to) : 60;
    const covered = p.on && pf < b && a < pt;
    if (covered && settingsFrozen()) { guardDiscipline('取消已选中的时段'); render(); return; }
    if (covered) {
      // 挖掉这 15 分钟：保留左右两侧
      const keepL = { f: pf, t: Math.min(pt, a) };
      const keepR = { f: Math.max(pf, b), t: pt };
      if (keepL.t > keepL.f) { p.from = keepL.f; p.to = keepL.t; }
      else if (keepR.t > keepR.f) { p.from = keepR.f; p.to = keepR.t; }
      else { p.on = false; p.from = 0; p.to = 60; }
    } else {
      if (!p.on) { p.work = prof.defWork; p.brk = prof.defBrk; }
      p.from = p.on ? Math.min(pf, a) : a;
      p.to = p.on ? Math.max(pt, b) : b;
      p.on = true;
    }
    await saveConfig();
    render();
  },

  /** 右键菜单应用：给矩形区域设置专注 / 休息时长（顺带开启这些时段）。
   *  defToo = 同时把这一套更新成「通用」时长，之后新选的时段沿用 */
  /** 右键菜单应用：给矩形区域设置专注 / 休息时长（顺带开启这些时段），
   *  并用起止分钟收窄首/尾小时的选中窗口。
   *  defToo = 同时把这一套更新成「通用」时长，之后新选的时段沿用。
   *  fromMin/toMin：起始分钟作用于第一个小时、结束分钟作用于最后一个小时；
   *  0 / 60 = 整点。范围内先归一成整小时，避免上次留下的窄窗口看不见地残留。 */
  async clockSetWB(d0, d1, h0, h1, w, b, defToo, fromMin, toMin) {
    const prof = clockProfile();
    // 生效中不能改"正在跑的这一小时"的时长（否则等于用改时长逃逸）
    const wdNow = (new Date().getDay() + 6) % 7;
    const hourNow = new Date().getHours();
    if (settingsFrozen() && d0 <= wdNow && wdNow <= d1 && h0 <= hourNow && hourNow <= h1) {
      guardDiscipline('改这一小时的专注 / 休息时长');
      return;
    }
    // 单格的起止分钟必须起早于止：非法时原样返回 false（不改配置），调用方给出提示并留住菜单。
    // 这条兜住一切入口（右键菜单 / 直接调 Act），与菜单里的校验是同一条约束。
    if (d0 === d1 && h0 === h1 && (Number(fromMin) || 0) >= (Number(toMin) || 0)) {
      return false;
    }
    // 起止分钟对齐 15 分钟刻度（边界自动向下/向上取整，零碎时间才对得齐）。
    // snap 后再判一次非法：刻度对齐也可能让「起 >= 止」成立（45/30 → 45/30）。
    const snap = ccSnapWin(fromMin, toMin);
    if (d0 === d1 && h0 === h1 && snap.f >= snap.t) {
      return false;
    }
    let n = 0;
    for (let d = d0; d <= d1; d++) {
      for (let h = h0; h <= h1; h++) {
        const p = prof.days[d][h];
        p.on = true;
        p.work = w;
        p.brk = b;
        p.from = 0;
        p.to = 60;
        n++;
      }
    }
    // 起止分钟只落在边界小时上（单格时两个都在这一格）
    prof.days[d0][h0].from = snap.f;
    prof.days[d1][h1].to = snap.t;
    if (defToo) { prof.defWork = w; prof.defBrk = b; }
    await saveConfig();
    render();
    const f2 = prof.days[d0][h0].from, t2 = prof.days[d1][h1].to;
    // 改到了「正在进行中的时段」：它会立刻按新时长重新划分专注 / 休息，提醒一句
    const liveTip = (d0 <= wdNow && wdNow <= d1 && h0 <= hourNow && hourNow <= h1)
      ? '；当前进行中的时段会立即按新时长重新划分'
      : '';
    const winTip = (f2 > 0 || t2 < 60) ? `，起止分钟 ${pad(f2)}–${pad(t2)}` : '';
    toast(`${ccRectText(d0, d1, h0, h1, f2, t2)}：专注 ${w} 分${b ? ` / 休息 ${b} 分` : '（不休息）'}${winTip}，共 ${n} 段${defToo ? '；已更新为通用时长' : ''}${liveTip}`, 'ok');
    return true;
  },

  /** 保存「通用时长」：之后新选中的时段都沿用这套专注 / 休息（只作用于当前方案） */
  async clockDefSave() {
    const prof = clockProfile();
    let w = Math.round(Number($('#defW').value) || 0);
    let b = Math.round(Number($('#defB').value) || 0);
    w = Math.max(1, Math.min(60, w));
    b = Math.max(0, Math.min(60, b));
    if (b > 0 && w + b > 60) b = 60 - w;
    prof.defWork = w;
    prof.defBrk = b;
    await saveConfig();
    render();
    // 通用时长只作用于"之后新选的时段"；已经选中的时段保留各自的时长
    toast(`通用时长已设为 专注 ${w} 分${b ? ` / 休息 ${b} 分` : '（不休息）'}：之后新选的时段都会沿用（已选中的时段保持原样）`, 'ok');
  },

  /** 改「每次选择多少分钟」：10 / 15。
   *
   * 只改画法与吸附粒度，不动已有配置 —— from/to 存的是绝对分钟，
   * 原来对齐到 15 分钟边界的时段在 10 分钟粒度下依然对齐，
   * 所以切成 10 分钟不会把排好的表弄乱，只是能排得更细。 */
  async clockGran(v) {
    const fc = clockCfg();
    const g = +v === 10 ? 10 : 15;
    if (fc.granularity === g) return;
    fc.granularity = g;
    await saveConfig();
    render();
    toast(`已改为每格 ${g} 分钟：一小时 ${60 / g} 格，已排好的时段不受影响`, 'ok');
  },

  /** 勾选 / 取消"这套时段管哪些自律规则分组"。
   *
   * 空列表 = 全部（默认，也是老配置的语义）。
   * 取消某组 = 这套时段不再管它 → 属于"放松纪律"，生效期间要拦。 */
  async clockBind(id) {
    const p = clockProfile();
    if (!Array.isArray(p.bound)) p.bound = [];
    const removing = !id || p.bound.includes(id);
    if (removing && settingsFrozen()) { guardDiscipline('改绑自律规则分组'); render(); return; }
    if (!id) p.bound = [];
    else if (p.bound.includes(id)) p.bound = p.bound.filter((x) => x !== id);
    else p.bound = [...p.bound, id];
    await saveConfig();
    render();
    const names = (S.data.config.rules || []);
    if (!p.bound.length) { toast('这套时段恢复为「全部自律规则生效」', 'ok'); return; }
    const label = p.bound.map((x) => (names.find((l) => l.id === x) || {}).name || x).join('、');
    toast(`「${p.name}」现在只管：${label}`, 'ok');
  },

  /** 把 HUD 停到某个角（立刻生效并落盘） */
  async hudCorner(corner) {
    try {
      await invoke('hud_set_look', { corner });
    } catch (e) {
      toast('切换 HUD 位置失败：' + e, 'err');
      return;
    }
    await pull();
    render();
    const name = { tl: '左上', tr: '右上', bl: '左下', br: '右下' }[corner] || corner;
    toast(`HUD 已停靠到${name}角`, 'ok');
  },

  /** 存 HUD 透明度（滑块松手时调用） */
  async hudOpacity(v) {
    const n = Math.max(30, Math.min(100, Math.round(+v || 92)));
    try {
      await invoke('hud_set_look', { opacity: n });
    } catch (e) {
      toast('设置透明度失败：' + e, 'err');
      return;
    }
    await pull();
    render();
  },

  /* ---- 多套「星期时段」方案 ---- */
  /** 切换生效方案（时段进行中不许切：切到更松的一套等于当场放行） */
  async clockProfSwitch(id) {
    const fc = clockCfg();
    if (settingsFrozen()) { guardDiscipline('切换「星期时段」方案'); render(); return; }
    if (!fc.profiles.some((p) => p.id === id) || fc.active === id) return;
    fc.active = id;
    await saveConfig();
    render();
    const p = clockProfile();
    toast(`已切换到「${p.name}」：从现在起按这套时段判定`, 'ok');
  },

  /** 新建一套空白方案并立刻切过去 */
  async clockProfNew(name) {
    const fc = clockCfg();
    if (settingsFrozen()) { guardDiscipline('新建「星期时段」方案'); render(); return; }
    if (fc.profiles.length >= CC_MAX_PROFILES) { toast(`最多 ${CC_MAX_PROFILES} 套方案`, 'err'); return; }
    const cur = clockProfile();
    const id = `p${Date.now().toString(36)}`;
    fc.profiles.push({
      id,
      name,
      days: [],                       // 空表：由归一化补成 7×24 全灰
      defWork: cur.defWork,
      defBrk: cur.defBrk,
    });
    fc.active = id;
    await saveConfig();
    render();
    toast(`已新建「${name}」并切到这套：在下面拖出要自律的时段`, 'ok');
  },

  /** 重命名当前方案 */
  async clockProfRename(name) {
    if (settingsFrozen()) { guardDiscipline('重命名「星期时段」方案'); render(); return; }
    const p = clockProfile();
    p.name = name;
    await saveConfig();
    render();
    toast(`已重命名为「${name}」`, 'ok');
  },

  /** 复制当前方案（排班 + 通用时长一起复制） */
  async clockProfDup() {
    const fc = clockCfg();
    if (settingsFrozen()) { guardDiscipline('复制「星期时段」方案'); render(); return; }
    if (fc.profiles.length >= CC_MAX_PROFILES) { toast(`最多 ${CC_MAX_PROFILES} 套方案`, 'err'); return; }
    const cur = clockProfile();
    const copy = JSON.parse(JSON.stringify(cur));
    copy.id = `p${Date.now().toString(36)}`;
    copy.name = `${cur.name} 副本`.slice(0, 30);
    fc.profiles.push(copy);
    fc.active = copy.id;
    await saveConfig();
    render();
    toast(`已复制出「${copy.name}」并切过去`, 'ok');
  },

  /** 删除当前方案（至少留一套；时段进行中不许删） */
  async clockProfDel() {
    const fc = clockCfg();
    if (settingsFrozen()) { guardDiscipline('删除「星期时段」方案'); render(); return; }
    if (fc.profiles.length <= 1) { toast('至少要留一套方案', 'err'); return; }
    const cur = clockProfile();
    if (!confirm(`确定删除方案「${cur.name}」？这套排班会被一起删掉。`)) return;
    fc.profiles = fc.profiles.filter((p) => p.id !== cur.id);
    fc.active = fc.profiles[0].id;
    await saveConfig();
    render();
    toast(`已删除「${cur.name}」，现在用的是「${clockProfile().name}」`, 'ok');
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
    renderEditor();
  },
  schedClear() {
    S.editing.schedule = [[], [], [], [], [], [], []];
    renderEditor();
  },
};

/** 保存整份配置。返回 true 表示后端真的接受了（自律时段内可能被拒绝） */
async function saveConfig() {
  let ok = true;
  try {
    await invoke('save_config', { config: S.data.config });
  } catch (e) {
    ok = false;
    toast(String(e).replace(/^Error:\s*/, ''), 'err');
  }
  // 无论成败都拉一次：失败时用服务端的真实状态把界面上的改动冲掉
  await pull();
  return ok;
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
/** 关弹窗：先播一段退场再移除。
 *
 *  退场只有 120ms，但这段窗口里可能已经开了下一个弹窗（语录面板、导出面板
 *  之间是来回切的；自动化脚本里更常见）。所以监听一次子节点变化：
 *  一旦有人改写了 #modalRoot，就取消这次清理——宁可动画少播一帧，
 *  也不能把刚打开的新弹窗删掉。 */
function closeModal() {
  const root = $('#modalRoot');
  if (!root) return;
  const mask = root.querySelector('.modal-mask');
  if (!mask) { root.innerHTML = ''; return; }
  mask.classList.add('closing');
  const box = mask.querySelector('.modal');
  if (box) box.classList.add('closing');

  let tid = 0;
  const obs = new MutationObserver(() => {
    // 期间有新内容写进来（新弹窗）→ 放弃这次清理
    obs.disconnect();
    clearTimeout(tid);
  });
  obs.observe(root, { childList: true, subtree: true });
  tid = setTimeout(() => {
    obs.disconnect();
    if (root.querySelector('.modal-mask') === mask) root.innerHTML = '';
  }, 120);
}

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

/** 「我的语录」管理面板：列出、删除、添加，保存前都只改本地副本 */
function renderQuoteModal() {
  const list = S.quoteEdit || [];
  const rows = list.length
    ? list.map((t, i) => `<div class="qrow">
        <span class="n">${i + 1}</span>
        <span class="t">${esc(t)}</span>
        <button class="btn btn-sm danger-ghost" data-act="quote-del" data-i="${i}">删除</button>
      </div>`).join('')
    : '<div class="empty" style="padding:20px"><span class="ico">”</span>还没有自己写的语录，在下面输入一句吧。</div>';
  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="width:600px">
      <div class="modal-hd">
        <h3>我的激励语录 <span class="badge">${list.length} 条</span></h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="hint" style="margin-bottom:12px">
          这里的句子会和联网取到的「一言」一起在 Hub 顶部轮换，每条下面都会标明来源。
        </div>
        <div class="qlist">${rows}</div>
        <div class="row" style="gap:8px;margin-top:14px">
          <input type="text" id="quoteNew" style="flex:1" maxlength="120"
            placeholder="写一句给自己的话（最多 120 字），回车即可添加" />
          <button class="btn btn-sm" data-act="quote-add">添加</button>
        </div>
      </div>
      <div class="modal-ft">
        <button class="btn" data-act="close-modal">取消</button>
        <button class="btn btn-primary" data-act="quote-save">保存</button>
      </div>
    </div>
  </div>`;
  const inp = $('#quoteNew');
  if (inp) {
    inp.focus();
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        Act.quoteAdd();
      }
    });
  }
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
    openSlotModal(el.dataset.id); return;
  }
  if (act === 'slot-more') {
    if (!S.editing) return;
    S.modalMode = 'editor';
    S.editorTab = 'apps';
    renderFullEditor();
    return;
  }
  if (act === 'save-slot') { await Act.saveEditor(); return; }
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
  if (act === 'tk-slot-del') {
    if (!S.editing) return;
    const day = +el.dataset.day, i = +el.dataset.i;
    const slots = (S.editing.schedule[day] || []).slice();
    if (!slots[i]) return;
    slots.splice(i, 1);
    S.editing.schedule[day] = slots;
    renderEditor();
    return;
  }
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
  if (act === 'clock-prof') { await Act.clockProfSwitch(el.dataset.id); return; }
  if (act === 'clock-prof-new') { ccNameDialog('new'); return; }
  if (act === 'clock-prof-rename') { ccNameDialog('rename'); return; }
  if (act === 'clock-prof-dup') { await Act.clockProfDup(); return; }
  if (act === 'clock-prof-del') { await Act.clockProfDel(); return; }
  if (act === 'hud-corner') { await Act.hudCorner(el.dataset.v); return; }
  if (act === 'clock-gran') { await Act.clockGran(el.dataset.v); return; }
  if (act === 'cc-open') { S.ccFull = true; render(); return; }
  if (act === 'cc-close') { S.ccFull = false; render(); return; }
  if (act === 'clock-bind') { await Act.clockBind(el.dataset.id || ''); return; }
  if (act === 'cc-name-ok') {
    const inp = $('#ccNameInput');
    const name = ((inp && inp.value) || '').trim().slice(0, 30);
    if (!name) { toast('方案名不能为空', 'err'); if (inp) inp.focus(); return; }
    closeModal();
    if (el.dataset.mode === 'new') await Act.clockProfNew(name);
    else await Act.clockProfRename(name);
    return;
  }
  if (act === 'mask-diag') { await Act.maskDiag(); return; }
  if (act === 'mask-preview') { await Act.maskPreview(); return; }
  if (act === 'toggle-follow-schedule') { await Act.toggleFollowSchedule(); return; }
  if (act === 'toggle-click') { await Act.toggleClick(); return; }
  if (act === 'toggle-follow') { await Act.toggleFollow(); return; }
  if (act === 'toggle-media-pause') { await Act.toggleMediaPause(); return; }
  if (act === 'test-enter') { await Act.enterTestMode(); return; }
  if (act === 'test-exit-keep') { await Act.askExitTest(true); return; }
  if (act === 'test-exit-discard') { await Act.askExitTest(false); return; }
  if (act === 'test-exit-do') { closeModal(); await Act.exitTestMode(el.dataset.keep === '1'); return; }
  if (act === 'stats-tab') { await Act.statsTab(el.dataset.tab); return; }
  if (act === 'range') { await Act.setRange(el.dataset.r); return; }
  if (act === 'range-apply') { await Act.applyRange(); return; }
  if (act === 'stats-refresh') { await Act.refreshStats(); return; }
  if (act === 'quote-next') { Act.quoteNext(); return; }
  if (act === 'quote-manage') { Act.quoteManage(); return; }
  if (act === 'quote-add-new') { Act.quoteAddNew(); return; }
  if (act === 'set-quote-add') { await Act.setQuoteAdd(); return; }
  if (act === 'set-quote-del') { await Act.setQuoteDel(+el.dataset.i); return; }
  if (act === 'quote-add') { Act.quoteAdd(); return; }
  if (act === 'quote-del') { Act.quoteDel(+el.dataset.i); return; }
  if (act === 'quote-save') { await Act.quoteSave(); return; }
  if (act === 'gen-report') { await Act.genReport(); return; }
  if (act === 'gen-period') { await Act.genPeriodSet(el.dataset.v); return; }
  if (act === 'open-report') { await Act.openReport(el.dataset.id); return; }
  if (act === 'reports-refresh') { await loadReports(); render(); return; }
  if (act === 'report-export-open') { Act.repExportOpen(el.dataset.id); return; }
  if (act === 'report-export-do') { await Act.repExportDo(el.dataset.f); return; }
  if (act === 'report-del-ask') { Act.repDeleteAsk(el.dataset.id); return; }
  if (act === 'report-del-do') { await Act.repDeleteDo(); return; }
  if (act === 'save-custom-days') { await Act.saveCustomDays(); return; }
  // 详情弹窗里的「删除这份报告」：同样走二次确认面板，不再用系统 confirm
  if (act === 'del-report') { Act.repDeleteAsk(el.dataset.id); return; }
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
  if (act === 'lang') { await Act.setLang(el.dataset.v); return; }
  if (act === 'cycle-theme') { await Act.cycleTheme(); return; }
  if (act === 'restart-admin') { await Act.restartAdmin(); return; }
  if (act === 'open-ext') { await Act.openExt(); return; }
  if (act === 'force-quit') { await Act.forceQuit(); return; }
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
  if (act === 'browser-setpath') { await Act.browserSetPath(el.dataset.k); return; }
  if (act === 'custom-browser-pick') { await Act.customBrowserPick(); return; }
  if (act === 'custom-browser-save') { await Act.customBrowserSave(); return; }
  if (act === 'custom-browser-del') { await Act.customBrowserDel(el.dataset.id); return; }
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

/* 自律时段：7 列 × 24 小时柱状图，二维矩形拖选
 * 口径：格子 = 某一天的一个小时，格子里再分 4 个 15 分钟刻度（滴答清单周视图同款）。
 * 按住拖动框出一片矩形（可跨天、跨小时），粒度落在 15 分钟刻度上：
 * 鼠标压在格子哪一段就落在哪个刻度，上下一划就能框住一个时间段；
 * 零碎时间（11:10–12:20 这种）也是一条整带，不会被小时边界切开。
 * 从灰格起笔 = 选中整片，从蓝格起笔 = 取消整片；单击（不拖动）= 单独开关那个 15 分钟刻度。
 * 右键格子 = 弹出"专注 / 休息"设置，作用于右键时选中的范围。 */

/** 整片矩形（刻度坐标）→ 逐格 [from,to) 的「目标选中窗口」映射。
 *  以「锚点刻度」为边界：起笔刻度之前的分钟是洞（若框往上有延伸），
 *  结束刻度之后的分钟是洞（若框往下有延伸）——与拖动框选的直觉一致。 */
function ccRectWindows(d0, d1, h0, h1, qA, qB) {
  const out = new Map();
  for (let d = d0; d <= d1; d++) {
    for (let h = h0; h <= h1; h++) {
      const top = (h === h0) ? qStart(qA) : 0;
      const bot = (h === h1) ? qEnd(qB) : 60;
      if (bot > top) out.set(`${d},${h}`, { f: top, t: bot });
    }
  }
  return out;
}
/** 重算某格的 DOM 选中态（.on）与细分刻度高亮（.cc-q.on），不触发整表渲染 */
function ccPaintCell(cell, d, h, win) {
  cell.classList.toggle('on', !!win);
  cell.querySelectorAll('.cc-q').forEach((q) => {
    const a = +q.dataset.a, b = +q.dataset.b;
    q.classList.toggle('on', !!win && win.f < b && a < win.t);
  });
}
/** hover 提示：只在停在细分刻度上时更新（避免 mouseover 抖动刷 tooltip） */
function ccHoverTip(cell, d, h, q) {
  const p = clockProfile().days[d][h];
  const a = qStart(q), b = qEnd(q);
  const w = Math.max(0, Math.min(60, p.work || 0));
  const br = Math.max(0, Math.min(60 - w, p.brk || 0));
  const onQ = p.on && (p.from || 0) < b && a < (p.to == null ? 60 : p.to);
  cell.setAttribute('title', `${WD[d]} ${pad(h)}:${pad(a)} – ${pad(h)}:${pad(b)}`
    + (onQ ? ` · 专注 ${w} 分 / 休息 ${br} 分，右键可改` : `（未选中，单击 / 拖选这 ${b - a} 分钟）`));
}

/* ───────── 自由拖选：按住就是一段，可随意伸缩 ─────────
 *
 * 交互口径（鼠标 / 手指共用同一套核心）：
 *   1. 按下 → 立刻把按住的那一个最小粒度作为起始选区（默认 15 分钟，可在设置里改 10 分钟）
 *   2. 不松手上下滑 → 选区沿时间轴伸缩，经过的时间自动并入**同一段**连续区间
 *   3. 拖动中实时高亮，并显示「起止时间 + 总时长」；到 0 点 / 24 点会明确提示
 *   4. 松手 → 立即提交（拖过多少就是多少，最少一格）
 *
 * 为什么不再用"矩形框选"：旧的手感是按格子跳的，指针移动必须跨过整格才更新一次，
 * 而且跨天时会变成二维矩形，和"我要选 9 点到 11 点半"这种线性意图不匹配。
 * 现在锚点固定在一个粒度上、另一端跟着指针连续走，天然就是一段可伸缩的区间。
 *
 * 关于边界：一列对应一天，纵向 0:00–24:00。拖出日界不跨天，而是夹到 0 点 / 24 点，
 * 并在文案里说明——这比"突然跳到隔壁那天"更符合直觉，也避免误改别的日子。
 */

/** 一天被切成多少个最小粒度 */
const ccDayGrains = () => 24 * ccQCnt();

/** 取某天这一列在视口里的几何（用来把 clientY 换算成"当天第几个粒度"） */
function ccDayGeom(d) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return null;
  const first = grid.querySelector(`.cc-cell[data-d="${d}"][data-h="0"]`);
  const last = grid.querySelector(`.cc-cell[data-d="${d}"][data-h="23"]`);
  if (!first || !last) return null;
  const r0 = first.getBoundingClientRect();
  return { top: r0.top, hourH: r0.height, bottom: last.getBoundingClientRect().bottom };
}

/** clientY → 当天第几个粒度（越界时夹住，并告诉调用方越到了哪边） */
function ccGrainAt(d, clientY) {
  const g = ccDayGeom(d);
  const n = ccDayGrains();
  if (!g || g.hourH <= 0) return { idx: 0, edge: 0 };
  const raw = Math.floor(((clientY - g.top) / g.hourH) * ccQCnt());
  const edge = clientY < g.top - 1 ? -1 : (clientY > g.bottom + 1 ? 1 : 0);
  return { idx: Math.max(0, Math.min(n - 1, raw)), edge };
}

/** 拖拽区间 [lo,hi)（分钟）：以锚点那一格为基准向两侧伸缩，最少一格 */
function ccDragRange(dg) {
  const st = ccStep();
  const n = ccDayGrains();
  const a = Math.max(0, Math.min(n - 1, dg.anchor));
  const c = Math.max(0, Math.min(n - 1, dg.cur));

  if (dg.mode === 'move') {
    // 整段平移：长度固定，只按"拖了多远"平移；撞到 0:00 / 24:00 就贴边停下
    let lo = dg.segFrom + (c - a) * st;
    let hi = dg.segTo + (c - a) * st;
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > 1440) { lo -= hi - 1440; hi = 1440; }
    return { lo: Math.max(0, lo), hi: Math.min(1440, hi) };
  }

  const lo = Math.min(a, c);
  const hi = Math.max(a, c) + 1;
  return { lo: lo * st, hi: Math.min(1440, hi * st) };
}

/** 把区间套到某一小时的已有窗口上 → {f,t}；null 表示这一小时没有选中 */
function ccHourResult(p, h, lo, hi, mode) {
  const hs = h * 60;
  const a = Math.max(lo, hs), b = Math.min(hi, hs + 60);
  const has = !!(p && p.on);
  const pf = has ? (p.from || 0) : 0;
  const pt = has ? (p.to == null ? 60 : p.to) : 60;
  if (mode === 'sub') {
    if (!has) return null;
    if (b <= a || a - hs >= pt || b - hs <= pf) return { f: pf, t: pt };
    // 从中间抹掉一段时保留较长的一侧（一小时只能存一个窗口，无法表达两段）
    const left = { f: pf, t: Math.min(pt, a - hs) };
    const right = { f: Math.max(pf, b - hs), t: pt };
    const lw = Math.max(0, left.t - left.f), rw = Math.max(0, right.t - right.f);
    if (lw >= rw && lw > 0) return left;
    if (rw > 0) return right;
    return null;
  }
  // add：与已有窗口取并集
  if (b <= a) return has ? { f: pf, t: pt } : null;
  const f = has ? Math.min(pf, a - hs) : a - hs;
  const t = has ? Math.max(pt, b - hs) : b - hs;
  return f < t ? { f, t } : null;
}

/* ───────── 拖拽预览：把"这一天的虚拟状态"画出来 ─────────
 *
 * 这一轮修的就是这里：以前 move 模式只在落点画一个虚线框、原块纹丝不动，
 * 松手才一下跳过去 —— 看起来像"卡住"，也不符合"抓着东西搬走"的直觉。
 *
 * 现在只有一个口径：预览 = **虚拟的一天**（24 个小时各自的窗口）。
 * 把它写进 DOM，再走与正式渲染**完全相同**的 ccRenderRuns，
 * 于是：
 *   · 被拖的那一块真的跟着指针走（半透明、微微抬起）
 *   · 块上的起止时间、每格刻度、每日时长、合计全部实时联动
 *   · 松手提交后是同一条代码路径画出来的，不会"跳一下"
 */

/** 预览下这一天 24 小时各自的窗口（null = 这一小时没选中） */
function ccPreviewWins(dg, lo, hi) {
  const prof = clockProfile();
  const day = prof.days[dg.d] || [];
  if (dg.mode === 'move') {
    // 整段平移：先把当天其它段原样抄过来（它们不能因为这次拖动而消失），
    // 再把"原段"覆盖到的小时清空，最后按落点铺上（与已有窗口取并集，
    // 这样预览和 clockMoveSeg 的 sub → add 完全一致）。
    const wins = day.map((p) => (p && p.on
      ? { f: p.from || 0, t: p.to == null ? 60 : p.to }
      : null));
    const s0 = Math.floor(dg.segFrom / 60);
    const s1 = Math.floor((dg.segTo - 1) / 60);
    for (let h = s0; h <= s1; h++) wins[h] = null;
    for (let h = 0; h < 24; h++) {
      const hs = h * 60;
      const a = Math.max(lo, hs), b = Math.min(hi, hs + 60);
      if (b <= a) continue;
      const prev = wins[h];
      wins[h] = prev
        ? { f: Math.min(prev.f, a - hs), t: Math.max(prev.t, b - hs) }
        : { f: a - hs, t: b - hs };
    }
    return wins;
  }
  // 新建 / 抹除：逐小时套用同一份判定（本次没碰到的小时原样保留）
  return new Array(24).fill(null).map((_, h) => ccHourResult(day[h], h, lo, hi, dg.mode));
}

/** 虚拟的一天里被选中多少分钟 */
function ccWinsMinutes(wins) {
  return (wins || []).reduce((n, w) => n + (w ? Math.max(0, w.t - w.f) : 0), 0);
}

/** 「合计 x」：拖拽中的实时文案也要跟着语言走 */
function ccTotalText(m) {
  return I18N.getLang() === 'en' ? `Total ${ccDurText(m)}` : `合计 ${ccMinText(0, m).dur}`;
}

/** 每日时长 / 合计：跟着预览实时联动（松手后整体重绘会覆盖，不必手动还原） */
function ccLiveTotals(d, wins) {
  const prof = clockProfile();
  const per = prof.days.map((day, i) => (wins && i === d ? ccWinsMinutes(wins) : ccDayMinutes(day)));
  const total = per.reduce((a, b) => a + b, 0);
  const hd = document.querySelector('.cc-days-hd');
  if (hd && hd.lastElementChild) hd.lastElementChild.textContent = ccTotalText(total);
  const row = document.querySelectorAll('.cc-days .cc-day')[d];
  if (!row) return;
  const bar = row.querySelector('.bar i');
  if (bar) bar.style.width = `${(per[d] / 1440 * 100).toFixed(1)}%`;
  const v = row.querySelector('.v');
  if (v) v.textContent = per[d] ? ccDurText(per[d]) : '—';
}

/** 拖拽预览：写 DOM（绝不写配置），并把被搬的那一块标成"抓起来了" */
function paintCcDrag() {
  const dg = S.ccDrag;
  if (!dg) return;
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  const { lo, hi } = ccDragRange(dg);
  const wins = ccPreviewWins(dg, lo, hi);

  // 1) 格子与细分刻度
  grid.querySelectorAll(`.cc-cell[data-d="${dg.d}"]`).forEach((c) => {
    const h = +c.dataset.h;
    ccPaintCell(c, dg.d, h, wins[h]);
  });
  // 2) 整块（块上的起止时间也在这里跟着变）
  //    这里必须把 wins 传给渲染器：只改单元格的 .on 不够——
  //    每小时的起止分钟若仍从配置里读，02:15 起的那一块就会被判成
  //    "上一小时 :15 就结束"，在小时边界断成两块。
  ccRenderRuns(document, (d, h) => (d === dg.d ? (wins[h] || null) : undefined));

  const h0 = Math.floor(lo / 60);
  const h1 = Math.floor((hi - 1) / 60);
  // 3) 被搬走的那一块：半透明 + 抬起，一眼看出"它在我手上"
  //    判定用"这一块的时间范围完整盖住了落点区间"，而不是只看小时重叠——
  //    否则同一天里恰好挨着的另一段也会被标上半透明。
  grid.querySelectorAll('.cc-run').forEach((r) => {
    const rFrom = +r.dataset.h0 * 60 + (+r.dataset.f0 || 0);
    const rTo = +r.dataset.h1 * 60 + (+r.dataset.t1 || 60);
    const hit = +r.dataset.d === dg.d && rFrom <= lo && rTo >= hi;
    r.classList.toggle('carry', dg.mode === 'move' && hit);
  });
  // 4) 原位留一条虚线占位：告诉用户它原本在哪，松手前不"凭空消失"
  grid.querySelectorAll('.cc-slot').forEach((el) => el.remove());
  if (dg.mode === 'move') {
    const s0 = Math.floor(dg.segFrom / 60), s1 = Math.floor((dg.segTo - 1) / 60);
    const span = (s1 - s0 + 1) * 60;
    const slot = document.createElement('div');
    slot.className = 'cc-slot';
    slot.style.gridColumn = `${dg.d + 2}`;
    slot.style.gridRow = `${s0 + 2} / ${s1 + 3}`;
    slot.innerHTML = `<i style="top:${(((dg.segFrom - s0 * 60) / span) * 100).toFixed(2)}%;`
      + `height:${(((dg.segTo - dg.segFrom) / span) * 100).toFixed(2)}%"></i>`;
    grid.appendChild(slot);
  }
  // 5) 每日时长 / 合计
  ccLiveTotals(dg.d, wins);

  // 6) 状态条
  const isEn = I18N.getLang() === 'en';
  const verb = dg.mode === 'move' ? (isEn ? 'Move' : '移动')
    : dg.mode === 'sub' ? (isEn ? 'Cancel' : '取消')
      : (isEn ? 'Select' : '选中');
  const dayTxt = I18N.t(WD[dg.d]);
  const durTxt = ccDurText(hi - lo);
  const rg = ccMinText(lo, hi).range;
  const edge = dg.edge < 0 ? (isEn ? ' · clamped at 0:00' : ' · 已到当日 0:00')
    : (dg.edge > 0 ? (isEn ? ' · clamped at 24:00' : ' · 已到当日 24:00') : '');
  const lab = $('#clockLive');
  if (lab) {
    lab.innerHTML = isEn
      ? `${verb} <b>${dayTxt} ${rg}</b> · ${durTxt}${edge}`
      : `${verb} <b>${dayTxt} ${rg}</b> · 共 ${durTxt}${edge}`;
  }
  // 7) 跟随指针的浮层（同一格内的小位移由 ccFlushDrag 单独更新，不重排）
  ccGhostSet(`${verb} ${dayTxt} ${rg} · ${durTxt}`,
    (dg.lastX != null ? dg.lastX : 240) + 16, (dg.lastY != null ? dg.lastY : 0) - 14);
  grid.classList.add('dragging');
}

/** 状态条还原成"当前排班摘要"（会跟着当前语言走） */
function ccResetLive() {
  const lab = $('#clockLive');
  if (!lab) return;
  lab.textContent = clockRangeText();
  I18N.apply(lab);
}

/** 撤回预览：按**配置里的真实值**把这一天重画（单击不改结构时用） */
function ccRestorePreview(d) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  grid.querySelectorAll('.cc-slot').forEach((el) => el.remove());
  const day = clockProfile().days[d] || [];
  grid.querySelectorAll(`.cc-cell[data-d="${d}"]`).forEach((c) => {
    const h = +c.dataset.h;
    const p = day[h];
    ccPaintCell(c, d, h, p && p.on ? { f: p.from || 0, t: p.to == null ? 60 : p.to } : null);
  });
  ccRenderRuns(document);
  ccLiveTotals(d, null);
  ccResetLive();
}

/** 松手落位：优先 FLIP（从"手上那一块"的位置滑到最终位置），
 *  位置本来就重合时退化成一次轻微的 settle —— 两种都不会让视图跳变。 */
function ccLandRun(fromRect, d, h0, h1) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  const run = [...grid.querySelectorAll('.cc-run')].find((r) => +r.dataset.d === d
    && +r.dataset.h1 >= h0 && +r.dataset.h0 <= h1);
  if (!run) return;
  const to = run.getBoundingClientRect();
  const dx = fromRect ? fromRect.left - to.left : 0;
  const dy = fromRect ? fromRect.top - to.top : 0;
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
    run.style.transition = 'none';
    run.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
    void run.offsetWidth;   // 先把起点落下来，下一步才有过渡
    run.style.transition = 'transform .24s cubic-bezier(.22, .61, .36, 1), opacity .18s linear';
    run.style.transform = '';
    setTimeout(() => { run.style.transition = ''; run.style.transform = ''; }, 320);
    return;
  }
  run.classList.add('land');
  setTimeout(() => run.classList.remove('land'), 320);
}

/** 时长文案（语言感知）：中文 "1 小时 45 分"，英文 "1 h 45 min" */
function ccDurText(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  if (I18N.getLang() === 'en') {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h && mm) return `${h} h ${mm} min`;
    if (h) return `${h} h`;
    return `${mm} min`;
  }
  return ccMinText(0, m).dur;
}

/** 分钟区间 → { range: "09:15 – 11:00", dur: "1 小时 45 分" } */
function ccMinText(lo, hi) {
  const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const mins = Math.max(0, hi - lo);
  const hh = Math.floor(mins / 60), mm = mins % 60;
  const dur = hh && mm ? `${hh} 小时 ${mm} 分` : (hh ? `${hh} 小时` : `${mm} 分钟`);
  return { range: `${hm(lo)} – ${hm(hi)}`, dur };
}

/** 按下：锚定一个粒度，并据此决定是"加选"还是"抹掉" */
/** 当天包含 atMin（绝对分钟）的那一段；没有就返回 null */
function ccSegAt(d, atMin) {
  const day = clockProfile().days[d];
  if (!day) return null;
  const segs = ccSegs(day);
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i];
    const from = sg.h0 * 60 + sg.f0;
    const to = sg.h1 * 60 + (sg.t1 >= 60 ? 60 : sg.t1);
    if (atMin >= from && atMin < to) return sg;
  }
  return null;
}

/* ── 跟随指针的浮动提示 ──
 * 真实高亮必须"即时"（拖到哪就亮到哪），但那一刻的跳变会让手感发硬。
 * 所以另起一个只改 transform 的小卡片跟着指针走（CSS 过渡负责平滑），
 * 两者的分工：高亮=结果，ghost=手感。 */
function ccGhostSet(text, x, y) {
  let el = document.getElementById('ccGhost');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ccGhost';
    el.className = 'cc-ghost';
    document.body.appendChild(el);
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    void el.offsetWidth;   // 先落一个初始位置，后续才有"从这滑到那"的过渡
  }
  if (text != null) el.textContent = text;
  el.classList.remove('out');   // 上一次的退场可能还没走完，复用时先复活
  el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

/** 只挪浮层：同一格内移动时不重排整张表，但浮层必须继续跟手 */
function ccGhostMove() {
  const dg = S.ccDrag;
  const el = document.getElementById('ccGhost');
  if (!dg || !el) return;
  const x = (dg.lastX != null ? dg.lastX : 240) + 16;
  const y = (dg.lastY != null ? dg.lastY : 0) - 14;
  el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function ccGhostDrop() {
  const el = document.getElementById('ccGhost');
  if (!el) return;
  el.classList.add('out');
  setTimeout(() => el.remove(), 180);
}

/* ── 拖动重绘的帧调度 ──
 * 一只 120Hz 的鼠标每秒会发 120 次 mousemove，每次都重排整张表太浪费。
 * 这里把"重算 + 重绘"合并到下一帧；同时挂一个 40ms 的兜底定时器 ——
 * 窗口在后台、或某些无头渲染环境里 requestAnimationFrame 不会推进，
 * 只靠 rAF 会让拖动"半路不动"。
 */
let ccPaintRaf = 0;
let ccPaintTimer = 0;

function ccFlushDrag() {
  if (ccPaintRaf) { cancelAnimationFrame(ccPaintRaf); ccPaintRaf = 0; }
  if (ccPaintTimer) { clearTimeout(ccPaintTimer); ccPaintTimer = 0; }
  const dg = S.ccDrag;
  if (!dg || dg.pendingY == null) return;
  const y = dg.pendingY;
  const x = dg.pendingX;
  dg.pendingY = null;
  dg.pendingX = null;
  const { idx, edge } = ccGrainAt(dg.d, y);
  dg.lastY = y;
  if (typeof x === 'number') dg.lastX = x;
  const changed = idx !== dg.cur || edge !== dg.edge;
  dg.cur = idx;
  dg.edge = edge;
  // 落到新的粒度 → 重排；仍在同一格 → 只挪浮层（省掉一次重排）
  if (changed) paintCcDrag();
  else ccGhostMove();
}

function ccScheduleDrag() {
  if (ccPaintRaf || ccPaintTimer) return;
  ccPaintRaf = requestAnimationFrame(ccFlushDrag);
  ccPaintTimer = setTimeout(ccFlushDrag, 40);
}

function ccDragBegin(d, clientY, clientX) {
  const { idx, edge } = ccGrainAt(d, clientY);
  const st = ccStep();
  const atMin = idx * st;

  // 拖动期间：整页进入"抓取"状态，并清掉原生 tooltip（否则悬停提示会跳出来挡路）
  document.body.classList.add('cc-dragging');
  document.querySelectorAll('#ccGrid .cc-cell[title]').forEach((c) => c.removeAttribute('title'));
  // 悬停高亮/可抓光标在拖动期间都不该再出现
  const gr = document.getElementById('ccGrid');
  if (gr) {
    gr.classList.remove('over-seg');
    gr.querySelectorAll('.cc-run.over').forEach((r) => r.classList.remove('over'));
  }

  // 按下的位置落在某一段里 → 拖动 = **整段平移**（段的长度不变，只换位置）；
  // 落在空白 → 拖动 = 新建一段。
  //
  // 以前"落在已选中的格子上"是 sub（抹掉），再加一句"没拖动就算单击 → 取消这一格"，
  // 结果在段中间点一下就把一整段从中间劈开、点中的那块消失。现在点击什么都不改。
  const seg = ccSegAt(d, atMin);

  if (seg) {
    S.ccDrag = {
      d, anchor: idx, cur: idx, edge, mode: 'move', moved: false,
      startY: clientY, lastX: clientX, lastY: clientY,
      segFrom: seg.h0 * 60 + seg.f0,
      segTo: seg.h1 * 60 + (seg.t1 >= 60 ? 60 : seg.t1),
    };
  } else {
    S.ccDrag = {
      d, anchor: idx, cur: idx, edge, mode: 'add', moved: false,
      startY: clientY, lastX: clientX, lastY: clientY,
    };
  }
  paintCcDrag();
}

/** 移动：只记下最新坐标并排一次帧，真正的重算在 ccFlushDrag 里做 */
function ccDragMove(clientY, clientX) {
  const dg = S.ccDrag;
  if (!dg) return;
  dg.pendingY = clientY;
  if (typeof clientX === 'number') dg.pendingX = clientX;
  // "真的动过"按位移算（3px）：同一格内稍微一拖也算拖动，不必跨过整格
  if (!dg.moved && Math.abs(clientY - dg.startY) >= 3) dg.moved = true;
  ccScheduleDrag();
}

/** 松手：没动过 = 单击（不改结构）；动过 = 提交这段区间 */
async function ccDragEnd() {
  const dg = S.ccDrag;
  if (!dg) return;
  // 先把还没落地的那一帧刷掉：提交的区间必须等于用户最后看到的那一块
  ccFlushDrag();
  S.ccDrag = null;

  // 记下"手上那一块"的位置，松手后用它做 FLIP 落位
  const carried = dg.mode === 'move' ? document.querySelector('#ccGrid .cc-run.carry') : null;
  const fromRect = carried ? carried.getBoundingClientRect() : null;
  const scroller = document.querySelector('#ccDetail .cc-scroll');
  const scrollTop = scroller ? scroller.scrollTop : 0;

  document.querySelectorAll('.cc-cell.qshow').forEach((c) => c.classList.remove('qshow'));
  const grid = document.getElementById('ccGrid');
  if (grid) {
    grid.classList.remove('dragging');
    grid.classList.remove('over-seg');
    grid.querySelectorAll('.cc-run.carry').forEach((r) => r.classList.remove('carry'));
    grid.querySelectorAll('.cc-slot').forEach((el) => el.remove());
  }
  document.body.classList.remove('cc-dragging');
  ccGhostDrop();

  const { lo, hi } = ccDragRange(dg);
  const h0 = Math.floor(lo / 60), h1 = Math.floor((hi - 1) / 60);
  // 留给右键菜单的"当前选区""：用粒度坐标表示，和旧版一致
  S.ccRect = {
    d0: dg.d, d1: dg.d, h0, h1,
    qA: Math.floor((lo - h0 * 60) / ccStep()),
    qB: Math.ceil((hi - h1 * 60) / ccStep()) - 1,
  };

  if (!dg.moved) {
    // 单击：**不改任何时段**，只把选区记下来给右键菜单用。
    // （这条是硬规则：点击不得改变时段的数量与结构。）预览也要撤回去。
    ccRestorePreview(dg.d);
    if (scroller) scroller.scrollTop = scrollTop;
    return;
  }

  if (dg.mode === 'move') {
    if (lo === dg.segFrom && hi === dg.segTo) {
      // 原地放下：什么都不用提交，只把预览换成真实渲染
      ccRestorePreview(dg.d);
      render();
      // render 换掉了整个面板，滚动位置要在**换完**之后还原
      const sc0 = document.querySelector('#ccDetail .cc-scroll');
      if (sc0) sc0.scrollTop = scrollTop;
      return;
    }
    await Act.clockMoveSeg(dg.d, dg.segFrom, dg.segTo, lo, hi);
  } else {
    await Act.clockCommitRange(dg.d, lo, hi, dg.mode);
  }
  // 提交后整体重绘会把滚动位置打回顶部，这里还原，免得"一松手视线就跑了"
  const sc2 = document.querySelector('#ccDetail .cc-scroll');
  if (sc2) sc2.scrollTop = scrollTop;
  ccLandRun(fromRect, dg.d, h0, h1);
}

document.addEventListener('mousedown', (e) => {
  const cell = e.target.closest('.cc-cell');
  if (!cell || e.button !== 0) return;
  e.preventDefault();
  cell.classList.add('qshow');
  ccDragBegin(+cell.dataset.d, e.clientY, e.clientX);
});

document.addEventListener('mousemove', (e) => {
  if (S.ccDrag) { e.preventDefault(); ccDragMove(e.clientY, e.clientX); }
});

// 拖动期间禁掉滚轮：图表一滚动，指针与刻度就错位了（拖完自然恢复）
document.addEventListener('wheel', (e) => {
  if (S.ccDrag) e.preventDefault();
}, { passive: false });

// 指针在窗口外松开时收不到 mouseup：失焦即视为松手，避免"卡在抓取状态"
window.addEventListener('blur', () => { if (S.ccDrag) ccDragEnd(); });

// 设置页的语录输入框：回车等于点「添加」
document.addEventListener('keydown', (e) => {
  if (!e.target || e.target.id !== 'setQuoteNew') return;
  if (e.key !== 'Enter') return;
  e.preventDefault();
  Act.setQuoteAdd();
});

/** 悬停到某一段上：整段轻微抬起 + 光标变 grab，预告"按住能整段搬走"。
 *  用 key 缓存，避免在同一个段里每移动一像素就操作一次 DOM。 */
function ccMarkHoverSeg(d, seg) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  const key = seg ? `${d}:${seg.h0}:${seg.h1}` : '';
  // 缓存只是为了省掉重复的 DOM 操作，但类可能被别处（按下、重绘）清掉，
  // 所以"同一个 key 且状态确实还在"才跳过。
  const marked = !!grid.querySelector('.cc-run.over');
  if (S.ccHoverKey === key && marked === !!seg) return;
  S.ccHoverKey = key;
  grid.querySelectorAll('.cc-run.over').forEach((r) => r.classList.remove('over'));
  if (!seg) return;
  const run = [...grid.querySelectorAll('.cc-run')].find((r) => +r.dataset.d === d
    && +r.dataset.h0 === seg.h0 && +r.dataset.h1 === seg.h1);
  if (run) run.classList.add('over');
}

document.addEventListener('mouseover', (e) => {
  const gr = document.getElementById('ccGrid');
  if (S.ccDrag) { if (gr) gr.classList.remove('over-seg'); return; }
  const cell = e.target.closest('.cc-cell');
  if (!cell) {
    if (gr) gr.classList.remove('over-seg');
    ccMarkHoverSeg(0, null);
    return;
  }
  const d = +cell.dataset.d;
  const g = ccGrainAt(d, e.clientY);
  const seg = ccSegAt(d, g.idx * ccStep());
  if (gr) gr.classList.toggle('over-seg', !!seg);
  ccMarkHoverSeg(d, seg);
  ccHoverTip(cell, d, +cell.dataset.h, g.idx % ccQCnt());
});

// 指针离开日历 → 收起"可抓"状态
document.addEventListener('mouseout', (e) => {
  if (S.ccDrag) return;
  const to = e.relatedTarget;
  if (to && to.closest && to.closest('#ccGrid')) return;
  const gr = document.getElementById('ccGrid');
  if (gr && e.target.closest && e.target.closest('#ccGrid')) {
    gr.classList.remove('over-seg');
    ccMarkHoverSeg(0, null);
  }
});

document.addEventListener('mouseup', async () => { await ccDragEnd(); });

/* 触摸：同一套核心，只是把坐标换成 touches[0]。
 * touchstart 里必须 preventDefault，否则浏览器会补发一套 mouse 事件，
 * 一次触摸会被当成两次操作。 */
document.addEventListener('touchstart', (e) => {
  const cell = e.target.closest && e.target.closest('.cc-cell');
  if (!cell || e.touches.length !== 1) return;
  e.preventDefault();
  cell.classList.add('qshow');
  ccDragBegin(+cell.dataset.d, e.touches[0].clientY, e.touches[0].clientX);
}, { passive: false });

document.addEventListener('touchmove', (e) => {
  if (!S.ccDrag) return;
  e.preventDefault();
  // 多指（捏合缩放）不参与拖选，避免和图表缩放手势打架
  if (e.touches.length !== 1) return;
  ccDragMove(e.touches[0].clientY, e.touches[0].clientX);
}, { passive: false });

document.addEventListener('touchend', async (e) => {
  if (!S.ccDrag) return;
  e.preventDefault();
  await ccDragEnd();
}, { passive: false });

document.addEventListener('touchcancel', async () => { await ccDragEnd(); });

/* ---- 自律时段：右键打开「时段设置」模态对话框 ---- */
let ccMenu = null;

function ccCloseMenu() {
  if (window.__ccMenuCtrl) { window.__ccMenuCtrl.abort(); window.__ccMenuCtrl = null; }
  ccMenu = null;
  closeModal();
}

/** 计算某小时当前的窗口文本（含起止分钟） */
function ccHourWinText(d, h, fromMin, toMin) {
  const pf = fromMin > 0 ? `:${pad(fromMin)}` : ':00';
  const endH = (toMin == null ? 60 : toMin) >= 60 ? h + 1 : h;
  const pt = (toMin == null ? 60 : toMin) >= 60 ? ':00' : `:${pad(toMin)}`;
  return `${pad(h)}${pf} – ${pad(endH)}${pt}`;
}

/** 解析连续段（结构化）：把一列里相邻的、连续的小时合并成一段（含起止分钟窗口） */
function ccDaySegs(day) {
  const out = [];
  let i = 0;
  while (i < 24) {
    if (!day[i] || !day[i].on) { i++; continue; }
    let j = i;
    while (j + 1 < 24 && day[j + 1] && day[j + 1].on
      && (day[j].to == null ? 60 : day[j].to) >= 60
      && (day[j + 1].from || 0) <= 0) j++;
    const snap0 = ccSnapWin(day[i].from, day[i].to);
    const snap1 = ccSnapWin(day[j].from, day[j].to);
    const work = day[i].work || CC_DEF_W;
    const brk = day[i].brk || CC_DEF_B;
    // 计算总时长（分钟）
    const totalMin = (j - i) * 60 - snap0.f + snap1.t;
    // 类型：有休息=番茄专注，无休息=纯专注
    const kind = brk > 0 ? '番茄专注' : '纯专注';
    // 备注
    const notes = [];
    if (brk > 0 && work + brk < 60) notes.push('尾段继续专注');
    if (i === 0 && snap0.f === 0) notes.push('从 0 点开始');
    if (j === 23 && snap1.t >= 60) notes.push('到 24 点结束');
    if (j > i) notes.push(`跨 ${j - i + 1} 个小时`);
    out.push({
      h0: i, h1: j, from: snap0.f, to: snap1.t, work, brk,
      totalMin, kind, notes,
    });
    i = j + 1;
  }
  return out;
}

/**
 * 把目标范围展开成**逐个 15 分钟刻度**的垂直列表。
 *
 * 这正是原来主网格里那条"一条横条从左到右划分 4 段"（`.cc-q`）的展开版：
 * 横条只有颜色、看不出任何信息；这里改成从上到下一行一个刻度，
 * 每行给出起止时间、类型（专注 / 休息 / 未选中）、备注，并可直接开关这一段。
 *
 * 类型判定与后端 clock.rs 的节奏一致：以「选中窗口起点」为周期起点，
 * 循环 专注 work 分 → 休息 brk 分；offset % (work+brk) < work 即为专注。
 */
function ccBuildSegments(t) {
  const prof = clockProfile();
  const rows = [];
  for (let d = t.d0; d <= t.d1; d++) {
    const day = prof.days[d] || [];
    for (let h = t.h0; h <= t.h1; h++) {
      const p = day[h];
      if (!p) continue;
      const work = p.work || CC_DEF_W;
      const brk = p.brk || CC_DEF_B;
      const winF = p.on ? (p.from || 0) : 0;
      const winT = p.on ? (p.to == null ? 60 : p.to) : 60;
      const cycle = work + brk;
      let cum = 0;            // 本小时选中窗口内的累计专注分钟
      for (let q = 0; q < ccQCnt(); q++) {
        const a = qStart(q), b = qEnd(q);
        const on = p.on && winF < b && a < winT;
        let type = 'off';
        let note = '未选中';
        let focusMin = 0, breakMin = 0;
        if (on) {
          // 逐分钟判定：专注 work 分 → 休息 brk 分，循环，周期起点 = 选中窗口起点。
          // 15 分钟刻度可能正好横跨边界（50/10 时 45–60 这一段就是），
          // 所以按"这一段里专注/休息各占多少分钟"来定类型，取多的那个。
          const lo = Math.max(a, winF), hi = Math.min(b, winT);
          for (let m = lo; m < hi; m++) {
            const off = m - winF;
            if (brk <= 0 || cycle <= 0) { focusMin++; }
            else {
              const phase = ((off % cycle) + cycle) % cycle;
              if (phase < work) focusMin++; else breakMin++;
            }
          }
          type = breakMin > focusMin ? 'break' : 'focus';
          if (focusMin > 0 && breakMin > 0) {
            note = `专注 ${focusMin} 分 / 休息 ${breakMin} 分`;
          } else if (type === 'break') {
            note = '休息中，不拦截';
          } else {
            note = '连续专注';
          }
        }
        cum += focusMin;
        rows.push({
          d, h, q,
          a, b,
          on,
          type,
          note,
          focusMin, breakMin,
          cumFocus: cum,
          // 该刻度落在窗口里的哪一段（只显示窗口内的部分）
          inFrom: Math.max(a, winF),
          inTo: Math.min(b, winT),
          work, brk,
        });
      }
    }
  }
  return rows;
}

/** 一行刻度的起止时间文案（考虑窗口收窄：只显示落在窗口里的部分） */
function ccSegTimeText(s) {
  const f = s.inFrom > s.a ? s.inFrom : s.a;
  const t = s.inTo < s.b ? s.inTo : s.b;
  const fH = s.h + Math.floor(f / 60);
  const tH = s.h + Math.floor(t / 60);
  return `${pad(fH)}:${pad(f % 60)} – ${pad(tH)}:${pad(t % 60)}`;
}

/** 一行刻度的类型徽章文案 */
function ccSegTypeText(s) {
  if (s.type === 'focus') return '专注';
  if (s.type === 'break') return '休息';
  return '未选中';
}

/** 从上到下、垂直列出各时段（替代原来一条横条 4 段的布局） */
function ccBuildSegRows(t) {
  const rows = [];
  for (let d = t.d0; d <= t.d1; d++) {
    const day = clockProfile().days[d];
    const ranges = ccDaySegs(day);
    ranges.forEach((r) => {
      // 只列出与目标范围有交集的段
      if (r.h1 < t.h0 || r.h0 > t.h1) return;
      rows.push({
        d,
        ...r,
        // 与目标范围的交集小时
        h0e: Math.max(r.h0, t.h0),
        h1e: Math.min(r.h1, t.h1),
      });
    });
  }
  return rows;
}

function ccOpenMenu(d, h, x, y) {
  ccCloseMenu();
  const fc = clockProfile();
  const r = S.ccRect;
  const hasRect = !!r;
  // 默认目标：这一格在上次框选的矩形里 → 整个矩形；否则只作用这一格。
  // 矩形要和这一格的 15 分钟窗口有交集才算"落在选区内"——
  // 只比 (d,h) 会把"框选没盖到的那 15 分钟"也算进去（比如框住 13:00–15:15，
  // 右键点 15:15–15:30 那半格，目标却显示成整片框选）。
  let t = { d0: d, d1: d, h0: h, h1: h };
  if (hasRect && d >= Math.min(r.d0, r.d1) && d <= Math.max(r.d0, r.d1)
    && h >= Math.min(r.h0, r.h1) && h <= Math.max(r.h0, r.h1)) {
    const r0 = Math.min(r.h0, r.h1), r1 = Math.max(r.h0, r.h1);
    const qA2 = (r.h1 >= r.h0) ? r.qA : r.qB, qB2 = (r.h1 >= r.h0) ? r.qB : r.qA;
    const rw = ccRectWindows(Math.min(r.d0, r.d1), Math.max(r.d0, r.d1), r0, r1, qA2 == null ? 0 : qA2, qB2 == null ? ccQCnt() - 1 : qB2);
    const w = rw.get(`${d},${h}`);
    if (w) t = { d0: Math.min(r.d0, r.d1), d1: Math.max(r.d0, r.d1), h0: r0, h1: r1 };
  }
  const p = fc.days[d][h];
  // 输入框预填：只作用这一格且这一格已选中 → 用这一格的值；否则用「通用」时长
  const prefill = (single) => {
    const one = single && p.on;
    return { w: one ? (p.work || CC_DEF_W) : fc.defWork, b: one ? (p.brk || CC_DEF_B) : fc.defBrk };
  };
  // 起止分钟预填：单格看这一格的窗口；多格看首/尾小时的窗口（没选中按整点）。
  // 框选带了锚点刻度时用框选窗口的首/尾（与拖动一致）。
  const prefillWin = () => {
    const single = t.d0 === t.d1 && t.h0 === t.h1;
    if (hasRect && r.qA != null && t.d0 === Math.min(r.d0, r.d1) && t.d1 === Math.max(r.d0, r.d1)
      && t.h0 === Math.min(r.h0, r.h1) && t.h1 === Math.max(r.h0, r.h1)) {
      return { f: qStart(r.qA), t: qEnd(r.qB) };
    }
    if (single) {
      const one = p.on ? p : null;
      return { f: one ? ccSnapWin(one.from, one.to).f : 0, t: one ? ccSnapWin(one.from, one.to).t : 60 };
    }
    const pf = fc.days[t.d0][t.h0], pt = fc.days[t.d1][t.h1];
    return {
      f: pf && pf.on ? ccSnapWin(pf.from, pf.to).f : 0,
      t: pt && pt.on ? ccSnapWin(pt.from, pt.to).t : 60,
    };
  };
  const pre = prefill(t.d0 === t.d1 && t.h0 === t.h1);
  const preW = prefillWin();

  $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal cc-modal">
        <div class="modal-hd">
          <h3>时段设置</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          <div class="cc-menu-tgt">作用于 <b id="ccTgt">${esc(ccRectText(t.d0, t.d1, t.h0, t.h1, preW.f, preW.t))}</b>（共 <b id="ccCnt">${(t.d1 - t.d0 + 1) * (t.h1 - t.h0 + 1)}</b> 段）</div>
          <div class="cc-menu-scope">
            <button class="chip-btn${hasRect ? ' active' : ''}" data-scope="rect"${hasRect ? '' : ' disabled title="先拖动框选一片区域"'}>当前框选</button>
            <button class="chip-btn${hasRect ? '' : ' active'}" data-scope="cell">这一格</button>
            <button class="chip-btn" data-scope="col">这一列（一整天）</button>
          </div>

          <div class="cc-tl-list" id="ccTlList">
            <div class="cc-tl-hd">
              <span class="cc-tl-c-idx">#</span>
              <span class="cc-tl-c-day">星期</span>
              <span class="cc-tl-c-time">起止时间</span>
              <span class="cc-tl-c-type">类型</span>
              <span class="cc-tl-c-note">备注</span>
              <span class="cc-tl-c-act">状态</span>
            </div>
            <div id="ccTlRows"></div>
          </div>

          <div class="cc-menu-row">
            <label>专注 <input type="number" id="ccW" min="1" max="60" step="1" value="${pre.w}"> 分</label>
            <label>休息 <input type="number" id="ccB" min="0" max="60" step="1" value="${pre.b}"> 分</label>
          </div>
          <div class="cc-menu-scope">
            ${[[25, 5], [45, 15], [50, 10], [60, 0]].map(([w, b]) =>
    `<button class="chip-btn" data-wb="${w},${b}">${b ? `${w} / ${b}` : '不休息'}</button>`).join('')}
          </div>
          <div class="cc-menu-row win">
            <label>起止分钟 从 <input type="number" id="ccFrom" min="0" max="59" step="1" value="${preW.f}"> 到</label>
            <label><input type="number" id="ccTo" min="1" max="60" step="1" value="${preW.t}"> 分</label>
          </div>
          <div class="cc-menu-hint">起止分钟只改目标范围的<b>首 / 尾小时</b>：起始分钟改第一个小时从第几分钟开始，结束分钟改最后一个小时到第几分钟结束（填 0 和 60 = 整点）。比整小时更细的边界就这样设，比如 8:15–11:45。</div>
          <label class="cc-menu-def"><input type="checkbox" id="ccDefToo" checked> 同时设为通用时长（之后新选的时段沿用）</label>
          <div class="cc-menu-hint">应用后会顺便开启这些时段；休息期间不拦截、不遮罩。排不满 60 分钟的尾段算继续专注。</div>
        </div>
        <div class="modal-ft">
          <button class="btn" data-act="cc-close">取消</button>
          <button class="btn btn-primary" id="ccApply">应用</button>
        </div>
      </div>
    </div>`;
  ccMenu = $('#modalRoot');
  $('#ccW') && $('#ccW').focus();

  // ---- 垂直刻度列表：渲染 + 就地刷新 ----
  // 列表是"从上到下、每行一个 15 分钟刻度"，替代主网格里那条
  // "一条横条从左到右划分 4 段"（.cc-q）：横条只有颜色看不出信息，
  // 这里每行都给起止时间、类型、备注，并可直接开关这一段。
  const renderTlRows = () => {
    const box = $('#ccTlRows');
    if (!box) return;
    const segs = ccBuildSegments(t);
    if (!segs.length) {
      box.innerHTML = '<div class="cc-tl-empty">这个范围里没有可设置的刻度</div>';
      return;
    }
    box.innerHTML = segs.map((s, i) => `
      <div class="cc-tl-row ${s.on ? 'on' : 'off'} type-${s.type}">
        <span class="cc-tl-idx">${i + 1}</span>
        <span class="cc-tl-day">${WD[s.d]}</span>
        <span class="cc-tl-time">${ccSegTimeText(s)}</span>
        <span class="cc-tl-type">${ccSegTypeText(s)}</span>
        <span class="cc-tl-note">${s.note}${s.on && s.type === 'focus' ? ` · 累计专注 ${s.cumFocus} 分` : ''}</span>
        <span class="cc-tl-act">
          <button class="cc-tl-btn ${s.on ? 'on' : ''}" data-tl="${s.d},${s.h},${s.q}"
            title="${s.on ? '点一下取消这 15 分钟' : '点一下选中这 15 分钟'}">${s.on ? '已选中' : '未选中'}</button>
        </span>
      </div>`).join('');
  };
  renderTlRows();
  window.__ccRenderTlRows = renderTlRows;

  const tgt = $('#ccTgt');
  const cnt = $('#ccCnt');
  const updTgt = (scope) => {
    if (scope === 'cell') t = { d0: d, d1: d, h0: h, h1: h };
    else if (scope === 'col') t = { d0: d, d1: d, h0: 0, h1: 23 };
    else if (hasRect) t = { d0: Math.min(r.d0, r.d1), d1: Math.max(r.d0, r.d1), h0: Math.min(r.h0, r.h1), h1: Math.max(r.h0, r.h1) };
    else return;
    const qw = prefillWin();
    tgt.textContent = ccRectText(t.d0, t.d1, t.h0, t.h1, qw.f, qw.t);
    cnt.textContent = (t.d1 - t.d0 + 1) * (t.h1 - t.h0 + 1);
    // 目标范围变了，输入框也跟着换：单格看这一格的值，多格看通用时长
    const q = prefill(t.d0 === t.d1 && t.h0 === t.h1);
    $('#ccW').value = q.w;
    $('#ccB').value = q.b;
    $('#ccFrom').value = qw.f;
    $('#ccTo').value = qw.t;
    // 目标范围变了，垂直刻度列表也要跟着换
    if (typeof renderTlRows === 'function') renderTlRows();
  };

  // 模态内部交互：scope / wb / apply / 关闭 全在这里处理。
  // 用 AbortController 一次性委托，避免每次 ccOpenMenu 都 addEventListener 累积
  // （#modalRoot 是常驻 DOM 节点，innerHTML 替换不会清掉挂在它身上的监听器）。
  // 旧的 controller 在下次 ccOpenMenu / ccCloseMenu 时被 abort 掉。
  if (window.__ccMenuCtrl) window.__ccMenuCtrl.abort();
  window.__ccMenuCtrl = new AbortController();
  $('#modalRoot').addEventListener('click', async (e) => {
    // 垂直刻度列表里的单段开关：直接切换那 15 分钟
    const tl = e.target.closest('[data-tl]');
    if (tl) {
      const [dd, hh, qq] = tl.dataset.tl.split(',').map(Number);
      await Act.clockToggleQ(dd, hh, qq);
      if (typeof window.__ccRenderTlRows === 'function') window.__ccRenderTlRows();
      return;
    }
    const sc = e.target.closest('[data-scope]');
    if (sc && !sc.disabled) {
      $('#modalRoot').querySelectorAll('[data-scope]').forEach((b) => b.classList.toggle('active', b === sc));
      updTgt(sc.dataset.scope);
      return;
    }
    const wb = e.target.closest('[data-wb]');
    if (wb) {
      const [w2, b2] = wb.dataset.wb.split(',').map(Number);
      $('#ccW').value = w2;
      $('#ccB').value = b2;
      return;
    }
    if (e.target.closest('#ccApply')) {
      let w2 = Math.round(Number($('#ccW').value) || 0);
      let b2 = Math.round(Number($('#ccB').value) || 0);
      w2 = Math.max(1, Math.min(60, w2));
      b2 = Math.max(0, Math.min(60, b2));
      if (b2 > 0 && w2 + b2 > 60) b2 = 60 - w2;
      let f2 = Math.round(Number($('#ccFrom').value) || 0);
      let t2 = Math.round(Number($('#ccTo').value) || 0);
      // 对齐 15 分钟刻度（边界向下/向上取整，零碎时间才对得齐）
      const snap = ccSnapWin(f2, t2);
      f2 = snap.f; t2 = snap.t;
      // 单格时起止分钟在同一小时里，必须起早于止；多格时分别作用于首/尾小时
      if (t.d0 === t.d1 && t.h0 === t.h1 && f2 >= t2) {
        toast('起始分钟要小于结束分钟', 'err');
        return;
      }
      const ok = await Act.clockSetWB(t.d0, t.d1, t.h0, t.h1, w2, b2, $('#ccDefToo').checked, f2, t2);
      if (ok === false) {
        // 兜底：直连 Act 的非法起止（菜单里的校验被绕过时）也不改配置、不关菜单
        toast('起始分钟要小于结束分钟', 'err');
        return;
      }
      ccCloseMenu();
      return;
    }
    if (e.target.closest('[data-act="cc-close"]')) ccCloseMenu();
  }, { signal: window.__ccMenuCtrl.signal });
}

/* 全局屏蔽 WebView 自带的右键菜单。
 *
 * 那是浏览器内核的页面菜单（返回 / 刷新 / 另存为 / 打印 / 更多工具），
 * 在一个桌面应用里既没用又难看，还会盖住我们自己画的右键菜单。
 * 用 capture 阶段先拦一刀：只在"原生菜单要不要弹"这一层生效，
 * 下面监听 contextmenu 的业务逻辑（时段格子）照常收到事件。
 */
document.addEventListener('contextmenu', (e) => { e.preventDefault(); }, { capture: true });

document.addEventListener('contextmenu', (e) => {
  const cell = e.target.closest('.cc-cell');
  if (!cell) { ccCloseMenu(); return; }
  e.preventDefault();
  ccOpenMenu(+cell.dataset.d, +cell.dataset.h, e.clientX, e.clientY);
});

// 点模态外面 = 关菜单（模态自带 data-act="close-modal-bg"，这里兜底）
document.addEventListener('mousedown', (e) => {
  if (ccMenu && !e.target.closest('.cc-modal') && !e.target.closest('.cc-menu')) ccCloseMenu();
});

/* 输入框回车 */
document.addEventListener('keydown', (e) => {
  // Alt+F4 强制退出（前端兜底）
  //
  // 后端已经用低级键盘钩子 + CloseRequested 双重判定实现了 Alt+F4 强制退出，
  // 但 WebView2 在某些情况下会把 Alt+F4 当成浏览器快捷键派发到页面。
  // 这里再兜一层：识别到 Alt+F4 就 preventDefault（别让 WebView 自己也处理）
  // 并直接调后端的 force_quit —— 保证在设置页 / 自律时段弹窗里按下也一定退得掉。
  if (e.altKey && (e.key === 'F4' || e.code === 'F4')) {
    e.preventDefault();
    invoke('force_quit').catch(() => {});
    return;
  }
  if (e.key === 'Escape') {
    if (typeof ccCloseMenu === 'function') ccCloseMenu();
    if ($('#modalRoot').innerHTML) { S.editing = null; closeModal(); }
  }
  if (e.key === 'Enter') {
    if (e.target.id === 'siteInput') { e.preventDefault(); Act.addSite(); }
    if (e.target.id === 'excInput') { e.preventDefault(); Act.addExc(); }
    if (e.target.id === 'ruleName') { e.preventDefault(); Act.saveEditor(); }
    if (e.target.id === 'ccNameInput') {
      e.preventDefault();
      const btn = document.querySelector('[data-act="cc-name-ok"]');
      if (btn) btn.click();
    }
  }
});

/* 遮罩滑块：实时预览 */
document.addEventListener('input', async (e) => {
  if (e.target.id === 'opRange') await Act.setOpacity(e.target.value);
  // HUD 透明度：拖动时只更新读数，松手（change）才写盘，避免每 1px 存一次配置
  if (e.target.id === 'hudOpacity') {
    const lab = $('#hudOpacityVal');
    if (lab) lab.textContent = `${e.target.value}%`;
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'hudOpacity') Act.hudOpacity(e.target.value);
});

/* 时段明细起止时间修改 */
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act="tk-slot-start"],[data-act="tk-slot-end"]');
  if (!el || !S.editing) return;
  const day = +el.dataset.day, i = +el.dataset.i;
  const slots = S.editing.schedule[day] || [];
  if (!slots[i]) return;
  const v = tkTimeParse(el.value);
  if (v == null) { toast('时间格式应为 HH:MM', 'err'); renderEditor(); return; }
  if (el.dataset.act === 'tk-slot-start') slots[i].start = v;
  else slots[i].end = v;
  S.editing.schedule[day] = normalize(slots);
  renderEditor();
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
  I.setLang(langPref());
  applyMotionPref();
  render();
  applyLang();
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

