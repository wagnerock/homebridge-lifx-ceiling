'use strict';
/**
 * Discovers LIFX matrix Ceilings on the LAN and publishes, per fixture, TWO
 * HomeKit accessories: "<Label> Uplight" and "<Label> Downlight".
 *
 * Why two accessories and not two services on one accessory: Home.app labels a
 * tile from the accessory, not from each service, so two Lightbulb services on one
 * accessory render as anonymous, indistinguishable tiles. One accessory per light
 * is what makes the names show up. Both accessories share one Fixture so their
 * writes compose into a single 64-pixel frame.
 */

const { Fixture, HALVES } = require('./fixture');
const { normalizeMac, CEILING_UPLIGHT_CELLS, ceilingsDownlightCells } = require('./matrix');

/** vendor 1 pid 176 = LIFX Ceiling US, 177 = Intl. Matrix (tile) protocol. */
const CEILING_PIDS = new Set([176, 177]);
const PLUGIN_ID = 'homebridge-lifx-ceiling';
const PLATFORM_NAME = 'LifxCeiling';

/** `4 corner cells [0,7,56,63]` — the only geometry this plugin drives. */
function describeCells(cells, showList = true) {
  const corners = cells.length === CEILING_UPLIGHT_CELLS.length && CEILING_UPLIGHT_CELLS.every((i) => cells.includes(i));
  if (!showList) return `${cells.length} cells`;
  return `${cells.length} ${corners ? 'corner ' : ''}cells [${cells.slice(0, 8).join(',')}${cells.length > 8 ? ',…' : ''}]`;
}

/**
 * Capability-based detection. NEVER match on the user's label — labels are free
 * text and a label like "Ceiling" on a Mini White bulb has produced dead HomeKit
 * services that could never respond.
 */
const isCeiling = (device) => {
  const info = (device && device.deviceInfo) || {};
  const feats = info.features || {};
  if (typeof feats.matrix === 'boolean') return feats.matrix;
  const pid = info.productId !== undefined ? info.productId
    : (info.pid !== undefined ? info.pid : info.product_id);
  return typeof pid === 'number' && CEILING_PIDS.has(pid);
};

/** A fixture is only usable if its chain answers with a real populated tile. */
const hasMatrix = async (device, log) => {
  try {
    const ch = await device.tileGetDeviceChain({});
    const real = ((ch && ch.tile_devices) || []).filter((t) => t && t.width > 0);
    if (!real.length) {
      log(`[${device.ip}] skipping — chain answered but no populated tile`);
      return false;
    }
    return true;
  } catch (e) {
    log(`[${device.ip}] skipping — tileGetDeviceChain failed: ${e.message}`);
    return false;
  }
};

class LifxCeilingPlatform {
  constructor(log, config, api) {
    if (!api) throw new Error('homebridge-lifx-ceiling requires the Homebridge api');
    this.log = typeof log === 'function' ? log : (m) => console.log(m);
    this.log.error = typeof log === 'function' ? log : (m) => console.error(m);
    this.config = config || {};
    this.api = api;
    this.aliases = this._readAliases(this.config.aliases);
    // The uplight/downlight split is a constant compiled into lib/matrix.js — there is no
    // knob, no file and no per-fixture override that can move it. See CEILING_UPLIGHT_CELLS.
    this._logGeometryInForce();
    this.lifx = null;
    this.fixtures = new Map(); // identity (fixture ip) -> Fixture
    this.accessories = new Map(); // `${identity}:${half}` -> accessory
    /*
     * Everything Homebridge handed back through configureAccessory() — the objects
     * that are ALREADY on the bridge. Kept separate from `accessories` so discovery
     * can tell a restored accessory (reuse it, never re-mint) from one this process
     * published itself.
     */
    this.restored = new Set();
    this._orphans = [];
    this._misses = new Map();
    this._driftWarned = new Set(); // `${hwMac}->${currentIp}` already shouted about
    this._timer = null;
    this._stopping = false;
    this._booted = false;

    // Homebridge always hands over api.on; a bare stub (tests, one-off tooling,
    // `node -e` probes) must not take the platform down — losing the shutdown hook
    // costs a clean exit, nothing more.
    if (typeof api.on === 'function') {
      try { api.on('shutdown', () => this.shutdown()); }
      catch (e) { this.log.error(`api.on('shutdown') failed: ${e.message}`); }
    }

    /*
     * Homebridge only calls start() for dynamic platforms once didFinishLaunching
     * fires; on bridges where another plugin holds accessory loading open that event
     * never arrives and these lights would never appear. Self-boot instead and treat
     * start() as idempotent.
     */
    setTimeout(() => this._boot(), 1500);
  }

