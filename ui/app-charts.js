/* 饼图绘制
 *
 * 由 app.js 按连续切片拆出（见 docs/release-notes 里那一版说明）。
 * 加载顺序就是原来的自上而下顺序：**不要**调整 <script> 的先后，
 * 顶层 const / function 共享同一个全局词法环境，换顺序会改变求值时机。
 */
'use strict';

/* ---------------- 饼图 ---------------- */
/** 把一侧的标签按"理想位置"推挤成互不重叠的一列，返回新的 y（与输入同序）。
 *
 *  三步，和绘图库里那套一样：
 *   1. 按理想 y 排序，从上往下保证最小间距；
 *   2. 再从下往上兜住底边（否则最后几条会出画布）；
 *   3. 条目多到连底边都兜不住时，按可用高度均分压缩——宁可挤一点，也不能越界。
 */
function packLabels(wantY, top, bottom, gap) {
  const n = wantY.length;
  if (!n) return [];
  const order = wantY.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);

  let cursor = top;
  for (const x of order) {
    x.y = Math.max(x.y, cursor);
    cursor = x.y + gap;
  }
  let limit = bottom;
  for (let k = n - 1; k >= 0; k--) {
    if (order[k].y > limit) order[k].y = limit;
    limit = order[k].y - gap;
  }
  if (order[0].y < top) {
    const step = n > 1 ? Math.min(gap, (bottom - top) / (n - 1)) : 0;
    order.forEach((x, k) => { x.y = top + k * step; });
  }

  const out = new Array(n);
  order.forEach((x) => { out[x.i] = x.y; });
  return out;
}

