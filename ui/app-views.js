/* 视图：总览、自律规则与编辑器、图表拖选、自律时段、专注遮罩
 *
 * 由 app.js 按连续切片拆出（见 docs/release-notes 里那一版说明）。
 * 加载顺序就是原来的自上而下顺序：**不要**调整 <script> 的先后，
 * 顶层 const / function 共享同一个全局词法环境，换顺序会改变求值时机。
 */
'use strict';

/* ---------------- 视图：总览 ---------------- */
function viewOverview() {
  const d = S.data;
  if (!d) return '<div class="empty is-loading">加载中…</div>';
  const rt = d.runtime;
  const on = rt.disciplineOn;
  const next = rt.nextChange;
  const locked = !!rt.locked;
  const pts = d.points || { balance: 0, price: 15, count: 0, unlockUntil: 0 };
  // 睡眠时段也吃积分（按段买断），卡片上要把两套价格摆在一起，用户才知道钱花在哪
  const sl = (d.config && d.config.settings && d.config.settings.sleep) || {};
  const sleepPts = sl.enabled && +sl.unlockPrice > 0 ? +sl.unlockPrice * (+sl.unlockMin || 30) : 0;

  const phase = rt.breakOn ? '休息中' : on ? '专注中' : '自由时间';
  const phaseLeft = rt.breakLeft || 0;
  const mmss = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;

  const lockBanner = locked ? `
    <div class="note" style="border-left:3px solid var(--red);background:rgba(255,92,92,.07);border-color:rgba(255,92,92,.22);margin-bottom:16px">
      <b style="color:var(--red)">🔒 自律固化中</b>
      ${esc(rt.lockNames.join('、'))} 正在生效，<b>${esc(rt.lockUntilText || '时段结束')}</b> 之前：
      无法退出程序、无法修改任何设置，任务管理器 / 进程管理器会被自动关闭。
      <div style="margin-top:6px;color:var(--text-3)">想提前结束，只能用积分解锁。</div>
    </div>` : '';

  const unlockBanner = pts.unlockUntil && pts.unlockUntil * 1000 > Date.now() ? `
    <div class="note" style="margin-bottom:16px">
      <b>已用积分解锁</b> · 到 ${new Date(pts.unlockUntil * 1000).toLocaleTimeString()} 之前所有拦截暂停。
    </div>` : '';

  const chips = rt.active.length
    ? rt.active.map((a) => `<span class="rule-chip"><span class="dot"></span>${esc(a.name)}
        ${ruleBadge(a)}</span>`).join('')
    : '<span class="muted">暂无生效自律规则。到「自律规则」里新建一条——它只会在自律时间内生效。</span>';

  const evs = (rt.events || []).slice(0, 7);
  const evHtml = evs.length
    ? evs.map((e) => `<div class="ev">
        <span class="t">${hhmm(e.ts)}</span>
        <span class="badge ${e.kind === 'site' ? 'blue' : e.kind === 'browser' ? 'blue' : 'gold'}">${e.kind === 'site' ? '网页' : e.kind === 'browser' ? '浏览器' : '软件'}</span>
        <span class="n" title="${esc(e.target)}">${esc(e.target)}</span>
        <span class="muted" style="font-size:11px">${esc(e.rule)}</span>
      </div>`).join('')
    : '<div class="empty"><span class="ico">◷</span>还没有拦截记录。等你设置的时段到了，这里会出现被拦下的应用和网页。</div>';

  const maskOn = d.mask.on;

  // —— 今天三件套：现在在干嘛 / 今天的进度 / 一个主按钮 ——
  // 总览上信息很多（语录、生效规则、拦截记录…），但"我现在该做什么"这一层
  // 以前是没有的：打开软件要先自己扫一遍才知道。这一块只回答三个问题。
  const en = I18N.getLang() === 'en';
  const br = d.brief || {};
  const sk = d.stake || {};
  const stakeAmt = sk.amount || 0;
  const stakeUnit = sk.stake || 10;
  const stakeBonus = sk.bonus || 2;
  const segOn = !!br.inSegment;
  const segLeft = br.segLeft || 0;
  const planMin = br.planMin || 0;
  const onMin = br.onMin || 0;
  const pct = planMin > 0 ? Math.min(100, Math.round((onMin / planMin) * 100)) : 0;
  const goal = br.goal || '';
  const nextAt = br.nextAt || '';
  const nextIn = br.nextInSecs > 0 ? br.nextInSecs : 0;
  const brState = segOn ? (rt.breakOn ? '休息中' : '专注中') : '空闲';
  // 上一段（已结束、写过目标、6 小时内）：总览上直接问"做到了吗"。
  // 为什么不等周复盘：记忆是有保质期的，隔一天再问，答案就不准了。
  const rv = br.review || null;
  const rvState = rv ? (rv.state || '') : '';
  const rvRow = rv && (!segOn || Number(rv.seg) !== undefined && rv.seg !== br.seg)
    ? `<div class="tb-review">
        <span class="tb-rv-goal" title="${esc(rv.goal)}">${en ? 'Last window' : '上一段'}「${esc(rv.goal)}」</span>
        ${[['done', en ? 'Done' : '做完了'], ['partial', en ? 'Half' : '做了一半'], ['missed', en ? 'Not done' : '没做成']]
          .map(([v, t]) => `<button class="rv-btn${rvState === v ? ' on' : ''}" data-act="goal-state" data-seg="${rv.seg}" data-st="${v}"${rvState === v ? ' data-on="1"' : ''}>${t}</button>`)
          .join('')}
      </div>`
    : '';
  const brLine = segOn
    ? `<span class="tb-left">${br.segLabel ? esc(br.segLabel) + ' · ' : ''}还剩 ${fmtDurShort(segLeft)}</span>`
    : nextAt
      ? `<span class="tb-left">下一段 <b>${esc(nextAt)}</b> 开始${nextIn ? `（${fmtDurShort(nextIn)}后）` : ''}</span>`
      : '<span class="tb-left">今天没有排时段</span>';
  const todayBar = `
  <div class="today-bar">
    <div class="tb-l">
      <div class="tb-state">
        <span class="tb-dot${segOn ? ' on' : ''}"></span>
        <b>${brState}</b>
        ${brLine}
        ${br.blocks ? `<span class="tb-blk">被打断 ${br.blocks}</span>` : ''}
      </div>
      <div class="tb-goal${goal ? '' : ' ghost'}" title="${
        segOn ? '在 HUD 那一行上点一下就能写' : '开始一段之后可以写'
      }">${goal ? esc(goal) : (segOn
        ? (en ? 'No goal yet — click that line on the HUD' : '还没写这一段的目标（在 HUD 上点一下就能写）')
        : (en ? 'Goals are written on the HUD' : '这一段的目标可以在 HUD 上写'))}</div>
      ${rvRow}
    </div>
    <div class="tb-p">
      <div class="tb-num">${fmtDurShort(onMin * 60)}<span class="muted"> / ${
        planMin ? fmtDurShort(planMin * 60) : (en ? 'not planned' : '未排')
      }</span></div>
      <div class="tb-track"><i style="width:${pct}%"></i></div>
      ${br.goalTotal
        ? `<div class="tb-goalstat">${en
            ? `${br.goalDone}/${br.goalTotal} goals done`
            : `${br.goalTotal} 个目标，做完 ${br.goalDone} 个`}</div>`
        : ''}
    </div>
    <div class="tb-a">
      ${segOn
        ? (stakeAmt > 0
            ? `<div class="tb-stake" title="跑完退还本金；一次都没被打断再加 20%">${
                en ? `Staked ${stakeAmt} pts` : `已押 ${stakeAmt} 分`
              }<span class="muted">${en ? ` · returns ${stakeAmt + stakeBonus}` : ` · 跑完退 ${stakeAmt + stakeBonus}`}</span></div>`
            : `<button class="btn btn-sm" data-act="stake" title="押上 ${stakeUnit} 分：跑完退还，用积分解锁提前退出则没收">${
                en ? `Stake ${stakeUnit}` : `押 ${stakeUnit} 分`
              }</button>`)
        : ''}
      ${segOn
        ? `<button class="btn btn-primary btn-sm" data-act="today-mask">打开遮罩</button>`
        : `<button class="btn btn-primary btn-sm" data-act="today-clock">去排时段</button>`}
    </div>
  </div>`;

  const q = quoteView();
  const qN = ((d.config.settings || {}).customQuotes || []).length;
  const feed = quoteActiveFeed();
  const srcTip = q.home
    ? `点击打开 ${q.home}`
    : '内置句子，没有网址';
  return `
  ${lockBanner}${unlockBanner}
  ${todayBar}
  <section class="hub-quote${S.quoteBusy ? ' busy' : ''}" aria-label="激励语录" data-quote-box="1">
    <div class="qmark">“</div>
    <div class="qbody">
      <div class="qtext">${esc(q.text)}</div>
      <div class="qmeta">
        <span class="qsrc ${q.src}${q.home ? ' link' : ' plain'}" data-act="quote-open-src"
          title="${esc(srcTip)}">${esc(q.feedName)}</span>
        ${q.from ? `<span class="qfrom">—— ${esc(q.from)}</span>` : ''}
        ${q.offline ? '<span class="qoff" title="联网没取到，这一条来自本地预置">离线 · 本地精选</span>' : ''}
        <span class="qhint">右键可换来源</span>
      </div>
    </div>
    <div class="qops">
      <button class="btn btn-sm" data-act="quote-next" ${S.quoteBusy ? 'disabled' : ''}
        title="${feed.kind === 'local' ? '在本地预置里换一条（不联网）' : `立刻从 ${esc(feed.name)} 取一条`}">${S.quoteBusy ? '正在获取…' : '换一条'}</button>
      <button class="btn btn-sm" data-act="quote-src-menu" title="切换 / 添加语录来源">来源 · ${esc(feed.name)}</button>
      <button class="btn btn-sm" data-act="quote-manage">我的语录${qN ? ` · ${qN}` : ''}</button>
      <button class="btn btn-sm" data-act="quote-add-new" title="直接写一句新的">＋ 添加</button>
    </div>
  </section>

  <div class="hero">
    <div class="hero-main">
      <div class="hero-label">当前状态</div>
      <div class="hero-state ${on || rt.breakOn ? 'on' : ''}">${phase}</div>
      <div class="hero-desc">${rt.breakOn
        ? `休息 ${mmss(phaseLeft)}，这段时间自律规则是放开的，时间到自动锁回去。`
        : on
          ? `自律规则里的软件与网页已被拦住：${esc(rt.active.map((a) => a.name).join('、'))}`
          : '现在不在自律时间，自律规则静默中。'}</div>
      <div class="hero-count">
        <div><div class="n">${rt.blockedApps}</div><div class="l">今日拦截软件</div></div>
        <div><div class="n">${rt.blockedSites}</div><div class="l">今日拦截网页</div></div>
        <div><div class="n">${on ? fmtCountdown(next).replace(' 后', '') : '—'}</div><div class="l">${on ? '距状态变化' : '下次生效'}</div></div>
      </div>
    </div>
    <div class="stat-mini">
      <div class="mini">
        <div class="l">自律积分</div>
        <div class="v" style="color:var(--gold)">${pts.balance}</div>
        <div class="l" style="margin-top:6px">每分钟 +1 分 · 今日已解锁 ${pts.count} 次</div>
      </div>
      <div class="mini">
        <div class="l">专注遮罩</div>
        <div class="v" style="color:${maskOn ? 'var(--gold)' : 'var(--text-2)'}">${maskOn ? '已开启' : '未开启'}</div>
        <div class="l" style="margin-top:6px">${maskOn ? esc(d.config.settings.mask.targetTitle || '目标窗口') : '选一个窗口，把其他都盖住'}</div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">积分兑换 <span class="badge gold">${pts.balance} 分</span></div>
    <div class="card-sub">专注 1 分钟 = 1 分。</div>
    <div class="card-sub">积分只用来解开正在生效的那一段时间：自律时段按分钟买，睡眠时段按整段买断。</div>
    <div class="card-sub">都只影响当下这一轮，不会改排班，也不会连带别的时段。</div>
    <div class="grid-2" style="margin:12px 0 4px">
      <div class="mini">
        <div class="l">自律时段</div>
        <div class="v" style="color:var(--gold)">${pts.price}<span style="font-size:12px;font-weight:400"> 分/分钟</span></div>
        <div class="l" style="margin-top:6px">${en
          ? `Unlock #${(pts.count || 0) + 1} today; price grows ×1.4 (15, 21, 29…)`
          : `今天第 ${(pts.count || 0) + 1} 次，单价 ×1.4 递增（第 1 次 15，第 2 次 21，第 3 次 29）`}</div>
        <div class="l" style="margin-top:4px;color:var(--gold)">${en
          ? `${pts.price} pts/min · ${pts.balance >= pts.price
              ? `you can buy ${Math.floor(pts.balance / pts.price)} min`
              : `${pts.price - pts.balance} pts short of 1 min`}`
          : `现在 ${pts.price} 分/分钟 · ${pts.balance >= pts.price
              ? `余额够买 ${Math.floor(pts.balance / pts.price)} 分钟`
              : `还差 ${pts.price - pts.balance} 分才能买 1 分钟`}`}</div>
      </div>
      <div class="mini">
        <div class="l">睡眠时段</div>
        <div class="v" style="color:${sleepPts ? 'var(--gold)' : 'var(--text-2)'}">${sleepPts ? `${sleepPts}<span style="font-size:12px;font-weight:400"> 分</span>` : '未开启'}</div>
        <div class="l" style="margin-top:6px">${sleepPts ? `一次买断 ${sl.unlockMin} 分钟（单价 ${sl.unlockPrice} 分/分钟）` : '在「自律时段 → 睡眠管理」里开启'}</div>
      </div>
    </div>
    <div class="row" style="align-items:center">
      <button class="btn btn-primary" data-act="open-unlock">用积分解锁</button>
      <span class="hint">${on || rt.breakOn ? '解锁期间所有拦截暂停，倒计时结束自动恢复' : (sl.enabled ? '现在不在自律 / 睡眠时段里，暂时不需要解锁' : '现在没有生效的自律规则，暂时不需要解锁')}</span>
    </div>
  </div>

  <div class="card">
    <div class="card-title">生效中的自律规则</div>
    <div class="card-sub">自律规则只在<b>自律时间</b>（自律时段的专注段）内生效，其余时间一律静默。</div>
    <div>${chips}</div>
  </div>

  <div class="grid-2" style="margin-top:16px;align-items:start">
    <div class="card">
      <div class="card-title">最近拦截</div>
      <div class="card-sub">只记录最近 240 条，含时间、类型、对象与命中自律规则。</div>
      <div class="evlist">${evHtml}</div>
    </div>
    <div class="card">
      <div class="card-title">今日概览</div>
      <div class="card-sub">每 15 秒落盘一次，关掉窗口也不会丢。</div>
      <div class="evlist">
        <div class="ev"><span class="t">软件</span><span class="n">${rt.blockedApps} 次拦截</span></div>
        <div class="ev"><span class="t">网页</span><span class="n">${rt.blockedSites} 次拦截</span></div>
        <div class="ev"><span class="t">插件</span><span class="n">${rt.hb ? `${esc(rt.hbBrowser || '浏览器')} · ${Math.max(0, Math.round(Date.now() / 1000 - rt.hb))} 秒前心跳` : '尚未连接'}</span></div>
        <div class="ev"><span class="t">数据</span><span class="n muted" style="font-size:11px">${esc(d.dataPath || '')}</span></div>
      </div>
    </div>
  </div>`;
}

/** 一条自律规则的「生效类型」。
 *
 * 三档，列表、卡片、编辑器标题都用这一份，避免三处各写一套 if：
 *   blacklist 自律规则       —— 名单里的软件 / 网站被拦下，其余放行
 *   whitelist 白名单       —— 只有名单里的能用，其余全拦
 *   both      两者同时生效 —— 名单里照样拦，同时「例外」作为白名单放行
 */
const RULE_KINDS = {
  blacklist: {
    label: '黑名单',
    short: '黑名单',
    cls: 'gold',
    note: '名单里的软件 / 网站会被拦下，其余放行',
  },
  whitelist: {
    label: '白名单',
    short: '白名单',
    cls: 'red',
    note: '只有名单里的能用，其余一律拦掉',
  },
  both: {
    label: '黑名单 + 白名单',
    short: '黑+白',
    cls: 'blue',
    note: '名单里的照样拦，「例外」里的放行',
  },
};
const ruleKind = (r) => RULE_KINDS[(r && r.mode) || 'blacklist'] || RULE_KINDS.blacklist;
/** 列表里那个一眼能认出来的类型标记 */
function ruleBadge(r) {
  const k = ruleKind(r);
  return `<span class="badge kind" title="${esc(k.label)}：${esc(k.note)}">`
    + `<i class="kd ${k.cls}"></i>${k.label}</span>`;
}

/* ---------------- 视图：自律规则 ---------------- */
/** 把一段 [a,b) 按番茄配置切成「专注 / 休息」交替的连续小段。
 *  口径与后端 sched::pomodoro_state 一致：周期从时段起点开始算。 */
function slSplit(r, a, b) {
  const brk = (r && r.brk) || {};
  const work = +brk.workMin || 0, rest = +brk.breakMin || 0;
  const pomo = brk.kind === 'pomodoro' && work > 0 && rest > 0;
  if (!pomo) return [{ a, b, type: 'focus' }];
  const cycle = work + rest;
  const out = [];
  let cur = a;
  while (cur < b) {
    const phase = (cur - a) % cycle;
    const isBreak = phase >= work;
    let nxt;
    if (isBreak) nxt = cur + (cycle - phase);
    else nxt = cur + (work - phase);
    if (nxt > b) nxt = b;
    out.push({ a: cur, b: nxt, type: isBreak ? 'break' : 'focus' });
    cur = nxt;
  }
  return out;
}
/** 某一天的色块序列（跨夜时段算到次日 00:00 之前） */
function slDaySegs(r, day) {
  const slots = ((r && r.schedule) || [])[day] || [];
  const out = [];
  for (const s of slots) {
    const end = s.end <= s.start ? 1440 : s.end;
    for (const seg of slSplit(r, s.start, end)) out.push(seg);
  }
  out.sort((x, y) => x.a - y.a);
  return out;
}

/* 把一周的时段压成「每天 / 工作日 / 周一」这类人话摘要 */
function schedCompact(sched) {
  if (!sched || sched.every((d) => !d || !d.length)) return '全天生效';
  const groups = [];
  for (let i = 0; i < 7; i++) {
    const slots = (sched[i] || []).map((s) => `${mins(s.start)}-${mins(s.end)}`).join(',');
    if (!slots) continue;
    let g = groups.find((x) => x.slots === slots);
    if (!g) { g = { slots, days: [] }; groups.push(g); }
    g.days.push(i);
  }
  return groups.map((g) => {
    let dn;
    if (g.days.length === 7) dn = '每天';
    else if (g.days.join() === '0,1,2,3,4') dn = '工作日';
    else if (g.days.join() === '5,6') dn = '周末';
    else dn = g.days.map((i) => DAYS[i]).join('/');
    return `${dn} ${g.slots}`;
  }).join('　');
}

/* 单条自律时段的迷你时间分布图（7 列 = 周一~周日，色块按专注/休息区分） */
function slMini(r) {
  const cols = DAYS.map((d, di) => {
    const bs = slDaySegs(r, di).map((s) => {
      const top = (s.a / 1440) * 100;
      const h = Math.max(3, ((s.b - s.a) / 1440) * 100);
      const bg = s.type === 'break' ? 'var(--green)' : (r.color || '#4d8dff');
      return `<i style="top:${top.toFixed(2)}%;height:${h.toFixed(2)}%;background:${esc(bg)}"></i>`;
    }).join('');
    return `<div class="sl-mini-col" title="${DAYS[di]}">${bs}</div>`;
  }).join('');
  return `<div class="sl-mini">${cols}</div>`;
}

/**
 * 总览"可见状态指纹"。
 *
 * 用途：`pull()` 每 1.5 秒拉一次状态，但屏幕上大多数时候什么都没变。
 * 比一下这个指纹，没变就整页不重绘——省掉 innerHTML 替换、图表重算和重排。
 *
 * 写它的规矩：**viewOverview() 读过的字段，这里都要有**。
 * 漏一个的代价是那一项最多旧 10 秒（不是错，只是不新），所以宁多勿少。
 * 只有"秒级噪音"要取整：心跳和倒计时按 10 秒量化，否则每拍都变、等于没省。
 */
function overviewSig() {
  const d = S.data;
  if (!d) return '';
  const rt = d.runtime || {};
  const br = d.brief || {};
  const ru = (v) => Math.round((Number(v) || 0) / 10);
  return [
    rt.disciplineOn ? 1 : 0,
    rt.breakOn ? 1 : 0,
    ru(rt.breakLeft),
    ru(rt.nextChange),
    rt.blockedApps || 0,
    rt.blockedSites || 0,
    rt.locked ? 1 : 0,
    (rt.lockNames || []).join(','),
    (rt.active || []).map((a) => a.name).join(','),
    (rt.events || []).length,
    (rt.events && rt.events[0] && rt.events[0].ts) || 0,
    ru(Date.now() / 1000 - (rt.hb || 0)),
    rt.hbBrowser || '',
    d.mask ? (d.mask.on ? 1 : 0) : 0,
    ((d.config && d.config.settings && d.config.settings.mask.targetTitle) || '').slice(0, 40),
    (d.points && d.points.balance) || 0,
    (d.points && d.points.price) || 0,
    (d.points && d.points.count) || 0,
    (d.points && d.points.unlockUntil) || 0,
    d.stake ? d.stake.amount || 0 : 0,
    br.inSegment ? 1 : 0,
    br.segLabel || '',
    ru(br.segLeft),
    br.planMin || 0,
    br.onMin || 0,
    br.goal || '',
    br.blocks || 0,
    br.goalTotal || 0,
    br.goalDone || 0,
    br.nextAt || '',
    ru(br.nextInSecs),
    br.review ? [br.review.seg, br.review.state, br.review.goal].join('|') : '',
    // 语录：换一条 / 搬运中 都要重绘
    S.quoteBusy ? 1 : 0,
    (S.data.quote && S.data.quote.text) || '',
    (S.data.quote && S.data.quote.from) || '',
    (S.data.quoteFrom || ''),
    ((d.config && d.config.settings && (d.config.settings.customQuotes || []).length) || 0),
  ].join('\u0001');
}

function viewRules() {
  const d = S.data;
  if (!d) return '';
  const rules = d.config.rules;
  const activeNames = new Set((d.runtime.active || []).map((a) => a.name));
  const hardLocked = !!d.runtime.locked;
  const locked = settingsFrozen();      // 固化中 或 自律时段生效中

  // 自律规则条目 = 纯名单：名称 + 软件 / 网站 / 例外 + 开关。
  // **不显示任何"时间范围"** —— 什么时候生效由「自律时段」统一决定，
  // 自律规则只管"自律时间里不能开什么"，两件事不混在一起。
  const item = (l) => `
    <div class="sl-item ${activeNames.has(l.name) ? 'active' : ''}" data-act="edit-rule" data-id="${l.id}" role="button" tabindex="0">
      <div class="sl-item-bar" style="background:${esc(l.color || '#4d8dff')}"></div>
      <div class="sl-item-main">
        <div class="sl-item-name">${esc(l.name)}
          ${ruleBadge(l)}
          ${l.hard ? '<span class="badge red">固化</span>' : ''}
          ${activeNames.has(l.name) ? '<span class="badge green">生效中</span>' : ''}
        </div>
        <div class="sl-item-meta">
          ${l.apps.length} 个软件 · ${l.sites.length} 个网站 · ${l.exceptions.length} 条例外
          ${l.autolaunch && l.autolaunch.enabled && (l.autolaunch.items || []).length
    ? ` · <b style="color:var(--cc-fill)">自动打开 ${l.autolaunch.items.length} 项</b>` : ''}
        </div>
      </div>
      <div class="sl-item-act">
        <div class="switch${locked ? ' locked' : ''}" data-act="toggle-rule" data-id="${l.id}"
             title="${locked ? (hardLocked ? '自律固化中，开关已锁定' : '自律时段生效中，开关已锁定') : '启用 / 停用'}">
          <input type="checkbox" ${l.enabled ? 'checked' : ''}><i></i>
        </div>
        <button class="btn btn-sm" data-act="rule-launch" data-id="${l.id}"
          title="进入自律时间时自动打开这些软件 / 网页">自动打开</button>
        <button class="btn btn-sm btn-danger" data-act="del-rule" data-id="${l.id}" ${locked ? 'disabled' : ''}>删除</button>
      </div>
    </div>`;

  const groups = [];
  const push = (title, note, arr) => {
    if (!arr.length) return;
    groups.push(`<div class="sl-group">
      <div class="sl-group-hd"><span class="sl-group-title">${title}</span><span class="muted">${note}</span></div>
      <div class="sl-grid">${arr.map(item).join('')}</div>
    </div>`);
  };
  // 按"生效类型"分组：三档各一组，顺序固定（黑 → 白 → 两者）
  push('黑名单', '自律时间里，名单里的软件 / 网站会被拦下，其余放行',
    rules.filter((l) => (l.mode || 'blacklist') === 'blacklist'));
  push('白名单', '自律时间里，只有名单里的能用，其余一律拦掉',
    rules.filter((l) => l.mode === 'whitelist'));
  push('黑名单 + 白名单同时生效', '名单里的照样拦，同时「例外」作为白名单放行',
    rules.filter((l) => l.mode === 'both'));

  const body = rules.length
    ? groups.join('')
    : '<div class="empty"><span class="ico">⚑</span>还没有自律规则。点右上角「新建自律规则」开始。</div>';

  const banner = hardLocked
    ? `<div class="note" style="border-left:3px solid var(--red);background:rgba(255,92,92,.07);border-color:rgba(255,92,92,.22);margin-bottom:16px">
    <b style="color:var(--red)">🔒 自律固化中</b>：${esc((d.runtime.lockNames || []).join('、'))} 正在生效，
    <b>${esc(d.runtime.lockUntilText || '时段结束')}</b> 之前所有开关都已置灰，改不了也关不掉。
  </div>`
    : (clockRunning() ? `<div class="note" style="border-left:3px solid var(--red);background:rgba(255,92,92,.07);border-color:rgba(255,92,92,.22);margin-bottom:16px">
    <b style="color:var(--red)">🔒 自律时段生效中</b>：这段时间自律规则开关整体锁定（开、关都不行），也不能删除条目、
    不能关掉「自律时段」本身——等这一段结束（或用积分解锁）之后才能改。
  </div>` : '');

  // 顶部常驻状态条：让"只在自律时间生效"这件事一眼可见，而不是藏在帮助里
  const fc = d.config.settings.focusClock || {};
  const statusBar = !fc.enabled
    ? `<div class="note" style="border-left:3px solid var(--gold);margin-bottom:14px">
        <b>自律时段没启用</b>：自律规则<b>只在自律时间内生效</b>，现在这个功能是整体静默的。
        先去「自律时段」把要自律的时段画出来，这里才会开始拦。
      </div>`
    : (d.runtime.clockOn
      ? `<div class="note" style="border-left:3px solid var(--green);margin-bottom:14px">
          <b style="color:var(--green)">● 自律时间进行中</b>：第 ${d.runtime.clockHour} 段专注中，下面的自律规则正在生效。
        </div>`
      : `<div class="note" style="border-left:3px solid var(--line);margin-bottom:14px">
          <b>当前不在自律时间</b>：自律规则只在「自律时段」的专注段内生效，
          其余时间（含番茄休息段）一律不拦。下面的开关可以先配好，到点自动生效。
        </div>`);

  return `
  ${banner}
  ${statusBar}
  <div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:16px">
    <div class="hint" style="max-width:660px">
      一条<b>自律规则</b> = 一份软件 / 网站名单 + 一张周时间表。<br>
      <b>生效前提是自律时间</b>：只有「自律时段」正在专注时才可能拦人；<br>
      时间表是在这之上再收窄——全空 = 自律时间内全程生效，画了格子就只在格子里生效。<br>
      点任意一条会打开独立弹窗，用图表方式查看和调整时间分布。
    </div>
    <button class="btn btn-primary" data-act="new-rule" ${hardLocked ? 'disabled' : ''}>+ 新建自律规则</button>
  </div>
  ${body}`;
}

/* ---------------- 自律规则条目编辑器 ---------------- */
/** 打开某条自律时段的独立弹窗（滴答清单图表式） */
function openSlotModal(id) {
  const d = S.data;
  if (!d) return;
  const src = d.config.rules.find((x) => x.id === id);
  if (!src) return;
  S.editing = JSON.parse(JSON.stringify(src));
  S.editingNew = false;
  S.editorTab = 'slot';
  S.modalMode = 'slot';
  renderSlotModal();
}

function renderSlotModal() {
  const r = S.editing;
  if (!r) return;
  // 自律规则弹窗 = **纯名单编辑**，不再有周时间表。
  // 时间只在「自律时段」排一次；这里只管"自律时间里不能开什么"。
  const html = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal wide tk-modal">
      <div class="modal-hd">
        <h3>${esc(r.name || '自律规则')}
          ${ruleBadge(r)}
          ${r.hard ? '<span class="badge red">固化</span>' : ''}
          ${r.enabled ? '<span class="badge green">已启用</span>' : '<span class="badge">未启用</span>'}
        </h3>
        <button class="close-x" data-act="close-editor">×</button>
      </div>
      <div class="modal-bd">
        <div class="row" style="gap:10px;margin-bottom:12px;align-items:center">
          <input type="text" id="ruleName" value="${esc(r.name)}" style="flex:1;font-size:14.5px;font-weight:650" placeholder="名字，例如：短视频与游戏" />
        </div>
        <div class="rule-kind-row">
          <span class="rk-lab">生效类型</span>
          <div class="seg">
            ${[['blacklist', '黑名单'], ['whitelist', '白名单'], ['both', '两者同时']].map(([v, t]) =>
              `<button class="${(r.mode || 'blacklist') === v ? 'active' : ''}" data-act="mode" data-mode="${v}"
                 title="${esc(RULE_KINDS[v].note)}">${t}</button>`).join('')}
          </div>
          <span class="rk-note">${esc(ruleKind(r).note)}</span>
        </div>
        <div class="note" style="margin-bottom:14px">
          生效时间由「<b>自律时段</b>」统一决定：<b>自律时间里，按上面的类型生效</b>；
          自律时间之外一律不拦。所以这里不需要、也不提供时间设置。
        </div>
        <div class="tk-info">
          <div><b>${r.apps.length}</b> 个软件</div>
          <div><b>${r.sites.length}</b> 个网站</div>
          <div><b>${r.exceptions.length}</b> 条例外</div>
          <div><b>${r.extraProtected && r.extraProtected.length ? r.extraProtected.length : 0}</b> 项额外保护</div>
        </div>
      </div>
      <div class="modal-ft">
        <button class="btn" data-act="slot-more">编辑名单…</button>
        <button class="btn" data-act="close-editor">取消</button>
        <button class="btn btn-primary" data-act="save-slot">保存</button>
      </div>
    </div>
  </div>`;
  $('#modalRoot').innerHTML = html;
}

