# Changelog

All notable changes. Dates are the day the change went live on real hardware, not the
day it was typed — everything here was verified against four LIFX Ceilings before release.

## 1.2.0 — one geometry, compiled in; the lab goes out of the package

Built for the person who buys a LIFX Ceiling and wants two lights in Home.app. Everything
that could select a different — or a wrong — geometry is gone from the published plugin.

- **Removed `lib/mapping.js` and the `mappingFile` config key.** There is no file, no path
  and no per-fixture override for the half split any more. The geometry comes from
  `matrix.CEILING_UPLIGHT_CELLS` (`[0, 7, 56, 63]`) and `matrix.ceilingsDownlightCells()`
  and from nothing else. A setting whose only failure mode is a wrongly painted room with no
  undo is not a feature, and the schema no longer offers one: the five keys are `name`,
  `aliases`, `kelvinMin`, `kelvinMax`, `discoveryInterval`.
- **Removed the radial code from `lib/matrix.js`** — radius maths, disc/complement masks,
  seam-radius scanning, region parsing and region validation. The model is disproven on this
  hardware (it lands colour on downlight LEDs); the code that could select it is deleted, and
  what remains is the corner model verified by eye on four fixtures.
- **The calibration and probe tools no longer ship.** `bin/` is `doctor.js` only, and
  `package.json` publishes `bin/doctor.js` by name. `calibrate.js`, `region-color.js`,
  `split-color.js`, `all-red.js`, `restore.js`, `identify.js`, `state-read.js`, `diag.js`,
  `tileack.js`, `live-fixture.js` and `mapping.js` moved to the estate repo's
  `tools/lifx-lab/` — they stay as the archaeology that proves the corner model, out of the
  install path. An end user verifies by looking at the fixture and diagnoses with
  `npm run doctor`.
- Other matrix products are **unsupported by decision, not by omission**: anything the corner
  model does not describe is skipped at discovery, and the docs say so.

Unchanged, and still tested: hardware-MAC identity (`<mac>:<half>`, reuse by `context.hwMac`,
`rebindDevice`, preserved Lightbulb subtype), `aliases`, never unregistering a light because
discovery went quiet, unicast liveness probing, ack-required svc-715 writes with svc 223 as a
failure, power before matrix, and no `config/` directory in the package.

## 1.1.0 — identity is the hardware MAC
- **Accessory identity moved from the fixture IP to the hardware MAC.** `stableId` is now
  `<mac>:<half>` and the UUID is minted from that; the IP is transport state held on the
  fixture. **DHCP reservations are no longer required** — a fixture that renews onto a new
  address keeps its UUID, name, room and automations, and its handlers are rebound to the
  new address (`Fixture.rebindDevice`).
  Safe for existing installs: every cached accessory already carries `context.hwMac`, and
  caches that predate it still match on the old `<ip>:<half>` form. No UUIDs are re-minted.
- **Unicast liveness.** Broadcast silence no longer marks a fixture missing; unheard
  fixtures get a targeted `GetLightState` first, and only silence on both counts is a miss.
- **The Lightbulb service subtype is preserved.** With identity changing from IP to MAC,
  recomputing the subtype would have added a second Lightbulb service to every restored
  accessory, leaving the cached one talking to nothing. Whatever the accessory carries is
  now reused and recorded in `context.subtype`.
- `bin/doctor.js` (`npm run doctor`): installed versions, private-API presence, discovery,
  unicast reachability and an ack-required svc-715 round-trip per fixture.
- Un-acked tile writes now log at **error**, on every boot and every degraded write,
  naming the `node-lifx-lan-multi` version — never a once-per-process notice again.

## 1.0.4 — aliases rename the accessory
An explicit `aliases` entry renames the accessory itself, not just the service, because
Home.app labels a bridged tile from the accessory.

## 1.0.3 — site-local name aliases
Optional `aliases` (MAC → short name) in `config.json`. Without one, a name renamed in
Home.app survives restarts: `Name` is published only when the service is created.

## 1.0.2 — never unregister on quiet discovery
**Production incident fix.** At 17:54 broadcast discovery missed all four ceilings for
three cycles, `prune()` unregistered all eight accessories, and Home.app deleted the tiles
out of the user's rooms — unrecoverable room assignments and automations. Unreachability is
transient; deleting someone's home is not. `prune()` now counts and logs, and unregisters
nothing. The test that asserted the destructive behaviour is inverted.

## 1.0.1 — tooling writes are acked
`bin/all-red.js` and `bin/calibrate.js` route tile writes through `lib/tilewrite.js`.

## 1.0.0 — the geometry is a constant, not a setting
Removed `uplightRegion` / `downlightRegion` from the schema and the code; the verified
corner model is compiled in as `matrix.CEILING_UPLIGHT_CELLS = [0, 7, 56, 63]`, downlight
the other 60. `config/mapping.json` no longer ships, nothing writes into the installed
package, and `calibrate.js` requires `--map <path>` before it touches a fixture.
`mappingFile` stays as the per-fixture repair hatch.

## 0.x
First working version: two HomeKit lights per ceiling (uplight/downlight), full colour,
local LAN only, ack-required svc-715 tile writes, restored accessories rebound to live
handlers so cached tiles are not wired to dead characteristics.
