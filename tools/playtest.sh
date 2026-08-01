#!/usr/bin/env bash
# Two-sided heist acceptance test:
#   careful bot (stealth, retreat, heal) must complete the heist on most seeds
#     → the game is winnable by good play
#   reckless bot (lamp blazing, fights everything) must die on most seeds
#     → danger is priced
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="${CHROME:-chromium}"
SEEDS="${1:-1 2 3 4 5 6 7 8 9 10}"
BUDGET="${2:-6000}"
for mode in careful reckless; do
  for seed in $SEEDS; do
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
      --virtual-time-budget=60000 \
      --dump-dom \
      "file://$DIR/index.html?autoplay=$mode&seed=$seed&budget=$BUDGET" 2>/dev/null \
      | grep -o 'AUTOPLAY:{[^<]*\|ERR:[^<]*' | head -1
  done
done
