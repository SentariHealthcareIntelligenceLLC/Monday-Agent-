'use strict';
/**
 * Parses inbound WhatsApp text into a task action.
 * Accepted forms (case-insensitive):
 *   DONE            -> completes the single open task, or asks which one
 *   DONE 3          -> completes open task #3 from the last reminder list
 *   DONE 3 note...  -> completes with a note
 *   BLOCKED 2 reason
 *   SNOOZE 1
 *   LIST / STATUS   -> re-sends the person's open tasks
 *   HELP
 */
const KEYWORDS = {
  done: 'done', complete: 'done', completed: 'done', finish: 'done', finished: 'done', '✅': 'done',
  blocked: 'blocked', block: 'blocked', stuck: 'blocked', issue: 'blocked',
  snooze: 'snoozed', later: 'snoozed',
  list: 'list', status: 'list', tasks: 'list',
  help: 'help', '?': 'help',
};

function parseReply(text) {
  const raw = (text || '').trim();
  if (!raw) return { action: 'unknown' };
  const [first, ...rest] = raw.split(/\s+/);
  const action = KEYWORDS[first.toLowerCase()];
  if (!action) return { action: 'unknown', raw };
  let index = null;
  let note = rest.join(' ').trim() || null;
  if (rest.length && /^#?\d+$/.test(rest[0])) {
    index = Number(rest[0].replace('#', ''));
    note = rest.slice(1).join(' ').trim() || null;
  }
  return { action, index, note, raw };
}

module.exports = { parseReply, KEYWORDS };
