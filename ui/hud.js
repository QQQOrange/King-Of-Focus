/* 桌面 HUD：每秒拉一次状态，纯展示 */
'use strict';

const T = window.__TAURI__;
const invoke = T && T.core ? T.core.invoke : async () => ({});

const themeMedia = window.matchMedia('(prefers-color-scheme: light)');
document.documentElement.dataset.theme = themeMedia.matches ? 'light' : 'dark';

/* HUD 的文案自己带一份：它是个独立窗口，只有 8 句话，
 * 而且每句都要往里插时长，用全局词典反而要拼一堆碎片。 */
const HUD_T = {
  'zh-CN': {
    focus: '专注中', brk: '休息中', locked: '固化专注中',
    until: '至', idle: '还没有开始',
    breakLeft: '休息还剩 {t}，之后自动锁回',
    warn: '本轮还剩 {t} · 快结束了',
    remain: '距结束 {t}',
    noEnd: '本时段没有设定结束时间',
    h: '小时', m: '分', s: '秒',
  },
  en: {
    focus: 'Focusing', brk: 'On break', locked: 'Hard-locked',
    until: 'until', idle: 'Not started yet',
    breakLeft: 'Break ends in {t}, then locks back',
    warn: 'Left this round: {t} · almost done',
    remain: 'Ends in {t}',
    noEnd: 'No end time for this window',
    h: 'h', m: 'min', s: 's',
  },
};
let HUD_LANG = 'zh-CN';

function L(k, vars) {
  const pack = HUD_T[HUD_LANG] || HUD_T['zh-CN'];
  let s = pack[k] != null ? pack[k] : HUD_T['zh-CN'][k];
  if (s == null) return k;
  if (vars) {
    Object.keys(vars).forEach((v) => { s = s.split('{' + v + '}').join(String(vars[v])); });
  }
  return s;
}

function pad(n) { return String(n).padStart(2, '0'); }
function hms(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}
function hm(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (HUD_LANG === 'en') {
    if (h > 0) return `${h} h ${pad(m)} min`;
    if (m > 0) return `${m} min`;
    return `${sec} s`;
  }
  if (h > 0) return `${h} 小时 ${pad(m)} 分`;
  if (m > 0) return `${m} 分钟`;
  return `${sec} 秒`;
}

let lastQuote = '';

async function tick() {
  let s;
  try {
    s = await invoke('hud_state');
  } catch (e) {
    return;
  }
  if (!s) return;

  HUD_LANG = s.lang === 'en' ? 'en' : 'zh-CN';
  document.documentElement.lang = HUD_LANG;

  const pref = s.theme || 'system';
  const t = pref === 'light' || pref === 'dark' ? pref : themeMedia.matches ? 'light' : 'dark';
  if (document.documentElement.dataset.theme !== t) {
    document.documentElement.dataset.theme = t;
  }

  // 透明度由设置页控制（30–100）。这里用 CSS opacity 做，
  // 比改窗口 alpha 更省事，也不影响点击穿透与置顶属性。
  const op = Math.max(30, Math.min(100, +(s.opacity || 92)));
  document.body.style.opacity = String(op / 100);

  document.body.classList.toggle('break', !!s.breakOn);
  document.getElementById('label').textContent = s.breakOn
    ? L('brk')
    : s.locked
      ? L('locked')
      : L('focus');

  document.getElementById('elapsed').textContent = hms(s.elapsed);

  const until = document.getElementById('until');
  until.textContent = s.untilText ? `${L('until')} ${s.untilText}` : '';

  const remain = document.getElementById('remain');
  remain.classList.toggle('warn', !!s.warn);
  if (s.breakOn) {
    remain.textContent = L('breakLeft', { t: hm(s.breakLeft) });
  } else if (s.warn && s.breakLeft > 0) {
    remain.textContent = L('warn', { t: hm(s.breakLeft) });
  } else if (s.remaining > 0) {
    remain.textContent = L('remain', { t: hm(s.remaining) });
  } else {
    remain.textContent = L('noEnd');
  }

  const qEl = document.getElementById('quote');
  const goal = s.goal || '';
  // 专注中：这一行显示"这一段要做什么"（没写就是一行虚线提示，点一下就能写）。
  // 为什么占用格言的位置而不是加一行：HUD 只有 272×122，加行会把下面的东西挤没；
  // 而专注时"我原本要做的事"比一句格言有用得多。
  if (s.inSegment) {
    qEl.classList.toggle('ghost', !goal);
    qEl.dataset.goal = '1';
    if (qEl.textContent !== (goal || goalPh())) qEl.textContent = goal || goalPh();
    document.getElementById('from').textContent = s.segLabel ? `—— ${s.segLabel}` : '';
    lastQuote = '';
  } else {
    delete qEl.dataset.goal;
    qEl.classList.remove('ghost');
    const q = s.quote || '';
    if (q && q !== lastQuote) {
      lastQuote = q;
      qEl.style.opacity = '0';
      setTimeout(() => {
        qEl.textContent = q;
        qEl.style.transition = 'opacity .45s ease';
        qEl.style.opacity = '1';
      }, 180);
    }
    document.getElementById('from').textContent = s.quoteFrom ? `—— ${s.quoteFrom}` : '';
  }

  // 被打断次数：只在非零时出现在顶部那一行
  const blk = document.getElementById('blk');
  blk.textContent = s.blocks > 0
    ? (HUD_LANG === 'en' ? `· ${s.blocks} interrupts` : `· 打断 ${s.blocks}`)
    : '';

  // —— 记一笔：模块开着才有按钮，位置跟着设置走 ——
  const on = !!s.distractOn;
  document.body.classList.toggle('has-cap', on);
  if (on) {
    const corner = ['tl', 'tr', 'bl', 'br'].includes(s.distractCorner) ? s.distractCorner : 'tl';
    ['tl', 'tr', 'bl', 'br'].forEach((c) => document.body.classList.toggle('cap-' + c, c === corner));
    // 关掉模块时把已经打开的输入框也收起来，否则会留下一个没有按钮的空面板
    if (!on && !panel.hidden) closeCapture();
  } else if (!panel.hidden) {
    closeCapture();
  }
}

