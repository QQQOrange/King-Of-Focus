/* 视图：设置（含浏览器插件段）
 *
 * 由 app.js 按连续切片拆出（见 docs/release-notes 里那一版说明）。
 * 加载顺序就是原来的自上而下顺序：**不要**调整 <script> 的先后，
 * 顶层 const / function 共享同一个全局词法环境，换顺序会改变求值时机。
 */
'use strict';

/* ---------------- 视图：设置 ---------------- */
/* ---------------- 浏览器插件 ---------------- */

/// 设置页通用的开关行（viewSettings 里那个 sw 是局部函数，这里需要一份全局的）
function cfgSwitchRow(k, v, title, sub) {
  // aria-label：开关两侧的文字是兄弟节点，input 本身没有名字，
  // 读屏器只会念"复选框 未选中"，用户不知道是哪个设置。
  const label = String(title).replace(/<[^>]*>/g, '');
  return `<div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">${title}</div><div class="hint" style="margin-top:3px">${sub}</div></div>
      <div class="switch" data-act="cfg-switch" data-k="${k}"><input type="checkbox" aria-label="${esc(label)}" ${v ? 'checked' : ''}><i></i></div>
    </div>`;
}

function browserMeta(ext) {
  if (ext === 'enabled') return { txt: '插件已启用', cls: 'green' };
  if (ext === 'disabled') return { txt: '插件被停用', cls: 'gold' };
  if (ext === 'unsupported') return { txt: '不支持本插件', cls: '' };
  // 自定义浏览器：用户数据目录不一定在标准位置，扩展状态没法可靠探测，
  // 与其瞎猜"未安装"，不如老实写"需自行确认"
  if (ext === 'manual') return { txt: '插件需自检', cls: 'blue' };
  // 后端读不到配置档（没启动过 / 自定义 --user-data-dir / Preferences 正被写）：
  // 这不是"没装插件"，而且浏览器守护也不会因此关它，界面上别吓唬人。
  if (ext === 'unknown') return { txt: '状态未知', cls: 'blue' };
  return { txt: '插件未安装', cls: 'red' };
}

