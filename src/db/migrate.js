'use strict';
/**
 * Applies the schema, then any pending migrations.
 *
 *   npm run migrate            apply everything outstanding
 *   npm run migrate -- --list  show what would run, change nothing
 *
 * A fresh database gets its structure from schema.pg.sql / schema.sql. A
 * database created before a change gets it from src/db/migrations/*.sql, which
 * are additive and idempotent: they never drop a table or rewrite a row.
 *
 * Applied filenames are recorded in schema_migrations, so re-running is a
 * no-op rather than a risk.
 */
const fs = require('fs');
const path = require('path');
const { db, migrate, backend } = require('./index');

const DIR = path.join(__dirname, 'migrations');

const files = () => (fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
  : []);

async function applied() {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    applied_at ${backend.kind === 'postgres' ? 'timestamptz' : 'TEXT'} NOT NULL DEFAULT ${backend.kind === 'postgres' ? 'now()' : "(datetime('now'))"}
  )`);
  const rows = await db.all('SELECT filename FROM schema_migrations');
  return new Set(rows.map((r) => r.filename));
}

async function run() {
  const listOnly = process.argv.includes('--list');

  // Migrations are written for Postgres; SQLite installs are recreated from
  // the generated schema instead, so there is nothing to replay there.
  if (backend.kind !== 'postgres') {
    await migrate();
    console.log(`Schema applied to ${backend.kind} (${backend.target})`);
    return;
  }

  await migrate();               // creates anything missing entirely
  const done = await applied();
  const pending = files().filter((f) => !done.has(f));

  if (!pending.length) {
    console.log(`Schema up to date (${done.size} migration(s) already applied).`);
    return;
  }

  if (listOnly) {
    console.log(`${pending.length} pending migration(s):`);
    for (const f of pending) console.log(`  ${f}`);
    return;
  }

  for (const f of pending) {
    process.stdout.write(`Applying ${f} ... `);
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
    });
    console.log('ok');
  }
  console.log(`Applied ${pending.length} migration(s) to ${backend.target}.`);
}

run()
  .then(() => backend.close())
  .catch(async (err) => {
    console.error(`Migration failed: ${err.message}`);
    try { await backend.close(); } catch { /* nothing to close */ }
    process.exit(1);
  });
