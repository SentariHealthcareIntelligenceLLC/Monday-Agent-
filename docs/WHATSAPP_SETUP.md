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

## 7. Add your team's numbers

Numbers are stored in **E.164 without the `+`** — e.g. `+1 (555) 867-5309` → `15558675309`.

Either edit them in the dashboard, or:

```bash
curl -u admin:YOUR_ADMIN_PASSWORD -X PATCH localhost:3000/api/people/4 \
  -H 'content-type: application/json' \
  -d '{"name":"Maria Lopez","whatsapp_number":"15558675309"}'
```

While using the free **test number**, each recipient must first be added under
WhatsApp → API Setup → "To" → **Manage phone number list** and verify the code.

## 8. Go live

1. Set `DRY_RUN=false` in `.env` and restart.
2. Trigger a test push from the dashboard: **Send reminders**.
3. Reply `DONE 1` from a team phone and confirm the board updates.

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
