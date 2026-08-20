'use strict';
/**
 * SQLite backend (local dev, Docker, tests).
 *
 * Thin wrapper over Node's built-in `node:sqlite` (Node 20.16+/22+) exposing
 * the same *async* interface as the Postgres backend, so service code is
 * written once and runs against either.
 *
 * Portable SQL dialect used by callers (see db/index.js):
 *   now()  -> rewritten to datetime('now') here
 *   ON CONFLICT DO NOTHING / $1 placeholders -> supported natively
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

const file = path.resolve(config.databaseFile);
fs.mkdirSync(path.dirname(file), { recursive: true });

const raw = new DatabaseSync(file);
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

/** node:sqlite only accepts null/number/bigint/string/Buffer. */
function coerce(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}

/** now() is Postgres spelling; SQLite needs datetime('now'). */
const dialect = (sql) => sql.replace(/\bnow\(\)/gi, "datetime('now')");

/** $1,$2,... -> ?,?,... in the same order (node:sqlite takes positional ?). */
const positional = (sql) => sql.replace(/\$(\d+)/g, '?');

/** Order the $n params as they first appear so ? binding lines up. */
function orderParams(sql, params) {
  const seen = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  return seen.map((n) => coerce(params[n - 1]));
}

function normRow(r) {
  if (!r) return r;
  for (const k of Object.keys(r)) if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
  return r;
}

async function query(sql, params = []) {
  const text = positional(dialect(sql));
  const args = orderParams(dialect(sql), params);
  const stmt = raw.prepare(text);
  if (/^\s*(select|.*returning\s)/is.test(text)) {
    const rows = stmt.all(...args).map(normRow);
    return { rows, rowCount: rows.length };
  }
  const res = stmt.run(...args);
  return { rows: [], rowCount: Number(res.changes) };
}

const exec = async (sql) => raw.exec(dialect(sql));

/** Serialized transaction — the SQLite handle is a single connection. */
async function tx(fn) {
  raw.exec('BEGIN');
  try {
    const out = await fn({ query, exec });
    raw.exec('COMMIT');
    return out;
  } catch (err) {
    try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

async function migrate() {
  raw.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

const close = async () => { try { raw.close(); } catch { /* already closed */ } };

module.exports = { query, exec, tx, migrate, close, kind: 'sqlite', target: file };
