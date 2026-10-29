#!/usr/bin/env bash
# Builds dist/linkedin-feed-collector-<version>.zip from extension/, for attaching to a release.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$HERE/extension/manifest.json")"
OUT="$HERE/dist/linkedin-feed-collector-$VERSION.zip"
mkdir -p "$HERE/dist"
rm -f "$OUT"
# The zip unpacks to a single folder, which is what "Load unpacked" expects.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -r "$HERE/extension" "$STAGE/linkedin-feed-collector"
(cd "$STAGE" && zip -qr "$OUT" linkedin-feed-collector)
echo "$OUT"
