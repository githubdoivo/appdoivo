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

### Should the dedications PDF lowercase the messages too?

A question for Ivo rather than a job, found while putting a test behind the
PDF's signature. The signature is lowercased in code, because a PDF is the
one thing this app produces that `body { text-transform: lowercase }` never
reaches. The **message text** is not: it is printed exactly as the guest
typed it, capitals and all.

On screen the same message reads lowercase, because the CSS rule catches it
there. So one message currently reads two different ways depending on where
it is looked at - which is the same inconsistency the signature fix was
for, left half-done.

Deliberately not changed. The golden rule is about the app's own voice, and
these are forty private messages written to Ivo by his friends - whether
his keepsake should overrule how someone chose to write to him is his call,
not a style rule's. Two lines either way once he says.

### Express 5, after the party

Dependabot PR #68 is open and will stay open until the party is over. It
reads as a security bump and is not one: `qs` 6.15.3 -> 6.16.0 is a feature
release with no advisory attached, and Express only appears in the PR
because Dependabot has to move the ancestor dependency to reach it. What
arrives with it is Express **4.21.2 -> 5.2.1**, a major version, which is
why CI on that branch is red.

The code surface is genuinely one line: `src/app.js` ends with a
`app.get('*', ...)` SPA fallback, and Express 5's path-to-regexp rejects a
bare `*` - it wants `'*splat'`. Nothing else in the app trips a 4->5
breaking change: no `req.param()`, no `res.send(status)`, no `app.del`, no
regex routes, and every `req.query` read is a flat string, so the query
parser default moving from extended to simple changes nothing.

So it is a small job - just not one worth doing in the week a live app has
fifty guests pointed at it, for a dependency bump that fixes nothing we are
exposed to. Do it after 20 September, on a branch, through QA like anything
else.

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

The production volume was extended to 20GB on 12 September 2026, ahead of
the party. It was never a backlog item - it was a hard deadline, so it
lives with the deploy process: see "The production volume" in
[CONTRIBUTING.md](CONTRIBUTING.md).