  get discoveryInterval() {
    const s = Number(this.config.discoveryInterval);
    return Number.isFinite(s) && s >= 60 ? s * 1000 : 300 * 1000;
  }

  /** One line every boot naming the geometry in force — there is exactly one. */
  _logGeometryInForce() {
    this.log(`geometry: uplight=${describeCells(CEILING_UPLIGHT_CELLS)} downlight=${describeCells(ceilingsDownlightCells(), false)} (fixed for pid 176/177)`);
  }

  async _boot() {
    if (this._booted || this._stopping) return;
    this._booted = true;
    try {
      await this.start();
    } catch (e) {
      this._booted = false;
      this.log.error(`self-boot failed: ${e.stack || e.message}`);
    }
  }

  async start() {
    let Lifx;
    try {
      // Lazy require keeps `require('./index.js')` and the tests dependency-free.
      Lifx = require('node-lifx-lan-multi');
    } catch (e) {
      this.log.error(`node-lifx-lan-multi is not installed: ${e.message}`);
      throw e;
    }
    this.lifx = new Lifx();
    this.log(`homebridge-lifx-ceiling starting (uplight=${CEILING_UPLIGHT_CELLS.join(',')} downlight=${ceilingsDownlightCells().length} cells)`);
    try {
      await this.discover();
    } catch (e) {
      this.log.error(`initial discover failed: ${e.stack || e.message}`);
    }
    if (!this._timer) {
      this._timer = setInterval(() => {
        this.discover().catch((e) => this.log.error(`discovery cycle failed: ${e.message}`));
      }, this.discoveryInterval);
    }
  }

