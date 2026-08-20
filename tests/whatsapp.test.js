'use strict';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = './data/test-wa.sqlite';
delete process.env.DATABASE_URL; // force the SQLite backend regardless of .env
process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

fs.rmSync('./data/test-wa.sqlite', { force: true });

const phone = require('../src/lib/phone');
const { migrate, db } = require('../src/db');
const T = require('../src/services/tasks');
const wa = require('../src/services/whatsapp');
const { handleMessage } = require('../src/routes/webhook');

// The number as Meta sends it, and as a human would type it into the dashboard.
const META_FROM = '18185550142';
const TYPED = '+1 (818) 555-0142';

let personId;

test.before(async () => {
  await migrate();
  const p = await db.one(
    `INSERT INTO people (name, role, whatsapp_number, channel, timezone)
     VALUES ('Johnny Reyes','medical_assistant',$1,'wa','America/Los_Angeles') RETURNING id`,
    [phone.normalize(TYPED)]
  );
  personId = p.id;
});

test.after(async () => { await db.close(); });

/**
 * A fresh task plus its run for today. Each test mints its own, so one test's
 * completed run never sits in the next test's open list — the reply commands
 * are positional ("DONE 2") and would otherwise drift.
 */
let seq = 0;
async function newRun({ requiresPhoto = 0, title } = {}) {
  seq += 1;
  const task = await db.one(
    `INSERT INTO tasks (title, cadence, due_time, assignee_id, requires_photo)
     VALUES ($1,'daily','17:00',$2,$3) RETURNING id`,
    [title || `Duty ${seq}`, personId, requiresPhoto]
  );
  return (await db.one(
    `INSERT INTO task_runs (task_id, due_date) VALUES ($1,$2) RETURNING id`,
    [task.id, T.today()]
  )).id;
}

/** Close everything still open, so each test starts from a known list. */
async function clearOpenRuns() {
  await db.run(
    `UPDATE task_runs SET status = 'done' WHERE status IN ('pending','snoozed')`);
  await T.clearAwaitingPhoto(personId);
}

const statusOf = async (runId) =>
  (await db.one('SELECT status, photo_path FROM task_runs WHERE id = $1', [runId]));

// --------------------------------------------------------------------- phone
test('phone normalization agrees with the form Meta sends', () => {
  assert.strictEqual(phone.normalize(TYPED), META_FROM);
  assert.strictEqual(phone.normalize('818-555-0142'), META_FROM);
  assert.strictEqual(phone.normalize('001 818 555 0142'), META_FROM);
  assert.strictEqual(phone.normalize(META_FROM), META_FROM);
  assert.ok(phone.same(TYPED, META_FROM));

  // A number that cannot be E.164 is rejected rather than half-converted.
  assert.strictEqual(phone.normalize('12345'), null);
  assert.strictEqual(phone.normalize('not a phone'), null);
  assert.strictEqual(phone.normalize(''), null);
  assert.strictEqual(phone.normalize(null), null);

  // Numbers already carrying a country code keep it.
  assert.strictEqual(phone.normalize('+44 20 7946 0958'), '442079460958');
});

test('a sender is resolved however the number was typed in', async () => {
  const found = await T.personByNumber(META_FROM);
  assert.ok(found, 'Meta digits should match the stored number');
  assert.strictEqual(found.id, personId);

  assert.strictEqual((await T.personByNumber('+1 818 555 0142')).id, personId);
  assert.ok(!(await T.personByNumber('19995550000')), 'an unknown number matches nobody');
});

// ------------------------------------------------------------------- replies
test('DONE completes the run and shows on the board', async () => {
  await clearOpenRuns();
  const runId = await newRun({ title: 'Restock the OR cart' });

  await handleMessage({ id: 'wamid.plain1', from: META_FROM, type: 'text', text: { body: 'DONE' } });

  assert.strictEqual((await statusOf(runId)).status, 'done');
});

test('a redelivered webhook does not complete a second task', async () => {
  await clearOpenRuns();
  const first = await newRun({ title: 'First duty' });
  const second = await newRun({ title: 'Second duty' });

  const msg = { id: 'wamid.retry1', from: META_FROM, type: 'text', text: { body: 'DONE 1' } };
  await handleMessage(msg);
  await handleMessage(msg); // Meta retrying the same delivery

  const done = await db.all(
    `SELECT id FROM task_runs WHERE id IN ($1,$2) AND status = 'done'`, [first, second]);
  assert.strictEqual(done.length, 1, 'the retry must not complete a second task');
});

