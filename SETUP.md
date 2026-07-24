# appdoivo - Setup & Hosting Guide

A small PWA for a private group of friends, with two features:

- **A Rata** - every hour a random "consequence" (suggested by users) is revealed and everyone is notified.
- **Best Outfit** - per-night voting; the admin opens and closes each night, and a ranking is published when a night closes.

This guide explains how to run it locally, how to host it safely for free, and how to buy a domain.

## Push notifications

Two automatic notifications are sent to every subscribed device:

- **A Rata (hourly):** when a new consequence is revealed, everyone receives - title "quem tem a rata?", body "temos uma nova consequência!". The consequence itself is not shown in the notification, on purpose, so people open the app to see it.
- **Best Outfit (on close):** when the admin closes a night's voting, everyone receives - title "período de votação encerrado", body "we got a winner!".

Notes:

- Push requires HTTPS. It works on `localhost`; in production you need a host with HTTPS (all the recommended hosts below provide it automatically).
- Android/Chrome: tap the notifications button inside the app.
- iPhone (iOS 16.4+): first use "Add to Home Screen", open the app from that icon, then enable notifications.

## Running locally

Requires Node.js 23.4 or newer (the app uses the built-in `node:sqlite`, so no native build step is needed).

```powershell
npm install
copy .env.example .env      # on macOS/Linux: cp .env.example .env
npm run genkeys             # generates the VAPID keys; copy them into .env
npm start
```

On the first start an admin user is created and its token is printed in the terminal. Keep it safe. To see it again:

```powershell
npm run admin-token
```

Open http://localhost:3001 (or the port set in `.env`), log in with the admin token, and go to "Admin" to create users, manage nights, and reveal consequences.

Run the test suite before deploying (it never runs in the cloud):

```powershell
npm test
```

## Is the app ready to host?

Yes, with one caveat. The app keeps no in-memory state - it only depends on a single SQLite file. A `Dockerfile` (node:24-slim) and a `fly.toml` are already provided.

The only requirement is a **persistent disk** for the SQLite database. If the host uses an ephemeral filesystem, the database is wiped on every deploy or restart, so a persistent volume is configured in `fly.toml`.

## Deploying (Fly.io, recommended)

1. Install `flyctl` and sign in: `fly auth login`
2. Create the app: `fly apps create appdoivo`
3. Create the persistent volume in the same region:
   `fly volumes create appdoivo_data --region cdg --size 1`
4. Set the secrets (these are never committed to the repository):
   ```
   fly secrets set TOKEN_SECRET=<32-byte hex> ADMIN_TOKEN=<your-admin-password> ADMIN_NAME=Ivo `
     VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@yourdomain
   ```
5. Deploy: `fly deploy`

`min_machines_running` is set to 1 in `fly.toml` so the hourly A Rata reveal fires even with no traffic. Outside events you may set it to 0 to save resources (the cron then only runs when there is a visit).

## Free hosting recommendations (app + database), securely

- **Fly.io (recommended):** hosts the app and a persistent volume for SQLite together, with free HTTPS and a small free allowance that is plenty for ~50 people. Best fit because the database lives next to the app.
- **Railway:** monthly free credit, persistent volumes, very simple deploys. Good alternative.
- **Render:** free web service, but the free plan sleeps and its persistent disk is paid. Only suitable if you host the database separately.
- **Turso (managed database):** cloud SQLite with a generous free tier; pairs with any app host. This requires swapping the `node:sqlite` client for theirs. A good option if you want to separate app and database.

Security checklist:

- Always set secrets through the host's "secrets" mechanism, never in `fly.toml` or the repository.
- Keep HTTPS enforced (already set in `fly.toml`).
- Keep `.env` in `.gitignore` (already done).
- User tokens are stored encrypted in the database (HMAC index plus AES-256-GCM), so a database leak alone does not expose them - as long as `TOKEN_SECRET` stays out of the database.

## Buying a domain

- **Cloudflare Registrar:** cheapest (at-cost, no mark-up or inflated renewals). Ideal if your chosen TLD is supported.
- **Porkbun:** cheap and simple, good for `.com` / `.app` / `.fun`.
- **Namecheap:** reliable and inexpensive.
- **`.pt` domains:** registered via dns.pt through registrars such as PTisp, Amen or 3domain.

Avoid GoDaddy (up-sells and expensive renewals). Suggested names: `appdoivo.com`, `appdoivo.fun` or `appdoivo.pt`. After deploying, point the DNS at Fly - `fly deploy` tells you which records to create.

## Environment variables (.env)

- `PORT` - server port (default 3000; this project uses 3001 locally).
- `ADMIN_TOKEN` - the admin access key. If empty, one is generated on first start.
- `ADMIN_NAME` - the admin's display name.
- `TIMEZONE` - timezone used for the A Rata "day" (e.g. `Europe/Lisbon`).
- `TOKEN_SECRET` - secret used to encrypt and index user tokens. Keep it out of the database and never share it. If you change it, nobody can log in (the stored hashes no longer match).
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` - Web Push keys (generate with `npm run genkeys`).

## Moving the project to another computer

The project contains no sensitive third-party or employer data - only the app's own secrets (in `.env`) and the friends' names/keys (in the local SQLite file under `data/`, which is git-ignored).

1. Copy the `appdoivo` folder, excluding `node_modules` (and optionally `data/` if you want to start with an empty database).
2. On the new machine run `npm install`.
3. Either bring the existing `.env`, or regenerate a fresh `TOKEN_SECRET` and new VAPID keys (`npm run genkeys`) and reset the admin.

## Important operational notes

- Any command-line script that imports `src/db.js` must load `dotenv` first (`import 'dotenv/config';`), otherwise it runs without `TOKEN_SECRET` and can corrupt the token data.
- Never commit `.env` or the `data/` folder.
