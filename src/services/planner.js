'use strict';
/**
 * Weekly and monthly planner cells. Some duties require photo proof of
 * completion (a cleaned room, a sealed crash cart); those store an object path
 * in Supabase Storage rather than the image itself.
 */
const { db } = require('../db');
const { addDays } = require('../lib/dates');
const { weekStart } = require('./schedule');

const JOIN = `
  SELECT i.*, p.name AS person_name, p.role, f.name AS facility_name, f.code AS facility_code
  FROM planner_items i
  LEFT JOIN people p ON p.id = i.person_id
  LEFT JOIN facilities f ON f.id = i.facility_id`;

const scopeClause = (facilityIds, from) =>
  (facilityIds && facilityIds.length
    ? ` AND i.facility_id IN (${facilityIds.map((_, n) => `$${from + n}`).join(',')})`
    : '');

async function forWeek(isoDate, facilityIds = null) {
  const start = weekStart(isoDate);
  const end = addDays(start, 6);
  return db.all(
    `${JOIN} WHERE i.kind = 'weekly' AND i.plan_date >= $1 AND i.plan_date <= $2
     ${scopeClause(facilityIds, 3)} ORDER BY i.plan_date, i.title`,
    [start, end, ...(facilityIds || [])]
  );
}

async function forMonth(year, month, facilityIds = null) {
  const mm = String(month).padStart(2, '0');
  return db.all(
    `${JOIN} WHERE i.kind = 'monthly' AND i.plan_date >= $1 AND i.plan_date <= $2
     ${scopeClause(facilityIds, 3)} ORDER BY i.plan_date, i.title`,
    [`${year}-${mm}-01`, `${year}-${mm}-31`, ...(facilityIds || [])]
  );
}

const create = async (i) => (await db.one(
  `INSERT INTO planner_items (kind, person_id, facility_id, plan_date, title, room,
                              frequency, requires_photo)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
  [i.kind, i.person_id || null, i.facility_id || null, i.plan_date, i.title,
   i.room || null, i.frequency || null, i.requires_photo ? 1 : 0]
)).id;

/**
 * Mark a cell complete. Items flagged `requires_photo` refuse to complete
 * without one — that photo is the compliance record, so accepting a bare
 * "done" would quietly defeat the point of the flag.
 */
async function complete(id, { done_by, photo_path = null }) {
  const item = await db.one('SELECT * FROM planner_items WHERE id = $1', [id]);
  if (!item) throw new Error(`no such planner item: ${id}`);
  if (Number(item.requires_photo) === 1 && !photo_path) {
    throw new Error('this item requires a photo before it can be marked done');
  }
  await db.run(
    'UPDATE planner_items SET done_at = now(), done_by = $1, photo_path = $2 WHERE id = $3',
    [done_by || null, photo_path, id]
  );
  return db.one('SELECT * FROM planner_items WHERE id = $1', [id]);
}

const reopen = (id) => db.run(
  'UPDATE planner_items SET done_at = NULL, done_by = NULL, photo_path = NULL WHERE id = $1', [id]
);

const remove = (id) => db.run('DELETE FROM planner_items WHERE id = $1', [id]);

module.exports = { forWeek, forMonth, create, complete, reopen, remove };
