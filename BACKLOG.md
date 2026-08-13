# Backlog

Work that has been agreed but not scheduled. This is deliberately **not**
a list of blockers - nothing here holds up a release. If a build is
ready, it ships, and whatever is still on this page stays on this page.

Anything actively in progress belongs in a branch and a PR, not here.
Process lives in [CONTRIBUTING.md](CONTRIBUTING.md); this is only the
list of what is still owed, and by whom.


## Waiting on Ivo

These cannot start until he hands something over. Listing them is not a
nudge; they sit here until they don't.

### Three guest accounts missing from production

Read off Ivo's own Guest DB on 12 Aug 2026: 24 guests plus the owner, 25
accounts in all. `src/seedDemo.js` matches that list, so QA rebuilds
itself correctly on every deploy. Production holds 22 and is missing:

- **Joana Correia**
- **Manuel Antunes**
- **Zé Monteiro** — removed from production on 11 Aug for not being on
  the shorter list that was to hand at the time. He was on the real one
  all along.

Nobody needs their key handed to them: each claims their own through the
first-time name search. The quickest route is Ivo typing the three names
into Manage Users himself — Claude Code's sandbox permits reading the
production database but refuses to write to it, and the permission rule
that would change that did not take effect mid-session (see the note in
`.claude/settings.local.json`).

Wants doing before invitations go out, since three guests currently have
no way in. The party is 18–20 Sept 2026.

### Replace both Fly API tokens

`FLY_API_TOKEN_QA` and `FLY_API_TOKEN_PROD` were both echoed into a
session transcript on 11 Aug 2026 — an unquoted value in `.env` run
through `source`, which fails with the value itself in the error. They
still work and are still in use; they should not be.

Revoking has to happen in the Fly dashboard: the Fly API deliberately
does not let a token revoke itself or any other. Once replaced, write
them back **quoted** — `scripts/deploy.sh` now strips surrounding quotes
when reading `.env`, so the quoted form is what survives the same
accident a second time.

The narrower replacement is one app-scoped deploy token per environment
rather than an account-wide one, so a leaked QA credential cannot reach
production at all.

### Two things that need a clock the tests can hold still

**Memo's dead zone.** The app's day rolls over at 06:00 (`today()` in
`time.js`) while Memo's window closes at 02:00, so between those hours a day
with no schedule yet gets one generated into the small hours, outside the
window it is meant to live in. Guarding against it is two lines; the reason
it is not done is that four Memo tests generate their slots from the real
clock, so the guard makes them fail when the suite runs between 02:00 and
06:00 - which is how this was found. Fixing it properly means giving the
tests an injectable now(), then the guard.

On production the schedule already exists from the afternoon before, so
this only shows on a freshly wiped QA opened in the small hours.

**The dedications PDF has no test.** `GET /admin/dedications.pdf` now
lowercases the signature, because a PDF is the one thing this app produces
that `body { text-transform: lowercase }` never reaches. There is no test
behind that fix: PDFKit deflates its content streams and reading the drawn
text back out needs a PDF parser this project does not carry. Worth either
a small dev dependency or a `compress: false` seam for tests, so the golden
rule is guarded there the way it is for push notification copy.

### The tab-row test depends on a font arriving over the network

`neither tab row can be dragged sideways` failed once on CI (12 Aug 2026)
with the guest row overflowing by 15px on an iPhone SE, and passed on a
re-run of the same commit with nothing changed. The row sits at its minimum
gap on a 320px screen, so it has almost no slack: if the Google Fonts
stylesheet does not arrive, the fallback serif is wide enough to push it
over, and the test reads that as a regression.

Nothing is broken - the row scrolls rather than breaking, and the page-level
overflow tests pass either way. But a red cross that means "the font CDN was
slow" costs someone an afternoon eventually. The fix is to self-host the two
faces instead of linking them, which also removes a third-party request from
every cold start; the test can then stop being weather-dependent.

### High-resolution vectorised login background

The login background is still the placeholder noted in `styles.css`
(`#login`). Ivo is providing a properly vectorised version of the same
artwork. Once it lands, both the login image **and** every app icon size
need regenerating from it - the current icons were cropped from the
cottage in the placeholder, so they inherit its resolution.

### Copy rewrite

Every user-facing string is laid out for review, pt and en side by side,
in the strings artifact and the matching spreadsheet. Ivo is rewriting
them himself; a blank entry means "leave this one alone". Unrelated to
the PDF feature above - this is the app's own wording, not anything
guests write.

Finished items come off this page rather than moving to a "done"
section - a backlog that accumulates history stops being read. Anything
worth keeping from a finished item goes wherever that knowledge belongs
(usually CONTRIBUTING.md), not here.

## Elsewhere

The production volume has to be extended before the party. That one is a
hard deadline rather than a backlog item, so it lives with the deploy
process instead: see "Before the party: extend the production volume" in
[CONTRIBUTING.md](CONTRIBUTING.md).
