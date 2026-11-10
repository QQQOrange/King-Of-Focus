/* 工具 / 主题 / 状态拉取
 *
 * 由 app.js 按连续切片拆出（见 docs/release-notes 里那一版说明）。
 * 加载顺序就是原来的自上而下顺序：**不要**调整 <script> 的先后，
 * 顶层 const / function 共享同一个全局词法环境，换顺序会改变求值时机。
 */
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
  dayFailed: new Set(),  // 读取失败过的 `${tab}|${date}`：界面用它显示"重试"而不是永远转圈
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
  stats: '时长统计', distract: '分心事件', reports: '统计报告', sync: '云同步',
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

/**
 * 把后端抛出来的错误整理成一句能直接给用户看的话。
 *
 * Tauri 的 `Err(String)` 到前端会变成 `Error("...")`，直接拼进提示里就会出现
 * 「同步失败：Error: 密码不对」这种半截英文前缀。以前有 30 多处各自 `.replace()`，
 * 新的调用点总会忘，所以统一收在这里。
 */
function errText(v) {
  let s = typeof v === 'string' ? v : (v && v.message ? String(v.message) : String(v));
  s = s.replace(/^Error:\s*/, '').replace(/^Error:\s*/, '').trim();
  return s || '未知错误';
}

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = L(errText(msg));
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
    // 增量拉取：带上上一份配置的指纹，后端没变就把 config 省掉
    const since = S.cfgRev || 0;
    const data = await invoke('get_state', { since });
    if (data && data.config == null && S.data) data.config = S.data.config;
    S.cfgRev = (data && data.cfgRev) || 0;
    S.data = data;
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
      // 正在编辑规则时不弹：庆祝弹窗是直接写 #modalRoot 的，
      // 会把编辑器连同没保存的改动一起顶掉，而且没有任何提示。
      // 留在 runtime.celebrate 里，关掉编辑器后的下一拍再弹。
      const editing = S.modalMode === 'editor' || S.modalMode === 'slot';
      if (!editing) showCelebrate(S.data.runtime.celebrate);
    }
    // 之前只要有一次成功就把"失联"标记清掉
    S.pullFails = 0;
    markOffline(false);
  } catch (e) {
    console.error(e);
    // 后端在忙 / 正在重启时，这里会一直失败。以前只是 console.error：
    // 界面继续用上一份快照画着"自律中 / 剩余 12 分钟"，用户完全看不出
    // 自己看到的是一份过期状态。连续失败两次就在状态条上明说。
    S.pullFails = (S.pullFails || 0) + 1;
    if (S.pullFails >= 2) markOffline(true);
  }
}

/** 状态条上的"与后台失联"提示（恢复后自动消失） */
function markOffline(on) {
  const pill = $('#statePill');
  if (!pill) return;
  if (on) {
    if (!S.offline) {
      S.offline = true;
      pill.dataset.offline = '1';
      pill.textContent = I.t('与后台失联，正在重连…');
      pill.className = 'pill red';
    }
  } else if (S.offline) {
    S.offline = false;
    delete pill.dataset.offline;
    renderChrome();
  }
}

function renderChrome() {
  const tbn = $('#testBanner');
  if (tbn) tbn.classList.toggle('hidden', !(S.data && S.data.testMode));
  const d = S.data;
  if (!d) return;
  const on = d.runtime.disciplineOn;
  const pill = $('#statePill');
  // 失联期间别把"与后台失联"覆盖成"自律模式未开启"——那是在撒谎
  if (!S.offline) {
    pill.className = 'pill' + (on ? ' on' : '');
    pill.innerHTML = `<span class="dot"></span>${on ? '自律模式已开启' : '自律模式未开启'}`;
  }

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

