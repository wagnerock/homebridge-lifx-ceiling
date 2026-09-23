#!/usr/bin/env node
'use strict';
/**
 * Calibrate which pixels of the 8x8 matrix are the uplight and which are the
 * downlight. The geometry cannot be determined from packets — you have to look at
 * the fixture, and buffer read-back proves only what is in the buffer.
 *
 *   node bin/calibrate.js 192.168.1.50
 *   node bin/calibrate.js 192.168.1.50 --answer up     (non-interactive)
 *   node bin/calibrate.js --invert                    (flip the current map)
 *
 * The shipped default is the CORNER MODEL, verified on pid 176/177 ceilings:
 * uplight = the four corner cells [0, 7, 56, 63], downlight = the other 60. This
 * tool re-confirms it on your fixture, or replaces it if yours differs.
 * Original colour and power are always restored in a finally block.
 */

const readline = require('readline');
const matrix = require('../lib/matrix');
const { Mapping } = require('../lib/mapping');
const { writeTileAcked } = require('../lib/tilewrite');

const argv = process.argv.slice(2);
const ip = argv.find((a) => !a.startsWith('--') && /^\d+\.\d+\.\d+\.\d+$/.test(a));
const invertOnly = argv.includes('--invert');
const sweep = argv.includes('--sweep');
const ai = argv.indexOf('--answer');
const preset = ai >= 0 ? (argv[ai + 1] || '').toLowerCase() : null;
const sti = argv.indexOf('--state');
const state = sti >= 0 ? (argv[sti + 1] || '').toLowerCase() : null;
/**
 * Where a calibration RESULT is persisted. There is no default: the plugin ships no
 * mapping file and nothing is ever written into the installed package. Every run that
 * would persist (`--invert`, `--seam`, or answering the prompt) must name a file with
 * `--map <path>` or `LIFX_MAP`, and the check runs BEFORE the fixture is touched —
 * a tool that paints your ceiling and then fails to record the answer is a tool that
 * repainted your ceiling for nothing.
 */
const mi = argv.indexOf('--map');
const mapFile = (mi >= 0 ? argv[mi + 1] : '') || process.env.LIFX_MAP || '';
const needMap = (what) => {
  if (mapFile) return;
  console.error(`${what} persists a mapping — pass --map <path> (or set LIFX_MAP) to a file of your own. Nothing is written into the installed package, and nothing on the fixture has been touched.`);
  process.exit(2);
};
const LIVE_MS = 8000;
const SWEEP_MS = 5000;
const GAP_MS = 1200;
/** The verified corner model: these four cells are the uplight, the rest the panel. */
const CORNERS = [0, 7, 56, 63];

if (!invertOnly && !ip) {
  console.error('usage: node bin/calibrate.js <ip> [--answer up|down] [--sweep] [--state up|down|both|off] | --invert');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (q) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); res(a.trim().toLowerCase()); });
});

/**
 * One ack-required Tile::SetTileState64 (svc 715). The rules live in lib/tilewrite.js;
 * the library's un-acked tileSetTileState64() is only ever a labelled fallback there.
 * @returns {Promise<number|null>} the answer service, or null on the library path
 */
async function writeTile(device, colors) {
  const payload = { tile_index: 0, length: 1, x: 0, y: 0, width: 8, duration: 0, colors };
  const pkt = await writeTileAcked(device, payload, (m) => console.error(`[tile] ${m}`));
  if (!pkt) return null;
  return (pkt.header && pkt.header.type) || pkt.type || null;
}