function viewBrowsers() {
  const d = S.data;
  if (!d) return '';
  const list = (d.browsers || []) || [];
  const g = (d.config.settings.browserGuard) || { enabled: true, notify: true, graceMs: 1200, detectOnStart: true };
  const installed = list.filter((b) => b.installed);
  const broken = installed.filter((b) => b.ext === 'notInstalled' || b.ext === 'disabled');
  const ok = installed.filter((b) => b.ext === 'enabled');

  const customs = list.filter((b) => b.custom);
  const customRows = customs.length
    ? customs.map((b) => `<div class="brow">
        <div class="brow-ico">${b.installed ? '◉' : '○'}</div>
        <div class="brow-main">
          <div class="brow-name">
            <span class="bname">${esc(b.name)}</span>
            <span class="badge ${b.installed ? 'green' : 'red'}">${b.installed ? '路径有效' : '路径失效'}</span>
            <span class="badge blue">自定义添加</span>
            ${b.running ? '<span class="badge blue">运行中</span>' : ''}
          </div>
          <div class="hint" style="word-break:break-all">${esc(b.exe || '')}</div>
        </div>
        <div class="brow-act">
          ${b.extPage ? `<button class="btn btn-sm" data-act="browser-page" data-k="${esc(b.key)}">扩展页</button>` : ''}
          <button class="btn btn-sm danger-ghost" data-act="custom-browser-del" data-id="${esc(String(b.key).replace('custom:', ''))}">删除</button>
        </div>
      </div>`).join('')
    : '<div class="hint" style="margin-top:10px">还没有登记任何自定义浏览器。</div>';

  const rows = list.length
    ? list.map((b) => {
      const m = browserMeta(b.ext);
      const canInstall = b.installed && (b.ext === 'notInstalled' || b.ext === 'disabled');
      // 「设置路径」一直可见：装在非默认目录时自动检测找不到主程序，
      // 这正是"扩展页"按钮打不开的常见原因，得让用户当场能补救。
      // 已设自定义路径时提示"可改/留空清除"，让入口既能设也能清。
      const pathTitle = b.exe
        ? `当前：${b.exe}${b.exeSource === 'custom' ? '（自定义，点此重新选择；在弹出的输入框留空可清除、回退自动检测）' : ''}`
        : '没找到主程序，点这里手动指定 .exe';
      const pathBtn = b.custom
        ? `<button class="btn btn-sm danger-ghost" data-act="custom-browser-del" data-id="${esc(String(b.key).replace('custom:', ''))}">删除</button>`
        : `<button class="btn btn-sm btn-ghost" data-act="browser-setpath" data-k="${b.key}" title="${esc(pathTitle)}">${b.exeSource === 'custom' ? '重设路径' : '设置路径'}</button>`;
      const act = !b.installed
        ? `<span class="muted" style="font-size:12px">未安装</span>${pathBtn}`
        : b.ext === 'unsupported'
          ? '<span class="muted" style="font-size:12px">无需安装</span>'
          : canInstall
            ? `<button class="btn btn-sm btn-primary" data-act="browser-install" data-k="${b.key}">${b.ext === 'disabled' ? '去启用' : '安装插件'}</button>
               <button class="btn btn-sm" data-act="browser-page" data-k="${b.key}">扩展页</button>${pathBtn}`
            : `<button class="btn btn-sm" data-act="browser-page" data-k="${b.key}">扩展页</button>${pathBtn}`;
      // 命中条目要带**版本号**：装了两份、或装的是旧版时，光看"启用/停用"分不出来，
      // 用户排查"到底哪一份在生效"就只能靠这个。多份时再补一句提示。
      const hitsList = b.hits || [];
      const hits = hitsList.length
        ? `<div class="hint">命中配置档：${hitsList.map((h) => `${esc(h.profile)}${h.version ? ` v${esc(h.version)}` : ''}（${h.enabled ? '启用' : '停用'}）`).join('、')}</div>`
          + (hitsList.filter((h) => h.unpacked).length > 1
            ? '<div class="hint">检测到多份解压加载记录，只保留一份即可；多余的可在扩展页移除，不影响拦截。</div>'
            : '')
        : '';
      return `<div class="brow">
        <div class="brow-ico">${b.installed ? '◉' : '○'}</div>
        <div class="brow-main">
          <div class="brow-name">
            <span class="bname">${esc(b.name)}</span>
            <span class="badge ${b.installed ? 'green' : ''}">${b.installed ? '已安装' : '未安装'}</span>
            ${b.installed ? `<span class="badge ${m.cls}">${m.txt}</span>` : ''}
            ${b.running ? '<span class="badge blue">运行中</span>' : ''}
            ${b.custom ? '<span class="badge blue">自定义添加</span>' : (b.exeSource === 'custom' ? '<span class="badge blue">自定义路径</span>' : '')}
            ${b.exeSource === 'none' && b.installed ? '<span class="badge">未找到主程序</span>' : ''}
          </div>
          <div class="hint">${esc(b.note || '')}</div>
          ${hits}
        </div>
        <div class="brow-act">${act}</div>
      </div>`;
    }).join('')
    : '<div class="empty"><span class="ico">◉</span>还没检测。点右上角「重新检测」。</div>';

  const sum = !list.length
    ? '正在检测…'
    : installed.length
      ? `已安装 ${installed.length} 个浏览器，${ok.length} 个插件就绪${broken.length ? `，${broken.length} 个需要处理` : ''}`
      : '这台机器上没有检测到受支持的浏览器';

  return `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <div class="card-title">浏览器与配套插件</div>
        <div class="card-sub">${esc(sum)}</div>
      </div>
      <button class="btn btn-sm" data-act="browser-scan" ${S.browserScanning ? 'disabled' : ''}>${S.browserScanning ? '检测中…' : '重新检测'}</button>
    </div>
    ${broken.length ? `<div class="note" style="border-left-color:var(--gold);margin:12px 0 4px">
      <b>有 ${broken.length} 个浏览器的插件没就绪。</b>自律时段里打开它们会被自动关闭——先把插件装上或启用，才不会被拦。
      <div style="margin-top:8px"><button class="btn btn-sm btn-primary" data-act="browser-guide">安装引导</button></div>
    </div>` : ''}
    ${extFolderPanel(d.extInfo)}
    <div style="margin-top:6px">${rows}</div>
  </div>

  <div class="card">
    <div class="card-title">自定义浏览器</div>
    <div class="card-sub">
      清单里没有的浏览器（公司内部壳、某些国产套壳）在这里登记主程序路径。
      登记后它会被<b>当作浏览器</b>处理：自律时段里打开它同样会被关闭，
      「浏览器巡检」也认得它。插件状态无法自动探测，需要你自己确认。
    </div>
    ${customRows}
    <div class="row" style="gap:8px;margin-top:14px;align-items:flex-end;flex-wrap:wrap">
      <label style="flex:1;min-width:150px">
        <div class="hint" style="margin-bottom:4px">名称</div>
        <input type="text" id="cbName" maxlength="40" placeholder="例如：公司内部浏览器" style="width:100%" />
      </label>
      <label style="flex:2;min-width:240px">
        <div class="hint" style="margin-bottom:4px">主程序路径</div>
        <input type="text" id="cbExe" placeholder="C:\\...\\browser.exe" style="width:100%" />
      </label>
      <button class="btn btn-sm" data-act="custom-browser-pick">选择 exe</button>
      <button class="btn btn-sm btn-primary" data-act="custom-browser-save">添加</button>
    </div>
    <div class="hint" style="margin-top:8px">
      保存时会校验 .exe 是否存在；登记后立即重新检测，不需要重启软件。
    </div>
  </div>

  <div class="card">
    <div class="card-title">自律时段守护</div>
    <div class="card-sub">
      自律时间（自律规则正在生效）里，只要你打开浏览器而插件没装或被停用，会在
      <b>5 秒内</b>自动关闭它，并记一条拦截记录。装了插件且已启用则完全不受影响。
    </div>
    ${cfgSwitchRow('browserGuard.enabled', g.enabled, '启用浏览器巡检', '关闭后，自律时段里不会因为插件状态而关浏览器')}
    ${cfgSwitchRow('browserGuard.notify', g.notify, '关闭前弹提示', '先弹一张卡片说明原因和剩余秒数，再关闭')}
    ${cfgSwitchRow('browserGuard.detectOnStart', g.detectOnStart, '启动时自动检测', '每次打开软件都识别一遍浏览器与插件状态')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div>
        <div style="font-size:12.5px">关闭前宽限</div>
        <div class="hint" style="margin-top:3px">留给你的反应时间；加上轮询间隔后总耗时不超过 5 秒（上限 3500ms）</div>
      </div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="bgGrace" value="${g.graceMs}" min="300" max="3500" step="100" style="width:96px" />
        <span class="hint">毫秒</span>
        <button class="btn btn-sm" data-act="browser-grace-save">保存</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">判定与检测说明</div>
    <div class="card-sub">以下都是实际实现口径，不是宣传语。</div>
    <div class="note" style="line-height:1.95">
      <b>支持范围</b>：Chrome、Edge、Brave、Vivaldi、Opera、Chromium、360 极速、QQ 浏览器、搜狗高速
      （这些都能装本插件）；Firefox 会被识别出来，但它不支持 Chromium 扩展，所以只显示、不参与拦截。<br>
      <b>状态判定</b>：读各浏览器用户目录下每个配置档的 <code>Preferences</code>，
      在 <code>extensions.settings</code> 里按扩展名找到本插件：
      完全找不到 = <b>未安装</b>；找到且 <code>state=1</code> 且没有 <code>disable_reasons</code> = <b>已启用</b>；
      找到但被停用 = <b>被停用</b>。<br>
      <b>检测频率</b>：启动时全量扫一次；之后后台每 20 秒刷新一次缓存；打开本页或点「重新检测」立即扫。
      自律时段里每个轮询周期（默认 1 秒）都会用最新缓存判定一次。<br>
      <b>关闭失败</b>：先发关闭信号，0.4 秒不退再强制结束；如果仍失败（多半是浏览器以管理员运行、而本程序不是），
      会记一条「关闭失败」，每 60 秒重试一次，并提示你以管理员身份运行。<br>
      <b>点了安装之后</b>：会给 10 分钟保护期，这期间不会因为插件状态去关浏览器，避免你正开着扩展管理页就被关掉。
    </div>
  </div>`;
}
function viewSettings() {
  const d = S.data;
  if (!d) return '';
  const st = d.config.settings;
  // HUD 的角与透明度：老配置没有这两个字段时按默认（右上 / 92%）
  const hud = {
    offsetX: (st.hud && st.hud.offsetX) ?? 20,
    offsetY: (st.hud && st.hud.offsetY) ?? 20,
  };
  const hudCorner = ['tl', 'tr', 'bl', 'br'].includes((st.hud || {}).corner) ? st.hud.corner : 'tr';
  const hudOpacity = Math.max(30, Math.min(100, +((st.hud || {}).opacity) || 92));
  // 「自律时段内允许退出」：开关关掉 + 现在正好在生效时段里 = 怎么都退不掉。
  // 用 runtime.clockInWindow（整个生效时段，含休息段）而不是 clockOn（专注段），
  // 和后端 guard::session_quit_locked 的判定保持同一口径。
  const quitAllowed = st.allowQuitInSession !== false;
  const quitLocked = !quitAllowed && !!((d.runtime || {}).clockInWindow || (d.runtime || {}).clockOn);
  const sw = (k, v, t, sub) => `<div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">${t}</div><div class="hint" style="margin-top:3px">${sub}</div></div>
      <div class="switch" data-act="cfg-switch" data-k="${k}"><input type="checkbox" ${v ? 'checked' : ''}><i></i></div>
    </div>`;

  return `
  ${!d.admin ? `<div class="note" style="border-left-color:var(--red);margin-bottom:14px">
    <b>当前不是管理员权限。</b>拦截普通程序没问题，但要关掉以管理员身份运行的程序（比如某些游戏、安装程序）会失败。
    <div style="margin-top:8px"><button class="btn btn-sm btn-danger" data-act="restart-admin">以管理员身份重启</button></div>
  </div>` : ''}

  <div class="card">
    <div class="card-title">自律时段</div>
    <div class="card-sub">只影响「自律时段」页怎么排时间，不改变判定口径。</div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div>
        <div style="font-size:12.5px">每次选择的时长</div>
        <div class="hint" style="margin-top:3px">
          拖一下 / 点一下代表多少分钟。改成 10 分钟能排得更细，代价是日历更高、要滚动；
          已经排好的时段不会被改动。
        </div>
      </div>
      <div class="row" style="align-items:center;gap:6px">
        ${[10, 15].map((g) => `<button class="cc-gran-btn${(st.focusClock && +st.focusClock.granularity === g) || (!(st.focusClock && st.focusClock.granularity) && g === 15) ? ' active' : ''}"
          data-act="clock-gran" data-v="${g}">${g} 分钟</button>`).join('')}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">外观</div>
    <div class="card-sub">「跟随系统」会实时响应 Windows 的浅色 / 深色切换，不用重启。</div>
    <div class="seg">
      <button class="${(st.theme || 'system') === 'system' ? 'active gold' : ''}" data-act="theme" data-v="system">跟随系统</button>
      <button class="${st.theme === 'light' ? 'active gold' : ''}" data-act="theme" data-v="light">浅色</button>
      <button class="${st.theme === 'dark' ? 'active gold' : ''}" data-act="theme" data-v="dark">深色</button>
    </div>
    <div class="hint" style="margin:14px 0 8px">语言 · Language</div>
    <div class="seg">
      <button class="${langPref() === 'zh-CN' ? 'active gold' : ''}" data-act="lang" data-v="zh-CN">简体中文</button>
      <button class="${langPref() === 'en' ? 'active gold' : ''}" data-act="lang" data-v="en">English</button>
    </div>
    <div class="hint" style="margin-top:8px">浏览器插件会跟随这里的语言；默认简体中文。</div>
  </div>

  <div class="card">
    <div class="card-title">新手引导</div>
    <div class="card-sub">三步：什么时候学 / 哪些不该开 / 试 25 分钟。重走一遍不会删掉你已经排好的时段和规则，只会覆盖向导自己写的那一套。</div>
    <div class="row" style="align-items:center;gap:10px">
      <button class="btn btn-sm" data-act="wiz-open">重新走一遍</button>
      <span class="hint">换电脑、换作息，或者想把家人也教会时用它</span>
    </div>
  </div>

  <div class="card">
    <div class="card-title">激励语录</div>
    <div class="card-sub">
      这些句子会和联网取到的「一言」一起在 Hub 顶部轮换，每条都会标明来源。
      最多 60 条、每条 120 字；这里改完立刻生效，不用打开 Hub。
    </div>
    ${(st.customQuotes || []).length
      ? `<div class="qlist" style="margin-top:10px">${(st.customQuotes || []).map((t, i) => `
          <div class="qrow">
            <span class="n">${i + 1}</span>
            <span class="t">${esc(t)}</span>
            <button class="btn btn-sm danger-ghost" data-act="set-quote-del" data-i="${i}">删除</button>
          </div>`).join('')}</div>`
      : '<div class="hint" style="margin-top:10px">还没有自己写的语录。</div>'}
    <div class="row" style="gap:8px;margin-top:12px">
      <input type="text" id="setQuoteNew" maxlength="120" style="flex:1"
        placeholder="写一句给自己的话（最多 120 字），回车即可添加" />
      <button class="btn btn-sm btn-primary" data-act="set-quote-add">添加</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">拦截行为</div>
    <div class="card-sub">这些设置对所有自律规则生效。</div>
    ${sw('dryRun', st.dryRun, '演练模式', '只记录不真的关闭，用来先验证名单是否写对了')}
    ${sw('softClose', st.softClose, '先温和关闭', '先给程序发关闭信号，0.7 秒不退再强制结束，能保住一部分现场')}
    ${sw('siteCloseBrowser', st.siteCloseBrowser, '网页被拦时关闭整个浏览器', '开：命中自律规则网页先弹通知，然后把整个浏览器窗口关掉；关：只关掉那一个标签页')}
    ${sw('feedHide', st.feedHide, '藏起首页推荐流', '插件把 YouTube / B 站 / 知乎 / 微博 / X 的首页信息流隐藏起来；搜索、播放页、私信照常。只改变页面显示，不算拦截')}
    ${sw('focusBar', st.focusBar !== false, '网页角落显示专注条', '自律生效时在每个网页左下角显示「自律中 · 剩余 mm:ss」，可以收成一个小圆点。浏览器全屏时主界面看不见，这条是唯一还看得见的提醒')}
    ${sw('guardBrowser', st.guardBrowser, '浏览器守护', '要拦网页时，如果插件失联，直接关掉浏览器（需先装插件）')}
    ${sw('blockTaskmgr', st.blockTaskmgr !== false, '自律期间禁止打开任务管理器', '自律模式生效时（自律时段专注段 / 自律规则生效中），一发现任务管理器就关掉；「固化」锁定期间无论如何都会关')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">扫描间隔</div><div class="hint" style="margin-top:3px">越小越灵敏，占用也越高</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="pollMs" value="${st.pollMs}" min="300" max="5000" step="100" style="width:90px" />
        <span class="hint">毫秒</span>
        <button class="btn btn-sm" data-act="save-num" data-k="pollMs">保存</button>
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div><div style="font-size:12.5px">插件心跳容忍</div><div class="hint" style="margin-top:3px">超过这个时间没收到插件心跳，就认为插件被停用了</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="graceSecs" value="${st.graceSecs}" min="20" max="600" style="width:90px" />
        <span class="hint">秒</span>
        <button class="btn btn-sm" data-act="save-num" data-k="graceSecs">保存</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">使用时长统计</div>
    <div class="card-sub">统计只存在本机，不上传任何数据。</div>
    ${sw('statsEnabled', d.config.settings.stats.enabled, '启用统计', '关闭后不再采样，已有数据保留')}
    ${sw('countIdle', d.config.settings.stats.countIdle, '计入无操作时间', '关掉时，超过 60 秒没碰键鼠就不计时')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div><div style="font-size:12.5px">数据保留天数</div><div class="hint" style="margin-top:3px">超期的日文件与报告会在启动时清理</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="retentionDays" value="${d.config.settings.stats.retentionDays}" min="30" max="3650" style="width:96px" />
        <span class="hint">天</span>
        <button class="btn btn-sm" data-act="save-num" data-k="retentionDays">保存</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">提醒</div>
    <div class="card-sub">
      每个「自律周期」和每段「休息」结束前各提醒一次：主界面弹提示，HUD 上对应的倒计时会变金色闪烁。
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">启用提醒</div><div class="hint" style="margin-top:3px">总开关，关掉后两种提醒都不发</div></div>
      <div class="switch"><input type="checkbox" id="ntEnabled" ${(d.config.settings.notify || {}).enabled ? 'checked' : ''}><i></i></div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">学习结束前提醒</div><div class="hint" style="margin-top:3px">0 = 不提醒；范围 0~120 分钟</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="ntWork" min="0" max="120" value="${(d.config.settings.notify || {}).workBefore ?? 5}" style="width:88px" />
        <span class="hint">分钟</span>
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">休息结束前提醒</div><div class="hint" style="margin-top:3px">范围 0~120 分钟</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="ntBreak" min="0" max="120" value="${(d.config.settings.notify || {}).breakBefore ?? 2}" style="width:88px" />
        <span class="hint">分钟</span>
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div><div style="font-size:12.5px">休息也提醒</div><div class="hint" style="margin-top:3px">关掉后只提醒学习结束，休息结束不打扰</div></div>
      <div class="row" style="align-items:center;gap:10px">
        <div class="switch"><input type="checkbox" id="ntBreakOn" ${(d.config.settings.notify || {}).breakNotify ? 'checked' : ''}><i></i></div>
        <button class="btn btn-sm" data-act="save-notify">保存</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">桌面 HUD</div>
    <div class="card-sub">
      自律期间在屏幕右上角浮一个小窗：已经专注多久、还有多久结束，下面一句励志短语。
      窗口置顶、不进任务栏，跟着浅色/深色主题走。
    </div>
    ${sw('hudEnabled', (d.config.settings.hud || {}).enabled, '显示桌面 HUD', '自律时段自动出现，结束后自动隐藏')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div><div style="font-size:12.5px">短语切换间隔</div><div class="hint" style="margin-top:3px">联网取一句（一言），失败时用内置句子轮换</div></div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="number" id="quoteMins" min="5" max="1440" value="${(d.config.settings.hud || {}).quoteMinutes || 60}" style="width:90px" />
        <span class="hint">分钟</span>
        <button class="btn btn-sm" data-act="save-quote-mins">保存</button>
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-top:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">显示位置</div>
        <div class="hint" style="margin-top:3px">
          挨着哪个角落（边距 ${hud.offsetX}/${hud.offsetY} 像素）。挑一个不压住主要内容的位置就行；
          专注遮罩打开时 HUD 会自动收起，不会盖在遮罩上。
        </div>
      </div>
      <div class="row" style="align-items:center;gap:6px">
        ${[['tl', '左上'], ['tr', '右上'], ['bl', '左下'], ['br', '右下']].map(([k, n]) =>
          `<button class="cc-gran-btn${hudCorner === k ? ' active' : ''}" data-act="hud-corner" data-v="${k}"
            title="停靠到${n}角">${n}</button>`).join('')}
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-top:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">透明度</div>
        <div class="hint" style="margin-top:3px">30% 起（再低就看不清了）。松手即保存，改动马上生效。</div>
      </div>
      <div class="row" style="align-items:center;gap:8px">
        <input type="range" id="hudOpacity" min="30" max="100" step="2" value="${hudOpacity}" style="width:140px" />
        <b id="hudOpacityVal" style="font-size:12px;min-width:38px;text-align:right">${hudOpacity}%</b>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">系统</div>
    ${sw('autostart', st.autostart, '开机自动启动', '写入 HKCU 的 Run 项，不需要管理员')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">测试模式
          ${d.testMode ? '<span class="badge gold" style="margin-left:6px">正在测试中</span>' : ''}
        </div>
        <div class="hint" style="margin-top:4px">
          所有功能（拦截、遮罩、统计、报告）都<b>真实生效</b>，唯一区别是自律模式可以随时开关。
          配置与统计写在独立目录，退出时可选「保留」或「丢弃」，都不会污染正式数据。
        </div>
      </div>
      ${d.testMode
        ? '<div class="row" style="gap:8px"><button class="btn btn-sm" data-act="test-exit-keep">退出并保留</button><button class="btn btn-sm btn-danger" data-act="test-exit-discard">退出并丢弃</button></div>'
        : `<button class="btn btn-sm btn-primary" data-act="test-enter" ${settingsFrozen() ? 'disabled title="自律时段生效中，不能进入测试模式"' : ''}>进入测试模式</button>`}
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">以管理员模式启动
          <span class="badge ${d.admin ? 'green' : 'red'}" style="margin-left:6px">${d.admin ? '当前已是管理员' : '当前是普通权限'}</span>
        </div>
        <div class="hint" style="margin-top:4px">
          打开后会弹 UAC 并重启成管理员。管理员权限下，遮罩可以<b>摘掉其他置顶浮窗的“总在最前”属性</b>，
          像 lazytyper 那种小横条会被一次性盖住，不再来回闪。
          同时也能拦住以管理员运行的程序。
          ${settingsFrozen() && !d.admin ? '<br><b>自律时段生效中：切换要重启程序，先等这段结束。</b>' : ''}
        </div>
      </div>
      <div class="switch${settingsFrozen() && !d.admin ? ' locked' : ''}" data-act="cfg-switch" data-k="runAsAdmin"><input type="checkbox" ${st.runAsAdmin ? 'checked' : ''}><i></i></div>
    </div>
    ${sw('alwaysOnTop', st.alwaysOnTop, '主窗口置顶', '开启后主界面始终浮在其它窗口之上，不会被别的窗口盖住；点一下这里就能立刻生效')}
    ${sw('closeToTray', st.closeToTray, '关闭窗口时收进托盘', '拦截引擎在托盘里继续工作')}
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div><div style="font-size:12.5px">浏览器插件</div><div class="hint" style="margin-top:3px">在 Chrome / Edge 的扩展页打开"开发者模式"，载入已解压的扩展</div></div>
      <button class="btn btn-sm" data-act="open-ext">打开插件目录</button>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">自律时段内允许退出</div>
        <div class="hint" style="margin-top:3px">
          开：自律时间里仍可以用 Ctrl+Alt+F4、Alt+F4 或下面的按钮退出。
          关：自律时段内<b>任何方式都退不掉</b>——热键、Alt+F4、关闭窗口、下面的按钮全部被拒绝，直到这一段结束。
          <br>自律规则开了「固化」时更严：固化锁定期间即使这里开着，也退不掉。
          ${quitLocked ? '<br><b style="color:var(--red)">这一段生效期间不能再打开这个开关。</b>' : ''}
        </div>
      </div>
      <div class="switch${quitLocked ? ' locked' : ''}" data-act="cfg-switch" data-k="allowQuitInSession">
        <input type="checkbox" ${quitAllowed ? 'checked' : ''}><i></i>
      </div>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-size:12.5px">立即退出程序</div>
        <div class="hint" style="margin-top:3px">
          ${quitLocked
            ? '<b style="color:var(--red)">自律时段生效中，且已关闭「自律时段内允许退出」——现在退不掉。</b>'
            : `立刻结束本程序：先停守护、还原被暂停的媒体、销毁遮罩并落盘统计，不弹确认框。快捷键 <b>Ctrl + Alt + F4</b>${quitAllowed ? '（窗口在前台时 <b>Alt + F4</b> 也行）' : ''}。`}
        </div>
      </div>
      <button class="btn btn-sm btn-danger" data-act="force-quit" ${quitLocked ? 'disabled' : ''}>立即强制退出</button>
    </div>
    <div class="row" style="align-items:center;justify-content:space-between;padding:11px 0">
      <div><div style="font-size:12.5px">配置文件</div><div class="hint" style="margin-top:3px">${esc(d.configPath)}</div></div>
      <button class="btn btn-sm" data-act="open-cfg">打开目录</button>
    </div>
  </div>

  <div class="card">
    <div class="card-title">全局保护名单</div>
    <div class="card-sub">白名单下，这些进程永远不会被拦截。用逗号分隔（进程名，不带 .exe）。</div>
    <textarea id="protectedList" style="width:100%;height:88px;background:var(--input-bg);border:1px solid var(--line-2);border-radius:var(--r-sm);color:var(--text);padding:10px;font-size:12px;resize:vertical;user-select:text">${esc((st.protected || []).join(', '))}</textarea>
    <div style="margin-top:10px"><button class="btn btn-sm" data-act="save-protected">保存名单</button></div>
  </div>

  ${resetCard()}`;
}

