# QCMS Task Bot

WhatsApp-driven routine-task management for **QCMS (Quality Clinical Management Solutions)** —
reminders, completion tracking, gap analysis, and chain-of-command escalation for clinic
and surgery-center operations.

- Every team member gets a **WhatsApp message** listing what they owe today.
- They reply `DONE 2`, `BLOCKED 1 no contrast left`, or `LIST` — no app to install.
- Anything still open at end of day is **escalated up the chain of command**.
- An **admin dashboard** shows today's board, who is behind, and where the process
  itself is failing.

**Zero npm dependencies.** Runs on Node 20.16+ / 22+ using the built-in SQLite and HTTP
modules, so it installs and deploys anywhere without a build step.

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

## API

All endpoints require Basic auth except `/health` and `/webhook/whatsapp`.

```
GET    /health
GET    /api/board?date=YYYY-MM-DD     today's task instances
POST   /api/runs/:id/status           {status, note}
GET    /api/people                    POST /api/people   PATCH /api/people/:id
GET    /api/tasks                     POST /api/tasks    DELETE /api/tasks/:id
GET    /api/gaps?days=30              completion rates + findings
GET    /api/messages                  last 100 WhatsApp messages
POST   /api/run/reminders|nudges|escalations    trigger a job now
```

## Project layout

```
src/
  lib/        env loader, tz-aware dates, cron engine, mini HTTP router
  db/         schema.sql, SQLite wrapper, migrate, seed
  services/   whatsapp.js, tasks.js, replies.js
  jobs/       reminders.js (reminders/nudges/escalation), scheduler.js
  routes/     webhook.js (Meta), api.js (admin)
  server.js
public/       dashboard (single self-contained HTML file)
docs/         WHATSAPP_SETUP.md, DEPLOY.md
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
