# QCMS Task Bot — configuration review & optimization

Reviewed: repo `SentariHealthcareIntelligenceLLC/Monday-Agent-` @ main, `.env.example`, `vercel.json`, `HANDOFF.md`, live deployment `monday-agent-eosin.vercel.app`. Date: 2026-09-01.

## The one thing breaking production

The live deployment serves the dashboard HTML but **every `/api/*` call returns 500**. Cause: `DATABASE_URL` is unset in Vercel, so the code falls back to SQLite and crashes trying to create a directory on Vercel's read-only filesystem. Fix order:

1. Run the three migrations in `supabase/migrations/` against the **Monday Agent** project (`xziunvsgzriuufcfdkvx`) — migration 0001 also applies the §4.1 catch-up the HANDOFF flags as required (`people.awaiting_photo_run_id`, `messages.media_path`, WhatsApp indexes).
2. In Vercel → `monday-agent` → Settings → Environment Variables, set:

| Variable | Value / note |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** string, port **6543** (`postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres`). Direct 5432 exhausts connection slots under serverless concurrency. |
| `DATABASE_SSL` | `true` |
| `ADMIN_PASSWORD` | Currently defaults to `change-me` on a **public URL** — set a strong value now, before seeding real staff data. |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `TZ` | `America/Los_Angeles` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | For photo-proof storage. |
| `WHATSAPP_*` | Leave `DRY_RUN=true` until Meta verifies the webhook. |

3. **Redeploy** — env changes don't apply to the existing deployment.
4. Create the private Storage bucket `qcms-proof` (public OFF).

## Deployment-protection & plan gotchas (will silently break things)

- **SSO Deployment Protection is on.** It will 302 Meta's webhook callback and Vercel Cron requests. Disable it for production, or add Protection Bypass for `/webhook/whatsapp` and `/api/cron/*`.
- **Hourly cron requires Vercel Pro.** Hobby runs crons once daily, which breaks the nudge (13:00) and escalation (17:00) schedule entirely. Verify the team plan.
- **Duplicate project** `monday-agent-m3ix` — delete one to avoid double cron invocations against the same database.
- The repo is **public**; confirm that's intended for a healthcare-ops tool.

## vercel.json — optimized (`vercel.optimized.json`)

Kept as-is deliberately: the six hourly crons with local-hour matching inside each job. That design is **DST-proof** (Vercel cron is UTC-only) — HANDOFF explicitly says not to convert these to fixed UTC hours. Changes:

- **`regions`** pinned so the function runs next to the database. Verified 2026-09-02: the Supabase project is in **us-west-2** (Oregon), so `vercel.json` pins **`pdx1`** — not the `sfo1` suggested here, which would sit a region away; cross-region hops add 50–150 ms to every one of the pooled Postgres round trips per request.
- **`memory: 1024`** — more memory also means a faster CPU class on Vercel; the cron jobs that fan out reminders are the beneficiaries.
- **Security headers** on all responses (nosniff, frame-deny, HSTS, no-referrer). The dashboard is Basic-auth on a public URL; these are free hardening.
- Optional (needs one small code change, not included): collapse the six cron entries into a single `/api/cron/tick` that runs all due jobs — cuts invocations 6× and stays within Hobby's cron limits if the plan is ever downgraded. The per-job no-op-unless-hour-matches logic already makes this safe.

## .env additions for the new migrations

```
# ---- Supabase Auth (dashboard login) ----
SUPABASE_ANON_KEY=            # publishable key; used by the browser login flow
# Vault secret NAMES referenced by whatsapp_accounts (raw tokens live in Vault):
#   select vault.create_secret('<token>',  'wa_token_primary');
#   select vault.create_secret('<secret>', 'wa_app_secret_primary');
#   select vault.create_secret('<verify>', 'wa_verify_primary');
```

## What the migrations add (and why)

**0001 `dashboard_core`** — the full idempotent dashboard schema (16 tables, security_invoker views, RLS enabled). Re-packaged from `supabase/schema.sql` for the Supabase CLI so schema history is tracked; running it on the live project is exactly the §4.1 catch-up.

**0002 `auth_profiles`** — Supabase Auth: `profiles` linked to `auth.users` and to `people`, auto-provisioned on signup (new users land as `viewer` with no access until promoted), SECURITY DEFINER role helpers to avoid RLS recursion, and role-based policies — owner/manager read/write the dashboard, staff see and update only their own work, `anon` still reads nothing, and the Node service (service_role) is untouched.

**0003 `whatsapp_connections`** — WhatsApp state in the database instead of env-only: sender accounts (secrets held as **Supabase Vault references**, never raw tokens), per-person contacts with opt-in/opt-out and the 24-hour session window (`v_wa_session_open`), a deduplicated webhook event log (Meta retries until it gets a 200), and delivery statuses (sent/delivered/read/failed) rolled up onto `messages.delivery_status`.

Apply order matters (0002 defines `touch_updated_at()` and the role helpers 0003 uses). With the Supabase CLI: `supabase db push`; or paste each file in order into the SQL Editor.

## Things NOT to change (per HANDOFF, verified still sensible)

- RLS-enabled-with-no-anon-policy is intentional; the 16 advisory INFOs are expected. 0002 adds *authenticated* policies only.
- Views must stay `security_invoker = true` — a plain view reads straight through RLS via PostgREST. All new views in 0003 comply.
- The Reports tab's "no case-log source connected" state is deliberate; don't wire it to synthetic numbers.
- Seed script deletes content tables and inserts placeholder phone numbers (`1555000xxxx`) plus ~570 rows of sample history — never run it against real data.
