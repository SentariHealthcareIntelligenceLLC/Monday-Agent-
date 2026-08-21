# QCMS Task Bot — continuation contract

Written 2026-08-20. Pick up from here in a new session.

Repo: `SentariHealthcareIntelligenceLLC/Monday-Agent-` · branch `main` · commit `5ad9800`

---

## 1. What this is

A WhatsApp/email reminder agent for QCMS clinical operations. It holds a
library of recurring duties, pushes them to the person who owns them, chases
non-replies up the chain of command, and records completion timestamps as the
compliance record. A ten-tab admin dashboard sits on top.

Two deployment shapes from one codebase, chosen at runtime by `DATABASE_URL`:

| | Vercel (production) | Docker / VPS |
|---|---|---|
| Entrypoint | `api/index.js` | `src/server.js` |
| Database | Supabase Postgres | local SQLite file |
| Scheduling | Vercel Cron → `/api/cron/*` | in-process cron |

Set `DATABASE_URL` → Postgres. Leave it empty → SQLite. Nothing else changes.

---

## 2. Current state — verified, not assumed

### GitHub
`main` at `5ad9800`, working tree clean, everything pushed. PR #1 (WhatsApp
round trip) is merged in. 33 tests pass; `npm run check:schema` clean.

### Supabase — TWO projects, and this matters

**`xziunvsgzriuufcfdkvx` — "Monday Agent" — this is the real one.**
- All 16 tables present, RLS enabled on every one.
- `roles` = 5 rows, `escalation_rules` = 2, `facility_roles` = 2.
- All 3 views are `security_invoker = true` — **verified by probe**, not just
  by reading the flag: as `anon`, both the tables and the views return 0 rows
  while the service role sees the data.
- **Content tables are still EMPTY.** Not seeded yet.
- **Missing `people.awaiting_photo_run_id` and `messages.media_path`** — added
  to `supabase/schema.sql` only in `5ad9800`, after the last paste. See §4.1.

**`yuwnvuknmjoyxwuhbrqn` — "SentariHealthcareIntelligenceLLC's Project" — NOT ours.**
- Hosts a different live clinical app: 19 patients, 414 cases, imaging studies,
  providers, practices, 1,925 usage events.
- An early run of the schema landed here by mistake. 16 empty QCMS tables and
  3 views are sitting in it.
- **Nothing was damaged** — every FK referencing the QCMS tables originates
  from the QCMS tables themselves; nothing in the clinical app touches them.
- Its 3 views are still `security_invoker = NOT SET`. Empty, so nothing leaks
  today. Unresolved — see §4.4.

### Vercel
Team `sentari`. Two projects, `monday-agent` and `monday-agent-m3ix`
(the second looks like an accidental duplicate re-import).

- Public URL: **https://monday-agent-eosin.vercel.app** — serves the dashboard
  HTML, but **every `/api/*` call returns 500** (`FUNCTION_INVOCATION_FAILED`).
  Cause: no `DATABASE_URL`, so the code falls back to the SQLite backend, which
  tries to create a directory on a read-only filesystem and crashes on startup.
- All other URLs 302 — SSO Deployment Protection is on for everything except
  custom domains.
- `monday-agent.vercel.app` is **someone else's project** ("Traffic Controller
  Bot"). Not ours. Don't chase it.

---

## 3. Design decisions worth not relitigating

- **Recurring vs one-off.** Recurring duties (`cadence` daily…yearly,
  `origin='library'`) are the standing library. Genuinely new work is
  `cadence='once'` with a `due_date`, entering only through the Task board
  (`origin='board'`) or the Messages composer (`origin='message'`), both via
  `POST /api/adhoc`. `POST /api/tasks` refuses `once`.
- **Escalation is data, not code.** `escalation_rules`: 4 unanswered reminders
  → Manager, 6 → Owner. `roles.rank` is the chain of command.
- **Lead windows.** `tasks.lead_days` opens the reminder window early, so a
  yearly accreditation packet nags for 45 days rather than appearing once.
- **Vercel Cron is UTC-only.** `vercel.json` fires all six jobs hourly and each
  endpoint no-ops unless the local hour in `TZ` matches. DST-proof by design —
  don't "fix" it into fixed UTC hours.
- **The Reports tab is deliberately not connected.** The prototype filled it
  with a random-number generator inventing case volume, physicians, turnaround
  and revenue. On a compliance dashboard those numbers can reach a board
  report, so it shows an explicit "no case-log source connected" state. Wiring
  it needs a real feed from surgical scheduling or billing.
- **RLS with no policies is intentional.** The service is the only writer and
  connects with the service-role key. Anon and authenticated read nothing. The
  16 `rls_enabled_no_policy` INFO advisories are expected. Do not "fix" them by
  adding permissive policies.
- **Views must stay `security_invoker`.** A plain view runs as its creator and
  reads straight through RLS; PostgREST exposes them to `anon`. This was a real
  leak, caught and closed. Any new view needs `WITH (security_invoker = true)`.

---

## 4. Outstanding work, highest value first

### 4.1 Bring Supabase up to `5ad9800` — REQUIRED before seeding
The live database predates two columns the merged WhatsApp code needs. Run on
**Monday Agent**:

