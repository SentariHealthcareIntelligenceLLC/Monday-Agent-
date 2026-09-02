-- =====================================================================
--  Migration 0001 — Dashboard core schema
--  QCMS Task Bot (SentariHealthcareIntelligenceLLC/Monday-Agent-)
--
--  Repackages supabase/schema.sql (repo @ 5ad9800) as a Supabase CLI
--  migration. Fully idempotent: safe on a fresh database AND on the live
--  "Monday Agent" project (xziunvsgzriuufcfdkvx), where it acts as the
--  §4.1 catch-up (people.awaiting_photo_run_id, messages.media_path,
--  WhatsApp message indexes).
--
--  STRUCTURE ONLY — no row is rewritten.
-- =====================================================================

-- ============================ ROLE MODEL =============================

CREATE TABLE IF NOT EXISTS roles (
  code            text PRIMARY KEY,
  label           text    NOT NULL,
  rank            integer NOT NULL,           -- 1 = owner, ascending downward
  is_clinical     integer NOT NULL DEFAULT 1,
  can_be_escalated_to integer NOT NULL DEFAULT 0,
  description     text
);

INSERT INTO roles (code, label, rank, is_clinical, can_be_escalated_to, description) VALUES
  ('owner',             'Owner',             1, 1, 1, 'Top of the chain. Final escalation target.'),
  ('manager',           'Manager',           2, 1, 1, 'First escalation target for unanswered tasks.'),
  ('or_supervisor',     'OR Supervisor',     3, 1, 0, 'Runs the angiosuite / OR floor.'),
  ('medical_assistant', 'Medical Assistant', 3, 1, 0, 'Clinical floor staff.'),
  ('virtual_assistant', 'Virtual Assistant', 4, 0, 0, 'Remote billing / scheduling staff.')
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  rank  = EXCLUDED.rank,
  is_clinical = EXCLUDED.is_clinical,
  can_be_escalated_to = EXCLUDED.can_be_escalated_to,
  description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS escalation_rules (
  id                bigserial PRIMARY KEY,
  level             integer NOT NULL UNIQUE,
  after_reminders   integer NOT NULL,
  notify_role       text    NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
  also_notify_owner integer NOT NULL DEFAULT 0,
  applies_to        text    NOT NULL DEFAULT 'task'
                      CHECK (applies_to IN ('task','credential','timeclock'))
);

INSERT INTO escalation_rules (level, after_reminders, notify_role, also_notify_owner, applies_to) VALUES
  (1, 4, 'manager', 0, 'task'),
  (2, 6, 'owner',   0, 'task')
ON CONFLICT (level) DO UPDATE SET
  after_reminders = EXCLUDED.after_reminders,
  notify_role     = EXCLUDED.notify_role,
  also_notify_owner = EXCLUDED.also_notify_owner;

-- ============================ FACILITIES =============================

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

