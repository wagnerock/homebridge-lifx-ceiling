// Unmistakable write: every cell full red. If the fixture does not change, the
// writes are not reaching it and nothing else should be concluded. Sent ack-required
// (svc 715) because an un-acked tile write can vanish without any error at all.
const IP = process.argv[2];
if (!IP) { console.error('usage: node bin/all-red.js <ip>'); process.exit(2); }

const Lifx = require('node-lifx-lan-multi');
const { writeTileAcked } = require('../lib/tilewrite');
(async () => {
  const l = new Lifx();
  const f = await l.discover({ timeoutSeconds: 8 }) || [];
  const d = f.find(x => x && x.ip === IP);
  if (!d) { console.log('device NOT FOUND - that is the answer'); process.exit(0); }
  console.log('found ' + d.ip + ' label=' + (d.label || '?'));
  const buf = [];
  for (let i = 0; i < 64; i++) buf.push({ hue: 0, saturation: 1, brightness: 1, kelvin: 2700 });
  await d.lightSetPower({ level: 1 });
  await new Promise(r => setTimeout(r, 400));
  // Ack-required, rules in lib/tilewrite.js: an un-acked frame on these ceilings can
  // vanish with no error, which looks exactly like a tool that worked.
  const pkt = await writeTileAcked(d, { tile_index: 0, length: 1, x: 0, y: 0, width: 8, duration: 0, colors: buf }, console.error);
  const svc = (pkt && pkt.header && pkt.header.type) || (pkt && pkt.type);
  if (svc === 223) { console.log('AT 715 -> svc 223 REJECTED'); process.exit(2); }
  console.log(`wrote ALL 64 cells FULL RED - ack svc ${svc || 'none (un-acked library fallback, unverified)'}`);
  process.exit(0);
})().catch(e => { console.log('fatal:', e.message); process.exit(1); });
