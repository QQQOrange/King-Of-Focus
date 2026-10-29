/* 拦截页：文案全部走 i18n.js，语言跟随主程序。
 *
 * 这一版多了两件事：
 *   1) 「本段还剩 mm:ss」——告诉用户什么时候能回来，而不是一句"不能看"。
 *      数据来自 background 存进 storage 的 clockLeft（每轮 /api/state 刷新一次），
 *      页面自己按秒往下走；到 0 就提示"可以刷新了"。
 *   2) 休息结束被"收起来"的标签（sweep=1）：页面上说明是哪种收尾，
 *      并且**不重复上报**——收尾时 background 已经报过一次了。
 */
const q = new URLSearchParams(location.search);
const mode = q.get('mode') || '';
const rawRule = q.get('rule') || '';
const swept = q.get('sweep') === '1';
const queryUrl = q.get('u') || '';
let tick = null;

function urlText(u) {
  return String(u || '').replace(/^https?:\/\//, '').slice(0, 60);
}

/** 本段剩余时间倒计时：mm:ss；到点后换成"可以刷新了" */
function startCountdown(secs) {
  const row = document.getElementById('leftRow');
  const el = document.getElementById('left');
  if (!row || !el) return;
  let left = Math.max(0, Math.round(Number(secs) || 0));
  if (!left) { row.hidden = true; return; }
  row.hidden = false;
  const paint = () => {
    if (left <= 0) {
      el.textContent = ET('blocked.leftDone');
      if (tick) { clearInterval(tick); tick = null; }
      return;
    }
    const m = Math.floor(left / 60);
    const s = left % 60;
    el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    left -= 1;
  };
  paint();
  tick = setInterval(paint, 1000);
}

// 先定语言，再往页面上写任何字
extLoadLang().then(async () => {
  applyExtI18n();
  const rule = rawRule || ET('blocked.unknownRule');
  document.title = ET('blocked.docTitle');
  document.getElementById('ruleName').textContent = rule;

  let st = {};
  try {
    st = await chrome.storage.local.get(['lastUrl', 'clockOn', 'clockLeft', 'sweepMode']);
  } catch (e) { /* 插件刚重载，读不到就用空对象 */ }

  // 地址：优先 URL 参数（收尾/主动清理都会带上），其次 referrer，最后是缓存的心跳地址
  const url = queryUrl || document.referrer || (st && st.lastUrl) || '';
  document.getElementById('url').textContent = url ? urlText(url) : '—';

  if (mode === 'white') {
    document.getElementById('title').textContent = ET('blocked.title.white');
    document.getElementById('sub').textContent = ET('blocked.sub.white');
    document.getElementById('whiteRow').hidden = false;
  }

  // 收尾提示：说明"为什么这个标签还在，但变成了这一页"
  if (swept) {
    const tip = document.getElementById('sweepTip');
    if (tip) {
      tip.hidden = false;
      tip.textContent = ET(st && st.sweepMode === 'hard'
        ? 'blocked.sweepTip.hard' : 'blocked.sweepTip.soft');
    }
  }

  startCountdown(st && st.clockOn ? st.clockLeft : 0);

  // 让主程序把这次拦截计入统计；收尾流程已经报过，别重复记
  if (!swept) {
    try {
      chrome.runtime.sendMessage({ type: 'report', url: url || rule, rule });
    } catch (e) { /* 插件重载后 context 会失效，忽略 */ }
  }

  const btn = document.getElementById('reload');
  if (btn) btn.addEventListener('click', () => location.reload());
});
