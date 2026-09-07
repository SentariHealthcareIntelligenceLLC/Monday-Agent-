# Step 04 — Register the WhatsApp sender (CONDITIONAL)

**Purpose:** store the Meta Cloud API sender in `whatsapp_accounts`, with secrets in
Supabase Vault.

**Preconditions:** step 02 complete, AND the user has supplied all four Meta values:
system-user access token, app secret, webhook verify token, WABA id + phone number id.
**If any value is missing: SKIP this step entirely and note it in the step-06 report.**
The application's env-var fallback keeps working without it — skipping breaks nothing.

## Actions

Replace the four `<...>` placeholders, then run:

```sql
select vault.create_secret('<meta system-user token>', 'wa_token_primary');
select vault.create_secret('<meta app secret>',        'wa_app_secret_primary');
select vault.create_secret('<webhook verify token>',   'wa_verify_primary');

insert into whatsapp_accounts
  (label, waba_id, phone_number_id, display_phone,
   token_secret_name, app_secret_name, verify_token_name, status)
values
  ('Primary', '<WABA_ID>', '<PHONE_NUMBER_ID>', '<display phone>',
   'wa_token_primary', 'wa_app_secret_primary', 'wa_verify_primary', 'dry_run')
on conflict (phone_number_id) do nothing;
```

Rules: raw secrets go ONLY into `vault.create_secret(...)` — never into a table column.
`status` stays `'dry_run'`; switching to `'live'` is a separate human decision after Meta
verifies the webhook.

**Success criteria:** `select label, phone_number_id, status from whatsapp_accounts;`
returns the Primary row with status `dry_run`, and no raw token appears in any table.
**On failure:** if `vault.create_secret` errors (a secret name already exists), use
`select vault.update_secret(id, '<new value>') ` semantics or report; do not create
duplicate-named secrets.
