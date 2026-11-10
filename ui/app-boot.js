/* 时段右键菜单、启动初始化与兜底
 *
 * 由 app.js 按连续切片拆出（见 docs/release-notes 里那一版说明）。
 * 加载顺序就是原来的自上而下顺序：**不要**调整 <script> 的先后，
 * 顶层 const / function 共享同一个全局词法环境，换顺序会改变求值时机。
 */
'use strict';

/* ---- 自律时段：右键打开「时段设置」模态对话框 ---- */
let ccMenu = null;

function ccCloseMenu() {
  if (window.__ccMenuCtrl) { window.__ccMenuCtrl.abort(); window.__ccMenuCtrl = null; }
  ccMenu = null;
  closeModal();
}

/** 计算某小时当前的窗口文本（含起止分钟） */
function ccHourWinText(d, h, fromMin, toMin) {
  const pf = fromMin > 0 ? `:${pad(fromMin)}` : ':00';
  const endH = (toMin == null ? 60 : toMin) >= 60 ? h + 1 : h;
  const pt = (toMin == null ? 60 : toMin) >= 60 ? ':00' : `:${pad(toMin)}`;
  return `${pad(h)}${pf} – ${pad(endH)}${pt}`;
}

/** 解析连续段（结构化）：把一列里相邻的、连续的小时合并成一段（含起止分钟窗口） */
function ccDaySegs(day) {
  const out = [];
  let i = 0;
  while (i < 24) {
    if (!day[i] || !day[i].on) { i++; continue; }
    let j = i;
    while (j + 1 < 24 && day[j + 1] && day[j + 1].on
      && (day[j].to == null ? 60 : day[j].to) >= 60
      && (day[j + 1].from || 0) <= 0) j++;
    const snap0 = ccSnapWin(day[i].from, day[i].to);
    const snap1 = ccSnapWin(day[j].from, day[j].to);
    const work = day[i].work || CC_DEF_W;
    const brk = day[i].brk || CC_DEF_B;
    // 计算总时长（分钟）
    const totalMin = (j - i) * 60 - snap0.f + snap1.t;
    // 类型：有休息=番茄专注，无休息=纯专注
    const kind = brk > 0 ? '番茄专注' : '纯专注';
    // 备注
    const notes = [];
    if (brk > 0 && work + brk < 60) notes.push('尾段继续专注');
    if (i === 0 && snap0.f === 0) notes.push('从 0 点开始');
    if (j === 23 && snap1.t >= 60) notes.push('到 24 点结束');
    if (j > i) notes.push(`跨 ${j - i + 1} 个小时`);
    out.push({
      h0: i, h1: j, from: snap0.f, to: snap1.t, work, brk,
      totalMin, kind, notes,
    });
    i = j + 1;
  }
  return out;
}

/**
 * 把目标范围展开成**逐个 15 分钟刻度**的垂直列表。
 *
 * 这正是原来主网格里那条"一条横条从左到右划分 4 段"（`.cc-q`）的展开版：
 * 横条只有颜色、看不出任何信息；这里改成从上到下一行一个刻度，
 * 每行给出起止时间、类型（专注 / 休息 / 未选中）、备注，并可直接开关这一段。
 *
 * 类型判定与后端 clock.rs 的节奏一致：以「选中窗口起点」为周期起点，
 * 循环 专注 work 分 → 休息 brk 分；offset % (work+brk) < work 即为专注。
 */
function ccBuildSegments(t) {
  const prof = clockProfile();
  const rows = [];
  for (let d = t.d0; d <= t.d1; d++) {
    const day = prof.days[d] || [];
    for (let h = t.h0; h <= t.h1; h++) {
      const p = day[h];
      if (!p) continue;
      const work = p.work || CC_DEF_W;
      const brk = p.brk || CC_DEF_B;
      const winF = p.on ? (p.from || 0) : 0;
      const winT = p.on ? (p.to == null ? 60 : p.to) : 60;
      const cycle = work + brk;
      let cum = 0;            // 本小时选中窗口内的累计专注分钟
      for (let q = 0; q < ccQCnt(); q++) {
        const a = qStart(q), b = qEnd(q);
        const on = p.on && winF < b && a < winT;
        let type = 'off';
        let note = '未选中';
        let focusMin = 0, breakMin = 0;
        if (on) {
          // 逐分钟判定：专注 work 分 → 休息 brk 分，循环，周期起点 = **整点**。
          // 必须与后端 clock.rs 的相位锚点一致：窗口的 from/to 只收窄"哪几分钟可见"，
          // 不改变节奏。用窗口起点当锚点会让界面显示与实际拦截错开。
          // 15 分钟刻度可能正好横跨边界（50/10 时 45–60 这一段就是），
          // 所以按"这一段里专注/休息各占多少分钟"来定类型，取多的那个。
          const lo = Math.max(a, winF), hi = Math.min(b, winT);
          for (let m = lo; m < hi; m++) {
            const off = m;
            if (brk <= 0 || cycle <= 0) { focusMin++; }
            else {
              const phase = ((off % cycle) + cycle) % cycle;
              if (phase < work) focusMin++; else breakMin++;
            }
          }
          type = breakMin > focusMin ? 'break' : 'focus';
          if (focusMin > 0 && breakMin > 0) {
            note = `专注 ${focusMin} 分 / 休息 ${breakMin} 分`;
          } else if (type === 'break') {
            note = '休息中，不拦截';
          } else {
            note = '连续专注';
          }
        }
        cum += focusMin;
        rows.push({
          d, h, q,
          a, b,
          on,
          type,
          note,
          focusMin, breakMin,
          cumFocus: cum,
          // 该刻度落在窗口里的哪一段（只显示窗口内的部分）
          inFrom: Math.max(a, winF),
          inTo: Math.min(b, winT),
          work, brk,
        });
      }
    }
  }
  return rows;
}

