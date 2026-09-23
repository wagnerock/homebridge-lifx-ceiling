'use strict';
/**
 * Shared state for one physical Ceiling, split into two HomeKit lights.
 *
 * Both halves address the SAME 64-pixel buffer, so they must compose into a
 * single write - if each half wrote its own frame they would clobber each other.
 * A ~120ms debounce coalesces rapid HomeKit changes into one UDP packet.
 *
 * Power: HomeKit "off" for a half is that region's brightness 0. Fixture power is
 * cut only when BOTH halves are off, and power is set BEFORE the matrix frame -
 * the panel is power-driven.
 *
 * TILE WRITES MUST BE ACK-REQUIRED (verified on pid 176 hardware): the library's
 * `tileSetTileState64()` goes through `_request()`, which hardcodes `ack_required:false`
 * (lifx-lan-device.js:62), and on these fixtures an un-acked tile write can silently
 * vanish. Frames therefore go out on `device._lifxLanUdp.request()` with
 * `ack_required:true`; a good write answers svc 45 (LightState) or svc 3 (Ack), and
 * svc 223 is a Rejection - see `_writeMatrix()`.
 *
 * CAUTION ON VERIFICATION: this device's read-backs lag or lag-stale behind writes.
 * `lightGetPower` has reported level:1 immediately after a successful
 * `lightSetPower({level:0})` that demonstrably worked (the occupant watched the light
 * go out). Never conclude a write failed from a single read — re-read after a delay,
 * or better, ask a human to look.
 */

const matrix = require('./matrix');

/** Version of the library whose private transport we depend on — named in every log. */
let LIB_VERSION = 'unknown';
try { LIB_VERSION = require('node-lifx-lan-multi/package.json').version; } catch (e) { /* diagnostic only */ }

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

const HALVES = {
  up: { name: 'Uplight', salt: 'up' },
  down: { name: 'Downlight', salt: 'down' },
};

class Fixture {
  /** @param {object} args { device, mapping, log, kelvinMin, kelvinMax } */
  constructor({ device, mapping, log, kelvinMin, kelvinMax }) {
    if (!device || !device.ip) throw new Error('Fixture requires a device with an ip');
    this.device = device;
    this.mapping = mapping;
    this.log = typeof log === 'function' ? log : () => {};
    if (typeof this.log.error !== 'function') this.log.error = (m) => this.log(m);

    /*
     * Loud, every boot, on every fixture. If `device._lifxLanUdp.request` is gone we fall
     * back to the library's un-acked `tileSetTileState64()`, which resolves happily whether
     * or not the light changed — the silent failure this plugin exists to prevent. A
     * once-per-process warn is not enough to notice across a dependency update 18 months
     * from now, so this is an error at construction and again on every degraded write.
     */
    this.canAck = !!(device._lifxLanUdp && typeof device._lifxLanUdp.request === 'function');
    if (!this.canAck) {
      this.log.error(`[${device.ip}] TILE WRITES UNACKED — node-lifx-lan-multi@${LIB_VERSION} exposes no _lifxLanUdp.request, so tile frames can vanish with no error and no visible change. Tile control on this combination is NOT trustworthy: pin/roll back the dependency (README -> "Tile writes require ack_required: true") and report the version.`);
    }

    this.ip = device.ip;
    // Canonical HARDWARE MAC (12 lowercase hex) — the MAPPING key, nothing else.
    // Falling back to device.ip *first* is what made the perDevice config entries
    // dead code, so discovery `device.mac` (uppercase colon) is normalised first and
    // the result feeds mapping.forDevice([this.mac, this.ip]).
    //
    // This field is NOT HomeKit identity. Identity is `identity` (the fixture IP) in
    // lib/platform.js, which mints the accessory UUID, the stableId and the service
    // subtype — none of those may be derived from this field, because bridged
    // accessories cannot be unpaired individually and re-minted UUIDs would strand
    // them. null when the device reports no MAC (an IP here would be a lie).
    this.mac = matrix.normalizeMac(device.mac)
      || matrix.normalizeMac(device.deviceInfo && device.deviceInfo.mac)
      || null;
    this.width = 8;
    this.height = 8;
    // Configurable colour range, defaulting to the LIFX Ceiling panel's own span.
    // HomeKit works in mireds, so expose both and convert at the boundary.
    this.kelvinMin = clamp(parseInt(kelvinMin, 10) || 1500, 1000, 9000);
    this.kelvinMax = clamp(parseInt(kelvinMax, 10) || 9000, 1000, 9000);
    if (this.kelvinMin > this.kelvinMax) {[this.kelvinMin, this.kelvinMax] = [this.kelvinMax, this.kelvinMin]};
    this.state = {
      up: { on: false, hue: 0, saturation: 0, brightness: 0.5, kelvin: 3000 },
      down: { on: false, hue: 0, saturation: 0, brightness: 0.5, kelvin: 3000 },
    };
    this._timer = null;
    this._services = {};
    this._writing = false;
    this._dirty = false;
    this._warnedUnacked = false;
    this._warnedNoMac = false;
  }

