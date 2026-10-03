#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/assets/icon.svg"
OUT_EXT="$ROOT/extension/icons"
OUT_FIX="$ROOT/fixtures/icons"
mkdir -p "$OUT_EXT" "$OUT_FIX"
if command -v rsvg-convert >/dev/null 2>&1; then
  CONVERT=(rsvg-convert -b transparent)
elif command -v convert >/dev/null 2>&1; then
  CONVERT=(convert -background none)
else
  echo "Install rsvg-convert or ImageMagick convert to export PNG icons." >&2
  exit 1
fi
for size in 16 32 48 128 256; do
  if [[ "${CONVERT[0]}" == "rsvg-convert" ]]; then
    rsvg-convert -b transparent -w "$size" -h "$size" "$SVG" -o "$OUT_EXT/icon-${size}.png"
    cp "$OUT_EXT/icon-${size}.png" "$OUT_FIX/icon-${size}.png"
  else
    convert -background none "$SVG" -resize "${size}x${size}" "$OUT_EXT/icon-${size}.png"
    cp "$OUT_EXT/icon-${size}.png" "$OUT_FIX/icon-${size}.png"
  fi
done
cp "$SVG" "$OUT_FIX/icon.svg"
echo "Exported icons to extension/icons and fixtures/icons"
