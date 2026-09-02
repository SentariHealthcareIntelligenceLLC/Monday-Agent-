# QCMS Task Bot — Supabase migration pack (agent manifest)

```yaml
pack: qcms-supabase-migrations
version: 2026-09-01
target_project_ref: xziunvsgzriuufcfdkvx        # "Monday Agent"
forbidden_project_ref: yuwnvuknmjoyxwuhbrqn     # different LIVE clinical app — never touch
execution: sequential                            # run steps in numeric order, stop on failure
steps:
  - 01_GUARDRAILS.md          # read fully before any SQL
  - 02_APPLY_MIGRATIONS.md    # required
  - 03_STORAGE_BUCKET.md      # required
  - 04_WHATSAPP_SENDER.md     # conditional — only with Meta credentials in hand
  - 05_ADMIN_LOGIN.md         # required
  - 06_VERIFY_AND_REPORT.md   # required — output goes back to the user
sql_files:
  - 20260901000001_dashboard_core.sql
  - 20260901000002_auth_profiles.sql
  - 20260901000003_whatsapp_connections.sql
idempotent: true              # every step safe to re-run; no row rewritten, nothing dropped
```

Each step file states its purpose, preconditions, exact actions, success criteria, and
what to do on failure. Do not improvise beyond them; if a precondition cannot be met,
stop and ask the user.
