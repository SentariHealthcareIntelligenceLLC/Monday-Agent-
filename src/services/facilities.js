'use strict';
/** Facilities and the saved multi-facility views the dashboard switches between. */
const { db } = require('../db');

const parseRooms = (f) => ({ ...f, rooms: JSON.parse(f.rooms || '[]') });

const all = async () =>
  (await db.all('SELECT * FROM facilities WHERE active = 1 ORDER BY group_name, name')).map(parseRooms);

const byId = async (id) => {
  const f = await db.one('SELECT * FROM facilities WHERE id = $1', [id]);
  return f ? parseRooms(f) : undefined;
};

const byCode = async (code) => {
  const f = await db.one('SELECT * FROM facilities WHERE code = $1', [code]);
  return f ? parseRooms(f) : undefined;
};

const create = async (f) => (await db.one(
  `INSERT INTO facilities (code, name, kind, group_name, rooms)
   VALUES ($1, $2, $3, $4, $5) RETURNING id`,
  [f.code, f.name, f.kind || null, f.group_name || null, JSON.stringify(f.rooms || [])]
)).id;

const UPDATABLE = ['code', 'name', 'kind', 'group_name', 'active'];

async function update(id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.includes(k));
  if (patch.rooms) {
    await db.run('UPDATE facilities SET rooms = $1 WHERE id = $2',
      [JSON.stringify(patch.rooms), id]);
  }
  if (!keys.length) return 0;
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  return db.run(`UPDATE facilities SET ${sets} WHERE id = $${keys.length + 1}`,
    [...keys.map((k) => patch[k]), id]);
}

const deactivate = (id) => db.run('UPDATE facilities SET active = 0 WHERE id = $1', [id]);

// ---- saved views ----

const views = async () =>
  (await db.all('SELECT * FROM facility_views ORDER BY sort_order, id'))
    .map((v) => ({ ...v, facility_ids: JSON.parse(v.facility_ids || '[]') }));

const createView = async (v) => (await db.one(
  `INSERT INTO facility_views (code, name, facility_ids, sort_order)
   VALUES ($1, $2, $3, $4) RETURNING id`,
  [v.code, v.name, JSON.stringify(v.facility_ids || []), v.sort_order || 0]
)).id;

/**
 * Resolve a scope token from the dashboard into concrete facility ids.
 * 'ALL' or a view code with an empty list means every active facility.
 */
async function resolveScope(token) {
  const facilities = await all();
  const everything = facilities.map((f) => f.id);
  if (!token || token === 'ALL') return everything;

  const view = (await views()).find((v) => v.code === token);
  if (view) return view.facility_ids.length ? view.facility_ids.map(Number) : everything;

  const one = /^\d+$/.test(String(token)) ? await byId(Number(token)) : await byCode(token);
  return one ? [one.id] : everything;
}

module.exports = {
  all, byId, byCode, create, update, deactivate, views, createView, resolveScope,
};
