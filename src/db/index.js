'use strict';
/**
 * Database facade. Picks a backend from the environment:
 *   DATABASE_URL set  -> PostgreSQL / Supabase  (Vercel, production)
 *   otherwise         -> SQLite file            (local dev, Docker, tests)
 *
 * The interface is async and identical across both:
 *   await db.query(sql, params)  -> { rows, rowCount }
 *   await db.one(sql, params)    -> first row or undefined
 *   await db.all(sql, params)    -> rows
 *   await db.run(sql, params)    -> rowCount
 *   await db.tx(async (t) => ...)
 *
 * Write portable SQL at call sites:
 *   - $1, $2 ... placeholders (never ? or @name)
 *   - now() for the current timestamp
 *   - ON CONFLICT DO NOTHING for idempotent inserts
 *   - RETURNING id to get a new row's id
 */
const config = require('./../config');

const backend = config.databaseUrl
  ? require('./postgres')
  : require('./sqlite');

const db = {
  kind: backend.kind,
  target: backend.target,
  query: (sql, params) => backend.query(sql, params),
  exec: (sql) => backend.exec(sql),
  tx: (fn) => backend.tx(fn),
  close: () => backend.close(),
  async all(sql, params) { return (await backend.query(sql, params)).rows; },
  async one(sql, params) { return (await backend.query(sql, params)).rows[0]; },
  async run(sql, params) { return (await backend.query(sql, params)).rowCount; },
};

const migrate = () => backend.migrate();

module.exports = { db, migrate, backend, file: backend.target };
