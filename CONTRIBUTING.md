# Development & deploy process

## Branches

Every change happens on its own branch off `main`, named by type:

- `feat/<description>` - new features
- `fix/<description>` - bug fixes
- `test/<description>` - test-only changes
- `chore/<description>` - config, docs, tooling (no app behavior change)

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
behavior safely, not for managing real users.

## Process for a change

Changes are batched: a work session typically covers several features/fixes
on one branch, tested and deployed together rather than one-change-per-branch
and one-deploy-per-change. Don't deploy after every small feature - batch the
session's work and deploy once at the end.

1. Branch off `main` with the right prefix (one branch can carry the whole
   session's worth of work).
2. Implement each change, running `npm test` locally (or `docker compose exec
   app npm test`) as you go. `npm test` covers both API/logic tests
   (`test/api.test.js`) and a real-browser UI/UX suite (`test/ui.test.js`)
   that drives the app with Playwright's WebKit engine (same engine as iOS
   Safari) across iPhone SE/13/Pro Max viewports, catching layout overflow,
   misalignment, and regressions on real device sizes before they reach QA.
   One-time setup: `npx playwright install webkit chromium`. Run just the UI
   suite with `npm run test:ui`.
3. Once the session's batch of work is complete and `npm test` passes,
   commit, push, open a PR, and merge it into `main` (delete the branch on
   merge - `gh pr merge --merge --delete-branch`).
4. Deploy `main` to QA (`fly deploy -a appdoivo-qa --config fly.qa.toml`) and
   verify manually at https://qa.appdoivo.com.
5. Only after QA is confirmed working: deploy `main` to production
   explicitly (`fly deploy -a appdoivo`). Fly's GitHub integration is
   connected but has not reliably auto-deployed on push in practice, so treat
   the manual deploy as the real step, not the integration.
6. Verify production directly (HTTP check, login, and whatever the batch
   actually touched) before considering the session's work done.

## Secrets

- `.env` (local) and `fly secrets` (per app) are the only place secrets
  live - never in a committed file.
- Production and QA have distinct `TOKEN_SECRET` and VAPID keys. The admin
  password is intentionally shared across environments for convenience.
