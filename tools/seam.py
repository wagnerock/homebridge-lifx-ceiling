#!/usr/bin/env python3
"""
Locate the uplight/downlight seam from a photograph, using COLOUR not brightness.

Why colour: a camera's auto-exposure normalises the whole scene, so absolute
luminance is unreliable - an uncalibrated webcam can report the same mean for a
fully-lit and a fully-dark frame. Hue survives auto-exposure. The calibrator
therefore paints uplight RED and downlight BLUE, and this tool finds the radius
where red hands over to blue.

  python3 tools/seam.py <photo.jpg> [--centre X Y] [--radius R] [--expect up|down|both]

Reports, as a fraction of the fixture radius:
  - the radial red/blue split
  - the crossover radius, i.e. the measured seam
  - cross-talk: red found inside the downlight, blue found outside the uplight
"""
import argparse
import math
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit('Pillow is required: python3 -m pip install pillow')


def classify(p):
    """Return 'red', 'blue' or None for a pixel, using normalized channels."""
    r, g, b = p[0], p[1], p[2]
    mx, mn = max(p), min(p)
    if mx < 40:
        return None
    sat = (mx - mn) / float(mx)
    if sat < 0.22:
        return None
    if r >= g and r >= b and (r - max(g, b)) > 25:
        return 'red'
    if b >= r and b >= g and (b - max(r, g)) > 25:
        return 'blue'
    return None


def find_fixture(px, w, h):
    """Centre and radius of the coloured (fixture) region."""
    xs, ys = [], []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if classify(px[x, y]):
                xs.append(x)
                ys.append(y)
    if len(xs) < 40:
        return w / 2.0, h / 2.0, min(w, h) / 2.4, 0
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    return cx, cy, span / 2.0, len(xs) * 4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('photo')
    ap.add_argument('--centre', nargs=2, type=float, default=None)
    ap.add_argument('--radius', type=float, default=None)
    ap.add_argument('--expect', default='', help='what was commanded: up|down|both')
    a = ap.parse_args()

    im = Image.open(a.photo).convert('RGB')
    if max(im.size) > 1200:
        sc = 1200 / max(im.size)
        im = im.resize((int(im.size[0] * sc), int(im.size[1] * sc)))
    px, (w, h) = im.load(), im.size

    if a.centre and a.radius:
        cx, cy, R = a.centre[0], a.centre[1], a.radius
    else:
        cx, cy, R, n = find_fixture(px, w, h)
        print('auto-located fixture at (%.0f,%.0f) radius %.0f px from %d coloured px' % (cx, cy, R, n))

    bins = 15
    red = [0] * bins
    blue = [0] * bins
    tot = [0] * bins
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            dx, dy = x - cx, y - cy
            rr = math.hypot(dx, dy) / R
            if rr > 1.6:
                continue
            i = min(bins - 1, int(rr / 1.6 * bins))
            tot[i] += 1
            c = classify(px[x, y])
            if c == 'red':
                red[i] += 1
            elif c == 'blue':
                blue[i] += 1

    print('\n  r/R    red%%   blue%%   boundary')
    prof = []
    for i in range(bins):
        rr = (i + 0.5) / bins * 1.6
        t = max(1, tot[i])
        rp, bp = 100.0 * red[i] / t, 100.0 * blue[i] / t
        prof.append((rr, rp, bp))
        mark = 'R' if rp > bp * 1.5 else ('B' if bp > rp * 1.5 else '=')
        print('  %.2f  %6.1f  %6.1f   %s %s' % (rr, rp, bp, mark, '#' * int(min(30, rp / 3)) + '.' * int(min(30, bp / 3))))

    cross = None
    for (r0, rp0, bp0), (r1, rp1, bp1) in zip(prof, prof[1:]):
        if (rp0 - bp0) * (rp1 - bp1) <= 0 and (rp0 + bp0) > 5:
            d0, d1 = rp0 - bp0, rp1 - bp1
            f = 0.5 if abs(d1 - d0) < 1e-6 else abs(d0) / abs(d1 - d0)
            cross = r0 + f * (r1 - r0)
            break

    inner_red = sum(red[:6]) / float(max(1, sum(red[:6]) + sum(blue[:6])))
    outer_blue = sum(blue[10:]) / float(max(1, sum(red[10:]) + sum(blue[10:])))

    print('\n== verdict ==')
    print('  crossover (measured seam) at r/R = %s' % (('%.2f' % cross) if cross else 'none - no clean red/blue boundary'))
    print('  red inside the downlight half   : %.0f%%' % (inner_red * 100))
    print('  blue outside the uplight ring   : %.0f%%' % (outer_blue * 100))

    if a.expect == 'both' and cross:
        print('  -> seam sits at %.2f of fixture radius; set mapping annulus/disc to that' % cross)
    elif a.expect == 'up':
        print('  -> uplight-only: red should fill the ring; red inside r<0.6 above ~15%% means uplight bleeds into the panel')
    elif a.expect == 'down':
        print('  -> downlight-only: blue should fill the core; blue outside r>1.0 means downlight bleeds into the ring')


if __name__ == '__main__':
    main()