/** 一行刻度的起止时间文案（考虑窗口收窄：只显示落在窗口里的部分） */
function ccSegTimeText(s) {
  const f = s.inFrom > s.a ? s.inFrom : s.a;
  const t = s.inTo < s.b ? s.inTo : s.b;
  const fH = s.h + Math.floor(f / 60);
  const tH = s.h + Math.floor(t / 60);
  return `${pad(fH)}:${pad(f % 60)} – ${pad(tH)}:${pad(t % 60)}`;
}

/** 一行刻度的类型徽章文案 */
function ccSegTypeText(s) {
  if (s.type === 'focus') return '专注';
  if (s.type === 'break') return '休息';
  return '未选中';
}

/** 从上到下、垂直列出各时段（替代原来一条横条 4 段的布局） */
function ccBuildSegRows(t) {
  const rows = [];
  for (let d = t.d0; d <= t.d1; d++) {
    const day = clockProfile().days[d];
    const ranges = ccDaySegs(day);
    ranges.forEach((r) => {
      // 只列出与目标范围有交集的段
      if (r.h1 < t.h0 || r.h0 > t.h1) return;
      rows.push({
        d,
        ...r,
        // 与目标范围的交集小时
        h0e: Math.max(r.h0, t.h0),
        h1e: Math.min(r.h1, t.h1),
      });
    });
  }
  return rows;
}

/* ───────── 右键：三种目标，互不混淆 ─────────
 *
 * 以前只有一个入口：右键任何格子都弹「时段设置」，里面还挂着一排
 * 「当前框选 / 这一格 / 这一列（一整天）」的切换 —— 于是"右键点某一段"，
 * 弹出来的却是"整天"级别的选项，手一滑就把一整天重排了。
 *
 * 现在按**点在哪**决定菜单，三档互斥，任何一张都不出现跨级选项：
 *   ① 日期表头 `.cc-dh`  → 整天：只作用于这一天 0:00–24:00
 *   ② 已有时段内部        → 时段：只作用于这一段（段首到段尾，跨小时也完整，
 *                          贴着 0:00 / 24:00 也不会牵连相邻那天）
 *   ③ 空白格子            → 选区：这一格，或当前拖选的连续范围
 *
 * 每张菜单顶部都写死"作用于 …"，所以"改了哪一段"永远是能读出来的。
 */

const CC_WB_PRESETS = [[25, 5], [45, 15], [50, 10], [60, 0]];

/** 三张菜单共用的弹窗外壳 */
function ccMenuShell(title, sub, body, foot) {
  return `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal cc-modal">
        <div class="modal-hd">
          <h3>${esc(title)}</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          ${sub ? `<div class="cc-menu-tgt">${sub}</div>` : ''}
          ${body}
        </div>
        <div class="modal-ft">${foot}</div>
      </div>
    </div>`;
}

/** 专注 / 休息输入 + 预设（三张菜单一样） */
function ccWbHtml(w, b) {
  return `
    <div class="cc-menu-row">
      <label>专注 <input type="number" id="ccW" min="1" max="60" step="1" value="${w}"> 分</label>
      <label>休息 <input type="number" id="ccB" min="0" max="60" step="1" value="${b}"> 分</label>
    </div>
    <div class="cc-menu-scope">
      ${CC_WB_PRESETS.map(([x, y]) => `<button class="chip-btn" data-wb="${x},${y}">${y ? `${x} / ${y}` : '不休息'}</button>`).join('')}
    </div>`;
}

/** 读输入框里的专注 / 休息（夹紧、休息不能挤掉专注） */
function ccReadWb() {
  let w = Math.round(Number(($('#ccW') || {}).value) || 0);
  let b = Math.round(Number(($('#ccB') || {}).value) || 0);
  w = Math.max(1, Math.min(60, w));
  b = Math.max(0, Math.min(60, b));
  if (b > 0 && w + b > 60) b = 60 - w;
  return { w, b };
}

