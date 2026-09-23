'use strict';
/**
 * Region mapping. The uplight/downlight split of a LIFX Ceiling (pid 176/177) is a
 * CONSTANT — the four corner cells, hardware-verified on four separate fixtures, see
 * matrix.CEILING_UPLIGHT_CELLS. It is not a preference and there is no settings-UI
 * knob for it.
 *
 * The mapping file is OPTIONAL and exists for one job: repairing the rare unit that
 * behaves differently. A missing file is normal and keeps the built-in model; a
 * `perDevice` entry keyed by MAC (any format) overrides that single fixture only.
 */

const fs = require('fs');
const path = require('path');
const matrix = require('./matrix');

const DEFAULT_MAP = {
  uplight: [...matrix.CEILING_UPLIGHT_CELLS],
  downlight: matrix.ceilingsDownlightCells(8, 8),
  perDevice: {},
};

/**
 * A dotted quad is never a MAC — and `255.255.255.255` has twelve decimal digits,
 * so normalizeMac() alone would happily read an IPv4 address as a hardware
 * address. IPs are therefore always matched and stored verbatim.
 */
const isIPv4 = (k) => typeof k === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(k);

/**
 * Canonical perDevice storage key: a MAC becomes lowercase colon-separated
 * (`aa:bb:cc:dd:ee:ff`, the shape a mapping file uses), an IPv4
 * address or any other key stays verbatim. Cosmetic only — forDevice() matches
 * on normalizeMac(), so pre-existing non-canonical keys keep working.
 */
function canonicalKey(key) {
  if (typeof key !== 'string' || !key || isIPv4(key)) return key;
  const hex = matrix.normalizeMac(key);
  return hex ? hex.replace(/(..)(?=.)/g, '$1:') : key;
}

/** Canonicalise every perDevice key, de-duping formats of the same fixture. */
function canonicalPerDevice(perDevice) {
  const out = {};
  for (const [k, v] of Object.entries(perDevice || {})) out[canonicalKey(k)] = v;
  return out;
}

class Mapping {
  constructor(file, log) {
    // No implicit default: the package ships no mapping file and nothing may be
    // written into the installed package. `null` means "built-in corners only".
    this.file = file || null;
    this.log = typeof log === 'function' ? log : (m) => console.log(m);
    this.data = { ...DEFAULT_MAP, perDevice: {} };
    /**
     * Diagnostics only — never part of resolution. Names who last set the GLOBAL
     * regions: 'default' (built-in corners), 'mappingFile' (the loaded file),
     * 'config' (the settings-UI knobs), 'inverted'/'manual' (a tool wrote them).
     * perDevice overrides are not tracked here; they always win, see forDevice().
     */
    this.globalSource = 'default';
    this.load();
  }

  load() {
    if (!this.file) return; // no file configured: the built-in corner model is in force, silently
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...DEFAULT_MAP, ...raw, perDevice: { ...(raw.perDevice || {}) } };
        // Only a file that actually states both halves counts as the source; a file
        // with just perDevice leaves the built-in corner model in force.
        this.globalSource = (raw.uplight !== undefined && raw.downlight !== undefined) ? 'mappingFile' : 'default';
        // Non-canonical keys (uppercase, colon-less) are tolerated, never rewritten
        // on load and never throw — they are normalised at match time instead.
        const odd = Object.keys(this.data.perDevice).filter((k) => k !== canonicalKey(k));
        this.log(`[mapping] loaded ${this.file}${odd.length ? ` (${odd.length} non-canonical perDevice key(s) matched by normalized MAC: ${odd.join(', ')})` : ''}`);
      } else {
        this.log(`[mapping] no ${this.file} — using default uplight=${this.data.uplight} downlight=${this.data.downlight}`);
      }
    } catch (e) {
      this.log(`[mapping] FAILED to read ${this.file}: ${e.message} — falling back to defaults`);
      this.data = { ...DEFAULT_MAP, perDevice: {} };
      this.globalSource = 'default';
    }
    return this;
  }

  save() {
    if (!this.file) {
      throw new Error('no mapping file configured — the plugin ships none and nothing is written into the installed package. Pass --map <path> (or set LIFX_MAP) to a file of your own.');
    }
    try {
      this.data.perDevice = canonicalPerDevice(this.data.perDevice);
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n');
      this.log(`[mapping] wrote ${this.file}`);
      return true;
    } catch (e) {
      this.log(`[mapping] FAILED to write ${this.file}: ${e.message}`);
      return false;
    }
  }

  /**
   * Set the global regions, validating coverage before accepting.
   *
   * Accepts every region shape `matrix.indicesForRegion()` understands — an explicit
   * index array ([0, 7, 56, 63]) or a string ('disc@0.75', 'annulus@0.75', 'ring',
   * 'core', 'all') — in either half, and mixed forms in the same pair. The raw
   * value is stored as given and resolved at match time, exactly as before.
   *
   * Validation still throws on overlap, gaps or malformed input: callers that must
   * survive a bad value (the platform's config knobs) catch it and keep the
   * previous mapping. `source` only labels the change for the startup log.
   */
  setGlobal(uplight, downlight, width = 8, height = 8, source = 'manual') {
    matrix.validateCoverage(uplight, downlight, width, height);
    this.data.uplight = uplight;
    this.data.downlight = downlight;
    this.globalSource = source;
    return this.data;
  }

  /** Per-device override, keyed by MAC (preferred) or IP. Keys are canonicalised. */
  setDevice(key, uplight, downlight, width = 8, height = 8) {
    if (!key) throw new Error('setDevice requires a mac or ip key');
    matrix.validateCoverage(uplight, downlight, width, height);
    const k = canonicalKey(key);
    this.data.perDevice[k] = { uplight, downlight };
    return this.data.perDevice[k];
  }

  /**
   * Resolve regions for one fixture: per-device override wins over global.
   *
   * Discovery hands us `device.mac` uppercase-colon (`AA:BB:CC:DD:EE:FF`) while
   * the config stores lowercase-colon and callers may pass colon-less hex, so
   * both sides of the comparison go through normalizeMac() first. IPv4 keys are
   * compared verbatim, exactly as before.
   */
  forDevice(keys, width = 8, height = 8) {
    const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    const byMac = new Map(); // normalized mac -> stored key
    const verbatim = new Set(); // ips and anything not a mac
    for (const stored of Object.keys(this.data.perDevice)) {
      if (isIPv4(stored)) { verbatim.add(stored); continue; }
      const nm = matrix.normalizeMac(stored);
      if (nm) { if (!byMac.has(nm)) byMac.set(nm, stored); } else verbatim.add(stored);
    }
    for (const k of list) {
      let hitKey;
      if (isIPv4(k)) hitKey = verbatim.has(k) ? k : undefined;
      else {
        const nm = matrix.normalizeMac(k);
        hitKey = (nm && byMac.get(nm)) || (verbatim.has(k) ? k : undefined);
      }
      const hit = hitKey === undefined ? undefined : this.data.perDevice[hitKey];
      if (hit) {
        return { ...matrix.validateCoverage(hit.uplight, hit.downlight, width, height), source: `perDevice:${hitKey}` };
      }
    }
    return {
      ...matrix.validateCoverage(this.data.uplight, this.data.downlight, width, height),
      source: 'global',
    };
  }

  invert(width = 8, height = 8) {
    const up = matrix.invertRegion(this.data.uplight, width, height);
    const down = matrix.invertRegion(this.data.downlight, width, height);
    return this.setGlobal(up, down, width, height, 'inverted');
  }
}

module.exports = { Mapping, DEFAULT_MAP };
