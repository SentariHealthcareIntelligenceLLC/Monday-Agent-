'use strict';
/**
 * Generates src/db/schema.sql (SQLite) from src/db/schema.pg.sql (Postgres),
 * so the two backends cannot drift. Edit the Postgres file; run `npm run
 * gen:schema`; commit both. CI checks the result is up to date.
 */
const fs = require('fs');
const path = require('path');

const PG = path.join(__dirname, '..', 'src', 'db', 'schema.pg.sql');
const LITE = path.join(__dirname, '..', 'src', 'db', 'schema.sql');

function generate(pg) {
  // Row-level security is a Postgres concept; SQLite has a single local file.
  let s = pg.split('-- This service connects with the service role')[0].trimEnd();

  // Strip the leading comment block; SQLite gets its own header.
  s = s.replace(/^(--[^\n]*\n)+/, '');

  s = s
    .replace(/bigserial PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/\bbigint\b/g, 'INTEGER')
    .replace(/\btimestamptz\b/g, 'TEXT')
    .replace(/\btext\b/g, 'TEXT')
    .replace(/\binteger\b/g, 'INTEGER')
    .replace(/DEFAULT now\(\)/g, "DEFAULT (datetime('now'))");

  return [
    '-- QCMS Task Bot schema (SQLite)',
    '-- GENERATED FILE — do not edit by hand.',
    '-- Edit src/db/schema.pg.sql, then run: npm run gen:schema',
    'PRAGMA journal_mode = WAL;',
    'PRAGMA foreign_keys = ON;',
    '',
    s.trimStart(),
    '',
  ].join('\n');
}

if (require.main === module) {
  const out = generate(fs.readFileSync(PG, 'utf8'));
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(LITE) ? fs.readFileSync(LITE, 'utf8') : '';
    if (current !== out) {
      console.error('schema.sql is out of date with schema.pg.sql — run: npm run gen:schema');
      process.exit(1);
    }
    console.log('schema.sql is up to date');
  } else {
    fs.writeFileSync(LITE, out);
    console.log(`Generated ${path.relative(process.cwd(), LITE)}`);
  }
}

module.exports = { generate };
