'use strict';
/**
 * WhatsApp numbers, one canonical form.
 *
 * Meta identifies a sender by `from`: E.164 digits with no '+', e.g.
 * "15551234567". The dashboard, meanwhile, lets a human type whatever looks
 * like a phone number — "+1 (818) 555-0142", "818-555-0142". If those two
 * forms are compared literally, an inbound reply matches no one and the person
 * is told they are "not registered".
 *
 * So every number is normalized to Meta's form on the way INTO the database
 * and on the way into a lookup, and both sides then agree by construction.
 */

// Numbers typed without a country code are assumed to be in this one. The
// clinics are all US/CA; a person abroad must be entered with their own code.
const DEFAULT_COUNTRY = '1';

/**
 * -> E.164 digits, no '+', or null if the input cannot be one.
 * Extensions, spaces, dashes, parentheses and a leading '00' are all handled.
 */
function normalize(input, defaultCountry = DEFAULT_COUNTRY) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;

  // '00' is the international prefix outside NANP; treat it as '+'.
  s = s.replace(/^00/, '+');
  const hadPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  if (!hadPlus) {
    // 10 digits is a bare NANP number; 11 starting with 1 already has its code.
    if (digits.length === 10) digits = defaultCountry + digits;
    else if (digits.length === 11 && digits.startsWith('1')) { /* already E.164 */ }
  }

  // E.164 allows at most 15 digits, and no real number is shorter than 8.
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/** True when two numbers refer to the same handset, however they were typed. */
const same = (a, b) => {
  const x = normalize(a);
  return Boolean(x) && x === normalize(b);
};

/** Display form for the dashboard: +1 818 555 0142 */
function pretty(input) {
  const n = normalize(input);
  if (!n) return null;
  if (n.length === 11 && n.startsWith('1')) {
    return `+1 ${n.slice(1, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
  }
  return `+${n}`;
}

module.exports = { normalize, same, pretty, DEFAULT_COUNTRY };
