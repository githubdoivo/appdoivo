# appdoivo

A web app (PWA) with two sections:

1. A Rata - each user suggests one "consequence" per day through a free-text
   form. Every hour a random consequence is drawn, a push notification is sent,
   and everyone sees the same one. Once revealed, it is removed from the draw.
2. Best Outfit - voting is per NIGHT. This edition has two nights, each with its
   own name and aesthetic: Furnished and Swamp. A switch at the top of Best
   Outfit selects the active night; changing it re-skins the WHOLE page with
   that night's aesthetic (the other sections stay clean). Each night has its
   own contestants and its own independent vote, and each user votes once per
   night. Each night's voting is controlled manually by the admin (open /
   close & publish / reset), not on a schedule. When the admin closes a night, a
   ranking of the most-voted contestants is published to everyone.
   The nights are fixed per edition. To change year, edit `src/nights.js`
   (names/themes) and the `body.theme-*` classes in `public/css/styles.css`.

Authentication is by a unique access key per user. There is one admin user (you)
with access to everything, including the votes database. The interface has a
PT/EN language switch everywhere.

## Stack

- Node.js 23.4+ (uses the built-in `node:sqlite`, no native build step)
- Express, node-cron, web-push
- Frontend: PWA in plain HTML/CSS/JS (works on iPhone and Android without an app store)

## Running locally

```powershell
npm install
copy .env.example .env      # on macOS/Linux: cp .env.example .env
npm run genkeys             # generates the VAPID keys; copy them into .env
npm start
```

On first start the admin user is created and its token is printed in the
terminal. Keep it safe. To see it again:

```powershell
npm run admin-token
```

Open http://localhost:3001 (or the port set in `.env`), log in with the admin
token, and go to "Admin" to:

- Create users (generates a key for each; send it to them).
- Pick the night to manage (Furnished / Swamp) and, for that night: register
  contestants, control the vote (open, close & publish, reset) and see every vote.
- Set the timezone.
- See every consequence.

## Tests

A local suite (Node `node:test`, no extra dependencies) that validates the API
against a temporary database. Run it before deploying; it never runs in the cloud.

```powershell
npm test
```

## Push notifications

- Android/Chrome: just tap the notifications button inside the app.
- iPhone (iOS 16.4+): first use "Add to Home Screen" (Share > Add to Home
  Screen) and open the app from the icon. Only then does iOS allow enabling
  notifications.
- Push requires HTTPS. It works on `localhost`; in production use a host with
  HTTPS (the ones suggested below provide it automatically).

## Configuration (.env)

- `PORT` - server port (default 3000; this project uses 3001 locally).
- `ADMIN_TOKEN` - the admin access key. If empty, one is generated on first start.
- `ADMIN_NAME` - the admin's display name.
- `TIMEZONE` - timezone used for the A Rata "day" (e.g. `Europe/Lisbon`).
- `TOKEN_SECRET` - secret used to encrypt and index user tokens. Keep it out of
  the database and never share it. If you change it, nobody can log in.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` - Web Push (`npm run genkeys`).
- `DB_FILE` - (optional) database path; used by the tests (`:memory:` or a temp file).

## Deploy & hosting

See [SETUP.md](SETUP.md) for the full hosting guide: readiness checklist,
step-by-step Fly.io deploy, free hosting options for the app and database, and
where to buy a domain. A `Dockerfile` and `fly.toml` are included.

The database lives in `data/app.sqlite`. On platforms with an ephemeral
filesystem, attach a persistent volume mounted at the database path so votes and
consequences survive each deploy.

## Notes

- The database is stored in `data/app.sqlite` (ignored by Git).
- Quick API check: `node scripts/smoke.js <ADMIN_TOKEN> <port>`.
- Demo data (contestants and votes per night, consequences) for preview:
  `npm run seed-demo`. Do not use in production.
- Any CLI script that imports `src/db.js` must load `dotenv` first
  (`import 'dotenv/config';`), otherwise `TOKEN_SECRET` is undefined and the
  token data can be corrupted.
