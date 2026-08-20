'use strict';
/**
 * HTTP entrypoints for the scheduled jobs (Vercel Cron calls these).
 *
 * WHY AN HOURLY TRIGGER + A LOCAL-TIME GATE:
 * Vercel Cron fires in UTC and has no timezone option, so a fixed UTC hour
 * would drift by an hour across DST relative to America/Los_Angeles. Instead
 * vercel.json invokes this every hour and each job checks the *local* hour in
 * config.tz, no-opping when it isn't its turn. Correct year-round, and the
 * schedule stays configurable through the same DAILY_REMINDER_CRON-style env
 * vars the long-running Docker deployment uses.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Requests
 * without it are rejected, so these paths are safe to leave outside Basic auth.
 */
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const { partsIn } = require('../lib/dates');
const T = require('../services/tasks');
const { sendDailyReminders, sendNudges, runEscalations } = require('../jobs/reminders');

/** Hour/minute out of a 5-field cron expression's first two fields. */
function hourMinuteOf(expr) {
  const [min, hour] = String(expr).trim().split(/\s+/);
  const n = (v) => (/^\d+$/.test(v) ? Number(v) : null);
  return { minute: n(min), hour: n(hour) };
}

const JOBS = {
  materialize: { expr: '5 0 * * *', run: () => T.materializeRuns() },
  reminders:   { expr: config.cron.daily,      run: sendDailyReminders },
  nudges:      { expr: config.cron.midday,     run: sendNudges },
  escalations: { expr: config.cron.escalation, run: runEscalations },
};

function authorized(req) {
  if (!config.cronSecret) return config.env !== 'production';
  const got = String(req.headers.authorization || '');
  const want = `Bearer ${config.cronSecret}`;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function register(app, prefix = '/api/cron') {
  app.get(`${prefix}/:job`, async (req, res) => {
    if (!authorized(req)) return res.json({ error: 'unauthorized' }, 401);

    const name = req.params.job;
    const job = JOBS[name];
    if (!job) return res.json({ error: 'unknown job' }, 404);

    const { hour } = hourMinuteOf(job.expr);
    const localHour = partsIn(new Date(), config.tz).hour;
    // `force=1` lets an operator run a job by hand from the dashboard.
    const forced = req.query.force === '1';

    if (!forced && hour !== null && localHour !== hour) {
      return res.json({ ok: true, job: name, skipped: true, localHour, scheduledHour: hour });
    }

    try {
      const result = await job.run();
      logger.info({ job: name, result, localHour }, 'Cron job ran');
      return res.json({ ok: true, job: name, result, localHour });
    } catch (err) {
      logger.error({ job: name, err: String(err) }, 'Cron job failed');
      return res.json({ ok: false, job: name, error: String(err) }, 500);
    }
  });
}

module.exports = { register, JOBS, hourMinuteOf };
