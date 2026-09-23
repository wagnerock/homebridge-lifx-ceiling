#!/usr/bin/env python3
"""
Differential seam measurement: compares an uplight-only and a downlight-only
frame to find where each half's light actually lands.

Absolute luminance and absolute colour are both unreliable from an uncalibrated
camera: auto-exposure can equate a fully-lit and a fully-dark frame, and auto
white balance neutralises the fixture face. Both are COMMON-MODE: they apply to
every frame in a burst. Subtracting one state from the other cancels them, so
what survives is only the light that actually moved.

  python3 tools/diff.py <up.jpg> <down.jpg> [--ref dark.jpg] --centre X Y --radius R

Writes an overlay PNG (red where uplight wins, blue where downlight wins) and
prints the radial crossover radius, which is the measured seam.
"""
import argparse
import math
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit('Pillow is required: python3 -m pip install pillow')


def lum(p):
    return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('up')
    ap.add_argument('down')
    ap.add_argument('--ref', default=None, help='baseline frame with the fixture off')
    ap.add_argument('--centre', nargs=2, type=float, required=True)
    ap.add_argument('--radius', type=float, required=True)
    ap.add_argument('--out', default='diff-overlay.png')
    a = ap.parse_args()

    Iu = Image.open(a.up).convert('RGB')
    Id = Image.open(a.down).convert('RGB')
    if Iu.size != Id.size:
        Id = Id.resize(Iu.size)
    Ir = Image.open(a.ref).convert('RGB').resize(Iu.size) if a.ref else None
    w, h = Iu.size
    pu, pd, pr = Iu.load(), Id.load(), Ir.load() if Ir else None
    cx, cy = a.centre
    R = a.radius
    out = Image.new('RGB', (w, h))
    po = out.load()

    bins = 16
    acc = [[0.0, 0.0, 0, 0, 0] for _ in range(bins)]  # sumUp, sumDown, n, redWin, blueWin

    for y in range(0, h, 2):
        for x in range(0, w, 2):
            r = math.hypot(x - cx, y - cy) / R
            if r > 1.6:
                continue
            u, d = pu[x, y], pd[x, y]
            lu, ld = lum(u), lum(d)
            if pr:
                rr = lum(pr[x, y])
                lu -= rr
                ld -= rr
            i = min(bins - 1, int(r / 1.6 * bins))
            row = acc[i]
            row[0] += lu
            row[1] += ld
            row[2] += 1
            if lu > ld:
                row[3] += 1
            elif ld > lu:
                row[4] += 1
            # overlay: colour by which state is brighter, grey where they agree
            m = lu - ld
            if abs(m) < 6:
                c = (90, 90, 90)
            elif m > 0:
                c = (255, int(max(0, 90 - m)), int(max(0, 90 - m)))
            else:
                c = (int(max(0, 90 + m)), int(max(0, 90 + m)), 255)
            po[x, y] = c
            if x + 1 < w:
                po[x + 1, y] = c
            if y + 1 < h:
                po[x, y + 1] = c
                po[x + 1, y + 1] = c

    out.save(a.out)
    print('overlay -> %s  (red = uplight-only brighter, blue = downlight-only brighter, grey = same)' % a.out)

    print('\n  r/R    up-only  down-only   delta   winner')
    cross = None
    prev = None
    for i in range(bins):
        rr = (i + 0.5) / bins * 1.6
        s = acc[i]
        if not s[2]:
            continue
        lu, ld = s[0] / s[2], s[1] / s[2]
        dl = lu - ld
        win = 'UP' if lu > ld * 1.05 else ('DOWN' if ld > lu * 1.05 else 'both/even')
        print('  %.2f  %8.1f  %9.1f  %7.1f   %s' % (rr, lu, ld, dl, win))
        if prev is not None and prev[0] * dl <= 0 and abs(prev[0]) + abs(dl) > 8:
            f = abs(prev[0]) / (abs(prev[0]) + abs(dl))
            cross = prev[1] + f * (rr - prev[1])
        prev = (dl, rr)

    print('\n== verdict ==')
    if cross:
        print('  measured seam (up/down crossover) at r/R = %.2f' % cross)
        print('  -> set mapping to annulus@%.2f / disc@%.2f' % (cross, cross))
    else:
        print('  no crossover: one half dominates everywhere, so the two halves are not separable in this frame')

    inner = [s for i, s in enumerate(acc) if (i + 0.5) / bins * 1.6 < 0.85]
    outer = [s for i, s in enumerate(acc) if (i + 0.5) / bins * 1.6 > 1.05]
    if inner and outer:
        itot = sum(s[2] for s in inner) or 1
        otot = sum(s[2] for s in outer) or 1
        print('  uplight wins inside the panel : %.0f%% of pixels (bleed if high)' % (100.0 * sum(s[3] for s in inner) / itot))
        print('  downlight wins outside the ring: %.0f%% of pixels (bleed if high)' % (100.0 * sum(s[4] for s in outer) / otot))


if __name__ == '__main__':
    main()
