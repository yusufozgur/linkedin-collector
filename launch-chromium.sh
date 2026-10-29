#!/usr/bin/env bash
# Starts Chromium with a dedicated, persistent profile and the extension loaded.
# Usage: ./launch-chromium.sh [url]
#   CHROMIUM_PROFILE  profile directory (default: ~/.local/share/linkedin-collector/chromium-profile)
#   CHROMIUM_BIN      browser binary (default: first of chromium, chromium-browser, google-chrome)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="${CHROMIUM_PROFILE:-$HOME/.local/share/linkedin-collector/chromium-profile}"

BIN="${CHROMIUM_BIN:-}"
if [[ -z "$BIN" ]]; then
  for candidate in chromium chromium-browser google-chrome; do
    if command -v "$candidate" >/dev/null; then BIN="$candidate"; break; fi
  done
fi
[[ -n "$BIN" ]] || { echo "No Chromium found; set CHROMIUM_BIN." >&2; exit 1; }

# --remote-debugging-port: used by the scripts in tools/.
# --disable-*-backgrounding: keep the feed rendering while other windows cover it;
#   otherwise LinkedIn stops loading posts.
exec "$BIN" \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --load-extension="$HERE/extension" \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
  "${1:-https://www.linkedin.com/feed/}"
