-- QCMS Task Bot schema (SQLite)
-- GENERATED FILE — do not edit by hand.
-- Edit src/db/schema.pg.sql, then run: npm run gen:schema
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- facilities
CREATE TABLE IF NOT EXISTS facilities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE NOT NULL,          -- 'tz', 'al', 'gl' ...
  name        TEXT NOT NULL,
  kind        TEXT,                          -- Surgery center | Vein clinic | ...
  group_name  TEXT,                          -- CVEC | EVSLA | CICVI
  rooms       TEXT NOT NULL DEFAULT '[]',    -- JSON array of room names
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Saved multi-facility views ("CVEC group", "All facilities").
CREATE TABLE IF NOT EXISTS facility_views (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  facility_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of facilities.id; [] = all
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------------- people
CREATE TABLE IF NOT EXISTS people (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  role              TEXT    NOT NULL CHECK (role IN (
                      'owner','manager','medical_assistant','virtual_assistant','or_supervisor')),
  whatsapp_number   TEXT    UNIQUE,          -- E.164 without '+', e.g. 15551234567
  email             TEXT,
  site              TEXT,                    -- legacy free-TEXT label
  facility_id       INTEGER  REFERENCES facilities(id) ON DELETE SET NULL,
  employee_no       TEXT,
  hired_on          TEXT,                    -- YYYY-MM-DD
  languages         TEXT,
  channel           TEXT    NOT NULL DEFAULT 'wa' CHECK (channel IN ('wa','em','both')),
  reminder_freq     TEXT    NOT NULL DEFAULT '2x'
                      CHECK (reminder_freq IN ('2x','1x','alt','wk','2wk','mo')),
  reports_to_id     INTEGER  REFERENCES people(id) ON DELETE SET NULL,
  timezone          TEXT    NOT NULL DEFAULT 'America/Los_Angeles',
  -- Set when this person replies DONE to a task that requires photo proof:
  -- the next image they send completes that run. Cleared once it arrives.
  awaiting_photo_run_id INTEGER,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------------------------- tasks
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT    NOT NULL,
  details       TEXT,
  category      TEXT,
  -- 'once' is a one-off item raised from the task board or a message; every
  -- other value is a standing duty that recurs on its own schedule.
  cadence       TEXT    NOT NULL CHECK (cadence IN (
                  'once','daily','weekly','monthly','quarterly','semiannual','yearly')),
  -- Where the task came from. The recurring library is the steady state;
  -- 'board' and 'message' are the two ways a new one-off enters the system.
  origin        TEXT    NOT NULL DEFAULT 'library'
                  CHECK (origin IN ('library','board','message')),
  due_date      TEXT,                        -- one-off tasks only (YYYY-MM-DD)
  raised_by_id  INTEGER  REFERENCES people(id) ON DELETE SET NULL,
  -- No FK: messages is declared after tasks, and SQLite cannot add a
  -- constraint after the fact, so the two schemas would diverge.
  source_message_id INTEGER,
  weekday       INTEGER,                     -- 1=Mon .. 7=Sun (weekly)
  day_of_month  INTEGER,                     -- 1..28 (monthly and longer)
  month_of_year INTEGER,                     -- 1..12 anchor for quarterly/semi/yearly
  lead_days     INTEGER NOT NULL DEFAULT 0,  -- start daily reminders N days early
  due_time      TEXT    NOT NULL DEFAULT '17:00',
  assignee_id   INTEGER  NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  facility_id   INTEGER  REFERENCES facilities(id) ON DELETE SET NULL,
  requires_photo INTEGER NOT NULL DEFAULT 0, -- completion needs a photo proof
  critical      INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per task per occurrence date
CREATE TABLE IF NOT EXISTS task_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER  NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  due_date       TEXT    NOT NULL,           -- YYYY-MM-DD (local tz)
  status         TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','done','blocked','missed','snoozed')),
  reminder_count INTEGER NOT NULL DEFAULT 0, -- drives the escalation ladder
  escalated_level INTEGER NOT NULL DEFAULT 0,-- 0 none, 1 manager, 2 owner
  reminded_at    TEXT,
  nudged_at      TEXT,
  responded_at   TEXT,
  note           TEXT,
  photo_path     TEXT,                       -- Supabase Storage object path
  escalated_at   TEXT,
  UNIQUE (task_id, due_date)
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  direction     TEXT NOT NULL CHECK (direction IN ('out','in')),
  channel       TEXT NOT NULL DEFAULT 'wa' CHECK (channel IN ('wa','em')),
  person_id     INTEGER REFERENCES people(id) ON DELETE SET NULL,
  wa_number     TEXT,
  wa_message_id TEXT,
  body          TEXT,
  kind          TEXT,
  task_run_id   INTEGER REFERENCES task_runs(id) ON DELETE SET NULL,
  media_path    TEXT,                        -- inbound image, as a storage key
  status        TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Meta retries a webhook until it gets a 200, so the same inbound message can
-- arrive more than once. The unique id makes the second delivery a no-op
-- instead of a second "task done".
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_wa_in
  ON messages(wa_message_id) WHERE direction = 'in' AND wa_message_id IS NOT NULL;
-- Delivery receipts arrive keyed by the id Meta returned on send.
CREATE INDEX IF NOT EXISTS idx_msg_wa_out
  ON messages(wa_message_id) WHERE direction = 'out';
-- Per-person thread, newest first, for the dashboard profile panel.
CREATE INDEX IF NOT EXISTS idx_msg_person ON messages(person_id, created_at);

-- ------------------------------------------------------------- credentialing
CREATE TABLE IF NOT EXISTS credentials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                 -- 'BLS / CPR'
  issuer      TEXT,                          -- 'American Heart Association'
  expires_on  TEXT NOT NULL,                 -- YYYY-MM-DD
  notified_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_creds_exp ON credentials(expires_on);

-- ---------------------------------------------------------------- scheduling
CREATE TABLE IF NOT EXISTS shifts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  facility_id  INTEGER REFERENCES facilities(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,                -- '1. Scrub 1', 'Front desk'
  work_date    TEXT NOT NULL,                -- YYYY-MM-DD
  starts_at    TEXT,                         -- HH:MM, null for 'On call'
  ends_at      TEXT,
  on_call      INTEGER NOT NULL DEFAULT 0,
  person_id    INTEGER REFERENCES people(id) ON DELETE SET NULL,
  staff_name   TEXT,                         -- staff not in the people table
  absence_kind TEXT,                         -- 'Off — call out' | 'Call out sick'
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(work_date, facility_id);

CREATE TABLE IF NOT EXISTS punches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id    INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
  person_id   INTEGER REFERENCES people(id) ON DELETE SET NULL,
  staff_name  TEXT,
  work_date   TEXT NOT NULL,
  clock_in    TEXT,                          -- HH:MM local
  lunch_out   TEXT,
  lunch_in    TEXT,
  clock_out   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_punch_shift ON punches(shift_id);

-- -------------------------------------------------------------- planner grid
-- Weekly / monthly planner cells, including photo-proof completions.
CREATE TABLE IF NOT EXISTS planner_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('weekly','monthly')),
  person_id      INTEGER REFERENCES people(id) ON DELETE CASCADE,
  facility_id    INTEGER REFERENCES facilities(id) ON DELETE SET NULL,
  plan_date      TEXT NOT NULL,              -- YYYY-MM-DD
  title          TEXT NOT NULL,
  room           TEXT,
  frequency      TEXT,
  requires_photo INTEGER NOT NULL DEFAULT 0,
  done_at        TEXT,
  done_by        TEXT,
  photo_path     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plan_date ON planner_items(kind, plan_date);

-- ----------------------------------------------------------------- daily lift
CREATE TABLE IF NOT EXISTS lift_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,                    -- Joke | Medical fact | ...
  body     TEXT NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1
);

-- ------------------------------------------------------------------ settings
-- Escalation ladder, reminder windows, channel defaults, lift categories.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                  -- JSON
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runs_due  ON task_runs(due_date, status);
CREATE INDEX IF NOT EXISTS idx_tasks_asn ON tasks(assignee_id, active);
CREATE INDEX IF NOT EXISTS idx_msgs_when ON messages(created_at);
