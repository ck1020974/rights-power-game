'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '傳送的資料太大', 'TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 16 * 1024) {
  const text = await readBody(req, limit);
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, '資料格式不正確', 'BAD_JSON');
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function serveStatic(req, res, root) {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return false;
  }
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

// 簡單的固定視窗限流（記憶體內）
function createLimiter(windowMs, max, clock = Date.now) {
  const hits = new Map();
  return {
    // 回傳 true 代表「已超過上限」
    hit(key) {
      const t = clock();
      const rec = hits.get(key);
      if (!rec || t - rec.start >= windowMs) {
        hits.set(key, { start: t, n: 1 });
        return false;
      }
      rec.n++;
      return rec.n > max;
    },
    blocked(key) {
      const rec = hits.get(key);
      return !!rec && clock() - rec.start < windowMs && rec.n >= max;
    },
    reset(key) {
      hits.delete(key);
    },
    sweep() {
      const t = clock();
      for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    },
  };
}

module.exports = { applySecurityHeaders, sendJson, readBody, readJson, parseCookies, serveStatic, createLimiter };
