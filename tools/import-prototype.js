'use strict';
/**
 * Extracts the sample dataset out of the design prototype
 * (qcms-admin-dashboard.html) and writes it as JSON for the seeder.
 *
 * The prototype's data block is plain declarations with no DOM access, so it
 * can be evaluated in a vm sandbox up to the first `document.` reference.
 * Transcribing several hundred rows by hand would be slower and less accurate.
 *
 * Usage: node tools/import-prototype.js <path-to-prototype.html> [out.json]
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/**
 * Slice one balanced object/array literal by name. Used for declarations that
 * live below the prototype's first DOM access and so cannot be run in bulk.
 */
function sliceLiteral(src, name) {
  const m = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*([[{])`).exec(src);
  if (!m) return null;
  const open = m[1];
  const close = open === '[' ? ']' : '}';
  let i = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = null;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { inStr = c; continue; }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) {
        const literal = src.slice(m.index + m[0].length - 1, i + 1);
        try { return vm.runInNewContext(`(${literal})`, {}, { timeout: 2000 }); }
        catch { return null; }
      }
    }
  }
  return null;
}

function extract(html) {
  const clean = html.replace(/\0/g, '');
  const start = clean.indexOf('<script>');
  const end = clean.indexOf('const $  = document' ) >= 0
    ? clean.indexOf('const $  = document')
    : clean.indexOf('const $  = s=>document');
  if (start < 0 || end < 0) throw new Error('could not locate the data block');

  // `const`/`let` are lexically scoped and never become sandbox properties, so
  // a trailing expression collects them by name into one object.
  const NAMES = ['PEOPLE', 'CREDS', 'DUTIES', 'CADENCES', 'FACS', 'VIEWS', 'TASKS',
    'LIFTS', 'SCHED_LOCS', 'STAFF', 'SCHED', 'DAYS', 'RECURRING', 'PLAN', 'MONTHPLAN',
    'CLOCK_RULES', 'SHIFT_TIMES', 'LIBRARY', 'FREQS'];

  const code = clean.slice(start + '<script>'.length, end)
    + `\n;globalThis.__OUT = { ${NAMES.map((n) => `${n}: typeof ${n} !== 'undefined' ? ${n} : null`).join(', ')} };`;

  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 5000 });

  const pick = (k) => sandbox.__OUT[k];
  return {
    people: pick('PEOPLE'),
    creds: pick('CREDS'),
    duties: pick('DUTIES'),
    cadences: pick('CADENCES'),
    facilities: pick('FACS'),
    views: pick('VIEWS'),
    tasks: pick('TASKS'),
    schedLocs: pick('SCHED_LOCS'),
    staff: pick('STAFF'),
    sched: pick('SCHED'),
    days: pick('DAYS'),
    recurring: pick('RECURRING'),
    plan: pick('PLAN'),
    monthplan: pick('MONTHPLAN'),
    // These two sit below the prototype's first DOM access.
    clockRules: pick('CLOCK_RULES') || sliceLiteral(clean, 'CLOCK_RULES'),
    lifts: pick('LIFTS') || sliceLiteral(clean, 'LIFTS'),
    shiftTimes: pick('SHIFT_TIMES'),
    library: pick('LIBRARY'),
    freqs: pick('FREQS'),
  };
}

if (require.main === module) {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: node tools/import-prototype.js <prototype.html> [out.json]');
    process.exit(1);
  }
  const out = process.argv[3] || path.join(__dirname, '..', 'src', 'db', 'seed-data.json');
  const data = extract(fs.readFileSync(src, 'utf8'));
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  const counts = Object.entries(data)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : Object.keys(v || {}).length}`)
    .join(' ');
  console.log(`Wrote ${path.relative(process.cwd(), out)}\n${counts}`);
}

module.exports = { extract };
