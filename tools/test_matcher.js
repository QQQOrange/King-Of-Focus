/* 匹配器单测：node tools/test_matcher.js
 * 覆盖纯域名 / 子域 / 通配 / 路径 / 例外 / 强制模式 / 非法输入
 */
global.self = global;
require('../extension/matcher.js');
const M = self.KOFMatch;

let pass = 0, fail = 0;
function eq(actual, expect, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect);
  if (ok) { pass++; } else { fail++; console.log(`  ✗ ${label}\n      期望 ${JSON.stringify(expect)}  实际 ${JSON.stringify(actual)}`); }
}

const bl = M.compile([{ name: '学习时间', mode: 'blacklist', sites: ['youtube.com', '*.bilibili.com', 'douyin.com/live'], exceptions: ['music.youtube.com'] }]);

const cases = [
  // [url, 期望命中的规则名 or null, 说明]
  ['https://www.youtube.com/watch?v=1', '学习时间', '纯域名命中 www 前缀'],
  ['https://m.youtube.com/', '学习时间', '纯域名命中子域'],
  ['https://youtube.com/', '学习时间', '纯域名命中裸域'],
  ['https://notyoutube.com/', null, '后缀相同但不是子域，必须放过'],
  ['https://youtube.com.evil.cn/', null, '域名被拼在后缀里，必须放过'],
  ['https://space.bilibili.com/123', '学习时间', '*.bilibili.com 命中子域'],
  ['https://bilibili.com/', '学习时间', '*.bilibili.com 也命中裸域（符合直觉）'],
  ['https://www.bilibili.com/', '学习时间', '*.bilibili.com 命中 www'],
  ['https://notbilibili.com/', null, '通配域名不误伤相似域名'],
  ['https://www.douyin.com/live/123', '学习时间', '路径规则命中'],
  ['https://www.douyin.com/user/abc', null, '路径规则不误伤其他路径'],
  ['https://music.youtube.com/watch?v=1', null, '例外优先于黑名单'],
  ['https://MUSIC.YouTube.com/', null, '大小写不敏感'],
  ['chrome://settings', null, '非 http(s) 不处理'],
  ['about:blank', null, 'about: 不处理'],
  ['https://example.com/', null, '无关站点'],
];
for (const [u, expect, label] of cases) eq(M.match(u, bl), expect, label);

// 强制模式
const wl = M.compile([{ name: '只准学习', mode: 'whitelist', sites: ['coursera.org', 'docs.rs'] }]);
eq(M.match('https://www.coursera.org/learn/x', wl), null, '白名单内放行');
eq(M.match('https://docs.rs/serde', wl), null, '白名单内放行 2');
eq(M.match('https://youtube.com/', wl), '只准学习', '白名单外拦截');

// 空名单的白名单规则不能清场
const emptyWl = M.compile([{ name: '空名单', mode: 'whitelist', sites: [] }]);
eq(M.match('https://youtube.com/', emptyWl), null, '空白名单视为未配置');

// 通配全站
const all = M.compile([{ name: '全拦', mode: 'blacklist', sites: ['*'] }]);
eq(M.match('https://anything.example/', all), '全拦', '单个 * 拦全部');

// 非法输入不崩
eq(M.match('', bl), null, '空 URL');
eq(M.match(null, bl), null, 'null URL');
eq(M.match('https://x.com/', null), null, '空规则集');
eq(M.makeMatcher(''), null, '空规则编译为 null');
eq(M.makeMatcher('   '), null, '空白规则编译为 null');

// 主机解析
eq(M.hostOf('https://WWW.Example.COM:8443/a'), 'example.com', 'hostOf 去 www / 端口 / 小写');
eq(M.hostOf('not a url'), '', 'hostOf 垃圾输入');

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
