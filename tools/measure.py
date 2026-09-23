#!/usr/bin/env python3
"""
Measure where the light actually is on a LIFX Ceiling, from a photograph.

Turns "is some of the downlight on?" into a number, so uplight/downlight seam
calibration stops being an argument about impressions.

  python3 tools/measure.py <photo.jpg|png> [--label up|down|both]

Reports, as a fraction of the fixture radius:
  - the radial luminance profile
  - the radius of peak luminance gradient  (the physical seam candidate)
  - ring vs panel mean luminance and their ratio
"""
import argparse
import math
import statistics
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit('Pillow is required: python3 -m pip install pillow')


def load(path, maxdim=1400):
    im = Image.open(path).convert('RGB')
    w, h = im.size
    if max(w, h) > maxdim:
        sc = maxdim / max(w, h)
        im = im.resize((int(w * sc), int(h * sc)))
    return im.load(), im.size


def find_disc(px, w, h):
    """Locate the lit disc: brightest wide run of pixels, any row."""
    best = (0, 0, 0)
    for y in range(0, h, 3):
        xs = [x for x in range(0, w, 2) if max(px[x, y]) > 70]
        if len(xs) > 8 and (xs[-1] - xs[0]) > best[0]:
            ys = [yy for yy in range(max(0, y - 60), min(h, y + 60), 3) for xx in xs[::3] if max(px[xx, yy]) > 70]
            if not ys:
                continue
            best = (xs[-1] - xs[0], sum(xs) / len(xs), sum(ys) / len(ys))
    span, cx, cy = best
    if span == 0:
        raise SystemExit('could not locate a lit disc in this photo - was the light on?')
    return cx, cy, span / 2.0


def lum(p):
    r, g, b = p
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def profile(px, w, h, cx, cy, R, steps=25):
    out = []
    for i in range(steps + 1):
        rr = i / float(steps)
        vals, sats = [], []
        for a in range(0, 360, 4):
            x = int(round(cx + rr * R * math.cos(math.radians(a))))
            y = int(round(cy + rr * R * math.sin(math.radians(a))))
            if 0 <= x < w and 0 <= y < h:
                p = px[x, y]
                if max(p) > 12:
                    vals.append(lum(p))
                    mx, mn = max(p), min(p)
                    sats.append(0.0 if mx == 0 else (mx - mn) / float(mx))
        if len(vals) >= 5:
            out.append((rr, statistics.median(vals), statistics.median(sats)))
    return out


def seam_from(profile):
    """Radius of the steepest luminance change, outward-biased: the seam."""
    best = (None, 0.0)
    for (r0, l0, _), (r1, l1, _) in zip(profile, profile[1:]):
        d = abs(l1 - l0)
        if r0 >= 0.30 and d > best[1]:
            best = (round((r0 + r1) / 2.0, 3), d)
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('photo')
    ap.add_argument('--label', default='', help='what was commanded: up|down|both')
    args = ap.parse_args()

    px, (w, h) = load(args.photo)
    cx, cy, R = find_disc(px, w, h)
    print('photo %dx%d  disc centre (%.0f,%.0f) radius %.0f px  [%s]' % (w, h, cx, cy, R, args.label or 'unlabelled'))

    pr = profile(px, w, h, cx, cy, R)
    print('\n  r/R    lum   sat')
    for rr, l, s in pr:
        bar = '#' * int(min(40, l / 6.0))
        print('  %.2f  %6.1f  %.2f  %s' % (rr, l, s, bar))

    peak = max(pr, key=lambda x: x[1])
    seam, grad = seam_from(pr)
    inner = [l for rr, l, _ in pr if rr <= 0.45]
    outer = [l for rr, l, _ in pr if rr >= 0.70]
    im_, om_ = (statistics.median(inner), statistics.median(outer)) if inner and outer else (0, 0)
    print('\n== verdict ==')
    print('  peak luminance at r/R=%.2f (lum %.1f)' % (peak[0], peak[1]))
    print('  steepest radial transition at r/R=%s (delta %.1f)' % (seam, grad))
    print('  panel (r<=0.45) mean lum %.1f | halo (r>=0.70) mean lum %.1f | ratio %.2f' % (im_, om_, (om_ / im_) if im_ else 0))
    if args.label == 'up':
        if om_ > 3 * im_:
            print('  -> uplight-dominant: halo far brighter than panel. Clean-ish split.')
        elif om_ > 1.15 * im_:
            print('  -> halo brighter, but panel is NOT dark. Panel rim still lit.')
        else:
            print('  -> FAIL: panel is as bright as the halo; uplight is driving the panel.')
    elif args.label == 'down':
        if im_ > om_:
            print('  -> panel-dominant: correct for downlight-only.')
        else:
            print('  -> halo >= panel: downlight command is leaking into the uplight.')


if __name__ == '__main__':
    main()