test('a task requiring photo proof is held open until the picture arrives', async () => {
  await clearOpenRuns();
  const runId = await newRun({ requiresPhoto: 1, title: 'Log the fridge temperature' });

  await handleMessage({ id: 'wamid.photo1', from: META_FROM, type: 'text', text: { body: 'DONE 1' } });

  const held = await statusOf(runId);
  assert.strictEqual(held.status, 'pending', 'a word alone must not complete a photo task');

  const person = await T.personById(personId);
  assert.strictEqual(
    Number(person.awaiting_photo_run_id), runId,
    'the person should be marked as owing a photo for this run'
  );
});

test('an inbound photo completes the run it was asked for', async (t) => {
  await clearOpenRuns();
  const runId = await newRun({ requiresPhoto: 1, title: 'Fridge temperature log' });
  await T.setAwaitingPhoto(personId, runId);

  // Stand in for the two authenticated hops to Meta's media endpoint.
  t.mock.method(wa, 'fetchMedia', async () => ({
    buffer: Buffer.from('fake-jpeg-bytes'), contentType: 'image/jpeg',
  }));

  await handleMessage({
    id: 'wamid.img1', from: META_FROM, type: 'image',
    image: { id: 'media-123', caption: '' },
  });

  const row = await statusOf(runId);
  assert.strictEqual(row.status, 'done');
  assert.match(row.photo_path, /^run\//, 'the object key should be namespaced by kind');

  const person = await T.personById(personId);
  assert.ok(!person.awaiting_photo_run_id, 'the photo debt should be cleared');

  const proof = await db.one(
    `SELECT media_path, kind FROM messages WHERE task_run_id = $1 AND kind = 'proof'`, [runId]);
  assert.ok(proof, 'the photo should be recorded on the message thread');
  assert.strictEqual(proof.media_path, row.photo_path);
});

test('a failed media download leaves the task open for a retry', async (t) => {
  await clearOpenRuns();
  const runId = await newRun({ requiresPhoto: 1, title: 'Sharps container swap' });
  await T.setAwaitingPhoto(personId, runId);

  t.mock.method(wa, 'fetchMedia', async () => { throw new Error('media download failed (401)'); });

  await handleMessage({
    id: 'wamid.img-fail', from: META_FROM, type: 'image', image: { id: 'media-bad' },
  });

  assert.strictEqual((await statusOf(runId)).status, 'pending', 'must not be marked done');
  const person = await T.personById(personId);
  assert.strictEqual(
    Number(person.awaiting_photo_run_id), runId,
    'the person still owes the photo, so a retry lands on the same task'
  );
});

// ----------------------------------------------------------------- receipts
test('delivery receipts update the outbound message', async () => {
  await wa.logMessage({
    direction: 'out', person_id: personId, wa_number: META_FROM,
    wa_message_id: 'wamid.out1', body: 'reminder', kind: 'reminder', status: 'sent',
  });

  await wa.applyStatus({ id: 'wamid.out1', status: 'delivered' });
  let row = await db.one(`SELECT status FROM messages WHERE wa_message_id = 'wamid.out1'`);
  assert.strictEqual(row.status, 'delivered');

  await wa.applyStatus({
    id: 'wamid.out1', status: 'failed',
    errors: [{ code: 131047, title: 'Re-engagement message' }],
  });
  row = await db.one(
    `SELECT status, error FROM messages WHERE wa_message_id = 'wamid.out1'`);
  assert.strictEqual(row.status, 'failed');
  assert.match(row.error, /131047/, 'the Meta error code should be kept for the dashboard');
});

test('an unregistered number is answered but changes nothing', async () => {
  await handleMessage({
    id: 'wamid.stranger', from: '19995550000', type: 'text', text: { body: 'DONE' },
  });
  const row = await db.one(
    `SELECT person_id FROM messages WHERE wa_message_id = 'wamid.stranger'`);
  assert.ok(row, 'the message should still be logged');
  assert.strictEqual(row.person_id, null);
});
