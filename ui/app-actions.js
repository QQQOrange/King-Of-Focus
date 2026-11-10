/* 全部动作（Act）
 *
 * 由 app.js 按连续切片拆出（见 docs/release-notes 里那一版说明）。
 * 加载顺序就是原来的自上而下顺序：**不要**调整 <script> 的先后，
 * 顶层 const / function 共享同一个全局词法环境，换顺序会改变求值时机。
 */
'use strict';

/* ---------------- 动作 ---------------- */
const Act = window.Act = {
  async nav(view) {
    S.view = view;
    // 完整图表页是"自律时段"的下一层：换页面就收起来，免得下次进来还停在那层
    if (view !== 'clock') S.ccFull = false;
    // 每次进统计页都重拉：以前只在"从没加载过"时拉，
    // 上午看过的页面晚上回来还是上午那几个数（"今天 3 分钟"），
    // 用户会以为统计不涨。
    if (view === 'stats') await loadStats();
    if (view === 'distract') await dxLoad();
    if (view === 'reports') { await loadReports(); await reviewLoad(); }
    if (view === 'sync') { await loadBackups(); }
    if (view === 'browsers') { await Act.browserScan(); return; }
    if (view === 'about') await loadQuota();
    render();
  },

  async loadQuota() { await loadQuota(); render(); },

  async toggleRule(id) {
    const l = S.data.config.rules.find((x) => x.id === id);
    if (!l) return;
    // 时段进行中（含休息段）：自律规则开关整体锁死，开、关都不许动
    if (settingsFrozen()) { guardDiscipline('切换自律规则开关'); render(); return; }
    l.enabled = !l.enabled;
    await saveConfig();
    render();
  },

  async delRule(id) {
    const l = S.data.config.rules.find((x) => x.id === id);
    if (!l) return;
    if (settingsFrozen()) { guardDiscipline('删除自律规则'); return; }
    if (!confirm(`确定删除自律规则「${l.name}」？`)) return;
    S.data.config.rules = S.data.config.rules.filter((x) => x.id !== id);
    await saveConfig();
    render();
  },

  async saveEditor() {
    // 关窗动画那 120ms 里按钮还能点：S.editing 已经置空，再点一次就是
    // "Cannot set properties of null" 被全局兜底弹成一条英文 JS 错误。
    if (!S.editing) return;
    const r = S.editing;
    syncEditorInputs();
    const nameEl = $('#ruleName');
    if (nameEl) r.name = nameEl.value.trim() || '未命名自律规则';
    const rules = S.data.config.rules;
    const i = rules.findIndex((x) => x.id === r.id);
    if (i >= 0) rules[i] = r; else rules.push(r);
    const ok = await saveConfig();
    if (!ok) {
      // 后端拒绝了（多为自律时段里删了已生效的条目）。
      // 保留编辑器不关，用户看得到提示、也能把改动改回去。
      render();
      return;
    }
    S.editing = null;
    closeModal();
    render();
    toast('自律规则已保存', 'ok');
  },

  async pickRunningApp() {
    S.pickerFor = 'app';
    const list = await invoke('list_windows');
    S.picker = list;
    renderPicker();
  },

  /**
   * 选一个"要保留显示的窗口"给专注遮罩用。
   *
   * 以前总览那个「打开遮罩」按钮在没选过目标时只提示"先选一次"，然后跳到遮罩页——
   * 而遮罩页根本没有选窗口的入口（`settings.mask.target_pid` 唯一的写入口是 mask_start
   * 自己）。于是默认配置下这个 CTA 永远走不通。这里把选择器直接接上。
   */
  async pickMaskTarget() {
    S.pickerFor = 'mask';
    try {
      S.picker = await invoke('list_windows');
    } catch (e) {
      toast('读取窗口失败：' + errText(e), 'err');
      return;
    }
    renderPicker();
  },

  async pickFile(kind) {
    const p = await invoke('pick_path', { kind: kind || 'file' });
    if (!p) return;
    if (!S.editing) return;
    const label = p.split(/[\\/]/).pop().replace(/\.exe$/i, '');
    S.editing.apps.push({ id: 'a' + Date.now().toString(36), kind: 'exe', value: p, label });
    renderEditor();
  },

  async pickDir() {
    await Act.pickFile('dir');
  },

  addSite() {
    const el = $('#siteInput');
    if (!el || !S.editing) return;
    const v = el.value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!v) return;
    if (S.editing.sites.some((s) => s.pattern === v)) { el.value = ''; return; }
    S.editing.sites.push({ id: 's' + Date.now().toString(36), pattern: v, label: v });
    renderEditor();
  },

  quickSite(v) {
    if (!S.editing) return;
    if (!S.editing.sites.some((s) => s.pattern === v)) {
      S.editing.sites.push({ id: 's' + Date.now().toString(36), pattern: v, label: v });
      renderEditor();
    }
  },

  addExc() {
    const el = $('#excInput');
    if (!el || !S.editing) return;
    const v = el.value.trim().replace(/^https?:\/\//, '');
    if (!v) return;
    S.editing.exceptions.push(v);
    renderEditor();
  },

  async toggleMask() {
    const d = S.data;
    if (!d) return;
    // 只有"自律正在接管"时才不能手动切；跟随自律开着但自律没生效时，开关照常可用
    if (d.mask.autoOn) {
      toast('自律模式生效中，遮罩由自律模式接管；把「跟随自律模式」关掉才能手动切', 'err');
      return;
    }
    const next = !(d.mask.userOn && !(d.mask.previewLeft > 0));
    try {
      await invoke('mask_set_on', { on: next });
      toast(next ? '遮罩已开启（真实生效），Ctrl+Alt+K 可随时关闭' : '遮罩已关闭', 'ok');
      await pull();
      render();
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
  },

  async maskDiag() {
    let info = '';
    try { info = await invoke('mask_diag'); } catch (e) { info = String(e); }
    const lines = String(info || '（无数据）').split(' | ');
    $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal">
        <div class="modal-hd">
          <h3>遮罩自查</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          <div class="hint" style="margin-bottom:12px">
            这是遮罩线程最后一帧的真实状态。点「测试效果」后再看，<b>painted=true</b> 且
            <b>可见=1</b> 就说明遮罩已经在屏幕上生效；如果显示 on=false，说明它被自动退出了。
          </div>
          <div class="note" style="font-size:12px;line-height:1.9;word-break:break-all">${esc(lines.join('\n')).replace(/\n/g, '<br>')}</div>
        </div>
        <div class="modal-ft">
          <button class="btn" data-act="close-modal">关闭</button>
        </div>
      </div>
    </div>`;
  },

  async maskPreview() {
    try {
      const left = await invoke('mask_preview');
      await pull();
      render();
      toast(left > 0 ? `预览中：${left} 秒后自动结束，不会改变主开关` : '预览已结束', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
  },

  async toggleFollowSchedule() {
    const on = !S.data.config.settings.mask.followSchedule;
    try {
      await invoke('mask_follow_schedule', { enabled: on });
      await pull();
      render();
      toast(on ? '已开启跟随自律：自律开始时自动打开遮罩，结束时自动关闭' : '已关闭跟随自律：遮罩回到手动/快捷键控制', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
  },

  async setOpacity(v) {
    $('#opVal').textContent = v + '%';
    const dim = $('#previewDim');
    if (dim) dim.style.opacity = v / 100;
    // 锁定期间后端会拒绝这条命令（改配置的都要过闸），
    // 不 catch 的话拖动滑块会留下一串 unhandled rejection。
    try {
      await invoke('mask_set', { opacity: +v });
    } catch (e) {
      toast(String(e).replace(/^Error:\s*/, ''), 'err');
    }
  },
  async maskSave() {
    const m = S.data.config.settings.mask;
    const cur = S.data.mask;
    m.opacity = cur.opacity;
    m.blockClick = cur.blockClick;
    m.follow = !!cur.follow;
    m.mediaPause = !!cur.mediaPause;
    // saveConfig() 不抛异常、只返回成败：以前包在 try/catch 里，
    // 固化拒绝写入时先弹红色错误、紧接着又弹"遮罩参数已保存"。
    if (!(await saveConfig())) return;
    toast('遮罩参数已保存', 'ok');
  },

  /* ---- 积分 ---- */
  /** 用积分解锁。
   *
   *  只解"现在正生效的那一段"——所以选项按当前状态给，不摆一堆通用套餐：
   *    · 睡眠时段内 → 买断一次（单价 × 分钟数），走 sleep_unlock
   *    · 自律时段内 → 按分钟买（5/10/15），走 points_unlock
   *    · 都不在     → 明确告诉他现在没有什么要解，别白花积分
   */
  openUnlock() {
    const p = S.data.points;
    const en = I18N.getLang() === 'en';
    const rt = S.data.runtime || {};
    const st = rt.sleep || {};
    const inSleep = !!(st.enabled && st.inWindow && st.price > 0);
    // 只看"真的有东西在拦"：disciplineOn = 规则生效 / 专注段 / 固化。
    // 以前还加了 breakOn，休息段点进来会列出一堆价格，点了却报
    // "当前没有正在进行的自律时段，不需要解锁"（后端只认专注段或生效中的规则）。
    const inDisc = !!rt.disciplineOn;
    const rows = [];

    if (inSleep) {
      const okS = p.balance >= st.price;
      rows.push(`<div class="list-row" style="cursor:pointer;${okS ? '' : 'opacity:.45'}"
          data-act="${okS ? 'do-unlock-sleep' : 'noop'}">
        <span class="badge ${okS ? 'gold' : 'red'}">睡眠时段</span>
        <span class="grow">买断 ${st.unlockMin} 分钟（这一轮睡眠解除锁定，也不关机）</span>
        <span class="tnum" style="color:${okS ? 'var(--gold)' : 'var(--red)'}">${st.price} 分</span>
      </div>`);
    }
    if (inDisc) {
      [5, 10, 15].forEach((m) => {
        const cost = p.price * m;
        const ok = p.balance >= cost;
        // 把"买完还剩多少 / 还差多少"写在旁边：价格随次数涨，不写清就只能凭感觉点
        const tail = ok
          ? `${en ? 'left ' : '买完剩 '}${p.balance - cost}`
          : `${en ? 'short ' : '还差 '}${cost - p.balance}`;
        rows.push(`<div class="list-row" style="cursor:pointer;${ok ? '' : 'opacity:.45'}"
            data-act="${ok ? 'do-unlock' : 'noop'}" data-min="${m}" role="button" tabindex="0">
          <span class="badge ${ok ? 'gold' : 'red'}">自律时段</span>
          <span class="grow">解锁 ${m} 分钟自由时间（只解现在这一轮，排班不动）</span>
          <span class="hint" style="flex:0 0 auto">${tail}</span>
          <span class="tnum" style="color:${ok ? 'var(--gold)' : 'var(--red)'}">${cost} 分</span>
        </div>`);
      });
    }
    if (!rows.length) {
      rows.push(`<div class="note">现在没有正在生效的自律时段或睡眠时段，<b>不需要解锁</b>。
        到点了再回来——积分不会自己跑掉。</div>`);
    }

    $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal" style="width:580px">
        <div class="modal-hd">
          <h3>用积分解锁</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          <div class="row" style="gap:14px;margin-bottom:16px">
            <div class="mini" style="flex:1"><div class="l">当前积分</div><div class="v" style="color:var(--gold)">${p.balance}</div></div>
            <div class="mini" style="flex:1"><div class="l">自律单价</div><div class="v">${p.price} <span style="font-size:12px;font-weight:400">分/分钟</span></div></div>
            <div class="mini" style="flex:1"><div class="l">睡眠买断</div><div class="v">${inSleep ? st.price : '—'} <span style="font-size:12px;font-weight:400">分</span></div></div>
          </div>
          ${rows.join('')}
          <div class="note" style="margin-top:14px">
            解锁只作用于<b>当前这一段</b>：自律时段按分钟买、单价随当天次数 ×1.4；
            睡眠时段一次买断，到期后如果还在时段内会自动重新锁定。提前结束不退还积分。
          </div>
        </div>
        <div class="modal-ft"><button class="btn" data-act="close-modal">取消</button></div>
      </div>
    </div>`;
  },

  async pointsUnlock(min) {
    try {
      const r = await invoke('points_unlock', { minutes: min });
      closeModal();
      await pull();
      render();
      toast(`已解锁 ${min} 分钟，消耗 ${r.spent} 分`, 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },

  hardToggle() {
    syncEditorInputs();
    S.editing.hard = !S.editing.hard;
    renderEditor();
  },
  breakKind(k) {
    syncEditorInputs();
    S.editing.brk = S.editing.brk || { kind: 'none', workMin: 25, breakMin: 5 };
    S.editing.brk.kind = k;
    renderEditor();
  },
  async enterTestMode() {
    try {
      const r = await invoke('test_mode_enter');
      await pull(); await loadReports(); render();
      toast('已进入测试模式：数据写在 ' + (r.dataDir || '独立目录') + '，自律开关可随时切换', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
  },

  async exitTestMode(keep) {
    try {
      await invoke('test_mode_exit', { keep });
      await pull(); await loadReports(); render();
      toast(keep ? '已退出测试模式，测试期间的设置与数据已并入正式环境' : '已退出测试模式，测试数据已丢弃', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },

  async askExitTest(keep) {
    $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal">
        <div class="modal-hd"><h3>${keep ? '退出并保留测试数据' : '退出并丢弃测试数据'}</h3>
          <button class="close-x" data-act="close-modal">×</button></div>
        <div class="modal-bd">
          <div class="note">${keep
            ? '测试期间的自律规则、设置、统计会<b>合并进正式环境</b>，回到正式模式后可以看到。正式环境原有的其它数据不会被删除。'
            : '测试期间产生的配置与统计会<b>全部删除</b>，正式环境保持进入测试模式前的样子。'}</div>
        </div>
        <div class="modal-ft">
          <button class="btn" data-act="close-modal">取消</button>
          <button class="btn ${keep ? 'btn-primary' : 'btn-danger'}" data-act="test-exit-do" data-keep="${keep ? 1 : 0}">确认退出</button>
        </div>
      </div>
    </div>`;
  },

  async toggleFollow() {
    const on = !S.data.mask.follow;
    await invoke('mask_set', { follow: on });
    await pull();
    render();
    toast(on ? '已开启跟随：遮罩会跟着当前最上层窗口走' : '已关闭跟随', 'ok');
  },

  async toggleMediaPause() {
    const on = !S.data.mask.mediaPause;
    try {
      await invoke('mask_media_pause', { enabled: on });
      await pull();
      render();
      toast(on ? '已开启媒体管控：遮罩生效时自动暂停被盖住窗口的媒体，回到前台自动恢复' : '已关闭媒体管控，已暂停的媒体会自动恢复', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
  },

  async toggleClick() {
    const on = !S.data.mask.blockClick;
    await invoke('mask_set', { blockClick: on });
    S.data.mask.blockClick = on;
    render();
  },

  async statsTab(k) {
    S.statsTab = k;
    if (!S.stats) await loadStats();
    render();
  },
  async setRange(r) {
    S.range = r;
    if (r === 'custom') { calFollowRange(); render(); return; }
    calFollowRange();
    await loadStats();
    render();
  },
  async applyRange() {
    S.customStart = ($('#cStart') || {}).value || todayStr();
    S.customEnd = ($('#cEnd') || {}).value || todayStr();
    calFollowRange();
    await loadStats();
    render();
  },
  async refreshStats() {
    await loadStats();
    S.dayCache.clear();
    S.calKey = '';      // 手动刷新 = 两边都重取，不当成"区间没变"跳过
    render();
  },

  /* ---- 时间日历 ---- */
  /** 切周/月：**选中日期保持不变**，切到月视图就显示它所在的那个月 */
  async calMode(m) {
    if (m !== 'week' && m !== 'month') return;
    if (S.calMode === m) return;
    S.calMode = m;
    if (S.calSel) S.calAnchor = S.calSel;
    await calLoad();
  },
  /** 翻页：周 ±7 天、月 ±1 月；选中日不动（区间会自动把它包进来） */
  async calMove(d) {
    const base = parseYmd(S.calAnchor || S.calSel || todayStr());
    if (S.calMode === 'month') {
      S.calAnchor = dateStr(new Date(base.getFullYear(), base.getMonth() + d, 1));
    } else {
      S.calAnchor = dateStr(addDays(base, d * 7));
    }
    await calLoad();
  },
  async calToday() {
    S.calAnchor = todayStr();
    S.calSel = todayStr();
    S.dayDate = todayStr();
    await calLoad();
    dayEnsure();
  },
  async calPick(date) {
    if (!date) return;
    // 在「时间日历」里点某一天 = 把整块「使用时长分布」切到那天看：
    // 饼图、当日日历、周月网格三处同一口径（区间按钮会变成「自定义 某天 ~ 某天」，
    // 想回到整周/整月点一下 本周/本月 就行）。以前只换日历、饼图还停在旧区间，
    // 上面的数字和下面的日期对不上，所以这里连区间一起切。
    S.range = 'custom';
    S.customStart = date;
    S.customEnd = date;
    calFollowRange();        // 日历/当日日历/选中日一起落到这个区间（= 这一天）
    S.dayCache.clear();      // 口径变了：单日缓存作废
    await loadStats();
    render();
    // 跳转：把这天对应的数据带到眼前（卡片本身就在视口外）
    scrollToDist();
  },

  /* ---- 当日日历 ---- */
  /** 上下翻一天；跨出网格窗口时窗口一起跟过去，选中日永远看得见 */
  async dayMove(d) {
    const nt = dateStr(addDays(parseYmd(dayOf()), d));
    S.dayDate = nt;
    S.calSel = nt;
    const win = calWindow();
    if (nt < win.start || nt > win.end) S.calAnchor = nt;
    if (S.calKey !== calRange().key) await calLoad();
    else paintCalSel();     // 窗口没变：只挪选中高亮，不重建网格
    dayEnsure();
    paintPieFocus();
  },
  async dayToday() {
    S.dayDate = todayStr();
    S.calSel = todayStr();
    S.calAnchor = todayStr();
    await calLoad();
    dayEnsure();
    paintPieFocus();
  },
  /** 点色块/图例 = 聚焦这个分类（再点一次取消）：饼图、日历、当日日历同时响应 */
  /** 点一个块 = 选中它所属的应用；再点同一个应用（任一段） = 取消。
   *  同一时刻只可能有一个 key 处于选中态，所以"全选"在数据层不可能发生。 */
  focusPick(key) {
    if (!key) return;
    S.calHit = S.calHit === key ? '' : key;
    // 只切 class：不重建节点，选中/切换/取消都不会闪
    paintFocus();
    paintCalFocus();
    paintPieFocus();
  },
  focusClear() {
    S.calHit = '';
    paintFocus();
    paintCalFocus();
    paintPieFocus();
  },

  async genReport() {
    const period = S.genPeriod || 'daily';
    const now = new Date();
    let start, end;
    if (period === 'daily') { const y = addDays(now, -1); start = end = dateStr(y); }
    if (period === 'weekly') {
      const dow = (now.getDay() + 6) % 7;
      const mon = addDays(addDays(now, -dow), -7);
      start = dateStr(mon); end = dateStr(addDays(mon, 6));
    }
    if (period === 'monthly') {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      start = dateStr(first); end = dateStr(last);
    }
    if (period === 'yearly') { start = `${now.getFullYear() - 1}-01-01`; end = `${now.getFullYear() - 1}-12-31`; }
    try {
      await invoke('report_generate', { period, start, end });
      await loadReports();
      render();
      toast('报告已生成', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },

  async openReport(id) {
    const r = await invoke('report_get', { id });
    if (!r) { toast('报告读取失败', 'err'); return; }
    S.reportView = r;
    renderReportModal();
  },

  /* ---- Hub：激励语录 ---- */

  /** 换一条：**立刻**按当前来源取一条。
   *
   *  本地源不联网（秒换）；联网源真的发一次请求，成功就换上、失败就退到本地池。
   *  两条路都保证"点一次，字就变了"——这是这个按钮唯一的承诺。
   */
  async quoteNext() {
    if (S.quoteBusy) return;                 // 连点只认第一次，避免请求打架
    const feed = quoteActiveFeed();
    if (feed.kind === 'local' || !feed.url) {
      Act.quoteLocalNext(feed, false);
      return;
    }
    S.quoteBusy = true;
    render();
    let r = null;
    try {
      r = await invoke('quote_fetch', { id: feed.id });
    } catch (e) {
      r = { ok: false, reason: String(e) };
    }
    S.quoteBusy = false;
    if (r && r.ok && r.text) {
      S.quoteCur = {
        text: r.text,
        from: r.from || '',
        src: r.from ? 'net' : 'local',
        feed: feed.id,
        feedName: r.feedName || feed.name,
        home: r.home || feed.home || '',
        offline: false,
      };
      render();
      toast(`换好了 · 来自 ${r.feedName || feed.name}`, 'ok');
      return;
    }
    // 失败：不弹错误对话框，静默退到本地池，并在标签上写明"离线"
    Act.quoteLocalNext(feed, true);
    toast(feed.kind === 'local' ? '已换一条本地句子' : '联网没取到，先从本地精选里挑了一条', '');
  },

  /** 从本地池换一条。offline=true 时标签改写成「内置精选」，让用户知道这句不是联网来的 */
  quoteLocalNext(feed, offline) {
    const pool = quoteLocalPool();
    if (!pool.length) return;
    const cur = S.quoteCur && S.quoteCur.text;
    let i = S.quoteLocalIdx || 0;
    for (let k = 0; k < pool.length; k++) {
      i = (i + 1) % pool.length;
      if (pool[i].text !== cur) break;       // 别换出一条一模一样的
    }
    S.quoteLocalIdx = i;
    const q = pool[i];
    S.quoteCur = {
      text: q.text,
      from: q.from || '',
      src: q.src,
      feed: feed.id,
      feedName: offline ? '内置精选' : feed.name,
      home: offline ? '' : (feed.home || ''),
      offline: !!offline,
    };
    render();
  },

  /** 点来源标签：有网址就打开（本地句子没有网址，标签是纯装饰） */
  async quoteOpenSrc() {
    const q = quoteView();
    if (!q.home) { toast('内置句子没有对应网址；想换来源可以右键语录', ''); return; }
    try {
      await invoke('open_url', { url: q.home });
    } catch (e) {
      toast('打开网址失败', 'err');
    }
  },

  /** 右键语录 → 来源设置 */
  quoteSrcMenu() {
    S.quoteFeedEdit = null;
    renderQuoteSrcModal();
  },

  /** 切换来源：立刻写盘，并作废当前这条（标签和句子必须同时换） */
  async quotePickFeed(id) {
    const list = quoteFeeds();
    const f = list.find((x) => x.id === id);
    if (!f) return;
    if (f.id === quoteActiveFeed().id) { closeModal(); return; }
    S.data.config.settings.quoteFeed = f.id;
    S.quoteCur = null;
    S.quoteLocalIdx = 0;
    const ok = await saveConfig();
    closeModal();
    render();
    toast(ok ? `语录来源已切换为「${f.name}」` : '来源没有保存成功', ok ? 'ok' : 'err');
    if (ok && f.kind !== 'local') Act.quoteNext();   // 联网源：顺手取一条，别让用户再点一次
  },

  /** 删除自定义来源（内置的不允许删：它是断网时的兜底） */
  async quoteDelFeed(id) {
    const list = quoteFeeds().slice();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (list[i].builtin) { toast('内置来源不能删除', 'err'); return; }
    // 名字要在 splice 之前记下来：splice 之后 list[i] 已经是"下一条"了，
    // 以前删「一言」会提示"已删除来源「内置精选」"。
    const goneName = list[i].name || id;
    list.splice(i, 1);
    S.data.config.settings.quoteFeeds = list;
    if (S.data.config.settings.quoteFeed === id) S.data.config.settings.quoteFeed = list[0].id;
    S.quoteCur = null;
    const ok = await saveConfig();
    renderQuoteSrcModal();
    render();
    toast(ok ? `已删除来源「${goneName}」` : '删除失败', ok ? 'ok' : 'err');
  },

  /** 添加自定义来源：名称 + 地址 + 类型，三条都必须说得清 */
  async quoteAddFeed() {
    const name = (($('#qfeedName') || {}).value || '').trim();
    const url = (($('#qfeedUrl') || {}).value || '').trim();
    const kind = (($('#qfeedKind') || {}).value || 'json').trim();
    if (!name) { toast('给这个来源起个名字', 'err'); const el = $('#qfeedName'); if (el) el.focus(); return; }
    if (!/^https?:\/\//i.test(url)) { toast('地址要以 http:// 或 https:// 开头', 'err'); const el = $('#qfeedUrl'); if (el) el.focus(); return; }
    const list = quoteFeeds().slice();
    if (list.length >= 12) { toast('最多 12 个来源，先删掉一个', 'err'); return; }
    if (list.some((x) => x.url === url)) { toast('这个地址已经加过了', ''); return; }
    const id = 'u' + Date.now().toString(36);
    list.push({ id, name: name.slice(0, 24), kind, url, home: url, builtin: false });
    S.data.config.settings.quoteFeeds = list;
    S.data.config.settings.quoteFeed = id;      // 刚加的就用它，用户马上能看到效果
    S.quoteCur = null;
    const ok = await saveConfig();
    closeModal();
    render();
    toast(ok ? `已添加来源「${name}」并用它取一条` : '来源没有保存成功', ok ? 'ok' : 'err');
    if (ok && kind !== 'local') Act.quoteNext();
  },

  /** 设置页里直接维护语录：加一条 / 删一条都立即写盘并重绘 */
  async setQuoteAdd() {
    const inp = $('#setQuoteNew');
    const v = ((inp && inp.value) || '').trim();
    if (!v) { if (inp) inp.focus(); return; }
    if (v.length > 120) { toast('一句话最多 120 字', 'err'); return; }
    const list = (S.data.config.settings.customQuotes || []).slice();
    if (list.includes(v)) { toast('这句已经加过了', ''); return; }
    if (list.length >= 60) { toast('最多 60 条，先删掉几条吧', 'err'); return; }
    list.push(v);
    await Act.setQuotes(list);
  },

  async setQuoteDel(i) {
    const list = (S.data.config.settings.customQuotes || []).slice();
    if (i < 0 || i >= list.length) return;
    list.splice(i, 1);
    await Act.setQuotes(list);
  },

  async setQuotes(list) {
    S.data.config.settings.customQuotes = list.slice(0, 60);
    const ok = await saveConfig();
    S.quoteCur = null;
    render();
    toast(ok ? '语录已保存' : '保存失败', ok ? 'ok' : 'err');
  },

  /** 直接从 Hub 写一句新的：打开面板并把光标放进输入框 */
  quoteAddNew() {
    Act.quoteManage();
    setTimeout(() => {
      const inp = $('#quoteNew');
      if (inp) { inp.focus(); inp.scrollIntoView({ block: 'nearest' }); }
    }, 60);
  },

  quoteManage() {
    S.quoteEdit = ((S.data.config.settings || {}).customQuotes || []).slice();
    renderQuoteModal();
  },

  quoteAdd() {
    const inp = $('#quoteNew');
    const v = ((inp && inp.value) || '').trim();
    if (!v) { if (inp) inp.focus(); return; }
    if (v.length > 120) { toast('一句话最多 120 字', 'err'); return; }
    if ((S.quoteEdit || []).includes(v)) { toast('这句已经加过了', ''); return; }
    if ((S.quoteEdit || []).length >= 60) { toast('最多 60 条，先删掉几条吧', 'err'); return; }
    S.quoteEdit = [...(S.quoteEdit || []), v];
    renderQuoteModal();
  },

  quoteDel(i) {
    S.quoteEdit = (S.quoteEdit || []).filter((_, k) => k !== i);
    renderQuoteModal();
  },

  async quoteSave() {
    S.data.config.settings.customQuotes = (S.quoteEdit || []).slice();
    const ok = await saveConfig();      // 内部会 pull + 用后端真实状态回填
    closeModal();
    S.quoteCur = null;
    render();
    toast(ok ? '语录已保存' : '保存失败', ok ? 'ok' : 'err');
  },

  /* ---- 历史报告：类型选择 / 导出 / 删除 ---- */

  genPeriodSet(v) {
    S.genPeriod = v;
    render();
  },

  /** 打开导出面板：三种格式让用户选 */
  repExportOpen(id) {
    const r = S.reports.find((x) => x.id === id);
    if (!r) { toast('报告不存在，可能已被删除', 'err'); return; }
    S.repExport = id;
    $('#modalRoot').innerHTML = `
      <div class="modal-mask" data-act="close-modal-bg">
        <div class="modal" style="width:520px">
          <div class="modal-hd">
            <h3>导出报告</h3>
            <button class="close-x" data-act="close-modal">×</button>
          </div>
          <div class="modal-bd">
            <div class="hint" style="margin-bottom:12px;line-height:1.7">
              ${esc(r.title)}<br>${r.start} ~ ${r.end}
            </div>
            <div class="exp-fmts">
              <button class="exp-fmt" data-act="report-export-do" data-f="md">
                <span class="ic">MD</span>
                <span class="tx"><b>Markdown</b><i>.md · 标题与列表层级完整，适合笔记软件</i></span>
              </button>
              <button class="exp-fmt" data-act="report-export-do" data-f="txt">
                <span class="ic">TXT</span>
                <span class="tx"><b>纯文本</b><i>.txt · 无格式符号，任何设备都能打开</i></span>
              </button>
              <button class="exp-fmt" data-act="report-export-do" data-f="docx">
                <span class="ic">DOC</span>
                <span class="tx"><b>Word 文档</b><i>.docx · 带标题样式与两级项目符号，可直接打印</i></span>
              </button>
            </div>
          </div>
          <div class="modal-ft">
            <button class="btn" data-act="close-modal">取消</button>
          </div>
        </div>
      </div>`;
  },

  async repExportDo(fmt) {
    const id = S.repExport;
    if (!id) return;
    const btns = [...document.querySelectorAll('.exp-fmt')];
    btns.forEach((b) => { b.disabled = true; });
    const cur = document.querySelector(`.exp-fmt[data-f="${fmt}"]`);
    if (cur) cur.classList.add('busy');
    try {
      const p = await invoke('report_export', { id, format: fmt });
      closeModal();
      toast(`已导出：${p}`, 'ok');
    } catch (e) {
      const msg = String(e || '');
      // 用户在系统对话框里点了取消，不算失败
      if (msg.includes('已取消')) toast('已取消导出', '');
      else toast(`导出失败：${msg}`, 'err');
      btns.forEach((b) => { b.disabled = false; });
      if (cur) cur.classList.remove('busy');
    }
  },

  /** 删除前二次确认：删的是报告，原始日数据不动 */
  repDeleteAsk(id) {
    const r = S.reports.find((x) => x.id === id);
    if (!r) { toast('报告不存在，可能已被删除', 'err'); return; }
    S.repDelete = id;
    $('#modalRoot').innerHTML = `
      <div class="modal-mask" data-act="close-modal-bg">
        <div class="modal" style="width:460px">
          <div class="modal-hd">
            <h3>删除这份报告？</h3>
            <button class="close-x" data-act="close-modal">×</button>
          </div>
          <div class="modal-bd">
            <div style="font-size:13px;line-height:1.8">
              <b>${esc(r.title)}</b><br>
              <span class="hint">${r.start} ~ ${r.end} · 生成于 ${new Date(r.created * 1000).toLocaleString()}</span>
            </div>
            <div class="hint" style="margin-top:12px">删除后无法恢复。原始逐日统计数据不受影响，需要的话可以重新生成。</div>
          </div>
          <div class="modal-ft">
            <button class="btn" data-act="close-modal">取消</button>
            <button class="btn btn-danger" data-act="report-del-do">确认删除</button>
          </div>
        </div>
      </div>`;
  },

  async repDeleteDo() {
    const id = S.repDelete;
    if (!id) return;
    const btn = document.querySelector('[data-act="report-del-do"]');
    if (btn) { btn.disabled = true; btn.textContent = '正在删除…'; }
    try {
      await invoke('report_delete', { id });
      S.repDelete = null;
      closeModal();
      await loadReports();
      render();
      toast('已删除该报告', 'ok');
    } catch (e) {
      toast(`删除失败：${String(e)}`, 'err');
      if (btn) { btn.disabled = false; btn.textContent = '确认删除'; }
    }
  },

  /* ---- 遮罩：快捷键 / 自动触发 ---- */
  async saveHotkey() {
    const v = ($('#hkInput') || {}).value || '';
    try {
      await invoke('mask_hotkey', { combo: v });
      await pull(); render();
      toast(v ? `快捷键已设为 ${v}` : '已取消快捷键', 'ok');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
  },
  /* ---- 备份 ---- */
  async backupMake() {
    try {
      const r = await invoke('backup_make');
      await loadBackups();
      render();
      toast(`已生成备份 ${r.name}（${r.encrypted ? '密码加密，两端都能恢复' : '明文，请妥善保管'}）`, r.encrypted ? 'ok' : 'warn');
    } catch (e) { toast(String(e), 'err'); }
  },
  async backupRestore(path) {
    const mode = await askRestoreMode('恢复这份备份？', '文件来自本机的备份目录。');
    if (!mode) return;
    await runRestore((pass) => invoke('backup_restore', { path, mode, pass }), 'backup_restore', { path, mode });
  },
  /** 导出成可以拷到手机上的文件 */
  async backupExport() {
    const pass = ((S.data.config.settings || {}).backup || {}).password || '';
    if (!pass && !confirm('没设备份密码，导出的是明文文件。继续吗？')) return;
    try {
      const r = await invoke('backup_export');
      toast(r.encrypted
        ? `已导出 ${r.rules} 条规则（密码加密）`
        : `已导出 ${r.rules} 条规则（明文，请妥善保管）`, r.encrypted ? 'ok' : 'warn');
    } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); }
  },
  /** 从任意文件恢复：电脑导出的、手机导出的都认 */
  async backupImport() {
    const mode = await askRestoreMode('从文件恢复', '选一个 .kofbak 备份文件，电脑或手机导出的都行。');
    if (!mode) return;
    await runRestore((pass) => invoke('backup_import', { mode, pass }), 'backup_import', { mode });
  },
  async backupDelete(path) {
    if (!confirm('删除这份备份文件？')) return;
    await invoke('backup_delete', { path });
    await loadBackups(); render();
  },
  async backupSavePass() {
    const v = ($('#bkPass') || {}).value || '';
    await invoke('backup_save', { password: v, autoOnStart: !!($('#bkAuto') || {}).checked });
    await pull(); render();
    toast(v ? '备份密码已保存（之后都用它加密）' : '已改为明文备份：两端都能读，但请妥善保管', 'ok');
  },
  async cloudList() {
    toast('正在读取云端备份…');
    try {
      S.cloud = await invoke('backup_cloud_list');
      renderCloudModal();
    } catch (e) { toast('读取失败：' + errText(e), 'err'); }
  },
  async cloudUpload() {
    try {
      const msg = await invoke('backup_cloud_upload');
      S.cloud = await invoke('backup_cloud_list');
      await loadBackups();
      render();
      toast(msg, 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },
  async cloudRestore(name) {
    const mode = await askRestoreMode('恢复云端的 ' + name + '？', '这台机器会按你选的方式应用它。');
    if (!mode) return;
    await runRestore((pass) => invoke('backup_cloud_restore', { name, mode, pass }), 'backup_cloud_restore', { name, mode });
  },

  async saveNotify() {
    const enabled = !!($('#ntEnabled') || {}).checked;
    const work = +(($('#ntWork') || {}).value || 0);
    const brk = +(($('#ntBreak') || {}).value || 0);
    const brkOn = !!($('#ntBreakOn') || {}).checked;
    try {
      await invoke('notify_save', {
        enabled,
        workBefore: Math.max(0, Math.min(120, work)),
        breakBefore: Math.max(0, Math.min(120, brk)),
        breakNotify: brkOn,
      });
      await pull();
      render();
      toast('提醒设置已保存', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },

  async saveQuoteMins() {    const v = +(($('#quoteMins') || {}).value || 60);
    await invoke('hud_save', {
      enabled: !!(S.data.config.settings.hud || {}).enabled,
      quoteMinutes: v,
    });
    await pull();
    render();
    toast(`短语每 ${v} 分钟换一次`, 'ok');
  },

  async saveCustomDays() {    const v = +(($('#customDays') || {}).value || 0);
    S.data.config.settings.stats.customDays = Math.max(0, Math.min(365, v));
    if (!S.data.config.settings.stats.customAnchor) S.data.config.settings.stats.customAnchor = todayStr();
    if (!(await saveConfig())) return;
    toast(v > 0 ? `已设置每 ${v} 天生成一次报告` : '已关闭自定义周期', 'ok');
  },

  async cfgSwitch(k) {
    const st = S.data.config.settings;
    if (k.indexOf('.') > 0) {
      // 嵌套配置（如 browserGuard.enabled）：按点号路径取字段并取反
      const [group, field] = k.split('.');
      if (!st[group]) st[group] = {};
      st[group][field] = !st[group][field];
      await saveConfig();
      render();
      return;
    }
    if (k === 'alwaysOnTop') {
      // 窗口层级必须由后端改（前端只能存一个布尔值）。
      // 这里不做乐观更新：等后端真的把窗口设成置顶之后再刷新界面，
      // 免得出现"开关亮了但窗口还在下面"的假象。
      const next = !st.alwaysOnTop;
      try {
        await invoke('set_always_on_top', { enabled: next });
        st.alwaysOnTop = next;
        toast(next ? '主窗口已置顶' : '已取消置顶', 'ok');
      } catch (e) {
        toast('切换置顶失败：' + errText(e), 'err');
      }
      await pull(); render(); return;
    }
    if (k === 'hudEnabled') {
      const h = st.hud || (st.hud = { enabled: true, quoteMinutes: 60 });
      h.enabled = !h.enabled;
      await invoke('hud_save', { enabled: h.enabled, quoteMinutes: h.quoteMinutes || 60 });
      await pull(); render(); return;
    }
    if (k === 'runAsAdmin') {
      const turningOn = !st.runAsAdmin;
      // 开启要重启进程 = 退出程序。自律时段里这条路必须堵死，
      // 否则"点一下开关"就成了绕过「自律期间不能退出」的后门。
      if (turningOn && settingsFrozen() && !S.data.admin) {
        toast('自律时段生效中，切换管理员模式要重启程序，先等这段结束', 'err');
        return;
      }
      st.runAsAdmin = turningOn;
      try {
        await invoke('set_run_as_admin', { enabled: st.runAsAdmin });
      } catch (e) { toast(String(e).replace(/^Error:\s*/, ''), 'err'); return; }
      if (st.runAsAdmin) {
        if (S.data.admin) {
          // 已经是管理员 → 后端不会重启，别骗用户说"正在重启"
          toast('已开启：当前已经是管理员，下次启动同样以管理员运行', 'ok');
          await pull(); render(); return;
        }
        // 后端已经落盘 + 拉起了提权副本，本进程 350ms 后退出。
        // 这里不要再 saveConfig / pull —— 进程随时会走，调用会失败并弹红条。
        toast('已保存，正在以管理员身份重启…', 'ok');
        return;
      }
      toast('已关闭管理员模式（下次启动生效）', 'ok');
      await saveConfig();
      await pull(); render(); return;
    }
    if (k === 'autostart') {
      st.autostart = !st.autostart;
      await invoke('set_autostart', { enabled: st.autostart });
    } else if (k === 'statsEnabled') {
      st.stats.enabled = !st.stats.enabled;
    } else if (k === 'countIdle') {
      st.stats.countIdle = !st.stats.countIdle;
    } else {
      st[k] = !st[k];
    }
    await saveConfig();
    render();
  },

  async statToggle(k) {
    const s = S.data.config.settings.stats;
    s[k] = !s[k];
    await saveConfig();
    render();
  },

  async saveNum(k) {    const map = {
      pollMs: ['settings', 'pollMs', 300, 5000],
      graceSecs: ['settings', 'graceSecs', 20, 600],
      retentionDays: ['stats', 'retentionDays', 30, 3650],
    };
    const m = map[k];
    if (!m) return;
    const el = $('#' + k);
    const v = +(el ? el.value : 0);
    const obj = m[0] === 'settings' ? S.data.config.settings : S.data.config.settings.stats;
    obj[m[1]] = Math.max(m[2], Math.min(m[3], v || m[2]));
    if (!(await saveConfig())) return;
    render();
    toast('已保存', 'ok');
  },

  /** 分区重置：选中哪一块，就只重置哪一块 */
  async resetSection() {
    const k = S.resetSection || 'rules';
    const meta = RESET_SECTIONS.find((s) => s[0] === k) || [k, k, ''];
    const frozen = !!(S.data && S.data.runtime && (S.data.runtime.locked || S.data.runtime.disciplineOn));
    const tip = frozen
      ? `当前正在自律时段/固化中。\n\n重置「${meta[1]}」会被后端拒绝（这等于削弱当前这一轮自律）。\n\n确定要试一下吗？`
      : `重置「${meta[1]}」？\n\n${meta[2]}\n\n重置前会自动存一份快照，之后可以点「撤销上次重置」回来。`;
    if (!confirm(tip)) return;
    try {
      const r = await invoke('config_reset_section', { section: k });
      await pull();
      render();
      toast(`已重置：${meta[1]}`, 'ok');
      if (r && r.section) S.resetLast = r;
    } catch (e) {
      toast(errText(e), 'err');
    }
  },

  async resetUndo() {
    const st = S.resetLast || {};
    const name = (RESET_SECTIONS.find((s) => s[0] === st.section) || [0, st.section || ''])[1];
    if (!confirm(`撤销上次重置（${name}）？\n\n会把配置恢复到那次重置之前的样子。`)) return;
    try {
      await invoke('config_reset_undo');
      await pull();
      render();
      toast('已撤销上次重置', 'ok');
    } catch (e) {
      toast(errText(e), 'err');
    }
  },

  async saveProtected() {
    const el = $('#protectedList');
    if (!el) return;
    S.data.config.settings.protected = el.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!(await saveConfig())) return;
    toast('保护名单已保存', 'ok');
  },

  /** 切主题。
   *
   *  **不要在这里 `render()`，也不要 `await saveConfig()`**——这两件事是点
   *  「跟随系统」卡顿的全部来源：
   *    · `saveConfig()` 末尾会 `pull()`（第二个 IPC），并把当前视图整个重绘一次；
   *    · `render()` 再把整页重建一次。
   *  而主题是纯 CSS 变量的：改 `data-theme` 就已经换色了，DOM 一个都不用动。
   *  所以这里只做"立刻生效 + 落盘放后台"，滚动位置和输入焦点都不会丢。 */
  async setTheme(v) {
    const st = S.data.config.settings;
    const prev = st.theme || 'system';
    const msg = v === 'system' ? '已跟随系统外观' : v === 'light' ? '已切换到浅色' : '已切换到深色';
    if (v === prev) { toast(msg, 'ok'); return; }
    st.theme = v;
    applyTheme();        // ① 立刻换色（只改 data-theme，无 DOM 重建）
    paintThemeChoice();  // ② 三个按钮的选中态
    renderChrome();      // ③ 侧栏那行「◐ 跟随系统（浅）」
    const ok = await saveConfigQuiet();   // ④ 只落盘，不回拉
    if (!ok) {
      // 落盘失败：pull() 已经把 S.data 换回后端真实状态，再刷一次按钮态即可
      applyTheme();
      paintThemeChoice();
      renderChrome();
      return;
    }
    toast(msg, 'ok');
  },
  /** 切换界面语言：写配置 → 重绘内容 → 全量应用。
   *  先 render 再 applyLang：重绘出来的节点是中文原文，切换/还原都走同一条路。 */
  async setLang(v) {
    const want = v === 'en' ? 'en' : 'zh-CN';
    if (langPref() === want) return;
    S.data.config.settings.lang = want;
    const ok = await saveConfig();
    render();
    applyLang();
    toast(ok
      ? (want === 'en' ? '已切换到 English' : '已切换回简体中文')
      : '语言保存失败', ok ? 'ok' : 'err');
  },
  async cycleTheme() {
    const cur = S.data.config.settings.theme || 'system';
    const next = cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system';
    await Act.setTheme(next);
  },

  async restartAdmin() { await invoke('restart_as_admin'); },
  /** KOF-07：键盘/焦点自查（弹窗本身就是被检查的那一层） */
  keyCheck() { renderKeyCheck(); },
  async openExt() { try { await invoke('open_extension_dir'); } catch (e) { toast(String(e), 'err'); } },
  async forceQuit() {
    // 强制退出不弹确认框（语义就是"立刻走"），但要有一次防误触的确认，
    // 否则点一下界面就整个程序没了。
    if (!confirm('确定要强制退出 King Of Focus 吗？\n（等同于按 Ctrl+Alt+F4）')) return;
    try { await invoke('force_quit'); } catch (e) { toast(String(e), 'err'); }
  },
  async openCfg() { await invoke('open_config_dir'); },
  async openStatsDir() { const p = await invoke('stats_dir_path'); await invoke('open_path', { path: p }); },

  /* ---- 云同步 ---- */
  async syncAuto() {
    // 以前只改内存 + render()：1.5 秒后 pull() 就把开关刷回磁盘上的旧值，
    // 用户按了「保存配置」也存不下来 —— 这个开关等于从来没生效过。
    S.data.config.settings.sync.auto = !S.data.config.settings.sync.auto;
    const ok = await saveConfig();
    render();
    if (ok) toast(S.data.config.settings.sync.auto ? '已开启自动同步' : '已关闭自动同步', 'ok');
  },
  async syncSave() {
    const url = ($('#davUrl') || {}).value || '';
    const username = ($('#davUser') || {}).value || '';
    const password = ($('#davPass') || {}).value || '';
    const autoMinutes = +(($('#davMins') || {}).value || 30);
    const auto = !!S.data.config.settings.sync.auto;
    try {
      // 地址留空 = 默认地址（后端补）；「启用」看的是账号是否填了：
      // 没有账号的匿名 PUT 只会在每半小时失败一次，那不如老实标成未启用。
      await invoke('sync_save', {
        url, username, password, auto, autoMinutes,
        enabled: !!username.trim(),
      });
      await pull(); render();
      // 回显**实际保存的地址**而不是再写一份默认值：
      // 默认地址只有后端一个来源（model::DEFAULT_SYNC_URL），前端再抄一份迟早会漂。
      const saved = (S.data.config.settings.sync.url || '').trim();
      toast(saved ? '同步配置已保存：' + saved : '同步配置已保存', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },
  async syncRun(kind) {
    const cmd = { now: 'sync_now', up: 'sync_upload', down: 'sync_download' }[kind];
    try {
      const msg = await invoke(cmd);
      await pull(); render();
      toast(msg || '同步完成', 'ok');
    } catch (e) {
      await pull(); render();
      toast('同步失败：' + errText(e), 'err');
    }
  },

  /* ---- 浏览器插件 ---- */
  async browserScan() {
    S.browserScanning = true;
    render();
    try {
      const r = await invoke('browsers_scan');
      S.browsers = r.list || [];
      await pull();
    } catch (e) {
      toast(String(e), 'err');
    }
    S.browserScanning = false;
    render();
  },

  /** 手动指定浏览器主程序路径。
   *  主通道走后端 `pick_path`（tauri_plugin_dialog 原生文件选择框，与自律规则页"选择 exe"同一条已验证链路）。
   *  后端对话框不可用时退回输入框，保证任何情况下都能设/清除，不被一个对话框堵死。 */
  /** 自定义浏览器：选 exe（选择器优先，取不到就退回粘贴） */
  async customBrowserPick() {
    let picked = null;
    try {
      picked = await withTimeout(
        invoke('pick_path', { kind: 'file' }),
        300000,
        '选择文件超时'
      );
    } catch (e) {
      picked = null;
    }
    if (!picked) return;
    const box = $('#cbExe');
    if (box) box.value = String(picked);
    const nm = $('#cbName');
    if (nm && !nm.value.trim()) {
      // 名称空着就先用文件名兜底，省得用户再想一个
      nm.value = String(picked).split(/[\\/]/).pop().replace(/\.exe$/i, '');
    }
  },

  async customBrowserSave() {
    const name = (($('#cbName') || {}).value || '').trim();
    const exe = (($('#cbExe') || {}).value || '').trim();
    if (!name) { toast('先给这个浏览器起个名字', 'err'); return; }
    if (!exe) { toast('先选择或粘贴主程序路径', 'err'); return; }
    try {
      await invoke('browser_custom_save', { id: '', name, exe, extPage: '' });
      if ($('#cbName')) $('#cbName').value = '';
      if ($('#cbExe')) $('#cbExe').value = '';
      toast('已添加，正在重新检测…', 'ok');
      await Act.browserScan();
    } catch (e) {
      toast(String(e && e.message ? e.message : e), 'err');
    }
  },

  async customBrowserDel(id) {
    if (!id) return;
    if (!confirm('删除这个自定义浏览器？只是不再登记它，不会动浏览器本身。')) return;
    try {
      await invoke('browser_custom_remove', { id });
      toast('已删除', 'ok');
      await Act.browserScan();
    } catch (e) {
      toast(String(e && e.message ? e.message : e), 'err');
    }
  },

  async browserSetPath(key) {
    let picked = null;
    try {
      picked = await withTimeout(
        invoke('pick_path', { kind: 'file' }),
        300000,
        '选择文件超时'
      );
    } catch (e) {
      picked = null;
    }
    // pick_path 有效返回 → 用它；返回 null/空 = 用户点了取消或对话框不可用，
    // 再走输入框让用户粘路径（留空=清除）。两条路都不会无声失败。
    if (!picked) {
      picked = window.prompt(
        '粘贴浏览器主程序（.exe）的完整路径：\n例如 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n\n留空并确定 = 清除自定义设置、改为自动检测',
        ''
      );
    }
    if (picked === null) return;
    try {
      const msg = await invoke('browser_set_path', { key, path: String(picked) });
      toast(msg, 'ok');
      await pull();
      render();
    } catch (e) {
      const m = String(e).replace(/^Error:\s*/, '');
      toast('这个路径不能用：' + m, 'err');
      const s = $('#extOpenStatus');
      if (s) {
        s.className = 'ext-status err';
        s.innerHTML = '✗ 路径无效：' + esc(m) + '<br>请重新选择该浏览器的 .exe 主程序。';
      }
    }
  },

  /** 打开扩展管理页。所有等待路径都有终态，不会出现"点完就没了" */
  async browserPage(key, el) {
    const status = (txt, cls) => {
      const s = $('#extOpenStatus');
      if (s) { s.className = 'ext-status ' + (cls || ''); s.innerHTML = txt; }
    };
    const btn = el && el.classList ? el : null;
    const oldTxt = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '正在打开…'; }
    status('正在打开扩展管理页…', 'busy');
    try {
      // 12 秒兜底：进程真起不来也得给个结论，不能让按钮一直转
      const msg = await withTimeout(
        invoke('browser_open_ext', { key }),
        12000,
        '等待浏览器响应超时'
      );
      toast(msg + '（10 分钟内不会因为插件状态关浏览器）', 'ok');
      status('✓ ' + esc(msg), 'ok');
      return true;
    } catch (e) {
      const m = String(e).replace(/^Error:\s*/, '');
      toast('打不开扩展管理页：' + m, 'err');
      status(
        '✗ 打不开扩展管理页。' + esc(m) +
        '<br>如果原因是"找不到主程序"，点「设置路径」手动选中该浏览器的 .exe 即可。<br>' +
        '也可以点「打开文件夹」，然后在浏览器里手动打开扩展页 → 开发者模式 → 加载已解压的扩展程序。',
        'err'
      );
      return false;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldTxt || '扩展页'; }
    }
  },

  async browserInstall(key) {
    // 顺序很重要：先出弹窗（用户立刻看到"正在做什么"），再去拉起浏览器。
    // 以前是先 await 拉起浏览器 → 进程卡住时界面一片死寂，看起来就是"卡死"。
    await Act.browserGuide(key);
    await Act.browserPage(key, $('#instOpenBtn'));
  },

  async browserGuide(key) {
    const list = (S.data && S.data.browsers) || S.browsers || [];
    const name = (list.find((b) => b.key === key) || {}).name || '浏览器';
    let info = (S.data && S.data.extInfo) || {};
    try {
      info = await withTimeout(invoke('browser_ext_info'), 8000, '读取扩展目录超时');
    } catch (e) { /* 用状态里的旧值，不影响后面的步骤 */ }
    $('#modalRoot').innerHTML = `
    <div class="modal-mask" data-act="close-modal-bg">
      <div class="modal">
        <div class="modal-hd">
          <h3>给 ${esc(name)} 装插件</h3>
          <button class="close-x" data-act="close-modal">×</button>
        </div>
        <div class="modal-bd">
          <div id="extOpenStatus" class="ext-status ${key ? 'busy' : ''}">${key ? '正在打开扩展管理页…' : '按下面三步装好即可。'}</div>
          <ol class="ext-steps">
            <li>在扩展页右上角打开 <b>开发者模式</b></li>
            <li>点 <b>加载已解压的扩展程序</b>，选中下面这个文件夹</li>
            <li>回到这里点 <b>完成，重新检测</b>，状态会变成「插件已启用」</li>
          </ol>
          ${extFolderPanel(info)}
          <div class="hint" style="margin-top:10px">
            也可以把 <code>${esc(((info.crx || 'KingOfFocus-Extension.crx').split('\\').pop()) || '')}</code>
            直接拖进扩展页（同样要先开开发者模式）。装的时候不会关你的浏览器。
          </div>
        </div>
        <div class="modal-ft">
          <button class="btn" data-act="close-modal">稍后</button>
          <button class="btn" data-act="ext-open">打开文件夹</button>
          <button class="btn btn-primary" id="rescanBtn" data-act="browser-rescan">完成，重新检测</button>
        </div>
      </div>
    </div>`;
  },

  /** 弹窗里的"完成，重新检测"：一定有结果，并且会自己关掉弹窗 */
  async browserRescan() {
    const btn = $('#rescanBtn');
    const st = $('#extOpenStatus');
    if (btn) { btn.disabled = true; btn.textContent = '检测中…'; }
    if (st) { st.className = 'ext-status busy'; st.textContent = '正在重新读取各浏览器的插件记录…'; }
    try {
      const r = await withTimeout(invoke('browsers_scan'), 15000, '检测超时');
      const list = r.list || [];
      S.browsers = list;
      const ready = list.filter((b) => b.installed && b.ext === 'enabled');
      const broken = list.filter((b) => b.installed && (b.ext === 'notInstalled' || b.ext === 'disabled'));
      closeModal();
      await pull();
      if (S.view === 'browsers') await Act.browserScan(); else render();
      if (ready.length) {
        toast(`检测完成：${ready.length} 个浏览器的插件已就绪`, 'ok');
      } else if (broken.length) {
        toast('还是没检测到插件。确认文件夹选对后，点「重新检测」再看一次', 'err');
      } else {
        toast('检测完成：没有发现受支持的浏览器', '');
      }
    } catch (e) {
      const m = String(e).replace(/^Error:\s*/, '');
      if (btn) { btn.disabled = false; btn.textContent = '完成，重新检测'; }
      if (st) {
        st.className = 'ext-status err';
        st.innerHTML = '✗ 检测失败：' + esc(m) + '<br>可以稍后再试，或直接看下面的扩展文件夹路径手动确认。';
      }
      toast('检测失败：' + m, 'err');
    }
  },

  async extCopy() {
    const info = S.data.extInfo || {};
    const ok = await copyText(info.path || '');
    const note = $('#extNote');
    if (ok) {
      toast('扩展路径已复制到剪贴板', 'ok');
      if (note) note.innerHTML = `<b style="color:var(--gold)">已复制。</b>在资源管理器地址栏 Ctrl+V 回车，再选中 extension 文件夹。`;
    } else {
      // 复制多半失败于 webview 权限：退化成"让用户手动选"
      toast('复制失败（剪贴板不可用），可以点「打开文件夹」直接从地址栏复制', 'err');
      if (note) note.innerHTML = `<b style="color:var(--red)">复制失败。</b>请点「打开文件夹」，在资源管理器地址栏里复制路径；或手动输入：<code>${esc(info.path || '')}</code>`;
    }
  },

  async browserOpenFolder() {
    const note = $('#extNote');
    const btns = document.querySelectorAll('[data-act="ext-open"],[data-act="browser-open-folder"]');
    if (note) { note.className = 'hint busy'; note.textContent = '正在打开资源管理器…'; }
    btns.forEach((b) => { b.disabled = true; });
    try {
      const msg = await withTimeout(invoke('browser_open_folder'), 12000, '打开资源管理器超时');
      toast(msg, 'ok');
      if (note) note.innerHTML = `<b style="color:var(--green)">${esc(msg)}</b>`;
    } catch (e) {
      const msg = String(e).replace(/^Error:\s*/, '').replace(/\n/g, ' ');
      toast('打开失败，已给出替代方案', 'err');
      if (note) note.innerHTML = `<b style="color:var(--red)">打不开扩展文件夹。</b>${esc(msg)}`;
    } finally {
      btns.forEach((b) => { b.disabled = false; });
      if (note) note.classList.remove('busy');
    }
  },

  async browserGraceSave() {
    const el = $('#bgGrace');
    const v = Math.max(300, Math.min(3500, Number(el.value) || 1200));
    S.data.config.settings.browserGuard.graceMs = v;
    if (!(await saveConfig())) return;
    toast(`关闭前宽限已设为 ${v}ms`, 'ok');
  },

  /* ---- 自律时段（多套「星期时段」方案 × 24 段） ---- */
  async clockEnable() {
    const fc = clockCfg();
    // 时段进行中（含休息段）：开关整体锁死，两个方向都不许动
    if (settingsFrozen()) { guardDiscipline('切换「自律时段」开关'); render(); return; }
    fc.enabled = !fc.enabled;
    await saveConfig();
    render();
    toast(
      fc.enabled
        ? '自律时段已启用：到了选中的时间会自动进入自律模式'
        : '自律时段已关闭：选中的时间段不再自动开启自律模式',
      'ok'
    );
  },

  async clockApplyRules() {
    const fc = clockCfg();
    // 生效中不能关掉"自律时间内启用自律规则"（打开是加强，不拦）
    if (fc.applyRules && settingsFrozen()) { guardDiscipline('关闭「自律时间内启用自律规则」'); render(); return; }
    fc.applyRules = !fc.applyRules;
    if (!(await saveConfig())) return;
    render();
    toast(fc.applyRules ? '自律时间内启用自律规则' : '自律时间内不再启用自律规则，只负责进入自律状态', 'ok');
  },

  /** 休息结束收尾：总开关。
   *
   *  置灰规则：自律时段生效中不能**关掉**（关掉等于放开纪律），
   *  但允许打开（加强）；与「自律时间内启用自律规则」同一个口径。 */
  async sweepToggle() {
    const sw = sweepCfg();
    if (sw.enabled && settingsFrozen()) { guardDiscipline('关闭「休息结束时的收尾」'); render(); return; }
    sw.enabled = !sw.enabled;
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
    toast(sw.enabled
      ? (sw.mode === 'hard'
        ? '休息结束时会关闭休息里打开的黑名单应用'
        : '休息结束时会最小化休息里打开的黑名单应用')
      : '休息结束后不再收起应用，休息里开的会一直留着', 'ok');
  },

  /** 切柔和 / 强制。生效时机是**下一次**「休息 → 学习」的边界，
   *  不会回头去动已经处理过的窗口。 */
  async sweepMode(v) {
    if (settingsFrozen()) { guardDiscipline('调整收尾方式'); render(); return; }
    const sw = sweepCfg();
    sw.mode = v === 'hard' ? 'hard' : 'soft';
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
    toast(sw.mode === 'hard'
      ? '已切成强制：休息结束直接关闭'
      : '已切成柔和：休息结束只最小化，随时能还原', 'ok');
  },

  /** 柔和模式下的"暂停播放中的媒体"。强制模式关掉应用自然就停了，所以这个开关
   *  只在柔和模式下有意义（界面里也是这么灰的）。 */
  async sweepMedia() {
    if (settingsFrozen()) { guardDiscipline('调整收尾时的媒体处理'); render(); return; }
    const sw = sweepCfg();
    sw.pauseMedia = !sw.pauseMedia;
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
    toast(sw.pauseMedia ? '收尾时会把正在播放的媒体暂停' : '收尾时不动媒体（正在放的继续放）', 'ok');
  },

  async clockClear() {
    const prof = clockProfile();
    if (settingsFrozen()) { guardDiscipline('清空已选时段'); return; }
    let n = 0;
    prof.days.forEach((day) => day.forEach((p) => { if (p.on) { p.on = false; p.seg = ''; n++; } }));
    if (!(await saveConfig())) return;
    render();
    toast(n ? `已清空 ${n} 个小时段` : '当前没有已选时段', n ? 'ok' : 'err');
  },

  /** 取消某一天的某几段（右键"取消这一段"用）。
   *  只动这几段覆盖的小时，其它时段原样保留——所以它和"清空全部"是两件事。 */
  async clockClearRange(d, h0, h1, label) {
    const prof = clockProfile();
    const wdNow = (new Date().getDay() + 6) % 7;
    const hourNow = new Date().getHours();
    if (settingsFrozen() && wdNow === d && hourNow >= h0 && hourNow <= h1) {
      guardDiscipline('取消正在生效的这一段');
      return false;
    }
    let n = 0;
    for (let h = h0; h <= h1; h++) {
      const p = prof.days[d][h];
      if (p.on) { p.on = false; p.from = 0; p.to = 60; p.seg = ''; n++; }
    }
    if (!n) { toast('这一段本来就没选中', 'err'); return false; }
    const ok = await saveConfig();
    render();
    if (!ok) return false;
    toast(`已取消 ${label || `${WD[d]} ${pad(h0)}:00 – ${pad(h1)}:00`}（${n} 个小时段）`, 'ok');
    return true;
  },

  /** 整天：选中 0:00–24:00（沿用这套的通用时长） */
  async clockDaySelect(d) {
    const prof = clockProfile();
    const w = prof.defWork, b = prof.defBrk;
    // 整天 = 一段：一个 id，避免"选中整天"之后被当成 24 个独立段
    const segId = ccNewSegId();
    for (let h = 0; h < 24; h++) {
      const p = prof.days[d][h];
      p.on = true;
      p.work = w;
      p.brk = b;
      p.from = 0;
      p.to = 60;
      p.seg = segId;
    }
    const ok = await saveConfig();
    render();
    if (!ok) return false;
    toast(`${WD[d]} 整天已选中（0:00–24:00，专注 ${w} 分${b ? ` / 休息 ${b} 分` : ''}）`, 'ok');
    return true;
  },

  /** 整天：清空这一天（其它六天不动） */
  async clockDayClear(d) {
    const prof = clockProfile();
    const wdNow = (new Date().getDay() + 6) % 7;
    const hourNow = new Date().getHours();
    if (settingsFrozen() && wdNow === d && prof.days[d][hourNow].on) {
      guardDiscipline('清空今天正在生效的时段');
      return false;
    }
    let n = 0;
    prof.days[d].forEach((p) => { if (p.on) { p.on = false; p.from = 0; p.to = 60; p.seg = ''; n++; } });
    if (!n) { toast(`${WD[d]} 本来就没有选中任何时段`, 'err'); return false; }
    const ok = await saveConfig();
    render();
    if (!ok) return false;
    toast(`已清空 ${WD[d]} 的 ${n} 个小时段`, 'ok');
    return true;
  },

  /** 整天：只改专注 / 休息，**不动**起止分钟（02:10 这种边界不会被抹平） */
  async clockDayWB(d, w, b, defToo) {
    const prof = clockProfile();
    let n = 0;
    for (let h = 0; h < 24; h++) {
      const p = prof.days[d][h];
      // 没选中的小时也记下来：等它被选上时就是这套时长（和"通用时长"是一个意思，
      // 但只影响这一天，不会波及别的天）
      p.work = w;
      p.brk = b;
      if (p.on) n++;
    }
    if (defToo) { prof.defWork = w; prof.defBrk = b; }
    const ok = await saveConfig();
    render();
    if (!ok) return false;
    toast(n
      ? `${WD[d]} 整天：专注 ${w} 分${b ? ` / 休息 ${b} 分` : '（不休息）'}，改了 ${n} 个小时段，起止分钟保持不变`
      : `${WD[d]} 这一天还没有选中时段；时长已记下，选中后即生效`, 'ok');
    return true;
  },

  /** 提交一次自由拖选：[lo,hi) 是当天的一段连续分钟区间。
   *
   *  `mode = 'add'` → 并入这一天的选中范围；`'sub'` → 从原有选中里抹掉这一段。
   *  每个小时各自只存一个窗口 [from,to)，所以同一小时里的两段会被并成一段
   *  （这是数据模型的固有限制，右键菜单里仍可以精细改起止分钟）。
   */
  /** 把某一天 [from,to) 这一段整体平移到 [nFrom,nTo)。
   *
   *  先清原区间、再写新区间，全程只写一次盘、只重绘一次；
   *  两段重叠也没关系——顺序是"先删后加"，重叠部分最后是被写上的。 */
  /** 把 d0 那天的 [from,to) 搬到 d1 那天的 [nFrom,nTo)。
   *  跨天时：先在原所在的天里清掉这一段，再在落点那天并上去。
   *  目标那天已有窗口 → 按"并集"合并（预览里看到的合并结果就是提交结果）。 */
  async clockMoveSeg(d0, from, to, d1, nFrom, nTo, opts) {
    const prof = clockProfile();
    if (settingsFrozen()) { guardDiscipline('调整已选中的时段'); render(); return false; }
    const put = (day, lo, hi, mode) => {
      if (!day) return;
      for (let h = 0; h < 24; h++) {
        const hs = h * 60;
        if (hi <= hs || lo >= hs + 60) continue;
        const p = day[h];
        const isNew = !p.on;
        const wins = ccWinsAfter(p, h, lo, hi, mode, moveSeg);
        ccSetHourWins(p, wins, isNew ? prof.defWork : null, isNew ? prof.defBrk : null);
      }
    };
    // 搬迁沿用原段的 id：搬过去还是"同一段"。
    // 落点那一段是另一个 id，两者即使贴着也不会被合并。
    const moveSeg = ccSegIdIn(prof.days[d0], from, to) || ccNewSegId();
    put(prof.days[d0], from, to, 'sub');
    put(prof.days[d1], nFrom, nTo, 'add');
    const ok = await saveConfig();
    if (!ok) {
      // 保存失败：界面上的预览必须作废，回到服务端的真实状态
      render();
      toast('时段没有保存成功，已恢复原状', 'err');
      return false;
    }
    // 拖拽提交后不重绘：预览已经是最终结果，重绘会让整页闪一下
    if (!(opts && opts.noRender)) render();
    const t = ccMinText(nFrom, nTo);
    const en = I18N.getLang() === 'en';
    // 缩放和搬家是两件事：一个改长度、一个换位置，提示词必须分开，
    // 否则"已把周三的时段移过去"会让人以为整段跑掉了。
    if (opts && opts.resize) {
      toast(en
        ? `Resized ${I18N.t(WD[d1])} to ${t.range} (${ccDurText(nTo - nFrom)})`
        : `已把 ${I18N.t(WD[d1])} 的时段调整为 ${t.range}（共 ${ccDurText(nTo - nFrom)}）`, 'ok');
      return true;
    }
    const where = d0 === d1
      ? `${I18N.t(WD[d0])} ${t.range}`
      : `${I18N.t(WD[d0])} → ${I18N.t(WD[d1])} ${t.range}`;
    toast(en
      ? `Moved to ${where} (${ccDurText(nTo - nFrom)})`
      : `已把 ${where} 的时段移过去（共 ${ccDurText(nTo - nFrom)}）`, 'ok');
    return true;
  },

  async clockCommitRange(d, lo, hi, mode) {
    const prof = clockProfile();
    if (mode === 'sub' && settingsFrozen()) { guardDiscipline('取消已选中的时段'); render(); return; }
    const days = prof.days[d];
    // 本次操作写什么段 id：
    //   · 区间里已经有段（扩展它）→ 沿用那个 id
    //   · 没有（新拖一段）→ 生成新 id
    // 只看区间**内部**，所以紧挨着别的段拖出来的新段永远是独立的一段。
    const segId = ccSegIdIn(days, lo, hi) || ccNewSegId();
    let changed = 0;
    for (let h = 0; h < 24; h++) {
      const hs = h * 60;
      if (hi <= hs || lo >= hs + 60) continue;   // 不涉及这一小时
      const p = days[h];
      const before = JSON.stringify(p);
      const isNew = !p.on;
      // 多窗口：这一小时可能同时有两段（09:00–09:30 + 09:30–10:00）
      const wins = ccWinsAfter(p, h, lo, hi, mode, segId);
      ccSetHourWins(p, wins, isNew ? prof.defWork : null, isNew ? prof.defBrk : null);
      if (JSON.stringify(p) !== before) changed++;
    }
    if (!changed) { render(); return; }   // 没有实际变化就别写盘
    await saveConfig();
    render();
    const t = ccMinText(lo, hi);
    toast(mode === 'sub'
      ? `已取消 ${WD[d]} ${t.range}`
      : `已选中 ${WD[d]} ${t.range}（共 ${t.dur}）`, 'ok');
  },

  /** 单击 = 单独开关一个 15 分钟刻度（与整小时窗口做并/差） */
  async clockToggleQ(d, h, q) {
    const prof = clockProfile();
    const p = prof.days[d][h];
    const a = qStart(q), b = qEnd(q);
    const pf = p.on ? (p.from || 0) : 0;
    const pt = p.on ? (p.to == null ? 60 : p.to) : 60;
    const covered = p.on && pf < b && a < pt;
    if (covered && settingsFrozen()) { guardDiscipline('取消已选中的时段'); render(); return; }
    if (covered) {
      // 挖掉这 15 分钟：保留左右两侧
      const keepL = { f: pf, t: Math.min(pt, a) };
      const keepR = { f: Math.max(pf, b), t: pt };
      if (keepL.t > keepL.f) { p.from = keepL.f; p.to = keepL.t; }
      else if (keepR.t > keepR.f) { p.from = keepR.f; p.to = keepR.t; }
      else { p.on = false; p.from = 0; p.to = 60; p.seg = ''; }
    } else {
      if (!p.on) {
        p.work = prof.defWork;
        p.brk = prof.defBrk;
        // 单独点亮一格：紧挨着的已有段**不并进来**，它就是新的一段
        p.seg = ccSegIdIn(prof.days[d], a, b) || ccNewSegId();
      }
      p.from = p.on ? Math.min(pf, a) : a;
      p.to = p.on ? Math.max(pt, b) : b;
      p.on = true;
    }
    await saveConfig();
    render();
  },

  /** 右键菜单应用：给矩形区域设置专注 / 休息时长（顺带开启这些时段）。
   *  defToo = 同时把这一套更新成「通用」时长，之后新选的时段沿用 */
  /** 右键菜单应用：给矩形区域设置专注 / 休息时长（顺带开启这些时段），
   *  并用起止分钟收窄首/尾小时的选中窗口。
   *  defToo = 同时把这一套更新成「通用」时长，之后新选的时段沿用。
   *  fromMin/toMin：起始分钟作用于第一个小时、结束分钟作用于最后一个小时；
   *  0 / 60 = 整点。范围内先归一成整小时，避免上次留下的窄窗口看不见地残留。 */
  async clockSetWB(d0, d1, h0, h1, w, b, defToo, fromMin, toMin) {
    const prof = clockProfile();
    // 生效中不能改"正在跑的这一小时"的时长（否则等于用改时长逃逸）
    const wdNow = (new Date().getDay() + 6) % 7;
    const hourNow = new Date().getHours();
    if (settingsFrozen() && d0 <= wdNow && wdNow <= d1 && h0 <= hourNow && hourNow <= h1) {
      guardDiscipline('改这一小时的专注 / 休息时长');
      return;
    }
    // 单格的起止分钟必须起早于止：非法时原样返回 false（不改配置），调用方给出提示并留住菜单。
    // 这条兜住一切入口（右键菜单 / 直接调 Act），与菜单里的校验是同一条约束。
    if (d0 === d1 && h0 === h1 && (Number(fromMin) || 0) >= (Number(toMin) || 0)) {
      return false;
    }
    // 起止分钟对齐 15 分钟刻度（边界自动向下/向上取整，零碎时间才对得齐）。
    // snap 后再判一次非法：刻度对齐也可能让「起 >= 止」成立（45/30 → 45/30）。
    const snap = ccSnapWin(fromMin, toMin);
    if (d0 === d1 && h0 === h1 && snap.f >= snap.t) {
      return false;
    }
    let n = 0;
    // 一次设置 = 一段：整个矩形共用一个 id（跨天也是同一段的连续排布）。
    // 若矩形里原本就有一整套同一 id 的段，沿用它，避免"改个时长就把段拆开"。
    const ids = new Set();
    for (let d = d0; d <= d1; d++) {
      for (let h = h0; h <= h1; h++) {
        const q = prof.days[d][h];
        if (q.on && q.seg) ids.add(q.seg);
      }
    }
    const segId = ids.size === 1 ? [...ids][0] : ccNewSegId();
    for (let d = d0; d <= d1; d++) {
      for (let h = h0; h <= h1; h++) {
        const p = prof.days[d][h];
        p.on = true;
        p.work = w;
        p.brk = b;
        p.from = 0;
        p.to = 60;
        p.seg = segId;
        // 清掉这一小时里的"两段"划分（wins）。
        // 引擎和画图都以 wins 为准，留着它的话：右键选「整小时」、
        // 或者把起止分钟改成 00–30，都会提示成功，但图和判定还是原来那两段。
        p.wins = [];
        n++;
      }
    }
    // 起止分钟只落在边界小时上（单格时两个都在这一格）
    prof.days[d0][h0].from = snap.f;
    prof.days[d1][h1].to = snap.t;
    if (defToo) { prof.defWork = w; prof.defBrk = b; }
    await saveConfig();
    render();
    const f2 = prof.days[d0][h0].from, t2 = prof.days[d1][h1].to;
    // 改到了「正在进行中的时段」：它会立刻按新时长重新划分专注 / 休息，提醒一句
    const liveTip = (d0 <= wdNow && wdNow <= d1 && h0 <= hourNow && hourNow <= h1)
      ? '；当前进行中的时段会立即按新时长重新划分'
      : '';
    const winTip = (f2 > 0 || t2 < 60) ? `，起止分钟 ${pad(f2)}–${pad(t2)}` : '';
    toast(`${ccRectText(d0, d1, h0, h1, f2, t2)}：专注 ${w} 分${b ? ` / 休息 ${b} 分` : '（不休息）'}${winTip}，共 ${n} 段${defToo ? '；已更新为通用时长' : ''}${liveTip}`, 'ok');
    return true;
  },

  /** 保存「通用时长」：之后新选中的时段都沿用这套专注 / 休息（只作用于当前方案） */
  async clockDefSave() {
    const prof = clockProfile();
    let w = Math.round(Number($('#defW').value) || 0);
    let b = Math.round(Number($('#defB').value) || 0);
    let c = Math.round(Number(($('#defCap') || {}).value) || 0);
    w = Math.max(1, Math.min(60, w));
    b = Math.max(0, Math.min(60, b));
    if (b > 0 && w + b > 60) b = 60 - w;
    c = Math.max(0, Math.min(60, c));
    prof.defWork = w;
    prof.defBrk = b;
    prof.defCap = c;
    if (!(await saveConfig())) return;
    render();
    // 通用时长只作用于"之后新选的时段"；已经选中的时段保留各自的时长
    const capTip = c > 0
      ? `，每小时休息上限 ${c} 分（到上限后剩下的休息跳过、继续专注）`
      : '，休息不设上限';
    toast(`通用时长已设为 专注 ${w} 分${b ? ` / 休息 ${b} 分` : '（不休息）'}${capTip}：之后新选的时段都会沿用（已选中的时段保持原样）`, 'ok');
  },

  /** 改「每次选择多少分钟」：10 / 15。
   *
   * 只改画法与吸附粒度，不动已有配置 —— from/to 存的是绝对分钟，
   * 原来对齐到 15 分钟边界的时段在 10 分钟粒度下依然对齐，
   * 所以切成 10 分钟不会把排好的表弄乱，只是能排得更细。 */
  async clockGran(v) {
    const fc = clockCfg();
    const g = +v === 10 ? 10 : 15;
    if (fc.granularity === g) return;
    fc.granularity = g;
    if (!(await saveConfig())) return;
    render();
    toast(`已改为每格 ${g} 分钟：一小时 ${60 / g} 格，已排好的时段不受影响`, 'ok');
  },

  /** 图表显示范围：from / to 两端，整点对齐，最少一小时。
   *
   *  这是纯显示参数（不影响判定与存储），所以不做「生效中禁止修改」的限制——
   *  把一天看成 0–24 还是 7–23，跟"要不要自律"完全是两件事。 */
  async clockView(k, v) {
    const fc = clockCfg();
    let from = Math.round((+fc.viewFrom || 0) / 60) * 60;
    let to = Math.round((fc.viewTo == null ? 1440 : +fc.viewTo) / 60) * 60;
    const h = Math.max(0, Math.min(24, Math.round(+v))) * 60;
    if (k === 'from') from = Math.min(h, to - 60);
    else to = Math.max(h, from + 60);
    from = Math.max(0, Math.min(1380, from));
    to = Math.max(from + 60, Math.min(1440, to));
    if (from === (fc.viewFrom || 0) && to === (fc.viewTo == null ? 1440 : fc.viewTo)) return;
    fc.viewFrom = from;
    fc.viewTo = to;
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
  },

  /** 开 / 关「完整展示」：只改行高的算法，切完立刻重绘（图表马上响应） */
  async clockFit(on) {
    const fc = clockCfg();
    const want = !!on;
    if ((fc.fitAll !== false) === want) return;
    fc.fitAll = want;
    const ok = await saveConfig();
    render();
    if (!ok) { toast('这个开关没保存成功', 'err'); return; }
    toast(want
      ? '已开启完整展示：整张图表一次铺满，不用上下滚动'
      : '已关闭完整展示：恢复固定行高，可以滚动看细节', 'ok');
  },

  async clockViewReset() {
    const fc = clockCfg();
    fc.viewFrom = 0;
    fc.viewTo = 1440;
    if (!(await saveConfig())) return;
    render();
    toast('显示范围已恢复为全天（00:00 – 24:00）', 'ok');
  },

  /* ---- 睡眠管理 ---- */

  async sleepSave() {
    const s = clockCfgSleep();
    const seg = sleepSelSeg();
    const isLegacy = seg.id === '__legacy';

    const fromM = hmToMin(($('#sleepFrom') || {}).value);
    let toM = hmToMin(($('#sleepTo') || {}).value);
    const count = Math.round(+($('#sleepCount') || {}).value);
    const price = Math.round(+($('#sleepPrice') || {}).value);
    const umin = Math.round(+($('#sleepUnlockMin') || {}).value);
    const shutdown = !!($('#sleepShutdown') || {}).checked;
    const lock = !!($('#sleepLockOn') || {}).checked;

    if (fromM == null || toM == null) { toast('时间格式应为 HH:MM', 'err'); return; }
    // 结束时间填 00:00 = 到次日 0 点（否则 23:00 – 00:00 会被当成"空时段"）
    if (toM === 0 && fromM > 0) toM = 1440;
    if (fromM === toM) { toast('睡眠时段的起止不能相同（会变成一段空时段）', 'err'); return; }
    if (!Number.isFinite(count) || count < 1 || count > 120) { toast('关机倒计时请填 1–120 分钟', 'err'); return; }
    if (!Number.isFinite(price) || price < 0 || price > 1000) { toast('积分钟价请填 0–1000', 'err'); return; }
    if (!Number.isFinite(umin) || umin < 5 || umin > 240) { toast('一次解锁时长请填 5–240 分钟', 'err'); return; }

    // 写回"这一段"
    seg.from = fromM;
    seg.to = toM;
    seg.countdownMin = count;
    seg.shutdown = shutdown;
    seg.lockScreen = lock;
    s.unlockPrice = price;
    s.unlockMin = umin;

    if (isLegacy) {
      // 单段模式：写回旧字段（Rust 侧 legacy 路径读的就是它们）
      s.from = fromM;
      s.to = toM;
      s.countdownMin = count;
      s.shutdown = shutdown;
      s.lockScreen = lock;
    } else {
      // 多段模式：旧字段保留成"新建段时的默认值"，跟着第一段走，避免两套值越飘越远
      const first = (s.windows || [])[0];
      if (first) {
        s.from = first.from;
        s.to = first.to;
        s.countdownMin = first.countdownMin;
        s.shutdown = first.shutdown;
        s.lockScreen = first.lockScreen;
      }
    }

    // 自动启动那一块：开关在别处即时保存，这里只收"延迟 / 叫醒 / 每一行"
    const w = seg.wake || (seg.wake = { enabled: false, delaySecs: 20, wakeSystem: true, items: [] });
    const dl = Math.round(+($('#wakeDelay') || {}).value);
    if (Number.isFinite(dl) && dl >= 0 && dl <= 300) w.delaySecs = dl;
    const ws = $('#wakeSystem');
    if (ws) w.wakeSystem = !!ws.checked;
    const rows = [...document.querySelectorAll('[data-wkrow]')];
    // 草稿行也要能保存：否则"新加的那一项"永远写不进去
    const byId = new Map((w.items || []).concat(S.wakeDraft || []).map((x) => [x.id, x]));
    const next = [];
    for (const row of rows) {
      const id = row.dataset.wkrow;
      const it = byId.get(id);
      if (!it) continue;
      const get = (k) => (row.querySelector('[data-wk="' + k + '"]') || {}).value;
      const kind = (get('kind') || 'app') === 'url' ? 'url' : 'app';
      const target = String(get('target') || '').trim();
      const args = String(get('args') || '').trim();
      const en = (row.querySelector('[data-wk="enabled"]') || {}).checked;
      if (!target) continue;                       // 空行直接丢掉，不写进配置
      if (kind === 'url' && !/^https?:\/\//i.test(target)) {
        toast(`「${target}」不是 http(s) 地址，已跳过`, 'err');
        continue;
      }
      next.push({ ...it, kind, target, args: kind === 'url' ? '' : args, enabled: en !== false });
    }
    w.items = next;
    S.wakeDraft = [];

    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
    const head = isLegacy ? '' : `第 ${((s.windows || []).findIndex((x) => x.id === seg.id) + 1) || 1} 段：`;
    toast(`睡眠管理已更新 ${head}${minToHm(fromM)} – ${toM >= 1440 ? '24:00' : minToHm(toM)}（${sleepCycleText(seg)}），开机 ${count} 分钟后${shutdown ? '关机' : '只锁定'}`, 'ok');
  },
  async sleepToggleDay(k) {
    sleepEnsureWindows();
    const seg = sleepSelSeg();
    const d = +k;
    const days = (seg.days || []).slice();
    const at = days.indexOf(d);
    if (at >= 0) {
      // 不允许把最后一天也取消：那会变成"一天都不生效"，
      // 界面上是个幽灵段（看着有、其实永不触发）。想每天都生效请切「每天」。
      if (days.length === 1) { toast('至少要选一天；想每天都生效请切到「每天」', 'err'); return; }
      days.splice(at, 1);
    } else {
      days.push(d);
    }
    days.sort((a, b) => a - b);
    seg.days = days;
    // 手动改过日期就是「指定」：不能因为凑巧凑成工作日就自动跳模式
    seg.mode = 'custom';
    S.sleepDaysLast = days.slice();
    const ok = await saveConfig();
    render();
    if (!ok) toast('没保存成功', 'err');
  },

  async sleepEnable() {
    const s = clockCfgSleep();
    s.enabled = !s.enabled;
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    render();
    toast(s.enabled
      ? `睡眠管理已启用：${minToHm(s.from)} – ${minToHm(s.to)} 之间开机，${s.countdownMin} 分钟后自动关机`
      : '睡眠管理已关闭：睡眠时段内不再锁定、也不会关机', 'ok');
  },

  /** 保存睡眠参数。全部走一遍校验再落盘，避免"存了一半"的非法状态。 */
  /* ---- 进入自律时间自动打开 ---- */

  /** 面板里的开关（改草稿，不落盘） */
  launchToggle() {
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    d.enabled = !d.enabled;
    renderLaunchModal();
  },

  /** 加一项：默认软件、窗口化，按顺序排最后 */
  launchAdd() {
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    if (d.items.length >= 12) { toast('最多 12 项，先删掉一个', 'err'); return; }
    d.items.push({
      id: 'i' + Date.now().toString(36),
      kind: 'app',
      target: '',
      args: '',
      window: 'normal',
      browser: '',
    });
    renderLaunchModal();
  },

  launchDel(id) {
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    d.items = d.items.filter((x) => x.id !== id);
    renderLaunchModal();
  },

  /** 上移 / 下移：数组顺序就是排列顺序，所以直接换位置 */
  launchMove(id, dir) {
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    const i = d.items.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.items.length) return;
    const t = d.items[i];
    d.items[i] = d.items[j];
    d.items[j] = t;
    renderLaunchModal();
  },

  /** 切换某一行的「打开方式」（窗口化 / 最大化 / 最小化）。
   *
   *  只改这一行的按钮状态，不重绘整个面板：重绘会把正在输入的输入框
   *  连同光标一起换掉，用户刚敲的半个路径就丢了焦点。
   *  （草稿值由 launchSync 在下次动作 / 保存时统一从 DOM 读回，不会漏。） */
  launchSetWin(id, v) {
    const win = ['normal', 'max', 'min'].indexOf(v) >= 0 ? v : 'normal';
    const row = document.querySelector(`[data-lkrow="${id}"]`);
    if (!row) return;
    row.querySelectorAll('[data-act="launch-win"]').forEach((b) => {
      const on = b.dataset.v === win;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const d = S.launchDraft;
    const it = d && d.items.find((x) => x.id === id);
    if (it) {
      launchSync();
      it.window = win;
    }
  },

  /** 切换「软件 / 网页」：两类目标的可填项不一样（参数 ↔ 浏览器、占位符也不同），
   *  所以这里必须整面板重绘一次，把禁用态和占位文案一起换掉。 */
  launchSetKind(id, v) {
    const kind = v === 'url' ? 'url' : 'app';
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    const it = d.items.find((x) => x.id === id);
    if (!it || it.kind === kind) return;
    it.kind = kind;
    if (kind === 'url') it.args = '';
    else it.browser = '';
    renderLaunchModal();
  },

  /** 保存：校验后写回规则 */
  async launchSave() {
    const d = S.launchDraft;
    if (!d) return;
    launchSync();
    const keep = [];
    for (const it of d.items) {
      const target = (it.target || '').trim();
      if (!target) continue;                       // 空行直接丢掉
      if (it.kind === 'url' && !/^https?:\/\//i.test(target)) {
        toast(`「${target}」不是 http(s) 地址，已跳过`, 'err');
        continue;
      }
      keep.push({ ...it, target });
    }
    const rule = (S.data.config.rules || []).find((x) => x.id === d.ruleId);
    if (!rule) { closeModal(); return; }
    rule.autolaunch = { enabled: !!d.enabled, items: keep };
    const ok = await saveConfig();
    if (!ok) { render(); return; }
    closeModal();
    render();
    toast(ok
      ? (d.enabled
        ? `已为「${rule.name}」配置 ${keep.length} 项自动打开`
        : `已关闭「${rule.name}」的自动打开（清单保留 ${keep.length} 项）`)
      : '没保存成功', ok ? 'ok' : 'err');
  },

  /** 添加一段新睡眠。**新段默认不锁屏**：多一段只是多一个"到点关机"，
   *  不能因为加了一段就把用户整屏锁上——那是最容易吓到人的默认值。 */
  async sleepAddSeg() {
    const s = clockCfgSleep();
    const wins = sleepEnsureWindows();
    if (wins.length >= 8) { toast('最多 8 段睡眠，先删掉一段', 'err'); return; }
    // 找一个不撞的时间当默认值：从 13:00 起每加一段往后挪 1 小时
    const base = 13 * 60 + (wins.length - 1) * 60;
    const from = Math.min(base, 22 * 60);
    const id = 'w' + Date.now().toString(36);
    wins.push({
      id,
      from,
      to: Math.min(from + 60, 1439),
      days: [],
      enabled: true,
      lockScreen: false,
      shutdown: true,
      countdownMin: 10,
      wake: { enabled: false, delaySecs: 20, wakeSystem: true, items: [] },
    });
    S.sleepSel = id;
    const ok = await saveConfig();
    render();
    toast(ok ? `已添加一段：${minToHm(from)} – ${minToHm(from + 60)}（每天 · 只关机不锁屏）` : '添加失败', ok ? 'ok' : 'err');
  },

  /** 切换正在编辑的段（纯界面状态，不落盘） */
  sleepPickSeg(id) {
    S.sleepSel = id;
    render();
  },

  /** 删一段。**永远至少保留一段**：全删光等于"睡眠管理静默失效"，
   *  用户会以为还在管，其实什么都没发生。 */
  async sleepDelSeg(id) {
    const s = clockCfgSleep();
    const wins = Array.isArray(s.windows) ? s.windows : [];
    if (wins.length <= 1) { toast('至少要保留一段；完全不想管就把右上角的开关关掉', 'err'); return; }
    const i = wins.findIndex((x) => x.id === id);
    if (i < 0) return;
    const name = `${minToHm(wins[i].from)} – ${wins[i].to >= 1440 ? '24:00' : minToHm(wins[i].to)}`;
    wins.splice(i, 1);
    if (S.sleepSel === id) S.sleepSel = wins[0].id;
    const first = wins[0];
    s.from = first.from;
    s.to = first.to;
    s.countdownMin = first.countdownMin;
    s.shutdown = first.shutdown;
    s.lockScreen = first.lockScreen;
    const ok = await saveConfig();
    render();
    toast(ok ? `已删除 ${name}` : '删除失败', ok ? 'ok' : 'err');
  },

  /** 切周期模式：每天 / 仅工作日 / 指定。
   *
   *  只动 `days`，不碰时间与开关——所以来回切不会丢任何设置。
   *  切到"指定"时优先恢复**上一次的自定义集合**（用户往往只是临时切走看一眼），
   *  没有历史就先用工作日当起点。
   */
  async sleepCycle(mode) {
    sleepEnsureWindows();          // 单段 → 多段，先把参数落成真段
    const seg = sleepSelSeg();
    const cur = sleepCycleMode(seg);
    if (cur === 'custom' && (seg.days || []).length) {
      S.sleepDaysLast = seg.days.slice().sort((a, b) => a - b);
    }
    seg.mode = mode;
    if (mode === 'everyday') {
      seg.days = [];
    } else if (mode === 'workdays') {
      seg.days = [0, 1, 2, 3, 4];
    } else if (!(seg.days && seg.days.length)) {
      // 「指定」：**保留已经选好的日期**。从「仅工作日」切过来时那就是周一到周五，
      // 用户看到的是"指定 + 五个勾"，而不是被清空或被改回工作日。
      seg.days = (S.sleepDaysLast && S.sleepDaysLast.length)
        ? S.sleepDaysLast.slice()
        : [0, 2, 4];
    }

    // 旧字段跟着第一段走（多段模式下它只是"默认值"）
    const first = (clockCfgSleep().windows || [])[0];
    if (first) { clockCfgSleep().from = first.from; clockCfgSleep().to = first.to; }
    const ok = await saveConfig();
    render();
    if (!ok) { toast('周期没保存成功', 'err'); return; }
    toast(`这一段的生效周期：${sleepCycleText(seg)}`, 'ok');
  },

  /** 指定模式里勾 / 取消某一天 */

  /** 锁屏浮层上的「积分解锁」 */
  async sleepUnlock() {
    const st = (S.data.runtime && S.data.runtime.sleep) || {};
    const mins = st.unlockMin || 30;
    try {
      const r = await invoke('sleep_unlock', { minutes: mins });
      closeModal();
      toast(`已用 ${r.spent} 积分解锁 ${r.minutes} 分钟（余额 ${r.balance}）`, 'ok');
      await pull();
      render();
    } catch (e) {
      toast(String(e).replace(/^Error:\s*/, ''), 'err');
    }
  },

  /** 勾选 / 取消"这套时段管哪些自律规则分组"。
   *
   * 空列表 = 全部（默认，也是老配置的语义）。
   * 取消某组 = 这套时段不再管它 → 属于"放松纪律"，生效期间要拦。 */
  async clockBind(id) {
    const p = clockProfile();
    if (!Array.isArray(p.bound)) p.bound = [];
    const removing = !id || p.bound.includes(id);
    if (removing && settingsFrozen()) { guardDiscipline('改绑自律规则分组'); render(); return; }
    if (!id) p.bound = [];
    else if (p.bound.includes(id)) p.bound = p.bound.filter((x) => x !== id);
    else p.bound = [...p.bound, id];
    await saveConfig();
    render();
    const names = (S.data.config.rules || []);
    if (!p.bound.length) { toast('这套时段恢复为「全部自律规则生效」', 'ok'); return; }
    const label = p.bound.map((x) => (names.find((l) => l.id === x) || {}).name || x).join('、');
    toast(`「${p.name}」现在只管：${label}`, 'ok');
  },

  /** 把 HUD 停到某个角（立刻生效并落盘） */
  async hudCorner(corner) {
    try {
      await invoke('hud_set_look', { corner });
    } catch (e) {
      toast('切换 HUD 位置失败：' + e, 'err');
      return;
    }
    await pull();
    render();
    const name = { tl: '左上', tr: '右上', bl: '左下', br: '右下' }[corner] || corner;
    toast(`HUD 已停靠到${name}角`, 'ok');
  },

  /** 存 HUD 透明度（滑块松手时调用） */
  async hudOpacity(v) {
    const n = Math.max(30, Math.min(100, Math.round(+v || 92)));
    try {
      await invoke('hud_set_look', { opacity: n });
    } catch (e) {
      toast('设置透明度失败：' + e, 'err');
      return;
    }
    await pull();
    render();
  },

  /* ---- 多套「星期时段」方案 ---- */
  /** 切换生效方案（时段进行中不许切：切到更松的一套等于当场放行） */
  async clockProfSwitch(id) {
    const fc = clockCfg();
    if (settingsFrozen()) { guardDiscipline('切换「星期时段」方案'); render(); return; }
    if (!fc.profiles.some((p) => p.id === id) || fc.active === id) return;
    fc.active = id;
    if (!(await saveConfig())) return;
    render();
    const p = clockProfile();
    toast(`已切换到「${p.name}」：从现在起按这套时段判定`, 'ok');
  },

  /** 新建一套空白方案并立刻切过去 */
  async clockProfNew(name) {
    const fc = clockCfg();
    if (settingsFrozen()) { guardDiscipline('新建「星期时段」方案'); render(); return; }
    if (fc.profiles.length >= CC_MAX_PROFILES) { toast(`最多 ${CC_MAX_PROFILES} 套方案`, 'err'); return; }
    const cur = clockProfile();
    const id = `p${Date.now().toString(36)}`;
    fc.profiles.push({
      id,
      name,
      days: [],                       // 空表：由归一化补成 7×24 全灰
      defWork: cur.defWork,
      defBrk: cur.defBrk,
    });
    fc.active = id;
    if (!(await saveConfig())) return;
    render();
    toast(`已新建「${name}」并切到这套：在下面拖出要自律的时段`, 'ok');
  },

  /** 重命名当前方案 */
  async clockProfRename(name) {
    if (settingsFrozen()) { guardDiscipline('重命名「星期时段」方案'); render(); return; }
    const p = clockProfile();
    p.name = name;
    if (!(await saveConfig())) return;
    render();
    toast(`已重命名为「${name}」`, 'ok');
  },

  /** 复制当前方案（排班 + 通用时长一起复制） */
  async clockProfDup() {
    const fc = clockCfg();
    if (settingsFrozen()) { guardDiscipline('复制「星期时段」方案'); render(); return; }
    if (fc.profiles.length >= CC_MAX_PROFILES) { toast(`最多 ${CC_MAX_PROFILES} 套方案`, 'err'); return; }
    const cur = clockProfile();
    const copy = JSON.parse(JSON.stringify(cur));
    copy.id = `p${Date.now().toString(36)}`;
    copy.name = `${cur.name} 副本`.slice(0, 30);
    fc.profiles.push(copy);
    fc.active = copy.id;
    if (!(await saveConfig())) return;
    render();
    toast(`已复制出「${copy.name}」并切过去`, 'ok');
  },

  /** 删除当前方案（至少留一套；时段进行中不许删） */
  async clockProfDel() {
    const fc = clockCfg();
    if (settingsFrozen()) { guardDiscipline('删除「星期时段」方案'); render(); return; }
    if (fc.profiles.length <= 1) { toast('至少要留一套方案', 'err'); return; }
    const cur = clockProfile();
    if (!confirm(`确定删除方案「${cur.name}」？这套排班会被一起删掉。`)) return;
    fc.profiles = fc.profiles.filter((p) => p.id !== cur.id);
    fc.active = fc.profiles[0].id;
    if (!(await saveConfig())) return;
    render();
    toast(`已删除「${cur.name}」，现在用的是「${clockProfile().name}」`, 'ok');
  },

  /* ---- 自动更新 ---- */
  async checkUpdate() {
    toast('正在检查更新…');
    try {
      // 把输入框里刚填、还没保存的令牌一起带上——否则等于用旧令牌去检测
      const typed = ($('#ghToken') && $('#ghToken').value.trim()) || '';
      const r = await invoke('update_check', { token: typed || null });
      await pull();
      render();
      if (!r.ok) {
        // 校验失败（平台不符 / 类型不符 / 清单坏了）——原话照搬，并带上错误码，
        // 用户报问题时能直接对到文档里的那一条。
        const why = r.reject ? `${r.reject.message}（${r.reject.code}）` : r.error;
        toast('检查失败：' + why, 'err');
        return;
      }
      if (r.newer) {
        showUpdateModal(r, true);
      } else if (!r.asset) {
        // 仓库只打了 tag、没有 Release 安装包：如实说明，别谎称"已是最新"
        toast(`远端最新 ${r.latest}，当前 v${r.current}。${r.note || '没有可自动下载的安装包。'}`,
          r.latest ? '' : 'ok');
      } else {
        toast('已经是最新版本 v' + r.current, 'ok');
      }
    } catch (e) { toast('检查失败：' + errText(e), 'err'); }
  },
  async clearToken() {
    try {
      await invoke('update_save', { token: '' });
      await pull(); render();
      toast('令牌已清除', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },
  async saveToken() {
    const el = $('#ghToken');
    const v = el ? el.value.trim() : '';
    if (!v) { toast('请先粘贴令牌', 'err'); return; }
    try {
      await invoke('update_save', { token: v });
      await pull(); await loadQuota(); render();
      toast('令牌已保存（只在本机，界面掩码显示）', 'ok');
    } catch (e) { toast(String(e), 'err'); }
  },
  async tokenDoc() { await invoke('open_url', { url: S.data.tokenDocUrl }); },
  async openRepo() { await invoke('open_url', { url: S.data.repoUrl }); },

  /** 导出诊断信息（版本 / 状态 / 日志 / 脱敏配置） */
  async diagExport() {
    try {
      const p = await invoke('diag_export');
      toast('诊断信息已导出：' + p, 'ok');
    } catch (e) {
      toast(errText(e), 'err');
    }
  },

  /** 手动退出安全模式（改好规则之后） */
  async safeLeave() {
    try {
      await invoke('safe_mode_leave');
      await pull();
      render();
      toast('已退出安全模式', 'ok');
    } catch (e) {
      toast(errText(e), 'err');
    }
  },

  /** 战报图：canvas 画好 → 后端弹保存框写 PNG */
  async poster() {    try {
      const url = drawPoster();
      if (!url) { toast('这段时间还没有数据', 'err'); return; }
      const p = await invoke('poster_save', { dataUrl: url });
      toast('战报图已保存：' + p, 'ok');
    } catch (e) {
      toast(errText(e), 'err');
    }
  },
  async quotaRefresh() { await loadQuota(); render(); },
  async updateEnabled() {
    await invoke('update_save', { enabled: !S.data.config.settings.update.enabled });
    await pull(); render();
  },
  async skipVersion(v) {
    await invoke('update_save', { skip: v });
    closeModal(); await pull();
    toast('已跳过 v' + v + '，下次有新版本还会提醒');
  },
  async clearSkip() {
    await invoke('update_save', { skip: '' });
    await pull(); render();
    toast('已取消跳过');
  },
  async doUpdate(url, name, size, sha) {
    if (!url) { toast('这个版本没有可下载的安装包', 'err'); return; }
    try {
      setProgress(2, '开始下载…');
      // size / sha256 都来自更新清单：size 判断"下全了"，sha256 判断"下对了"。
      // 后者是跨平台错配（或发布方传错包）的最后一道闸，不能省。
      const path = await invoke('update_download', { url, name, size: size || 0, sha256: sha || null });
      setProgress(100, '下载完成，正在退出并安装…');
      await new Promise((r) => setTimeout(r, 900));
      await invoke('update_apply', { installer: path });
    } catch (e) {
      setProgress(0, '');
      toast('更新失败：' + e, 'err');
    }
  },

  schedCopy(from, to) {
    const r = S.editing;
    const src = JSON.parse(JSON.stringify(r.schedule[+from]));
    for (const d of String(to).split(',')) r.schedule[+d] = JSON.parse(JSON.stringify(src));
    renderEditor();
  },
  schedClear() {
    S.editing.schedule = [[], [], [], [], [], [], []];
    renderEditor();
  },
};

/** 保存整份配置。返回 true 表示后端真的接受了（自律时段内可能被拒绝） */
async function saveConfig() {
  let ok = true;
  try {
    await invoke('save_config', { config: S.data.config });
  } catch (e) {
    ok = false;
    toast(String(e).replace(/^Error:\s*/, ''), 'err');
  }
  // 无论成败都拉一次：失败时用服务端的真实状态把界面上的改动冲掉
  await pull();
  return ok;
}

/** 只落盘、**不回拉状态**的保存。
 *
 *  给"改完立刻就能在本地看到效果"的偏好用（主题这类纯前端开关）。
 *  `saveConfig()` 末尾那次 `pull()` 会再走一趟 `get_state`，并且可能顺手 `render()`
 *  一次——对表单类保存是必要的（后端会 sanitize、改字段），但主题切换因此要等
 *  **两个 IPC 来回 + 两次整页重绘**，表现就是"点一下卡一下"。
 *  失败时仍然回拉一次，保证界面不会停在后端并不认可的状态上。 */
async function saveConfigQuiet() {
  try {
    await invoke('save_config', { config: S.data.config });
    return true;
  } catch (e) {
    toast(String(e).replace(/^Error:\s*/, ''), 'err');
    await pull();
    return false;
  }
}

async function loadStats() {
  const [start, end] = boundsOf(S.range);
  try {
    // 账本和统计一起拉：两个请求互不依赖，串行只是白等一轮
    const [r, led] = await Promise.all([
      invoke('stats_range', { start, end }),
      invoke('ledger_range', { start, end }).catch(() => null),
    ]);
    // 只有真的拿到区间数据才替换：接口打嗝时保留上一次的图表，
    // 免得点一下日期整块统计突然变成"没有数据"
    if (r && Array.isArray(r.on)) S.stats = r;
    S.statsLedger = led && !led.error ? led : { total: 0, items: [] };
  } catch (e) {
    // 区间填反之类的原因要说明白，不能只是控制台里一行
    toast(String(e).replace(/^Error:\s*/, ''), 'err');
    console.error(e);
  }
}
async function loadReports() {
  try { S.reports = await invoke('report_list'); } catch (e) { S.reports = []; }
}
async function loadQuota() {
  try { S.quota = await invoke('update_quota'); } catch (e) { S.quota = { ok: false }; }
}
async function loadBackups() {
  try { S.backups = await invoke('backup_list'); } catch (e) { S.backups = []; }
}

function renderCloudModal() {
  const list = S.cloud || [];
  $('#modalRoot').innerHTML = `
  <div class="modal-mask" data-act="close-modal-bg">
    <div class="modal" style="width:620px">
      <div class="modal-hd">
        <h3>云端备份（${list.length} 份）</h3>
        <button class="close-x" data-act="close-modal">×</button>
      </div>
      <div class="modal-bd">
        ${list.length ? list.map((f) => `<div class="list-row">
            <span class="badge ${f.source === 'android' ? 'blue' : 'gold'}">${f.source === 'android' ? '手机' : '桌面'}</span>
            <span class="grow" style="font-size:11.5px">${esc(f.name)}${f.auto ? ' <span class="muted">（自动）</span>' : ''}</span>
            <button class="btn btn-sm" data-act="cloud-restore" data-name="${esc(f.name)}">恢复</button>
          </div>`).join('') : '<div class="empty"><span class="ico">☁</span>云端还没有备份。<br>先点「上传当前配置」，或者在手机端「设置 → 云同步」里上传。</div>'}
        <div class="hint" style="margin-top:14px">
          标「手机」的是手机端传的跨设备备份：直接点「恢复」就能把手机上排的规则和时段搬过来
          （两端的备份密码要一样）。本机只保留最近 ${10} 份、7 天内的备份，
          <b>手机的备份不在这里清理</b>——它由手机自己管理。
        </div>
      </div>
      <div class="modal-ft"><button class="btn" data-act="close-modal">关闭</button></div>
    </div>
  </div>`;
}

/* 保住在编辑器里已经输入但还没保存的内容 */
function syncEditorInputs() {
  const r = S.editing;
  if (!r) return;
  const nm = $('#ruleName');
  if (nm) r.name = nm.value;
  const wm = $('#workMin');
  if (wm && r.brk) r.brk.workMin = +(wm.value || 25);
  const bm = $('#breakMin');
  if (bm && r.brk) r.brk.breakMin = +(bm.value || 5);
}

