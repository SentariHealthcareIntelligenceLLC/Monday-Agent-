# Connecting WhatsApp (Meta Cloud API)

Everything below is done once. Budget about an hour. Nothing here requires code changes —
you only fill in `.env`.

---

## 1. Create the Meta assets

1. Go to <https://business.facebook.com> and make sure you have a **Meta Business account**
   for QCMS (Business Settings → Business Info).
2. Go to <https://developers.facebook.com/apps> → **Create App** → type **Business**.
3. In the app, add the **WhatsApp** product.
4. Under **WhatsApp → API Setup** you get, for free:
   - a **test phone number** (send-only to 5 numbers you verify — perfect for testing)
   - a **Phone number ID**  → `WHATSAPP_PHONE_NUMBER_ID`
   - a **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`
   - a temporary 24-hour access token → `WHATSAPP_TOKEN` (fine for testing)

## 2. Get a permanent token

Temporary tokens expire daily. For production:

1. Business Settings → **Users → System Users** → Add → name it `qcms-taskbot`, role **Admin**.
2. **Add Assets** → your app and your WhatsApp account → grant full control.
3. **Generate New Token** → select the app → scopes `whatsapp_business_messaging`
   and `whatsapp_business_management` → set expiry **Never**.
4. Paste it into `WHATSAPP_TOKEN`.

## 3. Register your real clinic number (when you're ready to go live)

WhatsApp → API Setup → **Add phone number**. The number must **not** be active on
the regular WhatsApp or WhatsApp Business app. Verify by SMS/call. Then set the
new Phone number ID in `.env`.

## 4. App secret

App Dashboard → **Settings → Basic → App Secret** → `WHATSAPP_APP_SECRET`.
The service uses it to verify the `X-Hub-Signature-256` header on every inbound
webhook, so nobody can forge "task done" messages.

## 5. Point the webhook at this service

The webhook must be reachable over **HTTPS** on a public URL.

- Local testing: `npx ngrok http 3000` → gives you `https://xxxx.ngrok-free.app`
- Production: see [DEPLOY.md](DEPLOY.md)

In the App Dashboard → **WhatsApp → Configuration → Webhook → Edit**:

| Field | Value |
|---|---|
| Callback URL | `https://YOUR-DOMAIN/webhook/whatsapp` |
| Verify token | the same string you put in `WHATSAPP_VERIFY_TOKEN` |

Click **Verify and save** — the service answers Meta's handshake automatically.
Then click **Manage** and subscribe to the **`messages`** field. That is the only
one required.

## 6. Create the two message templates

Outbound messages that *start* a conversation must use a pre-approved template.
Business Manager → **WhatsApp Manager → Message templates → Create template**.
Category **Utility** (cheap, approves fast — do not pick Marketing).

### Template 1 — name: `qcms_task_reminder`, language: English (US)

Body:

```
Hi {{1}}, you have {{2}} QCMS task(s) due today:
{{3}}

Reply DONE <number> when finished, or BLOCKED <number> <reason> if you're stuck.
```

Sample values for review: `Maria` / `3` / `1. Confirm tomorrow's schedule (due 15:00) | 2. Verify insurance (due 16:00)`

### Template 2 — name: `qcms_escalation`, language: English (US)

Body:

```
Hi {{1}}, heads up: {{2}} has {{3}} overdue QCMS task(s).
{{4}}

Please follow up.
```

Sample values: `Manager` / `Maria` / `2` / `Confirm tomorrow's schedule (2026-08-20) | Verify insurance (2026-08-20)`

Approval usually lands within minutes to a few hours. If you rename them, update
`TEMPLATE_TASK_REMINDER` and `TEMPLATE_ESCALATION` in `.env`.

## 7. Subscribe to `messages` **and** `message_status`

Under WhatsApp → Configuration → Webhook → **Manage**, subscribe to:

- **`messages`** — replies and photos coming back from staff. Required.
- **`message_status`** — delivery receipts (sent → delivered → read, or failed).
  Optional, but without it the dashboard can only say a reminder *left*, not
  that it *landed*, and a silently failed send looks identical to one nobody
  answered.

## 8. Add your team's numbers

