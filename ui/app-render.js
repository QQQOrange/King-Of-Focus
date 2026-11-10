/* 渲染调度、复制面板、启动时的浏览器巡检提示
 *
 * 由 app.js 按连续切片拆出（见 docs/release-notes 里那一版说明）。
 * 加载顺序就是原来的自上而下顺序：**不要**调整 <script> 的先后，
 * 顶层 const / function 共享同一个全局词法环境，换顺序会改变求值时机。
 */
'use strict';

/* ---------------- 渲染调度 ---------------- */
/** 睡眠锁屏浮层：盖住整个应用，只留一个「积分解锁」按钮。
 *
 *  为什么要两层：全屏锁屏窗口管"整个桌面"，这一层管"应用内"——
 *  托盘图标、任务栏预览都能把主窗口翻到前面来，光靠窗口层级挡不住，
 *  但盖在 DOM 上的这一层永远在最上面（z-index 高于弹窗与 toast）。
 *  状态每秒跟着 1.5s 轮询刷新，不额外起定时器。
 */
function syncSleepLock() {
  const rt = (S.data && S.data.runtime) || {};
  const st = rt.sleep || {};
  // 卡片上的那句话也跟着秒级刷新（只换文本，不动整页）
  const card = document.querySelector('#sleepCard .sleep-state');
  if (card) {
    const line = sleepStateOf(rt);
    card.className = 'sleep-state ' + line.cls;
    const span = card.querySelector('span:last-child');
    if (span && span.textContent !== line.txt) {
      // 换成一个**新的**文本节点再翻译：i18n 用 WeakMap 记住"原文"，
      // 直接改 nodeValue 会让它以为还是上一句，英文界面下就漏翻。
      span.textContent = '';
      span.appendChild(document.createTextNode(line.txt));
      I18N.apply(span);
    }
  }
  let el = document.getElementById('sleepShield');
  if (!st.locked) {
    if (el) el.remove();
    return;
  }
  const left = Math.max(0, st.remain || 0);
  const mm = Math.floor(left / 60), ss = left % 60;
  const price = st.price || 0;
  const mins = st.unlockMin || 30;
  const afford = (st.balance || 0) >= price && price > 0;
  const shell = `
      <div class="sl-moon">🌙</div>
      <div class="sl-title">现在是睡眠时间</div>
      <div class="sl-sub">这台电脑该关着了。睡眠时段内的一切功能都被限制。</div>
      <div class="sl-count"><b></b><span></span></div>
      <button class="btn btn-sm sl-btn" data-act="sleep-unlock"></button>
      <div class="sl-foot"></div>`;
  if (!el) {
    el = document.createElement('div');
    el.id = 'sleepShield';
    el.className = 'sleep-lock';
    // 只建一次结构：每 1.5 秒重建 innerHTML 会让按钮节点被换掉，
    // 键盘用户 Tab 上去之后焦点每 1.5 秒掉回 body（这是全屏遮挡，唯一出口就是它）。
    el.innerHTML = `<div class="sl-box">${shell}</div>`;
    document.body.appendChild(el);
    I18N.apply(el);
  }
  // 之后只改文本 / 属性
  const box = el.querySelector('.sl-box');
  const cnt = el.querySelector('.sl-count');
  if (box && cnt) {
    cnt.classList.toggle('hot', left <= 60);
    const b = cnt.querySelector('b');
    const sp = cnt.querySelector('span');
    const t = `${pad(mm)}:${pad(ss)}`;
    if (b && b.textContent !== t) b.textContent = t;
    const sub = st.shutdown ? '后自动关机' : '（只锁定，不关机）';
    if (sp && sp.textContent !== sub) { sp.textContent = sub; I18N.apply(sp); }
    const btn = el.querySelector('.sl-btn');
    if (btn) {
      btn.disabled = !afford;
      const label = price ? `用 ${price} 积分解锁 ${mins} 分钟` : '这段睡眠没有开启积分解锁';
      if (btn.textContent.trim() !== label) { btn.textContent = label; I18N.apply(btn); }
    }
    const foot = el.querySelector('.sl-foot');
    if (foot) {
      const want = `积分余额 ${st.balance || 0}${afford || !price ? '' : ' · 积分不够'}`;
      // 第一行是纯文本，第二行固定；用 textContent 重建会丢 <br>，所以只改第一段
      const first = foot.firstChild;
      if (first && first.nodeType === 3 && first.nodeValue.trim() !== want) {
        first.nodeValue = want + '\n        ';
        I18N.apply(foot);
      }
    }
  }
}


