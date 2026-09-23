'use strict';
/** Zero-dependency smoke tests. Run: npm test */
async function main() {
const assert = require('assert');
const matrix = require('../lib/matrix');

let n = 0;
const ok = (label) => { n++; console.log(`  ok ${n} — ${label}`); };

// THE GEOMETRY IS A CONSTANT: one product, one split, compiled in. There is no mapping
// module, no region selection and no radius to tune — lib/matrix.js exports the corner
// model and nothing else, and that is the whole product decision.
const os = require('os');
const fs = require('fs');
const CORNERS = [0, 7, 56, 63];
assert.deepStrictEqual(matrix.CEILING_UPLIGHT_CELLS, CORNERS, 'uplight is the four corner cells');
ok('the uplight is the four corner cells [0,7,56,63]');

const DOWN = matrix.ceilingsDownlightCells(8, 8);
assert.deepStrictEqual(DOWN, matrix.complement(CORNERS, 8, 8), 'downlight is the complement of the corners');
assert.strictEqual(DOWN.length, 60, `downlight must be 60 cells, got ${DOWN.length}`);
assert.deepStrictEqual(matrix.ceilingsDownlightCells(), DOWN, 'the default buffer is the 8x8 ceiling');
ok('the downlight is the other 60 cells');

// Disjoint and exhaustive: there is exactly one way to split this fixture.
const touch = CORNERS.filter((i) => DOWN.includes(i));
assert.strictEqual(touch.length, 0, `the halves overlap at ${touch.join(',')}`);
assert.deepStrictEqual([...CORNERS, ...DOWN].sort((a, b) => a - b), matrix.allIndices(8, 8));
ok('uplight and downlight are disjoint and cover all 64 cells');
assert.deepStrictEqual(matrix.ceilingsDownlightCells(2, 2), [1, 2, 3], 'the rule is the complement at any buffer size');
assert.deepStrictEqual(matrix.complement([0, 1, 2], 8, 8), matrix.allIndices(8, 8).slice(3));
ok('complement returns every index the input does not own');

// colour validation — the two bugs that cost the most time on real hardware
assert.throws(() => matrix.assertColor({ hue: 240, saturation: 1, brightness: 1, kelvin: 3500 }), /hue must be a float/);
ok('assertColor rejects raw 0-360 hue (must be normalised)');
assert.throws(() => matrix.assertColor({ hue: 0, saturation: 65535, brightness: 1, kelvin: 3500 }), /saturation must be a float/);
ok('assertColor rejects 0-65535 saturation');
assert.throws(() => matrix.assertColor({ hue: 0, saturation: 0, brightness: 1 }), /kelvin/);
ok('assertColor requires absolute kelvin on every colour');
matrix.assertColor({ hue: 0.6667, saturation: 1, brightness: 0.7, kelvin: 4000 });
ok('assertColor accepts a normalised colour');

// paintCells is non-mutating and only paints the target cells
const base = matrix.allIndices(8, 8).map(() => ({ hue: 0, saturation: 0, brightness: 0.2, kelvin: 3000 }));
const frozen = JSON.stringify(base);
const RED = { hue: 0, saturation: 1, brightness: 0.8, kelvin: 3500 };
const painted = matrix.paintCells(base, CORNERS, RED, 8, 8);
assert.strictEqual(JSON.stringify(base), frozen, 'paintCells must not mutate input');
ok('paintCells does not mutate the source buffer');
assert.strictEqual(painted[0].saturation, 1, 'corner pixel 0 should be red');
assert.strictEqual(painted[63].saturation, 1, 'corner pixel 63 should be red');
assert.strictEqual(painted[9].saturation, 0, 'panel pixel 9 must stay untouched');
ok('paintCells paints only the target cells');

// CANONICAL MAC FORM (proven on hardware): discover() answers with device.mac
// UPPERCASE colon-separated and no deviceInfo.mac at all, config stores lowercase
// colon, derived ids are 12-hex. All three must mean the same fixture.
assert.strictEqual(matrix.normalizeMac('AA:BB:CC:DD:EE:FF'), 'aabbccddeeff');
assert.strictEqual(matrix.normalizeMac('aa:bb:cc:dd:ee:ff'), 'aabbccddeeff');
assert.strictEqual(matrix.normalizeMac('aabbccddeeff'), 'aabbccddeeff');
assert.strictEqual(matrix.normalizeMac('AA:BB:CC:DD:EE:FF'), matrix.normalizeMac('aabbccddeeff'));
assert.strictEqual(matrix.normalizeMac('192.168.1.50'), null, 'an IPv4 address is not a MAC');
assert.strictEqual(matrix.normalizeMac(undefined), null);
ok('normalizeMac collapses all three MAC formats to one canonical value, null for IPs/undefined');

// Nothing site-specific ships, and nothing can be pointed at a file that would move the
// geometry: no config/ directory, no data file, no path in the schema.
assert.ok(!fs.existsSync(require('path').join(__dirname, '..', 'config')), 'no config/ directory may ship')
// Stale prose is a real defect: identity was the fixture IP until 1.1.0 and the comments
// said so in those words. Comments mandating a DHCP reservation now argue for a requirement
// the code does not have — a future reader would "fix" working code to match them.
{
  const plat = fs.readFileSync(require('path').join(__dirname, '..', 'lib/platform.js'), 'utf8');
  assert.ok(!/needs a DHCP reservation|IDENTITY IS THE FIXTURE IP/i.test(plat), 'lib/platform.js carries pre-1.1.0 IP-identity prose');
};
assert.ok(!fs.existsSync(require('path').join(__dirname, '..', 'lib', 'mapping.js')), 'lib/mapping.js must not exist');
ok('the corner model is a code constant and no data file ships');

// The settings screen offers exactly the five keys a buyer can set — and its header states
// the geometry is the corner model rather than pointing at something to edit.
const schema = require('../config.schema.json');
assert.deepStrictEqual(Object.keys(schema.schema.properties).sort(), ['aliases', 'discoveryInterval', 'kelvinMax', 'kelvinMin', 'name'], 'the schema must advertise exactly five keys');
assert.strictEqual(schema.singular, true, 'two LifxCeiling platforms would mint identical mac:half UUIDs for one fixture');
assert.match(schema.headerDisplay, /corner cells/i);
assert.match(schema.headerDisplay, /DHCP reservation/i);
assert.ok(!/untested guess/i.test(schema.headerDisplay), 'headerDisplay must not call the shipped model a guess');
ok('config.schema.json advertises exactly the five keys a buyer can set');

// Same guard for the user-facing docs: the published package describes the product,
// not somebody's house. The pattern itself lives in the whole-package scan further down
// — repeated literals here would make this file trip its own check.
const readme = fs.readFileSync(require('path').join(__dirname, '..', 'README.md'), 'utf8');
assert.match(readme, /DHCP reservation/i);
assert.match(readme, /ack_required/i);
ok('README.md is generic and states the corner model, ack rule and reservation requirement');

// capability-based detection — the bug that created dead lights
const { isCeiling, hasMatrix } = require('../lib/platform');
assert.strictEqual(isCeiling({ deviceInfo: { productId: 176, features: { matrix: true } }, ip: '192.168.1.50' }), true);
ok('isCeiling accepts a matrix ceiling by capability');
assert.strictEqual(isCeiling({ deviceInfo: { productId: 43, features: { matrix: false }, label: 'Ceiling Study' }, ip: '192.168.1.106' }), false);
ok('isCeiling REFUSES a Mini whose label says Ceiling');
assert.strictEqual(isCeiling({ deviceInfo: { productId: 177 }, ip: 'x' }), true);
ok('isCeiling falls back to pid 177 (Intl) when features absent');
assert.strictEqual(isCeiling({ deviceInfo: {}, ip: 'x' }), false);
ok('isCeiling rejects a device with no usable metadata');
assert.strictEqual(await hasMatrix({ ip: 'a', tileGetDeviceChain: async () => ({ tile_devices: [{ width: 0 }, { width: 0 }] }) }, () => {}), false);
ok('hasMatrix rejects a chain of empty slots');
assert.strictEqual(await hasMatrix({ ip: 'b', tileGetDeviceChain: async () => ({ tile_devices: [{ width: 8, height: 8 }] }) }, () => {}), true);
ok('hasMatrix accepts a populated tile');
assert.strictEqual(await hasMatrix({ ip: 'c', tileGetDeviceChain: async () => { throw new Error('timeout'); } }, () => {}), false);
ok('hasMatrix fails closed on error');

// NEW accessories must use the 3-arg register (this is what puts them on the
// bridge and lets Homebridge cache them). Regression guard for the bug where
// updatePlatformAccessories alone silently produced lights that never reached Home.app.
const { LifxCeilingPlatform, PLUGIN_ID, PLATFORM_NAME } = require('../lib/platform');
assert.strictEqual(PLUGIN_ID, 'homebridge-lifx-ceiling');
assert.strictEqual(PLATFORM_NAME, 'LifxCeiling');
ok('platform exports the plugin id and platform name');

const mockChar = () => {
  // Keeps the handlers the platform binds, so a test can invoke the exact onSet that
  // Home.app would invoke and watch whether it reaches a live Fixture.
  const o = {
    handlers: {}, props: null, value: undefined,
    onGet: (fn) => { o.handlers.onGet = fn; return o; },
    onSet: (fn) => { o.handlers.onSet = fn; return o; },
    setProps: (p) => { o.props = p; return o; },
    updateValue: (v) => { o.value = v; return o; },
  };
  return o;
};
const mockSvc = () => {
  const chars = new Map();
  const o = {
    chars,
    sets: [],
    setCharacteristic: (name, value) => { o.sets.push([name, value]); return o; },
    getCharacteristic: (name) => { if (!chars.has(name)) chars.set(name, mockChar()); return chars.get(name); },
  };
  return o;
};
class FakeAccessory {
  constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.context = {}; this.svcs = new Map(); }
  // Subtypes already on the accessory — like the real one, it keeps what it cached.
  get subtypes() { return [...this.svcs.keys()]; }
  addService(s, displayName, subtype) { const svc = mockSvc(); this.svcs.set(subtype, svc); return svc; }
  getServiceById(s, subtype) { return this.svcs.get(subtype) || null; }
}
const recLog = () => {
  const lines = [];
  const log = Object.assign((m) => { lines.push(String(m)); }, {
    error: (m) => { lines.push(String(m)); }, warn: (m) => { lines.push(String(m)); }, info: (m) => { lines.push(String(m)); },
  });
  return { log, lines };
};
/**
 * A fresh fake Homebridge api plus its call log. register / update / unregister are
 * recorded separately so a test can prove "reused, never re-minted" — and the reverse.
 */