/** 统一的菜单交互委托（预设 / 关闭 / 交给各自的 handler）
 *
 *  用 AbortController 一次性绑定：#modalRoot 是常驻节点，innerHTML 换不掉它身上的监听，
 *  逐次 addEventListener 会越积越多（点一下应用执行 N 次）。
 */
function ccBindMenu(handler) {
  if (window.__ccMenuCtrl) window.__ccMenuCtrl.abort();
  window.__ccMenuCtrl = new AbortController();
  $('#modalRoot').addEventListener('click', async (e) => {
    const wb = e.target.closest('[data-wb]');
    if (wb) {
      const [w2, b2] = wb.dataset.wb.split(',').map(Number);
      if ($('#ccW')) $('#ccW').value = w2;
      if ($('#ccB')) $('#ccB').value = b2;
      return;
    }
    if (e.target.closest('[data-act="cc-close"]')) { ccCloseMenu(); return; }
    await handler(e);
  }, { signal: window.__ccMenuCtrl.signal });
}

/** 一段的文案：周三 02:10 – 03:10 */
function ccSegText(d, seg) {
  const a = seg.h0 * 60 + seg.f0;
  const b = seg.h1 * 60 + (seg.t1 >= 60 ? 60 : seg.t1);
  return `${WD[d]} ${ccMinText(a, b).range}`;
}

/** ② 右键落在**已有时段**里 → 只针对这一段 */
function ccOpenSegMenu(d, seg, hourAt) {
  ccCloseMenu();
  const prof = clockProfile();
  const a = seg.h0 * 60 + seg.f0;
  const b = seg.h1 * 60 + (seg.t1 >= 60 ? 60 : seg.t1);
  // 右键落在哪一小时：垂直刻度表只列**这一小时**的四个刻度
  const hList = Number.isFinite(hourAt) ? hourAt : seg.h0;

  // 说明：这里**只认右键点中的这一段**。
  // 拖选是"一段连续区间"，而连续区间一旦提交就必然合成一段（见 ccSegs），
  // 所以不存在"框选一次命中好几段"的情况；真有好几段时，右键哪段就只改哪段。

  const edge = [];
  if (a === 0) edge.push('起点是 0:00（日界）');
  if (b === 1440) edge.push('终点是 24:00（日界）');

  const sub = `作用于 <b id="ccTgt">${esc(ccSegText(d, seg))}</b>（<b id="ccCnt">1</b> 段 · ${ccMinText(a, b).dur}）`;
  const body = `
    <div class="note" style="line-height:1.8">
      这是<b>一段</b>：${esc(ccSegText(d, seg))}。菜单只改这一段，
      <b>不会</b>动这一天的其它时段，也没有整天级别的选项。
      ${edge.length ? `<br>${esc(edge.join('、'))}：只作用于${WD[d]}，不会牵连相邻那天。` : ''}
    </div>
    ${ccWbHtml(seg.work || prof.defWork, seg.brk || CC_DEF_B)}
    <div class="cc-menu-row win" id="ccWinRow">
      <label>起止分钟 从 <input type="number" id="ccFrom" min="0" max="59" step="1" value="${seg.f0}"> 到</label>
      <label><input type="number" id="ccTo" min="1" max="60" step="1" value="${seg.t1}"> 分</label>
    </div>
    <div class="cc-menu-hint" id="ccWinHint">起止分钟只改这一段的首 / 尾小时（${WD[d]} ${pad(seg.h0)}:00 与 ${pad(seg.h1)}:00 那两格），中间小时保持整点。</div>
    <label class="cc-menu-def"><input type="checkbox" id="ccDefToo" checked> 同时设为通用时长（之后新选的时段沿用）</label>
    <div class="cc-menu-hint">休息期间不拦截、不遮罩；排不满 60 分钟的尾段算继续专注。</div>
    <div class="cc-tl-list" id="ccTlList">
      <div class="cc-tl-hd">
        <span class="cc-tl-c-idx">#</span>
        <span class="cc-tl-c-day">星期</span>
        <span class="cc-tl-c-time">起止时间</span>
        <span class="cc-tl-c-type">类型</span>
        <span class="cc-tl-c-note">备注</span>
        <span class="cc-tl-c-act">状态</span>
      </div>
      <div id="ccTlRows"></div>
    </div>`;
  const foot = `
    <button class="btn btn-danger" id="ccSegDel" data-armed="0">取消这一段</button>
    <span style="flex:1"></span>
    <button class="btn" data-act="cc-close">取消</button>
    <button class="btn btn-primary" id="ccApply">应用</button>`;

  $('#modalRoot').innerHTML = ccMenuShell('时段设置', sub, body, foot);
  ccMenu = $('#modalRoot');
  $('#ccW') && $('#ccW').focus();

  // 垂直刻度表：列出**右键那一小时**的四个刻度，点一下就切掉/补回这一段
  const renderSegRows = () => {
    const box = $('#ccTlRows');
    if (!box) return;
    const segs = ccBuildSegments({ d0: d, d1: d, h0: hList, h1: hList });
    if (!segs.length) { box.innerHTML = '<div class="cc-tl-empty">这个范围里没有可设置的刻度</div>'; return; }
    box.innerHTML = segs.map((s, i) => `
      <div class="cc-tl-row ${s.on ? 'on' : 'off'} type-${s.type}">
        <span class="cc-tl-idx">${i + 1}</span>
        <span class="cc-tl-day">${WD[s.d]}</span>
        <span class="cc-tl-time">${ccSegTimeText(s)}</span>
        <span class="cc-tl-type">${ccSegTypeText(s)}</span>
        <span class="cc-tl-note">${s.note}${s.on && s.type === 'focus' ? ` · 累计专注 ${s.cumFocus} 分` : ''}</span>
        <span class="cc-tl-act">
          <button class="cc-tl-btn ${s.on ? 'on' : ''}" data-tl="${s.d},${s.h},${s.q}"
            title="${s.on ? '点一下取消这 15 分钟' : '点一下选中这 15 分钟'}">${s.on ? '已选中' : '未选中'}</button>
        </span>
      </div>`).join('');
  };
  renderSegRows();

  ccBindMenu(async (e) => {
    // 刻度表里的开关：切掉 / 补回这 15 分钟，随后重画表
    const tl = e.target.closest('[data-tl]');
    if (tl) {
      const [dd, hh, qq] = tl.dataset.tl.split(',').map(Number);
      await Act.clockToggleQ(dd, hh, qq);
      renderSegRows();
      return;
    }
    // 取消这一段：两步确认，避免手滑
    const del = e.target.closest('#ccSegDel');
    if (del) {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.textContent = '再点一次，确认取消';
        return;
      }
      await Act.clockClearRange(d, seg.h0, seg.h1, ccSegText(d, seg));
      ccCloseMenu();
      return;
    }
    if (!e.target.closest('#ccApply')) return;

    const { w, b } = ccReadWb();
    const defToo = !!($('#ccDefToo') || {}).checked;
    const f2 = Math.round(Number(($('#ccFrom') || {}).value) || 0);
    const t2 = Math.round(Number(($('#ccTo') || {}).value) || 0);
    const snap = ccSnapWin(f2, t2);
    if (snap.f >= snap.t) { toast('起始分钟要小于结束分钟', 'err'); return; }
    const ok = await Act.clockSetWB(d, d, seg.h0, seg.h1, w, b, defToo, snap.f, snap.t);
    if (ok === false) { toast('起始分钟要小于结束分钟', 'err'); return; }
    ccCloseMenu();
  });
}

