#!/usr/bin/env bash
# Deterministic shot capture. The combat_0..7 strip exists for the fidelity
# critic: one fight, every die on screen, one exchange per frame — the Sil
# opposed-roll core reconstructed roll by roll. alert_0..7 does the same for
# the stealth model: a bright lamp walking toward a sleeping hound.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$DIR/shots}"
mkdir -p "$OUT"
CHROME="${CHROME:-chromium}"
SHOTS=(title floor1 stealth sentinel dark vault grab pursuit flash skills death deathbanner win)
cap() {
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=1280,720 \
    --virtual-time-budget=8000 \
    --screenshot="$OUT/$1.png" \
    "file://$DIR/index.html?$2" 2>/dev/null
  echo "captured $1"
}
for s in "${SHOTS[@]}"; do cap "$s" "shot=$s"; done
for f in 0 1 2 3 4 5 6 7; do cap "combat_$f" "shot=combat&f=$f"; done
for f in 0 1 2 3 4 5 6 7; do cap "alert_$f" "shot=alert&f=$f"; done
