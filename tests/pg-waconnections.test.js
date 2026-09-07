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

  await t.test('repoints an existing contact when the person changes number', async () => {
    // person_id is UNIQUE: inserting a second row for the same person would
    // violate it, and ON CONFLICT (wa_id) cannot catch that.
    await db.run('DELETE FROM whatsapp_contacts WHERE person_id = $1', [person.id]);
    await wa.touchInbound(wid, 'Before', null);
    const moved = `${wid}9`;
    await db.run('UPDATE people SET whatsapp_number = $2 WHERE id = $1', [person.id, moved]);
    await wa.touchInbound(moved, 'After', null);

    const rows = await db.all(
      'SELECT wa_id, profile_name FROM whatsapp_contacts WHERE person_id = $1', [person.id]);
    assert.strictEqual(rows.length, 1, 'the person keeps exactly one contact row');
    assert.strictEqual(rows[0].wa_id, moved, 'the row must follow the new number');
    assert.strictEqual(rows[0].profile_name, 'After');
    await db.run('UPDATE people SET whatsapp_number = $2 WHERE id = $1', [person.id, wid]);
    await db.run('UPDATE whatsapp_contacts SET wa_id = $2 WHERE person_id = $1', [person.id, wid]);
  });

  await t.test('handles an unknown number without throwing or inserting', async () => {
    await wa.touchInbound('19995550000', 'Stranger', null);
    const n = (await db.all(
      'SELECT count(*) AS c FROM whatsapp_contacts WHERE wa_id = $1', ['19995550000']))[0].c;
    assert.strictEqual(Number(n), 0);
  });
});
