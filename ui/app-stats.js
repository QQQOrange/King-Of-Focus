/* 视图：时长统计、时间日历、统计报告、云同步、关于、帮助
 *
 * 由 app.js 按连续切片拆出（见 docs/release-notes 里那一版说明）。
 * 加载顺序就是原来的自上而下顺序：**不要**调整 <script> 的先后，
 * 顶层 const / function 共享同一个全局词法环境，换顺序会改变求值时机。
 */
'use strict';

/* ---------------- 视图：时长统计 ---------------- */
function boundsOf(range) {
  const now = new Date();
  if (range === 'today') return [todayStr(), todayStr()];
  if (range === 'week') {
    const dow = (now.getDay() + 6) % 7;
    const mon = addDays(now, -dow);
    return [dateStr(mon), dateStr(addDays(mon, 6))];
  }
  if (range === 'month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return [dateStr(first), dateStr(last)];
  }
  if (range === 'year') {
    return [`${now.getFullYear()}-01-01`, `${now.getFullYear()}-12-31`];
  }
  return [S.customStart || todayStr(), S.customEnd || todayStr()];
}

function mergeSlices(a, b) {
  const map = new Map();
  for (const s of [...a, ...b]) {
    const cur = map.get(s.key) || {
      key: s.key, label: s.label, category: s.category, secs: 0,
      // 站点行带着"主标题"和"页面数"，合并两档数据时不能把它们丢掉，
      // 否则切到「汇总」标签后标题会变回域名、也不再提示"共 N 个页面"
      title: s.title || '', pages: s.pages || 0,
      // 浏览器也要带过去：漏了它，切到「汇总」标签括号就没了
      browser: s.browser || '',
    };
    cur.secs += s.secs;
    // 页面数取较大值：两个数据集统计的是同一批页面，取并集的上界即可
    cur.pages = Math.max(cur.pages, s.pages || 0);
    if (!cur.title && s.title) cur.title = s.title;
    if (!cur.browser && s.browser) cur.browser = s.browser;
    map.set(s.key, cur);
  }
  return [...map.values()].sort((x, y) => y.secs - x.secs);
}

function currentSlices() {
  const st = S.stats;
  if (!st) return { slices: [], total: 0, label: '' };
  if (S.statsTab === 'on') return { slices: st.on, total: st.onSecs, label: '自律模式已开启' };
  if (S.statsTab === 'off') return { slices: st.off, total: st.offSecs, label: '自律模式未开启' };
  const m = mergeSlices(st.on, st.off);
  return { slices: m, total: st.onSecs + st.offSecs, label: '两种状态汇总' };
}

/* ---------------- 时间日历（周 / 月） ---------------- */

/** 一周从周一开始（与时段表一致） */
function weekStartOf(dt) {
  const d = new Date(dt.getTime());
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseYmd(t) {
  const p = String(t || '').split('-').map(Number);
  if (p.length !== 3 || !p[0]) return new Date();
  return new Date(p[0], p[1] - 1, p[2]);
}

/** 三个视图共用同一个状态筛选：饼图、周/月网格、当日日历必须看同一批数据。
 *  以前只有饼图认 statsTab，日历那边是自己拼的字符串 —— 一旦哪天加了新 tab，
 *  两边就会各自算各自的，出现"上面 3 小时、下面 5 小时"。 */
function statsTabKey() {
  return S.statsTab === 'off' ? 'off' : (S.statsTab === 'on' ? 'on' : 'all');
}

/** 当前要加载的区间：周 = 7 天，月 = 覆盖整月的 7 的倍数天 */
function calRange() {
  const base = parseYmd(S.calAnchor || S.calSel || todayStr());
  let start;
  let end;
  if (S.calMode === 'month') {
    const first = new Date(base.getFullYear(), base.getMonth(), 1);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    start = weekStartOf(first);
    end = addDays(weekStartOf(last), 6);
  } else {
    start = weekStartOf(base);
    end = addDays(start, 6);
  }
  let lo = dateStr(start);
  let hi = dateStr(end);
  // 选中日不在窗口里时把区间扩到它：切换视图/翻页后明细仍然读得到数据
  const sel = S.calSel || lo;
  if (sel < lo) lo = sel;
  if (sel > hi) hi = sel;
  const tab = statsTabKey();
  return { start: lo, end: hi, tab, key: lo + '|' + hi + '|' + tab };
}

/** 当前视图自己的窗口（不含"为选中日扩出来"的那几天） */
function calWindow() {
  const base = parseYmd(S.calAnchor || S.calSel || todayStr());
  if (S.calMode === 'month') {
    const first = new Date(base.getFullYear(), base.getMonth(), 1);
    const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    return { start: dateStr(weekStartOf(first)), end: dateStr(addDays(weekStartOf(last), 6)) };
  }
  const w0 = weekStartOf(base);
  return { start: dateStr(w0), end: dateStr(addDays(w0, 6)) };
}

/** 只保留窗口内的天：区间可能为了"选中日"被扩过，网格不能被撑成 8 列 */
function calWindowDays(days) {
  const w = calWindow();
  return days.filter((d) => d.date >= w.start && d.date <= w.end);
}

function calRangeLabel() {
  const r = calWindow();
  if (S.calMode === 'month') {
    const b = parseYmd(S.calAnchor || S.calSel || todayStr());
    return I18N.getLang() === 'en'
      ? `${b.getFullYear()}-${pad(b.getMonth() + 1)}`
      : `${b.getFullYear()} 年 ${b.getMonth() + 1} 月`;
  }
  return `${r.start.slice(5)} ~ ${r.end.slice(5)}`;
}

/** 颜色按"整个窗口内的累计时长"分配：同一个软件在每天都是同一种颜色 */
function calColors(days) {
  const m = new Map();
  const used = new Set();

  // ① 先沿用**饼图的配色**：同一个软件在上面的扇图和下面的日历里必须是同一种颜色，
  //    否则读者每换一个图都要重新"对颜色"，看着就会觉得哪里不协调。
  let cur = null;
  try { cur = currentSlices(); } catch (e) { cur = null; }
  const top = (cur && cur.slices ? cur.slices : []).slice(0, 8);
  top.forEach((sl, i) => {
    if (!sl || !sl.key) return;
    const c = PALETTE[i % PALETTE.length];
    m.set(sl.key, c);
    used.add(c);
  });

  // ② 只在日历里出现的（别的时段/别的天才用到）按累计时长接着排，避开已被占用的颜色
  const tot = new Map();
  for (const d of days) {
    for (const it of d.items || []) {
      if (m.has(it.key)) continue;
      tot.set(it.key, (tot.get(it.key) || 0) + it.secs);
    }
  }
  const arr = [...tot.entries()].sort((a, b) => b[1] - a[1]);
  let k = 0;
  for (const [key] of arr) {
    while (k < PALETTE.length && used.has(PALETTE[k])) k++;
    const c = PALETTE[k % PALETTE.length];
    m.set(key, c);
    used.add(c);
    k++;
  }
  return m;
}

function calSegs(items, colors, cls) {
  let out = '';
  for (const it of items) {
    const c = colors.get(it.key) || 'var(--line-2)';
    const hit = it.key && it.key === S.calHit ? ' hit' : '';
    for (const sp of it.spans || []) {
      const h = Math.max(0.7, ((sp.t - sp.f) / 1440) * 100);
      out += `<i class="${cls}${hit}" data-key="${esc(it.key)}"`
        + ` style="top:${(sp.f / 1440) * 100}%;height:${h}%;background:${c}"`
        + ` title="${esc(it.label)} ${hhmmOfMin(sp.f)}–${hhmmOfMin(sp.t)}"></i>`;
    }
  }
  return out;
}

/** 周视图：7 列，每列一条 24 小时时间轴 */
function calWeekHtml(days, colors) {
  const cells = calWindowDays(days).map((d) => {
    const dt = parseYmd(d.date);
    const wd = DAYS[(dt.getDay() + 6) % 7];
    const on = d.date === S.calSel;
    const today = d.date === todayStr();
    return `<button class="cw-col${on ? ' on' : ''}${today ? ' today' : ''}"
      data-act="cal-pick" data-date="${d.date}" title="${d.date}">
      <span class="cw-hd"><b>${wd}</b><em>${dt.getDate()}</em></span>
      <span class="cw-track">${calSegs(d.items || [], colors, 'cb')}</span>
      <span class="cw-tot">${d.secs ? fmtDurShort(d.secs) : ''}</span>
    </button>`;
  }).join('');
  // 左侧刻度和 7 列放在同一个 grid 里，刻度才能和格子对齐
  const axis = [0, 6, 12, 18, 24]
    .map((h) => `<span style="top:${(h / 24) * 100}%">${pad(h)}</span>`).join('');
  // 刻度必须和"轨道"等高：外层用 padding 让开表头/合计，内层才是真正的坐标系
  // （绝对定位子元素以 padding box 为基准，直接给外层加 padding 是不生效的）
  return `<div class="cal-week"><div class="cw-axis"><div class="cw-axis-in">${axis}</div></div>${cells}</div>`;
}

/** 月视图：7 × N 网格，每格一条横的 24 小时条 */
function calMonthHtml(days, colors) {
  const base = parseYmd(S.calAnchor || S.calSel || todayStr());
  const mon = base.getMonth();
  const cells = calWindowDays(days).map((d) => {
    const dt = parseYmd(d.date);
    const out = dt.getMonth() !== mon;
    const on = d.date === S.calSel;
    const today = d.date === todayStr();
    let segs = '';
    for (const it of d.items || []) {
      const c = colors.get(it.key) || 'var(--line-2)';
      const hit = it.key && it.key === S.calHit ? ' hit' : '';
      for (const sp of it.spans || []) {
        segs += `<i class="${hit ? 'hit' : ''}" data-key="${esc(it.key)}"`
          + ` style="left:${(sp.f / 1440) * 100}%;width:${Math.max(0.4, ((sp.t - sp.f) / 1440) * 100)}%;background:${c}"`
          + ` title="${esc(it.label)} ${hhmmOfMin(sp.f)}–${hhmmOfMin(sp.t)}"></i>`;
      }
    }
    const hasHit = S.calHit && (d.items || []).some((it) => it.key === S.calHit);
    return `<button class="cm-cell${out ? ' out' : ''}${on ? ' on' : ''}${today ? ' today' : ''}${hasHit ? ' has-hit' : ''}"
      data-act="cal-pick" data-date="${d.date}" title="${d.date}">
      <span class="cm-top"><b>${dt.getDate()}</b><em>${d.secs ? fmtDurShort(d.secs) : ''}</em></span>
      <span class="cm-bar">${segs}</span>
    </button>`;
  }).join('');
  return `<div class="cm-wd">${DAYS.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="cal-month">${cells}</div>`;
}

/* ---------------- 当日日历（饼图右侧的单日时间轴） ----------------
 *
 *  一天的 24 小时等比铺在一条竖轨上：色块的位置 = 什么时候开始，高度 = 用了多久。
 *  这块以前是"日历下面的一张明细表"，现在挪到饼图右侧、并且换成时间轴：
 *  同一份数据，看位置比看列表快得多 —— 是清晨还是深夜、一段是长是短，一眼就出来。
 *
 *  为什么不做成"每个块都写字"：24 小时塞进 480px，1 分钟只有 0.33px，
 *  短块根本放不下字。于是够高（>= 18px，约 55 分钟）才写名字、>= 36px 再写时刻，
 *  不够高的靠悬停把读数打到标题行 —— 轨道上永远不跳字。
 */

const DC_H = 480;   // 轨道高度（px），与 CSS 的 --dc-h 一致：1 小时 = 20px
const DC_MIN = 3;   // 一分钟的块也要看得见

function dayOf() {
  return S.dayDate || S.calSel || S.calAnchor || todayStr();
}

function dayCacheKey(date) {
  return statsTabKey() + '|' + date;
}

/** 当天数据：单日缓存优先，其次复用周/月网格里同一天 —— 同一份数据不发第二次请求 */
function dayData(date) {
  const d = date || dayOf();
  const ck = dayCacheKey(d);
  if (S.dayCache && S.dayCache.has(ck)) return S.dayCache.get(ck);
  if (S.cal && S.calKey === calRange().key) {
    const hit = S.cal.find((x) => x.date === d);
    if (hit) return hit;
  }
  return null;
}

let dayTok = 0;

async function dayFetch(date, force) {
  const ck = dayCacheKey(date);
  if (force) S.dayCache.delete(ck);
  else if (S.dayCache.has(ck)) { paintDay(); return; }
  const tok = ++dayTok;
  let got;
  try {
    const r = await invoke('stats_calendar', { start: date, end: date, tab: statsTabKey() });
    got = (r && r[0]) || { date, secs: 0, items: [] };
  } catch (e) {
    // 取失败**不能**当成"这一天零使用"：以前把它塞进缓存，界面就变成
    // "这一天没有使用记录"，而缓存又让后面永远不再重试 —— 用户看到的是假数据。
    S.dayCache.delete(ck);
    if (S.dayFailed) S.dayFailed.add(ck);
    if (tok === dayTok) paintDay();
    return;
  }
  if (S.dayFailed) S.dayFailed.delete(ck);
  S.dayCache.set(ck, got);
  // 期间又切到别的天了：这次结果只进缓存，不抢当前画面
  if (tok === dayTok) paintDay();
}

/** 保证当天有数据可画：已有就直接画，否则单独取那一天 */
function dayEnsure(force) {
  const d = dayOf();
  if (force) S.dayCache.delete(dayCacheKey(d));
  if (dayData(d)) { paintDay(); return; }
  // 周/月网格正在取、而且窗口里就有这天：等它回来，别为同一份数据发两个请求
  if (S.calPending && !force) return;
  dayFetch(d, force);
}

/** 这一项最该看的是哪一天：用时最长的那天（并列时取较近的一天） */
function bestDayOf(it) {
  const m = new Map();
  for (const sp of (it && it.spans) || []) {
    if (!sp || !sp.date) continue;
    m.set(sp.date, (m.get(sp.date) || 0) + Math.max(0, (sp.t || 0) - (sp.f || 0)));
  }
  if (!m.size) return '';
  const arr = [...m.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? 1 : -1));
  return arr[0][0];
}

