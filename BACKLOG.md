# Backlog

Work that has been agreed but not scheduled. This is deliberately **not**
a list of blockers - nothing here holds up a release. If a build is
ready, it ships, and whatever is still on this page stays on this page.

Anything actively in progress belongs in a branch and a PR, not here.
Process lives in [CONTRIBUTING.md](CONTRIBUTING.md); this is only the
list of what is still owed, and by whom.

## Ready to build - nothing needed from Ivo

### Plaza: private birthday messages, with a PDF at the end

Guests write a message to the birthday person from a dedicated box on
Plaza. Nobody else can read them - not other guests, and not other
admins either, since the whole point is that they stay private until
opened. A card on the Plaza admin page lets the owner read the
collection and download it as a nicely formatted PDF, meant to be done
once, at the end of the party.

**The guests populate it.** Ivo writes nothing and supplies nothing; the
only thing he does is press download. This is pure development work and
can start whenever.

Needs: its own table, the guest-facing form, an owner-only read route
and PDF export, pt/en copy, and test coverage across the branch (see the
testing rules in CLAUDE.md - a passing suite is not the same as a
covered feature).

## Waiting on Ivo

These cannot start until he hands something over. Listing them is not a
nudge; they sit here until they don't.

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

## Settled

### `security@appdoivo.com` receives mail — confirmed 2026-08-09

`security.txt` is served at the edge by Cloudflare's Security Center and
names this address. DNS was already correct (Cloudflare MX, SPF, and a
DMARC record whose `rua` reports also go there), but mail was being
dropped because the routing destination had never been verified. Once
verified, a test message arrived. Worth knowing if it ever breaks again:
the symptom is silence rather than a bounce, and it cannot be probed
remotely, since Cloudflare's MX rejects senders without reverse DNS - so
the only real test is to send it an email.

## Elsewhere

The production volume has to be extended before the party. That one is a
hard deadline rather than a backlog item, so it lives with the deploy
process instead: see "Before the party: extend the production volume" in
[CONTRIBUTING.md](CONTRIBUTING.md).
