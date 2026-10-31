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

// 白名单 + 例外：例外必须优先于白名单。
// 以前白名单分支只看 sites，配了例外也照拦 —— 界面承诺的"例外优先级更高"是空的。
const wlExc = M.compile([
  { name: '只准学习', mode: 'whitelist', sites: ['coursera.org'], exceptions: ['docs.rs'] },
]);
eq(M.match('https://docs.rs/serde', wlExc), null, '白名单模式下例外放行');
eq(M.match('https://www.coursera.org/', wlExc), null, '白名单内照常放行');
eq(M.match('https://youtube.com/', wlExc), '只准学习', '白名单外仍然拦截');

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

/* ---------- 网页收尾（sweep.js）：决定每个标签页怎么处理 ---------- */
require('../extension/sweep.js');
const S = self.KOFSweep;
const match = (u) => M.match(u, bl);

const tabs = [
  { id: 1, windowId: 10, url: 'https://www.youtube.com/watch?v=1' },  // 命中
  { id: 2, windowId: 10, url: 'https://docs.rs/serde' },               // 不命中
  { id: 3, windowId: 11, url: 'https://space.bilibili.com/1' },        // 命中（独立窗口）
  { id: 4, windowId: 13, url: 'chrome://settings' },                   // 非 http(s)，独占一个窗口
  { id: 5, windowId: 12, url: 'https://music.youtube.com/watch?v=1' }, // 例外 → 不命中
];
const planSoft = S.plan(tabs, match, { mode: 'soft' });
eq(planSoft.map((a) => a.tabId), [1, 3], '柔和：只挑命中规则的标签');
eq(planSoft.every((a) => a.action === 'blockpage'), true, '柔和：一律换成拦截页，不关标签');
eq(planSoft[0].rule, '学习时间', '柔和：带上命中的规则名');

const planHard = S.plan(tabs, match, { mode: 'hard', closeWindow: true });
eq(planHard.map((a) => `${a.tabId}:${a.action}`), ['1:close', '3:closeWindow'],
  '强制：单标签窗口连窗口关，多标签窗口只关标签');
eq(S.plan(tabs, match, { mode: 'hard', closeWindow: false }).map((a) => a.action),
  ['close', 'close'], '强制：允许连窗关时关闭（closeWindow=false 只关标签）');

eq(S.plan(tabs, match, { mode: 'soft', max: 1 }).length, 1, '每次最多处理 max 个');
eq(S.plan(tabs, match, { mode: 'soft', skipIds: [1] }).map((a) => a.tabId), [3],
  'skipIds 里的标签不动');

const sum = S.summarize(planHard);
eq([sum.blocked, sum.closed, sum.total], [0, 2, 2], '摘要：关标签 + 关窗口都算"关闭"');
eq(S.summarize(planSoft).blocked, 2, '摘要：柔和都算"拦截页"');

// 边界判定：只认"变大"；重启清零/首次连上都不算边界
eq(S.boundary(null, 3), false, '首次连上不触发收尾');
eq(S.boundary(3, 4), true, 'seq 变大 = 发生了一次边界');
eq(S.boundary(4, 4), false, 'seq 没变不触发');
eq(S.boundary(9, 0), false, '主程序重启把计数清零，不当作边界');
eq(S.boundary(undefined, 1), false, '没有基准时不触发');

// 非 http(s) 一律不碰
eq(S.isSystemPage('chrome-extension://abc/blocked.html'), true, '拦截页自身不处理');
eq(S.isSystemPage('https://a.com'), false, '普通网页要处理');

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