Numbers are stored in **E.164 without the `+`** — e.g. `+1 (555) 867-5309` → `15558675309`.

You no longer have to type them that way: the API normalizes whatever a human
enters (`+1 (555) 867-5309`, `555-867-5309`, `001 555 867 5309`) to the exact
form Meta sends, because a reply is matched to a person by that number alone.
A ten-digit number is assumed to be US/Canada; anyone abroad must be entered
with their own country code.

Either edit them in the dashboard, or:

```bash
curl -u admin:YOUR_ADMIN_PASSWORD -X PATCH localhost:3000/api/people/4 \
  -H 'content-type: application/json' \
  -d '{"name":"Maria Lopez","whatsapp_number":"15558675309"}'
```

While using the free **test number**, each recipient must first be added under
WhatsApp → API Setup → "To" → **Manage phone number list** and verify the code.

## 9. Create the photo-proof bucket (Supabase)

Tasks marked **requires photo** are not completed by the word "DONE" alone —
the bot holds the task open and asks for the picture, and the photo the person
sends back is what completes it. Those images are downloaded from Meta and
written to Supabase Storage.

In the Supabase dashboard → **Storage → New bucket**:

| Field | Value |
|---|---|
| Name | `qcms-proof` (must match `STORAGE_BUCKET`) |
| Public bucket | **off** — leave it private |

Keep it private. These are photographs taken inside clinical spaces; the
service reaches them with the service-role key and hands the dashboard
short-lived signed URLs instead of permanent public ones.

No storage policies are needed: the service role bypasses RLS, and nothing
else is given access to the bucket.

Then set in `.env` (or Vercel project settings):

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
STORAGE_BUCKET=qcms-proof
```

Without these two Supabase values the service falls back to writing photos to
`STORAGE_DIR` on local disk — fine for Docker or development, but on Vercel the
filesystem is ephemeral and proof would be lost, so **the bucket is required in
production**.

Run the migration so the new columns and indexes exist:

```bash
npm run migrate
```

## 10. Go live

1. Set `DRY_RUN=false` in `.env` and restart.
2. Trigger a test push from the dashboard: **Send reminders**.
3. Reply `DONE 1` from a team phone and confirm the board updates.
4. On a task that requires a photo, reply `DONE`, then send a picture — the
   board should flip to complete with the photo attached to the run.

---

## Cost and rules worth knowing

- **Utility** template conversations are billed per 24-hour conversation window and
  are inexpensive; service replies inside an open window are free. Meta changes
  pricing periodically — check the current rate card before rolling out to many people.
- You may send **free-form text only within 24 hours** of the person's last message
  to you. That's why reminders use templates and replies use plain text. The code
  already follows this rule.
- Keep template content transactional. Anything that reads like marketing risks
  rejection or a higher rate.
- Staff should save the clinic number in their contacts so messages don't look like spam.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Webhook "Verify and save" fails | URL must be public HTTPS; `WHATSAPP_VERIFY_TOKEN` must match exactly |
| Inbound messages return 401 | `WHATSAPP_APP_SECRET` is wrong or missing |
| `(#132001) Template name does not exist` | Template not approved yet, or the language code isn't `en_US` |
| `(#131047) Re-engagement message` | You tried free-form text outside the 24-hour window — use a template |
| Nothing sends, no errors | `DRY_RUN` is still `true`; check `/api/messages` for `dry_run` rows |
| "This number is not registered" on a real staff reply | The stored number doesn't match what Meta sends. Re-save it through the dashboard or API — it is normalized on write — and check `people.whatsapp_number` is bare digits with a country code |
| A reply completes two tasks | Should not happen: inbound messages are deduplicated on Meta's message id. If it does, confirm migration `002` ran and `idx_msg_wa_in` exists |
| Photo replies do nothing | The bucket is missing or `SUPABASE_SERVICE_ROLE_KEY` is wrong — look for `Photo proof failed` in the logs; the task stays open so the person can retry |
| Task stuck at "needs a photo" | Someone replied DONE to a `requires_photo` task and never sent one. Clear it from the board, or have them send the picture |
| Reminders show `sent` but never `delivered` | Subscribe to the `message_status` webhook field (step 7) |
