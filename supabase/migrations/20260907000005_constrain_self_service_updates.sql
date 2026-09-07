-- =====================================================================
--  Migration 006 — Constrain self-service updates
--
--  Fixes two gaps in the 003 policies, both reported on PR #2:
--
--  1. profiles_self_update pinned app_role and person_id but not `active`.
--     A deactivated user whose Auth session still existed could set
--     active = true on their own row and restore every permission the
--     role helpers grant. Now active and email are pinned too, so the
--     display name is genuinely the only self-editable field.
--
--  2. task_runs_self_update let staff write ANY column of their own runs.
--     RLS is row-level: WITH CHECK confirmed the row still belonged to
--     them, but not that they only touched status/note/photo. Staff could
--     rewrite due_date, reminder_count, escalated_level or move a run to
--     another of their tasks, corrupting scheduling and escalation
--     history.
--
--     Column-level GRANTs cannot express this: owner/manager are also the
--     `authenticated` role, so revoking UPDATE would disarm the dashboard
--     admin path as well. A BEFORE UPDATE trigger clamps the protected
--     columns back to their previous values for non-admins instead, and
--     exits early for service_role/postgres so the Node service and the
--     cron jobs are untouched.
--
--  Also pinned after review: profiles.created_at (audit metadata was still
--  client-writable), the set of statuses staff may set (done/blocked/
--  snoozed only -- 'missed' and 'pending' belong to the scheduler), and
--  responded_at, which is now server-derived rather than client-supplied.
--
--  Idempotent; safe to re-run. A copy ships under supabase/migrations/ so
--  the `supabase db push` / SQL Editor path applies it too.
-- =====================================================================

-- ===================== 1. PROFILES SELF-UPDATE =======================

DROP POLICY IF EXISTS profiles_self_update ON profiles;
CREATE POLICY profiles_self_update ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND app_role  = (SELECT p2.app_role  FROM profiles p2 WHERE p2.id = auth.uid())
    AND active    = (SELECT p2.active    FROM profiles p2 WHERE p2.id = auth.uid())
    AND email  IS NOT DISTINCT FROM (SELECT p2.email     FROM profiles p2 WHERE p2.id = auth.uid())
    AND person_id IS NOT DISTINCT FROM (SELECT p2.person_id FROM profiles p2 WHERE p2.id = auth.uid())
    AND created_at = (SELECT p2.created_at FROM profiles p2 WHERE p2.id = auth.uid())
  );

-- =================== 2. TASK_RUNS COLUMN CLAMP =======================

CREATE OR REPLACE FUNCTION clamp_task_run_self_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- No end-user session means this is the Node service, a cron job or local
  -- tooling, which connect straight to Postgres with no JWT and own the
  -- scheduling columns. Note this deliberately does NOT test current_user:
  -- in a SECURITY DEFINER function that reports the function owner, not the
  -- caller, which would skip the clamp for everyone.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Dashboard owner/manager edit runs freely.
  IF coalesce(app_is_admin(), false) THEN
    RETURN NEW;
  END IF;

  -- Staff may only report on their own work: complete it, block it, or
  -- snooze it. 'missed' and 'pending' are outcomes the scheduler decides,
  -- and letting a client set them would hide or silently reopen work.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status NOT IN ('done', 'blocked', 'snoozed') THEN
    RAISE EXCEPTION 'staff may only set task_runs.status to done, blocked or snoozed (got %)', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- responded_at is audit metadata: server-derived on a real status change,
  -- otherwise preserved. A client-supplied value is never trusted.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.responded_at := now();
  ELSE
    NEW.responded_at := OLD.responded_at;
  END IF;

  -- Anything that drives scheduling or escalation keeps its old value.
  NEW.task_id         := OLD.task_id;
  NEW.due_date        := OLD.due_date;
  NEW.reminder_count  := OLD.reminder_count;
  NEW.escalated_level := OLD.escalated_level;
  NEW.escalated_at    := OLD.escalated_at;
  NEW.reminded_at     := OLD.reminded_at;
  NEW.nudged_at       := OLD.nudged_at;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION clamp_task_run_self_update() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_task_runs_clamp ON task_runs;
CREATE TRIGGER trg_task_runs_clamp
  BEFORE UPDATE ON task_runs
  FOR EACH ROW EXECUTE FUNCTION clamp_task_run_self_update();

INSERT INTO schema_migrations (filename) VALUES ('006_constrain_self_service_updates.sql')
ON CONFLICT (filename) DO NOTHING;
