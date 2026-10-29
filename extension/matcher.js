/* King Of Focus — 网站规则匹配器
 *
 * 独立成文件的原因：declarativeNetRequest 只能拦「新发起的请求」，
 * 已经打开的标签页不会自己消失。要关掉它们，必须有一个和服务端
 * 语义完全一致的 URL 判定，这里就是那份唯一的判定逻辑。
 * 纯函数、无 chrome API，可以脱离浏览器直接用 node 跑测试。
 */
(function (root) {
  'use strict';

  function esc(s) {
    return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }

  // 主机名（小写、去掉 www. 和端口）
  function hostOf(u) {
    var raw = String(u || '').trim();
    if (!raw) return '';
    var withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw.replace(/^\/+/, '');
    try {
      return new URL(withProto).hostname.toLowerCase().replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  // 待匹配的候选串：完整「主机+路径」、去掉 www. 的版本、纯主机
  function candidates(u) {
    var s = String(u || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').toLowerCase();
    var out = [s];
    if (s.slice(0, 4) === 'www.') out.push(s.slice(4));
    var h = hostOf(u);
    if (h && out.indexOf(h) < 0) out.push(h);
    return out;
  }

  /** 把用户写下的一条网站规则编译成 (url) => boolean */
  function makeMatcher(pat) {
    var p = String(pat || '').trim().toLowerCase();
    if (!p) return null;
    if (p === '*' || p === '*.*' || p === '**') return function () { return true; };

    p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    var hashAt = p.indexOf('#');
    if (hashAt >= 0) p = p.slice(0, hashAt);
    if (!p) return null;

    // 「主机」部分：去掉 query 与结尾斜杠。
    // 用户常常直接粘贴整条网址（https://www.douyin.com/），如果不归一化，
    // 它会被当成"带路径的精确匹配"，于是裸域 douyin.com、少了斜杠的写法
    // 全都拦不住——这正是"加了黑名单还能照常看"的一大原因。
    var core = p.split('?')[0].replace(/\/+$/, '');
    if (!core) return null;
    // 开头的 "*." 是「该域含子域」的常见写法，等价于写裸域，按域名规则处理
    if (core.slice(0, 2) === '*.') core = core.slice(2);
    var hasPath = core.indexOf('/') >= 0;
    var hasWild = core.indexOf('*') >= 0;

    // 纯域名 → 该域及其所有子域（youtube.com 命中 m.youtube.com）
    if (!hasPath && !hasWild) {
      var d = core.replace(/^\./, '').replace(/^www\./, '');
      var colon = d.indexOf(':');
      if (colon >= 0) d = d.slice(0, colon);
      if (!d) return null;
      var suffix = '.' + d;
      return function (u) {
        var h = hostOf(u);
        if (!h) return false;
        return h === d || h.slice(-suffix.length) === suffix;
      };
    }

    // 带通配或带路径 → 正则
    var body = esc(p).replace(/\\?\*/g, '.*');
    var exact, prefix;
    try {
      exact = new RegExp('^' + body + '(?:[?#].*)?$', 'i');
      prefix = new RegExp('^' + body, 'i');
    } catch (e) {
      return null;
    }
    return function (u) {
      var c = candidates(u);
      for (var i = 0; i < c.length; i++) {
        if (exact.test(c[i]) || prefix.test(c[i])) return true;
      }
      return false;
    };
  }

  function compile(rules) {
    return (rules || []).map(function (r) {
      return {
        name: (r && r.name) || '网站黑名单',
        mode: r && r.mode === 'whitelist' ? 'whitelist' : 'blacklist',
        sites: ((r && r.sites) || []).map(makeMatcher).filter(Boolean),
        exceptions: ((r && r.exceptions) || []).map(makeMatcher).filter(Boolean),
      };
    });
  }

  function any(fns, u) {
    for (var i = 0; i < fns.length; i++) {
      try {
        if (fns[i](u)) return true;
      } catch (e) { /* 单条规则异常不影响整体 */ }
    }
    return false;
  }

  /** 返回命中的规则名；未命中返回 null */
  function match(u, compiled) {
    if (!/^https?:/i.test(String(u || ''))) return null;
    var list = compiled || [];

    // 强制模式优先：只要有生效的白名单规则，就只有名单内的能活
    // 空名单的白名单规则视为未配置，直接跳过（否则会把所有标签页清空）
    var whites = [];
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].mode === 'whitelist' && list[i].sites.length > 0) whites.push(list[i]);
    }
    if (whites.length) {
      for (i = 0; i < whites.length; i++) {
        if (any(whites[i].sites, u)) return null;
      }
      return whites[0].name;
    }

    for (i = 0; i < list.length; i++) {
      var r = list[i];
      if (r.mode === 'whitelist') continue;
      if (any(r.exceptions, u)) continue;
      if (any(r.sites, u)) return r.name;
    }
    return null;
  }

  root.KOFMatch = { hostOf: hostOf, makeMatcher: makeMatcher, compile: compile, match: match };
})(typeof self !== 'undefined' ? self : this);
