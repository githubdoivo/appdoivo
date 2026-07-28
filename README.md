# appdoivo

A private-party PWA (~50 guests) with four features, all behind one login:

1. **Wall** (internal name `plaza`) - the owner/admins post announcements or
   polls (2-6 options) for everyone to see. Posts can be pinned to the top.
   Publishing sends a push notification to the group.
2. **Rata** - each user suggests one "consequence" per day through a
   free-text form. Every 3 hours (16:00-04:00) a random pending consequence
   is drawn, everyone is notified, and it is removed from the draw. The
   owner can record who's actually holding the rata for the current
   consequence (only knowable by looking around the party).
3. **Snatch** (internal name `outfit`) - per-night outfit voting. This
   edition has two nights, each with its own name and aesthetic: Furnished
   and Swamp. A switch at the top selects the active night; changing it
   re-skins the whole page with that night's look (other tabs stay clean).
   Users can self-register their own persona (solo or as a duo). Each night
   is controlled manually by the admin (open registration, open voting,
   close, then reveal results in stages: 3rd -> 2nd -> 1st -> everyone).
   The nights are fixed per edition - to change year, edit `src/nights.js`
   (names/themes) and the `body.theme-*` classes in `public/css/styles.css`.
4. **Plaza** (internal name `chat`) - an open, ephemeral group chat. Every
   post is anonymous to everyone except the owner (each user gets a stable
   per-device pseudonym; the owner alone can see who's behind it). Keeps
   only the 15 most recent messages, no time-based expiry.

Login is by a unique access key per user (a first-time "find my name"
search flow lets a new guest claim their own key without the owner handing
it out). There are three roles:

- **Owner** - the one account created on first boot. Full access, including
  everyone's plaintext access keys and who's behind each Plaza pseudonym.
- **Admin** - a promoted regular user (only possible where
  `ENABLE_ADMIN_PROMOTION=true`, e.g. QA). Gets the admin panel (post to the
  Wall, run Snatch voting, reveal consequences) but never sees other users'
  access keys or Plaza identities - those stay owner-only regardless.
- **User** - a regular guest: votes, suggests consequences, posts to Plaza,
  reads the Wall.

The interface has a PT/EN language switch everywhere.

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

On first start the owner account is created and its token is printed in the
terminal. Keep it safe. To see it again:

```powershell
npm run admin-token
```

Open http://localhost:3001 (or the port set in `.env`), log in with that
token, and go to Settings to:

- Create users (generates a key for each; send it to them).
- Post to the Wall (announcement or poll).
- Pick the night to manage (Furnished / Swamp) and, for that night: register
  contestants, control the vote (registration, open, close, reveal results
  in stages), and see every vote.
- See and reveal consequences, and record who's holding the rata.

Optional local env flags (see `.env.example`):

- `ENABLE_PLAZA=true` - turns on the Wall tab (off by default locally; on in
  both QA and production).
- `ENABLE_ADMIN_PROMOTION=true` - lets the owner promote/revoke other users'
  admin status from Settings.
- `SEED_DEMO=true` - auto-loads demo users/contestants/consequences on every
  boot. Never set this in production; it's meant for QA/local preview
  (equivalent to running `npm run seed-demo` manually).

## Tests

A local suite (Node's built-in `node:test`, no extra dependencies) covering
both the API/logic (`test/api.test.js`) and a real-browser UI suite
(`test/ui.test.js`, Playwright WebKit, same engine as iOS Safari) across
iPhone SE/13/Pro Max viewports. Runs against a temporary database and never
touches the real one. Run it before deploying:

```powershell
npm test
```

A pre-commit hook and CI (GitHub Actions) both run this same suite - see
[CONTRIBUTING.md](CONTRIBUTING.md) for the full process.

## Push notifications

Every feature notifies the group when something happens - a new Wall post,
a revealed consequence, Snatch registration/voting opening or closing and
results being revealed, or a new Plaza post (skipping the poster's own
device). Each notification opens the app straight to the relevant tab. See
`broadcast(` calls in `src/consequences.js`, `src/routes.js`, and
`src/push.js` for the exact copy.

- Android/Chrome: just tap the notifications button inside the app.
- iPhone (iOS 16.4+): first use "Add to Home Screen" (Share > Add to Home
  Screen) and open the app from the icon. Only then does iOS allow enabling
  notifications.
- Push requires HTTPS. It works on `localhost`; in production use a host with
  HTTPS (the ones suggested in [SETUP.md](SETUP.md) provide it automatically).

## Configuration (.env)

- `PORT` - server port (default 3000; this project uses 3001 locally).
- `ADMIN_TOKEN` - the owner's access key. If empty, one is generated on first start.
- `ADMIN_NAME` - the owner's display name.
- `TOKEN_SECRET` - secret used to encrypt and index user tokens. Keep it out of
  the database and never share it. If you change it, nobody can log in.
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` - Web Push (`npm run genkeys`).
- `ENABLE_ADMIN_PROMOTION` - lets the owner promote/revoke other users' admin status.
- `ENABLE_PLAZA` - turns on the Wall tab. Off by default locally; on in both QA and production.
- `SEED_DEMO` - auto-loads demo data on boot. QA only, never production.
- `DB_FILE` - (optional) database path; used by the tests (`:memory:` or a temp file).
- `APP_ENV` - (optional) labels the version badge (e.g. `qa`) so it's obvious which environment is open.

## Deploy & hosting

See [SETUP.md](SETUP.md) for the full hosting guide: readiness checklist,
step-by-step Fly.io deploy, free hosting options for the app and database, and
where to buy a domain. A `Dockerfile` and `fly.toml`/`fly.qa.toml` are included.

The database lives in `data/app.sqlite`. On platforms with an ephemeral
filesystem, attach a persistent volume mounted at the database path so votes and
consequences survive each deploy.

## Notes

- The database is stored in `data/app.sqlite` (ignored by Git).
- Demo data (users, contestants and votes per night, consequences) for
  preview: `npm run seed-demo`. Do not use in production.
- Any CLI script that imports `src/db.js` must load `dotenv` first
  (`import 'dotenv/config';`), otherwise `TOKEN_SECRET` is undefined and the
  token data can be corrupted.
