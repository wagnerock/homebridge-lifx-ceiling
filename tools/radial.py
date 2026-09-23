#!/usr/bin/env python3
"""
Radial light profile of a LIFX Ceiling from a single photo, normalised to the
fixture's own radius - so shots taken at different framings still compare.

Lock the camera's exposure if you can, so the panel does not clip; a camera in
auto-exposure can report the same brightness for a lit and a dark fixture, which
is why these tools also read hue. Pixel-wise differencing only works if the
camera never moved between the two shots. Measuring each frame against its own
detected circle is what makes two framings comparable.

  python3 tools/radial.py <photo> [--centre X Y] [--radius R] [--label up|down|both]

Auto-detection: the fixture is found from its brightest ring or blob, so the
panel-lit and ring-lit states are both located correctly.
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


def detect(px, w, h):
    """Find the fixture centre and radius from the brightest pixels."""
    vals = [(lum(px[x, y]), x, y) for y in range(0, h, 3) for x in range(0, w, 3)]
    vals.sort(reverse=True)
    top = vals[:max(60, len(vals) // 40)]
    cx = sum(v[1] for v in top) / len(top)
    cy = sum(v[2] for v in top) / len(top)
    rs = sorted(math.hypot(v[1] - cx, v[2] - cy) for v in top)
    # a ring gives a tight radius spread; a blob gives radii out to the disc edge
    R = rs[int(len(rs) * 0.75)] or 1.0
    return cx, cy, R


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('photo')
    ap.add_argument('--centre', nargs=2, type=float, default=None)
    ap.add_argument('--radius', type=float, default=None)
    ap.add_argument('--label', default='')
    a = ap.parse_args()

    Image.MAX_IMAGE_PIXELS = None
    im = Image.open(a.photo).convert('RGB')
    if max(im.size) > 1100:
        sc = 1100 / max(im.size)
        im = im.resize((int(im.size[0] * sc), int(im.size[1] * sc)))
    px, (w, h) = im.load(), im.size

    if a.centre and a.radius:
        cx, cy, R = a.centre[0], a.centre[1], a.radius
    else:
        cx, cy, R = detect(px, w, h)
    print('%s: centre (%.0f,%.0f) radius %.0f px  [%s]' % (a.photo, cx, cy, R, a.label or 'unlabelled'))

    bins = 14
    acc = [[] for _ in range(bins)]
    for y in range(0, h):
        for x in range(0, w):
            r = math.hypot(x - cx, y - cy) / R
            if r > 1.6:
                continue
            acc[min(bins - 1, int(r / 1.6 * bins))].append(lum(px[x, y]))

    prof = []
    peak = 0.0
    for i, v in enumerate(acc):
        if v:
            m = sum(v) / len(v)
            peak = max(peak, m)
            prof.append(((i + 0.5) / bins * 1.6, m, len(v)))
    if peak <= 0:
        sys.exit('no light in frame')

    print('\n  r/R     lum    %%peak')
    for rr, m, n in prof:
        print('  %.2f  %6.1f   %5.1f  %s' % (rr, m, 100 * m / peak, '#' * int(38 * m / peak)))

    panel = [m for rr, m, _ in prof if rr <= 0.70]
    ring = [m for rr, m, _ in prof if 0.95 <= rr <= 1.30]
    pm = sum(panel) / len(panel) if panel else 0.0
    rm = sum(ring) / len(ring) if ring else 0.0
    # half-max radius: how far the light actually reaches
    half = next((rr for rr, m, _ in reversed(prof) if m >= peak * 0.5), None)

    print('\n== verdict [%s] ==' % (a.label or 'unlabelled'))
    print('  panel mean %.1f  |  ring mean %.1f  |  panel/ring %.2f' % (pm, rm, (pm / rm) if rm else 0))
    print('  light reaches out to r/R = %s (half of peak)' % (('%.2f' % half) if half else 'n/a'))
    if a.label == 'up':
        v = (pm / rm) if rm else 0
        print('  -> uplight-only: panel/ring %.2f  %s' % (v, 'CLEAN - panel stays dark' if v < 0.6 else ('MILD bleed' if v < 0.85 else 'BLEED - panel is lit')))
    elif a.label == 'down':
        v = (pm / rm) if rm else 0
        print('  -> downlight-only: panel/ring %.2f  %s' % (v, 'CLEAN - ring dark' if v > 1.4 else ('MILD bleed' if v > 1.15 else 'BLEED - ring is lit')))


if __name__ == '__main__':
    main()
