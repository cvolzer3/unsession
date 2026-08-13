#!/bin/sh
# Renders scripts/og-card.html to public/og.png (1200×630) with headless Chrome.
# Run from the repo root after editing the card. Needs network for Google Fonts.
set -e
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$CHROME" --headless=new --screenshot=public/og.png \
  --window-size=1200,630 --hide-scrollbars --virtual-time-budget=8000 \
  "file://$(pwd)/scripts/og-card.html"
echo "Wrote public/og.png"
