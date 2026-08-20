-- QCMS Task Bot schema
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Chain of command: owner > manager > (or_supervisor | medical_assistant) > virtual_assistant
CREATE TABLE IF NOT EXISTS people (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  role              TEXT    NOT NULL CHECK (role IN (
                      'owner','manager','medical_assistant','virtual_assistant','or_supervisor')),
  whatsapp_number   TEXT    UNIQUE,          -- E.164 without '+', e.g. 15551234567
  email             TEXT,
  site              TEXT,                    -- clinic / surgery center
  reports_to_id     INTEGER REFERENCES people(id) ON DELETE SET NULL,
  timezone          TEXT    NOT NULL DEFAULT 'America/Los_Angeles',
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  details       TEXT,
  category      TEXT,                        -- scheduling, insurance, inventory, credentialing, billing, or_readiness
  cadence       TEXT    NOT NULL CHECK (cadence IN ('daily','weekly','monthly')),
  weekday       INTEGER,                     -- 1=Mon .. 7=Sun (weekly only)
  day_of_month  INTEGER,                     -- 1..28 (monthly only)
  due_time      TEXT    NOT NULL DEFAULT '17:00',
  assignee_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  critical      INTEGER NOT NULL DEFAULT 0,  -- escalates same day if missed
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per task per occurrence date
CREATE TABLE IF NOT EXISTS task_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  due_date      TEXT    NOT NULL,            -- YYYY-MM-DD (local tz)
  status        TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','done','blocked','missed','snoozed')),
  reminded_at   TEXT,
  nudged_at     TEXT,
  responded_at  TEXT,
  note          TEXT,
  escalated_at  TEXT,
  UNIQUE (task_id, due_date)
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  direction    TEXT NOT NULL CHECK (direction IN ('out','in')),
  person_id    INTEGER REFERENCES people(id) ON DELETE SET NULL,
  wa_number    TEXT,
  wa_message_id TEXT,
  body         TEXT,
  kind         TEXT,                          -- reminder | nudge | escalation | reply | ack
  task_run_id  INTEGER REFERENCES task_runs(id) ON DELETE SET NULL,
  status       TEXT,                          -- sent | failed | dry_run | received
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runs_due  ON task_runs(due_date, status);
CREATE INDEX IF NOT EXISTS idx_tasks_asn ON tasks(assignee_id, active);
CREATE INDEX IF NOT EXISTS idx_msgs_when ON messages(created_at);
