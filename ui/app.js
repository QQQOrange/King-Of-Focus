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
  // 时间日历：默认周视图；calSel 是"选中的那一天"，切视图时保持不变
  calMode: 'week',
  calAnchor: '',
  calSel: '',
  cal: null,
  calKey: '',
  calPending: false,   // 周/月网格正在取数（当日日历据此等待，不重复请求同一天）
  // 「聚焦分类」：饼图描边、当日日历高亮、周/月网格描边三处共用同一个 key（'' = 不聚焦）
  calHit: '',
  // 当日日历：显示哪一天。默认跟着选中日/今天走
  dayDate: '',
  dayCache: new Map(),   // `${tab}|${date}` → 单日数据（日历窗口里已有那天时直接复用）
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

/** 只改那三个「跟随系统 / 浅色 / 深色」按钮的选中态。
 *
 *  切主题以前靠整页 `render()` 顺手刷新按钮，那是整页重建（上千个节点），
 *  代价远大于"把三个 class 换一下"，还会把滚动位置和输入焦点弄丢。 */
function paintThemeChoice() {
  const pref = (S.data && S.data.config && S.data.config.settings.theme) || 'system';
  document.querySelectorAll('[data-act="theme"]').forEach((b) => {
    const on = b.dataset.v === pref;
    b.classList.toggle('active', on);
    b.classList.toggle('gold', on);
  });
}
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
  const root = document.documentElement;
  if (root.dataset.theme !== t) {
    // 换主题那一瞬间，页面上几百个节点会同时给 background/color 插值，
    // WebView2 在大范围 transition 下会掉帧（看起来就是"卡一下"）。
    // 用一个只活两帧的类把过渡关掉：颜色立刻到位，之后交互的过渡照旧。
    root.classList.add('theme-swapping');
    root.dataset.theme = t;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      root.classList.remove('theme-swapping');
    }));
    // 主题切换后重绘饼图（canvas 颜色是算出来的）
    if (S.view === 'stats') {
      const cur = currentSlices();
      drawPie($('#pie'), cur.slices, cur.total, { sub: '累计前台时长', focusKey: S.calHit });
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
    syncSleepLock();
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
 * 三个概念必须分清，否则界面一定会说胡话：
 *   · 来源（feed）   用户可选的一组「从哪取句子」：内置精选 / 一言 / 自定义
 *   · 当前这条（cur）这一次真正显示在屏幕上的句子，带它自己的来源与出处
 *   · 本地池（pool） 自己写的 + 内置 121 条，**断网时唯一还能用的东西**
 *
 * 状态机很短：
 *   点「换一条」 → 当前来源是本地？ → 直接在池里换（不联网）
 *                → 是联网源？       → invoke quote_fetch
 *                     ├ ok      → 换上，标签写来源名，可点开网址
 *                     └ 失败     → 从本地池挑一条，标签写「内置精选 · 离线」
 * 失败不弹窗、不卡住：用户点一次就必须看到一句话变了，这是这个区域唯一的硬要求。
 */

/** 全部来源（配置里的；被手改坏了就退回内置三个） */
function quoteFeeds() {
  const st = (S.data && S.data.config && S.data.config.settings) || {};
  const list = (st.quoteFeeds || []).filter((f) => f && f.id && f.name);
  if (list.length) return list;
  return [{ id: 'local', name: '内置精选', kind: 'local', url: '', home: '', builtin: true }];
}

/** 当前选中的来源；配置里那个 id 不存在时退回第一个（和 Rust 侧 sanitize 口径一致） */
function quoteActiveFeed() {
  const list = quoteFeeds();
  const id = (((S.data && S.data.config && S.data.config.settings) || {}).quoteFeed || '').trim();
  return list.find((f) => f.id === id) || list[0];
}

/** 本地池：自己写的排前面（用户写的话本来就该先看到），后面接内置 121 条 */
function quoteLocalPool() {
  const st = (S.data && S.data.config && S.data.config.settings) || {};
  const own = (st.customQuotes || []).filter(Boolean)
    .map((t) => ({ text: t, from: '', src: 'custom' }));
  const base = (window.KOF_QUOTES || []).map((t) => ({ text: t, from: '', src: 'local' }));
  return own.concat(base);
}

/** 当前要显示的那一条。
 *
 *  `S.quoteCur` 只对"当前来源"有效：用户切了来源，这条就作废，
 *  不然会出现"标签写着内置精选、句子其实是一言取回来的"。
 */
function quoteView() {
  const feed = quoteActiveFeed();
  const meta = (o) => Object.assign({
    feed: feed.id, feedName: feed.name, home: feed.home || '', offline: false,
  }, o);
  if (S.quoteCur && S.quoteCur.feed === feed.id) return S.quoteCur;

  if (feed.kind === 'local') {
    const pool = quoteLocalPool();
    if (pool.length) {
      const q = pool[(S.quoteLocalIdx || 0) % pool.length];
      return meta({ text: q.text, from: q.from, src: q.src });
    }
  }
  // 联网源：第一屏先用后端缓存的那条（它可能就是上次从同一个源取到的）
  const rt = (S.data && S.data.runtime) || {};
  if (rt.quote) return meta({ text: rt.quote, from: rt.quoteFrom || '', src: rt.quoteFrom ? 'net' : 'local' });
  const pool = quoteLocalPool();
  const q = pool[0] || { text: '把想对自己说的话写下来，每次打开 Hub 都能看到。', from: '' };
  return meta({ text: q.text, from: q.from, src: q.src, offline: true });
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
  // 睡眠时段也吃积分（按段买断），卡片上要把两套价格摆在一起，用户才知道钱花在哪
  const sl = (d.config && d.config.settings && d.config.settings.sleep) || {};
  const sleepPts = sl.enabled && +sl.unlockPrice > 0 ? +sl.unlockPrice * (+sl.unlockMin || 30) : 0;

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
    : '<div class="empty"><span class="ico">◷</span>还没有拦截记录。等你设置的时段到了，这里会出现被拦下的应用和网页。</div>';

  const maskOn = d.mask.on;

  const q = quoteView();
  const qN = ((d.config.settings || {}).customQuotes || []).length;
  const feed = quoteActiveFeed();
  const srcTip = q.home
    ? `点击打开 ${q.home}`
    : '内置句子，没有网址';
  return `
  ${lockBanner}${unlockBanner}
  <section class="hub-quote${S.quoteBusy ? ' busy' : ''}" aria-label="激励语录" data-quote-box="1">
    <div class="qmark">“</div>
    <div class="qbody">
      <div class="qtext">${esc(q.text)}</div>
      <div class="qmeta">
        <span class="qsrc ${q.src}${q.home ? ' link' : ' plain'}" data-act="quote-open-src"
          title="${esc(srcTip)}">${esc(q.feedName)}</span>
        ${q.from ? `<span class="qfrom">—— ${esc(q.from)}</span>` : ''}
        ${q.offline ? '<span class="qoff" title="联网没取到，这一条来自本地预置">离线 · 本地精选</span>' : ''}
        <span class="qhint">右键可换来源</span>
      </div>
    </div>
    <div class="qops">
      <button class="btn btn-sm" data-act="quote-next" ${S.quoteBusy ? 'disabled' : ''}
        title="${feed.kind === 'local' ? '在本地预置里换一条（不联网）' : `立刻从 ${esc(feed.name)} 取一条`}">${S.quoteBusy ? '正在获取…' : '换一条'}</button>
      <button class="btn btn-sm" data-act="quote-src-menu" title="切换 / 添加语录来源">来源 · ${esc(feed.name)}</button>
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
    <div class="card-sub">专注 1 分钟 = 1 分。</div>
    <div class="card-sub">积分只用来解开正在生效的那一段时间：自律时段按分钟买，睡眠时段按整段买断。</div>
    <div class="card-sub">都只影响当下这一轮，不会改排班，也不会连带别的时段。</div>
    <div class="grid-2" style="margin:12px 0 4px">
      <div class="mini">
        <div class="l">自律时段</div>
        <div class="v" style="color:var(--gold)">${pts.price}<span style="font-size:12px;font-weight:400"> 分/分钟</span></div>
        <div class="l" style="margin-top:6px">今天第 n 次 ×1.4（第 1 次 ${pts.price}，第 2 次 ${Math.round(pts.price * 1.4)}，第 3 次 ${Math.round(pts.price * 1.96)}）</div>
      </div>
      <div class="mini">
        <div class="l">睡眠时段</div>
        <div class="v" style="color:${sleepPts ? 'var(--gold)' : 'var(--text-2)'}">${sleepPts ? `${sleepPts}<span style="font-size:12px;font-weight:400"> 分</span>` : '未开启'}</div>
        <div class="l" style="margin-top:6px">${sleepPts ? `一次买断 ${sl.unlockMin} 分钟（单价 ${sl.unlockPrice} 分/分钟）` : '在「自律时段 → 睡眠管理」里开启'}</div>
      </div>
    </div>
    <div class="row" style="align-items:center">
      <button class="btn btn-primary" data-act="open-unlock">用积分解锁</button>
      <span class="hint">${on || rt.breakOn ? '解锁期间所有拦截暂停，倒计时结束自动恢复' : (sl.enabled ? '现在不在自律 / 睡眠时段里，暂时不需要解锁' : '现在没有生效的自律规则，暂时不需要解锁')}</span>
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
          ${l.autolaunch && l.autolaunch.enabled && (l.autolaunch.items || []).length
    ? ` · <b style="color:var(--cc-fill)">自动打开 ${l.autolaunch.items.length} 项</b>` : ''}
        </div>
      </div>
      <div class="sl-item-act">
        <div class="switch${locked ? ' locked' : ''}" data-act="toggle-rule" data-id="${l.id}"
             style="${locked ? 'pointer-events:none;opacity:.32' : ''}"
             title="${locked ? (hardLocked ? '自律固化中，开关已锁定' : '自律时段生效中，开关已锁定') : '启用 / 停用'}">
          <input type="checkbox" ${l.enabled ? 'checked' : ''}><i></i>
        </div>
        <button class="btn btn-sm" data-act="rule-launch" data-id="${l.id}"
          title="进入自律时间时自动打开这些软件 / 网页">自动打开</button>
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
    : '<div class="empty"><span class="ico">⚑</span>还没有自律规则。点右上角「新建自律规则」开始。</div>';

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

/* ───────── 图表显示范围 ─────────
 *
 * 完整图表默认铺满 0:00–24:00（设置项里写作 0:00–23:59）。但多数人真正关心的
 * 只是"早上七点到晚上十一点"这一截：24 行铺下来要滚半天，还可能看不全。
 * 于是把范围做成一个纯**显示**参数：
 *
 *   · 只影响画多少行、刻度从几点开始、拖动的坐标怎么换算
 *   · 判定与存储完全不看它 —— 范围外的时段照样生效，只是不出现在图上
 *   · 整点对齐（拖选最小粒度是 10 分钟，行边界再切碎的话，一行就不是一小时了）
 */
function ccView() {
  const fc = S.data && S.data.config && S.data.config.settings.focusClock;
  const rawF = fc ? +fc.viewFrom || 0 : 0;
  const rawT = fc ? (fc.viewTo == null ? 1440 : +fc.viewTo) : 1440;
  const from = Math.max(0, Math.min(23 * 60, Math.floor(rawF / 60) * 60));
  const to = Math.max(from + 60, Math.min(1440, Math.floor(rawT / 60) * 60));
  return { from, to, hours: (to - from) / 60 };
}

/** 某个小时在网格里的行号（第 1 行是星期表头） */
function ccRow(h) {
  return h - ccView().from / 60 + 2;
}

/** 显示范围的文案：06:00 – 22:00（终点 24:00 写成 24:00，和刻度一致） */
function ccViewText(v) {
  const w = v || ccView();
  return `${pad(w.from / 60)}:00 – ${pad(w.to / 60)}:00`;
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
/** 睡眠管理的配置（缺失时补一份默认，老配置升级上来也安全） */
function clockCfgSleep() {
  const s = S.data && S.data.config && S.data.config.settings;
  if (!s) return { enabled: false, from: 23 * 60, to: 7 * 60, countdownMin: 10, shutdown: true, lockScreen: true, unlockMin: 30, unlockPrice: 10 };
  if (!s.sleep) {
    s.sleep = { enabled: false, from: 23 * 60, to: 7 * 60, countdownMin: 10, shutdown: true, lockScreen: true, unlockMin: 30, unlockPrice: 10 };
  }
  return s.sleep;
}

/** 休息结束收尾的配置。缺字段按默认补齐，和 Rust 侧 `SweepCfg::default()` 一致：
 *  开 / 柔和 / 暂停媒体。
 *
 *  为什么在前端也要兜一层：老配置（v0.1.22 之前）根本没有 `sweep` 这个键，
 *  界面要先能画出"默认值"的样子；后端读配置时同样有 serde default，
 *  两边各自兜住，谁先跑都不会显示错。 */
function sweepCfg() {
  const s = S.data && S.data.config && S.data.config.settings;
  if (!s) return { enabled: true, mode: 'soft', pauseMedia: true };
  if (!s.sweep || typeof s.sweep !== 'object') s.sweep = {};
  const sw = s.sweep;
  if (typeof sw.enabled !== 'boolean') sw.enabled = true;
  if (sw.mode !== 'hard' && sw.mode !== 'soft') sw.mode = 'soft';
  if (typeof sw.pauseMedia !== 'boolean') sw.pauseMedia = true;
  return sw;
}

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
 * `override(d,h)` 传入时，用它的返回值代替配置里的值（拖选预览用）。
 * `only` 传入时只重画这几天的块：跨天拖动落位 / 取消后需要把"指针掠过、
 * 但已经不是落点"的那几天收拾干净，而重建**全部**的块会把手上那一块也换掉，
 * 落位动画（FLIP）就没有起点可用了。
 *
 * 注意这里**没有**"选中色"参数：块画出来永远是"已放置"色（--cc-set）。
 * "正在被操作"这件事由 ccPaintSel 事后按区间逐块打 `.sel` 决定，
 * 因为它需要知道"哪一段在动"，而渲染器只知道"有哪些段"。
 *
 * 这样也顺手修掉了一个老问题：以前拖某一天时，整张表重画都会带上选中色，
 * 隔壁几天没被碰过的块也跟着变色，看起来像"它们也要变"。 */
function ccRenderRuns(root, override, only) {
  const host = root || document;
  const grid = host.querySelector('#ccGrid') || document.getElementById('ccGrid');
  if (!grid) return;
  const allow = only ? new Set(only) : null;
  // **复用池**：按 data-key 收好现有块，能复用就复用，只有真不该存在的才删。
  //
  // 这里以前是"先把所有块 remove 掉再重建"，每帧一次。而 `.cc-run.carry`
  // 带一段 0.13s 的落格动画（ccCarry：opacity .55 → .72、scale 1.015 → 1），
  // 于是被拖的那一块**每帧都从头重播一遍**——拖动时 mousemove 远快于 130ms，
  // 动画永远播不完，看起来就是持续闪烁。其它段虽然没动画，也跟着每帧重建重排。
  // 复用之后，同一段在整个拖动过程中始终是同一个 DOM 节点，只改 grid-row 和文字，
  // 动画不会重播，闪烁从根上消失。
  const pool = new Map();
  grid.querySelectorAll('.cc-drag').forEach((el) => el.remove());
  grid.querySelectorAll('.cc-run').forEach((el) => {
    const d = el.dataset.d == null ? null : +el.dataset.d;
    // 只重画某几天时，范围外的块原样留着，不参与本帧
    if (allow && d != null && !allow.has(d)) return;
    const k = el.dataset.key;
    if (!k) {
      el.remove();
      return;
    }
    pool.set(k, el);
  });
  const fc = clockProfile();
  // `override(d,h)` 让拖拽预览可以临时替换某天的窗口，而不去改配置：
  //   返回 undefined = 用配置；`null` / `[]` = 这一小时不选中；
  //   `{f,t}` 或 `[{f,t}, …]` = 用这些窗口。
  // **必须支持"一小时多个窗口"**：同一小时可以放两段（09:00–09:30 + 09:30–10:00），
  // 预览当初只认得一个窗口，于是拖别处的时段时，同一小时里的另一段就被整段丢掉，
  // 界面上看起来"已有时段凭空消失"（数据其实还在）。
  const ovList = (d, h) => {
    if (!override) return undefined;
    const ov = override(d, h);
    if (ov === undefined) return undefined;
    return ccWinList(ov).map((w) => ({ from: w.f, to: w.t, seg: w.seg || '__drag' }));
  };
  const hourAt = (d, h) => {
    const base = (fc.days[d] && fc.days[d][h]) || { on: false, work: 0, brk: 0, from: 0, to: 60 };
    const list = ovList(d, h);
    if (list === undefined) return base;
    if (!list.length) return { ...base, on: false };
    return {
      ...base,
      on: true,
      from: Math.min(...list.map((w) => w.from)),
      to: Math.max(...list.map((w) => w.to)),
    };
  };
  const clampW = (v) => Math.max(0, Math.min(60, Math.round(v || 0)));
  // 真实行高（px）：格子渲染出来了就以它为准，否则退回按粒度估算的常量
  const hourPx = (() => {
    const g = ccDayGeom(0);
    return g && g.hourH > 0 ? g.hourH : ccHourH();
  })();

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
  // 这一小时里要画的窗口（预览优先；一小时可能有多个）
  const winsAt = (d, h) => {
    const base = (fc.days[d] && fc.days[d][h]) || {};
    const list = ovList(d, h);
    if (list === undefined) return hourWins(base);
    return list;
  };

  const segs = [];
  const pushSeg = (d, sg) => {
    const mins = [];
    for (let i = sg.h0; i <= sg.h1; i++) {
      const p = hourAt(d, i);
      const w = p.on ? clampW(p.work) : clampW(fc.defWork);
      const b = p.on ? Math.max(0, Math.min(60 - w, clampW(p.brk))) : Math.min(clampW(fc.defBrk), 60 - w);
      mins.push(`${w}/${b}`);
    }
    segs.push({
      d,
      h0: sg.h0,
      h1: sg.h1,
      seg: sg.seg || '',
      sig: mins.join(','),
      f0: Math.max(0, Math.min(59, Math.round(sg.f0 || 0))),
      t1: Math.max(1, Math.min(60, Math.round(sg.t1))),
    });
  };
  cols.forEach((hs, d) => {
    if (allow && !allow.has(d)) return;
    // 收集这一列所有窗口，按（小时, 起点）排好；同段且首尾相接才接成一条
    const wins = [];
    for (let h = 0; h < 24; h++) {
      if (!hs.has(h)) continue;
      for (const w of winsAt(d, h)) wins.push({ h, from: w.from, to: w.to, seg: w.seg });
    }
    let cur = null;
    for (const w of wins) {
      const absFrom = w.h * 60 + w.from;
      if (cur && ccSameSegId(cur.seg, w.seg) && cur.endAbs === absFrom) {
        cur.h1 = w.h;
        cur.t1 = w.to;
        cur.endAbs = w.h * 60 + w.to;
        continue;
      }
      if (cur) pushSeg(d, cur);
      cur = {
        h0: w.h, h1: w.h, f0: w.from, t1: w.to, seg: w.seg, endAbs: w.h * 60 + w.to,
      };
    }
    if (cur) pushSeg(d, cur);
  });


  // 2) 每个「当天的一段连续小时」就是一块，**不再把相邻日期合并**。
  //
  //    以前会把"周一–周五 8–12、起止分钟和配方都一样"的那几天合成一块横跨五列的
  //    大色块。问题是：一旦和隔壁那天接上，圆角就只剩下最外沿那两个，中间全是
  //    直角——看起来像两块被硬粘在一起，也分不清哪块是周几。
  //    现在一天一块、各自四角圆润，日历的列感也回来了。

  const addBlock = (d0, h0, h1, f0, t1, seg) => {
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
      // 首 / 尾那条带要额外标出来：边缘缩放的小手柄挂在它们上面
      // （非整点的段，上边界在 :15 而不是格子顶，不能挂在容器上）
      b.first = i === 0;
      b.last = i === solid.length - 1;
    });
    const bands = parts.map((b) => (b.gap
      ? `<i class="cc-gap" style="flex:0 0 ${b.pct.toFixed(3)}%"></i>`
      : `<i class="f${b.first ? ' first' : ''}${b.last ? ' last' : ''}"`
        + ` style="flex:0 0 ${b.pct.toFixed(3)}%;border-radius:${b.radius}"></i>`)).join('');
    // 同一段在拖动过程中位置会变，但 seg 不变 —— 用它当 key 就能一直复用同一个节点。
    // 老配置没有 seg 时退化成"位置 key"，那种数据移动时会重建一次（只发生在
    // 从未保存过的旧数据上；保存过一次就会写入 seg）。
    const key = seg ? `s:${seg}@${d0}` : `p:${d0}:${h0}-${h1}:${f0}-${t1}`;
    let run = pool.get(key);
    if (run) {
      pool.delete(key);          // 标记"这一帧用到了"，别在收尾时被清掉
    } else {
      run = document.createElement('div');
      run.className = 'cc-run';
      // 只有"真的新出现一块"才播入场；拖动过程中的块是移动，不是新生。
      // `S.ccDrag` 存在 = 正在拖，这时候加入场动画等于每帧闪一次（就是原来那个 bug）。
      if (!S.ccDrag) {
        run.classList.add('cc-in');
        run.addEventListener('animationend', () => run.classList.remove('cc-in'), { once: true });
      }
    }
    run.dataset.key = key;
    run.dataset.seg = seg || '';
    run.dataset.d = String(d0);
    run.dataset.d1 = String(d0);
    run.dataset.h0 = String(h0);
    run.dataset.h1 = String(h1);
    run.dataset.f0 = String(f0);
    run.dataset.t1 = String(t1);
    // 第 1 行是星期表头、第 1 列是小时刻度 → 数据行/列都从 2 开始；
    // 行号再减去「显示范围」的起始小时（默认 0，等于没变）
    run.style.gridColumn = `${d0 + 2}`;
    run.style.gridRow = `${ccRow(h0)} / ${ccRow(h1) + 1}`;
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
    const spanMin = Math.max(0, Math.round(n * 60 - f0 - (60 - t1)));
    // 行高必须**量**，不能用常量：完整展示模式下每行是 1fr 算出来的（可能只有 20px），
    // 用常量 52 会把矮块判断成"够高"，两行字直接溢出块外。
    const spanPx = (spanMin / 60) * hourPx;
    const labTop = (f0 * unit).toFixed(3);
    const tight = spanPx < 20;
    // 够高的块：时间一行、时长另起一行；矮块挤成一行，时长紧跟在后面。
    // 时长用 ccDurText，跟着界面语言走（"3 小时 20 分" / "3 h 20 min"）。
    const twoLine = spanPx >= 34;
    const label = `<span class="cc-run-txt${tight ? ' tight' : ''}${twoLine ? ' two' : ''}"`
      + ` style="top:calc(${labTop}% + ${tight ? 2 : 3}px)">`
      + `<b>${labStart} – ${labEnd}</b><em>${ccDurText(spanMin)}</em></span>`;
    // 只有内容真的变了才重写：无谓赋值会把子节点（色带 + 文字）整批重建，
    // 那是"闪"的另一半来源。
    const html = label + bands;
    if (run.dataset.html !== html) {
      run.innerHTML = html;
      run.dataset.html = html;
    }
    if (!run.isConnected) grid.appendChild(run);
  };

  // 一天一段：直接铺，不做跨天/跨段合并
  for (const s of segs) addBlock(s.d, s.h0, s.h1, s.f0, s.t1, s.seg);

  // 池里剩下的 = 这一帧不该再有的块（被删掉、被合并、或换了位置的老数据），统一清掉
  pool.forEach((el) => el.remove());

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

/** 一天里选中的总分钟数。
 *
 *  按**窗口**累加，不能按 `from`/`to` 相减：那两个字段只是"这一小时的近似总范围"，
 *  同一小时里放两段且中间有空档时（09:00–09:15 与 09:45–10:00），
 *  相减会得到整小时 60 分钟，比真实值多一倍。窗口是唯一真相。 */
function ccDayMinutes(day) {
  return (day || []).reduce((n, p) => n
    + hourWins(p).reduce((m, w) => m + Math.max(0, w.to - w.from), 0), 0);
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
/// 一小时里的窗口列表（统一出口：`wins` 优先，否则旧的单窗口字段）。
///
/// 为什么需要：`on/from/to` 只能表达"一小时一个窗口"，
/// 于是 09:00–09:30 与 09:30–10:00 会被第二段撑成整小时、并成一段。
/// `wins` 非空时以它为准，老配置照旧走单窗口。
function hourWins(p) {
  if (!p || !p.on) return [];
  if (Array.isArray(p.wins) && p.wins.length) {
    return p.wins
      .filter((w) => w && (w.to == null ? 60 : +w.to) > (+w.from || 0))
      .map((w) => ({
        from: Math.max(0, Math.min(59, +w.from || 0)),
        to: Math.max(1, Math.min(60, w.to == null ? 60 : +w.to)),
        seg: w.seg || '',
      }))
      .sort((a, b) => a.from - b.from);
  }
  const f = Math.max(0, Math.min(59, p.from || 0));
  const t = Math.max(1, Math.min(60, p.to == null ? 60 : p.to));
  if (t <= f) return [];
  return [{ from: f, to: t, seg: p.seg || '' }];
}

/** 把窗口列表写回一小时。只剩一个窗口时收回旧字段，避免配置无谓膨胀。 */
function ccSetHourWins(p, wins, work, brk) {
  const list = (wins || [])
    .map((w) => ({
      from: Math.max(0, Math.min(59, +w.from || 0)),
      to: Math.max(1, Math.min(60, w.to == null ? 60 : +w.to)),
      seg: w.seg || '',
    }))
    .filter((w) => w.to > w.from)
    .sort((a, b) => a.from - b.from);
  if (work != null) p.work = work;
  if (brk != null) p.brk = brk;
  if (!list.length) {
    p.on = false;
    p.from = 0;
    p.to = 60;
    p.seg = '';
    p.wins = [];
    return;
  }
  p.on = true;
  p.from = list[0].from;
  p.to = list[list.length - 1].to;   // 旧字段记"总范围"，给只读旧字段的地方一个近似
  p.seg = list[0].seg || '';
  p.wins = list.length > 1
    ? list.map((w) => ({ from: w.from, to: w.to, seg: w.seg || '' }))
    : [];
}

/** 某一小时在 [lo,hi) 这次操作之后的窗口列表。
 *
 *  `mode`：
 *    · `add` 把这一段并进去（同段相接才连、不同段相接各留各的、重叠则截断旧段）
 *    · `sub` 从各窗口里减去这一段（**两侧都留**，以前只留较长一侧）
 */
function ccWinsAfter(p, h, lo, hi, mode, segId) {
  const hs = h * 60;
  const a = Math.max(lo, hs);
  const b = Math.min(hi, hs + 60);
  const wins = hourWins(p).map((w) => ({ ...w }));
  if (b <= a) return wins;
  const af = a - hs;
  const bt = b - hs;

  if (mode === 'sub') {
    const out = [];
    for (const w of wins) {
      if (bt <= w.from || af >= w.to) {
        out.push(w);
        continue;
      }
      // 两侧都保留：一小时现在能存两段了，不需要"留较长的一侧"
      if (w.from < af) out.push({ from: w.from, to: af, seg: w.seg });
      if (w.to > bt) out.push({ from: bt, to: w.to, seg: w.seg });
    }
    return out.sort((x, y) => x.from - y.from);
  }

  // add
  let nf = af;
  let nt = bt;
  let nseg = segId || '';
  const out = [];
  for (const w of wins) {
    const overlap = w.from < nt && w.to > nf;
    const touching = w.to === nf || w.from === nt;
    const same = !w.seg || !nseg ? true : w.seg === nseg;
    if (!overlap && !(touching && same)) {
      out.push(w);
      continue;
    }
    if (overlap && !same) {
      // 不同段且真的重叠：新段覆盖中间，旧段两侧截断
      if (w.from < nf) out.push({ from: w.from, to: nf, seg: w.seg });
      if (w.to > nt) out.push({ from: nt, to: w.to, seg: w.seg });
      continue;
    }
    nf = Math.min(nf, w.from);
    nt = Math.max(nt, w.to);
    if (w.seg) nseg = w.seg;
  }
  out.push({ from: nf, to: nt, seg: nseg });
  return out.sort((x, y) => x.from - y.from);
}

/** 新段 id：只要求"同一毫秒内也不撞"，不做持久化解析 */
let _ccSegSeq = 0;
function ccNewSegId() {
  _ccSegSeq += 1;
  return 's' + Date.now().toString(36) + '_' + _ccSegSeq.toString(36);
}

/** 相邻两小时是否属于同一段。
 *
 *  有 `seg` 就看 id：**id 不同就是两段**，哪怕 09:00–10:00 与 10:00–11:00 完全贴合。
 *  两边都没有 id（老配置）才退回"按连续性合并"的老行为——
 *  老数据没有段的概念，只能这么退，否则升级后旧排班会碎成一小时一段。
 *
 *  一边有一边没有（手工改过配置）：按"不同段"处理，宁可分成两段，
 *  也不要把用户明确分开的东西合起来。
 */
function ccSameSegId(x, y) {
  const a = x || '';
  const b = y || '';
  if (!a && !b) return true;
  return !!a && a === b;
}

function ccSameSeg(a, b) {
  return ccSameSegId((a && a.seg) || '', (b && b.seg) || '');
}

/** 在 [lo,hi) 这段分钟区间里，找已经选中的小时用过的段 id。
 *  只用于"扩展已有一段"时沿用 id；区间内没有已存在的段就返回空（= 新建一段）。
 *
 *  注意这里**不看区间外侧**：紧挨着另一段不算"同一段"，
 *  这正是"相邻两段不许合并"的关键。 */
function ccSegIdIn(day, lo, hi) {
  for (let h = 0; h < 24; h++) {
    const hs = h * 60;
    if (hi <= hs || lo >= hs + 60) continue;
    // **按窗口**判断，不能按小时：09:00–09:30 与 09:30–10:00 在同一个小时里，
    // 按小时判断会让第二段"借用"第一段的 id，然后被合并成一段——
    // 这正是"两个半小时变成一个一小时"的直接原因。
    for (const w of hourWins(day[h])) {
      const a = hs + w.from;
      const b = hs + w.to;
      if (b > lo && a < hi && w.seg) return w.seg;
    }
  }
  return '';
}

function ccSegs(day) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    const p = day[h];
    const ws = hourWins(p);
    if (!ws.length) continue;
    const work = Math.max(1, Math.min(60, p.work || 50));
    const brk = Math.max(0, Math.min(60 - work, p.brk || 0));
    for (const w of ws) {
      const absFrom = h * 60 + w.from;
      const last = out[out.length - 1];
      // 同段 + 首尾相接 → 接成一段（跨小时的那一段）
      if (last && ccSameSegId(last.seg, w.seg) && last.endAbs === absFrom) {
        last.h1 = h;
        last.t1 = w.to;
        last.endAbs = h * 60 + w.to;
        last.mins += w.to - w.from;
        continue;
      }
      out.push({
        h0: h,
        h1: h,
        f0: w.from,
        t1: w.to,
        seg: w.seg || '',
        endAbs: h * 60 + w.to,
        mins: w.to - w.from,
        work,
        brk,
      });
    }
  }
  // 补 range / rounds（原来在循环里算，现在统一收尾）
  for (const sg of out) {
    const endH = sg.t1 >= 60 ? sg.h1 + 1 : sg.h1;
    sg.range = `${pad(sg.h0)}:${pad(sg.f0)}–${pad(endH)}:${sg.t1 >= 60 ? '00' : pad(sg.t1)}`;
    sg.rounds = Math.floor(sg.mins / Math.max(1, sg.work + sg.brk));
    delete sg.endAbs;
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

/** 大日历的格子 HTML —— 只在完整页里生成（折叠时不算这 168 个格子）
 *  行数跟着「显示范围」走：默认 24 行，设成 07:00–23:00 就只画 16 行。 */
function ccGridHtml(prof, wdNow, hourNow) {
  const step = ccStep();
  const qn = ccQCnt();
  const hourH = ccHourH();
  const view = ccView();
  const h0 = view.from / 60;
  const h1 = view.to / 60;
  let grid = `<div class="cc-corner" style="grid-row:1;grid-column:1">时</div>` + WD.map((w, i) =>
    `<div class="cc-dh${i === wdNow ? ' today' : ''}" style="grid-row:1;grid-column:${i + 2}">${w}${i === wdNow ? '·今' : ''}</div>`).join('');
  for (let h = h0; h < h1; h++) {
    const row = h - h0 + 2;
    grid += `<div class="cc-hlab" style="grid-row:${row};grid-column:1">${h}</div>`;
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
        style="grid-row:${row};grid-column:${dd + 2}" data-d="${dd}" data-h="${h}"
        title="${winTxt}${p.on ? ` · 专注 ${w} 分 / 休息 ${b} 分${t ? `（尾段 ${t} 分继续专注）` : ''}，右键可改` : '（未选中，拖动或右键可设置）'}">${qs}</div>`;
    }
  }
  return { grid, hourH, step, qn, rows: view.hours };
}

