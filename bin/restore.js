// Restore a fixture to full warm white using the ack-required write path.
const IP = process.argv[2];
if (!IP) { console.error('usage: node bin/restore.js <ip>'); process.exit(2); }

const Lifx = require('node-lifx-lan-multi');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const l = new Lifx();
  const f = await l.discover({ timeoutSeconds: 8 }) || [];
  const d = f.find(x => x && x.ip === IP);
  if (!d) { console.log('not discovered'); process.exit(0); }
  const colors = [];
  for (let i = 0; i < 64; i++) colors.push({ hue: 0, saturation: 0, brightness: 1, kelvin: 2700 });
  await d.lightSetPower({ level: 1 });
  await sleep(300);
  await d._lifxLanUdp.request({
    address: d.ip, type: 715, ack_required: true, res_required: false, target: d.mac,
    payload: { tile_index: 0, length: 1, x: 0, y: 0, width: 8, duration: 0, colors }
  });
  console.log('restored ' + IP + ' to full warm white (ack-required write)');
  process.exit(0);
})().catch(e => { console.log('fatal:', e.message); process.exit(1); });