/* ============================================================
   分心事件
   ------------------------------------------------------------
   这个页面的存在理由很具体：专注的敌人往往不是"想玩"，而是
   "突然冒出一个必须记住的念头"。念头一旦在脑子里待着，就会一直
   抢注意力。所以第一步是**就地记下**（HUD 上的「记一笔」），
   第二步才是**集中处理**（这一页）。
   两件事刻意分开：记录时不分类、不追问、不切换页面；
   处理时才有清单、勾选、时段归属和提醒。
   ============================================================ */

function dxState() {
  S.dx = S.dx || {
    day: todayStr(),
    view: 'month',
    month: todayStr().slice(0, 7),
    data: null,
    monthData: null,
    ledger: null,
    loading: false,
  };
  return S.dx;
}

/** 拉取：某天的清单 + 某个月的日历计数（两个请求并发，省一次往返） */
async function dxLoad() {
  const d = dxState();
  if (d.loading) return;
  d.loading = true;
  try {
    const [day, mon, led] = await Promise.all([
      invoke('distract_day', { day: d.day }),
      invoke('distract_month', { month: d.month }),
      invoke('ledger_today', { limit: 6 }),
    ]);
    d.data = day && !day.error ? day : { day: d.day, items: [], groups: [], total: 0, done: 0 };
    d.monthData = mon && !mon.error ? mon : { days: {}, pending: 0, today: todayStr() };
    d.ledger = led && !led.error ? led : { total: 0, items: [] };
  } catch (e) {
    toast('读取分心事件失败：' + String(e).replace(/^Error:\s*/, ''), 'err');
  }
  d.loading = false;
  if (S.view === 'distract') render();
}

/** 一条 */
function dxRow(it) {
  const t = new Date((it.at || 0) * 1000);
  const hhmm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  // 这一句是"时间 + 时段标签"拼出来的，词典逐字命中不了，只能按语言拼
  const en = I18N.getLang() === 'en';
  const seg = en
    ? it.segLabel ? `window ${esc(it.segLabel)}` : 'outside any window'
    : it.segLabel ? `时段 ${esc(it.segLabel)}` : '不在自律时段内';
  return `<div class="dx-item${it.done ? ' done' : ''}">
      <div class="box" data-act="dx-toggle" data-id="${esc(it.id)}" data-done="${it.done ? '1' : '0'}"
        title="${it.done ? '取消勾选（重新变成待处理）' : '处理完了，打勾'}">${it.done ? '✓' : ''}</div>
      <div class="tx">${esc(it.text)}
        <div class="meta">${hhmm} 写入 · ${seg}</div>
      </div>
      <button class="btn btn-sm danger-ghost" data-act="dx-del" data-id="${esc(it.id)}">删除</button>
    </div>`;
}

/** 月历（周一为每周第一天，与「自律时段」的网格一致） */
function dxMonthGrid(d) {
  const days = (d.monthData && d.monthData.days) || {};
  const today = (d.monthData && d.monthData.today) || todayStr();
  const [y, m] = d.month.split('-').map(Number);
  if (!y || !m) return '';
  const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const total = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push('<div class="dx-d blank"></div>');
  for (let dd = 1; dd <= total; dd++) {
    const key = `${d.month}-${pad(dd)}`;
    const rec = days[key] || {};
    const n = rec.total || 0;
    const k = rec.done || 0;
    const cls = ['dx-d'];
    if (key === today) cls.push('today');
    if (key === d.day) cls.push('sel');
    if (n) cls.push('has');
    if (n && k >= n) cls.push('all-done');
    cells.push(`<div class="${cls.join(' ')}" data-act="dx-pick" data-day="${key}">
        ${dd}${n ? `<span class="dx-n">${n}</span><span class="dx-dot"></span>` : ''}
      </div>`);
  }
  return cells.join('');
}

