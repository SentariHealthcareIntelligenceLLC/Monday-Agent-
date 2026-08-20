-- QCMS Task Bot schema (PostgreSQL / Supabase)
-- Kept structurally in step with schema.sql (SQLite). Booleans are integer 0/1
-- on both so application predicates like `active = 1` are portable.

-- ---------------------------------------------------------------- facilities
CREATE TABLE IF NOT EXISTS facilities (
  id          bigserial PRIMARY KEY,
  code        text UNIQUE NOT NULL,          -- 'tz', 'al', 'gl' ...
  name        text NOT NULL,
  kind        text,                          -- Surgery center | Vein clinic | ...
  group_name  text,                          -- CVEC | EVSLA | CICVI
  rooms       text NOT NULL DEFAULT '[]',    -- JSON array of room names
  active      integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Saved multi-facility views ("CVEC group", "All facilities").
CREATE TABLE IF NOT EXISTS facility_views (
  id           bigserial PRIMARY KEY,
  code         text UNIQUE NOT NULL,
  name         text NOT NULL,
  facility_ids text NOT NULL DEFAULT '[]',   -- JSON array of facilities.id; [] = all
  sort_order   integer NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------------- people
CREATE TABLE IF NOT EXISTS people (
  id                bigserial PRIMARY KEY,
  name              text    NOT NULL,
  role              text    NOT NULL CHECK (role IN (
                      'owner','manager','medical_assistant','virtual_assistant','or_supervisor')),
  whatsapp_number   text    UNIQUE,          -- E.164 without '+', e.g. 15551234567
  email             text,
  site              text,                    -- legacy free-text label
  facility_id       bigint  REFERENCES facilities(id) ON DELETE SET NULL,
  employee_no       text,
  hired_on          text,                    -- YYYY-MM-DD
  languages         text,
  channel           text    NOT NULL DEFAULT 'wa' CHECK (channel IN ('wa','em','both')),
  reminder_freq     text    NOT NULL DEFAULT '2x'
                      CHECK (reminder_freq IN ('2x','1x','alt','wk','2wk','mo')),
  reports_to_id     bigint  REFERENCES people(id) ON DELETE SET NULL,
  timezone          text    NOT NULL DEFAULT 'America/Los_Angeles',
  active            integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------- tasks
CREATE TABLE IF NOT EXISTS tasks (
  id            bigserial PRIMARY KEY,
  title         text    NOT NULL,
  details       text,
  category      text,
  cadence       text    NOT NULL CHECK (cadence IN (
                  'daily','weekly','monthly','quarterly','semiannual','yearly')),
  weekday       integer,                     -- 1=Mon .. 7=Sun (weekly)
  day_of_month  integer,                     -- 1..28 (monthly and longer)
  month_of_year integer,                     -- 1..12 anchor for quarterly/semi/yearly
  lead_days     integer NOT NULL DEFAULT 0,  -- start daily reminders N days early
  due_time      text    NOT NULL DEFAULT '17:00',
  assignee_id   bigint  NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  facility_id   bigint  REFERENCES facilities(id) ON DELETE SET NULL,
  requires_photo integer NOT NULL DEFAULT 0, -- completion needs a photo proof
  critical      integer NOT NULL DEFAULT 0,
  active        integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per task per occurrence date
CREATE TABLE IF NOT EXISTS task_runs (
  id             bigserial PRIMARY KEY,
  task_id        bigint  NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  due_date       text    NOT NULL,           -- YYYY-MM-DD (local tz)
  status         text    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','done','blocked','missed','snoozed')),
  reminder_count integer NOT NULL DEFAULT 0, -- drives the escalation ladder
  escalated_level integer NOT NULL DEFAULT 0,-- 0 none, 1 manager, 2 owner
  reminded_at    timestamptz,
  nudged_at      timestamptz,
  responded_at   timestamptz,
  note           text,
  photo_path     text,                       -- Supabase Storage object path
  escalated_at   timestamptz,
  UNIQUE (task_id, due_date)
);

CREATE TABLE IF NOT EXISTS messages (
  id            bigserial PRIMARY KEY,
  direction     text NOT NULL CHECK (direction IN ('out','in')),
  channel       text NOT NULL DEFAULT 'wa' CHECK (channel IN ('wa','em')),
  person_id     bigint REFERENCES people(id) ON DELETE SET NULL,
  wa_number     text,
  wa_message_id text,
  body          text,
  kind          text,
  task_run_id   bigint REFERENCES task_runs(id) ON DELETE SET NULL,
  status        text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- credentialing
CREATE TABLE IF NOT EXISTS credentials (
  id          bigserial PRIMARY KEY,
  person_id   bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  name        text NOT NULL,                 -- 'BLS / CPR'
  issuer      text,                          -- 'American Heart Association'
  expires_on  text NOT NULL,                 -- YYYY-MM-DD
  notified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creds_exp ON credentials(expires_on);

-- ---------------------------------------------------------------- scheduling
CREATE TABLE IF NOT EXISTS shifts (
  id           bigserial PRIMARY KEY,
  facility_id  bigint REFERENCES facilities(id) ON DELETE CASCADE,
  role         text NOT NULL,                -- '1. Scrub 1', 'Front desk'
  work_date    text NOT NULL,                -- YYYY-MM-DD
  starts_at    text,                         -- HH:MM, null for 'On call'
  ends_at      text,
  on_call      integer NOT NULL DEFAULT 0,
  person_id    bigint REFERENCES people(id) ON DELETE SET NULL,
  staff_name   text,                         -- staff not in the people table
  absence_kind text,                         -- 'Off — call out' | 'Call out sick'
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(work_date, facility_id);

CREATE TABLE IF NOT EXISTS punches (
  id          bigserial PRIMARY KEY,
  shift_id    bigint REFERENCES shifts(id) ON DELETE CASCADE,
  person_id   bigint REFERENCES people(id) ON DELETE SET NULL,
  staff_name  text,
  work_date   text NOT NULL,
  clock_in    text,                          -- HH:MM local
  lunch_out   text,
  lunch_in    text,
  clock_out   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_punch_shift ON punches(shift_id);

-- -------------------------------------------------------------- planner grid
-- Weekly / monthly planner cells, including photo-proof completions.
CREATE TABLE IF NOT EXISTS planner_items (
  id             bigserial PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('weekly','monthly')),
  person_id      bigint REFERENCES people(id) ON DELETE CASCADE,
  facility_id    bigint REFERENCES facilities(id) ON DELETE SET NULL,
  plan_date      text NOT NULL,              -- YYYY-MM-DD
  title          text NOT NULL,
  room           text,
  frequency      text,
  requires_photo integer NOT NULL DEFAULT 0,
  done_at        timestamptz,
  done_by        text,
  photo_path     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_date ON planner_items(kind, plan_date);

-- ----------------------------------------------------------------- daily lift
CREATE TABLE IF NOT EXISTS lift_items (
  id       bigserial PRIMARY KEY,
  category text NOT NULL,                    -- Joke | Medical fact | ...
  body     text NOT NULL,
  active   integer NOT NULL DEFAULT 1
);

-- ------------------------------------------------------------------ settings
-- Escalation ladder, reminder windows, channel defaults, lift categories.
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,                  -- JSON
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runs_due  ON task_runs(due_date, status);
CREATE INDEX IF NOT EXISTS idx_tasks_asn ON tasks(assignee_id, active);
CREATE INDEX IF NOT EXISTS idx_msgs_when ON messages(created_at);

-- This service connects with the service role and is the only writer, so RLS
-- is enabled with no permissive policy: anon/authenticated keys read nothing.
ALTER TABLE facilities     ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE people         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials    ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE punches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE planner_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lift_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings       ENABLE ROW LEVEL SECURITY;
