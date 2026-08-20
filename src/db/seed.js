'use strict';
/**
 * Seeds the QCMS org chart, facilities, routine duties, credentialing records,
 * the staff schedule and the daily-lift library.
 *
 * Data comes from seed-data.json, extracted from the design prototype by
 * tools/import-prototype.js. Safe to re-run: it clears and rebuilds every
 * table. Replace the placeholder phone numbers with real E.164 numbers
 * (no '+') before going live.
 */
const fs = require('fs');
const path = require('path');
const { db, migrate, backend } = require('./index');
const { addDays, weekdayOf } = require('../lib/dates');
const config = require('../config');
const { todayIn } = require('../lib/dates');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));

const ROLE = {
  'Manager': 'manager',
  'Medical Assistant': 'medical_assistant',
  'Virtual Assistant': 'virtual_assistant',
  'OR Supervisor': 'or_supervisor',
  'Owner': 'owner',
};

// Prototype cadence keys -> schema cadence values, with a sensible lead window.
const CADENCE = {
  Weekly:    { cadence: 'weekly',     lead: 2 },
  Monthly:   { cadence: 'monthly',    lead: 5 },
  Quarterly: { cadence: 'quarterly',  lead: 14 },
  Semi:      { cadence: 'semiannual', lead: 30 },
  Yearly:    { cadence: 'yearly',     lead: 45 },
};

/** Prototype numbers are masked ("+1 818 ••• 4471"); make them dialable-looking. */
const fakeNumber = (i) => `1555000${String(i + 1).padStart(4, '0')}`;

// Duties needing visual proof of completion.
const PHOTO_HINTS = [/deep clean/i, /crash cart/i, /inventory/i, /eyewash/i,
  /drill/i, /expired/i, /equipment/i, /seal/i];
const needsPhoto = (title) => PHOTO_HINTS.some((rx) => rx.test(title)) ? 1 : 0;

