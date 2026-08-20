'use strict';
const { db } = require('../db');
const config = require('../config');
const { todayIn, weekdayOf, dayOf, addDays } = require('../lib/dates');

const today = (tz = config.tz) => todayIn(tz);

/** Is a task due on the given ISO date? */
function isDue(task, isoDate) {
  if (task.cadence === 'daily') return weekdayOf(isoDate) <= 5 || task.critical === 1;
  if (task.cadence === 'weekly') return weekdayOf(isoDate) === (task.weekday || 1);
  if (task.cadence === 'monthly') return dayOf(isoDate) === (task.day_of_month || 1);
  return false;
}

/** Create task_runs rows for everything due on isoDate. Idempotent. */
function materializeRuns(isoDate = today()) {
  const tasks = db.prepare('SELECT * FROM tasks WHERE active = 1').all();
  const ins = db.prepare(
    'INSERT OR IGNORE INTO task_runs (task_id, due_date, status) VALUES (?, ?, \'pending\')'
  );
  let created = 0;
  const tx = db.transaction(() => {
    for (const t of tasks) {
      if (isDue(t, isoDate)) created += ins.run(t.id, isoDate).changes;
    }
  });
  tx();
  return created;
}

const RUN_JOIN = `
  SELECT r.*, t.title, t.details, t.cadence, t.due_time, t.category, t.critical,
         p.id AS person_id, p.name AS person_name, p.role, p.whatsapp_number, p.reports_to_id
  FROM task_runs r
  JOIN tasks  t ON t.id = r.task_id
  JOIN people p ON p.id = t.assignee_id
  WHERE p.active = 1`;

const openRunsFor = (isoDate = today()) =>
  db.prepare(`${RUN_JOIN} AND r.due_date = ? AND r.status IN ('pending','snoozed') ORDER BY t.due_time`).all(isoDate);

const runsFor = (isoDate = today()) =>
  db.prepare(`${RUN_JOIN} AND r.due_date = ? ORDER BY t.due_time`).all(isoDate);

const openRunsForPerson = (personId, isoDate = today()) =>
  db.prepare(`${RUN_JOIN} AND p.id = ? AND r.due_date <= ? AND r.status IN ('pending','snoozed')
              ORDER BY r.due_date, t.due_time`).all(personId, isoDate);

const overdueRuns = (isoDate = today()) =>
  db.prepare(`${RUN_JOIN} AND r.due_date <= ? AND r.status IN ('pending','snoozed','blocked')
              AND r.escalated_at IS NULL ORDER BY r.due_date`).all(isoDate);

function markRun(runId, status, note = null) {
  return db.prepare(
    `UPDATE task_runs SET status = ?, responded_at = datetime('now'), note = COALESCE(?, note) WHERE id = ?`
  ).run(status, note, runId).changes;
}

const stamp = (runId, column) =>
  db.prepare(`UPDATE task_runs SET ${column} = datetime('now') WHERE id = ?`).run(runId);

const personByNumber = (num) =>
  db.prepare('SELECT * FROM people WHERE whatsapp_number = ? AND active = 1').get(String(num).replace(/^\+/, ''));

const personById = (id) => db.prepare('SELECT * FROM people WHERE id = ?').get(id);

/** Walk up the chain of command from a person. */
function chainOfCommand(personId, max = 4) {
  const chain = [];
  let cur = personById(personId);
  while (cur && cur.reports_to_id && chain.length < max) {
    cur = personById(cur.reports_to_id);
    if (cur) chain.push(cur);
  }
  return chain;
}

/**
 * Gap analysis: completion rates and recurring problem areas over N days.
 */
function analyzeGaps(days = 30) {
  const since = addDays(today(), -days);
  const byPerson = db.prepare(`
    SELECT p.id, p.name, p.role,
           COUNT(*) AS total,
           SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS done,
           SUM(CASE WHEN r.status IN ('missed','pending') AND r.due_date < ? THEN 1 ELSE 0 END) AS missed,
           SUM(CASE WHEN r.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
    FROM task_runs r
    JOIN tasks t  ON t.id = r.task_id
    JOIN people p ON p.id = t.assignee_id
    WHERE r.due_date >= ?
    GROUP BY p.id ORDER BY missed DESC`).all(today(), since);

  const byTask = db.prepare(`
    SELECT t.id, t.title, t.category, t.cadence,
           COUNT(*) AS total,
           SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) AS done
    FROM task_runs r JOIN tasks t ON t.id = r.task_id
    WHERE r.due_date >= ?
    GROUP BY t.id ORDER BY (1.0 * done / total) ASC`).all(since);

  const withRate = (rows) =>
    rows.map((r) => ({ ...r, rate: r.total ? Math.round((100 * r.done) / r.total) : null }));

  const people = withRate(byPerson);
  const tasks = withRate(byTask);
  const findings = [];
  for (const p of people) {
    if (p.total >= 5 && p.rate !== null && p.rate < 80) {
      findings.push(`${p.name} (${p.role}) completed ${p.rate}% of ${p.total} assigned task instances — below the 80% threshold.`);
    }
    if (p.blocked >= 3) findings.push(`${p.name} reported BLOCKED ${p.blocked} times — likely a process or supply bottleneck, not a person problem.`);
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
