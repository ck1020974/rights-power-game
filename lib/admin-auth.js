'use strict';
// 教師後台驗證：單一密碼（Cloudflare 祕密變數 ADMIN_PASSWORD）。
// 登入後發給「有簽章的通行證」Cookie（HttpOnly），8 小時有效；改密碼後舊通行證全部失效。
const { HttpError } = require('./errors');
const { createLimiter } = require('./limiter');

const COOKIE = 'rp_admin';
const TTL_MS = 8 * 60 * 60 * 1000;
const enc = new TextEncoder();

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))));
}
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function createAdminAuth({ password, config, clock = Date.now }) {
  const enabled = typeof password === 'string' && password.length >= 8;
  const failures = createLimiter(config.limits.adminLoginWindowMinutes * 60 * 1000, config.limits.adminLoginFailures, clock);
  let keyPromise = null;
  const key = () => {
    if (!keyPromise) {
      keyPromise = crypto.subtle.importKey('raw', enc.encode(`rights-power-admin:${password}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    }
    return keyPromise;
  };
  const sign = async (msg) => b64url(await crypto.subtle.sign('HMAC', await key(), enc.encode(msg)));

  const attrs = (maxAgeSec, secure) => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;

  async function login(pw, ip, secure) {
    if (!enabled) throw new HttpError(503, '教師後台尚未啟用：請先在 Cloudflare 設定 ADMIN_PASSWORD（至少 8 個字元）', 'ADMIN_DISABLED');
    if (failures.blocked(ip)) throw new HttpError(429, '密碼錯誤次數太多，請稍後再試', 'LOCKED');
    const ok = sameBytes(await sha256(pw), await sha256(password));
    if (!ok) {
      failures.hit(ip);
      throw new HttpError(401, '密碼不正確', 'BAD_PASSWORD');
    }
    failures.reset(ip);
    const exp = String(clock() + TTL_MS);
    const token = `${exp}.${await sign(exp)}`;
    return `${COOKIE}=${token}; ${attrs(TTL_MS / 1000, secure)}`;
  }

  async function isAuthed(cookies) {
    if (!enabled) return false;
    const token = cookies[COOKIE];
    if (!token) return false;
    const [exp, sig] = token.split('.');
    if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < clock()) return false;
    const expected = await sign(exp);
    return sameBytes(enc.encode(sig), enc.encode(expected));
  }

  function logout(secure) {
    return `${COOKIE}=; ${attrs(0, secure)}`;
  }

  return { enabled, login, isAuthed, logout };
}

module.exports = { createAdminAuth };
