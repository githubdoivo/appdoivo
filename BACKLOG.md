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

### Express 5, after the party

Dependabot raised this as PR #68 and then closed it automatically on
12 Sept 2026, when merging the multer bump moved the lockfile underneath
it. It will come back on its own; this note is here so the same decision
does not have to be made from scratch when it does.

It reads as a security bump and is not one: `qs` 6.15.3 -> 6.16.0 is a
feature release with no advisory attached, and Express only appeared in the
PR because Dependabot has to move the ancestor dependency to reach it. What
arrives with it is Express **4.21.2 -> 5.2.1**, a major version, which is
why CI on that branch was red.

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

### A higher-resolution login illustration, if one exists

The artwork was replaced on 13 Sept 2026 with the version Ivo sent, and
every icon was regenerated from it on the same crop (roof and both
chimneys) - see `scripts/make-artwork.sh` for the exact numbers.

It is worth knowing what it is not, though: the file is **804x1748**, and
a modern iPhone is 1170-1320 device pixels wide, so it is being upscaled
about 1.5x. For a soft painterly illustration that reads as atmosphere
rather than detail, which is what this is, it holds up - the screenshots
look fine. But if the original exists at a larger size (or as the vector
it was drawn from), re-exporting at 1320px wide or more and re-running
the script would be a free improvement.

Not urgent, and explicitly not a blocker: what is shipped looks right.

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