(async () => {
  const mapping = new Mapping(mapFile || undefined, console);

  if (invertOnly) {
    needMap('--invert');
    const next = mapping.invert();
    mapping.save();
    console.log(`inverted -> uplight=${next.uplight} downlight=${next.downlight}`);
    return;
  }

  // --seam <n>: adopt the nth swept radius as the mapping (no hardware needed).
  // Radial masks are an EXPERIMENT you measure on your own fixture. The shipped
  // default is the verified corner model; keep it unless your fixture differs.
  const si = argv.indexOf('--seam');
  if (si >= 0) {
    needMap('--seam');
    const n = Number(argv[si + 1]);
    const t = matrix.SEAM_CANDIDATES[n - 1];
    if (!Number.isFinite(t)) {
      console.error(`--seam must be 1..${matrix.SEAM_CANDIDATES.length}, got ${argv[si + 1]}`);
      process.exit(2);
    }
    mapping.setGlobal(`annulus@${t}`, `disc@${t}`);
    if (ip) mapping.setDevice(ip, `annulus@${t}`, `disc@${t}`);
    mapping.save();
    console.log(`seam radius ${t} adopted: uplight=annulus@${t} downlight=disc@${t}${ip ? ` (pinned for ${ip})` : ''}`);
    console.log('restart Homebridge to apply.');
    return;
  }

  // Record-where first, touch-the-light second: without --map the answer to this
  // calibration would have nowhere to go, so refuse before anything is painted.
  needMap('calibrate');

  const Lifx = require('node-lifx-lan-multi');
  const lifx = new Lifx();
  let device = null;
  let saved = null;

  try {
    const found = (await lifx.discover({ timeoutSeconds: 10 })) || [];
    device = found.find((d) => d && d.ip === ip);
    if (!device) throw new Error(`${ip} did not answer discovery — is it powered and on this LAN?`);

    // Save exactly what we found so we can put it back.
    const st = await device.getLightState({}).catch((e) => { console.error(`getLightState failed: ${e.message}`); return null; });
    const pw = await device.lightGetPower().catch((e) => { console.error(`lightGetPower failed: ${e.message}`); return null; });
    saved = { color: st && st.color ? { ...st.color } : null, level: pw && typeof pw.level === 'number' ? pw.level : (st && st.power ? 1 : 0) };
    console.log(`saved state: ${JSON.stringify(saved)}`);

    /*
     * Hold a single state and leave it lit, so a camera can shoot it.
     *
     * Painted in COLOUR, not white: the camera's auto-exposure normalises the
     * scene, so absolute luminance is worthless (full-bright and fully-dark both
     * measured a mean of ~110). Hue survives auto-exposure, so uplight is RED
     * and downlight is BLUE and the seam is found by where red hands over to
     * blue rather than by brightness at all.
     */
    if (state) {
      if (!['up', 'down', 'both', 'off'].includes(state)) {
        console.error('--state must be up|down|both|off');
        process.exit(2);
      }
      const lvlIdx = argv.indexOf('--level');
      const lvl = lvlIdx >= 0 ? Math.max(0.02, Math.min(1, Number(argv[lvlIdx + 1]) || 0.25)) : 0.25;
      const RED = { hue: 0, saturation: 1, brightness: lvl, kelvin: 3500 };
      const BLUE = { hue: 240 / 360, saturation: 1, brightness: lvl, kelvin: 3500 };
      // Pass the MAC first so a MAC-keyed perDevice override wins over the global
      // mapping; forDevice normalises the uppercase wire form and ignores IPs that
      // are not stored as keys.
      const res = mapping.forDevice([device.mac, device.ip]);
      // Handles both shapes a mapping can take: explicit index arrays (the verified
      // corner model) and radial strings such as annulus@0.88.
      const upCells = matrix.indicesForRegion(res.uplight, 8, 8);
      const downCells = matrix.indicesForRegion(res.downlight, 8, 8);
      let b = Array.from({ length: 64 }, () => ({ hue: 0, saturation: 0, brightness: 0, kelvin: 3500 }));
      if (state === 'up' || state === 'both') b = matrix.applyRegion(b, upCells, RED, 8, 8);
      if (state === 'down' || state === 'both') b = matrix.applyRegion(b, downCells, BLUE, 8, 8);
      // 'off' must actually cut power: this fixture's panel is power-driven, so
      // painting the matrix black while leaving power on still lights the panel.
      const on = state !== 'off';
      await device.lightSetPower({ level: on ? 1 : 0, duration: 0 });
      await writeTile(device, b);
      const lit = b.reduce((n, c) => n + (c.brightness > 0 ? 1 : 0), 0);
      console.log(`held ${state} at level ${lvl}, power ${on ? 'ON' : 'OFF'}: ${lit}/64 cells lit (uplight=red downlight=blue) - shoot it now`);
      // Exit without lifx.destroy(): it throws once the driver's socket is down.
      setTimeout(() => process.exit(0), 400);
      return;
    }

    /*
     * Sweep mode: an EXPERIMENT, not the shipped answer. The fixture is ROUND and the
     * matrix is an 8x8 square grid, so a radial threshold always snaps to a blocky
     * rounded square — which is why the verified model is the four corner cells and
     * not an annulus. Sweep when your fixture behaves oddly and let a human pick
     * the step whose boundary sits on the physical seam.
     */
    if (sweep) {
      console.log('\n*** SEAM SWEEP on ' + ip + ' ***');
      console.log('Each step paints the OUTSIDE red (uplight) and the INSIDE blue (downlight).');
      console.log('Watch the boundary circle and remember which step lines up with the fixture seam.\n');
      for (let n = 0; n < matrix.SEAM_CANDIDATES.length; n++) {
        const t = matrix.SEAM_CANDIDATES[n];
        const disc = matrix.discIndices(8, 8, t);
        const ann = matrix.annulusIndices(8, 8, t);
        let b = Array.from({ length: 64 }, () => ({ hue: 0, saturation: 0, brightness: 0, kelvin: 3000 }));
        b = matrix.applyRegion(b, ann, RED, 8, 8);
        b = matrix.applyRegion(b, disc, BLUE, 8, 8);
        await writeTile(device, b);
        console.log(`  STEP ${n + 1}: seam radius ${t} (${disc.length} downlight px / ${ann.length} uplight px) — ${SWEEP_MS / 1000}s`);
        await sleep(SWEEP_MS);
        await writeTile(device, Array(64).fill({ hue: 0, saturation: 0, brightness: 0.02, kelvin: 3000 }));
        await sleep(GAP_MS);
      }
      console.log('\nrun: node bin/calibrate.js ' + ip + ' --seam <1|2|3>   (whichever step matched the seam)');
      return;
    }

    const up = CORNERS;
    const down = matrix.complement(CORNERS, 8, 8);
    const RED = { hue: 0, saturation: 1, brightness: 0.8, kelvin: 3500 };
    const BLUE = { hue: 240 / 360, saturation: 1, brightness: 0.8, kelvin: 3500 };

    await device.lightSetPower({ level: 1, duration: 0 });

    let buf = Array.from({ length: 64 }, () => ({ hue: 0, saturation: 0, brightness: 0, kelvin: 3000 }));
    buf = matrix.applyRegion(buf, up, RED, 8, 8);
    buf = matrix.applyRegion(buf, down, BLUE, 8, 8);
    await writeTile(device, buf);
    console.log(`\n*** LOOK AT THE CEILING (${ip}) ***`);
    console.log('the FOUR CORNER cells should be RED and the panel (the other 60 cells) BLUE.');
    console.log(`holding for ${LIVE_MS / 1000}s so you can see it clearly...\n`);

    const t0 = Date.now();
    let answer = preset;
    if (!answer) {
      answer = await ask('Which part turned RED — the UPLIGHT or the DOWNLIGHT? (u/d) > ');
    }
    const elapsed = Date.now() - t0;
    if (elapsed < LIVE_MS) await sleep(LIVE_MS - elapsed);

    if (answer !== 'u' && answer !== 'up' && answer !== 'd' && answer !== 'down') {
      throw new Error(`unrecognised answer "${answer}" — expected u/p or d/n, mapping left unchanged`);
    }
    const redIsUp = answer === 'u' || answer === 'up';
    const newUp = redIsUp ? up : down;
    const newDown = redIsUp ? down : up;
    mapping.setGlobal(newUp, newDown);
    // deviceInfo.mac does not exist on these fixtures — discovery answers with
    // device.mac in UPPERCASE colon form, and that is the key that resolves.
    const mac = matrix.normalizeMac(device.mac) || device.ip;
    mapping.setDevice(mac, newUp, newDown);
    mapping.save();
    console.log(`calibrated: ${mac} uplight=[${newUp.join(',')}] (${newUp.length} cells) downlight=${newDown.length} cells`);
  } finally {
    if (state) {
      // --state deliberately holds the fixture lit so the camera can shoot it.
    } else if (device && saved) {
      try {
        if (saved.color) {
          const c = saved.color;
          const norm = {
            hue: c.hue > 1 ? c.hue / 360 : c.hue,
            saturation: c.saturation > 1 ? c.saturation / 100 : c.saturation,
            brightness: c.brightness > 1 ? c.brightness / 100 : c.brightness,
            kelvin: Math.round(c.kelvin || 3000),
          };
          await writeTile(device, Array(64).fill(norm));
        }
        await device.lightSetPower({ level: saved.level, duration: 0 });
        console.log(`restored original state: ${JSON.stringify(saved)}`);
      } catch (e) {
        console.error(`could not restore ${ip}: ${e.message}`);
      }
    }
    lifx.destroy();
  }
})().catch((e) => {
  console.error(`calibration failed: ${e.message}`);
  process.exitCode = 1;
});
