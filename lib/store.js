'use strict';
// 資料庫介面：同一套程式可以接 Cloudflare D1，也可以接 Node.js 內建 SQLite。
// 所有方法都是 async：
//   all(sql, ...params)   → 多列
//   first(sql, ...params) → 一列或 null
//   run(sql, ...params)   → { changes }
//   batch([[sql, params], ...]) → 全部成功或全部復原（交易）

function schemaStatements(schemaSql) {
  return schemaSql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function d1Store(d1) {
  const prep = (sql, params) => d1.prepare(sql).bind(...params.map((v) => (v === undefined ? null : v)));
  return {
    kind: 'd1',
    async all(sql, ...p) {
      return (await prep(sql, p).all()).results || [];
    },
    async first(sql, ...p) {
      return (await prep(sql, p).first()) ?? null;
    },
    async run(sql, ...p) {
      const r = await prep(sql, p).run();
      return { changes: r.meta?.changes ?? 0, rowsWritten: r.meta?.rows_written };
    },
    async batch(list) {
      if (!list.length) return [];
      const rs = await d1.batch(list.map(([sql, params = []]) => prep(sql, params)));
      return rs.map((r) => ({ changes: r.meta?.changes ?? 0, rowsWritten: r.meta?.rows_written }));
    },
    async migrate(schemaSql) {
      await d1.batch(schemaStatements(schemaSql).map((s) => d1.prepare(s)));
    },
  };
}

// node:sqlite 的 DatabaseSync
function sqliteStore(db) {
  const cache = new Map();
  const prep = (sql) => {
    let st = cache.get(sql);
    if (!st) {
      st = db.prepare(sql);
      cache.set(sql, st);
    }
    return st;
  };
  const norm = (p) => p.map((v) => (v === undefined ? null : v));
  return {
    kind: 'sqlite',
    raw: db,
    async all(sql, ...p) {
      return prep(sql).all(...norm(p));
    },
    async first(sql, ...p) {
      return prep(sql).get(...norm(p)) ?? null;
    },
    async run(sql, ...p) {
      return { changes: Number(prep(sql).run(...norm(p)).changes) };
    },
    async batch(list) {
      if (!list.length) return [];
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = list.map(([sql, params = []]) => ({ changes: Number(prep(sql).run(...norm(params)).changes) }));
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    },
    async migrate(schemaSql) {
      for (const s of schemaStatements(schemaSql)) db.exec(s);
    },
  };
}

module.exports = { d1Store, sqliteStore, schemaStatements };
