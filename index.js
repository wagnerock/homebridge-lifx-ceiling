'use strict';
/**
 * homebridge-lifx-ceiling
 *
 * Exposes each LIFX Ceiling on the LAN as one HomeKit accessory with two
 * independent full-colour lights — Uplight and Downlight. Local control only;
 * the LIFX cloud and the LIFX bridge are never contacted.
 *
 * Why this exists: every existing Homebridge LIFX plugin targets the legacy
 * Zones protocol. The Ceiling (vendor 1 pid 176/177) reports multizone:false
 * and answers only the Tile/matrix protocol, so those plugins see nothing.
 */

const { LifxCeilingPlatform } = require('./lib/platform');

module.exports = (api) => {
  if (!api || !api.hap) {
    throw new Error('homebridge-lifx-ceiling must be loaded by Homebridge 1.6+ (the api was not provided)');
  }
  api.registerPlatform('LifxCeiling', LifxCeilingPlatform);
};
