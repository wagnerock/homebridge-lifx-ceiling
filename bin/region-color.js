// Colour an EXPLICIT set of cells one colour and everything else another.
// The radial seam model has been disproven: the halves do not optically bleed, so
// any red that appears on the panel face means a cell we assigned to the uplight is
// physically a downlight LED. Radial bands can no longer express that — explicit
// index lists can.
//
// Usage: node bin/region-color.js <ip> <upSpec> <upHue> <upBri> <dnHue> <dnBri>
//   upSpec: cells:0,7,56,63 | annulus@1.09 | disc@1.01 | all | none
//   hue in degrees, brightness 0..1
//
//   # only the 4 grid corners red, panel blue
//   node bin/region-color.js 192.168.1.50 cells:0,7,56,63 0 1 240 1
//
// Writes with ack_required:true (library default silently drops tile writes).
const IP = process.argv[2];
if (!IP) { console.error('usage: node bin/region-color.js <ip> <upSpec> <upHue> <upBri> <dnHue> <dnBri> [kelvin]'); process.exit(2); }

const Lifx = require('node-lifx-lan-multi');
const m = require('../lib/matrix');

const SPEC = process.argv[3] || 'none';
const upHue = (parseFloat(process.argv[4]) || 0) / 360;
const upBri = process.argv[5] !== undefined ? parseFloat(process.argv[5]) : 1.0;
const dnHue = (parseFloat(process.argv[6]) || 0) / 360;
const dnBri = process.argv[7] !== undefined ? parseFloat(process.argv[7]) : 1.0;
const KELVIN = parseFloat(process.argv[8] !== undefined ? process.argv[8] : '2700');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolve(spec) {
  if (!spec || spec === 'none') return [];
  if (spec === 'all') return Array.from({ length: 64 }, (_, i) => i);
  if (spec.startsWith('cells:') || spec.startsWith('list:')) {
    return spec.split(':')[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
  }
  return m.indicesForRegion(spec, 8, 8);
}

async function findDevice(lifx, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    const list = (await lifx.discover({ timeoutSeconds: 8 })) || [];
    const d = list.find((x) => x && x.ip === IP);
    if (d) return d;
    console.log(`discovery attempt ${i}/${tries}: no ${IP}`);
  }
  throw new Error(`device ${IP} not discovered after ${tries} attempts`);
}

(async () => {
  const up = new Set(resolve(SPEC));
  if ([...up].some((i) => i < 0 || i > 63)) throw new Error('cell index out of range 0-63');

  const colors = [];
  for (let i = 0; i < 64; i++) {
    const u = up.has(i);
    colors.push({
      hue: u ? upHue : dnHue, saturation: 1.0,
      brightness: u ? upBri : dnBri, kelvin: KELVIN,
    });
  }

  const lifx = new Lifx();
  const dev = await findDevice(lifx);
  await dev.lightSetPower({ level: 1 }).catch((e) => console.log('power:', e.message));
  await sleep(250);

  const r = await dev._lifxLanUdp.request({
    address: dev.ip, type: 715,
    payload: { tile_index: 0, length: 1, x: 0, y: 0, width: 8, duration: 0, colors },
    ack_required: true, res_required: false, target: dev.mac,
  });
  const pkt = Array.isArray(r) ? r[0] : r;
  const svc = (pkt && pkt.header && pkt.header.type) || (pkt && pkt.type);
  if (svc === 223) { console.log('AT 715 -> svc 223 REJECTED'); lifx.destroy(); process.exit(2); }
  console.log(`AT 715 -> svc ${svc}; ${up.size} cells RED(${(upHue * 360).toFixed(0)}), ${64 - up.size} cells BLUE(${(dnHue * 360).toFixed(0)})`);

  console.log('\nwritten buffer (R=red .=blue):');
  for (let y = 0; y < 8; y++) {
    console.log('  ' + Array.from({ length: 8 }, (_, x) => (up.has(y * 8 + x) ? 'R' : '.')).join(''));
  }
  console.log('\nLOOK: red only where expected? any red inside the panel face? uplight red?');
  lifx.destroy();
})().catch((e) => { console.log('fatal:', e.message); process.exit(1); });
