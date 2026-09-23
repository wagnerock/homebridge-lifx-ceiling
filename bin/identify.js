// Identity + two write paths, with explicit acks.
// AT 23 GetLabel, AT 102 SetColor (whole light, no tile), AT 719 SetTileEffect off.
const IP = process.argv[2];
if (!IP) { console.error('usage: node bin/identify.js <ip>'); process.exit(2); }

const Lifx = require('node-lifx-lan-multi');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(d, type, payload, label) {
  try {
    const r = await d._lifxLanUdp.request({
      address: d.ip, type, payload: payload || null,
      ack_required: true, res_required: true, target: d.mac
    });
    const p = Array.isArray(r) ? r[0] : r;
    return { ok: true, p };
  } catch (e) { return { ok: false, msg: e.message }; }
}

(async () => {
  const l = new Lifx();
  const f = await l.discover({ timeoutSeconds: 10 }) || [];
  const d = f.find(x => x && x.ip === IP);
  if (!d) { console.log('IP ' + IP + ' not discovered'); process.exit(0); }

  // who are you?
  const lab = await ask(d, 23, null, 'GetLabel');
  let name = '?';
  if (lab.ok && lab.p && lab.p.payload && lab.p.payload.label) name = lab.p.payload.label;
  else if (lab.ok && Buffer.isBuffer(lab.p)) name = lab.p.toString('latin1').replace(/\0+$/, '');
  else if (lab.ok && lab.p && lab.p.payload) {
    const pl = lab.p.payload;
    if (pl.name) name = pl.name;
    else name = JSON.stringify(pl).slice(0, 60);
  }
  console.log('AT 23 GetLabel -> ' + name + (lab.ok ? '' : ' (failed: ' + lab.msg + ')'));

  const ver = await ask(d, 32, null, 'GetColor');
  console.log('AT 32 GetColor -> ' + (ver.ok ? JSON.stringify(ver.p && ver.p.payload).slice(0, 80) : 'failed: ' + ver.msg));

  // whole-light colour, no tile path
  const sc = await ask(d, 102, { hue: 0, saturation: 1, brightness: 1, kelvin: 2700, duration: 0 }, 'SetColor');
  console.log('AT 102 SetColor RED -> ' + (sc.ok ? 'ACK' : 'NO ACK: ' + sc.msg));
  await sleep(3000);
  console.log('\nLOOK: is ' + name + ' red now?');
  process.exit(0);
})().catch(e => { console.log('fatal:', e.message); process.exit(1); });
