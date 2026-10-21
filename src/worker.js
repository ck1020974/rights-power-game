// Cloudflare Worker 入口
//  · /api/*  → 遊戲與教師後台 API（lib/app.js）
//  · 其他路徑 → public/ 裡的網頁（Cloudflare 靜態資源）
import schema from '../schema.sql';
import config from '../lib/load-config.js';
import { d1Store } from '../lib/store.js';
import { createApp } from '../lib/app.js';

let app = null;
let ready = null;

export default {
  async fetch(request, env) {
    if (!env.DB) return new Response('尚未設定 D1 資料庫（binding 名稱必須是 DB）', { status: 500 });
    if (!app) {
      const store = d1Store(env.DB);
      app = createApp({ store, config, adminPassword: env.ADMIN_PASSWORD });
      ready = store.migrate(schema).catch((err) => {
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
