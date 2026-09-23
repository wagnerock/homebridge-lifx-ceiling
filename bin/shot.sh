#!/usr/bin/env bash
# Hold one light state, let it settle, and capture a camera frame for measurement.
#
#   CAM=rtsp://10.0.0.60/live0 ./bin/shot.sh <ip> <up|down|both|off> [out.jpg]
#
# Environment:
#   CAM     RTSP URL of any camera pointed at the fixture. REQUIRED — no default.
#           An uncalibrated camera is fine: the tools measure hue, not brightness.
#   SETTLE  seconds to wait for the fixture to reach the commanded state (default 2.5)
#   WORKDIR where captures are written (default: the plugin root)
#
# Then measure the frame:
#   python3 tools/measure.py <out.jpg> --label up
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
WORKDIR="${WORKDIR:-$HERE}"

IP="${1:?usage: shot.sh <ip> <up|down|both|off> [out.jpg]}"
STATE="${2:?usage: shot.sh <ip> <up|down|both|off> [out.jpg]}"
OUT="${3:-$WORKDIR/out/shot-$(date +%H%M%S)-${STATE}.jpg}"
CAM="${CAM:?CAM must be set, e.g. CAM=rtsp://10.0.0.60/live0 ./bin/shot.sh <ip> <up|down|both|off> [out.jpg]}"
SETTLE="${SETTLE:-2.5}"

node bin/calibrate.js "$IP" --state "$STATE"

# LIFX ramps and the camera encoder both need a moment; shoot a short burst so
# a single bad frame cannot decide the calibration.
sleep "$SETTLE"
mkdir -p "$(dirname "$OUT")"
ffmpeg -hide_banner -loglevel error -rtsp_transport tcp -i "$CAM" -frames:v 1 -y "$OUT"

echo "captured $OUT while holding ${STATE} on ${IP}"