```sql
ALTER TABLE people   ADD COLUMN IF NOT EXISTS awaiting_photo_run_id bigint;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_path text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_wa_in
  ON messages(wa_message_id) WHERE direction = 'in' AND wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_wa_out ON messages(wa_message_id) WHERE direction = 'out';
CREATE INDEX IF NOT EXISTS idx_msg_person ON messages(person_id, created_at);
INSERT INTO schema_migrations (filename) VALUES ('002_whatsapp_delivery.sql')
  ON CONFLICT DO NOTHING;
```

Or re-paste the whole of `supabase/schema.sql` (idempotent), or run
`DATABASE_URL='...' npm run migrate`.

### 4.2 Make the deployment actually work
In Vercel → `monday-agent` → Settings → Environment Variables:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler**, port 6543. The direct 5432 connection exhausts slots under serverless concurrency. |
| `DATABASE_SSL` | `true` |
| `ADMIN_PASSWORD` | **Defaults to `change-me`.** The deployment is on a public URL. Set this. |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `TZ` | `America/Los_Angeles` |
| `WHATSAPP_*` | phone number id, token, verify token, app secret |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | photo storage |
| `RESEND_API_KEY`, `EMAIL_FROM` | only if the email channel is wanted |
| `DRY_RUN` | keep `true` until Meta verifies the webhook |

Redeploy afterwards — env changes don't apply to an existing deployment.

Then create a **private** Storage bucket named `qcms-proof` (public OFF).

### 4.3 Seed
`DATABASE_URL='...' npm run seed` loads 6 facilities, 7 people, 32 credentials,
57 duties, 68 shifts, 19 lift items, 57 planner items.

**It DELETES and rebuilds the content tables** — do not run it against a
database holding real data. It also backfills ~570 rows of *sample* completion
history so the charts aren't empty; that block is clearly marked in
`src/db/seed.js` and should be removed for a real production install.

Phone numbers in the seed are placeholders (`1555000xxxx`). Replace before
going live or nobody receives anything.

### 4.4 Decide about the stray tables
16 empty QCMS tables in `yuwnvuknmjoyxwuhbrqn`. Either drop them to restore
that project, or at minimum apply the `security_invoker` fix to its 3 views.
**The user was asked and deferred — do not act without asking again.**

### 4.5 Smaller things
- Deployment Protection blocks Meta's webhook callback and Vercel Cron. Turn it
  off for production or bypass `/webhook/whatsapp` and `/api/cron/*`.
- Hourly cron requires Vercel **Pro**; Hobby is daily-only, which would break
  the nudge and escalation schedule.
- The repo is **public**. Confirm that's intended.
- Duplicate Vercel project `monday-agent-m3ix` — probably delete one.
- `/api/facility_roles` has no read endpoint yet; the Scheduling tab still gets
  its role rows from the prototype constant rather than the table.

---

## 5. Working on this codebase

```bash
npm test            # 33 tests, forces the SQLite backend — never touches Postgres
npm run check:schema # schema.sql must stay generated from schema.pg.sql
npm run gen:schema   # regenerate after editing schema.pg.sql
npm run dev          # local server, SQLite
```

Local Postgres testing (this is how everything above was verified):

```bash
brew services start postgresql@16
createdb qcms_dev
DATABASE_URL="postgres://$(whoami)@localhost:5432/qcms_dev" DATABASE_SSL=false npm run migrate
DATABASE_URL="postgres://$(whoami)@localhost:5432/qcms_dev" DATABASE_SSL=false npm run seed
DATABASE_URL="postgres://$(whoami)@localhost:5432/qcms_dev" DATABASE_SSL=false \
  DRY_RUN=true DISABLE_AUTH=1 PORT=3994 npm start
```

`DISABLE_AUTH=1` skips dashboard Basic auth so a browser can drive the UI. It is
**ignored entirely when `NODE_ENV=production`** — verified.

### Gotchas
- `schema.sql` (SQLite) is **generated**. Edit `schema.pg.sql` and run
  `npm run gen:schema`; CI checks they agree.
- The dashboard is the user's approved design. `public/index.html` keeps its CSS
  and markup verbatim; an adapter at the top of the `<script>` fetches from the
  API and reshapes responses into the structures the original renderers expect.
  **Don't restyle it.** When adding data, extend the adapter.
- Node and Postgres were installed on the user's Mac during this work (`brew`).
  Node 26, Postgres 16. `node` is at `/opt/homebrew/bin`, `psql` at
  `/opt/homebrew/opt/postgresql@16/bin` — neither is on the default PATH.

---

## 6. Ground truth to re-verify at session start

Don't trust this document on these — check them, they change:

```bash
git -C . log --oneline -3 && git status -sb
curl -s -o /dev/null -w "%{http_code}\n" https://monday-agent-eosin.vercel.app/health
```

Via the Supabase connector, on `xziunvsgzriuufcfdkvx`:

```sql
SELECT c.relname,
       COALESCE((SELECT option_value FROM pg_options_to_table(c.reloptions)
                 WHERE option_name='security_invoker'), 'NOT SET') AS security_invoker
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='v' AND c.relname LIKE 'v_%';

SELECT (SELECT count(*) FROM people) AS people,
       (SELECT count(*) FROM tasks)  AS tasks,
       (SELECT string_agg(filename, ', ') FROM schema_migrations) AS migrations;
```

Expected right now: all views `true`; people 0, tasks 0; migrations
`001_expand_schema.sql, supabase/schema.sql` — and **not** `002`, until §4.1
is done.
