'use strict';
const config = require('../config');
const logger = require('../logger');
const notify = require('../services/notify');
const T = require('../services/tasks');
const settings = require('../services/settings');
const creds = require('../services/credentials');
const lift = require('../services/lift');
const schedule = require('../services/schedule');
const { partsIn } = require('../lib/dates');

const label = (r) => `${r.title}${r.facility_name ? ` — ${r.facility_name}` : ''} (due ${r.due_date} ${r.due_time})`;

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
 * Morning push: everything inside its reminder window, not just today's items.
 * A yearly accreditation packet with lead_days=45 shows up daily for 45 days.
 */
async function sendDailyReminders(isoDate = T.today()) {
  await T.materializeRuns(isoDate);
  const groups = byPerson(await T.dueRunsFor(isoDate));
  const extra = await lift.pick(isoDate);
  let sent = 0;

  for (const { person, runs } of groups.values()) {
    const list = runs.map((r, i) => `${i + 1}. ${label(r)}`).join(' | ');
    const body =
      `Good morning ${person.person_name}. ${runs.length} item${runs.length > 1 ? 's' : ''} open:\n` +
      runs.map((r, i) => `${i + 1}. ${label(r)}`).join('\n') +
      `\n\nReply DONE <number>, BLOCKED <number> <reason>, or LIST.` +
      (extra ? `\n\n— ${extra.category} —\n${extra.body}` : '');

    await notify.notifyTemplate(
      person,
      config.whatsapp.templates.reminder,
      [person.person_name, String(runs.length), list],
      `QCMS — ${runs.length} task${runs.length > 1 ? 's' : ''} due`,
      body,
      { person_id: person.person_id, kind: 'reminder', task_run_id: runs[0].id }
    );
    for (const r of runs) await T.countReminder(r.id);
    sent += 1;
  }
  logger.info({ isoDate, people: sent }, 'Daily reminders sent');
  return sent;
}

/** Afternoon nudge to anyone still holding open items. */
async function sendNudges(isoDate = T.today()) {
  const groups = byPerson(await T.dueRunsFor(isoDate));
  let sent = 0;
  for (const { person, runs } of groups.values()) {
    const body =
      `Reminder — ${runs.length} task${runs.length > 1 ? 's' : ''} still open:\n` +
      runs.map((r, i) => `${i + 1}. ${label(r)}`).join('\n') +
      `\n\nReply DONE <number>, BLOCKED <number> <reason>, or LIST.`;

    await notify.notifyText(person, 'QCMS — tasks still open', body, {
      person_id: person.person_id, kind: 'nudge', task_run_id: runs[0].id,
    });
    for (const r of runs) {
      await T.countReminder(r.id);
      await T.stamp(r.id, 'nudged_at');
    }
    sent += 1;
  }
  logger.info({ isoDate, people: sent }, 'Nudges sent');
  return sent;
}

/**
 * Escalation ladder. Unlike a same-day sweep, this is driven by how many
 * reminders a run has absorbed without a reply: past `escalate_to_manager_after`
 * the manager is told, past `escalate_to_owner_after` the owner is too. Each
 * level fires once, tracked by task_runs.escalated_level.
 */
