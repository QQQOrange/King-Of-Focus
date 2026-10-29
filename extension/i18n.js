/* 插件的多语言文案。
 *
 * 语言不自己选，而是**跟随主程序**：background.js 每次轮询 /api/state
 * 会把 state.lang 存进 chrome.storage.local，弹窗与拦截页打开时读它。
 * 这样用户在软件设置里切了 English，插件页面也跟着变，不需要卸载重装。
 *
 * 为什么不用 chrome.i18n + _locales：
 *   Chrome 的 i18n 只认浏览器语言，不认"软件里选的语言"，两套会打架。
 *   扩展名称/描述这种清单里的字段仍然用 _locales（浏览器决定），页面内文案走这里。
 */
const EXT_I18N = {
  'zh-CN': {
    'status.checking': '检测中…',
    'status.connected': '已连接主程序',
    'status.disconnected': '未连接（主程序没开？）',
    'port': '主程序端口',
    'port.none': '未发现',
    'mode': '当前模式',
    'mode.active': '自律模式生效中',
    'mode.free': '自由时间',
    'rules': '生效规则',
    'rules.empty': '当前没有生效的自律规则',
    'btn.refresh': '立即刷新规则',
    'kind.whitelist': '白名单',
    'kind.blacklist': '黑名单',
    'kind.both': '黑+白',
    'rule.item': '{name}（{mode} · {n} 条）',

    'blocked.title': '这个页面现在不能看',
    'blocked.sub': '你正在自律模式的生效时段内。',
    'blocked.title.white': '这个页面不在白名单里',
    'blocked.sub.white': '白名单模式下，只允许打开名单里的网站。',
    'blocked.rule': '命中规则',
    'blocked.url': '目标地址',
    'blocked.mode': '当前模式',
    'blocked.mode.white': '白名单 · 只允许名单里的网站',
    'blocked.foot': 'King Of Focus · 专注由你掌控',
    'blocked.unknownRule': '网站自律规则',
    'blocked.tip1': '想改名单？在主程序里打开「规则 → 网站」。',
    'blocked.tip2': '如果这不是你想要的，说明时间表需要调整。',
    'blocked.docTitle': '已被 King Of Focus 拦截',
    'blocked.left': '本段还剩',
    'blocked.leftDone': '本段结束了，可以刷新',
    'blocked.reload': '刷新试试',
    'blocked.sweepTip.soft': '休息结束时它被收起来了：标签还在，休息回来点「刷新试试」就能继续。',
    'blocked.sweepTip.hard': '它是在休息结束时被关掉的。',
    /* —— 弹窗新增 —— */
    'mode.focus': '专注中（规则生效）',
    'mode.break': '休息中（不拦截）',
    'left': '本段还剩',
    'sweep': '收尾方式',
    'sweep.off': '未启用',
    'sweep.soft': '柔和 · 换拦截页',
    'sweep.hard': '强制 · 关标签页',
    'swept': '上次收尾',
    'btn.sweepWeb': '现在收尾',
  },
  en: {
    'status.checking': 'Checking…',
    'status.connected': 'Connected to the app',
    'status.disconnected': 'Not connected (app not running?)',
    'port': 'App port',
    'port.none': 'Not found',
    'mode': 'Mode',
    'mode.active': 'Discipline active',
    'mode.free': 'Free time',
    'rules': 'Active rules',
    'rules.empty': 'No active rules right now',
    'btn.refresh': 'Refresh rules',
    'kind.whitelist': 'Allowlist',
    'kind.blacklist': 'Blocklist',
    'kind.both': 'Both',
    'rule.item': '{name} ({mode} · {n} sites)',

    'blocked.title': 'This page is blocked',
    'blocked.sub': 'You are inside your discipline hours.',
    'blocked.title.white': 'This site is not on the allowlist',
    'blocked.sub.white': 'In allowlist mode only listed sites can open.',
    'blocked.rule': 'Matched rule',
    'blocked.url': 'Address',
    'blocked.mode': 'Mode',
    'blocked.mode.white': 'Allowlist · listed sites only',
    'blocked.foot': 'King Of Focus · Stay in control',
    'blocked.unknownRule': 'Site rules',
    'blocked.tip1': 'Change the list in the app: Rules → Sites.',
    'blocked.tip2': 'If this is not what you want, adjust your hours.',
    'blocked.docTitle': 'Blocked by King Of Focus',
    'blocked.left': 'Time left',
    'blocked.leftDone': 'This session is over — reload to continue',
    'blocked.reload': 'Reload',
    'blocked.sweepTip.soft': 'It was tucked away when your break ended: the tab is still here, reload after the break to keep going.',
    'blocked.sweepTip.hard': 'It was closed when your break ended.',
    'mode.focus': 'Focus (rules active)',
    'mode.break': 'Break (not blocking)',
    'left': 'Time left',
    'sweep': 'Cleanup',
    'sweep.off': 'Off',
    'sweep.soft': 'Gentle · block page',
    'sweep.hard': 'Strict · close tab',
    'swept': 'Last cleanup',
    'btn.sweepWeb': 'Clean up now',
  },
};

let EXT_LANG = 'zh-CN';

function extSetLang(l) {
  EXT_LANG = l === 'en' ? 'en' : 'zh-CN';
  if (document && document.documentElement) document.documentElement.lang = EXT_LANG;
}

/** 取一条文案；vars 做 {name} 占位替换。缺失时回落中文，再缺失回落 key。 */
function ET(key, vars) {
  const pack = EXT_I18N[EXT_LANG] || EXT_I18N['zh-CN'];
  let s = pack[key];
  if (s == null) s = EXT_I18N['zh-CN'][key];
  if (s == null) return key;
  if (vars) {
    Object.keys(vars).forEach((k) => {
      s = s.split('{' + k + '}').join(String(vars[k]));
    });
  }
  return s;
}

/** 把带 data-i18n / data-i18n-ph 的元素刷成当前语言 */
function applyExtI18n(root) {
  const r = root || document;
  r.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = ET(el.dataset.i18n);
  });
  r.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.setAttribute('placeholder', ET(el.dataset.i18nPh));
  });
  r.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', ET(el.dataset.i18nTitle));
  });
}

/** 从本地缓存读语言（background 写入），失败就当简体中文 */
function extLoadLang() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get('lang', (v) => {
        extSetLang(v && v.lang);
        resolve(EXT_LANG);
      });
    } catch (e) {
      resolve(EXT_LANG);
    }
  });
}