/* ---------------- 记一笔（分心事件） ----------------
 * 交互只求快：点一下 + 输入 + 回车，然后立刻回到刚才的事上。
 * 记下之后**不**切走、不弹详情、不要求分类——记录本身就是目的。
 */
const capBtn = document.getElementById('capBtn');
const panel = document.getElementById('capPanel');
const capInput = document.getElementById('capInput');
const capHint = document.getElementById('capHint');
let hintTimer = 0;
let pending = 0;
/** 面板当前在干嘛：'distract' = 记一笔；'goal' = 写这一段的目标 */
let mode = 'distract';
let curGoal = '';

function setHint(text, cls) {
  capHint.className = 'cap-hint' + (cls ? ' ' + cls : '');
  capHint.textContent = text;
}

function goalPh() {
  return HUD_LANG === 'en' ? 'Click: what is this session for?' : '点这里写下这段要做什么';
}

function openCapture(which) {
  mode = which || 'distract';
  if (!panel.hidden) return;
  panel.hidden = false;
  document.body.classList.add('capturing');
  if (mode === 'goal') {
    capInput.placeholder = HUD_LANG === 'en' ? 'What are you doing in this session?' : '这一段要做什么？';
    setHint(HUD_LANG === 'en' ? 'Enter to save · Esc to close' : '回车记下 · Esc 关闭');
    capInput.value = curGoal;
  } else {
    capInput.placeholder = HUD_LANG === 'en' ? 'A thought just popped up' : '刚冒出的想法，回车记下';
    setHint(HUD_LANG === 'en' ? 'Enter to save · Esc to close' : '回车记下 · Esc 关闭');
    capInput.value = '';
  }
  capInput.focus();
}

function closeCapture() {
  panel.hidden = true;
  document.body.classList.remove('capturing');
  capInput.blur();
}

async function saveCapture() {
  const text = capInput.value.trim();
  if (!text) {
    // 目标允许清空（= 这段不写目标）；记一笔则是"什么都没写，关掉就是"
    if (mode === 'goal') {
      try { await invoke('focus_goal_set', { text: '' }); curGoal = ''; } catch (e) { /* 忽略 */ }
    }
    closeCapture();
    return;
  }
  if (mode === 'goal') {
    try {
      const r = await invoke('focus_goal_set', { text });
      curGoal = (r && r.text) || text;
      closeCapture();
    } catch (e) {
      setHint(String(e).replace(/^Error:\s*/, ''), 'err');
    }
    return;
  }
  try {
    const r = await invoke('distract_add', { text });
    pending = (r && r.pending) || 0;
    document.getElementById('capN').textContent = pending > 99 ? '99+' : pending ? String(pending) : '';
    capInput.value = '';
    setHint(HUD_LANG === 'en' ? `Saved · ${pending} to process` : `已记下 · 待处理 ${pending} 条`, 'ok');
    // 2 秒后回到默认提示，输入框留着——用户可能连着想到好几条
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      setHint(HUD_LANG === 'en' ? 'Enter to save · Esc to close' : '回车记下 · Esc 关闭');
    }, 2000);
  } catch (e) {
    setHint(String(e).replace(/^Error:\s*/, ''), 'err');
  }
}

document.getElementById('quote').addEventListener('click', () => {
  if (document.getElementById('quote').dataset.goal) openCapture('goal');
});

capBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (panel.hidden) openCapture();
  else closeCapture();
});

capInput.addEventListener('keydown', (e) => {
  // 输入法组合中按回车是在选词，不能当成提交
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    saveCapture();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeCapture();
  }
});

// HUD 是个桌面小挂件，右键不该弹出浏览器内核那套页面菜单
document.addEventListener('contextmenu', (e) => e.preventDefault());

tick();
setInterval(tick, 1000);
