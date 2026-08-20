'use strict';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = './data/test.sqlite';
delete process.env.DATABASE_URL; // force the SQLite backend regardless of .env
process.env.DRY_RUN = 'true';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

fs.rmSync('./data/test.sqlite', { force: true });

const { migrate, db } = require('../src/db');
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

test('runs materialize and can be completed, and escalation walks the chain', async () => {
  await migrate();

  const newPerson = async (sql, params) => (await db.one(`${sql} RETURNING id`, params)).id;
  const owner = await newPerson("INSERT INTO people (name, role, whatsapp_number) VALUES ('O','owner','1000')", []);
  const mgr = await newPerson("INSERT INTO people (name, role, whatsapp_number, reports_to_id) VALUES ('M','manager','1001',$1)", [owner]);
  const ma = await newPerson("INSERT INTO people (name, role, whatsapp_number, reports_to_id) VALUES ('A','medical_assistant','1002',$1)", [mgr]);

  await db.run(`INSERT INTO tasks (title, cadence, due_time, assignee_id, critical)
                VALUES ('Open clinic','daily','08:00',$1,1)`, [ma]);

  const date = T.today();
  assert.strictEqual(await T.materializeRuns(date), 1);
  assert.strictEqual(await T.materializeRuns(date), 0, 'materialize is idempotent');

  const open = await T.openRunsForPerson(ma, date);
  assert.strictEqual(open.length, 1);

  const chain = await T.chainOfCommand(ma);
  assert.deepStrictEqual(chain.map((p) => p.name), ['M', 'O']);

  await T.markRun(open[0].id, 'done', 'all set');
  assert.strictEqual((await T.openRunsForPerson(ma, date)).length, 0);
  const row = await db.one('SELECT status FROM task_runs WHERE id = $1', [open[0].id]);
  assert.strictEqual(row.status, 'done');
});

test('stamp refuses unknown columns', async () => {
  await assert.rejects(async () => T.stamp(1, 'status; DROP TABLE people'), /refusing to stamp/);
});

test('gap analysis returns structured output', async () => {
  const g = await T.analyzeGaps(30);
  assert.ok(Array.isArray(g.people) && Array.isArray(g.findings));
});

test.after(async () => { await db.close(); });