const fakeHarness = () => {
  const calls = { register: [], update: [], unregister: [] };
  const api = {
    version: 2.4,
    hap: {
      uuid: { generate: (s) => s },
      Service: { Lightbulb: 'Lightbulb' },
      Characteristic: { On: 'On', Brightness: 'Brightness', Hue: 'Hue', Saturation: 'Saturation', ColorTemperature: 'ColorTemperature', Name: 'Name' },
      Categories: { LIGHTING: 5 },
    },
    platformAccessory: FakeAccessory,
    registerPlatformAccessories: (p, n, a) => calls.register.push([p, n, a.length]),
    updatePlatformAccessories: (a) => calls.update.push({ count: a.length, accs: a }),
    unregisterPlatformAccessories: (p, n, a) => calls.unregister.push([p, n, a.length]),
    on: () => {},
  };
  return { api, calls };
};
const { api: fakeApi, calls } = fakeHarness();
const { log: fakeLog, lines: logs } = recLog();
const fakeDevice = {
  ip: '192.168.1.50',
  deviceInfo: { mac: 'd0:52:50:aa:bb:cc', label: 'Test Ceiling', features: { matrix: true }, productId: 176 },
  tileGetDeviceChain: async () => ({ tile_devices: [{ width: 8, height: 8 }] }),
  tileSetTileState64: async () => {},
  lightSetPower: async () => {},
  lightGetPower: async () => ({ level: 1 }),
  getLightState: async () => ({ power: 1, color: { hue: 0, saturation: 0, brightness: 0.5, kelvin: 3000 } }),
};
const plat = new LifxCeilingPlatform(fakeLog, {}, fakeApi);
plat.lifx = { discover: async () => [fakeDevice], destroy: () => {} };
await plat.discover();
assert.deepStrictEqual(calls.register, [[PLUGIN_ID, PLATFORM_NAME, 2]], `expected one 3-arg register with 2 lights, got ${JSON.stringify(calls.register)}`);
ok('discover() publishes TWO accessories per ceiling (named uplight + downlight)');
assert.strictEqual(calls.update.length, 0, 'must not call updatePlatformAccessories for brand-new accessories');
ok('discover() does not misuse updatePlatformAccessories');
const names = [...plat.accessories.values()].map((a) => a.displayName);
assert.ok(names.some((n) => /Uplight$/.test(n)) && names.some((n) => /Downlight$/.test(n)), `names: ${names}`);
ok('accessories carry the Uplight/Downlight names Home.app was missing');
// IDENTITY IS THE HARDWARE MAC (the change). A fixture that renews onto a new address is
// the SAME accessory — same UUID, same name, same room — with only its transport moved.
// That is what removes the DHCP reservation requirement, and it costs nothing on an
// existing install because every cached accessory already carries context.hwMac.
const accIds = [...plat.accessories.keys()];
assert.deepStrictEqual(accIds, ['d05250aabbcc:up', 'd05250aabbcc:down'], 'accessories must be keyed mac:half, got ' + accIds);
const accObjs = [...plat.accessories.values()];
assert.ok(accObjs.every((a) => /^d05250aabbcc:(up|down)$/.test(a.UUID)), `UUID must be minted from the hardware MAC: ${accObjs.map((a) => a.UUID)}`);
assert.ok(accObjs.every((a) => /^d05250aabbcc:(up|down)$/.test(a.context.stableId)), 'stableId must be mac:half: ' + accObjs.map((a) => a.context.stableId));
assert.ok(accObjs.every((a) => a.context.hwMac === 'd05250aabbcc'), `context.hwMac must carry the canonical MAC: ${accObjs.map((a) => a.context.hwMac)}`);
assert.ok(accObjs.every((a) => a.context.mac === '192.168.1.50'), `context.mac keeps the cached address form so an older cache still matches byte-for-byte: ${accObjs.map((a) => a.context.mac)}`);
assert.strictEqual(plat.fixtures.get('d05250aabbcc').ip, '192.168.1.50', 'the fixture registry is keyed by MAC; the address lives on the fixture, not in the identity');
ok('identity is MAC-based: UUID and stableId derive from the hardware MAC, the address is transport state');
// second cycle must not re-register the same fixture
await plat.discover();
assert.strictEqual(calls.register.length, 1, 're-discovery must not double-register');
ok('repeat discovery does not double-register a fixture');
// A DHCP RENEWAL IS NOT AN EVENT. Same MAC, different address: the accessory is found by
// MAC and reused, nothing is registered, and only the transport moves. Before 1.1.0 this
// minted a second identity and needed a router reservation to avoid it.
plat.lifx = { discover: async () => [Object.assign({}, fakeDevice, { ip: '192.168.1.199', mac: 'D0:52:50:AA:BB:CC' })], destroy: () => {} };
const regBeforeMove = calls.register.length;
const unregBeforeMove = calls.unregister.length;
await plat.discover();
assert.strictEqual(calls.register.length, regBeforeMove, 'a new address on a known MAC must NOT mint a new accessory');
assert.deepStrictEqual([...plat.accessories.keys()], ['d05250aabbcc:up', 'd05250aabbcc:down'], 'still exactly the original two identities after an address change');
assert.strictEqual(plat.fixtures.get('d05250aabbcc').ip, '192.168.1.199', 'the transport moved to the address the fixture is answering on now');
assert.match(logs.join('\n'), /transport moved 192\.168\.1\.50 -> 192\.168\.1\.199/, 'the move is logged, old and new address');
assert.strictEqual(calls.unregister.length, unregBeforeMove, 'an address change unregisters nothing');
ok('a DHCP renewal reuses the accessory by MAC and moves only the transport — no reservation required');
// UNICAST LIVENESS: broadcast silence alone must never mark a fixture missing. Managed APs
// filter broadcast UDP and these radios sleep; on 2026-09-22 that misreading deleted eight
// tiles. "Missing" now means "did not answer a request aimed at it".
plat.lifx = { discover: async () => [], destroy: () => {} };
await plat.discover();
await plat.discover();
await plat.discover();
assert.strictEqual(plat._misses.size, 0, 'a fixture that answers a unicast probe is never counted as missing, however long broadcast stays quiet');
assert.match(logs.join('\n'), /answered a unicast probe/, 'the unicast rescue is logged, with the address and the reported power');
ok('broadcast silence is confirmed by a unicast probe before anything is called missing');
// An address that answers nothing at all is genuinely unreachable — logged as such, and
// still unregistering nothing.
plat.fixtures.get('d05250aabbcc').device.getLightState = async () => { throw new Error('no reply'); };
await plat.discover();
await plat.discover();
await plat.discover();
assert.strictEqual(plat._misses.get('d05250aabbcc'), 3, 'three cycles of silence on both transports is three misses');
assert.match(logs.join('\n'), /unicast probe to 192\.168\.1\.199 failed/, 'a failed unicast probe is named, with the address it tried');
assert.match(logs.join('\n'), /keeping its accessory/i, 'an unreachable fixture keeps its accessory');
assert.strictEqual(calls.unregister.length, unregBeforeMove, 'unreachability unregisters nothing');
ok('a fixture silent on both broadcast and unicast is reported unreachable and keeps its accessory');
plat.warnOnIdentityDrift(null, '192.168.1.77');
assert.ok(!/ONE FIXTURE, TWO ADDRESSES/.test(logs.join('\n')), 'a device with no MAC cannot be matched, so it is not an address change');
ok('an address change with no MAC to match on is not reported as drift');
// unregisterPlatformAccessories(), Home.app deleted eight tiles out of the user's rooms,
// and no restart or re-login brought the room assignments back. Missing multicast is not
// evidence a fixture is gone — a unicast probe to the same IP answers while IGMP is
// filtering. So the miss is counted and logged, and NOTHING is unregistered.
plat.lifx = { discover: async () => [], destroy: () => {} };
const accessoriesBefore = plat.accessories.size;
const unregisterBefore2 = calls.unregister.length;
await plat.discover(); plat._misses.set('192.168.1.50', 2); // identity is the fixture IP
await plat.discover();
assert.strictEqual(calls.unregister.length, unregisterBefore2, 'a fixture that stops answering discovery must NOT be unregistered');
assert.strictEqual(plat.accessories.size, accessoriesBefore, 'both halves stay in HomeKit while the fixture is out of range');
assert.match(logs.join('\n'), /keeping its accessory/i, 'the log must say the accessory is being kept');
ok('a fixture that stops answering discovery keeps its accessory — never unregistered');
plat.shutdown();

