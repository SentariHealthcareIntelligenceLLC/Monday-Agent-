# Step 06 — Verify and report

**Purpose:** prove the migration landed correctly. Run every query, capture output
verbatim, and return the whole block to the user.

## Query 1 — RLS on for all new tables (expect 5 rows, all `relrowsecurity = true`)

```sql
select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and relname in
  ('profiles','whatsapp_accounts','whatsapp_contacts','whatsapp_webhook_events','whatsapp_delivery_status');
```

## Query 2 — every view is security_invoker (FAIL if any row says `NOT SET`)

```sql
select c.relname, coalesce((select option_value from pg_options_to_table(c.reloptions)
  where option_name='security_invoker'),'NOT SET') as si
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='v';
```

## Query 3 — migrations recorded (expect the three `202609…` names among them)

```sql
select filename from schema_migrations order by 1;
```

## Query 4 — anon reads nothing

As the `anon` role (PostgREST/API with the anon key), select from `people`, `tasks`,
`profiles`, and `v_open_task_runs`: **every one must return 0 rows.** Any row visible to
anon is a critical finding — report it immediately.

## Report format

Return to the user: pass/fail per step 01–06 (with "skipped" where applicable),
the verbatim output of queries 1–3, the anon result, any NOTICE about `people.role`
from step 02, and anything you had to deviate on.
