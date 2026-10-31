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

/* ---------------- 版本与更新 ----------------
 *
 * 插件不能自己装自己（未打包安装没有静默更新通道），所以这里只负责
 * "按平台校验后告诉用户有没有新版"，并给出本平台的下载地址。
 * 校验全在 update.js 里（纯函数、node 单测），弹窗只是显示层。
 */
const updMsg = document.getElementById('updMsg');
const updWrap = document.getElementById('updGetWrap');
const updAuto = document.getElementById('updAuto');

function renderUpd(r) {
  updWrap.style.display = 'none';
  if (!r) { updMsg.textContent = ''; return; }
  if (r.status === 'reject') {
    // 校验没过：原话 + 错误码，别让用户以为"只是网络问题"
    updMsg.style.color = '#ff8a80';
    updMsg.textContent = ET('upd.rejected', { msg: r.message, code: r.code });
    return;
  }
  if (r.status === 'none') {
    updMsg.style.color = '#7fd1a0';
    updMsg.textContent = ET('upd.none') + ' v' + r.current;
    return;
  }
  updMsg.style.color = '#ffd479';
  updMsg.textContent = ET('upd.found', { ver: r.latest }) +
    (r.file ? ' · ' + r.file : '') + '\n' +
    (r.source === 'asset-scan' ? ET('upd.fallback') + '\n' : '') +
    ET('upd.noInstall');
  if (r.url) {
    updWrap.style.display = '';
    updWrap.dataset.url = r.url;
  }
}

document.getElementById('updVer').textContent = 'v' + chrome.runtime.getManifest().version;
document.getElementById('updPlat').textContent =
  KOFUpd.platformLabel(KOFUpd.PLATFORM) + '（' + KOFUpd.PLATFORM + '）';

chrome.storage.local.get({ updAuto: true, updResult: null }, (v) => {
  updAuto.checked = !!v.updAuto;
  renderUpd(v.updResult || null);
});

updAuto.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'setAutoUpdate', value: updAuto.checked });
});

document.getElementById('updCheck').addEventListener('click', () => {
  updMsg.style.color = '#8b95a8';
  updMsg.textContent = ET('upd.checking');
  chrome.runtime.sendMessage({ type: 'checkUpdate' }, (r) => renderUpd(r));
});

document.getElementById('updGet').addEventListener('click', () => {
  const url = updWrap.dataset.url;
  if (url) chrome.tabs.create({ url });
});

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
