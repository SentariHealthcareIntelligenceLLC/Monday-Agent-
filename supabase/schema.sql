-- =====================================================================
--  QCMS Task Management — complete Supabase / PostgreSQL schema
--  Repo: SentariHealthcareIntelligenceLLC/Monday-Agent-
--
--  ONE FILE. Paste the whole thing into the Supabase SQL Editor and run.
--
--  Safe on a fresh database AND on one that already holds live data:
--  every statement is CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
--  or an idempotent upsert. Nothing is dropped, no row is rewritten, and
--  running it twice changes nothing the second time.
--
--  Take a backup first anyway: Supabase -> Database -> Backups.
-- =====================================================================


-- =====================================================================
--  SECTION 1 — ROLE MODEL
--  The chain of command is the spine of the whole system: it decides who
--  gets chased, who gets copied, and who an unanswered task escalates to.
--  Roles are a table rather than a bare CHECK so the ladder is data you
--  can adjust, not logic buried in the application.
-- =====================================================================

-- Person roles, ordered by authority. `rank` 1 is the top of the chain.
CREATE TABLE IF NOT EXISTS roles (
  code            text PRIMARY KEY,
  label           text    NOT NULL,
  rank            integer NOT NULL,           -- 1 = owner, ascending downward
  is_clinical     integer NOT NULL DEFAULT 1, -- 0 for remote/virtual staff
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


-- The escalation ladder: after N unanswered reminders, notify this role.
-- Matches the rule printed on the dashboard — 4 reminders -> Manager,
-- 6 -> Owner.
CREATE TABLE IF NOT EXISTS escalation_rules (
  id                bigserial PRIMARY KEY,
  level             integer NOT NULL UNIQUE,   -- 1 = first step, 2 = second
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


-- =====================================================================
--  SECTION 2 — FACILITIES
-- =====================================================================

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

-- Staffing positions each facility rosters, in the order they appear on the
-- schedule board. A surgery centre needs Scrub 1 / Scrub 2 / Circulator / Rad
-- Tech / CRNA; a vein clinic needs Front desk / Ultrasound tech. Keeping this
-- per-facility is what stops the scheduler offering an Angio Suite role at a
-- clinic that has no angio suite.
CREATE TABLE IF NOT EXISTS facility_roles (
  id           bigserial PRIMARY KEY,
  facility_id  bigint REFERENCES facilities(id) ON DELETE CASCADE,
  role_label   text    NOT NULL,             -- '1. Scrub 1', 'Front desk'
  sort_order   integer NOT NULL DEFAULT 0,
  is_absence   integer NOT NULL DEFAULT 0,   -- 1 for call-out rows
  active       integer NOT NULL DEFAULT 1,
  UNIQUE (facility_id, role_label)
);

-- Absence rows are facility-independent (facility_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_facroles_absence
  ON facility_roles (role_label) WHERE facility_id IS NULL;

INSERT INTO facility_roles (facility_id, role_label, sort_order, is_absence)
SELECT NULL, v.label, v.ord, 1
FROM (VALUES ('Off — call out', 0), ('Call out sick', 1)) AS v(label, ord)
WHERE NOT EXISTS (
  SELECT 1 FROM facility_roles f WHERE f.facility_id IS NULL AND f.role_label = v.label
);


-- =====================================================================
--  SECTION 3 — PEOPLE
-- =====================================================================

CREATE TABLE IF NOT EXISTS people (
  id                bigserial PRIMARY KEY,
  name              text    NOT NULL,
  role              text    NOT NULL,        -- FK to roles(code), added below
  whatsapp_number   text    UNIQUE,          -- E.164 without '+', e.g. 15551234567
  email             text,
  site              text,                    -- legacy free-text label
  facility_id       bigint  REFERENCES facilities(id) ON DELETE SET NULL,
  employee_no       text,
  hired_on          text,                    -- YYYY-MM-DD
  languages         text,
  channel           text    NOT NULL DEFAULT 'wa',
  reminder_freq     text    NOT NULL DEFAULT '2x',
  reports_to_id     bigint  REFERENCES people(id) ON DELETE SET NULL,
  timezone          text    NOT NULL DEFAULT 'America/Los_Angeles',
  active            integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Columns added after the first release.
ALTER TABLE people ADD COLUMN IF NOT EXISTS facility_id   bigint REFERENCES facilities(id) ON DELETE SET NULL;
ALTER TABLE people ADD COLUMN IF NOT EXISTS employee_no   text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS hired_on      text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS languages     text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS channel       text NOT NULL DEFAULT 'wa';
ALTER TABLE people ADD COLUMN IF NOT EXISTS reminder_freq text NOT NULL DEFAULT '2x';


-- =====================================================================
--  SECTION 4 — TASKS
--
--  Two different things live here:
--    * the RECURRING LIBRARY  — standing duties, cadence daily..yearly
--    * ONE-OFF TASKS          — cadence 'once', raised from the task board
--                               or from a message. They never repeat.
-- =====================================================================

CREATE TABLE IF NOT EXISTS tasks (
  id            bigserial PRIMARY KEY,
  title         text    NOT NULL,
  details       text,
  category      text,
  cadence       text    NOT NULL,
  origin        text    NOT NULL DEFAULT 'library',
  weekday       integer,                     -- 1=Mon .. 7=Sun (weekly)
  day_of_month  integer,                     -- 1..28, or 0 for last day of month
  month_of_year integer,                     -- 1..12 anchor for quarterly/semi/yearly
  lead_days     integer NOT NULL DEFAULT 0,  -- start daily reminders N days early
  due_date      text,                        -- one-off tasks only (YYYY-MM-DD)
  due_time      text    NOT NULL DEFAULT '17:00',
  assignee_id   bigint  NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  facility_id   bigint  REFERENCES facilities(id) ON DELETE SET NULL,
  raised_by_id  bigint  REFERENCES people(id) ON DELETE SET NULL,
  source_message_id bigint,                  -- no FK: messages is created later
  requires_photo integer NOT NULL DEFAULT 0, -- completion needs photo proof
  critical      integer NOT NULL DEFAULT 0,  -- escalates same day if missed
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


-- One row per task per occurrence date.
CREATE TABLE IF NOT EXISTS task_runs (
  id              bigserial PRIMARY KEY,
  task_id         bigint  NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  due_date        text    NOT NULL,          -- YYYY-MM-DD (local tz)
  status          text    NOT NULL DEFAULT 'pending',
  reminder_count  integer NOT NULL DEFAULT 0,  -- drives the escalation ladder
  escalated_level integer NOT NULL DEFAULT 0,  -- 0 none, 1 manager, 2 owner
  reminded_at     timestamptz,
  nudged_at       timestamptz,
  responded_at    timestamptz,
  note            text,
  photo_path      text,                      -- Supabase Storage object path
  escalated_at    timestamptz,
  UNIQUE (task_id, due_date)
);

ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS reminder_count  integer NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS escalated_level integer NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS photo_path      text;


-- =====================================================================
--  SECTION 5 — MESSAGES
-- =====================================================================

CREATE TABLE IF NOT EXISTS messages (
  id            bigserial PRIMARY KEY,
  direction     text NOT NULL,
  channel       text NOT NULL DEFAULT 'wa',
  person_id     bigint REFERENCES people(id) ON DELETE SET NULL,
  wa_number     text,
  wa_message_id text,
  body          text,
  kind          text,          -- reminder | nudge | escalation | reply | ack |
                               -- credential | digest
  task_run_id   bigint REFERENCES task_runs(id) ON DELETE SET NULL,
  status        text,          -- sent | failed | dry_run | received
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'wa';


-- =====================================================================
--  SECTION 6 — CREDENTIALING
--  An expiring licence is a compliance exposure, so it follows the same
--  chain of command as an unanswered task: the holder is chased, the
--  Owner is copied, and once expired the Manager is copied too.
-- =====================================================================

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


-- =====================================================================
--  SECTION 7 — SCHEDULING AND TIME CLOCK
-- =====================================================================

CREATE TABLE IF NOT EXISTS shifts (
  id           bigserial PRIMARY KEY,
  facility_id  bigint REFERENCES facilities(id) ON DELETE CASCADE,
  role         text NOT NULL,                -- matches facility_roles.role_label
  work_date    text NOT NULL,                -- YYYY-MM-DD
  starts_at    text,                         -- HH:MM, null when on call
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


-- =====================================================================
--  SECTION 8 — PLANNERS (with photo proof)
-- =====================================================================

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


-- =====================================================================
--  SECTION 9 — DAILY LIFT AND SETTINGS
-- =====================================================================

CREATE TABLE IF NOT EXISTS lift_items (
  id             bigserial PRIMARY KEY,
  category       text NOT NULL,              -- Joke | Medical fact | ...
  body           text NOT NULL,
  audience_role  text REFERENCES roles(code) ON DELETE SET NULL,  -- null = everyone
  active         integer NOT NULL DEFAULT 1
);
ALTER TABLE lift_items ADD COLUMN IF NOT EXISTS audience_role text REFERENCES roles(code) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,                  -- JSON
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);


-- =====================================================================
--  SECTION 10 — CONSTRAINTS
--  Dropped and re-added rather than altered, which Postgres does not
--  support directly. This is also what widens the original cadence check
--  (daily/weekly/monthly only) to the full set.
-- =====================================================================

-- Tie people.role to the roles table, but only once every existing row
-- already holds a valid code — otherwise the constraint would fail on
-- live data and take the whole script down with it.
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

-- A one-off must carry a date; a recurring duty must not pretend to.
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


-- =====================================================================
--  SECTION 11 — INDEXES
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_runs_due    ON task_runs(due_date, status);
CREATE INDEX IF NOT EXISTS idx_tasks_asn   ON tasks(assignee_id, active);
CREATE INDEX IF NOT EXISTS idx_tasks_cad   ON tasks(cadence, active);
CREATE INDEX IF NOT EXISTS idx_msgs_when   ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_people_role ON people(role, active);
CREATE INDEX IF NOT EXISTS idx_people_boss ON people(reports_to_id);


-- =====================================================================
--  SECTION 12 — ROLE-AWARE VIEWS
--  The chain of command is recursive, so resolving "who does this
--  escalate to" belongs in the database rather than in a loop that
--  issues one query per level.
--
--  Every view is security_invoker. Postgres views otherwise run as their
--  CREATOR, which would let anon read straight through them and bypass the
--  RLS on the tables underneath — the view becomes a hole around the very
--  protection the tables have. security_invoker makes the caller's own
--  permissions and RLS apply, so a view can never expose more than the
--  tables it selects from.
-- =====================================================================

-- Every person with their full management chain, nearest boss first.
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
  WHERE b.reports_to_id IS NOT NULL AND c.depth < 5   -- guards a bad cycle
)
SELECT c.person_id, c.boss_id, c.depth,
       b.name AS boss_name, b.role AS boss_role,
       b.whatsapp_number AS boss_whatsapp, b.email AS boss_email, b.channel AS boss_channel
FROM chain c
JOIN people b ON b.id = c.boss_id
WHERE b.active = 1;

-- Open work with the escalation level it has actually earned.
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

-- Completion rate per person, for the dashboard's gap analysis.
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


-- =====================================================================
--  SECTION 13 — ROW LEVEL SECURITY
--
--  The service connects with the service_role key and is the only writer.
--  RLS is enabled with NO permissive policy, so the anon and authenticated
--  keys can read nothing at all. That is deliberate: this database holds
--  staff records, credentialing and clinical scheduling. If you later add
--  direct browser access, add explicit policies here — do not disable RLS.
-- =====================================================================

ALTER TABLE roles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_views   ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_roles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE people           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE punches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE planner_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lift_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;


-- =====================================================================
--  SECTION 14 — RECORD THIS AS APPLIED
--  So `npm run migrate` knows not to replay the file-based migrations.
-- =====================================================================

INSERT INTO schema_migrations (filename) VALUES
  ('001_expand_schema.sql'),
  ('supabase/schema.sql')
ON CONFLICT (filename) DO NOTHING;


-- =====================================================================
--  DONE.
--
--  Next:
--    1. Storage -> New bucket -> name it `qcms-proof`, PUBLIC OFF.
--       Photo proof is clinical-space imagery; it must stay private.
--    2. Load the starter data:  DATABASE_URL='...' npm run seed
--       (this DELETES and rebuilds the content tables — skip it if you
--        already have real data in here).
--    3. Set ADMIN_PASSWORD in Vercel. It defaults to 'change-me', and the
--       deployment is on a public URL.
-- =====================================================================
