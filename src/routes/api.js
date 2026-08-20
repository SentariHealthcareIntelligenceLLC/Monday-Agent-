'use strict';
/** Admin REST API. Registered onto the tiny router in src/lib/http.js. */
const { db } = require('../db');
const T = require('../services/tasks');
const jobs = require('../jobs/reminders');

function register(app, prefix = '/api') {
  const p = (s) => prefix + s;

  // ---- People ----
  app.get(p('/people'), (req, res) =>
    res.json(db.prepare('SELECT * FROM people ORDER BY id').all()));

  app.post(p('/people'), (req, res) => {
    const b = req.body;
    if (!b.name || !b.role) return res.json({ error: 'name and role are required' }, 400);
    const info = db.prepare(`INSERT INTO people (name, role, whatsapp_number, email, site, reports_to_id)
      VALUES (@name, @role, @whatsapp_number, @email, @site, @reports_to_id)`)
      .run({ whatsapp_number: null, email: null, site: null, reports_to_id: null, ...b });
    res.json({ id: info.lastInsertRowid }, 201);
  });

  app.patch(p('/people/:id'), (req, res) => {
    const allowed = ['name', 'role', 'whatsapp_number', 'email', 'site', 'reports_to_id', 'active', 'timezone'];
    const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!keys.length) return res.json({ error: 'no updatable fields' }, 400);
    db.prepare(`UPDATE people SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
      .run({ ...req.body, id: Number(req.params.id) });
    res.json({ ok: true });
  });

  // ---- Tasks ----
  app.get(p('/tasks'), (req, res) => res.json(db.prepare(`
    SELECT t.*, pe.name AS assignee FROM tasks t JOIN people pe ON pe.id = t.assignee_id
    ORDER BY t.cadence, t.due_time`).all()));

  app.post(p('/tasks'), (req, res) => {
    const b = req.body;
    if (!b.title || !b.cadence || !b.assignee_id) {
      return res.json({ error: 'title, cadence and assignee_id are required' }, 400);
    }
    const info = db.prepare(`INSERT INTO tasks
      (title, details, category, cadence, weekday, day_of_month, due_time, assignee_id, critical)
      VALUES (@title,@details,@category,@cadence,@weekday,@day_of_month,@due_time,@assignee_id,@critical)`)
      .run({ details: null, category: null, weekday: null, day_of_month: null,
             due_time: '17:00', critical: 0, ...b });
    res.json({ id: info.lastInsertRowid }, 201);
  });

  app.delete(p('/tasks/:id'), (req, res) => {
    db.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---- Board ----
  app.get(p('/board'), (req, res) => {
    const date = req.query.date || T.today();
    T.materializeRuns(date);
    res.json({ date, runs: T.runsFor(date) });
  });

  app.post(p('/runs/:id/status'), (req, res) => {
    const { status, note } = req.body;
    if (!['pending', 'done', 'blocked', 'missed', 'snoozed'].includes(status)) {
      return res.json({ error: 'bad status' }, 400);
    }
    T.markRun(Number(req.params.id), status, note || null);
    res.json({ ok: true });
  });

  // ---- Analysis & manual triggers ----
  app.get(p('/gaps'), (req, res) => res.json(T.analyzeGaps(Number(req.query.days) || 30)));

  app.get(p('/messages'), (req, res) =>
    res.json(db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 100').all()));

  app.post(p('/run/:job'), async (req, res) => {
    const map = { reminders: jobs.sendDailyReminders, nudges: jobs.sendNudges, escalations: jobs.runEscalations };
    const fn = map[req.params.job];
    if (!fn) return res.json({ error: 'unknown job' }, 404);
    res.json({ ok: true, result: await fn() });
  });
}

module.exports = { register };
