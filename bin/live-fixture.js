// Drive the PRODUCTION plugin path against a live fixture.
// bin/region-color.js proves what a hand-built frame does; this proves the code that
// HomeKit actually runs: Mapping resolves the region lists, Fixture composes ONE
// frame and sends it ack-required with power set first.
//
// Usage: node bin/live-fixture.js <ip> <upHue> <upBri> <dnHue> <dnBri> [sat] [kelvin]
//   node bin/live-fixture.js 192.168.1.50 0 0.85 240 1        # red up, blue panel
//   node bin/live-fixture.js 192.168.1.50 0 0.6 0 0.6 0 2700   # both halves warm white
// Set bri 0 to turn a half off. sat 0 = white (kelvin then decides the tint — a
// forced saturation:1 can never show white, which is why earlier tools only ever
// showed saturated colour). Read-back is informational only — LOOK at the fixture.
const IP = process.argv[2];
if (!IP) { console.error('usage: node bin/live-fixture.js <ip> <upHue> <upBri> <dnHue> <dnBri> [sat] [kelvin]'); process.exit(2); }

const Lifx = require('node-lifx-lan-multi');
const { Mapping } = require('../lib/mapping');
const { Fixture } = require('../lib/fixture');

const upHue = parseFloat(process.argv[3] !== undefined ? process.argv[3] : '0');
const upBri = parseFloat(process.argv[4] !== undefined ? process.argv[4] : '0.85');
const dnHue = parseFloat(process.argv[5] !== undefined ? process.argv[5] : '240');
const dnBri = parseFloat(process.argv[6] !== undefined ? process.argv[6] : '1');
const SAT = parseFloat(process.argv[7] !== undefined ? process.argv[7] : '100');
const KELVIN = parseInt(process.argv[8] !== undefined ? process.argv[8] : '2700', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lifx = new Lifx();
  let dev = null;
  for (let i = 1; i <= 3 && !dev; i++) {
    dev = ((await lifx.discover({ timeoutSeconds: 8 })) || []).find((x) => x && x.ip === IP);
    if (!dev) console.log(`discovery ${i}/3: no ${IP}`);
  }
  if (!dev) { console.log('NOT FOUND'); lifx.destroy(); process.exit(1); }

  const logs = [];
  const log = (m) => { logs.push(m); console.log(m); };
  const mapping = new Mapping(process.env.LIFX_MAP || undefined, () => {});
  const fx = new Fixture({ device: dev, mapping, log });

  console.log(`identity: mac=${fx.mac} target=${fx._targetMac()} ip=${fx.ip}`);
  const regions = mapping.forDevice([fx.mac, fx.ip], 8, 8);
  console.log(`mapping source=${regions.source} uplight=[${regions.uplight.join(',')}] downlight=${regions.downlight.length} cells`);

  fx.state.up = { on: upBri > 0, hue: upHue, saturation: SAT, brightness: upBri, kelvin: KELVIN };
  fx.state.down = { on: dnBri > 0, hue: dnHue, saturation: SAT, brightness: dnBri, kelvin: KELVIN };
  await fx.flush();
  console.log(`commanded: up h=${upHue} s=${SAT} b=${upBri} ${KELVIN}K | down h=${dnHue} s=${SAT} b=${dnBri} ${KELVIN}K`);

  await sleep(1200);
  try {
    const r = await dev.tileGetTileState64({ tile_index: 0, length: 1, x: 0, y: 0, width: 8, height: 8 });
    const px = ((Array.isArray(r) ? r[0] : r) || {}).colors || [];
    if (px.length) {
      const n = (v) => (v <= 1 ? v : v / 65535);   // replies are normalised 0-1
      console.log('\nbuffer read-back (R=up/red B=down/blue .=off) — buffer only, LOOK at the ceiling:');
      for (let y = 0; y < 8; y++) {
        console.log('  ' + Array.from({ length: 8 }, (_, x) => {
          const c = px[y * 8 + x] || {};
          return n(c.brightness) <= 0.02 ? '.' : (n(c.hue) < 0.12 ? 'R' : 'B');
        }).join(''));
      }
    }
    const p = await dev.lightGetPower().catch(() => null);
    console.log(`power read-back: ${p && p.level} (reads unreliably — not proof)`);
  } catch (e) {
    console.log('read-back failed: ' + e.message);
  }

  console.log('\nEXPECT: uplight red ring, panel uniformly BLUE, no magenta anywhere.');
  fx.destroy();
  lifx.destroy();
})().catch((e) => { console.log('fatal:', e.message); process.exit(1); });
