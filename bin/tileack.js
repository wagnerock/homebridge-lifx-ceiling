// Power is proven to work, tile writes are not. Ask the fixture to ACK the tile
// write and report exactly what it returns - ack, or service 223 Rejection.
const IP = process.argv[2];
if (!IP) { console.error('usage: node bin/tileack.js <ip> [up|down|all] [t]'); process.exit(2); }

const Lifx = require('node-lifx-lan-multi');
const m = require('../lib/matrix');
const MODE = process.argv[3] || 'up';    // up | down | all
const T = parseFloat(process.argv[4] !== undefined ? process.argv[4] : '0.88');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const l = new Lifx();
  const f = await l.discover({ timeoutSeconds: 8 }) || [];
  const d = f.find(x => x && x.ip === IP);
  if (!d) { console.log('not discovered'); process.exit(0); }

  await d.lightSetPower({ level: 1 }).catch(e => console.log('power: ' + e.message));
  await sleep(600);

  const band = new Set(m.annulusIndices(8, 8, T));
  const upOn = (MODE === 'up' || MODE === 'all') ? 1 : 0;
  const dnOn = (MODE === 'down' || MODE === 'all') ? 1 : 0;
  const colors = [];
  for (let i = 0; i < 64; i++) {
    colors.push({
      hue: 0, saturation: band.has(i) ? 1 : 0,
      brightness: band.has(i) ? upOn : dnOn, kelvin: 2700
    });
  }

  try {
    const r = await d._lifxLanUdp.request({
      address: d.ip, type: 715,
      payload: { tile_index: 0, length: 1, x: 0, y: 0, width: 8, duration: 0, colors },
      ack_required: true, res_required: false, target: d.mac
    });
    const p = Array.isArray(r) ? r[0] : r;
    const svc = p && p.header ? p.header.type : (p && p.type);
    console.log('AT 715 tile write -> ' + JSON.stringify({ svc, payload: p && p.payload }));
    if (svc === 223) console.log('  >>> REJECTED by fixture (service 223)');
    else if (svc === 3) console.log('  >>> ACKed. Device accepted the tile write.');
  } catch (e) {
    console.log('AT 715 -> ERROR: ' + e.message);
  }

  console.log('\nmap (# emitting):');
  for (let y = 0; y < 8; y++) {
    let s = '';
    for (let x = 0; x < 8; x++) s += (band.has(y * 8 + x) ? upOn : dnOn) > 0 ? '#' : '.';
    console.log('  ' + s);
  }
  console.log('\nLOOK at the fixture: uplight on? panel lit?');
  process.exit(0);
})().catch(e => { console.log('fatal:', e.message); process.exit(1); });
