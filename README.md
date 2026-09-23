# homebridge-lifx-ceiling

Split a **LIFX Ceiling** into two independent, full-colour HomeKit lights — **Uplight** and **Downlight** — over the LAN. No LIFX cloud, no LIFX bridge.

If Home.app shows your ceiling's uplight and downlight as one light and you cannot separate them, this plugin exists for you.

## Why another LIFX plugin

The LIFX Ceiling is **not** a multi-zone device. It reports `multizone: false` and answers only the **Tile / matrix** protocol. Every existing Homebridge LIFX plugin queries `get_color_zones`, which returns nothing on this hardware — which is why they either show the ceiling as a single light or fail entirely. This plugin speaks tiles.

## How it appears in Home.app

Two accessories per ceiling, one per half, each a full colour light (on/off, brightness, hue, saturation, colour temperature):

- `Ceiling Uplight`
- `Ceiling Downlight`

One accessory per half, deliberately: Home.app labels a tile from the accessory, not from each service, so two `Lightbulb` services on one accessory render as anonymous, indistinguishable tiles. Both halves are genuinely full-spectrum on this hardware, so neither is modelled as white-only.

## Install

Homebridge loads plugins from its own config directory, so install it there — a bare
`npm install -g` is invisible to a Homebridge running out of `~/.homebridge`:

```bash
cd ~/.homebridge
npm install homebridge-lifx-ceiling
```

On a Docker or launchctl-managed Homebridge, run the install inside that container's or
service's config directory instead (`$HOMEBRIDGE_CONFIG_DIR`).

Add to `~/.homebridge/config.json` (every address below is an example — use your own):

```json
{
  "platforms": [
    {
      "platform": "LifxCeiling",
      "name": "LIFX Ceilings"
    }
  ]
}
```

Restart Homebridge, then add the new lights in Home.app. Discovery is **multicast UDP only**, so Homebridge must sit on the same subnet (or have mDNS/UDP 56700 forwarded) as the ceilings — see Troubleshooting.

## The corner model

**Verified on hardware (vendor 1, pid 176 US / pid 177 Intl):** the uplight is driven by the **four corner cells** of the 8×8 matrix and the downlight by the other 60.

```
uplight  = cells 0, 7, 56, 63          # the four corners
downlight = the other 60 cells
```

That split is compiled in as a constant — `CEILING_UPLIGHT_CELLS` in `lib/matrix.js` — so the plugin works out of the box on this model with no configuration. It is not a guess and you should not try to "calibrate it away": if a colour you commanded to the uplight shows up on the panel face, that is one cell mis-assigned on that fixture, and the fix is the per-fixture repair file below — not a radial mask.

Two earlier models were tried on real fixtures and are **wrong**:

| model | what it claimed | what happened on the fixture |
|---|---|---|
| `ring` / `core` | the perimeter is the uplight | red landed on downlight LEDs at the edge midpoints |
| `annulus@0.88` / `disc@0.88` | a chamfered ring outside r=0.88 | red appeared as distinct dots *inside* the panel face |

Both failed for the same reason: they put cells inside the panel face in `uplight`. The 8×8 grid is a square matrix mounted behind a round fixture, so any radial threshold snaps to a blocky rounded square and always catches a few panel cells. Corner cells have no such ambiguity — each cell is in exactly one half.

**There is no optical bleed between the halves.** A cell belongs to one half and lights only there. That is what makes this debuggable by eye: contamination is always a mapping error, never diffusion.

**Verify by looking at the fixture.** `tileGetTileState64` read-back proves only what is in the fixture's *buffer*, not what lit up. A write can be accepted and still paint cells you did not intend, and a frame can be in the buffer while the panel is dark. The only proof is a photograph or your own eyes on the lit fixture — which is exactly what `bin/calibrate.js` and `tools/*.py` are there to give you.

## Tile writes require `ack_required: true`

The bundled dependency's own `tileSetTileState64()` helper sends `ack_required: false`. On these ceilings that frame **vanishes without an error** — the call resolves, the buffer is untouched, nothing on the ceiling changes, and no exception is thrown. It is the single most confusing failure mode on this hardware.

So every tile write in this plugin goes out raw as **service 715 (`Tile::SetTileState64`) with `ack_required: true`** over the driver's UDP socket. A good write answers service 45 (`LightState`) or service 3 (`Ack`); a rejected one answers **service 223**, and `flush()` rejects instead of reporting a silent success. If you write your own tile code against `node-lifx-lan-multi`, do not trust a resolved promise.