/** 周视图：以选中那天所在的周（周一起）为一条横向卡片 */
function dxWeekGrid(d) {
  const days = (d.monthData && d.monthData.days) || {};
  const base = new Date(d.day + 'T00:00:00');
  if (isNaN(base.getTime())) return '';
  const offset = (base.getDay() + 6) % 7;
  const monday = addDays(base, -offset);
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  return names.map((n, i) => {
    const dt = addDays(monday, i);
    const key = dateStr(dt);
    // 周可能跨月：计数要按各自的月份取，这里只在同月时才有数据
    const rec = key.slice(0, 7) === d.month ? days[key] || {} : {};
    const total = rec.total || 0;
    const done = rec.done || 0;
    const label = total ? `${done}/${total}` : '—';
    return `<div class="dx-wc${key === d.day ? ' sel' : ''}" data-act="dx-pick" data-day="${key}">
        <div class="w">周${n}</div><div class="d">${dt.getDate()}</div><div class="c">${label}</div>
      </div>`;
  }).join('');
}

function viewDistract() {
  const d = dxState();
  const cfg = (S.data.config.settings || {}).distract || {};
  const on = cfg.enabled !== false;
  const data = d.data || {};
  const items = data.items || [];
  const groups = data.groups || [];
  const total = data.total || 0;
  const done = data.done || 0;
  const pending = (d.monthData && d.monthData.pending) || 0;
  const led = d.ledger || { total: 0, items: [] };
  const en = I18N.getLang() === 'en';
  // 自动遮罩是遮罩页的开关（mask.followSchedule），这里只是给个近路
  const autoMask = !!((S.data.config.settings || {}).mask || {}).followSchedule;

  const segLabel = (l) => (en && l === '不在自律时段内' ? 'Outside any window' : l);
  const list = groups.length
    ? groups.map((g) => `<div class="dx-group">
          <div class="dx-seg"><b>${esc(segLabel(g.label))}</b>${
            g.goal ? `<span class="dx-goal" title="这一段开始前写的目标">${esc(g.goal)}</span>` : ''
          }${g.state ? `<span class="dx-st ${esc(g.state)}">${
            g.state === 'done' ? (en ? 'done' : '做完了')
            : g.state === 'partial' ? (en ? 'half' : '一半')
            : (en ? 'not done' : '没做成')
          }</span>` : ''}<span class="ln"></span><span>${g.items.length} ${en ? 'items' : '条'}</span></div>
          ${g.items.map(dxRow).join('')}
        </div>`).join('')
    : `<div class="empty"><span class="ico">✎</span>这天还没有记录。<br>
        专注时想到什么，点 HUD 左上角的「＋」记下来就行。</div>`;

  const [y, m] = d.month.split('-');
  const monthTitle = `${y} 年 ${Number(m)} 月`;

  return `
  <div class="card">
    <div class="card-title">分心事件
      <span class="badge gold">${en ? `${total} items · ${done} done` : `${total} 条 · 已处理 ${done}`}</span>
      ${pending ? `<span class="badge blue">${en ? `${pending} to process` : `待处理 ${pending}`}</span>` : ''}
    </div>
    <div class="card-sub">
      专注当中冒出的零散想法，先点 HUD 上的「＋」记一笔——记录这个动作本身就算把它从脑子里搬了出来。
      自律时段结束后会汇总提醒一次，没处理的按设置的间隔再提醒。
    </div>
    <div class="row" style="align-items:center;gap:9px;flex-wrap:wrap">
      <div class="seg">
        <button class="seg-btn${d.view === 'week' ? ' active' : ''}" data-act="dx-view" data-v="week">周视图</button>
        <button class="seg-btn${d.view === 'month' ? ' active' : ''}" data-act="dx-view" data-v="month">月视图</button>
      </div>
      <div class="row" style="align-items:center;gap:6px">
        <button class="btn btn-sm" data-act="dx-prev">‹</button>
        <span style="font-size:12px;font-variant-numeric:tabular-nums;min-width:96px;text-align:center">${
          d.view === 'month' ? monthTitle : `${d.day} 那周`
        }</span>
        <button class="btn btn-sm" data-act="dx-next">›</button>
        <button class="btn btn-sm" data-act="dx-today">今天</button>
      </div>
      <span class="hint" style="margin-left:auto">记录时间：${esc(d.day)}</span>
    </div>
  </div>

  <div class="dx-wrap">
    <div class="card" style="margin:0">
      <div class="card-title" style="font-size:13px">当天清单</div>
      ${total && done ? `<div class="row" style="margin-bottom:6px">
          <span class="hint">${en ? `Done ${done} / ${total}` : `已处理 ${done} / ${total}`}</span>
          <button class="btn btn-sm" style="margin-left:auto" data-act="dx-clear">清掉已完成</button>
        </div>` : ''}
      ${list}
    </div>

    <div class="card" style="margin:0">
      <div class="card-title" style="font-size:13px">${d.view === 'month' ? '月历' : '这周'}</div>
      ${d.view === 'month'
        ? `<div class="dx-cal">
             ${['一', '二', '三', '四', '五', '六', '日'].map((w) => `<div class="dx-wd">${w}</div>`).join('')}
             ${dxMonthGrid(d)}
           </div>`
        : `<div class="dx-week">${dxWeekGrid(d)}</div>`}
      <div class="hint" style="margin-top:8px">点任意一天即可查看那天的全部记录；绿点表示当天都处理完了。</div>

      <div class="card-title" style="font-size:13px;margin-top:18px">记录按钮与提醒</div>
      <div class="row" style="align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line)">
        <div>
          <div style="font-size:12.5px">启用分心事件</div>
          <div class="hint" style="margin-top:3px">关掉后 HUD 上不出现「＋」，也不再提醒（已记的条目都还在）</div>
        </div>
        <label class="switch" data-act="dx-on"><input type="checkbox" id="dxOn" ${on ? 'checked' : ''}><i></i></label>
      </div>
      <div class="row" style="align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line)">
        <div>
          <div style="font-size:12.5px">自律时段开始时自动开遮罩</div>
          <div class="hint" style="margin-top:3px">时段一开始就把桌面盖住，「＋」才真的在你的视线里</div>
        </div>
        <label class="switch" data-act="dx-mask"><input type="checkbox" id="dxMask" ${autoMask ? 'checked' : ''}><i></i></label>
      </div>
      <div class="row" style="align-items:center;gap:9px;margin-top:11px;flex-wrap:wrap">
        <span class="hint" style="width:88px">按钮位置</span>
        <select id="dxCorner" class="input" style="max-width:150px">
          ${[['tl', '左上角'], ['tr', '右上角'], ['bl', '左下角'], ['br', '右下角']]
            .map(([v, t]) => `<option value="${v}" ${(cfg.buttonCorner || 'tl') === v ? 'selected' : ''}>${t}</option>`)
            .join('')}
        </select>
      </div>
      <div class="row" style="align-items:center;gap:9px;margin-top:9px;flex-wrap:wrap">
        <span class="hint" style="width:88px">重复提醒</span>
        <input type="number" id="dxMin" class="input" min="0" max="43200" step="15" style="max-width:110px"
          value="${cfg.remindMinutes != null ? cfg.remindMinutes : 120}" />
        <span class="hint">分钟一次，0 = 只在时段结束时提醒</span>
      </div>
      <div class="row" style="align-items:center;gap:9px;margin-top:9px;flex-wrap:wrap">
        <span class="hint" style="width:88px">最多追</span>
        <input type="number" id="dxDays" class="input" min="1" max="90" style="max-width:110px"
          value="${cfg.remindMaxDays != null ? cfg.remindMaxDays : 7}" />
        <span class="hint">天，超过就不再提醒（避免陈年旧账天天弹）</span>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn btn-primary btn-sm" data-act="dx-save">保存设置</button>
        <span class="hint" style="margin-left:10px">间隔太密会变成新的打扰，建议 60–180 分钟</span>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title" style="font-size:13px">今天被什么打断
      ${led.total ? `<span class="badge gold">${en ? `${led.total} hits` : `共 ${led.total} 次`}</span>` : ''}
    </div>
    <div class="card-sub">
      只记<b>真的被拦下</b>的东西（应用被送回桌面、网页被关掉）。次数最多的那一个，
      就是最值得关掉的那一个。
    </div>
    ${led.items && led.items.length
      ? led.items.map((h) => `<div class="list-row">
          <span class="badge ${h.kind === 'site' ? 'blue' : 'gold'}">${h.kind === 'site' ? (en ? 'site' : '网页') : (en ? 'app' : '软件')}</span>
          <span class="grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(h.label)}">${esc(h.label)}</span>
          <span class="hint" style="flex:0 0 auto">${esc(h.rule || '')}</span>
          <b style="flex:0 0 auto;font-variant-numeric:tabular-nums">${h.n} ${en ? 'x' : '次'}</b>
        </div>`).join('')
      : `<div class="empty"><span class="ico">✓</span>${en
          ? 'Nothing blocked today.' : '今天还没被拦过。要么很自律，要么规则没生效——去总览看看守护状态。'}</div>`}
  </div>`;
}