function openEditor(id, isNew) {
  const d = S.data;
  if (!d) return;
  let rule;
  if (isNew) {
    rule = {
      id: 'r' + Date.now().toString(36),
      name: '新自律规则',
      enabled: false,
      mode: 'blacklist',
      apps: [],
      sites: [],
      exceptions: [],
      schedule: [[], [], [], [], [], [], []],
      lock: { kind: 'none', until: 0, password: '', chars: 20 },
      color: PALETTE[Math.floor(Math.random() * 4)],
      extraProtected: [],
      brk: { kind: 'none', workMin: 25, breakMin: 5 },
      hard: true,
    };
  } else {
    rule = JSON.parse(JSON.stringify(d.config.rules.find((x) => x.id === id)));
  }
  S.editing = rule;
  S.editingNew = !!isNew;
  S.editorTab = 'apps';
  S.modalMode = 'editor';
  renderEditor();
}

function renderEditor() {
  if (S.modalMode === 'slot') { renderSlotModal(); return; }
  renderFullEditor();
}

function renderFullEditor() {
  const r = S.editing;
  if (!r) return;
  const tabs = [
    ['apps', `软件 (${r.apps.length})`],
    ['sites', `网站 (${r.sites.length})`],
    ['exceptions', `网站例外 (${r.exceptions.length})`],
    ['lock', '固化'],
  ];

  let body = '';
  if (S.editorTab === 'apps') body = tabApps(r);
  if (S.editorTab === 'sites') body = tabSites(r);
  if (S.editorTab === 'exceptions') body = tabExceptions(r);
  if (S.editorTab === 'break') body = tabBreak(r);
  if (S.editorTab === 'lock') body = tabLock(r);

  const html = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal wide tk-modal">
      <div class="modal-hd">
        <h3>${S.editingNew ? '新建自律时段' : esc(r.name)}
          ${ruleBadge(r)}
          ${r.hard ? '<span class="badge red">固化</span>' : ''}
        </h3>
        <button class="close-x" data-act="close-editor">×</button>
      </div>
      <div class="modal-bd">
        <div class="row" style="gap:10px;margin-bottom:14px;align-items:center">
          <input type="text" id="ruleName" value="${esc(r.name)}" style="flex:1;font-size:14px;font-weight:600" placeholder="时段名称，例如：晚自习" />
          <div class="seg">
            ${[['blacklist', '黑名单'], ['whitelist', '白名单'], ['both', '两者同时']].map(([v, t]) =>
              `<button class="${(r.mode || 'blacklist') === v ? 'active' : ''}" data-act="mode" data-mode="${v}"
                 title="${esc(RULE_KINDS[v].note)}">${t}</button>`).join('')}
          </div>
        </div>
        ${r.mode === 'both' ? `<div class="note" style="margin-bottom:14px">
          <b>黑名单 + 白名单同时生效</b>：名单里的软件 / 网站照样被拦下；
          同时「例外」当作白名单用 —— 例外里的条目永远不会被这条规则拦。
        </div>` : ''}
        ${r.mode === 'whitelist' ? `<div class="note" style="margin-bottom:14px">
          <b>白名单</b>：生效时段内，只有下面名单里的软件可以打开，其他所有前台窗口都会被关掉。
          系统进程、资源管理器、本程序自身以及「设置 → 全局保护」里的进程不会被拦截。
        </div>` : ''}
        <div class="note" style="margin-bottom:14px">
          生效时间不在这里设：<b>「自律时段」决定什么时候进入自律时间</b>，
          这里只决定"自律时间里不能打开什么"。
        </div>
        <div class="tabs" style="margin-top:18px">${tabs.map(([k, n]) => `<button class="tab ${S.editorTab === k ? 'active' : ''}" data-act="editor-tab" data-tab="${k}">${n}</button>`).join('')}</div>
        ${body}
      </div>
      <div class="modal-ft">
        <button class="btn" data-act="close-editor">取消</button>
        <button class="btn btn-primary" data-act="save-editor">保存</button>
      </div>
    </div>
  </div>`;
  $('#modalRoot').innerHTML = html;
}

/* 滴答清单图表式时间分布：横轴 = 周一~周日，纵轴 = 00:00~24:00，色块 = 生效区间 */
function tkTimeVal(m) {
  const x = Math.max(0, Math.min(1440, +m || 0));
  if (x === 1440) return '24:00';
  return `${pad(Math.floor(x / 60) % 24)}:${pad(x % 60)}`;
}
function tkTimeParse(v) {
  const mt = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!mt) return null;
  const h = +mt[1], mm = +mt[2];
  if (h === 24 && mm === 0) return 1440;
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

function tabChart(r) {
  const axis = [];
  for (let h = 0; h <= 24; h += 3) {
    // 最后一格是 24:00（一天的结束），不能 %24 变成 00:00——
    // 那会让纵轴首尾都是 00:00，看起来像"刻度重复/错位"。
    const label = h === 24 ? '24:00' : `${pad(h)}:00`;
    const cls = h === 24 ? ' class="tk-axis-end"' : '';
    axis.push(`<span${cls} style="top:${(h / 24) * 100}%">${label}</span>`);
  }
  const cols = DAYS.map((d, di) => {
    const segs = slDaySegs(r, di);
    const blocks = segs.map((s) => {
      const top = (s.a / 1440) * 100;
      const h = Math.max(1.2, ((s.b - s.a) / 1440) * 100);
      const bg = s.type === 'break'
        ? 'repeating-linear-gradient(135deg, rgba(53,208,127,.85) 0 6px, rgba(53,208,127,.5) 6px 12px)'
        : esc(r.color || '#4d8dff');
      const label = `${mins(s.a)} - ${mins(s.b)}`;
      return `<div class="tk-seg ${s.type}" style="top:${top.toFixed(3)}%;height:${h.toFixed(3)}%;background:${bg}" title="${label}"><em>${label}</em></div>`;
    }).join('');
    const slots = (r.schedule[di] || []);
    const hint = slots.length
      ? slots.map((s) => `${mins(s.start)}-${mins(s.end)}`).join('、')
      : '未设置';
    return `<div class="tk-col">
      <div class="tk-track" data-day="${di}" title="${d}：${esc(hint)}">${blocks}</div>
      <div class="tk-col-day">${d}</div>
    </div>`;
  }).join('');

  const slotRows = DAYS.map((d, di) => {
    const slots = (r.schedule[di] || []).map((s, i) => `
      <div class="tk-slot">
        <span class="tk-slot-day">${d}</span>
        <input type="text" class="tk-time" value="${tkTimeVal(s.start)}" data-act="tk-slot-start" data-day="${di}" data-i="${i}" size="5" maxlength="5" />
        <span class="muted">→</span>
        <input type="text" class="tk-time" value="${tkTimeVal(s.end)}" data-act="tk-slot-end" data-day="${di}" data-i="${i}" size="5" maxlength="5" />
        <button class="x" data-act="tk-slot-del" data-day="${di}" data-i="${i}">×</button>
      </div>`).join('');
    return slots;
  }).join('');

  return `
    <div class="tk-chart">
      <div class="tk-axis">${axis.join('')}</div>
      <div class="tk-cols">${cols}</div>
    </div>
    <div class="tk-tools">
      <button class="chip-btn" data-act="sched-copy" data-from="0" data-to="1,2,3,4">周一 → 工作日</button>
      <button class="chip-btn" data-act="sched-copy" data-from="0" data-to="0,1,2,3,4,5,6">周一 → 全部</button>
      <button class="chip-btn" data-act="sched-clear">清空</button>
      <span class="hint" style="align-self:center">在某一列上<b>按住拖动</b>即可圈出时段；再次拖过同一段可取消。</span>
    </div>
    <div class="tk-legend">
      <span><i class="lg-focus"></i>生效区间</span>
      <span><i class="lg-break"></i>番茄休息（不拦截）</span>
      <span class="muted">时间表全空 = 全天生效；色块只在这条自律时段真正生效的时间段出现。</span>
    </div>
    <div class="tk-slots">
      <div class="tk-slots-hd">时段明细<span class="muted">（可精确到 15 分钟）</span></div>
      ${slotRows || '<div class="empty" style="padding:14px">还没有时段。在上方图表里拖动即可创建。</div>'}
    </div>`;
}

/* 图表重绘（拖动时实时刷新色块） */
function paintChart() {
  const r = S.editing;
  if (!r) return;
  document.querySelectorAll('.tk-track').forEach((track) => {
    const di = +track.dataset.day;
    const segs = slDaySegs(r, di);
    track.innerHTML = segs.map((s) => {
      const top = (s.a / 1440) * 100;
      const h = Math.max(1.2, ((s.b - s.a) / 1440) * 100);
      const bg = s.type === 'break'
        ? 'repeating-linear-gradient(135deg, rgba(53,208,127,.85) 0 6px, rgba(53,208,127,.5) 6px 12px)'
        : esc(r.color || '#4d8dff');
      const label = `${mins(s.a)} - ${mins(s.b)}`;
      return `<div class="tk-seg ${s.type}" style="top:${top.toFixed(3)}%;height:${h.toFixed(3)}%;background:${bg}" title="${label}"><em>${label}</em></div>`;
    }).join('');
  });
}

/* ---------------- 图表拖选（纵轴 00:00~24:00，15 分钟粒度） ---------------- */
const TK_STEP = 15;
function tkMinuteAt(track, clientY) {
  const rect = track.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
  const raw = ratio * 1440;
  return Math.max(0, Math.min(1440 - TK_STEP, Math.round(raw / TK_STEP) * TK_STEP));
}
function tkSlotAt(r, day, minute) {
  return ((r.schedule[day]) || []).some((s) => {
    const end = s.end <= s.start ? 1440 : s.end;
    return minute >= s.start && minute < end;
  });
}

function tabApps(r) {
  const rows = r.apps.length
    ? r.apps.map((a, i) => `<div class="list-row">
        <span class="badge">${a.kind === 'exe' ? '程序' : a.kind === 'dir' ? '文件夹' : a.kind === 'name' ? '进程名' : '窗口标题'}</span>
        <span class="grow">${esc(a.label || a.value)}<div class="path">${esc(a.value)}</div></span>
        <button class="x" data-act="del-app" data-i="${i}">×</button>
      </div>`).join('')
    : '<div class="empty">还没有添加软件。<br>推荐用「从运行中的程序添加」，一次点选最省事。</div>';
  return `
    <div class="add-row">
      <button class="btn" data-act="pick-running-app">+ 从运行中的程序添加</button>
      <button class="btn" data-act="pick-file">+ 选择 exe</button>
      <button class="btn" data-act="pick-dir">+ 整个文件夹</button>
    </div>
    <div class="list-box">${rows}</div>
    <div class="hint" style="margin-top:12px">
      匹配顺序：<b>程序</b>按 exe 完整路径比对；<b>文件夹</b>匹配该目录下所有 exe；
      <b>进程名</b>支持 <code>*</code> 通配（如 <code>*steam*</code>）；<b>窗口标题</b>按包含关系匹配，适合拦网页标题。
    </div>`;
}

function tabSites(r) {
  const rows = r.sites.length
    ? r.sites.map((s, i) => `<div class="list-row">
        <span class="badge blue">网站</span>
        <span class="grow">${esc(s.pattern)}</span>
        <button class="x" data-act="del-site" data-i="${i}">×</button>
      </div>`).join('')
    : '<div class="empty">还没有添加网站。<br>可以填 <code>youtube.com</code>、<code>bilibili.com/video</code> 或 <code>*porn*</code></div>';
  return `
    <div class="add-row">
      <input type="text" id="siteInput" placeholder="输入域名 / 路径 / 通配符，回车添加" />
      <button class="btn btn-primary" data-act="add-site">添加</button>
    </div>
    <div style="margin-bottom:12px">
      <button class="chip-btn" data-act="quick-site" data-v="*.*">整个互联网 *.*</button>
      <button class="chip-btn" data-act="quick-site" data-v="youtube.com">YouTube</button>
      <button class="chip-btn" data-act="quick-site" data-v="bilibili.com">哔哩哔哩</button>
      <button class="chip-btn" data-act="quick-site" data-v="weibo.com">微博</button>
      <button class="chip-btn" data-act="quick-site" data-v="douyin.com">抖音</button>
      <button class="chip-btn" data-act="quick-site" data-v="zhihu.com">知乎</button>
    </div>
    <div class="list-box">${rows}</div>
    <div class="hint" style="margin-top:12px">
      网站拦截由浏览器插件执行。填 <code>youtube.com</code> 会连子域名一起拦；
      填 <code>youtube.com/shorts</code> 只拦路径前缀；用 <code>*</code> 表示任意字符。
      需要放行某个页面时，到「网站例外」里加。
    </div>`;
}

function tabExceptions(r) {
  const rows = r.exceptions.length
    ? r.exceptions.map((v, i) => `<div class="list-row">
        <span class="badge green">放行</span>
        <span class="grow">${esc(v)}</span>
        <button class="x" data-act="del-exc" data-i="${i}">×</button>
      </div>`).join('')
    : '<div class="empty">没有例外。例外只在当前这条自律规则内生效。</div>';
  return `
    <div class="add-row">
      <input type="text" id="excInput" placeholder="要放行的网站，例如 mail.google.com" />
      <button class="btn btn-primary" data-act="add-exc">添加</button>
    </div>
    <div class="list-box">${rows}</div>
    <div class="hint" style="margin-top:12px">
      例外的优先级高于网站自律规则。想把「整个互联网」都拦掉、只放几个站点，
      就在网站页添加 <code>*.*</code>，再在这里把要放行的站点加进来。
    </div>`;
}

function tabBreak(r) {
  const b = r.brk || { kind: 'none', workMin: 25, breakMin: 5 };
  const pomo = b.kind === 'pomodoro';
  return `
    <div class="hint" style="margin-bottom:14px">
      开启番茄后，生效时段会被切成「专注 → 休息 → 专注 …」的循环。
      <b>休息期间这条自律规则不拦截</b>（自律规则里的软件和网页都能用），时间一到自动锁回去。
      循环从时段的起点开始算。
    </div>
    <div class="seg" style="margin-bottom:18px">
      <button class="${!pomo ? 'active gold' : ''}" data-act="break-kind" data-k="none">不休息</button>
      <button class="${pomo ? 'active gold' : ''}" data-act="break-kind" data-k="pomodoro">番茄休息</button>
    </div>
    ${pomo ? `
    <div class="row" style="gap:22px;align-items:flex-end;margin-bottom:16px">
      <div>
        <div class="hint" style="margin-bottom:6px">专注多久（分钟）</div>
        <input type="number" id="workMin" min="1" max="240" value="${b.workMin || 25}" style="width:110px" />
      </div>
      <div>
        <div class="hint" style="margin-bottom:6px">休息多久（分钟）</div>
        <input type="number" id="breakMin" min="1" max="120" value="${b.breakMin || 5}" style="width:110px" />
      </div>
      <div class="hint" style="padding-bottom:9px">例如 50 / 10 = 每专注 50 分钟放你 10 分钟</div>
    </div>
    <div class="note">
      生效时段建议留够整轮时间，比如 19:00-21:30 配 50/10，能跑完 2 轮多一点。<br>
      休息期间积分<b>不加</b>，但程序可以正常退出（休息不算自律时间）。
    </div>` : '<div class="hint">不设置休息时，整段生效时间都会处于拦截状态。</div>'}`;
}

function tabLock(r) {
  const locked = !!(S.data && S.data.runtime && S.data.runtime.locked);
  return `
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:14px">
      <div>
        <div class="card-title">固化锁定</div>
        <div class="card-sub">开启后，这条规则生效期间程序不可退出、设置不可修改、任务管理器会被关闭。</div>
        <div class="card-sub">以前这里只有一段说明文字、没有开关，新建规则一律固化且关不掉；现在可以直接控制。</div>
      </div>
      <div class="switch${locked ? ' locked' : ''}" data-act="hard-toggle" title="开启 / 关闭固化"><input type="checkbox" ${r.hard ? 'checked' : ''}><i></i></div>
    </div>
    ${locked ? `<div class="note" style="border-left:3px solid var(--red);background:rgba(255,92,92,.07)">
      当前正在固化中（${esc(S.data.runtime.lockUntilText || '时段结束')} 结束），期间无法保存任何修改。
    </div>` : '<div class="note">当前不在固化时段，设置可以自由修改。</div>'}
    <div class="hint" style="margin-top:16px">
      <b>解除方式</b>：时段自然结束，或用积分强行解锁（到「总览 → 积分兑换」）。
      积分按专注时长发放，每专注 1 分钟 1 分，解锁单价随当天解锁次数递增。
    </div>`;
}

/* 拖动刷时段 */
function normalize(slots) {
  const arr = slots.filter((s) => s.end !== s.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of arr) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}
function addRange(slots, a, b) { return normalize([...(slots || []), { start: a, end: b }]); }
function subRange(slots, a, b) {
  const out = [];
  for (const s of slots || []) {
    if (s.end <= a || s.start >= b) { out.push(s); continue; }
    if (s.start < a) out.push({ start: s.start, end: a });
    if (s.end > b) out.push({ start: b, end: s.end });
  }
  return normalize(out);
}
/* 图表拖动：在某一列上按住拖动 = 圈一段时段；拖过的区间若已在表内则取消 */
document.addEventListener('mousedown', (e) => {
  const track = e.target.closest('.tk-track');
  if (!track || !S.editing) return;
  e.preventDefault();
  const day = +track.dataset.day;
  const m = tkMinuteAt(track, e.clientY);
  const covered = tkSlotAt(S.editing, day, m);
  S.tkBase = JSON.parse(JSON.stringify(S.editing.schedule[day] || []));
  S.tkDrag = { day, from: m, to: m, mode: covered ? 'remove' : 'add' };
  tkDragApply(S.tkDrag);
});
document.addEventListener('mousemove', (e) => {
  if (!S.tkDrag) return;
  const track = document.querySelector(`.tk-track[data-day="${S.tkDrag.day}"]`);
  if (!track) return;
  const m = tkMinuteAt(track, e.clientY);
  if (m === S.tkDrag.to) return;
  S.tkDrag.to = m;
  tkDragApply(S.tkDrag);
});
document.addEventListener('mouseup', () => {
  if (!S.tkDrag || !S.editing) { S.tkDrag = null; return; }
  const { day, from, to } = S.tkDrag;
  S.editing.schedule[day] = tkApplyRange(S.tkBase || [], from, to);
  S.tkDrag = null;
  S.tkBase = null;
  renderEditor();
});

/** 把 [a,b) 这段按 15 分钟粒度"翻转"到 base 上：原本有就删、没有就加。
 *
 *  边界是**左闭右开**：拖 09:00→12:00 得到的就是 09:00-12:00。
 *  这里之所以抽成独立函数，是因为鼠标移动（预览）、松开（落定）两条路径
 *  各写一遍时曾经跑偏过 —— 预览用 `m <= b`，落定用另一套，结果落定后
 *  多出 12:00-12:15 一格，用户看到的是"拖不准"。
 */
function tkApplyRange(base, from, to) {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  const inBase = (m) => (base || []).some((s) => {
    const e2 = s.end <= s.start ? 1440 : s.end;
    return m >= s.start && m < e2;
  });
  let cur = base;
  if (a === b) {
    // 单击（没拖动）= 切换这一格
    cur = inBase(a) ? subRange(cur, a, a + TK_STEP) : addRange(cur, a, a + TK_STEP);
  } else {
    for (let m = a; m < b; m += TK_STEP) {
      cur = inBase(m) ? subRange(cur, m, m + TK_STEP) : addRange(cur, m, m + TK_STEP);
    }
  }
  return cur;
}

/** 拖动过程中的临时预览（基于拖动起点快照，避免反复叠加） */
function tkDragApply(drag) {
  const r = S.editing;
  if (!r) return;
  r.schedule[drag.day] = tkApplyRange(S.tkBase || [], drag.from, drag.to);
  paintChart();
}

/* ---------------- 视图：自律时段（7 列 × 24 小时柱状图） ---------------- */
const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const CC_DEF_W = 50, CC_DEF_B = 10; // 配置里没有通用时长时的兜底值
const CC_MAX_PROFILES = 12;         // 与后端 model::MAX_CLOCK_PROFILES 对齐
/** 一天切成 24 小时，每小时再竖向切成若干格 —— **格子的高度就是时间**。
 *
 * 为什么是竖向切（历史教训）：以前每小时从左到右切成 4 个方块，
 * 但判定点击落在哪一格用的是 `clientY`（纵向坐标），于是点最左边那格
 * 得到的是"中间那 15 分钟"，点第二格反而落到更上面一格 —— 方块的顺序
 * 和横条的位置对不上。现在方块本身也是竖向排布，看得见的顺序、
 * 点到的位置、画出来的横条三者用同一个坐标轴，不可能再错位。
 *
 * 粒度（每格多少分钟）由设置决定：10 或 15。它只影响"怎么画、怎么点"，
 * 判定永远按 from/to 的绝对分钟走，所以改粒度不会让已排好的时段失效。
 */
const CC_GRANS = [10, 15];
/** 当前粒度（分钟）：10 或 15 */
function ccStep() {
  const s = S.data && S.data.config && S.data.config.settings;
  const g = s && s.focusClock ? +s.focusClock.granularity : 15;
  return g === 10 ? 10 : 15;
}
/** 一小时被切成几格（15 分钟 → 4 格，10 分钟 → 6 格） */
const ccQCnt = () => 60 / ccStep();
/** 每小时的行高（px）：保证每格至少 13px，才点得准 */
const ccHourH = () => ccQCnt() * 13;
const qStart = (q) => q * ccStep();          // 第 q 格 → 起点分钟
const qEnd = (q) => (q + 1) * ccStep();      // 第 q 格 → 终点分钟
/** 夹到合法区间并把边界落回当前粒度（from 向下取整、to 向上取整）。
 *  只做对齐，不偷偷把非法区间翻成整小时——「起 >= 止」原样透出，
 *  由调用方（右键菜单 / clockSetWB）拦截并提示，避免非法输入被静默改写。 */
function ccSnapWin(f, t) {
  let a = Math.max(0, Math.min(59, Math.round(f || 0)));
  let b = Math.max(1, Math.min(60, Math.round(t == null ? 60 : t)));
  a = Math.floor(a / ccStep()) * ccStep();
  b = Math.ceil(b / ccStep()) * ccStep();
  if (b > 60) b = 60;
  return { f: a, t: b };
}

/* ───────── 图表显示范围 ─────────
 *
 * 完整图表默认铺满 0:00–24:00（设置项里写作 0:00–23:59）。但多数人真正关心的
 * 只是"早上七点到晚上十一点"这一截：24 行铺下来要滚半天，还可能看不全。
 * 于是把范围做成一个纯**显示**参数：
 *
 *   · 只影响画多少行、刻度从几点开始、拖动的坐标怎么换算
 *   · 判定与存储完全不看它 —— 范围外的时段照样生效，只是不出现在图上
 *   · 整点对齐（拖选最小粒度是 10 分钟，行边界再切碎的话，一行就不是一小时了）
 */
function ccView() {
  const fc = S.data && S.data.config && S.data.config.settings.focusClock;
  const rawF = fc ? +fc.viewFrom || 0 : 0;
  const rawT = fc ? (fc.viewTo == null ? 1440 : +fc.viewTo) : 1440;
  const from = Math.max(0, Math.min(23 * 60, Math.floor(rawF / 60) * 60));
  const to = Math.max(from + 60, Math.min(1440, Math.floor(rawT / 60) * 60));
  return { from, to, hours: (to - from) / 60 };
}

/** 某个小时在网格里的行号（第 1 行是星期表头） */
function ccRow(h) {
  return h - ccView().from / 60 + 2;
}

/** 显示范围的文案：06:00 – 22:00（终点 24:00 写成 24:00，和刻度一致） */
function ccViewText(v) {
  const w = v || ccView();
  return `${pad(w.from / 60)}:00 – ${pad(w.to / 60)}:00`;
}

/** 归一化一套方案：7 天 × 24 小时 + 时长夹紧 */
function ccNormProfile(p, idx) {
  if (!p || typeof p !== 'object') p = {};
  if (!p.id) p.id = `p${idx + 1}`;
  if (!p.name) p.name = `方案 ${idx + 1}`;
  // 通用时长：新框选/单击选中的时段沿用（右键菜单可更新）
  p.defWork = Math.max(1, Math.min(60, Math.round(p.defWork || CC_DEF_W)));
  p.defBrk = Math.max(0, Math.min(60, Math.round(p.defBrk || CC_DEF_B)));
  if (p.defBrk > 0 && p.defWork + p.defBrk > 60) p.defBrk = 60 - p.defWork;
  // 每小时累计休息上限（0 = 不限）。缺字段的老配置落到 0，行为与以前完全一致
  p.defCap = Math.max(0, Math.min(60, Math.round(p.defCap || 0)));
  const fresh = () => ({ on: false, work: p.defWork, brk: p.defBrk, from: 0, to: 60 });
  if (!Array.isArray(p.days)) p.days = [];
  while (p.days.length < 7) p.days.push(Array.from({ length: 24 }, fresh));
  p.days.length = 7;
  p.days.forEach((day, d) => {
    if (!Array.isArray(day)) p.days[d] = Array.from({ length: 24 }, fresh);
    const dd = p.days[d];
    while (dd.length < 24) dd.push(fresh());
    dd.length = 24;
    for (const h of dd) {
      h.work = Math.max(0, Math.min(60, Math.round(h.work || 0)));
      h.brk = Math.max(0, Math.min(60, Math.round(h.brk || 0)));
      // 起止分钟：夹到合法区间并对齐 15 分钟刻度；起始不早于结束，否则按整小时算
      const snap = ccSnapWin(h.from, h.to);
      h.from = snap.f;
      h.to = snap.t;
      if (h.brk > 0) {
        h.work = Math.max(1, Math.min(59, h.work));
        if (h.work + h.brk > 60) h.brk = 60 - h.work;
      }
    }
  });
  return p;
}

/** 归一化 focusClock：多套「星期时段」方案（兼容旧版单套 days / 更旧的 hours） */
/** 睡眠管理的配置（缺失时补一份默认，老配置升级上来也安全） */
function clockCfgSleep() {
  const s = S.data && S.data.config && S.data.config.settings;
  if (!s) return { enabled: false, from: 23 * 60, to: 7 * 60, countdownMin: 10, shutdown: true, lockScreen: true, unlockMin: 30, unlockPrice: 10 };
  if (!s.sleep) {
    s.sleep = { enabled: false, from: 23 * 60, to: 7 * 60, countdownMin: 10, shutdown: true, lockScreen: true, unlockMin: 30, unlockPrice: 10 };
  }
  return s.sleep;
}

/** 休息结束收尾的配置。缺字段按默认补齐，和 Rust 侧 `SweepCfg::default()` 一致：
 *  开 / 柔和 / 暂停媒体。
 *
 *  为什么在前端也要兜一层：老配置（v0.1.22 之前）根本没有 `sweep` 这个键，
 *  界面要先能画出"默认值"的样子；后端读配置时同样有 serde default，
 *  两边各自兜住，谁先跑都不会显示错。 */
function sweepCfg() {
  const s = S.data && S.data.config && S.data.config.settings;
  if (!s) return { enabled: true, mode: 'soft', pauseMedia: true };
  if (!s.sweep || typeof s.sweep !== 'object') s.sweep = {};
  const sw = s.sweep;
  if (typeof sw.enabled !== 'boolean') sw.enabled = true;
  if (sw.mode !== 'hard' && sw.mode !== 'soft') sw.mode = 'soft';
  if (typeof sw.pauseMedia !== 'boolean') sw.pauseMedia = true;
  return sw;
}

function clockCfg() {
  const s = S.data && S.data.config && S.data.config.settings;
  if (!s) return { enabled: false, applyRules: true, active: 'p1', profiles: [] };
  if (!s.focusClock) s.focusClock = { enabled: false, applyRules: true, active: 'p1', profiles: [] };
  const fc = s.focusClock;
  if (!Array.isArray(fc.profiles)) fc.profiles = [];
  // 旧版迁移：单套方案摊在 focusClock.days（更旧的是 hours）上，搬进第一套
  if (!fc.profiles.length) {
    let legacyDays = null;
    if (Array.isArray(fc.days) && fc.days.length) {
      legacyDays = fc.days;
    } else     if (Array.isArray(fc.hours) && fc.hours.length) {
      const one = [];
      for (let h = 0; h < 24; h++) {
        const p = fc.hours[h] || {};
        one.push({ on: !!p.on, work: +(p.work || CC_DEF_W), brk: +(p.brk || CC_DEF_B), from: 0, to: 60 });
      }
      legacyDays = Array.from({ length: 7 }, () => one.map((p) => ({ ...p })));
    }
    fc.profiles.push({
      id: 'p1',
      name: '默认时段',
      days: legacyDays || [],
      defWork: fc.defWork,
      defBrk: fc.defBrk,
    });
    fc.active = 'p1';
  }
  fc.profiles.forEach((p, i) => ccNormProfile(p, i));
  if (!fc.profiles.some((p) => p.id === fc.active)) fc.active = fc.profiles[0].id;
  // 旧字段不再参与任何逻辑，留着只会造成"两份真相"
  delete fc.days;
  delete fc.hours;
  delete fc.defWork;
  delete fc.defBrk;
  return fc;
}

/** 当前生效的那套方案 */
function clockProfile() {
  const fc = clockCfg();
  return fc.profiles.find((p) => p.id === fc.active) || fc.profiles[0];
}

/** 把 DOM 里 `.cc-cell` 的选中态按「每列连续分钟」画成整块覆盖层。
 *
 * 为什么不在格子上画：格子之间有 3px 间距，半透明底色在间距里叠两次会
 * 变成一条亮缝，几个连续小时看起来就像几块独立的小方块。
 * 这里改成用 grid 跨行跨列的覆盖层——一个连续段就是**一个**圆角块，
 * 中间没有任何接缝；格子仍然负责命中、hover 与右键。
 *
 * 三件事让"连续"真的连续：
 * 1. 相邻的块（只隔 3px 网格间距）互相缝合：共享的那一侧不画圆角和描边，
 *    并由后侧的块用负边距把间距补上——看起来就是一整块，而不是一块块拼的。
 * 2. 选中窗口是分钟区间 [from,to)（右键或细分刻度设置），整块按**均匀分钟格**
 *    切片：与格子边界无关，所以 11:10–12:20 这种零碎时间也是一条整带，
 *    不会因为跨小时被切开。未选中的分钟用与格子同色的占位带让开。
 * 3. 整块只用一种颜色：块里不再按 专注/休息 切出不同深浅的色带，
 *    未选中的分钟用透明占位带让开（这是"没选满"，不是另一种颜色）。
 *
 * `override(d,h)` 传入时，用它的返回值代替配置里的值（拖选预览用）。
 * `only` 传入时只重画这几天的块：跨天拖动落位 / 取消后需要把"指针掠过、
 * 但已经不是落点"的那几天收拾干净，而重建**全部**的块会把手上那一块也换掉，
 * 落位动画（FLIP）就没有起点可用了。
 *
 * 注意这里**没有**"选中色"参数：块画出来永远是"已放置"色（--cc-set）。
 * "正在被操作"这件事由 ccPaintSel 事后按区间逐块打 `.sel` 决定，
 * 因为它需要知道"哪一段在动"，而渲染器只知道"有哪些段"。
 *
 * 这样也顺手修掉了一个老问题：以前拖某一天时，整张表重画都会带上选中色，
 * 隔壁几天没被碰过的块也跟着变色，看起来像"它们也要变"。 */
function ccRenderRuns(root, override, only) {
  const host = root || document;
  const grid = host.querySelector('#ccGrid') || document.getElementById('ccGrid');
  if (!grid) return;
  const allow = only ? new Set(only) : null;
  // **复用池**：按 data-key 收好现有块，能复用就复用，只有真不该存在的才删。
  //
  // 这里以前是"先把所有块 remove 掉再重建"，每帧一次。而 `.cc-run.carry`
  // 带一段 0.13s 的落格动画（ccCarry：opacity .55 → .72、scale 1.015 → 1），
  // 于是被拖的那一块**每帧都从头重播一遍**——拖动时 mousemove 远快于 130ms，
  // 动画永远播不完，看起来就是持续闪烁。其它段虽然没动画，也跟着每帧重建重排。
  // 复用之后，同一段在整个拖动过程中始终是同一个 DOM 节点，只改 grid-row 和文字，
  // 动画不会重播，闪烁从根上消失。
  const pool = new Map();
  grid.querySelectorAll('.cc-drag').forEach((el) => el.remove());
  grid.querySelectorAll('.cc-run').forEach((el) => {
    const d = el.dataset.d == null ? null : +el.dataset.d;
    // 只重画某几天时，范围外的块原样留着，不参与本帧
    if (allow && d != null && !allow.has(d)) return;
    const k = el.dataset.key;
    if (!k) {
      el.remove();
      return;
    }
    pool.set(k, el);
  });
  const fc = clockProfile();
  // `override(d,h)` 让拖拽预览可以临时替换某天的窗口，而不去改配置：
  //   返回 undefined = 用配置；`null` / `[]` = 这一小时不选中；
  //   `{f,t}` 或 `[{f,t}, …]` = 用这些窗口。
  // **必须支持"一小时多个窗口"**：同一小时可以放两段（09:00–09:30 + 09:30–10:00），
  // 预览当初只认得一个窗口，于是拖别处的时段时，同一小时里的另一段就被整段丢掉，
  // 界面上看起来"已有时段凭空消失"（数据其实还在）。
  const ovList = (d, h) => {
    if (!override) return undefined;
    const ov = override(d, h);
    if (ov === undefined) return undefined;
    return ccWinList(ov).map((w) => ({ from: w.f, to: w.t, seg: w.seg || '__drag' }));
  };
  const hourAt = (d, h) => {
    const base = (fc.days[d] && fc.days[d][h]) || { on: false, work: 0, brk: 0, from: 0, to: 60 };
    const list = ovList(d, h);
    if (list === undefined) return base;
    if (!list.length) return { ...base, on: false };
    return {
      ...base,
      on: true,
      from: Math.min(...list.map((w) => w.from)),
      to: Math.max(...list.map((w) => w.to)),
    };
  };
  const clampW = (v) => Math.max(0, Math.min(60, Math.round(v || 0)));
  // 真实行高（px）：格子渲染出来了就以它为准，否则退回按粒度估算的常量
  const hourPx = (() => {
    const g = ccDayGeom(0);
    return g && g.hourH > 0 ? g.hourH : ccHourH();
  })();

  // 按列收集选中小时（以 DOM 为准：拖选预览用的是同一套 DOM 状态）
  const cols = new Map();
  grid.querySelectorAll('.cc-cell.on').forEach((c) => {
    const d = +c.dataset.d, h = +c.dataset.h;
    if (!cols.has(d)) cols.set(d, new Set());
    cols.get(d).add(h);
  });

  // 1) 每列先算出连续段，并记录这一段的「专注/休息配方」——
  //    配方不同的两天不能横向合并，否则色带会画错。
  //    分割点看「有效边界」：上一小时没到整点、或这一小时没从整点开始，
  //    中间就有没选中的分钟，必须切开——那个洞渲染时要让出来。
  //    切完的段只有首小时可以 from>0、尾小时可以 to<60，中间都是整小时。
  // 这一小时里要画的窗口（预览优先；一小时可能有多个）
  const winsAt = (d, h) => {
    const base = (fc.days[d] && fc.days[d][h]) || {};
    const list = ovList(d, h);
    if (list === undefined) return hourWins(base);
    return list;
  };

  const segs = [];
  const pushSeg = (d, sg) => {
    const mins = [];
    for (let i = sg.h0; i <= sg.h1; i++) {
      const p = hourAt(d, i);
      const w = p.on ? clampW(p.work) : clampW(fc.defWork);
      const b = p.on ? Math.max(0, Math.min(60 - w, clampW(p.brk))) : Math.min(clampW(fc.defBrk), 60 - w);
      mins.push(`${w}/${b}`);
    }
    segs.push({
      d,
      h0: sg.h0,
      h1: sg.h1,
      seg: sg.seg || '',
      sig: mins.join(','),
      f0: Math.max(0, Math.min(59, Math.round(sg.f0 || 0))),
      t1: Math.max(1, Math.min(60, Math.round(sg.t1))),
    });
  };
  cols.forEach((hs, d) => {
    if (allow && !allow.has(d)) return;
    // 收集这一列所有窗口，按（小时, 起点）排好；同段且首尾相接才接成一条
    const wins = [];
    for (let h = 0; h < 24; h++) {
      if (!hs.has(h)) continue;
      for (const w of winsAt(d, h)) wins.push({ h, from: w.from, to: w.to, seg: w.seg });
    }
    let cur = null;
    for (const w of wins) {
      const absFrom = w.h * 60 + w.from;
      if (cur && ccSameSegId(cur.seg, w.seg) && cur.endAbs === absFrom) {
        cur.h1 = w.h;
        cur.t1 = w.to;
        cur.endAbs = w.h * 60 + w.to;
        continue;
      }
      if (cur) pushSeg(d, cur);
      cur = {
        h0: w.h, h1: w.h, f0: w.from, t1: w.to, seg: w.seg, endAbs: w.h * 60 + w.to,
      };
    }
    if (cur) pushSeg(d, cur);
  });


  // 2) 每个「当天的一段连续小时」就是一块，**不再把相邻日期合并**。
  //
  //    以前会把"周一–周五 8–12、起止分钟和配方都一样"的那几天合成一块横跨五列的
  //    大色块。问题是：一旦和隔壁那天接上，圆角就只剩下最外沿那两个，中间全是
  //    直角——看起来像两块被硬粘在一起，也分不清哪块是周几。
  //    现在一天一块、各自四角圆润，日历的列感也回来了。

  const addBlock = (d0, h0, h1, f0, t1, seg) => {
    const t1Min = t1;   // 尾小时的结束分钟，用于色块上的时长文字
    const n = h1 - h0 + 1;
    // 块内统一按「分钟」切片，但**每格只发一条同色带**：
    // 以前把一小时拆成 专注/休息/尾段 三条不同颜色，块里就成了调色盘。
    // 现在整块只有一种颜色（CSS 里 --cc-block），起止分钟之外才是透明的"没选满"。
    const unit = 100 / (n * 60);
    const parts = [];   // { gap, pct }
    for (let k = 0; k < n; k++) {
      const f = k === 0 ? f0 : 0;      // 首小时的起始分钟
      const t = k === n - 1 ? t1 : 60; // 尾小时的结束分钟
      if (f > 0) parts.push({ gap: true, pct: f * unit });
      if (t > f) parts.push({ gap: false, pct: (t - f) * unit });
      if (t < 60) parts.push({ gap: true, pct: (60 - t) * unit });
    }
    // 圆角要画在**填色带**上，而不是外层容器上：
    // 容器是整格高度、透明，01:15–01:45 这种块只占了中间一半，
    // 容器那四个角根本没有颜色，圆角自然"看不见"——这正是"非整点区间没圆角"的原因。
    // 于是一条连续块的三段（首/中/尾）分别取：上圆角、不带圆角、下圆角，
    // 拼起来就是一条上下圆润、中间无缝的色块。
    const solid = parts.filter((x) => !x.gap);
    solid.forEach((b, i) => {
      // 4px：格子本身只有 52px 高、一列不到 100px 宽，7px 显得太"胖"，
      // 4px 更贴合日历这种密集网格的精致感。
      b.radius = solid.length === 1 ? '4px'
        : i === 0 ? '4px 4px 0 0'
          : i === solid.length - 1 ? '0 0 4px 4px'
            : '0';
      // 首 / 尾那条带要额外标出来：边缘缩放的小手柄挂在它们上面
      // （非整点的段，上边界在 :15 而不是格子顶，不能挂在容器上）
      b.first = i === 0;
      b.last = i === solid.length - 1;
    });
    const bands = parts.map((b) => (b.gap
      ? `<i class="cc-gap" style="flex:0 0 ${b.pct.toFixed(3)}%"></i>`
      : `<i class="f${b.first ? ' first' : ''}${b.last ? ' last' : ''}"`
        + ` style="flex:0 0 ${b.pct.toFixed(3)}%;border-radius:${b.radius}"></i>`)).join('');
    // 同一段在拖动过程中位置会变，但 seg 不变 —— 用它当 key 就能一直复用同一个节点。
    // 老配置没有 seg 时退化成"位置 key"，那种数据移动时会重建一次（只发生在
    // 从未保存过的旧数据上；保存过一次就会写入 seg）。
    const key = seg ? `s:${seg}@${d0}` : `p:${d0}:${h0}-${h1}:${f0}-${t1}`;
    let run = pool.get(key);
    if (run) {
      pool.delete(key);          // 标记"这一帧用到了"，别在收尾时被清掉
    } else {
      run = document.createElement('div');
      run.className = 'cc-run';
      // 只有"真的新出现一块"才播入场；拖动过程中的块是移动，不是新生。
      // `S.ccDrag` 存在 = 正在拖，这时候加入场动画等于每帧闪一次（就是原来那个 bug）。
      if (!S.ccDrag) {
        run.classList.add('cc-in');
        run.addEventListener('animationend', () => run.classList.remove('cc-in'), { once: true });
      }
    }
    run.dataset.key = key;
    run.dataset.seg = seg || '';
    run.dataset.d = String(d0);
    run.dataset.d1 = String(d0);
    run.dataset.h0 = String(h0);
    run.dataset.h1 = String(h1);
    run.dataset.f0 = String(f0);
    run.dataset.t1 = String(t1);
    // 第 1 行是星期表头、第 1 列是小时刻度 → 数据行/列都从 2 开始；
    // 行号再减去「显示范围」的起始小时（默认 0，等于没变）
    run.style.gridColumn = `${d0 + 2}`;
    run.style.gridRow = `${ccRow(h0)} / ${ccRow(h1) + 1}`;
    // 色块上的时长文字（滴答清单风格）：09:00 – 12:00。
    // 注意结束分钟可能是 60，那是"到下一小时整点"，必须进成 12:00，
    // 不能直接写成 11:60（非法时间，之前真出现过）。
    const labStart = `${pad(h0)}:${pad(f0)}`;
    const eMin = Math.round(t1Min);
    const labEnd = eMin >= 60
      ? `${pad(Math.min(24, h1 + 1))}:00`
      : `${pad(h1)}:${pad(eMin)}`;
    // 时间文字：**任何长度都要显示**。
    // 10 / 15 分钟这种短块只有 13px 高，用常规字号会顶出去，
    // 于是分两档：足够高用常规字号；不够高换成 .tight（8.5px、行高 1.1），
    // 在 13px 里正好放得下一行。位置跟着首个填色带走，
    // 不然 01:15 开始的块会把字写在上面那截空白里。
    const spanMin = Math.max(0, Math.round(n * 60 - f0 - (60 - t1)));
    // 行高必须**量**，不能用常量：完整展示模式下每行是 1fr 算出来的（可能只有 20px），
    // 用常量 52 会把矮块判断成"够高"，两行字直接溢出块外。
    const spanPx = (spanMin / 60) * hourPx;
    const labTop = (f0 * unit).toFixed(3);
    const tight = spanPx < 20;
    // 够高的块：时间一行、时长另起一行；矮块挤成一行，时长紧跟在后面。
    // 时长用 ccDurText，跟着界面语言走（"3 小时 20 分" / "3 h 20 min"）。
    const twoLine = spanPx >= 34;
    const label = `<span class="cc-run-txt${tight ? ' tight' : ''}${twoLine ? ' two' : ''}"`
      + ` style="top:calc(${labTop}% + ${tight ? 2 : 3}px)">`
      + `<b>${labStart} – ${labEnd}</b><em>${ccDurText(spanMin)}</em></span>`;
    // 只有内容真的变了才重写：无谓赋值会把子节点（色带 + 文字）整批重建，
    // 那是"闪"的另一半来源。
    const html = label + bands;
    if (run.dataset.html !== html) {
      run.innerHTML = html;
      run.dataset.html = html;
    }
    if (!run.isConnected) grid.appendChild(run);
  };

  // 一天一段：直接铺，不做跨天/跨段合并
  for (const s of segs) addBlock(s.d, s.h0, s.h1, s.f0, s.t1, s.seg);

  // 池里剩下的 = 这一帧不该再有的块（被删掉、被合并、或换了位置的老数据），统一清掉
  pool.forEach((el) => el.remove());

}

/** 已选时段总数（小时数）——只算当前生效的那套方案 */
function clockCountOn(fc) {
  const p = fc ? (fc.profiles.find((x) => x.id === fc.active) || fc.profiles[0]) : clockProfile();
  return p.days.reduce((n, day) => n + day.filter((h) => h.on).length, 0);
}

/** 一天里选中的小时合并成区间文案。
 *  带起止分钟（08:15–11:45）；中间小时的窗口不完整时会把区间断开——
 *  那个洞是真的没选中，文本不能假装连着（与后端 day_ranges 口径一致）。
 *
 *  分段逻辑统一走 `ccSegs`：以前这里和微缩图各写了一份"怎么算连续"，
 *  改一处忘另一处就会出现"摘要写 2 段、微缩图列 3 段"这种对不上的情况。 */
function ccDayRanges(day) {
  return ccSegs(day).map((s) => s.range);
}

/** 一天里选中的总分钟数。
 *
 *  按**窗口**累加，不能按 `from`/`to` 相减：那两个字段只是"这一小时的近似总范围"，
 *  同一小时里放两段且中间有空档时（09:00–09:15 与 09:45–10:00），
 *  相减会得到整小时 60 分钟，比真实值多一倍。窗口是唯一真相。 */
function ccDayMinutes(day) {
  return (day || []).reduce((n, p) => n
    + hourWins(p).reduce((m, w) => m + Math.max(0, w.to - w.from), 0), 0);
}

/** 一句话概括当前排班。
 *
 *  刻意按"天"聚合，不再把每一段当成一个独立条目罗列 ——
 *  同一天有多段时读起来是"周三 共 3 小时（08:00–09:00、14:00–16:00）"，
 *  而不是一串并列的"周三 08:00–09:00、周三 14:00–16:00"。 */
function clockRangeText(fc) {
  const c = fc || clockCfg();
  const p = c.profiles.find((x) => x.id === c.active) || c.profiles[0];
  const ranges = p.days.map((d) => ccDayRanges(d));
  const mins = p.days.map((d) => ccDayMinutes(d));
  if (!ranges.some((r) => r.length)) return '未选择任何时段';
  const dur = (m) => ccMinText(0, m).dur;
  const same = ranges.every((r) => r.join('|') === ranges[0].join('|'));
  if (same) {
    return `每天 ${ranges[0].join('、')}（共 ${dur(mins[0])}）`;
  }
  return ranges
    .map((r, d) => (r.length ? `${WD[d]} 共 ${dur(mins[d])}（${r.join('、')}）` : null))
    .filter(Boolean)
    .join('；');
}

/** 矩形区域文案：周三 08:00–12:00 / 周三 – 周五 08:00–12:00。
 *  传了起止分钟且不是整点时带分钟：周三 08:15–11:45（结束分钟 60 或省略 = 整点）。 */
function ccRectText(d0, d1, h0, h1, fromMin, toMin) {
  const days = d0 === d1 ? WD[d0] : `${WD[d0]} – ${WD[d1]}`;
  const f = fromMin > 0 ? `:${pad(fromMin)}` : ':00';
  const endH = (toMin == null ? 60 : toMin) >= 60 ? h1 + 1 : h1;
  const t = (toMin == null ? 60 : toMin) >= 60 ? ':00' : `:${pad(toMin)}`;
  return `${days} ${pad(h0)}${f} – ${pad(endH)}${t}`;
}

/** 从当前时刻起，下一个被选中的时段（含本周稍后与下周），没有则返回 '' */
function ccNextSlotText(fc, wdNow, hourNow) {
  const p = fc.profiles.find((x) => x.id === fc.active) || fc.profiles[0];
  for (let step = 0; step < 7 * 24; step++) {
    const d = (wdNow + Math.floor((hourNow + step) / 24)) % 7;
    const h = (hourNow + step) % 24;
    const one = p.days[d] && p.days[d][h];
    if (one && one.on) {
      const when = step < 24 ? (step === 0 ? '本小时' : `${step} 小时后`) : `${Math.floor(step / 24)} 天后`;
      const snap = ccSnapWin(one.from, one.to);
      const hm = snap.f > 0 ? `:${pad(snap.f)}` : ':00';
      return `，下一个选中时段：${WD[d]} ${pad(h)}${hm}（${when}）`;
    }
  }
  return '';
}

/** 方案命名弹层：新建时给个「方案 N」的默认名，重命名时带出原名。
 *  WebView 里 window.prompt 不可靠，统一走项目自己的 modal。 */
function ccNameDialog(mode) {
  const fc = clockCfg();
  const p = clockProfile();
  const isNew = mode === 'new';
  const val = isNew ? `方案 ${fc.profiles.length + 1}` : p.name;
  $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal" style="max-width:430px">
        <div class="modal-hd">
          <h3>${isNew ? '新建星期时段方案' : '重命名方案'}</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          <div class="add-row"><input type="text" id="ccNameInput" maxlength="30" value="${esc(val)}"
            placeholder="例如：工作日强化 / 周末轻松 / 考试冲刺"></div>
          <div class="hint" style="margin-top:8px">
            名字只用于区分方案，不影响判定。${isNew
              ? '新建后会自动切到这套，排班表是空的，拖出要自律的时段即可。'
              : '重命名不改排班，也不会影响正在生效的那套。'}
          </div>
        </div>
        <div class="modal-ft">
          <button class="btn" data-act="close-modal">取消</button>
          <button class="btn btn-primary" data-act="cc-name-ok" data-mode="${mode}">${isNew ? '创建' : '保存'}</button>
        </div>
      </div>
    </div>`;
  const inp = $('#ccNameInput');
  if (inp) { inp.focus(); inp.select(); }
}

