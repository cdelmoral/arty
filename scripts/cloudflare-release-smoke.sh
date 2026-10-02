#!/usr/bin/env bash
set -euo pipefail

: "${ARTY_EXECUTABLE:?ARTY_EXECUTABLE is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

worker_name="arty-release-${GITHUB_RUN_ID:-local}"
bucket_name="arty-release-${GITHUB_RUN_ID:-local}"
source_directory="$(mktemp -d)"
initialized=false

cleanup() {
  rm -rf "$source_directory"
  if [[ "$initialized" == true ]]; then
    "$ARTY_EXECUTABLE" destroy cloudflare --force || true
  fi
}
trap cleanup EXIT

printf '<h1>Arty release smoke test</h1>\n' > "$source_directory/index.html"
"$ARTY_EXECUTABLE" init cloudflare --yes --worker-name "$worker_name" --bucket-name "$bucket_name"
initialized=true

access_url="$("$ARTY_EXECUTABLE" "$source_directory")"
test "$(curl --fail --silent --show-error "$access_url")" = '<h1>Arty release smoke test</h1>'
"$ARTY_EXECUTABLE" delete "$access_url"
test "$(curl --silent --output /dev/null --write-out '%{http_code}' "$access_url")" = 404
"$ARTY_EXECUTABLE" destroy cloudflare --force
initialized=false