function render() {
  if (!S.data && S.view !== 'reports') { $('#content').innerHTML = '<div class="empty is-loading">加载中…</div>'; return; }
  // 只有真的换了页面才播入场：数据每 1.5s 刷一次，动画不能跟着重播
  const viewChanged = S._renderedView !== S.view;
  S._renderedView = S.view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
  $('#pageTitle').textContent = VIEW_TITLES[S.view];

  let html = '';
  if (S.view === 'overview') html = viewOverview();
  if (S.view === 'rules') html = viewRules();
  if (S.view === 'clock') html = viewClock();
  if (S.view === 'mask') html = viewMask();
  if (S.view === 'browsers') html = viewBrowsers();
  if (S.view === 'stats') html = viewStats();
  if (S.view === 'distract') html = viewDistract();
  if (S.view === 'reports') html = viewReports();
  if (S.view === 'sync') html = viewSync();
  if (S.view === 'settings') html = viewSettings();
  if (S.view === 'help') html = viewHelp();
  if (S.view === 'about') html = viewAbout();
  // 安全模式：连续几次启动没撑住。提示必须挂在**每一页**最上面——
  // 用户进来第一件事就是改规则，不能让他先去找入口。
  if (S.data && S.data.safeMode) html = safeBanner() + html;
  $('#content').innerHTML = html;

  // 连续时段要画成整块：格子是静态的，覆盖层得在 DOM 落地后再算
  if (S.view === 'clock') ccRenderRuns();

  if (S.view === 'stats') {
    const cur = currentSlices();
    // focusKey：重画时把"选中哪一项"带过去，否则一刷新选中状态就丢了
    drawPie($('#pie'), cur.slices, cur.total, { sub: '累计前台时长', focusKey: S.calHit });
    calEnsure();      // 周/月日历：区间没变就不重复请求
    dayEnsure();      // 当日日历：网格里已有这天就直接复用，不额外请求
    heatEnsure();     // 年度热力图：一天只拉一次
  }

  // 设置页的「分区重置」卡片：撤销状态要单独问一次后端（不放进 1.5s 轮询里）
  if (S.view === 'settings') loadResetState();

  // 内容区刚重绘，节点是中文原文；英文界面下立刻翻一遍
  applyLangView();

  // 睡眠锁屏：主界面也要挡住（锁屏窗口盖住整个桌面，这里管的是"应用内"）
  syncSleepLock();

  if (viewChanged) {
    const box = $('#content');
    if (box) {
      box.classList.remove('view-in');
      void box.offsetWidth;          // 强制重排，让动画能重新播放
      box.classList.add('view-in');
      clearTimeout(S._viewInTimer);
      // 动画最长 340 + 72(错峰) ≈ 412ms，600ms 后撤类，避免影响后续 hover
      S._viewInTimer = setTimeout(() => box.classList.remove('view-in'), 600);
    }
  }
}

