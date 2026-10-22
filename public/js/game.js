'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  // 瀏覽器儲存：在無痕模式、沙盒預覽等環境可能無法使用，所有存取都包在 try 裡
  const area = (name) => (name === 'session' ? window.sessionStorage : window.localStorage);
  const store = {
    get(k, s = 'local') { try { return area(s).getItem(k); } catch { return null; } },
    set(k, v, s = 'local') { try { area(s).setItem(k, v); } catch { /* ignore */ } },
    del(k, s = 'local') { try { area(s).removeItem(k); } catch { /* ignore */ } },
  };
  const SS = 'session';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let cfg = null;
  let me = null; // { id, name, className, best, plays }
  const g = {
    sessionId: null, question: null, endAt: 0, readyAt: 0, durationMs: 180000,
    score: 0, combo: 0, locked: true, pending: false, ended: false, raf: 0,
  };

  // ── API ──────────────────────────────────────────
  async function api(path, body) {
    const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    let res;
    try {
      res = await fetch(path, opt);
    } catch {
      const e = new Error('連不上伺服器，請檢查網路');
      e.code = 'NETWORK';
      throw e;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || `發生錯誤（${res.status}）`);
      e.code = data.code;
      e.data = data;
      throw e;
    }
    return data;
  }

  // ── 共用 ─────────────────────────────────────────
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.toggleAttribute('data-active', s.id === id));
    window.scrollTo(0, 0);
  }
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  const fmtTime = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const restart = (el, cls) => {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch { /* ignore */ } };

  function applyConfig() {
    const sc = cfg.scoring;
    const set = (k, v) => document.querySelectorAll(`[data-cfg="${k}"]`).forEach((el) => { el.textContent = v; });
    const d = cfg.durationSeconds;
    set('duration', d % 60 === 0 ? `${d / 60} 分鐘` : `${d} 秒`);
    set('base', `+${sc.correctBase}`);
    set('speed', sc.speedBonus.max);
    set('penalty', `−${sc.wrongPenalty}`);
    set('cdn', cfg.cooldown.triggerAtConsecutiveWrong);
    set('cds', cfg.cooldown.seconds);
    set('lbsize', cfg.leaderboardSize);
    g.durationMs = d * 1000;
  }

  // ── 排行榜 ───────────────────────────────────────
  async function loadBoard(listId, selectId) {
    const sel = $(selectId);
    const list = $(listId);
    try {
      const data = await api(`/api/leaderboard${sel.value ? `?class=${encodeURIComponent(sel.value)}` : ''}`);
      const keep = sel.value;
      sel.replaceChildren(new Option('全部班級', ''), ...data.classes.map((c) => new Option(c, c)));
      sel.value = data.classes.includes(keep) ? keep : '';
      list.replaceChildren();
      if (!data.entries.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = '還沒有人上榜，第一名等你來拿';
        list.append(li);
        return;
      }
      for (const e of data.entries) {
        const li = document.createElement('li');
        if (me && e.name === me.name && e.className === me.className) li.classList.add('me');
        const rk = document.createElement('span'); rk.className = 'rk'; rk.textContent = e.rank;
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = e.name;
        const cl = document.createElement('span'); cl.className = 'cl'; cl.textContent = e.className; nm.append(cl);
        const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = e.bestScore.toLocaleString();
        li.append(rk, nm, sc);
        list.append(li);
      }
    } catch (e) {
      list.replaceChildren();
      const li = document.createElement('li'); li.className = 'empty'; li.textContent = e.message; list.append(li);
    }
  }

  // ── 登入／大廳 ───────────────────────────────────
  function renderLobby() {
    $('lobby-name').textContent = me.name;
    $('lobby-class').textContent = me.className;
    $('lobby-best').textContent = me.best.toLocaleString();
    $('lobby-plays').textContent = me.plays ? `（已玩 ${me.plays} 次）` : '';
    show('screen-lobby');
    loadBoard('board-lobby', 'board-class-lobby');
  }

  async function login(id) {
    const data = await api('/api/login', { studentId: id });
    me = { id, name: data.student.name, className: data.student.className, best: data.bestScore, plays: data.plays };
    store.set('rp_student', id);
    renderLobby();
  }

  // 不依賴表單送出（某些內嵌/沙盒環境會封鎖表單送出），改用按鈕點擊與 Enter 鍵
  async function submitLogin() {
    const btn = $('login-btn');
    const id = $('student-id').value.trim();
    $('login-error').textContent = '';
    if (!id) {
      $('login-error').textContent = '請輸入學號';
      return;
    }
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await login(id);
    } catch (e) {
      $('login-error').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }
  $('login-form').addEventListener('submit', (ev) => { ev.preventDefault(); submitLogin(); });
  $('login-btn').addEventListener('click', submitLogin);
  $('student-id').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); submitLogin(); }
  });
  $('logout-btn').addEventListener('click', () => {
    me = null;
    store.del('rp_student');
    $('student-id').value = '';
    show('screen-login');
    $('student-id').focus();
  });
  $('show-board-from-login').addEventListener('click', (ev) => {
    ev.preventDefault();
    show('screen-board');
    loadBoard('board-public', 'board-class-public');
  });
  $('back-to-login').addEventListener('click', () => show('screen-login'));
  $('board-class-lobby').addEventListener('change', () => loadBoard('board-lobby', 'board-class-lobby'));
  $('board-class-public').addEventListener('change', () => loadBoard('board-public', 'board-class-public'));

  // ── 遊戲 ─────────────────────────────────────────
  const choiceBtns = [$('choice-0'), $('choice-1')];

  function setLocked(v) {
    g.locked = v;
    $('choices').classList.toggle('locked', v);
    choiceBtns.forEach((b) => { b.disabled = v; });
  }

  function renderQuestion(q, animate = true) {
    g.question = q;
    $('q-no').textContent = `第 ${q.no} 題`;
    $('q-text').textContent = q.text;
    q.choices.forEach((label, i) => {
      choiceBtns[i].dataset.label = label;
      choiceBtns[i].querySelector('.choice-text').textContent = label;
      choiceBtns[i].setAttribute('aria-label', label);
    });
    if (animate && !reduceMotion) restart($('q-card'), 'enter');
  }

  function renderHud() {
    $('score').textContent = g.score.toLocaleString();
    $('combo').textContent = g.combo;
    $('combo-box').classList.toggle('hot', g.combo >= 3);
  }

  function syncClock(remainingMs) {
    const target = performance.now() + remainingMs;
    if (!g.endAt || Math.abs(target - g.endAt) > 400) g.endAt = target;
  }

  function tick() {
    const left = g.endAt - performance.now();
    $('timer').textContent = fmtTime(left);
    const frac = Math.max(0, Math.min(1, left / g.durationMs));
    $('time-fill').style.transform = `scaleX(${frac})`;
    $('clock-hand').style.transform = `rotate(${(1 - frac) * 360}deg)`;
    $('timer-box').classList.toggle('urgent', left <= 10000);
    if (left <= 0) {
      endGame();
      return;
    }
    g.raf = requestAnimationFrame(tick);
  }

  async function runCountdown(ms) {
    const box = $('countdown');
    if (ms <= 50) return;
    box.hidden = false;
    let n = Math.ceil(ms / 1000);
    while (n > 0) {
      const span = $('countdown-num');
      span.textContent = n;
      restart(span, 'x');
      const wait = ms - (n - 1) * 1000;
      await sleep(wait);
      ms -= wait;
      n--;
    }
    box.hidden = true;
  }

  async function enterGame(state) {
    g.sessionId = state.sessionId;
    store.set('rp_session', state.sessionId, SS);
    g.score = state.score;
    g.combo = state.combo;
    g.ended = false;
    g.pending = false;
    g.endAt = 0;
    syncClock(state.remainingMs);
    renderHud();
    renderQuestion(state.question, false);
    setLocked(true);
    $('cooldown').hidden = true;
    $('q-card').classList.remove('ok', 'ng');
    show('screen-game');
    cancelAnimationFrame(g.raf);
    // 開場倒數期間，計時器停在滿格
    $('timer').textContent = fmtTime(Math.min(state.remainingMs, g.durationMs));
    $('time-fill').style.transform = 'scaleX(1)';
    $('clock-hand').style.transform = 'rotate(0deg)';
    $('timer-box').classList.remove('urgent');
    if (state.waitMs > 0 && state.answeredCount === 0) {
      await runCountdown(state.waitMs);
    } else if (state.waitMs > 0) {
      await showCooldown(state.waitMs);
    }
    if (g.ended) return;
    g.raf = requestAnimationFrame(tick);
    setLocked(false);
  }

  async function showCooldown(ms) {
    const box = $('cooldown');
    box.hidden = false;
    const until = performance.now() + ms;
    while (performance.now() < until && !g.ended) {
      $('cooldown-num').textContent = Math.ceil((until - performance.now()) / 1000);
      await sleep(100);
    }
    box.hidden = true;
  }

  function floatPoints(delta, label) {
    const el = document.createElement('span');
    el.className = `float-pts ${delta >= 0 ? 'plus' : 'minus'}`;
    el.textContent = `${label}  ${delta >= 0 ? '+' : '−'}${Math.abs(delta)}`;
    $('float-layer').append(el);
    setTimeout(() => el.remove(), 900);
  }

  function comboPop(combo, bonus) {
    const wrap = $('combo-pop');
    const el = document.createElement('div');
    el.className = 'cp';
    el.textContent = `${combo} 連對`;
    const small = document.createElement('small');
    small.textContent = `獎勵 +${bonus}`;
    el.append(small);
    wrap.replaceChildren(el);
    setTimeout(() => el.remove(), 1050);
  }

  async function answer(idx) {
    if (g.locked || g.pending || g.ended || !g.question) return;
    const choice = g.question.choices[idx];
    g.pending = true;
    setLocked(true);
    let r;
    try {
      r = await api('/api/game/answer', { sessionId: g.sessionId, questionId: g.question.id, choice });
    } catch (e) {
      g.pending = false;
      if (g.ended) return;
      if (e.code === 'NOT_READY') {
        await sleep(Math.min(3000, e.data.waitMs || 300));
        setLocked(false);
        return;
      }
      toast(e.code === 'NETWORK' ? '連線不穩，正在重新同步…' : e.message);
      await resync();
      return;
    }
    g.pending = false;
    if (r.finished && !r.next) {
      g.score = r.score;
      renderHud();
      endGame();
      return;
    }
    // 回饋動畫
    const card = $('q-card');
    card.classList.remove('ok', 'ng');
    void card.offsetWidth;
    card.classList.add(r.correct ? 'ok' : 'ng');
    setTimeout(() => card.classList.remove('ok', 'ng'), 380);
    const mark = $('mark');
    mark.classList.remove('ok', 'ng');
    void mark.getBoundingClientRect();
    mark.classList.add(r.correct ? 'ok' : 'ng');
    floatPoints(r.points.delta, r.correct ? `✓ ${r.correctAnswer}` : `✗ 正解：${r.correctAnswer}`);
    if (!r.correct) vibrate(80);
    const comboUp = r.combo > g.combo;
    g.score = r.score;
    g.combo = r.combo;
    renderHud();
    if (comboUp && !reduceMotion) restart($('combo-box'), 'bump');
    if (r.comboBonus > 0) comboPop(r.combo, r.comboBonus);
    syncClock(r.remainingMs);
    if (r.next) renderQuestion(r.next);
    if (r.cooldownMs > 0) await showCooldown(r.cooldownMs);
    if (!g.ended) setLocked(false);
  }

  async function resync() {
    try {
      const s = await api('/api/game/resume', { sessionId: g.sessionId });
      if (s.finished) return endGame();
      g.score = s.score;
      g.combo = s.combo;
      syncClock(s.remainingMs);
      renderHud();
      renderQuestion(s.question, false);
      if (s.waitMs > 0) await showCooldown(s.waitMs);
      if (!g.ended) setLocked(false);
    } catch {
      await sleep(1500);
      if (!g.ended) resync();
    }
  }

  choiceBtns.forEach((b, i) => b.addEventListener('click', () => answer(i)));
  document.addEventListener('keydown', (ev) => {
    if (!$('screen-game').hasAttribute('data-active') || ev.repeat) return;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); answer(0); }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); answer(1); }
  });

  async function startGame() {
    const btn = $('start-btn');
    btn.disabled = true;
    try {
      const s = await api('/api/game/start', { studentId: me.id });
      await enterGame(s);
    } catch (e) {
      toast(e.message);
      show('screen-lobby');
    } finally {
      btn.disabled = false;
    }
  }
  $('start-btn').addEventListener('click', startGame);
  $('again-btn').addEventListener('click', startGame);
  $('lobby-btn').addEventListener('click', async () => {
    try { await login(me.id); } catch { renderLobby(); }
  });

  // ── 結算 ─────────────────────────────────────────
  async function endGame() {
    if (g.ended) return;
    g.ended = true;
    cancelAnimationFrame(g.raf);
    setLocked(true);
    $('timer').textContent = '0:00';
    $('time-fill').style.transform = 'scaleX(0)';
    for (let i = 0; i < 30 && g.pending; i++) await sleep(100); // 等最後一題回來
    let res = null;
    for (let i = 0; i < 4 && !res; i++) {
      try {
        res = await api('/api/game/finish', { sessionId: g.sessionId });
      } catch (e) {
        if (e.code === 'NO_SESSION') break;
        await sleep(1000);
      }
    }
    store.del('rp_session', SS);
    if (!res) {
      toast('成績結算失敗，請回大廳查看分數');
      if (me) renderLobby(); else show('screen-login');
      return;
    }
    showResult(res);
  }

  function showResult(r) {
    $('r-score').textContent = r.score.toLocaleString();
    $('r-correct').textContent = `${r.correctCount} / ${r.answeredCount} 題`;
    $('r-acc').textContent = `${r.accuracy}%`;
    $('r-combo').textContent = `${r.maxCombo} 題`;
    $('r-best').textContent = r.bestScore.toLocaleString();
    $('r-rank').textContent = r.isTest ? '測試帳號不列入' : r.rank ? `第 ${r.rank} 名` : '—';
    $('record-banner').hidden = !r.isNewRecord;

    // 成績單抬頭與等第
    if (r.reportCardTitle) $('r-title').textContent = r.reportCardTitle;
    $('r-class').textContent = me ? me.className : '';
    $('r-name').textContent = me ? me.name : '';
    const d = new Date(r.finishedAt || Date.now());
    $('r-date').textContent = `${d.getFullYear() - 1911} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    const gradeEl = $('r-grade');
    gradeEl.classList.toggle('none', !r.grade);
    gradeEl.textContent = r.grade ? r.grade.label : '—';
    if (!reduceMotion) restart(gradeEl, 'x');
    $('r-comment').textContent = r.grade ? r.grade.comment : '這局沒有作答，不列入紀錄。';
    let hint = '';
    if (r.grade && r.grade.next) {
      const n = r.grade.next;
      const parts = [];
      if (n.needAccuracy != null) parts.push(`正確率達到 ${n.needAccuracy}%`);
      if (n.needScore != null) parts.push(`分數達到 ${n.needScore.toLocaleString()}`);
      if (parts.length) hint = `下一個目標：${parts.join('、')}，就能拿到「${n.label}」。`;
    }
    $('r-next').textContent = hint;
    if (me) { me.best = r.bestScore; me.plays += r.answeredCount ? 1 : 0; }

    const list = $('review-list');
    list.replaceChildren();
    for (const w of r.review) {
      const li = document.createElement('li');
      const q = document.createElement('span'); q.className = 'rv-q'; q.textContent = w.text;
      const a = document.createElement('span'); a.className = 'rv-a';
      const ng = document.createElement('span'); ng.className = 'ng'; ng.textContent = w.chosen;
      const ok = document.createElement('span'); ok.className = 'ok'; ok.textContent = w.correctAnswer;
      a.append('你選 ', ng, '，正確是 ', ok);
      li.append(q, a);
      if (w.explanation) { const x = document.createElement('span'); x.className = 'rv-x'; x.textContent = w.explanation; li.append(x); }
      list.append(li);
    }
    $('review-count').textContent = r.review.length;
    $('review').hidden = r.review.length === 0;
    $('review').open = false;
    show('screen-result');
    if (r.isNewRecord) confetti();
  }

  function confetti() {
    if (reduceMotion) return;
    const box = $('confetti');
    const colors = ['#1f56c8', '#de560f', '#e9b949', '#11895a', '#e0352b'];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 70; i++) {
      const p = document.createElement('i');
      p.style.left = `${Math.random() * 100}%`;
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = `${1.8 + Math.random() * 1.8}s`;
      p.style.animationDelay = `${Math.random() * 0.6}s`;
      p.style.transform = `rotate(${Math.random() * 360}deg)`;
      frag.append(p);
    }
    box.replaceChildren(frag);
    setTimeout(() => box.replaceChildren(), 4500);
  }

  // ── 啟動 ─────────────────────────────────────────
  (async function init() {
    try {
      cfg = await api('/api/config');
      applyConfig();
    } catch (e) {
      $('login-error').textContent = e.message;
      return;
    }
    const savedId = store.get('rp_student');
    const savedSession = store.get('rp_session', SS);
    if (savedId) {
      try {
        await login(savedId);
      } catch {
        store.del('rp_student');
        show('screen-login');
      }
    }
    if (me && savedSession) {
      try {
        const s = await api('/api/game/resume', { sessionId: savedSession });
        if (s.finished) {
          g.sessionId = savedSession;
          const r = await api('/api/game/finish', { sessionId: savedSession });
          store.del('rp_session', SS);
          showResult(r);
        } else {
          await enterGame(s);
        }
      } catch {
        store.del('rp_session', SS);
      }
    }
  })();
})();
