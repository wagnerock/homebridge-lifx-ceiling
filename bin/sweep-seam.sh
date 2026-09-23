#!/usr/bin/env bash
# Sweep a radial (annulus/disc) seam outward, shoot the fixture at each step, measure
# it. This is an EXPERIMENT for a fixture that behaves oddly: the verified model for
# the LIFX Ceiling is the four corner cells, not an annulus, because an 8x8 square
# grid behind a round fixture cannot express a circle.
#
# Needs node + the plugin's node_modules, ffmpeg, and PIL/numpy on the machine that
# runs it. For each seam radius the annulus goes RED and the disc goes BLUE, so a
# step that still shows ANY red/magenta on the panel face means cells inside the
# visible face are being commanded red — the halves do not optically bleed, so
# contamination is always a mapping error, never diffusion.
#
#   CAM=rtsp://10.0.0.60/live0 ./bin/sweep-seam.sh <ip> <centre-x> <centre-y> <radius> [t ...]
#
# Default t = 1.01 1.09 1.23 (the only distinct boundaries an 8x8 grid offers above
# 0.88 — see the radius maths in lib/matrix.js).
set -uo pipefail

IP="${1:?usage: sweep-seam.sh <ip> <cx> <cy> <r> [t ...]}"
CX="${2:?centre-x}"
CY="${3:?centre-y}"
CR="${4:?radius-px}"
shift 4
TS=("$@"); [ ${#TS[@]} -eq 0 ] && TS=(1.01 1.09 1.23)

CAM="${CAM:?CAM must be set, e.g. CAM=rtsp://10.0.0.60/live0 ./bin/sweep-seam.sh <ip> <cx> <cy> <r> [t ...]}"
UP_HUE="${UP_HUE:-0}"; UP_BRI="${UP_BRI:-0.85}"
DN_HUE="${DN_HUE:-240}"; DN_BRI="${DN_BRI:-1.0}"
SETTLE="${SETTLE:-3}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORKDIR="${WORKDIR:-$HERE}"
OUTDIR="${OUTDIR:-$WORKDIR/out/sweep-$(date +%H%M%S)}"

mkdir -p "$OUTDIR"
echo "sweep -> $OUTDIR  cam=$CAM  up=${UP_HUE}/$UP_BRI down=${DN_HUE}/$DN_BRI"

for t in "${TS[@]}"; do
  echo
  echo "### seam t=$t"
  node "$HERE/bin/split-color.js" "$IP" "$UP_HUE" "$UP_BRI" "$DN_HUE" "$DN_BRI" "$t" | grep -E 'AT 715|annulus|disc ' || true
  sleep "$SETTLE"
  jpg="$OUTDIR/t-$t.jpg"
  if timeout 30 ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "$CAM" -frames:v 1 -y "$jpg"; then
    python3 "$HERE/tools/hue-profile.py" "$jpg" --centre "$CX" "$CY" --radius "$CR" --ratio "${RATIO:-1.24}" --label "t=$t"
  else
    echo "  capture FAILED at t=$t"
  fi
done

echo
echo "frames: $OUTDIR"
