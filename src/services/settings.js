'use strict';
/**
 * Key/value settings, JSON-encoded. Holds the escalation ladder and reminder
 * windows the Rules tab edits, so operations staff can change them without a
 * deploy. Defaults here are the behaviour the dashboard documents.
 */
const { db } = require('../db');

const DEFAULTS = {
  rules: {
    // Reminder count at which a run escalates one level up the chain.
    escalate_to_manager_after: 4,
    escalate_to_owner_after: 6,
    // Credentialing warning bands, in days before expiry.
    credential_warn_days: 60,
    credential_critical_days: 30,
  },
  clock: {
    clockInNudge: 10,   // minutes before shift start to nudge
    lateAfter: 5,       // minutes after start before flagging late
    noShowAfter: 60,
    lunchAfter: 240,    // minutes worked before lunch is due
    lunchBack: 30,      // minutes of lunch before "punch back in"
    digest_at: '17:30',
  },
  lift: {
    enabled: true,
    categories: ['Joke', 'Medical fact', 'Word of the day'],
  },
  org: { name: 'QCMS' },
};

async function get(key) {
  const row = await db.one('SELECT value FROM settings WHERE key = $1', [key]);
  if (!row) return DEFAULTS[key] ?? null;
  try {
    // Stored values are merged over defaults so a new default key appears
    // without needing a data migration.
    const stored = JSON.parse(row.value);
    const base = DEFAULTS[key];
    return base && typeof base === 'object' && !Array.isArray(base)
      ? { ...base, ...stored }
      : stored;
  } catch {
    return DEFAULTS[key] ?? null;
  }
}

async function set(key, value) {
  const json = JSON.stringify(value);
  const updated = await db.run(
    'UPDATE settings SET value = $1, updated_at = now() WHERE key = $2', [json, key]
  );
  if (!updated) await db.run('INSERT INTO settings (key, value) VALUES ($1, $2)', [key, json]);
  return value;
}

/** Merge a patch into an existing settings object. */
async function patch(key, changes) {
  const current = await get(key);
  return set(key, { ...(current || {}), ...changes });
}

const all = async () => {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = await get(key);
  return out;
};

module.exports = { DEFAULTS, get, set, patch, all };
