'use strict';
const path = require('node:path');
const { HttpError } = require('./errors');
const { createGame } = require('./game');
const { createAdmin } = require('./admin');
const { createAdminAuth } = require('./admin-auth');
const { importStudents, importQuestions } = require('./importers');
const { toCsv } = require('./csv');
const http = require('./http');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ db, config, adminPassword, trustProxy = false, cookieSecure = false, now = Date.now, rnd = Math.random }) {
  const game = createGame({ db, config, now, rnd });
  const admin = createAdmin({ db, config });
  const auth = createAdminAuth({ password: adminPassword, config, clock: now, cookieSecure });
  const loginLimiter = http.createLimiter(60 * 1000, config.limits.loginPerMinutePerIp, now);

  const clientIp = (req) => {
    if (trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  // 後台 GET 以外的請求，必須帶自訂標頭（簡單的 CSRF 防護；Cookie 另有 SameSite=Strict）
  const requireXhr = (req) => {
    if (req.headers['x-requested-with'] !== 'rp-admin') throw new HttpError(403, '請求不合法', 'FORBIDDEN');
  };

  const templates = {
    students: toCsv(['學號', '姓名', '班級', '座號'], [['70101', '王小明', '701', '1'], ['70102', '李小華', '701', '2']]),
    questions: toCsv(['題號', '題目', '答案', '難度', '類別', '解析'],
      [['Q001', '法律所保障、人民可以主張的利益或自由，稱為＿＿。', '權利', 1, '定義辨識', '權利是法律保障人民可以主張的利益。']]),
  };

  // routes: [method, pattern, handler, { admin: bool }]
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
  route('POST', '/api/admin/login', ({ req, body, ip, res }) => {
    requireXhr(req);
    const { setCookie } = auth.login(String(body.password ?? ''), ip);
    res.setHeader('Set-Cookie', setCookie);
    return { ok: true };
  });
  route('POST', '/api/admin/logout', ({ req, cookies, res }) => {
    requireXhr(req);
    res.setHeader('Set-Cookie', auth.logout(cookies));
    return { ok: true };
  });
  route('GET', '/api/admin/me', ({ cookies }) => ({ authed: auth.isAuthed(cookies), enabled: auth.enabled }));

  route('GET', '/api/admin/overview', ({ query }) => { game.sweepExpired(); return { ...admin.overview(query.get('class')), classes: admin.classes() }; }, { admin: true });
  route('GET', '/api/admin/students', ({ query }) => { game.sweepExpired(); return { students: admin.students(query.get('class')) }; }, { admin: true });
  route('GET', '/api/admin/students/([^/]+)/sessions', ({ params }) => ({ sessions: admin.studentSessions(decodeURIComponent(params[0])) }), { admin: true });
  route('GET', '/api/admin/questions', ({ query }) => ({ questions: admin.questions(query.get('class')) }), { admin: true });
  route('GET', '/api/admin/config', () => ({ config, timezone: config.timezone }), { admin: true });
  route('POST', '/api/admin/import/students', ({ req, body }) => {
    requireXhr(req);
    return importStudents(db, String(body.csv ?? ''), { deactivateMissing: !!body.deactivateMissing, now: now() });
  }, { admin: true, bodyLimit: 2 * 1024 * 1024 });
  route('POST', '/api/admin/import/questions', ({ req, body }) => {
    requireXhr(req);
    return importQuestions(db, String(body.csv ?? ''), { deactivateMissing: body.deactivateMissing !== false, now: now() });
  }, { admin: true, bodyLimit: 2 * 1024 * 1024 });
  route('GET', '/api/admin/template/(students|questions)\\.csv', ({ params, res }) => {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${params[0]}-template.csv"`,
    });
    res.end(templates[params[0]]);
    return http; // 已自行回應
  }, { admin: true, raw: true });
  route('GET', '/api/admin/export/([a-z-]+)\\.csv', ({ params, query, res }) => {
    if (admin.exportCsv(params[0], query.get('class'), res) === false) throw new HttpError(404, '沒有這種匯出', 'NOT_FOUND');
    return http;
  }, { admin: true, raw: true });

  async function handler(req, res) {
    http.applySecurityHeaders(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        if ((req.method === 'GET' || req.method === 'HEAD') && http.serveStatic(req, res, PUBLIC_DIR)) return;
        throw new HttpError(404, '找不到頁面', 'NOT_FOUND');
      }
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
      const cookies = http.parseCookies(req.headers.cookie);
      if (matched.admin && !auth.isAuthed(cookies)) throw new HttpError(401, '請先登入教師後台', 'UNAUTHORIZED');
      const body = req.method === 'POST' ? await http.readJson(req, matched.bodyLimit) : {};
      const out = matched.handler({ req, res, body, params, cookies, query: url.searchParams, ip: clientIp(req) });
      if (matched.raw) return;
      http.sendJson(res, 200, out);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        http.sendJson(res, err.status, { error: err.message, code: err.code, ...err.extra });
      } else {
        console.error('[error]', err);
        http.sendJson(res, 500, { error: '伺服器發生問題，請稍後再試', code: 'INTERNAL' });
      }
    }
  }

  function sweep() {
    game.sweepExpired();
    auth.sweep();
    loginLimiter.sweep();
  }

  return { handler, sweep, game, auth };
}

module.exports = { createApp };
