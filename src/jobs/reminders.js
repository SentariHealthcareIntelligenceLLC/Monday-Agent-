'use strict';
const config = require('../config');
const logger = require('../logger');
const wa = require('../services/whatsapp');
const T = require('../services/tasks');

const label = (r) => `${r.title} (due ${r.due_time})`;

/** Group runs by assignee. */
function byPerson(runs) {
  const map = new Map();
  for (const r of runs) {
    if (!map.has(r.person_id)) map.set(r.person_id, { person: r, runs: [] });
    map.get(r.person_id).runs.push(r);
  }
  return map;
}

/**
 * Morning push: one template message per person listing what's due today.
 * Template variables: {{1}} name, {{2}} count, {{3}} task list.
 */
async function sendDailyReminders(isoDate = T.today()) {
  T.materializeRuns(isoDate);
  const groups = byPerson(T.openRunsFor(isoDate));
  let sent = 0;
  for (const { person, runs } of groups.values()) {
    if (!person.whatsapp_number) {
      logger.warn({ person: person.person_name }, 'No WhatsApp number; skipping');
      continue;
    }
    const list = runs.map((r, i) => `${i + 1}. ${label(r)}`).join(' | ');
    await wa.sendTemplate(
      person.whatsapp_number,
      config.whatsapp.templates.reminder,
      [person.person_name, String(runs.length), list],
      { person_id: person.person_id, kind: 'reminder', task_run_id: runs[0].id }
    );
    runs.forEach((r) => T.stamp(r.id, 'reminded_at'));
    sent += 1;
  }
  logger.info({ isoDate, people: sent }, 'Daily reminders sent');
  return sent;
}

/** Afternoon nudge to anyone still holding open items (24h window: plain text). */
async function sendNudges(isoDate = T.today()) {
  const groups = byPerson(T.openRunsFor(isoDate));
  let sent = 0;
  for (const { person, runs } of groups.values()) {
    if (!person.whatsapp_number) continue;
    const body =
      `Reminder — ${runs.length} task${runs.length > 1 ? 's' : ''} still open today:\n` +
      runs.map((r, i) => `${i + 1}. ${label(r)}`).join('\n') +
      `\n\nReply DONE <number>, BLOCKED <number> <reason>, or LIST.`;
    await wa.sendText(person.whatsapp_number, body, {
      person_id: person.person_id, kind: 'nudge', task_run_id: runs[0].id,
    });
    runs.forEach((r) => T.stamp(r.id, 'nudged_at'));
    sent += 1;
  }
  logger.info({ isoDate, people: sent }, 'Nudges sent');
  return sent;
}

/**
 * End-of-day: mark overdue items missed and notify the next person up the
 * chain of command (manager, then owner for critical items).
 */
async function runEscalations(isoDate = T.today()) {
  const overdue = T.overdueRuns(isoDate);
  const groups = byPerson(overdue);
  let escalations = 0;

  for (const { person, runs } of groups.values()) {
    runs.forEach((r) => {
      if (r.status !== 'blocked') T.markRun(r.id, 'missed');
    });

    const chain = T.chainOfCommand(person.person_id);
    const recipients = runs.some((r) => r.critical) ? chain : chain.slice(0, 1);
    const list = runs.map((r) => `${r.title} (${r.due_date}${r.status === 'blocked' ? ', blocked' : ''})`).join(' | ');

    for (const boss of recipients) {
      if (!boss.whatsapp_number) continue;
      await wa.sendTemplate(
        boss.whatsapp_number,
        config.whatsapp.templates.escalation,
        [boss.name, person.person_name, String(runs.length), list],
        { person_id: boss.id, kind: 'escalation', task_run_id: runs[0].id }
      );
      escalations += 1;
    }
    runs.forEach((r) => T.stamp(r.id, 'escalated_at'));
  }
  logger.info({ isoDate, escalations }, 'Escalations processed');
  return escalations;
}

module.exports = { sendDailyReminders, sendNudges, runEscalations };
