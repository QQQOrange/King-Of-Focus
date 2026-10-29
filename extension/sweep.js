/* King Of Focus — 网页收尾：休息结束那一刻决定每个标签页怎么处理
 *
 * 为什么单独成文件（和 matcher.js 一样）：
 *   判定必须是纯函数，才能脱离浏览器用 node 跑测试。background.js 里全是
 *   chrome.* 调用，一旦把"怎么处理"混进去，就只能靠人工点浏览器验证。
 *
 * 两种方式与主程序保持一致：
 *   soft（柔和）：把这个标签页换成拦截页——标签还在、地址可查，
 *                休息回来点一下「刷新」就能继续看；不关任何东西。
 *   hard（强制）：直接关掉标签页；若这个窗口只有它一个标签，
 *                并且主程序允许"连浏览器一起关"，就关掉整个窗口
 *                （与研究中主动清理的既有策略一致，见 background.closeOne）。
 *
 * 明确不碰的东西：
 *   · 非 http(s) 页面（chrome:// / 扩展页 / about:）
 *   · 拦截页自己（否则会把"已经收起来"的标签再收一次）
 *   · 未命中规则的标签（学习用的网页一个都不能动）
 */
(function (root) {
  'use strict';

  // 扩展页 / 浏览器内建页 / 拦截页：一律不处理
  function isSystemPage(u) {
    var s = String(u || '');
    if (!s) return true;
    return !/^https?:/i.test(s);
  }

  /**
   * @param {Array<{id:number,windowId:number,url:string}>} tabs 当前所有标签
   * @param {(url:string)=>string|null} matchFn 命中返回规则名（matcher.js 的 match）
   * @param {{mode?:'soft'|'hard', closeWindow?:boolean, max?:number, skipIds?:number[]}} opts
   * @returns {Array<{tabId:number,windowId:number,url:string,rule:string,
   *                  action:'blockpage'|'close'|'closeWindow'}>}
   */
  function plan(tabs, matchFn, opts) {
    var o = opts || {};
    var mode = o.mode === 'hard' ? 'hard' : 'soft';
    var closeWindow = o.closeWindow !== false;
    var max = o.max || 30;
    var skip = {};
    (o.skipIds || []).forEach(function (id) { skip[id] = true; });

    var perWin = {};
    (tabs || []).forEach(function (t) {
      if (t && t.windowId != null) perWin[t.windowId] = (perWin[t.windowId] || 0) + 1;
    });

    var out = [];
    (tabs || []).forEach(function (t) {
      if (!t || out.length >= max) return;
      if (t.id == null || skip[t.id]) return;
      if (isSystemPage(t.url)) return;
      var rule = null;
      try { rule = matchFn(t.url); } catch (e) { return; }
      if (!rule) return;
      var action = mode === 'hard' ? 'close' : 'blockpage';
      // 整窗关闭只在"这窗口就剩它一个标签"时做，避免顺手关掉用户别的页面
      if (action === 'close' && closeWindow && perWin[t.windowId] === 1) action = 'closeWindow';
      out.push({
        tabId: t.id,
        windowId: t.windowId,
        url: t.url,
        rule: rule,
        action: action,
      });
    });
    return out;
  }

  /** 这次是不是刚好发生了一次「休息 → 学习」的边界。
   *
   *  主程序每次边界把 sweepSeq +1，所以"变大"才算边界；
   *  变小说明主程序重启过（计数清零），那只是重新对齐，
   *  否则用户一开软件就会被莫名其妙收一遍标签。
   *  首次连上（prev == null）同样只对齐不扫。 */
  function boundary(prevSeq, seq) {
    if (prevSeq == null || prevSeq === undefined) return false;
    var a = Number(prevSeq), b = Number(seq);
    if (!isFinite(a) || !isFinite(b)) return false;
    return b > a;
  }

  /** 一次收尾的人类可读摘要（写进 storage / 弹窗显示） */
  function summarize(actions) {
    var n = { blockpage: 0, close: 0, closeWindow: 0 };
    (actions || []).forEach(function (a) { if (n[a.action] != null) n[a.action]++; });
    return { blocked: n.blockpage, closed: n.close + n.closeWindow, total: (actions || []).length };
  }

  root.KOFSweep = {
    plan: plan,
    summarize: summarize,
    isSystemPage: isSystemPage,
    boundary: boundary,
  };
})(typeof self !== 'undefined' ? self : this);
