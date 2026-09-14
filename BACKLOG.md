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

### Rotate the QA access key

On 14 September 2026 a command meant to check whether Ivo had an account on
QA printed the whole user row instead of just the name and permissions, and
that row carries the `token` field. His **QA** key is therefore written into
a chat transcript, which closing the chat does not undo. The key was not
changed and not used; it was only exposed. **Production was never involved.**

Rotating it is Manage Users -> his own row -> regenerate key, and then
claiming the new one through the name search on the QA login screen, which
reopens by itself whenever a key is regenerated. That route matters: it means
the replacement never has to be read out or pasted anywhere.

Deliberately not treated as urgent. QA is publicly reachable, so the exposure
is real in the sense that someone holding the transcript could sign in there
as the owner - but there is nothing on QA except test accounts and whatever
we filled it with ourselves. Ivo already has a text file of keys, so rotating
costs him an edit to that file. His call, and a defensible one either way.

### Push reach on production, and what decides it

Not a task - a measurement, written down because it answers a question that
will be asked again and because the number moves on its own as people install
the app.

On 14 September 2026, with 24 accounts on production, **4 people** had
notifications active, across 7 devices. Everything server-side is in place:
the three VAPID secrets are deployed and the server logs no missing-key
warning.

The gap is not a fault, it is how Web Push works. Nobody can be switched on
from this end: a person only becomes reachable once they have opened the app
and allowed notifications on that device. On iPhone there is a further
condition that catches people out - Web Push only reaches an app that has
been **added to the Home Screen**; a page left open in a Safari tab receives
nothing however many times permission is granted.

So during testing, the reachable set is whoever has installed it, which is
what the 4 above means. It should climb by itself as the rest of the guests
install before the party.

There is no endpoint for sending a free-text notification - every push in this
app is tied to a real action - so the way to reach everyone deliberately is to
publish a Wall announcement, which sends "wall - o anfitrião deixou um novo
anúncio na wall" and opens on the post. Worth knowing; not a suggestion to do
it.

### Whether a Memo selfie comes back mirrored

Ivo raised this while testing and it is still unresolved, because the half
that is left needs an iPhone.

What was measured, all of it against QA: the app mirrors nothing of its own -
no transform in the CSS, no re-encoding on upload, and a photo comes back out
of `/memo/uploads` byte for byte identical to the one that went in, EXIF and
all. The browser applies EXIF orientation properly, including the mirrored
values: a test image with red on the left and orientation 2 renders with blue
on the left, which is correct behaviour and matches what the Photos app does.

Which leaves exactly one place a mirror could still be introduced, and it is
the one place that cannot be tested from here: an iPhone stores photos as
HEIC and Safari converts them to JPEG at the moment of upload. If that
conversion applies the rotation but mishandles the mirror flag, the result is
a selfie that disagrees with the gallery it came from.

The step that settles it is to shoot one selfie into Memo and compare it with
the same photo in the gallery. If they differ, the fix is to normalise
orientation server-side on upload - baking the EXIF flag into the pixels so
nothing is left for a viewer to interpret - and that is worth writing only
once the problem is known to be real.

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
