# Deploying

The service needs: Node 20.16+ (or 22+), a writable disk for the SQLite file, and a
public HTTPS URL for the WhatsApp webhook. There are **no npm dependencies** —
`npm install` is a no-op.

## Option A — Render / Railway / Fly.io (easiest)

1. Push this repo to GitHub.
2. Create a **Web Service** pointing at the repo.
   - Build command: *(leave empty)*
   - Start command: `npm start`
3. Add every variable from `.env.example` in the dashboard's environment settings.
4. Add a **persistent disk** mounted at `/data` and set `DATABASE_FILE=/data/qcms.sqlite`.
   Without a persistent disk the task history resets on each deploy.
5. Copy the service URL and use `https://YOUR-URL/webhook/whatsapp` as the Meta callback.

## Option B — Docker

```bash
docker build -t qcms-taskbot .
docker run -d --name qcms-taskbot -p 3000:3000 \
  --env-file .env -v qcms-data:/app/data qcms-taskbot
```

Put it behind Caddy, nginx, or Cloudflare Tunnel for TLS.

## Option C — A VM with systemd

```ini
# /etc/systemd/system/qcms-taskbot.service
[Unit]
Description=QCMS Task Bot
After=network.target

[Service]
WorkingDirectory=/opt/qcms-taskbot
ExecStart=/usr/bin/node src/server.js
EnvironmentFile=/opt/qcms-taskbot/.env
Restart=always
User=qcms

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now qcms-taskbot
```

## First run

```bash
npm run migrate   # create tables
npm run seed      # load the QCMS org chart + starter task library (optional)
```

Then open the dashboard at `/` (user `admin`, password `ADMIN_PASSWORD`) and replace
the seeded people with your real team and phone numbers.

## Backups

Everything lives in one SQLite file. A nightly copy is enough:

```bash
0 2 * * * sqlite3 /data/qcms.sqlite ".backup '/backups/qcms-$(date +\%F).sqlite'"
```

## Security notes

- Put the dashboard behind HTTPS — Basic auth over plain HTTP exposes the password.
- Set a strong `ADMIN_PASSWORD`. Never commit `.env`.
- `WHATSAPP_APP_SECRET` must be set in production so forged webhooks are rejected.
- Task titles are visible in WhatsApp notifications — keep **PHI out of task titles**.
  Reference charts and patients by internal ID, not by name. WhatsApp is not a
  HIPAA-covered channel and Meta will not sign a BAA for the Cloud API, so treat
  every message as if it could be read on a lock screen.
