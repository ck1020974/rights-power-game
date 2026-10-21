'use strict';
// API 路由：使用網頁標準的 Request / Response，Cloudflare Worker 與本機測試共用。
const { HttpError } = require('./errors');
const { createGame } = require('./game');
const { createAdmin } = require('./admin');
const { createAdminAuth } = require('./admin-auth');
const { createLimiter } = require('./limiter');
const { importStudents, importQuestions } = require('./importers');
const { toCsv } = require('./csv');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function json(status, obj, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra } });
}
function csv(filename, body) {
  return new Response('﻿' + body.replace(/^﻿/, ''), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      ...SECURITY_HEADERS,
    },
  });
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
async function readJson(request, limit) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > limit) throw new HttpError(413, '傳送的資料太大', 'TOO_LARGE');
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, '傳送的資料太大', 'TOO_LARGE');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, '資料格式不正確', 'BAD_JSON');
  }
}

function createApp({ store, config, adminPassword, now = Date.now, rnd = Math.random }) {
  const game = createGame({ store, config, now, rnd });
  const admin = createAdmin({ store, config });
  const auth = createAdminAuth({ password: adminPassword, config, clock: now });
  const loginLimiter = createLimiter(60 * 1000, config.limits.loginPerMinutePerIp, now);

  const requireXhr = (req) => {
    if (req.headers.get('x-requested-with') !== 'rp-admin') throw new HttpError(403, '請求不合法', 'FORBIDDEN');
  };
  const templates = {
    students: toCsv(['學號', '姓名', '班級', '座號'], [['70101', '王小明', '701', '1'], ['70102', '李小華', '701', '2']]),
    questions: toCsv(['題號', '題目', '答案', '難度', '類別', '解析'],
      [['Q001', '警察對闖紅燈的騎士開罰單。', '權力', 1, '基本辨識', '依法處罰違規，是警察的公權力。']]),
  };

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler, ...opts });

  // ── 學生端 ────────────────────────────────────────
  route('GET', '/api/config', () => game.publicConfig());
  route('POST', '/api/login', ({ body, ip }) => {
    if (loginLimiter.hit(ip)) throw new HttpError(429, '嘗試太多次了，請稍等一分鐘再試', 'RATE_LIMIT');
    return game.login(body.studentId);
  });
  route('POST', '/api/game/start', ({ body, ip }) => {
    if (loginLimiter.hit(ip)) throw new HttpError(429, '嘗試太多次了，請稍等一分鐘再試', 'RATE_LIMIT');
    return game.start(body.studentId);
  });
  route('POST', '/api/game/resume', ({ body }) => game.resume(body.sessionId));
  route('POST', '/api/game/answer', ({ body }) => game.answer(body));
  route('POST', '/api/game/finish', ({ body }) => game.finish(body.sessionId));
  route('GET', '/api/leaderboard', ({ query }) => game.leaderboard(query.get('class')));

  // ── 教師後台 ──────────────────────────────────────
  route('POST', '/api/admin/login', async ({ req, body, ip, secure, headers }) => {
    requireXhr(req);
    headers['Set-Cookie'] = await auth.login(String(body.password ?? ''), ip, secure);
    return { ok: true };
  });
  route('POST', '/api/admin/logout', ({ req, secure, headers }) => {
    requireXhr(req);
    headers['Set-Cookie'] = auth.logout(secure);
    return { ok: true };
  });
  route('GET', '/api/admin/me', async ({ cookies }) => ({ authed: await auth.isAuthed(cookies), enabled: auth.enabled }));
  route('GET', '/api/admin/overview', async ({ query }) => {
    await game.sweepExpired();
    return { ...(await admin.overview(query.get('class'))), classes: await admin.classes() };
  }, { admin: true });
  route('GET', '/api/admin/students', async ({ query }) => ({ students: await admin.students(query.get('class')) }), { admin: true });
  route('GET', '/api/admin/students/([^/]+)/sessions', async ({ params }) => ({ sessions: await admin.studentSessions(decodeURIComponent(params[0])) }), { admin: true });
  route('GET', '/api/admin/questions', async ({ query }) => ({ questions: await admin.questions(query.get('class')) }), { admin: true });
  route('GET', '/api/admin/answers', ({ query }) => admin.answerPage(query.get('class'), query.get('cursor')), { admin: true });
  route('POST', '/api/admin/import/students', ({ req, body }) => {
    requireXhr(req);
    return importStudents(store, String(body.csv ?? ''), { deactivateMissing: !!body.deactivateMissing, now: now() });
  }, { admin: true, bodyLimit: 2 * 1024 * 1024 });
  route('POST', '/api/admin/import/questions', ({ req, body }) => {
    requireXhr(req);
    return importQuestions(store, String(body.csv ?? ''), { deactivateMissing: body.deactivateMissing !== false, now: now() });
  }, { admin: true, bodyLimit: 2 * 1024 * 1024 });
  route('POST', '/api/admin/reset-scores', ({ req, body }) => {
    requireXhr(req);
    if (body.confirm !== '確認清除') throw new HttpError(400, '請輸入「確認清除」', 'CONFIRM');
    return admin.resetScores();
  }, { admin: true });
  route('GET', '/api/admin/template/(students|questions)\\.csv', ({ params }) => csv(`${params[0]}-template.csv`, templates[params[0]]), { admin: true });
  route('GET', '/api/admin/export/([a-z-]+)\\.csv', async ({ params, query }) => {
    const out = await admin.exportCsv(params[0], query.get('class'));
    if (!out) throw new HttpError(404, '沒有這種匯出', 'NOT_FOUND');
    return csv(out.filename, out.body);
  }, { admin: true });

  // 回傳 Response；不是 /api/ 開頭的路徑回傳 null（交給靜態檔案）
  async function handle(req, { ip = 'unknown' } = {}) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return null;
    try {
      let matched = null;
      let params = [];
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method === req.method) {
          matched = r;
          params = m.slice(1);
          break;
        }
      }
      if (!matched) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? '不支援的請求方式' : '找不到這個 API', 'NOT_FOUND');
      const cookies = parseCookies(req.headers.get('cookie'));
      if (matched.admin && !(await auth.isAuthed(cookies))) throw new HttpError(401, '請先登入教師後台', 'UNAUTHORIZED');
      const body = req.method === 'POST' ? await readJson(req, matched.bodyLimit || 16 * 1024) : {};
      const headers = {};
      const out = await matched.handler({ req, body, params, cookies, query: url.searchParams, ip, secure: url.protocol === 'https:', headers });
      return out instanceof Response ? out : json(200, out, headers);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message, code: err.code, ...err.extra });
      console.error('[error]', err && err.stack ? err.stack : err);
      if (/limit|exceeded|quota/i.test(String(err && err.message))) {
        return json(503, { error: '今天的免費使用量已達上限，請明天早上 8 點後再試', code: 'QUOTA' });
      }
      return json(500, { error: '伺服器發生問題，請稍後再試', code: 'INTERNAL' });
    }
  }

  return { handle, game, auth };
}

module.exports = { createApp };
