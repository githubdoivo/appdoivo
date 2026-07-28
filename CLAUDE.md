# Working with Claude on appdoivo

This file is project context for AI assistants (Claude Code and others) working
in this repo. For what the app does and how to run/deploy it, see
[README.md](README.md), [SETUP.md](SETUP.md), and
[CONTRIBUTING.md](CONTRIBUTING.md) — this file is about *how to work here*,
not what the app is.

## What this is

appdoivo is a PWA built for Ivo's birthday party (~50 guests), four features
under one login: **Wall** (announcements/polls), **Rata** (daily consequence
game), **Snatch** (per-night outfit voting), **Plaza** (anonymous open chat).
See README.md for the full breakdown and role model (owner/admin/user).

**Naming quirk to know before touching feature code:** Wall and Plaza swapped
*display* labels partway through development, but their *internal*
identifiers were deliberately left unchanged to minimize risk — the DOM
attribute `data-tab="plaza"` and the route/DB naming `plaza` refer to what's
now displayed as "Wall"; `data-tab="chat"`/`chat` routes are what's now
displayed as "Plaza". Same story for "A Rata" → "Rata" and "Best Look" →
"Snatch" (labels only, internal names `rata`/`outfit` unchanged). Don't
"fix" this mismatch — it's intentional. When grepping for a feature, search
by its *internal* name, not its current display label.

## Design rules

- **No uppercase, anywhere — golden rule.** `body { text-transform:
  lowercase; }` in `styles.css` enforces this globally. Never add
  `text-transform: uppercase` to a new component (badges/eyebrows/labels are
  the usual place this slips in). If you catch one, fix it the same way the
  rest of the app does: `text-transform: lowercase;`, not just removing the
  rule.
- Copy tone: short, human, avoid leaning on a repeated word/phrase across
  messages just for "voice consistency" — reads as forced, not intentional.
- Language: European Portuguese, not Brazilian (*ecrã* not *tela*,
  *utilizador* not *usuário*, tu-form verbs), UK-leaning English (*queue*
  not *line*). No gendered nouns/pronouns in user-facing copy.
- Match the app's existing visual language (paper texture, per-theme SVG
  motifs, serif/script font pairing) rather than introducing new patterns
  — check `styles.css`'s theme blocks (`body.theme-*`) before adding a new
  surface.

## Git & deploy workflow

Full process in [CONTRIBUTING.md](CONTRIBUTING.md); the short version:

1. Branch off `main` (`feat/`, `fix/`, `test/`, `chore/` prefix). **Never
   commit straight to `main`** except for an explicit "hotfix" request (see
   below).
2. Implement the whole requested batch of changes first — `npm test` and
   commit **once** at the end of the batch, not after every small change.
3. Deploy the branch straight to QA (`scripts/deploy.sh qa`) so it can be
   checked live before merging. **Bump the version in `package.json` before
   every QA deploy** — the version badge is how a build gets identified at a
   glance.
4. Once confirmed on QA, open a PR, merge to `main`, then deploy prod
   (`scripts/deploy.sh prod`) — only after explicit go-ahead, never
   proactively.
5. Verify deploys with real commands (`curl` the `/api/version` endpoint,
   check logs), not just "should be deployed now."

**"Hotfix" is a specific signal**: if the user says "hotfix X, deploy to QA
and prod," that means skip the branch step — commit straight to `main`, test,
deploy QA, verify, deploy prod, verify, all in one go. Everything else uses
the normal branch → QA → approve → prod flow above.

## Testing

- `npm test` runs both `test/api.test.js` (server logic) and
  `test/ui.test.js` (real-browser Playwright/WebKit — same engine as iOS
  Safari — across iPhone SE/13/Pro Max viewports). Both must pass before
  considering a change done.
- A pre-commit hook and GitHub Actions CI both run the same suite
  automatically — don't skip or work around either.
- A test that fails identically across multiple runs is a real regression;
  a test that fails once and passes on retry in isolation is usually load-
  induced flakiness (this suite runs the full browser matrix in parallel) —
  confirm which one it is by re-running the specific test alone before
  concluding either way.

## Collaboration preferences

- Move fast on implementation without asking permission for each small step
  — implement, test, report. Batch rapid-fire follow-up requests instead of
  only addressing the latest one.
- Explicit check-in required before: deploying to **production**, rotating
  **already-live** secrets, writing directly to a production database, or
  anything else destructive/costly.
- Always verify claims with real commands (curl checks, `npm test` output,
  reading actual file/DB state) rather than asserting something worked.
- When something breaks, explain the actual root cause, not just the patch.
