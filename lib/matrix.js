'use strict';
/**
 * Pure pixel-region maths for the LIFX Ceiling 8x8 matrix.
 * No dependencies, no I/O, no HomeKit, no LIFX — fully unit-testable.
 *
 * Buffer layout: row-major, index = y * width + x, length = width * height.
 *
 * Colour convention (matches node-lifx-lan-multi): hue/saturation/brightness
 * are NORMALISED FLOATS 0.0-1.0, kelvin is ABSOLUTE (e.g. 3500).
 */

const REGION_KINDS = ['ring', 'core', 'all'];

/**
 * Canonical MAC form. The same address arrives from different layers in three
 * shapes — `AA:BB:CC:DD:EE:FF` (what the fixture answers on the wire),
 * `aa:bb:cc:dd:ee:ff` (what a mapping file stores) and `aabbccddeeff`
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
/**
 * Radial geometry. A LIFX Ceiling is ROUND, so the uplight/downlight seam is a
 * circle. A square perimeter cannot express it: on an 8x8 grid the corner cells
 * (r=1.41) sit outside the fixture's circle altogether and mid-edge cells
 * (r=1.01) straddle the rim, which is what made "ring" paint bleed onto the
 * downlight. Radius is normalised so that a cell on the edge midpoint is 1.0
 * and the corners are ~1.41.
 * @param {number} t boundary radius (cells with r <= t are the disc)
 */
function cellRadius(x, y, width, height) {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  // Normalise by the distance from centre to an edge cell centre, so a cell on
  // the rim reads ~1.0 and the corners read ~1.41 (outside the round fixture).
  const denom = Math.max(width, height) / 2 - 0.5;
  return Math.hypot(x - cx, y - cy) / denom;
}

/** Disc: cells whose centre is within radius t of the fixture centre. */
function discIndices(width, height, t) {
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cellRadius(x, y, width, height) <= t) out.push(y * width + x);
    }
  }
  return out;
}

/** Annulus complement: everything outside radius t. */
function annulusIndices(width, height, t) {
  const have = new Set(discIndices(width, height, t));
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!have.has(i)) out.push(i);
    }
  }
  return out;
}

/**
 * Candidate seam radii, scanned outward. 0.75 puts the boundary just inside the
 * rim; 0.88 hugs it; 0.62 pulls well inside. Calibration picks the one that
 * produces a clean circle against the fixture's physical seam.
 */
const SEAM_CANDIDATES = [0.75, 0.88, 0.62];

/** Parse 'disc@0.75' / 'annulus@0.75' (also plain 'ring'/'core'/'all'). */
function parseRegion(region) {
  if (Array.isArray(region)) return { kind: 'list', indices: region };
  if (typeof region !== 'string') throw new Error(`region must be a string or index array, got ${JSON.stringify(region)}`);
  const at = region.indexOf('@');
  if (at === -1) return { kind: region };
  const kind = region.slice(0, at);
  const t = Number(region.slice(at + 1));
  if (!Number.isFinite(t) || t <= 0 || t > 1.5) throw new Error(`bad radius in region "${region}"`);
  return { kind, t };
}

function allIndices(width, height) {
  const out = [];
  for (let i = 0, n = width * height; i < n; i++) out.push(i);
  return out;
}

/** Perimeter pixels of a width x height buffer. */
function ringIndices(width, height) {
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) out.push(y * width + x);
    }
  }
  return out;
}

/** Everything that is not on the perimeter. */
function coreIndices(width, height) {
  const ring = new Set(ringIndices(width, height));
  const out = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!ring.has(i)) out.push(i);
    }
  }
  return out;
}

function complement(indices, width, height) {
  const have = new Set(indices);
  return allIndices(width, height).filter((i) => !have.has(i));
}

