/* 弹层与事件绑定
 *
 * 由 app.js 按连续切片拆出（见 docs/release-notes 里那一版说明）。
 * 加载顺序就是原来的自上而下顺序：**不要**调整 <script> 的先后，
 * 顶层 const / function 共享同一个全局词法环境，换顺序会改变求值时机。
 */
'use strict';

/* ---------------- 弹层 ---------------- */
/** 关弹窗：先播一段退场再移除。
 *
 *  退场只有 120ms，但这段窗口里可能已经开了下一个弹窗（语录面板、导出面板
 *  之间是来回切的；自动化脚本里更常见）。所以监听一次子节点变化：
 *  一旦有人改写了 #modalRoot，就取消这次清理——宁可动画少播一帧，
 *  也不能把刚打开的新弹窗删掉。 */
function closeModal() {
  const root = $('#modalRoot');
  if (!root) return;
  // 关掉的是编辑器/格子弹窗时，把"正在编辑"也一起清掉。
  //
  // 以前只有 close-editor 那一条路径会清 S.editing；而庆祝弹窗、更新弹窗、
  // 浏览器引导都会直接覆盖 #modalRoot，用户用 close-modal 关掉之后 S.editing
  // 还指着一个已经销毁的规则，pull() 里 `!S.editing` 的判断从此永远为假 ——
  // 总览页再也不会自动刷新。
  if (S.modalMode === 'editor' || S.modalMode === 'slot') S.editing = null;
  S.modalMode = '';
  // 有些弹窗是"等用户选一个值"的 Promise（选择恢复方式、输入旧备份密码）。
  // 用 Esc / 点遮罩关掉时必须把它们 resolve(null)，否则调用方那个 await 永远挂着：
  // 弹窗关掉了，但"恢复"既没成功也没失败，什么都不发生。
  const onClose = MODAL_ON_CLOSE;
  MODAL_ON_CLOSE = null;
  if (onClose) { try { onClose(); } catch (_) { /* 忽略 */ } }
  const mask = root.querySelector('.modal-mask');
  if (!mask) { root.innerHTML = ''; return; }
  mask.classList.add('closing');
  const box = mask.querySelector('.modal');
  if (box) box.classList.add('closing');

  let tid = 0;
  const obs = new MutationObserver((muts) => {
    // 只有**新弹窗被插进来**才放弃清理。
    //
    // 以前这里是"任何 childList 变化都放弃"，代价是：弹窗里只要有会自己刷新的
    // 内容（进度、实时读数、自查面板的 250ms 刷新），关闭就永远执行不到——
    // 表现就是"按 Esc / 点关闭没反应，弹窗还在"。内部刷新不是新弹窗，别当成新弹窗。
    const replaced = muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1
      && (n.classList && n.classList.contains('modal-mask')
        || (n.querySelector && n.querySelector('.modal-mask')))));
    if (!replaced) return;
    obs.disconnect();
    clearTimeout(tid);
  });
  obs.observe(root, { childList: true, subtree: true });
  tid = setTimeout(() => {
    obs.disconnect();
    if (root.querySelector('.modal-mask') === mask) root.innerHTML = '';
  }, 120);
}

/* ---------------- 弹层键盘与焦点管理（KOF-01 ~ KOF-05） ----------------

   为什么需要这一层：`#modalRoot` 一直是"谁想弹就 innerHTML 直写"，没有任何
   "当前是哪一层"的概念。于是出现三个真问题：

   1. **Tab 会把焦点送到弹窗外面**——主界面的按钮一圈一圈地过，最后按 Esc
      反而关掉了弹窗，用户以为"键盘坏了"；
   2. **输入法组合中按 Enter 会提前提交**（拼音还没选字就点了保存）；
   3. 某个子组件 `stopPropagation()` 之后 Esc 再也到不了 document，弹窗卡住。

   这里刻意**不去改那十几处 innerHTML 写法**，而是用观察器盯着 #modalRoot：
   谁写进去，谁就自动成为一名"层"。写法不用变，行为统一。

   对外只暴露 `Layer`，并把层变化派发成 `SubLayerChanged` 事件
   （`document.addEventListener('SubLayerChanged', e => ...)`），
   任何子系统（拖选、快捷键面板、将来的键盘引擎）都能订阅，不用互相 import。 */

const Layer = (() => {
  /** 层栈，栈顶在最后。`{ el, name, at, focusBefore }` */
  const stack = [];
  /** 焦点被从层外拽回来的次数（自查面板显示，用来判断"是不是又逃了"） */
  let escapes = 0;
  /** 递增序号：同一时刻开两层也能分出新旧 */
  let seq = 0;

  const SEL = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function visible(el) {
    if (!el || !el.getClientRects) return false;
    // 不用 getClientRects 判可见：弹窗刚插入、还没排版时它是 0，
    // 那会让"第一下 Tab"因为找不到元素而被吃掉。
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  function focusables(root) {
    return [...root.querySelectorAll(SEL)].filter(
      (el) => !el.disabled && el.tabIndex >= 0 && visible(el),
    );
  }

  function nameOf(el) {
    const h = el.querySelector('.modal-hd h3') || el.querySelector('h3');
    const t = h ? (h.textContent || '').trim() : '';
    return t || '（未命名弹层）';
  }

  function firstFocus(el) {
    if (!el) return;
    const marked = el.querySelector('[data-autofocus]');
    const target = marked || focusables(el)[0];
    if (target && target.focus) {
      try { target.focus({ preventScroll: false }); } catch (_) { /* 老 WebView 不认参数 */ }
      return;
    }
    // 一层里没有可聚焦元素（纯文字提示）：让容器自己可聚焦，
    // 这样 Tab 至少有落点，不会直接跳回主界面。
    if (el.tabIndex < 0) el.tabIndex = -1;
    try { el.focus(); } catch (_) { /* 忽略 */ }
  }

  function emit() {
    const top = stack.length ? stack[stack.length - 1] : null;
    const detail = {
      count: stack.length,
      name: top ? top.name : '',
      at: top ? top.at : 0,
      escapes,
    };
    // 自查面板读它；顺便留在 window 上，方便排查时手输
    try { S.uiLayer = detail; } catch (_) { /* S 还没初始化 */ }
    document.dispatchEvent(new CustomEvent('SubLayerChanged', { detail }));
  }

  /** 把 #modalRoot 的现状同步成层栈（新增的入栈、消失的出栈） */
  function sync() {
    const root = document.getElementById('modalRoot');
    if (!root) return;
    const now = [...root.children].filter((el) => el.classList && el.classList.contains('modal-mask'));

    // 出栈：从后往前，保证"关顶层"先被处理
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (!now.includes(stack[i].el)) {
        const gone = stack.splice(i, 1)[0];
        // 只有关掉的是栈顶才把焦点还回去；关掉下层时焦点本来就在上层
        if (i === stack.length && gone.focusBefore && document.contains(gone.focusBefore)) {
          try { gone.focusBefore.focus(); } catch (_) { /* 元素可能已销毁 */ }
        }
      }
    }
    // 入栈：按 DOM 顺序补
    now.forEach((el) => {
      if (stack.some((l) => l.el === el)) return;
      stack.push({ el, name: nameOf(el), at: ++seq, focusBefore: document.activeElement });
      // 打开就把焦点送进去：否则第一下 Tab 是"从外面跳进来"，
      // 在用户看来就是"焦点先跑了一下"。
      const mine = stack[stack.length - 1];
      queueMicrotask(() => {
        if (stack[stack.length - 1] === mine) firstFocus(el);
      });
    });
    emit();
  }

  /** 焦点必须在栈顶层里；跑到外面就拽回来（keyup / 窗口回焦时调） */
  function ensureInside(why) {
    const top = stack.length ? stack[stack.length - 1] : null;
    if (!top) return;
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) {
      if (a && a !== document.body) return;
      escapes += 1;
      firstFocus(top.el);
      emit();
      return;
    }
    if (top.el.contains(a)) return;
    escapes += 1;
    if (why) top.why = why;
    firstFocus(top.el);
    emit();
  }

  /** 关掉栈顶那一层（Esc 用） */
  function closeTop() {
    const top = stack.length ? stack[stack.length - 1] : null;
    if (!top) return false;
    // 时段页的右键菜单有自己的收尾（清 hover、清边缘手柄），先让它走完
    if (top.el.querySelector('.cc-modal') && typeof ccCloseMenu === 'function') {
      ccCloseMenu();
      return true;
    }
    // 只有一层：走原来的 closeModal，保留它那套退场动画
    if (stack.length === 1) {
      closeModal();
      return true;
    }
    // 多层：**只摘掉栈顶**。
    // closeModal 内部是 `root.querySelector('.modal-mask')`（第一个）+ 清空整个
    // #modalRoot —— 那在嵌套时会把下面那层也一起关掉。所以这里自己移除。
    const el = top.el;
    el.classList.add('closing');
    const box = el.querySelector('.modal');
    if (box) box.classList.add('closing');
    setTimeout(() => { if (el.parentNode) el.remove(); }, 120);
    return true;
  }

  return {
    sync,
    ensureInside,
    closeTop,
    focusables,
    firstFocus,
    top: () => (stack.length ? stack[stack.length - 1] : null),
    size: () => stack.length,
    info: () => ({
      count: stack.length,
      names: stack.map((l) => l.name),
      name: stack.length ? stack[stack.length - 1].name : '',
      escapes,
    }),
    /** 自查面板用：量化地看"这一层里有几个可聚焦点、当前在第几个" */
    probe: () => {
      const top = stack.length ? stack[stack.length - 1] : null;
      if (!top) return { count: 0, index: -1, total: 0, name: '' };
      const items = focusables(top.el);
      return {
        count: stack.length,
        name: top.name,
        total: items.length,
        index: items.indexOf(document.activeElement),
      };
    },
  };
})();

/* 观察器：谁往 #modalRoot 写，谁就自动成为一层 */
(() => {
  const root = document.getElementById('modalRoot');
  if (!root || typeof MutationObserver === 'undefined') return;
  new MutationObserver(() => {
    Layer.sync();
    // 弹窗内容是 `#modalRoot.innerHTML = ...` 直接插进去的，而 `I.apply` 只在
    // 启动和切语言时对 document.body 跑过一次 —— 所以英文界面下**所有**弹窗
    // （规则编辑器、积分解锁、导出、报告、云端、更新…）一直是中文。
    // 这里跟一次翻译，只扫新插进来的这一层，代价很小。
    if (window.I18N && root.firstChild) {
      for (const el of root.children) I18N.apply(el);
    }
  }).observe(root, { childList: true });
  Layer.sync();
})();

/* KOF-01：Tab 焦点陷阱（capture 阶段，子组件 stopPropagation 也拦不住） */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const top = Layer.top();
  if (!top) return;
  // 输入法有时用 Tab 翻页选词，组合中不接管
  if (e.isComposing || e.keyCode === 229) return;
  const items = Layer.focusables(top.el);
  // 关键：不 preventDefault 的话浏览器会把焦点送出弹窗，这就是"焦点连续跳"
  e.preventDefault();
  if (!items.length) return;
  const cur = document.activeElement;
  const i = items.indexOf(cur);
  const forward = !e.shiftKey;
  const next = i < 0
    ? (forward ? 0 : items.length - 1)
    : (i + (forward ? 1 : -1) + items.length) % items.length;
  try { items[next].focus(); } catch (_) { /* 忽略 */ }
}, true);

/* KOF-03：Esc 也放 capture —— 子组件吞掉冒泡时仍然能关 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (e.isComposing || e.keyCode === 229) return;
  if (!Layer.top()) return;
  // 标记一下，冒泡阶段的旧逻辑看到就跳过，避免一次 Esc 关两层
  e.__kofEscHandled = true;
  e.preventDefault();
  Layer.closeTop();
}, true);

/* KOF-06：让"用 div 做的按钮"也能用键盘触发。
 *
 * 规则行、积分解锁行、窗口选择项都是 div（为了布局方便），它们没有原生按钮的
 * 键盘语义：Tab 到不了、回车也没反应。而积分解锁行偏偏是"被锁住时唯一的出路"。
 * 给它们加了 role="button" tabindex="0"，这里把 Enter / 空格转成一次点击。
 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const t = e.target;
  if (!t || !t.closest) return;
  const el = t.closest('[data-act][role="button"]');
  if (!el || el === t && el.tagName === 'BUTTON') return;
  e.preventDefault();
  el.click();
}, true);

/* KOF-04：keyup / 窗口回焦兜底——层还在，焦点却不在了，就拽回来 */
document.addEventListener('keyup', (e) => {
  if (e.key === 'Tab' || e.key === 'Escape') Layer.ensureInside('keyup');
}, true);
window.addEventListener('focus', () => Layer.ensureInside('window-focus'));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) Layer.ensureInside('visible');
});

/* KOF-05：层变化对外广播。现有消费者：时段页拖选/悬停状态需要在弹层出现时收尾 */
document.addEventListener('SubLayerChanged', (e) => {
  const d = (e && e.detail) || {};
  if (d.count > 0) {
    try { if (typeof ccEdgeClear === 'function') ccEdgeClear(); } catch (_) { /* 不在时段页 */ }
  }
});

/** KOF-07：键盘与焦点自查面板。
 *
 *  为什么要有个"自己测自己"的入口：Tab 逃出弹窗这种事，用户只能描述成
 *  "焦点乱跳"，而开发这边没有现成的可观测值。这个面板把内部状态摊开：
 *  当前几层、几个可聚焦点、焦点在第几个、被拽回了几次。
 *  它自己也是一个层，所以"打开它就等于在测它自己"——很省事。 */
