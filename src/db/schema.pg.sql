-- QCMS Task Bot schema (PostgreSQL / Supabase)
-- Ported from schema.sql. Booleans stay as integer 0/1 so application
-- predicates like `active = 1` work unchanged across both backends.

CREATE TABLE IF NOT EXISTS people (
  id                bigserial PRIMARY KEY,
  name              text    NOT NULL,
  role              text    NOT NULL CHECK (role IN (
                      'owner','manager','medical_assistant','virtual_assistant','or_supervisor')),
  whatsapp_number   text    UNIQUE,          -- E.164 without '+', e.g. 15551234567
  email             text,
  site              text,                    -- clinic / surgery center
  reports_to_id     bigint  REFERENCES people(id) ON DELETE SET NULL,
  timezone          text    NOT NULL DEFAULT 'America/Los_Angeles',
  active            integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id            bigserial PRIMARY KEY,
  title         text    NOT NULL,
  details       text,
  category      text,                        -- scheduling, insurance, inventory, credentialing, billing, or_readiness
  cadence       text    NOT NULL CHECK (cadence IN ('daily','weekly','monthly')),
  weekday       integer,                     -- 1=Mon .. 7=Sun (weekly only)
  day_of_month  integer,                     -- 1..28 (monthly only)
  due_time      text    NOT NULL DEFAULT '17:00',
  assignee_id   bigint  NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  critical      integer NOT NULL DEFAULT 0,  -- escalates same day if missed
  active        integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per task per occurrence date
CREATE TABLE IF NOT EXISTS task_runs (
  id            bigserial PRIMARY KEY,
  task_id       bigint  NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  due_date      text    NOT NULL,            -- YYYY-MM-DD (local tz)
  status        text    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','done','blocked','missed','snoozed')),
  reminded_at   timestamptz,
  nudged_at     timestamptz,
  responded_at  timestamptz,
  note          text,
  escalated_at  timestamptz,
  UNIQUE (task_id, due_date)
);

CREATE TABLE IF NOT EXISTS messages (
  id            bigserial PRIMARY KEY,
  direction     text NOT NULL CHECK (direction IN ('out','in')),
  person_id     bigint REFERENCES people(id) ON DELETE SET NULL,
  wa_number     text,
  wa_message_id text,
  body          text,
  kind          text,                         -- reminder | nudge | escalation | reply | ack
  task_run_id   bigint REFERENCES task_runs(id) ON DELETE SET NULL,
  status        text,                         -- sent | failed | dry_run | received
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runs_due  ON task_runs(due_date, status);
CREATE INDEX IF NOT EXISTS idx_tasks_asn ON tasks(assignee_id, active);
CREATE INDEX IF NOT EXISTS idx_msgs_when ON messages(created_at);

-- This service connects with the service role and is the only writer, so RLS
-- is enabled with no permissive policy: anon/authenticated keys read nothing.
ALTER TABLE people    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages  ENABLE ROW LEVEL SECURITY;
