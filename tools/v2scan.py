#!/usr/bin/env python3
"""
Parse and diff LIFXV2 frames from a pcap.

The controllers (phones, the LIFX app) unicast their commands and AP client
isolation hides them from any wireless client sniffer. But the LIGHTS broadcast
LIFXV2: state, capability and large zone blobs. So the protocol is recoverable
from the device's own traffic without monitor mode.

  python3 tools/v2scan.py <pcap> [--src IP] [--types] [--dump N]
  python3 tools/v2scan.py <pcap> --diff IP   # show payload deltas over time

Header layout, observed on a LIFX Ceiling (pid 176) on UDP 56700:
  0  size        uint16 LE
  2  0x0014      constant
  4  tag         10 bytes, constant per device
  16 "LIFXV2"    magic
  22 seq         uint16 LE, increments per frame
  24 id          uint48 LE, monotonic (timestamp-ish)
  28 0000
  32 len         uint32 LE payload length
  36 payload
"""
import argparse
import binascii
import struct
import sys

HDR = 36
MAGIC = b'LIFXV2'


def frames(path):
    d = open(path, 'rb').read()
    if d[:4] != b'\xd4\xc3\xb2\xa1':
        sys.exit('not a pcap file: %s' % path)
    off = 24
    while off + 16 <= len(d):
        ts, us, cl, wl = struct.unpack('<IIII', d[off:off + 16])
        off += 16
        raw = d[off:off + cl]
        off += (wl or cl)
        if len(raw) < 42:
            continue
        if struct.unpack('>H', raw[12:14])[0] != 0x0800:
            continue
        ihl = (raw[14] & 0x0f) * 4
        if raw[14 + 9] != 17:
            continue
        udp = raw[14 + ihl:]
        if len(udp) < 8:
            continue
        sp, dp = struct.unpack('>HH', udp[0:4])
        pl = udp[8:]
        if len(pl) < HDR or pl[16:22] != MAGIC:
            continue
        yield {
            't': ts + us / 1e6,
            'src': '.'.join(str(b) for b in raw[26:30]),
            'dst': '.'.join(str(b) for b in raw[30:34]),
            'sp': sp, 'dp': dp,
            'size': struct.unpack('<H', pl[0:2])[0],
            'seq': struct.unpack('<H', pl[22:24])[0],
            'id': int.from_bytes(pl[24:30], 'little'),
            'len': struct.unpack('<I', pl[32:36])[0],
            'pl': pl,
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pcap')
    ap.add_argument('--src', default=None)
    ap.add_argument('--types', action='store_true', help='summarise frame types')
    ap.add_argument('--dump', type=int, default=0, help='hexdump N largest payloads')
    ap.add_argument('--diff', action='store_true', help='show bytes that change over time')
    a = ap.parse_args()

    fr = [f for f in frames(a.pcap) if not a.src or f['src'] == a.src]
    if not fr:
        print('no LIFXV2 frames' + (' from %s' % a.src if a.src else ''))
        return
    t0 = fr[0]['t']
    print('%d LIFXV2 frames' % len(fr))

    if a.types:
        agg = {}
        for f in fr:
            k = (f['seq'], f['len'])
            e = agg.setdefault(k, {'n': 0, 't': [], 'src': set()})
            e['n'] += 1
            e['t'].append(f['t'] - t0)
            e['src'].add(f['src'])
        print('\n  type(seq) len   n   first   last   sources')
        for (seq, ln), e in sorted(agg.items(), key=lambda kv: -kv[1]['n'])[:24]:
            print('  %04x    %4d %3d  %6.2f  %6.2f  %s' % (
                seq, ln, e['n'], min(e['t']), max(e['t']), ','.join(sorted(e['src']))))

    if a.dump:
        big = sorted(fr, key=lambda f: -len(f['pl']))[:a.dump]
        for f in big:
            print('\n== t=%.2f seq=%04x len=%d src=%s ==' % (f['t'] - t0, f['seq'], len(f['pl']), f['src']))
            body = f['pl'][HDR:]
            for i in range(0, min(len(body), 256), 16):
                chunk = body[i:i + 16]
                print('  %4d  %s  %s' % (i, ' '.join('%02x' % b for b in chunk),
                                          ''.join(chr(b) if 32 <= b < 127 else '.' for b in chunk)))

    if a.diff:
        by = {}
        for f in sorted(fr, key=lambda x: x['t']):
            by.setdefault(f['seq'], []).append(f)
        for seq, lst in sorted(by.items()):
            if len(lst) < 2:
                continue
            base = lst[0]['pl']
            print('\n== type %04x: %d frames, bytes that vary ==' % (seq, len(lst)))
            idx = [i for i in range(min(len(f['pl']) for f in lst))
                   if len({f['pl'][i] for f in lst}) > 1]
            runs = []
            for i in idx:
                if runs and i == runs[-1][1] + 1:
                    runs[-1][1] = i
                else:
                    runs.append([i, i])
            for s, e in runs:
                vals = [' '.join('%02x' % b for b in f['pl'][s:e + 1]) for f in lst]
                print('  bytes %3d-%-3d (%d): %s' % (s, e, e - s + 1, ' | '.join(vals[:6])))


if __name__ == '__main__':
    main()
