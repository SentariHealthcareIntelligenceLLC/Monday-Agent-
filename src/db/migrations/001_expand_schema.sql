-- 001: expand the original four-table schema to the full dashboard model.
--
-- Safe to run against a database that already holds live data: every statement
-- is additive and idempotent. Nothing is dropped and no row is rewritten.
--
-- Postgres/Supabase only. A fresh install gets the same result from
-- schema.pg.sql; this file exists for databases created before that.

-- ------------------------------------------------------------- new tables
CREATE TABLE IF NOT EXISTS facilities (
  id          bigserial PRIMARY KEY,
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  kind        text,
  group_name  text,
  rooms       text NOT NULL DEFAULT '[]',
  active      integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facility_views (
  id           bigserial PRIMARY KEY,
  code         text UNIQUE NOT NULL,
  name         text NOT NULL,
  facility_ids text NOT NULL DEFAULT '[]',
  sort_order   integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credentials (
  id          bigserial PRIMARY KEY,
  person_id   bigint NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  name        text NOT NULL,
  issuer      text,
  expires_on  text NOT NULL,
  notified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creds_exp ON credentials(expires_on);

CREATE TABLE IF NOT EXISTS shifts (
  id           bigserial PRIMARY KEY,
  facility_id  bigint REFERENCES facilities(id) ON DELETE CASCADE,
  role         text NOT NULL,
  work_date    text NOT NULL,
  starts_at    text,
  ends_at      text,
  on_call      integer NOT NULL DEFAULT 0,
  person_id    bigint REFERENCES people(id) ON DELETE SET NULL,
  staff_name   text,
  absence_kind text,
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
  clock_in    text,
  lunch_out   text,
  lunch_in    text,
  clock_out   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_punch_shift ON punches(shift_id);

CREATE TABLE IF NOT EXISTS planner_items (
  id             bigserial PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('weekly','monthly')),
  person_id      bigint REFERENCES people(id) ON DELETE CASCADE,
  facility_id    bigint REFERENCES facilities(id) ON DELETE SET NULL,
  plan_date      text NOT NULL,
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

CREATE TABLE IF NOT EXISTS lift_items (
  id       bigserial PRIMARY KEY,
  category text NOT NULL,
  body     text NOT NULL,
  active   integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------- new columns
ALTER TABLE people ADD COLUMN IF NOT EXISTS facility_id   bigint REFERENCES facilities(id) ON DELETE SET NULL;
ALTER TABLE people ADD COLUMN IF NOT EXISTS employee_no   text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS hired_on      text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS languages     text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS channel       text NOT NULL DEFAULT 'wa';
ALTER TABLE people ADD COLUMN IF NOT EXISTS reminder_freq text NOT NULL DEFAULT '2x';

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS month_of_year     integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lead_days         integer NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS facility_id       bigint REFERENCES facilities(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requires_photo    integer NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS origin            text NOT NULL DEFAULT 'library';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date          text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS raised_by_id      bigint REFERENCES people(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_message_id bigint;

ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS reminder_count  integer NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS escalated_level integer NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS photo_path      text;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'wa';

-- ------------------------------------------------- widen CHECK constraints
-- The original cadence check allowed only daily/weekly/monthly, and there was
-- no channel/origin check at all. Constraints are dropped and re-added rather
-- than altered, which Postgres does not support directly.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_cadence_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_cadence_check
  CHECK (cadence IN ('once','daily','weekly','monthly','quarterly','semiannual','yearly'));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_origin_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_origin_check
  CHECK (origin IN ('library','board','message'));

ALTER TABLE people DROP CONSTRAINT IF EXISTS people_channel_check;
ALTER TABLE people ADD CONSTRAINT people_channel_check
  CHECK (channel IN ('wa','em','both'));

ALTER TABLE people DROP CONSTRAINT IF EXISTS people_reminder_freq_check;
ALTER TABLE people ADD CONSTRAINT people_reminder_freq_check
  CHECK (reminder_freq IN ('2x','1x','alt','wk','2wk','mo'));

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_channel_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_check
  CHECK (channel IN ('wa','em'));

-- ------------------------------------------------------------------- RLS
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
