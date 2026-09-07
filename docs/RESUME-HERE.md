# Resume here — paused 2026-09-07

**Status: paused, waiting on Meta.** The blocker is the WhatsApp admin login from the
Meta developer account. Nothing below can move until that arrives; everything that could
be done without it is done and merged.

## Where things stand

`main` now carries the full 2026-09-01 migration pack plus seven rounds of review fixes.
CI is green: `npm test` is 42/42 on Postgres, 33 pass 1 skipped on SQLite, and the CI
`postgres` job runs the suite against a real server.

**The live Supabase project is ahead of this repo, not behind it.** `xziunvsgzriuufcfdkvx`
("Monday Agent") was migrated on 2026-09-02 from a *later* generation of the pack, with
different role-helper names (`current_app_role` / `is_dashboard_admin` /
`current_person_id` vs this repo's `app_*`). Read
`docs/migration-pack/07_LIVE_STATE_2026-09-02.md` before running anything against it.

## Blocked on the Meta admin login

Step 04 of the migration pack (`docs/migration-pack/04_WHATSAPP_SENDER.md`) needs four
values from the Meta app: system-user access token, app secret, webhook verify token, and
the WABA id + phone number id. Until then:

- Leave `DRY_RUN=true`. Outbound sends are logged, not sent.
- Do **not** put raw tokens in any table. They go in Supabase Vault by name; the
  `whatsapp_accounts` row stores only the secret *names*.
- The sender row's `status` stays `dry_run`. Moving it to `live` is a separate human
  decision after Meta verifies the webhook.
- SSO Deployment Protection will 302 Meta's webhook callback. It has to be disabled for
  production, or bypassed for `/webhook/whatsapp`, before verification can succeed.

## Not blocked — can be done any time

1. **`DATABASE_URL` is unset in Vercel.** This is why every `/api/*` returns 500 in
   production right now. Set it to the Supabase **transaction pooler** string (port 6543,
   not 5432), plus `DATABASE_SSL=true`, then **redeploy** — env changes do not apply to an
   existing deployment.
2. **`ADMIN_PASSWORD` still defaults to `change-me`** on a public URL. Change it before
   any real staff data goes in.
3. **Create the private `qcms-proof` bucket** (public OFF) — step 03.
4. **First admin login** — step 05. Every signup lands as `viewer` with no access; exactly
   one account gets promoted to `owner`.
5. **Duplicate Vercel project `monday-agent-m3ix`** is still live and will double-invoke
   every cron against the same database once `DATABASE_URL` is set. Delete one.
6. **Hourly crons need Vercel Pro.** On Hobby they run once daily, which breaks the 13:00
   nudge and 17:00 escalation entirely.

## Open decisions for a human

- **Reconcile repo vs live schema** before applying these migrations there. Either
  `supabase db pull` to regenerate from live, or accept that the database will carry two
  parallel sets of role-helper functions. Nothing is blocked by this — live already has
  what the app needs.
- **`20260907000005_constrain_self_service_updates.sql` and `src/services/waConnections.js`
  deserve a human read.** Seven automated review rounds found sixteen real issues, several
  of them in code written to fix the previous round. No security review ever ran against
  the final state: the Codex security reviewer could not be triggered from the working
  session (comment triggers routed to the code reviewer; a draft→ready flip did nothing).
  A security pass on these two files is the single most valuable thing to do next.
- **Photo proof is only partly enforceable in SQL.** The trigger rejects `done` with no
  `photo_path`, but cannot verify the path points at a real image in the bucket. Closing
  that needs a server-side completion endpoint.

## Things not to change

- RLS-enabled-with-no-anon-policy is intentional; the `rls_enabled_no_policy` advisories
  are expected. Never add a permissive `anon` policy.
- Views must stay `security_invoker = true`.
- The six hourly crons with local-hour matching are DST-proof by design. Do not convert
  them to fixed UTC hours.
- Never run `npm run seed` against real data — it deletes content tables and inserts
  placeholder numbers.
- `007` must stay last in the migration sequence; `006` re-creates helpers that `007`
  hardens.