/** 分钟数 → "HH:MM"（睡眠时段用；1440 显示成 00:00，表示"到次日 0 点"） */
function minToHm(m) {
  const v = Math.max(0, Math.min(1440, Math.round(m || 0)));
  return `${pad(Math.floor(v / 60) % 24)}:${pad(v % 60)}`;
}
/** "HH:MM" → 分钟数；非法输入返回 null */
function hmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], mm = +m[2];
  if (h > 24 || mm > 59) return null;
  return Math.max(0, Math.min(1440, h * 60 + mm));
}

/** 睡眠状态那一句话（卡片用；pull 轮询时也用它原地刷新，不整页重绘） */
function sleepStateOf(rt) {
  const s = (S.data.config.settings.sleep) || {};
  const st = (rt && rt.sleep) || {};
  const fromM = s.from == null ? 23 * 60 : +s.from;
  const toM = s.to == null ? 7 * 60 : +s.to;
  if (!s.enabled) return { cls: '', txt: '未启用：睡眠时段内开机不会被限制' };
  if (st.locked) {
    const left = Math.max(0, st.remain || 0);
    return {
      cls: 'hot',
      txt: st.shutdown
        ? `锁定中 · ${Math.floor(left / 60)} 分 ${pad(left % 60)} 秒后自动关机`
        : `锁定中 · 只锁屏，不关机（${minToHm(fromM)} – ${minToHm(toM)}）`,
    };
  }
  if (st.inWindow && st.unlockedUntil > 0) {
    const d = new Date(st.unlockedUntil * 1000);
    return { cls: 'gold', txt: `已用积分解锁至 ${pad(d.getHours())}:${pad(d.getMinutes())}，到点后重新锁定` };
  }
  if (st.inWindow) {
    return { cls: 'gold', txt: '在睡眠时段内（未锁定：请检查「锁定屏幕」开关或测试模式）' };
  }
  // 多段时不能猜"下次锁定几点"：两段之间到底哪段先来、明天是否生效，
  // 得把周期算进去才准。算不准就别说，别给一个错的时刻。
  const multi = Array.isArray(s.windows) && s.windows.length > 1;
  return {
    cls: '',
    txt: multi ? '现在不在任何睡眠时段内' : `现在不在睡眠时段，下次锁定 ${minToHm(fromM)}`,
  };
}

/* ── 睡眠时段：多段 + 生效周期 ──────────────────────────────
 *
 * 数据层只有一个真相：`settings.sleep.windows[]`。每段自带 from/to/days/
 * 锁屏/关机/倒计时/启动清单；`days` 又是"生效周期"的唯一真相，
 * 模式（每天 / 工作日 / 指定）只是它的投影——这样就不会出现
 * "模式说每天、days 里却躺着周一"这种自相矛盾的配置。
 *
 * 兼容：`windows` 为空时用旧的 from/to 合成一段（伪 id `__legacy`），
 * 界面照常显示、保存时写回旧字段。用户一旦碰周期或添加时段，
 * `sleepEnsureWindows()` 会把它落成真正的 windows[0]，前后参数一字不变。
 */

/** 段列表：windows 为空时合成一段"旧字段" */
function sleepSegs() {
  const s = clockCfgSleep();
  if (Array.isArray(s.windows) && s.windows.length) return s.windows;
  return [{
    id: '__legacy',
    from: s.from == null ? 23 * 60 : +s.from,
    to: s.to == null ? 7 * 60 : +s.to,
    days: [],
    enabled: true,
    lockScreen: s.lockScreen !== false,
    shutdown: s.shutdown !== false,
    countdownMin: s.countdownMin == null ? 10 : +s.countdownMin,
    wake: s.wake || { enabled: false, items: [] },
  }];
}

/** 正在编辑的那一段（选中的 id 失效就退回第一段） */
function sleepSelSeg() {
  const list = sleepSegs();
  return list.find((x) => x.id === S.sleepSel) || list[0];
}

/** 周期模式：days 的投影，规则与 Rust 侧 sleep_window::cycle_mode 一致 */
function sleepCycleMode(seg) {
  // 显式模式优先：在「指定」里勾出周一到周五时，它就是「指定」。
  // 早先靠 days 投影，集合恰好等于工作日就跳成「仅工作日」，
  // 再点「指定」又立刻弹回去——用户看到的是"点不动"。
  const m = (seg && seg.mode) || '';
  if (m === 'everyday' || m === 'workdays' || m === 'custom') return m;
  // 老数据没有 mode：按 days 投影，与升级前一致
  const d = (seg && seg.days) || [];
  if (!d.length) return 'everyday';
  if (d.length === 5 && d.every((x) => x < 5)) return 'workdays';
  return 'custom';
}

/** 周期的一句话描述 */
function sleepCycleText(seg) {
  const m = sleepCycleMode(seg);
  if (m === 'everyday') return '每天';
  if (m === 'workdays') return '仅工作日';
  const WD = ['一', '二', '三', '四', '五', '六', '日'];
  const d = (seg.days || []).slice().sort((a, b) => a - b);
  return d.map((k) => '周' + (WD[k] || '?')).join('、');
}

/** 把"单段"升级成"多段"：用户碰周期或多段时，必须存在真正的段对象。
 *  升级前后 from/to/开关一个字都不变，所以对用户是无感的。 */
function sleepEnsureWindows() {
  const s = clockCfgSleep();
  if (Array.isArray(s.windows) && s.windows.length) return s.windows;
  const seg = sleepSelSeg();
  s.windows = [{
    id: 'w1',
    from: +seg.from,
    to: +seg.to,
    days: (seg.days || []).slice(),
    mode: sleepCycleMode(seg),
    enabled: true,
    lockScreen: !!seg.lockScreen,
    shutdown: !!seg.shutdown,
    countdownMin: +seg.countdownMin || 10,
    wake: seg.wake || { enabled: false, items: [] },
  }];
  S.sleepSel = 'w1';
  return s.windows;
}

/** 多段时的时段列表（单段不渲染列表：只有一段时列表纯属占地方） */
function sleepSegListHtml() {
  const s = clockCfgSleep();
  const multi = Array.isArray(s.windows) && s.windows.length > 1;
  if (!multi) return '';
  const cur = sleepSelSeg();
  const rows = s.windows.map((w, i) => `
    <div class="sl-row${w.id === cur.id ? ' on' : ''}">
      <span class="sl-idx">${i + 1}</span>
      <span class="sl-time">${minToHm(w.from)} – ${w.to >= 1440 ? '24:00' : minToHm(w.to)}</span>
      <span class="sl-cycle">${esc(sleepCycleText(w))}</span>
      <span class="sl-tags">${w.lockScreen ? '<b>锁屏</b>' : '<b class="off">不锁</b>'}${w.shutdown ? '<b>关机</b>' : '<b class="off">不关</b>'}</span>
      <button class="btn btn-sm" data-act="sleep-pick-seg" data-id="${esc(w.id)}"
        ${w.id === cur.id ? 'disabled' : ''}>${w.id === cur.id ? '编辑中' : '编辑'}</button>
      <button class="btn btn-sm danger-ghost" data-act="sleep-del-seg" data-id="${esc(w.id)}">删</button>
    </div>`).join('');
  return `<div class="sl-list"><div class="sl-hd">共 ${s.windows.length} 段睡眠</div>${rows}</div>`;
}

/** 表单：作用对象是"选中的那一段"（单段时就是伪段） */
function sleepFormHtml(seg) {
  const s = clockCfgSleep();
  const fromM = +seg.from;
  const toM = +seg.to;
  const count = +seg.countdownMin || 10;
  const price = s.unlockPrice == null ? 10 : +s.unlockPrice;
  const umin = s.unlockMin == null ? 30 : +s.unlockMin;
  const mode = sleepCycleMode(seg);
  const WD = ['一', '二', '三', '四', '五', '六', '日'];
  const days = (seg.days || []).slice().sort((a, b) => a - b);
  return `
    <div class="sleep-grid">
      <label class="sf"><span class="sf-lab">睡眠时段</span>
        <span class="sf-in">
          <input type="time" id="sleepFrom" value="${minToHm(fromM)}">
          <em>至</em>
          <input type="time" id="sleepTo" value="${minToHm(toM)}">
          <em class="hint">（结束填 00:00 = 到次日 0 点，例如 23:00 – 00:00）</em>
        </span>
      </label>
      <label class="sf"><span class="sf-lab">生效周期</span>
        <span class="sf-in">
          <span class="sl-seg">
            <button class="${mode === 'everyday' ? 'active' : ''}" data-act="sleep-cycle" data-v="everyday"
              title="每天都按这个时段管">每天</button>
            <button class="${mode === 'workdays' ? 'active' : ''}" data-act="sleep-cycle" data-v="workdays"
              title="周一到周五生效，周末不管">仅工作日</button>
            <button class="${mode === 'custom' ? 'active' : ''}" data-act="sleep-cycle" data-v="custom"
              title="自己挑星期几">指定</button>
          </span>
          <span class="sl-days"${mode === 'custom' ? '' : ' hidden'}>${WD.map((d, k) => `<button
            class="${days.includes(k) ? 'on' : ''}" data-act="sleep-day" data-v="${k}"
            title="周${d}">${d}</button>`).join('')}</span>
        </span>
      </label>
      <label class="sf"><span class="sf-lab">开机后</span>
        <span class="sf-in">
          <input type="number" id="sleepCount" min="1" max="120" step="1" value="${count}">
          <em>分钟内自动关机</em>
        </span>
      </label>
      <label class="sf"><span class="sf-lab">积分解锁</span>
        <span class="sf-in">
          <input type="number" id="sleepPrice" min="0" max="1000" step="1" value="${price}">
          <em>分 / 分钟，一次买</em>
          <input type="number" id="sleepUnlockMin" min="5" max="240" step="5" value="${umin}">
          <em>分钟</em>
          <em class="hint">（价格填 0 = 这段睡眠不许用积分解锁）</em>
        </span>
      </label>
      <label class="sf"><span class="sf-lab">到点关机</span>
        <span class="sf-in">
          <input type="checkbox" id="sleepShutdown" ${seg.shutdown === false ? '' : 'checked'}>
          <em>真的执行关机（关掉 = 只锁定、不关机）</em>
        </span>
      </label>
      <label class="sf"><span class="sf-lab">限制功能</span>
        <span class="sf-in">
          <input type="checkbox" id="sleepLockOn" ${seg.lockScreen === false ? '' : 'checked'}>
          <em>睡眠时段内全屏锁定（关掉就只剩倒计时关机）</em>
        </span>
      </label>
    </div>`;
}

/** 「睡眠管理」卡片 */
function sleepCardHtml(rt) {
  const s = clockCfgSleep();
  const st = (rt && rt.sleep) || {};
  const on = !!s.enabled;
  const seg = sleepSelSeg();
  const multi = Array.isArray(s.windows) && s.windows.length > 1;
  const state = sleepStateOf(rt);
  return `
  <div class="card" id="sleepCard">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:14px">
      <div>
        <div class="card-title">睡眠管理</div>
        <div class="card-sub">和「自律时段」是两件事：那边管白天什么时候不许玩，这里管夜里这台机器该关着了。</div>
        <div class="card-sub">到了睡眠时段，开机 / 唤醒后会限制所有功能，倒计时结束自动关机；想现在用，只能用积分解锁。</div>
      </div>
      <div class="switch" data-act="sleep-enable" title="启用 / 停用睡眠管理"><input type="checkbox" ${on ? 'checked' : ''}><i></i></div>
    </div>

    <div class="sleep-state ${state.cls}"><span class="cs-dot"></span><span>${esc(state.txt)}</span></div>

    ${sleepSegListHtml()}
    ${multi ? `<div class="sl-edit-hd">正在编辑第 ${(s.windows.findIndex((x) => x.id === seg.id) + 1) || 1} 段 · ${esc(sleepCycleText(seg))}</div>` : ''}

    ${sleepFormHtml(seg)}


    <div class="row" style="margin-top:14px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-sm" data-act="sleep-save">保存睡眠设置</button>
      <button class="btn btn-sm" data-act="sleep-add-seg" title="加一段不同时间 / 不同策略的睡眠">＋ 添加时段</button>
      <span class="hint">判定只看当前时刻是否落在任一段睡眠时段内，与自律时段、自律规则完全独立。</span>
    </div>
  </div>`;
}

/* ── 进入自律时间自动打开 ──────────────────────────────────
 *
 * 编辑的是一份**草稿**（S.launchDraft），点保存才写回规则。
 * 为什么不像睡眠那样即时保存：这里一次要改好几行（顺序、窗口形式），
 * 每敲一个字就落盘会让"撤销"变得不可能，而且中途状态不完整。
 */

/** 打开面板：把规则的清单深拷贝成草稿 */
function openLaunchModal(id) {
  const r = (S.data.config.rules || []).find((x) => x.id === id);
  if (!r) return;
  const a = r.autolaunch || {};
  S.launchDraft = {
    ruleId: id,
    ruleName: r.name,
    enabled: !!a.enabled,
    items: (a.items || []).map((x, i) => ({
      id: x.id || 'i' + (i + 1),
      kind: x.kind === 'url' ? 'url' : 'app',
      target: x.target || '',
      args: x.args || '',
      window: x.window || 'normal',
      browser: x.browser || '',
    })),
  };
  renderLaunchModal();
}

/** 把面板里每一行的输入同步回草稿（不落盘）。
 *
 *  「软件 / 网页」「窗口化 / 最大化 / 最小化」不再是原生下拉，而是分段按钮，
 *  所以这里按"哪一个是 active"读取——读的还是 DOM，保证"看到的就是存下的"。 */
function launchSync() {
  const d = S.launchDraft;
  if (!d) return;
  const byId = new Map(d.items.map((x) => [x.id, x]));
  document.querySelectorAll('[data-lkrow]').forEach((row) => {
    const it = byId.get(row.dataset.lkrow);
    if (!it) return;
    const get = (k) => (row.querySelector('[data-lk="' + k + '"]') || {}).value;
    /** 分段按钮当前选中的那个值 */
    const pick = (sel) => {
      const on = row.querySelector(`${sel} .active`);
      return on ? on.dataset.v : '';
    };
    const kind = pick('.lk-kind') === 'url' ? 'url' : 'app';
    it.kind = kind;
    it.target = String(get('target') || '');
    it.args = kind === 'url' ? '' : String(get('args') || '');
    it.window = pick('.lk-win') || 'normal';
    it.browser = kind === 'url' ? String(get('browser') || '') : '';
  });
}

function renderLaunchModal() {
  const d = S.launchDraft;
  if (!d) return;
  // 窗口形式：三个并列的分段按钮，不用原生 <select>。
  // 为什么换掉：下拉在深色里只有控件本体跟着主题走，弹出来的选项列表是系统默认的
  // （浅底黑字 / 深底黑字都可能），"窗口化 / 最大化 / 最小化"糊成一片，
  // 和界面其它分段控件的风格也完全不是一路。分段按钮是自绘的，颜色、字号、圆角
  // 全在本项目手里，三项一眼可辨、点了就有明确反馈。
  const WIN = [['normal', '窗口化', '按普通窗口打开'], ['max', '最大化', '铺满屏幕'],
    ['min', '最小化', '只放进任务栏']];
  const rows = d.items.length
    ? d.items.map((it, i) => {
      const url = it.kind === 'url';
      const win = it.window || 'normal';
      return `<div class="lk" data-lkrow="${esc(it.id)}">
        <div class="lk-line lk-main">
          <span class="lk-idx" title="桌面上的排列顺序">${i + 1}</span>
          <div class="lk-kind" role="group" aria-label="软件还是网页">
            <button type="button" data-act="launch-kind" data-id="${esc(it.id)}" data-v="app"
              class="${url ? '' : 'active'}" title="打开本机软件">软件</button>
            <button type="button" data-act="launch-kind" data-id="${esc(it.id)}" data-v="url"
              class="${url ? 'active' : ''}" title="打开一个网址">网页</button>
          </div>
          <input type="text" data-lk="target" value="${esc(it.target)}"
            placeholder="${url ? 'https://example.com' : 'C:\\Program Files\\App\\app.exe'}">
          <span class="lk-ops">
            <button class="btn btn-sm" data-act="launch-up" data-id="${esc(it.id)}" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
            <button class="btn btn-sm" data-act="launch-down" data-id="${esc(it.id)}"
              ${i === d.items.length - 1 ? 'disabled' : ''} title="下移">↓</button>
            <button class="btn btn-sm danger-ghost" data-act="launch-del" data-id="${esc(it.id)}">删</button>
          </span>
        </div>
        <div class="lk-line lk-sub">
          <span class="lk-lab">打开方式</span>
          <div class="lk-win" role="group" aria-label="打开后的窗口形式">
            ${WIN.map(([v, t, tip]) => `<button type="button" data-act="launch-win"
              data-id="${esc(it.id)}" data-v="${v}" class="${win === v ? 'active' : ''}"
              title="${tip}">${t}</button>`).join('')}
          </div>
          <label class="lk-field">
            <span class="lk-lab">参数</span>
            <input type="text" data-lk="args" value="${esc(it.args || '')}"
              placeholder="启动参数（可空）" ${url ? 'disabled' : ''}>
          </label>
          <label class="lk-field">
            <span class="lk-lab">浏览器</span>
            <input type="text" data-lk="browser" value="${esc(it.browser || '')}"
              placeholder="${url ? '默认浏览器' : '—'}" ${url ? '' : 'disabled'}>
          </label>
        </div>
      </div>`;
    }).join('')
    : '<div class="lk-empty">还没有目标。点下面的「＋ 添加一项」，可以加软件，也可以加网页。</div>';

  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="width:820px">
      <div class="modal-hd">
        <h3>进入自律时间时自动打开</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="row" style="justify-content:space-between;align-items:flex-start;gap:14px">
          <div style="flex:1">
            <div class="card-sub">规则「${esc(d.ruleName)}」</div>
            <div class="hint" style="line-height:1.8">每到<b>一个专注段的开始</b>（含番茄休息结束回到专注）就对齐一次：</div>
            <div class="hint" style="line-height:1.8">已经开着的窗口直接切到最上层，没开的才启动；软件启动时正好在自律时间里，也会立刻对齐。</div>
          </div>
          <div class="switch" data-act="launch-toggle" title="启用 / 停用"><input type="checkbox" ${d.enabled ? 'checked' : ''}><i></i></div>
        </div>

        <div class="lk-list">${rows}</div>

        <div class="row" style="margin-top:10px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-sm" data-act="launch-add">＋ 添加一项</button>
          <span class="hint">序号就是桌面上的从左到右顺序；「打开方式」决定它启动后是窗口化、最大化还是最小化。</span>
        </div>
        <div class="hint" style="margin-top:8px;line-height:1.8">
          网页的「已打开就切过去」靠窗口标题里的域名判断，属于尽力而为；判不出来会新开一个标签页。
        </div>
      </div>
      <div class="modal-ft">
        <span class="hint" style="flex:1">最多 12 项；网页必须是 http(s) 地址</span>
        <button class="btn" data-act="close-modal">取消</button>
        <button class="btn btn-primary" data-act="launch-save">保存</button>
      </div>
    </div>
  </div>`;
}

/** 「完整展示」是否开着（默认开）。
 *  纯展示参数：关掉只是回到固定行高 + 滚动条，判定与排班一个字都不变。 */
function ccFit() {
  const fc = (S.data && S.data.config && S.data.config.settings && S.data.config.settings.focusClock) || {};
  return fc.fitAll !== false;
}

/** 完整页：大日历（可拖选 / 右键）+ 粒度 + 每日明细 */
function ccDetailHtml(prof, wdNow, hourNow, frozen) {
  const { grid, hourH, step, qn, rows } = ccGridHtml(prof, wdNow, hourNow);
  const view = ccView();
  const fit = ccFit();
  const totalMins = prof.days.reduce((n, d) => n + ccDayMinutes(d), 0);
  // 显示范围外还有多少段：不提醒一下的话，用户会以为"我排的时段没了"
  const outside = prof.days.reduce((n, day) => n + ccSegs(day).filter((sg) => {
    const a = sg.h0 * 60 + sg.f0;
    const b = sg.h1 * 60 + (sg.t1 >= 60 ? 60 : sg.t1);
    return b <= view.from || a >= view.to;
  }).length, 0);
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
  <div class="cc-detail${S.ccAnimIn ? ' opening' : ''}" id="ccDetail">
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
      <div class="cc-gran cc-view">
        <span class="cc-gran-lab">显示范围</span>
        <label class="cc-view-pick">从 <select data-act="clock-view" data-k="from">
          ${Array.from({ length: 23 }, (_, i) => `<option value="${i}"${i * 60 === view.from ? ' selected' : ''}>${pad(i)}:00</option>`).join('')}
        </select></label>
        <label class="cc-view-pick">到 <select data-act="clock-view" data-k="to">
          ${Array.from({ length: 24 }, (_, i) => `<option value="${i + 1}"${(i + 1) * 60 === view.to ? ' selected' : ''}>${pad(i + 1)}:00</option>`).join('')}
        </select></label>
        <button class="btn btn-sm" data-act="clock-view-reset" title="恢复成全天（00:00 – 24:00）">全天</button>
        <span class="hint">现在只看 ${ccViewText(view)}：<b>只影响显示</b>，范围外的时段照样生效${
  outside ? `（另有 <b>${outside}</b> 段在范围外）` : ''}。</span>
        <div class="cc-fit" id="ccFit">
          <span class="lab">完整展示</span>
          <span class="seg">
            <button class="${fit ? 'active' : ''}" data-act="clock-fit" data-v="1">开</button>
            <button class="${fit ? '' : 'active'}" data-act="clock-fit" data-v="0">关</button>
          </span>
          <span class="state ${fit ? 'on' : ''}">${fit ? '一次铺满，不用滚动' : '固定行高，可滚动'}</span>
        </div>
      </div>
      <div class="cc-main${fit ? ' fit' : ''}" id="ccMain">
        <div class="cc-left">
          <div class="cc-scroll"><div class="cc" id="ccGrid" style="--cc-hour-h:${hourH}px;--cc-rows:${rows}">${grid}</div></div>
          <div class="cc-legend">
            <span><i class="sw sel"></i>选中 / 拖动中</span>
            <span><i class="sw"></i>已放置（已保存）</span>
            <span class="hint">同一个色相，只差 5% 明度：拖的时候亮一点点，松手后轻微加深就是存好了</span>
          </div>
          <div class="tl-legend">
            <span class="hint">
              <b>空白处按住拖动</b> = 新建一段（按当前粒度吸附，最少一格）；
              <b>在已有的条上按住拖动</b> = 整段搬走；
              <b>按住上下边缘</b> = 拉长 / 缩短；
              <b>单击</b> = 只记选区，不改结构；
              <b>右键</b> = 细调时长与起止分钟。
            </span>
            <button class="btn btn-sm" data-act="clock-clear" ${frozen ? 'disabled' : ''}>清空全部</button>
          </div>
        </div>
        <aside class="cc-side">
          <div class="cc-days">
            <div class="cc-days-hd"><span>每日时长</span><span>合计 ${ccMinText(0, totalMins).dur}</span></div>
            ${dayRows}
          </div>
        </aside>
      </div>
    </div>
  </div>`;
}

/* ── 休息结束时的收尾 ─────────────────────────────────────────
 *
 * 只在「休息 → 学习」的那一次边界动手：休息段里黑名单是放行的，用户会把
 * 抖音 / 游戏开起来；回到学习的那一刻，这些窗口不能就这么留着。
 *
 * 两种模式的区别（也写在卡片里，用户改设置时能直接看到）：
 *   柔和 · 最小化：窗口收进任务栏、程序留着，随时能还原；学习期间它被"停放"
 *      （不再被反复强杀），一旦还原就立刻按拦截处理。播放中的媒体会先暂停。
 *   强制 · 关闭：直接关掉（先请程序自己退出，不退出再强制结束）。
 *
 * 网页为什么不在这个开关里：外部进程只能看到浏览器窗口，看不到标签页；
 * 按窗口标题猜会把整个浏览器连坐（用户可能开着十个学习用的标签）。
 * 网页由浏览器插件按标签页精确拦截，一个标签不会牵连其它标签。
 */
