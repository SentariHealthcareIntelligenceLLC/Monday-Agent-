'use strict';
/** Admin REST API. Registered onto the tiny router in src/lib/http.js. */
const { db } = require('../db');
const T = require('../services/tasks');
const { addDays } = require('../lib/dates');
const phone = require('../lib/phone');
const storage = require('../services/storage');
const jobs = require('../jobs/reminders');

function register(app, prefix = '/api') {
  const p = (s) => prefix + s;

  // ---- People ----
  app.get(p('/people'), async (req, res) =>
    res.json(await db.all('SELECT * FROM people ORDER BY id')));

  app.post(p('/people'), async (req, res) => {
    const b = { whatsapp_number: null, email: null, site: null, reports_to_id: null, ...req.body };
    if (!b.name || !b.role) return res.json({ error: 'name and role are required' }, 400);
    // Stored in the form Meta sends, so inbound replies match this person.
    if (b.whatsapp_number) {
      const n = phone.normalize(b.whatsapp_number);
      if (!n) return res.json({ error: `not a usable phone number: ${b.whatsapp_number}` }, 400);
      b.whatsapp_number = n;
    }
    const row = await db.one(
      `INSERT INTO people (name, role, whatsapp_number, email, site, reports_to_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [b.name, b.role, b.whatsapp_number, b.email, b.site, b.reports_to_id]
    );
    res.json({ id: row.id }, 201);
  });

  app.patch(p('/people/:id'), async (req, res) => {
    const allowed = ['name', 'role', 'whatsapp_number', 'email', 'site', 'reports_to_id', 'active', 'timezone'];
    const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!keys.length) return res.json({ error: 'no updatable fields' }, 400);
    const body = { ...req.body };
    if (keys.includes('whatsapp_number') && body.whatsapp_number) {
      const n = phone.normalize(body.whatsapp_number);
      if (!n) return res.json({ error: `not a usable phone number: ${body.whatsapp_number}` }, 400);
      body.whatsapp_number = n;
    }
    // Column names come from the allow-list above; values stay parameterized.
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    await db.run(
      `UPDATE people SET ${sets} WHERE id = $${keys.length + 1}`,
      [...keys.map((k) => body[k]), Number(req.params.id)]
    );
    res.json({ ok: true });
  });

  // ---- Tasks ----
  // The standing library of recurring duties. One-off items live at /adhoc so
  // the two never get mixed into the same list.
  app.get(p('/tasks'), async (req, res) => res.json(await T.recurringTasks()));

  app.get(p('/adhoc'), async (req, res) =>
    res.json(await T.adHocTasks(Number(req.query.limit) || 100)));

  /**
   * Raise a new one-off task — the Task board's "+" and the Messages composer
   * both land here. Recurring duties are created through POST /api/tasks.
   */
  app.post(p('/adhoc'), async (req, res) => {
    try {
      res.json(await T.raiseAdHoc(req.body), 201);
    } catch (err) {
      res.json({ error: err.message }, 400);
    }
  });

  app.post(p('/tasks'), async (req, res) => {
    const b = {
      details: null, category: null, weekday: null, day_of_month: null,
      month_of_year: null, lead_days: 0, facility_id: null, requires_photo: 0,
      due_time: '17:00', critical: 0, ...req.body,
    };
    if (!b.title || !b.cadence || !b.assignee_id) {
      return res.json({ error: 'title, cadence and assignee_id are required' }, 400);
    }
    if (b.cadence === 'once') {
      return res.json({ error: 'one-off tasks are raised through POST /api/adhoc' }, 400);
    }
    const CADENCES = ['daily', 'weekly', 'monthly', 'quarterly', 'semiannual', 'yearly'];
    if (!CADENCES.includes(b.cadence)) {
      return res.json({ error: `cadence must be one of: ${CADENCES.join(', ')}` }, 400);
    }
    const row = await db.one(
      `INSERT INTO tasks
        (title, details, category, cadence, weekday, day_of_month, month_of_year,
         lead_days, due_time, assignee_id, facility_id, requires_photo, critical, origin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'library') RETURNING id`,
      [b.title, b.details, b.category, b.cadence, b.weekday, b.day_of_month,
       b.month_of_year ?? null, b.lead_days ?? 0, b.due_time, b.assignee_id,
       b.facility_id ?? null, b.requires_photo ? 1 : 0, b.critical]
    );
    res.json({ id: row.id }, 201);
  });

  app.delete(p('/tasks/:id'), async (req, res) => {
    await db.run('UPDATE tasks SET active = 0 WHERE id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  // ---- Board ----
  app.get(p('/board'), async (req, res) => {
    const date = req.query.date || T.today();
    await T.materializeRuns(date);
    // `window=1` returns everything inside its reminder lead window plus
    // anything still open from earlier — what the dashboard's board shows.
    // Without it the response is strictly that one day's runs.
    if (req.query.window === '1') {
      // Recent history is included so completed work stays visible — a board
      // that drops items the moment they are done can never show a completion
      // rate, and hides the timestamp that is the compliance record.
      const back = Number(req.query.back) || 7;
      const [open, overdue, recent] = await Promise.all([
        T.dueRunsFor(date), T.overdueRuns(date),
        T.runsBetween(addDays(date, -back), date),
      ]);
      const byId = new Map();
      for (const r of [...recent, ...open, ...overdue]) byId.set(r.id, r);
      const runs = [...byId.values()].sort((a, b) =>
        a.due_date.localeCompare(b.due_date) || String(a.due_time).localeCompare(b.due_time));
      return res.json({ date, runs });
    }
    res.json({ date, runs: await T.runsFor(date) });
  });

  app.post(p('/runs/:id/status'), async (req, res) => {
    const { status, note } = req.body;
    if (!['pending', 'done', 'blocked', 'missed', 'snoozed'].includes(status)) {
      return res.json({ error: 'bad status' }, 400);
    }
    await T.markRun(Number(req.params.id), status, note || null);
    res.json({ ok: true });
  });

  // ---- Analysis & manual triggers ----
  app.get(p('/trend'), async (req, res) =>
    res.json(await T.completionTrend(Number(req.query.days) || 7)));

  app.get(p('/gaps'), async (req, res) =>
    res.json(await T.analyzeGaps(Number(req.query.days) || 30)));

  /**
   * The activity thread. Photo proofs are returned as short-lived signed URLs
   * rather than object paths, so the dashboard can render them inline while
   * the bucket stays private.
   */
  app.get(p('/messages'), async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = req.query.person
      ? await db.all(
        'SELECT * FROM messages WHERE person_id = $1 ORDER BY id DESC LIMIT $2',
        [Number(req.query.person), limit])
      : await db.all('SELECT * FROM messages ORDER BY id DESC LIMIT $1', [limit]);

    for (const row of rows) {
      if (row.media_path) row.media_url = await storage.signedUrl(row.media_path);
    }
    res.json(rows);
  });

  app.post(p('/run/:job'), async (req, res) => {
    const map = { reminders: jobs.sendDailyReminders, nudges: jobs.sendNudges, escalations: jobs.runEscalations };
    const fn = map[req.params.job];
    if (!fn) return res.json({ error: 'unknown job' }, 404);
    res.json({ ok: true, result: await fn() });
  });
}

module.exports = { register };