// THE REUSE CONTRACT (the live defect). configureAccessory() is handed the accessory
// Homebridge restored from cache; minting a parallel platformAccessory for the same
// device produces the identical UUID, Homebridge logs "same UUID ... Skipping duplicate"
// and keeps the RESTORED object on the bridge — the one whose Lightbulb characteristics
// had no handlers bound. Home.app tiles were wired to dead characteristics. discover()
// must rebind the restored object and register nothing.
{
  const mkDevice = (ip, mac) => {
    const w = { tiles: [], power: [] };
    return {
      device: {
        ip, mac,
        deviceInfo: { label: 'Test Ceiling', features: { matrix: true }, productId: 176 },
        tileGetDeviceChain: async () => ({ tile_devices: [{ width: 8, height: 8 }] }),
        getLightState: async () => ({ power: 0, color: { hue: 0, saturation: 0, brightness: 0, kelvin: 3000 } }),
        lightGetPower: async () => ({ level: 0 }),
        turnOn: async () => { w.power.push('on'); },
        turnOff: async () => { w.power.push('off'); },
        tileSetTileState64: async () => {},
        _lifxLanUdp: { request: async (req) => { w.tiles.push(req); return { header: { type: 3 } }; } },
      }, w,
    };
  };
  // A restored accessory as Homebridge hands it over: cached UUID, cached context, and
  // an already-present Lightbulb service carrying the cached subtype.
  const restored = (half, name) => {
    const stableId = `192.168.1.50:${half}`;
    const acc = new FakeAccessory(name, stableId);
    acc.context = { stableId, half, mac: '192.168.1.50', hwMac: 'd05250aabbcc' };
    acc.addService('Lightbulb', name, stableId); // the service from the cache
    return acc;
  };

  // 1. everything restored: zero registers, both halves updated, handlers now live.
  {
    const { api, calls } = fakeHarness();
    const { log, lines } = recLog();
    const { device, w } = mkDevice('192.168.1.50', 'D0:52:50:AA:BB:CC');
    const plat = new LifxCeilingPlatform(log, {}, api);
    plat.lifx = { discover: async () => [device], destroy: () => {} };
    const up = restored('up', 'Test Ceiling Uplight'); const down = restored('down', 'Test Ceiling Downlight');
    plat.configureAccessory(up); plat.configureAccessory(down);
    assert.strictEqual(plat.restored.size, 2, 'configureAccessory must track restored accessories');
    await plat.discover();
    assert.deepStrictEqual(calls.register, [], 'restored accessories must NEVER be re-registered (duplicate UUID)');
    assert.strictEqual(calls.update.length, 1, 'exactly one updatePlatformAccessories call');
    assert.strictEqual(calls.update[0].count, 2, 'both reused halves in it');
    assert.ok(calls.update[0].accs.includes(up) && calls.update[0].accs.includes(down), 'update must carry the RESTORED objects');
    assert.strictEqual(plat.accessories.get('d05250aabbcc:up'), up, 'the registry keeps the restored object under the MAC, not a minted twin');
    assert.strictEqual(up.UUID, '192.168.1.50:up', 'the cached UUID is kept byte-for-byte');
    assert.strictEqual(up.svcs.size, 1, 'rebinding must reuse the cached Lightbulb service, never add a second');
    const svc = up.getServiceById('Lightbulb', '192.168.1.50:up');
    assert.ok(!svc.sets.some((s) => s[0] === 'Name'), 'a restored service keeps its name — without an explicit alias we never re-publish the label we invented, which is how a rename made in Home.app used to get stomped on every restart');
    const fx = plat.fixtures.get('d05250aabbcc');
    assert.strictEqual(fx.state.up.on, false, 'precondition: the fixture reads off');
    await svc.chars.get('On').handlers.onSet(true);
    assert.strictEqual(fx.state.up.on, true, 'the RESTORED onSet must write through to the live Fixture');
    await new Promise((r) => setTimeout(r, 220));
    assert.strictEqual(w.tiles.length, 1, 'the restored handler must produce a tile write');
    assert.strictEqual(w.tiles[0].type, 715, 'and it must be svc 715');
    assert.strictEqual(w.power[w.power.length - 1], 'on');
    assert.ok(lines.some((l) => /2 light\(s\) live \(0 new, 2 reused\)/.test(l)), `boot log must distinguish reused from minted: ${lines.join(' | ')}`);
    assert.ok(!lines.some((l) => /published 2 light\(s\)/.test(l)), 'the old re-minting log line must be gone');
    ok('restored accessories are rebound to the live Fixture and updated, never re-registered');
    plat.shutdown();
  }

  // 2. nothing restored: still mints and registers exactly 2 for one device.
  {
    const { api, calls } = fakeHarness();
    const { log, lines } = recLog();
    const { device } = mkDevice('192.168.1.50', 'D0:52:50:AA:BB:CC');
    const plat = new LifxCeilingPlatform(log, {}, api);
    plat.lifx = { discover: async () => [device], destroy: () => {} };
    await plat.discover();
    assert.deepStrictEqual(calls.register, [[PLUGIN_ID, PLATFORM_NAME, 2]], 'no cache must still mint+register two lights per ceiling');
    assert.strictEqual(calls.update.length, 0, 'nothing restored means nothing to update');
    assert.strictEqual(plat.restored.size, 0, 'a minted accessory is not a restored one');
    assert.ok(lines.some((l) => /2 light\(s\) live \(2 new, 0 reused\)/.test(l)), `mint log: ${lines.join(' | ')}`);
    ok('with an empty cache discover() still mints and registers exactly two lights per ceiling');
    plat.shutdown();
  }

  // 3. mixed: up restored, down minted -> exactly one registered, one updated.
  {
    const { api, calls } = fakeHarness();
    const { log, lines } = recLog();
    const { device } = mkDevice('192.168.1.50', 'D0:52:50:AA:BB:CC');
    const plat = new LifxCeilingPlatform(log, {}, api);
    plat.lifx = { discover: async () => [device], destroy: () => {} };
    const up = restored('up', 'Test Ceiling Uplight');
    plat.configureAccessory(up);
    await plat.discover();
    assert.strictEqual(calls.register.length, 1, 'mixed cycle registers exactly once');
    assert.strictEqual(calls.register[0][2], 1, 'only the missing half is registered');
    assert.strictEqual(calls.update.length, 1, 'only the restored half is updated');
    assert.strictEqual(calls.update[0].count, 1);
    assert.strictEqual(calls.update[0].accs[0], up);
    assert.strictEqual(plat.accessories.get('d05250aabbcc:up'), up, 'the restored half keeps its own object');
    const down = plat.accessories.get('d05250aabbcc:down');
    assert.ok(down && down !== up, 'the other half is minted');
    assert.ok(!plat.restored.has(down));
    assert.strictEqual(down.context.hwMac, 'd05250aabbcc');
    assert.ok(lines.some((l) => /2 light\(s\) live \(1 new, 1 reused\)/.test(l)), `mixed log: ${lines.join(' | ')}`);
    ok('mixed cache: the missing half is registered, the restored half is updated');
    plat.shutdown();
  }

  // 4. a cache entry that predates the ip:half stableId is still matched on mac+half,
  // so an existing pairing is never orphaned by a stableId format change.
  {
    const { api, calls } = fakeHarness();
    const { log, lines } = recLog();
    const { device, w } = mkDevice('192.168.1.50', 'D0:52:50:AA:BB:CC');
    const plat = new LifxCeilingPlatform(log, {}, api);
    plat.lifx = { discover: async () => [device], destroy: () => {} };
    const old = new FakeAccessory('Test Ceiling Uplight', 'legacy-uuid-not-a-stableid');
    old.context = { mac: '192.168.1.50', half: 'up' }; // predates stableId
    plat.configureAccessory(old);
    assert.ok(!lines.some((l) => /legacy shape/i.test(l)), 'mac+half is NOT the legacy two-services shape');
    assert.strictEqual(plat.findAccessory('some-other-key:up', '192.168.1.50', 'up'), old, 'the restored mac+half scan finds it');
    await plat.discover();
    assert.strictEqual(calls.register.length, 1, 'only the half with no cached accessory is minted');
    assert.strictEqual(calls.register[0][2], 1, 'the reused up half must not be in the register call');
    assert.strictEqual(calls.update.length, 1); assert.strictEqual(calls.update[0].accs[0], old);
    assert.notStrictEqual(plat.accessories.get('d05250aabbcc:down'), old);
    assert.strictEqual(old.UUID, 'legacy-uuid-not-a-stableid', 'its UUID is untouched');
    assert.strictEqual(plat.accessories.get('d05250aabbcc:up'), old, 'it is re-keyed onto mac:half');
    assert.strictEqual(old.context.hwMac, 'd05250aabbcc', 'the missing hwMac is backfilled');
    // The subtype this accessory carries — cached if it had one, minted from the identity
    // if it did not. context.subtype is now recorded so the answer is never guessed again.
    assert.ok(old.context.subtype, 'the service subtype is recorded in context');
    const svc = old.getServiceById('Lightbulb', old.context.subtype);
    assert.ok(svc, 'a Lightbulb service exists under the recorded subtype');
    await svc.chars.get('On').handlers.onSet(true);
    assert.strictEqual(plat.fixtures.get('d05250aabbcc').state.up.on, true);
    await new Promise((r) => setTimeout(r, 220));
    assert.strictEqual(w.tiles.length, 1, 'the reused pre-stableId accessory is live, not dead');
    ok('a pre-stableId cache entry is matched on mac+half, keeps its UUID and gets live handlers');
    plat.shutdown();
  }
}

