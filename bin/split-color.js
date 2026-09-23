// Set uplight (annulus) and downlight (disc) to two different colours on one fixture.
//
// Writes through _lifxLanUdp.request with ack_required:true — the library's
// _request() hardcodes ack_required:false and on these Ceiling fixtures the write
// then silently vanishes (see CONTROLS.md "tile writes require ack_required:true").
//
// Colours are degrees-hue in, normalised floats 0-1 out (composer multiplies by 65535).
//
// Usage: node bin/split-color.js <ip> <upHueDeg> <upBri> <downHueDeg> <downBri> [t]
//   node bin/split-color.js 192.168.1.50 0 0.85 240 0.85 0.88   # red up, blue down
const IP = process.argv[2];
if (!IP) { console.error('usage: node bin/split-color.js <ip> <upHueDeg> <upBri> <downHueDeg> <downBri> [t] [kelvin]'); process.exit(2); }

const Lifx = require('node-lifx-lan-multi');
const m = require('../lib/matrix');

const upHue = (parseFloat(process.argv[3]) || 0) / 360;
const upBri = process.argv[4] !== undefined ? parseFloat(process.argv[4]) : 0.85;
const downHue = (parseFloat(process.argv[5]) || 0) / 360;
const downBri = process.argv[6] !== undefined ? parseFloat(process.argv[6]) : 0.85;
const T = process.argv[7] !== undefined ? parseFloat(process.argv[7]) : 0.88;
const KELVIN = parseFloat(process.argv[8] !== undefined ? process.argv[8] : '2700');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

(async () => {
  const lifx = new Lifx();
  const found = (await lifx.discover({ timeoutSeconds: 8 })) || [];
  const dev = found.find((x) => x && x.ip === IP);
  if (!dev) { console.log(`device ${IP} not discovered`); lifx.destroy(); process.exit(1); }

  const band = new Set(m.annulusIndices(8, 8, T));
  const colors = [];
  for (let i = 0; i < 64; i++) {
    const up = band.has(i);
    colors.push({
      hue: up ? clamp(upHue, 0, 1) : clamp(downHue, 0, 1),
      saturation: 1.0,
      brightness: up ? clamp(upBri, 0, 1) : clamp(downBri, 0, 1),
      kelvin: KELVIN,
    });
  }

  await dev.lightSetPower({ level: 1 }).catch((e) => console.log('power:', e.message));
  await sleep(250);

  const r = await dev._lifxLanUdp.request({
    address: dev.ip, type: 715,
    payload: { tile_index: 0, length: 1, x: 0, y: 0, width: 8, duration: 0, colors },
    ack_required: true, res_required: false, target: dev.mac,
  });
  const pkt = Array.isArray(r) ? r[0] : r;
  const svc = (pkt && pkt.header && pkt.header.type) || (pkt && pkt.type);
  console.log(`AT 715 -> svc ${svc}${svc === 223 ? ' (REJECTED)' : svc === 3 ? ' (ACKed)' : ''}`);
  if (svc === 223) { lifx.destroy(); process.exit(2); }

  console.log(`annulus t=${T}: hue=${(upHue * 360).toFixed(0)} bri=${upBri}  [${band.size} cells] -> uplight`);
  console.log(`disc    t=${T}: hue=${(downHue * 360).toFixed(0)} bri=${downBri}  [${64 - band.size} cells] -> panel`);
  console.log('\nbuffer written (# = annulus/up, . = disc/down):');
  for (let y = 0; y < 8; y++) {
    console.log('  ' + Array.from({ length: 8 }, (_, x) => (band.has(y * 8 + x) ? '#' : '.')).join(''));
  }

  await sleep(1200);
  try {
    const rr = await dev.tileGetTileState64({ tile_index: 0, length: 1, x: 0, y: 0, width: 8, height: 8 });
    const t = Array.isArray(rr) ? rr[0] : rr;
    const px = (t && t.colors) || [];
    if (px.length) {
      // The library decomposes hue/brightness to normalised floats (0-1); raw frames
      // are 0-65535. Scale-detect instead of assuming, or every cell reads as "off".
      const norm = (v) => (v <= 1 ? v : v / 65535);
      console.log('\nbuffer read-back (R=red B=blue .=off) — buffer contents only, NOT proof of light:');
      for (let y = 0; y < 8; y++) {
        let s = '';
        for (let x = 0; x < 8; x++) {
          const c = px[y * 8 + x] || {};
          const b = norm(c.brightness || 0);
          s += b <= 0.02 ? '.' : (norm(c.hue || 0) < 0.12 ? 'R' : 'B');
        }
        console.log('  ' + s);
      }
    } else console.log('\nread-back: no pixels');
  } catch (e) {
    console.log('\nread-back failed: ' + e.message);
  }

  console.log('\nLOOK at the fixture: uplight red? panel blue?');
  lifx.destroy();
  process.exit(0);
})().catch((e) => { console.log('fatal:', e.message); process.exit(1); });
