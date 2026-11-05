/**
 * 新标签页。
 *
 * 只做一件事：把"今天"摆在每次开新标签页的那一秒。
 * 数据全部来自 background 写进 chrome.storage.local 的那一份（每 12 秒刷新一次），
 * 这里不发任何请求——新标签页是打开频率最高的页面，不能因为它多一个网络请求
 * 就把开新标签页变慢。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, '0');

  let st = {
    active: false,
    clockOn: false,
    clockLeft: 0,
    lang: 'zh-CN',
    today: null,
    activeRules: [],
  };
  let left = 0;

  const T = (zh, en) => (st.lang === 'en' ? en : zh);

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h} ${T('小时', 'h')} ${m} ${T('分', 'min')}`;
    return `${m} ${T('分钟', 'min')}`;
  }

  function paintClock() {
    const d = new Date();
    $('clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const wd = T(
      ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()],
      ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()],
    );
    $('date').textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} · ${wd}`;
  }

  function paintStatus() {
    const bar = $('status');
    if (st.active) {
      bar.className = 'pill';
      bar.textContent = st.clockOn ? T('自律中', 'Focus on') : T('规则生效中', 'Rules active');
      const l = $('left');
      if (st.clockOn && left > 0) {
        l.hidden = false;
        const m = Math.floor(left / 60);
        l.textContent = T('剩余 ', 'left ') + `${m}:${pad(left % 60)}`;
      } else {
        l.hidden = true;
      }
    } else {
      bar.className = 'pill off';
      bar.textContent = T('当前没有自律', 'Nothing active now');
      $('left').hidden = true;
    }
  }

  function paintToday() {
    const t = st.today || {};
    const onMin = Number(t.onMin) || 0;
    const planMin = Number(t.planMin) || 0;
    $('todayLine').textContent = planMin > 0
      ? `${fmt(onMin * 60)} / ${fmt(planMin * 60)}`
      : fmt(onMin * 60);
    const pct = planMin > 0 ? Math.min(100, Math.round((onMin / planMin) * 100)) : 0;
    $('bar').style.width = pct + '%';

    const goal = (t.goal || '').trim();
    const g = $('goal');
    g.textContent = '';
    if (!goal) {
      g.className = 'goal muted';
      g.textContent = T(
        '还没有写目标——打开 King Of Focus 开始一段专注，就能写这一段的产出。',
        'No goal yet — start a focus session in King Of Focus to write one.',
      );
      return;
    }
    g.className = 'goal';
    g.textContent = goal;
    const state = t.goalState || '';
    if (state) {
      const tag = document.createElement('span');
      tag.className = 'tag ' + state;
      tag.textContent = state === 'done' ? T('做到了', 'Done')
        : state === 'partial' ? T('做了一半', 'Partial')
          : state === 'missed' ? T('没做成', 'Missed') : '';
      if (tag.textContent) g.appendChild(tag);
    }
    if (t.goalTotal > 0) {
      const stat = document.createElement('div');
      stat.className = 'muted';
      stat.style.marginTop = '8px';
      stat.style.fontSize = '12px';
      stat.textContent = T('今日目标 ', 'Today: ') + `${t.goalDone}/${t.goalTotal}`;
      g.appendChild(stat);
    }
  }

  function paintQuote() {
    const q = st.today && st.today.quote;
    const el = $('quote');
    if (q && (q.text || q.t)) {
      el.textContent = (q.text || q.t) + (q.from ? ' —— ' + q.from : '');
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function paintAll() {
    paintClock();
    paintStatus();
    paintToday();
    paintQuote();
  }

  function load() {
    chrome.storage.local.get(
      ['active', 'clockOn', 'clockLeft', 'lang', 'today', 'activeRules'],
      (v) => {
        st.active = !!v.active;
        st.clockOn = !!v.clockOn;
        st.clockLeft = Number(v.clockLeft) || 0;
        st.lang = v.lang === 'en' ? 'en' : 'zh-CN';
        st.today = v.today || null;
        st.activeRules = v.activeRules || [];
        left = st.clockLeft;
        paintAll();
      },
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let hit = false;
    for (const k of Object.keys(changes)) {
      if (['active', 'clockOn', 'clockLeft', 'lang', 'today', 'activeRules'].includes(k)) {
        st[k] = changes[k].newValue;
        hit = true;
      }
    }
    if (!hit) return;
    if (typeof st.clockLeft !== 'number') st.clockLeft = Number(st.clockLeft) || 0;
    left = st.clockLeft;
    paintAll();
  });

  setInterval(() => {
    paintClock();
    if (st.active && st.clockOn && left > 0) {
      left -= 1;
      paintStatus();
    }
  }, 1000);

  load();
})();