  async discover() {
    if (!this.lifx || this._stopping) return;
    let found = [];
    try {
      found = (await this.lifx.discover({ timeoutSeconds: 10 })) || [];
    } catch (e) {
      this.log.error(`lifx discover() failed: ${e.message}`);
      return;
    }

    const seen = new Set();
    const added = []; // brand-new accessories -> registerPlatformAccessories
    const bound = []; // restored accessories rebound to a live Fixture -> updatePlatformAccessories

    for (const device of Array.isArray(found) ? found : []) {
      if (!device || !device.ip) continue;
      if (!isCeiling(device)) continue;
      if (!(await hasMatrix(device, this.log))) continue;

      /*
       * HOMEKIT IDENTITY IS THE HARDWARE MAC.
       *
       * Bridged accessories cannot be unpaired individually in Home.app; only the whole
       * bridge can be removed. So a UUID is permanent once paired, and the token it is
       * derived from must be one that survives the things that actually happen to a
       * fixture: a renewed DHCP lease, a router change, a new switch. The MAC does, the
       * address does not. Restored accessories are matched on context.hwMac first and
       * reused, then on the legacy address forms so installs from before 1.1.0 keep
       * their cached UUIDs rather than becoming duplicate tiles.
       *
       * A fixture that reports no MAC falls back to its address — rare, and the only
       * case where a lease change can produce a new tile.
       */
      // Canonical hardware MAC. Identity where we can get it: a fixture that renews onto
      // a new address stays the SAME accessory, so no DHCP reservation is required and no
      // duplicate tile appears. The IP is the transport, chosen per frame, not the name.
      const hwMac = normalizeMac(device.mac) || normalizeMac(device.deviceInfo && device.deviceInfo.mac) || null;
      const identity = hwMac || device.ip; // no MAC (rare) -> address is all we have
      seen.add(identity);
      this._misses.delete(identity);
      this.warnOnIdentityDrift(hwMac, identity);

      let fixture = this.fixtures.get(identity);
      if (fixture) {
        // Same fixture, different address: keep the accessory and its UUID, move the
        // transport. Without this the handlers keep writing to the IP it left behind.
        if (device.ip && fixture.ip !== device.ip) {
          this.log(`[${identity}] transport moved ${fixture.ip} -> ${device.ip}; accessory and UUID unchanged`);
          fixture.rebindDevice(device);
        }
        continue;
      }
      fixture = new Fixture({
        device, log: this.log,
        kelvinMin: this.config.kelvinMin, kelvinMax: this.config.kelvinMax,
      });
      fixture.setApi(this.api);
      this.fixtures.set(identity, fixture);

      const base = this._baseName(device);
      // An alias is explicit intent written in config.json, so we publish it; without
      // one the label is the fixture's own and a rename made in Home.app outranks us.
      const nameIsOurs = base === this.aliases.get(normalizeMac(device.mac));
      for (const half of Object.keys(HALVES)) {
        // Registry key. For a brand-new fixture this is also the UUID seed, so a
        // never-before-seen panel is minted as `<mac>:<half>`; an accessory Homebridge
        // already restored keeps its cached UUID and only its handler is rebound.
        const stableId = `${identity}:${half}`;
        const displayName = `${base} ${HALVES[half].name}`;

        /*
         * REUSE BEFORE YOU MINT. configureAccessory() already gave us the accessory
         * Homebridge restored from cache; minting a parallel one for the same device
         * computes the identical UUID, Homebridge logs "same UUID ... Skipping
         * duplicate" and keeps the restored object on the bridge — with no handlers
         * bound, because configureService() ran on the object we threw away. Home.app
         * tiles then talk to dead characteristics. So: find the existing accessory,
         * rebind its Lightbulb to this live Fixture, keep its UUID untouched.
         */
        const existing = this.findAccessory(stableId, identity, half, hwMac, device.ip);
        if (existing) {
          this.configureService(existing, half, fixture, displayName, identity, nameIsOurs);
          /*
           * Home.app labels a bridged tile from the ACCESSORY, not only from the
           * Lightbulb service, so a reused accessory keeps the name it was cached with
           * however many times we re-publish the service name. Only an explicit `aliases`
           * entry renames it — that is intent stated in config.json. Without one the
           * cached name stays, so a rename the user made in Home.app survives.
           */
          if (nameIsOurs && existing.displayName !== displayName) {
            this.log(`renaming "${existing.displayName}" -> "${displayName}" (alias in config.json)`);
            existing.displayName = displayName;
          }
          const ctx = existing.context || (existing.context = {});
          if (!ctx.half) ctx.half = half;
          if (!ctx.mac) ctx.mac = device.ip; // cached context.mac has always been the address
          if (!ctx.hwMac) ctx.hwMac = hwMac; // real MAC, kept for a future migration
          // A cache entry that predates the `ip:half` stableId is keyed by UUID; move
          // it onto the registry key everything else (prune, drift) looks it up by.
          if (this.accessories.get(stableId) !== existing) {
            for (const [k, v] of this.accessories) if (v === existing) this.accessories.delete(k);
            this.accessories.set(stableId, existing);
          }
          bound.push(existing);
          continue;
        }

        const uuid = this.api.hap.uuid.generate(stableId);
        const accessory = new this.api.platformAccessory(displayName, uuid, this.api.hap.Categories.LIGHTING);
        accessory.context.stableId = stableId;
        accessory.context.half = half;
        accessory.context.mac = device.ip; // the address, as older caches store it
        accessory.context.hwMac = hwMac; // real MAC, kept for a future migration
        this.configureService(accessory, half, fixture, displayName, identity, nameIsOurs);
        this.accessories.set(stableId, accessory);
        added.push(accessory);
      }
      await fixture.refresh();
    }

    if (added.length) {
      try {
        // 3-argument register: the only call that associates the plugin and puts
        // the accessory on the bridge. updatePlatformAccessories refreshes only.
        this.api.registerPlatformAccessories(PLUGIN_ID, PLATFORM_NAME, added);
      } catch (e) {
        this.log.error(`registerPlatformAccessories failed: ${e.message}`);
      }
    }
    /*
     * Reused accessories are already on the bridge under UUIDs Home.app has already
     * paired; updatePlatformAccessories only persists their context. That is a
     * persistence hint, not a correctness requirement — the handlers are bound
     * in-process above either way — so a failure is logged and never fatal.
     */
    if (bound.length) {
      try {
        this.api.updatePlatformAccessories(bound);
      } catch (e) {
        this.log.error(`updatePlatformAccessories failed for ${bound.length} reused light(s): ${e.message}`);
      }
    }
    // One line per cycle naming the split, so re-minting after a restart is visible
    // in the boot log rather than hidden behind a duplicate-UUID warning.
    if (added.length || bound.length) {
      this.log(`${added.length + bound.length} light(s) live (${added.length} new, ${bound.length} reused): ${[...added, ...bound].map((a) => a.displayName).join(', ')}`);
    }

    this.dropLegacyAccessories();
    // A missing broadcast reply is not evidence of absence: managed APs filter broadcast
    // UDP and LIFX radios sleep, and on 2026-09-22 that misreading deleted eight tiles.
    // Ask each unheard fixture directly before believing it is gone.
    await this._probeUnheard(seen);

    this.prune(seen);
  }