async function seed() {
  await migrate();
  const today = todayIn(config.tz);

  return db.tx(async (t) => {
    await t.exec(`
      DELETE FROM punches; DELETE FROM shifts; DELETE FROM planner_items;
      DELETE FROM messages; DELETE FROM task_runs; DELETE FROM tasks;
      DELETE FROM credentials; DELETE FROM people; DELETE FROM facility_views;
      DELETE FROM facilities; DELETE FROM lift_items; DELETE FROM settings;`);

    // ---------------------------------------------------------- facilities
    const facId = {};
    for (const f of DATA.facilities) {
      if (facId[f.id]) continue; // the prototype list has duplicate rows
      const row = await t.query(
        `INSERT INTO facilities (code, name, kind, group_name, rooms)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [f.id, f.name, f.kind || null, f.group || null, JSON.stringify(f.rooms || [])]
      );
      facId[f.id] = row.rows[0].id;
    }
    const facByName = {};
    for (const f of DATA.facilities) facByName[f.name] = facId[f.id];

    for (const [i, v] of (DATA.views || []).entries()) {
      await t.query(
        `INSERT INTO facility_views (code, name, facility_ids, sort_order)
         VALUES ($1,$2,$3,$4)`,
        [v.id, v.name, JSON.stringify((v.ids || []).map((c) => facId[c]).filter(Boolean)), i]
      );
    }

    // -------------------------------------------------------------- people
    // The prototype has no owner row, but the escalation ladder needs a top of
    // the chain, so one is created and everyone senior reports to it.
    const owner = (await t.query(
      `INSERT INTO people (name, role, whatsapp_number, email, channel, reminder_freq, timezone)
       VALUES ('Fredshon Gevera','owner',$1,'owner@example.com','both','1x',$2) RETURNING id`,
      ['15550000001', config.tz]
    )).rows[0].id;

    const pid = {};
    for (const [i, p] of DATA.people.entries()) {
      const role = ROLE[p.role];
      if (!role) throw new Error(`unmapped role: ${p.role}`);
      const row = await t.query(
        `INSERT INTO people (name, role, whatsapp_number, email, site, facility_id,
                             employee_no, hired_on, languages, channel, reminder_freq,
                             reports_to_id, timezone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [p.name, role, fakeNumber(i + 1), p.em, p.base || null,
         facByName[p.base] || null, p.emp || null, null, p.lang || null,
         p.chan || 'wa', p.freq || '2x',
         role === 'manager' ? owner : null, config.tz]
      );
      pid[p.id] = row.rows[0].id;
    }

    // Everyone below manager reports to the manager.
    const manager = DATA.people.find((p) => p.role === 'Manager');
    if (manager) {
      for (const p of DATA.people) {
        if (p.role === 'Manager') continue;
        await t.query('UPDATE people SET reports_to_id = $1 WHERE id = $2',
          [pid[manager.id], pid[p.id]]);
      }
    }

    // ------------------------------------------------------- credentialing
    let credCount = 0;
    for (const [proto, list] of Object.entries(DATA.creds || {})) {
      if (!pid[proto]) continue;
      for (const [name, issuer, expires] of list) {
        await t.query(
          `INSERT INTO credentials (person_id, name, issuer, expires_on)
           VALUES ($1,$2,$3,$4)`,
          [pid[proto], name, issuer, expires]
        );
        credCount += 1;
      }
    }

    // -------------------------------------------------------------- duties
    let taskCount = 0;
    for (const [proto, list] of Object.entries(DATA.duties || {})) {
      if (!pid[proto]) continue;
      const person = DATA.people.find((p) => p.id === proto);
      for (const d of list) {
        const map = CADENCE[d.c];
        if (!map) throw new Error(`unmapped cadence: ${d.c}`);
        const [y, m, dd] = d.due.split('-').map(Number);
        await t.query(
          `INSERT INTO tasks (title, details, cadence, weekday, day_of_month, month_of_year,
                              lead_days, due_time, assignee_id, facility_id, requires_photo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [d.t, d.how || null, map.cadence,
           map.cadence === 'weekly' ? weekdayOf(d.due) : null,
           map.cadence === 'weekly' ? null : dd,
           map.cadence === 'weekly' || map.cadence === 'monthly' ? null : m,
           map.lead, '17:00', pid[proto],
           facByName[person && person.base] || null, needsPhoto(d.t)]
        );
        taskCount += 1;
      }
    }

    // ------------------------------------------------------------ schedule
    // The prototype's week grid is day-indexed (0 = Monday); anchor it to the
    // current week so the schedule and time clock have live data on first run.
    const monday = addDays(today, -(weekdayOf(today) - 1));
    const staffPersonId = {};
    for (const p of DATA.people) staffPersonId[p.name] = pid[p.id];

    let shiftCount = 0;
    for (const [weekOffset, rows] of Object.entries(DATA.sched || {})) {
      const base = addDays(monday, Number(weekOffset) * 7);
      for (const s of rows) {
        if (!s.w) continue; // unfilled slot
        const onCall = s.t === 'On call';
        const [starts, ends] = onCall ? [null, null] : s.t.split('-');
        const absence = s.l === 'ab';
        await t.query(
          `INSERT INTO shifts (facility_id, role, work_date, starts_at, ends_at, on_call,
                               person_id, staff_name, absence_kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [absence ? null : (facId[s.l] || null), s.r, addDays(base, s.d),
           starts, ends, onCall ? 1 : 0,
           staffPersonId[s.w] || null, s.w, absence ? s.r : null]
        );
        shiftCount += 1;
      }
    }

    // ---------------------------------------------------------- daily lift
    let liftCount = 0;
    for (const [category, items] of Object.entries(DATA.lifts || {})) {
      for (const body of items) {
        await t.query('INSERT INTO lift_items (category, body) VALUES ($1,$2)',
          [category, body]);
        liftCount += 1;
      }
    }

    // ------------------------------------------------------------- planner
    // Weekly planner cells come from each person's weekly duties, laid across
    // the current week; monthly cells from their monthly-and-longer duties.
    let planCount = 0;
    for (const [proto, list] of Object.entries(DATA.duties || {})) {
      if (!pid[proto]) continue;
      const person = DATA.people.find((p) => p.id === proto);
      const facility = facByName[person && person.base] || null;

      const weekly = list.filter((d) => d.c === 'Weekly');
      for (const [i, d] of weekly.entries()) {
        await t.query(
          `INSERT INTO planner_items (kind, person_id, facility_id, plan_date, title,
                                      frequency, requires_photo)
           VALUES ('weekly',$1,$2,$3,$4,$5,$6)`,
          [pid[proto], facility, addDays(monday, i % 5), d.t, 'Weekly', needsPhoto(d.t)]
        );
        planCount += 1;
      }

      const longer = list.filter((d) => d.c !== 'Weekly');
      for (const d of longer) {
        const day = Number(d.due.split('-')[2]) || 1;
        const planDate = `${today.slice(0, 7)}-${String(Math.min(day, 28)).padStart(2, '0')}`;
        await t.query(
          `INSERT INTO planner_items (kind, person_id, facility_id, plan_date, title,
                                      frequency, requires_photo)
           VALUES ('monthly',$1,$2,$3,$4,$5,$6)`,
          [pid[proto], facility, planDate, d.t, d.c, needsPhoto(d.t)]
        );
        planCount += 1;
      }
    }

    // ------------------------------------------------------------- history
    // Backfill two weeks of completed/missed runs so the trend line, gap
    // analysis and completion rates have something to show on a fresh
    // install. This is SAMPLE history, like everything else in this seeder --
    // it is not derived from real activity. Drop this block for a production
    // install that should start from a genuinely empty record.
    const allTasks = (await t.query('SELECT id, assignee_id FROM tasks')).rows;
    let runCount = 0;
    for (let back = 14; back >= 1; back -= 1) {
      const date = addDays(today, -back);
      if (weekdayOf(date) > 5) continue; // weekdays only
      for (const task of allTasks) {
        // Deterministic spread: ~78% done, ~12% missed, ~10% still pending.
        const roll = (Number(task.id) * 7 + back * 13) % 100;
        const status = roll < 78 ? 'done' : (roll < 90 ? 'missed' : 'pending');
        const reminders = status === 'done' ? 1 : (status === 'missed' ? 5 : 2);
        await t.query(
          `INSERT INTO task_runs (task_id, due_date, status, reminder_count, responded_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (task_id, due_date) DO NOTHING`,
          [task.id, date, status, reminders, status === 'done' ? `${date} 16:00:00` : null]
        );
        runCount += 1;
      }
    }

    return { facilities: Object.keys(facId).length, people: DATA.people.length + 1,
             credentials: credCount, tasks: taskCount, shifts: shiftCount,
             lift: liftCount, planner: planCount, sample_history: runCount };
  });
}

seed()
  .then(async (counts) => {
    console.log(`Seeded into ${backend.kind}:`);
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(12)} ${v}`);
    console.log('\nReplace the placeholder phone numbers before going live.');
    await backend.close();
  })
  .catch(async (err) => {
    console.error(`Seed failed: ${err.message}`);
    try { await backend.close(); } catch { /* nothing to close */ }
    process.exit(1);
  });
