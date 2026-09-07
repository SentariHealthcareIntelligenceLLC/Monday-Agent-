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

  await t.test('never attaches one person\'s state to another after a number is reassigned', async () => {
    // A keeps the old number in whatsapp_contacts; the admin gives that number
    // to B. An update keyed on wa_id alone would record B's inbound message
    // against A.
    const other = (await db.all(
      'SELECT id FROM people WHERE id <> $1 AND active = 1 LIMIT 1', [person.id]))[0];
    assert.ok(other, 'seed data must provide a second person');
    await db.run('DELETE FROM whatsapp_contacts WHERE person_id IN ($1, $2)', [person.id, other.id]);
    await db.run('UPDATE people SET whatsapp_number = NULL WHERE id = $1', [other.id]);

    await wa.touchInbound(wid, 'Person A', null);          // A owns the number
    await db.run('UPDATE people SET whatsapp_number = NULL WHERE id = $1', [person.id]);
    await db.run('UPDATE people SET whatsapp_number = $2 WHERE id = $1', [other.id, wid]);
    await wa.touchInbound(wid, 'Person B', null);          // now B owns it

    const rows = await db.all(
      'SELECT person_id, profile_name FROM whatsapp_contacts WHERE wa_id = $1', [wid]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].person_id), Number(other.id),
      'the contact must belong to the person people says owns the number');
    assert.strictEqual(rows[0].profile_name, 'Person B');

    await db.run('UPDATE people SET whatsapp_number = NULL WHERE id = $1', [other.id]);
    await db.run('UPDATE people SET whatsapp_number = $2 WHERE id = $1', [person.id, wid]);
    await db.run('DELETE FROM whatsapp_contacts WHERE person_id = $1', [other.id]);
  });

  await t.test('creates contact state on a first outbound send', async () => {
    // A person onboarded after migration 004's backfill gets a reminder before
    // ever messaging in: an update-only path would record nothing.
    await db.run('DELETE FROM whatsapp_contacts WHERE person_id = $1', [person.id]);
    await wa.touchOutbound(wid);
    let row = (await db.all(
      'SELECT last_outbound_at FROM whatsapp_contacts WHERE person_id = $1', [person.id]))[0];
    assert.ok(row, 'the first send must create the contact row');
    assert.notStrictEqual(row.last_outbound_at, null);

    await db.run('DELETE FROM whatsapp_contacts WHERE person_id = $1', [person.id]);
    await wa.recordFailure(wid, 'boom');
    row = (await db.all(
      'SELECT failure_count, last_error FROM whatsapp_contacts WHERE person_id = $1',
      [person.id]))[0];
    assert.ok(row, 'a failed first send must create the contact row too');
    assert.strictEqual(Number(row.failure_count), 1);
    assert.strictEqual(row.last_error, 'boom');
  });

  await t.test('keeps an unhandled event eligible after a failed handleMessage', async () => {
    // The event is stamped processed only after handling, so a crash between
    // the two must not make Meta's redelivery a no-op.
    const id = 'wamid.test.redelivery';
    await db.run('DELETE FROM whatsapp_webhook_events WHERE wa_message_id = $1', [id]);

    const first = await wa.recordWebhookEvent(
      { eventType: 'message', waMessageId: id, waId: wid, payload: { id }, signatureOk: true });
    assert.strictEqual(first, true, 'a new event must be handled');

    const redelivered = await wa.recordWebhookEvent(
      { eventType: 'message', waMessageId: id, waId: wid, payload: { id }, signatureOk: true });
    assert.strictEqual(redelivered, true,
      'handling never completed, so the redelivery must still be handled');

    await wa.markEventProcessed(id, 'message');
    const afterDone = await wa.recordWebhookEvent(
      { eventType: 'message', waMessageId: id, waId: wid, payload: { id }, signatureOk: true });
    assert.strictEqual(afterDone, false, 'once handled, a redelivery is skipped');
    await db.run('DELETE FROM whatsapp_webhook_events WHERE wa_message_id = $1', [id]);
  });

  await t.test('a late receipt cannot regress delivery status', async () => {
    const wam = 'wamid.test.receipts';
    await db.run('DELETE FROM whatsapp_delivery_status WHERE wa_message_id = $1', [wam]);
    await db.run('DELETE FROM messages WHERE wa_message_id = $1', [wam]);
    await db.run(
      `INSERT INTO messages (direction, channel, wa_number, wa_message_id, body)
       VALUES ('out', 'wa', $1, $2, 'hi')`, [wid, wam]);

    await wa.recordDeliveryStatus({ id: wam, status: 'sent', timestamp: '1000' });
    await wa.recordDeliveryStatus({ id: wam, status: 'read', timestamp: '3000' });
    let row = (await db.all(
      'SELECT delivery_status FROM messages WHERE wa_message_id = $1', [wam]))[0];
    assert.strictEqual(row.delivery_status, 'read');

    // Meta redelivers an older receipt out of order.
    await wa.recordDeliveryStatus({ id: wam, status: 'delivered', timestamp: '2000' });
    row = (await db.all(
      'SELECT delivery_status FROM messages WHERE wa_message_id = $1', [wam]))[0];
    assert.strictEqual(row.delivery_status, 'read', 'a late receipt must not walk the status back');

    // A failure must still be able to take over.
    await wa.recordDeliveryStatus({ id: wam, status: 'failed', timestamp: '4000' });
    row = (await db.all(
      'SELECT delivery_status FROM messages WHERE wa_message_id = $1', [wam]))[0];
    assert.strictEqual(row.delivery_status, 'failed');

    const occurred = await db.all(
      `SELECT status, occurred_at FROM whatsapp_delivery_status
        WHERE wa_message_id = $1 ORDER BY occurred_at`, [wam]);
    assert.strictEqual(occurred[0].status, 'sent', "Meta's own timestamps must be persisted");
    await db.run('DELETE FROM whatsapp_delivery_status WHERE wa_message_id = $1', [wam]);
    await db.run('DELETE FROM messages WHERE wa_message_id = $1', [wam]);
  });

  await t.test('handles an unknown number without throwing or inserting', async () => {
    await wa.touchInbound('19995550000', 'Stranger', null);
    const n = (await db.all(
      'SELECT count(*) AS c FROM whatsapp_contacts WHERE wa_id = $1', ['19995550000']))[0].c;
    assert.strictEqual(Number(n), 0);
  });
});