// Fixture: both halves compose into ONE write, and power follows "either on"
const { Fixture } = require('../lib/fixture');
const writes = [];
const tileReqs = [];
const powerCalls = [];
const fxDevice = {
  ip: '192.168.1.50',
  deviceInfo: { mac: 'aa:bb:cc:dd:ee:ff' },
  // Hardware-verified path: tile frames must go out raw with ack_required:true.
  _lifxLanUdp: {
    request: async (req) => {
      tileReqs.push(req);
      writes.push(req.payload.colors);
      return { header: { type: 3 } };
    },
  },
  tileSetTileState64: async (p) => { writes.push(p.colors); },
  turnOn: async () => { powerCalls.push('on'); },
  turnOff: async () => { powerCalls.push('off'); },
  getLightState: async () => ({ power: 0, color: { hue: 0, saturation: 0, brightness: 0, kelvin: 3000 } }),
  lightGetPower: async () => ({ level: 0 }),
};
const fx = new Fixture({ device: fxDevice, log: () => {} });
fx.set('up', { on: true, brightness: 1, hue: 0, saturation: 100 });
fx.set('down', { on: false });
await new Promise((r) => setTimeout(r, 200));
assert.strictEqual(writes.length, 1, `both halves must compose into one write, got ${writes.length}`);
ok('two halves produce exactly one matrix write');
assert.strictEqual(powerCalls[powerCalls.length - 1], 'on');
ok('fixture powers on when either half is on');
const frame = writes[0];
assert.strictEqual(frame.length, 64);
const upLit = frame.filter((c) => c.saturation > 0.5 && c.brightness > 0.5).length;
const downLit = frame.filter((c) => c.brightness > 0.01).length - upLit;
assert.ok(upLit > 0 && downLit === 0, `downlit half should be dark; upLit=${upLit} downLit=${downLit}`);
ok('only the addressed half is lit in the composed frame');

