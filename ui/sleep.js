/* 睡眠锁屏窗口：每秒拉一次状态，纯展示 + 一个「积分解锁」按钮 */
'use strict';

const T = window.__TAURI__;
const invoke = T && T.core ? T.core.invoke : async () => ({});

const $ = (s) => document.querySelector(s);

const TXT = {
  'zh-CN': {
    kicker: 'SLEEP HOURS',
    title: '现在是睡眠时间',
    sub: '这台电脑该关着了。',
    countLab: '后自动关机',
    firedLab: '关机指令已发出',
    noShutdown: '只锁定，不关机',
    unlock: (p, m) => `用 ${p} 积分解锁 ${m} 分钟`,
    unlockShort: '积分解锁',
    balance: (b) => `当前积分 ${b}`,
    notEnough: '积分不够，先去完成今天的自律时段',
    off: '这段睡眠没有开启积分解锁',
    lockedTo: (t) => `锁定至 ${t}`,
    win: (a, b) => `睡眠时段 ${a} – ${b}`,
    foot: '睡眠时段内开机，功能会被限制；倒计时结束将自动关机。<br>想现在用电脑，只能用积分解锁（解锁到期后自动重新锁定）。',
    up: (m) => `本次开机 ${m} 分钟`,
    dry: '演练模式：不会真的关机',
    test: '测试模式：锁定已豁免',
  },
  en: {
    kicker: 'SLEEP HOURS',
    title: 'It is sleep time',
    sub: 'This machine should be off.',
    countLab: 'until shutdown',
    firedLab: 'shutdown issued',
    noShutdown: 'lock only, no shutdown',
    unlock: (p, m) => `Unlock ${m} min for ${p} pts`,
    unlockShort: 'Unlock with points',
    balance: (b) => `Balance ${b} pts`,
    notEnough: 'Not enough points',
    off: 'Points unlock is disabled',
    lockedTo: (t) => `Locked until ${t}`,
    win: (a, b) => `Sleep hours ${a} – ${b}`,
    foot: 'Booting during sleep hours restricts this PC; it shuts down when the countdown ends.<br>Use points to use the PC now (it re-locks when the unlock expires).',
    up: (m) => `Up ${m} min`,
    dry: 'Dry run: no real shutdown',
    test: 'Test mode: lock bypassed',
  },
};

let LANG = 'zh-CN';
const L = (k) => (TXT[LANG] || TXT['zh-CN'])[k] || TXT['zh-CN'][k] || k;

const pad = (n) => String(n).padStart(2, '0');
const fmtHM = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
const fmtTs = (ts) => {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const mmss = (secs) => {
  const s = Math.max(0, Math.round(secs));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};

let first = true;
let unlockMin = 30;
let price = 0;

function paint(st) {
  if (!st) return;
  LANG = st.lang === 'en' ? 'en' : 'zh-CN';
  document.documentElement.lang = LANG;
  unlockMin = st.unlockMin || 30;
  price = st.price || 0;

  $('#kicker').textContent = L('kicker');
  $('#title').textContent = L('title');
  $('#sub').textContent = L('sub');
  $('#testTag').hidden = !(st.testMode || st.dryRun);
  $('#testTag').textContent = st.testMode ? L('test') : (st.dryRun ? L('dry') : '');

  const now = new Date();
  $('#clock').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const fired = !!st.fired;
  $('#countBox').classList.toggle('hot', fired || st.remain <= 60);
  $('#count').textContent = fired ? '00:00' : mmss(st.remain);
  $('#countLab').textContent = fired ? L('firedLab') : (st.shutdown ? L('countLab') : L('noShutdown'));

  // 进度条：从倒计时满格走到 0
  const total = Math.max(1, (st.countdownMin || 10) * 60);
  $('#bar').style.width = `${Math.max(0, Math.min(100, (st.remain / total) * 100))}%`;

  const btn = $('#unlock');
  if (!price) {
    btn.disabled = true;
    btn.textContent = L('unlockShort');
    $('#err').textContent = L('off');
  } else {
    btn.disabled = st.balance < price;
    btn.textContent = L('unlock')(price, unlockMin);
    $('#err').textContent = st.balance < price ? L('notEnough') : '';
  }

  const uptimeMin = Math.floor((st.uptime || 0) / 60);
  const parts = [
    L('win')(fmtHM(st.from), fmtHM(st.to % 1440 === 0 && st.to >= 1440 ? 1440 : st.to)),
    L('lockedTo')(fmtTs(st.windowEnd)),
  ];
  if (uptimeMin >= 1) parts.push(L('up')(uptimeMin));
  parts.push(L('balance')(st.balance));
  $('#tag').textContent = parts.join(' · ');
  $('#foot').innerHTML = L('foot');

  if (first) {
    first = false;
    document.body.style.opacity = '0';
    document.body.style.transition = 'opacity .35s ease';
    requestAnimationFrame(() => { document.body.style.opacity = '1'; });
  }
}

$('#unlock').addEventListener('click', async () => {
  const btn = $('#unlock');
  btn.disabled = true;
  try {
    await invoke('sleep_unlock', { minutes: unlockMin });
    $('#err').textContent = '';
    await tick();
  } catch (e) {
    $('#err').textContent = String(e).replace(/^Error:\s*/, '');
  } finally {
    btn.disabled = false;
  }
});

async function tick() {
  try {
    const st = await invoke('sleep_state');
    paint(st);
    // 已经解锁 / 出了睡眠时段：让出屏幕（Rust 那边也会隐藏，这里只是更快一步）
    if (st && !st.locked && !st.testMode) {
      document.body.style.opacity = '0';
    } else {
      document.body.style.opacity = '1';
    }
  } catch (e) {
    // 拿不到状态时不要挡住窗口（宁可少锁，也不要黑屏解不开）
  }
}

tick();
setInterval(tick, 1000);
