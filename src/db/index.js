'use strict';
/**
 * Thin wrapper over Node's built-in `node:sqlite` (Node 20.16+/22+).
 * No native module to compile — the repo installs cleanly anywhere.
 *
 * Exposes a small better-sqlite3-shaped API:
 *   db.exec(sql)
 *   db.prepare(sql).run(...) / .get(...) / .all(...)
 *   db.transaction(fn)()
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

/** Named params used in a statement, so extra object keys are harmless. */
const namesIn = (sql) => [...new Set([...sql.matchAll(/[@:$]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];

function bindArgs(sql, args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && !Buffer.isBuffer(args[0])) {
    const wanted = namesIn(sql);
    const out = {};
    for (const k of wanted) out[k] = coerce(args[0][k]);
    return [out];
  }
  return args.map(coerce);
}

function wrapStatement(sql) {
  const stmt = raw.prepare(sql);
  if (typeof stmt.setAllowBareNamedParameters === 'function') stmt.setAllowBareNamedParameters(true);
  const norm = (r) => {
    if (!r) return r;
    for (const k of Object.keys(r)) if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
    return r;
  };
  return {
    run: (...a) => {
      const res = stmt.run(...bindArgs(sql, a));
      return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
    },
    get: (...a) => norm(stmt.get(...bindArgs(sql, a))),
    all: (...a) => stmt.all(...bindArgs(sql, a)).map(norm),
  };
}

const db = {
  raw,
  exec: (sql) => raw.exec(sql),
  prepare: (sql) => wrapStatement(sql),
  transaction(fn) {
    return (...args) => {
      raw.exec('BEGIN');
      try {
        const out = fn(...args);
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        try { raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    };
  },
};

function migrate() {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

module.exports = { db, migrate, file };
