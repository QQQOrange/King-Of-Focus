/* 拦截通知窗：由 Rust 侧通过事件推送内容，窗口本身不做任何逻辑判断 */
(function () {
  const $ = (id) => document.getElementById(id);
  const card = $('card');
  let hideTimer = null;
  let raf = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function render(p) {
    const kind = p.kind === 'site' ? 'site' : 'app';
    $('ico').className = 'ico ' + kind;
    $('ico').textContent = kind === 'site' ? '网' : '王';
    $('title').textContent = p.title || '已被拦截';
    $('sub').innerHTML = p.body || '';
    $('tag').textContent = p.tag || (kind === 'site' ? '网页自律规则' : '应用自律规则');
  }

  function play(secs) {
    card.classList.remove('in');
    // 强制回流，让动画能重放
    void card.offsetWidth;
    card.classList.add('in');

    const total = Math.max(1, secs || 4) * 1000;
    const start = performance.now();
    const bar = $('bar');
    cancelAnimationFrame(raf);
    const step = (t) => {
      const p = Math.min(1, (t - start) / total);
      bar.style.transform = `scaleX(${1 - p})`;
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => card.classList.remove('in'), Math.max(600, total - 260));
  }

  // Tauri 事件（如果注入了 withGlobalTauri）
  const api = window.__TAURI__;
  if (api && api.event && api.event.listen) {
    api.event.listen('kof-toast', (e) => {
      const p = e.payload || {};
      render(p);
      play(p.secs);
    });
  }

  // 兜底：URL 参数（万一事件通道不可用）
  const q = new URLSearchParams(location.search);
  if (q.get('title')) {
    render({ kind: q.get('kind'), title: q.get('title'), body: q.get('body'), tag: q.get('tag') });
    play(+(q.get('secs') || 4));
  }
})();
