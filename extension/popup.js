/* 插件弹窗：语言跟随主程序（EXT_LANG 由 i18n.js 从 storage 读出）。 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function kindOf(mode) {
  if (mode === 'whitelist') return ET('kind.whitelist');
  if (mode === 'both') return ET('kind.both');
  return ET('kind.blacklist');
}

/** mm:ss（本段剩余） */
function fmtLeft(secs) {
  const n = Math.max(0, Math.round(Number(secs) || 0));
  if (!n) return '—';
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function render(v) {
  const dot = document.getElementById('dot');
  const stText = document.getElementById('stText');
  const connected = !!v.connected;
  dot.className = 'dot ' + (connected ? 'ok' : 'bad');
  stText.textContent = connected ? ET('status.connected') : ET('status.disconnected');
  document.getElementById('port').textContent = v.port || ET('port.none');
  // 状态三选一：规则生效 → 专注中；自律时段里的休息 → 休息中；其余 → 自由时间
  document.getElementById('mode').textContent = v.active
    ? ET('mode.focus') : (v.clockBreak ? ET('mode.break') : ET('mode.free'));
  document.getElementById('left').textContent = v.clockOn ? fmtLeft(v.clockLeft) : '—';

  const rules = v.activeRules || [];
  document.getElementById('cnt').textContent = rules.length;
  document.getElementById('list').innerHTML = rules.length
    ? rules.map((r) => `<li>${esc(ET('rule.item', {
      name: r.name, mode: kindOf(r.mode), n: r.sites,
    }))}</li>`).join('')
    : `<li>${esc(ET('rules.empty'))}</li>`;

  // 收尾：当前方式 + 上一次收了多少个标签
  document.getElementById('sweep').textContent = v.sweepEnabled === false
    ? ET('sweep.off')
    : ET(v.sweepMode === 'hard' ? 'sweep.hard' : 'sweep.soft');
  document.getElementById('swept').textContent = v.lastSweepCount
    ? `${v.lastSweepCount}` : '—';
}

function pull() {
  chrome.runtime.sendMessage({ type: 'status' }, (v) => { if (v) render(v); });
}

// 先定语言再渲染：避免先出中文再跳成英文的闪动
extLoadLang().then(() => {
  applyExtI18n();
  pull();
});

document.getElementById('refresh').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'refresh' }, () => pull());
});

// 手动收尾：按当前模式处理已打开的黑名单标签页（柔和=换拦截页 / 强制=关）
document.getElementById('sweepNow').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'sweepWeb' }, () => pull());
});
