// Diagnostics: re-discover everything, pick a fixture BY LABEL (not by a remembered
// IP), then try two different write paths and report which one the fixture
// acknowledges.
const LABEL = (process.argv[2] || '').toLowerCase();
if (!LABEL) { console.error('usage: node bin/diag.js <label>'); process.exit(2); }

const Lifx = require('node-lifx-lan-multi');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const l = new Lifx();
  const f = await l.discover({ timeoutSeconds: 10 }) || [];
  console.log('discovered ' + f.length + ' device(s):');
  for (const d of f) {
    console.log('  ' + String(d.ip).padEnd(16) + ' mac=' + (d.mac || d.address || '?') +
      '  label=' + (d.label || '?') + '  fw=' + (d.firmware_version || '?'));
  }

  const d = f.find(x => (x.label || '').toLowerCase().includes(LABEL));
  if (!d) {
    console.log('\nNO device labelled *' + LABEL + '* - the IP we were using is not this fixture.');
    process.exit(0);
  }
  console.log('\ntarget: ' + d.ip + '  label=' + d.label);

  // path 1: simple whole-light colour, no tile machinery involved
  const setFn = ['lightSetColor', 'setColor'].find(n => typeof d[n] === 'function');
  if (setFn) {
    try {
      await d.lightSetPower({ level: 1 });
      await sleep(300);
      await d[setFn]({ hue: 0, saturation: 1, brightness: 1, kelvin: 2700, duration: 0 });
      console.log('path 1 ' + setFn + ' RED -> sent');
    } catch (e) { console.log('path 1 ' + setFn + ' FAILED: ' + e.message); }
  } else {
    console.log('path 1 unavailable: no setColor method on device object');
    console.log('  available: ' + Object.getOwnPropertyNames(Object.getPrototypeOf(d)).filter(n => /color|Colour|power|set/i.test(n)).join(', '));
  }
  await sleep(2500);

  // path 2: raw AT with ack requested - proves the device understood it
  try {
    await d._lifxLanUdp.request({
      address: d.ip, type: 103, payload: null,
      ack_required: true, res_required: false, target: d.mac
    });
    console.log('path 2 AT 103 GetColor w/ ack -> acknowledged');
  } catch (e) { console.log('path 2 ack probe FAILED: ' + e.message); }

  console.log('\nLOOK: is ' + d.label + ' RED now?');
  process.exit(0);
})().catch(e => { console.log('fatal:', e.message); process.exit(1); });
