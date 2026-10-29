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

function render(v) {
  const dot = document.getElementById('dot');
  const stText = document.getElementById('stText');
  const connected = !!v.connected;
  dot.className = 'dot ' + (connected ? 'ok' : 'bad');
  stText.textContent = connected ? ET('status.connected') : ET('status.disconnected');
  document.getElementById('port').textContent = v.port || ET('port.none');
  document.getElementById('mode').textContent = v.active ? ET('mode.active') : ET('mode.free');

  const rules = v.activeRules || [];
  document.getElementById('cnt').textContent = rules.length;
  document.getElementById('list').innerHTML = rules.length
    ? rules.map((r) => `<li>${esc(ET('rule.item', {
      name: r.name, mode: kindOf(r.mode), n: r.sites,
    }))}</li>`).join('')
    : `<li>${esc(ET('rules.empty'))}</li>`;
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
