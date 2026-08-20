'use strict';
/**
 * PostgreSQL / Supabase backend (Vercel, production).
 *
 * Uses `pg` directly rather than @supabase/supabase-js so the SQL in
 * services/ is shared verbatim with the SQLite backend.
 *
 * Connection notes for serverless:
 *  - Point DATABASE_URL at Supabase's *transaction pooler* (port 6543).
 *    Direct connections (5432) exhaust Postgres' connection slots when many
 *    lambdas start at once.
 *  - Keep the pool tiny; each lambda instance gets its own.
 *  - The pool is cached on globalThis so warm invocations reuse it.
 */
const { Pool, types } = require('pg');
const config = require('../config');

// int8/numeric arrive as strings by default; the app expects numbers.
types.setTypeParser(20, (v) => Number(v));   // int8
types.setTypeParser(1700, (v) => Number(v)); // numeric

const KEY = '__qcms_pg_pool__';

function pool() {
  if (!globalThis[KEY]) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is not set — required for the postgres backend');
    }
    globalThis[KEY] = new Pool({
      connectionString: config.databaseUrl,
      max: Number(process.env.PG_POOL_MAX || 1),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      // Supabase terminates TLS with its own CA; verification is off for the
      // pooler hostname the same way `psql sslmode=require` behaves.
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
    });
  }
  return globalThis[KEY];
}

/** Booleans/objects/Dates -> what the driver expects, matching sqlite.js. */
function coerce(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    return JSON.stringify(v);
  }
  return v;
}

async function query(sql, params = [], client = null) {
  const runner = client || pool();
  const res = await runner.query(sql, params.map(coerce));
  return { rows: res.rows, rowCount: res.rowCount };
}

const exec = async (sql) => { await pool().query(sql); };

/** Real transaction on a single checked-out connection. */
async function tx(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn({
      query: (sql, params) => query(sql, params, client),
      exec: (sql) => client.query(sql),
    });
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

async function migrate() {
  const fs = require('fs');
  const path = require('path');
  await exec(fs.readFileSync(path.join(__dirname, 'schema.pg.sql'), 'utf8'));
}

async function close() {
  if (globalThis[KEY]) {
    await globalThis[KEY].end();
    globalThis[KEY] = null;
  }
}

module.exports = { query, exec, tx, migrate, close, kind: 'postgres', target: 'supabase' };