/* ---------------- 备份：恢复方式选择 ----------------
 *
 * 为什么要在恢复前多问一句：
 *   「覆盖」是不可撤销的（本机多出来的规则会消失），「合并」只加不减。
 *   这两种意图差得很远，替用户猜一个不如让他点一下——点错了代价太大。
 *   返回 Promise<'overwrite'|'merge'|null>，取消得到 null。
 */
let _modeResolve = null;

/**
 * 当前弹窗被"非按钮方式"关掉（Esc / 点遮罩 / 新弹窗顶替）时的回调解。
 *
 * 有些弹窗本质是 `await 用户选一个值`：选择恢复方式、输入旧备份密码。
 * 它们必须在**任何**关闭路径上兑现，否则调用方会永久挂起（弹窗没了，
 * 恢复既没成功也没失败）。
 */
let MODAL_ON_CLOSE = null;

function askRestoreMode(title, sub) {
  return new Promise((resolve) => {
    if (_modeResolve) { const old = _modeResolve; _modeResolve = null; old(null); }
    _modeResolve = resolve;
    $('#modalRoot').innerHTML = `
      <div class="modal-mask" data-act="mode-cancel">
        <div class="modal" style="max-width:540px">
          <div class="modal-hd">
            <h3>${esc(title || '选择恢复方式')}</h3>
            <button class="close-x" data-act="mode-cancel">×</button>
          </div>
          <div class="modal-bd">
            ${sub ? `<div class="hint" style="margin-bottom:12px">${esc(sub)}</div>` : ''}
            <div class="note" style="margin-bottom:10px">
              <b>覆盖</b>：用备份里的规则、时段、积分、提醒和语言替换本机。<br>
              本机多出来的规则会消失；遮罩、HUD、端口、备份密码不受影响。
            </div>
            <div class="note">
              <b>合并</b>：只补本机没有的规则和时段，已有的一律不改。<br>
              同名不同内容的规则会改名并列，积分取两边较大值。
            </div>
          </div>
          <div class="modal-ft">
            <button class="btn" data-act="mode-cancel">取消</button>
            <button class="btn" data-act="mode-merge">合并</button>
            <button class="btn btn-primary" data-act="mode-overwrite">覆盖</button>
          </div>
        </div>
      </div>`;
    // Esc / 点遮罩关掉时也要兑现：否则调用方的 await 永远挂着，恢复静默失效。
    MODAL_ON_CLOSE = () => {
      if (_modeResolve) { const r = _modeResolve; _modeResolve = null; r(null); }
    };
  });
}