  /**
   * Report an address change on a fixture we already know — log only, never act.
   *
   * Identity is the hardware MAC (see discover()), so this does NOT create a second
   * pair of tiles: the transport is rebound to the new address and the accessory keeps
   * its UUID. The warning exists because the address is also what every CLI tool here
   * takes as an argument, and because drift on a fixture that fell back to address
   * identity (no MAC reported) is exactly where a duplicate tile would appear.
   * Nothing here unregisters an accessory, re-mints a UUID or rewrites an
   * existing context.hwMac; it names both addresses and stops.
   *
   * @param {string|null} hwMac canonical MAC of the device as discovered now
   * @param {string} ip the IP it is answering on now
   */
  warnOnIdentityDrift(hwMac, ip) {
    if (!hwMac || !ip) return;
    const stale = new Set();
    for (const accessory of this.accessories.values()) {
      const ctx = (accessory && accessory.context) || {};
      if (normalizeMac(ctx.hwMac) !== hwMac) continue;
      if (!ctx.mac || ctx.mac === ip) continue;
      stale.add(ctx.mac);
    }
    if (!stale.size) return;
    const token = `${hwMac}->${ip}`;
    if (this._driftWarned.has(token)) return; // one shout per fixture+address, not per cycle
    this._driftWarned.add(token);
    const old = [...stale].join(', ');
    this.log(
      `[identity] hwMac ${hwMac} is answering on ${ip}; accessories published on ${old} are reused by MAC. ` +
      'Same accessory, same UUID, same room — only the transport moved, no action needed.'
    );
  }

  /**
   * The accessory already representing this identity+half, if any — never mint over it.
   *
   * `accessories` first (the normal case: cached under `ip:half`, or published earlier
   * in this process), then a scan of the restored set for `mac`+`half`, which still
   * matches a cache entry written before the current stableId format existed.
   */
  findAccessory(stableId, identity, half, hwMac = null, ip = null) {
    const byId = this.accessories.get(stableId);
    if (byId) return byId;
    // Hardware-MAC match: the accessory that used to live at another address. This is the
    // lookup that makes a DHCP change invisible — the cached UUID is reused as-is.
    if (hwMac) {
      for (const pool of [this.accessories.values(), this.restored]) {
        for (const a of pool) {
          const c = (a && a.context) || {};
          if (c.half === half && normalizeMac(c.hwMac) === hwMac) return a;
        }
      }
    }
    // Caches that predate hwMac store the ADDRESS in context.mac, and older still may have
    // no stableId at all. Without this fallback a pre-1.1 cache entry looks unknown, gets
    // minted beside the restored one, and Homebridge logs "same UUID ... skipping".
    const addr = ip || (hwMac ? null : identity);
    if (addr) {
      for (const pool of [this.accessories.values(), this.restored]) {
        for (const a of pool) {
          const c = (a && a.context) || {};
          if (c.half !== half) continue;
          if (c.mac === addr || c.stableId === `${addr}:${half}`) return a;
        }
      }
    }
    return null;
  }

  /** Two Lightbulb services on one accessory is the old shape — remove it. */
  dropLegacyAccessories() {
    const legacy = [...this.accessories.values()].filter((a) => !a.context || !a.context.half);
    if (!legacy.length) return;
    try {
      this.api.unregisterPlatformAccessories(PLUGIN_ID, PLATFORM_NAME, legacy);
      this.log(`removed ${legacy.length} legacy accessory/ies (two-services shape)`);
    } catch (e) {
      this.log.error(`unregister legacy failed: ${e.message}`);
    }
    for (const a of legacy) {
      this.restored.delete(a);
      for (const [k, v] of this.accessories) if (v === a) this.accessories.delete(k);
    }
  }

  /**
   * What a fixture is called, most specific first: the `aliases` entry for its MAC, then
   * the label the fixture carries in the LIFX app, then its address.
   * Keys are normalised, so `aa:bb:cc:dd:ee:ff` and `aabbccddee22` are the same fixture.
   */
  _baseName(device) {
    const mac = normalizeMac(device.mac || (device.deviceInfo && device.deviceInfo.mac));
    if (mac && this.aliases.has(mac)) return this.aliases.get(mac);
    return (device.deviceInfo && device.deviceInfo.label) || `LIFX Ceiling ${device.ip}`;
  }