/**
 * 「分区重置」卡片。
 *
 * 为什么是"选一块 + 一个按钮"而不是 12 个并排的红按钮：
 * 重置是破坏性操作，界面不该给 12 个手滑的机会。选中态用高亮，
 * 真正执行还要过一次确认框。
 *
 * 每个分区只改自己那几个字段（见 Rust `reset::apply`），
 * 并且重置前会自动快照、支持撤销。
 */
const RESET_SECTIONS = [
  ['rules', '自律规则', '规则列表恢复为出厂那条「自律时间」，自定义规则会被删除'],
  ['clock', '自律时段', '7×24 时段表恢复默认，多套方案一并清掉'],
  ['mask', '专注遮罩', '透明度、跟随、点击穿透、热键等恢复默认'],
  ['sleep', '睡眠管理', '睡眠时段与关机倒计时恢复默认（默认关闭）'],
  ['hud', 'HUD 外观', '停靠角、边距、透明度恢复默认'],
  ['quotes', '激励语录', '自定义语录与自定义来源清空，回到内置精选'],
  ['notify', '阶段提醒', '提醒开关与提前量恢复默认'],
  ['distract', '分心事件', '提醒间隔、上限、按钮位置恢复默认'],
  ['stats', '统计口径', '保留天数与计闲规则恢复默认（不会删除已统计的数据）'],
  ['browser', '浏览器插件', '插件巡检、宽限、自定义浏览器与路径清空'],
  ['sync', '云同步', '清空 WebDAV 地址与凭据（本机备份不受影响）'],
  ['update', '更新通道', '清空 GitHub 令牌与跳过版本'],
];