/** 聚焦某个分类（'' = 取消）：饼图描边、当日日历、周/月网格三处一起变 */
function statsFocus(key, date) {
  const moved = !!date && date !== dayOf();
  S.calHit = key || '';
  if (date) {
    // 三处日期一起走：当日日历、网格选中日、网格窗口锚点
    S.dayDate = date;
    S.calSel = date;
    S.calAnchor = date;
  }
  if (S.calKey !== calRange().key) {
    calLoad();          // 窗口变了：网格要重取（它回来时会顺带重画当日日历）
  } else {
    paintCalFocus();    // 只切描边，不重建网格
    if (moved) dayEnsure();   // 真的换了天才整块重画当日日历
    else paintFocus();
  }
  paintPieFocus();
  // 只是把面板收起来（没换分类也没换天）就别闪了 —— 那一侧其实什么都没变
  if (!S.calHit && !moved) return;
  flashDay();
}

/** 只重画扇图的"聚焦"描边：不重新布局，扇区位置一动不动 */
function paintPieFocus() {
  const cv = $('#pie');
  if (!cv || !cv.__pie) return;
  const items = cv.__pie.items || [];
  cv.__pie.focus = S.calHit ? items.findIndex((it) => it.key === S.calHit) : -1;
  drawPieFrame(cv);
}

/** 一天里所有有记录的段：按开始时间排好，越界的先夹进 00:00–24:00 */
function dcBlocks(d, colors) {
  const out = [];
  for (const it of (d && d.items) || []) {
    const c = colors.get(it.key) || 'var(--line-2)';
    for (const sp of it.spans || []) {
      // 跨天/脏数据（t > 1440、t < f）一律夹住：宁可少画一段，也不把块画到轨道外面
      const f = Math.max(0, Math.min(1440, Number(sp.f) || 0));
      const t = Math.max(f, Math.min(1440, Number(sp.t) || 0));
      if (t - f < 1) continue;
      out.push({ key: it.key, label: it.label || '', c, f, t });
    }
  }
  out.sort((a, b) => (a.f - b.f) || (a.t - b.t));
  return out;
}

/** 空档：铺一层很淡的斜纹，让人分得清"没记录"和"这一段是别的软件" */
function dcGap(f, t) {
  const px = ((t - f) / 1440) * DC_H;
  return `<i class="dc-gap" style="top:${(f / 1440) * 100}%;height:${((t - f) / 1440) * 100}%">${
    px >= 40 ? '<span>空闲</span>' : ''}</i>`;
}

/** 聚焦项的名字：今天的数据里有就用它，否则退回总览里的名字，再不行用 key 的尾巴 */
function focusName(key, d) {
  const it = d ? (d.items || []).find((x) => x.key === key) : null;
  if (it) return it.label;
  let found = null;
  if (S.stats) {
    const tab = statsTabKey();
    const pool = tab === 'on' ? S.stats.on : (tab === 'off' ? S.stats.off : mergeSlices(S.stats.on, S.stats.off));
    found = pool.find((x) => x.key === key) || null;
  }
  if (found) return found.label;
  return String(key || '').split('|').slice(1).join('|') || String(key || '');
}

/** 时长文案：英文界面用 1h30m，中文用 1 小时 30 分（不发明"共…项"这种复合句去查词典） */
function dcDur(secs) {
  return I18N.getLang() === 'en' ? fmtDurShort(secs) : fmtDur(secs);
}

/** 当天的配色。
 *
 *  窗口里**确实包含这一天**时，按整个窗口算（同一软件每天同色）；
 *  否则只按这一天算 —— 拿一个不含当天的窗口去建色表，当天的应用一个都查不到，
 *  会全部回落到 `--line-2`，看起来就是"所有颜色突然变成同一种颜色"。
 */
function dayColors(d) {
  const days = (S.cal || []).slice();
  // 无条件把这一天并进来：色表必须覆盖这一次真正要画的**全部**条目。
  // 少一个，那个应用就会回落成 var(--line-2)（灰）—— 一片灰看着就是"颜色全变成一个样"。
  if (d) days.push(d);
  if (!days.length) return calColors([]);
  return calColors(days);
}

/** 聚焦提示条：明确写着"现在看的是哪一项"，也给出撤掉的出口 */
function dayChipHtml(d, colors, hasHit) {
  if (!S.calHit) return '';
  const en = I18N.getLang() === 'en';
  return `<div class="dc-chip${hasHit ? '' : ' off'}">
      <i style="background:${colors.get(S.calHit) || 'var(--text-3)'}"></i>
      <span>${esc(focusName(S.calHit, d))}${hasHit ? '' : (en ? ' · none today' : ' · 这天没有')}</span>
      <button class="dc-x" data-act="focus-clear" title="${en ? 'Clear focus' : '取消聚焦'}">×</button>
    </div>`;
}

/** 当日日历的整块内容（标题行 + 时间轴 + 图例） */
function dayHtml() {
  const en = I18N.getLang() === 'en';
  const date = dayOf();
  const dt = parseYmd(date);
  const wd = DAYS[(dt.getDay() + 6) % 7];
  const d = dayData(date);
  const colors = dayColors(d);
  const blocks = d ? dcBlocks(d, colors) : [];
  const total = (d && d.secs) || 0;
  const nItems = d && d.items ? d.items.length : 0;
  // 聚焦的那一项在今天到底有没有：没有就别把别的块压暗（否则满屏发灰，像坏了）
  const hasHit = !!(S.calHit && blocks.some((b) => b.key === S.calHit));
  const today = date === todayStr();

  // 读数行："共 2 小时 30 分 · 6 项"。复合句在 JS 里拼，不指望词典认得出来
  const sumTxt = en ? `${fmtDurShort(total)} · ${nItems} items` : `共 ${fmtDur(total)} · ${nItems} 项`;
  const head = `<div class="dc-hd">
    <b class="dc-title">当日日历 ${qtip('hour')}</b>
    <button class="btn btn-sm dc-ar" data-act="day-move" data-d="-1" title="${en ? 'Previous day' : '前一天'}">‹</button>
    <button class="btn btn-sm dc-ar" data-act="day-move" data-d="1" title="${en ? 'Next day' : '后一天'}">›</button>
  </div>
  <div class="dc-sub">
    <b class="dc-date${today ? ' today' : ''}">${date.slice(5)} <span>${wd}</span></b>
    <span class="dc-sum" id="dcSum" data-def="${sumTxt}">${sumTxt}</span>
    ${today ? '' : '<button class="dc-today" data-act="day-today">今天</button>'}
  </div>`;

  // 聚焦条固定占一行（.dc-slot）：有/没有聚焦都不动时间轴的位置，
  // 否则选中的那一刻轨道会被顶下去 24px，看起来就像"闪了一下"。
  const chip = `<div class="dc-slot">${dayChipHtml(d, colors, hasHit)}</div>`;

  if (!d) {
    // 读取失败不能一直显示"正在载入…"：那是个永远不会结束的状态，
    // 用户只会以为界面坏了。给一句实话 + 一个能点的重试。
    if (S.dayFailed && S.dayFailed.has(dayCacheKey(date))) {
      return `${head}${chip}<div class="empty dc-empty">`
        + '<span class="ico">⚠</span>这一天读取失败，'
        + '<button class="btn btn-sm" data-act="day-retry">重试</button></div>';
    }
    return `${head}${chip}<div class="dc-loading">正在载入…</div>`;
  }
  if (!blocks.length) {
    return `${head}${chip}<div class="empty dc-empty"><span class="ico">▤</span>这一天没有使用记录。</div>`;
  }

  let gaps = '';
  let cur = 0;
  for (const b of blocks) {
    if (b.f - cur >= 30) gaps += dcGap(cur, b.f);
    cur = Math.max(cur, b.t);
  }
  if (1440 - cur >= 30) gaps += dcGap(cur, 1440);

  const evs = blocks.map((b) => {
    const px = ((b.t - b.f) / 1440) * DC_H;
    const hPct = ((b.t - b.f) / 1440) * 100;
    const on = hasHit && b.key === S.calHit;
    const off = hasHit && !on;
    // 很薄的段（< 8px，约 25 分钟以内）用光晕而不是描边：描边会把它自己的颜色盖掉
    const thin = px < 8 ? ' thin' : '';
    const tm = hhmmOfMin(b.f) + '–' + hhmmOfMin(b.t);
    // 读数只留"时段 · 名称"：时长本来就由色块高度表达；时刻放最前面，
    // 窄列里被省略号截掉的是名字尾巴，而不是"几点到几点"。
    const tip = `${tm} · ${b.label}`;
    return `<button class="dc-ev${on ? ' hit' : ''}${off ? ' off' : ''}${thin}" data-act="day-ev"
      data-key="${esc(b.key)}" data-tip="${esc(tip)}"
      style="top:${(b.f / 1440) * 100}%;height:${Math.max(hPct, (DC_MIN / DC_H) * 100)}%;background:${b.c}">
      ${px >= 18 ? `<span class="dc-n">${esc(b.label)}</span>` : ''}
      ${px >= 36 ? `<span class="dc-t">${tm}</span>` : ''}
    </button>`;
  }).join('');

  const nowMin = dt.getHours() * 60 + dt.getMinutes();
  const nowLine = today ? `<i class="dc-now" style="top:${(nowMin / 1440) * 100}%"></i>` : '';
  const axis = [0, 6, 12, 18, 24]
    .map((h) => `<span style="top:${(h / 24) * 100}%">${pad(h)}:00</span>`).join('');

  // 图例就是"颜色 → 名字"的对照：色块太薄写不下字时靠它认
  const items = d.items || [];
  const legend = `<div class="dc-lg">${items.slice(0, 6).map((it) => `<button
      class="dc-lg-i${it.key === S.calHit ? ' on' : ''}" data-act="day-ev" data-key="${esc(it.key)}"
      title="${esc(it.label)} · ${dcDur(it.secs)}">
      <i style="background:${colors.get(it.key) || 'var(--line-2)'}"></i>${esc(it.label)}</button>`).join('')
    }${items.length > 6 ? `<span class="dc-lg-more">+${items.length - 6}</span>` : ''}</div>`;

  return `${head}${chip}
  <div class="dc-body">
    <div class="dc-axis"><div class="dc-axis-in">${axis}</div></div>
    <div class="dc-track">${gaps}${evs}${nowLine}</div>
  </div>${legend}`;
}

/** 只重画当日日历（不整页重建：卡片右侧这一块独立更新，点一下不会带着整页闪） */
function paintDay() {
  const body = $('#dayBody');
  if (!body) return;
  body.innerHTML = dayHtml();
  if (window.I18N && I18N.apply) I18N.apply(body);
  // 默认读数（"共 X · N 项"）翻译后再记下来：悬停结束后原样还原
  const sum = body.querySelector('#dcSum');
  if (sum) sum.dataset.def = sum.textContent;
}

/** 只改"聚焦"相关的 class，不重建 DOM。
 *
 *  以前点一下色块会把整块当日日历（连带下面整张周/月网格）innerHTML 重写一遍：
 *  节点全换新、过渡从零开始、布局重排一次 —— 眼睛看到的就是"闪一下"。
 *  现在只切 class：高亮/压暗走 .13s 过渡，节点不换、位置不动。
 */
function paintFocus() {
  const body = $('#dayBody');
  if (!body) return;
  const key = S.calHit || '';
  const evs = body.querySelectorAll('.dc-ev[data-key]');
  let hasHit = false;
  evs.forEach((e) => {
    if (key && e.dataset.key === key) hasHit = true;
  });
  evs.forEach((e) => {
    const on = hasHit && e.dataset.key === key;
    e.classList.toggle('hit', on);
    e.classList.toggle('off', hasHit && !on);
  });
  body.querySelectorAll('.dc-lg-i').forEach((e) => {
    e.classList.toggle('on', !!key && e.dataset.key === key);
  });
  const slot = body.querySelector('.dc-slot');
  if (slot) {
    const d = dayData(dayOf());
    const html = dayChipHtml(d, dayColors(d), hasHit);
    if (slot.innerHTML !== html) {
      slot.innerHTML = html;
      if (window.I18N && I18N.apply) I18N.apply(slot);
    }
  }
}

/** 只挪网格里"选中那一天"的高亮：‹ › 翻天不用重建整张网格 */
function paintCalSel() {
  const body = $('#calBody');
  if (!body) return;
  body.querySelectorAll('[data-date]').forEach((el) => {
    el.classList.toggle('on', el.dataset.date === S.calSel);
  });
  const lab = $('.cal-label');
  if (lab) lab.textContent = calRangeLabel();
}

/** 只同步周/月网格上的"聚焦"描边：同样不重建网格 */
function paintCalFocus() {
  const body = $('#calBody');
  if (!body) return;
  const key = S.calHit || '';
  body.querySelectorAll('[data-key]').forEach((el) => {
    el.classList.toggle('hit', !!key && el.dataset.key === key);
  });
  const cells = body.querySelectorAll('.cm-cell');
  if (!cells.length) return;
  cells.forEach((cell) => {
    cell.classList.toggle('has-hit', !!key && cell.querySelector('.cm-bar i.hit') != null);
  });
}

/** 当日日历卡片脉冲一下：点扇区时"右边这块就是它"要看得见 */
function flashDay() {
  const card = $('#dayCard');
  if (!card) return;
  card.classList.remove('cal-flash');
  void card.offsetWidth;      // 强制回流：连点两次也要重播一次高亮
  card.classList.add('cal-flash');
  clearTimeout(flashDay._t);
  flashDay._t = setTimeout(() => card.classList.remove('cal-flash'), 2000);
}

