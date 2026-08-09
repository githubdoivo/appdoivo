# Backlog

Work that has been agreed but not scheduled: features not started yet,
and things waiting on something outside the code. This is deliberately
**not** a list of blockers - nothing here holds up a release. If a build
is ready, it ships, and whatever is still on this page stays on this page.

Anything actively in progress belongs in a branch and a PR, not here.
Process lives in [CONTRIBUTING.md](CONTRIBUTING.md); this is only the
list of what is still owed.

## Features not started

### Plaza: private birthday messages, with a PDF at the end

Guests write a message to the birthday person from a dedicated box on
Plaza. Nobody else can read them - not other guests, and not other
admins either, since the whole point is that they are private until
opened. A card on the Plaza admin page lets the owner read the
collection and download it as a nicely formatted PDF, which is meant to
be done once, at the end of the party.

Needs: its own table, the guest-facing form, an owner-only read route
and PDF export, pt/en copy, and test coverage across the branch (see the
testing rules in CLAUDE.md - a passing suite is not the same as a
covered feature).

## Waiting on an asset

### High-resolution vectorised login background

The login background is still the placeholder noted in `styles.css`
(`#login`). Ivo is providing a properly vectorised version of the same
artwork. Once it lands, both the login image **and** every app icon size
need regenerating from it - the current icons were cropped from the
cottage in the placeholder, so they inherit its resolution.

### Copy rewrite pass

Every user-facing string is laid out for review, pt and en side by side,
in the strings artifact and the matching spreadsheet. Ivo is doing the
rewrite himself; blank entries mean "leave this one alone". Nothing to
do here until those come back.

## Verification owed

### Does `security@appdoivo.com` actually receive mail?

`security.txt` is served at the edge by Cloudflare's Security Center and
names this address, and DNS is set up for it - Cloudflare MX records,
SPF, and a DMARC record whose `rua` reports also go there. What is *not*
confirmed is that a routing rule exists for the address and that its
destination has been verified. If it has not, a researcher's report
bounces and the DMARC reports are lost too, which defeats the point of
publishing the file at all.

Check under Cloudflare -> appdoivo.com -> Email -> Email Routing: either
a rule for `security@` or a catch-all, pointing at a **Verified**
destination. The conclusive test is simply to send it an email and see
whether it arrives - it cannot be probed remotely, since Cloudflare's MX
rejects senders without reverse DNS.

## Elsewhere

The production volume has to be extended before the party. That one is a
hard deadline rather than a backlog item, so it lives with the deploy
process instead: see "Before the party: extend the production volume" in
[CONTRIBUTING.md](CONTRIBUTING.md).
