'use strict';
/**
 * Seeds the QCMS org chart and a starter routine-task library.
 * Safe to re-run: it clears and rebuilds the people/tasks tables.
 * Replace the phone numbers with real E.164 numbers (no '+').
 */
const { db, migrate, backend } = require('./index');

async function seed() {
  await migrate();

  return db.tx(async (t) => {
    await t.exec('DELETE FROM messages; DELETE FROM task_runs; DELETE FROM tasks; DELETE FROM people;');

    const addPerson = async (r) => (await t.query(
      `INSERT INTO people (name, role, whatsapp_number, email, site, reports_to_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [r.name, r.role, r.whatsapp_number, r.email, r.site, r.reports_to_id]
    )).rows[0].id;

  const owner = await addPerson({
    name: 'Owner', role: 'owner', whatsapp_number: '15550000001',
    email: 'owner@example.com', site: 'QCMS', reports_to_id: null,
  });

  const manager = await addPerson({
    name: 'Clinic Manager', role: 'manager', whatsapp_number: '15550000002',
    email: 'manager@example.com', site: 'QCMS', reports_to_id: owner,
  });

  const orSup = await addPerson({
    name: 'OR / Angiosuite Supervisor', role: 'or_supervisor', whatsapp_number: '15550000003',
    email: 'or@example.com', site: 'Surgery Center', reports_to_id: manager,
  });

  const ma = await addPerson({
    name: 'Medical Assistant', role: 'medical_assistant', whatsapp_number: '15550000004',
    email: 'ma@example.com', site: 'Clinic', reports_to_id: manager,
  });

  const va = await addPerson({
    name: 'Virtual Assistant', role: 'virtual_assistant', whatsapp_number: '15550000005',
    email: 'va@example.com', site: 'Remote', reports_to_id: ma,
  });

    const T = async (row) => {
      const r = { details: null, category: null, weekday: null, day_of_month: null,
                  due_time: '17:00', critical: 0, ...row };
      await t.query(
        `INSERT INTO tasks (title, details, category, cadence, weekday, day_of_month, due_time, assignee_id, critical)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.title, r.details, r.category, r.cadence, r.weekday, r.day_of_month, r.due_time, r.assignee_id, r.critical]
      );
    };

    // --- Daily ---
    await T({ title: 'Confirm tomorrow’s patient schedule', category: 'scheduling', cadence: 'daily', due_time: '15:00', assignee_id: va, critical: 1,
        details: 'Call/text every patient on tomorrow’s list; log confirmations and no-shows.' });
    await T({ title: 'Verify insurance eligibility for tomorrow’s patients', category: 'insurance', cadence: 'daily', due_time: '16:00', assignee_id: va, critical: 1,
        details: 'Run eligibility, flag auth-required procedures to the manager.' });
    await T({ title: 'Room turnover and clinic open checklist', category: 'or_readiness', cadence: 'daily', due_time: '08:30', assignee_id: ma,
        details: 'Vitals equipment, sharps, PPE, front-desk open.' });
    await T({ title: 'Angiosuite pre-procedure checklist', category: 'or_readiness', cadence: 'daily', due_time: '07:30', assignee_id: orSup, critical: 1,
        details: 'Supervisor checklist: crash cart, sedation chart, contrast, implants/consignment counted.' });
    await T({ title: 'Post charges for today’s cases', category: 'billing', cadence: 'daily', due_time: '18:00', assignee_id: va,
        details: 'Superbill capture; unposted charges must be zero by end of day.' });

    // --- Weekly ---
    await T({ title: 'Supply inventory count and reorder', category: 'inventory', cadence: 'weekly', weekday: 1, due_time: '12:00', assignee_id: ma,
        details: 'Par-level count, reorder short items, record usage against product order summary.' });
    await T({ title: 'Facility weekly checklist', category: 'or_readiness', cadence: 'weekly', weekday: 5, due_time: '15:00', assignee_id: orSup,
        details: 'Equipment logs, temperatures, expirations, emergency equipment.' });
    await T({ title: 'A/R follow-up on claims over 30 days', category: 'billing', cadence: 'weekly', weekday: 3, due_time: '16:00', assignee_id: va });
    await T({ title: 'Prior-authorization backlog review', category: 'insurance', cadence: 'weekly', weekday: 2, due_time: '14:00', assignee_id: manager });

    // --- Monthly ---
    await T({ title: 'Physician credentialing expirations review', category: 'credentialing', cadence: 'monthly', day_of_month: 1, due_time: '12:00', assignee_id: manager, critical: 1,
        details: 'Licenses, DEA, board certs, payer re-credentialing dates within 120 days.' });
    await T({ title: 'Facility credentialing / accreditation documents', category: 'credentialing', cadence: 'monthly', day_of_month: 5, due_time: '12:00', assignee_id: manager });
    await T({ title: 'Monthly revenue and productivity report to owner', category: 'billing', cadence: 'monthly', day_of_month: 3, due_time: '17:00', assignee_id: manager });
    await T({ title: 'Staff competency / training log update', category: 'or_readiness', cadence: 'monthly', day_of_month: 10, due_time: '15:00', assignee_id: orSup });
  });
}

seed()
  .then(async () => {
    const people = (await db.one('SELECT COUNT(*) AS c FROM people')).c;
    const tasks = (await db.one('SELECT COUNT(*) AS c FROM tasks')).c;
    console.log(`Seeded ${people} people and ${tasks} routine tasks into ${backend.kind}.`);
    console.log('Update phone numbers in the dashboard or directly in the people table before going live.');
    await backend.close();
  })
  .catch(async (err) => {
    console.error(`Seed failed: ${err.message}`);
    try { await backend.close(); } catch { /* nothing to close */ }
    process.exit(1);
  });
