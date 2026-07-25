# Development & deploy process

## Branches

Every change happens on its own branch off `main`, named by type:

- `feat/<description>` - new features
- `fix/<description>` - bug fixes
- `test/<description>` - test-only changes
- `chore/<description>` - config, docs, tooling (no app behavior change)

Never commit straight to `main`.

## Environments

- **QA** (`appdoivo-qa`, https://www.qa.appdoivo.com) - manual preview target.
  No persistent volume: the database is ephemeral and resets on every deploy.
  Same admin login as production, but its own `TOKEN_SECRET`/VAPID keys.
  Deployed manually, on demand, from whatever branch is being tested - never
  automatically. Use throwaway test users here, not real ones.
- **Production** (`appdoivo`, https://appdoivo.com) - the real app, real data,
  persistent volume. Only ever deployed from `main`.

Databases are intentionally isolated between the two - QA is for testing
behavior safely, not for managing real users.

## Process for a change

1. Branch off `main` with the right prefix.
2. Implement the change, run `npm test` locally (or `docker compose exec app
   npm test`), commit.
3. Deploy the branch to QA (`fly deploy -a appdoivo-qa --config
   fly.qa.toml`) and verify manually at www.qa.appdoivo.com.
4. Only after that's confirmed working: merge the branch into `main` and
   push.
5. Deploy `main` to production explicitly (`fly deploy -a appdoivo`). Fly's
   GitHub integration is connected but has not reliably auto-deployed on
   push in practice, so treat the manual deploy as the real step, not the
   integration.
6. Verify production directly (HTTP check, login, and whatever the change
   actually touched) before considering the change done.

## Secrets

- `.env` (local) and `fly secrets` (per app) are the only place secrets
  live - never in a committed file.
- Production and QA have distinct `TOKEN_SECRET` and VAPID keys. The admin
  password is intentionally shared across environments for convenience.
