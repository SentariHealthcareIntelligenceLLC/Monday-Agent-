'use strict';
const { db } = require('../db');
const config = require('../config');
const { todayIn, weekdayOf, dayOf, monthOf, lastDayOfMonth, addDays, daysBetween } = require('../lib/dates');

const today = (tz = config.tz) => todayIn(tz);

/** How many months apart two occurrences of a cadence are. */
const MONTH_STEP = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };

/**
 * Is a task due on the given ISO date?
 *
 * Monthly and longer cadences land on `day_of_month`; `day_of_month = 0` means
 * the last day of the month (QUAD A uploads, OR utilization summaries). The
 * longer cadences additionally only fire in months that line up with
 * `month_of_year` at the right interval, so a quarterly task anchored to
 * January fires in Jan/Apr/Jul/Oct.
 */
function isDue(task, isoDate) {
  if (task.cadence === 'daily') return weekdayOf(isoDate) <= 5 || Number(task.critical) === 1;
  if (task.cadence === 'weekly') return weekdayOf(isoDate) === (task.weekday || 1);

  const step = MONTH_STEP[task.cadence];
  if (!step) return false;

  const wantDay = Number(task.day_of_month) === 0
    ? lastDayOfMonth(isoDate)
    : (task.day_of_month || 1);
  if (dayOf(isoDate) !== wantDay) return false;

  if (step === 1) return true;
  const anchor = Number(task.month_of_year) || 1;
  return (((monthOf(isoDate) - anchor) % step) + step) % step === 0;
}

/**
 * Reminder window: a run is "in season" from lead_days before its due date.
 * Long-cadence duties (a yearly accreditation packet) nag daily for weeks
 * rather than appearing once on the due date and being missed.
 */
const inReminderWindow = (run, isoDate) => {
  const lead = Number(run.lead_days) || 0;
  const delta = daysBetween(isoDate, run.due_date); // >0 = still upcoming
  return delta <= lead;
};

/** Create task_runs rows for everything due on isoDate. Idempotent. */
async function materializeRuns(isoDate = today()) {
  const tasks = await db.all('SELECT * FROM tasks WHERE active = 1');
  // Create a run as soon as its lead window opens, not on the due date, so
  // reminders can start early. Each task is checked across its own window.
  const due = [];
  for (const t of tasks) {
    const lead = Number(t.lead_days) || 0;
    for (let ahead = 0; ahead <= lead; ahead += 1) {
      const target = addDays(isoDate, ahead);
      if (isDue(t, target)) due.push({ ...t, _dueDate: target });
    }
  }
  if (!due.length) return 0;

  return db.tx(async (t) => {
    let created = 0;
    for (const task of due) {
      const { rowCount } = await t.query(
        `INSERT INTO task_runs (task_id, due_date, status) VALUES ($1, $2, 'pending')
         ON CONFLICT (task_id, due_date) DO NOTHING`,
        [task.id, task._dueDate]
      );
      created += rowCount;
    }
    return created;
  });
}

const RUN_JOIN = `
  SELECT r.*, t.title, t.details, t.cadence, t.due_time, t.category, t.critical,
         t.lead_days, t.requires_photo, t.facility_id,
         f.name AS facility_name, f.code AS facility_code,
         p.id AS person_id, p.name AS person_name, p.role, p.whatsapp_number,
         p.email AS person_email, p.channel, p.reports_to_id
  FROM task_runs r
  JOIN tasks  t ON t.id = r.task_id
  JOIN people p ON p.id = t.assignee_id
  LEFT JOIN facilities f ON f.id = t.facility_id
  WHERE p.active = 1`;

const openRunsFor = (isoDate = today()) =>
  db.all(`${RUN_JOIN} AND r.due_date = $1 AND r.status IN ('pending','snoozed') ORDER BY t.due_time`, [isoDate]);

const runsFor = (isoDate = today()) =>
  db.all(`${RUN_JOIN} AND r.due_date = $1 ORDER BY t.due_time`, [isoDate]);

const openRunsForPerson = (personId, isoDate = today()) =>
  db.all(`${RUN_JOIN} AND p.id = $1 AND r.due_date <= $2 AND r.status IN ('pending','snoozed')
          ORDER BY r.due_date, t.due_time`, [personId, isoDate]);

const overdueRuns = (isoDate = today()) =>
  db.all(`${RUN_JOIN} AND r.due_date <= $1 AND r.status IN ('pending','snoozed','blocked')
          AND r.escalated_at IS NULL ORDER BY r.due_date`, [isoDate]);

const markRun = (runId, status, note = null) =>
  db.run(
    `UPDATE task_runs SET status = $1, responded_at = now(), note = COALESCE($2, note) WHERE id = $3`,
    [status, note, runId]
  );

/** column is an internal literal, never user input. */
const STAMPABLE = new Set(['reminded_at', 'nudged_at', 'responded_at', 'escalated_at']);
const stamp = (runId, column) => {
  if (!STAMPABLE.has(column)) throw new Error(`refusing to stamp unknown column: ${column}`);
  return db.run(`UPDATE task_runs SET ${column} = now() WHERE id = $1`, [runId]);
};

const personByNumber = (num) =>
  db.one('SELECT * FROM people WHERE whatsapp_number = $1 AND active = 1', [String(num).replace(/^\+/, '')]);

const personById = (id) => db.one('SELECT * FROM people WHERE id = $1', [id]);

/** Walk up the chain of command from a person. */
async function chainOfCommand(personId, max = 4) {
  const chain = [];
  let cur = await personById(personId);
  while (cur && cur.reports_to_id && chain.length < max) {
    cur = await personById(cur.reports_to_id);
    if (cur) chain.push(cur);
  }
  return chain;
}

