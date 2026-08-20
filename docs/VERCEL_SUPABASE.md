# Deploying to Vercel + Supabase

The service runs in two shapes from one codebase:

| | Docker / any VPS | Vercel |
|---|---|---|
| Entrypoint | `src/server.js` (listens on `PORT`) | `api/index.js` (serverless function) |
| Database | SQLite file (`DATABASE_FILE`) | Supabase Postgres (`DATABASE_URL`) |
| Scheduling | in-process cron (`src/jobs/scheduler.js`) | Vercel Cron → `/api/cron/*` |

The backend is chosen at runtime: **set `DATABASE_URL` and it uses Postgres; leave it empty and it uses the SQLite file.** Nothing else changes.

## 1. Create the Supabase schema

In the Supabase dashboard → SQL Editor, paste and run [`src/db/schema.pg.sql`](../src/db/schema.pg.sql).

Or from your machine:

```bash
DATABASE_URL='postgresql://...' npm run migrate
```

Optionally load the starter org chart and routine-task library (**this deletes existing rows**):

```bash
DATABASE_URL='postgresql://...' npm run seed
```

RLS is enabled on all four tables with no permissive policy, so the `anon` and
`authenticated` keys can read nothing. The service connects as the database user
in `DATABASE_URL` and is the only writer.

## 2. Get the right connection string

Supabase → Project Settings → Database → Connection string → **Transaction pooler (port 6543)**.

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Use the pooler, not the direct `5432` connection. Every concurrent lambda opens
its own connection, and direct connections exhaust Postgres' slot limit quickly.

## 3. Set environment variables in Vercel

Project → Settings → Environment Variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the pooler URL from step 2 |
| `DATABASE_SSL` | `true` |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `ADMIN_PASSWORD` | dashboard password |
| `TZ` | `America/Los_Angeles` |
| `WHATSAPP_PHONE_NUMBER_ID` | from Meta |
| `WHATSAPP_TOKEN` | permanent System User token |
| `WHATSAPP_VERIFY_TOKEN` | any string; paste the same one into Meta |
| `WHATSAPP_APP_SECRET` | Meta App → Settings → Basic |
| `DRY_RUN` | `true` until the Meta webhook verifies, then `false` |

Keep `DRY_RUN=true` for the first deploy. Outbound messages are logged to the
`messages` table instead of being sent, so you can exercise the whole flow
without messaging real staff.

## 4. Scheduling, and why it looks odd

`vercel.json` triggers all four jobs **hourly**:

```json
{ "path": "/api/cron/reminders", "schedule": "0 * * * *" }
```

Vercel Cron has no timezone support — it always fires in UTC. A fixed UTC hour
would drift by an hour against `America/Los_Angeles` every time DST flips, so
instead each endpoint checks the *local* hour in `TZ` and no-ops unless it
matches its configured hour (`DAILY_REMINDER_CRON` etc.). Correct year-round,
and the same env vars still drive the real cron scheduler under Docker.

Requests must carry `Authorization: Bearer $CRON_SECRET`; Vercel adds this
automatically. Without a valid secret the endpoints return 401, which is why
they sit outside the dashboard's Basic auth.

To run a job by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://<your-app>.vercel.app/api/cron/reminders?force=1"
```

`force=1` bypasses the hour gate.

> Vercel's Hobby plan allows a limited number of cron invocations and only
> daily granularity on some accounts. Hourly triggers require Pro.

## 5. Deployment protection

A fresh Vercel project often has Deployment Protection (SSO) on, which makes
**every** path return a 302 redirect — including Meta's webhook callback and
Vercel Cron. Meta cannot verify a protected webhook.

Project → Settings → Deployment Protection → disable it for production, or add
`/webhook/whatsapp` and `/api/cron/*` as protection bypass paths.

## 6. Point Meta at the deployment

Callback URL: `https://<your-app>.vercel.app/webhook/whatsapp`
Verify token: whatever you set as `WHATSAPP_VERIFY_TOKEN`.

Then follow [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md) for template approval.

## Local development against Postgres

```bash
DATABASE_URL='postgres://localhost:5432/qcms_dev' DATABASE_SSL=false npm run migrate
DATABASE_URL='postgres://localhost:5432/qcms_dev' DATABASE_SSL=false npm run dev
```

The test suite always forces the SQLite backend, so `npm test` never touches a
real database.
