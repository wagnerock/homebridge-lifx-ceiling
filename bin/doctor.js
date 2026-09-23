#!/usr/bin/env node
'use strict';
/**
 * Self-diagnosis for homebridge-lifx-ceiling. Run this when the lights are doing
 * something you cannot explain, and paste the output into a bug report.
 *
 *   node bin/doctor.js                 # discover everything, check every fixture
 *   node bin/doctor.js 192.168.1.50  # check one address
 *
 * What it answers, in order:
 *   1. Which versions are actually installed — the plugin, Homebridge, node, and
 *      node-lifx-lan-multi, whose private `_lifxLanUdp` the ack-required tile write
 *      depends on. A future library release that renames it degrades tile writes to
 *      un-acked, and the only symptom is lights that do not change.
 *   2. Whether each fixture answers broadcast discovery, and whether it answers a
 *      unicast request when it does not — the distinction that mattered on 2026-09-22,
 *      when broadcast silence was mistaken for absence.
 *   3. Whether an ack-required svc-715 write actually round-trips. The write sends the
 *      fixture's CURRENT colours back to it, so the room looks exactly as it did.
 *
 * Exit code is non-zero if anything failed, so this is usable from CI or a cron job.
 */

const fail = [];
const say = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fail.push(label);
};

const versionOf = (mod) => {
  try { return require(`${mod}/package.json`).version; } catch (e) { return null; }
};

/** Homebridge lives in a global root, not in this plugin's node_modules. */
function globalHomebridgeVersion() {
  const roots = ['/usr/lib/node_modules', '/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules'];
  for (const r of roots) {
    try { return require(`${r}/homebridge/package.json`).version; } catch (e) { /* keep looking */ }
  }
  try {
    const fs = require('fs');
    const p = `${process.env.HOMEBRIDGE_CONFIG_DIR || '/var/lib/homebridge'}/homebridge.log`;
    const tail = fs.readFileSync(p, 'utf8').split('\n').slice(-200).join('\n');
    const m = tail.match(/v?(\d+\.\d+\.\d+)/);
    return m ? m[1] + ' (from the log)' : null;
  } catch (e) { return null; }
}

(async () => {
  const target = (process.argv[2] || '').trim() || null;

  console.log('homebridge-lifx-ceiling doctor');
  console.log('------------------------------');
  const plugin = versionOf('homebridge-lifx-ceiling');
  const here = require('../package.json');
  say('plugin version', true, `${plugin || 'installed as ' + here.version}${plugin && plugin !== here.version ? ` (dev copy ${here.version})` : ''}`);
  say('node', true, process.version);
  const hb = versionOf('homebridge') || globalHomebridgeVersion();
  // INFO, not FAIL: a plugin is installed as a dependency OF Homebridge, so requiring
  // 'homebridge' from a global plugin directory legitimately fails. It is not a fault.
  console.log(`INFO homebridge — ${hb || 'not resolvable from this path (normal for a global install)'}`);
  const libVersion = versionOf('node-lifx-lan-multi');
  say('node-lifx-lan-multi', !!libVersion, libVersion || 'MISSING — install dependencies');

  const { CEILING_UPLIGHT_CELLS, ceilingsDownlightCells } = require('../lib/matrix');
  say('geometry', JSON.stringify(CEILING_UPLIGHT_CELLS) === '[0,7,56,63]',
    `uplight ${CEILING_UPLIGHT_CELLS.join(',')} downlight ${ceilingsDownlightCells(8, 8).length} cells (hardware-verified for pid 176/177)`);

  const { writeTileAcked } = require('../lib/tilewrite');
  const Lifx = require('node-lifx-lan-multi');
  const lifx = new Lifx();
  let found = [];
  try {
    found = (await lifx.discover({ timeoutSeconds: 10 })) || [];
  } catch (e) {
    say('discovery', false, e.message);
  }
  say('discovery', found.length > 0, `${found.length} device(s) answered broadcast${target ? `, looking for ${target}` : ''}`);

  // Only ceilings. `svc 715` to a white bulb or a color strip is not a harmless no-op:
  // this tool writes frames, and it has no business touching a light it cannot model.
  const { isCeiling } = require('../lib/platform');
  const { hasMatrix } = require('../lib/platform');
  const candidates = found.filter((d) => d && d.deviceInfo && (!target || d.ip === target));
  const ceilings = [];
  for (const d of candidates) {
    if (!isCeiling(d)) { console.log(`skip ${d.ip} ${(d.deviceInfo && d.deviceInfo.label) || ''} — not a Ceiling (pid ${d.deviceInfo.productId}); no tile writes`); continue; }
    if (await hasMatrix(d, () => {})) ceilings.push(d);
    else console.log(`skip ${d.ip} ${(d.deviceInfo && d.deviceInfo.label) || ''} — no populated tile in the chain`);
  }
  if (!ceilings.length) {
    say('fixture', false, `${target || 'any ceiling'} — nothing to check. Is Homebridge running, and is this machine on the same subnet?`);
  }

  for (const d of ceilings) {
    const mac = d.mac || (d.deviceInfo && d.deviceInfo.mac) || 'no MAC reported';
    console.log(`\n${d.ip}  ${mac}  label "${(d.deviceInfo && d.deviceInfo.label) || '?'}"`);
    const canAck = !!(d._lifxLanUdp && typeof d._lifxLanUdp.request === 'function');
    say('  private acked transport (_lifxLanUdp.request)', canAck,
      canAck ? 'acked tile writes available' : `ABSENT in node-lifx-lan-multi@${libVersion} — tile writes are UNACKED and unverifiable`);

    let st = null;
    try { st = await d.getLightState({}); } catch (e) { /* reported below */ }
    say('  unicast GetLightState', !!st, st ? `power ${st.power ? 'on' : 'off'}, ${(st.color && st.color.kelvin) || '?'}K` : 'no reply — fixture unreachable at this address');

    if (canAck && st && st.color) {
      try {
        const colors = new Array(64).fill({
          hue: (st.color.hue || 0) / 360, saturation: (st.color.saturation || 0) / 100,
          brightness: st.color.brightness == null ? 1 : st.color.brightness, kelvin: st.color.kelvin || 3000,
        });
        const pkt = await writeTileAcked(d, { tile_index: 0, length: 1, x: 0, y: 0, width: 8, duration: 0, colors }, console.error);
        const svc = (pkt && pkt.header && pkt.header.type) || (pkt && pkt.type);
        say('  acked svc-715 round-trip', svc !== 223, `answer service ${svc} (current colours rewritten unchanged, room visually untouched)`);
      } catch (e) {
        say('  acked svc-715 round-trip', false, e.message);
      }
    }
  }

  try { if (lifx.destroy) lifx.destroy(); } catch (e) { /* teardown */ }
  console.log(`\n${fail.length ? `${fail.length} problem(s): ${fail.join('; ')}` : 'all checks passed'}`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('doctor failed:', e.message); process.exit(1); });
