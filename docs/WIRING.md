# Wiring the new components — exact patches, zero dashboard changes

`public/index.html` is not touched by anything in this package. The approved design and
flow stay verbatim; every change below is behind the API.

## Why the board goes stale after a day (fix this first)

The dashboard renders, but the data underneath dies because four things upstream are off.
None of them are code:

1. **`DATABASE_URL` unset on Vercel** → every `/api/*` call 500s (SQLite fallback on a
   read-only filesystem). Nothing written in the chat ever lands anywhere durable.
2. **The 00:05 `materialize` cron never runs** → no new `task_runs` rows are created for
   the new day, so yesterday's board is the last board.
3. **Deployment Protection 302s** Vercel Cron and Meta's webhook → reminders don't go out,
   replies don't come in.
4. **Hobby plan runs crons daily, not hourly** → the local-hour-matching design never hits
   08:00/13:00/17:00.

Fix = HANDOFF-2026-09-01.md §4 (env vars + redeploy + protection bypass + Pro plan).
After that, the daily loop is self-refreshing: materialize at 00:05, reminders at 08:00,
nudge at 13:00, escalation sweep at 17:00, digest at 17:30 — and every WhatsApp reply
writes `task_runs`/`messages` in real time, which is exactly what the dashboard reads.

## Files this package adds to `src/`

| File | Purpose |
|---|---|
| `src/db/migrations/003_auth_profiles.sql` | Repo-native copy of the auth migration; `npm run migrate` applies it. Includes a local-dev shim (creates stand-in `auth` schema/roles on plain Postgres; a no-op on Supabase). |
| `src/db/migrations/004_whatsapp_connections.sql` | Repo-native copy of the WhatsApp-connections migration. |
| `src/services/waConnections.js` | Runtime for the new tables: sender config from DB+Vault (env fallback), contact opt-in + 24 h window, deduped webhook event log, delivery receipts. Every function degrades to a no-op on SQLite or before migration — wiring it in cannot break the webhook. |

The two migration copies and the `supabase/migrations/` CLI copies record each other in
`schema_migrations`, so whichever path runs first, the other is skipped, and both are
idempotent anyway.

## Patch 1 — `src/routes/webhook.js` (delivery receipts, event log, contact state)

Add the import at the top, next to the other services:

```js
const waConn = require('../services/waConnections');
```

In the `app.post(path, ...)` handler, replace the inner loop body:

```js
        for (const change of entry.changes || []) {
          const profileName = change.value?.contacts?.[0]?.profile?.name || null;

          for (const status of change.value?.statuses || []) {
            await waConn.recordDeliveryStatus(status);   // NEW: receipts table -> messages.delivery_status
            await wa.applyStatus(status);                // unchanged legacy status column
          }
          for (const msg of change.value?.messages || []) {
            // NEW: raw audit log; false = Meta redelivery, already handled
            const fresh = await waConn.recordWebhookEvent({
              eventType: 'message', waMessageId: msg.id, waId: msg.from,
              payload: msg, signatureOk: true,
            });
            // NEW: opt-in + open the 24h session window
            await waConn.touchInbound(msg.from, profileName, null);
            if (fresh) await handleMessage(msg);
          }
        }
```

(`handleMessage` itself is unchanged — its own `logInbound` dedupe still stands as a
second guard.)

## Patch 2 — `src/services/whatsapp.js` (outbound touches)

Add the import at the top:

```js
const waConn = require('./waConnections');
```

In `post()`, in the success branch (right after the `logMessage({... status: 'sent' ...})`
call), add:

```js
    await waConn.touchOutbound(payload.to);
```

and in both failure branches (after each `logMessage({... status: 'failed' ...})`):

```js
    await waConn.recordFailure(payload.to, json ?? err);
```

## Patch 3 (optional, phase 2) — sender config from the database

`waConn.getAccount()` returns the same shape as `config.whatsapp`, resolved from
`whatsapp_accounts` + Vault, with env vars as automatic fallback. To adopt it, resolve it
at the top of `post()` / `fetchMedia()` / the webhook GET handshake instead of reading
`config.whatsapp` directly. Until then the env-var path keeps working — the fallback is
the point: nothing breaks if this patch waits.

## Auth (migration 003) — what changes for the API

Nothing, yet. The Node service connects as `service_role` and bypasses RLS, so applying
003 changes no behavior. It enables the phase-2 login swap (HANDOFF §6): Supabase Auth
in the browser, `profiles.app_role` deciding who sees what. Until that code lands, Basic
auth (`admin` / `ADMIN_PASSWORD`) keeps guarding the dashboard exactly as today.

## Patch 4 (optional) — connection-pool sizing for serverless

Each Vercel invocation is its own process, so a default `pg` Pool (`max: 10`) claims up
to 10 pooler slots per concurrent lambda for no benefit. In `src/db/postgres.js`, where
the Pool is constructed, size it for serverless:

```js
new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /* existing DATABASE_SSL logic */,
  max: 3,                      // per-invocation; Supavisor multiplexes the rest
  idleTimeoutMillis: 10_000,   // release slots between cron ticks
  connectionTimeoutMillis: 8_000,
  keepAlive: true,
});
```

With the transaction pooler (port 6543) this is belt-and-braces, but it keeps slot usage
flat when several cron jobs and dashboard requests overlap at the top of the hour —
which is exactly when all six cron endpoints fire.

## Verify freshness end-to-end (10 minutes, DRY_RUN=true)

1. `curl https://monday-agent-eosin.vercel.app/health` → 200.
2. Dashboard → Send reminders → "Recent WhatsApp activity" fills (dry_run rows in `messages`).
3. `GET /api/cron/materialize?force=1` with `Authorization: Bearer $CRON_SECRET` → new
   `task_runs` rows for tomorrow: `select count(*) from task_runs where due_date = to_char(now() + interval '1 day','YYYY-MM-DD');`
4. Next morning, the board shows the new day without anyone touching it. That is the fix.