/**
 * THE uplight of a LIFX Ceiling (pid 176/177): the four corner cells.
 *
 * Hardware-verified by looking at four separate fixtures — this frame gives a full
 * red uplight ring with the panel uniformly blue and a hard, clean edge:
 *
 *   U.......
 *   .......U      U = 0, 7, 56, 63  = uplight
 *   .......U      . = the other 60  = downlight panel
 *   U.......
 *
 * Not a radial seam: `annulus@t` and `ring` put colour onto downlight LEDs
 * (cells 1, 6, 8, 15, 48, 55, 57, 62), which show as red/magenta on the panel face.
 * The two halves do not optically bleed, so colour on the panel is always a cell
 * that belongs to the wrong half.
 *
 * This is a constant, not a setting. Overriding it is a REPAIR operation for a unit
 * that behaves differently — see `mappingFile` — never a preference.
 */
const CEILING_UPLIGHT_CELLS = [0, 7, 56, 63];

/** The downlight panel: every cell the uplight does not own. */
function ceilingsDownlightCells(width = 8, height = 8) {
  return complement(CEILING_UPLIGHT_CELLS.filter((i) => i < width * height), width, height);
}

/**
 * Resolve a region descriptor to concrete pixel indices.
 * @param {string|number[]} region  'ring' | 'core' | 'all' | explicit index array
 */
function indicesForRegion(region, width, height) {
  const p = parseRegion(region);
  if (p.kind === 'list') {
    const max = width * height;
    for (const i of p.indices) {
      if (!Number.isInteger(i) || i < 0 || i >= max) {
        throw new Error(`region index ${i} out of range for ${width}x${height} (0..${max - 1})`);
      }
    }
    return [...new Set(p.indices)].sort((a, b) => a - b);
  }
  if (p.kind === 'ring') return ringIndices(width, height);
  if (p.kind === 'core') return coreIndices(width, height);
  if (p.kind === 'all') return allIndices(width, height);
  if (p.kind === 'disc') return discIndices(width, height, p.t);
  if (p.kind === 'annulus') return annulusIndices(width, height, p.t);
  throw new Error(`unknown region "${region}" — expected ring, core, all, disc@t or annulus@t`);
}

/** Flip a region so the other half of the fixture gets it. */
function invertRegion(region, width, height) {
  if (region === 'ring') return 'core';
  if (region === 'core') return 'ring';
  if (region === 'all') return 'all';
  return complement(region, width, height);
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
function applyRegion(buffer, indices, color, width, height) {
  assertColor(color);
  const set = new Set(indices);
  const src = Array.isArray(buffer) ? buffer : [];
  const out = [];
  for (let i = 0, n = width * height; i < n; i++) {
    out.push(set.has(i) ? { ...color } : (src[i] ? { ...src[i] } : { hue: 0, saturation: 0, brightness: 0, kelvin: 3500 }));
  }
  return out;
}

/** Overlay `top` onto `base` at `indices`. Non-mutating. */
function mergeRegion(base, overlay, indices) {
  const set = new Set(indices);
  return base.map((c, i) => (set.has(i) ? { ...(overlay[i] || c) } : { ...c }));
}

/** Two regions must not overlap and must together cover the whole buffer. */
function validateCoverage(up, down, width, height) {
  const a = indicesForRegion(up, width, height);
  const b = indicesForRegion(down, width, height);
  const sa = new Set(a);
  const overlap = b.filter((i) => sa.has(i));
  if (overlap.length) {
    throw new Error(`regions overlap at ${overlap.length} pixel(s), e.g. ${overlap.slice(0, 8).join(', ')}`);
  }
  const covered = new Set([...a, ...b]);
  const max = width * height;
  if (covered.size !== max) {
    const missing = [];
    for (let i = 0; i < max; i++) if (!covered.has(i)) missing.push(i);
    throw new Error(`regions cover ${covered.size}/${max} pixels — missing ${missing.slice(0, 8).join(', ')}`);
  }
  return { uplight: a, downlight: b };
}

module.exports = {
  REGION_KINDS,
  normalizeMac,
  SEAM_CANDIDATES,
  cellRadius,
  discIndices,
  annulusIndices,
  parseRegion,
  allIndices,
  ringIndices,
  coreIndices,
  complement,
  CEILING_UPLIGHT_CELLS,
  ceilingsDownlightCells,
  indicesForRegion,
  invertRegion,
  assertColor,
  applyRegion,
  mergeRegion,
  validateCoverage,
};
