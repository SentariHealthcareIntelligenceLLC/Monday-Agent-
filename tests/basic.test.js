'use strict';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = './data/test.sqlite';
process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

fs.rmSync('./data/test.sqlite', { force: true });

const { migrate, db } = require('../src/db');
migrate();

const T = require('../src/services/tasks');
const { parseReply } = require('../src/services/replies');

test('parseReply understands the command set', () => {
  assert.strictEqual(parseReply('DONE').action, 'done');
  assert.deepStrictEqual(
    { a: parseReply('done 3 ran late').action, i: parseReply('done 3 ran late').index, n: parseReply('done 3 ran late').note },
    { a: 'done', i: 3, n: 'ran late' }
  );
  assert.strictEqual(parseReply('blocked 2 no contrast').action, 'blocked');
  assert.strictEqual(parseReply('list').action, 'list');
  assert.strictEqual(parseReply('gibberish').action, 'unknown');
});

test('isDue respects cadence', () => {
  const monday = '2026-08-24';
  assert.ok(T.isDue({ cadence: 'daily', critical: 1 }, monday));
  assert.ok(T.isDue({ cadence: 'weekly', weekday: 1 }, monday));
  assert.ok(!T.isDue({ cadence: 'weekly', weekday: 3 }, monday));
  assert.ok(T.isDue({ cadence: 'monthly', day_of_month: 24 }, monday));
});

test('runs materialize and can be completed, and escalation walks the chain', () => {
  const owner = db.prepare("INSERT INTO people (name, role, whatsapp_number) VALUES ('O','owner','1000')").run().lastInsertRowid;
  const mgr = db.prepare("INSERT INTO people (name, role, whatsapp_number, reports_to_id) VALUES ('M','manager','1001',?)").run(owner).lastInsertRowid;
  const ma = db.prepare("INSERT INTO people (name, role, whatsapp_number, reports_to_id) VALUES ('A','medical_assistant','1002',?)").run(mgr).lastInsertRowid;

  db.prepare(`INSERT INTO tasks (title, cadence, due_time, assignee_id, critical)
              VALUES ('Open clinic','daily','08:00',?,1)`).run(ma);

  const date = T.today();
  assert.strictEqual(T.materializeRuns(date), 1);
  assert.strictEqual(T.materializeRuns(date), 0, 'materialize is idempotent');

  const open = T.openRunsForPerson(ma, date);
  assert.strictEqual(open.length, 1);

  assert.deepStrictEqual(T.chainOfCommand(ma).map((p) => p.name), ['M', 'O']);

  T.markRun(open[0].id, 'done', 'all set');
  assert.strictEqual(T.openRunsForPerson(ma, date).length, 0);
  assert.strictEqual(db.prepare('SELECT status FROM task_runs WHERE id = ?').get(open[0].id).status, 'done');
});

test('gap analysis returns structured output', () => {
  const g = T.analyzeGaps(30);
  assert.ok(Array.isArray(g.people) && Array.isArray(g.findings));
});