CREATE TABLE IF NOT EXISTS facility_roles (
  id           bigserial PRIMARY KEY,
  facility_id  bigint REFERENCES facilities(id) ON DELETE CASCADE,
  role_label   text    NOT NULL,
  sort_order   integer NOT NULL DEFAULT 0,
  is_absence   integer NOT NULL DEFAULT 0,
  active       integer NOT NULL DEFAULT 1,
  UNIQUE (facility_id, role_label)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_facroles_absence
  ON facility_roles (role_label) WHERE facility_id IS NULL;

INSERT INTO facility_roles (facility_id, role_label, sort_order, is_absence)
SELECT NULL, v.label, v.ord, 1
FROM (VALUES ('Off — call out', 0), ('Call out sick', 1)) AS v(label, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM facility_roles f WHERE f.facility_id IS NULL AND f.role_label = v.label
);

-- ============================== PEOPLE ===============================

CREATE TABLE IF NOT EXISTS people (
  id                bigserial PRIMARY KEY,
  name              text    NOT NULL,
  role              text    NOT NULL,
  whatsapp_number   text    UNIQUE,          -- E.164 without '+'
  email             text,
  site              text,
  facility_id       bigint  REFERENCES facilities(id) ON DELETE SET NULL,
  employee_no       text,
  hired_on          text,
  languages         text,
  channel           text    NOT NULL DEFAULT 'wa',
  reminder_freq     text    NOT NULL DEFAULT '2x',
  reports_to_id     bigint  REFERENCES people(id) ON DELETE SET NULL,
  awaiting_photo_run_id bigint,
  timezone          text    NOT NULL DEFAULT 'America/Los_Angeles',
  active            integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE people ADD COLUMN IF NOT EXISTS facility_id   bigint REFERENCES facilities(id) ON DELETE SET NULL;
ALTER TABLE people ADD COLUMN IF NOT EXISTS employee_no   text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS hired_on      text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS languages     text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS channel       text NOT NULL DEFAULT 'wa';
ALTER TABLE people ADD COLUMN IF NOT EXISTS reminder_freq text NOT NULL DEFAULT '2x';
ALTER TABLE people ADD COLUMN IF NOT EXISTS awaiting_photo_run_id bigint;

-- =============================== TASKS ===============================

CREATE TABLE IF NOT EXISTS tasks (
  id            bigserial PRIMARY KEY,
  title         text    NOT NULL,
  details       text,
  category      text,
  cadence       text    NOT NULL,
  origin        text    NOT NULL DEFAULT 'library',
  weekday       integer,
  day_of_month  integer,
  month_of_year integer,
  lead_days     integer NOT NULL DEFAULT 0,
  due_date      text,
  due_time      text    NOT NULL DEFAULT '17:00',
  assignee_id   bigint  NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  facility_id   bigint  REFERENCES facilities(id) ON DELETE SET NULL,
  raised_by_id  bigint  REFERENCES people(id) ON DELETE SET NULL,
  source_message_id bigint,
  requires_photo integer NOT NULL DEFAULT 0,
  critical      integer NOT NULL DEFAULT 0,
  active        integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS month_of_year     integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lead_days         integer NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS facility_id       bigint REFERENCES facilities(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS requires_photo    integer NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS origin            text NOT NULL DEFAULT 'library';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date          text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS raised_by_id      bigint REFERENCES people(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_message_id bigint;

CREATE TABLE IF NOT EXISTS task_runs (
  id              bigserial PRIMARY KEY,
  task_id         bigint  NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  due_date        text    NOT NULL,
  status          text    NOT NULL DEFAULT 'pending',
  reminder_count  integer NOT NULL DEFAULT 0,
  escalated_level integer NOT NULL DEFAULT 0,
  reminded_at     timestamptz,
  nudged_at       timestamptz,
  responded_at    timestamptz,
  note            text,
  photo_path      text,
  escalated_at    timestamptz,
  UNIQUE (task_id, due_date)
);

ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS reminder_count  integer NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS escalated_level integer NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS photo_path      text;

-- ============================= MESSAGES ==============================

CREATE TABLE IF NOT EXISTS messages (
  id            bigserial PRIMARY KEY,
  direction     text NOT NULL,
  channel       text NOT NULL DEFAULT 'wa',
  person_id     bigint REFERENCES people(id) ON DELETE SET NULL,
  wa_number     text,
  wa_message_id text,
  body          text,
  kind          text,
  task_run_id   bigint REFERENCES task_runs(id) ON DELETE SET NULL,
  status        text,
  error         text,
  media_path    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel    text NOT NULL DEFAULT 'wa';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_path text;

-- =========================== CREDENTIALING ===========================

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

-- ====================== SCHEDULING / TIME CLOCK ======================

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

-- ============================= PLANNERS ==============================

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

-- ======================= DAILY LIFT / SETTINGS =======================

CREATE TABLE IF NOT EXISTS lift_items (
  id             bigserial PRIMARY KEY,
  category       text NOT NULL,
  body           text NOT NULL,
  audience_role  text REFERENCES roles(code) ON DELETE SET NULL,
  active         integer NOT NULL DEFAULT 1
);
ALTER TABLE lift_items ADD COLUMN IF NOT EXISTS audience_role text REFERENCES roles(code) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ============================ CONSTRAINTS ============================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM people p WHERE p.role NOT IN (SELECT code FROM roles)) THEN
    ALTER TABLE people DROP CONSTRAINT IF EXISTS people_role_fkey;
    ALTER TABLE people ADD CONSTRAINT people_role_fkey
      FOREIGN KEY (role) REFERENCES roles(code) ON DELETE RESTRICT;
  ELSE
    RAISE NOTICE 'people.role holds values not present in roles(code); FK not added. Fix those rows and re-run.';
  END IF;
END $$;

ALTER TABLE people DROP CONSTRAINT IF EXISTS people_role_check;

ALTER TABLE people DROP CONSTRAINT IF EXISTS people_channel_check;
ALTER TABLE people ADD CONSTRAINT people_channel_check
  CHECK (channel IN ('wa','em','both'));

ALTER TABLE people DROP CONSTRAINT IF EXISTS people_reminder_freq_check;
ALTER TABLE people ADD CONSTRAINT people_reminder_freq_check
  CHECK (reminder_freq IN ('2x','1x','alt','wk','2wk','mo'));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_cadence_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_cadence_check
  CHECK (cadence IN ('once','daily','weekly','monthly','quarterly','semiannual','yearly'));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_origin_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_origin_check
  CHECK (origin IN ('library','board','message'));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_once_needs_due_date;
ALTER TABLE tasks ADD CONSTRAINT tasks_once_needs_due_date
  CHECK (cadence <> 'once' OR due_date IS NOT NULL);

ALTER TABLE task_runs DROP CONSTRAINT IF EXISTS task_runs_status_check;
ALTER TABLE task_runs ADD CONSTRAINT task_runs_status_check
  CHECK (status IN ('pending','done','blocked','missed','snoozed'));

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_direction_check;
ALTER TABLE messages ADD CONSTRAINT messages_direction_check
  CHECK (direction IN ('out','in'));

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_channel_check;
ALTER TABLE messages ADD CONSTRAINT messages_channel_check
  CHECK (channel IN ('wa','em'));

-- ============================== INDEXES ==============================

CREATE INDEX IF NOT EXISTS idx_runs_due    ON task_runs(due_date, status);
CREATE INDEX IF NOT EXISTS idx_tasks_asn   ON tasks(assignee_id, active);
CREATE INDEX IF NOT EXISTS idx_tasks_cad   ON tasks(cadence, active);
CREATE INDEX IF NOT EXISTS idx_msgs_when   ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_people_role ON people(role, active);
CREATE INDEX IF NOT EXISTS idx_people_boss ON people(reports_to_id);

-- Webhook idempotency: Meta retries until it sees a 200.
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_wa_in
  ON messages(wa_message_id) WHERE direction = 'in' AND wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_wa_out
  ON messages(wa_message_id) WHERE direction = 'out';
CREATE INDEX IF NOT EXISTS idx_msg_person ON messages(person_id, created_at);

-- ======================== ROLE-AWARE VIEWS ===========================
--  All views are security_invoker so they can never read through RLS.

CREATE OR REPLACE VIEW v_chain_of_command
WITH (security_invoker = true) AS
WITH RECURSIVE chain AS (
  SELECT p.id AS person_id, p.reports_to_id AS boss_id, 1 AS depth
  FROM people p
  WHERE p.reports_to_id IS NOT NULL AND p.active = 1
  UNION ALL
  SELECT c.person_id, b.reports_to_id, c.depth + 1
  FROM chain c
  JOIN people b ON b.id = c.boss_id
  WHERE b.reports_to_id IS NOT NULL AND c.depth < 5
)
SELECT c.person_id, c.boss_id, c.depth,
       b.name AS boss_name, b.role AS boss_role,
       b.whatsapp_number AS boss_whatsapp, b.email AS boss_email, b.channel AS boss_channel
FROM chain c
JOIN people b ON b.id = c.boss_id
WHERE b.active = 1;

CREATE OR REPLACE VIEW v_open_task_runs
WITH (security_invoker = true) AS
SELECT r.id AS run_id, r.due_date, r.status, r.reminder_count, r.escalated_level,
       t.id AS task_id, t.title, t.cadence, t.origin, t.due_time,
       t.critical, t.requires_photo, t.lead_days,
       p.id AS person_id, p.name AS person_name, p.role AS person_role,
       f.name AS facility_name, f.code AS facility_code,
       (SELECT max(e.level) FROM escalation_rules e
         WHERE e.applies_to = 'task' AND r.reminder_count >= e.after_reminders) AS earned_level
FROM task_runs r
JOIN tasks  t ON t.id = r.task_id
JOIN people p ON p.id = t.assignee_id
LEFT JOIN facilities f ON f.id = t.facility_id
WHERE r.status IN ('pending','snoozed','blocked') AND p.active = 1;

CREATE OR REPLACE VIEW v_person_completion
WITH (security_invoker = true) AS
SELECT p.id, p.name, p.role,
       count(*) AS total,
       sum(CASE WHEN r.status = 'done'   THEN 1 ELSE 0 END) AS done,
       sum(CASE WHEN r.status = 'missed' THEN 1 ELSE 0 END) AS missed,
       sum(CASE WHEN r.status = 'blocked' THEN 1 ELSE 0 END) AS blocked
FROM task_runs r
JOIN tasks  t ON t.id = r.task_id
JOIN people p ON p.id = t.assignee_id
GROUP BY p.id, p.name, p.role;

-- ======================= ROW LEVEL SECURITY ==========================
--  RLS on, no permissive policies here. The service (service_role) is
--  the only writer. Read policies for authenticated dashboard users are
--  added in 0002 (Supabase Auth).

ALTER TABLE roles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_rules  ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_views    ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_roles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE people            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks             ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_runs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials       ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE punches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE planner_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE lift_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

-- ====================== RECORD AS APPLIED ============================

INSERT INTO schema_migrations (filename) VALUES
  ('001_expand_schema.sql'),
  ('002_whatsapp_delivery.sql'),
  ('supabase/schema.sql'),
  ('20260901000001_dashboard_core.sql')
ON CONFLICT (filename) DO NOTHING;