function resetCard() {
  const cur = RESET_SECTIONS.find((s) => s[0] === S.resetSection) || RESET_SECTIONS[0];
  // 分区名先进 I.t()：英文界面下按钮和说明都必须是英文，
  // 否则「Reset “自律规则” to defaults」这种半中半英会露出来。
  const name = (k) => I.t(k);
  return `<div class="card" id="resetCard">
    <div class="card-title">分区重置</div>
    <div class="card-sub">只把选中的那一块恢复出厂值，其它设置、规则、积分都不动。重置前会自动存一份快照，点「撤销」能回来。</div>
    <div class="row" style="flex-wrap:wrap;gap:8px;margin:10px 0">
      ${RESET_SECTIONS.map(([k, n]) => `<button class="btn btn-sm${cur[0] === k ? ' btn-primary' : ''}"
        data-act="reset-pick" data-k="${k}">${esc(name(n))}</button>`).join('')}
    </div>
    <div class="hint" style="margin-bottom:10px">${esc(I.t(cur[2]))}</div>
    <div class="row" style="justify-content:space-between;align-items:center;gap:10px">
      <div class="hint" id="resetLast" style="flex:1">读取中…</div>
      <button class="btn btn-sm btn-danger" data-act="reset-section">恢复「${esc(name(cur[1]))}」的默认值</button>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:8px">
      <button class="btn btn-sm" id="resetUndo" data-act="reset-undo" style="display:none">撤销上次重置</button>
    </div>
  </div>`;
}

/** 拉一次"有没有可撤销的重置"，填进卡片（不整页重绘） */
async function loadResetState() {
  let st = { has: false };
  let failed = false;
  try {
    // 加超时：后端要是卡住（比如正忙着扫进程），这一行不能永远停在「读取中…」
    st = await withTimeout(invoke('config_reset_state'), 3000, '读取超时');
  } catch (e) {
    failed = true;
  }
  S.resetLast = st;
  const el = $('#resetLast');
  if (el) {
    const name = (RESET_SECTIONS.find((s) => s[0] === st.section) || [0, st.section || ''])[1];
    // 这里是 textContent 直接赋值，不会走 DOM 的翻译扫描 —— 所以自己过一遍 I.t()
    el.textContent = failed
      ? I.t('状态读取失败，不影响重置本身。')
      : (st.has
        ? I.t('上次重置：') + `${I.t(name)} · ${new Date((st.at || 0) * 1000).toLocaleString()}`
        : I.t('还没有重置过任何分区。'));
  }
  const btn = $('#resetUndo');
  if (btn) btn.style.display = !failed && st.has ? '' : 'none';
}