/** 点按钮 → 兑现 Promise 并关掉弹层 */
function pickRestoreMode(act) {
  const r = _modeResolve;
  _modeResolve = null;
  MODAL_ON_CLOSE = null;
  closeModal();
  if (r) r(act === 'mode-merge' ? 'merge' : act === 'mode-overwrite' ? 'overwrite' : null);
}

/** 把后端返回的计数说成人话 */
function restoreText(r) {
  if (!r) return '已完成';
  if (r.noop) return '没有需要合并的内容：这些规则本机已经有了';
  if (r.mode === 'merge') {
    const p = [];
    if (r.added) p.push(`新增 ${r.added} 条规则`);
    if (r.skipped) p.push(`跳过 ${r.skipped} 条（已存在）`);
    if (r.conflict) p.push(`冲突 ${r.conflict} 条已改名并列`);
    if (r.slots) p.push(`补上 ${r.slots} 个小时段`);
    return '合并完成：' + (p.length ? p.join('，') : '没有变化');
  }
  return `已覆盖：现在有 ${r.rules} 条规则` + (r.legacy ? '（旧版备份，整份恢复）' : '');
}

/**
 * 跑一次"恢复"：解密失败时问一次备份密码再重试。
 *
 * 为什么需要：备份是用**当时设置里的**密码加密的。用户改过密码之后，
 * 旧备份就再也打不开了——以前只会弹一句"密码不对，或者备份文件被改动过"，
 * 文件明明是好的，而且没有任何地方能输入旧密码。
 */
