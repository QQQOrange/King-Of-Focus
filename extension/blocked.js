const q = new URLSearchParams(location.search);
const rule = q.get('rule') || '网站黑名单';
const mode = q.get('mode') || '';
const target = document.referrer || '';

document.getElementById('ruleName').textContent = rule;

// 尝试从 last blocked 里拿地址（DNR 重定向不带原始 URL，用 referrer 兜底）
let url = target;
if (!url) {
  chrome.storage.local.get('lastUrl').then((v) => {
    if (v && v.lastUrl) document.getElementById('url').textContent = v.lastUrl;
  });
} else {
  document.getElementById('url').textContent = url.replace(/^https?:\/\//, '').slice(0, 60);
}

if (mode === 'white') {
  document.getElementById('title').textContent = '这个页面不在白名单里';
  document.getElementById('sub').textContent = '强制模式下，只允许打开白名单里的网站。';
  document.getElementById('whiteRow').hidden = false;
}

// 让主程序把这次拦截计入统计
try {
  chrome.runtime.sendMessage({ type: 'report', url: url || rule, rule });
} catch (e) { /* 插件重载后 context 会失效，忽略 */ }
