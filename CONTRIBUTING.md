# Development & deploy process

## Branches

Every change happens on its own branch off `main`, named by type:

- `feat/<description>` - new features
- `fix/<description>` - bug fixes
- `test/<description>` - test-only changes
- `chore/<description>` - config, docs, tooling (no app behaviour change)

Never commit straight to `main`.

## Environments

- **QA** (`appdoivo-qa`, https://qa.appdoivo.com) - manual preview target.
  No persistent volume: the database is ephemeral and resets on every deploy.
  Same admin login as production, but its own `TOKEN_SECRET`/VAPID keys.
  Deployed manually, on demand, from whatever branch is being tested - never
  automatically. Use throwaway test users here, not real ones.
- **Production** (`appdoivo`, https://appdoivo.com) - the real app, real data,
  persistent volume. Only ever deployed from `main`.

Databases are intentionally isolated between the two - QA is for testing
behaviour safely, not for managing real users.

## Process for a change

Changes are batched: a work session typically covers several features/fixes
on one branch, tested and deployed together rather than one-change-per-branch
and one-deploy-per-change. Don't deploy after every small feature - batch the
session's work and deploy once at the end.

1. Branch off `main` with the right prefix (one branch can carry the whole
   session's worth of work).
2. Implement each change. `npm test` covers both API/logic tests
   (`test/api.test.js`) and a real-browser UI/UX suite (`test/ui.test.js`)
   that drives the app with Playwright's WebKit engine (same engine as iOS
   Safari) across iPhone SE/13/Pro Max viewports, catching layout overflow,
   misalignment, and regressions on real device sizes before they reach QA.
   One-time setup: `npx playwright install webkit chromium`. Run just the UI
   suite with `npm run test:ui`.
3. Commit. A pre-commit hook (`.githooks/pre-commit`, wired up automatically
   via `npm install`'s `postinstall` - no husky, plain git hook) runs
   `npm test` and blocks the commit if anything fails, so this doesn't rely
   on remembering to run it manually.
4. Push the branch. Once a PR is open, every push to it also runs the same
   suite via GitHub Actions (`.github/workflows/test.yml`) - a red check
   there means the branch isn't safe to deploy or merge. Plain pushes
   without an open PR don't trigger CI, to avoid noise on WIP commits that
   aren't close to main yet.
5. Deploy the branch straight to QA with `scripts/deploy.sh qa` (wraps
   `npm test` + `fly deploy -a appdoivo-qa --config fly.qa.toml` - refuses
   to deploy if tests fail) so it can be checked live at
   https://qa.appdoivo.com before it's even merged. Bump the version in
   `package.json` before each QA deploy, so the version badge makes it
   obvious which build is live.
6. Once it's confirmed working on QA, open a PR and merge it into `main`
   (delete the branch on merge - `gh pr merge --merge --delete-branch`).
7. Only after merging: deploy `main` to production with
   `scripts/deploy.sh prod`. Fly's GitHub integration is connected but has
   not reliably auto-deployed on push in practice, so treat this script as
   the real deploy step, not the integration.
8. Verify production directly (HTTP check, login, and whatever the batch
   actually touched) before considering the session's work done.

### Before the party: extend the production volume

**The party is 18-20 September 2026.** Memo stores every uploaded photo
and video, plus the generated day videos, as real files on the production
volume (`/data/memo-uploads`) - not as rows in SQLite. That volume is
still at its original **1GB**, which Memo would fill on day one, and a
full disk means uploads start failing mid-party.

Sometime in the week before (~14 September), extend it:

```
fly volumes extend vol_v8ep3d82yoxxg65v -s 20 -a appdoivo
```

Sizing: ~50 guests x 5 slots/day at a realistic ~12MB average is ~3GB a
day, so 20GB covers the whole weekend with room to spare. Two things to
know before running it:

- Fly bills volumes on **provisioned** size, not bytes used - 20GB costs
  ~$3/month from the moment you extend, whether or not it's full.
- A volume can be **extended but never shrunk**, so this is one-way.
  That's why it's deliberately left until close to the date rather than
  done up front.

## Secrets

- `.env` (local) and `fly secrets` (per app) are the only place secrets
  live - never in a committed file.
- Production and QA have distinct `TOKEN_SECRET` and VAPID keys. The admin
  password is intentionally shared across environments for convenience.
