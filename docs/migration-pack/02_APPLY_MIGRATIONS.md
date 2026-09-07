# Step 02 — Apply the three migrations, in filename order

**Purpose:** bring the database to the 2026-09-01 schema (dashboard core + Supabase Auth
+ WhatsApp connections).

**Preconditions:** step 01 passed. Order is mandatory — file 2 defines
`touch_updated_at()` and the `app_*` role helpers that file 3 uses.

## Actions

Run each file completely, one at a time, via SQL Editor paste or
`supabase link --project-ref xziunvsgzriuufcfdkvx && supabase db push`:

| Order | File | What it does |
|---|---|---|
| 1 | `20260901000001_dashboard_core.sql` | Full dashboard schema (16 tables, security-invoker views, RLS enabled). On the live DB it also applies the pending catch-up: `people.awaiting_photo_run_id`, `messages.media_path`, WhatsApp message indexes. |
| 2 | `20260901000002_auth_profiles.sql` | `profiles` linked to `auth.users` + `people`, signup auto-provision trigger (new users = `viewer`), SECURITY DEFINER role helpers, role-based RLS (owner/manager full, staff own rows, anon nothing). |
| 3 | `20260901000003_whatsapp_connections.sql` | `whatsapp_accounts` (Vault secret names only), `whatsapp_contacts` (opt-in + 24 h session window), deduped `whatsapp_webhook_events`, `whatsapp_delivery_status` → rolls onto `messages.delivery_status`, view `v_wa_session_open`. |
| 4 | `20260907000004_harden_function_grants.sql` | Pins `search_path` on the trigger helpers and revokes the PUBLIC/anon `EXECUTE` Postgres grants by default, which would otherwise publish each helper at `/rest/v1/rpc/<name>`. Role helpers become `authenticated`-only. |
| 5 | `20260907000005_constrain_self_service_updates.sql` | Closes the self-service gaps in 0002: a deactivated user can no longer reactivate themselves, `created_at` is pinned, a `viewer` signup resolves to no person link, staff cannot rewrite scheduling columns or reopen a finalized run, and a photo-proof task cannot be marked done with no proof. |

Steps 4 and 5 are **not optional**. `supabase db push` applies them automatically, but a
database brought up by pasting only the three September 1 files keeps the unsafe function
grants and the vulnerable self-update policies those two files repair.

Expected notices (not errors): `NOTICE` lines from `IF NOT EXISTS` clauses; a NOTICE about
`people.role` FK only if pre-existing rows hold invalid role codes (report it if seen).

**Success criteria:** all five files complete without ERROR, and
`select filename from schema_migrations order by 1;` includes all five `202609…` names.

**On failure:** capture the exact ERROR line and statement, apply nothing further, report.
Re-running a file after a fix is safe (idempotent).
