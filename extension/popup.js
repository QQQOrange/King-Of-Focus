function render(v) {
  const dot = document.getElementById('dot');
  const stText = document.getElementById('stText');
  const connected = !!v.connected;
  dot.className = 'dot ' + (connected ? 'ok' : 'bad');
  stText.textContent = connected ? '已连接主程序' : '未连接（主程序没开？）';
  document.getElementById('port').textContent = v.port || '未发现';
  document.getElementById('mode').textContent = v.active ? '自律模式生效中' : '自由时间';
  const rules = v.activeRules || [];
  document.getElementById('cnt').textContent = rules.length;
  document.getElementById('list').innerHTML = rules
    .map((r) => `<li>${r.name}（${r.mode === 'whitelist' ? '强制' : '黑名单'} · ${r.sites} 条）</li>`)
    .join('');
}

chrome.runtime.sendMessage({ type: 'status' }, (v) => { if (v) render(v); });

document.getElementById('refresh').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'refresh' }, () => {
    chrome.runtime.sendMessage({ type: 'status' }, (v) => { if (v) render(v); });
  });
});