/** ③ 右键点在**空白格子**上 → 只作用这一格（不再是"这一列"或"整个框选"） */
function ccOpenCellMenu(d, h) {
  ccCloseMenu();
  const fc = clockProfile();
  const p = fc.days[d][h];
  const pre = p.on
    ? { w: p.work || CC_DEF_W, b: p.brk || CC_DEF_B }
    : { w: fc.defWork, b: fc.defBrk };
  const snap = p.on ? ccSnapWin(p.from, p.to) : { f: 0, t: 60 };
  const t = { d0: d, d1: d, h0: h, h1: h };

  const sub = `作用于 <b id="ccTgt">${esc(ccRectText(d, d, h, h, snap.f, snap.t))}</b>（<b id="ccCnt">1</b> 段）`;
  const body = `
    <div class="note" style="line-height:1.8">
      这一格现在是<b>${p.on ? '选中的' : '空白的'}</b>（${WD[d]} ${pad(h)}:00 – ${pad(h + 1)}:00）。
      应用会把它选上；想改别的范围请在图上拖一段，再右键那一段。
    </div>
    <div class="cc-menu-scope" style="margin:10px 0 4px">
      <button class="chip-btn" data-cell-quick="${ccStep()}" title="只把这一格的最小粒度选上，分钟数不用自己填">
        只选 ${ccStep()} 分钟
      </button>
      <button class="chip-btn" data-cell-quick="60">整小时</button>
    </div>
    <div class="cc-menu-hint">单选最小粒度就点上面第一个按钮：一次点击 = 这一格只选 ${ccStep()} 分钟。也可以在图上按住拖动 ${ccStep()} 分钟的范围，效果一样。</div>
    <div class="cc-tl-list" id="ccTlList">
      <div class="cc-tl-hd">
        <span class="cc-tl-c-idx">#</span>
        <span class="cc-tl-c-day">星期</span>
        <span class="cc-tl-c-time">起止时间</span>
        <span class="cc-tl-c-type">类型</span>
        <span class="cc-tl-c-note">备注</span>
        <span class="cc-tl-c-act">状态</span>
      </div>
      <div id="ccTlRows"></div>
    </div>
    ${ccWbHtml(pre.w, pre.b)}
    <div class="cc-menu-row win">
      <label>起止分钟 从 <input type="number" id="ccFrom" min="0" max="59" step="1" value="${snap.f}"> 到</label>
      <label><input type="number" id="ccTo" min="1" max="60" step="1" value="${snap.t}"> 分</label>
    </div>
    <div class="cc-menu-hint">起止分钟只对<b>这一格</b>生效：0 和 60 就是整小时（例如 8:15–8:45）。</div>
    <label class="cc-menu-def"><input type="checkbox" id="ccDefToo" checked> 同时设为通用时长（之后新选的时段沿用）</label>
    <div class="cc-hint-sep">想改一整段？右键那一段。想改一整天？右键顶部日期表头。</div>`;
  const foot = `
    <span style="flex:1"></span>
    <button class="btn" data-act="cc-close">取消</button>
    <button class="btn btn-primary" id="ccApply">应用</button>`;

  $('#modalRoot').innerHTML = ccMenuShell('格子设置', sub, body, foot);
  ccMenu = $('#modalRoot');
  $('#ccW') && $('#ccW').focus();

  const renderTlRows = () => {
    const box = $('#ccTlRows');
    if (!box) return;
    const segs = ccBuildSegments(t);
    if (!segs.length) { box.innerHTML = '<div class="cc-tl-empty">这个范围里没有可设置的刻度</div>'; return; }
    box.innerHTML = segs.map((s, i) => `
      <div class="cc-tl-row ${s.on ? 'on' : 'off'} type-${s.type}">
        <span class="cc-tl-idx">${i + 1}</span>
        <span class="cc-tl-day">${WD[s.d]}</span>
        <span class="cc-tl-time">${ccSegTimeText(s)}</span>
        <span class="cc-tl-type">${ccSegTypeText(s)}</span>
        <span class="cc-tl-note">${s.note}${s.on && s.type === 'focus' ? ` · 累计专注 ${s.cumFocus} 分` : ''}</span>
        <span class="cc-tl-act">
          <button class="cc-tl-btn ${s.on ? 'on' : ''}" data-tl="${s.d},${s.h},${s.q}"
            title="${s.on ? '点一下取消这 15 分钟' : '点一下选中这 15 分钟'}">${s.on ? '已选中' : '未选中'}</button>
        </span>
      </div>`).join('');
  };
  renderTlRows();
  window.__ccRenderTlRows = renderTlRows;

  ccBindMenu(async (e) => {
    const tl = e.target.closest('[data-tl]');
    if (tl) {
      const [dd, hh, qq] = tl.dataset.tl.split(',').map(Number);
      await Act.clockToggleQ(dd, hh, qq);
      renderTlRows();
      return;
    }
    // 快捷：一次点击就把这一格设成"只有一个最小粒度"或"整小时"。
    // 这是 15 / 10 分钟单选的**直达入口**——不用自己算起止分钟，
    // 也不用在 20px 高的一格里精确拖动。
    const quick = e.target.closest('[data-cell-quick]');
    if (quick) {
      const { w, b } = ccReadWb();
      const to = Math.max(1, Math.min(60, +quick.dataset.cellQuick || 60));
      const ok = await Act.clockSetWB(d, d, h, h, w, b, !!($('#ccDefToo') || {}).checked, 0, to);
      if (ok !== false) ccCloseMenu();
      return;
    }
    if (!e.target.closest('#ccApply')) return;
    const { w, b } = ccReadWb();
    let f2 = Math.round(Number(($('#ccFrom') || {}).value) || 0);
    let t2 = Math.round(Number(($('#ccTo') || {}).value) || 0);
    const sn = ccSnapWin(f2, t2);
    f2 = sn.f; t2 = sn.t;
    if (f2 >= t2) { toast('起始分钟要小于结束分钟', 'err'); return; }
    const ok = await Act.clockSetWB(d, d, h, h, w, b, !!($('#ccDefToo') || {}).checked, f2, t2);
    if (ok === false) { toast('起始分钟要小于结束分钟', 'err'); return; }
    ccCloseMenu();
  });
}