/** 滚到「使用时长分布」并让当日日历脉冲一下：从日历点一天后"数据在眼前" */
function scrollToDist() {
  const card = $('#distCard');
  if (!card) return;
  if (card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  flashDay();
}

/** 悬停读数：把具体时刻写到标题行 —— 不占轨道、也不会让块跳动 */
function dcRead(tip) {
  const el = $('#dcSum');
  if (!el) return;
  const v = tip || el.dataset.def || '';
  if (el.textContent !== v) el.textContent = v;
}

/** 时间范围变了，日历跟着落到同一个周期。
 *
 *  不这么做就会出现"上面是今日、下面是本周"的错位：
 *  两边统计窗口不同，数字自然对不上，看起来就是"哪里不对"。
 */
function calFollowRange() {
  const now = new Date();
  if (S.range === 'today') S.calAnchor = todayStr();
  else if (S.range === 'week') S.calAnchor = dateStr(weekStartOf(now));
  else if (S.range === 'month') S.calAnchor = dateStr(new Date(now.getFullYear(), now.getMonth(), 1));
  else if (S.range === 'year') S.calAnchor = dateStr(new Date(now.getFullYear(), 0, 1));
  else if (S.range === 'custom') S.calAnchor = S.customStart || todayStr();
  // 当日日历落到同一周期的"今天"：区间里没有今天就退到区间的最后一天
  // （否则切到「本月」还盯着上个月某一天，看起来就是两边对不上）
  const bd = boundsOf(S.range);
  const t = todayStr();
  S.dayDate = (t >= bd[0] && t <= bd[1]) ? t : bd[1];
  S.calSel = S.dayDate;
  S.calKey = '';   // 强制重取
}

function calHtml() {
  const days = S.cal;
  if (!days) return '<div class="cal-loading">正在载入…</div>';
  // 读取失败不能画成"这段时间还没有数据"——那是在告诉用户一件假事
  if (S.calFailed) return '<div class="empty"><span class="ico">⚠</span>统计读取失败，正在重试…</div>';
  if (!days.length) return '<div class="empty"><span class="ico">▤</span>这段时间还没有数据。</div>';
  const colors = calColors(days);
  // 只画网格：选中那天的细则已经搬到饼图右侧的「当日日历」里，
  // 这里再放一份就是同一份数据看两遍（而且会把卡片撑很高）。
  return S.calMode === 'month' ? calMonthHtml(days, colors) : calWeekHtml(days, colors);
}

/** 只重画日历卡片（不整页重建，滚动位置和焦点都不动） */
function paintCal() {
  const body = $('#calBody');
  if (body) {
    body.innerHTML = calHtml();
    // render() 里的翻译是在这一块**之前**跑的；日历数据是异步到的，
    // 这里换完 innerHTML 必须再翻一次，否则英文界面下会露出中文。
    if (window.I18N && I18N.apply) I18N.apply(body);
  }
  const lab = $('.cal-label');
  if (lab) lab.textContent = calRangeLabel();
  document.querySelectorAll('[data-act="cal-mode"]').forEach((b) => {
    const on = b.dataset.m === S.calMode;
    b.classList.toggle('active', on);
    b.classList.toggle('gold', on);
  });
}

async function calLoad() {
  const r = calRange();
  S.calKey = r.key;             // 先记指纹：失败也不会被每帧重试打爆
  S.cal = null;
  S.calPending = true;          // 当日日历据此等待，不为同一天再发一个请求
  paintCal();
  paintDay();
  let failed = false;
  try {
    S.cal = await invoke('stats_calendar', { start: r.start, end: r.end, tab: r.tab });
  } catch (e) {
    // 失败就把指纹清掉，让 calEnsure 下次重试；同时画"读取失败"而不是"没有数据"
    S.cal = [];
    S.calKey = '';
    failed = true;
  }
  S.calPending = false;
  S.calFailed = failed;
  paintCal();
  // 网格回来了，当天那份数据大概率就在里面：不用再单独请求
  paintDay();
  // 失败后自动重试一次（每 3 秒，最多持续到用户离开统计页）：
  // 界面上写的是"正在重试…"，那就得真的在重试，否则就是骗人。
  if (failed && !S.calRetry) {
    S.calRetry = setTimeout(() => {
      S.calRetry = 0;
      if (S.view === 'stats' && S.calFailed) calLoad();
    }, 3000);
  }
}

/** 进入统计页时保证有数据（区间没变就不重复请求） */
function calEnsure() {
  if (S.calKey === calRange().key && S.cal) return;
  calLoad();
}

/** 统计页顶部那条「另一台设备」。
 *
 *  为什么单独一条、不并进本机统计：手机的使用时长和电脑的使用时长是两回事，
 *  加在一起只会得到一个没意义的数字（还会让人以为"我今天用了 20 小时"）。
 *  数据来自云同步/备份带过来的统计摘要（见 portable::Doc.stats）。
 */
/** 「节奏」：连续达标 + 本周对比。
 *
 *  统计页已经有很多数字了，但都在回答"用了多久"，没有一条回答"我最近是变好
 *  还是变差"。这张卡只放三个判断：连续多少天、本周比上周怎么样、今天达标没有。
 *
 *  达标 = 当天自律时长达到计划，且写过的目标都做完（见 Rust `rhythm.rs`）。
 *  休息日不算断，所以"周末没排班"不会让连续天数归零。
 */
function rhythmCard() {
  const r = (S.data && S.data.rhythm) || null;
  if (!r) return '';
  const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
  const delta = pct(r.weekOnSecs || 0, r.lastWeekOnSecs || 0);
  const deltaTxt = delta === null
    ? '<span class="badge">上周还没有数据</span>'
    : delta === 0
      ? '<span class="badge">和上周持平</span>'
      : `<span class="badge ${delta > 0 ? 'green' : 'gold'}">比上周${delta > 0 ? '多' : '少'} ${Math.abs(delta)}%</span>`;
  const today = r.todayState === 'done'
    ? '<span class="badge green">今天已达标</span>'
    : r.todayState === 'rest'
      ? '<span class="badge">今天是休息日</span>'
      : `<span class="badge gold">还差 ${fmtDur(Math.max(0, (r.todayPlanSecs || 0) - (r.todayOnSecs || 0)))}</span>`;
  const goalTxt = (r.todayGoalsTotal || 0) > 0
    ? `目标 ${r.todayGoalsDone}/${r.todayGoalsTotal}`
    : '';
  return `<div class="card" id="rhythmCard">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap">
      <div>
        <div class="card-title" style="margin:0">节奏</div>
        <div class="hint" style="margin-top:4px">达标 = 当天自律时长达到计划，且写过的目标都做完；没有计划的休息日不算断。</div>
      </div>
      <div style="text-align:right;min-width:96px">
        <div style="font-size:30px;font-weight:700;line-height:1.1;color:${(r.streak || 0) > 0 ? 'var(--gold)' : 'var(--text-2)'}">${r.streak || 0}</div>
        <div class="hint">连续达标（天）</div>
      </div>
    </div>
    <div class="row" style="gap:22px;flex-wrap:wrap;margin-top:12px;align-items:center">
      <div><span class="hint">本周</span> <b>${fmtDur(r.weekOnSecs || 0)}</b> ${deltaTxt}</div>
      <div><span class="hint">今日</span> ${today} ${goalTxt ? `<span class="hint">· ${goalTxt}</span>` : ''}</div>
      ${bestBlock() ? `<div><span class="hint">最专注</span> <b>${bestBlock()}</b></div>` : ''}
    </div>
    <div class="hint" style="margin-top:8px">${insightLine(r, delta)}</div>
  </div>`;
}

/**
 * 当前区间里"最专注的两小时"（按 2 小时合并桶找最大值）。
 *
 * 为什么按 2 小时而不是 1 小时：单小时的峰值受一次会议/一次刷视频影响太大，
 * 两小时段才更像"你这段时间真的在状态里"。
 */
function bestBlock() {
  const h = S.stats && S.stats.onHourly;
  if (!Array.isArray(h) || h.length < 24) return '';
  let best = -1;
  let bestV = 0;
  for (let i = 0; i < 24; i += 2) {
    const v = (h[i] || 0) + (h[i + 1] || 0);
    if (v > bestV) { bestV = v; best = i; }
  }
  if (best < 0 || bestV < 600) return '';  // 少于 10 分钟不值得说
  return `${pad(best)}:00–${pad(best + 2)}:00`;
}

/** 一句人话结论：把数字翻译成"这意味着什么" */
function insightLine(r, delta) {
  const parts = [];
  const best = bestBlock();
  if (best) parts.push(`你最常在 ${best} 进入状态`);
  if (delta !== null && delta !== undefined && Math.abs(delta) >= 10) {
    parts.push(delta > 0 ? `本周比上周多出 ${delta}%` : `本周比上周少了 ${Math.abs(delta)}%`);
  }
  if ((r.streak || 0) >= 3) parts.push(`已经连着 ${r.streak} 天达标`);
  if (!parts.length) return '攒几天数据，这里会给你一句结论。';
  return parts.join('；') + '。';
}

/**
 * 年度热力图：一格一天，颜色越亮 = 那天自律越久。
 *
 * 为什么值得占屏幕：柱状图和日历回答的是"某一天/某一周"，只有这种图能一眼
 * 看出"我这半年是不是在退步"。人对自己时间分布的直觉，在二维方格上最强。
 *
 * 数据走 `stats_heatmap`（只回 date + 秒数），一次拉 365 天；
 * 拉成功就按今天缓存住，同一天不再重复请求。
 */
function heatmapCard() {
  return `<div class="card" id="heatCard">
    <div class="row" style="justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
      <div class="card-title" style="margin:0">这一年 ${qtip('collect')}</div>
      <div class="hint">每一格是一天，越亮 = 那天自律模式开着的时间越长</div>
    </div>
    <div class="heat-wrap"><div class="heat-grid" id="heatGrid"><span class="hint">正在读取…</span></div></div>
    <div class="row" style="justify-content:flex-end;align-items:center;gap:6px;margin-top:8px">
      <span class="hint">少</span>
      <span class="heat-cell l0"></span><span class="heat-cell l1"></span>
      <span class="heat-cell l2"></span><span class="heat-cell l3"></span>
      <span class="heat-cell l4"></span>
      <span class="hint">多</span>
    </div>
  </div>`;
}

/** 拉一年的每日秒数：失败就画"读取失败"，绝不当成 0 画成空白 */
function heatEnsure() {
  const today = todayStr();
  // 同一天也要过期重拉：今天这一格会随着你继续用而变长，
  // 只按"日期"缓存的话，早上打开统计页，下午再来看还是早上的颜色。
  const fresh = S.heatAt && Date.now() - S.heatAt < 5 * 60 * 1000;
  if (S.heat && S.heatKey === today && fresh) { paintHeat(); return; }
  if (S.heatPending) return;
  S.heatPending = true;
  const start = dateStr(addDays(new Date(), -364));
  withTimeout(invoke('stats_heatmap', { start, end: today }), 8000, '热力图读取超时')
    .then((r) => { S.heat = Array.isArray(r) ? r : []; S.heatFailed = false; })
    .catch(() => { S.heat = null; S.heatFailed = true; })
    .finally(() => { S.heatPending = false; S.heatKey = today; S.heatAt = Date.now(); paintHeat(); });
}

function paintHeat() {
  const el = $('#heatGrid');
  if (!el) return;
  if (S.heatFailed) { el.innerHTML = '<span class="hint">热力图读取失败，点上面的「刷新」再试一次。</span>'; return; }
  if (!S.heat) return;
  // 一整年都没有数据（新装、或者刚清过统计）：画 365 个灰格子只会让人以为坏了
  const total = S.heat.reduce((a, [, s]) => a + (Number(s) || 0), 0);
  if (total === 0) {
    el.innerHTML = '<span class="hint">最近一年还没有可用的数据。用满几天之后，这里就会长出颜色。</span>';
    return;
  }
  const map = new Map(S.heat.map(([d, s]) => [d, Number(s) || 0]));
  // 以周一为一列的开头：先找到"364 天前"那个周一
  const start = addDays(new Date(), -364);
  const lead = (start.getDay() + 6) % 7; // 0=周一
  const first = addDays(start, -lead);
  const cells = [];
  for (let d = new Date(first.getTime()); d <= new Date(); d = addDays(d, 1)) {
    const key = dateStr(d);
    const secs = map.get(key) || 0;
    const h = secs / 3600;
    const lv = h >= 5 ? 4 : h >= 2.5 ? 3 : h >= 1 ? 2 : h > 0 ? 1 : 0;
    // title 属性不会被 DOM 翻译扫描到，这里显式过一遍 I.t()
    const tip = secs ? fmtDur(secs) : I.t('没有数据');
    cells.push(`<span class="heat-cell l${lv}" title="${key} · ${tip}"></span>`);
  }
  el.innerHTML = cells.join('');
}

/**
 * 安全模式提示条。
 *
 * 只有在"连续几次启动都没撑住"时出现（见 Rust `boot.rs`）。这时拦截和遮罩
 * 都已经临时关掉，用户要做的只有一件事：把坏掉的规则改掉，然后点右边恢复。
 */
function safeBanner() {
  return `<div class="card" style="border-color:rgba(255,92,92,.45);background:rgba(255,92,92,.07);margin-bottom:14px">
    <div class="row" style="justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div>
        <div class="card-title" style="margin:0;color:var(--red)">安全模式</div>
        <div class="hint" style="margin-top:4px">连续几次启动都没撑住，已经临时关掉拦截和遮罩（统计照常记录）。先改掉可疑的规则，再点右边恢复。</div>
      </div>
      <button class="btn btn-sm" data-act="safe-leave">退出安全模式</button>
    </div>
  </div>`;
}

function peerBanner() {
  const peer = (S.data && S.data.config.settings.peerStats) || null;
  const days = (peer && peer.days) || [];
  if (!days.length) return '';
  const sorted = days.slice().sort((a, b) => String(b.day).localeCompare(String(a.day)));
  const last7 = sorted.slice(0, 7);
  const total = last7.reduce((n, x) => n + (+x.total || 0), 0);
  const on = last7.reduce((n, x) => n + (+x.on || 0), 0);
  const who = peer.source === 'android' ? '手机' : '桌面';
  const name = peer.device ? '（' + esc(peer.device) + '）' : '';
  const when = peer.at ? new Date(peer.at * 1000).toLocaleString() : '';
  // 这条横幅以前只有读数，没有任何去处：用户想知道"多久没同步了/怎么同步"只能自己找。
  // 补一行状态 + 一个直达云同步页的入口。
  const sync = (S.data && S.data.config.settings.sync) || {};
  const lastSync = sync.lastSync ? new Date(sync.lastSync * 1000).toLocaleString() : '';
  const staleDays = peer.at ? Math.floor((Date.now() / 1000 - peer.at) / 86400) : -1;
  const stale = staleDays >= 3
    ? `<span class="badge red" style="margin-left:6px">${staleDays} 天没更新</span>`
    : '';
  return `<div class="note" style="border-left-color:var(--blue);margin-bottom:14px">
    <b>另一台设备</b>
    <span class="hint" style="margin-left:6px">${who}${name}</span>${stale}
    <div style="margin-top:6px;font-size:12px">
      最近 ${last7.length} 天：总 ${fmtDur(total)} · 其中自律时段 ${fmtDur(on)}
      ${on > 0 ? `（${Math.round((on / Math.max(1, total)) * 100)}%）` : ''}
      ${when ? `<span class="hint"> · 数据同步于 ${esc(when)}</span>` : ''}
    </div>
    <div class="hint" style="margin-top:4px">
      这些数字来自对方设备，不计入上面的本机统计。
      ${lastSync ? `本机上次与云端同步：${esc(lastSync)}。` : ''}
      <a href="#" data-act="open-sync" style="color:var(--blue)">去云同步 ↗</a>
    </div>
  </div>`;
}



/* ============================================================
   首用向导（B6）
   ------------------------------------------------------------
   装完软件是"空"的：十几个页面每个都能点，但不知道先做哪一件。
   多数人在这一步流失——不是功能不够，是不知道从哪开始。
   所以这里只问三个问题，而且每个答案都直接落到既有结构里：
     ① 几点学   → 一套 ClockProfile（「自律时段」页里那套）
     ② 哪些别开 → 一条 Rule（「自律规则」页里那条）
     ③ 试 25 分钟 → 一套**一次性**时段方案，到点由后台删掉并还原

   文案全部走 w('中','en')：这些句子都带插值，进 i18n 词典会被切成碎片，
   直接在渲染时选语言更可靠，也顺手满足"英文界面零残留中文"。
   ============================================================ */
const WIZ_DAYS = ['一', '二', '三', '四', '五', '六', '日'];
const WIZ_DAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function w() {
  return I18N.getLang() === 'en' ? 1 : 0;
}
/** 二选一取文案：w2('中文', 'English') */
function w2(zh, en) {
  return I18N.getLang() === 'en' ? en : zh;
}

function wizState() {
  if (!S.wizard) {
    S.wizard = { step: 0, days: [0, 1, 2, 3, 4], from: 20, to: 22, apps: [], list: null, busy: false };
  }
  return S.wizard;
}

function wizOpen() {
  S.wizard = { step: 0, days: [0, 1, 2, 3, 4], from: 20, to: 22, apps: [], list: null, busy: false };
  wizRender();
  wizLoadApps();
}

function wizClose() {
  S.wizard = null;
  // 直接清空即可：Layer 的 sync() 会比对 #modalRoot 的现状，
  // 消失的弹层自动出栈（见 Layer 的注释），不必手工 closeModal。
  // 不要改成 closeModal：它 120ms 后才清 DOM，而调用方紧接着就 render 了，
  // 实测这样会让自动化用例直接卡住。
  const root = $('#modalRoot');
  if (root) root.innerHTML = '';
}

/** 读当前打开的程序，供第二步勾选（读不到不是错误，只是列表为空） */
async function wizLoadApps() {
  const w0 = S.wizard;
  if (!w0) return;
  try {
    const list = await invoke('list_windows');
    const seen = new Set();
    w0.list = (list || [])
      .filter((a) => a && a.path && !/king[-. ]?of[-. ]?focus/i.test(String(a.name || '')))
      .filter((a) => {
        const k = String(a.path).toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 12);
  } catch (e) {
    w0.list = [];
  }
  if (S.wizard) wizRender();
}

function wizHours() {
  const st = wizState();
  const mins = st.days.length * Math.max(0, st.to - st.from) * 60;
  return { mins };
}

function wizDayLabel(d) {
  return I18N.getLang() === 'en' ? WIZ_DAYS_EN[d] : WIZ_DAYS[d];
}

/** 周一~周五 / 每天 这种人话摘要 */
function wizDaysText(days) {
  const d = days.slice().sort((a, b) => a - b);
  const key = d.join(',');
  if (key === '0,1,2,3,4') return w2('工作日', 'Weekdays');
  if (key === '0,1,2,3,4,5,6') return w2('每天', 'Every day');
  if (key === '5,6') return w2('周末', 'Weekends');
  if (!d.length) return w2('还没选', 'Nothing selected');
  return d.map(wizDayLabel).join(' ');
}

function wizRender() {
  const st = wizState();
  const root = $('#modalRoot');
  if (!root) return;
  const M = wizStepHtml(st);
  root.innerHTML = `
  <div class="modal-mask wiz-mask">
    <div class="modal wiz">
      <div class="wiz-top">
        <div class="wiz-dots">${[0, 1, 2].map((i) =>
          `<i class="${i === st.step ? 'on' : ''}${i < st.step ? ' done' : ''}"></i>`).join('')}</div>
        <button class="close-x" data-act="wiz-close" title="${w2('关闭（下次启动还会出现）', 'Close (comes back next launch)')}">×</button>
      </div>
      <div class="wiz-bd">${M.body}</div>
      <div class="wiz-foot">
        ${st.step > 0
          ? `<button class="btn btn-sm" data-act="wiz-back">${w2('上一步', 'Back')}</button>`
          : `<button class="btn btn-sm" data-act="wiz-skip">${w2('跳过引导', 'Skip setup')}</button>`}
        <span style="flex:1"></span>
        ${M.foot}
      </div>
    </div>
  </div>`;
}

function wizStepHtml(st) {
  if (st.step === 0) {
    const { mins } = wizHours();
    const opt = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
      .map((h) => `<option value="${h}" ${(h === (a === 6 ? st.from : st.to)) ? 'selected' : ''}>${pad(h)}:00</option>`)
      .join('');
    return {
      body: `
      <div class="wiz-h">${w2('你打算什么时候学？', 'When do you plan to study?')}</div>
      <div class="wiz-sub">${w2(
        '这段时间里，「不该开的东西」会被挡住；需要的话，桌面也可以被遮罩盖住。先选一个你真能做到的时间——小一点没关系。',
        'During this window the things you pick get blocked, and the desktop can be masked. Pick something you can actually keep — small is fine.'
      )}</div>
      <div class="wiz-days">
        ${WIZ_DAYS.map((_, i) => `<button class="wiz-day${st.days.includes(i) ? ' on' : ''}"
          data-act="wiz-day" data-d="${i}">${wizDayLabel(i)}</button>`).join('')}
      </div>
      <div class="row" style="align-items:center;gap:10px;margin-top:14px">
        <span class="hint">${w2('从', 'From')}</span>
        <select class="input" id="wizFrom" data-act="wiz-time" data-k="from" style="max-width:110px">${opt(6, 23)}</select>
        <span class="hint">${w2('到', 'to')}</span>
        <select class="input" id="wizTo" data-act="wiz-time" data-k="to" style="max-width:110px">${opt(7, 24)}</select>
      </div>
      <div class="wiz-sum">${w2(
        `${wizDaysText(st.days)} ${pad(st.from)}:00–${pad(st.to)}:00 · 每天 ${Math.floor((st.to - st.from))} 小时`,
        `${wizDaysText(st.days)} ${pad(st.from)}:00–${pad(st.to)}:00 · ${(st.to - st.from)}h per day`
      )}${mins ? '' : ''}</div>`,
      foot: `<button class="btn btn-primary btn-sm" data-act="wiz-next" ${st.days.length ? '' : 'disabled'}>${w2('下一步', 'Next')}</button>`,
    };
  }

  if (st.step === 1) {
    const list = st.list;
    const rows = list === null
      ? `<div class="hint">${w2('正在读取当前打开的程序…', 'Reading open programs…')}</div>`
      : list.length
        // data-act 放在 label 上：点文字也能选中（放在 input 上时点标签文字没反应）
        ? list.map((a) => `<label class="wiz-app${st.apps.includes(a.path) ? ' on' : ''}"
            data-act="wiz-app" data-path="${esc(a.path)}">
            <input type="checkbox" ${st.apps.includes(a.path) ? 'checked' : ''} tabindex="-1" />
            <span class="n">${esc(a.name)}</span>
            <span class="t">${esc(a.title || '')}</span>
          </label>`).join('')
        : `<div class="hint">${w2(
            '没读到现在打开的程序（有时需要管理员权限）。这一步可以跳过，以后在「自律规则」里随时能加。',
            'No open programs found (this sometimes needs admin). You can skip and add them later in Rules.'
          )}</div>`;
    return {
      body: `
      <div class="wiz-h">${w2('这些时候，哪些不该打开？', 'Which ones should stay closed then?')}</div>
      <div class="wiz-sub">${w2(
        '只在你刚选的时间段里挡住它们，别的时间照常使用。想挡的东西没开？先打开它再回来勾。',
        'Only blocked during the window you just picked. Missing something? Open it, then come back.'
      )}</div>
      <div class="wiz-apps">${rows}</div>`,
      foot: `<button class="btn btn-primary btn-sm" data-act="wiz-next">${w2('下一步', 'Next')}</button>`,
    };
  }

  const hrs = Math.max(0, st.to - st.from) * st.days.length;
  return {
    body: `
    <div class="wiz-h">${w2('就这样，可以开始了', 'That is it — you can start')}</div>
    <div class="wiz-sub">${w2(
      '到点会自动开始：被选的软件会被挡住，桌面可以被遮罩盖住。之后想改，随时到「自律时段」和「自律规则」里改。',
      'It starts on its own: blocked apps get stopped and the desktop can be masked. Change anything later in Schedule and Rules.'
    )}</div>
    <div class="wiz-plan">
      <div><b>${wizDaysText(st.days)} ${pad(st.from)}:00–${pad(st.to)}:00</b>
        <span class="hint">${w2(`每周约 ${hrs} 小时`, `~${hrs}h per week`)}</span></div>
      <div>${st.apps.length
        ? w2(`挡住 ${st.apps.length} 个软件`, `${st.apps.length} apps blocked`)
        : w2('这一步先跳过（以后可以加）', 'No apps for now')}</div>
      <div>${w2('到点自动打开遮罩：开', 'Mask opens automatically: on')}</div>
    </div>`,
    foot: `
      <button class="btn btn-sm" data-act="wiz-try">${w2('先试 25 分钟', 'Try 25 minutes')}</button>
      <button class="btn btn-primary btn-sm" data-act="wiz-done">${w2('完成', 'Done')}</button>`,
  };
}

/** 保存（完成 / 试一下都要先保存） */
async function wizSave() {
  const st = wizState();
  if (st.busy) return false;
  st.busy = true;
  let ok = false;
  try {
    await invoke('onboard_finish', {
      days: st.days,
      fromHour: st.from,
      toHour: st.to,
      apps: st.apps,
    });
    ok = true;
  } catch (e) {
    toast(String(e).replace(/^Error:\s*/, ''), 'err');
  }
  st.busy = false;
  return ok;
}

async function wizDone() {
  if (!(await wizSave())) return;
  wizClose();
  await pull();
  render();
  toast(w2('设置好了。到点会自动开始。', 'All set. It starts on its own when the time comes.'), 'ok');
}

async function wizTry() {
  if (!(await wizSave())) return;
  try {
    const r = await invoke('onboard_try', { minutes: 25 });
    wizClose();
    await pull();
    render();
    toast(w2(
      `试的这 25 分钟已开始，${new Date((r.until || 0) * 1000).toLocaleTimeString()} 自动结束并还原。`,
      `25-minute trial started; it ends and restores itself at ${new Date((r.until || 0) * 1000).toLocaleTimeString()}.`
    ), 'ok');
  } catch (e) {
    toast(String(e).replace(/^Error:\s*/, ''), 'err');
  }
}

/* ============================================================
   口径说明（B7）
   ------------------------------------------------------------
   统计页最容易被误读的不是数字，是"这个数字是什么意思"。
   误读一次，用户就会开始怀疑整套数据，然后关掉统计。
   所以每个关键数字旁边都留一个「?」，点开就是一句话解释。

   为什么文案写在这里而不是 i18n 词典里：这些是**成段的解释**，
   整段是一个文本节点，词典里逐字命中没问题；但每段都带 `<b>` 与换行，
   塞进词典会变成一堆片段，反而更容易翻错。这里用 zh/en 双份，直接取。
   ============================================================ */
const TIPS = {
  track: {
    zh: ['为什么分成两条轨', `只有一秒里满足下面任一条件，才记到<b>自律模式已开启</b>：
      <br>① 有自律规则正在生效（到点就生效，与你是否在看这个软件无关）；
      <br>② 正在自律时段里（番茄休息也算在内）；
      <br>③ 正处于锁机中；
      <br>④ 手动开着专注遮罩（你主动把屏幕盖上去做一件事，那也算在专注）。
      <br><br>其余全部记到<b>自律模式未开启</b>。两条轨<b>完全隔离、绝不相加</b>——
      "开着自律在用电脑"和"没开自律在用电脑"是两种完全不同的事，
      混在一起只会得到一条既不能夸也不能骂的曲线。
      <br><br>所以「今日自律 2 小时」的意思是：今天有 2 小时是<b>在自律状态下的使用时间</b>，
      不是"今天学了 2 小时"。`],
    en: ['Why two tracks', `A second counts as <b>discipline on</b> only when one of these holds:
      <br>1. a discipline rule is active right now;
      <br>2. you are inside a focus window (pomodoro breaks included);
      <br>3. the screen is locked by this app;
      <br>4. the focus mask is on (you put it up yourself to work on one thing).
      <br><br>Everything else goes to <b>discipline off</b>. The tracks are never
      mixed or summed: "using the PC while discipline is on" and "using it while off"
      are different things.`],
  },
  collect: {
    zh: ['这些秒数是怎么来的', `每秒采样一次前台窗口，累计成秒数：
      <br>· 前台是受支持的浏览器、且插件在 5 分钟内上报过当前标签页 → 记到<b>那个域名</b>；
      <br>· 否则记到<b>那个 exe</b>。
      <br><br>它统计的是<b>窗口在前台的时间</b>，不是"你有多专注"。想看专注质量，
      看「分心事件」和「被打断」——那两样记录的才是真的走神。`],
    en: ['Where the seconds come from', `The foreground window is sampled once per second:
      <br>· supported browser with a page reported by the extension within 5 minutes →
      counted against <b>that domain</b>;
      <br>· otherwise → counted against <b>that exe</b>.
      <br><br>This measures time in the foreground, not focus quality.`],
  },
  hour: {
    zh: ['为什么这一小时算"未自律"', `判定是<b>按秒</b>做的，不是给整小时贴一个标签：
      那一秒如果不在规则生效期、不在专注时段、也没锁机，就记进"未开启"。
      <br><br>所以同一小时里两种状态都可能有（日历上是不同颜色的块）。
      如果你觉得"我明明在自律"，去总览看一眼守护状态——多半是规则没生效。`],
    en: ['Why this hour counts as "off"', `The decision is made <b>per second</b>: a second with no
      active rule, no focus window and no lock goes to "off". One hour can therefore
      contain both colours.`],
  },
  hourly: {
    zh: ['24 根柱子是什么', `每根柱子 = 那个钟点上累计的使用秒数（整个所选时间段相加），
      不是某一天的分布。
      <br><br>它回答的是"你一天里什么时候最投入"，所以看形状比看高度有用：
      连续的高柱是整块时间，零碎的小柱是被打断的时段。`],
    en: ['What the 24 bars are', `Each bar is the accumulated seconds at that hour of the day
      across the selected range — not a single day's shape.`],
  },
  idle: {
    zh: ['离开的时间去哪了', `超过 60 秒没有任何键鼠输入，这段不计时（可在设置里改）。
      <br><br>这是这套统计最容易被误读的地方：「看了两小时视频」可能只记几分钟，
      因为手没动。真正在看的东西，会在「分心事件」和「被打断」里留下痕迹。`],
    en: ['Where idle time goes', `A stretch with no keyboard or mouse input for more than
      60 seconds is not counted (configurable).`],
  },
};

/** 一个小问号：点开就是上面那段解释 */
function qtip(k) {
  return `<button class="q" data-act="tip" data-k="${k}" title="口径说明">?</button>`;
}

function showTip(k) {
  const t = TIPS[k];
  if (!t) return;
  const zh = I18N.getLang() !== 'en';
  const [title, body] = zh ? t.zh : t.en;
  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="max-width:520px">
      <div class="modal-hd">
        <h3>${qtTitle(title)}</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div style="font-size:12.5px;line-height:1.85">${body}</div>
        <div class="row" style="margin-top:16px">
          <button class="btn btn-primary btn-sm" data-act="close-modal">明白了</button>
        </div>
      </div>
    </div>
  </div>`;
}

/** 标题里不放用户输入，只有固定文案，直接插即可 */
function qtTitle(t) {
  return esc(t);
}

function viewStats() {
  const st = S.stats;
  const cur = currentSlices();
  const hourly = st ? (S.statsTab === 'off' ? st.offHourly : S.statsTab === 'all'
    ? st.onHourly.map((v, i) => v + st.offHourly[i]) : st.onHourly) : new Array(24).fill(0);
  const maxH = Math.max(1, ...hourly);

  const ranges = [['today', '今日'], ['week', '本周'], ['month', '本月'], ['year', '今年'], ['custom', '自定义']];
  const segs = [
    ['on', '自律模式已开启', 'gold'],
    ['off', '自律模式未开启', ''],
    ['all', '两种状态汇总', ''],
  ];

  return `
  <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
    <div class="seg">
      ${segs.map(([k, n, c]) => `<button class="${S.statsTab === k ? 'active ' + c : ''}" data-act="stats-tab" data-tab="${k}">${n}</button>`).join('')}
    </div>
    <div class="hint">${qtip('track')} 当前状态：<b>${S.data && S.data.runtime.disciplineOn ? '自律模式已开启' : '自律模式未开启'}</b></div>
  </div>

  ${peerBanner()}

  ${rhythmCard()}

  ${heatmapCard()}

  <div class="range-row">
    ${ranges.map(([k, n]) => `<button class="chip-btn ${S.range === k ? 'active' : ''}" data-act="range" data-r="${k}">${n}</button>`).join('')}
    ${S.range === 'custom' ? `<input type="date" id="cStart" value="${esc(S.customStart || todayStr())}"/>
      <span class="muted">至</span>
      <input type="date" id="cEnd" value="${esc(S.customEnd || todayStr())}"/>
      <button class="btn btn-sm" data-act="range-apply">应用</button>` : ''}
    <span class="muted" id="rangeLabel" style="margin-left:auto;font-size:11.5px">${st ? st.start + ' ~ ' + st.end : ''}</span>
    <button class="btn btn-sm" data-act="poster" title="把这段时间的数据画成一张可分享的图">战报图</button>
    <button class="btn btn-sm" data-act="stats-refresh">刷新</button>
  </div>

  <div class="card" id="distCard">
    <div class="card-title">
      使用时长分布 · ${cur.label} ${qtip('collect')}
      <span class="badge">合计 ${fmtDur(cur.total)}</span>
    </div>
    <div class="hint" style="margin-bottom:6px">统计口径：只计入你在电脑前的时间；离开超过 1 分钟（无键鼠输入）的那段不计入。</div>
    <div class="card-sub">
      ${S.statsTab === 'on'
        ? '这里<b>只统计自律模式开启时段</b>内的前台使用时长，与"未开启"的数据完全隔离。'
        : S.statsTab === 'off'
          ? '这里<b>只统计自律模式未生效时段</b>内的前台使用时长，与"已开启"的数据完全隔离。'
          : '汇总口径：把「已开启」与「未开启」两个数据集里同一个应用 / 同一个域名的秒数直接相加，不做任何加权；扇区大小 = 该项在所选时间段内的前台使用总时长占比。'}
    </div>
    <div class="stats-split">
      <div class="stats-pie">
        ${cur.slices.length ? '<div class="chart-wrap"><canvas id="pie" width="620" height="360"></canvas></div>'
    : `<div class="empty"><span class="ico">▤</span>这个时间段还没有数据。<br>统计每秒采样一次前台窗口，用一会儿就会有了。</div>`}
      </div>
      <div class="stats-day" id="dayCard">
        <div id="dayBody">${dayHtml()}</div>
      </div>
    </div>
    ${cur.slices.length ? '<div id="pieDetail" class="pie-detail-host" data-key=""></div>' : ''}
  </div>

  <div class="card" id="calCard">
    <div class="card-title">
      时间日历
      <div class="seg cal-seg">
        <button class="${S.calMode === 'week' ? 'active gold' : ''}" data-act="cal-mode" data-m="week">周</button>
        <button class="${S.calMode === 'month' ? 'active gold' : ''}" data-act="cal-mode" data-m="month">月</button>
      </div>
    </div>
    <div class="cal-nav">
      <button class="btn btn-sm" data-act="cal-move" data-d="-1" title="上一页">‹</button>
      <span class="cal-label">${calRangeLabel()}</span>
      <button class="btn btn-sm" data-act="cal-move" data-d="1" title="下一页">›</button>
      <button class="btn btn-sm" data-act="cal-today">今天</button>
      <span class="hint" style="margin-left:auto">每个色块就是一种软件；点任意一天，右边「当日日历」就跟着换到那天。</span>
    </div>
    <div id="calBody">${calHtml()}</div>
  </div>

  ${cur.slices.length ? `
  <div class="card">
    <div class="card-title">24 小时分布 ${qtip('hourly')}</div>
    <div class="card-sub">每个小时累计的秒数，可以看出你在什么时间最投入。</div>
    <div class="hourly">
      ${hourly.map((v) => `<div class="hbar ${v === 0 ? 'zero' : ''}" style="height:${Math.max(1, (v / maxH) * 100)}%" title="${Math.round(v / 60)} 分钟"></div>`).join('')}
    </div>
    <div class="hlabels">${Array.from({ length: 24 }, (_, i) => `<span>${i}</span>`).join('')}</div>
  </div>` : ''}

  ${(() => {
    const led = S.statsLedger || { total: 0, items: [] };
    if (!led.total) return '';
    // 这段是整块拼出来的，词典命中不了 —— 直接按语言拼
    const en2 = I18N.getLang() === 'en';
    return `<div class="card">
      <div class="card-title">${en2 ? 'What interrupted you' : '本期被什么打断'}
        <span class="badge gold">${en2 ? `${led.total} hits` : `共 ${led.total} 次`}</span>
      </div>
      <div class="card-sub">${en2
        ? 'Only <b>actual blocks</b> count (app sent home, page closed); the same target counts once per 30 seconds. The top one is the one worth turning off.'
        : '只记<b>真的被拦下</b>的东西（应用被送回桌面、网页被关掉）；30 秒内同一个目标只算一次。次数最多的那一个，就是最值得关掉的那一个。'}</div>
      ${led.items.slice(0, 8).map((h) => `<div class="list-row">
        <span class="badge ${h.kind === 'site' ? 'blue' : 'gold'}">${
          h.kind === 'site' ? (en2 ? 'site' : '网页') : (en2 ? 'app' : '软件')
        }</span>
        <span class="grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(h.label)}">${esc(h.label)}</span>
        <span class="hint" style="flex:0 0 auto">${esc(h.rule || '')}</span>
        <b style="flex:0 0 auto;font-variant-numeric:tabular-nums">${h.n} ${en2 ? 'x' : '次'}</b>
      </div>`).join('')}
    </div>`;
  })()}

  <div class="note" style="margin-top:14px">
    <b>采集口径：</b>${qtip('idle')}每秒采样一次前台窗口。若前台是受支持的浏览器、且插件在 5 分钟内上报过当前标签页，
    这一秒记到<b>该域名</b>上；否则记到<b>该 exe</b>上。无操作超过 60 秒不计时（可在设置里改）。
    日文件按小时分桶，可回溯到"某天某小时"。
  </div>`;
}


/* ============================================================
   周复盘（A7）
   ------------------------------------------------------------
   为什么不是"自动生成一份周报"：报告是数据，复盘是决定。
   一份周报可以从头看到尾，然后什么都不会改变。
   所以这里只有五个问题，每个问题前面挂一个数字，
   答完必须落成一句"下周改什么"——这一句才是产出。

   数据全部来自已有文件（统计日文件、账本、分心事件、段目标、质押），
   在 Rust 侧 `review::week` 里汇总，和统计页读的是同一份数据。
   另算一套的话，用户会先怀疑数字，再怀疑软件。
   ============================================================ */
function reviewState() {
  S.review = S.review || { offset: 1, data: null, loading: false };
  return S.review;
}

async function reviewLoad() {
  const r = reviewState();
  if (r.loading) return;
  r.loading = true;
  try {
    r.data = await invoke('review_week', { offset: r.offset });
  } catch (e) {
    r.data = null;
  }
  r.loading = false;
  if (S.view === 'reports') render();
}

async function reviewSave() {
  const r = reviewState();
  if (!r.data) return;
  const answers = [];
  for (let i = 0; i < 5; i++) {
    const el = document.getElementById(`rvA${i}`);
    answers.push(el ? el.value : '');
  }
  try {
    await invoke('review_save', { week: r.data.week, answers });
    r.data.answers = answers;
    toast('复盘已保存：下周打开还能看到这几句', 'ok');
  } catch (e) {
    toast(String(e).replace(/^Error:\s*/, ''), 'err');
  }
}

/** 五个问题：数据陈述 + 一个真正要回答的提问 */
function reviewCard() {
  const r = reviewState();
  const en = I18N.getLang() === 'en';
  const d = r.data;
  const head = `<div class="card-title">周复盘
      <div class="seg cal-seg" style="margin-left:auto">
        <button class="${r.offset === 0 ? 'active gold' : ''}" data-act="review-week" data-off="0">${en ? 'This week' : '本周'}</button>
        <button class="${r.offset === 1 ? 'active gold' : ''}" data-act="review-week" data-off="1">${en ? 'Last week' : '上周'}</button>
      </div>
    </div>`;

  if (!d) {
    return `<div class="card">${head}
      <div class="empty"><span class="ico">◔</span>${en ? 'No data yet.' : '还没有可复盘的数据。'}</div>
    </div>`;
  }

  // 用 fmtDurShort（6h20m）而不是 fmtDur（6 小时 20 分）：后者是中文专用，
  // 英文界面下会漏出中文单位 —— "英文界面零残留中文"那条断言就是抓这个的。
  const h = (sec) => fmtDurShort(sec);
  const diver = (d.diversions && d.diversions[0]) || null;
  const left = Math.max(0, (d.distractTotal || 0) - (d.distractDone || 0));
  const bestDay = d.bestDay ? d.bestDay.slice(5) : '—';
  const ans = d.answers || [];

  const qs = [
    {
      data: en
        ? `Discipline-on time <b>${h(d.onSecs)}</b> this week, <b>${h(d.prevOnSecs)}</b> last week. Best day: <b>${bestDay}</b> (${h(d.bestOn)}).`
        : `本周自律 <b>${h(d.onSecs)}</b>，上周 <b>${h(d.prevOnSecs)}</b>。最投入的是 <b>${bestDay}</b>（${h(d.bestOn)}）。`,
      ask: en ? 'Which day felt best, and what did you do right that day?' : '这周最好的一天是哪天？那天你做对了什么？',
      ph: en ? 'e.g. Tuesday — phone was in another room' : '例如：周二，手机放到了另一个房间',
    },
    {
      data: d.diverTotal
        ? (en
            ? `Blocked <b>${d.diverTotal}</b> times; top source <b>${esc(diver.label)}</b> (${diver.n}).`
            : `被打断 <b>${d.diverTotal}</b> 次，最多来自 <b>${esc(diver.label)}</b>（${diver.n} 次）。`)
        : (en
            ? 'Nothing was blocked this week. Either very disciplined, or the rules were not active.'
            : '这周一次都没被拦过。要么很自律，要么规则没生效。'),
      ask: en
        ? (d.diverTotal ? 'Will you turn that one off next week? If not, what is the alternative?' : 'Do you want to check whether the rules actually work?')
        : (d.diverTotal ? '下周要不要把「' + (diver ? esc(diver.label) : '') + '」关掉？关不掉的话，替代办法是什么？' : '要不要去总览看一眼守护状态，确认规则真的在生效？'),
      ph: en ? 'e.g. uninstall it / only allow it after 21:00' : '例如：卸载掉 / 只在 21 点后允许',
    },
    {
      data: d.goalTotal
        ? (en
            ? `Wrote <b>${d.goalTotal}</b> goals: <b>${d.goalDone}</b> done, <b>${d.goalPartial}</b> half, <b>${d.goalMissed}</b> not done, <b>${d.goalNone}</b> unanswered.`
            : `写了 <b>${d.goalTotal}</b> 个段目标：做完 <b>${d.goalDone}</b>、做了一半 <b>${d.goalPartial}</b>、没做成 <b>${d.goalMissed}</b>、还没答 <b>${d.goalNone}</b>。`)
        : (en
            ? 'No goals written this week — the session length was all you measured.'
            : '这周一个段目标都没写——你量到的只有"坐了多久"。'),
      ask: d.goalMissed || d.goalNone
        ? (en ? 'Of the goals you did not finish, were they too big, or was the time wrong?'
              : '没做成 / 还没答的那几个，是目标定太大了，还是时间选得不对？')
        : (en ? 'What made the finished ones finishable?' : '做完的那几个，凭什么做得完？'),
      ph: en ? 'e.g. "写登录页" is doable in 2h, "学完前端" is not' : '例如：「写完登录页」两小时能做完，「学完前端」不能',
    },
    {
      data: en
        ? `Recorded <b>${d.distractTotal}</b> distractions, processed <b>${d.distractDone}</b>.`
        : `记下 <b>${d.distractTotal}</b> 条分心事件，处理了 <b>${d.distractDone}</b> 条。`,
      ask: left
        ? (en ? `${left} left — which one deserves handling right now?` : `还剩 ${left} 条，哪一条值得现在就处理？`)
        : (en ? 'All processed. What did you learn about what distracts you?' : '都处理完了。这些念头里有什么规律？'),
      ph: en ? 'e.g. the one about "check the docs later"' : '例如：那条"晚点去查文档"',
    },
    {
      data: en
        ? `Stakes: <b>${d.staked}</b> settled, <b>${d.stakeClean}</b> clean, <b>${d.stakeVoid}</b> forfeited.`
        : `质押结算 <b>${d.staked}</b> 笔，干净跑完 <b>${d.stakeClean}</b> 笔，被没收 <b>${d.stakeVoid}</b> 笔。`,
      ask: en ? 'Pick ONE thing to change next week.' : '下周只改一件事——改哪件？',
      ph: en ? 'Just one. Two changes means none.' : '只写一件。写两件等于没写。',
      last: true,
    },
  ];

  const rows = qs.map((q, i) => `<div class="rv-q">
      <div class="rv-data">${q.data}</div>
      <div class="rv-ask">${q.ask}</div>
      <textarea id="rvA${i}" class="input rv-in" rows="${q.last ? 3 : 2}"
        placeholder="${q.ph}">${esc(ans[i] || '')}</textarea>
    </div>`).join('');

  return `<div class="card">
    ${head}
    <div class="card-sub">
      ${en
        ? 'Five questions, the numbers are already filled in. Answer in a sentence or two — that sentence is the whole point.'
        : '五个问题，数字已经填好。每题用一两句回答就行——那一两句才是复盘的全部产出。'}
    </div>
    ${rows}
    <div class="row" style="margin-top:14px;align-items:center;flex-wrap:wrap;gap:8px">
      <button class="btn btn-primary btn-sm" data-act="review-save">${en ? 'Save review' : '保存复盘'}</button>
      ${left
        ? `<button class="btn btn-sm" data-act="review-goto" data-view="distract">${
            en ? `Process these ${left}` : `去处理这 ${left} 条`
          }</button>`
        : ''}
      <span class="hint" style="margin-left:10px">${en
        ? 'Stored locally; open the same week again to compare.'
        : '存在本机，下次打开这一周还能看到，用来对照'}</span>
    </div>
  </div>`;
}

/* ---------------- 视图：统计报告 ---------------- *//* ---------------- 视图：统计报告 ---------------- */
function viewReports() {
  const d = S.data;
  const s = d ? d.config.settings.stats : {};
  // 报告类型用分段按钮，不用原生 <select>：原生下拉在深色界面里会掉出
  // 一套系统配色（白底 / 系统蓝高亮），和整个页面完全不搭。
  const PERIODS = [['daily', '日报'], ['weekly', '周报'], ['monthly', '月报'], ['yearly', '年报']];
  const curP = S.genPeriod || 'daily';
  const seg = `<div class="seg" id="genPeriod">${PERIODS.map(([v, t]) =>
    `<button class="seg-btn${v === curP ? ' active' : ''}" data-act="gen-period" data-v="${v}">${t}</button>`).join('')}</div>`;

  const list = S.reports.length
    ? S.reports.map((r) => `<div class="rep-item" data-act="open-report" data-id="${esc(r.id)}">
        <span class="badge ${r.period === 'daily' ? 'gold' : r.period === 'weekly' ? 'blue' : 'green'}">${
          { daily: '日报', weekly: '周报', monthly: '月报', yearly: '年报', custom: '自定义' }[r.period] || r.period}</span>
        <div class="rep-main">
          <div class="ttl">${esc(r.title)}</div>
          <div class="sub">${r.start} ~ ${r.end} · 生成于 ${new Date(r.created * 1000).toLocaleString()}</div>
        </div>
        <div class="rep-stat">
          <div class="tnum">${fmtDur(r.onSecs + r.offSecs)}</div>
          <div class="sub">开启 ${fmtDurShort(r.onSecs)} · 未开启 ${fmtDurShort(r.offSecs)}</div>
        </div>
        <div class="rep-ops">
          <button class="btn btn-sm" data-act="report-export-open" data-id="${esc(r.id)}"
            title="导出为 Markdown / 纯文本 / Word">导出</button>
          <button class="btn btn-sm danger-ghost" data-act="report-del-ask" data-id="${esc(r.id)}"
            title="删除这份报告（会先确认）">删除</button>
        </div>
      </div>`).join('')
    : '<div class="empty"><span class="ico">▤</span>还没有生成过报告。<br>开启下面的自动生成，或者点「立即生成」。</div>';

  const sw = (k, v, t, sub) => `<div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">${t}</div><div class="hint" style="margin-top:3px">${sub}</div></div>
      <div class="switch" data-act="stat-toggle" data-k="${k}"><input type="checkbox" ${v ? 'checked' : ''}><i></i></div>
    </div>`;

  return `
  ${reviewCard()}

  <div class="card">
    <div class="card-title">自动生成设置</div>
    <div class="card-sub">
      报告在周期结束后的<b>第一个 00:00 自动生成</b>（程序没开着的话，下次启动会补齐）。
      生成的报告不会自动删除，除非超过「数据保留天数」。
    </div>
    ${sw('autoDaily', s.autoDaily, '每日报告', '每天 00:00 生成前一天的日报')}
    ${sw('autoWeekly', s.autoWeekly, '每周报告', '每周一 00:00 生成上周（周一 ~ 周日）的周报')}
    ${sw('autoMonthly', s.autoMonthly, '每月报告', '每月 1 日 00:00 生成上个月的月报')}
    ${sw('autoYearly', s.autoYearly, '每年报告', '每年 1 月 1 日生成上一年的年报')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div>
        <div style="font-size:12.5px">自定义周期</div>
        <div class="hint" style="margin-top:3px">每 N 天生成一次，从锚点日算起，报告覆盖上一个完整 N 天</div>
      </div>
      <div class="row" style="align-items:center;gap:8px">
        <span class="hint">每</span>
        <input type="number" id="customDays" min="0" max="365" value="${s.customDays || 0}" style="width:76px" />
        <span class="hint">天</span>
        <button class="btn btn-sm" data-act="save-custom-days">保存</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="rep-hd">
      <div>
        <div class="card-title" style="margin:0">历史报告</div>
        <div class="hint" style="margin-top:4px">保留在本地，可随时回看、导出或删除${
          S.reports.length ? ` · 共 ${S.reports.length} 份` : ''}</div>
      </div>
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
        ${seg}
        <button class="btn btn-primary btn-sm" data-act="gen-report">立即生成</button>
        <button class="btn btn-sm" data-act="reports-refresh">刷新</button>
      </div>
    </div>
    <div class="rep-list">${list}</div>
  </div>

  <div class="note" style="margin-top:14px">
    <b>存储方式：</b>全部数据都在软件目录下的 <code>king of focus data</code> 里 —— 原始日数据存
    <code>stats\\days\\</code>（一天一个 JSON，按小时分桶）；报告存 <code>stats\\reports\\</code>
    （一份报告一个 JSON，含两种状态各自的扇区数据）。
    默认保留 <b>${s.retentionDays || 400} 天</b>，可在设置里调整。报告可以随时点开回看，也可以手动删除。
    <div class="hint" style="margin-top:8px;word-break:break-all">当前路径：${esc(d.dataPath || '')}</div>
    <div style="margin-top:10px"><button class="btn btn-sm" data-act="open-stats-dir">打开数据目录</button></div>
  </div>`;
}

/* ---------------- 视图：云同步 ---------------- */
function viewSync() {
  const d = S.data;
  if (!d) return '';
  const sy = d.config.settings.sync || {};
  const last = sy.lastSync ? new Date(sy.lastSync * 1000).toLocaleString() : '从未同步';
  const err = sy.lastError || '';
  const okMsg = sy.lastResult || '';

  return `
  <div class="card">
    <div class="card-title">WebDAV 云同步</div>
    <div class="card-sub">
      把<b>自律规则与设置</b>同步到你自己的网盘（坚果云 / Nextcloud / 群晖 / 阿里云盘 WebDAV 等）。
      统计原始数据<b>不会</b>上传，避免动辄几十 MB 的日文件把网盘撑爆。
    </div>

    <div style="display:grid;grid-template-columns:1fr;gap:12px;max-width:640px">
      <div>
        <div class="hint" style="margin-bottom:6px">WebDAV 目录地址</div>
        <input type="text" id="davUrl" style="width:100%" value="${esc(sy.url || '')}"
          placeholder="留空 = 用默认地址（坚果云）" />
        <div class="hint" style="margin-top:6px">默认是坚果云的公共目录，目录不存在会自动建；用别的网盘（Nextcloud / 群晖 / 阿里云盘）就把地址改成你自己的，改完点「保存配置」</div>
      </div>
      <div class="row">
        <div style="flex:1">
          <div class="hint" style="margin-bottom:6px">账号</div>
          <input type="text" id="davUser" style="width:100%" value="${esc(sy.username || '')}" placeholder="邮箱 / 用户名" />
        </div>
        <div style="flex:1">
          <div class="hint" style="margin-bottom:6px">密码 / 应用密码</div>
          <input type="password" id="davPass" style="width:100%" value="${esc(sy.password || '')}" placeholder="••••••••" />
        </div>
      </div>
      <div class="row" style="align-items:center;gap:18px">
        <label class="row" style="align-items:center;gap:8px;cursor:pointer">
          <div class="switch" data-act="sync-auto"><input type="checkbox" ${sy.auto ? 'checked' : ''}><i></i></div>
          <span style="font-size:12.5px">自动同步</span>
        </label>
        <div class="row" style="align-items:center;gap:8px">
          <span class="hint">每</span>
          <input type="number" id="davMins" value="${sy.autoMinutes || 30}" min="5" max="1440" style="width:82px" />
          <span class="hint">分钟</span>
        </div>
      </div>
      <div class="row">
        <button class="btn btn-primary" data-act="sync-save">保存配置</button>
        <button class="btn" data-act="sync-now" ${sy.url ? '' : 'disabled'}>立即同步</button>
        <button class="btn" data-act="sync-up" ${sy.url ? '' : 'disabled'}>上传本机 → 云端</button>
        <button class="btn" data-act="sync-down" ${sy.url ? '' : 'disabled'}>云端 → 覆盖本机</button>
      </div>
    </div>

    <div class="note" style="margin-top:18px">
      <b>上次同步：</b>${esc(last)}<br>
      ${err ? `<b style="color:var(--red)">失败：</b>${esc(err)}` : okMsg ? `<b style="color:var(--green)">结果：</b>${esc(okMsg)}` : '<span class="muted">还没有同步记录</span>'}
    </div>
  </div>

  <div class="card">
    <div class="card-title">本地备份 <span class="badge">${(S.backups || []).length} 份</span></div>
    <div class="card-sub">
      存在软件目录下的 <code>king of focus back</code>，每一份都是跨设备文件。<br>
      设了备份密码就是 AES-256-GCM 密文（电脑、手机都能打开）；没设就是明文（生成时会提醒）。<br>
      只保留最近 10 份、7 天内的。同一份文件拿到哪台设备都能恢复，没有「只认本机」那一档。
    </div>
    <div class="row" style="gap:9px;flex-wrap:wrap;margin-bottom:10px">
      <button class="btn btn-primary btn-sm" data-act="backup-make">立即备份</button>
      <button class="btn btn-sm" data-act="backup-dir">打开备份目录</button>
    </div>
    <div class="row" style="gap:9px;flex-wrap:wrap;margin-bottom:14px">
      <button class="btn btn-sm" data-act="backup-export">导出跨设备备份…</button>
      <button class="btn btn-sm" data-act="backup-import">从文件恢复…</button>
    </div>
    <div class="hint" style="margin-bottom:14px">
      跨设备：导出的文件可以拷到手机上恢复，手机导出的也能拿回来。设了备份密码就是密文，没设就是明文 JSON。
    </div>
    <div class="row" style="align-items:center;gap:9px;margin-bottom:14px;flex-wrap:wrap">
      <span class="hint" style="width:74px">备份密码</span>
      <input type="password" id="bkPass" style="flex:1;max-width:280px"
        placeholder="${(d.config.settings.backup || {}).password ? '已设置（留空 = 不修改）' : '留空 = 明文备份（两端都能读）'}" />
      <label class="row" style="align-items:center;gap:6px;font-size:11.5px;cursor:pointer">
        <input type="checkbox" id="bkAuto" ${(d.config.settings.backup || {}).autoOnStart ? 'checked' : ''} /> 启动时自动备份
      </label>
      <button class="btn btn-sm" data-act="backup-pass">保存</button>
    </div>
    ${(d.config.settings.backup || {}).password ? '' : `<div class="hint" style="margin:-6px 0 12px;color:var(--gold)">⚠ 没设备份密码：本地备份、云端备份、导出的文件都是明文，任何能拿到文件的人都能读。</div>`}
    ${(S.backups || []).length ? (S.backups || []).map((f) => `<div class="list-row">
        <span class="badge gold">${esc(f.name)}</span>
        <span class="grow muted" style="font-size:10.5px">${new Date((f.mtime || 0) * 1000).toLocaleString()} · ${Math.round((f.size || 0) / 1024)} KB</span>
        <button class="btn btn-sm" data-act="backup-restore" data-path="${esc(f.path)}">恢复</button>
        <button class="x" data-act="backup-del" data-path="${esc(f.path)}">×</button>
      </div>`).join('') : '<div class="empty"><span class="ico">⛁</span>还没有本地备份。点「立即备份」生成第一份。</div>'}
  </div>

  <div class="card">
    <div class="card-title">云端备份</div>
    <div class="card-sub">
      把加密后的备份传到上面的 WebDAV 目录，可以列出历史版本任选一份恢复。
      保留策略和本地一致：最近 10 份、7 天内。
    </div>
    <div class="row" style="gap:9px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" data-act="cloud-upload" ${sy.url ? '' : 'disabled'}>上传当前配置</button>
      <button class="btn btn-sm" data-act="cloud-list" ${sy.url ? '' : 'disabled'}>查看云端备份 / 恢复</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">同步自律规则</div>
    <div class="card-sub">冲突时不会静默丢掉任何一边。</div>
    <div class="hint" style="line-height:2">
      · 每份配置都带 <code>updatedAt</code> 时间戳，同步时<b>新的覆盖旧的</b>（last-write-wins）。<br>
      · 「立即同步」会先读云端再比较：云端新就下载，本机新就上传，一样就跳过。<br>
      · 「云端 → 覆盖本机」是强制拉取，会丢掉本机未上传的改动，请谨慎使用。<br>
      · 账号密码只保存在本机配置文件里，不随配置上传。<br>
      · 默认地址是 https://dav.jianguoyun.com/dav/KingOfFocus/（目录会自动创建）；换别的网盘就按 Nextcloud 的格式填 https://你的域名/remote.php/dav/files/用户名/目录/
    </div>
  </div>`;
}

/* ---------------- 视图：关于 / 开发者 ---------------- */
function viewAbout() {
  const d = S.data;
  if (!d) return '';
  const st = d.config.settings.update || {};
  const hasToken = !!d.hasToken;
  const quotaTxt = S.quota ? (S.quota.ok ? `${S.quota.remaining} / ${S.quota.limit}` : '读取失败') : '读取中…';

  return `
  <div class="mask-hero" style="align-items:center">
    <div style="display:flex;gap:18px;align-items:center">
      <div class="brand-mark" style="width:72px;height:72px;border-radius:var(--r-xl)"><img src="logo.png" alt="" /></div>
      <div>
        <div style="font-size:22px;font-weight:700;letter-spacing:.3px">${esc(d.appName || 'King Of Focus')}</div>
        <div class="hint" style="margin-top:6px">
          版本 <b style="color:var(--gold)">v${esc(d.version)}</b>
          <span class="muted">·</span> 本版本更新时间 <b>${esc(d.buildDate)}</b>
        </div>
      </div>
    </div>
    <div style="text-align:right">
      <div class="hint">开发者</div>
      <div style="font-size:16px;font-weight:600;margin-top:4px">${esc(d.developer)}</div>
    </div>
  </div>

  <div class="card" style="margin-top:14px">
    <div class="card-title">三端版本</div>
    ${'' /* 桌面端版本是本机真实版本；手机端/插件读的是上次检查更新时缓存的清单，
         没有缓存就如实说"还没检查过"，不编一个数字出来。 */}
    <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0">
      <div>
        <div style="font-size:12.5px">桌面端 <span class="badge green" style="margin-left:6px">当前运行</span></div>
        <div class="hint" style="margin-top:4px">Windows x64 · ${esc(d.buildDate)} 构建</div>
      </div>
      <b style="color:var(--gold)">v${esc(d.version)}</b>
    </div>
    ${(() => {
      const plats = (st.platforms || {});
      const row = (key, label, hint) => {
        const p = plats[key];
        if (!p || !p.version) {
          return `<div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
            <div><div style="font-size:12.5px">${label}</div>
            <div class="hint" style="margin-top:4px">${hint}</div></div>
            <span class="badge">未知</span></div>`;
        }
        return `<div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
          <div><div style="font-size:12.5px">${label}</div>
          <div class="hint" style="margin-top:4px">${hint}</div></div>
          <div class="row" style="gap:8px;align-items:center">
            <b>v${esc(p.version)}</b>
            <button class="btn btn-sm" data-act="open-url" data-url="${esc(p.url || '')}">下载</button>
          </div></div>`;
      };
      return row('android', '手机端', '同一个 Release 里的 APK，与桌面端共用备份格式')
        + row('chrome-extension', '浏览器插件', 'MV3 扩展，网页拦截与焦点上报')
        + `<div class="hint" style="padding-top:8px">${
          st.lastCheck
            ? '清单来自上次检查更新：' + new Date(st.lastCheck * 1000).toLocaleString()
            : '还没检查过更新——点下面的「检查更新」拉一次清单，这里就会显示三端版本。'
        }</div>`;
    })()}
  </div>

  <div class="card" style="margin-top:14px">
    <div class="card-title">项目</div>
    <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0">
      <div>
        <div style="font-size:12.5px">项目地址</div>
        <div class="hint" style="margin-top:4px">点击可直接在浏览器中打开</div>
      </div>
      <a href="#" data-act="open-repo" style="color:var(--gold);font-size:12.5px;text-decoration:none">${esc(d.repoUrl)} ↗</a>
    </div>
    <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
      <div><div style="font-size:12.5px">配置文件</div><div class="hint" style="margin-top:4px">${esc(d.configPath)}</div></div>
      <button class="btn btn-sm" data-act="open-cfg">打开</button>
    </div>
    <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">诊断信息</div>
        <div class="hint" style="margin-top:4px">版本、运行状态、最近日志和脱敏后的配置打包成一份文本。出问题时导出它发过来，比描述快得多。</div>
      </div>
      <button class="btn btn-sm" data-act="diag-export">导出</button>
    </div>
    <div class="row" style="justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
      <div><div style="font-size:12.5px">使用手册</div><div class="hint" style="margin-top:4px">右键怎么用、积分怎么算、睡眠时段怎么生效，都在这里</div></div>
      <button class="btn btn-sm" data-act="open-help">打开</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">这个版本改了什么</div>
    <div class="card-sub">只列会改变你手感的几条，细节看「帮助」。</div>
    <div class="evlist">
      <div class="ev"><span class="t">修复</span><span class="n">跨天拖动不再在中间那天多出幽灵时段（02:10–03:10 拖走就是拖走）</span></div>
      <div class="ev"><span class="t">交互</span><span class="n">右键分三档：表头 = 整天、段 = 只这一段、空白格 = 这一格</span></div>
      <div class="ev"><span class="t">新增</span><span class="n">图表显示范围；睡眠时段（锁定 + 倒计时关机 + 积分解锁）</span></div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">自动更新</div>
    <div class="card-sub">启动时检查 GitHub Releases，有新版本会弹窗提示；下载完成后自动退出、安装并重新启动。</div>

    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">本机更新通道</div>
        <div class="hint" style="margin-top:3px">
          <span>平台标识</span> <code>${esc(d.platform || 'windows-x64')}</code> ·
          <span>当前版本</span> <b>v${esc(d.version)}</b>
        </div>
      </div>
      <span class="badge">只收桌面端安装包</span>
    </div>
    <div class="hint" style="line-height:1.9;padding:10px 0;border-bottom:1px solid var(--line)">
      桌面端只读更新清单里 windows-x64 那一条，四道校验都要过。<br>
      校验平台标识、包类型、版本号、sha256：对不上就不下载。<br>
      宁可停在提示上，也不去找别的平台的包。<br>
      手机端与插件的版本和下载入口在「关于」页的「三端版本」里。
    </div>

    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">启动时检查更新</div>
        <div class="hint" style="margin-top:3px">最近一次检查：${st.lastCheck ? new Date(st.lastCheck * 1000).toLocaleString() : '还没检查过'}</div>
      </div>
      <div class="switch" data-act="update-enabled"><input type="checkbox" ${st.enabled ? 'checked' : ''}><i></i></div>
    </div>

    <div style="padding:12px 0;border-bottom:1px solid var(--line)">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
        <div>
          <div style="font-size:12.5px">GitHub 个人访问令牌</div>
          <div class="hint" style="margin-top:3px">填了可以提升 API 额度（未登录 60 次/小时，登录后 5000 次/小时）</div>
        </div>
        <div class="badge ${S.quota && S.quota.ok && S.quota.remaining > 100 ? 'green' : 'red'}">
          剩余额度 ${esc(quotaTxt)}
        </div>
      </div>
      <div class="add-row" style="margin-bottom:0">
        <input type="password" id="ghToken" placeholder="${hasToken ? '已设置（留空则不修改）' : '粘贴 ghp_ 开头的令牌'}" autocomplete="off" spellcheck="false" />
        <button class="btn" data-act="token-doc" title="如何获取令牌">?</button>
        <button class="btn btn-primary" data-act="save-token">保存</button>
        <button class="btn btn-sm" data-act="quota-refresh">刷新额度</button>
        ${hasToken ? '<button class="btn btn-sm btn-danger" data-act="clear-token">清除</button>' : ''}
      </div>
      <div class="hint" style="margin-top:8px">
        令牌只保存在本机，界面上<b>不回显任何字符</b>，输入框始终是暗文。${hasToken ? '当前<b>已设置</b>。' : '当前<b>未设置</b>。'}点 <b>?</b> 打开 GitHub 官方教程。
      </div>
    </div>

    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div>
        <div style="font-size:12.5px">检查更新</div>
        <div class="hint" style="margin-top:3px">${st.skippedVersion ? '已跳过版本：' + esc(st.skippedVersion) : '当前没有跳过任何版本'}</div>
      </div>
      <div class="row" style="gap:8px">
        ${st.skippedVersion ? '<button class="btn btn-sm" data-act="clear-skip">取消跳过</button>' : ''}
        <button class="btn btn-primary btn-sm" data-act="check-update">立即检查</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- 更新弹窗 ---------------- */
function showUpdateModal(info, manual) {
  const a = info.asset || {};
  const size = a.size ? (a.size / 1024 / 1024).toFixed(1) + ' MB' : '未知大小';
  const notes = (info.notes || '').slice(0, 1200);
  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal">
      <div class="modal-hd">
        <h3>发现新版本 v${esc(info.latest)}</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="row" style="gap:10px;margin-bottom:14px;flex-wrap:wrap">
          <span class="badge gold">当前 v${esc(info.current)}</span>
          <span class="badge green">最新 v${esc(info.latest)}</span>
          <span class="badge">${esc(size)}</span>
          ${info.platformLabel ? `<span class="badge">${esc(info.platformLabel)}</span>` : ''}
          ${a.name ? `<span class="badge blue">${esc(a.name)}</span>` : ''}
        </div>
        ${info.platform ? `<div class="hint" style="margin-bottom:10px">
          只下载本平台（${esc(info.platform)}）的安装包：包名、类型、版本、sha256 四项都和更新清单核对过。
        </div>` : ''}
        ${notes ? `<div class="note" style="max-height:220px;overflow:auto;white-space:pre-wrap">${esc(notes)}</div>`
                : '<div class="hint">这个版本没有写更新说明。</div>'}
        ${!a.url ? '<div class="note" style="border-left-color:var(--red);margin-top:12px">该版本还没有上传安装包，暂时无法自动更新。</div>' : ''}
        <div id="upProgressWrap" class="hidden" style="margin-top:16px">
          <div style="height:6px;background:var(--inset-bg);border-radius:var(--r-pill);overflow:hidden">
            <div id="upBar" style="height:100%;width:0;background:var(--cc-fill);transition:width .2s"></div>
          </div>
          <div class="hint" id="upText" style="margin-top:8px">准备下载…</div>
        </div>
      </div>
      <div class="modal-ft">
        ${manual ? '' : `<button class="btn" data-act="skip-version" data-v="${esc(info.latest)}">跳过这个版本</button>`}
        <button class="btn" data-act="close-modal">稍后提醒</button>
        <button class="btn btn-primary" data-act="do-update"
          data-url="${esc(a.url || '')}" data-name="${esc(a.name || 'KingOfFocus-Setup.exe')}"
          data-size="${Number(a.size) || 0}" data-sha="${esc(a.sha256 || '')}">
          下载并安装
        </button>
      </div>
    </div>
  </div>`;
}

function setProgress(pct, text) {
  const w = $('#upProgressWrap');
  if (w) w.classList.remove('hidden');
  const b = $('#upBar');
  if (b) b.style.width = Math.max(0, Math.min(100, pct)) + '%';
  const t = $('#upText');
  if (t && text) t.textContent = text;
}

/* ---------------- 自律结束 · 恭喜弹窗 ---------------- */
const PRAISE = [
  '你今天的样子，比昨天更像你想成为的人。',
  '这一段专注，已经赢了昨天刷手机的自己。',
  '能坐下来的人，最后都走得挺远。',
  '自律不是煎熬，是你终于开始对自己好。',
  '别人看不见的这段时间，会变成看得见的差距。',
  '你没有辜负这段时间，一次都没有。',
  '保持住——这已经是很多人做不到的事了。',
  '专注的每一分钟，都在给你攒底气。',
  '这就是「说到做到」的样子。',
  '很棒，真的。继续。',
  '你证明了自己能行，这比什么都重要。',
  '今天这一局，你赢了。',
  '安静的坚持最狠，你正在做这件事。',
  '没有白坐的，都在长成你的本事。',
];

function showCelebrate(c) {
  const secs = c.secs || 0;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  const dur = h > 0 ? `${h} 小时 ${m} 分` : `${Math.max(1, m)} 分钟`;
  const praise = PRAISE[Math.floor(Math.random() * PRAISE.length)];

  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="width:520px;text-align:center">
      <div class="modal-bd" style="padding:38px 34px 26px">
        <div style="font-size:44px;line-height:1;margin-bottom:14px">🎉</div>
        <div style="font-size:13px;color:var(--text-3);letter-spacing:2px">本 轮 完 成</div>
        <div style="font-size:30px;font-weight:750;margin:12px 0 4px;color:var(--gold);font-variant-numeric:tabular-nums">
          ${dur}
        </div>
        <div style="font-size:12.5px;color:var(--text-2);margin-bottom:22px">
          ${esc(c.rules || '自律自律规则')} · ${(c.blocks || 0) > 0
            ? `被打断 ${c.blocks} 次`
            : '全程没有破功'}
        </div>
        <div class="note" style="text-align:left;font-size:13px;line-height:1.9">
          ${esc(praise)}
        </div>
        <div class="hint" style="margin-top:16px">
          这一段的专注已经换成积分，去「总览」看看你现在攒了多少。
        </div>
      </div>
      <div class="modal-ft" style="justify-content:center">
        <button class="btn btn-primary" data-act="close-modal">继续加油</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- 视图：帮助 ---------------- */
function viewHelp() {
  const d = S.data;
  const v = d ? d.version : '0.0.2';
  const dt = d ? d.buildDate : '';
  const sec = (t, body) => `<div class="card">
      <div class="card-title">${t}</div>
      <div class="card-sub" style="margin-bottom:8px">${body}</div>
    </div>`;

  return `
  <div class="note" style="margin-bottom:16px">
    <b>使用手册</b> · 与 v${esc(v)} 同步更新（${esc(dt)}）。改动了功能，这一页会跟着一起改。
  </div>

  ${sec('1 · 三步开始', `
    <div>最省事的路：设置 → 新手引导</div>
    <div>三步：什么时候学（写时段）/ 哪些不该打开（建一条规则）/ 可以先试 25 分钟。</div>
    <div>它建的东西和你手建的是同一套，之后照样能在「自律时段」「自律规则」里改；重走一遍只覆盖向导写过的那一套。</div>
    <div>手动来也行：① 到「自律规则」新建一条 → ② 加软件 / 加网站 → ③ 拖出它在自律时间内的生效范围。</div>
    打开开关后，<b>只有自律时间内</b>它才会拦；自律时间之外完全静默。
  `)}

  ${sec('2 · 自律规则与生效', `
    <div>一条自律规则 = 一份名单（软件 / 网站 / 例外），不带时间表。</div>
    <div>什么时候算自律时间，只由「自律时段」那一页决定；规则只负责"自律时间里不能开什么"。</div>
    <div>自律时间之外它完全静默，自律时间内它一律生效（休息段除外）。</div>
    <div>生效类型：黑名单（名单里的不许开）、白名单（只有名单里的能开，其他前台窗口都会被关）、两者同时（名单里的照样拦，例外里的放行）。</div>
  `)}

  ${sec('3 · 番茄与提醒', `
    <div>番茄在「自律时段」里按小时配：每个小时都可以设「专注 N 分钟 / 休息 M 分钟」，锚点是整点。</div>
    <div>休息期间所有自律规则都暂停拦截（软件和网页都放开），时间到自动锁回，HUD 上的圆点会变绿并显示"休息中"。</div>
    <div>提醒在「设置 → 提醒」：学习结束前 X 分钟、休息结束前 Y 分钟各响一次（0~120 分钟，0 = 不发），休息提醒可以单独关。</div>
    <div>触发时主界面弹提示、HUD 上的倒计时变金色闪烁。</div>
  `)}

  ${sec('4 · 生效时间段：右键改哪里，就只改哪里', `
     <div>完整图表里有三种右键目标，每张菜单顶部都写着"作用于 …"，三档互不越界。</div>
    <div class="note" style="margin:10px 0 0;line-height:2">
      <div>右键日期表头（周一 / 周二…）= 整天：弹出来第一眼就是这一天排了什么（每段的起止、时长、节奏，可逐段取消），下面才是「选中整天」「清空整天」这类整天级操作，只作用于这一天 0:00–24:00。</div>
    <div>图表右上角的「完整展示」开关：开着时整张表一次铺满、不用滚动；关掉回到固定行高，可以滚着看细节。</div>
      <div>右键某一段 = 时段：只作用于这一段（段首到段尾，跨小时也完整），可改时长、起止分钟，或「取消这一段」（两步确认）。</div>
      <div>右键空白格 = 格子：只作用于这一小时，把它选上并设定起止分钟。</div>
    </div>
    <div>一句话：点得越具体，作用范围越小——不会出现"右键一段、却把一整天重排"的情况。</div>
    <div>拖选是"从起点到终点的一段连续区间"，松手即提交；贴着 0:00 / 24:00 的段只属于当天，不会牵连相邻那天。</div>
    <div>按住某一段的上边缘或下边缘（5px 内，光标变成上下箭头）可以拉长或缩短它；最短一格，最长到显示范围的尽头。</div>
    <div>图表顶部还能设「显示范围」：只看 07:00–23:00 也行，只影响显示，范围外的时段照样生效。</div>
  `)}

  ${sec('5 · 睡眠管理', `
    <div>和自律时段是两件事：那边管"白天什么时候不许玩"，这里管"夜里这台机器该关着了"。</div>
    <div>到了睡眠时段，开机 / 唤醒后会全屏锁定、限制所有功能，倒计时（默认 10 分钟，可改）结束自动关机。</div>
    <div>锁定期内设置改不了、程序也退不掉。想现在用，只能用积分解锁买断一段时间（价格在卡片里配）。</div>
    <div>可以有多段：比如午睡 13:00–14:00 只关机不锁屏，夜间 23:00–07:00 才全屏锁定。点「＋ 添加时段」就多一段。</div>
    <div>每段都能单独设「生效周期」：每天、仅工作日、指定星期几。</div>
    <div>每天适合固定作息；仅工作日适合周末晚睡晚起；指定适合「只在周日晚上早睡」这类安排。</div>
    <div>切周期只改「哪几天生效」，时间、锁屏、开机后多久关机都不会被改动。</div>
    <div>前提是程序在运行；睡眠时段之外它什么都不做。</div>
    <div>睡眠到点后会锁定、会关机，但<b>不会</b>替你开机——软件叫不醒一台关着的电脑（那要在 BIOS 里设定时开机）。</div>
    <div>想在自律时自动开好工作窗口，用「自律规则 → 自动打开」：那里会在每个专注段开始时把软件 / 网页摆好。</div>
  `)}

  ${sec('6 · 固化与积分', `
    <div>「固化」打开后，生效期间不能退出程序、不能改任何设置，任务管理器会被自动关掉；进程被杀掉会被守护进程在 2 秒内拉回来。</div>
    <div>解除只有两条路：时段结束，或者用积分解锁。</div>
    <div>专注每分钟 +1 分；自律时段按分钟买（15 分/分钟起，当天第 n 次 ×1.4）。</div>
    <div>睡眠时段按段买断（单价 × 分钟数，各自在卡片里配）。</div>
    <div>固化只在自律时间内生效，且自律时段本身的结束时间就是最晚解封时刻，不会把自己永久锁死。</div>
  `)}

  ${sec('7 · 专注遮罩', `
    <div>选一个目标窗口，其余区域被遮罩盖住；不透明度 20%–100% 实时可调，没有任何动画，开关是瞬时到位。</div>
    <div>两种开启方式：全局快捷键（默认 Ctrl+Alt+K，可在遮罩页改，被占用会报错），或者「跟随自律模式」——自律一开始自动开、结束自动关。</div>
    <div>手动开遮罩时，屏幕上会出现桌面 HUD（它压在遮罩之上）：大数字是"这次遮罩已经开了多久"，下面一行是"今天已专注多久"；连续坐满 90 分钟会改成一句"起来走两步？"。</div>
    <div>HUD 左上角那个「＋」是记一笔：想到什么先点一下、打一行字回车，不会打断你，之后在「分心事件」页逐条处理。</div>
    <div>记一笔的按钮只在「设置 → 分心事件」开着时出现；它挂在 HUD 上，所以自律时段里也能用。</div>
  `)}

  ${sec('8 · 统计与报告', `
    <div>每秒采样一次前台窗口；按「自律模式开启 / 未开启」两套数据独立记录，互不混合。</div>
    <div>前台是浏览器且插件上报过，就记到域名上，否则记到 exe 上。统计页显示的是软件名（取自程序版本信息）和页面标题，同一个网址下的多个页面会按网址归并成一行。</div>
    <div>「自律模式开启」的口径有四个：自律规则生效 / 在专注段里 / 固化锁定 / 手动开着专注遮罩。</div>
    <div>人离开超过 60 秒（无键鼠输入）的那段时间会被扣回来，不算进任何一边。</div>
    <div>报告在日/周/月/年结束后自动生成，也可以手动生成。程序停了几周再打开，中间那几期会一次补齐。</div>
    <div>三种口径：只看开启、只看未开启、两者汇总（同一应用/域名秒数直接相加）。</div>
  `)}

  ${sec('9 · 备份与云同步', `
    <div>本机备份是完整备份：规则、时段、积分、遮罩、睡眠、HUD、语录、提醒、自启……全都在里面，换台电脑恢复就是原样搬过去。</div>
    <div>手机端读不懂的那部分会原样忽略，不影响跨设备往返。</div>
    <div>文件在软件目录下的 king of focus back，只保留最近 10 份、7 天内的，超出自动删。</div>
    <div>设了密码用 AES-256-GCM（两端都能开），没设密码就是明文 JSON——设置页会常驻一条警告。</div>
    <div>改过备份密码？旧备份是用当时那个密码加密的。恢复时如果解不开，会弹一个输入框问你要"当初的密码"，用它能恢复，而且不会改动你现在设置里的密码。</div>
    <div>云端备份走你自己的 WebDAV：上传后可以列出所有历史版本，任选一份恢复。「立即同步」只同步自律规则和设置，不做版本归档。</div>
    <div>手机互通：两端导出的是同一种文件（同样的字段、同样的加密信封）；桌面端用「导出跨设备备份…」/「从文件恢复…」，手机端在「设置 → 备份与恢复」填同一个密码。</div>
    <div>恢复时选「覆盖」（整份替换）或「合并」（只补缺的）。</div>
  `)}

  ${sec('10 · 常见问题', `
    <b>拦截没反应？</b> 目标程序是管理员权限，就右键以管理员身份运行本程序。<br>
    <b>网页没拦住？</b> 插件没装或没连上，看侧边栏「浏览器插件」状态。<br>
    <b>右键怎么只改了一段？</b> 这是设计：段右键只管那一段；要改整天请右键日期表头。<br>
    <b>想临时放过自己？</b> 用「总览 → 积分兑换」解锁当前这一段（固化了才需要）。<br>
    <b>数据在哪？</b> 全在软件目录的 <code>king of focus data</code>，整个文件夹拷走就能迁移。
  `)}

  ${sec('11 · 出问题了怎么反馈', `
    <div>「关于 → 诊断信息 → 导出」会生成一份文本：版本、系统、当前状态、最近日志，以及脱敏后的配置（网盘密码、备份口令、更新令牌都会打码）。</div>
    <div>出问题时把这份文件发过来，比描述"它有时候不管用"有用得多——日志里能看到规则有没有命中、钩子有没有起来、云同步报了什么错。</div>
    <div>程序崩溃时还会在 logs 目录里留一份 crash-时间.txt，带调用栈。</div>
    <div>日志超过 1.5MB 会自动滚成 app.1.log，不会无限长大。</div>
  `)}

  <div class="row" style="gap:9px;margin-top:4px">
    <button class="btn" data-act="open-repo">查看项目主页</button>
    <button class="btn" data-act="open-cfg">打开配置目录</button>
  </div>`;
}

