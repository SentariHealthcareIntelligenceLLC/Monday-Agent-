'use strict';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = './data/test-domain.sqlite';
delete process.env.DATABASE_URL; // force the SQLite backend regardless of .env
process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

fs.rmSync('./data/test-domain.sqlite', { force: true });

const { migrate, db } = require('../src/db');
const T = require('../src/services/tasks');
const S = require('../src/services/schedule');
const C = require('../src/services/credentials');
const PL = require('../src/services/planner');
const settings = require('../src/services/settings');

test.before(async () => { await migrate(); });
test.after(async () => { await db.close(); });

test('cadence engine handles quarterly, semiannual and yearly anchors', () => {
  // Quarterly anchored to January fires Jan/Apr/Jul/Oct on day 15.
  const q = { cadence: 'quarterly', day_of_month: 15, month_of_year: 1 };
  assert.ok(T.isDue(q, '2026-01-15'));
  assert.ok(T.isDue(q, '2026-04-15'));
  assert.ok(T.isDue(q, '2026-10-15'));
  assert.ok(!T.isDue(q, '2026-05-15'), 'wrong month');
  assert.ok(!T.isDue(q, '2026-04-16'), 'wrong day');

  const semi = { cadence: 'semiannual', day_of_month: 1, month_of_year: 3 };
  assert.ok(T.isDue(semi, '2026-03-01'));
  assert.ok(T.isDue(semi, '2026-09-01'));
  assert.ok(!T.isDue(semi, '2026-06-01'));

  const yearly = { cadence: 'yearly', day_of_month: 20, month_of_year: 9 };
  assert.ok(T.isDue(yearly, '2026-09-20'));
  assert.ok(!T.isDue(yearly, '2026-08-20'));
});

test('day_of_month 0 means the last day of the month', () => {
  const t = { cadence: 'monthly', day_of_month: 0 };
  assert.ok(T.isDue(t, '2026-08-31'), 'August has 31 days');
  assert.ok(T.isDue(t, '2026-02-28'), '2026 is not a leap year');
  assert.ok(!T.isDue(t, '2026-08-30'));
});

test('reminder window opens lead_days before the due date', () => {
  const run = { due_date: '2026-09-20', lead_days: 45 };
  assert.ok(!T.inReminderWindow(run, '2026-08-05'), '46 days out is too early');
  assert.ok(T.inReminderWindow(run, '2026-08-06'), '45 days out is in window');
  assert.ok(T.inReminderWindow(run, '2026-09-20'), 'due date is in window');
  assert.ok(T.inReminderWindow(run, '2026-09-25'), 'overdue stays in window');

  const noLead = { due_date: '2026-09-20', lead_days: 0 };
  assert.ok(!T.inReminderWindow(noLead, '2026-09-19'));
  assert.ok(T.inReminderWindow(noLead, '2026-09-20'));
});

test('materializeRuns creates a run as soon as the lead window opens', async () => {
  const person = (await db.one(
    "INSERT INTO people (name, role, whatsapp_number) VALUES ('L','manager','2000') RETURNING id")).id;
  await db.run(
    `INSERT INTO tasks (title, cadence, day_of_month, month_of_year, lead_days, assignee_id)
     VALUES ('Accreditation packet','yearly',20,9,45,$1)`, [person]);

  // 45 days before 2026-09-20.
  assert.strictEqual(await T.materializeRuns('2026-08-06'), 1);
  const run = await db.one("SELECT * FROM task_runs WHERE due_date = '2026-09-20'");
  assert.ok(run, 'run created for the future due date, not today');
  assert.strictEqual(await T.materializeRuns('2026-08-06'), 0, 'idempotent');
});

test('reminder count drives the escalation ladder', async () => {
  const run = await db.one("SELECT id FROM task_runs WHERE due_date = '2026-09-20'");
  assert.strictEqual(await T.countReminder(run.id), 1);
  assert.strictEqual(await T.countReminder(run.id), 2);

  const rules = await settings.get('rules');
  assert.strictEqual(rules.escalate_to_manager_after, 4);
  assert.strictEqual(rules.escalate_to_owner_after, 6);

  await T.setEscalationLevel(run.id, 1);
  const after = await db.one('SELECT escalated_level FROM task_runs WHERE id = $1', [run.id]);
  assert.strictEqual(Number(after.escalated_level), 1);
});

test('stamp refuses a column outside the allow-list', async () => {
  await assert.rejects(async () => T.stamp(1, 'status; DROP TABLE people'), /refusing to stamp/);
});

test('credential bands classify by days remaining', () => {
  assert.strictEqual(C.stateFor(-1), 'expired');
  assert.strictEqual(C.stateFor(0), 'expired');
  assert.strictEqual(C.stateFor(15), 'critical');
  assert.strictEqual(C.stateFor(45), 'warning');
  assert.strictEqual(C.stateFor(90), 'ok');
});

test('attendance ladder flags late, lunch and clock-out', () => {
  const shift = { starts_at: '07:00', ends_at: '15:30', on_call: 0 };
  const at = (nowMin, punch) => S.attendance(shift, punch, nowMin).status;

  assert.strictEqual(at(6 * 60 + 55, null), 'Clock in due');
  assert.match(at(7 * 60 + 20, null), /^Late 20 min$/);
  assert.strictEqual(at(8 * 60 + 30, null), 'No show — not punched');
  assert.strictEqual(at(8 * 60, { clock_in: '06:58' }), 'Clocked in');
  assert.strictEqual(at(11 * 60 + 30, { clock_in: '06:58' }), 'Lunch due');
  assert.strictEqual(at(11 * 60 + 40, { clock_in: '06:58', lunch_out: '11:35' }), 'On lunch');
  assert.strictEqual(at(16 * 60, { clock_in: '06:58' }), 'Clock out due');
  assert.strictEqual(at(16 * 60, { clock_in: '06:58', clock_out: '15:32' }), 'Complete');
});

test('worked minutes exclude the lunch break', () => {
  const shift = { starts_at: '07:00', ends_at: '15:00', on_call: 0 };
  const r = S.attendance(shift, { clock_in: '07:00', lunch_out: '11:00', lunch_in: '11:30', clock_out: '15:00' }, 16 * 60);
  assert.strictEqual(r.worked, 450, '8 hours minus a 30 minute lunch');
  assert.strictEqual(r.worked_hhmm, '07:30');
});

test('a planner item requiring a photo will not close without one', async () => {
  const id = await PL.create({
    kind: 'weekly', plan_date: '2026-08-20', title: 'Terminal clean OR 1', requires_photo: 1,
  });
  await assert.rejects(() => PL.complete(id, { done_by: 'tester' }), /requires a photo/);

  const done = await PL.complete(id, { done_by: 'tester', photo_path: 'planner/1/x.jpg' });
  assert.ok(done.done_at, 'closes once a photo is attached');
  assert.strictEqual(done.photo_path, 'planner/1/x.jpg');
});

test('settings merge stored values over defaults', async () => {
  await settings.patch('rules', { escalate_to_manager_after: 3 });
  const r = await settings.get('rules');
  assert.strictEqual(r.escalate_to_manager_after, 3, 'patched value wins');
  assert.strictEqual(r.escalate_to_owner_after, 6, 'untouched default survives');
});

test('completion trend omits days with no scheduled runs', async () => {
  const trend = await T.completionTrend(7, '2026-08-20');
  assert.ok(Array.isArray(trend));
  assert.ok(trend.every((d) => d.total > 0), 'no zero-total days plotted');
});
