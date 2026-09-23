'use strict';
/**
 * Ack-required TileSetTileState64 (service 715) for the command-line tools.
 *
 * WHY THIS EXISTS: `node-lifx-lan-multi`'s own `tileSetTileState64()` sends with
 * `ack_required:false`. On a LIFX Ceiling (pid 176/177) an un-acked matrix frame can
 * simply not arrive, and nothing in the library will tell you — the tool prints a happy
 * log line while the fixture is unchanged. Every tile write in this plugin therefore goes
 * out through `udp.request()` with `ack_required: true`, and a service-223 reply is
 * treated as a failure rather than ignored.
 *
 * `Fixture._writeMatrix()` in lib/fixture.js is the production write path and carries
 * the same rules with the platform's own logging; it is deliberately NOT routed through
 * here, so that a tooling change can never touch a live lighting path. If you change
 * the rules below, change that one too, and re-verify on hardware.
 */

const TILE_SET_STATE_64 = 715;
const REJECTION = 223;

/**
 * @param {object} device a discovered device (needs `ip`, and `_lifxLanUdp` to be acked)
 * @param {object} payload { tile_index, length, x, y, width, duration, colors }
 * @param {(msg: string) => void} [log]
 * @returns {Promise<object|undefined>} the reply packet
 * @throws if the device rejected the write (service 223)
 */
async function writeTileAcked(device, payload, log = () => {}) {
  const udp = device && device._lifxLanUdp;
  if (!udp) {
    log('no _lifxLanUdp on this device — falling back to un-acked tileSetTileState64, this write may silently vanish');
    return device.tileSetTileState64(payload);
  }
  const mac = device.mac || (device.deviceInfo && device.deviceInfo.mac) || null;
  const req = { address: device.ip, type: TILE_SET_STATE_64, ack_required: true, res_required: false, payload };
  if (mac) req.target = mac; // verbatim as discovery reported it
  const res = await udp.request(req);
  const pkt = Array.isArray(res) ? res[0] : res;
  const type = pkt && pkt.header ? pkt.header.type : (pkt ? pkt.type : undefined);
  if (type === REJECTION) throw new Error(`tile write rejected by ${device.ip} (service 223) — this firmware does not accept that frame`);
  return pkt;
}

module.exports = { writeTileAcked, TILE_SET_STATE_64, REJECTION };
