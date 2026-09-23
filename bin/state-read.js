// Current live state of a fixture: power + which cells are lit right now.
const IP = process.argv[2];
if (!IP) { console.error('usage: node bin/state-read.js <ip>'); process.exit(2); }

const Lifx = require('node-lifx-lan-multi');
(async () => {
  const l = new Lifx();
  const f = await l.discover({ timeoutSeconds: 8 }) || [];
  const d = f.find(x => x && x.ip === IP);
  if (!d) { console.log('device not found'); process.exit(0); }
  const p = await d.lightGetPower().catch(() => ({}));
  console.log('power=' + (p && p.level));
  const r = await d.tileGetTileState64({ tile_index: 0, x: 0, y: 0, width: 8, length: 1 });
  const t = Array.isArray(r) ? r[0] : r;
  if (!t || !t.colors) { console.log('read null'); process.exit(0); }
  for (let y = 0; y < 8; y++) {
    let s = '';
    for (let x = 0; x < 8; x++) {
      const c = t.colors[y * 8 + x] || {};
      s += (c.brightness || 0) > 0.05 ? '#' : ((c.brightness || 0) > 0 ? '~' : '.');
    }
    console.log('  ' + s);
  }
  const lit = t.colors.filter(c => c && c.brightness > 0.05).length;
  console.log('  lit=' + lit + '/64');
  process.exit(0);
})().catch(e => { console.log('fatal: ' + e.message); process.exit(1); });