function sweepCardHtml(frozen) {
  const sw = sweepCfg();
  const soft = sw.mode !== 'hard';
  const dis = sw.enabled && !frozen ? '' : 'disabled';
  const off = !sw.enabled;
  return `
  <div class="card" id="sweepCard">
    <div class="card-title">休息结束时的收尾</div>
    <div class="card-sub">休息段里黑名单是放行的；回到学习的那一刻，把休息里开着的那些收起来。</div>

    <div class="row" style="justify-content:space-between;align-items:center;gap:14px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px">回到学习时自动收尾</div>
        <div class="hint" style="margin-top:4px">只在「休息 → 学习」的边界执行一次；学习中新打开的应用照常拦截。</div>
      </div>
      <div class="switch${frozen ? ' locked' : ''}" data-act="sweep-toggle"
           title="${frozen ? '自律时段生效中，不能改' : '切换'}"><input type="checkbox" ${sw.enabled ? 'checked' : ''}><i></i></div>
    </div>

    <div class="cc-gran cc-sweep-mode" style="margin-top:14px">
      <span class="cc-gran-lab">处理方式</span>
      <button class="cc-gran-btn${soft ? ' active' : ''}" data-act="sweep-mode" data-v="soft" ${dis}
        title="收起窗口，程序留着，随时可以还原">柔和 · 最小化</button>
      <button class="cc-gran-btn${soft ? '' : ' active'}" data-act="sweep-mode" data-v="hard" ${dis}
        title="直接关闭应用">强制 · 关闭</button>
      <span class="hint">${off ? '收尾已关闭，这两种方式都不会执行。'
    : soft ? '窗口收进任务栏、程序留着；网页换成拦截页（标签还在）。学习期间不再强杀，但点开就按拦截处理。'
      : '直接关掉：先请程序自己退出，不退出再强制结束；网页直接关掉标签页。'}</span>
    </div>

    <div class="row" style="justify-content:space-between;align-items:center;gap:14px;margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px">播放中的媒体一并暂停</div>
        <div class="hint" style="margin-top:4px">只有确实在播放才暂停；已暂停、已停止、状态读不到都不动，也永远不会自动恢复播放。</div>
      </div>
      <div class="switch${frozen || off ? ' locked' : ''}" data-act="sweep-media"
           title="${off ? '先打开上面的收尾' : frozen ? '自律时段生效中，不能改' : '切换'}"><input type="checkbox" ${sw.pauseMedia ? 'checked' : ''} ${off || frozen ? 'disabled' : ''}><i></i></div>
    </div>

    <div class="note" style="margin-top:12px;line-height:1.95">
      <div>作用对象：被自律规则判为「不能开」的软件（黑名单命中的，或白名单之外且不是保护进程的），与拦截用的是同一份判定。</div>
      <div>网页由浏览器插件按标签页执行同一种收尾：柔和 = 换成拦截页（标签保留，休息回来点刷新即可），强制 = 直接关掉标签页；不会因为一个标签连坐整个浏览器。</div>
      <div>执行时机：只在「休息 → 学习」的那一次边界执行；开机或唤醒时如果已经在上课段，不会补做。</div>
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

  ${sleepCardHtml(rt)}

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
  ${sweepCardHtml(frozen)}
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
            <div class="hint" style="margin-top:2px">
              需要播放器支持 Windows 的系统媒体控件（浏览器与主流播放器都支持）；
              点上面的「自查」可以看到当前识别到几个媒体会话、暂停了谁。
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
    const cur = map.get(s.key) || {
      key: s.key, label: s.label, category: s.category, secs: 0,
      // 站点行带着"主标题"和"页面数"，合并两档数据时不能把它们丢掉，
      // 否则切到「汇总」标签后标题会变回域名、也不再提示"共 N 个页面"
      title: s.title || '', pages: s.pages || 0,
      // 浏览器也要带过去：漏了它，切到「汇总」标签括号就没了
      browser: s.browser || '',
    };
    cur.secs += s.secs;
    // 页面数取较大值：两个数据集统计的是同一批页面，取并集的上界即可
    cur.pages = Math.max(cur.pages, s.pages || 0);
    if (!cur.title && s.title) cur.title = s.title;
    if (!cur.browser && s.browser) cur.browser = s.browser;
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

/* ---------------- 时间日历（周 / 月） ---------------- */

/** 一周从周一开始（与时段表一致） */
function weekStartOf(dt) {
  const d = new Date(dt.getTime());
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseYmd(t) {
  const p = String(t || '').split('-').map(Number);
  if (p.length !== 3 || !p[0]) return new Date();
  return new Date(p[0], p[1] - 1, p[2]);
}

/** 三个视图共用同一个状态筛选：饼图、周/月网格、当日日历必须看同一批数据。
 *  以前只有饼图认 statsTab，日历那边是自己拼的字符串 —— 一旦哪天加了新 tab，
 *  两边就会各自算各自的，出现"上面 3 小时、下面 5 小时"。 */
function statsTabKey() {
  return S.statsTab === 'off' ? 'off' : (S.statsTab === 'on' ? 'on' : 'all');
}

/** 当前要加载的区间：周 = 7 天，月 = 覆盖整月的 7 的倍数天 */
function calRange() {
  const base = parseYmd(S.calAnchor || S.calSel || todayStr());
  let start;
  let end;
  if (S.calMode === 'month') {
    const first = new Date(base.getFullYear(), base.getMonth(), 1);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    start = weekStartOf(first);
    end = addDays(weekStartOf(last), 6);
  } else {
    start = weekStartOf(base);
    end = addDays(start, 6);
  }
  let lo = dateStr(start);
  let hi = dateStr(end);
  // 选中日不在窗口里时把区间扩到它：切换视图/翻页后明细仍然读得到数据
  const sel = S.calSel || lo;
  if (sel < lo) lo = sel;
  if (sel > hi) hi = sel;
  const tab = statsTabKey();
  return { start: lo, end: hi, tab, key: lo + '|' + hi + '|' + tab };
}

/** 当前视图自己的窗口（不含"为选中日扩出来"的那几天） */
function calWindow() {
  const base = parseYmd(S.calAnchor || S.calSel || todayStr());
  if (S.calMode === 'month') {
    const first = new Date(base.getFullYear(), base.getMonth(), 1);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    return { start: dateStr(weekStartOf(first)), end: dateStr(addDays(weekStartOf(last), 6)) };
  }
  const w0 = weekStartOf(base);
  return { start: dateStr(w0), end: dateStr(addDays(w0, 6)) };
}

/** 只保留窗口内的天：区间可能为了"选中日"被扩过，网格不能被撑成 8 列 */
function calWindowDays(days) {
  const w = calWindow();
  return days.filter((d) => d.date >= w.start && d.date <= w.end);
}

function calRangeLabel() {
  const r = calWindow();
  if (S.calMode === 'month') {
    const b = parseYmd(S.calAnchor || S.calSel || todayStr());
    return I18N.getLang() === 'en'
      ? `${b.getFullYear()}-${pad(b.getMonth() + 1)}`
      : `${b.getFullYear()} 年 ${b.getMonth() + 1} 月`;
  }
  return `${r.start.slice(5)} ~ ${r.end.slice(5)}`;
}

/** 颜色按"整个窗口内的累计时长"分配：同一个软件在每天都是同一种颜色 */
function calColors(days) {
  const m = new Map();
  const used = new Set();

  // ① 先沿用**饼图的配色**：同一个软件在上面的扇图和下面的日历里必须是同一种颜色，
  //    否则读者每换一个图都要重新"对颜色"，看着就会觉得哪里不协调。
  let cur = null;
  try { cur = currentSlices(); } catch (e) { cur = null; }
  const top = (cur && cur.slices ? cur.slices : []).slice(0, 8);
  top.forEach((sl, i) => {
    if (!sl || !sl.key) return;
    const c = PALETTE[i % PALETTE.length];
    m.set(sl.key, c);
    used.add(c);
  });

  // ② 只在日历里出现的（别的时段/别的天才用到）按累计时长接着排，避开已被占用的颜色
  const tot = new Map();
  for (const d of days) {
    for (const it of d.items || []) {
      if (m.has(it.key)) continue;
      tot.set(it.key, (tot.get(it.key) || 0) + it.secs);
    }
  }
  const arr = [...tot.entries()].sort((a, b) => b[1] - a[1]);
  let k = 0;
  for (const [key] of arr) {
    while (k < PALETTE.length && used.has(PALETTE[k])) k++;
    const c = PALETTE[k % PALETTE.length];
    m.set(key, c);
    used.add(c);
    k++;
  }
  return m;
}

function calSegs(items, colors, cls) {
  let out = '';
  for (const it of items) {
    const c = colors.get(it.key) || 'var(--line-2)';
    const hit = it.key && it.key === S.calHit ? ' hit' : '';
    for (const sp of it.spans || []) {
      const h = Math.max(0.7, ((sp.t - sp.f) / 1440) * 100);
      out += `<i class="${cls}${hit}" data-key="${esc(it.key)}"`
        + ` style="top:${(sp.f / 1440) * 100}%;height:${h}%;background:${c}"`
        + ` title="${esc(it.label)} ${hhmmOfMin(sp.f)}–${hhmmOfMin(sp.t)}"></i>`;
    }
  }
  return out;
}

/** 周视图：7 列，每列一条 24 小时时间轴 */
function calWeekHtml(days, colors) {
  const cells = calWindowDays(days).map((d) => {
    const dt = parseYmd(d.date);
    const wd = DAYS[(dt.getDay() + 6) % 7];
    const on = d.date === S.calSel;
    const today = d.date === todayStr();
    return `<button class="cw-col${on ? ' on' : ''}${today ? ' today' : ''}"
      data-act="cal-pick" data-date="${d.date}" title="${d.date}">
      <span class="cw-hd"><b>${wd}</b><em>${dt.getDate()}</em></span>
      <span class="cw-track">${calSegs(d.items || [], colors, 'cb')}</span>
      <span class="cw-tot">${d.secs ? fmtDurShort(d.secs) : ''}</span>
    </button>`;
  }).join('');
  // 左侧刻度和 7 列放在同一个 grid 里，刻度才能和格子对齐
  const axis = [0, 6, 12, 18, 24]
    .map((h) => `<span style="top:${(h / 24) * 100}%">${pad(h)}</span>`).join('');
  // 刻度必须和"轨道"等高：外层用 padding 让开表头/合计，内层才是真正的坐标系
  // （绝对定位子元素以 padding box 为基准，直接给外层加 padding 是不生效的）
  return `<div class="cal-week"><div class="cw-axis"><div class="cw-axis-in">${axis}</div></div>${cells}</div>`;
}

/** 月视图：7 × N 网格，每格一条横的 24 小时条 */
function calMonthHtml(days, colors) {
  const base = parseYmd(S.calAnchor || S.calSel || todayStr());
  const mon = base.getMonth();
  const cells = calWindowDays(days).map((d) => {
    const dt = parseYmd(d.date);
    const out = dt.getMonth() !== mon;
    const on = d.date === S.calSel;
    const today = d.date === todayStr();
    let segs = '';
    for (const it of d.items || []) {
      const c = colors.get(it.key) || 'var(--line-2)';
      const hit = it.key && it.key === S.calHit ? ' hit' : '';
      for (const sp of it.spans || []) {
        segs += `<i class="${hit ? 'hit' : ''}" data-key="${esc(it.key)}"`
          + ` style="left:${(sp.f / 1440) * 100}%;width:${Math.max(0.4, ((sp.t - sp.f) / 1440) * 100)}%;background:${c}"`
          + ` title="${esc(it.label)} ${hhmmOfMin(sp.f)}–${hhmmOfMin(sp.t)}"></i>`;
      }
    }
    const hasHit = S.calHit && (d.items || []).some((it) => it.key === S.calHit);
    return `<button class="cm-cell${out ? ' out' : ''}${on ? ' on' : ''}${today ? ' today' : ''}${hasHit ? ' has-hit' : ''}"
      data-act="cal-pick" data-date="${d.date}" title="${d.date}">
      <span class="cm-top"><b>${dt.getDate()}</b><em>${d.secs ? fmtDurShort(d.secs) : ''}</em></span>
      <span class="cm-bar">${segs}</span>
    </button>`;
  }).join('');
  return `<div class="cm-wd">${DAYS.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="cal-month">${cells}</div>`;
}

/* ---------------- 当日日历（饼图右侧的单日时间轴） ----------------
 *
 *  一天的 24 小时等比铺在一条竖轨上：色块的位置 = 什么时候开始，高度 = 用了多久。
 *  这块以前是"日历下面的一张明细表"，现在挪到饼图右侧、并且换成时间轴：
 *  同一份数据，看位置比看列表快得多 —— 是清晨还是深夜、一段是长是短，一眼就出来。
 *
 *  为什么不做成"每个块都写字"：24 小时塞进 480px，1 分钟只有 0.33px，
 *  短块根本放不下字。于是够高（>= 18px，约 55 分钟）才写名字、>= 36px 再写时刻，
 *  不够高的靠悬停把读数打到标题行 —— 轨道上永远不跳字。
 */

const DC_H = 480;   // 轨道高度（px），与 CSS 的 --dc-h 一致：1 小时 = 20px
const DC_MIN = 3;   // 一分钟的块也要看得见

function dayOf() {
  return S.dayDate || S.calSel || S.calAnchor || todayStr();
}

function dayCacheKey(date) {
  return statsTabKey() + '|' + date;
}

/** 当天数据：单日缓存优先，其次复用周/月网格里同一天 —— 同一份数据不发第二次请求 */
function dayData(date) {
  const d = date || dayOf();
  const ck = dayCacheKey(d);
  if (S.dayCache && S.dayCache.has(ck)) return S.dayCache.get(ck);
  if (S.cal && S.calKey === calRange().key) {
    const hit = S.cal.find((x) => x.date === d);
    if (hit) return hit;
  }
  return null;
}

let dayTok = 0;

async function dayFetch(date, force) {
  const ck = dayCacheKey(date);
  if (force) S.dayCache.delete(ck);
  else if (S.dayCache.has(ck)) { paintDay(); return; }
  const tok = ++dayTok;
  let got;
  try {
    const r = await invoke('stats_calendar', { start: date, end: date, tab: statsTabKey() });
    got = (r && r[0]) || { date, secs: 0, items: [] };
  } catch (e) {
    got = { date, secs: 0, items: [] };
  }
  S.dayCache.set(ck, got);
  // 期间又切到别的天了：这次结果只进缓存，不抢当前画面
  if (tok === dayTok) paintDay();
}

/** 保证当天有数据可画：已有就直接画，否则单独取那一天 */
function dayEnsure(force) {
  const d = dayOf();
  if (force) S.dayCache.delete(dayCacheKey(d));
  if (dayData(d)) { paintDay(); return; }
  // 周/月网格正在取、而且窗口里就有这天：等它回来，别为同一份数据发两个请求
  if (S.calPending && !force) return;
  dayFetch(d, force);
}

/** 这一项最该看的是哪一天：用时最长的那天（并列时取较近的一天） */
function bestDayOf(it) {
  const m = new Map();
  for (const sp of (it && it.spans) || []) {
    if (!sp || !sp.date) continue;
    m.set(sp.date, (m.get(sp.date) || 0) + Math.max(0, (sp.t || 0) - (sp.f || 0)));
  }
  if (!m.size) return '';
  const arr = [...m.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? 1 : -1));
  return arr[0][0];
}

/** 聚焦某个分类（'' = 取消）：饼图描边、当日日历、周/月网格三处一起变 */
function statsFocus(key, date) {
  const moved = !!date && date !== dayOf();
  S.calHit = key || '';
  if (date) {
    // 三处日期一起走：当日日历、网格选中日、网格窗口锚点
    S.dayDate = date;
    S.calSel = date;
    S.calAnchor = date;
  }
  if (S.calKey !== calRange().key) {
    calLoad();          // 窗口变了：网格要重取（它回来时会顺带重画当日日历）
  } else {
    paintCalFocus();    // 只切描边，不重建网格
    if (moved) dayEnsure();   // 真的换了天才整块重画当日日历
    else paintFocus();
  }
  paintPieFocus();
  // 只是把面板收起来（没换分类也没换天）就别闪了 —— 那一侧其实什么都没变
  if (!S.calHit && !moved) return;
  flashDay();
}

/** 只重画扇图的"聚焦"描边：不重新布局，扇区位置一动不动 */
function paintPieFocus() {
  const cv = $('#pie');
  if (!cv || !cv.__pie) return;
  const items = cv.__pie.items || [];
  cv.__pie.focus = S.calHit ? items.findIndex((it) => it.key === S.calHit) : -1;
  drawPieFrame(cv);
}

/** 一天里所有有记录的段：按开始时间排好，越界的先夹进 00:00–24:00 */
function dcBlocks(d, colors) {
  const out = [];
  for (const it of (d && d.items) || []) {
    const c = colors.get(it.key) || 'var(--line-2)';
    for (const sp of it.spans || []) {
      // 跨天/脏数据（t > 1440、t < f）一律夹住：宁可少画一段，也不把块画到轨道外面
      const f = Math.max(0, Math.min(1440, Number(sp.f) || 0));
      const t = Math.max(f, Math.min(1440, Number(sp.t) || 0));
      if (t - f < 1) continue;
      out.push({ key: it.key, label: it.label || '', c, f, t });
    }
  }
  out.sort((a, b) => (a.f - b.f) || (a.t - b.t));
  return out;
}

/** 空档：铺一层很淡的斜纹，让人分得清"没记录"和"这一段是别的软件" */
function dcGap(f, t) {
  const px = ((t - f) / 1440) * DC_H;
  return `<i class="dc-gap" style="top:${(f / 1440) * 100}%;height:${((t - f) / 1440) * 100}%">${
    px >= 40 ? '<span>空闲</span>' : ''}</i>`;
}

/** 聚焦项的名字：今天的数据里有就用它，否则退回总览里的名字，再不行用 key 的尾巴 */
function focusName(key, d) {
  const it = d ? (d.items || []).find((x) => x.key === key) : null;
  if (it) return it.label;
  let found = null;
  if (S.stats) {
    const tab = statsTabKey();
    const pool = tab === 'on' ? S.stats.on : (tab === 'off' ? S.stats.off : mergeSlices(S.stats.on, S.stats.off));
    found = pool.find((x) => x.key === key) || null;
  }
  if (found) return found.label;
  return String(key || '').split('|').slice(1).join('|') || String(key || '');
}

/** 时长文案：英文界面用 1h30m，中文用 1 小时 30 分（不发明"共…项"这种复合句去查词典） */
function dcDur(secs) {
  return I18N.getLang() === 'en' ? fmtDurShort(secs) : fmtDur(secs);
}

/** 当天的配色。
 *
 *  窗口里**确实包含这一天**时，按整个窗口算（同一软件每天同色）；
 *  否则只按这一天算 —— 拿一个不含当天的窗口去建色表，当天的应用一个都查不到，
 *  会全部回落到 `--line-2`，看起来就是"所有颜色突然变成同一种颜色"。
 */
function dayColors(d) {
  const days = (S.cal || []).slice();
  // 无条件把这一天并进来：色表必须覆盖这一次真正要画的**全部**条目。
  // 少一个，那个应用就会回落成 var(--line-2)（灰）—— 一片灰看着就是"颜色全变成一个样"。
  if (d) days.push(d);
  if (!days.length) return calColors([]);
  return calColors(days);
}

/** 聚焦提示条：明确写着"现在看的是哪一项"，也给出撤掉的出口 */
function dayChipHtml(d, colors, hasHit) {
  if (!S.calHit) return '';
  const en = I18N.getLang() === 'en';
  return `<div class="dc-chip${hasHit ? '' : ' off'}">
      <i style="background:${colors.get(S.calHit) || 'var(--text-3)'}"></i>
      <span>${esc(focusName(S.calHit, d))}${hasHit ? '' : (en ? ' · none today' : ' · 这天没有')}</span>
      <button class="dc-x" data-act="focus-clear" title="${en ? 'Clear focus' : '取消聚焦'}">×</button>
    </div>`;
}

/** 当日日历的整块内容（标题行 + 时间轴 + 图例） */
function dayHtml() {
  const en = I18N.getLang() === 'en';
  const date = dayOf();
  const dt = parseYmd(date);
  const wd = DAYS[(dt.getDay() + 6) % 7];
  const d = dayData(date);
  const colors = dayColors(d);
  const blocks = d ? dcBlocks(d, colors) : [];
  const total = (d && d.secs) || 0;
  const nItems = d && d.items ? d.items.length : 0;
  // 聚焦的那一项在今天到底有没有：没有就别把别的块压暗（否则满屏发灰，像坏了）
  const hasHit = !!(S.calHit && blocks.some((b) => b.key === S.calHit));
  const today = date === todayStr();

  // 读数行："共 2 小时 30 分 · 6 项"。复合句在 JS 里拼，不指望词典认得出来
  const sumTxt = en ? `${fmtDurShort(total)} · ${nItems} items` : `共 ${fmtDur(total)} · ${nItems} 项`;
  const head = `<div class="dc-hd">
    <b class="dc-title">当日日历</b>
    <button class="btn btn-sm dc-ar" data-act="day-move" data-d="-1" title="${en ? 'Previous day' : '前一天'}">‹</button>
    <button class="btn btn-sm dc-ar" data-act="day-move" data-d="1" title="${en ? 'Next day' : '后一天'}">›</button>
  </div>
  <div class="dc-sub">
    <b class="dc-date${today ? ' today' : ''}">${date.slice(5)} <span>${wd}</span></b>
    <span class="dc-sum" id="dcSum" data-def="${sumTxt}">${sumTxt}</span>
    ${today ? '' : '<button class="dc-today" data-act="day-today">今天</button>'}
  </div>`;

  // 聚焦条固定占一行（.dc-slot）：有/没有聚焦都不动时间轴的位置，
  // 否则选中的那一刻轨道会被顶下去 24px，看起来就像"闪了一下"。
  const chip = `<div class="dc-slot">${dayChipHtml(d, colors, hasHit)}</div>`;

  if (!d) return `${head}${chip}<div class="dc-loading">正在载入…</div>`;
  if (!blocks.length) {
    return `${head}${chip}<div class="empty dc-empty"><span class="ico">▤</span>这一天没有使用记录。</div>`;
  }

  let gaps = '';
  let cur = 0;
  for (const b of blocks) {
    if (b.f - cur >= 30) gaps += dcGap(cur, b.f);
    cur = Math.max(cur, b.t);
  }
  if (1440 - cur >= 30) gaps += dcGap(cur, 1440);

  const evs = blocks.map((b) => {
    const px = ((b.t - b.f) / 1440) * DC_H;
    const hPct = ((b.t - b.f) / 1440) * 100;
    const on = hasHit && b.key === S.calHit;
    const off = hasHit && !on;
    // 很薄的段（< 8px，约 25 分钟以内）用光晕而不是描边：描边会把它自己的颜色盖掉
    const thin = px < 8 ? ' thin' : '';
    const tm = hhmmOfMin(b.f) + '–' + hhmmOfMin(b.t);
    // 读数只留"时段 · 名称"：时长本来就由色块高度表达；时刻放最前面，
    // 窄列里被省略号截掉的是名字尾巴，而不是"几点到几点"。
    const tip = `${tm} · ${b.label}`;
    return `<button class="dc-ev${on ? ' hit' : ''}${off ? ' off' : ''}${thin}" data-act="day-ev"
      data-key="${esc(b.key)}" data-tip="${esc(tip)}"
      style="top:${(b.f / 1440) * 100}%;height:${Math.max(hPct, (DC_MIN / DC_H) * 100)}%;background:${b.c}">
      ${px >= 18 ? `<span class="dc-n">${esc(b.label)}</span>` : ''}
      ${px >= 36 ? `<span class="dc-t">${tm}</span>` : ''}
    </button>`;
  }).join('');

  const nowMin = dt.getHours() * 60 + dt.getMinutes();
  const nowLine = today ? `<i class="dc-now" style="top:${(nowMin / 1440) * 100}%"></i>` : '';
  const axis = [0, 6, 12, 18, 24]
    .map((h) => `<span style="top:${(h / 24) * 100}%">${pad(h)}:00</span>`).join('');

  // 图例就是"颜色 → 名字"的对照：色块太薄写不下字时靠它认
  const items = d.items || [];
  const legend = `<div class="dc-lg">${items.slice(0, 6).map((it) => `<button
      class="dc-lg-i${it.key === S.calHit ? ' on' : ''}" data-act="day-ev" data-key="${esc(it.key)}"
      title="${esc(it.label)} · ${dcDur(it.secs)}">
      <i style="background:${colors.get(it.key) || 'var(--line-2)'}"></i>${esc(it.label)}</button>`).join('')
    }${items.length > 6 ? `<span class="dc-lg-more">+${items.length - 6}</span>` : ''}</div>`;

  return `${head}${chip}
  <div class="dc-body">
    <div class="dc-axis"><div class="dc-axis-in">${axis}</div></div>
    <div class="dc-track">${gaps}${evs}${nowLine}</div>
  </div>${legend}`;
}

/** 只重画当日日历（不整页重建：卡片右侧这一块独立更新，点一下不会带着整页闪） */
function paintDay() {
  const body = $('#dayBody');
  if (!body) return;
  body.innerHTML = dayHtml();
  if (window.I18N && I18N.apply) I18N.apply(body);
  // 默认读数（"共 X · N 项"）翻译后再记下来：悬停结束后原样还原
  const sum = body.querySelector('#dcSum');
  if (sum) sum.dataset.def = sum.textContent;
}

/** 只改"聚焦"相关的 class，不重建 DOM。
 *
 *  以前点一下色块会把整块当日日历（连带下面整张周/月网格）innerHTML 重写一遍：
 *  节点全换新、过渡从零开始、布局重排一次 —— 眼睛看到的就是"闪一下"。
 *  现在只切 class：高亮/压暗走 .13s 过渡，节点不换、位置不动。
 */
function paintFocus() {
  const body = $('#dayBody');
  if (!body) return;
  const key = S.calHit || '';
  const evs = body.querySelectorAll('.dc-ev[data-key]');
  let hasHit = false;
  evs.forEach((e) => {
    if (key && e.dataset.key === key) hasHit = true;
  });
  evs.forEach((e) => {
    const on = hasHit && e.dataset.key === key;
    e.classList.toggle('hit', on);
    e.classList.toggle('off', hasHit && !on);
  });
  body.querySelectorAll('.dc-lg-i').forEach((e) => {
    e.classList.toggle('on', !!key && e.dataset.key === key);
  });
  const slot = body.querySelector('.dc-slot');
  if (slot) {
    const d = dayData(dayOf());
    const html = dayChipHtml(d, dayColors(d), hasHit);
    if (slot.innerHTML !== html) {
      slot.innerHTML = html;
      if (window.I18N && I18N.apply) I18N.apply(slot);
    }
  }
}

/** 只挪网格里"选中那一天"的高亮：‹ › 翻天不用重建整张网格 */
function paintCalSel() {
  const body = $('#calBody');
  if (!body) return;
  body.querySelectorAll('[data-date]').forEach((el) => {
    el.classList.toggle('on', el.dataset.date === S.calSel);
  });
  const lab = $('.cal-label');
  if (lab) lab.textContent = calRangeLabel();
}

/** 只同步周/月网格上的"聚焦"描边：同样不重建网格 */
function paintCalFocus() {
  const body = $('#calBody');
  if (!body) return;
  const key = S.calHit || '';
  body.querySelectorAll('[data-key]').forEach((el) => {
    el.classList.toggle('hit', !!key && el.dataset.key === key);
  });
  const cells = body.querySelectorAll('.cm-cell');
  if (!cells.length) return;
  cells.forEach((cell) => {
    cell.classList.toggle('has-hit', !!key && cell.querySelector('.cm-bar i.hit') != null);
  });
}

/** 当日日历卡片脉冲一下：点扇区时"右边这块就是它"要看得见 */
function flashDay() {
  const card = $('#dayCard');
  if (!card) return;
  card.classList.remove('cal-flash');
  void card.offsetWidth;      // 强制回流：连点两次也要重播一次高亮
  card.classList.add('cal-flash');
  clearTimeout(flashDay._t);
  flashDay._t = setTimeout(() => card.classList.remove('cal-flash'), 2000);
}

/** 滚到「使用时长分布」并让当日日历脉冲一下：从日历点一天后"数据在眼前" */
function scrollToDist() {
  const card = $('#distCard');
  if (!card) return;
  if (card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  flashDay();
}

/** 悬停读数：把具体时刻写到标题行 —— 不占轨道、也不会让块跳动 */
function dcRead(tip) {
  const el = $('#dcSum');
  if (!el) return;
  const v = tip || el.dataset.def || '';
  if (el.textContent !== v) el.textContent = v;
}

/** 时间范围变了，日历跟着落到同一个周期。
 *
 *  不这么做就会出现"上面是今日、下面是本周"的错位：
 *  两边统计窗口不同，数字自然对不上，看起来就是"哪里不对"。
 */
function calFollowRange() {
  const now = new Date();
  if (S.range === 'today') S.calAnchor = todayStr();
  else if (S.range === 'week') S.calAnchor = dateStr(weekStartOf(now));
  else if (S.range === 'month') S.calAnchor = dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
  else if (S.range === 'year') S.calAnchor = dateStr(new Date(now.getFullYear(), 0, 1));
  else if (S.range === 'custom') S.calAnchor = S.customStart || todayStr();
  // 当日日历落到同一周期的"今天"：区间里没有今天就退到区间的最后一天
  // （否则切到「本月」还盯着上个月某一天，看起来就是两边对不上）
  const bd = boundsOf(S.range);
  const t = todayStr();
  S.dayDate = (t >= bd[0] && t <= bd[1]) ? t : bd[1];
  S.calSel = S.dayDate;
  S.calKey = '';   // 强制重取
}

function calHtml() {
  const days = S.cal;
  if (!days) return '<div class="cal-loading">正在载入…</div>';
  if (!days.length) return '<div class="empty"><span class="ico">▤</span>这段时间还没有数据。</div>';
  const colors = calColors(days);
  // 只画网格：选中那天的细则已经搬到饼图右侧的「当日日历」里，
  // 这里再放一份就是同一份数据看两遍（而且会把卡片撑很高）。
  return S.calMode === 'month' ? calMonthHtml(days, colors) : calWeekHtml(days, colors);
}

/** 只重画日历卡片（不整页重建，滚动位置和焦点都不动） */
function paintCal() {
  const body = $('#calBody');
  if (body) {
    body.innerHTML = calHtml();
    // render() 里的翻译是在这一块**之前**跑的；日历数据是异步到的，
    // 这里换完 innerHTML 必须再翻一次，否则英文界面下会露出中文。
    if (window.I18N && I18N.apply) I18N.apply(body);
  }
  const lab = $('.cal-label');
  if (lab) lab.textContent = calRangeLabel();
  document.querySelectorAll('[data-act="cal-mode"]').forEach((b) => {
    const on = b.dataset.m === S.calMode;
    b.classList.toggle('active', on);
    b.classList.toggle('gold', on);
  });
}

async function calLoad() {
  const r = calRange();
  S.calKey = r.key;             // 先记指纹：失败也不会被每帧重试打爆
  S.cal = null;
  S.calPending = true;          // 当日日历据此等待，不为同一天再发一个请求
  paintCal();
  paintDay();
  try {
    S.cal = await invoke('stats_calendar', { start: r.start, end: r.end, tab: r.tab });
  } catch (e) {
    S.cal = [];
  }
  S.calPending = false;
  paintCal();
  // 网格回来了，当天那份数据大概率就在里面：不用再单独请求
  paintDay();
}

/** 进入统计页时保证有数据（区间没变就不重复请求） */
function calEnsure() {
  if (S.calKey === calRange().key && S.cal) return;
  calLoad();
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

  <div class="card" id="distCard">
    <div class="card-title">
      使用时长分布 · ${cur.label}
      <span class="badge">合计 ${fmtDur(cur.total)}</span>
    </div>
    <div class="hint" style="margin-bottom:6px">统计口径：只计入你在电脑前的时间；离开超过 1 分钟（无键鼠输入）的那段不计入。</div>
    <div class="card-sub">
      ${S.statsTab === 'on'
        ? '这里<b>只统计自律模式开启时段</b>内的前台使用时长，与"未开启"的数据完全隔离。'
        : S.statsTab === 'off'
          ? '这里<b>只统计自律模式未生效时段</b>内的前台使用时长，与"已开启"的数据完全隔离。'
          : '汇总口径：把「已开启」与「未开启」两个数据集里同一个应用 / 同一个域名的秒数直接相加，不做任何加权；扇区大小 = 该项在所选时间段内的前台使用总时长占比。'}
    </div>
    <div class="stats-split">
      <div class="stats-pie">
        ${cur.slices.length ? '<div class="chart-wrap"><canvas id="pie" width="620" height="360"></canvas></div>'
    : `<div class="empty"><span class="ico">▤</span>这个时间段还没有数据。<br>统计每秒采样一次前台窗口，用一会儿就会有了。</div>`}
      </div>
      <div class="stats-day" id="dayCard">
        <div id="dayBody">${dayHtml()}</div>
      </div>
    </div>
    ${cur.slices.length ? '<div id="pieDetail" class="pie-detail-host" data-key=""></div>' : ''}
  </div>

  <div class="card" id="calCard">
    <div class="card-title">
      时间日历
      <div class="seg cal-seg">
        <button class="${S.calMode === 'week' ? 'active gold' : ''}" data-act="cal-mode" data-m="week">周</button>
        <button class="${S.calMode === 'month' ? 'active gold' : ''}" data-act="cal-mode" data-m="month">月</button>
      </div>
    </div>
    <div class="cal-nav">
      <button class="btn btn-sm" data-act="cal-move" data-d="-1" title="上一页">‹</button>
      <span class="cal-label">${calRangeLabel()}</span>
      <button class="btn btn-sm" data-act="cal-move" data-d="1" title="下一页">›</button>
      <button class="btn btn-sm" data-act="cal-today">今天</button>
      <span class="hint" style="margin-left:auto">每个色块就是一种软件；点任意一天，右边「当日日历」就跟着换到那天。</span>
    </div>
    <div id="calBody">${calHtml()}</div>
  </div>

  ${cur.slices.length ? `
  <div class="card">
    <div class="card-title">24 小时分布</div>
    <div class="card-sub">每个小时累计的秒数，可以看出你在什么时间最投入。</div>
    <div class="hourly">
      ${hourly.map((v) => `<div class="hbar ${v === 0 ? 'zero' : ''}" style="height:${Math.max(1, (v / maxH) * 100)}%" title="${Math.round(v / 60)} 分钟"></div>`).join('')}
    </div>
    <div class="hlabels">${Array.from({ length: 24 }, (_, i) => `<span>${i}</span>`).join('')}</div>
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
      </div>`).join('') : '<div class="empty"><span class="ico">⛁</span>还没有本地备份。点「立即备份」生成第一份。</div>'}
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
    <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
      <div><div style="font-size:12.5px">使用手册</div><div class="hint" style="margin-top:4px">右键怎么用、积分怎么算、睡眠时段怎么生效，都在这里</div></div>
      <button class="btn btn-sm" data-act="open-help">打开</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">这个版本改了什么</div>
    <div class="card-sub">只列会改变你手感的几条，细节看「帮助」。</div>
    <div class="evlist">
      <div class="ev"><span class="t">修复</span><span class="n">跨天拖动不再在中间那天多出幽灵时段（02:10–03:10 拖走就是拖走）</span></div>
      <div class="ev"><span class="t">交互</span><span class="n">右键分三档：表头 = 整天、段 = 只这一段、空白格 = 这一格</span></div>
      <div class="ev"><span class="t">新增</span><span class="n">图表显示范围；睡眠时段（锁定 + 倒计时关机 + 积分解锁）</span></div>
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

  ${sec('4 · 生效时间段：右键改哪里，就只改哪里', `
     <div>完整图表里有三种右键目标，每张菜单顶部都写着"作用于 …"，三档互不越界。</div>
    <div class="note" style="margin:10px 0 0;line-height:2">
      <div>右键日期表头（周一 / 周二…）= 整天：弹出来第一眼就是这一天排了什么（每段的起止、时长、节奏，可逐段取消），下面才是「选中整天」「清空整天」这类整天级操作，只作用于这一天 0:00–24:00。</div>
    <div>图表右上角的「完整展示」开关：开着时整张表一次铺满、不用滚动；关掉回到固定行高，可以滚着看细节。</div>
      <div>右键某一段 = 时段：只作用于这一段（段首到段尾，跨小时也完整），可改时长、起止分钟，或「取消这一段」（两步确认）。</div>
      <div>右键空白格 = 格子：只作用于这一小时，把它选上并设定起止分钟。</div>
    </div>
    <div>一句话：点得越具体，作用范围越小——不会出现"右键一段、却把一整天重排"的情况。</div>
    <div>拖选是"从起点到终点的一段连续区间"，松手即提交；贴着 0:00 / 24:00 的段只属于当天，不会牵连相邻那天。</div>
    <div>按住某一段的上边缘或下边缘（5px 内，光标变成上下箭头）可以拉长或缩短它；最短一格，最长到显示范围的尽头。</div>
    <div>图表顶部还能设「显示范围」：只看 07:00–23:00 也行，只影响显示，范围外的时段照样生效。</div>
  `)}

  ${sec('5 · 睡眠管理', `
    <div>和自律时段是两件事：那边管"白天什么时候不许玩"，这里管"夜里这台机器该关着了"。</div>
    <div>到了睡眠时段，开机 / 唤醒后会全屏锁定、限制所有功能，倒计时（默认 10 分钟，可改）结束自动关机。</div>
    <div>锁定期内设置改不了、程序也退不掉。想现在用，只能用积分解锁买断一段时间（价格在卡片里配）。</div>
    <div>可以有多段：比如午睡 13:00–14:00 只关机不锁屏，夜间 23:00–07:00 才全屏锁定。点「＋ 添加时段」就多一段。</div>
    <div>每段都能单独设「生效周期」：每天、仅工作日、指定星期几。</div>
    <div>每天适合固定作息；仅工作日适合周末晚睡晚起；指定适合「只在周日晚上早睡」这类安排。</div>
    <div>切周期只改「哪几天生效」，时间、锁屏、开机后多久关机都不会被改动。</div>
    <div>前提是程序在运行；睡眠时段之外它什么都不做。</div>
    <div>睡眠到点后会锁定、会关机，但<b>不会</b>替你开机——软件叫不醒一台关着的电脑（那要在 BIOS 里设定时开机）。</div>
    <div>想在自律时自动开好工作窗口，用「自律规则 → 自动打开」：那里会在每个专注段开始时把软件 / 网页摆好。</div>
  `)}

  ${sec('6 · 固化与积分', `
    <div>「固化」打开后，生效期间不能退出程序、不能改任何设置，任务管理器会被自动关掉；进程被杀掉会被守护进程在 2 秒内拉回来。</div>
    <div>解除只有两条路：时段结束，或者用积分解锁。</div>
    <div>专注每分钟 +1 分；自律时段按分钟买（15 分/分钟起，当天第 n 次 ×1.4）。</div>
    <div>睡眠时段按段买断（单价 × 分钟数，各自在卡片里配）。</div>
    <div>固化只在自律时间内生效，且自律时段本身的结束时间就是最晚解封时刻，不会把自己永久锁死。</div>
  `)}

  ${sec('7 · 专注遮罩', `
    <div>选一个目标窗口，其余区域被遮罩盖住；不透明度 20%–100% 实时可调，没有任何动画，开关是瞬时到位。</div>
    <div>两种开启方式：全局快捷键（默认 Ctrl+Alt+K，可在遮罩页改，被占用会报错），或者「跟随自律模式」——自律一开始自动开、结束自动关。</div>
  `)}

  ${sec('8 · 统计与报告', `
    每秒采样一次前台窗口；按「自律模式开启 / 未开启」两套数据独立记录，互不混合。
    前台是浏览器且插件上报过，就记到域名上，否则记到 exe 上。<br>
    统计页显示的是<b>软件名</b>（取自程序版本信息）和<b>页面标题</b>，同一个网址下的多个页面会按网址归并成一行。<br>
    报告在日/周/月/年结束后自动生成（程序没开会下次启动补齐），也可以手动生成。
    三种口径：只看开启、只看未开启、两者汇总（同一应用/域名秒数直接相加）。
  `)}

  ${sec('9 · 备份与云同步', `
    本地备份在软件目录下的 <code>king of focus back</code>，写盘前加密（设了密码用 AES-256-GCM，
    没设密码用本机 DPAPI）。只保留最近 10 份、7 天内的，超出自动删。<br>
    云端备份走你自己的 WebDAV：上传后可以列出所有历史版本，任选一份恢复。
    「立即同步」只同步自律规则和设置，不做版本归档。
  `)}

  ${sec('10 · 常见问题', `
    <b>拦截没反应？</b> 目标程序是管理员权限，就右键以管理员身份运行本程序。<br>
    <b>网页没拦住？</b> 插件没装或没连上，看侧边栏「浏览器插件」状态。<br>
    <b>右键怎么只改了一段？</b> 这是设计：段右键只管那一段；要改整天请右键日期表头。<br>
    <b>想临时放过自己？</b> 用「总览 → 积分兑换」解锁当前这一段（固化了才需要）。<br>
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
      // 命中条目要带**版本号**：装了两份、或装的是旧版时，光看"启用/停用"分不出来，
      // 用户排查"到底哪一份在生效"就只能靠这个。多份时再补一句提示。
      const hitsList = b.hits || [];
      const hits = hitsList.length
        ? `<div class="hint">命中配置档：${hitsList.map((h) => `${esc(h.profile)}${h.version ? ` v${esc(h.version)}` : ''}（${h.enabled ? '启用' : '停用'}）`).join('、')}</div>`
          + (hitsList.filter((h) => h.unpacked).length > 1
            ? '<div class="hint">检测到多份解压加载记录，只保留一份即可；多余的可在扩展页移除，不影响拦截。</div>'
            : '')
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
    : '<div class="empty"><span class="ico">◉</span>还没检测。点右上角「重新检测」。</div>';

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
/** 把一侧的标签按"理想位置"推挤成互不重叠的一列，返回新的 y（与输入同序）。
 *
 *  三步，和绘图库里那套一样：
 *   1. 按理想 y 排序，从上往下保证最小间距；
 *   2. 再从下往上兜住底边（否则最后几条会出画布）；
 *   3. 条目多到连底边都兜不住时，按可用高度均分压缩——宁可挤一点，也不能越界。
 */
function packLabels(wantY, top, bottom, gap) {
  const n = wantY.length;
  if (!n) return [];
  const order = wantY.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);

  let cursor = top;
  for (const x of order) {
    x.y = Math.max(x.y, cursor);
    cursor = x.y + gap;
  }
  let limit = bottom;
  for (let k = n - 1; k >= 0; k--) {
    if (order[k].y > limit) order[k].y = limit;
    limit = order[k].y - gap;
  }
  if (order[0].y < top) {
    const step = n > 1 ? Math.min(gap, (bottom - top) / (n - 1)) : 0;
    order.forEach((x, k) => { x.y = top + k * step; });
  }

  const out = new Array(n);
  order.forEach((x) => { out[x.i] = x.y; });
  return out;
}

/** 文字超宽就截断加省略号（canvas 不会自动省略，会直接画出画布） */
function clipText(ctx, str, maxW) {
  if (!str) return '';
  if (ctx.measureText(str).width <= maxW) return str;
  let t = str;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** 分钟数 → "09:12" */
function hhmmOfMin(min) {
  const m = Math.max(0, Math.min(1440, Math.round(min || 0)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** 量文字宽度用的离屏 ctx：布局阶段就要知道每个标签占多宽（命中测试也靠它） */
let __pieM = null;
function pieMeasure(text, font) {
  if (!__pieM) __pieM = document.createElement('canvas').getContext('2d');
  __pieM.font = font;
  return __pieM.measureText(String(text == null ? '' : text)).width;
}

/** 按**实测字宽**截断（布局阶段就定下来，画的时候不再变，避免悬停时文字长度跳动） */
function clipText2(str, font, maxW) {
  const t0 = String(str == null ? '' : str);
  if (!t0 || pieMeasure(t0, font) <= maxW) return t0;
  let t = t0;
  while (t.length > 1 && pieMeasure(t + '…', font) > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** 时长文案：英文界面走短格式（canvas 不经过 DOM 翻译，混着写会露出中文） */
function pieDur(secs) {
  return I18N.getLang() === 'en' ? fmtDurShort(secs) : fmtDur(secs);
}

const PIE_W = 660;
/** 一行两排字（名称 + 时长）的最小行距 */
const PIE_ROW = 34;
/** 画布上下留白。
 *
 *  这就是"折线"的根源：以前上下只留 24px，标签被压在最上/最下一行，
 *  而顶部扇区的弧点本来就在 cy - rOut 附近 —— 标签比弧点还高一截，
 *  连线只能先折出去再折回来，看着就是"中途突兀一拐"。
 *  留 72px 之后，最高/最低的标签与扇区顶部基本同高，线几乎是直的。 */
const PIE_PAD = 72;
const PIE_NAME_FONT = '600 11.5px "Microsoft YaHei UI", sans-serif';
const PIE_DUR_FONT = '10.5px "Microsoft YaHei UI", sans-serif';
const PIE_NAME_FONT_ON = '700 13px "Microsoft YaHei UI", sans-serif';
const PIE_DUR_FONT_ON = '600 11px "Microsoft YaHei UI", sans-serif';

/** 扇图布局：扇区 + 标签位置一次性算好，绘制时不再重排。
 *
 *  为什么必须"算一次、画很多次"：
 *   · 悬停只改颜色 / 字重 / 字号，**位置一个都不动**，否则鼠标一过就"跳一下"；
 *   · 连线要正交且互不交叉，靠的是"标签行序 == 扇区角序"，
 *     这个顺序在这里定死，之后每帧都照着画。
 */
function pieLayout(slices, total) {
  const items = slices.slice(0, 8).map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }));
  const restItems = slices.slice(8);
  const restSecs = restItems.reduce((a, b) => a + b.secs, 0);
  if (restSecs > 0) {
    const hours = new Array(24).fill(0);
    for (const s of restItems) {
      const hs = s.hours || [];
      for (let h = 0; h < 24; h++) hours[h] += hs[h] || 0;
    }
    items.push({
      key: '__rest',
      label: I18N.t('其他'),
      secs: restSecs,
      category: 'rest',
      color: '#4a5468',
      hours,
      // 点开「其他」也要看得到时间段：把成员的段并过来并带上名字，
      // 否则这一块就是"有总时长、没有明细"的死角。
      spans: restItems.reduce((acc, s) => acc.concat((s.spans || []).map((sp) => ({
        date: sp.date, f: sp.f, t: sp.t, label: s.label || s.key,
      }))), []),
      spanCount: restItems.reduce((a, s) => a + (s.spanCount || (s.spans || []).length), 0),
      members: restItems.map((s) => s.label || s.key),
    });
  }

  const sum = items.reduce((a, b) => a + b.secs, 0);
  const cx = PIE_W / 2;
  // 画布加宽到 660、环也放大一点：左右各留 190px 放标签，两侧对称
  const rOut = 104;
  const rIn = 66;

  const arcs = [];
  let ang = -Math.PI / 2;
  for (const it of items) {
    const a = sum > 0 ? (it.secs / sum) * Math.PI * 2 : 0;
    arcs.push({ it, a0: ang, a1: ang + a, mid: ang + a / 2 });
    ang += a;
  }

  // 先按角度分左右两列，才知道要几行、画布该多高
  const sides = { left: [], right: [] };
  for (const arc of arcs) {
    const cos = Math.cos(arc.mid);
    const sin = Math.sin(arc.mid);
    sides[cos >= 0 ? 'right' : 'left'].push({ arc, cos, sin });
  }
  const rows = Math.max(sides.left.length, sides.right.length, 1);
  // 高度同时满足两件事：
  //   · 圆环本身要放得下（2 × (rOut + 留白)）；
  //   · 行数多时按行加起来，而不是把行距压扁。
  // 这样无论 1 项还是 9 项，顶部/底部都有 PIE_PAD 的呼吸空间，
  // 标签的"理想高度"就是扇区弧点的高度 —— 不需要绕行。
  const H = Math.max(2 * (rOut + PIE_PAD), PIE_PAD * 2 + rows * PIE_ROW);
  const cy = H / 2;
  const TOP = PIE_PAD;
  const BOT = H - PIE_PAD;

  const labels = [];
  for (const side of ['left', 'right']) {
    const list = sides[side];
    if (!list.length) continue;
    const right = side === 'right';
    // 理想高度直接用**弧点所在的高度**（rOut + 3，与 p0y 同一个半径）：
    // 以前这里多加了 9px，标签天生就比弧点低一截，再叠加挤动，线就必须折一下。
    const ys = packLabels(list.map((x) => cy + x.sin * (rOut + 3)), TOP, BOT, PIE_ROW);
    list.forEach((x, i) => { x.y = ys[i]; });

    // 行序 = 角序（同一侧 sin 单调），按 y 排序拿到的就是"从上到下"；
    // 让每条线的竖直段按这个顺序依次外扩，就保证了任意两条线都不相交。
    const ordered = list.slice().sort((a, b) => a.y - b.y);
    const anchorX = right ? cx + rOut + 48 : cx - rOut - 48;
    const room = right ? (PIE_W - 10) - (anchorX + 8) : (anchorX - 8) - 10;
    // 悬停时字号大一档（11.5 → 13，10.5 → 11），预留余量，
    // 这样"放大"不会让文字突然被截断成另一句。
    const maxW = Math.max(40, room * 0.86);

    ordered.forEach((x, i) => {
      const it = x.arc.it;
      const nameTxt = clipText2(it.label || '', PIE_NAME_FONT, maxW);
      const pct = sum ? ((it.secs / sum) * 100).toFixed(1) : '0.0';
      const durTxt = clipText2(pieDur(it.secs) + ' · ' + pct + '%', PIE_DUR_FONT, maxW);
      labels.push({
        idx: arcs.indexOf(x.arc),
        it,
        right,
        y: x.y,
        anchorX,
        colX: right ? cx + rOut + 14 + i * 2.4 : cx - rOut - 14 - i * 2.4,
        p0x: cx + x.cos * (rOut + 3),
        p0y: cy + x.sin * (rOut + 3),
        straight: Math.abs(x.y - (cy + x.sin * (rOut + 3))) <= 14,
        pts: pieLeadPts(
          cx + x.cos * (rOut + 3),
          cy + x.sin * (rOut + 3),
          right ? 1 : -1,
          anchorX,
          x.y,
        ),
        nameTxt,
        durTxt,
        textW: Math.max(pieMeasure(nameTxt, PIE_NAME_FONT), pieMeasure(durTxt, PIE_DUR_FONT)),
      });
    });
  }

  return { items, arcs, labels, sum, cx, cy, rOut, rIn, W: PIE_W, H, total };
}

/** 一条引导线的路径点（采样成折线，绘制和命中用同一份数据）。
 *
 *  两种形状：
 *   · 标签与弧点几乎同高（|dy| ≤ 14）→ 一条**直线**，中途没有任何拐点；
 *   · 被别的标签挤开了 → 一条**两端都是水平切线**的三次贝塞尔（S 形）。
 *
 *  为什么不再用"斜线 + 直角/圆角 + 水平"：那种折法在落差大时会出现一个
 *  看得见的尖角，也就是用户说的"中途突兀的弯折"。S 形曲线两端都与水平相切，
 *  视觉上是从圆周"顺出去"，再平滑地贴到标签那一行，没有折角。
 */
function pieLeadPts(p0x, p0y, dir, anchorX, y) {
  // **一律直线**：从扇区外缘直接连到标签的锚点，中途不拐弯、不带弧度。
  // 上下留白（PIE_PAD）已经把标签的高度对齐到弧点，所以直线基本都是水平或微斜的；
  // 只有被同侧标签挤开时才会略微倾斜 —— 但仍然是**一条直线**，不会出现"弯"。
  // （dir 保留在签名里，调用方不用改；命中测试和绘制共用这份点。）
  return [[p0x, p0y], [anchorX, y]];
}

/** 点到线段距离（命中测试用） */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 画一帧。`hover` = 高亮项索引（-1 无），`t` = 高亮强度 0..1。 */
function drawPieFrame(cv) {
  const d = cv.__pie;
  if (!d) return;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, d.W, d.H);

  const { cx, cy, rOut, rIn, sum, arcs, labels } = d;
  const hover = d.hover;
  const t = d.t || 0;
  const dim = 1 - 0.6 * t;           // 非高亮项压暗的程度
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
    for (let i = 0; i < arcs.length; i++) {
      const a = arcs[i];
      const on = hover === i;
      const fo = d.focus === i;   // 被选中的那一项（点过扇区/日历色块）
      const grow = on ? 5 * t : 0;
      // 悬停优先：没悬停时按"聚焦"把其余项压暗，选中状态一眼可见
      ctx.globalAlpha = (hover < 0 || on) ? 1 : dim;
      if (hover < 0 && d.focus >= 0 && !fo) ctx.globalAlpha = 0.42;
      ctx.beginPath();
      ctx.arc(cx, cy, rOut + grow, a.a0, a.a1);
      ctx.arc(cx, cy, rIn, a.a1, a.a0, true);
      ctx.closePath();
      ctx.fillStyle = a.it.color;
      ctx.fill();
      ctx.strokeStyle = cStroke;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (fo && hover < 0) {
        // 聚焦项压一道"字色"描边（深色下亮边、浅色下暗边）—— 不动几何，只加一圈
        ctx.beginPath();
        ctx.arc(cx, cy, rOut + 2, a.a0, a.a1);
        ctx.strokeStyle = cText;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (on && t > 0.02) {
        // 外沿再压一道淡亮边：高亮的扇区轮廓更清楚
        ctx.beginPath();
        ctx.arc(cx, cy, rOut + grow - 1, a.a0, a.a1);
        ctx.strokeStyle = cText;
        ctx.globalAlpha = 0.32 * t;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // 中心文字（不参与高亮，避免闪）
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = cText;
  ctx.font = '600 19px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(d.center, cx, cy - 7);
  ctx.fillStyle = cDim;
  ctx.font = '11px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(d.sub, cx, cy + 13);

  if (sum <= 0) return;

  /* ── 引导线：一段斜线（扇区 → 本行拐点）+ 一段水平线（拐点 → 标签） ──
   *
   *  为什么这样能保证"零交叉"：
   *   ① 同侧标签的**行序**与**扇区角序**严格一致（pieLayout 里定的），
   *      所以从圆周发出的斜线是一把"扇"，后一行的落点一定在前一行下面，互不穿越；
   *   ② 每条线的竖直落点各自占一列（colX 每行外扩 2.4px），
   *      第 i 行的水平段整段都在第 j<i 行竖直落点的外侧，够不着；
   *   ③ 水平段各在自己的行高上（行距 34px），彼此不重叠。
   *
   *  以前是「扇区 → 水平 → 竖直 → 水平」的三段折线：拐点挤在圆周外侧，
   *  数据一倾斜（比如一项占 95%）就有大量短横线互相穿过，看着就是一团乱麻。
   */
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const lb of labels) {
    const on = hover === lb.idx;
    const fo = d.focus === lb.idx;
    const alpha = hover < 0 ? (d.focus >= 0 ? (fo ? 1 : 0.3) : 0.82) : (on ? 1 : 0.16);

    ctx.beginPath();
    ctx.moveTo(lb.pts[0][0], lb.pts[0][1]);
    for (let i = 1; i < lb.pts.length; i++) ctx.lineTo(lb.pts[i][0], lb.pts[i][1]);
    // 先描一层底色再压本色：并行的段也能分辨（同地图路线）
    ctx.strokeStyle = cStroke;
    ctx.globalAlpha = alpha * (on ? 0.95 : 0.72);
    ctx.lineWidth = on ? 4.8 : 3.6;
    ctx.stroke();
    ctx.strokeStyle = lb.it.color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 两端各一个小圆点：靠标签那头表示"这一行"，靠扇区那头表示"指的就是这块"
    const dot = hover < 0 || on ? 1 : 0.3;
    ctx.beginPath();
    ctx.arc(lb.anchorX, lb.y, on ? 3.2 : 2, 0, Math.PI * 2);
    ctx.arc(lb.p0x, lb.p0y, on ? 2.4 : 1.6, 0, Math.PI * 2);
    ctx.fillStyle = lb.it.color;
    ctx.globalAlpha = dot;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* ── 标签：全部压在线之上，线不会穿过文字 ────────────────────────── */
  for (const lb of labels) {
    const on = hover === lb.idx;
    const tx = lb.right ? lb.anchorX + 8 : lb.anchorX - 8;
    ctx.textAlign = lb.right ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = hover < 0 || on ? 1 : 0.38;

    // 悬停 = 放大一号 + 加粗 + 染成扇区色。
    // 字号变化**不会**影响其它标签：位置在 pieLayout 里已经算死，
    // canvas 也不会像 DOM 那样回流，所以"放大"和"不跳动"可以同时成立。
    ctx.font = on ? PIE_NAME_FONT_ON : PIE_NAME_FONT;
    ctx.fillStyle = on ? lb.it.color : cText;
    ctx.fillText(lb.nameTxt, tx, lb.y - (on ? 8.5 : 7));

    ctx.font = on ? PIE_DUR_FONT_ON : PIE_DUR_FONT;
    ctx.fillStyle = on ? cText : cDim;
    ctx.fillText(lb.durTxt, tx, lb.y + (on ? 8.5 : 7));
    ctx.globalAlpha = 1;
  }
}

/** 指数逼近地推动高亮强度，起停都有一点过渡，不会"啪"地切换 */
function pieAnimate(cv) {
  const d = cv.__pie;
  if (!d || cv.__raf) return;
  const step = () => {
    d.t += (d.target - d.t) * 0.35;
    if (Math.abs(d.target - d.t) < 0.02) d.t = d.target;
    drawPieFrame(cv);
    cv.__raf = d.t === d.target ? 0 : requestAnimationFrame(step);
  };
  cv.__raf = requestAnimationFrame(step);
}

/** 命中测试：扇区本体、两行标签文字、引导线的**水平段和竖直段**都算。
 *
 *  以前只按"行"判（|y - 行高| <= 13 且越过圆周就算命中），于是：
 *   · 指到一条线旁边的空白也会亮；
 *   · 反过来，指在竖直段上（离行很远）却命中不到 —— 用户说"线点不着"就是这个。
 *  现在按每段线的真实几何走廊判，标签则按**实测文字宽度**判。
 */
function pieHit(cv, ev) {
  const d = cv.__pie;
  if (!d) return -1;
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return -1;
  const x = (ev.clientX - r.left) * (d.W / r.width);
  const y = (ev.clientY - r.top) * (d.H / r.height);

  for (const lb of d.labels) {
    const tx = lb.right ? lb.anchorX + 8 : lb.anchorX - 8;
    const x1 = lb.right ? tx + lb.textW : tx - lb.textW;
    const xa = Math.min(tx, x1) - 4;
    const xb = Math.max(tx, x1) + 4;
    // ① 两行文字（±16 覆盖 13px 名称 + 11px 时长）
    if (y >= lb.y - 17 && y <= lb.y + 16 && x >= xa && x <= xb) return lb.idx;
    // ② 引导线：线只有 1.4px 宽，按到各段折线的距离给 6px 容差才点得着
    for (let i = 1; i < lb.pts.length; i++) {
      const a0 = lb.pts[i - 1];
      const b0 = lb.pts[i];
      if (distToSeg(x, y, a0[0], a0[1], b0[0], b0[1]) <= 6) return lb.idx;
    }
  }

  const dx = x - d.cx;
  const dy = y - d.cy;
  const dist = Math.hypot(dx, dy);
  if (dist >= d.rIn - 4 && dist <= d.rOut + 10) {
    let a = Math.atan2(dy, dx);
    while (a < -Math.PI / 2) a += Math.PI * 2;
    for (let i = 0; i < d.arcs.length; i++) {
      const g = d.arcs[i];
      if (a >= g.a0 && a < g.a1) return i;
    }
  }
  return -1;
}

/** 展开面板：这一项在**哪些时间段**用过。
 *
 *  数据来自分钟级的 `spans`（后端采样时按连续使用分段）。
 *  这里把**所有**段都列出来（列表自身可滚动）——以前只列 12 段，
 *  用户看到的是"明细不全"。真的被后端裁剪时，标题会如实写"共 N 段（列出 M 段）"。
 */
function pieDetailHtml(slice, sum) {
  if (!slice) return '';
  const pct = sum ? ((slice.secs / sum) * 100).toFixed(1) : '0.0';
  const spans = slice.spans || [];
  const hours = slice.hours || [];
  const totalSpans = slice.spanCount || spans.length;

  const bars = Array.from({ length: 24 }, (_, h) => {
    const v = hours[h] || 0;
    const height = Math.max(2, Math.min(100, (v / 3600) * 100));
    return `<i class="${v ? '' : 'off'}" style="height:${height}%" title="${pad(h)}:00 ${I18N.getLang() === 'en' ? Math.round(v / 60) + ' min' : '用了 ' + Math.round(v / 60) + ' 分钟'}"></i>`;
  }).join('');

  const rows = spans.length
    ? spans.map((sp) => {
      const d = String(sp.date || '').slice(5);
      const mins = Math.max(0, (sp.t || 0) - (sp.f || 0));
      const who = sp.label ? `<span class="pd-l">${esc(sp.label)}</span>` : '';
      return `<li>${who}<span class="pd-d">${esc(d)}</span>
        <span class="pd-t">${hhmmOfMin(sp.f)} – ${hhmmOfMin(sp.t)}</span>
        <span class="pd-m">${fmtDur(mins * 60)}</span></li>`;
    }).join('')
    : '<li class="pd-none">这一版开始才有分段记录，更早的数据只有小时分布。</li>';

  const cut = totalSpans > spans.length ? `（列出 ${spans.length} 段）` : '';
  const mem = slice.members && slice.members.length
    ? `<div class="pd-mem">这一块含 ${slice.members.length} 项：${esc(slice.members.join('、'))}</div>`
    : '';

  return `<div class="pie-detail">
    <div class="pd-hd">
      <span class="sw" style="background:${slice.color || 'var(--gold)'}"></span>
      <b>${esc(slice.label || '')}</b>
      <span class="pd-total">${fmtDur(slice.secs)}</span>
      <span class="pd-pct">${pct}%</span>
      <button class="pd-x" data-act="pie-close" title="收起">×</button>
    </div>
    <div class="pd-hours">
      <div class="pd-bars">${bars}</div>
      <div class="pd-ticks">${[0, 6, 12, 18].map((h) => `<span>${pad(h)}:00</span>`).join('')}</div>
    </div>
    ${mem}
    <div class="pd-sub">使用时段 · 共 ${totalSpans} 段${cut}</div>
    <ul class="pd-list">${rows}</ul>
  </div>`;
}

/** 时长扇图：甜甜圈 + 正交引导线 + 悬停强调 + 点击展开明细 */
function drawPie(canvas, slices, total, opts) {
  if (!canvas) return;
  const lay = pieLayout(slices, total);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(lay.W * dpr);
  canvas.height = Math.round(lay.H * dpr);
  canvas.style.width = lay.W + 'px';
  canvas.style.height = 'auto';            // 高度按比例走，窄屏不会被压扁
  canvas.style.touchAction = 'manipulation';

  const prev = canvas.__pie;
  // 数据没变（只是重画）时保留高亮；换了一批数据就把高亮清掉，免得指错项
  const same = prev && prev.items.length === lay.items.length
    && prev.items.every((it, i) => it.key === lay.items[i].key);
  const keep = same ? prev.hover : -1;

  // 选中哪一项由外部状态（S.calHit）决定：重画不能把"选中"丢掉
  const fk = opts && opts.focusKey;
  const focus = fk ? lay.items.findIndex((it) => it.key === fk) : -1;
  canvas.__pie = {
    ...lay,
    center: opts && opts.center ? opts.center
      : (I18N.getLang() === 'en' ? fmtDurShort(total)
        : fmtDurShort(total).replace('h', ' 小时 ').replace('m', ' 分')),
    sub: I18N.t((opts && opts.sub) || '合计'),
    hover: keep,
    focus,
    t: keep >= 0 ? 1 : 0,
    target: keep >= 0 ? 1 : 0,
    raf: 0,
  };

  drawPieFrame(canvas);
  if (canvas.__pieBound) return;
  canvas.__pieBound = true;

  const setHover = (idx) => {
    const d = canvas.__pie;
    if (!d || d.hover === idx) return;
    d.hover = idx;
    d.target = idx >= 0 ? 1 : 0;
    canvas.style.cursor = idx >= 0 ? 'pointer' : 'default';
    pieAnimate(canvas);
  };

  // 指针事件：桌面和触屏统一走 Pointer Events
  canvas.addEventListener('pointermove', (ev) => {
    // 手指没有"悬停"：触屏上移动是滚页面，点亮只会让画面乱跳
    if (ev.pointerType === 'touch') return;
    setHover(pieHit(canvas, ev));
  });
  canvas.addEventListener('pointerleave', () => setHover(-1));
  canvas.addEventListener('pointercancel', () => setHover(-1));
  canvas.addEventListener('pointerup', (ev) => {
    // 触屏点完要收掉高亮，否则会"粘"在某一项上
    if (ev.pointerType === 'touch') setHover(-1);
  });
  canvas.addEventListener('pointerdown', (ev) => {
    const idx = pieHit(canvas, ev);
    if (idx < 0) return;
    if (ev.pointerType === 'touch') setHover(-1);   // 触屏点完不留悬停态
    const it = canvas.__pie.items[idx];
    // 「其他」是聚合块，没有单一分类可指：面板照开，但不做逐块聚焦
    const key = it.key && it.key !== '__rest' ? it.key : '';
    const host = document.querySelector('#pieDetail');
    const dk = key || ('i' + idx);
    const again = !!host && host.dataset.key === dk;
    if (host) {
      if (again) {
        host.dataset.key = '';
        host.innerHTML = '';
      } else {
        host.dataset.key = dk;
        host.innerHTML = pieDetailHtml(it, canvas.__pie.sum);
        if (window.I18N && I18N.apply) I18N.apply(host);   // 面板是点击后才生成的，得单独翻一次
      }
    }
    // 关键联动：右侧「当日日历」立刻切到这一项用时最多的那天，并高亮它的所有时段
    statsFocus(again ? '' : key, again ? '' : bestDayOf(it));
  });
}

/* ---------------- 渲染调度 ---------------- */
/** 睡眠锁屏浮层：盖住整个应用，只留一个「积分解锁」按钮。
 *
 *  为什么要两层：全屏锁屏窗口管"整个桌面"，这一层管"应用内"——
 *  托盘图标、任务栏预览都能把主窗口翻到前面来，光靠窗口层级挡不住，
 *  但盖在 DOM 上的这一层永远在最上面（z-index 高于弹窗与 toast）。
 *  状态每秒跟着 1.5s 轮询刷新，不额外起定时器。
 */
function syncSleepLock() {
  const rt = (S.data && S.data.runtime) || {};
  const st = rt.sleep || {};
  // 卡片上的那句话也跟着秒级刷新（只换文本，不动整页）
  const card = document.querySelector('#sleepCard .sleep-state');
  if (card) {
    const line = sleepStateOf(rt);
    card.className = 'sleep-state ' + line.cls;
    const span = card.querySelector('span:last-child');
    if (span && span.textContent !== line.txt) {
      // 换成一个**新的**文本节点再翻译：i18n 用 WeakMap 记住"原文"，
      // 直接改 nodeValue 会让它以为还是上一句，英文界面下就漏翻。
      span.textContent = '';
      span.appendChild(document.createTextNode(line.txt));
      I18N.apply(span);
    }
  }
  let el = document.getElementById('sleepShield');
  if (!st.locked) {
    if (el) el.remove();
    return;
  }
  const left = Math.max(0, st.remain || 0);
  const mm = Math.floor(left / 60), ss = left % 60;
  const price = st.price || 0;
  const mins = st.unlockMin || 30;
  const afford = (st.balance || 0) >= price && price > 0;
  if (!el) {
    el = document.createElement('div');
    el.id = 'sleepShield';
    el.className = 'sleep-lock';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <div class="sl-box">
      <div class="sl-moon">🌙</div>
      <div class="sl-title">现在是睡眠时间</div>
      <div class="sl-sub">这台电脑该关着了。睡眠时段内的一切功能都被限制。</div>
      <div class="sl-count${left <= 60 ? ' hot' : ''}">
        <b>${pad(mm)}:${pad(ss)}</b><span>${st.shutdown ? '后自动关机' : '（只锁定，不关机）'}</span>
      </div>
      <button class="btn btn-sm sl-btn" data-act="sleep-unlock" ${afford ? '' : 'disabled'}>
        ${price ? `用 ${price} 积分解锁 ${mins} 分钟` : '这段睡眠没有开启积分解锁'}
      </button>
      <div class="sl-foot">
        积分余额 ${st.balance || 0}${afford || !price ? '' : ' · 积分不够'}<br>
        解锁到期后如果还在睡眠时段内，会自动重新锁定。
      </div>
    </div>`;
}

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
    // focusKey：重画时把"选中哪一项"带过去，否则一刷新选中状态就丢了
    drawPie($('#pie'), cur.slices, cur.total, { sub: '累计前台时长', focusKey: S.calHit });
    calEnsure();      // 周/月日历：区间没变就不重复请求
    dayEnsure();      // 当日日历：网格里已有这天就直接复用，不额外请求
  }

  // 内容区刚重绘，节点是中文原文；英文界面下立刻翻一遍
  applyLangView();

  // 睡眠锁屏：主界面也要挡住（锁屏窗口盖住整个桌面，这里管的是"应用内"）
  syncSleepLock();

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
  /** 用积分解锁。
   *
   *  只解"现在正生效的那一段"——所以选项按当前状态给，不摆一堆通用套餐：
   *    · 睡眠时段内 → 买断一次（单价 × 分钟数），走 sleep_unlock
   *    · 自律时段内 → 按分钟买（5/10/15），走 points_unlock
   *    · 都不在     → 明确告诉他现在没有什么要解，别白花积分
   */
  openUnlock() {
    const p = S.data.points;
    const rt = S.data.runtime || {};
    const st = rt.sleep || {};
    const inSleep = !!(st.enabled && st.inWindow && st.price > 0);
    const inDisc = !!(rt.disciplineOn || rt.breakOn);
    const rows = [];

    if (inSleep) {
      const okS = p.balance >= st.price;
      rows.push(`<div class="list-row" style="cursor:pointer;${okS ? '' : 'opacity:.45'}"
          data-act="${okS ? 'do-unlock-sleep' : 'noop'}">
        <span class="badge ${okS ? 'gold' : 'red'}">睡眠时段</span>
        <span class="grow">买断 ${st.unlockMin} 分钟（这一轮睡眠解除锁定，也不关机）</span>
        <span class="tnum" style="color:${okS ? 'var(--gold)' : 'var(--red)'}">${st.price} 分</span>
      </div>`);
    }
    if (inDisc) {
      [5, 10, 15].forEach((m) => {
        const cost = p.price * m;
        const ok = p.balance >= cost;
        rows.push(`<div class="list-row" style="cursor:pointer;${ok ? '' : 'opacity:.45'}"
            data-act="${ok ? 'do-unlock' : 'noop'}" data-min="${m}">
          <span class="badge ${ok ? 'gold' : 'red'}">自律时段</span>
          <span class="grow">解锁 ${m} 分钟自由时间（只解现在这一轮，排班不动）</span>
          <span class="tnum" style="color:${ok ? 'var(--gold)' : 'var(--red)'}">${cost} 分</span>
        </div>`);
      });
    }
    if (!rows.length) {
      rows.push(`<div class="note">现在没有正在生效的自律时段或睡眠时段，<b>不需要解锁</b>。
        到点了再回来——积分不会自己跑掉。</div>`);
    }

    $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal" style="width:580px">
        <div class="modal-hd">
          <h3>用积分解锁</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          <div class="row" style="gap:14px;margin-bottom:16px">
            <div class="mini" style="flex:1"><div class="l">当前积分</div><div class="v" style="color:var(--gold)">${p.balance}</div></div>
            <div class="mini" style="flex:1"><div class="l">自律单价</div><div class="v">${p.price} <span style="font-size:12px;font-weight:400">分/分钟</span></div></div>
            <div class="mini" style="flex:1"><div class="l">睡眠买断</div><div class="v">${inSleep ? st.price : '—'} <span style="font-size:12px;font-weight:400">分</span></div></div>
          </div>
          ${rows.join('')}
          <div class="note" style="margin-top:14px">
            解锁只作用于<b>当前这一段</b>：自律时段按分钟买、单价随当天次数 ×1.4；
            睡眠时段一次买断，到期后如果还在时段内会自动重新锁定。提前结束不退还积分。
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
    if (r === 'custom') { calFollowRange(); render(); return; }
    calFollowRange();
    await loadStats();
    render();
  },
  async applyRange() {
    S.customStart = ($('#cStart') || {}).value || todayStr();
    S.customEnd = ($('#cEnd') || {}).value || todayStr();
    calFollowRange();
    await loadStats();
    render();
  },
  async refreshStats() {
    await loadStats();
    S.dayCache.clear();
    S.calKey = '';      // 手动刷新 = 两边都重取，不当成"区间没变"跳过
    render();
  },

  /* ---- 时间日历 ---- */
  /** 切周/月：**选中日期保持不变**，切到月视图就显示它所在的那个月 */
  async calMode(m) {
    if (m !== 'week' && m !== 'month') return;
    if (S.calMode === m) return;
    S.calMode = m;
    if (S.calSel) S.calAnchor = S.calSel;
    await calLoad();
  },
  /** 翻页：周 ±7 天、月 ±1 月；选中日不动（区间会自动把它包进来） */
  async calMove(d) {
    const base = parseYmd(S.calAnchor || S.calSel || todayStr());
    if (S.calMode === 'month') {
      S.calAnchor = dateStr(new Date(base.getFullYear(), base.getMonth() + d, 1));
    } else {
      S.calAnchor = dateStr(addDays(base, d * 7));
    }
    await calLoad();
  },
  async calToday() {
    S.calAnchor = todayStr();
    S.calSel = todayStr();
    S.dayDate = todayStr();
    await calLoad();
    dayEnsure();
  },
  async calPick(date) {
    if (!date) return;
    // 在「时间日历」里点某一天 = 把整块「使用时长分布」切到那天看：
    // 饼图、当日日历、周月网格三处同一口径（区间按钮会变成「自定义 某天 ~ 某天」，
    // 想回到整周/整月点一下 本周/本月 就行）。以前只换日历、饼图还停在旧区间，
    // 上面的数字和下面的日期对不上，所以这里连区间一起切。
    S.range = 'custom';
    S.customStart = date;
    S.customEnd = date;
    calFollowRange();        // 日历/当日日历/选中日一起落到这个区间（= 这一天）
    S.dayCache.clear();      // 口径变了：单日缓存作废
    await loadStats();
    render();
    // 跳转：把这天对应的数据带到眼前（卡片本身就在视口外）
    scrollToDist();
  },

  /* ---- 当日日历 ---- */
  /** 上下翻一天；跨出网格窗口时窗口一起跟过去，选中日永远看得见 */
  async dayMove(d) {
    const nt = dateStr(addDays(parseYmd(dayOf()), d));
    S.dayDate = nt;
    S.calSel = nt;
    const win = calWindow();
    if (nt < win.start || nt > win.end) S.calAnchor = nt;
    if (S.calKey !== calRange().key) await calLoad();
    else paintCalSel();     // 窗口没变：只挪选中高亮，不重建网格
    dayEnsure();
    paintPieFocus();
  },
  async dayToday() {
    S.dayDate = todayStr();
    S.calSel = todayStr();
    S.calAnchor = todayStr();
    await calLoad();
    dayEnsure();
    paintPieFocus();
  },
  /** 点色块/图例 = 聚焦这个分类（再点一次取消）：饼图、日历、当日日历同时响应 */
  /** 点一个块 = 选中它所属的应用；再点同一个应用（任一段） = 取消。
   *  同一时刻只可能有一个 key 处于选中态，所以"全选"在数据层不可能发生。 */
  focusPick(key) {
    if (!key) return;
    S.calHit = S.calHit === key ? '' : key;
    // 只切 class：不重建节点，选中/切换/取消都不会闪
    paintFocus();
    paintCalFocus();
    paintPieFocus();
  },
  focusClear() {
    S.calHit = '';
    paintFocus();
    paintCalFocus();
    paintPieFocus();
  },

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

  /** 换一条：**立刻**按当前来源取一条。
   *
   *  本地源不联网（秒换）；联网源真的发一次请求，成功就换上、失败就退到本地池。
   *  两条路都保证"点一次，字就变了"——这是这个按钮唯一的承诺。
   */
  async quoteNext() {
    if (S.quoteBusy) return;                 // 连点只认第一次，避免请求打架
    const feed = quoteActiveFeed();
    if (feed.kind === 'local' || !feed.url) {
      Act.quoteLocalNext(feed, false);
      return;
    }
    S.quoteBusy = true;
    render();
    let r = null;
    try {
      r = await invoke('quote_fetch', { id: feed.id });
    } catch (e) {
      r = { ok: false, reason: String(e) };
    }
    S.quoteBusy = false;
    if (r && r.ok && r.text) {
      S.quoteCur = {
        text: r.text,
        from: r.from || '',
        src: r.from ? 'net' : 'local',
        feed: feed.id,
        feedName: r.feedName || feed.name,
        home: r.home || feed.home || '',
        offline: false,
      };
      render();
      toast(`换好了 · 来自 ${r.feedName || feed.name}`, 'ok');
      return;
    }
    // 失败：不弹错误对话框，静默退到本地池，并在标签上写明"离线"
    Act.quoteLocalNext(feed, true);
    toast(feed.kind === 'local' ? '已换一条本地句子' : '联网没取到，先从本地精选里挑了一条', '');
  },

  /** 从本地池换一条。offline=true 时标签改写成「内置精选」，让用户知道这句不是联网来的 */
  quoteLocalNext(feed, offline) {
    const pool = quoteLocalPool();
    if (!pool.length) return;
    const cur = S.quoteCur && S.quoteCur.text;
    let i = S.quoteLocalIdx || 0;
    for (let k = 0; k < pool.length; k++) {
      i = (i + 1) % pool.length;
      if (pool[i].text !== cur) break;       // 别换出一条一模一样的
    }
    S.quoteLocalIdx = i;
    const q = pool[i];
    S.quoteCur = {
      text: q.text,
      from: q.from || '',
      src: q.src,
      feed: feed.id,
      feedName: offline ? '内置精选' : feed.name,
      home: offline ? '' : (feed.home || ''),
      offline: !!offline,
    };
    render();
  },

  /** 点来源标签：有网址就打开（本地句子没有网址，标签是纯装饰） */
  async quoteOpenSrc() {
    const q = quoteView();
    if (!q.home) { toast('内置句子没有对应网址；想换来源可以右键语录', ''); return; }
    try {
      await invoke('open_url', { url: q.home });
    } catch (e) {
      toast('打开网址失败', 'err');
    }
  },

  /** 右键语录 → 来源设置 */
  quoteSrcMenu() {
    S.quoteFeedEdit = null;
    renderQuoteSrcModal();
  },

  /** 切换来源：立刻写盘，并作废当前这条（标签和句子必须同时换） */
  async quotePickFeed(id) {
    const list = quoteFeeds();
    const f = list.find((x) => x.id === id);
    if (!f) return;
    if (f.id === quoteActiveFeed().id) { closeModal(); return; }
    S.data.config.settings.quoteFeed = f.id;
    S.quoteCur = null;
    S.quoteLocalIdx = 0;
    const ok = await saveConfig();
    closeModal();
    render();
    toast(ok ? `语录来源已切换为「${f.name}」` : '来源没有保存成功', ok ? 'ok' : 'err');
    if (ok && f.kind !== 'local') Act.quoteNext();   // 联网源：顺手取一条，别让用户再点一次
  },

  /** 删除自定义来源（内置的不允许删：它是断网时的兜底） */
  async quoteDelFeed(id) {
    const list = quoteFeeds().slice();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (list[i].builtin) { toast('内置来源不能删除', 'err'); return; }
    list.splice(i, 1);
    S.data.config.settings.quoteFeeds = list;
    if (S.data.config.settings.quoteFeed === id) S.data.config.settings.quoteFeed = list[0].id;
    S.quoteCur = null;
    const ok = await saveConfig();
    renderQuoteSrcModal();
    render();
    toast(ok ? `已删除来源「${list[i] ? list[i].name : id}」` : '删除失败', ok ? 'ok' : 'err');
  },

  /** 添加自定义来源：名称 + 地址 + 类型，三条都必须说得清 */
  async quoteAddFeed() {
    const name = (($('#qfeedName') || {}).value || '').trim();
    const url = (($('#qfeedUrl') || {}).value || '').trim();
    const kind = (($('#qfeedKind') || {}).value || 'json').trim();
    if (!name) { toast('给这个来源起个名字', 'err'); const el = $('#qfeedName'); if (el) el.focus(); return; }
    if (!/^https?:\/\//i.test(url)) { toast('地址要以 http:// 或 https:// 开头', 'err'); const el = $('#qfeedUrl'); if (el) el.focus(); return; }
    const list = quoteFeeds().slice();
    if (list.length >= 12) { toast('最多 12 个来源，先删掉一个', 'err'); return; }
    if (list.some((x) => x.url === url)) { toast('这个地址已经加过了', ''); return; }
    const id = 'u' + Date.now().toString(36);
    list.push({ id, name: name.slice(0, 24), kind, url, home: url, builtin: false });
    S.data.config.settings.quoteFeeds = list;
    S.data.config.settings.quoteFeed = id;      // 刚加的就用它，用户马上能看到效果
    S.quoteCur = null;
    const ok = await saveConfig();
    closeModal();
    render();
    toast(ok ? `已添加来源「${name}」并用它取一条` : '来源没有保存成功', ok ? 'ok' : 'err');
    if (ok && kind !== 'local') Act.quoteNext();
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
    S.quoteCur = null;
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
    S.quoteCur = null;
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

  /** 切主题。
   *
   *  **不要在这里 `render()`，也不要 `await saveConfig()`**——这两件事是点
   *  「跟随系统」卡顿的全部来源：
   *    · `saveConfig()` 末尾会 `pull()`（第二个 IPC），并把当前视图整个重绘一次；
   *    · `render()` 再把整页重建一次。
   *  而主题是纯 CSS 变量的：改 `data-theme` 就已经换色了，DOM 一个都不用动。
   *  所以这里只做"立刻生效 + 落盘放后台"，滚动位置和输入焦点都不会丢。 */
  async setTheme(v) {
    const st = S.data.config.settings;
    const prev = st.theme || 'system';
    const msg = v === 'system' ? '已跟随系统外观' : v === 'light' ? '已切换到浅色' : '已切换到深色';
    if (v === prev) { toast(msg, 'ok'); return; }
    st.theme = v;
    applyTheme();        // ① 立刻换色（只改 data-theme，无 DOM 重建）
    paintThemeChoice();  // ② 三个按钮的选中态
    renderChrome();      // ③ 侧栏那行「◐ 跟随系统（浅）」
    const ok = await saveConfigQuiet();   // ④ 只落盘，不回拉
    if (!ok) {
      // 落盘失败：pull() 已经把 S.data 换回后端真实状态，再刷一次按钮态即可
      applyTheme();
      paintThemeChoice();
      renderChrome();
      return;
    }
    toast(msg, 'ok');
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

  /** 休息结束收尾：总开关。
   *
   *  置灰规则：自律时段生效中不能**关掉**（关掉等于放开纪律），
   *  但允许打开（加强）；与「自律时间内启用自律规则」同一个口径。 */
  async sweepToggle() {
    const sw = sweepCfg();
    if (sw.enabled && settingsFrozen()) { guardDiscipline('关闭「休息结束时的收尾」'); render(); return; }
    sw.enabled = !sw.enabled;
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
    toast(sw.enabled
      ? (sw.mode === 'hard'
        ? '休息结束时会关闭休息里打开的黑名单应用'
        : '休息结束时会最小化休息里打开的黑名单应用')
      : '休息结束后不再收起应用，休息里开的会一直留着', 'ok');
  },

  /** 切柔和 / 强制。生效时机是**下一次**「休息 → 学习」的边界，
   *  不会回头去动已经处理过的窗口。 */
  async sweepMode(v) {
    if (settingsFrozen()) { guardDiscipline('调整收尾方式'); render(); return; }
    const sw = sweepCfg();
    sw.mode = v === 'hard' ? 'hard' : 'soft';
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
    toast(sw.mode === 'hard'
      ? '已切成强制：休息结束直接关闭'
      : '已切成柔和：休息结束只最小化，随时能还原', 'ok');
  },

  /** 柔和模式下的"暂停播放中的媒体"。强制模式关掉应用自然就停了，所以这个开关
   *  只在柔和模式下有意义（界面里也是这么灰的）。 */
  async sweepMedia() {
    if (settingsFrozen()) { guardDiscipline('调整收尾时的媒体处理'); render(); return; }
    const sw = sweepCfg();
    sw.pauseMedia = !sw.pauseMedia;
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
    toast(sw.pauseMedia ? '收尾时会把正在播放的媒体暂停' : '收尾时不动媒体（正在放的继续放）', 'ok');
  },

  async clockClear() {
    const prof = clockProfile();
    if (settingsFrozen()) { guardDiscipline('清空已选时段'); return; }
    let n = 0;
    prof.days.forEach((day) => day.forEach((p) => { if (p.on) { p.on = false; p.seg = ''; n++; } }));
    await saveConfig();
    render();
    toast(n ? `已清空 ${n} 个小时段` : '当前没有已选时段', n ? 'ok' : 'err');
  },

  /** 取消某一天的某几段（右键"取消这一段"用）。
   *  只动这几段覆盖的小时，其它时段原样保留——所以它和"清空全部"是两件事。 */
  async clockClearRange(d, h0, h1, label) {
    const prof = clockProfile();
    const wdNow = (new Date().getDay() + 6) % 7;
    const hourNow = new Date().getHours();
    if (settingsFrozen() && wdNow === d && hourNow >= h0 && hourNow <= h1) {
      guardDiscipline('取消正在生效的这一段');
      return false;
    }
    let n = 0;
    for (let h = h0; h <= h1; h++) {
      const p = prof.days[d][h];
      if (p.on) { p.on = false; p.from = 0; p.to = 60; p.seg = ''; n++; }
    }
    if (!n) { toast('这一段本来就没选中', 'err'); return false; }
    const ok = await saveConfig();
    render();
    if (!ok) return false;
    toast(`已取消 ${label || `${WD[d]} ${pad(h0)}:00 – ${pad(h1)}:00`}（${n} 个小时段）`, 'ok');
    return true;
  },

  /** 整天：选中 0:00–24:00（沿用这套的通用时长） */
  async clockDaySelect(d) {
    const prof = clockProfile();
    const w = prof.defWork, b = prof.defBrk;
    // 整天 = 一段：一个 id，避免"选中整天"之后被当成 24 个独立段
    const segId = ccNewSegId();
    for (let h = 0; h < 24; h++) {
      const p = prof.days[d][h];
      p.on = true;
      p.work = w;
      p.brk = b;
      p.from = 0;
      p.to = 60;
      p.seg = segId;
    }
    const ok = await saveConfig();
    render();
    if (!ok) return false;
    toast(`${WD[d]} 整天已选中（0:00–24:00，专注 ${w} 分${b ? ` / 休息 ${b} 分` : ''}）`, 'ok');
    return true;
  },

  /** 整天：清空这一天（其它六天不动） */
  async clockDayClear(d) {
    const prof = clockProfile();
    const wdNow = (new Date().getDay() + 6) % 7;
    const hourNow = new Date().getHours();
    if (settingsFrozen() && wdNow === d && prof.days[d][hourNow].on) {
      guardDiscipline('清空今天正在生效的时段');
      return false;
    }
    let n = 0;
    prof.days[d].forEach((p) => { if (p.on) { p.on = false; p.from = 0; p.to = 60; p.seg = ''; n++; } });
    if (!n) { toast(`${WD[d]} 本来就没有选中任何时段`, 'err'); return false; }
    const ok = await saveConfig();
    render();
    if (!ok) return false;
    toast(`已清空 ${WD[d]} 的 ${n} 个小时段`, 'ok');
    return true;
  },

  /** 整天：只改专注 / 休息，**不动**起止分钟（02:10 这种边界不会被抹平） */
  async clockDayWB(d, w, b, defToo) {
    const prof = clockProfile();
    let n = 0;
    for (let h = 0; h < 24; h++) {
      const p = prof.days[d][h];
      // 没选中的小时也记下来：等它被选上时就是这套时长（和"通用时长"是一个意思，
      // 但只影响这一天，不会波及别的天）
      p.work = w;
      p.brk = b;
      if (p.on) n++;
    }
    if (defToo) { prof.defWork = w; prof.defBrk = b; }
    const ok = await saveConfig();
    render();
    if (!ok) return false;
    toast(n
      ? `${WD[d]} 整天：专注 ${w} 分${b ? ` / 休息 ${b} 分` : '（不休息）'}，改了 ${n} 个小时段，起止分钟保持不变`
      : `${WD[d]} 这一天还没有选中时段；时长已记下，选中后即生效`, 'ok');
    return true;
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
  /** 把 d0 那天的 [from,to) 搬到 d1 那天的 [nFrom,nTo)。
   *  跨天时：先在原所在的天里清掉这一段，再在落点那天并上去。
   *  目标那天已有窗口 → 按"并集"合并（预览里看到的合并结果就是提交结果）。 */
  async clockMoveSeg(d0, from, to, d1, nFrom, nTo, opts) {
    const prof = clockProfile();
    if (settingsFrozen()) { guardDiscipline('调整已选中的时段'); render(); return false; }
    const put = (day, lo, hi, mode) => {
      if (!day) return;
      for (let h = 0; h < 24; h++) {
        const hs = h * 60;
        if (hi <= hs || lo >= hs + 60) continue;
        const p = day[h];
        const isNew = !p.on;
        const wins = ccWinsAfter(p, h, lo, hi, mode, moveSeg);
        ccSetHourWins(p, wins, isNew ? prof.defWork : null, isNew ? prof.defBrk : null);
      }
    };
    // 搬迁沿用原段的 id：搬过去还是"同一段"。
    // 落点那一段是另一个 id，两者即使贴着也不会被合并。
    const moveSeg = ccSegIdIn(prof.days[d0], from, to) || ccNewSegId();
    put(prof.days[d0], from, to, 'sub');
    put(prof.days[d1], nFrom, nTo, 'add');
    const ok = await saveConfig();
    if (!ok) {
      // 保存失败：界面上的预览必须作废，回到服务端的真实状态
      render();
      toast('时段没有保存成功，已恢复原状', 'err');
      return false;
    }
    // 拖拽提交后不重绘：预览已经是最终结果，重绘会让整页闪一下
    if (!(opts && opts.noRender)) render();
    const t = ccMinText(nFrom, nTo);
    const en = I18N.getLang() === 'en';
    // 缩放和搬家是两件事：一个改长度、一个换位置，提示词必须分开，
    // 否则"已把周三的时段移过去"会让人以为整段跑掉了。
    if (opts && opts.resize) {
      toast(en
        ? `Resized ${I18N.t(WD[d1])} to ${t.range} (${ccDurText(nTo - nFrom)})`
        : `已把 ${I18N.t(WD[d1])} 的时段调整为 ${t.range}（共 ${ccDurText(nTo - nFrom)}）`, 'ok');
      return true;
    }
    const where = d0 === d1
      ? `${I18N.t(WD[d0])} ${t.range}`
      : `${I18N.t(WD[d0])} → ${I18N.t(WD[d1])} ${t.range}`;
    toast(en
      ? `Moved to ${where} (${ccDurText(nTo - nFrom)})`
      : `已把 ${where} 的时段移过去（共 ${ccDurText(nTo - nFrom)}）`, 'ok');
    return true;
  },

  async clockCommitRange(d, lo, hi, mode) {
    const prof = clockProfile();
    if (mode === 'sub' && settingsFrozen()) { guardDiscipline('取消已选中的时段'); render(); return; }
    const days = prof.days[d];
    // 本次操作写什么段 id：
    //   · 区间里已经有段（扩展它）→ 沿用那个 id
    //   · 没有（新拖一段）→ 生成新 id
    // 只看区间**内部**，所以紧挨着别的段拖出来的新段永远是独立的一段。
    const segId = ccSegIdIn(days, lo, hi) || ccNewSegId();
    let changed = 0;
    for (let h = 0; h < 24; h++) {
      const hs = h * 60;
      if (hi <= hs || lo >= hs + 60) continue;   // 不涉及这一小时
      const p = days[h];
      const before = JSON.stringify(p);
      const isNew = !p.on;
      // 多窗口：这一小时可能同时有两段（09:00–09:30 + 09:30–10:00）
      const wins = ccWinsAfter(p, h, lo, hi, mode, segId);
      ccSetHourWins(p, wins, isNew ? prof.defWork : null, isNew ? prof.defBrk : null);
      if (JSON.stringify(p) !== before) changed++;
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
      else { p.on = false; p.from = 0; p.to = 60; p.seg = ''; }
    } else {
      if (!p.on) {
        p.work = prof.defWork;
        p.brk = prof.defBrk;
        // 单独点亮一格：紧挨着的已有段**不并进来**，它就是新的一段
        p.seg = ccSegIdIn(prof.days[d], a, b) || ccNewSegId();
      }
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
    // 一次设置 = 一段：整个矩形共用一个 id（跨天也是同一段的连续排布）。
    // 若矩形里原本就有一整套同一 id 的段，沿用它，避免"改个时长就把段拆开"。
    const ids = new Set();
    for (let d = d0; d <= d1; d++) {
      for (let h = h0; h <= h1; h++) {
        const q = prof.days[d][h];
        if (q.on && q.seg) ids.add(q.seg);
      }
    }
    const segId = ids.size === 1 ? [...ids][0] : ccNewSegId();
    for (let d = d0; d <= d1; d++) {
      for (let h = h0; h <= h1; h++) {
        const p = prof.days[d][h];
        p.on = true;
        p.work = w;
        p.brk = b;
        p.from = 0;
        p.to = 60;
        p.seg = segId;
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

  /** 图表显示范围：from / to 两端，整点对齐，最少一小时。
   *
   *  这是纯显示参数（不影响判定与存储），所以不做「生效中禁止修改」的限制——
   *  把一天看成 0–24 还是 7–23，跟"要不要自律"完全是两件事。 */
  async clockView(k, v) {
    const fc = clockCfg();
    let from = Math.round((+fc.viewFrom || 0) / 60) * 60;
    let to = Math.round((fc.viewTo == null ? 1440 : +fc.viewTo) / 60) * 60;
    const h = Math.max(0, Math.min(24, Math.round(+v))) * 60;
    if (k === 'from') from = Math.min(h, to - 60);
    else to = Math.max(h, from + 60);
    from = Math.max(0, Math.min(1380, from));
    to = Math.max(from + 60, Math.min(1440, to));
    if (from === (fc.viewFrom || 0) && to === (fc.viewTo == null ? 1440 : fc.viewTo)) return;
    fc.viewFrom = from;
    fc.viewTo = to;
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
  },

  /** 开 / 关「完整展示」：只改行高的算法，切完立刻重绘（图表马上响应） */
  async clockFit(on) {
    const fc = clockCfg();
    const want = !!on;
    if ((fc.fitAll !== false) === want) return;
    fc.fitAll = want;
    const ok = await saveConfig();
    render();
    if (!ok) { toast('这个开关没保存成功', 'err'); return; }
    toast(want
      ? '已开启完整展示：整张图表一次铺满，不用上下滚动'
      : '已关闭完整展示：恢复固定行高，可以滚动看细节', 'ok');
  },

  async clockViewReset() {
    const fc = clockCfg();
    fc.viewFrom = 0;
    fc.viewTo = 1440;
    await saveConfig();
    render();
    toast('显示范围已恢复为全天（00:00 – 24:00）', 'ok');
  },

  /* ---- 睡眠管理 ---- */

  async sleepSave() {
    const s = clockCfgSleep();
    const seg = sleepSelSeg();
    const isLegacy = seg.id === '__legacy';

    const fromM = hmToMin(($('#sleepFrom') || {}).value);
    let toM = hmToMin(($('#sleepTo') || {}).value);
    const count = Math.round(+($('#sleepCount') || {}).value);
    const price = Math.round(+($('#sleepPrice') || {}).value);
    const umin = Math.round(+($('#sleepUnlockMin') || {}).value);
    const shutdown = !!($('#sleepShutdown') || {}).checked;
    const lock = !!($('#sleepLockOn') || {}).checked;

    if (fromM == null || toM == null) { toast('时间格式应为 HH:MM', 'err'); return; }
    // 结束时间填 00:00 = 到次日 0 点（否则 23:00 – 00:00 会被当成"空时段"）
    if (toM === 0 && fromM > 0) toM = 1440;
    if (fromM === toM) { toast('睡眠时段的起止不能相同（会变成一段空时段）', 'err'); return; }
    if (!Number.isFinite(count) || count < 1 || count > 120) { toast('关机倒计时请填 1–120 分钟', 'err'); return; }
    if (!Number.isFinite(price) || price < 0 || price > 1000) { toast('积分钟价请填 0–1000', 'err'); return; }
    if (!Number.isFinite(umin) || umin < 5 || umin > 240) { toast('一次解锁时长请填 5–240 分钟', 'err'); return; }

    // 写回"这一段"
    seg.from = fromM;
    seg.to = toM;
    seg.countdownMin = count;
    seg.shutdown = shutdown;
    seg.lockScreen = lock;
    s.unlockPrice = price;
    s.unlockMin = umin;

    if (isLegacy) {
      // 单段模式：写回旧字段（Rust 侧 legacy 路径读的就是它们）
      s.from = fromM;
      s.to = toM;
      s.countdownMin = count;
      s.shutdown = shutdown;
      s.lockScreen = lock;
    } else {
      // 多段模式：旧字段保留成"新建段时的默认值"，跟着第一段走，避免两套值越飘越远
      const first = (s.windows || [])[0];
      if (first) {
        s.from = first.from;
        s.to = first.to;
        s.countdownMin = first.countdownMin;
        s.shutdown = first.shutdown;
        s.lockScreen = first.lockScreen;
      }
    }

    // 自动启动那一块：开关在别处即时保存，这里只收"延迟 / 叫醒 / 每一行"
    const w = seg.wake || (seg.wake = { enabled: false, delaySecs: 20, wakeSystem: true, items: [] });
    const dl = Math.round(+($('#wakeDelay') || {}).value);
    if (Number.isFinite(dl) && dl >= 0 && dl <= 300) w.delaySecs = dl;
    const ws = $('#wakeSystem');
    if (ws) w.wakeSystem = !!ws.checked;
    const rows = [...document.querySelectorAll('[data-wkrow]')];
    // 草稿行也要能保存：否则"新加的那一项"永远写不进去
    const byId = new Map((w.items || []).concat(S.wakeDraft || []).map((x) => [x.id, x]));
    const next = [];
    for (const row of rows) {
      const id = row.dataset.wkrow;
      const it = byId.get(id);
      if (!it) continue;
      const get = (k) => (row.querySelector('[data-wk="' + k + '"]') || {}).value;
      const kind = (get('kind') || 'app') === 'url' ? 'url' : 'app';
      const target = String(get('target') || '').trim();
      const args = String(get('args') || '').trim();
      const en = (row.querySelector('[data-wk="enabled"]') || {}).checked;
      if (!target) continue;                       // 空行直接丢掉，不写进配置
      if (kind === 'url' && !/^https?:\/\//i.test(target)) {
        toast(`「${target}」不是 http(s) 地址，已跳过`, 'err');
        continue;
      }
      next.push({ ...it, kind, target, args: kind === 'url' ? '' : args, enabled: en !== false });
    }
    w.items = next;
    S.wakeDraft = [];

    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
    const head = isLegacy ? '' : `第 ${((s.windows || []).findIndex((x) => x.id === seg.id) + 1) || 1} 段：`;
    toast(`睡眠管理已更新 ${head}${minToHm(fromM)} – ${toM >= 1440 ? '24:00' : minToHm(toM)}（${sleepCycleText(seg)}），开机 ${count} 分钟后${shutdown ? '关机' : '只锁定'}`, 'ok');
  },
  async sleepToggleDay(k) {
    sleepEnsureWindows();
    const seg = sleepSelSeg();
    const d = +k;
    const days = (seg.days || []).slice();
    const at = days.indexOf(d);
    if (at >= 0) {
      // 不允许把最后一天也取消：那会变成"一天都不生效"，
      // 界面上是个幽灵段（看着有、其实永不触发）。想每天都生效请切「每天」。
      if (days.length === 1) { toast('至少要选一天；想每天都生效请切到「每天」', 'err'); return; }
      days.splice(at, 1);
    } else {
      days.push(d);
    }
    days.sort((a, b) => a - b);
    seg.days = days;
    // 手动改过日期就是「指定」：不能因为凑巧凑成工作日就自动跳模式
    seg.mode = 'custom';
    S.sleepDaysLast = days.slice();
    const ok = await saveConfig();
    render();
    if (!ok) toast('没保存成功', 'err');
  },

  async sleepEnable() {
    const s = clockCfgSleep();
    s.enabled = !s.enabled;
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
    toast(s.enabled
      ? `睡眠管理已启用：${minToHm(s.from)} – ${minToHm(s.to)} 之间开机，${s.countdownMin} 分钟后自动关机`
      : '睡眠管理已关闭：睡眠时段内不再锁定、也不会关机', 'ok');
  },

  /** 保存睡眠参数。全部走一遍校验再落盘，避免"存了一半"的非法状态。 */
  /* ---- 进入自律时间自动打开 ---- */

  /** 面板里的开关（改草稿，不落盘） */
  launchToggle() {
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    d.enabled = !d.enabled;
    renderLaunchModal();
  },

  /** 加一项：默认软件、窗口化，按顺序排最后 */
  launchAdd() {
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    if (d.items.length >= 12) { toast('最多 12 项，先删掉一个', 'err'); return; }
    d.items.push({
      id: 'i' + Date.now().toString(36),
      kind: 'app',
      target: '',
      args: '',
      window: 'normal',
      browser: '',
    });
    renderLaunchModal();
  },

  launchDel(id) {
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    d.items = d.items.filter((x) => x.id !== id);
    renderLaunchModal();
  },

  /** 上移 / 下移：数组顺序就是排列顺序，所以直接换位置 */
  launchMove(id, dir) {
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    const i = d.items.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.items.length) return;
    const t = d.items[i];
    d.items[i] = d.items[j];
    d.items[j] = t;
    renderLaunchModal();
  },

  /** 切换某一行的「打开方式」（窗口化 / 最大化 / 最小化）。
   *
   *  只改这一行的按钮状态，不重绘整个面板：重绘会把正在输入的输入框
   *  连同光标一起换掉，用户刚敲的半个路径就丢了焦点。
   *  （草稿值由 launchSync 在下次动作 / 保存时统一从 DOM 读回，不会漏。） */
  launchSetWin(id, v) {
    const win = ['normal', 'max', 'min'].indexOf(v) >= 0 ? v : 'normal';
    const row = document.querySelector(`[data-lkrow="${id}"]`);
    if (!row) return;
    row.querySelectorAll('[data-act="launch-win"]').forEach((b) => {
      const on = b.dataset.v === win;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const d = S.launchDraft;
    const it = d && d.items.find((x) => x.id === id);
    if (it) {
      launchSync();
      it.window = win;
    }
  },

  /** 切换「软件 / 网页」：两类目标的可填项不一样（参数 ↔ 浏览器、占位符也不同），
   *  所以这里必须整面板重绘一次，把禁用态和占位文案一起换掉。 */
  launchSetKind(id, v) {
    const kind = v === 'url' ? 'url' : 'app';
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    const it = d.items.find((x) => x.id === id);
    if (!it || it.kind === kind) return;
    it.kind = kind;
    if (kind === 'url') it.args = '';
    else it.browser = '';
    renderLaunchModal();
  },

  /** 保存：校验后写回规则 */
  async launchSave() {
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    const keep = [];
    for (const it of d.items) {
      const target = (it.target || '').trim();
      if (!target) continue;                       // 空行直接丢掉
      if (it.kind === 'url' && !/^https?:\/\//i.test(target)) {
        toast(`「${target}」不是 http(s) 地址，已跳过`, 'err');
        continue;
      }
      keep.push({ ...it, target });
    }
    const rule = (S.data.config.rules || []).find((x) => x.id === d.ruleId);
    if (!rule) { closeModal(); return; }
    rule.autolaunch = { enabled: !!d.enabled, items: keep };
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    closeModal();
    render();
    toast(ok
      ? (d.enabled
        ? `已为「${rule.name}」配置 ${keep.length} 项自动打开`
        : `已关闭「${rule.name}」的自动打开（清单保留 ${keep.length} 项）`)
      : '没保存成功', ok ? 'ok' : 'err');
  },

  /** 添加一段新睡眠。**新段默认不锁屏**：多一段只是多一个"到点关机"，
   *  不能因为加了一段就把用户整屏锁上——那是最容易吓到人的默认值。 */
  async sleepAddSeg() {
    const s = clockCfgSleep();
    const wins = sleepEnsureWindows();
    if (wins.length >= 8) { toast('最多 8 段睡眠，先删掉一段', 'err'); return; }
    // 找一个不撞的时间当默认值：从 13:00 起每加一段往后挪 1 小时
    const base = 13 * 60 + (wins.length - 1) * 60;
    const from = Math.min(base, 22 * 60);
    const id = 'w' + Date.now().toString(36);
    wins.push({
      id,
      from,
      to: Math.min(from + 60, 1439),
      days: [],
      enabled: true,
      lockScreen: false,
      shutdown: true,
      countdownMin: 10,
      wake: { enabled: false, delaySecs: 20, wakeSystem: true, items: [] },
    });
    S.sleepSel = id;
    const ok = await saveConfig();
    render();
    toast(ok ? `已添加一段：${minToHm(from)} – ${minToHm(from + 60)}（每天 · 只关机不锁屏）` : '添加失败', ok ? 'ok' : 'err');
  },

  /** 切换正在编辑的段（纯界面状态，不落盘） */
  sleepPickSeg(id) {
    S.sleepSel = id;
    render();
  },

  /** 删一段。**永远至少保留一段**：全删光等于"睡眠管理静默失效"，
   *  用户会以为还在管，其实什么都没发生。 */
  async sleepDelSeg(id) {
    const s = clockCfgSleep();
    const wins = Array.isArray(s.windows) ? s.windows : [];
    if (wins.length <= 1) { toast('至少要保留一段；完全不想管就把右上角的开关关掉', 'err'); return; }
    const i = wins.findIndex((x) => x.id === id);
    if (i < 0) return;
    const name = `${minToHm(wins[i].from)} – ${wins[i].to >= 1440 ? '24:00' : minToHm(wins[i].to)}`;
    wins.splice(i, 1);
    if (S.sleepSel === id) S.sleepSel = wins[0].id;
    const first = wins[0];
    s.from = first.from;
    s.to = first.to;
    s.countdownMin = first.countdownMin;
    s.shutdown = first.shutdown;
    s.lockScreen = first.lockScreen;
    const ok = await saveConfig();
    render();
    toast(ok ? `已删除 ${name}` : '删除失败', ok ? 'ok' : 'err');
  },

  /** 切周期模式：每天 / 仅工作日 / 指定。
   *
   *  只动 `days`，不碰时间与开关——所以来回切不会丢任何设置。
   *  切到"指定"时优先恢复**上一次的自定义集合**（用户往往只是临时切走看一眼），
   *  没有历史就先用工作日当起点。
   */
  async sleepCycle(mode) {
    sleepEnsureWindows();          // 单段 → 多段，先把参数落成真段
    const seg = sleepSelSeg();
    const cur = sleepCycleMode(seg);
    if (cur === 'custom' && (seg.days || []).length) {
      S.sleepDaysLast = seg.days.slice().sort((a, b) => a - b);
    }
    seg.mode = mode;
    if (mode === 'everyday') {
      seg.days = [];
    } else if (mode === 'workdays') {
      seg.days = [0, 1, 2, 3, 4];
    } else if (!(seg.days && seg.days.length)) {
      // 「指定」：**保留已经选好的日期**。从「仅工作日」切过来时那就是周一到周五，
      // 用户看到的是"指定 + 五个勾"，而不是被清空或被改回工作日。
      seg.days = (S.sleepDaysLast && S.sleepDaysLast.length)
        ? S.sleepDaysLast.slice()
        : [0, 2, 4];
    }

    // 旧字段跟着第一段走（多段模式下它只是"默认值"）
    const first = (clockCfgSleep().windows || [])[0];
    if (first) { clockCfgSleep().from = first.from; clockCfgSleep().to = first.to; }
    const ok = await saveConfig();
    render();
    if (!ok) { toast('周期没保存成功', 'err'); return; }
    toast(`这一段的生效周期：${sleepCycleText(seg)}`, 'ok');
  },

  /** 指定模式里勾 / 取消某一天 */

  /** 锁屏浮层上的「积分解锁」 */
  async sleepUnlock() {
    const st = (S.data.runtime && S.data.runtime.sleep) || {};
    const mins = st.unlockMin || 30;
    try {
      const r = await invoke('sleep_unlock', { minutes: mins });
      closeModal();
      toast(`已用 ${r.spent} 积分解锁 ${r.minutes} 分钟（余额 ${r.balance}）`, 'ok');
      await pull();
      render();
    } catch (e) {
      toast(String(e).replace(/^Error:\s*/, ''), 'err');
    }
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

/** 只落盘、**不回拉状态**的保存。
 *
 *  给"改完立刻就能在本地看到效果"的偏好用（主题这类纯前端开关）。
 *  `saveConfig()` 末尾那次 `pull()` 会再走一趟 `get_state`，并且可能顺手 `render()`
 *  一次——对表单类保存是必要的（后端会 sanitize、改字段），但主题切换因此要等
 *  **两个 IPC 来回 + 两次整页重绘**，表现就是"点一下卡一下"。
 *  失败时仍然回拉一次，保证界面不会停在后端并不认可的状态上。 */
async function saveConfigQuiet() {
  try {
    await invoke('save_config', { config: S.data.config });
    return true;
  } catch (e) {
    toast(String(e).replace(/^Error:\s*/, ''), 'err');
    await pull();
    return false;
  }
}

async function loadStats() {
  const [start, end] = boundsOf(S.range);
  try {
    const r = await invoke('stats_range', { start, end });
    // 只有真的拿到区间数据才替换：接口打嗝时保留上一次的图表，
    // 免得点一下日期整块统计突然变成"没有数据"
    if (r && Array.isArray(r.on)) S.stats = r;
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
          </div>`).join('') : '<div class="empty"><span class="ico">☁</span>云端还没有备份。<br>先点「上传当前配置」。</div>'}
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
/** 语录来源设置（右键 Hub 上的语录弹出）。
 *
 *  一屏说清三件事：现在用的是哪个、还有哪些能选、怎么加一个新的。
 *  内置来源标「内置」且不给删除按钮——它是断网时唯一的兜底。
 */
function renderQuoteSrcModal() {
  const list = quoteFeeds();
  const cur = quoteActiveFeed();
  const kindTxt = { local: '本地', json: '联网 · JSON', text: '联网 · 纯文本' };
  const rows = list.map((f) => {
    const on = f.id === cur.id;
    return `<div class="fsrc${on ? ' on' : ''}">
      <div class="fsrc-main">
        <div class="fsrc-name">${esc(f.name)}
          <span class="badge ${f.kind === 'local' ? '' : 'blue'}">${kindTxt[f.kind] || f.kind}</span>
          ${f.builtin ? '<span class="badge">内置</span>' : ''}
          ${on ? '<span class="badge gold">使用中</span>' : ''}
        </div>
        <div class="fsrc-url">${f.url ? esc(f.url) : `本地预置 ${(window.KOF_QUOTES || []).length} 条，永不联网`}</div>
      </div>
      <div class="fsrc-ops">
        ${on ? '<span class="hint">当前</span>'
    : `<button class="btn btn-sm" data-act="quote-pick-feed" data-id="${esc(f.id)}">用它</button>`}
        ${f.builtin ? '' : `<button class="btn btn-sm danger-ghost" data-act="quote-del-feed" data-id="${esc(f.id)}">删除</button>`}
      </div>
    </div>`;
  }).join('');

  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="width:620px">
      <div class="modal-hd">
        <h3>语录来源</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="hint" style="margin-bottom:10px;line-height:1.8">
          点「换一条」时，会按这里选中的来源取一句。<b>联网源取不到就自动退回本地预置</b>，
          断网也照样能换，不会卡住。
        </div>
        <div class="flist">${rows}</div>

        <div class="card" style="margin-top:16px;padding:14px 14px 12px">
          <div class="card-title" style="font-size:13px">添加自定义来源</div>
          <div class="hint" style="margin:6px 0 10px;line-height:1.7">
            地址返回 JSON 时，会自动认 <code>hitokoto</code> / <code>text</code> / <code>content</code> / <code>sentence</code>
            这几个字段；返回纯文本就选「纯文本」，取第一行。
          </div>
          <div class="qfeed-form">
            <input type="text" id="qfeedName" maxlength="24" placeholder="名称（显示在语录下方）" />
            <input type="text" id="qfeedUrl" maxlength="300" placeholder="https://example.com/api/quote" />
            <select id="qfeedKind">
              <option value="json">联网 · JSON</option>
              <option value="text">联网 · 纯文本</option>
            </select>
            <button class="btn btn-sm btn-primary" data-act="quote-add-feed">添加</button>
          </div>
        </div>
      </div>
      <div class="modal-ft">
        <span class="hint" style="flex:1">右键语录随时回到这里</span>
        <button class="btn" data-act="close-modal">关闭</button>
      </div>
    </div>
  </div>`;
}

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
// 当日日历的悬停读数：色块太薄写不下字时，靠这一行把"几点到几点、多少分钟"读出来。
// 用事件委托挂在 document 上 —— 日历每换一天都整块重画，绑在块上会越绑越多。
document.addEventListener('pointerover', (e) => {
  const ev = e.target && e.target.closest ? e.target.closest('.dc-ev') : null;
  if (ev) dcRead(ev.dataset.tip || '');
});
document.addEventListener('pointerout', (e) => {
  const ev = e.target && e.target.closest ? e.target.closest('.dc-ev') : null;
  if (ev) dcRead('');
});

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
  if (act === 'open-help') { await Act.nav('help'); return; }
  if (act === 'do-unlock') { await Act.pointsUnlock(+el.dataset.min); return; }
  if (act === 'do-unlock-sleep') { await Act.sleepUnlock(); return; }
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
  if (act === 'sweep-toggle') { await Act.sweepToggle(); return; }
  if (act === 'sweep-mode') { await Act.sweepMode(el.dataset.v); return; }
  if (act === 'sweep-media') { await Act.sweepMedia(); return; }
  if (act === 'clock-clear') { await Act.clockClear(); return; }
  if (act === 'clock-def-save') { await Act.clockDefSave(); return; }
  if (act === 'clock-prof') { await Act.clockProfSwitch(el.dataset.id); return; }
  if (act === 'clock-prof-new') { ccNameDialog('new'); return; }
  if (act === 'clock-prof-rename') { ccNameDialog('rename'); return; }
  if (act === 'clock-prof-dup') { await Act.clockProfDup(); return; }
  if (act === 'clock-prof-del') { await Act.clockProfDel(); return; }
  if (act === 'hud-corner') { await Act.hudCorner(el.dataset.v); return; }
  if (act === 'clock-gran') { await Act.clockGran(el.dataset.v); return; }
  // 下拉框在 click 上什么都不做（真正的改动在 change 里，见下面那条监听）
  if (act === 'clock-view') return;
  if (act === 'clock-fit') { await Act.clockFit(el.dataset.v === '1'); return; }
  if (act === 'sleep-enable') { await Act.sleepEnable(); return; }
  if (act === 'sleep-save') { await Act.sleepSave(); return; }
  if (act === 'rule-launch') { openLaunchModal(el.dataset.id); return; }
  if (act === 'launch-toggle') { Act.launchToggle(); return; }
  if (act === 'launch-add') { Act.launchAdd(); return; }
  if (act === 'launch-del') { Act.launchDel(el.dataset.id); return; }
  if (act === 'launch-up') { Act.launchMove(el.dataset.id, -1); return; }
  if (act === 'launch-down') { Act.launchMove(el.dataset.id, 1); return; }
  if (act === 'launch-win') { Act.launchSetWin(el.dataset.id, el.dataset.v); return; }
  if (act === 'launch-kind') { Act.launchSetKind(el.dataset.id, el.dataset.v); return; }
  if (act === 'launch-save') { await Act.launchSave(); return; }
  if (act === 'sleep-add-seg') { await Act.sleepAddSeg(); return; }
  if (act === 'sleep-del-seg') { await Act.sleepDelSeg(el.dataset.id); return; }
  if (act === 'sleep-pick-seg') { Act.sleepPickSeg(el.dataset.id); return; }
  if (act === 'sleep-cycle') { await Act.sleepCycle(el.dataset.v); return; }
  if (act === 'sleep-day') { await Act.sleepToggleDay(el.dataset.v); return; }
  if (act === 'sleep-unlock') { await Act.sleepUnlock(); return; }
  if (act === 'clock-view-reset') { await Act.clockViewReset(); return; }
  // S.ccAnimIn 只在这一帧为真：完整图表页的入场动画不能每次重绘都重播，
  // 否则拖完一段松手（内部会 render 一次）整页就会重新淡入 = 闪一下。
  if (act === 'cc-open') { S.ccFull = true; S.ccAnimIn = true; render(); S.ccAnimIn = false; return; }
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
  if (act === 'quote-open-src') { await Act.quoteOpenSrc(); return; }
  if (act === 'quote-src-menu') { Act.quoteSrcMenu(); return; }
  if (act === 'quote-pick-feed') { await Act.quotePickFeed(el.dataset.id); return; }
  if (act === 'quote-del-feed') { await Act.quoteDelFeed(el.dataset.id); return; }
  if (act === 'quote-add-feed') { await Act.quoteAddFeed(); return; }
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
  if (act === 'cal-mode') { await Act.calMode(el.dataset.m); return; }
  if (act === 'cal-move') { await Act.calMove(+el.dataset.d); return; }
  if (act === 'cal-today') { await Act.calToday(); return; }
  if (act === 'cal-pick') { await Act.calPick(el.dataset.date); return; }
  if (act === 'day-move') { await Act.dayMove(+el.dataset.d); return; }
  if (act === 'day-today') { await Act.dayToday(); return; }
  if (act === 'day-ev') { Act.focusPick(el.dataset.key); return; }
  if (act === 'focus-clear') { Act.focusClear(); return; }
  if (act === 'pie-close') {
    const host = document.querySelector('#pieDetail');
    if (host) { host.dataset.key = ''; host.innerHTML = ''; }
    // 收起饼图明细 = 不再"聚焦"某个分类：当日日历和日历上的描边一起撤掉
    if (S.calHit) Act.focusClear();
    return;
  }
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
/** 把"一个窗口 / 一组窗口 / 空"统一成窗口数组（分 → {f,t,seg}）。
 *
 *  为什么需要它：同一小时可以放**两段**（09:00–09:30 + 09:30–10:00），
 *  任何"一小时只装一个窗口"的中间表示都会在拖动预览里把另一段抹掉。
 *  对外仍然接受单个 `{f,t}`（老调用点、老测试），内部一律按数组处理。 */
function ccWinList(x) {
  if (!x) return [];
  const arr = Array.isArray(x) ? x : [x];
  const out = [];
  for (const w of arr) {
    if (!w) continue;
    const f = Math.max(0, Math.min(59, Math.round(+w.f || 0)));
    const t = Math.max(1, Math.min(60, Math.round(w.t == null ? 60 : +w.t)));
    if (t > f) out.push({ f, t, seg: w.seg || '' });
  }
  return out.sort((a, b) => a.f - b.f);
}

/** 重算某格的 DOM 选中态（.on）与细分刻度高亮（.cc-q.on），不触发整表渲染。
 *  `win` 可以是单个窗口、窗口数组，或空——见 ccWinList。 */
function ccPaintCell(cell, d, h, win) {
  const list = ccWinList(win);
  cell.classList.toggle('on', list.length > 0);
  cell.querySelectorAll('.cc-q').forEach((q) => {
    const a = +q.dataset.a, b = +q.dataset.b;
    q.classList.toggle('on', list.some((w) => w.f < b && a < w.t));
  });
}
/** hover 提示：只在停在细分刻度上时更新（避免 mouseover 抖动刷 tooltip） */
function ccHoverTip(cell, d, h, q) {
  const p = clockProfile().days[d][h];
  const a = qStart(q), b = qEnd(q);
  const w = Math.max(0, Math.min(60, p.work || 0));
  const br = Math.max(0, Math.min(60 - w, p.brk || 0));
  const onQ = p.on && (p.from || 0) < b && a < (p.to == null ? 60 : p.to);
  // 悬停在**已选中**的格子上时，顺手告诉你"这一整段是多长"：
  // 色块上的字只有 8~10px，短段还只能显示一行，鼠标停一下就能看全文更实用。
  const sg = onQ ? ccSegAt(d, h * 60 + a) : null;
  const segTxt = sg ? `本段 ${sg.range}（共 ${ccDurText(sg.mins)}） · ` : '';
  cell.setAttribute('title', `${WD[d]} ${pad(h)}:${pad(a)} – ${pad(h)}:${pad(b)}`
    + (onQ
      ? ` · ${segTxt}专注 ${w} 分 / 休息 ${br} 分，右键可改`
      : `（未选中，单击 / 拖选这 ${b - a} 分钟）`));
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
  // 不能写死 data-h=0 / 23：图表可以只显示其中一段（显示范围），
  // 那两格根本不存在，写死会让整条拖拽链路直接失效。
  const cells = grid.querySelectorAll(`.cc-cell[data-d="${d}"]`);
  if (!cells.length) return null;
  const first = cells[0];
  const last = cells[cells.length - 1];
  const r0 = first.getBoundingClientRect();
  const r1 = last.getBoundingClientRect();
  // 行高要用**平均值**（总高 ÷ 行数），不能拿第一格高：完整展示模式下每行是 1fr，
  // 浏览器会把不足 1px 的余量摊到某些行上（这一格 27px、下一格 28px）。
  // 拿第一格当行高，误差会随着行号累加——到第 11 小时就偏了 7~8px，
  // 指针明明在 09:00 却被算成 09:15，拖出来的时段跟着错位。
  const n = cells.length;
  const hourH = (r1.bottom - r0.top) / n;
  return { top: r0.top, hourH, bottom: r1.bottom };
}

/** clientX → 落在哪一列（哪一天）。返回 null = 指针不在图表的横向范围内。
 *
 *  为什么返回 null 而不是夹住：跨天拖拽只在"指针真的到了另一列"时才换天。
 *  指针滑出图表两侧时保持原来那一天（等于在周首 / 周末停住，不绕回另一头），
 *  既符合"一周就是一周"的直觉，也避免合成事件里 clientX=0 这类脏值把时段甩到周一。
 */
/** 某一列的横向范围。取这一列的**第一格**，而不是写死 data-h="0"——
 *  显示范围可能不从 0 点开始（例如只看 07:00–23:00），那时 data-h="0" 根本不存在，
 *  跨天命中的列宽就会退化成"空数组"，于是拖到别的列永远算"没换天"。
 *  （这就是"周二拖不到周三"的根因。） */
function ccColBox(d) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return null;
  const c = grid.querySelector(`.cc-cell[data-d="${d}"]`);
  return c ? c.getBoundingClientRect() : null;
}

function ccDayAtX(clientX) {
  const grid = document.getElementById('ccGrid');
  if (!grid || typeof clientX !== 'number' || !isFinite(clientX)) return null;
  const cols = [];
  for (let d = 0; d < 7; d++) {
    const r = ccColBox(d);
    if (r) cols.push({ d, r });
  }
  if (!cols.length) return null;
  const left = cols[0].r.left;
  const right = cols[cols.length - 1].r.right;
  if (clientX < left - 8 || clientX > right + 8) return null;
  for (const c of cols) {
    if (clientX >= c.r.left - 3 && clientX <= c.r.right + 3) return c.d;
  }
  // 落在列间距里：取最近的一列
  let best = cols[0].d;
  let bestDist = Infinity;
  for (const c of cols) {
    const dist = clientX < c.r.left ? c.r.left - clientX : clientX - c.r.right;
    if (dist < bestDist) { bestDist = dist; best = c.d; }
  }
  return best;
}

/** clientY → 当天第几个粒度（越界时夹住，并告诉调用方越到了哪边） */
function ccGrainAt(d, clientY) {
  const g = ccDayGeom(d);
  const view = ccView();
  if (!g || g.hourH <= 0) return { idx: 0, edge: 0 };
  const qn = ccQCnt();
  const raw = Math.floor(((clientY - g.top) / g.hourH) * qn);
  const edge = clientY < g.top - 1 ? -1 : (clientY > g.bottom + 1 ? 1 : 0);
  // 返回的是**整天**的粒度序号：显示范围只改"画哪一段"，
  // 序号仍以 0:00 为原点，这样与 from/to 的绝对分钟一一对应。
  const lo = view.from / ccStep();
  const hi = view.to / ccStep() - 1;
  return { idx: Math.max(lo, Math.min(hi, lo + raw)), edge };
}

/** 拖拽区间 [lo,hi)（分钟）：以锚点那一格为基准向两侧伸缩，最少一格 */
/** 某一天里**除被拖的那一段**之外，已经被占用的分钟区间。
 *
 *  这是碰撞限制的唯一输入。为什么不看 DOM：DOM 上是"预览态"，被拖的那一段
 *  已经在往目标位置跑了；拿它当障碍物会算出一堆假碰撞。
 *  配置才是"别人的真实位置"，在整个拖动过程中它一个字都不会变。
 *
 *  `dg` 传进来时按段身份把自己摘掉：
 *    · 有 seg id → 比 id（同一天里 id 唯一，跨天也不会误伤）
 *    · 老配置没有 id → 退回"起止分钟完全相等才算自己"
 */
function ccBusyBlocks(d, dg) {
  const day = (clockProfile().days[d]) || [];
  const isSrc = !!(dg && d === dg.d);
  return ccSegs(day)
    .map((s) => ({
      lo: s.h0 * 60 + s.f0,
      hi: s.h1 * 60 + s.t1,
      seg: s.seg || '',
    }))
    .filter((b) => !(isSrc && (
      (dg.segId && b.seg === dg.segId)
      || (!dg.segId && b.lo === dg.segFrom && b.hi === dg.segTo))))
    .sort((x, y) => x.lo - y.lo);
}

/** 把"想放的起点"夹到一个不压别人的位置：贴着对方边缘停下。
 *
 *  规则（对应交互约定）：
 *    · 能放下就按指针走（`ok(desired)`）；
 *    · 撞上别人 → 贴到**来的那一侧**的边：
 *        往下拖 → 停在障碍物上沿（`hit.lo - len`）
 *        往上拖 → 停在障碍物下沿（`hit.hi`）
 *      绝不做"截断对方 / 把对方切成两段"这种联动；
 *    · 那一侧塞不下（< 段长）→ 退回另一侧；两侧都不行 → 原地不动（`prevLo`）。
 *
 *  返回 null 只表示"连原位都放不下"（配置本身已被手改坏），调用方保持原值。 */
function ccFreeStart(desired, len, blocks, view, prevLo, down) {
  const fits = (lo) => lo >= view.from && lo + len <= view.to
    && !blocks.some((b) => lo < b.hi && lo + len > b.lo);
  if (fits(desired)) return desired;
  const hit = blocks.find((b) => desired < b.hi && desired + len > b.lo);
  if (!hit) return prevLo == null ? null : prevLo;
  const above = hit.lo - len;   // 停在障碍物上沿
  const below = hit.hi;         // 停在障碍物下沿
  const keep = prevLo == null ? null : prevLo;
  if (down === true) return fits(above) ? above : (fits(below) ? below : keep);
  if (down === false) return fits(below) ? below : (fits(above) ? above : keep);
  // 没有纵向位移（例如只是横向换天）：贴到更近的那一侧，
  // 这样"同一时刻搬到另一天"不会莫名其妙跳到障碍物的另一头。
  const near = Math.abs(above - desired) <= Math.abs(below - desired)
    ? [above, below] : [below, above];
  for (const c of near) if (fits(c)) return c;
  return keep;
}

function ccDragRange(dg) {
  const st = ccStep();
  const n = ccDayGrains();
  const a = Math.max(0, Math.min(n - 1, dg.anchor));
  const c = Math.max(0, Math.min(n - 1, dg.cur));
  dg.blocked = false;   // 只有真正被相邻时段挡住时才由下面的平移分支置位

  // 边缘缩放：一端钉死，另一端跟着指针走。
  //   下边 → 只动 hi；上边 → 只动 lo。
  //   长度夹在 [一个粒度, 显示范围] 之间：最短一格（10 / 15 分钟），最长到视野尽头。
  //   另外**撞到相邻段就停在它的边缘**：不许把它压短，也不许把它推开。
  if (dg.resize) {
    const view = ccView();
    const minDur = ccStep();
    const blocks = ccBusyBlocks(dg.d, dg);
    let lo = dg.segFrom;
    let hi = dg.segTo;
    if (dg.resize === 'bottom') {
      // 指针所在那一格的下沿就是新的结束时刻（拖到 10:15 中间 → 结束 10:15）
      hi = Math.min(view.to, Math.max((c + 1) * st, lo + minDur));
      // 下方最近的一段：它的上沿就是这条边能到的极限。
      // 用**固定的起点** lo 判断"在下方的"，不能用会移动的 hi——
      // 否则指针一旦越过那道墙，墙就被算成"不在下方"，边就穿过去了。
      const next = blocks.filter((b) => b.lo > lo).reduce((m, b) => Math.min(m, b.lo), Infinity);
      if (isFinite(next)) hi = Math.min(hi, next);
      hi = Math.max(hi, lo + minDur);
    } else {
      lo = Math.max(view.from, Math.min(c * st, hi - minDur));
      // 上方最近的一段：它的下沿就是这条边能到的极限（同理用固定的 hi 判断）
      const prev = blocks.filter((b) => b.hi < hi).reduce((m, b) => Math.max(m, b.hi), -Infinity);
      if (isFinite(prev)) lo = Math.max(lo, prev);
      lo = Math.min(lo, hi - minDur);
    }
    return { lo, hi };
  }

  if (dg.mode === 'move') {
    // 整段平移：**长度恒定**，只按"拖了多远"平移，撞到显示范围的边就贴边停下。
    // 这里绝不能"先挪再裁"：那会把越过边界的部分剪掉，看起来是贴边，实际是丢分钟。
    // 所以夹的是**起点**，终点永远由起点 + 原长度推出来。
    const view = ccView();
    const len = dg.segTo - dg.segFrom;
    let lo = dg.segFrom + (c - a) * st;
    if (lo + len > view.to) lo = view.to - len;
    if (lo < view.from) lo = view.from;
    // 段比显示范围还长（例如只显示 9–10 点，却抓着一段 8–12 点）：
    // 怎么挪都会越界，干脆钉住不动，而不是把它截短
    if (lo + len > view.to) lo = dg.segFrom;

    // 碰撞：这一天里除自己以外的段都是"墙"。碰到就停在墙边，绝不压上去、
    // 绝不插进它中间、绝不把它挤走——别人的起止/时长/数量在拖动期间完全不变。
    const dCur = dg.mode === 'move' ? (dg.dCur == null ? dg.d : dg.dCur) : dg.d;
    if (dg.lockDay !== dCur) {
      // 换了一天：上一个落点属于原来那天，不能拿来当"上次位置"
      dg.lockDay = dCur;
      dg.lockLo = dg.segFrom;
    }
    const blocks = ccBusyBlocks(dCur, dg);
    const prevLo = dg.lockLo == null ? dg.segFrom : dg.lockLo;
    const want = lo;             // 夹过视野、但还没夹碰撞的"指针想要的落点"
    // 方向：真的往上/下拖了才按方向贴边；只是横向换天（纵向没动）就让"近的那一侧"说话
    const moved = Math.abs(want - prevLo) > 0.5;
    const down = moved ? want > prevLo : null;
    const fit = ccFreeStart(want, len, blocks, view, prevLo, down);
    if (fit != null) lo = fit;
    // 被相邻时段挡住了 → 状态条上说明一句，避免用户以为"拖不动了"
    dg.blocked = fit != null && Math.abs(fit - want) > 0.5;
    dg.lockLo = lo;
    return { lo, hi: lo + len };
  }

  // 新建拖选：锚点那一格固定，另一端跟着指针长。
  // 同样不许画到别人身上（那等于把对方从中间切开），撞到就停在对方边缘。
  {
    const blocks = ccBusyBlocks(dg.d, null);
    if (c >= a) {
      const lo = a * st;
      let hi = Math.min(1440, (c + 1) * st);
      const next = blocks.filter((b) => b.lo >= lo + st).reduce((m, b) => Math.min(m, b.lo), Infinity);
      if (isFinite(next)) hi = Math.min(hi, next);
      return { lo, hi: Math.max(hi, lo + st) };
    }
    const hi = (a + 1) * st;
    let lo = c * st;
    const prev = blocks.filter((b) => b.hi <= hi - st).reduce((m, b) => Math.max(m, b.hi), -Infinity);
    if (isFinite(prev)) lo = Math.max(lo, prev);
    return { lo: Math.min(lo, hi - st), hi };
  }
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

/** 预览下**某一天** 24 小时各自的窗口（**数组**，空数组 = 这一小时没选中）。
 *
 *  平移时会被问两天：原所在的那天（要把这一段拿掉）和落点那天（要铺上）。
 *  同一天时两步都作用在同一份数组上，等价于"先 sub 再 add"，
 *  与 clockMoveSeg 的写入顺序完全一致，所以松手不会跳变。
 *
 *  ⚠️ 这里以前有两条会"抹掉别的时段"的错：
 *  1. `out[h] = 与拖拽区间相交的那个窗口，否则 null` —— 只保留被拖的那一段。
 *     只要这天还有别的时段，拖动其中一段时其余时段全被涂成"未选中"，块一块块消失。
 *     落位走的又是"不整体重绘"的提交，没人再按配置纠正 DOM，
 *     那些块就永久留在了"消失"状态——数据还在，界面没了。
 *  2. 新建拖选（add）时仍然去"减掉 segFrom…segTo"，而这时这两个字段根本不存在，
 *     减出来的小时列表是空的：拖新段时当天所有旧段一起闪没。
 *  现在每小时**全量**返回所有窗口，只减真正被搬走 / 被覆盖的那一段。 */
function ccWinsForDay(d, dg, lo, hi) {
  const prof = clockProfile();
  const day = prof.days[d] || [];
  const out = new Array(24).fill(null).map(() => []);
  const isMove = dg.mode === 'move';
  const isSrc = isMove && d === dg.d;
  const isDst = d === (dg.dCur == null ? dg.d : dg.dCur);
  // 段 id 与真正落盘时用的那一个完全同源：
  //   · 平移 / 缩放 → 原地那一段的 id（ccSegIdIn 从原位置取）
  //   · 新建拖选   → 区间内已有段的 id，没有就临时 id（提交时换成真 id）
  // 这样预览里"贴在一起的两段"与落盘后的结果一模一样，松手不跳变。
  const seg = isMove
    ? (ccSegIdIn(prof.days[dg.d] || [], dg.segFrom, dg.segTo) || '__drag')
    : (ccSegIdIn(day, lo, hi) || '__drag');
  for (let h = 0; h < 24; h++) {
    const p = day[h];
    let wins = hourWins(p);
    if (isSrc) wins = ccWinsAfter(p, h, dg.segFrom, dg.segTo, 'sub', '');
    if (isDst) wins = ccWinsAfterSource(wins, h, lo, hi, seg);
    out[h] = ccWinList(wins.map((w) => ({ f: w.from, t: w.to, seg: w.seg })));
  }
  return out;
}

/** 预览用：把 [lo,hi) 并进已有窗口列表（不动配置） */
function ccWinsAfterSource(wins, h, lo, hi, seg) {
  const hs = h * 60;
  const a = Math.max(lo, hs), b = Math.min(hi, hs + 60);
  if (b <= a) return wins;
  const af = a - hs, bt = b - hs;
  const list = wins.map((w) => ({ ...w }));
  let nf = af, nt = bt;
  const out = [];
  for (const w of list) {
    const overlap = w.from < nt && w.to > nf;
    const touching = w.to === nf || w.from === nt;
    const same = !w.seg || !seg ? true : w.seg === seg;
    if (!overlap && !(touching && same)) { out.push(w); continue; }
    if (overlap && !same) {
      if (w.from < nf) out.push({ from: w.from, to: nf, seg: w.seg });
      if (w.to > nt) out.push({ from: nt, to: w.to, seg: w.seg });
      continue;
    }
    nf = Math.min(nf, w.from);
    nt = Math.max(nt, w.to);
  }
  out.push({ from: nf, to: nt, seg: seg || '__drag' });
  return out.sort((x, y) => x.from - y.from);
}

/** 虚拟的一天里被选中多少分钟。
 *  一天 = 24 个小时，每小时可能**有多个窗口**（同一小时两段），
 *  所以这里既接受 `[{f,t}, …]` 也接受 `[[{f,t}], …]` 两层结构。 */
function ccWinsMinutes(wins) {
  return (wins || []).reduce((n, w) => n + (Array.isArray(w)
    ? ccWinsMinutes(w)
    : (w ? Math.max(0, w.t - w.f) : 0)), 0);
}

/** 预览的一天（24 小时窗口数组）→ 与配置同形状的一天（`ccSegs` 认的形状）。
 *  段数 / 摘要 / 微缩图都走 `hourWins`，所以多窗口要原样翻译成 `wins`。 */
function ccDayOfWins(hours) {
  return (hours || []).map((list) => {
    const l = ccWinList(list);
    if (!l.length) return { on: false };
    return {
      on: true,
      from: l[0].f,
      to: l[l.length - 1].t,
      seg: l[0].seg || '',
      wins: l.map((w) => ({ from: w.f, to: w.t, seg: w.seg || '' })),
    };
  });
}

/** 「合计 x」：拖拽中的实时文案也要跟着语言走 */
function ccTotalText(m) {
  return I18N.getLang() === 'en' ? `Total ${ccDurText(m)}` : `合计 ${ccMinText(0, m).dur}`;
}

/** 每日时长 / 合计 / 段数：跟着预览实时联动。
 *  `winsBy` 是 Map<天, 24 小时窗口>；跨天拖动时会同时有两天的数据。
 *  松手后若整体重绘会覆盖这些值，不重绘时它们就是最终值（预览=结果）。 */
function ccLiveTotals(winsBy) {
  const prof = clockProfile();
  const per = prof.days.map((day, i) => (winsBy && winsBy.has(i)
    ? ccWinsMinutes(winsBy.get(i))
    : ccDayMinutes(day)));
  const total = per.reduce((a, b) => a + b, 0);
  // 拖动时这个函数每帧都会被调一次：**值没变就一个字符都不写**。
  // `textContent = 同一个字符串` 也会把文本节点整个换掉，配合入场动画就是
  // "数字在抖"的观感；宽度同理。
  const setTxt = (el, t) => {
    if (el && el.textContent !== t) el.textContent = t;
  };
  const hd = document.querySelector('.cc-days-hd');
  if (hd && hd.lastElementChild) setTxt(hd.lastElementChild, ccTotalText(total));
  const rows = document.querySelectorAll('.cc-days .cc-day');
  per.forEach((m, d) => {
    const row = rows[d];
    if (!row) return;
    const bar = row.querySelector('.bar i');
    if (bar) {
      const w = `${(m / 1440 * 100).toFixed(1)}%`;
      if (bar.style.width !== w) bar.style.width = w;
    }
    setTxt(row.querySelector('.v'), m ? ccDurText(m) : '—');
    // 段数也跟着变：新建时可能把两段并成一段（并集），这里必须如实反映。
    // 没有预览数据时（撤回 / 提交后）就用配置里的真实值，别留着旧的段数。
    const day = winsBy && winsBy.has(d)
      ? ccDayOfWins(winsBy.get(d))
      : prof.days[d];
    const n = ccSegs(day).length;
    setTxt(row.querySelector('.s'), n ? `${n} 段` : '');
  });
}

/** 拖拽预览：写 DOM（绝不写配置），并把被搬的那一块标成"抓起来了"。
 *  平移可以跨天：这时会同时画两条列——原列去掉这一段、目标列铺上这一段。 */
function paintCcDrag() {
  const dg = S.ccDrag;
  if (!dg) return;
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  const dCur = dg.mode === 'move' ? (dg.dCur == null ? dg.d : dg.dCur) : dg.d;
  const { lo, hi } = ccDragRange(dg);
  const days = dCur === dg.d ? [dg.d] : [dg.d, dCur];

  // 0) **先把上一帧涂过、这一帧不再涉及的天还原**。
  //    跨多天拖动时 dCur 是"跳"的：周二 → 周三 → 周四 → 周五，
  //    每跳一次，刚刚离开的那一天就再也不会出现在 days 里。
  //    以前这里只重绘 days，于是周三、周四的格子一直留着预览态的 .on，
  //    而块又是按 DOM 的 .on 画的 → 中间那天凭空多出一段。
  //    落位时走的是 noRender 提交（为了不整页闪），没人来纠正，幽灵就留在屏幕上。
  const stale = [];
  if (dg.painted) for (const d of dg.painted) if (days.indexOf(d) < 0) stale.push(d);
  if (stale.length) ccRestoreCells(stale);
  dg.painted = days.slice();

  const winsBy = new Map();
  for (const d of days) winsBy.set(d, ccWinsForDay(d, dg, lo, hi));

  // 1) 格子与细分刻度（涉及的那几天一起刷）
  for (const d of days) {
    const wins = winsBy.get(d);
    grid.querySelectorAll(`.cc-cell[data-d="${d}"]`).forEach((c) => {
      const h = +c.dataset.h;
      ccPaintCell(c, d, h, wins[h]);
    });
  }
  // 2) 整块（块上的起止时间也在这里跟着变）
  //    必须把窗口传给渲染器：只改单元格的 .on 不够——
  //    每小时的起止分钟若仍从配置里读，02:15 起的那一块就会被判成
  //    "上一小时 :15 结束"，在小时边界断成两块。
  //    传的是**这一小时的全部窗口**（不是与拖拽相交的那一个）：
  //    只传一个的话，同一天里别的时段就在预览里消失了（见 ccWinsForDay）。
  // 块本身按"已放置"色画；只有**这次真正在动的那一段**单独点亮（见 ccPaintSel）。
  ccRenderRuns(document, (d, h) => {
    if (!winsBy.has(d)) return undefined;
    const list = winsBy.get(d)[h];
    return list && list.length ? list : null;
  });
  ccPaintSel(days, lo, hi);

  const h0 = Math.floor(lo / 60);
  const h1 = Math.floor((hi - 1) / 60);
  // 3) 被搬走的那一块：半透明 + 抬起，一眼看出"它在我手上"
  //    判定用"这一块的时间范围完整盖住了落点区间"，而不是只看小时重叠——
  //    否则同一天里恰好挨着的另一段也会被标上半透明。
  grid.querySelectorAll('.cc-run').forEach((r) => {
    const rFrom = +r.dataset.h0 * 60 + (+r.dataset.f0 || 0);
    const rTo = +r.dataset.h1 * 60 + (+r.dataset.t1 || 60);
    const hit = +r.dataset.d === dCur && rFrom <= lo && rTo >= hi;
    // 缩放不出"手上那块半透明"的效果：它没有被搬走，只是在原地变长 / 变短
    r.classList.toggle('carry', dg.mode === 'move' && !dg.resize && hit);
  });
  // 4) 原位留一条虚线占位：告诉用户它原本在哪，松手前不"凭空消失"
  // 占位虚线也**复用同一个节点**：以前每帧 remove + 新建，而 `.cc-slot` 带
  // `ccSlotIn` 淡入动画，于是虚线每帧闪一下。现在只更新位置与百分比，
  // 它的出现动画只在真正开始拖动时播一次。
  let slot = grid.querySelector('.cc-slot');
  if (dg.mode === 'move' && !dg.resize) {
    const s0 = Math.floor(dg.segFrom / 60), s1 = Math.floor((dg.segTo - 1) / 60);
    const span = (s1 - s0 + 1) * 60;
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'cc-slot';
      grid.appendChild(slot);
    }
    slot.style.gridColumn = `${dg.d + 2}`;
    slot.style.gridRow = `${ccRow(s0)} / ${ccRow(s1) + 1}`;
    let bar = slot.firstElementChild;
    if (!bar) {
      bar = document.createElement('i');
      slot.appendChild(bar);
    }
    bar.style.top = `${(((dg.segFrom - s0 * 60) / span) * 100).toFixed(2)}%`;
    bar.style.height = `${(((dg.segTo - dg.segFrom) / span) * 100).toFixed(2)}%`;
  } else if (slot) {
    slot.remove();
  }
  // 5) 每日时长 / 合计 / 段数
  ccLiveTotals(winsBy);

  // 6) 状态条
  const isEn = I18N.getLang() === 'en';
  const verb = dg.resize ? (isEn ? 'Resize' : '调整')
    : dg.mode === 'move' ? (isEn ? 'Move' : '移动')
      : dg.mode === 'sub' ? (isEn ? 'Cancel' : '取消')
        : (isEn ? 'Select' : '选中');
  const dayTxt = dCur === dg.d
    ? I18N.t(WD[dCur])
    : `${I18N.t(WD[dg.d])} → ${I18N.t(WD[dCur])}`;
  const durTxt = ccDurText(hi - lo);
  const rg = ccMinText(lo, hi).range;
  const edgeY = dg.edge < 0 ? (isEn ? ' · clamped at 0:00' : ' · 已到当日 0:00')
    : (dg.edge > 0 ? (isEn ? ' · clamped at 24:00' : ' · 已到当日 24:00') : '');
  // 横向顶到周首 / 周末：说明"不会再往旁边走了"，避免用户以为拖不动
  const edgeX = dg.edgeX < 0 ? (isEn ? ' · week starts here' : ' · 已到周一')
    : (dg.edgeX > 0 ? (isEn ? ' · week ends here' : ' · 已到周日') : '');
  // 被相邻时段挡住了：同上，明确告诉用户"是撞到别人了，不是卡住"。
  // 顺带说明别人没被改动——这正是这次交互约定的核心。
  const edgeB = dg.blocked
    ? (isEn ? ' · next window blocks it (untouched)' : ' · 已贴住相邻时段（没有移动它）') : '';
  const lab = $('#clockLive');
  if (lab) {
    const html = isEn
      ? `${verb} <b>${dayTxt} ${rg}</b> · ${durTxt}${edgeY}${edgeX}${edgeB}`
      : `${verb} <b>${dayTxt} ${rg}</b> · 共 ${durTxt}${edgeY}${edgeX}${edgeB}`;
    // 每帧都赋一次 innerHTML 会把 <b> 连同文本反复重建，拖动时那行字会轻微抖。
    // 内容没变就不碰它。
    if (lab.__html !== html) {
      lab.innerHTML = html;
      lab.__html = html;
    }
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

/** 只还原**格子**（.on 与细分刻度）：按配置里的真实值重画指定的这几天，
 *  不碰块、不碰合计。拖拽过程中要求"某一天退出预览"时用它——
 *  完整的 ccRestorePreview 会把状态条和合计一起复位，那会打断正在进行的拖动。 */
function ccRestoreCells(days) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return [];
  const list = (Array.isArray(days) ? days : [days]).filter((d) => d != null);
  const prof = clockProfile();
  for (const d of list) {
    const day = prof.days[d] || [];
    grid.querySelectorAll(`.cc-cell[data-d="${d}"]`).forEach((c) => {
      const h = +c.dataset.h;
      const p = day[h];
      // 用**全部窗口**还原：同一小时可以有两段，只按 from/to 画会把两段并成整小时
      ccPaintCell(c, d, h, p && p.on
        ? hourWins(p).map((w) => ({ f: w.from, t: w.to, seg: w.seg }))
        : null);
    });
  }
  return list;
}

/** 撤回预览：按**配置里的真实值**把涉及的那几天重画（单击 / 取消拖动时用） */
function ccRestorePreview(days) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  grid.querySelectorAll('.cc-slot').forEach((el) => el.remove());
  const list = ccRestoreCells(days);
  // 这几天里可能还挂着上一帧留下的块：只重画它们，别的列原样保留
  ccRenderRuns(document, null, list);
  grid.querySelectorAll('.cc-run.carry').forEach((r) => r.classList.remove('carry'));
  // 重画只覆盖这几天；万一别处还挂着"选中中"，一并收掉（取消后不该有任何高亮残留）
  ccSettleRuns();
  ccLiveTotals(null);
  ccResetLive();
}

/** 「选中中」只给**真正在动的那一段**上色。
 *
 *  days = 这次操作涉及的天；[lo,hi) = 被操作的分钟区间。
 *  只有"在这些天里、且与这个区间有交集"的块才加 `.sel`，
 *  其余块一律摘掉——这是"局部高亮"的硬约束：拖周一的段，
 *  周二、周三的块不能跟着变色（它们的数据一点都没动）。
 *
 *  用"区间有交集"而不是"整块被盖住"：拖到一半、段被拉长时，
 *  正在变形的就是那一块，它当然要亮；而同一个小时里另一段没被碰过的，
 *  边界不重叠就不会亮。
 */
function ccPaintSel(days, lo, hi) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  const set = new Set(days || []);
  grid.querySelectorAll('.cc-run').forEach((r) => {
    const d = +r.dataset.d;
    const a = +r.dataset.h0 * 60 + (+r.dataset.f0 || 0);
    const b = +r.dataset.h1 * 60 + (+r.dataset.t1 || 60);
    r.classList.toggle('sel', set.has(d) && b > lo && a < hi);
  });
}

/** 落盘之后：把仍然挂着的「选中中」块换回「已放置」色。
 *
 *  只换类、不重建节点——重建会打断落位动画（FLIP 需要同一块继续存在），
 *  而 CSS 上 `background-color` 有 160ms 过渡，于是这次换色本身就是"设置成功"的反馈：
 *  同一色相、只深 5%，几乎察觉不到，但确实"定下来了"。
 */
function ccSettleRuns() {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  grid.querySelectorAll('.cc-run.sel').forEach((r) => r.classList.remove('sel'));
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
/** 当天**覆盖这一小时**的那一段（合成事件没有真实坐标时兜底用）。
 *  只要这一小时里有一段（哪怕它只占后半截），就认为右键的目的是那一段。 */
function ccSegAtHour(d, h) {
  const day = clockProfile().days[d];
  if (!day) return null;
  return ccSegs(day).find((s) => s.h0 <= h && s.h1 >= h) || null;
}

/** 一段在屏幕上的上 / 下边界（像素）。
 *  **不能用块容器的 rect**：容器占的是整格高度，02:10 起的段，
 *  它的容器从 02:00 就开始了，手柄会画在那 10 分钟空白里。
 *  这里按 h0*60+f0 精确换算，非整点的段手柄才贴得住色带。 */
function ccSegEdgeY(d, seg) {
  const g = ccDayGeom(d);
  if (!g || !seg) return null;
  const view = ccView();
  const a = seg.h0 * 60 + (seg.f0 || 0);
  const b = seg.h1 * 60 + (seg.t1 >= 60 ? 60 : seg.t1);
  return {
    top: g.top + ((a - view.from) / 60) * g.hourH,
    bottom: g.top + ((b - view.from) / 60) * g.hourH,
    h: ((b - a) / 60) * g.hourH,
  };
}

/** 指针落在这一段的上边还是下边？返回 'top' / 'bottom' / null。
 *
 *  热区宽度分两种情形，因为"一格"和"一块"的比例完全不同：
 *
 *  · **多格块**（≥ 2 小时）取 min(5px, 段高/3, 一格 × 0.45)：
 *    `一格 × 0.45` 保证"任意一格的中心"都落在可搬区间里——完整展示模式下
 *    每行被压到 20~28px，10 分钟一格只有 3~5px，用固定 5px 会让首格整块变成
 *    热区，拖着拖着就变成"怎么按都在改大小"。
 *
 *  · **单格块**（15 / 10 分钟，只有一格）取 min(5px, 段高 × 0.32)：
 *    这种块没有"内部格"可保护，上下各让出约 1/3 做缩放，中间 1/3 仍可搬走。
 *    按比例算而不是按格算，否则 13px 的块热区只剩 1px，等于没有。
 */
const CC_EDGE_PX = 5;
function ccEdgeZone(d, seg, clientY) {
  if (!seg || typeof clientY !== 'number') return null;
  const y = ccSegEdgeY(d, seg);
  if (!y || y.h <= 0) return null;
  const n = (seg.h1 - seg.h0) + 1;
  const grainPx = y.h / (ccQCnt() * n);
  const z = n === 1
    ? Math.min(CC_EDGE_PX, y.h * 0.32)
    : Math.max(1.5, Math.min(CC_EDGE_PX, y.h / 3, grainPx * 0.45));
  if (clientY <= y.top + z) return 'top';
  if (clientY >= y.bottom - z) return 'bottom';
  return null;
}

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
  dg.lastY = y;
  if (typeof x === 'number') dg.lastX = x;

  // 平移可以跨天：横向落点决定"搬到哪一天"。
  // 指针滑出图表两侧时保持当前天（在周首 / 周末停住），并在状态条说明到头了。
  let dCur = dg.dCur == null ? dg.d : dg.dCur;
  let edgeX = 0;
  // 缩放只改长度，**不接受横向换天**：把一段的上边界拖到周三的列上，
  // 意思到底是"拉长"还是"搬到周三"说不清，索性钉死在本天——
  // 要换天请按段中间（那是平移）。
  if (dg.mode === 'move' && !dg.resize) {
    const at = ccDayAtX(x);
    if (at != null) {
      dCur = at;
    } else if (typeof x === 'number') {
      const b0 = ccColBox(0);
      const b6 = ccColBox(6);
      if (b0 && b6) {
        if (x < b0.left - 8 && dCur === 0) edgeX = -1;
        if (x > b6.right + 8 && dCur === 6) edgeX = 1;
      }
    }
  }
  const { idx, edge } = ccGrainAt(dCur, y);
  const changed = idx !== dg.cur || edge !== dg.edge
    || dCur !== dg.dCur || edgeX !== dg.edgeX;
  dg.cur = idx;
  dg.edge = edge;
  dg.dCur = dCur;
  dg.edgeX = edgeX;
  // 落到新的粒度 / 新的一天 → 重排；仍在同一格 → 只挪浮层（省掉一次重排）
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
    gr.classList.remove('over-edge');
    gr.querySelectorAll('.cc-run.over').forEach((r) => r.classList.remove('over'));
    gr.querySelectorAll('.cc-run.edge-top, .cc-run.edge-bottom')
      .forEach((r) => r.classList.remove('edge-top', 'edge-bottom'));
  }
  S.ccEdgeKey = '';

  // 按下的位置落在某一段里 → 拖动 = **整段平移**（段的长度不变，只换位置）；
  // 落在空白 → 拖动 = 新建一段。
  //
  // 以前"落在已选中的格子上"是 sub（抹掉），再加一句"没拖动就算单击 → 取消这一格"，
  // 结果在段中间点一下就把一整段从中间劈开、点中的那块消失。现在点击什么都不改。
  const seg = ccSegAt(d, atMin);
  // 落在段的上 / 下边界 7px 内 → 缩放这一段；否则才是"整段搬走"。
  // 判定顺序就是优先级：**边缘 > 段身 > 空白**（越具体越优先）。
  const zone = ccEdgeZone(d, seg, clientY);
  if (zone) S.ccEdgeKey = '';   // 一开始拖就把悬停手柄收掉，别和拖动抢视线

  if (seg) {
    S.ccDrag = {
      d, dCur: d, anchor: idx, cur: idx, edge, edgeX: 0, mode: 'move', moved: false,
      resize: zone || null,
      startY: clientY, startX: clientX, lastX: clientX, lastY: clientY,
      // painted = 当前 DOM 上"正在显示预览"的天；跨天时指针会一路掠过别的天，
      // 每帧都要据此把离开的天还原（见 paintCcDrag 第 0 步）
      painted: [d],
      segFrom: seg.h0 * 60 + seg.f0,
      segTo: seg.h1 * 60 + (seg.t1 >= 60 ? 60 : seg.t1),
      // 段身份 + 最近一次"合法的落点"：碰撞限制用它们把自己从占位表里摘出去，
      // 并在被人挡住时宁可原地不动（见 ccDragRange）
      segId: seg.seg || '',
      lockLo: seg.h0 * 60 + seg.f0,
      lockDay: d,
    };
  } else {
    S.ccDrag = {
      d, dCur: d, anchor: idx, cur: idx, edge, edgeX: 0, mode: 'add', moved: false,
      startY: clientY, startX: clientX, lastX: clientX, lastY: clientY,
      painted: [d],
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
  // "真的动过"按位移算（3px）：同一格内稍微一拖也算拖动，不必跨过整格；
  // 横向同样算——跨天搬一段时，指针可能只往右挪了一点点。
  if (!dg.moved && Math.abs(clientY - dg.startY) >= 3) dg.moved = true;
  if (!dg.moved && typeof clientX === 'number' && typeof dg.startX === 'number'
    && Math.abs(clientX - dg.startX) >= 3) dg.moved = true;
  ccScheduleDrag();
}

/** 取消拖动：把预览整个撤回，不写任何数据（Esc / 窗口失焦 / 右键） */
function ccCancelDrag() {
  const dg = S.ccDrag;
  if (!dg) return;
  S.ccDrag = null;
  if (ccPaintRaf) { cancelAnimationFrame(ccPaintRaf); ccPaintRaf = 0; }
  if (ccPaintTimer) { clearTimeout(ccPaintTimer); ccPaintTimer = 0; }
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
  // 收尾要把"掠过"的那些天一起还原：它们只在某一帧里被涂过，
  // 不属于最后那次落点，光还原 d / dCur 会把幽灵时段留在屏幕上。
  ccRestorePreview(ccDragDays(dg));
}

/** 这次拖动在 DOM 上留下的所有天（含指针一路掠过、最后已经离开的那些）。
 *  去重并保序，null 会被过滤掉。 */
function ccDragDays(dg) {
  const list = [dg.d, dg.dCur == null ? dg.d : dg.dCur].concat(dg.painted || []);
  return list.filter((d, i) => d != null && list.indexOf(d) === i);
}

/** 松手：没动过 = 单击（不改结构）；动过 = 提交这段区间 */
async function ccDragEnd() {
  const dg = S.ccDrag;
  if (!dg) return;
  // 先把还没落地的那一帧刷掉：提交的区间必须等于用户最后看到的那一块
  ccFlushDrag();
  S.ccDrag = null;

  // 落点那天（平移可跨天）
  const dCur = dg.mode === 'move' ? (dg.dCur == null ? dg.d : dg.dCur) : dg.d;

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
  // 留给右键菜单的"当前选区"：用粒度坐标表示，和旧版一致
  S.ccRect = {
    d0: dCur, d1: dCur, h0, h1,
    qA: Math.floor((lo - h0 * 60) / ccStep()),
    qB: Math.ceil((hi - h1 * 60) / ccStep()) - 1,
  };

  if (!dg.moved) {
    // 单击：**不改任何时段**，只把选区记下来给右键菜单用。
    // （这条是硬规则：点击不得改变时段的数量与结构。）预览也要撤回去。
    ccRestorePreview(ccDragDays(dg));
    if (scroller) scroller.scrollTop = scrollTop;
    return;
  }

  if (dg.mode === 'move') {
    if (dCur === dg.d && lo === dg.segFrom && hi === dg.segTo) {
      // 原地放下：什么都不用提交，只把预览换成真实渲染
      ccRestorePreview(ccDragDays(dg));
      render();
      // render 换掉了整个面板，滚动位置要在**换完**之后还原
      const sc0 = document.querySelector('#ccDetail .cc-scroll');
      if (sc0) sc0.scrollTop = scrollTop;
      return;
    }
    // 关键：提交后**不整体重绘**。
    // 预览本来就是按最终结果画的，再 render 一次等于把 168 个格子重建一遍，
    // 既会打断落位动画，也会让"整页重新淡入"闪一下。
    const ok = await Act.clockMoveSeg(dg.d, dg.segFrom, dg.segTo, dCur, lo, hi,
      { noRender: true, resize: !!dg.resize });
    // 提交是异步的（要等一次落盘）：这期间用户可能已经开始了下一次拖动。
    // 那时预览归新拖动所有，收尾动作不能再抢 DOM。
    const live = S.ccDrag;
    const busy = live ? (live.painted || []) : [];
    // 一路掠过的中间天：既不是起点也不是落点，配置里从来没有它们，
    // 必须按配置清一遍，否则它们会作为"幽灵时段"留在屏幕上（提交不重绘，没人纠正）。
    const staleDays = (dg.painted || []).filter((d) => d !== dg.d && d !== dCur
      && busy.indexOf(d) < 0);
    if (!live) {
      if (ok) {
        // 落位后**按配置重建**涉及的这几天（起点 / 落点 / 掠过的中间天）。
        // 为什么不直接相信预览：预览只是"看起来的样子"，一旦它在某一帧少画了
        // 一块（丢窗口、被别的段盖住），noRender 提交不会有人来纠正，
        // 界面就永久少一块而数据还在。这里以数据为准重画一次，DOM 必然等于配置。
        // FLIP 用的是下面 ccLandRun 里**重建后**的目标块，动画照旧。
        const touched = [dg.d, dCur].concat(staleDays)
          .filter((d, i, arr) => arr.indexOf(d) === i);
        ccRestoreCells(touched);
        ccRenderRuns(document, null, touched);
        ccSettleRuns();         // 选中中 → 已设置（只换类，保留落位动画起点）
        ccResetLive();          // 状态条回到摘要
        ccLiveTotals(null);     // 行数据已经是最终值，这里只做一次兜底对齐
      }
      const sc2 = document.querySelector('#ccDetail .cc-scroll');
      if (sc2) sc2.scrollTop = scrollTop;
      if (ok) ccLandRun(fromRect, dCur, h0, h1);
    } else if (ok && staleDays.length) {
      // 这一次拖动还没结束：只清掠过的中间天，别动新拖动正在画的那几天
      ccRestoreCells(staleDays);
      ccRenderRuns(document, null, staleDays);
    }
    return;
  }

  await Act.clockCommitRange(dg.d, lo, hi, dg.mode);
  // 提交后整体重绘会把滚动位置打回顶部，这里还原，免得"一松手视线就跑了"
  const sc3 = document.querySelector('#ccDetail .cc-scroll');
  if (sc3) sc3.scrollTop = scrollTop;
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
  if (S.ccDrag) { e.preventDefault(); ccDragMove(e.clientY, e.clientX); return; }
  // 不拖动时：顺手判断指针是不是压在段的上 / 下边界上（给缩放做预告）
  ccHoverEdge(e);
});

// 拖动期间禁掉滚轮：图表一滚动，指针与刻度就错位了（拖完自然恢复）
document.addEventListener('wheel', (e) => {
  if (S.ccDrag) e.preventDefault();
}, { passive: false });

// 指针在窗口外松开时收不到 mouseup：失焦即视为松手，避免"卡在抓取状态"
// 指针在窗口外松开时收不到 mouseup：失焦即视为**取消**（不是提交），
// 免得"切个窗口回来发现时段已经被搬走了"。
window.addEventListener('blur', () => { if (S.ccDrag) ccCancelDrag(); });

// 拖动中按 Esc = 取消（把预览撤回，不写任何数据）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !S.ccDrag) return;
  e.preventDefault();
  ccCancelDrag();
});

// Hub 上的语录：右键弹出「来源」设置。
// 只认 [data-quote-box]，不碰图表那边的格子右键——两套菜单各管各的。
document.addEventListener('contextmenu', (e) => {
  const box = e.target && e.target.closest ? e.target.closest('[data-quote-box]') : null;
  if (!box) return;
  e.preventDefault();
  Act.quoteSrcMenu();
});

// 设置页的语录输入框：回车等于点「添加」
// 自动启动的星期小按钮：点一下切换"这一天跑不跑"


document.addEventListener('keydown', (e) => {
  if (!e.target || e.target.id !== 'setQuoteNew') return;
  if (e.key !== 'Enter') return;
  e.preventDefault();
  Act.setQuoteAdd();
});

/** 找出某一列里起止小时对应的那个块（块是渲染出来的，没有稳定 id） */
function ccFindRun(d, h0, h1) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return null;
  return [...grid.querySelectorAll('.cc-run')].find((r) => +r.dataset.d === d
    && +r.dataset.h0 === h0 && +r.dataset.h1 === h1) || null;
}

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
  const run = ccFindRun(d, seg.h0, seg.h1);
  if (run) run.classList.add('over');
}

/** 收起边缘手柄（离开图表 / 开始拖动时） */
function ccEdgeClear() {
  const grid = document.getElementById('ccGrid');
  if (S.ccEdgeKey) S.ccEdgeKey = '';
  if (!grid) return;
  grid.classList.remove('over-edge');
  grid.querySelectorAll('.cc-run.edge-top, .cc-run.edge-bottom')
    .forEach((r) => r.classList.remove('edge-top', 'edge-bottom'));
}

/** 悬停在某一段的上下边界 → 长出手柄 + 光标 ns-resize。
 *
 *  必须挂在 mousemove 而不是 mouseover 上：一个段可能只占半格
 *  （10:15–10:45），指针在段内从中间走到下边界，压根不会换元素、
 *  也就不会触发 mouseover。 */
function ccHoverEdge(e) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  const cell = e.target && e.target.closest ? e.target.closest('.cc-cell') : null;
  if (!cell || !grid.contains(cell)) { ccEdgeClear(); return; }
  const d = +cell.dataset.d;
  const g = ccGrainAt(d, e.clientY);
  const seg = ccSegAt(d, g.idx * ccStep());
  const zone = ccEdgeZone(d, seg, e.clientY);
  const key = `${d}:${seg ? `${seg.h0}-${seg.h1}` : ''}:${zone || ''}`;
  const marked = !!grid.querySelector('.cc-run.edge-top, .cc-run.edge-bottom');
  // 重绘会把块整个换掉、类跟着丢；所以"key 没变但标记不见了"也要重新打上
  if (key === S.ccEdgeKey && (marked || !zone)) return;
  S.ccEdgeKey = key;
  grid.classList.toggle('over-edge', !!zone);
  grid.querySelectorAll('.cc-run.edge-top, .cc-run.edge-bottom')
    .forEach((r) => r.classList.remove('edge-top', 'edge-bottom'));
  if (!zone) return;
  const run = ccFindRun(d, seg.h0, seg.h1);
  if (run) run.classList.add(zone === 'top' ? 'edge-top' : 'edge-bottom');
}

document.addEventListener('mouseover', (e) => {
  const gr = document.getElementById('ccGrid');
  if (S.ccDrag) { if (gr) { gr.classList.remove('over-seg'); gr.classList.remove('over-edge'); } return; }
  const cell = e.target.closest('.cc-cell');
  if (!cell) {
    if (gr) gr.classList.remove('over-seg');
    ccMarkHoverSeg(0, null);
    ccEdgeClear();
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
    ccEdgeClear();
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

/* ───────── 右键：三种目标，互不混淆 ─────────
 *
 * 以前只有一个入口：右键任何格子都弹「时段设置」，里面还挂着一排
 * 「当前框选 / 这一格 / 这一列（一整天）」的切换 —— 于是"右键点某一段"，
 * 弹出来的却是"整天"级别的选项，手一滑就把一整天重排了。
 *
 * 现在按**点在哪**决定菜单，三档互斥，任何一张都不出现跨级选项：
 *   ① 日期表头 `.cc-dh`  → 整天：只作用于这一天 0:00–24:00
 *   ② 已有时段内部        → 时段：只作用于这一段（段首到段尾，跨小时也完整，
 *                          贴着 0:00 / 24:00 也不会牵连相邻那天）
 *   ③ 空白格子            → 选区：这一格，或当前拖选的连续范围
 *
 * 每张菜单顶部都写死"作用于 …"，所以"改了哪一段"永远是能读出来的。
 */

const CC_WB_PRESETS = [[25, 5], [45, 15], [50, 10], [60, 0]];

/** 三张菜单共用的弹窗外壳 */
function ccMenuShell(title, sub, body, foot) {
  return `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal cc-modal">
        <div class="modal-hd">
          <h3>${esc(title)}</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          ${sub ? `<div class="cc-menu-tgt">${sub}</div>` : ''}
          ${body}
        </div>
        <div class="modal-ft">${foot}</div>
      </div>
    </div>`;
}

/** 专注 / 休息输入 + 预设（三张菜单一样） */
function ccWbHtml(w, b) {
  return `
    <div class="cc-menu-row">
      <label>专注 <input type="number" id="ccW" min="1" max="60" step="1" value="${w}"> 分</label>
      <label>休息 <input type="number" id="ccB" min="0" max="60" step="1" value="${b}"> 分</label>
    </div>
    <div class="cc-menu-scope">
      ${CC_WB_PRESETS.map(([x, y]) => `<button class="chip-btn" data-wb="${x},${y}">${y ? `${x} / ${y}` : '不休息'}</button>`).join('')}
    </div>`;
}

/** 读输入框里的专注 / 休息（夹紧、休息不能挤掉专注） */
function ccReadWb() {
  let w = Math.round(Number(($('#ccW') || {}).value) || 0);
  let b = Math.round(Number(($('#ccB') || {}).value) || 0);
  w = Math.max(1, Math.min(60, w));
  b = Math.max(0, Math.min(60, b));
  if (b > 0 && w + b > 60) b = 60 - w;
  return { w, b };
}

/** 统一的菜单交互委托（预设 / 关闭 / 交给各自的 handler）
 *
 *  用 AbortController 一次性绑定：#modalRoot 是常驻节点，innerHTML 换不掉它身上的监听，
 *  逐次 addEventListener 会越积越多（点一下应用执行 N 次）。
 */
function ccBindMenu(handler) {
  if (window.__ccMenuCtrl) window.__ccMenuCtrl.abort();
  window.__ccMenuCtrl = new AbortController();
  $('#modalRoot').addEventListener('click', async (e) => {
    const wb = e.target.closest('[data-wb]');
    if (wb) {
      const [w2, b2] = wb.dataset.wb.split(',').map(Number);
      if ($('#ccW')) $('#ccW').value = w2;
      if ($('#ccB')) $('#ccB').value = b2;
      return;
    }
    if (e.target.closest('[data-act="cc-close"]')) { ccCloseMenu(); return; }
    await handler(e);
  }, { signal: window.__ccMenuCtrl.signal });
}

/** 一段的文案：周三 02:10 – 03:10 */
function ccSegText(d, seg) {
  const a = seg.h0 * 60 + seg.f0;
  const b = seg.h1 * 60 + (seg.t1 >= 60 ? 60 : seg.t1);
  return `${WD[d]} ${ccMinText(a, b).range}`;
}

/** ② 右键落在**已有时段**里 → 只针对这一段 */
function ccOpenSegMenu(d, seg) {
  ccCloseMenu();
  const prof = clockProfile();
  const a = seg.h0 * 60 + seg.f0;
  const b = seg.h1 * 60 + (seg.t1 >= 60 ? 60 : seg.t1);

  // 说明：这里**只认右键点中的这一段**。
  // 拖选是"一段连续区间"，而连续区间一旦提交就必然合成一段（见 ccSegs），
  // 所以不存在"框选一次命中好几段"的情况；真有好几段时，右键哪段就只改哪段。

  const edge = [];
  if (a === 0) edge.push('起点是 0:00（日界）');
  if (b === 1440) edge.push('终点是 24:00（日界）');

  const sub = `作用于 <b id="ccTgt">${esc(ccSegText(d, seg))}</b>（<b id="ccCnt">1</b> 段 · ${ccMinText(a, b).dur}）`;
  const body = `
    <div class="note" style="line-height:1.8">
      这是<b>一段</b>：${esc(ccSegText(d, seg))}。菜单只改这一段，
      <b>不会</b>动这一天的其它时段，也没有整天级别的选项。
      ${edge.length ? `<br>${esc(edge.join('、'))}：只作用于${WD[d]}，不会牵连相邻那天。` : ''}
    </div>
    ${ccWbHtml(seg.work || prof.defWork, seg.brk || CC_DEF_B)}
    <div class="cc-menu-row win" id="ccWinRow">
      <label>起止分钟 从 <input type="number" id="ccFrom" min="0" max="59" step="1" value="${seg.f0}"> 到</label>
      <label><input type="number" id="ccTo" min="1" max="60" step="1" value="${seg.t1}"> 分</label>
    </div>
    <div class="cc-menu-hint" id="ccWinHint">起止分钟只改这一段的首 / 尾小时（${WD[d]} ${pad(seg.h0)}:00 与 ${pad(seg.h1)}:00 那两格），中间小时保持整点。</div>
    <label class="cc-menu-def"><input type="checkbox" id="ccDefToo" checked> 同时设为通用时长（之后新选的时段沿用）</label>
    <div class="cc-menu-hint">休息期间不拦截、不遮罩；排不满 60 分钟的尾段算继续专注。</div>`;
  const foot = `
    <button class="btn btn-danger" id="ccSegDel" data-armed="0">取消这一段</button>
    <span style="flex:1"></span>
    <button class="btn" data-act="cc-close">取消</button>
    <button class="btn btn-primary" id="ccApply">应用</button>`;

  $('#modalRoot').innerHTML = ccMenuShell('时段设置', sub, body, foot);
  ccMenu = $('#modalRoot');
  $('#ccW') && $('#ccW').focus();

  ccBindMenu(async (e) => {
    // 取消这一段：两步确认，避免手滑
    const del = e.target.closest('#ccSegDel');
    if (del) {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.textContent = '再点一次，确认取消';
        return;
      }
      await Act.clockClearRange(d, seg.h0, seg.h1, ccSegText(d, seg));
      ccCloseMenu();
      return;
    }
    if (!e.target.closest('#ccApply')) return;

    const { w, b } = ccReadWb();
    const defToo = !!($('#ccDefToo') || {}).checked;
    const f2 = Math.round(Number(($('#ccFrom') || {}).value) || 0);
    const t2 = Math.round(Number(($('#ccTo') || {}).value) || 0);
    const snap = ccSnapWin(f2, t2);
    if (snap.f >= snap.t) { toast('起始分钟要小于结束分钟', 'err'); return; }
    const ok = await Act.clockSetWB(d, d, seg.h0, seg.h1, w, b, defToo, snap.f, snap.t);
    if (ok === false) { toast('起始分钟要小于结束分钟', 'err'); return; }
    ccCloseMenu();
  });
}

/** ③ 右键点在**空白格子**上 → 只作用这一格（不再是"这一列"或"整个框选"） */
function ccOpenCellMenu(d, h) {
  ccCloseMenu();
  const fc = clockProfile();
  const p = fc.days[d][h];
  const pre = p.on
    ? { w: p.work || CC_DEF_W, b: p.brk || CC_DEF_B }
    : { w: fc.defWork, b: fc.defBrk };
  const snap = p.on ? ccSnapWin(p.from, p.to) : { f: 0, t: 60 };
  const t = { d0: d, d1: d, h0: h, h1: h };

  const sub = `作用于 <b id="ccTgt">${esc(ccRectText(d, d, h, h, snap.f, snap.t))}</b>（<b id="ccCnt">1</b> 段）`;
  const body = `
    <div class="note" style="line-height:1.8">
      这一格现在是<b>${p.on ? '选中的' : '空白的'}</b>（${WD[d]} ${pad(h)}:00 – ${pad(h + 1)}:00）。
      应用会把它选上；想改别的范围请在图上拖一段，再右键那一段。
    </div>
    <div class="cc-menu-scope" style="margin:10px 0 4px">
      <button class="chip-btn" data-cell-quick="${ccStep()}" title="只把这一格的最小粒度选上，分钟数不用自己填">
        只选 ${ccStep()} 分钟
      </button>
      <button class="chip-btn" data-cell-quick="60">整小时</button>
    </div>
    <div class="cc-menu-hint">单选最小粒度就点上面第一个按钮：一次点击 = 这一格只选 ${ccStep()} 分钟。也可以在图上按住拖动 ${ccStep()} 分钟的范围，效果一样。</div>
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
    ${ccWbHtml(pre.w, pre.b)}
    <div class="cc-menu-row win">
      <label>起止分钟 从 <input type="number" id="ccFrom" min="0" max="59" step="1" value="${snap.f}"> 到</label>
      <label><input type="number" id="ccTo" min="1" max="60" step="1" value="${snap.t}"> 分</label>
    </div>
    <div class="cc-menu-hint">起止分钟只对<b>这一格</b>生效：0 和 60 就是整小时（例如 8:15–8:45）。</div>
    <label class="cc-menu-def"><input type="checkbox" id="ccDefToo" checked> 同时设为通用时长（之后新选的时段沿用）</label>
    <div class="cc-hint-sep">想改一整段？右键那一段。想改一整天？右键顶部日期表头。</div>`;
  const foot = `
    <span style="flex:1"></span>
    <button class="btn" data-act="cc-close">取消</button>
    <button class="btn btn-primary" id="ccApply">应用</button>`;

  $('#modalRoot').innerHTML = ccMenuShell('格子设置', sub, body, foot);
  ccMenu = $('#modalRoot');
  $('#ccW') && $('#ccW').focus();

  const renderTlRows = () => {
    const box = $('#ccTlRows');
    if (!box) return;
    const segs = ccBuildSegments(t);
    if (!segs.length) { box.innerHTML = '<div class="cc-tl-empty">这个范围里没有可设置的刻度</div>'; return; }
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

  ccBindMenu(async (e) => {
    const tl = e.target.closest('[data-tl]');
    if (tl) {
      const [dd, hh, qq] = tl.dataset.tl.split(',').map(Number);
      await Act.clockToggleQ(dd, hh, qq);
      renderTlRows();
      return;
    }
    // 快捷：一次点击就把这一格设成"只有一个最小粒度"或"整小时"。
    // 这是 15 / 10 分钟单选的**直达入口**——不用自己算起止分钟，
    // 也不用在 20px 高的一格里精确拖动。
    const quick = e.target.closest('[data-cell-quick]');
    if (quick) {
      const { w, b } = ccReadWb();
      const to = Math.max(1, Math.min(60, +quick.dataset.cellQuick || 60));
      const ok = await Act.clockSetWB(d, d, h, h, w, b, !!($('#ccDefToo') || {}).checked, 0, to);
      if (ok !== false) ccCloseMenu();
      return;
    }
    if (!e.target.closest('#ccApply')) return;
    const { w, b } = ccReadWb();
    let f2 = Math.round(Number(($('#ccFrom') || {}).value) || 0);
    let t2 = Math.round(Number(($('#ccTo') || {}).value) || 0);
    const sn = ccSnapWin(f2, t2);
    f2 = sn.f; t2 = sn.t;
    if (f2 >= t2) { toast('起始分钟要小于结束分钟', 'err'); return; }
    const ok = await Act.clockSetWB(d, d, h, h, w, b, !!($('#ccDefToo') || {}).checked, f2, t2);
    if (ok === false) { toast('起始分钟要小于结束分钟', 'err'); return; }
    ccCloseMenu();
  });
}

/** ① 右键点**日期表头** → 整天（0:00–24:00，只这一天） */
function ccOpenDayMenu(d) {
  ccCloseMenu();
  const prof = clockProfile();
  const day = prof.days[d];
  const segs = ccSegs(day);
  const mins = ccDayMinutes(day);
  const w = prof.defWork, b = prof.defBrk;

  // 进来先把"这一天到底排了什么"列清楚——这是用户右键表头最想看到的东西。
  // 以前只给"选中整天 / 清空整天"，等于让人摸黑操作：不知道自己会覆盖掉什么。
  const segRows = segs.length
    ? segs.map((sg, i) => {
      const a = sg.h0 * 60 + sg.f0;
      const b = sg.h1 * 60 + (sg.t1 >= 60 ? 60 : sg.t1);
      const dur = ccDurText(b - a);
      const wp = prof.days[d][sg.h0];
      const wk = wp.work || prof.defWork;
      const bk = wp.brk || 0;
      return `<div class="dseg">
        <span class="dseg-idx">${i + 1}</span>
        <span class="dseg-time">${pad(sg.h0)}:${pad(sg.f0)} – ${(sg.t1 >= 60 ? pad(sg.h1 + 1) : pad(sg.h1))}:${pad(sg.t1 >= 60 ? 0 : sg.t1)}</span>
        <span class="dseg-dur">${dur}</span>
        <span class="dseg-rhythm">专注 ${wk} 分${bk ? ` / 休息 ${bk} 分` : '（不休息）'}</span>
        <button class="btn btn-sm danger-ghost" data-day-del="${i}">取消这段</button>
      </div>`;
    }).join('')
    : '<div class="dseg-empty">这一天还没有任何自律时段。可以点下面的「选中整天」，也可以在图上按住拖动来新建。</div>';

  const sub = `作用于 <b id="ccTgt">${WD[d]} 00:00 – 24:00</b>（整天 · ${segs.length} 段 · ${mins ? ccMinText(0, mins).dur : '空'}）`;
  const body = `
    <div class="cc-dseg-list" id="ccDaySegs">
      <div class="cc-dseg-hd"><span>${WD[d]} 已排时段</span><span>${segs.length} 段 · 共 ${mins ? ccMinText(0, mins).dur : '0 分钟'}</span></div>
      ${segRows}
    </div>
    <div class="note" style="line-height:1.8;margin-top:10px">
      下面是<b>整天</b>级别的操作：只作用于 ${WD[d]} 0:00–24:00，其余六天原样不动。
      想改某一段的起止分钟，请直接在图上右键那一段。
    </div>
    <div class="cc-menu-scope" style="margin-top:10px">
      <button class="chip-btn" data-day-act="select">选中整天</button>
      <button class="chip-btn" data-day-act="clear">清空整天</button>
    </div>
    ${ccWbHtml(w, b)}
    <div class="cc-menu-hint">「应用到整天」只改<b>专注 / 休息</b>，不会动已有时段的起止分钟（例如 02:10–03:10 仍然是 02:10 开始）。要让整天变成整点，用「选中整天」重排。</div>
    <label class="cc-menu-def"><input type="checkbox" id="ccDefToo"> 同时设为通用时长（之后新选的时段沿用）</label>`;
  const foot = `
    <span style="flex:1"></span>
    <button class="btn" data-act="cc-close">取消</button>
    <button class="btn btn-primary" id="ccApply">应用到整天</button>`;

  $('#modalRoot').innerHTML = ccMenuShell('整天设置', sub, body, foot);
  ccMenu = $('#modalRoot');
  $('#ccW') && $('#ccW').focus();

  ccBindMenu(async (e) => {
    // 列表里逐段取消：两步确认，避免手滑把整段删了
    const del = e.target.closest('[data-day-del]');
    if (del) {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.textContent = '再点一次确认';
        return;
      }
      // 属性叫 data-day-del → dataset 里是 dayDel（不是 del！写错会静默取到 NaN）
      const sg = segs[+del.dataset.dayDel];
      if (!sg) return;
      const label = `${pad(sg.h0)}:${pad(sg.f0)} – ${(sg.t1 >= 60 ? pad(sg.h1 + 1) : pad(sg.h1))}:${pad(sg.t1 >= 60 ? 0 : sg.t1)}`;
      const ok = await Act.clockClearRange(d, sg.h0, sg.h1, `${WD[d]} ${label}`);
      if (ok !== false) ccCloseMenu();
      return;
    }
    const da = e.target.closest('[data-day-act]');
    if (da) {
      if (da.dataset.dayAct === 'select') await Act.clockDaySelect(d);
      else await Act.clockDayClear(d);
      ccCloseMenu();
      return;
    }
    if (!e.target.closest('#ccApply')) return;
    const { w: w2, b: b2 } = ccReadWb();
    const ok = await Act.clockDayWB(d, w2, b2, !!($('#ccDefToo') || {}).checked);
    if (ok !== false) ccCloseMenu();
  });
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
  // 语录区的右键归来源菜单管（上面那个监听已处理）。
  // 这里必须显式让路：末尾的 ccCloseMenu() 会把刚弹出来的来源面板关掉——
  // 两个 document 级监听、同一个事件，靠"谁先注册"来分工太脆。
  if (e.target && e.target.closest && e.target.closest('[data-quote-box]')) return;
  // 拖动中按右键 = 取消这次拖动，且不弹菜单（否则会一边拖一边弹窗）
  if (S.ccDrag) { e.preventDefault(); ccCancelDrag(); return; }
  if (!S.data) { ccCloseMenu(); return; }

  // ① 日期表头 → 整天设置（只这一天）
  const dh = e.target.closest('.cc-dh');
  if (dh) {
    e.preventDefault();
    const idx = [...document.querySelectorAll('.cc-dh')].indexOf(dh);
    if (idx >= 0) ccOpenDayMenu(idx);
    return;
  }

  // ② / ③ 格子：落在已有时段里 → 只改这一段；空白 → 这一格 / 当前框选
  const cell = e.target.closest('.cc-cell');
  if (!cell) { ccCloseMenu(); return; }
  e.preventDefault();
  const d = +cell.dataset.d;
  const h = +cell.dataset.h;
  // 真实右键：按指针落在哪一个最小粒度判断（02:00–02:10 那截空白就是空白）。
  // 没有真实坐标（脚本 / 自动化合成的 contextmenu）：退回"这一小时里有段就算段"，
  // 否则坐标一偏就会把"段"认成"空白格"，菜单跟着错。
  const box = cell.getBoundingClientRect();
  const real = e.clientY >= box.top - 2 && e.clientY <= box.bottom + 2
    && e.clientX >= box.left - 2 && e.clientX <= box.right + 2;
  const seg = real
    ? ccSegAt(d, ccGrainAt(d, e.clientY).idx * ccStep())
    : ccSegAtHour(d, h);
  if (seg) ccOpenSegMenu(d, seg);
  else ccOpenCellMenu(d, h);
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

/* 完整图表的「显示范围」下拉：改完立刻重画（纯显示参数，不需要二次确认） */
document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-act="clock-view"]');
  if (!el) return;
  await Act.clockView(el.dataset.k, el.value);
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

