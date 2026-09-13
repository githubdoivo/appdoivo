#!/bin/bash
# Regenerates the login background and every app icon from one source
# illustration. Run it when the artwork changes; the outputs are committed,
# so a normal build never needs it.
#
#   ./scripts/make-artwork.sh path/to/illustration.png
#
# macOS only - it uses sips, which ships with the OS. That is deliberate:
# this runs by hand a couple of times a year, and is not worth adding an
# image library to the project's dependencies for.
set -euo pipefail

SRC="${1:?usage: make-artwork.sh <source.png>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The icon crop: the mossy roof with both chimneys and their smoke, the
# dormer window low-left, and the corner of the white gable wall low-right.
# These numbers are tuned to the 804x1748 illustration delivered on 13 Sept
# 2026 and were chosen by matching the framing of the previous icon, not
# derived from anything - if the source is re-exported at a different size,
# scale them by the width ratio and check the result by eye.
ICON_SIZE=338; ICON_Y=562; ICON_X=248

# The maskable icon is the same centre, pulled back about 25%. Android and
# friends apply their own circular or rounded mask to it, so the subject has
# to survive having its corners cut off - a crop as tight as the icon above
# loses the chimneys to the mask.
MASK_SIZE=422; MASK_Y=520; MASK_X=206

cd "$ROOT"
cp "$SRC" public/images/login-bg.png

sips -c $ICON_SIZE $ICON_SIZE --cropOffset $ICON_Y $ICON_X "$SRC" --out /tmp/_icon.png >/dev/null
sips -c $MASK_SIZE $MASK_SIZE --cropOffset $MASK_Y $MASK_X "$SRC" --out /tmp/_mask.png >/dev/null

for s in 180 192 512; do
  sips -s format png --resampleHeightWidth $s $s /tmp/_icon.png --out "public/icons/icon-$s.png" >/dev/null
done
sips -s format png --resampleHeightWidth 512 512 /tmp/_mask.png --out public/icons/icon-maskable-512.png >/dev/null
for s in 16 32; do
  sips -s format png --resampleHeightWidth $s $s /tmp/_icon.png --out "public/icons/favicon-$s.png" >/dev/null
done

# The SVG favicon is the same crop embedded as a base64 PNG, at 128px rather
# than 32 so it still holds up where a browser draws the favicon larger than
# the tab. Only the payload is replaced; the comment in the file stays.
sips -s format png --resampleHeightWidth 128 128 /tmp/_icon.png --out /tmp/_fav128.png >/dev/null
python3 - <<'PY'
import base64, re
b64 = base64.b64encode(open('/tmp/_fav128.png','rb').read()).decode()
p = 'public/icons/favicon.svg'
s = open(p).read()
new = re.sub(r'(href="data:image/png;base64,)[^"]*(")', lambda m: m.group(1)+b64+m.group(2), s, count=1)
assert new != s, 'favicon.svg payload not found - has the file changed shape?'
open(p, 'w').write(new)
PY

rm -f /tmp/_icon.png /tmp/_mask.png /tmp/_fav128.png
echo "done - remember to bump the ?v= on the icon links in index.html and settings.html"