// REGRESSION GUARD (hardware): an un-acked tile write can silently vanish on these
// pid 176 ceilings — tileSetTileState64() hardcodes ack_required:false, so flush()
// must use the raw ack-required request instead.
assert.strictEqual(tileReqs.length, 1, `exactly one raw tile request per flush, got ${tileReqs.length}`);
ok('one composed frame = exactly one raw tile request');
const req = tileReqs[0];
assert.strictEqual(req.type, 715, `tile write must be svc 715, got ${req.type}`);
assert.strictEqual(req.ack_required, true, 'tile write MUST be ack_required — un-acked writes vanish on pid 176');
assert.strictEqual(req.res_required, false, `res_required should be false, got ${req.res_required}`);
assert.strictEqual(req.payload.colors.length, 64, 'tile write must carry the full 64-pixel frame');
ok('tile write goes out ack-required as svc 715 with all 64 colours');
assert.strictEqual(req.target, 'aa:bb:cc:dd:ee:ff', `target should be the MAC, got ${req.target}`);
assert.strictEqual(req.address, '192.168.1.50');
ok('tile request targets the fixture MAC and address');

// HARDWARE SHAPE: discovered devices carry `mac` UPPERCASE colon-separated and NO
// deviceInfo.mac — this is the shape that made a MAC-keyed lookup and the UUID dead.
const macOnlyDevice = Object.assign({}, fxDevice, { mac: 'AA:BB:CC:DD:EE:FF' });
delete macOnlyDevice.deviceInfo;
const macOnly = new Fixture({ device: macOnlyDevice, log: () => {} });
assert.strictEqual(macOnly.mac, 'aabbccddeeff', `fixture.mac must be the canonical hardware MAC, got ${macOnly.mac}`);
assert.strictEqual(macOnly.mac, matrix.normalizeMac('AA:BB:CC:DD:EE:FF'));
assert.notStrictEqual(macOnly.mac, macOnly.ip, 'the identity key must never silently become an IP');
assert.strictEqual(macOnly._targetMac(), 'AA:BB:CC:DD:EE:FF', 'the V2 target must stay the uppercase wire form, verbatim');
ok('the canonical MAC is the identity key while the wire target stays uppercase');

fx.set('up', { on: false });
await new Promise((r) => setTimeout(r, 200));
assert.strictEqual(powerCalls[powerCalls.length - 1], 'off');
ok('fixture powers off only when both halves are off');
assert.strictEqual(writes.length, 2, `a follow-up flush writes again, got ${writes.length}`);
assert.strictEqual(tileReqs.length, 2, `and sends exactly one tile request, got ${tileReqs.length}`);
ok('follow-up flush sends exactly one more composed tile request');

// svc 223 == Rejection: flush() must reject, not report a silent success
{
  const rejDevice = Object.assign({}, fxDevice, {
    _lifxLanUdp: { request: async () => ({ header: { type: 223 } }) },
  });
  const rej = new Fixture({ device: rejDevice, log: () => {} });
  await assert.rejects(() => rej.flush(), /rejected.*service 223/);
  ok('a svc 223 rejection makes flush() reject');
  rej.destroy();
}
fx.destroy();

// Kelvin range is a real config knob, not decoration: it clamps the frame AND the
// HomeKit mired limits, so Home.app cannot offer a white the panel cannot produce.
{
  const fxK = new Fixture({
    device: fxDevice, log: () => {}, kelvinMin: 2000, kelvinMax: 6500,
  });
  fxK.state.down = { on: true, hue: 0, saturation: 0, brightness: 1, kelvin: 9000 };
  assert.strictEqual(fxK._deviceColor('down').kelvin, 6500, 'kelvinMax must clamp the frame');
  ok('kelvinMax clamps the commanded frame');
  fxK.state.down.kelvin = 1000;
  assert.strictEqual(fxK._deviceColor('down').kelvin, 2000, 'kelvinMin must clamp the frame');
  ok('kelvinMin clamps the commanded frame');
  const def = new Fixture({ device: fxDevice, log: () => {} });
  assert.strictEqual(def.kelvinMin, 1500); assert.strictEqual(def.kelvinMax, 9000);
  ok('kelvin range defaults to the panel span when unset');
  const swapped = new Fixture({ device: fxDevice, log: () => {}, kelvinMin: 6500, kelvinMax: 2000 });
  assert.ok(swapped.kelvinMin < swapped.kelvinMax, 'inverted min/max must be swapped, never produce an empty range');
  ok('an inverted kelvin range is repaired, not propagated');
  fxK.destroy(); def.destroy(); swapped.destroy();
}

// Nothing in the settings UI may advertise a key the code ignores.
{
  const s = require('../config.schema.json').schema;
  const props = s.properties;
  assert.ok(!('manualDevices' in props), 'manualDevices is not implemented — it must not appear in the settings UI');
  assert.ok(!/reserved|not read/i.test(JSON.stringify(props.kelvinMin)), 'kelvinMin is read now; the schema must not call it reserved');
  assert.ok(!/reserved|not read/i.test(JSON.stringify(props.kelvinMax)), 'kelvinMax is read now; the schema must not call it reserved');
  ok('the settings schema advertises only keys the code actually reads');
  const readme = require('fs').readFileSync(require('path').join(__dirname, '..', 'README.md'), 'utf8');
  assert.ok(!readme.includes('manualDevices'), 'README must not document a key the schema no longer has');
  ok('README does not document removed keys');
}

// No shipped file may name this author's house.
{
  const fs2 = require('fs');
  const root = require('path').join(__dirname, '..');
  // Scans everything that ships, including test/ — this file used to hold the real
  // fixture labels it now forbids, so the guard has to cover its own source.
  // Assembled from fragments at runtime so this file does not trip its own guard: a
  // privacy check whose patterns are literal text is a check that cannot scan itself.
  const leak = new RegExp([
    '192' + '\\.' + '168' + '\\.0' + '\\.',
    'd0' + ':73' + ':d5',
    'd0' + '73d5',
    'South' + 'west', 'North' + 'west', 'North' + 'east', 'South' + 'east',
    'rtsp' + ':',
    '/home' + '/homebridge',
    'pi' + 'sh',
  ].join('|'), 'i');
  // Case-sensitive: the camera framing label, not the English word for winning.
  const caps = new RegExp('W' + 'INS');
  const dirs = ['lib', 'bin', 'test', '.github'];
  const hits = [];
  assert.ok(!fs2.existsSync(root + '/config'), 'the package must ship no config/ directory — the geometry is compiled in');
  // The development harness does not ship: RTSP capture scripts and the Python image
  // measurement tools were how *we* looked at a ceiling while reverse-engineering it.
  // An end user verifies by looking at the fixture, and a stranger has no camera
  // mounted on their ceiling. They live in the estate repo's tools/lifx-lab/.
  for (const gone of ['bin/shot.sh', 'bin/sweep-seam.sh', 'tools']) {
    assert.ok(!fs2.existsSync(root + '/' + gone), `${gone} is development scaffolding and must not be published`);
  }
  for (const d of dirs) {
    if (!fs2.existsSync(root + '/' + d)) continue;
    for (const f of fs2.readdirSync(root + '/' + d)) {
      const p = root + '/' + d + '/' + f;
      if (!fs2.statSync(p).isFile()) continue;
      const txt = fs2.readFileSync(p, 'utf8');
      if (leak.test(txt) || caps.test(txt)) hits.push(d + '/' + f);
    }
  }
  for (const f of ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'config.schema.json']) {
    const txt = fs2.existsSync(root + '/' + f) ? fs2.readFileSync(root + '/' + f, 'utf8') : '';
    if (leak.test(txt) || caps.test(txt)) hits.push(f);
  }
  assert.deepStrictEqual(hits, [], `published files must not name one person's installation: ${hits.join(', ')}`);
  ok('no shipped file leaks a site-specific address, MAC or room name');
}


