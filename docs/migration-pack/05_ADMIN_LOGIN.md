# Step 05 — First admin login

**Purpose:** create and promote the first dashboard owner account.

**Preconditions:** step 02 complete (the signup trigger from migration 2 must exist).

## Actions

1. Dashboard → Authentication → Users → **Invite user** → `nelson.kenny.k@gmail.com`.
2. The trigger auto-creates a `profiles` row as `viewer` (no access). Promote it:

```sql
update profiles set app_role = 'owner',
  person_id = (select id from people where lower(email) = lower(profiles.email) limit 1)
where email = 'nelson.kenny.k@gmail.com';
```

`person_id` may resolve to NULL if the `people` table is empty or holds no matching
email — that is fine; it links later when people data exists.

**Success criteria:**
`select email, app_role, active from profiles where email = 'nelson.kenny.k@gmail.com';`
returns one row with `app_role = 'owner'`, `active = true`.
**On failure:** if the profiles row is missing, the invite happened before migration 2 —
insert it manually with the auth user's UUID:
`insert into profiles (id, email, app_role) values ('<auth.users.id>', 'nelson.kenny.k@gmail.com', 'owner') on conflict (id) do update set app_role='owner';`