async function runRestore(call, _cmd, _base) {
  const isPassErr = (m) => /密码不对|需要密码|password/i.test(m);
  try {
    const r = await call(undefined);
    await pull(); render();
    toast(restoreText(r), 'ok');
    return;
  } catch (e) {
    const msg = String(e).replace(/^Error:\s*/, '');
    if (!isPassErr(msg)) {
      if (!msg.includes('已取消')) toast(msg, 'err');
      return;
    }
  }
  // 问一次旧密码
  const pass = await promptBackupPass();
  if (pass == null) return;
  try {
    const r = await call(pass);
    await pull(); render();
    toast(restoreText(r), 'ok');
  } catch (e) {
    toast(String(e).replace(/^Error:\s*/, ''), 'err');
  }
}

/** 输入备份密码的小弹窗（返回 null = 取消） */
function promptBackupPass() {
  return new Promise((resolve) => {
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-mask" data-act="pass-cancel">
        <div class="modal" style="width:430px">
          <div class="modal-hd"><h3>这份备份用的是另一个密码</h3></div>
          <div class="modal-bd">
            <div class="note" style="font-size:13px;line-height:1.9;margin-bottom:14px">
              备份是用**当时设置里的**密码加密的。你后来改过备份密码，所以现在解不开。
              输入当初那个密码就能恢复（不会改动你现在的设置）。
            </div>
            <input id="bakPass" type="password" class="input" placeholder="当初的备份密码" autocomplete="off" />
          </div>
          <div class="modal-ft">
            <button class="btn" data-act="pass-cancel">取消</button>
            <button class="btn btn-primary" data-act="pass-ok">用这个密码恢复</button>
          </div>
        </div>
      </div>`;
    const done = (v) => {
      MODAL_ON_CLOSE = null;
      root.innerHTML = '';
      resolve(v);
    };
    // Esc / 点遮罩关掉时也要兑现（否则 await 永久挂起）
    MODAL_ON_CLOSE = () => resolve(null);
    const ok = () => {
      const v = (($('#bakPass') || {}).value || '').trim();
      if (!v) { toast('请输入密码', 'err'); return; }
      done(v);
    };
    root.onclick = (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'pass-ok') ok();
      else if (a.dataset.act === 'pass-cancel') done(null);
    };
    const inp = $('#bakPass');
    if (inp) {
      inp.focus();
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); ok(); }
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
      });
    }
  });
}

/* ---------------- 生效时间段：微缩图 + 完整页（两级形态） ----------------
 *
 * 为什么分成两级：
 *   一张 7×24 的日历占掉大半个屏幕，而这个页面还要放方案、绑定、通用时长……
 *   于是"看排班"这件事被挤到很下面。现在页面里只留一张**微缩概览**，
 *   想看细节就点开**完整页**：那里才有刻度、拖选、明细数据。
 *   两处读的是同一份 `prof.days`，所以不会出现"微缩图和完整页不一致"。
 *
 * 微缩图不是"把主窗口按比例缩小"：那样只剩一团色块，什么也读不出来。
 * 它由两部分组成——
 *   · 左边/上面一条 7 列时间轴：只回答"哪天、大概几点到几点"（形状）
 *   · 下面逐条列出每段的摘要：时间范围 + 节奏 + 番茄轮数 + 时长（内容）
 * 概览的定位不变（不标坐标、不可交互、一眼看完），但读得懂"这一段是干什么的"。
 */

/** 把一天拆成若干"连续时段"，连同摘要需要的统计值一起算出来。
 *  和 `ccDayRanges` 同一套连续性判据（上一小时排到整点、下一小时从整点开始）。 */
/// 一小时里的窗口列表（统一出口：`wins` 优先，否则旧的单窗口字段）。
///
/// 为什么需要：`on/from/to` 只能表达"一小时一个窗口"，
/// 于是 09:00–09:30 与 09:30–10:00 会被第二段撑成整小时、并成一段。
/// `wins` 非空时以它为准，老配置照旧走单窗口。
function hourWins(p) {
  if (!p || !p.on) return [];
  if (Array.isArray(p.wins) && p.wins.length) {
    return p.wins
      .filter((w) => w && (w.to == null ? 60 : +w.to) > (+w.from || 0))
      .map((w) => ({
        from: Math.max(0, Math.min(59, +w.from || 0)),
        to: Math.max(1, Math.min(60, w.to == null ? 60 : +w.to)),
        seg: w.seg || '',
      }))
      .sort((a, b) => a.from - b.from);
  }
  const f = Math.max(0, Math.min(59, p.from || 0));
  const t = Math.max(1, Math.min(60, p.to == null ? 60 : p.to));
  if (t <= f) return [];
  return [{ from: f, to: t, seg: p.seg || '' }];
}

/** 把窗口列表写回一小时。只剩一个窗口时收回旧字段，避免配置无谓膨胀。 */
function ccSetHourWins(p, wins, work, brk) {
  const list = (wins || [])
    .map((w) => ({
      from: Math.max(0, Math.min(59, +w.from || 0)),
      to: Math.max(1, Math.min(60, w.to == null ? 60 : +w.to)),
      seg: w.seg || '',
    }))
    .filter((w) => w.to > w.from)
    .sort((a, b) => a.from - b.from);
  if (work != null) p.work = work;
  if (brk != null) p.brk = brk;
  if (!list.length) {
    p.on = false;
    p.from = 0;
    p.to = 60;
    p.seg = '';
    p.wins = [];
    return;
  }
  p.on = true;
  p.from = list[0].from;
  p.to = list[list.length - 1].to;   // 旧字段记"总范围"，给只读旧字段的地方一个近似
  p.seg = list[0].seg || '';
  p.wins = list.length > 1
    ? list.map((w) => ({ from: w.from, to: w.to, seg: w.seg || '' }))
    : [];
}

/** 某一小时在 [lo,hi) 这次操作之后的窗口列表。
 *
 *  `mode`：
 *    · `add` 把这一段并进去（同段相接才连、不同段相接各留各的、重叠则截断旧段）
 *    · `sub` 从各窗口里减去这一段（**两侧都留**，以前只留较长一侧）
 */
function ccWinsAfter(p, h, lo, hi, mode, segId) {
  const hs = h * 60;
  const a = Math.max(lo, hs);
  const b = Math.min(hi, hs + 60);
  const wins = hourWins(p).map((w) => ({ ...w }));
  if (b <= a) return wins;
  const af = a - hs;
  const bt = b - hs;

  if (mode === 'sub') {
    const out = [];
    for (const w of wins) {
      if (bt <= w.from || af >= w.to) {
        out.push(w);
        continue;
      }
      // 两侧都保留：一小时现在能存两段了，不需要"留较长的一侧"
      if (w.from < af) out.push({ from: w.from, to: af, seg: w.seg });
      if (w.to > bt) out.push({ from: bt, to: w.to, seg: w.seg });
    }
    return out.sort((x, y) => x.from - y.from);
  }

  // add
  let nf = af;
  let nt = bt;
  let nseg = segId || '';
  const out = [];
  for (const w of wins) {
    const overlap = w.from < nt && w.to > nf;
    const touching = w.to === nf || w.from === nt;
    const same = !w.seg || !nseg ? true : w.seg === nseg;
    if (!overlap && !(touching && same)) {
      out.push(w);
      continue;
    }
    if (overlap && !same) {
      // 不同段且真的重叠：新段覆盖中间，旧段两侧截断
      if (w.from < nf) out.push({ from: w.from, to: nf, seg: w.seg });
      if (w.to > nt) out.push({ from: nt, to: w.to, seg: w.seg });
      continue;
    }
    nf = Math.min(nf, w.from);
    nt = Math.max(nt, w.to);
    if (w.seg) nseg = w.seg;
  }
  out.push({ from: nf, to: nt, seg: nseg });
  return out.sort((x, y) => x.from - y.from);
}

/** 新段 id：只要求"同一毫秒内也不撞"，不做持久化解析 */
let _ccSegSeq = 0;
function ccNewSegId() {
  _ccSegSeq += 1;
  return 's' + Date.now().toString(36) + '_' + _ccSegSeq.toString(36);
}

/** 相邻两小时是否属于同一段。
 *
 *  有 `seg` 就看 id：**id 不同就是两段**，哪怕 09:00–10:00 与 10:00–11:00 完全贴合。
 *  两边都没有 id（老配置）才退回"按连续性合并"的老行为——
 *  老数据没有段的概念，只能这么退，否则升级后旧排班会碎成一小时一段。
 *
 *  一边有一边没有（手工改过配置）：按"不同段"处理，宁可分成两段，
 *  也不要把用户明确分开的东西合起来。
 */
function ccSameSegId(x, y) {
  const a = x || '';
  const b = y || '';
  if (!a && !b) return true;
  return !!a && a === b;
}

function ccSameSeg(a, b) {
  return ccSameSegId((a && a.seg) || '', (b && b.seg) || '');
}

/** 在 [lo,hi) 这段分钟区间里，找已经选中的小时用过的段 id。
 *  只用于"扩展已有一段"时沿用 id；区间内没有已存在的段就返回空（= 新建一段）。
 *
 *  注意这里**不看区间外侧**：紧挨着另一段不算"同一段"，
 *  这正是"相邻两段不许合并"的关键。 */
function ccSegIdIn(day, lo, hi) {
  for (let h = 0; h < 24; h++) {
    const hs = h * 60;
    if (hi <= hs || lo >= hs + 60) continue;
    // **按窗口**判断，不能按小时：09:00–09:30 与 09:30–10:00 在同一个小时里，
    // 按小时判断会让第二段"借用"第一段的 id，然后被合并成一段——
    // 这正是"两个半小时变成一个一小时"的直接原因。
    for (const w of hourWins(day[h])) {
      const a = hs + w.from;
      const b = hs + w.to;
      if (b > lo && a < hi && w.seg) return w.seg;
    }
  }
  return '';
}

function ccSegs(day) {
  const out = [];
  // 上限是方案级的（跟着当前生效方案），循环外取一次
  const cap = Math.max(0, Math.min(60, clockProfile().defCap || 0));
  for (let h = 0; h < 24; h++) {
    const p = day[h];
    const ws = hourWins(p);
    if (!ws.length) continue;
    const work = Math.max(1, Math.min(60, p.work || 50));
    const brk = Math.max(0, Math.min(60 - work, p.brk || 0));
    for (const w of ws) {
      const absFrom = h * 60 + w.from;
      const last = out[out.length - 1];
      // 同段 + 首尾相接 → 接成一段（跨小时的那一段）
      if (last && ccSameSegId(last.seg, w.seg) && last.endAbs === absFrom) {
        last.h1 = h;
        last.t1 = w.to;
        last.endAbs = h * 60 + w.to;
        last.mins += w.to - w.from;
        continue;
      }
      out.push({
        h0: h,
        h1: h,
        f0: w.from,
        t1: w.to,
        seg: w.seg || '',
        endAbs: h * 60 + w.to,
        mins: w.to - w.from,
        work,
        brk,
        cap,
      });
    }
  }
  // 补 range / rounds（原来在循环里算，现在统一收尾）
  for (const sg of out) {
    const endH = sg.t1 >= 60 ? sg.h1 + 1 : sg.h1;
    sg.range = `${pad(sg.h0)}:${pad(sg.f0)}–${pad(endH)}:${sg.t1 >= 60 ? '00' : pad(sg.t1)}`;
    sg.rounds = Math.floor(sg.mins / Math.max(1, sg.work + sg.brk));
    delete sg.endAbs;
  }
  return out;
}

/** 一段的概括性内容：节奏 + 轮数 + 时长，一句话 */
function ccSegBrief(sg) {
  // 设了休息上限时也说一句：否则用户看到"休息 5 分"却只休了 3 分钟会以为坏了
  const cap = sg.cap > 0 ? `（每小时最多休 ${sg.cap} 分）` : '';
  const rhythm = sg.brk ? `专注 ${sg.work} 分 / 休息 ${sg.brk} 分${cap}` : `连续专注 ${sg.work} 分`;
  const rounds = sg.rounds > 0 ? `${sg.rounds} 个番茄` : '不足 1 轮';
  return `${rhythm} · ${rounds} · ${ccMinText(0, sg.mins).dur}`;
}

/** 微缩周视图：时间轴（形状）+ 时段摘要（内容），都没有坐标 / 刻度 / 交互 */
function ccMiniHtml(prof, wdNow) {
  const cols = prof.days.map((day, d) => {
    let bars = '';
    day.forEach((p, h) => {
      if (!p.on) return;
      const f = Math.max(0, Math.min(59, p.from || 0));
      const t = Math.max(1, Math.min(60, p.to == null ? 60 : p.to));
      bars += `<i style="top:${((h * 60 + f) / 1440 * 100).toFixed(2)}%;`
        + `height:${((t - f) / 1440 * 100).toFixed(2)}%"></i>`;
    });
    return `<div class="cc-mini-col${d === wdNow ? ' today' : ''}">${bars}</div>`;
  }).join('');

  // 逐段摘要：按周一到周日、按时间先后排
  const rows = [];
  prof.days.forEach((day, d) => {
    for (const sg of ccSegs(day)) rows.push({ d, sg });
  });
  const CAP = 6;
  const shown = rows.slice(0, CAP);
  const rest = rows.length - shown.length;
  const list = shown.map(({ d, sg }) => `
      <div class="cc-mini-row${d === wdNow ? ' today' : ''}">
        <span class="dw">${WD[d]}</span>
        <span class="rg">${sg.range}</span>
        <span class="br">${ccSegBrief(sg)}</span>
      </div>`).join('') + (rest > 0
    ? `<div class="cc-mini-row more">还有 ${rest} 段，点开完整图表查看</div>` : '');

  const total = prof.days.reduce((n, d) => n + ccDayMinutes(d), 0);
  const head = WD.map((w, i) => `<span class="${i === wdNow ? 'today' : ''}">${w.slice(1)}</span>`).join('');
  return `
    <div class="cc-mini" data-act="cc-open" role="button" tabindex="0" title="点击展开完整图表">
      <div class="cc-mini-hd">${head}</div>
      <div class="cc-mini-body">${cols}</div>
      <div class="cc-mini-list">${rows.length ? list : '<div class="cc-mini-row more">还没排任何时段</div>'}</div>
      <div class="cc-mini-ft">
        <span class="nm">${esc(prof.name)}</span>
        <span class="sum">${total ? `每周 ${ccMinText(0, total).dur} · ${rows.length} 段` : '还没排任何时段'}</span>
        <span class="go">展开完整图表 ›</span>
      </div>
    </div>`;
}