  /**
   * Raw-UDP target for a V2 frame. The fixture answers discovery with `device.mac`
   * UPPERCASE colon-separated (`AA:BB:CC:DD:EE:FF`) and accepts exactly that wire
   * form, so it is passed through VERBATIM — deliberately NOT this.mac, which is the
   * normalised lowercase form used only for mapping lookups and identity.
   * Returns null when the device reports no MAC; the request then goes out bare.
   */
  _targetMac() {
    return this.device.mac
      || (this.device.deviceInfo && this.device.deviceInfo.mac)
      || null;
  }

  bind(half, service) {
    this._services[half] = service;
    this.push(half);
  }

  push(half) {
    const svc = this._services[half];
    if (!svc) return;
    const s = this.state[half];
    try {
      const C = this._api ? this._api.hap.Characteristic : null;
      if (!C) return;
      svc.getCharacteristic(C.On).updateValue(s.on);
      svc.getCharacteristic(C.Brightness).updateValue(Math.round(s.brightness * 100));
      svc.getCharacteristic(C.Hue).updateValue(s.hue);
      svc.getCharacteristic(C.Saturation).updateValue(Math.round(s.saturation));
      svc.getCharacteristic(C.ColorTemperature).updateValue(Math.round(1e6 / clamp(s.kelvin, this.kelvinMin, this.kelvinMax)));
    } catch (e) {
      this.log(`[${this.ip}] ${half} updateValue failed: ${e.message}`);
    }
  }

  setApi(api) {
    this._api = api;
  }

