#!/usr/bin/env bash
# Runs the test suite, then deploys to the given target - refuses to touch
# qa.appdoivo.com or appdoivo.com if a test fails. Requires FLY_API_TOKEN
# (fly deploy's own auth) - read from .env if not already in the
# environment (e.g. CI, which sets it directly as a secret instead).
# See CONTRIBUTING.md for the full branch -> QA -> prod process this fits into.
set -euo pipefail

if [[ -z "${FLY_API_TOKEN:-}" && -f .env ]]; then
  FLY_API_TOKEN="$(grep -m1 '^FLY_API_TOKEN=' .env | cut -d= -f2-)"
  export FLY_API_TOKEN
fi

target="${1:-}"
if [[ "$target" != "qa" && "$target" != "prod" ]]; then
  echo "Usage: scripts/deploy.sh <qa|prod>" >&2
  exit 1
fi

echo "Running tests before deploy..."
npm test

if [[ "$target" == "qa" ]]; then
  fly deploy -a appdoivo-qa --config fly.qa.toml
else
  fly deploy -a appdoivo
fi