/** ① 右键点**日期表头** → 整天（0:00–24:00，只这一天） */
function ccOpenDayMenu(d) {
  ccCloseMenu();
  const prof = clockProfile();
  const day = prof.days[d];
  const segs = ccSegs(day);
  const mins = ccDayMinutes(day);
  const w = prof.defWork, b = prof.defBrk;

  // 进来先把"这一天到底排了什么"列清楚——这是用户右键表头最想看到的东西。
  // 以前只给"选中整天 / 清空整天"，等于让人摸黑操作：不知道自己会覆盖掉什么。
  const segRows = segs.length
    ? segs.map((sg, i) => {
      const a = sg.h0 * 60 + sg.f0;
      const b = sg.h1 * 60 + (sg.t1 >= 60 ? 60 : sg.t1);
      const dur = ccDurText(b - a);
      const wp = prof.days[d][sg.h0];
      const wk = wp.work || prof.defWork;
      const bk = wp.brk || 0;
      return `<div class="dseg">
        <span class="dseg-idx">${i + 1}</span>
        <span class="dseg-time">${pad(sg.h0)}:${pad(sg.f0)} – ${(sg.t1 >= 60 ? pad(sg.h1 + 1) : pad(sg.h1))}:${pad(sg.t1 >= 60 ? 0 : sg.t1)}</span>
        <span class="dseg-dur">${dur}</span>
        <span class="dseg-rhythm">专注 ${wk} 分${bk ? ` / 休息 ${bk} 分` : '（不休息）'}</span>
        <button class="btn btn-sm danger-ghost" data-day-del="${i}">取消这段</button>
      </div>`;
    }).join('')
    : '<div class="dseg-empty">这一天还没有任何自律时段。可以点下面的「选中整天」，也可以在图上按住拖动来新建。</div>';

  const sub = `作用于 <b id="ccTgt">${WD[d]} 00:00 – 24:00</b>（整天 · ${segs.length} 段 · ${mins ? ccMinText(0, mins).dur : '空'}）`;
  const body = `
    <div class="cc-dseg-list" id="ccDaySegs">
      <div class="cc-dseg-hd"><span>${WD[d]} 已排时段</span><span>${segs.length} 段 · 共 ${mins ? ccMinText(0, mins).dur : '0 分钟'}</span></div>
      ${segRows}
    </div>
    <div class="note" style="line-height:1.8;margin-top:10px">
      下面是<b>整天</b>级别的操作：只作用于 ${WD[d]} 0:00–24:00，其余六天原样不动。
      想改某一段的起止分钟，请直接在图上右键那一段。
    </div>
    <div class="cc-menu-scope" style="margin-top:10px">
      <button class="chip-btn" data-day-act="select">选中整天</button>
      <button class="chip-btn" data-day-act="clear">清空整天</button>
    </div>
    ${ccWbHtml(w, b)}
    <div class="cc-menu-hint">「应用到整天」只改<b>专注 / 休息</b>，不会动已有时段的起止分钟（例如 02:10–03:10 仍然是 02:10 开始）。要让整天变成整点，用「选中整天」重排。</div>
    <label class="cc-menu-def"><input type="checkbox" id="ccDefToo"> 同时设为通用时长（之后新选的时段沿用）</label>`;
  const foot = `
    <span style="flex:1"></span>
    <button class="btn" data-act="cc-close">取消</button>
    <button class="btn btn-primary" id="ccApply">应用到整天</button>`;

  $('#modalRoot').innerHTML = ccMenuShell('整天设置', sub, body, foot);
  ccMenu = $('#modalRoot');
  $('#ccW') && $('#ccW').focus();

  ccBindMenu(async (e) => {
    // 列表里逐段取消：两步确认，避免手滑把整段删了
    const del = e.target.closest('[data-day-del]');
    if (del) {
      if (del.dataset.armed !== '1') {
        del.dataset.armed = '1';
        del.textContent = '再点一次确认';
        return;
      }
      // 属性叫 data-day-del → dataset 里是 dayDel（不是 del！写错会静默取到 NaN）
      const sg = segs[+del.dataset.dayDel];
      if (!sg) return;
      const label = `${pad(sg.h0)}:${pad(sg.f0)} – ${(sg.t1 >= 60 ? pad(sg.h1 + 1) : pad(sg.h1))}:${pad(sg.t1 >= 60 ? 0 : sg.t1)}`;
      const ok = await Act.clockClearRange(d, sg.h0, sg.h1, `${WD[d]} ${label}`);
      if (ok !== false) ccCloseMenu();
      return;
    }
    const da = e.target.closest('[data-day-act]');
    if (da) {
      if (da.dataset.dayAct === 'select') await Act.clockDaySelect(d);
      else await Act.clockDayClear(d);
      ccCloseMenu();
      return;
    }
    if (!e.target.closest('#ccApply')) return;
    const { w: w2, b: b2 } = ccReadWb();
    const ok = await Act.clockDayWB(d, w2, b2, !!($('#ccDefToo') || {}).checked);
    if (ok !== false) ccCloseMenu();
  });
}

