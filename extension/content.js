/**
 * King Of Focus —— 页面侧脚本
 *
 * 两件事，都只读状态、不改网页本身的行为：
 *
 * 1. **顶部专注条**：自律生效期间在每个网页顶上挂一条"还在自律里 · 剩余 mm:ss"。
 *    浏览器全屏时主界面看不见，这条是唯一还看得见的提醒。可以收起成一个小圆点。
 *
 * 2. **藏起首页推荐流**（可选，默认关）：YouTube / B 站 / 知乎 / 微博 / X 的
 *    *首页信息流*。注意只动"首页推荐"，搜索、播放页、私信一律不碰——
 *    改坏一个网站比少拦一会儿更让人恼火。
 *
 * 状态从 `chrome.storage.local` 读（background 每轮 refresh 会写），
 * 不在页面里轮询本地端口：网页脚本不该有访问 127.0.0.1 的能力。
 */
(() => {
  'use strict';

  /* ---------------- 推荐流规则 ----------------
   * test 决定"这个页面算不算首页"；sel 是要隐藏的容器。
   * 只列**推荐/信息流**容器，不列整页布局——宁可少藏，不要藏错。
   */
  const FEEDS = [
    {
      name: 'youtube',
      test: (u) => /(^|\.)youtube\.com$/.test(u.hostname),
      sel: [
        'ytd-browse[page-subtype="home"] #contents',
        'ytd-reel-shelf-renderer',
        '#secondary #related',
      ],
    },
    {
      name: 'bilibili',
      test: (u) => /(^|\.)bilibili\.com$/.test(u.hostname) && (u.pathname === '/' || u.pathname === '/index.html'),
      sel: ['.recommend-list-v1', '#reco_list', '.bili-feed4-layout .feed-card'],
    },
    {
      name: 'zhihu',
      test: (u) => /(^|\.)zhihu\.com$/.test(u.hostname) && (u.pathname === '/' || u.pathname === '/follow'),
      sel: ['.Topstory-recommend', '.Recommendations', '.Topstory-mainColumn .Feed'],
    },
    {
      name: 'weibo',
      test: (u) => /(^|\.)weibo\.(com|cn)$/.test(u.hostname) && (u.pathname === '/' || u.pathname === '/hot'),
      sel: ['#pl_feedlist_index', '.wbpro-feed'],
    },
    {
      name: 'x',
      test: (u) => /(^|\.)(x|twitter)\.com$/.test(u.hostname) && u.pathname.startsWith('/home'),
      sel: ['[aria-label="Home timeline"]', '[data-testid="primaryColumn"] [aria-label="Timeline: Trending now"]'],
    },
  ];

  const CSS_ID = 'kof-hide-style';
  const BAR_ID = 'kof-focus-bar';
  const BAR_CSS_ID = 'kof-bar-style';
  const NOTE_CLASS = 'kof-feed-note';

  /**
   * 专注条固定在**左下角**，不是顶部横条。
   *
   * 顶部横条会盖住站点自己的导航（YouTube 的头、B 站的顶栏都在 top:0），
   * 那等于为了提醒而破坏页面。左下角是各站点几乎不用的位置，也不挡内容。
   */
  const BAR_CSS = `
#kof-focus-bar{position:fixed;left:12px;bottom:12px;z-index:2147483646;display:flex;align-items:center;gap:8px;
  max-width:min(520px,calc(100vw - 24px));padding:7px 10px;border-radius:10px;
  background:rgba(18,20,28,.94);color:#e8ecf5;font:12px/1.1 system-ui,-apple-system,"Segoe UI",sans-serif;
  box-shadow:0 6px 20px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.06);backdrop-filter:blur(6px)}
#kof-focus-bar .kof-dot{width:7px;height:7px;border-radius:50%;background:#4d8dff;box-shadow:0 0 0 3px rgba(77,141,255,.18);flex:0 0 auto}
#kof-focus-bar .kof-txt{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.2px}
#kof-focus-bar .kof-min{all:unset;cursor:pointer;width:18px;height:18px;line-height:17px;text-align:center;border-radius:5px;color:#9aa4b8;flex:0 0 auto}
#kof-focus-bar .kof-min:hover{background:rgba(255,255,255,.1);color:#fff}
#kof-focus-bar.kof-collapsed{padding:6px;border-radius:50%}
#kof-focus-bar.kof-collapsed .kof-txt,#kof-focus-bar.kof-collapsed .kof-min{display:none}
.kof-feed-note{margin:10px 0;padding:14px 16px;border:1px dashed rgba(120,130,150,.45);border-radius:10px;
  color:#8b94a7;font:12.5px/1.6 system-ui,sans-serif;text-align:center}
`;

  let st = {
    active: false,
    feedHide: false,
    focusBar: true,
    clockLeft: 0,
    clockOn: false,
    lang: 'zh-CN',
    names: [],
  };
  let tick = 0;
  let left = 0;
  let collapsed = false;

  const T = (zh, en) => (st.lang === 'en' ? en : zh);

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  /* ---------------- 专注条 ---------------- */

  function ensureBar() {
    let el = document.getElementById(BAR_ID);
    if (el) return el;
    if (!document.getElementById(BAR_CSS_ID)) {
      const s = document.createElement('style');
      s.id = BAR_CSS_ID;
      s.textContent = BAR_CSS;
      (document.head || document.documentElement).appendChild(s);
    }
    el = document.createElement('div');
    el.id = BAR_ID;
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<span class="kof-dot"></span>' +
      '<span class="kof-txt"></span>' +
      '<button class="kof-min" type="button" title="">–</button>';
    (document.body || document.documentElement).appendChild(el);
    el.querySelector('.kof-min').addEventListener('click', (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      el.classList.toggle('kof-collapsed', collapsed);
      el.querySelector('.kof-min').textContent = collapsed ? '+' : '–';
    });
    return el;
  }

  function paintBar() {
    if (!st.focusBar || !st.active) {
      const el = document.getElementById(BAR_ID);
      if (el) el.remove();
      return;
    }
    const el = ensureBar();
    el.classList.toggle('kof-collapsed', collapsed);
    const txt = el.querySelector('.kof-txt');
    const names = (st.names || []).join(' / ');
    if (collapsed) {
      txt.textContent = '';
    } else {
      const leftTxt = st.clockOn && left > 0 ? ' · ' + T('剩余 ', 'left ') + fmt(left) : '';
      txt.textContent = T('自律中', 'Focus on') + leftTxt + (names ? ' · ' + names : '');
    }
    el.title = names ? T('正在生效：', 'Active: ') + names : T('King Of Focus 自律生效中', 'King Of Focus is active');
  }

  /* ---------------- 推荐流 ---------------- */

  function applyFeeds() {
    const old = document.getElementById(CSS_ID);
    if (old) old.remove();
    document.querySelectorAll('.' + NOTE_CLASS).forEach((n) => n.remove());
    if (!st.feedHide) return;

    const rule = FEEDS.find((r) => r.test(location));
    if (!rule) return;

    const css = rule.sel.map((s) => s + '{display:none !important}').join('\n');
    const style = document.createElement('style');
    style.id = CSS_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);

    // 藏完给一句说明：否则用户只看到"页面空了"，以为网站坏了
    const anchor = document.querySelector(rule.sel[0]);
    if (anchor && anchor.parentElement) {
      const note = document.createElement('div');
      note.className = NOTE_CLASS;
      note.textContent = T(
        '推荐流已按 King Of Focus 的设置隐藏（设置 → 拦截行为 → 藏起首页推荐流）',
        'Recommendation feed hidden by King Of Focus (Settings → Blocking → Hide home feeds)',
      );
      anchor.parentElement.insertBefore(note, anchor);
    }
  }

  /* ---------------- 状态 ---------------- */

  function apply(next) {
    const wasActive = st.active;
    st = Object.assign({}, st, next || {});
    left = Number(st.clockLeft) || 0;
    paintBar();
    applyFeeds();
    if (!wasActive && st.active) scheduleTick();
  }

  function scheduleTick() {
    clearInterval(tick);
    tick = setInterval(() => {
      if (left > 0) left -= 1;
      if (st.focusBar && st.active) paintBar();
      if (!st.active) clearInterval(tick);
    }, 1000);
  }

  function load() {
    try {
      chrome.storage.local.get(
        ['active', 'feedHide', 'focusBar', 'clockLeft', 'clockOn', 'lang', 'activeRules', 'lastSync'],
        (v) => {
          apply({
            active: !!v.active,
            feedHide: !!v.feedHide,
            focusBar: v.focusBar !== false,
            clockLeft: Number(v.clockLeft) || 0,
            clockOn: !!v.clockOn,
            lang: v.lang === 'en' ? 'en' : 'zh-CN',
            names: (v.activeRules || []).map((r) => r && r.name).filter(Boolean),
          });
        },
      );
    } catch (e) {
      /* 扩展被更新/重载时上下文会失效，静默即可 */
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const patch = {};
      let hit = false;
      for (const k of Object.keys(changes)) {
        if (['active', 'feedHide', 'focusBar', 'clockLeft', 'clockOn', 'lang', 'activeRules'].includes(k)) {
          patch[k] = changes[k].newValue;
          hit = true;
        }
      }
      if (!hit) return;
      if (patch.activeRules) patch.names = (patch.activeRules || []).map((r) => r && r.name).filter(Boolean);
      apply(patch);
    });
  } catch (e) {
    /* 同上 */
  }

  // 单页应用（YouTube/X）切路由不会重新注入脚本：监听 DOM，必要时重挂
  const mo = new MutationObserver(() => {
    if (!document.getElementById('kof-hide-style') && st.feedHide) applyFeeds();
    if (st.focusBar && st.active && !document.getElementById(BAR_ID)) paintBar();
  });
  try {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {
    /* ignore */
  }

  load();
})();