  /**
   * `aliases` is a site-local map of MAC -> short name ({ "11:22:33:44:55:66": "SW" } →
   * "SW Uplight", "SW Downlight"). It is opt-in and empty by default: the published
   * plugin names tiles from the fixture's own LIFX label, because a shipped default of
   * "SW" is one person's living room. A key that is not a MAC is almost certainly a typo
   * or an IP, so it is refused with a named warning rather than silently ignored.
   */
  _readAliases(raw) {
    const map = new Map();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (raw !== undefined) this.log.error('[config] ignored aliases — expected an object of MAC -> short name; using fixture labels');
      return map;
    }
    for (const [key, value] of Object.entries(raw)) {
      const mac = normalizeMac(key);
      const name = typeof value === 'string' ? value.trim() : '';
      if (!mac) { this.log.error(`[config] ignored aliases["${key}"] — not a MAC; keys are like "aa:bb:cc:dd:ee:11" (case and separators are free)`); continue; }
      if (!name) { this.log.error(`[config] ignored aliases["${key}"] — the name is empty`); continue; }
      map.set(mac, name);
    }
    if (map.size) this.log(`[config] aliases for ${map.size} fixture(s): ${[...map.values()].join(', ')}`);
    return map;
  }

  configureService(accessory, half, fixture, displayName, identity, nameIsOurs = false) {
    const { Service, Characteristic } = this.api.hap;
    // Service subtype from the SAME identity token as the accessory UUID, so a
    // restored accessory reuses its existing Lightbulb service instead of getting a
    // second one. Never derive this from fixture.mac — that is only a lookup key.
    /*
     * The Lightbulb subtype is part of the cached accessory on the bridge. When identity
     * moved from the address to the MAC, naively recomputing it here would have failed the
     * lookup below, added a SECOND Lightbulb service to the same accessory, and left the
     * cached one talking to nothing. So: whatever the accessory already carries is the
     * subtype; only a brand-new service gets the identity-derived one, and it is recorded
     * in context so the answer never has to be guessed again.
     */
    const ctxForSub = accessory.context || (accessory.context = {});
    let subtype = ctxForSub.subtype || null;
    if (!subtype) {
      const carried = accessory.svcs instanceof Map
        ? [...accessory.svcs.keys()]
        : (Array.isArray(accessory.services) ? accessory.services.filter((sv) => sv && sv.UUID === Service.Lightbulb.UUID).map((sv) => sv.subtype) : []);
      const known = carried.filter((x) => typeof x === 'string' && x.length);
      if (known.length === 1) subtype = known[0];
    }
    if (!subtype) subtype = this.api.hap.uuid.generate(`${identity}:${half}`);
    ctxForSub.subtype = subtype;
    let svc = accessory.getServiceById(Service.Lightbulb, subtype);
    if (!svc) {
      svc = accessory.addService(Service.Lightbulb, displayName, subtype);
      // A brand-new service takes our name — this is the tile's first name in Home.app.
      svc.setCharacteristic(Characteristic.Name, displayName);
    } else if (nameIsOurs) {
      // Existing service. Only an explicit `aliases` entry re-publishes a name; otherwise
      // the name on the bridge stays as Home.app last had it, so a rename the user made
      // there survives every restart instead of reverting to a label we invented.
      svc.setCharacteristic(Characteristic.Name, displayName);
    }

    svc.getCharacteristic(Characteristic.On)
      .onGet(() => fixture.state[half].on)
      .onSet((v) => fixture.set(half, { on: !!v }));
    svc.getCharacteristic(Characteristic.Brightness)
      .onGet(() => Math.round(fixture.state[half].brightness * 100))
      .onSet((v) => fixture.set(half, { brightness: Math.min(Math.max(v, 0), 100) / 100 }));
    svc.getCharacteristic(Characteristic.Hue)
      .onGet(() => fixture.state[half].hue)
      .onSet((v) => fixture.set(half, { hue: ((v % 360) + 360) % 360 }));
    svc.getCharacteristic(Characteristic.Saturation)
      .onGet(() => Math.round(fixture.state[half].saturation))
      .onSet((v) => fixture.set(half, { saturation: Math.min(Math.max(v, 0), 100) }));
    // HomeKit expresses colour temperature in mireds; the fixture speaks kelvin.
    const miredMin = Math.ceil(1e6 / fixture.kelvinMax);
    const miredMax = Math.floor(1e6 / fixture.kelvinMin);
    svc.getCharacteristic(Characteristic.ColorTemperature)
      .setProps({ minValue: miredMin, maxValue: miredMax, minStep: 1 })
      .onGet(() => Math.round(1e6 / Math.min(Math.max(fixture.state[half].kelvin, fixture.kelvinMin), fixture.kelvinMax)))
      .onSet((v) => fixture.set(half, { kelvin: Math.round(1e6 / Math.min(Math.max(v, miredMin), miredMax)) }));

    fixture.bind(half, svc);
    return svc;
  }

  /** Homebridge restores cached accessories here — never re-mint UUIDs. */
  configureAccessory(accessory) {
    // Whatever Homebridge restored is the object on the bridge: record it so
    // discover() rebinds it instead of minting a duplicate UUID beside it.
    this.restored.add(accessory);
    const ctx = (accessory && accessory.context) || {};
    // `context` is persisted verbatim, so a cache entry written before the `ip:half`
    // stableId format still identifies itself by mac + half — same token, rebuilt.
    const stableId = ctx.stableId || (ctx.mac && ctx.half ? `${ctx.mac}:${ctx.half}` : null);
    if (stableId && ctx.half) {
      this.accessories.set(stableId, accessory);
      return;
    }
    // Legacy shape (no half marker): drop it from HomeKit rather than resurrect it.
    this.log(`restoring accessory "${accessory.displayName}" — legacy shape, will be removed`);
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Ask every unheard fixture directly before believing it is gone.
   *
   * Discovery is a broadcast, and broadcast UDP over Wi-Fi is routinely dropped — AP
   * filtering, client isolation, and LIFX radios that sleep. Unreachable has to mean
   * "did not answer a request aimed at it", not "was quiet when we shouted".
   */
  async _probeUnheard(seen) {
    for (const [identity, fx] of this.fixtures) {
      if (seen.has(identity)) continue;
      try {
        const st = await fx.probe();
        seen.add(identity);
        this._misses.delete(identity);
        this.log(`[${identity}] answered a unicast probe at ${fx.ip} although broadcast was quiet — reachable, power ${st && st.power ? 'on' : 'off'}`);
      } catch (e) {
        this.log(`[${identity}] unicast probe to ${fx.ip} failed: ${e.message}`);
      }
    }
  }

  /**
   * Notice fixtures that have gone quiet — and keep everything they are in HomeKit.
   *
   * This used to call `unregisterPlatformAccessories()`. That was a data-destroying
   * mistake and it fired in production: multicast discovery missed the four ceilings for
   * three cycles (a unicast probe to the very same IPs answered fine), the plugin
   * unregistered all eight accessories, and Home.app deleted the tiles out of the user's
   * rooms. A bridge may remove a bridged accessory, but to HomeKit its return is a NEW
   * accessory — room, automations and favourites are gone and nothing we do can put them
   * back. Unreachability is transient; deleting someone's home is not.
   *
   * So this only counts and logs. The accessory, its handlers and its last known state
   * all stay exactly where they are; the next discovery cycle finds the device again and
   * refreshes it. While it is out of reach a control attempt fails on the UDP timeout
   * and Home.app shows "No Response", which is the honest and recoverable answer.
   */
  prune(seen) {
    for (const identity of this.fixtures.keys()) {
      if (seen.has(identity)) {
        if (this._misses.delete(identity)) {
          this.log(`[${identity}] back in range`);
        }
        continue;
      }
      const misses = (this._misses.get(identity) || 0) + 1;
      this._misses.set(identity, misses);
      if (misses === 3) {
        this.log(`[${identity}] not answering discovery for ${misses} cycles — keeping its accessory; a reply refreshes it, unregistering would delete it from the user's rooms for good`);
      }
    }
  }

  shutdown() {
    this._stopping = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    for (const fx of this.fixtures.values()) fx.destroy();
    if (this.lifx && this.lifx.destroy) {
      try { this.lifx.destroy(); } catch (e) { this.log(`lifx.destroy failed: ${e.message}`); }
    }
    this.log('homebridge-lifx-ceiling stopped');
  }
}

module.exports = { LifxCeilingPlatform, isCeiling, hasMatrix, CEILING_PIDS, PLUGIN_ID, PLATFORM_NAME };