/**
 * Gap analysis: completion rates and recurring problem areas over N days.
 */
async function analyzeGaps(days = 30) {
  const since = addDays(today(), -days);
  const byPerson = await db.all(`
    SELECT p.id, p.name, p.role,
           COUNT(*) AS total,
           SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN r.status IN ('missed','pending') AND r.due_date < $1 THEN 1 ELSE 0 END) AS missed,
           SUM(CASE WHEN r.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
    FROM task_runs r
    JOIN tasks t  ON t.id = r.task_id
    JOIN people p ON p.id = t.assignee_id
    WHERE r.due_date >= $2
    GROUP BY p.id, p.name, p.role ORDER BY missed DESC`, [today(), since]);

  // NOTE: ordering repeats the ratio expression rather than referencing the
  // `done`/`total` output aliases — Postgres does not allow aliases inside an
  // ORDER BY expression, only as a bare term.
  const byTask = await db.all(`
    SELECT t.id, t.title, t.category, t.cadence,
           COUNT(*) AS total,
           SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS done
    FROM task_runs r JOIN tasks t ON t.id = r.task_id
    WHERE r.due_date >= $1
    GROUP BY t.id, t.title, t.category, t.cadence
    ORDER BY (1.0 * SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) / COUNT(*)) ASC`, [since]);

  const withRate = (rows) =>
    rows.map((r) => {
      const total = Number(r.total) || 0;
      const done = Number(r.done) || 0;
      return { ...r, total, done, rate: total ? Math.round((100 * done) / total) : null };
    });

  const people = withRate(byPerson);
  const tasks = withRate(byTask);
  const findings = [];
  for (const p of people) {
    if (p.total >= 5 && p.rate !== null && p.rate < 80) {
      findings.push(`${p.name} (${p.role}) completed ${p.rate}% of ${p.total} assigned task instances — below the 80% threshold.`);
    }
    if (Number(p.blocked) >= 3) findings.push(`${p.name} reported BLOCKED ${p.blocked} times — likely a process or supply bottleneck, not a person problem.`);
  }
  for (const t of tasks) {
    if (t.total >= 4 && t.rate !== null && t.rate < 60) {
      findings.push(`"${t.title}" (${t.category || 'uncategorized'}, ${t.cadence}) is only completed ${t.rate}% of the time — consider reassigning, re-timing, or splitting it.`);
    }
  }
  return { since, people, tasks, findings };
}

/**
 * Open runs whose reminder window has opened. This is what the reminder jobs
 * push on, rather than only same-day items.
 */
async function dueRunsFor(isoDate = today()) {
  const rows = await db.all(
    `${RUN_JOIN} AND r.due_date >= $1 AND r.status IN ('pending','snoozed')
     ORDER BY r.due_date, t.due_time`,
    [isoDate]
  );
  return rows.filter((r) => inReminderWindow(r, isoDate));
}

/** Count a reminder against a run; returns the new count. */
async function countReminder(runId) {
  await db.run(
    `UPDATE task_runs SET reminder_count = reminder_count + 1, reminded_at = now()
     WHERE id = $1`,
    [runId]
  );
  const row = await db.one('SELECT reminder_count FROM task_runs WHERE id = $1', [runId]);
  return row ? Number(row.reminder_count) : 0;
}

const setEscalationLevel = (runId, level) =>
  db.run('UPDATE task_runs SET escalated_level = $1, escalated_at = now() WHERE id = $2',
    [level, runId]);

const setPhoto = (runId, photoPath) =>
  db.run('UPDATE task_runs SET photo_path = $1 WHERE id = $2', [photoPath, runId]);

/** Every run in a date range, whatever its status. */
const runsBetween = (from, to) =>
  db.all(`${RUN_JOIN} AND r.due_date >= $1 AND r.due_date <= $2
          ORDER BY r.due_date, t.due_time`, [from, to]);

/** Runs scoped to a set of facility ids (empty/undefined = all facilities). */
async function runsForFacilities(isoDate, facilityIds) {
  const rows = await runsFor(isoDate);
  if (!facilityIds || !facilityIds.length) return rows;
  const want = new Set(facilityIds.map(Number));
  return rows.filter((r) => want.has(Number(r.facility_id)));
}

/**
 * Daily completion rate for the last N days — the dashboard's trend line.
 * Days with no scheduled runs are omitted rather than plotted as 0%, which
 * would read as a total failure on a quiet weekend.
 */
async function completionTrend(days = 7, isoDate = today()) {
  const since = addDays(isoDate, -(days - 1));
  const rows = await db.all(`
    SELECT r.due_date AS d,
           COUNT(*) AS total,
           SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS done
    FROM task_runs r
    WHERE r.due_date >= $1 AND r.due_date <= $2
    GROUP BY r.due_date ORDER BY r.due_date`, [since, isoDate]);

  return rows
    .filter((r) => Number(r.total) > 0)
    .map((r) => ({
      date: r.d,
      total: Number(r.total),
      done: Number(r.done),
      rate: Math.round((100 * Number(r.done)) / Number(r.total)),
    }));
}

module.exports = {
  today, isDue, inReminderWindow, completionTrend, materializeRuns, openRunsFor, runsFor, openRunsForPerson,
  overdueRuns, dueRunsFor, runsBetween, runsForFacilities, markRun, stamp, countReminder,
  setEscalationLevel, setPhoto, personByNumber, personById, chainOfCommand, analyzeGaps,
};