## Identity is the hardware MAC — no DHCP reservations required

**Since 1.1.0.** Accessory identity is the fixture's hardware MAC: `stableId` is
`<mac>:up` / `<mac>:down` and the UUID is minted from that. The IP is transport state — it
lives on the fixture object and is re-chosen every discovery cycle.

So when a ceiling renews onto a new address, Home.app does not see anything happen. Same
UUID, same name, same room, same automations; the log says so:

```
[identity] hwMac a1b2c3d4e5f6 is answering on 192.168.1.190; accessories published on 192.168.1.166 are reused by MAC. Same accessory, same UUID, same room — only the transport moved, no action needed.
[<mac>] transport moved 192.168.1.166 -> 192.168.1.190; accessory and UUID unchanged
```

**Why this is safe to change, and was not before:** every accessory written by earlier
versions already stores `context.hwMac`, so existing installs are matched by MAC on the
next boot and keep their cached UUIDs untouched — the migration is a lookup change, not a
re-mint. Caches that predate `hwMac` fall back to matching on the old `<ip>:<half>` form,
and those keep working too.

**A DHCP reservation is still a nice thing to have** — tidier logs, marginally faster
reconnects after a power cycle. It is no longer a requirement, and a fixture that moves
will not produce a duplicate tile.

**What still cannot be undone remotely:** if `~/.homebridge/accessories/cachedAccessories`
is deleted, UUIDs are minted fresh from the MAC and will not match the ones Home.app
remembers. That is true of every Homebridge plugin, and reservations never saved you from
it either.

## Configuration

| key | default | meaning |
|---|---|---|
| `name` | `LIFX Ceilings` | platform name |
| `aliases` | unset — tiles are named from the fixture's own LIFX label | **site-local short names**, keyed by MAC: `{ "aa:bb:cc:dd:ee:ff": "SW" }` publishes `SW Uplight` and `SW Downlight`. Case and `:` separators in the key are free; a MAC survives an IP change, so it beats keying by address. A key that is not a MAC is refused with a named warning. See "Naming" below |
| `mappingFile` | unset | **optional, repair only** — path to your own mapping file for a fixture that behaves differently. See "Repairing one fixture" |
| `discoveryInterval` | `300` | seconds between discovery cycles (minimum 60) |
| `kelvinMin` / `kelvinMax` | `1500` / `9000` | white range the fixture may use. Clamped in software *and* published to HomeKit as the colour-temperature limits, so Home.app will not offer a white the panel cannot make |

### Naming, and what Homebridge cannot do about rooms

A tile's name is `<base> Uplight` / `<base> Downlight`, where `<base>` is, in order:

1. your `aliases` entry for the fixture's MAC,
2. the label the fixture carries — set it in the LIFX app and the tiles follow it,
3. `LIFX Ceiling <ip>`, when the fixture reports no label.

Without `aliases`, a name you rename in Home.app is **left alone across restarts** — the
plugin publishes a name only when it creates the service. With `aliases` set, that name is
republished every boot, because you asked for it in config and config should win over a
label the plugin invented.

**Rooms are not ours to set.** Room membership lives in the HomeKit home database on your
hub, not in the accessory, and HAP exposes no attribute for it — so every bridge plugin's
new tiles land in Default Room, without exception. Move them with Siri (`Move SW Uplight
to the Living room room`) or long-press → Move to Room in Home.app.

### The geometry is not configurable — on purpose

Earlier versions of this schema offered `uplightRegion` and `downlightRegion`. They are
**gone**, and they will not do anything if you leave them in `config.json` — the code no
longer reads them. That is deliberate: the geometry above is a property of the product,
verified on four separate fixtures, and a wrong pair of lists repaints the room with no
undo. A setting that can only be wrong is not a feature.

Every boot prints one line naming what is in force:

```
mapping: uplight=4 corner cells [0,7,56,63] downlight=60 cells source=default
```

`source` is `default` (the compiled-in corners) or `mappingFile` when you supply the
file below.

### Repairing one fixture

The only override is a mapping file you point at with `mappingFile`. No file ships and
none is needed; use it when *one* ceiling differs — a swapped cell, or a firmware that
lights something else:

```json
{
  "perDevice": {
    "aa:bb:cc:dd:ee:ff": {
      "uplight": [0, 7, 56, 63],
      "downlight": [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 57, 58, 59, 60, 61, 62]
    }
  }
}
```

