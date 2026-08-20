'use strict';
/**
 * Seeds the QCMS org chart and a starter routine-task library.
 * Safe to re-run: it clears and rebuilds the people/tasks tables.
 * Replace the phone numbers with real E.164 numbers (no '+').
 */
const { db, migrate } = require('./index');

migrate();

const reset = db.transaction(() => {
  db.exec('DELETE FROM task_runs; DELETE FROM tasks; DELETE FROM people;');

  const addPerson = db.prepare(`
    INSERT INTO people (name, role, whatsapp_number, email, site, reports_to_id)
    VALUES (@name, @role, @whatsapp_number, @email, @site, @reports_to_id)`);

  const owner = addPerson.run({
    name: 'Owner', role: 'owner', whatsapp_number: '15550000001',
    email: 'owner@example.com', site: 'QCMS', reports_to_id: null,
  }).lastInsertRowid;

  const manager = addPerson.run({
    name: 'Clinic Manager', role: 'manager', whatsapp_number: '15550000002',
    email: 'manager@example.com', site: 'QCMS', reports_to_id: owner,
  }).lastInsertRowid;

  const orSup = addPerson.run({
    name: 'OR / Angiosuite Supervisor', role: 'or_supervisor', whatsapp_number: '15550000003',
    email: 'or@example.com', site: 'Surgery Center', reports_to_id: manager,
  }).lastInsertRowid;

  const ma = addPerson.run({
    name: 'Medical Assistant', role: 'medical_assistant', whatsapp_number: '15550000004',
    email: 'ma@example.com', site: 'Clinic', reports_to_id: manager,
  }).lastInsertRowid;

  const va = addPerson.run({
    name: 'Virtual Assistant', role: 'virtual_assistant', whatsapp_number: '15550000005',
    email: 'va@example.com', site: 'Remote', reports_to_id: ma,
  }).lastInsertRowid;

  const addTask = db.prepare(`
    INSERT INTO tasks (title, details, category, cadence, weekday, day_of_month, due_time, assignee_id, critical)
    VALUES (@title, @details, @category, @cadence, @weekday, @day_of_month, @due_time, @assignee_id, @critical)`);

  const T = (t) => addTask.run({
    details: null, weekday: null, day_of_month: null, due_time: '17:00', critical: 0, ...t,
  });

  // --- Daily ---
  T({ title: 'Confirm tomorrow’s patient schedule', category: 'scheduling', cadence: 'daily', due_time: '15:00', assignee_id: va, critical: 1,
      details: 'Call/text every patient on tomorrow’s list; log confirmations and no-shows.' });
  T({ title: 'Verify insurance eligibility for tomorrow’s patients', category: 'insurance', cadence: 'daily', due_time: '16:00', assignee_id: va, critical: 1,
      details: 'Run eligibility, flag auth-required procedures to the manager.' });
  T({ title: 'Room turnover and clinic open checklist', category: 'or_readiness', cadence: 'daily', due_time: '08:30', assignee_id: ma,
      details: 'Vitals equipment, sharps, PPE, front-desk open.' });
  T({ title: 'Angiosuite pre-procedure checklist', category: 'or_readiness', cadence: 'daily', due_time: '07:30', assignee_id: orSup, critical: 1,
      details: 'Supervisor checklist: crash cart, sedation chart, contrast, implants/consignment counted.' });
  T({ title: 'Post charges for today’s cases', category: 'billing', cadence: 'daily', due_time: '18:00', assignee_id: va,
      details: 'Superbill capture; unposted charges must be zero by end of day.' });

  // --- Weekly ---
  T({ title: 'Supply inventory count and reorder', category: 'inventory', cadence: 'weekly', weekday: 1, due_time: '12:00', assignee_id: ma,
      details: 'Par-level count, reorder short items, record usage against product order summary.' });
  T({ title: 'Facility weekly checklist', category: 'or_readiness', cadence: 'weekly', weekday: 5, due_time: '15:00', assignee_id: orSup,
      details: 'Equipment logs, temperatures, expirations, emergency equipment.' });
  T({ title: 'A/R follow-up on claims over 30 days', category: 'billing', cadence: 'weekly', weekday: 3, due_time: '16:00', assignee_id: va });
  T({ title: 'Prior-authorization backlog review', category: 'insurance', cadence: 'weekly', weekday: 2, due_time: '14:00', assignee_id: manager });

  // --- Monthly ---
  T({ title: 'Physician credentialing expirations review', category: 'credentialing', cadence: 'monthly', day_of_month: 1, due_time: '12:00', assignee_id: manager, critical: 1,
      details: 'Licenses, DEA, board certs, payer re-credentialing dates within 120 days.' });
  T({ title: 'Facility credentialing / accreditation documents', category: 'credentialing', cadence: 'monthly', day_of_month: 5, due_time: '12:00', assignee_id: manager });
  T({ title: 'Monthly revenue and productivity report to owner', category: 'billing', cadence: 'monthly', day_of_month: 3, due_time: '17:00', assignee_id: manager });
  T({ title: 'Staff competency / training log update', category: 'or_readiness', cadence: 'monthly', day_of_month: 10, due_time: '15:00', assignee_id: orSup });
});

reset();

const counts = {
  people: db.prepare('SELECT COUNT(*) c FROM people').get().c,
  tasks: db.prepare('SELECT COUNT(*) c FROM tasks').get().c,
};
console.log(`Seeded ${counts.people} people and ${counts.tasks} routine tasks.`);
console.log('Update phone numbers in the dashboard or directly in the people table before going live.');
