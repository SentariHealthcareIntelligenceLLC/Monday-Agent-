-- =====================================================================
--  Repo-native copy for `npm run migrate` (src/db/migrations runner).
--  Identical to the supabase/migrations CLI file of the same content;
--  whichever applies first records both names, the other becomes a no-op.
--
--  LOCAL-DEV SHIM: a plain Postgres (brew/Docker) has no Supabase auth
--  schema or API roles. This block creates minimal stand-ins so the
--  migration applies cleanly in local dev. On Supabase every condition
--  is false and the block does nothing.
-- =====================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'CREATE ROLE anon NOLOGIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'CREATE ROLE authenticated NOLOGIN';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    EXECUTE 'CREATE SCHEMA IF NOT EXISTS auth';
    EXECUTE 'CREATE TABLE IF NOT EXISTS auth.users(
               id uuid PRIMARY KEY,
               email text,
               raw_user_meta_data jsonb DEFAULT ''{}''::jsonb)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'auth' AND p.proname = 'uid') THEN
    EXECUTE 'CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS ''SELECT NULL::uuid''';
  END IF;
END $$;

-- =====================================================================
--  Migration 0002 — User authentication (Supabase Auth + profiles)
--
--  Adds real per-user login on top of the existing schema:
--    * profiles           — one row per auth.users row, linked to people
--    * app-role helpers   — SECURITY DEFINER, avoid RLS recursion
--    * auto-provisioning  — trigger creates a profile on signup
--    * RLS policies       — owner/manager see everything; staff see
--                           their own work. service_role is untouched
--                           (it bypasses RLS), so the existing Node
--                           service keeps working unchanged.
--
--  Design rules preserved from HANDOFF.md:
--    * No permissive policy is granted to anon — anon still reads nothing.
--    * Views remain security_invoker; these table policies are what an
--      authenticated dashboard session reads through them.
--  Idempotent; safe to re-run.
-- =====================================================================

-- ============================ PROFILES ===============================

CREATE TABLE IF NOT EXISTS profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text UNIQUE,
  full_name   text,
  -- Dashboard access level. Independent of the operational chain of
  -- command (people.role), but usually mirrors it.
  app_role    text NOT NULL DEFAULT 'staff'
                CHECK (app_role IN ('owner','manager','staff','viewer')),
  -- Link into the operational org chart. Staff policies key off this.
  person_id   bigint UNIQUE REFERENCES people(id) ON DELETE SET NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_person ON profiles(person_id);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- ======================= ROLE HELPER FUNCTIONS =======================
--  SECURITY DEFINER so policies on other tables can consult profiles
--  without recursing into profiles' own RLS. search_path pinned.

CREATE OR REPLACE FUNCTION app_current_role()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.app_role FROM profiles p
  WHERE p.id = auth.uid() AND p.active
$$;

CREATE OR REPLACE FUNCTION app_current_person_id()
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.person_id FROM profiles p
  WHERE p.id = auth.uid() AND p.active
$$;

CREATE OR REPLACE FUNCTION app_is_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(app_current_role() IN ('owner','manager'), false)
$$;

REVOKE ALL ON FUNCTION app_current_role()      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_current_person_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_is_admin()          FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_current_role()      TO authenticated;
GRANT EXECUTE ON FUNCTION app_current_person_id() TO authenticated;
GRANT EXECUTE ON FUNCTION app_is_admin()          TO authenticated;

-- ==================== AUTO-PROVISION ON SIGNUP =======================
--  New signups land as 'viewer' with no person link: they can log in but
--  see nothing until an owner/manager assigns app_role + person_id.
--  Matching is attempted on email against people.email.

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, app_role, person_id)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    'viewer',
    (SELECT p.id FROM people p
      WHERE lower(p.email) = lower(NEW.email) AND p.active = 1
      LIMIT 1)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- updated_at maintenance
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_profiles_touch ON profiles;
CREATE TRIGGER trg_profiles_touch
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ======================= PROFILES POLICIES ===========================

DROP POLICY IF EXISTS profiles_self_read   ON profiles;
DROP POLICY IF EXISTS profiles_admin_read  ON profiles;
DROP POLICY IF EXISTS profiles_self_update ON profiles;
DROP POLICY IF EXISTS profiles_admin_write ON profiles;

CREATE POLICY profiles_self_read ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY profiles_admin_read ON profiles
  FOR SELECT TO authenticated
  USING (app_is_admin());

