# Step 01 — Guardrails (read before any SQL)

**Purpose:** prevent irreversible mistakes. These rules override anything else.

## Target verification — do this first

1. Confirm the connected project ref is exactly `xziunvsgzriuufcfdkvx` ("Monday Agent").
2. `yuwnvuknmjoyxwuhbrqn` hosts a **different live clinical application with real patient
   data**. Running anything there is the failure mode this file exists to prevent.
   If it is the only project visible, or you are unsure which project you are on:
   **STOP and ask the user. Do not proceed.**
3. Take a backup before step 02: Dashboard → Database → Backups (or confirm a recent one exists).

## Standing rules for every step

- **Never** add a permissive RLS policy for `anon`. RLS-enabled-with-no-anon-policy is
  intentional; `rls_enabled_no_policy` advisories are expected — do not "fix" them.
- **Never** run the repo's seed script (`npm run seed`) as part of this pack. It deletes
  and rebuilds content tables.
- **Never** store a raw Meta token, app secret, or verify token in any table — Vault
  secret names only (step 04 shows how).
- Any view you ever create must be `WITH (security_invoker = true)`.
- Do not drop, truncate, or rewrite anything. Every file in this pack is additive and
  idempotent; if something appears to require a destructive statement, stop and ask.

**Success criteria:** project ref confirmed, backup exists, rules acknowledged.
**On failure:** stop; report which check failed.
