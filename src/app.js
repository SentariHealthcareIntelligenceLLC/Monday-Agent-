'use strict';
/**
 * Builds the request handler. Shared by both deployment shapes:
 *   src/server.js  -> long-running node/Docker process (listens, runs cron in-process)
 *   api/index.js   -> Vercel serverless function (cron arrives over HTTP)
 *
 * No migrate() at import time: on Vercel the filesystem is read-only and the
 * schema is applied out-of-band via `npm run migrate` against Supabase.
 */
const path = require('path');
const config = require('./config');
const { createApp } = require('./lib/http');
const basicAuth = require('./middleware/auth');
const webhook = require('./routes/webhook');
const api = require('./routes/api');
const admin = require('./routes/admin');
const cron = require('./routes/cron');
const storage = require('./services/storage');
const { db } = require('./db');
const T = require('./services/tasks');

function buildApp() {
  const app = createApp();
  app.staticDir = path.join(__dirname, '..', 'public');

  app.use(basicAuth);

  app.get('/health', (req, res) =>
    res.json({ ok: true, tz: config.tz, dryRun: config.dryRun, db: db.kind, date: T.today() }));

  webhook.register(app, '/webhook/whatsapp');
  cron.register(app, '/api/cron');
  api.register(app, '/api');
  admin.register(app, '/api');

  // Local-disk storage backend serves proof photos from here. On Supabase the
  // dashboard uses signed URLs instead and never hits this route.
  app.get('/uploads/*', (req, res) => {
    const buf = storage.readLocal(req.params.rest || '');
    if (!buf) return res.json({ error: 'not found' }, 404);
    const ext = (req.params.rest.match(/\.[a-z0-9]+$/i) || ['.bin'])[0].toLowerCase();
    const type = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
                   '.heic': 'image/heic' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=300' });
    res.end(buf);
  });

  return app;
}

module.exports = { buildApp };