// THE GEOMETRY IS NOT CONFIGURABLE (the change): earlier versions of this package shipped
// a region-mapping module, a schema key that pointed at a file of them, and names an old
// config.json could still carry. All of it is gone, so the guard is structural: the platform
// holds no mapping object at all, ignores keys it does not read, and logs the compiled-in
// corners on every boot. Patterns are assembled from fragments so this file does not match
// its own scan.
{
  const path = require('path');
  const cfg = {};
  cfg[['uplight', 'Region'].join('')] = 'rin' + 'g';
  cfg[['downlight', 'Region'].join('')] = 'cor' + 'e';
  const ghost = path.join(os.tmpdir(), 'lifx-no-such-file.json');
  cfg[['mapping', 'File'].join('')] = ghost;
  const { log, lines } = recLog();
  const platform = new LifxCeilingPlatform(log, cfg, fakeApi);
  assert.ok(!('mapping' in platform), 'the platform holds no mapping object — there is nothing to override');
  assert.deepStrictEqual(matrix.CEILING_UPLIGHT_CELLS, CORNERS, 'a leftover knob must not move the geometry');
  assert.deepStrictEqual(matrix.ceilingsDownlightCells(8, 8), matrix.complement(CORNERS, 8, 8), 'nor may it move the other half');
  assert.ok(!lines.some((l) => /applied/i.test(l)), 'nothing may be applied from a key the code does not read');
  assert.match(lines.join('\n'), /uplight=4 corner cells \[0,7,56,63\]/, 'startup logs the geometry in force');
  assert.ok(!fs.existsSync(ghost), 'a config value pointing at a file must not make the plugin create or read it');
  platform.shutdown();

  const rm = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(rm, /not configurable/i, 'README must say the geometry is not configurable');
  assert.match(rm, /unsupported/i, 'README must say other matrix products are unsupported');
  assert.match(rm, /^geometry: uplight=4 corner cells \[0,7,56,63\]/m, 'README must show the startup line');
  ok('leftover knobs are inert, the corner model is the only geometry, README matches');
}


