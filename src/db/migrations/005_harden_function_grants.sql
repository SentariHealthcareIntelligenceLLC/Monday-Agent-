-- =====================================================================
--  Migration 005 — Harden function search_path and grants
--
--  Postgres grants EXECUTE on new functions to PUBLIC by default, which
--  publishes each one at /rest/v1/rpc/<name>. Trigger helpers are invoked
--  by their triggers and must never be callable over PostgREST; the role
--  helpers are for signed-in users only.
--
--  This mirrors the `harden_function_grants` migration already applied to
--  the live "Monday Agent" project (xziunvsgzriuufcfdkvx) on 2026-09-02.
--  That project was migrated from a LATER generation of the pack than the
--  files in this repo, and its role helpers carry different names
--  (current_app_role / is_dashboard_admin / current_person_id) than the
--  ones 003 defines (app_current_role / app_is_admin /
--  app_current_person_id). Both naming sets are handled below, and each
--  function is only touched if it actually exists, so this file is correct
--  on a fresh database, in CI, and against the live project alike.
--
--  Ordering note: 003 defines touch_updated_at() WITHOUT a pinned
--  search_path. Re-running 003 over an already-hardened database silently
--  removes that pin, so this file must run after it and stay last.
--  Idempotent; safe to re-run.
-- =====================================================================

-- Pin search_path on the trigger helper (CREATE OR REPLACE keeps grants,
-- so the REVOKE below still applies afterwards).
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- Trigger helpers: callable by nobody over the API.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['touch_updated_at','handle_new_user',
                            'apply_wa_delivery_status','touch_wa_contact_window'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = fn) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM public, anon, authenticated', fn);
    END IF;
  END LOOP;
END $$;

-- Role helpers: signed-in users only; anon must not be able to probe them.
-- Covers this repo's names and the live project's earlier-generation names.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['app_current_role','app_is_admin','app_current_person_id',
                            'current_app_role','is_dashboard_admin','current_person_id'] LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = fn) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM public, anon', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I() TO authenticated', fn);
    END IF;
  END LOOP;
END $$;

INSERT INTO schema_migrations (filename)
VALUES ('supabase/migrations/20260902081530_harden_function_grants.sql')
ON CONFLICT (filename) DO NOTHING;
