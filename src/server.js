'use strict';
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const { migrate } = require('./db');
const { createApp } = require('./lib/http');
const basicAuth = require('./middleware/auth');
const webhook = require('./routes/webhook');
const api = require('./routes/api');
const scheduler = require('./jobs/scheduler');
const T = require('./services/tasks');

migrate();

const app = createApp();
app.staticDir = path.join(__dirname, '..', 'public');

app.use(basicAuth);

app.get('/health', (req, res) =>
  res.json({ ok: true, tz: config.tz, dryRun: config.dryRun, date: T.today() }));

webhook.register(app, '/webhook/whatsapp');
api.register(app, '/api');

if (require.main === module) {
  T.materializeRuns();
  app.listen(config.port, () => {
    logger.info({ port: config.port, tz: config.tz, dryRun: config.dryRun }, 'QCMS task bot listening');
    if (config.dryRun) logger.warn('DRY_RUN is on — WhatsApp messages are logged, not sent');
    scheduler.start();
  });
}

module.exports = app;
