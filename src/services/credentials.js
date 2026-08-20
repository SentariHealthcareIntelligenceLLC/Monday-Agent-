'use strict';
/**
 * Staff credentialing: licenses, certifications and mandated training with
 * expiry dates. Expiry is a compliance exposure, so the reminder jobs treat an
 * approaching expiry like an overdue task and walk the same chain of command.
 */
const { db } = require('../db');
const { todayIn, daysBetween } = require('../lib/dates');
const config = require('../config');

/** Warning bands, in days remaining. */
const BANDS = [
  { state: 'expired', max: 0 },
  { state: 'critical', max: 30 },
  { state: 'warning', max: 60 },
  { state: 'ok', max: Infinity },
];

const stateFor = (daysLeft) => BANDS.find((b) => daysLeft <= b.max).state;

const decorate = (row, today) => {
  const daysLeft = daysBetween(today, row.expires_on);
  return { ...row, days_left: daysLeft, state: stateFor(daysLeft) };
};

async function forPerson(personId, today = todayIn(config.tz)) {
  const rows = await db.all(
    'SELECT * FROM credentials WHERE person_id = $1 ORDER BY expires_on', [personId]
  );
  return rows.map((r) => decorate(r, today));
}

async function all(today = todayIn(config.tz)) {
  const rows = await db.all(`
    SELECT c.*, p.name AS person_name, p.role, p.whatsapp_number, p.email AS person_email,
           p.channel, p.reports_to_id, p.facility_id
    FROM credentials c JOIN people p ON p.id = c.person_id
    WHERE p.active = 1 ORDER BY c.expires_on`);
  return rows.map((r) => decorate(r, today));
}

/** Everything expired or inside `withinDays`, worst first. */
async function expiring(withinDays = 60, today = todayIn(config.tz)) {
  return (await all(today))
    .filter((c) => c.days_left <= withinDays)
    .sort((a, b) => a.days_left - b.days_left);
}

const create = async (c) => (await db.one(
  `INSERT INTO credentials (person_id, name, issuer, expires_on)
   VALUES ($1, $2, $3, $4) RETURNING id`,
  [c.person_id, c.name, c.issuer || null, c.expires_on]
)).id;

const update = (id, patch) => db.run(
  `UPDATE credentials SET name = COALESCE($1, name), issuer = COALESCE($2, issuer),
     expires_on = COALESCE($3, expires_on) WHERE id = $4`,
  [patch.name ?? null, patch.issuer ?? null, patch.expires_on ?? null, id]
);

const remove = (id) => db.run('DELETE FROM credentials WHERE id = $1', [id]);

const markNotified = (id) =>
  db.run('UPDATE credentials SET notified_at = now() WHERE id = $1', [id]);

module.exports = { forPerson, all, expiring, create, update, remove, markNotified, stateFor };
