'use strict';
/** Long-running server (local dev, Docker). Vercel uses api/index.js instead. */
const config = require('./config');
const logger = require('./logger');
const { migrate, db } = require('./db');
const { buildApp } = require('./app');
const scheduler = require('./jobs/scheduler');
const T = require('./services/tasks');

const app = buildApp();

async function main() {
  await migrate();
  await T.materializeRuns();
  app.listen(config.port, () => {
    logger.info({ port: config.port, tz: config.tz, dryRun: config.dryRun, db: db.kind },
      'QCMS task bot listening');
    if (config.dryRun) logger.warn('DRY_RUN is on — WhatsApp messages are logged, not sent');
    scheduler.start();
  });
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err: String(err) }, 'Failed to start');
    process.exit(1);
  });
}

module.exports = app;