// NO TILE WRITE MAY BE SILENT: on pid 176/177 an un-acked TileSetTileState64 can
// vanish with no error and no visible change, so every shipped file that writes tiles
// must have an ack-required path (svc 715, ack_required:true) and treat svc 223 as a
// failure. The library call is allowed only as a labelled fallback beside one.
{
  const fs3 = require('fs');
  const path3 = require('path');
  const root3 = path3.join(__dirname, '..');
  const offenders = [];
  for (const dir of ['lib', 'bin']) {
    for (const f of fs3.readdirSync(path3.join(root3, dir))) {
      if (!f.endsWith('.js')) continue;
      const src = fs3.readFileSync(path3.join(root3, dir, f), 'utf8');
      if (!/tileSetTileState64\(/.test(src)) continue;
      // Either it sends ack-required itself, or it delegates to lib/tilewrite.js.
      const acked = /ack_required:\s*true/.test(src) || /TILE_SET_STATE_64/.test(src) || /writeTileAcked/.test(src);
      // If it still calls the library directly, that call must be a labelled fallback.
      const direct = /\b\w+\.tileSetTileState64\(/.test(src);
      const labelled = !direct || /un-acked|unverified|may silently vanish|fallback/i.test(src);
      if (!acked || !labelled) offenders.push(`${dir}/${f}${direct && !labelled ? ' (unlabelled direct library write)' : ''}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `these files write tiles without an ack-required path: ${offenders.join(', ')}`);
  assert.ok(/writeTileAcked/.test(fs3.readFileSync(path3.join(root3, 'bin', 'doctor.js'), 'utf8')), 'bin/doctor.js must go through lib/tilewrite.js');
  assert.ok(/ack_required:\s*true/.test(fs3.readFileSync(path3.join(root3, 'lib', 'tilewrite.js'), 'utf8')), 'lib/tilewrite.js must send ack_required:true');
  assert.ok(/service 223|REJECTION/.test(fs3.readFileSync(path3.join(root3, 'lib', 'tilewrite.js'), 'utf8')), 'lib/tilewrite.js must treat svc 223 as a failure');
  ok('every shipped tile write is ack-required, with 223 handled as failure');
}

// NAMES. A tile's name comes from the fixture's own LIFX label unless the site supplies
// an `aliases` entry for its MAC — then that short name wins, because it is explicit
// intent written by the user. Keys are matched on the normalised MAC, so the uppercase
// colon form discovery hands back hits just as well as a colon-less paste. And a name
// Home.app already has is never overwritten unless the user asked for that name here.
{
  const mkDevice = (mac, label) => ({
    ip: '192.168.1.60', mac,
    deviceInfo: { label, features: { matrix: true }, productId: 176 },
    tileGetDeviceChain: async () => ({ tile_devices: [{ width: 8, height: 8 }] }),
    getLightState: async () => ({ power: 0, color: { hue: 0, saturation: 0, brightness: 0, kelvin: 3000 } }),
    lightGetPower: async () => ({ level: 0 }),
    turnOn: async () => {}, turnOff: async () => {}, tileSetTileState64: async () => {},
    _lifxLanUdp: { request: async () => ({ header: { type: 3 } }) },
  });

  const { api: aApi } = fakeHarness();
  const { log: aLog, lines: aLines } = recLog();
  const named = new LifxCeilingPlatform(aLog, {
    aliases: { 'aa:bb:cc:dd:ee:ff': 'SW', 'not-a-mac': 'JUNK', '11:22:33:44:55:66': '' },
  }, aApi);
  assert.deepStrictEqual([...named.aliases.keys()], ['aabbccddeeff'], 'aliases keep only valid normalised MAC keys');
  assert.match(aLines.join('\n'), /aliases\["not-a-mac"\] — not a MAC/, 'a junk alias key is refused by name, not silently dropped');
  assert.match(aLines.join('\n'), /11:22:33:44:55:66.{0,40}empty/i, 'an empty alias name is refused by name');

  assert.strictEqual(named._baseName(mkDevice('AA:BB:CC:DD:EE:FF', 'LIFX Ceiling')), 'SW', 'the alias outranks the LIFX label');
  assert.strictEqual(named._baseName(mkDevice('aabbccddeeff', 'LIFX Ceiling')), 'SW', 'a colon-less MAC hits the same alias');
  assert.strictEqual(named._baseName(mkDevice('99:88:77:66:55:44', 'LIFX Ceiling B')), 'LIFX Ceiling B', 'no alias falls back to the fixture label');

  const plain = new LifxCeilingPlatform(recLog().log, {}, aApi);
  assert.strictEqual(plain.aliases.size, 0, 'no aliases configured is the default');
  assert.strictEqual(plain._baseName(mkDevice('aa:bb:cc:dd:ee:ff', 'LIFX Ceiling')), 'LIFX Ceiling', 'unconfigured: the published plugin names from the fixture label');

  // A brand-new accessory takes our name once; a restored one keeps whatever Home.app has.
  const fresh = new FakeAccessory('x', 'uuid-fresh');
  plain.configureService(fresh, 'up', { state: { up: { on: false, brightness: 0, hue: 0, saturation: 0, kelvin: 3000 } }, set: async () => {}, bind: () => {}, kelvinMin: 1500, kelvinMax: 9000 }, 'LIFX Ceiling SW Uplight', '192.168.1.60', false);
  const freshSvc = fresh.getServiceById('Lightbulb', '192.168.1.60:up');
  assert.ok(freshSvc.sets.some((x) => x[0] === 'Name'), 'a service created here must publish its name');

  const kept = new FakeAccessory('y', 'uuid-kept');
  kept.addService('Lightbulb', 'Renamed In Home.app', '192.168.1.60:up');
  plain.configureService(kept, 'up', { state: { up: { on: false, brightness: 0, hue: 0, saturation: 0, kelvin: 3000 } }, set: async () => {}, bind: () => {}, kelvinMin: 1500, kelvinMax: 9000 }, 'LIFX Ceiling SW Uplight', '192.168.1.60', false);
  assert.ok(!kept.getServiceById('Lightbulb', '192.168.1.60:up').sets.some((x) => x[0] === 'Name'), 'an existing service is not renamed behind the user’s back');

  const aliased = new LifxCeilingPlatform(recLog().log, { aliases: { 'aa:bb:cc:dd:ee:33': 'SW' } }, aApi);
  aliased.configureService(kept, 'up', { state: { up: { on: false, brightness: 0, hue: 0, saturation: 0, kelvin: 3000 } }, set: async () => {}, bind: () => {}, kelvinMin: 1500, kelvinMax: 9000 }, 'SW Uplight', '192.168.1.60', true);
  assert.deepStrictEqual(kept.getServiceById('Lightbulb', '192.168.1.60:up').sets.find((x) => x[0] === 'Name'), ['Name', 'SW Uplight'], 'an explicit alias is republished, because the user asked for that name');

  const schema = require('../config.schema.json');
  assert.ok('aliases' in schema.schema.properties, 'config.schema.json must expose aliases');
  assert.strictEqual(schema.schema.properties.aliases.additionalProperties.type, 'string', 'alias values are names');
  ok('names: LIFX label by default, site aliases by normalised MAC, Home.app renames left alone');
}

// The tile label Home.app renders comes from the ACCESSORY, so a reused accessory keeps
// its cached name no matter what the service says. An explicit alias must therefore
// rename the accessory too; without an alias the cached name is left exactly as Home.app
// last had it.
{
  const dev = {
    ip: '192.168.1.61', mac: 'AA:BB:CC:DD:EE:FF',
    deviceInfo: { label: 'LIFX Ceiling', features: { matrix: true }, productId: 176 },
    tileGetDeviceChain: async () => ({ tile_devices: [{ width: 8, height: 8 }] }),
    getLightState: async () => ({ power: 0, color: { hue: 0, saturation: 0, brightness: 0, kelvin: 3000 } }),
    lightGetPower: async () => ({ level: 0 }),
    turnOn: async () => {}, turnOff: async () => {}, tileSetTileState64: async () => {},
    _lifxLanUdp: { request: async () => ({ header: { type: 3 } }) },
  };
  const boot = (config) => {
    const { api } = fakeHarness();
    const { log, lines } = recLog();
    const plat = new LifxCeilingPlatform(log, config, api);
    plat.lifx = { discover: async () => [dev], destroy: () => {} };
    const accs = ['up', 'down'].map((half) => {
      const a = new FakeAccessory(`LIFX Ceiling ${half === 'up' ? 'Uplight' : 'Downlight'}`, `192.168.1.61:${half}`);
      a.context = { stableId: `192.168.1.61:${half}`, half, mac: '192.168.1.61' };
      plat.configureAccessory(a);
      return a;
    });
    return { plat, accs, lines };
  };

  const kept = boot({});
  await kept.plat.discover();
  assert.strictEqual(kept.accs[0].displayName, 'LIFX Ceiling Uplight', 'no alias: the cached accessory name is untouched');

  const renamed = boot({ aliases: { 'aa:bb:cc:dd:ee:ff': 'SW' } });
  await renamed.plat.discover();
  assert.strictEqual(renamed.accs[0].displayName, 'SW Uplight', 'an alias renames the accessory itself, which is what Home.app labels the tile with');
  assert.strictEqual(renamed.accs[1].displayName, 'SW Downlight', 'both halves follow the alias');
  assert.match(renamed.lines.join('\n'), /renaming "LIFX Ceiling Uplight" -> "SW Uplight"/, 'the rename is logged, old and new name');
  renamed.plat.shutdown();
  kept.plat.shutdown();
  ok('aliases rename the accessory, not just the service; without one the cached name stands');
}

// PUBLISH SURFACE: the claims in the docs must match the code, or the README becomes the
// next person's wrong assumption. Reservations were removed as a requirement in 1.1.0 —
// the code must not still demand them, and the docs must not either.
{
  const fs5 = require('fs');
  const path5 = require('path');
  const root5 = path5.join(__dirname, '..');
  const readme = fs5.readFileSync(path5.join(root5, 'README.md'), 'utf8');
  assert.match(readme, /no DHCP reservations required/i, 'README must say reservations are no longer required');
  assert.ok(!/bind every ceiling to a fixed address|required for every fixture/i.test(readme), 'README must not still demand DHCP reservations');
  assert.match(readme, /npm run doctor/, 'README must document doctor');
  assert.match(readme, /Verified on/i, 'README must state what it was verified on');
  const schema5 = require('../config.schema.json');
  assert.match(schema5.headerDisplay, /no longer required/i, 'the settings screen must not demand reservations');
  assert.match(schema5.headerDisplay, /hardware MAC/i, 'the settings screen must say identity is the MAC');
  assert.ok(fs5.existsSync(path5.join(root5, 'bin', 'doctor.js')), 'bin/doctor.js must exist');
  assert.ok(fs5.existsSync(path5.join(root5, 'CHANGELOG.md')), 'CHANGELOG.md must ship');
  assert.ok(fs5.existsSync(path5.join(root5, 'SECURITY.md')), 'SECURITY.md must ship');
  assert.ok(fs5.existsSync(path5.join(root5, '.github', 'workflows', 'ci.yml')), 'CI must exist');
  const pkg5 = require('../package.json');
  assert.ok(pkg5.files.includes('CHANGELOG.md'), 'CHANGELOG.md must be in the published files');
  assert.strictEqual(pkg5.author, 'N Wagner', 'author must be set — npm and the plugin browser show it');
  assert.ok(!/un-acked|_lifxLanUdp/.test(''), 'sanity');
  assert.match(fs5.readFileSync(path5.join(root5, 'bin', 'doctor.js'), 'utf8'), /_lifxLanUdp/, 'doctor must check the private API');
  ok('publish surface: docs, schema and package metadata match what the code does');
}


// NO SCAFFOLDING CREeps BACK: the lab tools, the removed module, the radial API, the
// extra schema keys and the vocabulary that described them are all out of the published
// package. This guard is what keeps them out.
{
  const fs6 = require('fs');
  const path6 = require('path');
  const root6 = path6.join(__dirname, '..');

  // 1. bin/ is exactly doctor.js — one diagnostic, nothing else.
  assert.deepStrictEqual(fs6.readdirSync(path6.join(root6, 'bin')), ['doctor.js'], 'bin/ must contain exactly doctor.js');
  ok('bin/ contains exactly doctor.js');

  // 2. no mapping module, and nothing requires one.
  assert.ok(!fs6.existsSync(path6.join(root6, 'lib', 'mapping.js')), 'lib/mapping.js must not exist');
  const modName = ['map', 'ping'].join('');
  const reqPat = new RegExp('require\\([^)]*' + modName);
  const requiring = [];
  for (const d of ['lib', 'bin']) {
    for (const f of fs6.readdirSync(path6.join(root6, d))) {
      if (!f.endsWith('.js')) continue;
      if (reqPat.test(fs6.readFileSync(path6.join(root6, d, f), 'utf8'))) requiring.push(d + '/' + f);
    }
  }
  if (reqPat.test(fs6.readFileSync(path6.join(root6, 'index.js'), 'utf8'))) requiring.push('index.js');
  assert.deepStrictEqual(requiring, [], `these files still require the removed module: ${requiring.join(', ')}`);
  ok('no shipped .js requires the removed module');

  // 3. the radial API is gone from lib/matrix.js, not merely unused.
  for (const gone of ['resolveRegion', 'ring' + 'Indices', 'core' + 'Indices', 'ann' + 'ulusIndices']) {
    assert.strictEqual(matrix[gone], undefined, `matrix.${gone} must not be exported`);
  }
  ok('matrix exports no radial API');

  // 4. the schema is exactly the five keys.
  assert.deepStrictEqual(Object.keys(require('../config.schema.json').schema.properties).sort(),
    ['aliases', 'discoveryInterval', 'kelvinMax', 'kelvinMin', 'name'], 'exactly five config keys, no more');
  ok('config.schema.json schema properties are exactly the five advertised keys');

  // 5. symmetry: every key the code reads is advertised, and every advertised key is read.
  // `name` is the one exception by design — Homebridge reads it to select the platform
  // config block, our code never does, and every Homebridge plugin advertises it.
  const readKeys = new Set();
  // Strip comments first — the prose in these files talks about "config.json" constantly,
  // and a doc mention is not a read of the config object.
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const KEY = /\bconfig\.([A-Za-z_]\w*)\b/g;
  for (const f of ['lib/platform.js', 'lib/fixture.js', 'index.js']) {
    const txt = strip(fs6.readFileSync(path6.join(root6, f), 'utf8'));
    for (const mo of txt.matchAll(KEY)) if (mo[1] !== 'json') readKeys.add(mo[1]);
    for (const mo of txt.matchAll(/const\s*\{([^}]*)\}\s*=\s*(?:this\.)?config\b/g)) {
      for (const nm of mo[1].split(',')) readKeys.add(nm.trim().split(':')[0].trim());
    }
  }
  const HOMEKIT_OWNS = new Set(['name']);
  const advertised = new Set(Object.keys(require('../config.schema.json').schema.properties));
  assert.deepStrictEqual([...readKeys].filter((k) => !advertised.has(k)), [], 'the code reads a key the settings UI does not advertise');
  assert.deepStrictEqual([...advertised].filter((k) => !readKeys.has(k) && !HOMEKIT_OWNS.has(k)), [], 'the settings UI advertises a key the code never reads');
  assert.deepStrictEqual([...readKeys].sort(), ['aliases', 'discoveryInterval', 'kelvinMax', 'kelvinMin'], 'the readable set is the four behavioural knobs');
  ok('every config key read by the code is advertised in the schema, and vice versa');

  // 6. the vocabulary of the removed feature appears nowhere in the package.
  // Assembled from fragments so this file does not match its own patterns.
  const banned = [
    ['ann', 'ulus'].join(''),
    ['disc', '@'].join(''),
    ['mapping', 'File'].join(''),
    ['cal', 'ibrate'].join(''),
    ['per', 'Device'].join(''),
    ['uplight', 'Region'].join(''),
  ];
  const vocabHits = [];
  const scanFile = (p, label) => {
    const txt = fs6.readFileSync(p, 'utf8');
    for (const b of banned) if (txt.includes(b)) vocabHits.push(`${label} names ${b}`);
  };
  for (const d of ['lib', 'bin', 'test']) {
    for (const f of fs6.readdirSync(path6.join(root6, d))) {
      if (fs6.statSync(path6.join(root6, d, f)).isFile()) scanFile(path6.join(root6, d, f), d + '/' + f);
    }
  }
  for (const f of ['index.js', 'config.schema.json', 'README.md']) scanFile(path6.join(root6, f), f);
  assert.deepStrictEqual(vocabHits, [], `the removed feature still speaks its name: ${vocabHits.join('; ')}`);
  ok('no shipped file names the removed geometry scaffolding');
}


// The diagnostic must not be able to light the room. Regression guard for the deploy where
// doctor.js fabricated 64 cells from one GetLightState colour and pushed them flat at full
// brightness, turning every ceiling on while Home.app showed nothing happening.
{
  const doc = fs.readFileSync(require('path').join(__dirname, '..', 'bin/doctor.js'), 'utf8');
  assert.ok(!/new\s+Array\s*\(\s*64\s*\)\s*\.fill/.test(doc), 'doctor.js fabricates a flat 64-cell fill — that destroys the uplight/downlight split');
  assert.ok(!/brightness\s*==\s*null\s*\?\s*1/.test(doc), 'doctor.js invents full brightness when the read returns none');
  assert.ok(!/setPower|service:\s*21\b|power:\s*(true|1)\b/i.test(doc), 'doctor.js must never touch power');
  assert.ok(/process\.argv\.includes\('--write'\)/.test(doc), 'doctor.js writes must be opt-in via --write');
  assert.ok(/if \(!WRITE\)/.test(doc), 'a read-only run must report the write path as untested, not pass it');
  assert.ok(/readTileAcked\(/.test(doc), 'doctor.js must read the real tile buffer before writing it back');
  ok('doctor.js cannot light the room: read-only by default, no fabricated cells, no power writes');
}

// The tile buffer read exists, is acked, and is the documented service 710.
{
  const tw = require('../lib/tilewrite');
  assert.strictEqual(typeof tw.readTileAcked, 'function', 'lib/tilewrite.js must export readTileAcked');
  assert.strictEqual(tw.TILE_GET_STATE_64, 710, 'tile read is AT 710 Tile::GetTileState64');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'lib/tilewrite.js'), 'utf8');
  assert.match(src, /type:\s*TILE_GET_STATE_64,\s*ack_required:\s*true/, 'the tile read must require an ack');
  assert.match(src, /res_required:\s*true/, 'a read needs res_required, or the fixture answers with nothing');
  ok('tile buffer read is svc 710, ack-required, and returns cells');
}

console.log(`\n${n} assertions passed.`);

  /*
   * Exit explicitly. The LIFX library binds a UDP socket at require time and platform
   * instances hold timers; those handles outlive every assertion, so the process sits
   * there alive after printing success — indistinguishable from a hung run from outside.
   */
  process.exit(0);
}
main().catch((e) => { console.error('FAIL:', e.message); console.error(e.stack.split('\n').slice(1,4).join('\n')); process.exit(1); });