/* 全局屏蔽 WebView 自带的右键菜单。
 *
 * 那是浏览器内核的页面菜单（返回 / 刷新 / 另存为 / 打印 / 更多工具），
 * 在一个桌面应用里既没用又难看，还会盖住我们自己画的右键菜单。
 * 用 capture 阶段先拦一刀：只在"原生菜单要不要弹"这一层生效，
 * 下面监听 contextmenu 的业务逻辑（时段格子）照常收到事件。
 */
document.addEventListener('contextmenu', (e) => {
  // 输入控件保留原生菜单：粘贴 GitHub 令牌、粘贴浏览器路径、复制域名是文档里
  // 明确让用户做的动作，一刀切掉等于让这些步骤没法用。
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) {
    return;
  }
  e.preventDefault();
}, { capture: true });

document.addEventListener('contextmenu', (e) => {
  // 语录区的右键归来源菜单管（上面那个监听已处理）。
  // 这里必须显式让路：末尾的 ccCloseMenu() 会把刚弹出来的来源面板关掉——
  // 两个 document 级监听、同一个事件，靠"谁先注册"来分工太脆。
  if (e.target && e.target.closest && e.target.closest('[data-quote-box]')) return;
  // 拖动中按右键 = 取消这次拖动，且不弹菜单（否则会一边拖一边弹窗）
  if (S.ccDrag) { e.preventDefault(); ccCancelDrag(); return; }
  if (!S.data) { ccCloseMenu(); return; }

  // ① 日期表头 → 整天设置（只这一天）
  const dh = e.target.closest('.cc-dh');
  if (dh) {
    e.preventDefault();
    const idx = [...document.querySelectorAll('.cc-dh')].indexOf(dh);
    if (idx >= 0) ccOpenDayMenu(idx);
    return;
  }

  // ② / ③ 格子：落在已有时段里 → 只改这一段；空白 → 这一格 / 当前框选
  const cell = e.target.closest('.cc-cell');
  if (!cell) { ccCloseMenu(); return; }
  e.preventDefault();
  const d = +cell.dataset.d;
  const h = +cell.dataset.h;
  // 真实右键：按指针落在哪一个最小粒度判断（02:00–02:10 那截空白就是空白）。
  // 没有真实坐标（脚本 / 自动化合成的 contextmenu）：退回"这一小时里有段就算段"，
  // 否则坐标一偏就会把"段"认成"空白格"，菜单跟着错。
  const box = cell.getBoundingClientRect();
  const real = e.clientY >= box.top - 2 && e.clientY <= box.bottom + 2
    && e.clientX >= box.left - 2 && e.clientX <= box.right + 2;
  const seg = real
    ? ccSegAt(d, ccGrainAt(d, e.clientY).idx * ccStep())
    : ccSegAtHour(d, h);
  if (seg) ccOpenSegMenu(d, seg, h);
  else ccOpenCellMenu(d, h);
});