function renderKeyCheck() {
  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="width:520px">
      <div class="modal-hd">
        <h3>键盘与焦点自查</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="list-row"><span class="grow">弹层数 / 当前层</span><b id="kcLayer">—</b></div>
        <div class="list-row"><span class="grow">可聚焦元素 / 焦点位置</span><b id="kcFocus">—</b></div>
        <div class="list-row"><span class="grow">焦点被拽回次数</span><b id="kcEscapes">0</b></div>
        <div class="list-row"><span class="grow">运行权限</span><b id="kcAdmin">—</b></div>
        <div class="hint" style="margin-top:12px">在这一层里按 Tab / Shift+Tab：焦点应该只在这几个控件之间循环，不会跑到主界面上。上面的「焦点位置」会跟着变；显示 — 说明焦点当前不在这层的任何控件上。</div>
        <div class="row" style="margin-top:10px;gap:8px;align-items:center">
          <input type="text" placeholder="在这里输入试试 Tab" style="flex:1" />
          <button class="btn btn-sm">测试按钮 A</button>
          <button class="btn btn-sm">测试按钮 B</button>
        </div>
        <div class="hint" style="margin-top:8px">Esc 关闭；打开期间如果焦点被外部抢走，会被自动拽回来（次数记在上面的「拽回次数」里）。</div>
      </div>
      <div class="modal-ft"><button class="btn" data-act="close-modal">关闭</button></div>
    </div>
  </div>`;

  const paint = () => {
    // 弹窗被关掉后停止刷新（节点没了就说明层已经不在）
    if (!document.getElementById('kcLayer')) { clearInterval(timer); return; }
    const p = Layer.probe();
    const info = Layer.info();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('kcLayer', p.count ? `${p.count} · ${p.name}` : '没有弹层');
    set('kcFocus', p.count ? `${p.index >= 0 ? p.index + 1 : '—'} / ${p.total}` : '—');
    set('kcEscapes', String(info.escapes));
    set('kcAdmin', S.data && S.data.admin ? '管理员' : '普通权限');
  };
  let timer = 0;
  timer = setInterval(paint, 250);
  paint();
}

function renderPicker() {
  const list = (S.picker || []).filter((w) => w.title);
  const html = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal">
      <div class="modal-hd">
        <h3>${S.pickerFor === 'mask' ? '选择要保留显示的窗口' : '选择要拦截的程序'}</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="add-row"><input type="text" id="pickerSearch" placeholder="搜索窗口标题或进程名…" /></div>
        <div class="picker-list" id="pickerList">
          ${list.length ? list.map((w, i) => `<div class="picker-item" data-act="pick-item" data-i="${i}" role="button" tabindex="0">
            <span class="badge ${w.title ? 'gold' : ''}">${esc(w.name || '?')}</span>
            <div style="flex:1;min-width:0">
              <div class="nm">${esc(w.title || '(无标题)')}</div>
              <div class="ti">${esc(w.path || '')}</div>
            </div>
          </div>`).join('') : '<div class="empty">没有找到带窗口的程序</div>'}
        </div>
        <div class="hint" style="margin-top:12px">列表只显示当前有可见窗口的进程。想拦截的游戏可以先打开它，再回来这里选。</div>
      </div>
    </div>
  </div>`;
  $('#modalRoot').innerHTML = html;
  const s = $('#pickerSearch');
  if (s) s.addEventListener('input', () => {
    const q = s.value.toLowerCase();
    document.querySelectorAll('#pickerList .picker-item').forEach((el) => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

/** 「我的语录」管理面板：列出、删除、添加，保存前都只改本地副本 */
/** 语录来源设置（右键 Hub 上的语录弹出）。
 *
 *  一屏说清三件事：现在用的是哪个、还有哪些能选、怎么加一个新的。
 *  内置来源标「内置」且不给删除按钮——它是断网时唯一的兜底。
 */
function renderQuoteSrcModal() {
  const list = quoteFeeds();
  const cur = quoteActiveFeed();
  const kindTxt = { local: '本地', json: '联网 · JSON', text: '联网 · 纯文本' };
  const rows = list.map((f) => {
    const on = f.id === cur.id;
    return `<div class="fsrc${on ? ' on' : ''}">
      <div class="fsrc-main">
        <div class="fsrc-name">${esc(f.name)}
          <span class="badge ${f.kind === 'local' ? '' : 'blue'}">${kindTxt[f.kind] || f.kind}</span>
          ${f.builtin ? '<span class="badge">内置</span>' : ''}
          ${on ? '<span class="badge gold">使用中</span>' : ''}
        </div>
        <div class="fsrc-url">${f.url ? esc(f.url) : `本地预置 ${(window.KOF_QUOTES || []).length} 条，永不联网`}</div>
      </div>
      <div class="fsrc-ops">
        ${on ? '<span class="hint">当前</span>'
    : `<button class="btn btn-sm" data-act="quote-pick-feed" data-id="${esc(f.id)}">用它</button>`}
        ${f.builtin ? '' : `<button class="btn btn-sm danger-ghost" data-act="quote-del-feed" data-id="${esc(f.id)}">删除</button>`}
      </div>
    </div>`;
  }).join('');

  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="width:620px">
      <div class="modal-hd">
        <h3>语录来源</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="hint" style="margin-bottom:10px;line-height:1.8">
          点「换一条」时，会按这里选中的来源取一句。<b>联网源取不到就自动退回本地预置</b>，
          断网也照样能换，不会卡住。
        </div>
        <div class="flist">${rows}</div>

        <div class="card" style="margin-top:16px;padding:14px 14px 12px">
          <div class="card-title" style="font-size:13px">添加自定义来源</div>
          <div class="hint" style="margin:6px 0 10px;line-height:1.7">
            地址返回 JSON 时，会自动认 <code>hitokoto</code> / <code>text</code> / <code>content</code> / <code>sentence</code>
            这几个字段；返回纯文本就选「纯文本」，取第一行。
          </div>
          <div class="qfeed-form">
            <input type="text" id="qfeedName" maxlength="24" placeholder="名称（显示在语录下方）" />
            <input type="text" id="qfeedUrl" maxlength="300" placeholder="https://example.com/api/quote" />
            <select id="qfeedKind">
              <option value="json">联网 · JSON</option>
              <option value="text">联网 · 纯文本</option>
            </select>
            <button class="btn btn-sm btn-primary" data-act="quote-add-feed">添加</button>
          </div>
        </div>
      </div>
      <div class="modal-ft">
        <span class="hint" style="flex:1">右键语录随时回到这里</span>
        <button class="btn" data-act="close-modal">关闭</button>
      </div>
    </div>
  </div>`;
}

function renderQuoteModal() {
  const list = S.quoteEdit || [];
  const rows = list.length
    ? list.map((t, i) => `<div class="qrow">
        <span class="n">${i + 1}</span>
        <span class="t">${esc(t)}</span>
        <button class="btn btn-sm danger-ghost" data-act="quote-del" data-i="${i}">删除</button>
      </div>`).join('')
    : '<div class="empty" style="padding:20px"><span class="ico">”</span>还没有自己写的语录，在下面输入一句吧。</div>';
  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="width:600px">
      <div class="modal-hd">
        <h3>我的激励语录 <span class="badge">${list.length} 条</span></h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="hint" style="margin-bottom:12px">
          这里的句子会和联网取到的「一言」一起在 Hub 顶部轮换，每条下面都会标明来源。
        </div>
        <div class="qlist">${rows}</div>
        <div class="row" style="gap:8px;margin-top:14px">
          <input type="text" id="quoteNew" style="flex:1" maxlength="120"
            placeholder="写一句给自己的话（最多 120 字），回车即可添加" />
          <button class="btn btn-sm" data-act="quote-add">添加</button>
        </div>
      </div>
      <div class="modal-ft">
        <button class="btn" data-act="close-modal">取消</button>
        <button class="btn btn-primary" data-act="quote-save">保存</button>
      </div>
    </div>
  </div>`;
  const inp = $('#quoteNew');
  if (inp) {
    inp.focus();
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        Act.quoteAdd();
      }
    });
  }
}

function renderReportModal() {
  const r = S.reportView;
  if (!r) return;
  const total = r.onSecs + r.offSecs;
  const merged = mergeSlices(r.on || [], r.off || []);
  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal wide" style="width:940px">
      <div class="modal-hd">
        <h3>${esc(r.title)} <span class="badge">${r.start} ~ ${r.end}</span></h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="grid-3" style="margin-bottom:16px">
          <div class="mini"><div class="l">自律模式已开启</div><div class="v" style="color:var(--gold)">${fmtDur(r.onSecs)}</div></div>
          <div class="mini"><div class="l">自律模式未开启</div><div class="v">${fmtDur(r.offSecs)}</div></div>
          <div class="mini"><div class="l">合计</div><div class="v">${fmtDur(total)}</div></div>
        </div>
        <div class="grid-2">
          <div>
            <div class="card-title">已开启</div>
            <canvas id="pieOn" width="240" height="240"></canvas>
            <div class="legend" id="legOn"></div>
          </div>
          <div>
            <div class="card-title">未开启</div>
            <canvas id="pieOff" width="240" height="240"></canvas>
            <div class="legend" id="legOff"></div>
          </div>
        </div>
        <div style="margin-top:18px">
          <div class="card-title">汇总（两状态直接相加）</div>
          <div class="row" style="gap:20px;align-items:flex-start">
            <canvas id="pieAll" width="240" height="240"></canvas>
            <div class="legend" id="legAll" style="flex:1"></div>
          </div>
        </div>
      </div>
      <div class="modal-ft">
        <button class="btn btn-danger" data-act="del-report" data-id="${r.id}">删除这份报告</button>
        <button class="btn" data-act="close-modal">关闭</button>
      </div>
    </div>
  </div>`;

  const draw = (sel, legSel, slices, tot) => {
    const cv = $(sel);
    if (!cv) return;
    const old = $('#legend');
    drawPie(cv, slices, tot, { sub: fmtDurShort(tot) });
  };
  // 逐个画，图例临时切换目标
  const legBackup = ['#legend'];
  const paint = (canvasSel, legSel, slices, tot) => {
    const cv = $(canvasSel);
    if (!cv) return;
    const size = 240;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size * dpr; cv.height = size * dpr;
    cv.style.width = size + 'px'; cv.style.height = size + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    let items = slices.slice(0, 7).map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }));
    const rest = slices.slice(7).reduce((a, b) => a + b.secs, 0);
    if (rest > 0) items.push({ label: '其他', secs: rest, color: '#4a5468' });
    const sum = items.reduce((a, b) => a + b.secs, 0);
    const cx = size / 2, cy = size / 2, rOut = 100, rIn = 62;
    if (sum > 0) {
      let ang = -Math.PI / 2;
      for (const it of items) {
        const a = (it.secs / sum) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, rOut, ang, ang + a);
        ctx.arc(cx, cy, rIn, ang + a, ang, true);
        ctx.closePath();
        ctx.fillStyle = it.color; ctx.fill();
        ctx.strokeStyle = cssVar('--panel-a'); ctx.lineWidth = 2; ctx.stroke();
        ang += a;
      }
    } else {
      ctx.beginPath(); ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
      ctx.strokeStyle = cssVar('--line-2'); ctx.lineWidth = rOut - rIn; ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = cssVar('--text'); ctx.font = '600 15px "Microsoft YaHei UI", sans-serif';
    ctx.fillText(fmtDurShort(tot), cx, cy + 1);
    ctx.fillStyle = cssVar('--text-3'); ctx.font = '10px "Microsoft YaHei UI", sans-serif';
    ctx.fillText('合计', cx, cy + 18);

    const lg = $(legSel);
    if (lg) lg.innerHTML = items.map((it) => `<div class="leg">
      <span class="sw" style="background:${it.color}"></span>
      <span class="nm">${esc(it.label)}</span>
      <span class="vv">${fmtDurShort(it.secs)}</span>
      <span class="pp">${sum ? ((it.secs / sum) * 100).toFixed(1) : 0}%</span>
    </div>`).join('');
  };

  paint('#pieOn', '#legOn', r.on || [], r.onSecs);
  paint('#pieOff', '#legOff', r.off || [], r.offSecs);
  paint('#pieAll', '#legAll', merged, total);
}

/* ---------------- 事件绑定 ---------------- */
// 当日日历的悬停读数：色块太薄写不下字时，靠这一行把"几点到几点、多少分钟"读出来。
// 用事件委托挂在 document 上 —— 日历每换一天都整块重画，绑在块上会越绑越多。
document.addEventListener('pointerover', (e) => {
  const ev = e.target && e.target.closest ? e.target.closest('.dc-ev') : null;
  if (ev) dcRead(ev.dataset.tip || '');
});
document.addEventListener('pointerout', (e) => {
  const ev = e.target && e.target.closest ? e.target.closest('.dc-ev') : null;
  if (ev) dcRead('');
});

document.addEventListener('click', async (e) => {
  const nav = e.target.closest('.nav-item');
  if (nav) { await Act.nav(nav.dataset.view); return; }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  // 锁定的开关（自律时段 / 固化期间）：吞掉这次点击，只说明原因。
  //
  // 以前靠 CSS `pointer-events:none` 挡住，结果点击直接穿透到下面那一行的
  // 「编辑」动作上 —— 用户点那个灰掉的开关，弹出来的是规则编辑器，
  // 而且怎么改都保存不了。现在统一在这里拦，所有锁定开关行为一致。
  if (el.classList.contains('locked') && el.classList.contains('switch')) {
    if (guardDiscipline(act === 'toggle-rule' ? '切换自律规则开关' : '修改这项设置')) return;
  }

  // ---- 首用向导 ----
  if (act === 'wiz-open') { wizOpen(); return; }
  if (act === 'wiz-close') { wizClose(); return; }
  if (act === 'wiz-skip') {
    try { await invoke('onboard_skip'); } catch (e) { /* 跳过失败也无所谓 */ }
    wizClose();
    await pull();
    toast('以后想再看，在「设置 → 新手引导」里重新打开', 'ok');
    return;
  }
  if (act === 'wiz-day') {
    const st = wizState();
    const d = Number(el.dataset.d);
    st.days = st.days.includes(d) ? st.days.filter((x) => x !== d) : st.days.concat([d]).sort((a, b) => a - b);
    wizRender();
    return;
  }
  if (act === 'wiz-app') {
    const st = wizState();
    const p2 = el.dataset.path;
    st.apps = st.apps.includes(p2) ? st.apps.filter((x) => x !== p2) : st.apps.concat([p2]);
    wizRender();
    return;
  }
  if (act === 'wiz-next') {
    const st = wizState();
    st.step = Math.min(2, st.step + 1);
    wizRender();
    return;
  }
  if (act === 'wiz-back') {
    const st = wizState();
    st.step = Math.max(0, st.step - 1);
    wizRender();
    return;
  }
  if (act === 'wiz-done') { await wizDone(); return; }
  if (act === 'wiz-try') { await wizTry(); return; }

  // ---- 口径说明 ----
  if (act === 'tip') { showTip(el.dataset.k); return; }
  if (act === 'review-save') { await reviewSave(); return; }
  // 复盘里问到"哪一条值得现在处理"，就得给一条能过去的路——
  // 只提问不给出路，那一问等于白问。
  if (act === 'review-goto') { await Act.nav(el.dataset.view || 'distract'); return; }
  if (act === 'review-week') {
    S.review = S.review || {};
    S.review.offset = Number(el.dataset.off) || 0;
    await reviewLoad();
    return;
  }

  // ---- 今天三件套 ----
  if (act === 'goal-state') {
    const seg = Number(el.dataset.seg) || 0;
    const now = el.dataset.st || '';
    // 再点一次同一个 = 撤销（填错、或者想重新判断一次）
    const state = (Number(el.dataset.on) === 1) ? '' : now;
    try {
      // 后端在"变成 done"时会发奖励分，返回 { goal, bonus }
      const r = await invoke('focus_goal_state', { seg, state });
      const bonus = (r && Number(r.bonus)) || 0;
      await pull();
      render();
      const base = state === 'done' ? '记下了：这一段做完了'
        : state === 'partial' ? '记下了：做了一半'
          : state === 'missed' ? '记下了：这一段没做成。下次把目标切小一点。'
            : '已撤销判定';
      const tail = bonus > 0 ? ` · +${bonus} 分` : bonus < 0 ? ` · ${bonus} 分` : '';
      toast(base + tail, 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
    return;
  }
  if (act === 'stake') {
    try {
      const r = await invoke('stake_place', { amount: (S.data.stake || {}).stake || 10 });
      await pull();
      render();
      toast(`已押 ${r.amount} 分：跑完退 ${r.amount + ((S.data.stake || {}).bonus || 2)}`, 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
    return;
  }
  if (act === 'today-clock') { await Act.nav('clock'); return; }
  if (act === 'today-mask') {
    const m = ((S.data.config.settings || {}).mask || {});
    const pid = m.targetPid || 0;
    if (pid > 0) {
      try {
        await invoke('mask_start', { pid, title: m.targetTitle || '' });
        toast('遮罩已盖上：这一段只看目标窗口', 'ok');
      } catch (e) {
        // 目标窗口可能已经关掉了：退回"自己选一次"，别静默什么都不发生
        toast(String(e).replace(/^Error:\s*/, ''), 'err');
        await Act.nav('mask');
      }
    } else {
      // 没选过目标：直接把窗口选择器弹出来，选完立刻盖。
      // 以前这里只提示"先选一次"然后跳到遮罩页，而那一页没有选窗口的入口。
      toast('选一个要保留显示的窗口，选完立刻盖上');
      await Act.pickMaskTarget();
    }
    return;
  }

  // ---- 分心事件 ----
  if (act === 'dx-view') { dxState().view = el.dataset.v; render(); return; }
  if (act === 'dx-prev' || act === 'dx-next') {
    const d = dxState();
    const step = act === 'dx-prev' ? -1 : 1;
    if (d.view === 'month') {
      const [y, m] = d.month.split('-').map(Number);
      const dt = new Date(y, m - 1 + step, 1);
      d.month = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
    } else {
      const dt = addDays(new Date(d.day + 'T00:00:00'), step * 7);
      d.day = dateStr(dt);
      d.month = d.day.slice(0, 7);
    }
    await dxLoad();
    return;
  }
  if (act === 'dx-today') {
    const d = dxState();
    d.day = todayStr();
    d.month = d.day.slice(0, 7);
    await dxLoad();
    return;
  }
  if (act === 'dx-pick') {
    const d = dxState();
    const day = el.dataset.day || todayStr();
    if (!day) return;
    d.day = day;
    d.month = day.slice(0, 7);
    await dxLoad();
    return;
  }
  if (act === 'dx-toggle') {
    const done = el.dataset.done === '1';
    try {
      await invoke('distract_toggle', { id: el.dataset.id, done: !done });
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
    await dxLoad();
    return;
  }
  if (act === 'dx-del') {
    if (!confirm('删掉这条记录？删了就找不回来了。')) return;
    try {
      await invoke('distract_delete', { id: el.dataset.id });
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
    await dxLoad();
    return;
  }
  if (act === 'dx-clear') {
    const d = dxState();
    if (!confirm('清掉这一天的已处理记录？')) return;
    try {
      const r = await invoke('distract_clear_done', { day: d.day });
      toast(`已清掉 ${(r && r.cleared) || 0} 条`, 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
    await dxLoad();
    return;
  }
  if (act === 'dx-on') {
    // 这个开关以前**没有任何 handler**：点一下视觉变了，但不落盘，
    // 任何一次重绘又亮回去，HUD 上的「＋」也还在。现在点一下就保存。
    const box = $('#dxOn');
    const on = box ? box.checked : true;
    const cur = (S.data.config.settings || {}).distract || {};
    const numOr = (sel, fallback) => {
      const el = $(sel);
      const v = el ? parseInt(el.value, 10) : NaN;
      return Number.isFinite(v) ? v : fallback;
    };
    try {
      await invoke('distract_save', {
        enabled: on,
        remindMinutes: numOr('#dxMin', cur.remindMinutes || 0),
        remindMaxDays: numOr('#dxMaxDays', cur.remindMaxDays || 0),
        buttonCorner: cur.buttonCorner || 'tl',
      });
      await pull();
      toast(on ? '分心事件已开启' : '分心事件已关闭', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
    return;
  }
  if (act === 'reload-app') { location.reload(); return; }
  if (act === 'dx-mask') {
    const box = $('#dxMask');
    const on = box ? box.checked : true;
    try {
      await invoke('distract_auto_mask', { on });
      await pull();
      // 不 render：整页重建会把同一张卡上"重复提醒"输入框里还没保存的数字冲掉。
      // 这个开关本身是原生 checkbox，视觉已经是对的，只需要刷新数据。
      toast(on ? '已开启：时段一开始就自动盖遮罩' : '已关闭自动遮罩', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
    return;
  }
  if (act === 'dx-save') {
    const on = !!($('#dxOn') || {}).checked;
    const min = parseInt(($('#dxMin') || {}).value, 10);
    const days = parseInt(($('#dxDays') || {}).value, 10);
    const corner = ($('#dxCorner') || {}).value || 'tl';
    try {
      await invoke('distract_save', {
        enabled: on,
        remindMinutes: Number.isFinite(min) ? min : 120,
        remindMaxDays: Number.isFinite(days) ? days : 7,
        buttonCorner: corner,
      });
      await pull();
      render();
      toast('已保存：HUD 按钮与提醒节奏立即生效', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
    return;
  }

  if (act === 'close-modal-bg' && e.target.closest('.modal-mask') === el && e.target === el) { closeModal(); return; }
  if (act === 'close-modal' || act === 'close-editor') {
    if (act === 'close-editor') S.editing = null;
    closeModal(); return;
  }
  if (act === 'new-rule') { openEditor(null, true); return; }
  if (act === 'edit-rule') {
    if (e.target.closest('[data-act="toggle-rule"]') || e.target.closest('[data-act="del-rule"]')) return;
    openSlotModal(el.dataset.id); return;
  }
  if (act === 'slot-more') {
    if (!S.editing) return;
    S.modalMode = 'editor';
    S.editorTab = 'apps';
    renderFullEditor();
    return;
  }
  if (act === 'save-slot') { await Act.saveEditor(); return; }
  if (act === 'toggle-rule') {
    const sw = el.querySelector('input');
    if (sw) sw.checked = !sw.checked;
    await Act.toggleRule(el.dataset.id); return;
  }
  if (act === 'del-rule') { await Act.delRule(el.dataset.id); return; }
  if (act === 'mode') {
    if (!S.editing) return;
    syncEditorInputs();
    S.editing.mode = el.dataset.mode;
    renderEditor(); return;
  }
  if (act === 'editor-tab') { syncEditorInputs(); S.editorTab = el.dataset.tab; renderEditor(); return; }
  if (act === 'hard-toggle') { Act.hardToggle(); return; }
  if (act === 'break-kind') { Act.breakKind(el.dataset.k); return; }
  if (act === 'mask-save') { await Act.maskSave(); return; }
  if (act === 'open-unlock') { Act.openUnlock(); return; }
  if (act === 'open-help') { await Act.nav('help'); return; }
  if (act === 'do-unlock') { await Act.pointsUnlock(+el.dataset.min); return; }
  if (act === 'do-unlock-sleep') { await Act.sleepUnlock(); return; }
  if (act === 'noop') { toast('积分不够，先去专注赚点分', 'err'); return; }
  if (act === 'save-editor') { await Act.saveEditor(); return; }
  if (act === 'del-app') { if (!S.editing) return; S.editing.apps.splice(+el.dataset.i, 1); renderEditor(); return; }
  if (act === 'del-site') { if (!S.editing) return; S.editing.sites.splice(+el.dataset.i, 1); renderEditor(); return; }
  if (act === 'del-exc') { if (!S.editing) return; S.editing.exceptions.splice(+el.dataset.i, 1); renderEditor(); return; }
  if (act === 'pick-running-app') { await Act.pickRunningApp(); return; }
  if (act === 'pick-file') { await Act.pickFile('file'); return; }
  if (act === 'pick-dir') { await Act.pickDir(); return; }
  if (act === 'add-site') { Act.addSite(); return; }
  if (act === 'quick-site') { Act.quickSite(el.dataset.v); return; }
  if (act === 'add-exc') { Act.addExc(); return; }
  if (act === 'sched-copy') { Act.schedCopy(el.dataset.from, el.dataset.to); return; }
  if (act === 'sched-clear') { Act.schedClear(); return; }
  if (act === 'tk-slot-del') {
    if (!S.editing) return;
    const day = +el.dataset.day, i = +el.dataset.i;
    const slots = (S.editing.schedule[day] || []).slice();
    if (!slots[i]) return;
    slots.splice(i, 1);
    S.editing.schedule[day] = slots;
    renderEditor();
    return;
  }
  if (act === 'pick-item') {
    // 遮罩模式：选中即开遮罩（只留这个窗口可见）
    if (S.pickerFor === 'mask') {
      const w = (S.picker || []).filter((x) => x.title)[+el.dataset.i];
      if (w) {
        closeModal();
        try {
          await invoke('mask_start', { pid: w.pid, title: w.title || '' });
          await pull();
          render();
          toast(`遮罩已开：只保留「${w.title}」`, 'ok');
        } catch (e) {
          toast('开遮罩失败：' + errText(e), 'err');
        }
      }
      return;
    }
    const w = (S.picker || []).filter((x) => x.title)[+el.dataset.i];
    if (!w) return;
    {
      const label = (w.name || '').replace(/\.exe$/i, '') || (w.title || '').slice(0, 20);
      S.editing.apps.push({
        id: 'a' + Date.now().toString(36),
        kind: w.path ? 'exe' : 'name',
        value: w.path || w.name,
        label,
      });
      closeModal();
      renderEditor();
    }
    return;
  }
  if (act === 'toggle-mask') { await Act.toggleMask(); return; }
  if (act === 'clock-enable') { await Act.clockEnable(); return; }
  if (act === 'clock-apply-rules') { await Act.clockApplyRules(); return; }
  if (act === 'sweep-toggle') { await Act.sweepToggle(); return; }
  if (act === 'sweep-mode') { await Act.sweepMode(el.dataset.v); return; }
  if (act === 'sweep-media') { await Act.sweepMedia(); return; }
  if (act === 'clock-clear') { await Act.clockClear(); return; }
  if (act === 'clock-def-save') { await Act.clockDefSave(); return; }
  if (act === 'clock-prof') { await Act.clockProfSwitch(el.dataset.id); return; }
  if (act === 'clock-prof-new') { ccNameDialog('new'); return; }
  if (act === 'clock-prof-rename') { ccNameDialog('rename'); return; }
  if (act === 'clock-prof-dup') { await Act.clockProfDup(); return; }
  if (act === 'clock-prof-del') { await Act.clockProfDel(); return; }
  if (act === 'hud-corner') { await Act.hudCorner(el.dataset.v); return; }
  if (act === 'clock-gran') { await Act.clockGran(el.dataset.v); return; }
  // 下拉框在 click 上什么都不做（真正的改动在 change 里，见下面那条监听）
  if (act === 'clock-view') return;
  if (act === 'clock-fit') { await Act.clockFit(el.dataset.v === '1'); return; }
  if (act === 'sleep-enable') { await Act.sleepEnable(); return; }
  if (act === 'sleep-save') { await Act.sleepSave(); return; }
  if (act === 'rule-launch') { openLaunchModal(el.dataset.id); return; }
  if (act === 'launch-toggle') { Act.launchToggle(); return; }
  if (act === 'launch-add') { Act.launchAdd(); return; }
  if (act === 'launch-del') { Act.launchDel(el.dataset.id); return; }
  if (act === 'launch-up') { Act.launchMove(el.dataset.id, -1); return; }
  if (act === 'launch-down') { Act.launchMove(el.dataset.id, 1); return; }
  if (act === 'launch-win') { Act.launchSetWin(el.dataset.id, el.dataset.v); return; }
  if (act === 'launch-kind') { Act.launchSetKind(el.dataset.id, el.dataset.v); return; }
  if (act === 'launch-save') { await Act.launchSave(); return; }
  if (act === 'sleep-add-seg') { await Act.sleepAddSeg(); return; }
  if (act === 'sleep-del-seg') { await Act.sleepDelSeg(el.dataset.id); return; }
  if (act === 'sleep-pick-seg') { Act.sleepPickSeg(el.dataset.id); return; }
  if (act === 'sleep-cycle') { await Act.sleepCycle(el.dataset.v); return; }
  if (act === 'sleep-day') { await Act.sleepToggleDay(el.dataset.v); return; }
  if (act === 'sleep-unlock') { await Act.sleepUnlock(); return; }
  if (act === 'clock-view-reset') { await Act.clockViewReset(); return; }
  // S.ccAnimIn 只在这一帧为真：完整图表页的入场动画不能每次重绘都重播，
  // 否则拖完一段松手（内部会 render 一次）整页就会重新淡入 = 闪一下。
  if (act === 'cc-open') { S.ccFull = true; S.ccAnimIn = true; render(); S.ccAnimIn = false; return; }
  if (act === 'cc-close') { S.ccFull = false; render(); return; }
  if (act === 'clock-bind') { await Act.clockBind(el.dataset.id || ''); return; }
  if (act === 'cc-name-ok') {
    const inp = $('#ccNameInput');
    const name = ((inp && inp.value) || '').trim().slice(0, 30);
    if (!name) { toast('方案名不能为空', 'err'); if (inp) inp.focus(); return; }
    closeModal();
    if (el.dataset.mode === 'new') await Act.clockProfNew(name);
    else await Act.clockProfRename(name);
    return;
  }
  if (act === 'mask-diag') { await Act.maskDiag(); return; }
  if (act === 'mask-preview') { await Act.maskPreview(); return; }
  if (act === 'toggle-follow-schedule') { await Act.toggleFollowSchedule(); return; }
  if (act === 'toggle-click') { await Act.toggleClick(); return; }
  if (act === 'toggle-follow') { await Act.toggleFollow(); return; }
  if (act === 'toggle-media-pause') { await Act.toggleMediaPause(); return; }
  if (act === 'test-enter') { await Act.enterTestMode(); return; }
  if (act === 'test-exit-keep') { await Act.askExitTest(true); return; }
  if (act === 'test-exit-discard') { await Act.askExitTest(false); return; }
  if (act === 'test-exit-do') { closeModal(); await Act.exitTestMode(el.dataset.keep === '1'); return; }
  if (act === 'stats-tab') { await Act.statsTab(el.dataset.tab); return; }
  if (act === 'range') { await Act.setRange(el.dataset.r); return; }
  if (act === 'range-apply') { await Act.applyRange(); return; }
  if (act === 'stats-refresh') { await Act.refreshStats(); return; }
  if (act === 'quote-next') { Act.quoteNext(); return; }
  if (act === 'quote-open-src') { await Act.quoteOpenSrc(); return; }
  if (act === 'quote-src-menu') { Act.quoteSrcMenu(); return; }
  if (act === 'quote-pick-feed') { await Act.quotePickFeed(el.dataset.id); return; }
  if (act === 'quote-del-feed') { await Act.quoteDelFeed(el.dataset.id); return; }
  if (act === 'quote-add-feed') { await Act.quoteAddFeed(); return; }
  if (act === 'quote-manage') { Act.quoteManage(); return; }
  if (act === 'quote-add-new') { Act.quoteAddNew(); return; }
  if (act === 'set-quote-add') { await Act.setQuoteAdd(); return; }
  if (act === 'set-quote-del') { await Act.setQuoteDel(+el.dataset.i); return; }
  if (act === 'quote-add') { Act.quoteAdd(); return; }
  if (act === 'quote-del') { Act.quoteDel(+el.dataset.i); return; }
  if (act === 'quote-save') { await Act.quoteSave(); return; }
  if (act === 'gen-report') { await Act.genReport(); return; }
  if (act === 'gen-period') { await Act.genPeriodSet(el.dataset.v); return; }
  if (act === 'open-report') { await Act.openReport(el.dataset.id); return; }
  if (act === 'reports-refresh') { await loadReports(); render(); return; }
  if (act === 'report-export-open') { Act.repExportOpen(el.dataset.id); return; }
  if (act === 'report-export-do') { await Act.repExportDo(el.dataset.f); return; }
  if (act === 'report-del-ask') { Act.repDeleteAsk(el.dataset.id); return; }
  if (act === 'report-del-do') { await Act.repDeleteDo(); return; }
  if (act === 'save-custom-days') { await Act.saveCustomDays(); return; }
  // 详情弹窗里的「删除这份报告」：同样走二次确认面板，不再用系统 confirm
  if (act === 'del-report') { Act.repDeleteAsk(el.dataset.id); return; }
  if (act === 'stat-toggle') { await Act.statToggle(el.dataset.k); return; }
  if (act === 'cfg-switch') { await Act.cfgSwitch(el.dataset.k); return; }
  if (act === 'save-num') { await Act.saveNum(el.dataset.k); return; }
  if (act === 'save-quote-mins') { await Act.saveQuoteMins(); return; }
  if (act === 'save-notify') { await Act.saveNotify(); return; }
  if (act === 'save-hotkey') { await Act.saveHotkey(); return; }
  if (act === 'backup-make') { await Act.backupMake(); return; }
  if (act === 'backup-export') { await Act.backupExport(); return; }
  if (act === 'backup-import') { await Act.backupImport(); return; }
  if (act === 'mode-merge' || act === 'mode-overwrite' || act === 'mode-cancel') { pickRestoreMode(act); return; }
  if (act === 'backup-restore') { await Act.backupRestore(el.dataset.path); return; }
  if (act === 'backup-del') { await Act.backupDelete(el.dataset.path); return; }
  if (act === 'backup-pass') { await Act.backupSavePass(); return; }
  if (act === 'cloud-list') { await Act.cloudList(); return; }
  if (act === 'cloud-upload') { await Act.cloudUpload(); return; }
  if (act === 'cloud-restore') { await Act.cloudRestore(el.dataset.name); return; }
  if (act === 'backup-dir') { await invoke('backup_open_dir'); return; }
  if (act === 'save-protected') { await Act.saveProtected(); return; }
  if (act === 'reset-pick') { S.resetSection = el.dataset.k; render(); return; }
  if (act === 'reset-section') { await Act.resetSection(); return; }
  if (act === 'reset-undo') { await Act.resetUndo(); return; }
  if (act === 'theme') { await Act.setTheme(el.dataset.v); return; }
  if (act === 'cal-mode') { await Act.calMode(el.dataset.m); return; }
  if (act === 'cal-move') { await Act.calMove(+el.dataset.d); return; }
  if (act === 'cal-today') { await Act.calToday(); return; }
  if (act === 'cal-pick') { await Act.calPick(el.dataset.date); return; }
  if (act === 'day-move') { await Act.dayMove(+el.dataset.d); return; }
  if (act === 'day-today') { await Act.dayToday(); return; }
  if (act === 'day-ev') { Act.focusPick(el.dataset.key); return; }
  if (act === 'focus-clear') { Act.focusClear(); return; }
  if (act === 'pie-close') {
    const host = document.querySelector('#pieDetail');
    if (host) { host.dataset.key = ''; host.innerHTML = ''; }
    // 收起饼图明细 = 不再"聚焦"某个分类：当日日历和日历上的描边一起撤掉
    if (S.calHit) Act.focusClear();
    return;
  }
  if (act === 'lang') { await Act.setLang(el.dataset.v); return; }
  if (act === 'cycle-theme') { await Act.cycleTheme(); return; }
  if (act === 'restart-admin') { await Act.restartAdmin(); return; }
  if (act === 'key-check') { Act.keyCheck(); return; }
  if (act === 'open-ext') { await Act.openExt(); return; }
  if (act === 'force-quit') { await Act.forceQuit(); return; }
  if (act === 'open-cfg') { await Act.openCfg(); return; }
  if (act === 'diag-export') { await Act.diagExport(); return; }
  if (act === 'poster') { await Act.poster(); return; }
  if (act === 'safe-leave') { await Act.safeLeave(); return; }
  if (act === 'open-stats-dir') { await Act.openStatsDir(); return; }
  /* 云同步 */
  if (act === 'sync-auto') { Act.syncAuto(); return; }
  if (act === 'sync-save') { await Act.syncSave(); return; }
  if (act === 'sync-now') { await Act.syncRun('now'); return; }
  if (act === 'sync-up') { await Act.syncRun('up'); return; }
  if (act === 'sync-down') { await Act.syncRun('down'); return; }
  /* 更新 / 关于 */
  if (act === 'check-update') { await Act.checkUpdate(); return; }
  if (act === 'save-token') { await Act.saveToken(); return; }
  if (act === 'token-doc') { await Act.tokenDoc(); return; }
  if (act === 'clear-token') { await Act.clearToken(); return; }
  if (act === 'browser-scan') { await Act.browserScan(); return; }
  if (act === 'browser-page') { await Act.browserPage(el.dataset.k, el); return; }
  if (act === 'browser-setpath') { await Act.browserSetPath(el.dataset.k); return; }
  if (act === 'custom-browser-pick') { await Act.customBrowserPick(); return; }
  if (act === 'custom-browser-save') { await Act.customBrowserSave(); return; }
  if (act === 'custom-browser-del') { await Act.customBrowserDel(el.dataset.id); return; }
  if (act === 'browser-install') { await Act.browserInstall(el.dataset.k); return; }
  if (act === 'browser-rescan') { await Act.browserRescan(); return; }
  if (act === 'browser-guide') { await Act.browserGuide(null); return; }
  if (act === 'browser-open-folder') { await Act.browserOpenFolder(); return; }
  if (act === 'ext-copy') { await Act.extCopy(); return; }
  if (act === 'ext-open') { await Act.browserOpenFolder(); return; }
  if (act === 'browser-grace-save') { await Act.browserGraceSave(); return; }
  // `nav('browsers')` 自己就会扫一次，这里再扫一遍等于连做两次窗口枚举（每次是
  // spawn_blocking），而且 nav 的 rejection 没人接。
  if (act === 'day-retry') { await dayFetch(dayOf(), true); return; }
  if (act === 'browser-prompt-go') { closeModal(); await Act.nav('browsers'); return; }
  if (act === 'open-repo') { e.preventDefault(); await Act.openRepo(); return; }
  // 「另一台设备」横幅上的入口：直接跳到云同步页
  if (act === 'open-sync') { e.preventDefault(); await Act.nav('sync'); return; }
  // 关于页「三端版本」里的下载按钮：URL 来自更新清单（Rust 侧拼好的），这里只负责打开
  if (act === 'open-url') {
    const u = el.dataset.url || '';
    if (!/^https:\/\//i.test(u)) { toast('这个平台还没有下载地址', 'err'); return; }
    try { await invoke('open_url', { url: u }); }
    catch (err) { toast('打开浏览器失败：' + errText(err), 'err'); }
    return;
  }
  if (act === 'quota-refresh') { await Act.quotaRefresh(); return; }
  if (act === 'update-enabled') { await Act.updateEnabled(); return; }
  if (act === 'skip-version') { await Act.skipVersion(el.dataset.v); return; }
  if (act === 'clear-skip') { await Act.clearSkip(); return; }
  if (act === 'do-update') {
    await Act.doUpdate(el.dataset.url, el.dataset.name, Number(el.dataset.size) || 0, el.dataset.sha || '');
    return;
  }
});

/* 自律时段：7 列 × 24 小时柱状图，二维矩形拖选
 * 口径：格子 = 某一天的一个小时，格子里再分 4 个 15 分钟刻度（滴答清单周视图同款）。
 * 按住拖动框出一片矩形（可跨天、跨小时），粒度落在 15 分钟刻度上：
 * 鼠标压在格子哪一段就落在哪个刻度，上下一划就能框住一个时间段；
 * 零碎时间（11:10–12:20 这种）也是一条整带，不会被小时边界切开。
 * 从灰格起笔 = 选中整片，从蓝格起笔 = 取消整片；单击（不拖动）= 单独开关那个 15 分钟刻度。
 * 右键格子 = 弹出"专注 / 休息"设置，作用于右键时选中的范围。 */

/** 整片矩形（刻度坐标）→ 逐格 [from,to) 的「目标选中窗口」映射。
 *  以「锚点刻度」为边界：起笔刻度之前的分钟是洞（若框往上有延伸），
 *  结束刻度之后的分钟是洞（若框往下有延伸）——与拖动框选的直觉一致。 */
function ccRectWindows(d0, d1, h0, h1, qA, qB) {
  const out = new Map();
  for (let d = d0; d <= d1; d++) {
    for (let h = h0; h <= h1; h++) {
      const top = (h === h0) ? qStart(qA) : 0;
      const bot = (h === h1) ? qEnd(qB) : 60;
      if (bot > top) out.set(`${d},${h}`, { f: top, t: bot });
    }
  }
  return out;
}
/** 把"一个窗口 / 一组窗口 / 空"统一成窗口数组（分 → {f,t,seg}）。
 *
 *  为什么需要它：同一小时可以放**两段**（09:00–09:30 + 09:30–10:00），
 *  任何"一小时只装一个窗口"的中间表示都会在拖动预览里把另一段抹掉。
 *  对外仍然接受单个 `{f,t}`（老调用点、老测试），内部一律按数组处理。 */
function ccWinList(x) {
  if (!x) return [];
  const arr = Array.isArray(x) ? x : [x];
  const out = [];
  for (const w of arr) {
    if (!w) continue;
    const f = Math.max(0, Math.min(59, Math.round(+w.f || 0)));
    const t = Math.max(1, Math.min(60, Math.round(w.t == null ? 60 : +w.t)));
    if (t > f) out.push({ f, t, seg: w.seg || '' });
  }
  return out.sort((a, b) => a.f - b.f);
}

/** 重算某格的 DOM 选中态（.on）与细分刻度高亮（.cc-q.on），不触发整表渲染。
 *  `win` 可以是单个窗口、窗口数组，或空——见 ccWinList。 */
function ccPaintCell(cell, d, h, win) {
  const list = ccWinList(win);
  cell.classList.toggle('on', list.length > 0);
  cell.querySelectorAll('.cc-q').forEach((q) => {
    const a = +q.dataset.a, b = +q.dataset.b;
    q.classList.toggle('on', list.some((w) => w.f < b && a < w.t));
  });
}
/** hover 提示：只在停在细分刻度上时更新（避免 mouseover 抖动刷 tooltip） */
function ccHoverTip(cell, d, h, q) {
  const p = clockProfile().days[d][h];
  const a = qStart(q), b = qEnd(q);
  const w = Math.max(0, Math.min(60, p.work || 0));
  const br = Math.max(0, Math.min(60 - w, p.brk || 0));
  const onQ = p.on && (p.from || 0) < b && a < (p.to == null ? 60 : p.to);
  // 悬停在**已选中**的格子上时，顺手告诉你"这一整段是多长"：
  // 色块上的字只有 8~10px，短段还只能显示一行，鼠标停一下就能看全文更实用。
  const sg = onQ ? ccSegAt(d, h * 60 + a) : null;
  const segTxt = sg ? `本段 ${sg.range}（共 ${ccDurText(sg.mins)}） · ` : '';
  cell.setAttribute('title', `${WD[d]} ${pad(h)}:${pad(a)} – ${pad(h)}:${pad(b)}`
    + (onQ
      ? ` · ${segTxt}专注 ${w} 分 / 休息 ${br} 分，右键可改`
      : `（未选中，单击 / 拖选这 ${b - a} 分钟）`));
}

/* ───────── 自由拖选：按住就是一段，可随意伸缩 ─────────
 *
 * 交互口径（鼠标 / 手指共用同一套核心）：
 *   1. 按下 → 立刻把按住的那一个最小粒度作为起始选区（默认 15 分钟，可在设置里改 10 分钟）
 *   2. 不松手上下滑 → 选区沿时间轴伸缩，经过的时间自动并入**同一段**连续区间
 *   3. 拖动中实时高亮，并显示「起止时间 + 总时长」；到 0 点 / 24 点会明确提示
 *   4. 松手 → 立即提交（拖过多少就是多少，最少一格）
 *
 * 为什么不再用"矩形框选"：旧的手感是按格子跳的，指针移动必须跨过整格才更新一次，
 * 而且跨天时会变成二维矩形，和"我要选 9 点到 11 点半"这种线性意图不匹配。
 * 现在锚点固定在一个粒度上、另一端跟着指针连续走，天然就是一段可伸缩的区间。
 *
 * 关于边界：一列对应一天，纵向 0:00–24:00。拖出日界不跨天，而是夹到 0 点 / 24 点，
 * 并在文案里说明——这比"突然跳到隔壁那天"更符合直觉，也避免误改别的日子。
 */

/** 一天被切成多少个最小粒度 */
const ccDayGrains = () => 24 * ccQCnt();

/** 取某天这一列在视口里的几何（用来把 clientY 换算成"当天第几个粒度"） */
function ccDayGeom(d) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return null;
  // 不能写死 data-h=0 / 23：图表可以只显示其中一段（显示范围），
  // 那两格根本不存在，写死会让整条拖拽链路直接失效。
  const cells = grid.querySelectorAll(`.cc-cell[data-d="${d}"]`);
  if (!cells.length) return null;
  const first = cells[0];
  const last = cells[cells.length - 1];
  const r0 = first.getBoundingClientRect();
  const r1 = last.getBoundingClientRect();
  // 行高要用**平均值**（总高 ÷ 行数），不能拿第一格高：完整展示模式下每行是 1fr，
  // 浏览器会把不足 1px 的余量摊到某些行上（这一格 27px、下一格 28px）。
  // 拿第一格当行高，误差会随着行号累加——到第 11 小时就偏了 7~8px，
  // 指针明明在 09:00 却被算成 09:15，拖出来的时段跟着错位。
  const n = cells.length;
  const hourH = (r1.bottom - r0.top) / n;
  return { top: r0.top, hourH, bottom: r1.bottom };
}

/** clientX → 落在哪一列（哪一天）。返回 null = 指针不在图表的横向范围内。
 *
 *  为什么返回 null 而不是夹住：跨天拖拽只在"指针真的到了另一列"时才换天。
 *  指针滑出图表两侧时保持原来那一天（等于在周首 / 周末停住，不绕回另一头），
 *  既符合"一周就是一周"的直觉，也避免合成事件里 clientX=0 这类脏值把时段甩到周一。
 */
/** 某一列的横向范围。取这一列的**第一格**，而不是写死 data-h="0"——
 *  显示范围可能不从 0 点开始（例如只看 07:00–23:00），那时 data-h="0" 根本不存在，
 *  跨天命中的列宽就会退化成"空数组"，于是拖到别的列永远算"没换天"。
 *  （这就是"周二拖不到周三"的根因。） */
function ccColBox(d) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return null;
  const c = grid.querySelector(`.cc-cell[data-d="${d}"]`);
  return c ? c.getBoundingClientRect() : null;
}

function ccDayAtX(clientX) {
  const grid = document.getElementById('ccGrid');
  if (!grid || typeof clientX !== 'number' || !isFinite(clientX)) return null;
  const cols = [];
  for (let d = 0; d < 7; d++) {
    const r = ccColBox(d);
    if (r) cols.push({ d, r });
  }
  if (!cols.length) return null;
  const left = cols[0].r.left;
  const right = cols[cols.length - 1].r.right;
  if (clientX < left - 8 || clientX > right + 8) return null;
  for (const c of cols) {
    if (clientX >= c.r.left - 3 && clientX <= c.r.right + 3) return c.d;
  }
  // 落在列间距里：取最近的一列
  let best = cols[0].d;
  let bestDist = Infinity;
  for (const c of cols) {
    const dist = clientX < c.r.left ? c.r.left - clientX : clientX - c.r.right;
    if (dist < bestDist) { bestDist = dist; best = c.d; }
  }
  return best;
}

/** clientY → 当天第几个粒度（越界时夹住，并告诉调用方越到了哪边） */
function ccGrainAt(d, clientY) {
  const g = ccDayGeom(d);
  const view = ccView();
  if (!g || g.hourH <= 0) return { idx: 0, edge: 0 };
  const qn = ccQCnt();
  const raw = Math.floor(((clientY - g.top) / g.hourH) * qn);
  const edge = clientY < g.top - 1 ? -1 : (clientY > g.bottom + 1 ? 1 : 0);
  // 返回的是**整天**的粒度序号：显示范围只改"画哪一段"，
  // 序号仍以 0:00 为原点，这样与 from/to 的绝对分钟一一对应。
  const lo = view.from / ccStep();
  const hi = view.to / ccStep() - 1;
  return { idx: Math.max(lo, Math.min(hi, lo + raw)), edge };
}

/** 拖拽区间 [lo,hi)（分钟）：以锚点那一格为基准向两侧伸缩，最少一格 */
/** 某一天里**除被拖的那一段**之外，已经被占用的分钟区间。
 *
 *  这是碰撞限制的唯一输入。为什么不看 DOM：DOM 上是"预览态"，被拖的那一段
 *  已经在往目标位置跑了；拿它当障碍物会算出一堆假碰撞。
 *  配置才是"别人的真实位置"，在整个拖动过程中它一个字都不会变。
 *
 *  `dg` 传进来时按段身份把自己摘掉：
 *    · 有 seg id → 比 id（同一天里 id 唯一，跨天也不会误伤）
 *    · 老配置没有 id → 退回"起止分钟完全相等才算自己"
 */
function ccBusyBlocks(d, dg) {
  const day = (clockProfile().days[d]) || [];
  const isSrc = !!(dg && d === dg.d);
  return ccSegs(day)
    .map((s) => ({
      lo: s.h0 * 60 + s.f0,
      hi: s.h1 * 60 + s.t1,
      seg: s.seg || '',
    }))
    .filter((b) => !(isSrc && (
      (dg.segId && b.seg === dg.segId)
      || (!dg.segId && b.lo === dg.segFrom && b.hi === dg.segTo))))
    .sort((x, y) => x.lo - y.lo);
}

/** 把"想放的起点"夹到一个不压别人的位置：贴着对方边缘停下。
 *
 *  规则（对应交互约定）：
 *    · 能放下就按指针走（`ok(desired)`）；
 *    · 撞上别人 → 贴到**来的那一侧**的边：
 *        往下拖 → 停在障碍物上沿（`hit.lo - len`）
 *        往上拖 → 停在障碍物下沿（`hit.hi`）
 *      绝不做"截断对方 / 把对方切成两段"这种联动；
 *    · 那一侧塞不下（< 段长）→ 退回另一侧；两侧都不行 → 原地不动（`prevLo`）。
 *
 *  返回 null 只表示"连原位都放不下"（配置本身已被手改坏），调用方保持原值。 */
function ccFreeStart(desired, len, blocks, view, prevLo, down) {
  const fits = (lo) => lo >= view.from && lo + len <= view.to
    && !blocks.some((b) => lo < b.hi && lo + len > b.lo);
  if (fits(desired)) return desired;
  const hit = blocks.find((b) => desired < b.hi && desired + len > b.lo);
  if (!hit) return prevLo == null ? null : prevLo;
  const above = hit.lo - len;   // 停在障碍物上沿
  const below = hit.hi;         // 停在障碍物下沿
  const keep = prevLo == null ? null : prevLo;
  if (down === true) return fits(above) ? above : (fits(below) ? below : keep);
  if (down === false) return fits(below) ? below : (fits(above) ? above : keep);
  // 没有纵向位移（例如只是横向换天）：贴到更近的那一侧，
  // 这样"同一时刻搬到另一天"不会莫名其妙跳到障碍物的另一头。
  const near = Math.abs(above - desired) <= Math.abs(below - desired)
    ? [above, below] : [below, above];
  for (const c of near) if (fits(c)) return c;
  return keep;
}

function ccDragRange(dg) {
  const st = ccStep();
  const n = ccDayGrains();
  const a = Math.max(0, Math.min(n - 1, dg.anchor));
  const c = Math.max(0, Math.min(n - 1, dg.cur));
  dg.blocked = false;   // 只有真正被相邻时段挡住时才由下面的平移分支置位

  // 边缘缩放：一端钉死，另一端跟着指针走。
  //   下边 → 只动 hi；上边 → 只动 lo。
  //   长度夹在 [一个粒度, 显示范围] 之间：最短一格（10 / 15 分钟），最长到视野尽头。
  //   另外**撞到相邻段就停在它的边缘**：不许把它压短，也不许把它推开。
  if (dg.resize) {
    const view = ccView();
    const minDur = ccStep();
    const blocks = ccBusyBlocks(dg.d, dg);
    let lo = dg.segFrom;
    let hi = dg.segTo;
    if (dg.resize === 'bottom') {
      // 指针所在那一格的下沿就是新的结束时刻（拖到 10:15 中间 → 结束 10:15）
      hi = Math.min(view.to, Math.max((c + 1) * st, lo + minDur));
      // 下方最近的一段：它的上沿就是这条边能到的极限。
      // 用**固定的起点** lo 判断"在下方的"，不能用会移动的 hi——
      // 否则指针一旦越过那道墙，墙就被算成"不在下方"，边就穿过去了。
      const next = blocks.filter((b) => b.lo > lo).reduce((m, b) => Math.min(m, b.lo), Infinity);
      if (isFinite(next)) hi = Math.min(hi, next);
      hi = Math.max(hi, lo + minDur);
    } else {
      lo = Math.max(view.from, Math.min(c * st, hi - minDur));
      // 上方最近的一段：它的下沿就是这条边能到的极限（同理用固定的 hi 判断）
      const prev = blocks.filter((b) => b.hi < hi).reduce((m, b) => Math.max(m, b.hi), -Infinity);
      if (isFinite(prev)) lo = Math.max(lo, prev);
      lo = Math.min(lo, hi - minDur);
    }
    return { lo, hi };
  }

  if (dg.mode === 'move') {
    // 整段平移：**长度恒定**，只按"拖了多远"平移，撞到显示范围的边就贴边停下。
    // 这里绝不能"先挪再裁"：那会把越过边界的部分剪掉，看起来是贴边，实际是丢分钟。
    // 所以夹的是**起点**，终点永远由起点 + 原长度推出来。
    const view = ccView();
    const len = dg.segTo - dg.segFrom;
    let lo = dg.segFrom + (c - a) * st;
    if (lo + len > view.to) lo = view.to - len;
    if (lo < view.from) lo = view.from;
    // 段比显示范围还长（例如只显示 9–10 点，却抓着一段 8–12 点）：
    // 怎么挪都会越界，干脆钉住不动，而不是把它截短
    if (lo + len > view.to) lo = dg.segFrom;

    // 碰撞：这一天里除自己以外的段都是"墙"。碰到就停在墙边，绝不压上去、
    // 绝不插进它中间、绝不把它挤走——别人的起止/时长/数量在拖动期间完全不变。
    const dCur = dg.mode === 'move' ? (dg.dCur == null ? dg.d : dg.dCur) : dg.d;
    if (dg.lockDay !== dCur) {
      // 换了一天：上一个落点属于原来那天，不能拿来当"上次位置"
      dg.lockDay = dCur;
      dg.lockLo = dg.segFrom;
    }
    const blocks = ccBusyBlocks(dCur, dg);
    const prevLo = dg.lockLo == null ? dg.segFrom : dg.lockLo;
    const want = lo;             // 夹过视野、但还没夹碰撞的"指针想要的落点"
    // 方向：真的往上/下拖了才按方向贴边；只是横向换天（纵向没动）就让"近的那一侧"说话
    const moved = Math.abs(want - prevLo) > 0.5;
    const down = moved ? want > prevLo : null;
    const fit = ccFreeStart(want, len, blocks, view, prevLo, down);
    if (fit != null) lo = fit;
    // 被相邻时段挡住了 → 状态条上说明一句，避免用户以为"拖不动了"
    dg.blocked = fit != null && Math.abs(fit - want) > 0.5;
    dg.lockLo = lo;
    return { lo, hi: lo + len };
  }

  // 新建拖选：锚点那一格固定，另一端跟着指针长。
  // 同样不许画到别人身上（那等于把对方从中间切开），撞到就停在对方边缘。
  {
    const blocks = ccBusyBlocks(dg.d, null);
    if (c >= a) {
      const lo = a * st;
      let hi = Math.min(1440, (c + 1) * st);
      const next = blocks.filter((b) => b.lo >= lo + st).reduce((m, b) => Math.min(m, b.lo), Infinity);
      if (isFinite(next)) hi = Math.min(hi, next);
      return { lo, hi: Math.max(hi, lo + st) };
    }
    const hi = (a + 1) * st;
    let lo = c * st;
    const prev = blocks.filter((b) => b.hi <= hi - st).reduce((m, b) => Math.max(m, b.hi), -Infinity);
    if (isFinite(prev)) lo = Math.max(lo, prev);
    return { lo: Math.min(lo, hi - st), hi };
  }
}

/** 把区间套到某一小时的已有窗口上 → {f,t}；null 表示这一小时没有选中 */
function ccHourResult(p, h, lo, hi, mode) {
  const hs = h * 60;
  const a = Math.max(lo, hs), b = Math.min(hi, hs + 60);
  const has = !!(p && p.on);
  const pf = has ? (p.from || 0) : 0;
  const pt = has ? (p.to == null ? 60 : p.to) : 60;
  if (mode === 'sub') {
    if (!has) return null;
    if (b <= a || a - hs >= pt || b - hs <= pf) return { f: pf, t: pt };
    // 从中间抹掉一段时保留较长的一侧（一小时只能存一个窗口，无法表达两段）
    const left = { f: pf, t: Math.min(pt, a - hs) };
    const right = { f: Math.max(pf, b - hs), t: pt };
    const lw = Math.max(0, left.t - left.f), rw = Math.max(0, right.t - right.f);
    if (lw >= rw && lw > 0) return left;
    if (rw > 0) return right;
    return null;
  }
  // add：与已有窗口取并集
  if (b <= a) return has ? { f: pf, t: pt } : null;
  const f = has ? Math.min(pf, a - hs) : a - hs;
  const t = has ? Math.max(pt, b - hs) : b - hs;
  return f < t ? { f, t } : null;
}

/* ───────── 拖拽预览：把"这一天的虚拟状态"画出来 ─────────
 *
 * 这一轮修的就是这里：以前 move 模式只在落点画一个虚线框、原块纹丝不动，
 * 松手才一下跳过去 —— 看起来像"卡住"，也不符合"抓着东西搬走"的直觉。
 *
 * 现在只有一个口径：预览 = **虚拟的一天**（24 个小时各自的窗口）。
 * 把它写进 DOM，再走与正式渲染**完全相同**的 ccRenderRuns，
 * 于是：
 *   · 被拖的那一块真的跟着指针走（半透明、微微抬起）
 *   · 块上的起止时间、每格刻度、每日时长、合计全部实时联动
 *   · 松手提交后是同一条代码路径画出来的，不会"跳一下"
 */

/** 预览下**某一天** 24 小时各自的窗口（**数组**，空数组 = 这一小时没选中）。
 *
 *  平移时会被问两天：原所在的那天（要把这一段拿掉）和落点那天（要铺上）。
 *  同一天时两步都作用在同一份数组上，等价于"先 sub 再 add"，
 *  与 clockMoveSeg 的写入顺序完全一致，所以松手不会跳变。
 *
 *  ⚠️ 这里以前有两条会"抹掉别的时段"的错：
 *  1. `out[h] = 与拖拽区间相交的那个窗口，否则 null` —— 只保留被拖的那一段。
 *     只要这天还有别的时段，拖动其中一段时其余时段全被涂成"未选中"，块一块块消失。
 *     落位走的又是"不整体重绘"的提交，没人再按配置纠正 DOM，
 *     那些块就永久留在了"消失"状态——数据还在，界面没了。
 *  2. 新建拖选（add）时仍然去"减掉 segFrom…segTo"，而这时这两个字段根本不存在，
 *     减出来的小时列表是空的：拖新段时当天所有旧段一起闪没。
 *  现在每小时**全量**返回所有窗口，只减真正被搬走 / 被覆盖的那一段。 */
function ccWinsForDay(d, dg, lo, hi) {
  const prof = clockProfile();
  const day = prof.days[d] || [];
  const out = new Array(24).fill(null).map(() => []);
  const isMove = dg.mode === 'move';
  const isSrc = isMove && d === dg.d;
  const isDst = d === (dg.dCur == null ? dg.d : dg.dCur);
  // 段 id 与真正落盘时用的那一个完全同源：
  //   · 平移 / 缩放 → 原地那一段的 id（ccSegIdIn 从原位置取）
  //   · 新建拖选   → 区间内已有段的 id，没有就临时 id（提交时换成真 id）
  // 这样预览里"贴在一起的两段"与落盘后的结果一模一样，松手不跳变。
  const seg = isMove
    ? (ccSegIdIn(prof.days[dg.d] || [], dg.segFrom, dg.segTo) || '__drag')
    : (ccSegIdIn(day, lo, hi) || '__drag');
  for (let h = 0; h < 24; h++) {
    const p = day[h];
    let wins = hourWins(p);
    if (isSrc) wins = ccWinsAfter(p, h, dg.segFrom, dg.segTo, 'sub', '');
    if (isDst) wins = ccWinsAfterSource(wins, h, lo, hi, seg);
    out[h] = ccWinList(wins.map((w) => ({ f: w.from, t: w.to, seg: w.seg })));
  }
  return out;
}

/** 预览用：把 [lo,hi) 并进已有窗口列表（不动配置） */
function ccWinsAfterSource(wins, h, lo, hi, seg) {
  const hs = h * 60;
  const a = Math.max(lo, hs), b = Math.min(hi, hs + 60);
  if (b <= a) return wins;
  const af = a - hs, bt = b - hs;
  const list = wins.map((w) => ({ ...w }));
  let nf = af, nt = bt;
  const out = [];
  for (const w of list) {
    const overlap = w.from < nt && w.to > nf;
    const touching = w.to === nf || w.from === nt;
    const same = !w.seg || !seg ? true : w.seg === seg;
    if (!overlap && !(touching && same)) { out.push(w); continue; }
    if (overlap && !same) {
      if (w.from < nf) out.push({ from: w.from, to: nf, seg: w.seg });
      if (w.to > nt) out.push({ from: nt, to: w.to, seg: w.seg });
      continue;
    }
    nf = Math.min(nf, w.from);
    nt = Math.max(nt, w.to);
  }
  out.push({ from: nf, to: nt, seg: seg || '__drag' });
  return out.sort((x, y) => x.from - y.from);
}

/** 虚拟的一天里被选中多少分钟。
 *  一天 = 24 个小时，每小时可能**有多个窗口**（同一小时两段），
 *  所以这里既接受 `[{f,t}, …]` 也接受 `[[{f,t}], …]` 两层结构。 */
function ccWinsMinutes(wins) {
  return (wins || []).reduce((n, w) => n + (Array.isArray(w)
    ? ccWinsMinutes(w)
    : (w ? Math.max(0, w.t - w.f) : 0)), 0);
}

/** 预览的一天（24 小时窗口数组）→ 与配置同形状的一天（`ccSegs` 认的形状）。
 *  段数 / 摘要 / 微缩图都走 `hourWins`，所以多窗口要原样翻译成 `wins`。 */
function ccDayOfWins(hours) {
  return (hours || []).map((list) => {
    const l = ccWinList(list);
    if (!l.length) return { on: false };
    return {
      on: true,
      from: l[0].f,
      to: l[l.length - 1].t,
      seg: l[0].seg || '',
      wins: l.map((w) => ({ from: w.f, to: w.t, seg: w.seg || '' })),
    };
  });
}

/** 「合计 x」：拖拽中的实时文案也要跟着语言走 */
function ccTotalText(m) {
  return I18N.getLang() === 'en' ? `Total ${ccDurText(m)}` : `合计 ${ccMinText(0, m).dur}`;
}

/** 每日时长 / 合计 / 段数：跟着预览实时联动。
 *  `winsBy` 是 Map<天, 24 小时窗口>；跨天拖动时会同时有两天的数据。
 *  松手后若整体重绘会覆盖这些值，不重绘时它们就是最终值（预览=结果）。 */
function ccLiveTotals(winsBy) {
  const prof = clockProfile();
  const per = prof.days.map((day, i) => (winsBy && winsBy.has(i)
    ? ccWinsMinutes(winsBy.get(i))
    : ccDayMinutes(day)));
  const total = per.reduce((a, b) => a + b, 0);
  // 拖动时这个函数每帧都会被调一次：**值没变就一个字符都不写**。
  // `textContent = 同一个字符串` 也会把文本节点整个换掉，配合入场动画就是
  // "数字在抖"的观感；宽度同理。
  const setTxt = (el, t) => {
    if (el && el.textContent !== t) el.textContent = t;
  };
  const hd = document.querySelector('.cc-days-hd');
  if (hd && hd.lastElementChild) setTxt(hd.lastElementChild, ccTotalText(total));
  const rows = document.querySelectorAll('.cc-days .cc-day');
  per.forEach((m, d) => {
    const row = rows[d];
    if (!row) return;
    const bar = row.querySelector('.bar i');
    if (bar) {
      const w = `${(m / 1440 * 100).toFixed(1)}%`;
      if (bar.style.width !== w) bar.style.width = w;
    }
    setTxt(row.querySelector('.v'), m ? ccDurText(m) : '—');
    // 段数也跟着变：新建时可能把两段并成一段（并集），这里必须如实反映。
    // 没有预览数据时（撤回 / 提交后）就用配置里的真实值，别留着旧的段数。
    const day = winsBy && winsBy.has(d)
      ? ccDayOfWins(winsBy.get(d))
      : prof.days[d];
    const n = ccSegs(day).length;
    setTxt(row.querySelector('.s'), n ? `${n} 段` : '');
  });
}

/** 拖拽预览：写 DOM（绝不写配置），并把被搬的那一块标成"抓起来了"。
 *  平移可以跨天：这时会同时画两条列——原列去掉这一段、目标列铺上这一段。 */
function paintCcDrag() {
  const dg = S.ccDrag;
  if (!dg) return;
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  const dCur = dg.mode === 'move' ? (dg.dCur == null ? dg.d : dg.dCur) : dg.d;
  const { lo, hi } = ccDragRange(dg);
  const days = dCur === dg.d ? [dg.d] : [dg.d, dCur];

  // 0) **先把上一帧涂过、这一帧不再涉及的天还原**。
  //    跨多天拖动时 dCur 是"跳"的：周二 → 周三 → 周四 → 周五，
  //    每跳一次，刚刚离开的那一天就再也不会出现在 days 里。
  //    以前这里只重绘 days，于是周三、周四的格子一直留着预览态的 .on，
  //    而块又是按 DOM 的 .on 画的 → 中间那天凭空多出一段。
  //    落位时走的是 noRender 提交（为了不整页闪），没人来纠正，幽灵就留在屏幕上。
  const stale = [];
  if (dg.painted) for (const d of dg.painted) if (days.indexOf(d) < 0) stale.push(d);
  if (stale.length) ccRestoreCells(stale);
  dg.painted = days.slice();

  const winsBy = new Map();
  for (const d of days) winsBy.set(d, ccWinsForDay(d, dg, lo, hi));

  // 1) 格子与细分刻度（涉及的那几天一起刷）
  for (const d of days) {
    const wins = winsBy.get(d);
    grid.querySelectorAll(`.cc-cell[data-d="${d}"]`).forEach((c) => {
      const h = +c.dataset.h;
      ccPaintCell(c, d, h, wins[h]);
    });
  }
  // 2) 整块（块上的起止时间也在这里跟着变）
  //    必须把窗口传给渲染器：只改单元格的 .on 不够——
  //    每小时的起止分钟若仍从配置里读，02:15 起的那一块就会被判成
  //    "上一小时 :15 结束"，在小时边界断成两块。
  //    传的是**这一小时的全部窗口**（不是与拖拽相交的那一个）：
  //    只传一个的话，同一天里别的时段就在预览里消失了（见 ccWinsForDay）。
  // 块本身按"已放置"色画；只有**这次真正在动的那一段**单独点亮（见 ccPaintSel）。
  ccRenderRuns(document, (d, h) => {
    if (!winsBy.has(d)) return undefined;
    const list = winsBy.get(d)[h];
    return list && list.length ? list : null;
  });
  ccPaintSel(days, lo, hi);

  const h0 = Math.floor(lo / 60);
  const h1 = Math.floor((hi - 1) / 60);
  // 3) 被搬走的那一块：半透明 + 抬起，一眼看出"它在我手上"
  //    判定用"这一块的时间范围完整盖住了落点区间"，而不是只看小时重叠——
  //    否则同一天里恰好挨着的另一段也会被标上半透明。
  grid.querySelectorAll('.cc-run').forEach((r) => {
    const rFrom = +r.dataset.h0 * 60 + (+r.dataset.f0 || 0);
    const rTo = +r.dataset.h1 * 60 + (+r.dataset.t1 || 60);
    const hit = +r.dataset.d === dCur && rFrom <= lo && rTo >= hi;
    // 缩放不出"手上那块半透明"的效果：它没有被搬走，只是在原地变长 / 变短
    r.classList.toggle('carry', dg.mode === 'move' && !dg.resize && hit);
  });
  // 4) 原位留一条虚线占位：告诉用户它原本在哪，松手前不"凭空消失"
  // 占位虚线也**复用同一个节点**：以前每帧 remove + 新建，而 `.cc-slot` 带
  // `ccSlotIn` 淡入动画，于是虚线每帧闪一下。现在只更新位置与百分比，
  // 它的出现动画只在真正开始拖动时播一次。
  let slot = grid.querySelector('.cc-slot');
  if (dg.mode === 'move' && !dg.resize) {
    const s0 = Math.floor(dg.segFrom / 60), s1 = Math.floor((dg.segTo - 1) / 60);
    const span = (s1 - s0 + 1) * 60;
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'cc-slot';
      grid.appendChild(slot);
    }
    slot.style.gridColumn = `${dg.d + 2}`;
    slot.style.gridRow = `${ccRow(s0)} / ${ccRow(s1) + 1}`;
    let bar = slot.firstElementChild;
    if (!bar) {
      bar = document.createElement('i');
      slot.appendChild(bar);
    }
    bar.style.top = `${(((dg.segFrom - s0 * 60) / span) * 100).toFixed(2)}%`;
    bar.style.height = `${(((dg.segTo - dg.segFrom) / span) * 100).toFixed(2)}%`;
  } else if (slot) {
    slot.remove();
  }
  // 5) 每日时长 / 合计 / 段数
  ccLiveTotals(winsBy);

  // 6) 状态条
  const isEn = I18N.getLang() === 'en';
  const verb = dg.resize ? (isEn ? 'Resize' : '调整')
    : dg.mode === 'move' ? (isEn ? 'Move' : '移动')
      : dg.mode === 'sub' ? (isEn ? 'Cancel' : '取消')
        : (isEn ? 'Select' : '选中');
  const dayTxt = dCur === dg.d
    ? I18N.t(WD[dCur])
    : `${I18N.t(WD[dg.d])} → ${I18N.t(WD[dCur])}`;
  const durTxt = ccDurText(hi - lo);
  const rg = ccMinText(lo, hi).range;
  const edgeY = dg.edge < 0 ? (isEn ? ' · clamped at 0:00' : ' · 已到当日 0:00')
    : (dg.edge > 0 ? (isEn ? ' · clamped at 24:00' : ' · 已到当日 24:00') : '');
  // 横向顶到周首 / 周末：说明"不会再往旁边走了"，避免用户以为拖不动
  const edgeX = dg.edgeX < 0 ? (isEn ? ' · week starts here' : ' · 已到周一')
    : (dg.edgeX > 0 ? (isEn ? ' · week ends here' : ' · 已到周日') : '');
  // 被相邻时段挡住了：同上，明确告诉用户"是撞到别人了，不是卡住"。
  // 顺带说明别人没被改动——这正是这次交互约定的核心。
  const edgeB = dg.blocked
    ? (isEn ? ' · next window blocks it (untouched)' : ' · 已贴住相邻时段（没有移动它）') : '';
  const lab = $('#clockLive');
  if (lab) {
    const html = isEn
      ? `${verb} <b>${dayTxt} ${rg}</b> · ${durTxt}${edgeY}${edgeX}${edgeB}`
      : `${verb} <b>${dayTxt} ${rg}</b> · 共 ${durTxt}${edgeY}${edgeX}${edgeB}`;
    // 每帧都赋一次 innerHTML 会把 <b> 连同文本反复重建，拖动时那行字会轻微抖。
    // 内容没变就不碰它。
    if (lab.__html !== html) {
      lab.innerHTML = html;
      lab.__html = html;
    }
  }
  // 7) 跟随指针的浮层（同一格内的小位移由 ccFlushDrag 单独更新，不重排）
  ccGhostSet(`${verb} ${dayTxt} ${rg} · ${durTxt}`,
    (dg.lastX != null ? dg.lastX : 240) + 16, (dg.lastY != null ? dg.lastY : 0) - 14);
  grid.classList.add('dragging');
}

/** 状态条还原成"当前排班摘要"（会跟着当前语言走） */
function ccResetLive() {
  const lab = $('#clockLive');
  if (!lab) return;
  lab.textContent = clockRangeText();
  I18N.apply(lab);
}

/** 只还原**格子**（.on 与细分刻度）：按配置里的真实值重画指定的这几天，
 *  不碰块、不碰合计。拖拽过程中要求"某一天退出预览"时用它——
 *  完整的 ccRestorePreview 会把状态条和合计一起复位，那会打断正在进行的拖动。 */
function ccRestoreCells(days) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return [];
  const list = (Array.isArray(days) ? days : [days]).filter((d) => d != null);
  const prof = clockProfile();
  for (const d of list) {
    const day = prof.days[d] || [];
    grid.querySelectorAll(`.cc-cell[data-d="${d}"]`).forEach((c) => {
      const h = +c.dataset.h;
      const p = day[h];
      // 用**全部窗口**还原：同一小时可以有两段，只按 from/to 画会把两段并成整小时
      ccPaintCell(c, d, h, p && p.on
        ? hourWins(p).map((w) => ({ f: w.from, t: w.to, seg: w.seg }))
        : null);
    });
  }
  return list;
}

/** 撤回预览：按**配置里的真实值**把涉及的那几天重画（单击 / 取消拖动时用） */
function ccRestorePreview(days) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  grid.querySelectorAll('.cc-slot').forEach((el) => el.remove());
  const list = ccRestoreCells(days);
  // 这几天里可能还挂着上一帧留下的块：只重画它们，别的列原样保留
  ccRenderRuns(document, null, list);
  grid.querySelectorAll('.cc-run.carry').forEach((r) => r.classList.remove('carry'));
  // 重画只覆盖这几天；万一别处还挂着"选中中"，一并收掉（取消后不该有任何高亮残留）
  ccSettleRuns();
  ccLiveTotals(null);
  ccResetLive();
}

/** 「选中中」只给**真正在动的那一段**上色。
 *
 *  days = 这次操作涉及的天；[lo,hi) = 被操作的分钟区间。
 *  只有"在这些天里、且与这个区间有交集"的块才加 `.sel`，
 *  其余块一律摘掉——这是"局部高亮"的硬约束：拖周一的段，
 *  周二、周三的块不能跟着变色（它们的数据一点都没动）。
 *
 *  用"区间有交集"而不是"整块被盖住"：拖到一半、段被拉长时，
 *  正在变形的就是那一块，它当然要亮；而同一个小时里另一段没被碰过的，
 *  边界不重叠就不会亮。
 */
function ccPaintSel(days, lo, hi) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  const set = new Set(days || []);
  grid.querySelectorAll('.cc-run').forEach((r) => {
    const d = +r.dataset.d;
    const a = +r.dataset.h0 * 60 + (+r.dataset.f0 || 0);
    const b = +r.dataset.h1 * 60 + (+r.dataset.t1 || 60);
    r.classList.toggle('sel', set.has(d) && b > lo && a < hi);
  });
}

/** 落盘之后：把仍然挂着的「选中中」块换回「已放置」色。
 *
 *  只换类、不重建节点——重建会打断落位动画（FLIP 需要同一块继续存在），
 *  而 CSS 上 `background-color` 有 160ms 过渡，于是这次换色本身就是"设置成功"的反馈：
 *  同一色相、只深 5%，几乎察觉不到，但确实"定下来了"。
 */
function ccSettleRuns() {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  grid.querySelectorAll('.cc-run.sel').forEach((r) => r.classList.remove('sel'));
}

/** 松手落位：优先 FLIP（从"手上那一块"的位置滑到最终位置），
 *  位置本来就重合时退化成一次轻微的 settle —— 两种都不会让视图跳变。 */
function ccLandRun(fromRect, d, h0, h1) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  const run = [...grid.querySelectorAll('.cc-run')].find((r) => +r.dataset.d === d
    && +r.dataset.h1 >= h0 && +r.dataset.h0 <= h1);
  if (!run) return;
  const to = run.getBoundingClientRect();
  const dx = fromRect ? fromRect.left - to.left : 0;
  const dy = fromRect ? fromRect.top - to.top : 0;
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
    run.style.transition = 'none';
    run.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
    void run.offsetWidth;   // 先把起点落下来，下一步才有过渡
    run.style.transition = 'transform .24s cubic-bezier(.22, .61, .36, 1), opacity .18s linear';
    run.style.transform = '';
    setTimeout(() => { run.style.transition = ''; run.style.transform = ''; }, 320);
    return;
  }
  run.classList.add('land');
  setTimeout(() => run.classList.remove('land'), 320);
}

/** 时长文案（语言感知）：中文 "1 小时 45 分"，英文 "1 h 45 min" */
function ccDurText(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  if (I18N.getLang() === 'en') {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h && mm) return `${h} h ${mm} min`;
    if (h) return `${h} h`;
    return `${mm} min`;
  }
  return ccMinText(0, m).dur;
}

/** 分钟区间 → { range: "09:15 – 11:00", dur: "1 小时 45 分" } */
function ccMinText(lo, hi) {
  const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const mins = Math.max(0, hi - lo);
  const hh = Math.floor(mins / 60), mm = mins % 60;
  const dur = hh && mm ? `${hh} 小时 ${mm} 分` : (hh ? `${hh} 小时` : `${mm} 分钟`);
  return { range: `${hm(lo)} – ${hm(hi)}`, dur };
}

/** 按下：锚定一个粒度，并据此决定是"加选"还是"抹掉" */
/** 当天**覆盖这一小时**的那一段（合成事件没有真实坐标时兜底用）。
 *  只要这一小时里有一段（哪怕它只占后半截），就认为右键的目的是那一段。 */
function ccSegAtHour(d, h) {
  const day = clockProfile().days[d];
  if (!day) return null;
  return ccSegs(day).find((s) => s.h0 <= h && s.h1 >= h) || null;
}

/** 一段在屏幕上的上 / 下边界（像素）。
 *  **不能用块容器的 rect**：容器占的是整格高度，02:10 起的段，
 *  它的容器从 02:00 就开始了，手柄会画在那 10 分钟空白里。
 *  这里按 h0*60+f0 精确换算，非整点的段手柄才贴得住色带。 */
function ccSegEdgeY(d, seg) {
  const g = ccDayGeom(d);
  if (!g || !seg) return null;
  const view = ccView();
  const a = seg.h0 * 60 + (seg.f0 || 0);
  const b = seg.h1 * 60 + (seg.t1 >= 60 ? 60 : seg.t1);
  return {
    top: g.top + ((a - view.from) / 60) * g.hourH,
    bottom: g.top + ((b - view.from) / 60) * g.hourH,
    h: ((b - a) / 60) * g.hourH,
  };
}

/** 指针落在这一段的上边还是下边？返回 'top' / 'bottom' / null。
 *
 *  热区宽度分两种情形，因为"一格"和"一块"的比例完全不同：
 *
 *  · **多格块**（≥ 2 小时）取 min(5px, 段高/3, 一格 × 0.45)：
 *    `一格 × 0.45` 保证"任意一格的中心"都落在可搬区间里——完整展示模式下
 *    每行被压到 20~28px，10 分钟一格只有 3~5px，用固定 5px 会让首格整块变成
 *    热区，拖着拖着就变成"怎么按都在改大小"。
 *
 *  · **单格块**（15 / 10 分钟，只有一格）取 min(5px, 段高 × 0.32)：
 *    这种块没有"内部格"可保护，上下各让出约 1/3 做缩放，中间 1/3 仍可搬走。
 *    按比例算而不是按格算，否则 13px 的块热区只剩 1px，等于没有。
 */
const CC_EDGE_PX = 5;
function ccEdgeZone(d, seg, clientY) {
  if (!seg || typeof clientY !== 'number') return null;
  const y = ccSegEdgeY(d, seg);
  if (!y || y.h <= 0) return null;
  const n = (seg.h1 - seg.h0) + 1;
  const grainPx = y.h / (ccQCnt() * n);
  const z = n === 1
    ? Math.min(CC_EDGE_PX, y.h * 0.32)
    : Math.max(1.5, Math.min(CC_EDGE_PX, y.h / 3, grainPx * 0.45));
  if (clientY <= y.top + z) return 'top';
  if (clientY >= y.bottom - z) return 'bottom';
  return null;
}

/** 当天包含 atMin（绝对分钟）的那一段；没有就返回 null */
function ccSegAt(d, atMin) {
  const day = clockProfile().days[d];
  if (!day) return null;
  const segs = ccSegs(day);
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i];
    const from = sg.h0 * 60 + sg.f0;
    const to = sg.h1 * 60 + (sg.t1 >= 60 ? 60 : sg.t1);
    if (atMin >= from && atMin < to) return sg;
  }
  return null;
}

/* ── 跟随指针的浮动提示 ──
 * 真实高亮必须"即时"（拖到哪就亮到哪），但那一刻的跳变会让手感发硬。
 * 所以另起一个只改 transform 的小卡片跟着指针走（CSS 过渡负责平滑），
 * 两者的分工：高亮=结果，ghost=手感。 */
function ccGhostSet(text, x, y) {
  let el = document.getElementById('ccGhost');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ccGhost';
    el.className = 'cc-ghost';
    document.body.appendChild(el);
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    void el.offsetWidth;   // 先落一个初始位置，后续才有"从这滑到那"的过渡
  }
  if (text != null) el.textContent = text;
  el.classList.remove('out');   // 上一次的退场可能还没走完，复用时先复活
  el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

/** 只挪浮层：同一格内移动时不重排整张表，但浮层必须继续跟手 */
function ccGhostMove() {
  const dg = S.ccDrag;
  const el = document.getElementById('ccGhost');
  if (!dg || !el) return;
  const x = (dg.lastX != null ? dg.lastX : 240) + 16;
  const y = (dg.lastY != null ? dg.lastY : 0) - 14;
  el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function ccGhostDrop() {
  const el = document.getElementById('ccGhost');
  if (!el) return;
  el.classList.add('out');
  setTimeout(() => el.remove(), 180);
}

/* ── 拖动重绘的帧调度 ──
 * 一只 120Hz 的鼠标每秒会发 120 次 mousemove，每次都重排整张表太浪费。
 * 这里把"重算 + 重绘"合并到下一帧；同时挂一个 40ms 的兜底定时器 ——
 * 窗口在后台、或某些无头渲染环境里 requestAnimationFrame 不会推进，
 * 只靠 rAF 会让拖动"半路不动"。
 */
let ccPaintRaf = 0;
let ccPaintTimer = 0;

function ccFlushDrag() {
  if (ccPaintRaf) { cancelAnimationFrame(ccPaintRaf); ccPaintRaf = 0; }
  if (ccPaintTimer) { clearTimeout(ccPaintTimer); ccPaintTimer = 0; }
  const dg = S.ccDrag;
  if (!dg || dg.pendingY == null) return;
  const y = dg.pendingY;
  const x = dg.pendingX;
  dg.pendingY = null;
  dg.pendingX = null;
  dg.lastY = y;
  if (typeof x === 'number') dg.lastX = x;

  // 平移可以跨天：横向落点决定"搬到哪一天"。
  // 指针滑出图表两侧时保持当前天（在周首 / 周末停住），并在状态条说明到头了。
  let dCur = dg.dCur == null ? dg.d : dg.dCur;
  let edgeX = 0;
  // 缩放只改长度，**不接受横向换天**：把一段的上边界拖到周三的列上，
  // 意思到底是"拉长"还是"搬到周三"说不清，索性钉死在本天——
  // 要换天请按段中间（那是平移）。
  if (dg.mode === 'move' && !dg.resize) {
    const at = ccDayAtX(x);
    if (at != null) {
      dCur = at;
    } else if (typeof x === 'number') {
      const b0 = ccColBox(0);
      const b6 = ccColBox(6);
      if (b0 && b6) {
        if (x < b0.left - 8 && dCur === 0) edgeX = -1;
        if (x > b6.right + 8 && dCur === 6) edgeX = 1;
      }
    }
  }
  const { idx, edge } = ccGrainAt(dCur, y);
  const changed = idx !== dg.cur || edge !== dg.edge
    || dCur !== dg.dCur || edgeX !== dg.edgeX;
  dg.cur = idx;
  dg.edge = edge;
  dg.dCur = dCur;
  dg.edgeX = edgeX;
  // 落到新的粒度 / 新的一天 → 重排；仍在同一格 → 只挪浮层（省掉一次重排）
  if (changed) paintCcDrag();
  else ccGhostMove();
}

function ccScheduleDrag() {
  if (ccPaintRaf || ccPaintTimer) return;
  ccPaintRaf = requestAnimationFrame(ccFlushDrag);
  ccPaintTimer = setTimeout(ccFlushDrag, 40);
}

function ccDragBegin(d, clientY, clientX) {
  const { idx, edge } = ccGrainAt(d, clientY);
  const st = ccStep();
  const atMin = idx * st;

  // 拖动期间：整页进入"抓取"状态，并清掉原生 tooltip（否则悬停提示会跳出来挡路）
  document.body.classList.add('cc-dragging');
  document.querySelectorAll('#ccGrid .cc-cell[title]').forEach((c) => c.removeAttribute('title'));
  // 悬停高亮/可抓光标在拖动期间都不该再出现
  const gr = document.getElementById('ccGrid');
  if (gr) {
    gr.classList.remove('over-seg');
    gr.classList.remove('over-edge');
    gr.querySelectorAll('.cc-run.over').forEach((r) => r.classList.remove('over'));
    gr.querySelectorAll('.cc-run.edge-top, .cc-run.edge-bottom')
      .forEach((r) => r.classList.remove('edge-top', 'edge-bottom'));
  }
  S.ccEdgeKey = '';

  // 按下的位置落在某一段里 → 拖动 = **整段平移**（段的长度不变，只换位置）；
  // 落在空白 → 拖动 = 新建一段。
  //
  // 以前"落在已选中的格子上"是 sub（抹掉），再加一句"没拖动就算单击 → 取消这一格"，
  // 结果在段中间点一下就把一整段从中间劈开、点中的那块消失。现在点击什么都不改。
  const seg = ccSegAt(d, atMin);
  // 落在段的上 / 下边界 7px 内 → 缩放这一段；否则才是"整段搬走"。
  // 判定顺序就是优先级：**边缘 > 段身 > 空白**（越具体越优先）。
  const zone = ccEdgeZone(d, seg, clientY);
  if (zone) S.ccEdgeKey = '';   // 一开始拖就把悬停手柄收掉，别和拖动抢视线

  if (seg) {
    S.ccDrag = {
      d, dCur: d, anchor: idx, cur: idx, edge, edgeX: 0, mode: 'move', moved: false,
      resize: zone || null,
      startY: clientY, startX: clientX, lastX: clientX, lastY: clientY,
      // painted = 当前 DOM 上"正在显示预览"的天；跨天时指针会一路掠过别的天，
      // 每帧都要据此把离开的天还原（见 paintCcDrag 第 0 步）
      painted: [d],
      segFrom: seg.h0 * 60 + seg.f0,
      segTo: seg.h1 * 60 + (seg.t1 >= 60 ? 60 : seg.t1),
      // 段身份 + 最近一次"合法的落点"：碰撞限制用它们把自己从占位表里摘出去，
      // 并在被人挡住时宁可原地不动（见 ccDragRange）
      segId: seg.seg || '',
      lockLo: seg.h0 * 60 + seg.f0,
      lockDay: d,
    };
  } else {
    S.ccDrag = {
      d, dCur: d, anchor: idx, cur: idx, edge, edgeX: 0, mode: 'add', moved: false,
      startY: clientY, startX: clientX, lastX: clientX, lastY: clientY,
      painted: [d],
    };
  }
  paintCcDrag();
}

/** 移动：只记下最新坐标并排一次帧，真正的重算在 ccFlushDrag 里做 */
function ccDragMove(clientY, clientX) {
  const dg = S.ccDrag;
  if (!dg) return;
  dg.pendingY = clientY;
  if (typeof clientX === 'number') dg.pendingX = clientX;
  // "真的动过"按位移算（3px）：同一格内稍微一拖也算拖动，不必跨过整格；
  // 横向同样算——跨天搬一段时，指针可能只往右挪了一点点。
  if (!dg.moved && Math.abs(clientY - dg.startY) >= 3) dg.moved = true;
  if (!dg.moved && typeof clientX === 'number' && typeof dg.startX === 'number'
    && Math.abs(clientX - dg.startX) >= 3) dg.moved = true;
  ccScheduleDrag();
}

/** 取消拖动：把预览整个撤回，不写任何数据（Esc / 窗口失焦 / 右键） */
function ccCancelDrag() {
  const dg = S.ccDrag;
  if (!dg) return;
  S.ccDrag = null;
  if (ccPaintRaf) { cancelAnimationFrame(ccPaintRaf); ccPaintRaf = 0; }
  if (ccPaintTimer) { clearTimeout(ccPaintTimer); ccPaintTimer = 0; }
  document.querySelectorAll('.cc-cell.qshow').forEach((c) => c.classList.remove('qshow'));
  const grid = document.getElementById('ccGrid');
  if (grid) {
    grid.classList.remove('dragging');
    grid.classList.remove('over-seg');
    grid.querySelectorAll('.cc-run.carry').forEach((r) => r.classList.remove('carry'));
    grid.querySelectorAll('.cc-slot').forEach((el) => el.remove());
  }
  document.body.classList.remove('cc-dragging');
  ccGhostDrop();
  // 收尾要把"掠过"的那些天一起还原：它们只在某一帧里被涂过，
  // 不属于最后那次落点，光还原 d / dCur 会把幽灵时段留在屏幕上。
  ccRestorePreview(ccDragDays(dg));
}

/** 这次拖动在 DOM 上留下的所有天（含指针一路掠过、最后已经离开的那些）。
 *  去重并保序，null 会被过滤掉。 */
function ccDragDays(dg) {
  const list = [dg.d, dg.dCur == null ? dg.d : dg.dCur].concat(dg.painted || []);
  return list.filter((d, i) => d != null && list.indexOf(d) === i);
}

/** 松手：没动过 = 单击（不改结构）；动过 = 提交这段区间 */
async function ccDragEnd() {
  const dg = S.ccDrag;
  if (!dg) return;
  // 先把还没落地的那一帧刷掉：提交的区间必须等于用户最后看到的那一块
  ccFlushDrag();
  S.ccDrag = null;

  // 落点那天（平移可跨天）
  const dCur = dg.mode === 'move' ? (dg.dCur == null ? dg.d : dg.dCur) : dg.d;

  // 记下"手上那一块"的位置，松手后用它做 FLIP 落位
  const carried = dg.mode === 'move' ? document.querySelector('#ccGrid .cc-run.carry') : null;
  const fromRect = carried ? carried.getBoundingClientRect() : null;
  const scroller = document.querySelector('#ccDetail .cc-scroll');
  const scrollTop = scroller ? scroller.scrollTop : 0;

  document.querySelectorAll('.cc-cell.qshow').forEach((c) => c.classList.remove('qshow'));
  const grid = document.getElementById('ccGrid');
  if (grid) {
    grid.classList.remove('dragging');
    grid.classList.remove('over-seg');
    grid.querySelectorAll('.cc-run.carry').forEach((r) => r.classList.remove('carry'));
    grid.querySelectorAll('.cc-slot').forEach((el) => el.remove());
  }
  document.body.classList.remove('cc-dragging');
  ccGhostDrop();

  const { lo, hi } = ccDragRange(dg);
  const h0 = Math.floor(lo / 60), h1 = Math.floor((hi - 1) / 60);
  // 留给右键菜单的"当前选区"：用粒度坐标表示，和旧版一致
  S.ccRect = {
    d0: dCur, d1: dCur, h0, h1,
    qA: Math.floor((lo - h0 * 60) / ccStep()),
    qB: Math.ceil((hi - h1 * 60) / ccStep()) - 1,
  };

  if (!dg.moved) {
    // 单击：**不改任何时段**，只把选区记下来给右键菜单用。
    // （这条是硬规则：点击不得改变时段的数量与结构。）预览也要撤回去。
    ccRestorePreview(ccDragDays(dg));
    if (scroller) scroller.scrollTop = scrollTop;
    return;
  }

  if (dg.mode === 'move') {
    if (dCur === dg.d && lo === dg.segFrom && hi === dg.segTo) {
      // 原地放下：什么都不用提交，只把预览换成真实渲染
      ccRestorePreview(ccDragDays(dg));
      render();
      // render 换掉了整个面板，滚动位置要在**换完**之后还原
      const sc0 = document.querySelector('#ccDetail .cc-scroll');
      if (sc0) sc0.scrollTop = scrollTop;
      return;
    }
    // 关键：提交后**不整体重绘**。
    // 预览本来就是按最终结果画的，再 render 一次等于把 168 个格子重建一遍，
    // 既会打断落位动画，也会让"整页重新淡入"闪一下。
    const ok = await Act.clockMoveSeg(dg.d, dg.segFrom, dg.segTo, dCur, lo, hi,
      { noRender: true, resize: !!dg.resize });
    // 提交是异步的（要等一次落盘）：这期间用户可能已经开始了下一次拖动。
    // 那时预览归新拖动所有，收尾动作不能再抢 DOM。
    const live = S.ccDrag;
    const busy = live ? (live.painted || []) : [];
    // 一路掠过的中间天：既不是起点也不是落点，配置里从来没有它们，
    // 必须按配置清一遍，否则它们会作为"幽灵时段"留在屏幕上（提交不重绘，没人纠正）。
    const staleDays = (dg.painted || []).filter((d) => d !== dg.d && d !== dCur
      && busy.indexOf(d) < 0);
    if (!live) {
      if (ok) {
        // 落位后**按配置重建**涉及的这几天（起点 / 落点 / 掠过的中间天）。
        // 为什么不直接相信预览：预览只是"看起来的样子"，一旦它在某一帧少画了
        // 一块（丢窗口、被别的段盖住），noRender 提交不会有人来纠正，
        // 界面就永久少一块而数据还在。这里以数据为准重画一次，DOM 必然等于配置。
        // FLIP 用的是下面 ccLandRun 里**重建后**的目标块，动画照旧。
        const touched = [dg.d, dCur].concat(staleDays)
          .filter((d, i, arr) => arr.indexOf(d) === i);
        ccRestoreCells(touched);
        ccRenderRuns(document, null, touched);
        ccSettleRuns();         // 选中中 → 已设置（只换类，保留落位动画起点）
        ccResetLive();          // 状态条回到摘要
        ccLiveTotals(null);     // 行数据已经是最终值，这里只做一次兜底对齐
      }
      const sc2 = document.querySelector('#ccDetail .cc-scroll');
      if (sc2) sc2.scrollTop = scrollTop;
      if (ok) ccLandRun(fromRect, dCur, h0, h1);
    } else if (ok && staleDays.length) {
      // 这一次拖动还没结束：只清掠过的中间天，别动新拖动正在画的那几天
      ccRestoreCells(staleDays);
      ccRenderRuns(document, null, staleDays);
    }
    return;
  }

  await Act.clockCommitRange(dg.d, lo, hi, dg.mode);
  // 提交后整体重绘会把滚动位置打回顶部，这里还原，免得"一松手视线就跑了"
  const sc3 = document.querySelector('#ccDetail .cc-scroll');
  if (sc3) sc3.scrollTop = scrollTop;
  ccLandRun(fromRect, dg.d, h0, h1);
}

document.addEventListener('mousedown', (e) => {
  const cell = e.target.closest('.cc-cell');
  if (!cell || e.button !== 0) return;
  e.preventDefault();
  cell.classList.add('qshow');
  ccDragBegin(+cell.dataset.d, e.clientY, e.clientX);
});

document.addEventListener('mousemove', (e) => {
  if (S.ccDrag) { e.preventDefault(); ccDragMove(e.clientY, e.clientX); return; }
  // 不拖动时：顺手判断指针是不是压在段的上 / 下边界上（给缩放做预告）
  ccHoverEdge(e);
});

// 拖动期间禁掉滚轮：图表一滚动，指针与刻度就错位了（拖完自然恢复）
document.addEventListener('wheel', (e) => {
  if (S.ccDrag) e.preventDefault();
}, { passive: false });

// 指针在窗口外松开时收不到 mouseup：失焦即视为松手，避免"卡在抓取状态"
// 指针在窗口外松开时收不到 mouseup：失焦即视为**取消**（不是提交），
// 免得"切个窗口回来发现时段已经被搬走了"。
window.addEventListener('blur', () => { if (S.ccDrag) ccCancelDrag(); });

// 拖动中按 Esc = 取消（把预览撤回，不写任何数据）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !S.ccDrag) return;
  e.preventDefault();
  ccCancelDrag();
});

// Hub 上的语录：右键弹出「来源」设置。
// 只认 [data-quote-box]，不碰图表那边的格子右键——两套菜单各管各的。
document.addEventListener('contextmenu', (e) => {
  const box = e.target && e.target.closest ? e.target.closest('[data-quote-box]') : null;
  if (!box) return;
  e.preventDefault();
  Act.quoteSrcMenu();
});

// 设置页的语录输入框：回车等于点「添加」
// 自动启动的星期小按钮：点一下切换"这一天跑不跑"


document.addEventListener('keydown', (e) => {
  if (!e.target || e.target.id !== 'setQuoteNew') return;
  if (e.key !== 'Enter') return;
  e.preventDefault();
  Act.setQuoteAdd();
});

/** 找出某一列里起止小时对应的那个块（块是渲染出来的，没有稳定 id） */
function ccFindRun(d, h0, h1) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return null;
  return [...grid.querySelectorAll('.cc-run')].find((r) => +r.dataset.d === d
    && +r.dataset.h0 === h0 && +r.dataset.h1 === h1) || null;
}

/** 悬停到某一段上：整段轻微抬起 + 光标变 grab，预告"按住能整段搬走"。
 *  用 key 缓存，避免在同一个段里每移动一像素就操作一次 DOM。 */
function ccMarkHoverSeg(d, seg) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  const key = seg ? `${d}:${seg.h0}:${seg.h1}` : '';
  // 缓存只是为了省掉重复的 DOM 操作，但类可能被别处（按下、重绘）清掉，
  // 所以"同一个 key 且状态确实还在"才跳过。
  const marked = !!grid.querySelector('.cc-run.over');
  if (S.ccHoverKey === key && marked === !!seg) return;
  S.ccHoverKey = key;
  grid.querySelectorAll('.cc-run.over').forEach((r) => r.classList.remove('over'));
  if (!seg) return;
  const run = ccFindRun(d, seg.h0, seg.h1);
  if (run) run.classList.add('over');
}

/** 收起边缘手柄（离开图表 / 开始拖动时） */
function ccEdgeClear() {
  const grid = document.getElementById('ccGrid');
  if (S.ccEdgeKey) S.ccEdgeKey = '';
  if (!grid) return;
  grid.classList.remove('over-edge');
  grid.querySelectorAll('.cc-run.edge-top, .cc-run.edge-bottom')
    .forEach((r) => r.classList.remove('edge-top', 'edge-bottom'));
}

/** 悬停在某一段的上下边界 → 长出手柄 + 光标 ns-resize。
 *
 *  必须挂在 mousemove 而不是 mouseover 上：一个段可能只占半格
 *  （10:15–10:45），指针在段内从中间走到下边界，压根不会换元素、
 *  也就不会触发 mouseover。 */
function ccHoverEdge(e) {
  const grid = document.getElementById('ccGrid');
  if (!grid) return;
  const cell = e.target && e.target.closest ? e.target.closest('.cc-cell') : null;
  if (!cell || !grid.contains(cell)) { ccEdgeClear(); return; }
  const d = +cell.dataset.d;
  const g = ccGrainAt(d, e.clientY);
  const seg = ccSegAt(d, g.idx * ccStep());
  const zone = ccEdgeZone(d, seg, e.clientY);
  const key = `${d}:${seg ? `${seg.h0}-${seg.h1}` : ''}:${zone || ''}`;
  const marked = !!grid.querySelector('.cc-run.edge-top, .cc-run.edge-bottom');
  // 重绘会把块整个换掉、类跟着丢；所以"key 没变但标记不见了"也要重新打上
  if (key === S.ccEdgeKey && (marked || !zone)) return;
  S.ccEdgeKey = key;
  grid.classList.toggle('over-edge', !!zone);
  grid.querySelectorAll('.cc-run.edge-top, .cc-run.edge-bottom')
    .forEach((r) => r.classList.remove('edge-top', 'edge-bottom'));
  if (!zone) return;
  const run = ccFindRun(d, seg.h0, seg.h1);
  if (run) run.classList.add(zone === 'top' ? 'edge-top' : 'edge-bottom');
}

document.addEventListener('mouseover', (e) => {
  const gr = document.getElementById('ccGrid');
  if (S.ccDrag) { if (gr) { gr.classList.remove('over-seg'); gr.classList.remove('over-edge'); } return; }
  const cell = e.target.closest('.cc-cell');
  if (!cell) {
    if (gr) gr.classList.remove('over-seg');
    ccMarkHoverSeg(0, null);
    ccEdgeClear();
    return;
  }
  const d = +cell.dataset.d;
  const g = ccGrainAt(d, e.clientY);
  const seg = ccSegAt(d, g.idx * ccStep());
  if (gr) gr.classList.toggle('over-seg', !!seg);
  ccMarkHoverSeg(d, seg);
  ccHoverTip(cell, d, +cell.dataset.h, g.idx % ccQCnt());
});

// 指针离开日历 → 收起"可抓"状态
document.addEventListener('mouseout', (e) => {
  if (S.ccDrag) return;
  const to = e.relatedTarget;
  if (to && to.closest && to.closest('#ccGrid')) return;
  const gr = document.getElementById('ccGrid');
  if (gr && e.target.closest && e.target.closest('#ccGrid')) {
    gr.classList.remove('over-seg');
    ccMarkHoverSeg(0, null);
    ccEdgeClear();
  }
});

document.addEventListener('mouseup', async () => { await ccDragEnd(); });

/* 触摸：同一套核心，只是把坐标换成 touches[0]。
 * touchstart 里必须 preventDefault，否则浏览器会补发一套 mouse 事件，
 * 一次触摸会被当成两次操作。 */
document.addEventListener('touchstart', (e) => {
  const cell = e.target.closest && e.target.closest('.cc-cell');
  if (!cell || e.touches.length !== 1) return;
  e.preventDefault();
  cell.classList.add('qshow');
  ccDragBegin(+cell.dataset.d, e.touches[0].clientY, e.touches[0].clientX);
}, { passive: false });

document.addEventListener('touchmove', (e) => {
  if (!S.ccDrag) return;
  e.preventDefault();
  // 多指（捏合缩放）不参与拖选，避免和图表缩放手势打架
  if (e.touches.length !== 1) return;
  ccDragMove(e.touches[0].clientY, e.touches[0].clientX);
}, { passive: false });

document.addEventListener('touchend', async (e) => {
  if (!S.ccDrag) return;
  e.preventDefault();
  await ccDragEnd();
}, { passive: false });

document.addEventListener('touchcancel', async () => { await ccDragEnd(); });

