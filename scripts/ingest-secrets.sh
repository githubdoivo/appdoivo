#!/bin/bash
# Reads credentials out of a file you drop somewhere and writes them into
# .env, without any of them being printed to a terminal or a transcript.
#
#   ./scripts/ingest-secrets.sh ~/Downloads/creds.txt
#
# The file is expected to be plain KEY=value lines, one per credential, e.g.
#
#   FLY_API_TOKEN_QA=...
#   FLY_API_TOKEN_PROD=...
#   ANTHROPIC_API_KEY=...
#
# Values are written quoted, because an unquoted one run through `source`
# once failed with the value itself in the error message and put both Fly
# tokens in a transcript. That is the whole reason these are being rotated.
#
# The source file is shredded afterwards - it has no reason to outlive this.
set -euo pipefail

SRC="${1:?usage: ingest-secrets.sh <file-with-KEY=value-lines>}"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }

touch "$ENV_FILE"
found=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue;; esac
  key="${line%%=*}"; val="${line#*=}"
  case "$key" in *' '*|'') continue;; esac
  # Strip any quotes the sender added, then re-add our own.
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  [ -n "$val" ] || continue

  if grep -q "^${key}=" "$ENV_FILE"; then
    # sed -i '' is the macOS spelling; the temp file keeps it portable.
    grep -v "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  printf '%s="%s"\n' "$key" "$val" >> "$ENV_FILE"
  echo "  set $key (${#val} chars)"
  found=$((found+1))
done < "$SRC"

[ "$found" -gt 0 ] || { echo "nothing looked like KEY=value in that file" >&2; exit 1; }

# Overwrite before unlinking, so the bytes are not just de-referenced.
if command -v shred >/dev/null 2>&1; then shred -u "$SRC"; else
  dd if=/dev/urandom of="$SRC" bs=1024 count=8 conv=notrunc 2>/dev/null || true
  rm -f "$SRC"
fi
echo "done - $found credential(s) written to .env, source file shredded"
