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

  const BAR_ID = 'kof-focus-bar';
  const NOTE_CLASS = 'kof-feed-note';

  /**
   * 为什么所有样式都走 CSSOM（`el.style.xxx = ...`），而不是插一个 <style>：
   *
   * 很多站点的 CSP 里没有 `style-src 'unsafe-inline'`（X / GitHub 都是），
   * 内容脚本往页面里塞的 <style> 会被浏览器拦掉——表现就是"功能开了，页面没变"，
   * 而且控制台里只有一条和插件无关的 CSP 报错，用户根本查不到。
   * 直接改元素的 style 属性（CSSOM）不经过 CSP 解析，稳定得多。
   */
  const BAR_STYLE = {
    position: 'fixed',
    left: '12px',
    bottom: '12px',
    zIndex: '2147483646',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    maxWidth: 'min(520px, calc(100vw - 24px))',
    padding: '7px 10px',
    borderRadius: '10px',
    background: 'rgba(18,20,28,.94)',
    color: '#e8ecf5',
    font: '12px/1.1 system-ui,-apple-system,"Segoe UI",sans-serif',
    boxShadow: '0 6px 20px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.06)',
    backdropFilter: 'blur(6px)',
  };

  function style(el, obj) {
    for (const k in obj) el.style[k] = obj[k];
    return el;
  }

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
    el = document.createElement('div');
    el.id = BAR_ID;
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<span class="kof-dot"></span>' +
      '<span class="kof-txt"></span>' +
      '<button class="kof-min" type="button" title="">–</button>';
    style(el, BAR_STYLE);
    const dot = el.querySelector('.kof-dot');
    style(dot, {
      width: '7px', height: '7px', borderRadius: '50%', background: '#4d8dff',
      boxShadow: '0 0 0 3px rgba(77,141,255,.18)', flex: '0 0 auto',
    });
    const txt = el.querySelector('.kof-txt');
    style(txt, {
      flex: '1 1 auto', whiteSpace: 'nowrap', overflow: 'hidden',
      textOverflow: 'ellipsis', letterSpacing: '.2px',
    });
    const min = el.querySelector('.kof-min');
    style(min, {
      all: 'unset', cursor: 'pointer', width: '18px', height: '18px',
      lineHeight: '17px', textAlign: 'center', borderRadius: '5px',
      color: '#9aa4b8', flex: '0 0 auto',
    });
    (document.body || document.documentElement).appendChild(el);
    // 整条都可以点：收起之后按钮是隐藏的，如果只有按钮能切换，
    // 用户把专注条收成小圆点后就再也打不开了（只能刷新页面）。
    el.addEventListener('click', () => {
      collapsed = !collapsed;
      paintCollapsed(el);
    });
    min.addEventListener('click', (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      paintCollapsed(el);
    });
    return el;
  }

  /** 收起态只留一个小圆点：改的是这一个元素，不依赖 class + 样式表 */
  function paintCollapsed(el) {
    const txt = el.querySelector('.kof-txt');
    const min = el.querySelector('.kof-min');
    if (collapsed) {
      el.style.padding = '6px';
      el.style.borderRadius = '50%';
      el.style.cursor = 'pointer';
      txt.style.display = 'none';
      min.style.display = 'none';
    } else {
      el.style.padding = BAR_STYLE.padding;
      el.style.borderRadius = BAR_STYLE.borderRadius;
      el.style.cursor = 'default';
      txt.style.display = '';
      min.style.display = '';
      min.textContent = '–';
    }
  }

  function paintBar() {
    if (!st.focusBar || !st.active) {
      const el = document.getElementById(BAR_ID);
      if (el) el.remove();
      return;
    }
    const el = ensureBar();
    paintCollapsed(el);
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

  let feedKey = '';

  function applyFeeds() {
    const rule = st.feedHide ? FEEDS.find((r) => r.test(location)) : null;
    const key = rule ? rule.name + '|' + location.pathname : '';
    if (key === feedKey) return;   // 同一页不重复跑（MutationObserver 会频繁触发）
    feedKey = key;
    document.querySelectorAll('.' + NOTE_CLASS).forEach((n) => n.remove());
    if (!rule) {
      restoreHidden();
      return;
    }

    let first = null;
    rule.sel.forEach((s) => {
      document.querySelectorAll(s).forEach((el) => {
        // 记一下原值：关掉开关/离开首页时要能还原，不能把页面永久改坏
        if (el.dataset.kofHidden !== '1') {
          el.dataset.kofHidden = '1';
          el.dataset.kofPrev = el.style.display || '';
        }
        el.style.setProperty('display', 'none', 'important');
        if (!first) first = el;
      });
    });
    restoreHidden(rule.sel);

    // 藏完给一句说明：否则用户只看到"页面空了"，以为网站坏了
    if (first && first.parentElement) {
      const note = document.createElement('div');
      note.className = NOTE_CLASS;
      note.textContent = T(
        '推荐流已按 King Of Focus 的设置隐藏（设置 → 拦截行为 → 藏起首页推荐流）',
        'Recommendation feed hidden by King Of Focus (Settings → Blocking → Hide home feeds)',
      );
      style(note, {
        margin: '10px 0', padding: '14px 16px',
        border: '1px dashed rgba(120,130,150,.45)', borderRadius: '10px',
        color: '#8b94a7', font: '12.5px/1.6 system-ui,sans-serif', textAlign: 'center',
      });
      first.parentElement.insertBefore(note, first);
    }
  }

  /** 把之前藏过、但现在不该藏的节点还原（切路由 / 关开关时） */
  function restoreHidden(keepSelectors) {
    document.querySelectorAll('[data-kof-hidden="1"]').forEach((el) => {
      if (keepSelectors && keepSelectors.some((s) => el.matches(s))) return;
      el.style.display = el.dataset.kofPrev || '';
      delete el.dataset.kofHidden;
      delete el.dataset.kofPrev;
    });
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

  // 单页应用（YouTube/X）切路由不会重新注入脚本：监听 DOM，必要时重挂。
  //
  // 这里必须**有限度**：MutationObserver 在 X 那种页面上每秒能触发几十次，
  // 无条件调 applyFeeds 会把主线程拖死。所以只在"该有的东西不见了"时才重跑：
  //   · 专注条被站点重渲染冲掉；
  //   · 已经藏过的推荐流标记消失（说明路由换了 / 节点被替换）。
  //
  // 再叠一层 300ms 合并：即使只是查两次 DOM，每秒几十次也够让页面发涩。
  let moTimer = 0;
  const mo = new MutationObserver(() => {
    if (moTimer) return;
    moTimer = setTimeout(() => {
      moTimer = 0;
      if (st.focusBar && st.active && !document.getElementById(BAR_ID)) paintBar();
      if (st.feedHide && feedKey && !document.querySelector('.' + NOTE_CLASS)) {
        feedKey = '';
        applyFeeds();
      }
    }, 300);
  });
  try {
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {
    /* ignore */
  }

  load();
})();
