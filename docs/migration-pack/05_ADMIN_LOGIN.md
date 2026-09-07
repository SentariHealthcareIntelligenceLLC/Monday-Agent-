# Step 05 — First admin login

> **Reconstructed.** This step is required by `00_README_MANIFEST.md`, but the file was
> never delivered with the pack. The procedure below is derived from what migration 0002
> actually does; treat it as a best reconstruction and check it against the original if
> that file turns up.

**Purpose:** create the first dashboard account and promote it to `owner`. Until one
profile holds `owner` or `manager`, nobody can read anything through the dashboard —
`handle_new_user()` lands every new signup as `viewer` with no `person_id`.

**Preconditions:** step 02 complete. `SUPABASE_ANON_KEY` set (see `.env.example`).

## Actions

1. Supabase → Authentication → Users → **Add user**, with the real email of the owner.
   (Signing up through the dashboard login form works identically — the trigger fires
   either way.)
2. Confirm the trigger provisioned a profile:

   ```sql
   select id, email, app_role, person_id, active from profiles order by created_at;
   ```

   Expect one row, `app_role = 'viewer'`. If `people` already holds a row whose email
   matches, `person_id` is linked automatically; otherwise it is null.
3. Promote that row, and link it to the operator's `people` row if there is one:

   ```sql
   update profiles
      set app_role  = 'owner',
          person_id = (select id from people where lower(email) = lower('<owner email>') and active = 1)
    where email = '<owner email>';
   ```

4. Log in to the dashboard as that user and confirm the tabs load.

Rules: promote exactly one account to `owner` here. Everyone else stays `viewer` until an
owner promotes them — that is the intended default, not a bug. Never grant `anon` a policy
to work around a login problem (step 01).

**Success criteria:** exactly one `profiles` row with `app_role = 'owner'`, and that user
can read the dashboard.
**On failure:** if no profile row appeared, the `on_auth_user_created` trigger is missing —
re-run migration 0002 and re-check before creating users by hand.
