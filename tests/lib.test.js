'use strict';
process.env.NODE_ENV = 'test';
process.env.DATABASE_FILE = './data/test-lib.sqlite';

const test = require('node:test');
const assert = require('node:assert');
const cron = require('../src/lib/cron');
const { weekdayOf, dayOf, addDays } = require('../src/lib/dates');
const { createApp } = require('../src/lib/http');

test('cron parses and validates', () => {
  assert.ok(cron.validate('0 8 * * *'));
  assert.ok(cron.validate('*/15 9-17 * * 1-5'));
  assert.ok(!cron.validate('0 8 * *'));
  assert.ok(!cron.validate('99 8 * * *'));
});

test('cron matches the right minute in a timezone', () => {
  // 2026-08-20T15:00:00Z == 08:00 America/Los_Angeles (UTC-7)
  const d = new Date('2026-08-20T15:00:00Z');
  assert.ok(cron.matches('0 8 * * *', d, 'America/Los_Angeles'));
  assert.ok(!cron.matches('0 9 * * *', d, 'America/Los_Angeles'));
  assert.ok(cron.matches('0 15 * * *', d, 'UTC'));
});

test('date helpers', () => {
  assert.strictEqual(weekdayOf('2026-08-24'), 1); // Monday
  assert.strictEqual(weekdayOf('2026-08-23'), 7); // Sunday
  assert.strictEqual(dayOf('2026-08-05'), 5);
  assert.strictEqual(addDays('2026-03-01', -1), '2026-02-28');
});

test('router dispatches params, query and JSON bodies', async () => {
  const app = createApp();
  app.get('/x/:id', (req, res) => res.json({ id: req.params.id, q: req.query.q || null }));
  app.post('/y', (req, res) => res.json({ got: req.body.v }));

  const call = (method, url, body) => new Promise((resolve) => {
    const chunks = [];
    const req = { method, url, headers: { host: 'x', 'content-type': 'application/json' } };
    req[Symbol.asyncIterator] = async function* () { if (body) yield Buffer.from(JSON.stringify(body)); };
    const res = {
      headersSent: false, statusCode: 200,
      writeHead(code) { this.statusCode = code; this.headersSent = true; },
      end(b) { chunks.push(b || ''); resolve({ status: this.statusCode, body: chunks.join('') }); },
    };
    app.handle(req, res);
  });

  assert.deepStrictEqual(JSON.parse((await call('GET', '/x/42?q=hi')).body), { id: '42', q: 'hi' });
  assert.deepStrictEqual(JSON.parse((await call('POST', '/y', { v: 7 })).body), { got: 7 });
  assert.strictEqual((await call('GET', '/nope')).status, 404);
});