/** 大日历的格子 HTML —— 只在完整页里生成（折叠时不算这 168 个格子）
 *  行数跟着「显示范围」走：默认 24 行，设成 07:00–23:00 就只画 16 行。 */
function ccGridHtml(prof, wdNow, hourNow) {
  const step = ccStep();
  const qn = ccQCnt();
  const hourH = ccHourH();
  const view = ccView();
  const h0 = view.from / 60;
  const h1 = view.to / 60;
  let grid = `<div class="cc-corner" style="grid-row:1;grid-column:1">时</div>` + WD.map((w, i) =>
    `<div class="cc-dh${i === wdNow ? ' today' : ''}" style="grid-row:1;grid-column:${i + 2}">${w}${i === wdNow ? '·今' : ''}</div>`).join('');
  for (let h = h0; h < h1; h++) {
    const row = h - h0 + 2;
    grid += `<div class="cc-hlab" style="grid-row:${row};grid-column:1">${h}</div>`;
    for (let dd = 0; dd < 7; dd++) {
      const p = prof.days[dd][h];
      const w = Math.max(0, Math.min(60, p.work || 0));
      const b = Math.max(0, Math.min(60 - w, p.brk || 0));
      const t = Math.max(0, 60 - w - b);
      const snap = ccSnapWin(p.from, p.to);
      const pf = p.on ? snap.f : 0, pt = p.on ? snap.t : 60;
      const winTxt = pf > 0 || pt < 60
        ? `${WD[dd]} ${pad(h)}:${pad(pf)} – ${pad(h)}:${pad(pt)}`
        : `${WD[dd]} ${pad(h)}:00 – ${pad(h + 1)}:00`;
      let qs = '';
      for (let q = 0; q < qn; q++) {
        const a = qStart(q), bq = qEnd(q);
        const onQ = p.on && pf < bq && a < pt;
        qs += `<i class="cc-q${onQ ? ' on' : ''}" data-q="${q}" data-a="${a}" data-b="${bq}"
          style="top:${(q * 100 / qn).toFixed(4)}%;height:${(100 / qn).toFixed(4)}%"></i>`;
      }
      grid += `<div class="cc-cell${p.on ? ' on' : ''}${dd === wdNow && h === hourNow ? ' now' : ''}"
        style="grid-row:${row};grid-column:${dd + 2}" data-d="${dd}" data-h="${h}"
        title="${winTxt}${p.on ? ` · 专注 ${w} 分 / 休息 ${b} 分${t ? `（尾段 ${t} 分继续专注）` : ''}，右键可改` : '（未选中，拖动或右键可设置）'}">${qs}</div>`;
    }
  }
  return { grid, hourH, step, qn, rows: view.hours };
}

/** 分钟数 → "HH:MM"（睡眠时段用；1440 显示成 00:00，表示"到次日 0 点"） */
function minToHm(m) {
  const v = Math.max(0, Math.min(1440, Math.round(m || 0)));
  return `${pad(Math.floor(v / 60) % 24)}:${pad(v % 60)}`;
}
/** "HH:MM" → 分钟数；非法输入返回 null */
function hmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], mm = +m[2];
  if (h > 24 || mm > 59) return null;
  return Math.max(0, Math.min(1440, h * 60 + mm));
}

/** 睡眠状态那一句话（卡片用；pull 轮询时也用它原地刷新，不整页重绘） */
function sleepStateOf(rt) {
  const s = (S.data.config.settings.sleep) || {};
  const st = (rt && rt.sleep) || {};
  const fromM = s.from == null ? 23 * 60 : +s.from;
  const toM = s.to == null ? 7 * 60 : +s.to;
  if (!s.enabled) return { cls: '', txt: '未启用：睡眠时段内开机不会被限制' };
  if (st.locked) {
    const left = Math.max(0, st.remain || 0);
    return {
      cls: 'hot',
      txt: st.shutdown
        ? `锁定中 · ${Math.floor(left / 60)} 分 ${pad(left % 60)} 秒后自动关机`
        : `锁定中 · 只锁屏，不关机（${minToHm(fromM)} – ${minToHm(toM)}）`,
    };
  }
  if (st.inWindow && st.unlockedUntil > 0) {
    const d = new Date(st.unlockedUntil * 1000);
    return { cls: 'gold', txt: `已用积分解锁至 ${pad(d.getHours())}:${pad(d.getMinutes())}，到点后重新锁定` };
  }
  if (st.inWindow) {
    return { cls: 'gold', txt: '在睡眠时段内（未锁定：请检查「锁定屏幕」开关或测试模式）' };
  }
  // 多段时不能猜"下次锁定几点"：两段之间到底哪段先来、明天是否生效，
  // 得把周期算进去才准。算不准就别说，别给一个错的时刻。
  const multi = Array.isArray(s.windows) && s.windows.length > 1;
  return {
    cls: '',
    txt: multi ? '现在不在任何睡眠时段内' : `现在不在睡眠时段，下次锁定 ${minToHm(fromM)}`,
  };
}

/* ── 睡眠时段：多段 + 生效周期 ──────────────────────────────
 *
 * 数据层只有一个真相：`settings.sleep.windows[]`。每段自带 from/to/days/
 * 锁屏/关机/倒计时/启动清单；`days` 又是"生效周期"的唯一真相，
 * 模式（每天 / 工作日 / 指定）只是它的投影——这样就不会出现
 * "模式说每天、days 里却躺着周一"这种自相矛盾的配置。
 *
 * 兼容：`windows` 为空时用旧的 from/to 合成一段（伪 id `__legacy`），
 * 界面照常显示、保存时写回旧字段。用户一旦碰周期或添加时段，
 * `sleepEnsureWindows()` 会把它落成真正的 windows[0]，前后参数一字不变。
 */

/** 段列表：windows 为空时合成一段"旧字段" */
function sleepSegs() {
  const s = clockCfgSleep();
  if (Array.isArray(s.windows) && s.windows.length) return s.windows;
  return [{
    id: '__legacy',
    from: s.from == null ? 23 * 60 : +s.from,
    to: s.to == null ? 7 * 60 : +s.to,
    days: [],
    enabled: true,
    lockScreen: s.lockScreen !== false,
    shutdown: s.shutdown !== false,
    countdownMin: s.countdownMin == null ? 10 : +s.countdownMin,
    wake: s.wake || { enabled: false, items: [] },
  }];
}

/** 正在编辑的那一段（选中的 id 失效就退回第一段） */
function sleepSelSeg() {
  const list = sleepSegs();
  return list.find((x) => x.id === S.sleepSel) || list[0];
}

/** 周期模式：days 的投影，规则与 Rust 侧 sleep_window::cycle_mode 一致 */
function sleepCycleMode(seg) {
  // 显式模式优先：在「指定」里勾出周一到周五时，它就是「指定」。
  // 早先靠 days 投影，集合恰好等于工作日就跳成「仅工作日」，
  // 再点「指定」又立刻弹回去——用户看到的是"点不动"。
  const m = (seg && seg.mode) || '';
  if (m === 'everyday' || m === 'workdays' || m === 'custom') return m;
  // 老数据没有 mode：按 days 投影，与升级前一致
  const d = (seg && seg.days) || [];
  if (!d.length) return 'everyday';
  if (d.length === 5 && d.every((x) => x < 5)) return 'workdays';
  return 'custom';
}

/** 周期的一句话描述 */
function sleepCycleText(seg) {
  const m = sleepCycleMode(seg);
  if (m === 'everyday') return '每天';
  if (m === 'workdays') return '仅工作日';
  const WD = ['一', '二', '三', '四', '五', '六', '日'];
  const d = (seg.days || []).slice().sort((a, b) => a - b);
  return d.map((k) => '周' + (WD[k] || '?')).join('、');
}

/** 把"单段"升级成"多段"：用户碰周期或多段时，必须存在真正的段对象。
 *  升级前后 from/to/开关一个字都不变，所以对用户是无感的。 */
function sleepEnsureWindows() {
  const s = clockCfgSleep();
  if (Array.isArray(s.windows) && s.windows.length) return s.windows;
  const seg = sleepSelSeg();
  s.windows = [{
    id: 'w1',
    from: +seg.from,
    to: +seg.to,
    days: (seg.days || []).slice(),
    mode: sleepCycleMode(seg),
    enabled: true,
    lockScreen: !!seg.lockScreen,
    shutdown: !!seg.shutdown,
    countdownMin: +seg.countdownMin || 10,
    wake: seg.wake || { enabled: false, items: [] },
  }];
  S.sleepSel = 'w1';
  return s.windows;
}

/** 多段时的时段列表（单段不渲染列表：只有一段时列表纯属占地方） */
function sleepSegListHtml() {
  const s = clockCfgSleep();
  const multi = Array.isArray(s.windows) && s.windows.length > 1;
  if (!multi) return '';
  const cur = sleepSelSeg();
  const rows = s.windows.map((w, i) => `
    <div class="sl-row${w.id === cur.id ? ' on' : ''}">
      <span class="sl-idx">${i + 1}</span>
      <span class="sl-time">${minToHm(w.from)} – ${w.to >= 1440 ? '24:00' : minToHm(w.to)}</span>
      <span class="sl-cycle">${esc(sleepCycleText(w))}</span>
      <span class="sl-tags">${w.lockScreen ? '<b>锁屏</b>' : '<b class="off">不锁</b>'}${w.shutdown ? '<b>关机</b>' : '<b class="off">不关</b>'}</span>
      <button class="btn btn-sm" data-act="sleep-pick-seg" data-id="${esc(w.id)}"
        ${w.id === cur.id ? 'disabled' : ''}>${w.id === cur.id ? '编辑中' : '编辑'}</button>
      <button class="btn btn-sm danger-ghost" data-act="sleep-del-seg" data-id="${esc(w.id)}">删</button>
    </div>`).join('');
  return `<div class="sl-list"><div class="sl-hd">共 ${s.windows.length} 段睡眠</div>${rows}</div>`;
}

/** 表单：作用对象是"选中的那一段"（单段时就是伪段） */
function sleepFormHtml(seg) {
  const s = clockCfgSleep();
  const fromM = +seg.from;
  const toM = +seg.to;
  const count = +seg.countdownMin || 10;
  const price = s.unlockPrice == null ? 10 : +s.unlockPrice;
  const umin = s.unlockMin == null ? 30 : +s.unlockMin;
  const mode = sleepCycleMode(seg);
  const WD = ['一', '二', '三', '四', '五', '六', '日'];
  const days = (seg.days || []).slice().sort((a, b) => a - b);
  return `
    <div class="sleep-grid">
      <label class="sf"><span class="sf-lab">睡眠时段</span>
        <span class="sf-in">
          <input type="time" id="sleepFrom" value="${minToHm(fromM)}">
          <em>至</em>
          <input type="time" id="sleepTo" value="${minToHm(toM)}">
          <em class="hint">（结束填 00:00 = 到次日 0 点，例如 23:00 – 00:00）</em>
        </span>
      </label>
      <label class="sf"><span class="sf-lab">生效周期</span>
        <span class="sf-in">
          <span class="sl-seg">
            <button class="${mode === 'everyday' ? 'active' : ''}" data-act="sleep-cycle" data-v="everyday"
              title="每天都按这个时段管">每天</button>
            <button class="${mode === 'workdays' ? 'active' : ''}" data-act="sleep-cycle" data-v="workdays"
              title="周一到周五生效，周末不管">仅工作日</button>
            <button class="${mode === 'custom' ? 'active' : ''}" data-act="sleep-cycle" data-v="custom"
              title="自己挑星期几">指定</button>
          </span>
          <span class="sl-days"${mode === 'custom' ? '' : ' hidden'}>${WD.map((d, k) => `<button
            class="${days.includes(k) ? 'on' : ''}" data-act="sleep-day" data-v="${k}"
            title="周${d}">${d}</button>`).join('')}</span>
        </span>
      </label>
      <label class="sf"><span class="sf-lab">开机后</span>
        <span class="sf-in">
          <input type="number" id="sleepCount" min="1" max="120" step="1" value="${count}">
          <em>分钟内自动关机</em>
        </span>
      </label>
      <label class="sf"><span class="sf-lab">积分解锁</span>
        <span class="sf-in">
          <input type="number" id="sleepPrice" min="0" max="1000" step="1" value="${price}">
          <em>分 / 分钟，一次买</em>
          <input type="number" id="sleepUnlockMin" min="5" max="240" step="5" value="${umin}">
          <em>分钟</em>
          <em class="hint">（价格填 0 = 这段睡眠不许用积分解锁）</em>
        </span>
      </label>
      <label class="sf"><span class="sf-lab">到点关机</span>
        <span class="sf-in">
          <input type="checkbox" id="sleepShutdown" ${seg.shutdown === false ? '' : 'checked'}>
          <em>真的执行关机（关掉 = 只锁定、不关机）</em>
        </span>
      </label>
      <label class="sf"><span class="sf-lab">限制功能</span>
        <span class="sf-in">
          <input type="checkbox" id="sleepLockOn" ${seg.lockScreen === false ? '' : 'checked'}>
          <em>睡眠时段内全屏锁定（关掉就只剩倒计时关机）</em>
        </span>
      </label>
    </div>`;
}

