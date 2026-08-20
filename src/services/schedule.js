'use strict';
/**
 * Staff scheduling (shifts) and the time clock (punches).
 *
 * Shifts carry either a `person_id` (someone in the people table who also
 * receives task reminders) or a bare `staff_name`, because the OR roster
 * includes CRNAs and float staff who are scheduled but not task-assigned.
 */
const { db } = require('../db');
const { addDays, weekdayOf } = require('../lib/dates');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const minutes = (hhmm) => {
  if (!hhmm || !HHMM.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const clock = (mins) =>
  mins == null ? null : `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/** Monday of the week containing isoDate. */
const weekStart = (isoDate) => addDays(isoDate, -(weekdayOf(isoDate) - 1));

const SHIFT_JOIN = `
  SELECT s.*, f.name AS facility_name, f.code AS facility_code,
         p.name AS person_name, p.whatsapp_number, p.email AS person_email, p.channel
  FROM shifts s
  LEFT JOIN facilities f ON f.id = s.facility_id
  LEFT JOIN people p ON p.id = s.person_id`;

const forWeek = (isoDate, facilityIds = null) => {
  const start = weekStart(isoDate);
  const end = addDays(start, 6);
  const scoped = facilityIds && facilityIds.length
    ? ` AND s.facility_id IN (${facilityIds.map((_, i) => `$${i + 3}`).join(',')})`
    : '';
  return db.all(
    `${SHIFT_JOIN} WHERE s.work_date >= $1 AND s.work_date <= $2${scoped}
     ORDER BY s.work_date, f.name, s.role`,
    [start, end, ...(facilityIds && facilityIds.length ? facilityIds : [])]
  );
};

const forDay = (isoDate, facilityIds = null) => {
  const scoped = facilityIds && facilityIds.length
    ? ` AND s.facility_id IN (${facilityIds.map((_, i) => `$${i + 2}`).join(',')})`
    : '';
  return db.all(
    `${SHIFT_JOIN} WHERE s.work_date = $1${scoped} ORDER BY f.name, s.role`,
    [isoDate, ...(facilityIds && facilityIds.length ? facilityIds : [])]
  );
};

const createShift = async (s) => (await db.one(
  `INSERT INTO shifts (facility_id, role, work_date, starts_at, ends_at, on_call,
                       person_id, staff_name, absence_kind, note)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
  [s.facility_id || null, s.role, s.work_date, s.starts_at || null, s.ends_at || null,
   s.on_call ? 1 : 0, s.person_id || null, s.staff_name || null,
   s.absence_kind || null, s.note || null]
)).id;

const assignShift = (id, { person_id = null, staff_name = null }) =>
  db.run('UPDATE shifts SET person_id = $1, staff_name = $2 WHERE id = $3',
    [person_id, staff_name, id]);

const removeShift = (id) => db.run('DELETE FROM shifts WHERE id = $1', [id]);

// ---------------------------------------------------------------- time clock

const punchFor = (shiftId) => db.one('SELECT * FROM punches WHERE shift_id = $1', [shiftId]);

/** Record one punch event. Idempotent per shift; later events overwrite. */
async function punch(shiftId, field, hhmm) {
  const allowed = ['clock_in', 'lunch_out', 'lunch_in', 'clock_out'];
  if (!allowed.includes(field)) throw new Error(`unknown punch field: ${field}`);
  if (hhmm && !HHMM.test(hhmm)) throw new Error(`bad time: ${hhmm}`);

  const shift = await db.one('SELECT * FROM shifts WHERE id = $1', [shiftId]);
  if (!shift) throw new Error(`no such shift: ${shiftId}`);

  const existing = await punchFor(shiftId);
  if (!existing) {
    await db.run(
      `INSERT INTO punches (shift_id, person_id, staff_name, work_date, ${field})
       VALUES ($1, $2, $3, $4, $5)`,
      [shiftId, shift.person_id, shift.staff_name, shift.work_date, hhmm]
    );
  } else {
    await db.run(`UPDATE punches SET ${field} = $1 WHERE shift_id = $2`, [hhmm, shiftId]);
  }
  return punchFor(shiftId);
}

/**
 * Attendance state for one shift at a given local time, using the same ladder
 * the dashboard shows: clock-in nudge, late flag, lunch due, clock-out due.
 */
function attendance(shift, p, nowMin, rules = {}) {
  const {
    clockInNudge = 10, lateAfter = 5, noShowAfter = 60,
    lunchAfter = 240, lunchBack = 30,
  } = rules;

  const start = minutes(shift.starts_at);
  const end = minutes(shift.ends_at);
  const inM = minutes(p && p.clock_in);
  const outM = minutes(p && p.clock_out);
  const loM = minutes(p && p.lunch_out);
  const liM = minutes(p && p.lunch_in);

  let status = 'Scheduled';
  let tone = '';
  if (shift.on_call) status = 'On call';
  else if (start == null) status = 'Unscheduled';
  else if (!inM && nowMin > start + noShowAfter) { status = 'No show — not punched'; tone = 'bad'; }
  else if (!inM && nowMin > start + lateAfter) { status = `Late ${nowMin - start} min`; tone = 'bad'; }
  else if (!inM && nowMin >= start - clockInNudge) { status = 'Clock in due'; tone = 'warn'; }
  else if (inM && !outM && loM && !liM) {
    status = nowMin > loM + lunchBack ? 'Lunch over — punch back in' : 'On lunch';
    tone = 'warn';
  } else if (inM && !outM && end != null && nowMin > end) {
    // Past the end of the shift, clocking out is the more urgent prompt than a
    // lunch that can no longer be taken.
    status = 'Clock out due'; tone = 'warn';
  } else if (inM && !outM && !loM && nowMin > inM + lunchAfter) { status = 'Lunch due'; tone = 'warn'; }
  else if (inM && outM) { status = 'Complete'; tone = 'ok'; }
  else if (inM) { status = 'Clocked in'; tone = 'ok'; }

  const lunchMins = (loM != null && liM != null) ? liM - loM : 0;
  const until = outM ?? (end != null ? Math.min(nowMin, end) : nowMin);
  const worked = inM != null ? Math.max(0, until - inM - lunchMins) : 0;

  return { status, tone, worked, worked_hhmm: clock(worked) };
}

/** Today's roster with punch state attached. */
async function clockBoard(isoDate, nowMin, facilityIds = null, rules = {}) {
  const shifts = (await forDay(isoDate, facilityIds)).filter((s) => !s.absence_kind);
  const out = [];
  for (const s of shifts) {
    const p = await punchFor(s.id);
    out.push({ ...s, punch: p || null, ...attendance(s, p, nowMin, rules) });
  }
  return out;
}

module.exports = {
  weekStart, minutes, clock, forWeek, forDay, createShift, assignShift, removeShift,
  punch, punchFor, attendance, clockBoard,
};
