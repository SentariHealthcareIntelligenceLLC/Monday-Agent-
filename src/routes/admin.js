'use strict';
/**
 * Admin API for the expanded dashboard: facilities, credentialing, scheduling,
 * the time clock, planners (with photo proof), the daily lift, and rules.
 *
 * Registered alongside the original task API in routes/api.js.
 */
const F = require('../services/facilities');
const C = require('../services/credentials');
const S = require('../services/schedule');
const PL = require('../services/planner');
const L = require('../services/lift');
const settings = require('../services/settings');
const storage = require('../services/storage');
const T = require('../services/tasks');
const config = require('../config');
const { partsIn } = require('../lib/dates');

/** Resolve ?facility=<code|id|viewCode|ALL> into facility ids. */
const scopeOf = (req) => F.resolveScope(req.query.facility);

const nowMinutes = (req) => {
  if (req.query.now && /^\d{1,2}:\d{2}$/.test(req.query.now)) {
    const [h, m] = req.query.now.split(':').map(Number);
    return h * 60 + m;
  }
  const p = partsIn(new Date(), config.tz);
  return p.hour * 60 + p.minute;
};

function register(app, prefix = '/api') {
  const p = (s) => prefix + s;

  // ------------------------------------------------------------ facilities
  app.get(p('/facilities'), async (req, res) =>
    res.json({ facilities: await F.all(), views: await F.views() }));

  app.post(p('/facilities'), async (req, res) => {
    const b = req.body;
    if (!b.code || !b.name) return res.json({ error: 'code and name are required' }, 400);
    res.json({ id: await F.create(b) }, 201);
  });

  app.patch(p('/facilities/:id'), async (req, res) => {
    await F.update(Number(req.params.id), req.body);
    res.json({ ok: true });
  });

  app.delete(p('/facilities/:id'), async (req, res) => {
    await F.deactivate(Number(req.params.id));
    res.json({ ok: true });
  });

  app.post(p('/facility-views'), async (req, res) => {
    const b = req.body;
    if (!b.code || !b.name) return res.json({ error: 'code and name are required' }, 400);
    res.json({ id: await F.createView(b) }, 201);
  });

  // --------------------------------------------------------- credentialing
  app.get(p('/credentials'), async (req, res) => {
    const within = req.query.within ? Number(req.query.within) : null;
    res.json(within ? await C.expiring(within) : await C.all());
  });

  app.get(p('/people/:id/credentials'), async (req, res) =>
    res.json(await C.forPerson(Number(req.params.id))));

  app.post(p('/credentials'), async (req, res) => {
    const b = req.body;
    if (!b.person_id || !b.name || !b.expires_on) {
      return res.json({ error: 'person_id, name and expires_on are required' }, 400);
    }
    res.json({ id: await C.create(b) }, 201);
  });

  app.patch(p('/credentials/:id'), async (req, res) => {
    await C.update(Number(req.params.id), req.body);
    res.json({ ok: true });
  });

  app.delete(p('/credentials/:id'), async (req, res) => {
    await C.remove(Number(req.params.id));
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- scheduling
  app.get(p('/shifts'), async (req, res) => {
    const date = req.query.date || T.today();
    const ids = await scopeOf(req);
    res.json({
      week_start: S.weekStart(date),
      shifts: req.query.day === '1' ? await S.forDay(date, ids) : await S.forWeek(date, ids),
    });
  });

  app.post(p('/shifts'), async (req, res) => {
    const b = req.body;
    if (!b.role || !b.work_date) return res.json({ error: 'role and work_date are required' }, 400);
    res.json({ id: await S.createShift(b) }, 201);
  });

  app.patch(p('/shifts/:id'), async (req, res) => {
    await S.assignShift(Number(req.params.id), req.body);
    res.json({ ok: true });
  });

  app.delete(p('/shifts/:id'), async (req, res) => {
    await S.removeShift(Number(req.params.id));
    res.json({ ok: true });
  });

  // ------------------------------------------------------------- time clock
  app.get(p('/clock'), async (req, res) => {
    const date = req.query.date || T.today();
    res.json({
      date,
      now: nowMinutes(req),
      rows: await S.clockBoard(date, nowMinutes(req), await scopeOf(req), await settings.get('clock')),
    });
  });

  app.post(p('/clock/:shiftId/:field'), async (req, res) => {
    try {
      const at = req.body.at || S.clock(nowMinutes(req));
      res.json(await S.punch(Number(req.params.shiftId), req.params.field, at));
    } catch (err) {
      res.json({ error: err.message }, 400);
    }
  });

  // ---------------------------------------------------------------- planner
  app.get(p('/planner/week'), async (req, res) =>
    res.json(await PL.forWeek(req.query.date || T.today(), await scopeOf(req))));

  app.get(p('/planner/month'), async (req, res) => {
    const today = T.today();
    const year = Number(req.query.year) || Number(today.slice(0, 4));
    const month = Number(req.query.month) || Number(today.slice(5, 7));
    res.json(await PL.forMonth(year, month, await scopeOf(req)));
  });

  app.post(p('/planner'), async (req, res) => {
    const b = req.body;
    if (!b.kind || !b.plan_date || !b.title) {
      return res.json({ error: 'kind, plan_date and title are required' }, 400);
    }
    res.json({ id: await PL.create(b) }, 201);
  });

  app.post(p('/planner/:id/done'), async (req, res) => {
    try {
      res.json(await PL.complete(Number(req.params.id), req.body));
    } catch (err) {
      res.json({ error: err.message }, 400);
    }
  });

  app.post(p('/planner/:id/reopen'), async (req, res) => {
    await PL.reopen(Number(req.params.id));
    res.json({ ok: true });
  });

  app.delete(p('/planner/:id'), async (req, res) => {
    await PL.remove(Number(req.params.id));
    res.json({ ok: true });
  });

  /**
   * Photo proof. The raw request body is the image and Content-Type names the
   * format — no multipart parsing, which keeps the dependency count at one.
   */
  const upload = (kind, onStored) => async (req, res) => {
    try {
      const id = Number(req.params.id);
      const key = await storage.put(kind, id, req.rawBody, req.headers['content-type']);
      await onStored(id, key, req);
      res.json({ ok: true, photo_path: key, url: await storage.signedUrl(key) }, 201);
    } catch (err) {
      res.json({ error: err.message }, 400);
    }
  };

  app.post(p('/planner/:id/photo'), upload('planner', async (id, key, req) =>
    PL.complete(id, { done_by: req.query.by || 'dashboard', photo_path: key })));

  app.post(p('/runs/:id/photo'), upload('run', async (id, key) => T.setPhoto(id, key)));

  app.get(p('/photo'), async (req, res) => {
    if (!req.query.path) return res.json({ error: 'path is required' }, 400);
    res.json({ url: await storage.signedUrl(req.query.path) });
  });

  // ------------------------------------------------------------- daily lift
  app.get(p('/lift'), async (req, res) => res.json({
    items: await L.all(),
    categories: await L.categories(),
    settings: await settings.get('lift'),
    today: await L.pick(T.today()),
  }));

  app.post(p('/lift'), async (req, res) => {
    const b = req.body;
    if (!b.category || !b.body) return res.json({ error: 'category and body are required' }, 400);
    res.json({ id: await L.create(b) }, 201);
  });

  app.delete(p('/lift/:id'), async (req, res) => {
    await L.remove(Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- settings
  app.get(p('/settings'), async (req, res) => res.json(await settings.all()));

  app.patch(p('/settings/:key'), async (req, res) => {
    if (!Object.keys(settings.DEFAULTS).includes(req.params.key)) {
      return res.json({ error: 'unknown settings key' }, 404);
    }
    res.json(await settings.patch(req.params.key, req.body));
  });
}

module.exports = { register };
