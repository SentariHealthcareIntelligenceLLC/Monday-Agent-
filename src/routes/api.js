'use strict';
/** Admin REST API. Registered onto the tiny router in src/lib/http.js. */
const { db } = require('../db');
const T = require('../services/tasks');
const jobs = require('../jobs/reminders');

function register(app, prefix = '/api') {
  const p = (s) => prefix + s;

  // ---- People ----
  app.get(p('/people'), async (req, res) =>
    res.json(await db.all('SELECT * FROM people ORDER BY id')));

  app.post(p('/people'), async (req, res) => {
    const b = { whatsapp_number: null, email: null, site: null, reports_to_id: null, ...req.body };
    if (!b.name || !b.role) return res.json({ error: 'name and role are required' }, 400);
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
    // Column names come from the allow-list above; values stay parameterized.
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    await db.run(
      `UPDATE people SET ${sets} WHERE id = $${keys.length + 1}`,
      [...keys.map((k) => req.body[k]), Number(req.params.id)]
    );
    res.json({ ok: true });
  });

  // ---- Tasks ----
  app.get(p('/tasks'), async (req, res) => res.json(await db.all(`
    SELECT t.*, pe.name AS assignee FROM tasks t JOIN people pe ON pe.id = t.assignee_id
    ORDER BY t.cadence, t.due_time`)));

  app.post(p('/tasks'), async (req, res) => {
    const b = {
      details: null, category: null, weekday: null, day_of_month: null,
      due_time: '17:00', critical: 0, ...req.body,
    };
    if (!b.title || !b.cadence || !b.assignee_id) {
      return res.json({ error: 'title, cadence and assignee_id are required' }, 400);
    }
    const row = await db.one(
      `INSERT INTO tasks
        (title, details, category, cadence, weekday, day_of_month, due_time, assignee_id, critical)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [b.title, b.details, b.category, b.cadence, b.weekday, b.day_of_month, b.due_time, b.assignee_id, b.critical]
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
  app.get(p('/gaps'), async (req, res) =>
    res.json(await T.analyzeGaps(Number(req.query.days) || 30)));

  app.get(p('/messages'), async (req, res) =>
    res.json(await db.all('SELECT * FROM messages ORDER BY id DESC LIMIT 100')));

  app.post(p('/run/:job'), async (req, res) => {
    const map = { reminders: jobs.sendDailyReminders, nudges: jobs.sendNudges, escalations: jobs.runEscalations };
    const fn = map[req.params.job];
    if (!fn) return res.json({ error: 'unknown job' }, 404);
    res.json({ ok: true, result: await fn() });
  });
}

module.exports = { register };
