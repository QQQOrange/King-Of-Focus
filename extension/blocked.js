/* 拦截页：文案全部走 i18n.js，语言跟随主程序。 */
const q = new URLSearchParams(location.search);
const mode = q.get('mode') || '';
const rawRule = q.get('rule') || '';
const target = document.referrer || '';

// 先定语言，再往页面上写任何字
extLoadLang().then(() => {
  applyExtI18n();
  const rule = rawRule || ET('blocked.unknownRule');
  document.title = ET('blocked.docTitle');
  document.getElementById('ruleName').textContent = rule;

  // 地址（DNR 重定向不带原始 URL，用 referrer 兜底，再退到缓存）
  let url = target;
  if (!url) {
    chrome.storage.local.get('lastUrl').then((v) => {
      if (v && v.lastUrl) document.getElementById('url').textContent = v.lastUrl;
    });
  } else {
    document.getElementById('url').textContent = url.replace(/^https?:\/\//, '').slice(0, 60);
  }

  if (mode === 'white') {
    document.getElementById('title').textContent = ET('blocked.title.white');
    document.getElementById('sub').textContent = ET('blocked.sub.white');
    document.getElementById('whiteRow').hidden = false;
  }

  // 让主程序把这次拦截计入统计
  try {
    chrome.runtime.sendMessage({ type: 'report', url: url || rule, rule });
  } catch (e) { /* 插件重载后 context 会失效，忽略 */ }
});