/** 文字超宽就截断加省略号（canvas 不会自动省略，会直接画出画布） */
function clipText(ctx, str, maxW) {
  if (!str) return '';
  if (ctx.measureText(str).width <= maxW) return str;
  let t = str;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** 分钟数 → "09:12" */
function hhmmOfMin(min) {
  const m = Math.max(0, Math.min(1440, Math.round(min || 0)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** 量文字宽度用的离屏 ctx：布局阶段就要知道每个标签占多宽（命中测试也靠它） */
let __pieM = null;
function pieMeasure(text, font) {
  if (!__pieM) __pieM = document.createElement('canvas').getContext('2d');
  __pieM.font = font;
  return __pieM.measureText(String(text == null ? '' : text)).width;
}

/** 按**实测字宽**截断（布局阶段就定下来，画的时候不再变，避免悬停时文字长度跳动） */
function clipText2(str, font, maxW) {
  const t0 = String(str == null ? '' : str);
  if (!t0 || pieMeasure(t0, font) <= maxW) return t0;
  let t = t0;
  while (t.length > 1 && pieMeasure(t + '…', font) > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** 时长文案：英文界面走短格式（canvas 不经过 DOM 翻译，混着写会露出中文） */
function pieDur(secs) {
  return I18N.getLang() === 'en' ? fmtDurShort(secs) : fmtDur(secs);
}

const PIE_W = 660;
/** 一行两排字（名称 + 时长）的最小行距 */
const PIE_ROW = 34;
/** 画布上下留白。
 *
 *  这就是"折线"的根源：以前上下只留 24px，标签被压在最上/最下一行，
 *  而顶部扇区的弧点本来就在 cy - rOut 附近 —— 标签比弧点还高一截，
 *  连线只能先折出去再折回来，看着就是"中途突兀一拐"。
 *  留 72px 之后，最高/最低的标签与扇区顶部基本同高，线几乎是直的。 */
const PIE_PAD = 72;
const PIE_NAME_FONT = '600 11.5px "Microsoft YaHei UI", sans-serif';
const PIE_DUR_FONT = '10.5px "Microsoft YaHei UI", sans-serif';
const PIE_NAME_FONT_ON = '700 13px "Microsoft YaHei UI", sans-serif';
const PIE_DUR_FONT_ON = '600 11px "Microsoft YaHei UI", sans-serif';

/** 扇图布局：扇区 + 标签位置一次性算好，绘制时不再重排。
 *
 *  为什么必须"算一次、画很多次"：
 *   · 悬停只改颜色 / 字重 / 字号，**位置一个都不动**，否则鼠标一过就"跳一下"；
 *   · 连线要正交且互不交叉，靠的是"标签行序 == 扇区角序"，
 *     这个顺序在这里定死，之后每帧都照着画。
 */
function pieLayout(slices, total) {
  const items = slices.slice(0, 8).map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] }));
  const restItems = slices.slice(8);
  const restSecs = restItems.reduce((a, b) => a + b.secs, 0);
  if (restSecs > 0) {
    const hours = new Array(24).fill(0);
    for (const s of restItems) {
      const hs = s.hours || [];
      for (let h = 0; h < 24; h++) hours[h] += hs[h] || 0;
    }
    items.push({
      key: '__rest',
      label: I18N.t('其他'),
      secs: restSecs,
      category: 'rest',
      color: '#4a5468',
      hours,
      // 点开「其他」也要看得到时间段：把成员的段并过来并带上名字，
      // 否则这一块就是"有总时长、没有明细"的死角。
      spans: restItems.reduce((acc, s) => acc.concat((s.spans || []).map((sp) => ({
        date: sp.date, f: sp.f, t: sp.t, label: s.label || s.key,
      }))), []),
      spanCount: restItems.reduce((a, s) => a + (s.spanCount || (s.spans || []).length), 0),
      members: restItems.map((s) => s.label || s.key),
    });
  }

  const sum = items.reduce((a, b) => a + b.secs, 0);
  const cx = PIE_W / 2;
  // 画布加宽到 660、环也放大一点：左右各留 190px 放标签，两侧对称
  const rOut = 104;
  const rIn = 66;

  const arcs = [];
  let ang = -Math.PI / 2;
  for (const it of items) {
    const a = sum > 0 ? (it.secs / sum) * Math.PI * 2 : 0;
    arcs.push({ it, a0: ang, a1: ang + a, mid: ang + a / 2 });
    ang += a;
  }

  // 先按角度分左右两列，才知道要几行、画布该多高
  const sides = { left: [], right: [] };
  for (const arc of arcs) {
    const cos = Math.cos(arc.mid);
    const sin = Math.sin(arc.mid);
    sides[cos >= 0 ? 'right' : 'left'].push({ arc, cos, sin });
  }
  const rows = Math.max(sides.left.length, sides.right.length, 1);
  // 高度同时满足两件事：
  //   · 圆环本身要放得下（2 × (rOut + 留白)）；
  //   · 行数多时按行加起来，而不是把行距压扁。
  // 这样无论 1 项还是 9 项，顶部/底部都有 PIE_PAD 的呼吸空间，
  // 标签的"理想高度"就是扇区弧点的高度 —— 不需要绕行。
  const H = Math.max(2 * (rOut + PIE_PAD), PIE_PAD * 2 + rows * PIE_ROW);
  const cy = H / 2;
  const TOP = PIE_PAD;
  const BOT = H - PIE_PAD;

  const labels = [];
  for (const side of ['left', 'right']) {
    const list = sides[side];
    if (!list.length) continue;
    const right = side === 'right';
    // 理想高度直接用**弧点所在的高度**（rOut + 3，与 p0y 同一个半径）：
    // 以前这里多加了 9px，标签天生就比弧点低一截，再叠加挤动，线就必须折一下。
    const ys = packLabels(list.map((x) => cy + x.sin * (rOut + 3)), TOP, BOT, PIE_ROW);
    list.forEach((x, i) => { x.y = ys[i]; });

    // 行序 = 角序（同一侧 sin 单调），按 y 排序拿到的就是"从上到下"；
    // 让每条线的竖直段按这个顺序依次外扩，就保证了任意两条线都不相交。
    const ordered = list.slice().sort((a, b) => a.y - b.y);
    const anchorX = right ? cx + rOut + 48 : cx - rOut - 48;
    const room = right ? (PIE_W - 10) - (anchorX + 8) : (anchorX - 8) - 10;
    // 悬停时字号大一档（11.5 → 13，10.5 → 11），预留余量，
    // 这样"放大"不会让文字突然被截断成另一句。
    const maxW = Math.max(40, room * 0.86);

    ordered.forEach((x, i) => {
      const it = x.arc.it;
      const nameTxt = clipText2(it.label || '', PIE_NAME_FONT, maxW);
      const pct = sum ? ((it.secs / sum) * 100).toFixed(1) : '0.0';
      const durTxt = clipText2(pieDur(it.secs) + ' · ' + pct + '%', PIE_DUR_FONT, maxW);
      labels.push({
        idx: arcs.indexOf(x.arc),
        it,
        right,
        y: x.y,
        anchorX,
        colX: right ? cx + rOut + 14 + i * 2.4 : cx - rOut - 14 - i * 2.4,
        p0x: cx + x.cos * (rOut + 3),
        p0y: cy + x.sin * (rOut + 3),
        straight: Math.abs(x.y - (cy + x.sin * (rOut + 3))) <= 14,
        pts: pieLeadPts(
          cx + x.cos * (rOut + 3),
          cy + x.sin * (rOut + 3),
          right ? 1 : -1,
          anchorX,
          x.y,
        ),
        nameTxt,
        durTxt,
        textW: Math.max(pieMeasure(nameTxt, PIE_NAME_FONT), pieMeasure(durTxt, PIE_DUR_FONT)),
      });
    });
  }

  return { items, arcs, labels, sum, cx, cy, rOut, rIn, W: PIE_W, H, total };
}

/** 一条引导线的路径点（采样成折线，绘制和命中用同一份数据）。
 *
 *  两种形状：
 *   · 标签与弧点几乎同高（|dy| ≤ 14）→ 一条**直线**，中途没有任何拐点；
 *   · 被别的标签挤开了 → 一条**两端都是水平切线**的三次贝塞尔（S 形）。
 *
 *  为什么不再用"斜线 + 直角/圆角 + 水平"：那种折法在落差大时会出现一个
 *  看得见的尖角，也就是用户说的"中途突兀的弯折"。S 形曲线两端都与水平相切，
 *  视觉上是从圆周"顺出去"，再平滑地贴到标签那一行，没有折角。
 */
function pieLeadPts(p0x, p0y, dir, anchorX, y) {
  // **一律直线**：从扇区外缘直接连到标签的锚点，中途不拐弯、不带弧度。
  // 上下留白（PIE_PAD）已经把标签的高度对齐到弧点，所以直线基本都是水平或微斜的；
  // 只有被同侧标签挤开时才会略微倾斜 —— 但仍然是**一条直线**，不会出现"弯"。
  // （dir 保留在签名里，调用方不用改；命中测试和绘制共用这份点。）
  return [[p0x, p0y], [anchorX, y]];
}

/** 点到线段距离（命中测试用） */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 战报图：1080×1350 竖版海报，画完交给后端存 PNG。
 *
 * 为什么是竖版：这图是给人**发出去**的（群里/朋友圈），竖图占屏最大。
 * 为什么用 canvas 而不是 HTML 转图片：不引第三方库、不依赖布局引擎，
 * 画出来是什么就是什么，缩放/DPI 都不会走样。
 */
function drawPoster() {
  const cur = currentSlices();
  if (!cur || !cur.total) return null;
  const cv = document.createElement('canvas');
  cv.width = 1080;
  cv.height = 1350;
  const g = cv.getContext('2d');
  const SANS = '"Segoe UI","Microsoft YaHei",system-ui,sans-serif';
  const pad = 88;

  const bg = g.createLinearGradient(0, 0, 0, 1350);
  bg.addColorStop(0, '#0b0d12');
  bg.addColorStop(0.55, '#11151d');
  bg.addColorStop(1, '#0b0d12');
  g.fillStyle = bg;
  g.fillRect(0, 0, 1080, 1350);

  const glow = g.createRadialGradient(880, 110, 20, 880, 110, 540);
  glow.addColorStop(0, 'rgba(77,141,255,.30)');
  glow.addColorStop(1, 'rgba(77,141,255,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 1080, 720);

  g.fillStyle = '#4d8dff';
  g.font = `600 22px ${SANS}`;
  g.fillText('K I N G   O F   F O C U S', pad, 120);

  g.fillStyle = '#eef2fa';
  g.font = `700 64px ${SANS}`;
  g.fillText('自律战报', pad, 210);

  g.fillStyle = '#8b94a7';
  g.font = `400 24px ${SANS}`;
  g.fillText(`${(S.stats && S.stats.start) || ''} — ${(S.stats && S.stats.end) || ''}`, pad, 256);

  const total = cur.total || 0;
  const hh = Math.floor(total / 3600);
  const mm = Math.round((total % 3600) / 60);
  g.fillStyle = '#ffffff';
  g.font = `800 150px ${SANS}`;
  g.fillText(String(hh), pad, 432);
  const hw = g.measureText(String(hh)).width;
  g.fillStyle = '#9aa4b8';
  g.font = `600 42px ${SANS}`;
  g.fillText('小时', pad + hw + 18, 432);
  g.fillStyle = '#eef2fa';
  g.font = `600 42px ${SANS}`;
  g.fillText(`${mm} 分钟`, pad + hw + 18 + 100, 432);

  g.fillStyle = '#6f7890';
  g.font = `400 24px ${SANS}`;
  g.fillText('本区间自律时长', pad, 482);

  const r = (S.data && S.data.rhythm) || {};
  const cards = [
    ['连续达标', `${r.streak || 0} 天`],
    ['今日目标', (r.todayGoalsTotal || 0) > 0 ? `${r.todayGoalsDone}/${r.todayGoalsTotal}` : '—'],
    ['本周', fmtDur(r.weekOnSecs || 0)],
  ];
  let x = pad;
  cards.forEach(([k, v]) => {
    roundRect(g, x, 544, 280, 132, 18, 'rgba(255,255,255,.045)', 'rgba(255,255,255,.07)');
    g.fillStyle = '#8b94a7';
    g.font = `400 22px ${SANS}`;
    g.fillText(k, x + 28, 594);
    g.fillStyle = '#ffffff';
    g.font = `700 38px ${SANS}`;
    g.fillText(v, x + 28, 644);
    x += 296;
  });

  g.fillStyle = '#8b94a7';
  g.font = `400 24px ${SANS}`;
  g.fillText('花时间最多', pad, 754);

  const top = (cur.slices || []).slice(0, 3);
  const max = Math.max(1, ...top.map((s) => s.secs || 0));
  const barW = 1080 - pad * 2;
  top.forEach((s, i) => {
    const y = 806 + i * 104;
    const name = String(s.label || s.key || '—');
    g.fillStyle = '#eef2fa';
    g.font = `500 28px ${SANS}`;
    g.fillText(name.length > 18 ? name.slice(0, 18) + '…' : name, pad, y);
    g.fillStyle = '#8b94a7';
    g.font = `400 24px ${SANS}`;
    g.textAlign = 'right';
    g.fillText(fmtDur(s.secs || 0), 1080 - pad, y);
    g.textAlign = 'left';
    roundRect(g, pad, y + 18, barW, 12, 6, 'rgba(255,255,255,.06)', null);
    roundRect(g, pad, y + 18, Math.max(12, barW * ((s.secs || 0) / max)), 12, 6, '#4d8dff', null);
  });

  g.fillStyle = 'rgba(255,255,255,.06)';
  g.fillRect(pad, 1178, barW, 1);
  const best = bestBlock();
  g.fillStyle = '#c9d2e3';
  g.font = `400 28px ${SANS}`;
  g.fillText(best ? `最常在 ${best} 进入状态` : '把时间花在哪儿，是看得见的。', pad, 1238);
  g.fillStyle = '#5d6678';
  g.font = `400 22px ${SANS}`;
  g.fillText(`King Of Focus · ${todayStr()}`, pad, 1292);

  return cv.toDataURL('image/png');
}

function roundRect(g, x, y, w, h, r, fill, stroke) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
}

/** 画一帧。`hover` = 高亮项索引（-1 无），`t` = 高亮强度 0..1。 */
function drawPieFrame(cv) {  const d = cv.__pie;
  if (!d) return;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, d.W, d.H);

  const { cx, cy, rOut, rIn, sum, arcs, labels } = d;
  const hover = d.hover;
  const t = d.t || 0;
  const dim = 1 - 0.6 * t;           // 非高亮项压暗的程度
  const cText = cssVar('--text');
  const cDim = cssVar('--text-3');
  const cStroke = cssVar('--panel-a');

  if (sum <= 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
    ctx.strokeStyle = cssVar('--line-2');
    ctx.lineWidth = rOut - rIn;
    ctx.stroke();
  } else {
    for (let i = 0; i < arcs.length; i++) {
      const a = arcs[i];
      const on = hover === i;
      const fo = d.focus === i;   // 被选中的那一项（点过扇区/日历色块）
      const grow = on ? 5 * t : 0;
      // 悬停优先：没悬停时按"聚焦"把其余项压暗，选中状态一眼可见
      ctx.globalAlpha = (hover < 0 || on) ? 1 : dim;
      if (hover < 0 && d.focus >= 0 && !fo) ctx.globalAlpha = 0.42;
      ctx.beginPath();
      ctx.arc(cx, cy, rOut + grow, a.a0, a.a1);
      ctx.arc(cx, cy, rIn, a.a1, a.a0, true);
      ctx.closePath();
      ctx.fillStyle = a.it.color;
      ctx.fill();
      ctx.strokeStyle = cStroke;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (fo && hover < 0) {
        // 聚焦项压一道"字色"描边（深色下亮边、浅色下暗边）—— 不动几何，只加一圈
        ctx.beginPath();
        ctx.arc(cx, cy, rOut + 2, a.a0, a.a1);
        ctx.strokeStyle = cText;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (on && t > 0.02) {
        // 外沿再压一道淡亮边：高亮的扇区轮廓更清楚
        ctx.beginPath();
        ctx.arc(cx, cy, rOut + grow - 1, a.a0, a.a1);
        ctx.strokeStyle = cText;
        ctx.globalAlpha = 0.32 * t;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // 中心文字（不参与高亮，避免闪）
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = cText;
  ctx.font = '600 19px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(d.center, cx, cy - 7);
  ctx.fillStyle = cDim;
  ctx.font = '11px "Microsoft YaHei UI", sans-serif';
  ctx.fillText(d.sub, cx, cy + 13);

  if (sum <= 0) return;

  /* ── 引导线：一段斜线（扇区 → 本行拐点）+ 一段水平线（拐点 → 标签） ──
   *
   *  为什么这样能保证"零交叉"：
   *   ① 同侧标签的**行序**与**扇区角序**严格一致（pieLayout 里定的），
   *      所以从圆周发出的斜线是一把"扇"，后一行的落点一定在前一行下面，互不穿越；
   *   ② 每条线的竖直落点各自占一列（colX 每行外扩 2.4px），
   *      第 i 行的水平段整段都在第 j<i 行竖直落点的外侧，够不着；
   *   ③ 水平段各在自己的行高上（行距 34px），彼此不重叠。
   *
   *  以前是「扇区 → 水平 → 竖直 → 水平」的三段折线：拐点挤在圆周外侧，
   *  数据一倾斜（比如一项占 95%）就有大量短横线互相穿过，看着就是一团乱麻。
   */
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const lb of labels) {
    const on = hover === lb.idx;
    const fo = d.focus === lb.idx;
    const alpha = hover < 0 ? (d.focus >= 0 ? (fo ? 1 : 0.3) : 0.82) : (on ? 1 : 0.16);

    ctx.beginPath();
    ctx.moveTo(lb.pts[0][0], lb.pts[0][1]);
    for (let i = 1; i < lb.pts.length; i++) ctx.lineTo(lb.pts[i][0], lb.pts[i][1]);
    // 先描一层底色再压本色：并行的段也能分辨（同地图路线）
    ctx.strokeStyle = cStroke;
    ctx.globalAlpha = alpha * (on ? 0.95 : 0.72);
    ctx.lineWidth = on ? 4.8 : 3.6;
    ctx.stroke();
    ctx.strokeStyle = lb.it.color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 两端各一个小圆点：靠标签那头表示"这一行"，靠扇区那头表示"指的就是这块"
    const dot = hover < 0 || on ? 1 : 0.3;
    ctx.beginPath();
    ctx.arc(lb.anchorX, lb.y, on ? 3.2 : 2, 0, Math.PI * 2);
    ctx.arc(lb.p0x, lb.p0y, on ? 2.4 : 1.6, 0, Math.PI * 2);
    ctx.fillStyle = lb.it.color;
    ctx.globalAlpha = dot;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* ── 标签：全部压在线之上，线不会穿过文字 ────────────────────────── */
  for (const lb of labels) {
    const on = hover === lb.idx;
    const tx = lb.right ? lb.anchorX + 8 : lb.anchorX - 8;
    ctx.textAlign = lb.right ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = hover < 0 || on ? 1 : 0.38;

    // 悬停 = 放大一号 + 加粗 + 染成扇区色。
    // 字号变化**不会**影响其它标签：位置在 pieLayout 里已经算死，
    // canvas 也不会像 DOM 那样回流，所以"放大"和"不跳动"可以同时成立。
    ctx.font = on ? PIE_NAME_FONT_ON : PIE_NAME_FONT;
    ctx.fillStyle = on ? lb.it.color : cText;
    ctx.fillText(lb.nameTxt, tx, lb.y - (on ? 8.5 : 7));

    ctx.font = on ? PIE_DUR_FONT_ON : PIE_DUR_FONT;
    ctx.fillStyle = on ? cText : cDim;
    ctx.fillText(lb.durTxt, tx, lb.y + (on ? 8.5 : 7));
    ctx.globalAlpha = 1;
  }
}

/** 指数逼近地推动高亮强度，起停都有一点过渡，不会"啪"地切换 */
function pieAnimate(cv) {
  const d = cv.__pie;
  if (!d || cv.__raf) return;
  const step = () => {
    d.t += (d.target - d.t) * 0.35;
    if (Math.abs(d.target - d.t) < 0.02) d.t = d.target;
    drawPieFrame(cv);
    cv.__raf = d.t === d.target ? 0 : requestAnimationFrame(step);
  };
  cv.__raf = requestAnimationFrame(step);
}

/** 命中测试：扇区本体、两行标签文字、引导线的**水平段和竖直段**都算。
 *
 *  以前只按"行"判（|y - 行高| <= 13 且越过圆周就算命中），于是：
 *   · 指到一条线旁边的空白也会亮；
 *   · 反过来，指在竖直段上（离行很远）却命中不到 —— 用户说"线点不着"就是这个。
 *  现在按每段线的真实几何走廊判，标签则按**实测文字宽度**判。
 */
function pieHit(cv, ev) {
  const d = cv.__pie;
  if (!d) return -1;
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return -1;
  const x = (ev.clientX - r.left) * (d.W / r.width);
  const y = (ev.clientY - r.top) * (d.H / r.height);

  for (const lb of d.labels) {
    const tx = lb.right ? lb.anchorX + 8 : lb.anchorX - 8;
    const x1 = lb.right ? tx + lb.textW : tx - lb.textW;
    const xa = Math.min(tx, x1) - 4;
    const xb = Math.max(tx, x1) + 4;
    // ① 两行文字（±16 覆盖 13px 名称 + 11px 时长）
    if (y >= lb.y - 17 && y <= lb.y + 16 && x >= xa && x <= xb) return lb.idx;
    // ② 引导线：线只有 1.4px 宽，按到各段折线的距离给 6px 容差才点得着
    for (let i = 1; i < lb.pts.length; i++) {
      const a0 = lb.pts[i - 1];
      const b0 = lb.pts[i];
      if (distToSeg(x, y, a0[0], a0[1], b0[0], b0[1]) <= 6) return lb.idx;
    }
  }

  const dx = x - d.cx;
  const dy = y - d.cy;
  const dist = Math.hypot(dx, dy);
  if (dist >= d.rIn - 4 && dist <= d.rOut + 10) {
    let a = Math.atan2(dy, dx);
    while (a < -Math.PI / 2) a += Math.PI * 2;
    for (let i = 0; i < d.arcs.length; i++) {
      const g = d.arcs[i];
      if (a >= g.a0 && a < g.a1) return i;
    }
  }
  return -1;
}

/** 展开面板：这一项在**哪些时间段**用过。
 *
 *  数据来自分钟级的 `spans`（后端采样时按连续使用分段）。
 *  这里把**所有**段都列出来（列表自身可滚动）——以前只列 12 段，
 *  用户看到的是"明细不全"。真的被后端裁剪时，标题会如实写"共 N 段（列出 M 段）"。
 */
function pieDetailHtml(slice, sum) {
  if (!slice) return '';
  const pct = sum ? ((slice.secs / sum) * 100).toFixed(1) : '0.0';
  const spans = slice.spans || [];
  const hours = slice.hours || [];
  const totalSpans = slice.spanCount || spans.length;

  const bars = Array.from({ length: 24 }, (_, h) => {
    const v = hours[h] || 0;
    const height = Math.max(2, Math.min(100, (v / 3600) * 100));
    return `<i class="${v ? '' : 'off'}" style="height:${height}%" title="${pad(h)}:00 ${I18N.getLang() === 'en' ? Math.round(v / 60) + ' min' : '用了 ' + Math.round(v / 60) + ' 分钟'}"></i>`;
  }).join('');

  const rows = spans.length
    ? spans.map((sp) => {
      const d = String(sp.date || '').slice(5);
      const mins = Math.max(0, (sp.t || 0) - (sp.f || 0));
      const who = sp.label ? `<span class="pd-l">${esc(sp.label)}</span>` : '';
      return `<li>${who}<span class="pd-d">${esc(d)}</span>
        <span class="pd-t">${hhmmOfMin(sp.f)} – ${hhmmOfMin(sp.t)}</span>
        <span class="pd-m">${fmtDur(mins * 60)}</span></li>`;
    }).join('')
    : '<li class="pd-none">这一版开始才有分段记录，更早的数据只有小时分布。</li>';

  const cut = totalSpans > spans.length ? `（列出 ${spans.length} 段）` : '';
  const mem = slice.members && slice.members.length
    ? `<div class="pd-mem">这一块含 ${slice.members.length} 项：${esc(slice.members.join('、'))}</div>`
    : '';

  return `<div class="pie-detail">
    <div class="pd-hd">
      <span class="sw" style="background:${slice.color || 'var(--gold)'}"></span>
      <b>${esc(slice.label || '')}</b>
      <span class="pd-total">${fmtDur(slice.secs)}</span>
      <span class="pd-pct">${pct}%</span>
      <button class="pd-x" data-act="pie-close" title="收起">×</button>
    </div>
    <div class="pd-hours">
      <div class="pd-bars">${bars}</div>
      <div class="pd-ticks">${[0, 6, 12, 18].map((h) => `<span>${pad(h)}:00</span>`).join('')}</div>
    </div>
    ${mem}
    <div class="pd-sub">使用时段 · 共 ${totalSpans} 段${cut}</div>
    <ul class="pd-list">${rows}</ul>
  </div>`;
}

/** 时长扇图：甜甜圈 + 正交引导线 + 悬停强调 + 点击展开明细 */
function drawPie(canvas, slices, total, opts) {
  if (!canvas) return;
  const lay = pieLayout(slices, total);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(lay.W * dpr);
  canvas.height = Math.round(lay.H * dpr);
  canvas.style.width = lay.W + 'px';
  canvas.style.height = 'auto';            // 高度按比例走，窄屏不会被压扁
  canvas.style.touchAction = 'manipulation';

  const prev = canvas.__pie;
  // 数据没变（只是重画）时保留高亮；换了一批数据就把高亮清掉，免得指错项
  const same = prev && prev.items.length === lay.items.length
    && prev.items.every((it, i) => it.key === lay.items[i].key);
  const keep = same ? prev.hover : -1;

  // 选中哪一项由外部状态（S.calHit）决定：重画不能把"选中"丢掉
  const fk = opts && opts.focusKey;
  const focus = fk ? lay.items.findIndex((it) => it.key === fk) : -1;
  canvas.__pie = {
    ...lay,
    center: opts && opts.center ? opts.center
      : (I18N.getLang() === 'en' ? fmtDurShort(total)
        : fmtDurShort(total).replace('h', ' 小时 ').replace('m', ' 分')),
    sub: I18N.t((opts && opts.sub) || '合计'),
    hover: keep,
    focus,
    t: keep >= 0 ? 1 : 0,
    target: keep >= 0 ? 1 : 0,
    raf: 0,
  };

  drawPieFrame(canvas);
  if (canvas.__pieBound) return;
  canvas.__pieBound = true;

  const setHover = (idx) => {
    const d = canvas.__pie;
    if (!d || d.hover === idx) return;
    d.hover = idx;
    d.target = idx >= 0 ? 1 : 0;
    canvas.style.cursor = idx >= 0 ? 'pointer' : 'default';
    pieAnimate(canvas);
  };

  // 指针事件：桌面和触屏统一走 Pointer Events
  canvas.addEventListener('pointermove', (ev) => {
    // 手指没有"悬停"：触屏上移动是滚页面，点亮只会让画面乱跳
    if (ev.pointerType === 'touch') return;
    setHover(pieHit(canvas, ev));
  });
  canvas.addEventListener('pointerleave', () => setHover(-1));
  canvas.addEventListener('pointercancel', () => setHover(-1));
  canvas.addEventListener('pointerup', (ev) => {
    // 触屏点完要收掉高亮，否则会"粘"在某一项上
    if (ev.pointerType === 'touch') setHover(-1);
  });
  canvas.addEventListener('pointerdown', (ev) => {
    const idx = pieHit(canvas, ev);
    if (idx < 0) return;
    if (ev.pointerType === 'touch') setHover(-1);   // 触屏点完不留悬停态
    const it = canvas.__pie.items[idx];
    // 「其他」是聚合块，没有单一分类可指：面板照开，但不做逐块聚焦
    const key = it.key && it.key !== '__rest' ? it.key : '';
    const host = document.querySelector('#pieDetail');
    const dk = key || ('i' + idx);
    const again = !!host && host.dataset.key === dk;
    if (host) {
      if (again) {
        host.dataset.key = '';
        host.innerHTML = '';
      } else {
        host.dataset.key = dk;
        host.innerHTML = pieDetailHtml(it, canvas.__pie.sum);
        if (window.I18N && I18N.apply) I18N.apply(host);   // 面板是点击后才生成的，得单独翻一次
      }
    }
    // 关键联动：右侧「当日日历」立刻切到这一项用时最多的那天，并高亮它的所有时段
    statsFocus(again ? '' : key, again ? '' : bestDayOf(it));
  });
}

