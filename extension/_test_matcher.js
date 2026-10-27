/* 扩展匹配器单元测试（node 直接跑）：node extension/_test_matcher.js
 *
 * 覆盖两类最容易踩的坑：
 *   1) 用户直接粘贴整条网址（https://www.douyin.com/）→ 必须按域名规则处理，
 *      裸域 douyin.com、www.douyin.com、m.douyin.com 全都要拦住；
 *   2) 带路径 / 通配的写法仍然按原来的精确 / 前缀语义走，不能被放宽。
 */
const path = require('path');
const src = require('fs').readFileSync(path.join(__dirname, 'matcher.js'), 'utf8');
const sandbox = { self: {} };
// matcher.js 是 IIFE，挂到 self 上
new Function('self', src)(sandbox.self);
const M = sandbox.self.KOFMatch;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function block(pat, url, name) {
  const m = M.makeMatcher(pat);
  ok(!!m && m(url), name || (pat + ' 应当拦住 ' + url), 'matcher=' + (m ? '有' : '无'));
}
function allow(pat, url, name) {
  const m = M.makeMatcher(pat);
  ok(!m || !m(url), name || (pat + ' 不该拦 ' + url));
}

console.log('— 用户粘贴整条网址 —');
block('https://www.douyin.com/', 'https://www.douyin.com/', '整条网址（含斜杠）拦得住自己');
block('https://www.douyin.com/', 'https://www.douyin.com', '整条网址拦得住无斜杠写法');
block('https://www.douyin.com/', 'https://douyin.com/', '整条网址拦得住裸域');
block('https://www.douyin.com/', 'https://m.douyin.com/video/123', '整条网址拦得住子域');
block('https://www.douyin.com/', 'https://www.douyin.com/video/123', '整条网址拦得住子页面');
block('https://www.douyin.com/?from=x', 'https://www.douyin.com/', '带 query 的整条网址也拦得住');

console.log('— 裸域写法（用户配置里现在的样子）—');
block('www.douyin.com', 'https://www.douyin.com/', '裸域拦得住自己');
block('www.douyin.com', 'https://douyin.com/', '裸域拦得住去 www 的裸域');
block('www.douyin.com', 'https://www.douyin.com/video/123', '裸域拦得住子页面');
block('douyin.com', 'https://www.douyin.com/', '裸域（非 www）拦得住 www');
block('*.douyin.com', 'https://www.douyin.com/', '*. 写法拦得住');
allow('douyin.com', 'https://www.baidu.com/', '别的站不该被拦');

console.log('— 路径 / 通配语义不被放宽 —');
block('example.com/video', 'https://example.com/video/123', '路径前缀仍然拦得住');
allow('example.com/video', 'https://example.com/', '路径规则不该拦到根路径');
block('*.example.com', 'https://a.example.com/x', '*. 通配仍然拦得住子域');
allow('example.com/video', 'https://example.com/other', '路径规则不该拦到别的路径');

console.log('— 整条规则（含例外）—');
const rules = M.compile([{
  name: '自律时间',
  mode: 'blacklist',
  sites: ['https://www.douyin.com/'],
  exceptions: ['www.douyin.com/video/keep'],
}]);
ok(M.match('https://www.douyin.com/', rules) === '自律时间', '规则命中抖音');
ok(M.match('https://www.douyin.com/video/keep', rules) === null, '例外放行');
ok(M.match('https://www.baidu.com/', rules) === null, '无关站点放行');

console.log('— 白名单（强制模式）—');
const white = M.compile([{ name: '只能看这些', mode: 'whitelist', sites: ['www.bing.com'], exceptions: [] }]);
ok(M.match('https://www.bing.com/', white) === null, '白名单内的放行');
ok(M.match('https://www.douyin.com/', white) === '只能看这些', '白名单外的被拦');

console.log('— DNR 条件（background.js 里的 condOf）—');
// background.js 顶层就摸 chrome.*，不能直接 require；只把 condOf 抠出来跑
const bgSrc = require('fs').readFileSync(path.join(__dirname, 'background.js'), 'utf8');
const condSrc = bgSrc.match(/function condOf\(pattern\) \{[\s\S]*?\n\}/);
if (!condSrc) { console.log('  ✗ 没找到 condOf'); fail++; }
else {
  const condOf = new Function(condSrc[0] + '; return condOf;')();
  const c1 = condOf('https://www.douyin.com/');
  ok(c1 && c1.requestDomains && c1.requestDomains[0] === 'douyin.com',
    '整条网址 → DNR 走域名规则（douyin.com）', JSON.stringify(c1));
  const c2 = condOf('www.douyin.com');
  ok(c2 && c2.requestDomains && c2.requestDomains[0] === 'douyin.com',
    '裸域 → DNR 走域名规则', JSON.stringify(c2));
  const c3 = condOf('example.com/video');
  ok(c3 && c3.regexFilter === 'example\\.com/video', '带路径 → 仍是正则', JSON.stringify(c3));
  const c4 = condOf('*.example.com');
  ok(c4 && c4.requestDomains && c4.requestDomains[0] === 'example.com', '*. 写法 → 域名规则', JSON.stringify(c4));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