- Keys are matched by **normalised MAC**, so upper/lower case and `:` separators all hit.
- `perDevice` outranks the file's global `uplight`/`downlight`, which outrank the built-in default.
- If a commanded uplight colour shows up as distinct dots *inside the panel*, one or more panel cells are in the `uplight` list — move those indices to `downlight`. Do not widen a radius.
- An unreadable or malformed file is logged and ignored: the fixture keeps working on the built-in corners.

If you had `mappingFile` set to the file this plugin used to ship, you can delete the key.

### The mapping file (reference)

```json
{
  "uplight": [0, 7, 56, 63],
  "downlight": [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 57, 58, 59, 60, 61, 62],
  "perDevice": {
    "aa:bb:cc:dd:ee:ff": {
      "uplight": [0, 7, 56, 63],
      "downlight": [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 57, 58, 59, 60, 61, 62]
    }
  }
}
```

- `uplight` / `downlight` must not overlap and must together cover all 64 cells, or the mapping is refused with a precise error.
- A region is either an explicit index array or a radial string (`disc@0.88`, `annulus@0.88`, `ring`, `core`, `all`). **Index arrays are the verified shape** — use a radial string only if you have measured your own fixture and want the blocky approximation it produces. Inside this file `ring`/`core` still resolve, for per-fixture experiments; they are the disproven model — the corners are the shape that is verified.
- `perDevice` keys are MACs (preferred — MACs survive an IP change within one Homebridge install) or IPs. Keys are canonicalised to lowercase colon form, and any input shape (`AA:BB:CC:DD:EE:FF`, `aabbccddeeff`, `aa:bb:cc:dd:ee:ff`) resolves to the same fixture. IPv4 keys are matched verbatim and never mistaken for MACs.
- Your fixtures' addresses belong in *your* mapping file, never in the published package: set `mappingFile` to a path outside the plugin directory.
- The mapping is read once at startup. Restart Homebridge after editing it.

## Diagnostics

```bash
npm run doctor            # versions, private-API presence, discovery, unicast, acked write round-trip
node bin/doctor.js 192.168.1.50
```

`doctor` reports the installed `node-lifx-lan-multi` version and whether its private
`_lifxLanUdp.request` is still there — the API the ack-required tile write depends on. If
a future release removes it, tile writes silently fall back to un-acked, and this is the
command that tells you. The svc-715 check rewrites each fixture's *current* colours, so
the room looks exactly as it did while it runs.

Every tool in `bin/` is run with `node bin/<tool>.js <fixture>`; only `shot.sh` and
`sweep-seam.sh` are executable directly.

## Calibration and the measurement tools

These are the reason this plugin works on hardware nobody documented. Everything takes the fixture address as an argument; nothing has your address baked in.

```bash
node bin/calibrate.js 192.168.1.50              # interactive: which half went red?
node bin/calibrate.js 192.168.1.50 --answer up  # non-interactive
node bin/calibrate.js --invert                    # flip the current global mapping
```

`bin/calibrate.js` paints two colours, holds them long enough to see, records the answer, and restores your original colour and power in a `finally` block.

To settle a seam or a suspect cell, hold one state and shoot it:

```bash
CAM=rtsp://10.0.0.60/live0 ./bin/shot.sh 192.168.1.50 up up.jpg
python3 tools/measure.py up.jpg --label up
```

`CAM` is required — there is no default camera. `tools/*.py` turn "is some of the downlight on?" into a number: radial luminance profiles, red→blue handover radius, per-ring contamination. Use them if you are chasing a seam on a fixture that behaves differently from the corner model; do not use them to second-guess the four corners, which are settled.

Colour, not brightness, is the measurement: a camera's auto-exposure normalises the scene, so absolute luminance from an uncalibrated webcam is worthless (a fully-lit and a fully-dark frame have both measured the same mean here). Hue survives auto-exposure — hence red uplight, blue downlight.

## Compatibility

**Verified on**

| Fixture | How |
|---|---|
| LIFX Ceiling US (vendor 1, pid 176), firmware 4.112 | discovery, `tileGetDeviceChain`, `tileGetTileState64`, ack-required `Tile::SetTileState64` (svc 715) landing on the fixture |
| Four separate fixtures in one home, through Home.app | 8 tiles controlled individually, rooms and automations surviving an identity change to MAC-based (1.1.0) |
| Homebridge 2.4.0 on node 24.21, `hb-service` under systemd | boots clean: `8 light(s) live`, zero duplicate warnings |
| Uplight = cells 0, 7, 56, 63; downlight = the other 60 | painted each half a different colour and read the fixture face; no bleed between halves |

