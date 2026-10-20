'use strict';
// 教師後台驗證：單一密碼（環境變數 ADMIN_PASSWORD），登入後發給隨機 token（HttpOnly Cookie）。
const crypto = require('node:crypto');
const { HttpError } = require('./errors');
const { createLimiter } = require('./http');

const COOKIE = 'rp_admin';
const TTL_MS = 8 * 60 * 60 * 1000;

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function createAdminAuth({ password, config, clock = Date.now, cookieSecure = false }) {
  const tokens = new Map(); // token -> 到期時間
  const failures = createLimiter(config.limits.adminLoginWindowMinutes * 60 * 1000, config.limits.adminLoginFailures, clock);
  const enabled = typeof password === 'string' && password.length >= 8;
  const expected = enabled ? sha(password) : null;

  function cookieAttrs(maxAgeSec) {
    return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${cookieSecure ? '; Secure' : ''}`;
  }

  function login(pw, ip) {
    if (!enabled) throw new HttpError(503, '教師後台尚未啟用：請先設定 ADMIN_PASSWORD（至少 8 個字元）後重新啟動伺服器', 'ADMIN_DISABLED');
    if (failures.blocked(ip)) throw new HttpError(429, '密碼錯誤次數太多，請稍後再試', 'LOCKED');
    const ok = crypto.timingSafeEqual(sha(pw), expected);
    if (!ok) {
      failures.hit(ip);
      throw new HttpError(401, '密碼不正確', 'BAD_PASSWORD');
    }
    failures.reset(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    tokens.set(token, clock() + TTL_MS);
    return { token, setCookie: `${COOKIE}=${token}; ${cookieAttrs(TTL_MS / 1000)}` };
  }

  function isAuthed(cookies) {
    const token = cookies[COOKIE];
    if (!token) return false;
    const exp = tokens.get(token);
    if (!exp) return false;
    if (exp < clock()) {
      tokens.delete(token);
      return false;
    }
    return true;
  }

  function logout(cookies) {
    if (cookies[COOKIE]) tokens.delete(cookies[COOKIE]);
    return `${COOKIE}=; ${cookieAttrs(0)}`;
  }

  function sweep() {
    const t = clock();
    for (const [k, v] of tokens) if (v < t) tokens.delete(k);
    failures.sweep();
  }

  return { enabled, login, isAuthed, logout, sweep };
}

module.exports = { createAdminAuth };