  /** @param {object} patch partial state, HomeKit units */
  set(half, patch) {
    if (!this.state[half]) throw new Error(`unknown half ${half}`);
    Object.assign(this.state[half], patch);
    this.push(half);
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush().catch((e) => this.log(`[${this.ip}] flush failed: ${e.message}`));
    }, 120);
  }

  _deviceColor(half) {
    const s = this.state[half];
    return {
      hue: clamp(s.hue / 360, 0, 1),
      saturation: clamp(s.saturation / 100, 0, 1),
      brightness: s.on ? clamp(s.brightness, 0, 1) : 0,
      kelvin: clamp(Math.round(s.kelvin), this.kelvinMin, this.kelvinMax),
    };
  }

  async flush() {
    if (this._writing) { this._dirty = true; return; }
    this._writing = true;
    try {
      const regions = this.mapping.forDevice([this.mac, this.ip], this.width, this.height);
      const blank = () => ({ hue: 0, saturation: 0, brightness: 0, kelvin: 3000 });
      let buf = Array.from({ length: this.width * this.height }, blank);
      buf = matrix.applyRegion(buf, regions.uplight, this._deviceColor('up'), this.width, this.height);
      buf = matrix.applyRegion(buf, regions.downlight, this._deviceColor('down'), this.width, this.height);

      const anyOn = this.state.up.on || this.state.down.on;
      // turnOn/turnOff are the documented device calls; level writes also work but
      // read back unreliably (see header), so do not judge them from a read.
      // Power goes first: the panel is power-driven, so the frame only shows on a
      // powered fixture.
      if (anyOn) await this.device.turnOn();
      else await this.device.turnOff();

      await this._writeMatrix(buf);
      this.log(`[${this.ip}] wrote matrix up=${this.state.up.on ? 'on' : 'off'} down=${this.state.down.on ? 'on' : 'off'}`);
    } finally {
      this._writing = false;
      if (this._dirty) {
        this._dirty = false;
        this.flush().catch((e) => this.log(`[${this.ip}] follow-up flush failed: ${e.message}`));
      }
    }
  }

  /**
   * One ack-required TileSetTileState64 (svc 715). See header: the library's own
   * `tileSetTileState64()` is un-acked and frames can vanish unnoticed.
   */
  async _writeMatrix(buf) {
    const payload = { tile_index: 0, length: 1, x: 0, y: 0, width: this.width, duration: 0, colors: buf };
    const udp = this.device._lifxLanUdp;
    if (!udp) {
      // Every time, not once: an un-acked write is an unverifiable write.
      this.log.error(`[${this.ip}] UNACKED tile write (no _lifxLanUdp, node-lifx-lan-multi@${LIB_VERSION}) — this frame is unverifiable`);
      return this.device.tileSetTileState64(payload);
    }
    const target = this._targetMac();
    if (!target && !this._warnedNoMac) {
      this._warnedNoMac = true;
      this.log(`[${this.ip}] no MAC on this device - tile request sent without a target`);
    }
    const req = { address: this.device.ip, type: 715, ack_required: true, res_required: false, payload };
    if (target) req.target = target;
    const res = await udp.request(req);
    const pkt = Array.isArray(res) ? res[0] : res;
    const type = pkt && pkt.header ? pkt.header.type : (pkt ? pkt.type : undefined);
    if (type === 223) throw new Error(`[${this.ip}] tile write rejected by device (service 223)`);
    return pkt;
  }

  /** Seed from the device. Reads only — never a power write. */
  async refresh() {
    try {
      const st = await this.device.getLightState({});
      if (st && st.color) {
        const hue = st.color.hue <= 1 ? st.color.hue * 360 : st.color.hue;
        const sat = st.color.saturation <= 1 ? st.color.saturation * 100 : st.color.saturation;
        const bri = st.color.brightness <= 1 ? st.color.brightness : st.color.brightness / 100;
        const kelvin = st.color.kelvin || 3000;
        for (const half of Object.keys(HALVES)) {
          this.state[half] = { on: !!st.power, hue: Math.round(hue), saturation: Math.round(sat), brightness: clamp(bri, 0, 1), kelvin };
        }
      }
      const p = await this.device.lightGetPower();
      if (p && typeof p.level === 'number') {
        for (const half of Object.keys(HALVES)) this.state[half].on = p.level > 0;
      }
    } catch (e) {
      this.log(`[${this.ip}] refresh failed: ${e.message}`);
    }
    for (const half of Object.keys(HALVES)) this.push(half);
  }

  /**
   * Move the transport without touching HomeKit identity. Accessory, UUID, name and room
   * stay exactly as they were; only the address our frames go to changes. A fixture that
   * renews its DHCP lease reappears in discovery with a new address, and without this the
   * handlers would keep writing to the one it left.
   */
  rebindDevice(device) {
    if (!device || !device.ip) throw new Error('rebindDevice requires a device with an ip');
    this.device = device;
    this.ip = device.ip;
    this.mac = matrix.normalizeMac(device.mac) || this.mac;
    this.canAck = !!(device._lifxLanUdp && typeof device._lifxLanUdp.request === 'function');
  }

  /**
   * Liveness without side effects — a unicast read to the address we hold. Broadcast is
   * filtered by plenty of access points and these radios sleep, so silence on broadcast
   * proves nothing; a targeted request answers in well under a second when the fixture is
   * reachable. Never writes: a probe must not change someone's lights.
   * @returns {Promise<object>} the reported light state
   */
  async probe() {
    const st = await this.device.getLightState({});
    if (!st) throw new Error('no reply to unicast GetLightState');
    return st;
  }

  destroy() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }
}

module.exports = { Fixture, HALVES };
