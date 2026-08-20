'use strict';
const cron = require('../lib/cron');
const config = require('../config');
const logger = require('../logger');
const {
  sendDailyReminders, sendNudges, runEscalations, credentialAlerts, clockDigest,
} = require('./reminders');
const T = require('../services/tasks');

function start() {
  const jobs = [];
  const add = (name, expr, fn) => {
    if (!cron.validate(expr)) {
      logger.error({ name, expr }, 'Invalid cron expression; job not scheduled');
      return;
    }
    jobs.push(cron.schedule(expr, async () => {
      logger.info({ job: name }, 'Job start');
      try { await fn(); } catch (err) { logger.error({ err: String(err), job: name }, 'Job failed'); }
    }, { tz: config.tz }));
    logger.info({ job: name, expr, tz: config.tz }, 'Job scheduled');
  };

  // Weekly and monthly tasks are included in the daily push on the day they fall due.
  add('materialize', '5 0 * * *', async () => T.materializeRuns());
  add('daily-reminders', config.cron.daily, sendDailyReminders);
  add('midday-nudge', config.cron.midday, sendNudges);
  add('escalation', config.cron.escalation, runEscalations);
  add('credentials', config.cron.credentials, credentialAlerts);
  add('clock-digest', config.cron.digest, clockDigest);

  return { jobs, stop: () => jobs.forEach((j) => j.stop()) };
}

module.exports = { start };
