# QCMS Task Bot

WhatsApp-driven routine-task management for **QCMS (Quality Clinical Management Solutions)** —
reminders, completion tracking, gap analysis, and chain-of-command escalation for clinic
and surgery-center operations.

- Every team member gets a **WhatsApp message** listing what they owe today.
- They reply `DONE 2`, `BLOCKED 1 no contrast left`, or `LIST` — no app to install.
- Anything still open at end of day is **escalated up the chain of command**.
- An **admin dashboard** shows today's board, who is behind, and where the process
  itself is failing.

**One npm dependency (`pg`).** Runs on Node 20.16+ / 22+ using the built-in HTTP
and SQLite modules, so it installs and deploys anywhere without a build step.

**Two deployment shapes, one codebase.** Set `DATABASE_URL` and it runs on
Vercel against Supabase Postgres with Vercel Cron driving the jobs; leave it
empty and it runs as a long-lived Docker/VPS process against a local SQLite file
with in-process cron. See [docs/VERCEL_SUPABASE.md](docs/VERCEL_SUPABASE.md).

---

## Quick start

```bash
git clone <this repo>
cd qcms-taskbot
cp .env.example .env        # DRY_RUN=true by default — nothing is sent yet
npm run seed                # loads the QCMS org chart + starter task library
npm start
```

Open <http://localhost:3000> — user `admin`, password from `ADMIN_PASSWORD`.

With `DRY_RUN=true` every outbound message is logged to the `messages` table instead of
being sent, so you can exercise the whole system before touching Meta. Click
**Send reminders** on the dashboard and watch the "Recent WhatsApp activity" panel fill up.

To connect real WhatsApp, follow **[docs/WHATSAPP_SETUP.md](docs/WHATSAPP_SETUP.md)**.

---

## How it works

### The org chart

Chain of command mirrors QCMS's structure, and escalation walks it upward:

```
Owner
└── Manager
    ├── OR / Angiosuite Supervisor
    └── Medical Assistant
        └── Virtual Assistant
```

Each person has a `reports_to_id`. When a task is missed, the assignee's manager is
notified; if the task is marked **critical**, it goes all the way to the owner.

### The daily cycle

| Time (configurable) | What happens |
|---|---|
| 00:05 | Tomorrow's task instances are created from the recurring task library |
| 08:00 | Each person gets one WhatsApp template listing everything due today |
| 13:00 | Anyone with open items gets a plain-text nudge |
| 17:00 | Open items are marked missed and escalated to the next person up |

Daily tasks fire Mon–Fri (critical ones fire every day). Weekly tasks fire on their
weekday, monthly on their day of month — all rolled into the same morning message.

### What staff can text back

| Reply | Effect |
|---|---|
| `LIST` / `STATUS` | Show my open tasks, numbered |
| `DONE 2` | Complete item 2 |
| `DONE 2 ran late, finished at 6` | Complete with a note |
| `BLOCKED 1 no contrast left` | Flag a blocker — immediately alerts the manager |
| `SNOOZE 3` | Push to later today |
| `HELP` | Command list |

If only one task is open, a bare `DONE` is enough.

### Gap analysis

The dashboard flags patterns rather than just individuals:

- anyone completing under 80% of their assigned instances over 30 days
- anyone reporting `BLOCKED` three or more times — a supply or process bottleneck,
  not a performance problem
- any *task* completed under 60% of the time — usually a sign it's assigned to the
  wrong role, scheduled at the wrong hour, or too big to be one task

### Seeded task library

Starter tasks reflect real clinic operations and are meant to be edited:
schedule confirmation, insurance eligibility, angiosuite pre-procedure checklist,
charge posting, supply inventory and reorder, weekly facility checklist, A/R follow-up,
prior-auth backlog, physician and facility credentialing expirations, monthly revenue
reporting, competency logs.

---

## Configuration

Every setting lives in `.env` — see `.env.example` for the annotated list.
The ones that matter most:

| Variable | Meaning |
|---|---|
| `DRY_RUN` | `true` logs messages instead of sending. Start here. |
| `ADMIN_PASSWORD` | Dashboard/API password (username is always `admin`) |
| `WHATSAPP_*` | Meta Cloud API credentials — see the setup doc |
| `DAILY_REMINDER_CRON` etc. | Schedule, evaluated in `TZ` |
| `DATABASE_FILE` | SQLite path; put it on a persistent disk in production |
| `DATABASE_URL` | Set → Postgres/Supabase backend. Empty → SQLite. Required on Vercel. |
| `DATABASE_SSL` | `true` for Supabase; `false` for a local postgres |
| `CRON_SECRET` | Bearer token Vercel Cron sends to `/api/cron/*` |

