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
--  3. A 'viewer' signup whose email matched an active people row was linked
--     to that person immediately by handle_new_user(), and
--     app_current_person_id() never checked app_role. Every self-service
--     policy keys off that person id, so an unapproved signup could read
--     the employee's tasks, messages, credentials, shifts and punches and
--     update their runs before any admin promoted the account. 003's own
--     comment says new signups land "with no person link"; the code did
--     not match. The helper now yields a person id only for an approved
--     role, so a viewer sees reference data and nothing else.
--
--  Also pinned after review: profiles.created_at (audit metadata was still
--  client-writable), the set of statuses staff may set (done/blocked/
--  snoozed only -- 'missed' and 'pending' belong to the scheduler), and
--  responded_at, which is now server-derived rather than client-supplied.
--
--  Idempotent; safe to re-run. A copy ships under supabase/migrations/ so
--  the `supabase db push` / SQL Editor path applies it too.
-- =====================================================================

-- ============== 0. VIEWERS RESOLVE TO NO PERSON LINK =================
--  Gate the helper rather than the individual policies: every self-service
--  policy already routes through it, so one change closes them all.

CREATE OR REPLACE FUNCTION app_current_person_id()
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.person_id FROM profiles p
  WHERE p.id = auth.uid()
    AND p.active
    AND p.app_role IN ('owner', 'manager', 'staff')
$$;

REVOKE ALL ON FUNCTION app_current_person_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_current_person_id() TO authenticated;

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

  -- A finalized run is a closed record -- not just its status. Checking only
  -- the status change would still let a staff client rewrite the note or
  -- replace/remove the stored photo proof on a settled run while leaving
  -- 'done' in place, so every staff-writable field is compared here. Only an
  -- admin or the service touches a finalized run.
  IF OLD.status IN ('done', 'missed')
     AND (NEW.status     IS DISTINCT FROM OLD.status
       OR NEW.note       IS DISTINCT FROM OLD.note
       OR NEW.photo_path IS DISTINCT FROM OLD.photo_path) THEN
    RAISE EXCEPTION 'task_run % is already %; staff cannot change a finalized run', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Photo-proof tasks are not complete without proof. The webhook path
  -- verifies and stores the image; this stops a direct PostgREST call from
  -- marking the run done with no proof attached at all. SQL cannot judge
  -- whether the referenced object is a genuine photo -- that remains the
  -- storage layer's job -- but an empty photo_path is unambiguous.
  IF NEW.status = 'done' AND NEW.photo_path IS NULL
     AND EXISTS (SELECT 1 FROM tasks t
                 WHERE t.id = OLD.task_id AND t.requires_photo = 1) THEN
    RAISE EXCEPTION 'task_run % requires photo proof before it can be marked done', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- responded_at is audit metadata: server-derived on a real status change,
  -- otherwise preserved. A client-supplied value is never trusted.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.responded_at := now();
  ELSE
    NEW.responded_at := OLD.responded_at;
  END IF;

  -- Anything that drives scheduling or escalation keeps its old value. The
  -- primary key is included: RLS authorizes through task_id and says nothing
  -- about id, so without this a staff client could rewrite a run's identity
  -- or push the id past the sequence and make a later scheduler insert fail.
  NEW.id              := OLD.id;
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