/* ---------------- 复制与扩展目录面板 ---------------- */

/** 给任意 Promise 加一个上限时间。有的系统调用（拉起浏览器 / 读别的浏览器配置）
 *  在特定环境下会卡很久，卡住时也必须给用户一个明确的结论，不能让界面停在"加载中"。 */
function withTimeout(p, ms, hint) {
  let tid = 0;
  const timeout = new Promise((_, rej) => {
    tid = setTimeout(() => rej(new Error(hint || '操作超时')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(tid));
}

/** 复制文本：优先 clipboard API，失败回退到隐藏 textarea + execCommand */async function copyText(text) {
  const t = String(text || '');
  if (!t) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (e) { /* 有些 webview 不给权限，走回退 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

/** 安装引导里的"扩展文件夹"面板：标题、路径、按钮各占一行，任何宽度都不会挤在一起 */
function extFolderPanel(info) {
  const i = info || (S.data && S.data.extInfo) || {};
  const exists = !!i.exists;
  return `<div class="ext-box reveal-in">
    <div class="ext-head">
      <div class="ext-title">扩展文件夹</div>
      <span class="badge ${exists ? 'green' : 'red'}">${exists ? '目录已就绪' : '目录未找到'}</span>
    </div>
    <div class="ext-path" id="extPath">${esc(i.path || '（未知路径）')}</div>
    <div class="ext-actions">
      <button class="btn btn-sm btn-primary" data-act="ext-copy">复制路径</button>
      <button class="btn btn-sm" data-act="ext-open">打开文件夹</button>
    </div>
    <div class="hint" id="extNote">
      ${exists
        ? '在扩展管理页点「加载已解压的扩展程序」，把上面这个路径粘到地址栏回车后选中该文件夹即可。'
        : `这个路径下没找到 manifest.json。程序目录是 <code>${esc(i.exeDir || '')}</code>，${i.crx ? '同目录里还有 CRX 安装包，可以直接拖进扩展页。' : '请重新解压完整安装包，或到 GitHub 下载最新版。'}`}
    </div>
  </div>`;
}

/* ---------------- 启动时的浏览器巡检提示 ---------------- */
async function promptBrowserSetup() {
  if (S.data && S.data.config.settings.browserGuard && S.data.config.settings.browserGuard.detectOnStart === false) return;
  let list = [];
  try {
    const r = await invoke('browsers_scan');
    list = r.list || [];
    S.browsers = list;
  } catch (e) { return; }
  const broken = list.filter((b) => b.installed && (b.ext === 'notInstalled' || b.ext === 'disabled'));
  if (!broken.length) return;
  // 一次启动只弹一次：本次点"稍后再说"后不再打扰
  if (sessionStorage.getItem('kof-browser-prompt') === '1') return;
  sessionStorage.setItem('kof-browser-prompt', '1');

  const rows = broken.map((b) => `
    <div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)">
      <span>${esc(b.name)}</span>
      <span class="badge ${b.ext === 'disabled' ? 'gold' : 'red'}">${b.ext === 'disabled' ? '插件被停用' : '插件未安装'}</span>
    </div>`).join('');

  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal">
      <div class="modal-hd">
        <h3>浏览器插件还没就绪</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="note" style="margin-bottom:12px">
          检测到 <b>${broken.length}</b> 个浏览器装了但插件没启用。缺少这个插件会有两个后果：
          <div style="margin-top:8px;line-height:1.9">
            ① 网页自律规则拦不住（插件负责在请求层拦截，并在自律时段扫掉已打开的标签页）<br>
            ② 自律时段里打开这些浏览器会被<b>自动关闭</b>（因为无法确认网页是否违规）
          </div>
        </div>
        <div style="font-size:12.5px">${rows}</div>
        <div class="hint" style="margin-top:10px">
          点「去安装」会打开对应浏览器的扩展管理页，并给你 10 分钟安装时间（这期间不会关浏览器）。
        </div>
      </div>
      <div class="modal-ft">
        <button class="btn" data-act="close-modal">稍后再说</button>
        <button class="btn btn-primary" data-act="browser-prompt-go">去安装</button>
      </div>
    </div>
  </div>`;
}

