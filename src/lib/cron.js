'use strict';
/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week),
 * evaluated in a named timezone.
 * Supports: star, n, a-b, a-b/s, star-slash-s, and comma lists.
 * Day-of-week: 0 or 7 = Sunday. No dependencies.
 */
const { partsIn } = require('./dates');

const RANGES = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 6],   // day of week
];

function parseField(field, [min, max]) {
  const allowed = new Set();
  for (const part of String(field).split(',')) {
    const [spec, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo; let hi;
    if (spec === '*') { lo = min; hi = max; }
    else if (spec.includes('-')) { [lo, hi] = spec.split('-').map(Number); }
    else { lo = hi = Number(spec); }
    if (![lo, hi].every(Number.isInteger) || lo < min || hi > max || lo > hi) {
      throw new Error(`bad cron field "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

function parse(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields, got ${fields.length}`);
  const sets = fields.map((f, i) => parseField(f, RANGES[i]));
  // normalise Sunday-as-7
  if (sets[4].has(7)) sets[4].add(0);
  return { sets, fields };
}

function validate(expr) {
  try { parse(expr); return true; } catch { return false; }
}

/** Does `expr` fire at `date` (evaluated in tz)? Minute resolution. */
function matches(expr, date, tz) {
  const { sets } = typeof expr === 'string' ? parse(expr) : expr;
  const p = partsIn(date, tz);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const domRestricted = sets[2].size !== 31;
  const dowRestricted = sets[4].size < 8;
  const dayOk = domRestricted && dowRestricted
    ? sets[2].has(p.day) || sets[4].has(dow)     // cron's OR rule
    : (!domRestricted || sets[2].has(p.day)) && (!dowRestricted || sets[4].has(dow));
  return sets[0].has(p.minute) && sets[1].has(p.hour) && sets[3].has(p.month) && dayOk;
}

/**
 * Schedule `fn` on `expr`. Ticks once a minute, aligned to the minute boundary.
 * Returns { stop() }.
 */
function schedule(expr, fn, { tz = 'UTC' } = {}) {
  const compiled = parse(expr);
  let timer = null;
  let last = null;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const now = new Date();
    const key = now.toISOString().slice(0, 16);
    if (key !== last && matches(compiled, now, tz)) {
      last = key;
      Promise.resolve().then(fn).catch(() => {});
    }
    const msToNextMinute = 60000 - (Date.now() % 60000) + 250;
    timer = setTimeout(tick, msToNextMinute);
    if (timer.unref) timer.unref();
  };
  tick();

  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

module.exports = { parse, validate, matches, schedule };