**Not verified on**

- LIFX Ceiling Intl (pid 177) — same matrix protocol and the same model in the firmware family, but not personally confirmed on one
- Homebridge < 1.6, Node < 18
- Ceilings with more than one populated tile in the chain (`tile_index: 0` only)
- Ceiling White / any white-only variant — both halves here are full-colour

## Known limitations

- **Manual changes made elsewhere are not auto-detected.** HomeKit state is served from an in-memory cache (a side effect of the two-half architecture — Homebridge must answer reads instantly and cannot block on UDP), so a change made from the LIFX app or a wall switch will not appear in Home.app until Homebridge restarts.
- **Both halves share one physical power.** Switching one half "off" sets that region's brightness to 0; fixture power is only cut when *both* halves are off.
- **One accessory cannot be in two HomeKit rooms**, so uplight and downlight of the same fixture always live in the same room.
- **One 8×8 tile is addressed** (`tile_index: 0`). Multi-tile chains are not supported.
- The corner model is verified for the LIFX Ceiling (pid 176/177). It is not claimed for any other matrix product — if yours differs, calibrate and pin it in `perDevice`.

## Troubleshooting

| symptom | cause and fix |
|---|---|
| Red or magenta on the downlight panel while the uplight is red | a cell inside the panel face is listed in `uplight`. Identify the index and move it to `downlight`. There is no optical bleed, so this is always a mapping error — never diffusion. |
| Uplight and downlight change together | both halves are resolving to the same region. Check `mappingFile` is the file you think it is, and that `uplight`/`downlight` do not both claim the same cells; restart Homebridge. |
| A light appears in Home.app twice, one always "No Response" | almost impossible since 1.1.0 — identity is the MAC, so an address change reuses the accessory. If you see it on a cache written before 1.1.0, restart Homebridge once so the MAC can be recorded, then remove the stale tile by removing and re-adding the bridge. Run `npm run doctor` to confirm the fixture answers. |
| Home.app tile says "No Response" and the ceiling is unreachable | the fixture is off the network or was powered off; the plugin prunes it after 3 missed discovery cycles. |
| Colour commands appear to succeed but the ceiling never changes | you are writing through a helper that sends `ack_required: false` (the bundled library's `tileSetTileState64` does exactly this). Send svc 715 ack-required; a real write answers svc 45 or 3. |
| `svc 223` in the log | the fixture rejected the tile frame — usually a bad `width`/`length`/colour count or a wrong `tile_index`. `flush()` rejects rather than reporting success. |
| Wrong fixture name in Home.app | the accessory label comes from the LIFX label at publish time; rename it in Home.app, not in the LIFX app (re-discovery does not relabel a cached accessory). |
| Nothing is discovered | Discovery is multicast-only, so a LAN, VLAN or AP that blocks IGMP/multicast finds nothing — run Homebridge on the same subnet as the ceilings. Then check the fixture really is a Ceiling: `node bin/diag.js <label>` prints every discovered device with its pid and `features.matrix`, and only pid 176/177 with a populated tile are published. |

## The API gotchas this plugin works around

If you are writing your own LIFX tile code against `node-lifx-lan-multi`, these five cost real debugging time:

1. Parameters are **snake_case** — `tile_index`, not `tileIndex`. CamelCase silently returns `null`.
2. Colours are **normalised floats 0.0–1.0** for hue, saturation *and* brightness. Hue is **not** 0–360. HomeKit's 0–360 must be divided by 360.
3. `tileGetTileState64` resolves to an **array** of `{ tile_index, x, y, width, colors }`. The key is `colors`, never `palette`.
4. `kelvin` is **absolute** and **required** on all 64 colour objects of every write.
5. Tile writes must be **ack-required** (svc 715 raw). See above — an un-acked write is indistinguishable from a successful one.

## Development

```bash
npm test          # zero dependencies, no hardware needed
node -e "require('./index.js')"
```

`lib/matrix.js` and `lib/mapping.js` are pure and unit-tested. The LIFX dependency is loaded lazily so the test suite runs without hardware or `node_modules`.

## Credit

The zone-model question was settled by reading [Djelibeybi/hass-lifx-ceiling](https://github.com/Djelibeybi/hass-lifx-ceiling), a Home Assistant integration. This is an independent Homebridge implementation; it shares no code with it.

## License

MIT
