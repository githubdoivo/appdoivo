#!/usr/bin/env bash
# Runs the test suite, then deploys to the given target - refuses to touch
# qa.appdoivo.com or appdoivo.com if a test fails. Requires FLY_API_TOKEN in
# the environment (fly deploy's own auth). See CONTRIBUTING.md for the full
# branch -> QA -> prod process this fits into.
set -euo pipefail

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