async function runEscalations(isoDate = T.today()) {
  const rules = await settings.get('rules');
  const overdue = await T.overdueRuns(isoDate);
  const inWindow = await T.dueRunsFor(isoDate);

  // A run qualifies either by being past due or by having been reminded enough.
  const seen = new Map();
  for (const r of [...overdue, ...inWindow]) seen.set(r.id, r);

  const groups = byPerson([...seen.values()]);
  let escalations = 0;

  for (const { person, runs } of groups.values()) {
    const chain = await T.chainOfCommand(person.person_id);
    if (!chain.length) continue;

    for (const level of [1, 2]) {
      const threshold = level === 1
        ? rules.escalate_to_manager_after
        : rules.escalate_to_owner_after;

      const ripe = runs.filter((r) =>
        Number(r.escalated_level) < level && Number(r.reminder_count) >= threshold);
      if (!ripe.length) continue;

      const boss = chain[level - 1];
      if (!boss) continue;

      const list = ripe.map((r) =>
        `${r.title} (due ${r.due_date}, ${r.reminder_count} reminders${r.status === 'blocked' ? ', blocked' : ''})`
      ).join(' | ');

      await notify.notifyTemplate(
        boss,
        config.whatsapp.templates.escalation,
        [boss.name, person.person_name, String(ripe.length), list],
        `QCMS escalation — ${person.person_name}`,
        `${ripe.length} task(s) assigned to ${person.person_name} are still open after ` +
        `${threshold}+ reminders:\n${ripe.map((r) => `• ${label(r)}`).join('\n')}`,
        { person_id: boss.id, kind: 'escalation', task_run_id: ripe[0].id }
      );

      for (const r of ripe) await T.setEscalationLevel(r.id, level);
      escalations += 1;
    }

    // Anything genuinely past due and unanswered is recorded as missed.
    for (const r of runs) {
      if (r.due_date < isoDate && r.status !== 'blocked' && r.status !== 'done') {
        await T.markRun(r.id, 'missed');
      }
    }
  }
  logger.info({ isoDate, escalations }, 'Escalations processed');
  return escalations;
}

/**
 * Credentialing sweep: an expiring license is a compliance exposure, so it
 * notifies the holder and their manager on the same chain of command.
 */
async function credentialAlerts(isoDate = T.today()) {
  const rules = await settings.get('rules');
  const due = await creds.expiring(rules.credential_warn_days, isoDate);
  let sent = 0;

  const byHolder = new Map();
  for (const c of due) {
    if (!byHolder.has(c.person_id)) byHolder.set(c.person_id, []);
    byHolder.get(c.person_id).push(c);
  }

  for (const [personId, items] of byHolder) {
    const person = await T.personById(personId);
    if (!person) continue;

    const lines = items.map((c) => {
      const when = c.days_left < 0
        ? `EXPIRED ${Math.abs(c.days_left)} days ago`
        : `expires in ${c.days_left} days`;
      return `• ${c.name}${c.issuer ? ` (${c.issuer})` : ''} — ${when}, ${c.expires_on}`;
    }).join('\n');

    await notify.notifyText(person, 'QCMS — credential expiring',
      `${person.name}, the following credentials need renewal:\n${lines}`,
      { person_id: person.id, kind: 'credential' });

    const worst = items[0];
    if (worst.days_left <= rules.credential_critical_days) {
      const [boss] = await T.chainOfCommand(person.id);
      if (boss) {
        await notify.notifyText(boss, 'QCMS — credential expiring',
          `${person.name} has credentials at or past expiry:\n${lines}`,
          { person_id: boss.id, kind: 'credential' });
      }
    }
    for (const c of items) await creds.markNotified(c.id);
    sent += 1;
  }
  logger.info({ isoDate, people: sent }, 'Credential alerts sent');
  return sent;
}

/** End-of-day attendance digest to the owner. */
async function clockDigest(isoDate = T.today()) {
  const clockCfg = await settings.get('clock');
  const now = partsIn(new Date(), config.tz);
  const board = await schedule.clockBoard(isoDate, now.hour * 60 + now.minute, null, clockCfg);

  const problems = board.filter((r) => r.tone === 'bad' || r.tone === 'warn');
  const owner = await require('../db').db.one(
    "SELECT * FROM people WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1");
  if (!owner) return 0;

  const body = problems.length
    ? `Attendance digest ${isoDate}:\n` + problems.map((r) =>
        `• ${r.person_name || r.staff_name || 'Unassigned'} — ${r.facility_name || ''} ${r.role}: ${r.status}`
      ).join('\n')
    : `Attendance digest ${isoDate}: all ${board.length} scheduled shifts clean.`;

  await notify.notifyText(owner, 'QCMS — attendance digest', body,
    { person_id: owner.id, kind: 'digest' });
  logger.info({ isoDate, problems: problems.length }, 'Clock digest sent');
  return problems.length;
}

module.exports = {
  sendDailyReminders, sendNudges, runEscalations, credentialAlerts, clockDigest,
};
