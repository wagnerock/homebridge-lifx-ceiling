'use strict';
/**
 * Pixel maths for the LIFX Ceiling 8x8 matrix.
 * No dependencies, no I/O, no HomeKit, no LIFX — fully unit-testable.
 *
 * Buffer layout: row-major, index = y * width + x, length = width * height.
 *
 * Colour convention (matches node-lifx-lan-multi): hue/saturation/brightness
 * are NORMALISED FLOATS 0.0-1.0, kelvin is ABSOLUTE (e.g. 3500).
 *
 * ONE GEOMETRY, COMPILED IN. This plugin supports the LIFX Ceiling (pid 176/177) and
 * nothing else, so the half split here is a constant, not a setting.
 */

/**
 * Canonical MAC form. The same address arrives from different layers in three
 * shapes — `AA:BB:CC:DD:EE:FF` (what the fixture answers on the wire),
 * `aa:bb:cc:dd:ee:ff` (what config stores) and `aabbccddeeff`
 * (what a normalised id looks like) — and `!==` compares them as three
 * different devices. Strip every non-hex character and lowercase, so all three
 * collapse to one 12-digit key. Pure, dependency-free.
 * @param {string|null|undefined} v
 * @returns {string|null} 12 lowercase hex digits, or null if it is not a MAC
 */
function normalizeMac(v) {
  if (typeof v !== 'string') return null;
  const hex = v.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 ? hex : null;
}

/** @returns {number[]} every index of a width x height buffer */
function allIndices(width, height) {
  const out = [];
  for (let i = 0, n = width * height; i < n; i++) out.push(i);
  return out;
}

/** Everything `indices` does not own. */
function complement(indices, width, height) {
  const have = new Set(indices);
  return allIndices(width, height).filter((i) => !have.has(i));
}

/**
 * THE uplight of a LIFX Ceiling (pid 176/177): the four corner cells.
 *
 * Hardware-verified by looking at four separate fixtures — this frame gives a full
 * red uplight with the panel uniformly blue and a hard, clean edge:
 *
 *   U.......
 *   .......U      U = 0, 7, 56, 63  = uplight
 *   .......U      . = the other 60  = downlight panel
 *   U.......
 *
 * Not a radial seam. A radius-based mask — the disc of cells inside some boundary
 * radius, or everything outside it — puts colour onto downlight LEDs (cells 1, 6, 8,
 * 15, 48, 55, 57, 62), which show as red/magenta on the panel face. The 8x8 grid is a
 * square matrix behind a round fixture, so any radius snaps to a blocky rounded square
 * and always catches a few panel cells. Corner cells have no such ambiguity.
 *
 * The code for that model — radius parsing, boundary scanning, region selection — was
 * removed in 1.2.0, along with the per-fixture override that could select it. What is
 * left here is the model that was verified by eye on hardware, and it is a constant.
 *
 * This is a constant, not a setting. There is no override: a LIFX Ceiling whose halves
 * behave differently is unsupported, and that is a product decision (README ->
 * "The geometry is fixed").
 */
const CEILING_UPLIGHT_CELLS = [0, 7, 56, 63];

/** The downlight panel: every cell the uplight does not own. */
function ceilingsDownlightCells(width = 8, height = 8) {
  return complement(CEILING_UPLIGHT_CELLS.filter((i) => i < width * height), width, height);
}

/** Normalise+validate a device-bound colour, or throw a precise error. */
function assertColor(color, where = 'colour') {
  if (!color || typeof color !== 'object') throw new Error(`${where}: expected an object`);
  for (const k of ['hue', 'saturation', 'brightness']) {
    const v = color[k];
    if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1.0) {
      throw new Error(`${where}.${k} must be a float between 0.0 and 1.0, got ${JSON.stringify(v)}`);
    }
  }
  if (!Number.isInteger(color.kelvin) || color.kelvin < 1000 || color.kelvin > 9000) {
    throw new Error(`${where}.kelvin must be an absolute kelvin integer 1000-9000, got ${JSON.stringify(color.kelvin)}`);
  }
  return true;
}

/**
 * Paint `indices` of `buffer` with `color`. Non-mutating — returns a new buffer.
 * Untouched pixels keep their previous value.
 */
function paintCells(buffer, indices, color, width, height) {
  assertColor(color);
  const set = new Set(indices);
  const src = Array.isArray(buffer) ? buffer : [];
  const out = [];
  for (let i = 0, n = width * height; i < n; i++) {
    out.push(set.has(i) ? { ...color } : (src[i] ? { ...src[i] } : { hue: 0, saturation: 0, brightness: 0, kelvin: 3500 }));
  }
  return out;
}

module.exports = {
  normalizeMac,
  allIndices,
  complement,
  CEILING_UPLIGHT_CELLS,
  ceilingsDownlightCells,
  assertColor,
  paintCells,
};