// 点模态外面 = 关菜单（模态自带 data-act="close-modal-bg"，这里兜底）
document.addEventListener('mousedown', (e) => {
  if (ccMenu && !e.target.closest('.cc-modal') && !e.target.closest('.cc-menu')) ccCloseMenu();
});

/* 输入框回车 */
document.addEventListener('keydown', (e) => {
  // Alt+F4 强制退出（前端兜底）
  //
  // 后端已经用低级键盘钩子 + CloseRequested 双重判定实现了 Alt+F4 强制退出，
  // 但 WebView2 在某些情况下会把 Alt+F4 当成浏览器快捷键派发到页面。
  // 这里再兜一层：识别到 Alt+F4 就 preventDefault（别让 WebView 自己也处理）
  // 并直接调后端的 force_quit —— 保证在设置页 / 自律时段弹窗里按下也一定退得掉。
  if (e.altKey && (e.key === 'F4' || e.code === 'F4')) {
    e.preventDefault();
    invoke('force_quit').catch(() => {});
    return;
  }
  if (e.key === 'Escape') {
    // 上面 capture 的处理器已经关过一层（它能穿过 stopPropagation）。
    // 这里只兜"没有层栈"的情况，否则一次 Esc 会连关两层。
    if (e.__kofEscHandled) return;
    if (typeof ccCloseMenu === 'function') ccCloseMenu();
    if ($('#modalRoot').innerHTML) { S.editing = null; closeModal(); }
  }
  if (e.key === 'Enter') {
    // 输入法组合中（拼音还没选字）按 Enter 是"选词"，不是"提交"。
    // 以前这里没有这道判断，中文输入法下回车会直接把半成品存下去。
    if (e.isComposing || e.keyCode === 229) return;
    // 长按回车只算一次：不然一按住就重复建了好几条规则
    if (e.repeat) return;
    if (e.target.id === 'siteInput') { e.preventDefault(); Act.addSite(); }
    if (e.target.id === 'excInput') { e.preventDefault(); Act.addExc(); }
    if (e.target.id === 'ruleName') { e.preventDefault(); Act.saveEditor(); }
    if (e.target.id === 'ccNameInput') {
      e.preventDefault();
      const btn = document.querySelector('[data-act="cc-name-ok"]');
      if (btn) btn.click();
    }
  }
});

/* 遮罩滑块：实时预览 */
document.addEventListener('input', async (e) => {
  if (e.target.id === 'opRange') await Act.setOpacity(e.target.value);
  // HUD 透明度：拖动时只更新读数，松手（change）才写盘，避免每 1px 存一次配置
  if (e.target.id === 'hudOpacity') {
    const lab = $('#hudOpacityVal');
    if (lab) lab.textContent = `${e.target.value}%`;
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'hudOpacity') Act.hudOpacity(e.target.value);
});

