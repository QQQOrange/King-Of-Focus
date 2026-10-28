/* 桌面 HUD：每秒拉一次状态，纯展示 */
'use strict';

const T = window.__TAURI__;
const invoke = T && T.core ? T.core.invoke : async () => ({});

const themeMedia = window.matchMedia('(prefers-color-scheme: light)');
document.documentElement.dataset.theme = themeMedia.matches ? 'light' : 'dark';

function pad(n) { return String(n).padStart(2, '0'); }
function hms(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}
function hm(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
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
    ? '休息中'
    : s.locked
      ? '固化专注中'
      : '专注中';

  document.getElementById('elapsed').textContent = hms(s.elapsed);

  const until = document.getElementById('until');
  until.textContent = s.untilText ? `至 ${s.untilText}` : '';

  const remain = document.getElementById('remain');
  remain.classList.toggle('warn', !!s.warn);
  if (s.breakOn) {
    remain.textContent = `休息还剩 ${hm(s.breakLeft)}，之后自动锁回`;
  } else if (s.warn && s.breakLeft > 0) {
    remain.textContent = `本轮还剩 ${hm(s.breakLeft)} · 快结束了`;
  } else if (s.remaining > 0) {
    remain.textContent = `距结束 ${hm(s.remaining)}`;
  } else {
    remain.textContent = '本时段没有设定结束时间';
  }

  const q = s.quote || '';
  if (q && q !== lastQuote) {
    lastQuote = q;
    const el = document.getElementById('quote');
    el.style.opacity = '0';
    setTimeout(() => {
      el.textContent = q;
      el.style.transition = 'opacity .45s ease';
      el.style.opacity = '1';
    }, 180);
  }
  document.getElementById('from').textContent = s.quoteFrom ? `—— ${s.quoteFrom}` : '';
}

// HUD 是个桌面小挂件，右键不该弹出浏览器内核那套页面菜单
document.addEventListener('contextmenu', (e) => e.preventDefault());

tick();
setInterval(tick, 1000);
