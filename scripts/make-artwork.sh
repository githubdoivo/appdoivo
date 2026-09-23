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
#
# These four numbers were tuned by eye against ONE export - the 804x1748
# illustration of 13 Sept 2026 - and mean nothing on any other. They were
# briefly scaled automatically by the source width ratio, on the assumption
# that a re-export is the same painting at a new size. That assumption is
# wrong: the 1608x3496 v2 export re-composed the scene and baked lettering
# into the top, so the scaled crop slid off the roof onto the gable wall,
# and that icon reached production before anyone looked at it.
#
# So the numbers stay fixed and the script says so when the source is not
# the one they were tuned for. Re-tune them by eye for a new export, and
# LOOK at public/icons/icon-192.png before you commit it.
REF_WIDTH=804; REF_HEIGHT=1748
SRC_WIDTH=$(sips -g pixelWidth "$SRC" | awk '/pixelWidth/{print $2}')
SRC_HEIGHT=$(sips -g pixelHeight "$SRC" | awk '/pixelHeight/{print $2}')

ICON_SIZE=338; ICON_Y=562; ICON_X=248

# The maskable icon gets a wider crop of the same spot: Android shaves a
# safe zone off every edge, so a mark framed for the plain icon loses its
# chimneys to the mask.
MASK_SIZE=422; MASK_Y=520; MASK_X=206

if [ "$SRC_WIDTH" != "$REF_WIDTH" ] || [ "$SRC_HEIGHT" != "$REF_HEIGHT" ]; then
  echo "WARNING: the crop is tuned to a ${REF_WIDTH}x${REF_HEIGHT} export;"
  echo "         this source is ${SRC_WIDTH}x${SRC_HEIGHT}. Do not trust the"
  echo "         icons this produces - re-tune ICON_*/MASK_* and check by eye."
fi

# JPEG, not a copy of the source. The illustration is painterly and has no
# transparency, so PNG spends its bytes on something nothing needs: the
# 1608x3496 source lands at 6.3MB as PNG and 768KB as JPEG q75 - and the
# 804-wide PNG this replaces was already 1.9MB. So the artwork doubled in
# resolution while the login screen got lighter, which matters because this
# is the first thing a guest loads, often on a phone at a party.
sips -s format jpeg -s formatOptions 78 "$SRC" --out public/images/login-bg.jpg >/dev/null
rm -f public/images/login-bg.png

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