## Recurring duties vs. one-off tasks

Two different things share the board:

- **The recurring library** — the standing duties each role owns, on their own
  cadence (`daily` … `yearly`). These are the steady state and are managed in
  Rules / `POST /api/tasks`.
- **One-off tasks** — work that is genuinely new. These have cadence `once`,
  carry a single `due_date`, and never recur. They enter through exactly two
  doors, which is what the dashboard's two boxes are for:
  - the **Task board**'s "new one-off task" row (`origin: board`)
  - the **Messages** composer, ticking *Track as a one-off task*
    (`origin: message`) — so a request made in a message gets reminders and an
    escalation path instead of scrolling away

Both land on `POST /api/adhoc`, appear on the board immediately, and then follow
the same reminder and escalation rules as everything else.

## API

All endpoints require Basic auth except `/health` and `/webhook/whatsapp`.

```
GET    /health
GET    /api/board?date=YYYY-MM-DD     today's task instances
POST   /api/runs/:id/status           {status, note}
GET    /api/people                    POST /api/people   PATCH /api/people/:id
DELETE /api/tasks/:id                 retire a duty
GET    /api/gaps?days=30              completion rates + findings
GET    /api/messages                  last 100 WhatsApp messages
POST   /api/run/reminders|nudges|escalations    trigger a job now

GET    /api/tasks                     the recurring duty library (never one-offs)
POST   /api/tasks                     add a recurring duty
GET    /api/adhoc                     one-off tasks, newest first
POST   /api/adhoc                     raise a one-off {title, assignee_id, due_date,
                                      origin: board|message}

GET    /api/facilities                 POST /api/facilities  PATCH/DELETE /api/facilities/:id
GET    /api/credentials?within=60     POST /api/credentials PATCH/DELETE /api/credentials/:id
GET    /api/shifts?date=&facility=    POST /api/shifts      PATCH/DELETE /api/shifts/:id
GET    /api/clock?date=&now=HH:MM     POST /api/clock/:shiftId/:field
GET    /api/planner/week|month        POST /api/planner     POST /api/planner/:id/done
POST   /api/planner/:id/photo         raw image body; closes a photo-proof item
GET    /api/photo?path=               signed URL for a stored photo
GET    /api/lift                      POST /api/lift        DELETE /api/lift/:id
GET    /api/settings                  PATCH /api/settings/:key
GET    /api/trend?days=7              daily completion rate

GET    /api/cron/:job                 Vercel Cron entrypoint (Bearer CRON_SECRET,
                                      not Basic auth). :job is one of
                                      materialize|reminders|nudges|escalations|
                                      credentials|digest.
                                      No-ops unless the local hour matches the
                                      job's schedule; ?force=1 overrides.
```

## Project layout

```
src/
  lib/        env loader, tz-aware dates, cron engine, mini HTTP router
  db/         schema.sql (SQLite) + schema.pg.sql (Postgres),
              index.js facade, sqlite.js / postgres.js backends, migrate, seed
  services/   tasks.js, whatsapp.js, email.js, notify.js (channel routing),
              facilities.js, credentials.js, schedule.js (shifts + time clock),
              planner.js, lift.js, settings.js, storage.js, replies.js
  jobs/       reminders.js (reminders/nudges/escalation), scheduler.js
  routes/     webhook.js (Meta), api.js (admin), cron.js (Vercel Cron)
  app.js      builds the request handler (shared by both entrypoints)
  server.js   long-running entrypoint (Docker/VPS)
api/
  index.js    Vercel serverless entrypoint
vercel.json   rewrites + cron schedules
public/       dashboard (single self-contained HTML file)
docs/         WHATSAPP_SETUP.md, DEPLOY.md, VERCEL_SUPABASE.md
tools/        gen-sqlite-schema.js, import-prototype.js
tests/        node:test suites
```

## Tests

```bash
npm test
```

## Important limitation — PHI

WhatsApp Cloud API is **not** a HIPAA-compliant channel and Meta does not sign a BAA
for it. Keep patient identifiers out of task titles, details, and notes. Refer to
patients by internal ID. Task *names* ("Verify insurance for tomorrow's list") are safe;
patient names are not.

## License

MIT — see [LICENSE](LICENSE).
