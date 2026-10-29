// Cloudflare Worker 入口
//  · /api/*  → 遊戲與教師後台 API（lib/app.js）
//  · 其他路徑 → public/ 裡的網頁（Cloudflare 靜態資源）
import schema from '../schema.sql';
import defaultQuestions from '../samples/questions.csv';
import config from '../lib/load-config.js';
import { d1Store } from '../lib/store.js';
import { createApp } from '../lib/app.js';
import { importQuestions } from '../lib/importers.js';

let app = null;
let ready = null;

export default {
  async fetch(request, env) {
    if (!env.DB) return new Response('尚未設定 D1 資料庫（binding 名稱必須是 DB）', { status: 500 });
    if (!app) {
      const store = d1Store(env.DB);
      app = createApp({ store, config, adminPassword: env.ADMIN_PASSWORD });
      ready = store.migrate(schema).then(async () => {
        // 資料庫裡一題都沒有時，自動載入內建的 200 題（老師之後匯入自己的題庫則以老師的為準）
        const row = await store.first('SELECT COUNT(*) AS n FROM questions');
        if (!row || !row.n) await importQuestions(store, defaultQuestions, { deactivateMissing: false });
      }).catch((err) => {
        ready = null;
        app = null;
        throw err;
      });
    }
    await ready;
    const res = await app.handle(request, { ip: request.headers.get('cf-connecting-ip') || 'unknown' });
    return res || env.ASSETS.fetch(request);
  },
};
