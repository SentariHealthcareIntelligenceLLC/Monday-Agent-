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
const cron = require('./routes/cron');
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

  return app;
}

module.exports = { buildApp };
