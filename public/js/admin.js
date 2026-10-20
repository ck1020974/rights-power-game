'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { cls: '', students: [], questions: [], sort: { s: ['className', 1], q: ['code', 1] } };

  async function api(path, body) {
    const opt = { headers: { 'X-Requested-With': 'rp-admin' } };
    if (body !== undefined) {
      opt.method = 'POST';
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    let res;
    try { res = await fetch(path, opt); } catch { throw new Error('連不上伺服器'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.endsWith('/login')) { showLogin(); throw new Error(data.error || '請重新登入'); }
    if (!res.ok) throw new Error(data.error || `發生錯誤（${res.status}）`);
    return data;
  }

  const show = (id) => document.querySelectorAll('.screen').forEach((s) => s.toggleAttribute('data-active', s.id === id));
  let toastTimer;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  const fmtPct = (x) => (x == null ? '—' : `${Math.round(x * 1000) / 10}%`);
  const fmtSec = (x) => (x == null ? '—' : x.toFixed(2));
  const dtf = new Intl.DateTimeFormat('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtTime = (ms) => (ms ? dtf.format(new Date(ms)) : '—');
  const accClass = (x) => (x == null ? '' : x < 0.6 ? 'acc-low' : x < 0.75 ? 'acc-mid' : '');
  const qs = () => (state.cls ? `?class=${encodeURIComponent(state.cls)}` : '');

  function td(text, cls) {
    const el = document.createElement('td');
    if (text instanceof Node) el.append(text); else el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }
  function tag(answer) {
    const s = document.createElement('span');
    s.className = `tag ${answer === '權利' ? 'tag-r' : 'tag-p'}`;
    s.textContent = answer;
    return s;
  }
  function emptyRow(tbody, cols, text) {
    const tr = document.createElement('tr'); tr.className = 'empty-row';
    const c = td(text); c.colSpan = cols; tr.append(c); tbody.replaceChildren(tr);
  }

  // ── 排序 ─────────────────────────────────────────
  const collator = new Intl.Collator('zh-Hant', { numeric: true });
  const GRADE_ORDER = { 優: 5, 甲: 4, 乙: 3, 丙: 2, 丁: 1 };
  function sortRows(rows, [key, dir]) {
    return rows.slice().sort((a, b) => {
      let x = a[key]; let y = b[key];
      if (key === 'bestGrade') { x = x ? GRADE_ORDER[x] ?? 0 : null; y = y ? GRADE_ORDER[y] ?? 0 : null; }
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
      return r * dir;
    });
  }
  function bindSort(tableId, which, render) {
    $(tableId).querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const [k, d] = state.sort[which];
        const numeric = th.classList.contains('num') || th.dataset.sort === 'lastPlayed';
        state.sort[which] = [th.dataset.sort, k === th.dataset.sort ? -d : numeric ? -1 : 1];
        render();
      });
    });
  }
  function markSorted(tableId, [key, dir]) {
    $(tableId).querySelectorAll('th[data-sort]').forEach((th) => {
      th.classList.toggle('sorted-asc', th.dataset.sort === key && dir === 1);
      th.classList.toggle('sorted-desc', th.dataset.sort === key && dir === -1);
    });
  }

  // ── 學生 ─────────────────────────────────────────
  function renderStudents() {
    const q = $('s-search').value.trim().toLowerCase();
    const playedOnly = $('s-played').checked;
    let rows = state.students.filter((s) => (!playedOnly || s.plays > 0) && (!q || s.studentId.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)));
    rows = sortRows(rows, state.sort.s);
    markSorted('s-table', state.sort.s);
    const tbody = $('s-table').tBodies[0];
    if (!rows.length) return emptyRow(tbody, 11, state.students.length ? '沒有符合條件的學生' : '還沒有學生名單，請到「匯入名單／題庫」匯入');
    const frag = document.createDocumentFragment();
    for (const s of rows) {
      const tr = document.createElement('tr');
      tr.className = `clickable${s.active ? '' : ' inactive'}`;
      tr.tabIndex = 0;
      tr.append(td(s.className), td(s.seatNo ?? '', 'num'), td(s.studentId), td(s.active ? s.name : `${s.name}（停用）`),
        td(s.plays ? s.bestScore.toLocaleString() : '—', 'num'), td(s.bestGrade || '—', 'grade-cell'), td(s.plays, 'num'),
        td(fmtPct(s.accuracy), `num ${accClass(s.accuracy)}`), td(s.answered, 'num'), td(fmtSec(s.avgSeconds), 'num'), td(fmtTime(s.lastPlayed)));
      const open = () => openStudent(s);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      frag.append(tr);
    }
    tbody.replaceChildren(frag);
  }

  async function openStudent(s) {
    $('s-dialog-title').textContent = `${s.className} ${s.name}（${s.studentId}）`;
    const tbody = $('s-dialog-body');
    emptyRow(tbody, 7, '載入中…');
    $('s-dialog').showModal();
    try {
      const { sessions } = await api(`/api/admin/students/${encodeURIComponent(s.studentId)}/sessions`);
      if (!sessions.length) return emptyRow(tbody, 7, '這位學生還沒有玩過');
      const best = Math.max(...sessions.map((x) => x.score));
      tbody.replaceChildren(...sessions.map((x) => {
        const tr = document.createElement('tr');
        const mark = document.createElement('span');
        if (x.score === best) { mark.className = 'badge-new'; mark.textContent = '最高分'; }
        tr.append(td(fmtTime(x.finishedAt)), td(x.score.toLocaleString(), 'num'), td(`${x.correct}／${x.answered}`, 'num'),
          td(fmtPct(x.accuracy), `num ${accClass(x.accuracy)}`), td(x.maxCombo, 'num'), td(fmtSec(x.avgSeconds), 'num'), td(mark));
        return tr;
      }));
    } catch (e) {
      emptyRow(tbody, 7, e.message);
    }
  }

  // ── 題目 ─────────────────────────────────────────
  function renderQuestions() {
    const q = $('q-search').value.trim().toLowerCase();
    const hardOnly = $('q-hard').checked;
    let rows = state.questions.filter((x) => (!hardOnly || (x.accuracy != null && x.accuracy < 0.6)) && (!q || x.code.toLowerCase().includes(q) || x.text.toLowerCase().includes(q)));
    rows = sortRows(rows, state.sort.q);
    markSorted('q-table', state.sort.q);
    const tbody = $('q-table').tBodies[0];
    if (!rows.length) return emptyRow(tbody, 7, state.questions.length ? '沒有符合條件的題目' : '題庫是空的，請到「匯入名單／題庫」匯入');
    const frag = document.createDocumentFragment();
    for (const x of rows) {
      const tr = document.createElement('tr');
      if (!x.active) tr.className = 'inactive';
      tr.append(td(x.code), td(x.active ? x.text : `（停用）${x.text}`, 'wrap'), td(tag(x.answer)), td(x.difficulty, 'num'),
        td(x.attempts, 'num'), td(fmtPct(x.accuracy), `num ${accClass(x.accuracy)}`), td(fmtSec(x.avgSeconds), 'num'));
      frag.append(tr);
    }
    tbody.replaceChildren(frag);
  }

  // ── 載入 ─────────────────────────────────────────
  async function loadAll() {
    try {
      const [ov, st, qu] = await Promise.all([api(`/api/admin/overview${qs()}`), api(`/api/admin/students${qs()}`), api(`/api/admin/questions${qs()}`)]);
      const sel = $('a-class');
      sel.replaceChildren(new Option('全部班級', ''), ...ov.classes.map((c) => new Option(c, c)));
      sel.value = ov.classes.includes(state.cls) ? state.cls : '';
      document.querySelectorAll('#a-overview dd').forEach((dd) => { dd.textContent = Number(ov[dd.dataset.k] || 0).toLocaleString(); });
      state.students = st.students;
      state.questions = qu.questions;
      renderStudents();
      renderQuestions();
      updateExportLinks();
    } catch (e) {
      toast(e.message);
    }
  }

  function updateExportLinks() {
    document.querySelectorAll('.a-exp').forEach((a) => {
      const kind = a.dataset.exp;
      const scoped = !['students-list', 'questions'].includes(kind);
      a.href = `/api/admin/export/${kind}.csv${scoped ? qs() : ''}`;
    });
  }

  // ── 匯入 ─────────────────────────────────────────
  async function readCsvFile(file) {
    const buf = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      return new TextDecoder('big5').decode(buf); // Excel 預設存成 Big5 的 CSV
    }
  }

  function showImportResult(box, r) {
    box.className = `imp-result ${r.ok ? 'ok' : 'fail'}`;
    box.replaceChildren();
    const head = document.createElement('b');
    if (r.ok) {
      head.textContent = `匯入成功：共 ${r.total} 筆，新增 ${r.inserted}、更新 ${r.updated}${r.deactivated ? `、停用 ${r.deactivated}` : ''}`;
    } else {
      head.textContent = '沒有匯入任何資料，請修正下列問題後重新上傳';
    }
    box.append(head);
    if (r.byAnswer) {
      const p = document.createElement('div');
      p.textContent = `答案分布：權利 ${r.byAnswer['權利']}、權力 ${r.byAnswer['權力']}；難度 1／2／3：${r.byDifficulty[1]}／${r.byDifficulty[2]}／${r.byDifficulty[3]}`;
      box.append(p);
    }
    const items = [...(r.errors || []).map((t) => ['err', t]), ...(r.warnings || []).map((t) => ['warn', t])];
    if (items.length) {
      const ul = document.createElement('ul');
      for (const [c, t] of items) { const li = document.createElement('li'); li.className = c; li.textContent = t; ul.append(li); }
      box.append(ul);
    }
  }

  function bindImport(formId, url) {
    const form = $(formId);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const file = form.querySelector('input[type=file]').files[0];
      const box = form.querySelector('.imp-result');
      const btn = form.querySelector('button[type=submit]');
      if (!file) return;
      btn.disabled = true;
      try {
        const csv = await readCsvFile(file);
        const r = await api(url, { csv, deactivateMissing: form.elements.deactivateMissing.checked });
        showImportResult(box, r);
        if (r.ok) { form.reset(); if (formId === 'imp-questions') form.elements.deactivateMissing.checked = true; loadAll(); }
      } catch (e) {
        showImportResult(box, { ok: false, errors: [e.message] });
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── 登入／分頁 ───────────────────────────────────
  function showLogin() { show('a-login'); $('a-password').focus(); }

  $('a-login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('a-login-error').textContent = '';
    try {
      await api('/api/admin/login', { password: $('a-password').value });
      $('a-password').value = '';
      show('a-main');
      loadAll();
    } catch (e) {
      $('a-login-error').textContent = e.message;
    }
  });
  $('a-logout').addEventListener('click', async () => { try { await api('/api/admin/logout', {}); } catch { /* ignore */ } showLogin(); });
  $('a-class').addEventListener('change', (e) => { state.cls = e.target.value; loadAll(); });
  document.querySelectorAll('.a-tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.a-tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('.a-tab').forEach((t) => { t.hidden = t.id !== `tab-${b.dataset.tab}`; });
  }));
  $('s-search').addEventListener('input', renderStudents);
  $('s-played').addEventListener('change', renderStudents);
  $('q-search').addEventListener('input', renderQuestions);
  $('q-hard').addEventListener('change', renderQuestions);
  bindSort('s-table', 's', renderStudents);
  bindSort('q-table', 'q', renderQuestions);
  bindImport('imp-students', '/api/admin/import/students');
  bindImport('imp-questions', '/api/admin/import/questions');

  (async () => {
    try {
      const me = await api('/api/admin/me');
      if (!me.enabled) {
        showLogin();
        $('a-login-error').textContent = '後台尚未啟用：請在伺服器設定 ADMIN_PASSWORD（至少 8 個字元）後重新啟動';
        return;
      }
      if (me.authed) { show('a-main'); loadAll(); } else showLogin();
    } catch (e) {
      showLogin();
      $('a-login-error').textContent = e.message;
    }
  })();
})();
