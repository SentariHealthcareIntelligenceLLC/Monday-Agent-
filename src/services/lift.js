'use strict';
/** The "daily lift" — a rotating morale item appended to the morning push. */
const { db } = require('../db');
const settings = require('./settings');

const all = () => db.all('SELECT * FROM lift_items WHERE active = 1 ORDER BY category, id');

const categories = async () => {
  const rows = await db.all(
    'SELECT DISTINCT category FROM lift_items WHERE active = 1 ORDER BY category');
  return rows.map((r) => r.category);
};

const create = async (i) => (await db.one(
  'INSERT INTO lift_items (category, body) VALUES ($1, $2) RETURNING id',
  [i.category, i.body]
)).id;

const remove = (id) => db.run('UPDATE lift_items SET active = 0 WHERE id = $1', [id]);

/**
 * Pick the item for a date. Deterministic on the date so everyone receiving
 * the morning push that day sees the same one, and it advances daily.
 */
async function pick(isoDate) {
  const cfg = await settings.get('lift');
  if (!cfg || cfg.enabled === false) return null;

  const wanted = new Set(cfg.categories || []);
  const pool = (await all()).filter((i) => !wanted.size || wanted.has(i.category));
  if (!pool.length) return null;

  const seed = Number(String(isoDate).replace(/-/g, ''));
  return pool[seed % pool.length];
}

module.exports = { all, categories, create, remove, pick };