-- Users may edit their own display name only; role/person changes are
-- blocked by the WITH CHECK re-asserting current values via subselect.
CREATE POLICY profiles_self_update ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND app_role  = (SELECT p2.app_role  FROM profiles p2 WHERE p2.id = auth.uid())
    AND person_id IS NOT DISTINCT FROM (SELECT p2.person_id FROM profiles p2 WHERE p2.id = auth.uid())
  );

CREATE POLICY profiles_admin_write ON profiles
  FOR ALL TO authenticated
  USING (app_is_admin())
  WITH CHECK (app_is_admin());

-- ================= DASHBOARD READ/WRITE POLICIES =====================
--  owner/manager: full read on operational tables, plus writes the
--  dashboard needs. staff: read own tasks/runs/messages/credentials/
--  shifts/punches/planner rows, update status on their own task_runs.
--  viewer: reference data only. anon: nothing (unchanged).

-- Reference data readable by any active authenticated user.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles','escalation_rules','facilities','facility_views','facility_roles'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_auth_read ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_auth_read ON %I FOR SELECT TO authenticated
         USING (app_current_role() IS NOT NULL)', t, t);
  END LOOP;
END $$;

-- Admin (owner/manager) full read on everything operational.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['people','tasks','task_runs','messages','credentials',
                           'shifts','punches','planner_items','lift_items','settings'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_admin_read ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_admin_read ON %I FOR SELECT TO authenticated
         USING (app_is_admin())', t, t);
  END LOOP;
END $$;

-- Admin writes for tables the dashboard edits directly.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['people','tasks','task_runs','credentials','shifts',
                           'punches','planner_items','lift_items','settings',
                           'facilities','facility_views','facility_roles',
                           'escalation_rules'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_admin_write ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_admin_write ON %I FOR ALL TO authenticated
         USING (app_is_admin()) WITH CHECK (app_is_admin())', t, t);
  END LOOP;
END $$;

-- Staff: own person row.
DROP POLICY IF EXISTS people_self_read ON people;
CREATE POLICY people_self_read ON people
  FOR SELECT TO authenticated
  USING (id = app_current_person_id());

-- Staff: own tasks and their runs.
DROP POLICY IF EXISTS tasks_self_read ON tasks;
CREATE POLICY tasks_self_read ON tasks
  FOR SELECT TO authenticated
  USING (assignee_id = app_current_person_id());

DROP POLICY IF EXISTS task_runs_self_read ON task_runs;
CREATE POLICY task_runs_self_read ON task_runs
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM tasks t
                 WHERE t.id = task_runs.task_id
                   AND t.assignee_id = app_current_person_id()));

-- Staff may complete/block/snooze their own runs from the dashboard.
DROP POLICY IF EXISTS task_runs_self_update ON task_runs;
CREATE POLICY task_runs_self_update ON task_runs
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM tasks t
                 WHERE t.id = task_runs.task_id
                   AND t.assignee_id = app_current_person_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM tasks t
                      WHERE t.id = task_runs.task_id
                        AND t.assignee_id = app_current_person_id()));

-- Staff: own message history, credentials, shifts, punches, planner.
DROP POLICY IF EXISTS messages_self_read ON messages;
CREATE POLICY messages_self_read ON messages
  FOR SELECT TO authenticated
  USING (person_id = app_current_person_id());

DROP POLICY IF EXISTS credentials_self_read ON credentials;
CREATE POLICY credentials_self_read ON credentials
  FOR SELECT TO authenticated
  USING (person_id = app_current_person_id());

DROP POLICY IF EXISTS shifts_self_read ON shifts;
CREATE POLICY shifts_self_read ON shifts
  FOR SELECT TO authenticated
  USING (person_id = app_current_person_id());

DROP POLICY IF EXISTS punches_self_read ON punches;
CREATE POLICY punches_self_read ON punches
  FOR SELECT TO authenticated
  USING (person_id = app_current_person_id());

DROP POLICY IF EXISTS planner_self_read ON planner_items;
CREATE POLICY planner_self_read ON planner_items
  FOR SELECT TO authenticated
  USING (person_id = app_current_person_id());

-- Everyone active can read the daily lift.
DROP POLICY IF EXISTS lift_auth_read ON lift_items;
CREATE POLICY lift_auth_read ON lift_items
  FOR SELECT TO authenticated
  USING (app_current_role() IS NOT NULL);

-- ====================== RECORD AS APPLIED ============================

-- Also record the repo-native copy's name so `npm run migrate` skips it.
INSERT INTO schema_migrations (filename)
VALUES ('20260901000002_auth_profiles.sql')
ON CONFLICT (filename) DO NOTHING;