/** 「睡眠管理」卡片 */
function sleepCardHtml(rt) {
  const s = clockCfgSleep();
  const st = (rt && rt.sleep) || {};
  const on = !!s.enabled;
  const seg = sleepSelSeg();
  const multi = Array.isArray(s.windows) && s.windows.length > 1;
  const state = sleepStateOf(rt);
  return `
  <div class="card" id="sleepCard">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:14px">
      <div>
        <div class="card-title">睡眠管理</div>
        <div class="card-sub">和「自律时段」是两件事：那边管白天什么时候不许玩，这里管夜里这台机器该关着了。</div>
        <div class="card-sub">到了睡眠时段，开机 / 唤醒后会限制所有功能，倒计时结束自动关机；想现在用，只能用积分解锁。</div>
      </div>
      <div class="switch" data-act="sleep-enable" title="启用 / 停用睡眠管理"><input type="checkbox" ${on ? 'checked' : ''}><i></i></div>
    </div>

    <div class="sleep-state ${state.cls}"><span class="cs-dot"></span><span>${esc(state.txt)}</span></div>

    ${sleepSegListHtml()}
    ${multi ? `<div class="sl-edit-hd">正在编辑第 ${(s.windows.findIndex((x) => x.id === seg.id) + 1) || 1} 段 · ${esc(sleepCycleText(seg))}</div>` : ''}

    ${sleepFormHtml(seg)}


    <div class="row" style="margin-top:14px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-sm" data-act="sleep-save">保存睡眠设置</button>
      <button class="btn btn-sm" data-act="sleep-add-seg" title="加一段不同时间 / 不同策略的睡眠">＋ 添加时段</button>
      <span class="hint">判定只看当前时刻是否落在任一段睡眠时段内，与自律时段、自律规则完全独立。</span>
    </div>
  </div>`;
}

/* ── 进入自律时间自动打开 ──────────────────────────────────
 *
 * 编辑的是一份**草稿**（S.launchDraft），点保存才写回规则。
 * 为什么不像睡眠那样即时保存：这里一次要改好几行（顺序、窗口形式），
 * 每敲一个字就落盘会让"撤销"变得不可能，而且中途状态不完整。
 */

/** 打开面板：把规则的清单深拷贝成草稿 */
function openLaunchModal(id) {
  const r = (S.data.config.rules || []).find((x) => x.id === id);
  if (!r) return;
  const a = r.autolaunch || {};
  S.launchDraft = {
    ruleId: id,
    ruleName: r.name,
    enabled: !!a.enabled,
    items: (a.items || []).map((x, i) => ({
      id: x.id || 'i' + (i + 1),
      kind: x.kind === 'url' ? 'url' : 'app',
      target: x.target || '',
      args: x.args || '',
      window: x.window || 'normal',
      browser: x.browser || '',
    })),
  };
  renderLaunchModal();
}

/** 把面板里每一行的输入同步回草稿（不落盘）。
 *
 *  「软件 / 网页」「窗口化 / 最大化 / 最小化」不再是原生下拉，而是分段按钮，
 *  所以这里按"哪一个是 active"读取——读的还是 DOM，保证"看到的就是存下的"。 */
function launchSync() {
  const d = S.launchDraft;
  if (!d) return;
  const byId = new Map(d.items.map((x) => [x.id, x]));
  document.querySelectorAll('[data-lkrow]').forEach((row) => {
    const it = byId.get(row.dataset.lkrow);
    if (!it) return;
    const get = (k) => (row.querySelector('[data-lk="' + k + '"]') || {}).value;
    /** 分段按钮当前选中的那个值 */
    const pick = (sel) => {
      const on = row.querySelector(`${sel} .active`);
      return on ? on.dataset.v : '';
    };
    const kind = pick('.lk-kind') === 'url' ? 'url' : 'app';
    it.kind = kind;
    it.target = String(get('target') || '');
    it.args = kind === 'url' ? '' : String(get('args') || '');
    it.window = pick('.lk-win') || 'normal';
    it.browser = kind === 'url' ? String(get('browser') || '') : '';
  });
}

