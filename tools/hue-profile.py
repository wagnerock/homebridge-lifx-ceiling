#!/usr/bin/env python3
"""Hue profile of a lit fixture face from a photo — does the downlight stay blue?

The split is only proven by looking, and "looking" needs to mean a number, so this
samples the fixture face in spokes at normalised radius r and reports, per ring:
mean hue, and the fraction of pixels that are RED/MAGENTA rather than BLUE.

Camera is static during a sweep; centre/radius/ellipse-ratio come from the framing
(--centre cx cy --radius rx --ratio ry/rx). Auto-detect is a fallback only: the
bright wall spill from the uplight defeats naive brightness thresholding, so a
manual centre is the honest default.

  python3 tools/hue-profile.py <photo.jpg> --centre 730 313 --radius 232 --ratio 1.24

Bands: core r<=0.50 | panel 0.50<r<=0.90 (must be all blue) | outside r>1.05
(outside is the uplight spill on the wall — advisory, depends on framing).
"""
import argparse
import colorsys
import sys

try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit('Pillow+numpy required (pip install pillow numpy)')

BLUE = (195, 285)


def band(h):
    if 195 <= h <= 285:
        return 'blue'
    if h > 285 or h < 25:
        return 'red/magenta'
    return 'other'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('photo')
    ap.add_argument('--centre', nargs=2, type=float, default=None, metavar=('X', 'Y'))
    ap.add_argument('--radius', type=float, default=None)
    ap.add_argument('--ratio', type=float, default=1.0, help='ry/rx for a tilted camera')
    ap.add_argument('--label', default='')
    a = ap.parse_args()

    im = np.asarray(Image.open(a.photo).convert('RGB')).astype(float) / 255.0
    H, W = im.shape[:2]
    cx, cy = a.centre if a.centre else (W / 2, H / 2)
    R = a.radius if a.radius else min(W, H) / 3

    def sample(rn, degs):
        cols = []
        for deg in degs:
            x = int(round(cx + rn * R * np.cos(np.radians(deg))))
            y = int(round(cy + rn * R * a.ratio * np.sin(np.radians(deg))))
            if x < 3 or y < 3 or x > W - 4 or y > H - 4:
                continue
            p = im[y - 3:y + 4, x - 3:x + 4].reshape(-1, 3).mean(axis=0)
            cols.append(colorsys.rgb_to_hsv(*p))
        return cols

    rows = []
    for rn in [0.0, 0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0]:
        cols = sample(rn, range(0, 360, 15))
        if not cols:
            continue
        arr = np.array(cols)
        hues = arr[:, 0] * 360
        # Absolute lit-threshold, not per-ring-relative: a dim RED rim pixel is
        # exactly the evidence we are looking for, and a per-ring max would discard it.
        lit = arr[:, 2] > 0.18
        hs = hues[lit] if lit.any() else hues
        rmag = int(np.sum((hs > BLUE[1]) | (hs < 25)))
        rows.append((rn, float(hs.mean()), float(arr[:, 1].mean()), float(arr[:, 2].mean()),
                     rmag, int(hs.size)))

    # Uplight proxy: wall spill on one side of the fixture (camera-dependent, advisory).
    spill = []
    for rn in [1.10, 1.25, 1.45]:
        cols = sample(rn, list(range(315, 360, 15)) + list(range(0, 46, 15)))
        if not cols:
            continue
        arr = np.array(cols)
        spill.append((rn, float((arr[:, 0] * 360).mean()), float(arr[:, 1].mean()), float(arr[:, 2].mean()), 0, int(arr.shape[0])))

    print(f'== hue profile {a.label} {a.photo} centre={cx:.0f},{cy:.0f} r={R:.0f} k={a.ratio} ==')
    print('   r    meanHue  sat  val   red/magenta pixels   band')
    for rn, h, s, v, rmag, n in rows:
        tag = 'core' if rn <= 0.5 else ('panel' if rn <= 0.9 else 'rim')
        print(f' {rn:4.2f}   {h:6.0f}  {s:.2f}  {v:.2f}   {rmag:3d}/{n:<3d} ({100*rmag/max(n,1):3.0f}%)  {tag}')
    for rn, h, s, v, _r, n in spill:
        print(f' {rn:4.2f}   {h:6.0f}  {s:.2f}  {v:.2f}     -          uplight spill (right wall)')

    panel = [r for r in rows if 0.5 < r[0] <= 0.90]
    core = [r for r in rows if r[0] <= 0.5]
    bad = sum(r[4] for r in panel + core)
    tot = sum(r[5] for r in panel + core)
    pct = 100 * bad / max(tot, 1)
    verdict = 'CLEAN (no red on downlight)' if pct < 2 else f'CONTAMINATED ({pct:.0f}% of panel is red/magenta)'
    print(f'VERDICT panel: {verdict}')
    return 0 if pct < 2 else 1


if __name__ == '__main__':
    sys.exit(main())