/* 完整图表的「显示范围」下拉：改完立刻重画（纯显示参数，不需要二次确认） */
/* 首用向导的起止小时：select 只走 change，不走 click ——
 * 点击那一刻重渲染会把下拉立刻收起来。 */
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act="wiz-time"]');
  if (!el || !S.wizard) return;
  const st = wizState();
  const v = Number(el.value) || 0;
  // 起止撞在一起时把另一端推开一格：留着"开始 ≥ 结束"等于什么都没排
  if (el.dataset.k === 'from') st.from = Math.max(6, Math.min(v, st.to - 1));
  else st.to = Math.max(st.from + 1, Math.min(v, 24));
  wizRender();
});

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-act="clock-view"]');
  if (!el) return;
  await Act.clockView(el.dataset.k, el.value);
});

/* 时段明细起止时间修改 */
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act="tk-slot-start"],[data-act="tk-slot-end"]');
  if (!el || !S.editing) return;
  const day = +el.dataset.day, i = +el.dataset.i;
  const slots = S.editing.schedule[day] || [];
  if (!slots[i]) return;
  const v = tkTimeParse(el.value);
  if (v == null) { toast('时间格式应为 HH:MM', 'err'); renderEditor(); return; }
  if (el.dataset.act === 'tk-slot-start') slots[i].start = v;
  else slots[i].end = v;
  S.editing.schedule[day] = normalize(slots);
  renderEditor();
});

/* 启动 */
document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

(async function boot() {
  await pull();
  await loadReports();
  await loadBackups();
  // 轮询必须在任何 return 之前挂上。
  //
  // 以前这里 `if (!S.data) { ...; return; }` 直接返回，于是后端只要在启动那一瞬
  // 不可用（配置目录被占用、杀软在扫、rt 锁中毒），整个窗口就永久停在
  // "无法连接后台服务"：不轮询、不重试、主题语言都没初始化，点导航永远转圈。
  setInterval(pull, 1500);
  window.addEventListener('focus', () => { pull(); });
  if (!S.data) {
    markOffline(true);
    $('#content').innerHTML =
      '<div class="empty">后台服务暂时不可用，正在自动重试…<br>'
      + '<button class="btn btn-sm" style="margin-top:12px" data-act="reload-app">重试一次</button></div>';
    return;
  }
  S.customStart = todayStr();
  S.customEnd = todayStr();
  I.setLang(langPref());
  applyMotionPref();
  render();
  applyLang();
  // 从托盘恢复窗口时立刻刷一次：窗口隐藏期间 WebView 的定时器会被系统降频，
  // 遮罩/自律状态可能早就变了，等下一拍轮询会在这一瞬间显示旧值。
  // 新装第一次启动：先把向导弹出来，而不是让人自己找
  // （老配置里没有 onboarded 这个键 → undefined，不算 false，所以老用户不会被弹）
  if ((((S.data.config || {}).settings || {}).onboarded) === false) wizOpen();
  // 启动时自动识别浏览器与插件状态，缺失就弹一次安装引导。
  // 必须排在向导**之后**且 await：browsers_scan 会让出执行权，它写的弹窗
  // 会把刚打开的向导盖掉（新人第一次看到的是"插件没装"而不是三步引导）。
  else await promptBrowserSetup();

  // 下载进度
  if (T && T.event) {
    T.event.listen('update-progress', (ev) => {
      const p = ev.payload || {};
      const pct = p.total ? (p.done / p.total) * 100 : 0;
      const mb = (n) => (n / 1024 / 1024).toFixed(1);
      setProgress(
        pct,
        p.total
          ? `已下载 ${mb(p.done)} / ${mb(p.total)} MB`
          : `已下载 ${mb(p.done)} MB`
      );
    });

    // 拦截触发 → 自动跳回首页
    T.event.listen('goto-home', () => {
      if (S.editing) return;
      S.view = 'overview';
      render();
    });
  }

  // 启动时检查更新（延迟一下，先让界面出来）
  setTimeout(async () => {
    if (!S.data || !S.data.config.settings.update.enabled) return;
    try {
      const r = await invoke('update_check');
      if (r.ok && r.hasUpdate) showUpdateModal(r, false);
    } catch (e) { /* 网络失败静默，不打扰用户 */ }
  }, 2600);
})();

/* 兜底：没被 catch 的 invoke 失败要说话，不能静默。
 *
 * 以前一批"点了就发出去"的动作（打开报告、删除备份、切换更新开关、
 * 跳过版本、打开配置目录……）没有 try/catch：后端一拒绝，用户看到的是
 * "点了没反应"，既没有提示也没有状态变化，只能反复点。
 * 这里统一收口，把原因弹出来；已经自己 catch 过的地方不会走到这里。
 */
window.addEventListener('unhandledrejection', (e) => {
  const raw = e.reason && (e.reason.message || e.reason);
  const msg = String(raw || '').replace(/^Error:\s*/, '').trim();
  if (msg) toast(msg, 'err');
  // 别让控制台里堆一堆未处理拒绝
  if (e.preventDefault) e.preventDefault();
});