function renderLaunchModal() {
  const d = S.launchDraft;
  if (!d) return;
  // 窗口形式：三个并列的分段按钮，不用原生 <select>。
  // 为什么换掉：下拉在深色里只有控件本体跟着主题走，弹出来的选项列表是系统默认的
  // （浅底黑字 / 深底黑字都可能），"窗口化 / 最大化 / 最小化"糊成一片，
  // 和界面其它分段控件的风格也完全不是一路。分段按钮是自绘的，颜色、字号、圆角
  // 全在本项目手里，三项一眼可辨、点了就有明确反馈。
  const WIN = [['normal', '窗口化', '按普通窗口打开'], ['max', '最大化', '铺满屏幕'],
    ['min', '最小化', '只放进任务栏']];
  const rows = d.items.length
    ? d.items.map((it, i) => {
      const url = it.kind === 'url';
      const win = it.window || 'normal';
      return `<div class="lk" data-lkrow="${esc(it.id)}">
        <div class="lk-line lk-main">
          <span class="lk-idx" title="桌面上的排列顺序">${i + 1}</span>
          <div class="lk-kind" role="group" aria-label="软件还是网页">
            <button type="button" data-act="launch-kind" data-id="${esc(it.id)}" data-v="app"
              class="${url ? '' : 'active'}" title="打开本机软件">软件</button>
            <button type="button" data-act="launch-kind" data-id="${esc(it.id)}" data-v="url"
              class="${url ? 'active' : ''}" title="打开一个网址">网页</button>
          </div>
          <input type="text" data-lk="target" value="${esc(it.target)}"
            placeholder="${url ? 'https://example.com' : 'C:\\Program Files\\App\\app.exe'}">
          <span class="lk-ops">
            <button class="btn btn-sm" data-act="launch-up" data-id="${esc(it.id)}" ${i === 0 ? 'disabled' : ''} title="上移">↑</button>
            <button class="btn btn-sm" data-act="launch-down" data-id="${esc(it.id)}"
              ${i === d.items.length - 1 ? 'disabled' : ''} title="下移">↓</button>
            <button class="btn btn-sm danger-ghost" data-act="launch-del" data-id="${esc(it.id)}">删</button>
          </span>
        </div>
        <div class="lk-line lk-sub">
          <span class="lk-lab">打开方式</span>
          <div class="lk-win" role="group" aria-label="打开后的窗口形式">
            ${WIN.map(([v, t, tip]) => `<button type="button" data-act="launch-win"
              data-id="${esc(it.id)}" data-v="${v}" class="${win === v ? 'active' : ''}"
              title="${tip}">${t}</button>`).join('')}
          </div>
          <label class="lk-field">
            <span class="lk-lab">参数</span>
            <input type="text" data-lk="args" value="${esc(it.args || '')}"
              placeholder="启动参数（可空）" ${url ? 'disabled' : ''}>
          </label>
          <label class="lk-field">
            <span class="lk-lab">浏览器</span>
            <input type="text" data-lk="browser" value="${esc(it.browser || '')}"
              placeholder="${url ? '默认浏览器' : '—'}" ${url ? '' : 'disabled'}>
          </label>
        </div>
      </div>`;
    }).join('')
    : '<div class="lk-empty">还没有目标。点下面的「＋ 添加一项」，可以加软件，也可以加网页。</div>';

  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="width:820px">
      <div class="modal-hd">
        <h3>进入自律时间时自动打开</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        <div class="row" style="justify-content:space-between;align-items:flex-start;gap:14px">
          <div style="flex:1">
            <div class="card-sub">规则「${esc(d.ruleName)}」</div>
            <div class="hint" style="line-height:1.8">每到<b>一个专注段的开始</b>（含番茄休息结束回到专注）就对齐一次：</div>
            <div class="hint" style="line-height:1.8">已经开着的窗口直接切到最上层，没开的才启动；软件启动时正好在自律时间里，也会立刻对齐。</div>
          </div>
          <div class="switch" data-act="launch-toggle" title="启用 / 停用"><input type="checkbox" ${d.enabled ? 'checked' : ''}><i></i></div>
        </div>

        <div class="lk-list">${rows}</div>

        <div class="row" style="margin-top:10px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-sm" data-act="launch-add">＋ 添加一项</button>
          <span class="hint">序号就是桌面上的从左到右顺序；「打开方式」决定它启动后是窗口化、最大化还是最小化。</span>
        </div>
        <div class="hint" style="margin-top:8px;line-height:1.8">
          网页的「已打开就切过去」靠窗口标题里的域名判断，属于尽力而为；判不出来会新开一个标签页。
        </div>
      </div>
      <div class="modal-ft">
        <span class="hint" style="flex:1">最多 12 项；网页必须是 http(s) 地址</span>
        <button class="btn" data-act="close-modal">取消</button>
        <button class="btn btn-primary" data-act="launch-save">保存</button>
      </div>
    </div>
  </div>`;
}

/** 「完整展示」是否开着（默认开）。
 *  纯展示参数：关掉只是回到固定行高 + 滚动条，判定与排班一个字都不变。 */
function ccFit() {
  const fc = (S.data && S.data.config && S.data.config.settings && S.data.config.settings.focusClock) || {};
  return fc.fitAll !== false;
}

/** 完整页：大日历（可拖选 / 右键）+ 粒度 + 每日明细 */
function ccDetailHtml(prof, wdNow, hourNow, frozen) {
  const { grid, hourH, step, qn, rows } = ccGridHtml(prof, wdNow, hourNow);
  const view = ccView();
  const fit = ccFit();
  const totalMins = prof.days.reduce((n, d) => n + ccDayMinutes(d), 0);
  // 显示范围外还有多少段：不提醒一下的话，用户会以为"我排的时段没了"
  const outside = prof.days.reduce((n, day) => n + ccSegs(day).filter((sg) => {
    const a = sg.h0 * 60 + sg.f0;
    const b = sg.h1 * 60 + (sg.t1 >= 60 ? 60 : sg.t1);
    return b <= view.from || a >= view.to;
  }).length, 0);
  const dayRows = prof.days.map((day, d) => {
    const m = ccDayMinutes(day);
    const seg = ccDayRanges(day);
    return `<div class="cc-day${d === wdNow ? ' today' : ''}">
      <span class="d">${WD[d]}</span>
      <span class="bar"><i style="width:${(m / 1440 * 100).toFixed(1)}%"></i></span>
      <span class="v">${m ? ccMinText(0, m).dur : '—'}</span>
      <span class="s">${seg.length ? `${seg.length} 段` : ''}</span>
    </div>`;
  }).join('');
  return `
  <div class="cc-detail${S.ccAnimIn ? ' opening' : ''}" id="ccDetail">
    <div class="cc-detail-hd">
      <button class="btn btn-sm" data-act="cc-close">‹ 返回</button>
      <div class="cc-detail-title">生效时间段 · 完整图表<span class="badge">${esc(prof.name)}</span></div>
      <div class="cc-detail-live" id="clockLive">${esc(clockRangeText())}</div>
    </div>
    <div class="cc-detail-bd">
      <div class="cc-gran">
        <span class="cc-gran-lab">每次选择</span>
        ${CC_GRANS.map((g) => `<button class="cc-gran-btn${g === step ? ' active' : ''}"
          data-act="clock-gran" data-v="${g}" ${frozen ? 'disabled' : ''}
          title="每一格代表 ${g} 分钟">${g} 分钟</button>`).join('')}
        <span class="hint">现在每格 ${step} 分钟，一小时 ${qn} 格。切到 10 分钟更细（格子变多、日历变高），已排好的时段不受影响。</span>
      </div>
      <div class="cc-gran cc-view">
        <span class="cc-gran-lab">显示范围</span>
        <label class="cc-view-pick">从 <select data-act="clock-view" data-k="from">
          ${Array.from({ length: 23 }, (_, i) => `<option value="${i}"${i * 60 === view.from ? ' selected' : ''}>${pad(i)}:00</option>`).join('')}
        </select></label>
        <label class="cc-view-pick">到 <select data-act="clock-view" data-k="to">
          ${Array.from({ length: 24 }, (_, i) => `<option value="${i + 1}"${(i + 1) * 60 === view.to ? ' selected' : ''}>${pad(i + 1)}:00</option>`).join('')}
        </select></label>
        <button class="btn btn-sm" data-act="clock-view-reset" title="恢复成全天（00:00 – 24:00）">全天</button>
        <span class="hint">现在只看 ${ccViewText(view)}：<b>只影响显示</b>，范围外的时段照样生效${
  outside ? `（另有 <b>${outside}</b> 段在范围外）` : ''}。</span>
        <div class="cc-fit" id="ccFit">
          <span class="lab">完整展示</span>
          <span class="seg">
            <button class="${fit ? 'active' : ''}" data-act="clock-fit" data-v="1">开</button>
            <button class="${fit ? '' : 'active'}" data-act="clock-fit" data-v="0">关</button>
          </span>
          <span class="state ${fit ? 'on' : ''}">${fit ? '一次铺满，不用滚动' : '固定行高，可滚动'}</span>
        </div>
      </div>
      <div class="cc-main${fit ? ' fit' : ''}" id="ccMain">
        <div class="cc-left">
          <div class="cc-scroll"><div class="cc" id="ccGrid" style="--cc-hour-h:${hourH}px;--cc-rows:${rows}">${grid}</div></div>
          <div class="cc-legend">
            <span><i class="sw sel"></i>选中 / 拖动中</span>
            <span><i class="sw"></i>已放置（已保存）</span>
            <span class="hint">同一个色相，只差 5% 明度：拖的时候亮一点点，松手后轻微加深就是存好了</span>
          </div>
          <div class="tl-legend">
            <span class="hint">
              <b>空白处按住拖动</b> = 新建一段（按当前粒度吸附，最少一格）；
              <b>在已有的条上按住拖动</b> = 整段搬走；
              <b>按住上下边缘</b> = 拉长 / 缩短；
              <b>单击</b> = 只记选区，不改结构；
              <b>右键</b> = 细调时长与起止分钟。
            </span>
            <button class="btn btn-sm" data-act="clock-clear" ${frozen ? 'disabled' : ''}>清空全部</button>
          </div>
        </div>
        <aside class="cc-side">
          <div class="cc-days">
            <div class="cc-days-hd"><span>每日时长</span><span>合计 ${ccMinText(0, totalMins).dur}</span></div>
            ${dayRows}
          </div>
        </aside>
      </div>
    </div>
  </div>`;
}

/* ── 休息结束时的收尾 ─────────────────────────────────────────
 *
 * 只在「休息 → 学习」的那一次边界动手：休息段里黑名单是放行的，用户会把
 * 抖音 / 游戏开起来；回到学习的那一刻，这些窗口不能就这么留着。
 *
 * 两种模式的区别（也写在卡片里，用户改设置时能直接看到）：
 *   柔和 · 最小化：窗口收进任务栏、程序留着，随时能还原；学习期间它被"停放"
 *      （不再被反复强杀），一旦还原就立刻按拦截处理。播放中的媒体会先暂停。
 *   强制 · 关闭：直接关掉（先请程序自己退出，不退出再强制结束）。
 *
 * 网页为什么不在这个开关里：外部进程只能看到浏览器窗口，看不到标签页；
 * 按窗口标题猜会把整个浏览器连坐（用户可能开着十个学习用的标签）。
 * 网页由浏览器插件按标签页精确拦截，一个标签不会牵连其它标签。
 */
function sweepCardHtml(frozen) {
  const sw = sweepCfg();
  const soft = sw.mode !== 'hard';
  const dis = sw.enabled && !frozen ? '' : 'disabled';
  const off = !sw.enabled;
  return `
  <div class="card" id="sweepCard">
    <div class="card-title">休息结束时的收尾</div>
    <div class="card-sub">休息段里黑名单是放行的；回到学习的那一刻，把休息里开着的那些收起来。</div>

    <div class="row" style="justify-content:space-between;align-items:center;gap:14px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px">回到学习时自动收尾</div>
        <div class="hint" style="margin-top:4px">只在「休息 → 学习」的边界执行一次；学习中新打开的应用照常拦截。</div>
      </div>
      <div class="switch${frozen ? ' locked' : ''}" data-act="sweep-toggle"
           title="${frozen ? '自律时段生效中，不能改' : '切换'}"><input type="checkbox" ${sw.enabled ? 'checked' : ''}><i></i></div>
    </div>

    <div class="cc-gran cc-sweep-mode" style="margin-top:14px">
      <span class="cc-gran-lab">处理方式</span>
      <button class="cc-gran-btn${soft ? ' active' : ''}" data-act="sweep-mode" data-v="soft" ${dis}
        title="收起窗口，程序留着，随时可以还原">柔和 · 最小化</button>
      <button class="cc-gran-btn${soft ? '' : ' active'}" data-act="sweep-mode" data-v="hard" ${dis}
        title="直接关闭应用">强制 · 关闭</button>
      <span class="hint">${off ? '收尾已关闭，这两种方式都不会执行。'
    : soft ? '窗口收进任务栏、程序留着；网页换成拦截页（标签还在）。学习期间不再强杀，但点开就按拦截处理。'
      : '直接关掉：先请程序自己退出，不退出再强制结束；网页直接关掉标签页。'}</span>
    </div>

    <div class="row" style="justify-content:space-between;align-items:center;gap:14px;margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px">播放中的媒体一并暂停</div>
        <div class="hint" style="margin-top:4px">只有确实在播放才暂停；已暂停、已停止、状态读不到都不动，也永远不会自动恢复播放。</div>
      </div>
      <div class="switch${frozen || off ? ' locked' : ''}" data-act="sweep-media"
           title="${off ? '先打开上面的收尾' : frozen ? '自律时段生效中，不能改' : '切换'}"><input type="checkbox" ${sw.pauseMedia ? 'checked' : ''} ${off || frozen ? 'disabled' : ''}><i></i></div>
    </div>

    <div class="note" style="margin-top:12px;line-height:1.95">
      <div>作用对象：被自律规则判为「不能开」的软件（黑名单命中的，或白名单之外且不是保护进程的），与拦截用的是同一份判定。</div>
      <div>网页由浏览器插件按标签页执行同一种收尾：柔和 = 换成拦截页（标签保留，休息回来点刷新即可），强制 = 直接关掉标签页；不会因为一个标签连坐整个浏览器。</div>
      <div>执行时机：只在「休息 → 学习」的那一次边界执行；开机或唤醒时如果已经在上课段，不会补做。</div>
    </div>
  </div>`;
}

function viewClock() {
  const d = S.data;
  if (!d) return '';
  const fc = clockCfg();
  const prof = clockProfile();
  const rt = d.runtime || {};
  const wdNow = (new Date().getDay() + 6) % 7; // 0=周一
  const hourNow = new Date().getHours();
  const n = clockCountOn(fc);
  const multi = fc.profiles.length > 1;
  // 这套时段绑定哪些自律规则（空 = 全部）
  const allRules = (S.data.config.rules || []);
  const bound = Array.isArray(prof.bound) ? prof.bound : [];

  // 自律时段生效中（且非测试模式）：与纪律相关的控件置灰
  const frozen = settingsFrozen();
  // 「自律时间内启用自律规则」只有"关掉"是削弱纪律，"打开"是加强 → 只在已打开时置灰
  const applyFrozen = frozen && fc.applyRules;

  // 当前状态一句话
  let stateTxt = '当前不在生效时段';
  let stateCls = '';
  if (fc.enabled && rt.clockInWindow) {
    const left = Math.max(0, rt.clockLeft || 0);
    const mm = Math.floor(left / 60), ss = left % 60;
    if (rt.clockBreak) {
      stateTxt = `休息中 · 还剩 ${mm} 分 ${pad(ss)} 秒（这段时间不拦截、不遮罩）`;
      stateCls = 'gold';
    } else {
      stateTxt = `专注中 · 还剩 ${mm} 分 ${pad(ss)} 秒（自律规则正在生效，应用 / 网页会被关闭）`;
      stateCls = 'green';
    }
  } else if (!fc.enabled) {
    stateTxt = '未启用：下面选中的时段不会生效';
  } else if (!n) {
    stateTxt = '还没有选择任何时段';
  } else if (rt.clockInWindow === undefined || rt.clockInWindow === null) {
    stateTxt = '正在读取时钟状态…';
  } else {
    stateTxt = `当前不在自律时间：自律规则不拦截${ccNextSlotText(fc, wdNow, hourNow)}`;
  }

  // 方案切换条：同一时刻只有一套在生效，切过去立刻按新方案判定
  const chips = fc.profiles.map((p) => {
    const on = p.id === fc.active;
    const cnt = p.days.reduce((m, day) => m + day.filter((h) => h.on).length, 0);
    return `<button class="cc-prof${on ? ' active' : ''}${frozen ? ' locked' : ''}" data-act="clock-prof" data-id="${esc(p.id)}"
      title="${frozen ? '自律时段生效中，不能切换方案' : `切换到「${esc(p.name)}」`}">
      <span class="nm">${esc(p.name)}</span><span class="n">${cnt} 段</span></button>`;
  }).join('');

  // 周日历：第 1 行星期表头，下面 24 行小时格（自上而下 0 → 23）。
  // 所有格子都**显式定位**：连续时段的整块是按行号覆盖上去的，
  // 只要格子还是自动流，自动布局就会绕开被覆盖块占住的位置，整张表会错行。
  // 左上角是「纵轴单位」，不再重复标一个 0（第一个小时标签已经是 0 了）。
  //
  // 每一小时内部**自上而下**再切成若干格（粒度 15 分钟 = 4 格，10 分钟 = 6 格）：
  // 格子是竖向的、位置就是时间顺序；选中的时段画成同样竖向的横条，
  // 两者共用一条纵轴，所以"点哪一格"和"条子出现在哪"必然一致。
  return `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:14px">
      <div>
        <div class="card-title">自律模式生效时间段</div>
        <div class="card-sub">
          横轴一周七天，纵轴 0–24 点，一小时再竖着分成若干格。
          哪几天、哪几段要自律，直接在格子上拖出来——选中的部分就是一条从上到下的横条，条子的长度就是时长。
          到点自动进入自律模式，到点自动退出；自律规则、浏览器巡检、专注遮罩都会跟着这段状态走。
          需要多套排班时，做成几套「星期时段」方案，每套还能各自绑定不同的自律规则分组。
        </div>
      </div>
      <div class="switch${frozen ? ' locked' : ''}" data-act="clock-enable"
           title="${frozen ? '自律时段生效中，开关已锁定' : '启用 / 停用自律时段'}"><input type="checkbox" ${fc.enabled ? 'checked' : ''}><i></i></div>
    </div>

    ${frozen ? `<div class="note" style="border-left:3px solid var(--red);background:rgba(255,92,92,.07);border-color:rgba(255,92,92,.22);margin:14px 0 0">
      <b style="color:var(--red)">🔒 自律时段生效中</b>：这段时间「自律时段」开关和「自律规则」开关都点不动，
      不能切换 / 删除方案，也不能取消已选中的时段或改这一小时的专注 / 休息时长；
      其它时段照常可以安排。等这一段结束（或用积分解锁）之后再改。
    </div>` : ''}

    <div class="cc-profiles">
      <span class="cc-prof-lab">星期时段</span>
      ${chips}
      <button class="cc-prof-add" data-act="clock-prof-new"
        ${frozen || fc.profiles.length >= CC_MAX_PROFILES ? 'disabled' : ''}
        title="${frozen ? '自律时段生效中，不能新建方案' : fc.profiles.length >= CC_MAX_PROFILES ? `最多 ${CC_MAX_PROFILES} 套方案` : '再排一套星期时段'}">+ 新建</button>
    </div>
    <div class="cc-prof-ops">
      <button class="btn btn-sm" data-act="clock-prof-rename" ${frozen ? 'disabled' : ''}>重命名</button>
      <button class="btn btn-sm" data-act="clock-prof-dup" ${frozen || fc.profiles.length >= CC_MAX_PROFILES ? 'disabled' : ''}>复制这套</button>
      <button class="btn btn-sm btn-danger" data-act="clock-prof-del" ${frozen || !multi ? 'disabled' : ''}>删除这套</button>
      <span class="hint">同一时刻只有一套在生效；卡片顶部的开关管的是「自律时段」整体，与选哪套无关。</span>
    </div>

    <div class="cc-bind">
      <div class="cc-bind-hd">
        <span class="cc-bind-title">这套时段生效的自律规则</span>
        <span class="hint">${bound.length ? `已绑 ${bound.length} 组，其余分组这套时段不管` : '没绑任何分组 = 全部生效（默认）'}</span>
      </div>
      <div class="cc-bind-list">
        <button class="cc-bind-chip${bound.length ? '' : ' active'}" data-act="clock-bind" data-id=""
          title="这套时段用上全部已启用的自律规则">全部</button>
        ${allRules.map((l) => `<button class="cc-bind-chip${bound.includes(l.id) ? ' active' : ''}"
          data-act="clock-bind" data-id="${esc(l.id)}"
          title="${esc(l.name)}：${l.apps.length} 个软件 · ${l.sites.length} 个网站${l.enabled ? '' : '（这条没启用，绑了也不会拦）'}">
          ${esc(l.name)}</button>`).join('') || '<span class="hint">还没有自律规则分组，先去「自律规则」建一组</span>'}
      </div>
      <div class="hint" style="margin-top:6px">
        换方案 = 换时间表 + 换管哪些分组。比如「工作日」那套只绑工作类，
        「周末」那套只绑娱乐类，互不干扰。
      </div>
    </div>


    <div class="clock-state ${stateCls}">
      <span class="cs-dot"></span>
      <span>${esc(stateTxt)}</span>
      ${fc.enabled && n ? `<span class="badge">已选 ${n} 个小时段</span>` : ''}
    </div>

    ${ccMiniHtml(prof, wdNow)}
    <div class="cc-def">
      <span class="cc-def-lab">通用时长</span>
      <label>专注 <input type="number" id="defW" min="1" max="60" step="1" value="${prof.defWork}"> 分</label>
      <label>休息 <input type="number" id="defB" min="0" max="60" step="1" value="${prof.defBrk}"> 分</label>
      <label title="一小时里累计能给多少休息；0 = 不限。到上限后剩下的休息整段跳过，继续保持专注">休息上限 <input type="number" id="defCap" min="0" max="60" step="1" value="${prof.defCap || 0}"> 分</label>
      <button class="btn btn-sm" data-act="clock-def-save">保存</button>
      <span class="hint">只作用于「${esc(prof.name)}」这套：之后新框选 / 单击选中的时段都沿用这套时长；右键菜单里改也能顺手更新它</span>
      <span class="hint">一小时里累计能给多少休息；0 = 不限。到上限后剩下的休息整段跳过，继续保持专注</span>
    </div>
  </div>

  ${sleepCardHtml(rt)}

  <div class="card">
    <div class="card-title">它和「自律规则」的关系</div>
    <div class="card-sub">自律时段是总开关，自律规则是执法工具。</div>
    <div class="note" style="line-height:1.95">
      <b>这里（自律时段）</b>：决定"什么时候进入自律时间"。按周排、每周重复，每格 ${ccStep()} 分钟。<br>
      <b>自律规则</b>：只有名单，没有自己的时间表。它<b>只在自律时间（专注段）内生效</b>，其余时间一律静默。<br>
      <b>两者是包含关系</b>：自律时间之外的时段、以及番茄休息段，自律规则都不拦。<br>
      <b>每套时段还能各自绑定分组</b>：上面「这套时段生效的自律规则」勾了哪几组，这套时段就只管那几组。
      <div class="row" style="justify-content:space-between;align-items:center;margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
        <div>
          <div style="font-size:12.5px">自律时间内启用自律规则</div>
          <div class="hint" style="margin-top:4px">关掉后，自律时段只负责"进入自律状态"（遮罩 / HUD / 积分 / 成绩），自律规则完全不拦。</div>
        </div>
        <div class="switch${applyFrozen ? ' locked' : ''}" data-act="clock-apply-rules"
             title="${applyFrozen ? '自律时段生效中，不能关掉' : '切换'}"><input type="checkbox" ${fc.applyRules ? 'checked' : ''}><i></i></div>
      </div>
      <div style="margin-top:12px" class="hint">
        优先级（从高到低）：<b>不在自律时间</b>（一律不拦） &gt; <b>休息段</b>（一律放行） &gt; 自律规则时间范围 &gt; 手动开关。<br>
        自律时段生效期间，专注遮罩如果开了「跟随自律模式」就会跟着自动打开，此时主开关显示为接管、不能手动切。
      </div>
    </div>
  </div>
  ${sweepCardHtml(frozen)}
  ${S.ccFull ? ccDetailHtml(prof, wdNow, hourNow, frozen) : ''}`;
}

/* ---------------- 视图：专注遮罩 ---------------- */
function viewMask() {
  const d = S.data;
  if (!d) return '';
  const m = d.mask;
  const target = d.config.settings.mask.targetTitle || '';
  const op = m.opacity;
  const rt = d.runtime;
  // on  = 最终生效（用户意向 OR 自律接管）
  // userOn = 用户自己按的开关；autoOn = 自律模式正在接管
  const on = !!m.on;
  const previewing = (m.previewLeft || 0) > 0;
  const followed = !!m.followSchedule;
  const autoOn = !!m.autoOn;
  const autonomy = rt.disciplineOn || rt.active.length > 0 || !!rt.locked;
  // 主开关只反映"真实启用"：预览期间不算开启
  const stateOn = on && !previewing;
  const powerState = previewing ? 'preview' : stateOn ? 'on' : 'off';
  const stateTitle = previewing
    ? `预览中 · ${m.previewLeft} 秒后自动结束`
    : autoOn
      ? '已开启 · 自律模式接管中'
      : stateOn
        ? '已开启 · 正在遮罩'
        : '已关闭';
  const stateDesc = previewing
    ? '这只是临时预览，几秒后会自动收起；它<b>不会</b>改变主开关，也不会让遮罩"一直开着"。'
    : autoOn
      ? '自律模式正在生效，遮罩由它自动接管：自律结束时遮罩会自己关掉。<b>这段时间主开关不能手动切</b>。'
      : stateOn
        ? '这是<b>真实生效</b>的状态：其他窗口与任务栏都被压暗，只有当前最上层窗口（含本软件自己）完整可见。'
        : followed
          ? '遮罩当前没有生效。<b>跟随自律模式</b>开着，自律一开始就会自动打开它。'
          : '遮罩当前<b>没有生效</b>。打开下面的开关后，除当前窗口外的区域会立刻被压暗。';
  return `
  <div class="mask-hero">
    <div style="flex:1;min-width:0">
      <div class="hero-label">专注遮罩 / FOCUS MASK</div>

      <div class="mask-power ${powerState}">
        <div class="switch big ${autoOn ? 'locked' : ''}" data-act="toggle-mask" title="${autoOn ? '自律模式接管中，不能手动切换' : ''}">
          <input type="checkbox" ${stateOn ? 'checked' : ''} ${autoOn ? 'disabled' : ''}><i></i>
        </div>
        <div style="flex:1;min-width:0">
          <div class="mp-title">${stateOn ? '专注遮罩已开启' : '专注遮罩已关闭'}</div>
          <div class="hint" style="margin-top:4px">${stateDesc}</div>
        </div>
        <span class="badge ${powerState === 'on' ? 'green' : powerState === 'preview' ? 'gold' : ''}">${stateTitle}</span>
      </div>

      <div class="row" style="align-items:center;gap:9px;margin-top:12px;flex-wrap:wrap">
        <button class="btn" data-act="mask-preview">${previewing ? `结束预览（剩 ${m.previewLeft}s）` : '预览效果（5 秒）'}</button>
        <button class="btn" data-act="mask-diag">自查</button>
        <span class="hint">预览只是看一眼效果，会自动结束，不会改变主开关。</span>
      </div>

      <div class="mask-link">
        <div class="row" style="align-items:center;justify-content:space-between;gap:14px">
          <div>
            <div style="font-size:12.5px">专注遮罩跟随自律模式</div>
            <div class="hint" style="margin-top:4px">
              自律模式一开始，遮罩自动打开；自律模式一结束，遮罩自动关闭。
              组合条件只有一条：<b>生效 = 主开关 OR（跟随自律 AND 自律生效中）</b>——
              自律接管期间主开关置灰（不能手动关），自律一结束立刻回到你自己按的状态，
              两者不会再互相打架。
            </div>
          </div>
          <div class="switch" data-act="toggle-follow-schedule"><input type="checkbox" ${followed ? 'checked' : ''}><i></i></div>
        </div>
        <div class="row" style="align-items:center;justify-content:space-between;gap:14px;margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
          <div>
            <div style="font-size:12.5px">跟随当前窗口</div>
            <div class="hint" style="margin-top:4px">
              打开后不用选目标窗口：遮罩自动盯住<b>当前最上层（正在用）的窗口</b>，只留它可见、其他全压暗。
              切换窗口时洞口平滑移过去，拖动 / 缩放时 1:1 完全跟手。
            </div>
          </div>
          <div class="switch" data-act="toggle-follow"><input type="checkbox" ${m.follow ? 'checked' : ''}><i></i></div>
        </div>
        <div class="row" style="align-items:center;justify-content:space-between;gap:14px;margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
          <div>
            <div style="font-size:12.5px">媒体管控</div>
            <div class="hint" style="margin-top:4px">
              遮罩生效时，自动<b>暂停</b>被盖住（非前台/非呈现）窗口的媒体播放；
              窗口回到前台、或遮罩关闭时<b>自动恢复</b>播放。只动我们暂停过的，
              你自己手动暂停的不会被乱动；归因不到的后台音乐一律不碰。
            </div>
            <div class="hint" style="margin-top:2px">
              需要播放器支持 Windows 的系统媒体控件（浏览器与主流播放器都支持）；
              点上面的「自查」可以看到当前识别到几个媒体会话、暂停了谁。
            </div>
          </div>
          <div class="switch" data-act="toggle-media-pause"><input type="checkbox" ${m.mediaPause ? 'checked' : ''}><i></i></div>
        </div>
      </div>
    </div>

    <div class="mask-preview">
      <div class="screen"></div>
      <div class="dim" id="previewDim" style="opacity:${op / 100}"></div>
      <div class="hole" id="previewHole">当前窗口</div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-title">遮罩参数</div>
    <div class="card-sub">拖动即时生效——遮罩开着的时候，你可以直接在屏幕上看到效果。动画速度就是"从窗口边缘铺满全屏"用多久，数值越大越慢，0 = 瞬间出现。</div>
    <div class="slider-row">
      <span class="lab">不透明度</span>
      <input type="range" min="20" max="100" step="1" value="${op}" id="opRange" />
      <span class="val" id="opVal">${op}%</span>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <div>
        <div style="font-size:12.5px">点击遮罩空白处不穿透</div>
        <div class="hint" style="margin-top:4px">
          开启后，点遮罩空白区域没有任何反应，也不会把别的窗口切到前台——专心时最稳。<br>
          关掉则点击会穿透到被遮罩的窗口，方便临时操作，但点到别的应用会让它变成前台，
          遮罩会跟着换目标。<br>
          不论开关，<b>选中窗口本身永远正常可点</b>。
        </div>
      </div>
      <div class="switch" data-act="toggle-click">
        <input type="checkbox" ${m.blockClick ? 'checked' : ''}><i></i>
      </div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn btn-sm" data-act="mask-save">保存为默认</button>
      <span class="hint" style="align-self:center">改动会立即生效；点保存才会写进配置，下次启动沿用</span>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-title">快捷键</div>
    <div class="card-sub">
      手动开关遮罩的另一种方式。自动化请用上方的「跟随自律模式」，不再按应用逐个配置。
    </div>
    <div class="row" style="align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap">
      <span class="hint" style="width:88px">全局快捷键</span>
      <input type="text" id="hkInput" value="${esc(m.hotkey || '')}" placeholder="Ctrl+Alt+K（留空=不注册）" style="flex:1;max-width:270px" />
      <button class="btn btn-sm" data-act="save-hotkey">保存</button>
      <span class="badge ${m.hotkeyOk ? 'green' : 'red'}">${m.hotkeyOk ? '已注册' : '未注册'}</span>
    </div>

    <!-- KOF-06：提权与 UIPI。
         低级键盘钩子在**未提权**时收不到更高完整性级别进程（管理员窗口）的按键，
         这不是本程序的问题，是 Windows 的 UIPI 隔离。写清楚，别让用户以为"快捷键坏了"。 -->
    ${!S.data.admin ? `<div class="hint" style="margin-top:8px;color:var(--red)">
      当前是普通权限：强制退出用的全局键盘钩子收不到「以管理员身份运行」的窗口里的按键（Windows UIPI 隔离）。
      这是系统限制，不是快捷键没注册——需要覆盖那种窗口时，用上面的「以管理员身份重启」。
    </div>` : ''}

    <!-- KOF-07：键盘自查。弹窗、Tab 循环、焦点是否逃逸，都在这里一眼看到 -->
    <div class="row" style="margin-top:10px;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-sm" data-act="key-check">键盘与焦点自查</button>
      <span class="hint" style="align-self:center">打开一个弹窗，按 Tab 看焦点是否只在弹窗内循环</span>
    </div>
  </div>`;
}

