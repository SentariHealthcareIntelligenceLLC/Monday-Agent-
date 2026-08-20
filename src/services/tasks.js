'use strict';
const { db } = require('../db');
const config = require('../config');
const { todayIn, weekdayOf, dayOf, addDays } = require('../lib/dates');

const today = (tz = config.tz) => todayIn(tz);

/** Is a task due on the given ISO date? */
function isDue(task, isoDate) {
  if (task.cadence === 'daily') return weekdayOf(isoDate) <= 5 || Number(task.critical) === 1;
  if (task.cadence === 'weekly') return weekdayOf(isoDate) === (task.weekday || 1);
  if (task.cadence === 'monthly') return dayOf(isoDate) === (task.day_of_month || 1);
  return false;
}

/** Create task_runs rows for everything due on isoDate. Idempotent. */
async function materializeRuns(isoDate = today()) {
  const tasks = await db.all('SELECT * FROM tasks WHERE active = 1');
  const due = tasks.filter((t) => isDue(t, isoDate));
  if (!due.length) return 0;

  return db.tx(async (t) => {
    let created = 0;
    for (const task of due) {
      const { rowCount } = await t.query(
        `INSERT INTO task_runs (task_id, due_date, status) VALUES ($1, $2, 'pending')
         ON CONFLICT (task_id, due_date) DO NOTHING`,
        [task.id, isoDate]
      );
      created += rowCount;
    }
    return created;
  });
}

const RUN_JOIN = `
  SELECT r.*, t.title, t.details, t.cadence, t.due_time, t.category, t.critical,
         p.id AS person_id, p.name AS person_name, p.role, p.whatsapp_number, p.reports_to_id
  FROM task_runs r
  JOIN tasks  t ON t.id = r.task_id
  JOIN people p ON p.id = t.assignee_id
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

module.exports = {
  today, isDue, materializeRuns, openRunsFor, runsFor, openRunsForPerson,
  overdueRuns, markRun, stamp, personByNumber, personById, chainOfCommand, analyzeGaps,
};
