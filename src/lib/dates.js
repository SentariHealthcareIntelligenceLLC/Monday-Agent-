'use strict';
/** Timezone-aware date helpers built on Intl — no dependencies. */

/** Parts of `date` as seen in `tz`. */
function partsIn(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour === '24' ? '00' : p.hour), minute: Number(p.minute),
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/** Current local date in tz as YYYY-MM-DD. */
const todayIn = (tz) => partsIn(new Date(), tz).date;

/** ISO weekday for a YYYY-MM-DD string: 1 = Monday .. 7 = Sunday. */
function weekdayOf(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  return wd === 0 ? 7 : wd;
}

const dayOf = (isoDate) => Number(isoDate.split('-')[2]);

/** Shift a YYYY-MM-DD string by n days. */
function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

module.exports = { partsIn, todayIn, weekdayOf, dayOf, addDays };
