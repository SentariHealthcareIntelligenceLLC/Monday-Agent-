'use strict';
/**
 * Postgres-only coverage for the WhatsApp contact path.
 *
 * The other suites force SQLite, where every waConnections function no-ops,
 * so nothing here was exercised by `npm test`. A malformed UPDATE (an unbound
 * $2) therefore shipped unnoticed: Postgres refused to prepare the statement
 * and safe() swallowed the error, leaving the 24-hour session window shut.
 *
 * Skips unless DATABASE_URL points at Postgres, so the SQLite job stays green;
 * the CI `postgres` job runs it against a real server.
 */
process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');

const PG = (process.env.DATABASE_URL || '').startsWith('postgres');

test('touchInbound records inbound contacts on Postgres', { skip: !PG }, async (t) => {
  const { db, backend } = require('../src/db');
  const wa = require('../src/services/waConnections');
  t.after(() => backend.close());

  const person = (await db.all(
    'SELECT id, whatsapp_number FROM people WHERE whatsapp_number IS NOT NULL AND active = 1 LIMIT 1'))[0];
  assert.ok(person, 'seed data must provide a person with a whatsapp number');
  const wid = person.whatsapp_number;

  await t.test('updates an existing contact row', async () => {
    await db.run(
      `UPDATE whatsapp_contacts SET last_inbound_at = NULL, opt_in_status = 'pending',
              profile_name = NULL WHERE wa_id = $1`, [wid]);
    await wa.touchInbound(wid, 'Alice', null);
    const row = (await db.all(
      'SELECT opt_in_status, profile_name, last_inbound_at FROM whatsapp_contacts WHERE wa_id = $1', [wid]))[0];
    assert.strictEqual(row.opt_in_status, 'opted_in');
    assert.strictEqual(row.profile_name, 'Alice');
    assert.notStrictEqual(row.last_inbound_at, null, 'the 24h session window must open');
  });

  await t.test('inserts and resolves person_id when no contact row exists', async () => {
    await db.run('DELETE FROM whatsapp_contacts WHERE wa_id = $1', [wid]);
    await wa.touchInbound(wid, 'Bob', null);
    const row = (await db.all(
      'SELECT person_id, opt_in_status, last_inbound_at FROM whatsapp_contacts WHERE wa_id = $1', [wid]))[0];
    assert.ok(row, 'a contact row must be created; person_id is NOT NULL and must be resolved');
    assert.strictEqual(Number(row.person_id), Number(person.id));
    assert.strictEqual(row.opt_in_status, 'opted_in');
  });

  await t.test('handles an unknown number without throwing or inserting', async () => {
    await wa.touchInbound('19995550000', 'Stranger', null);
    const n = (await db.all(
      'SELECT count(*) AS c FROM whatsapp_contacts WHERE wa_id = $1', ['19995550000']))[0].c;
    assert.strictEqual(Number(n), 0);
  });
});
