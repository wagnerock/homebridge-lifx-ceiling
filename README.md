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

That split is compiled in as a constant — `CEILING_UPLIGHT_CELLS` in `lib/matrix.js` — so the plugin works out of the box on this model with no configuration. It is not a guess and there is nothing to tune: if a colour you commanded to the uplight shows up on the panel face, that is a bug to report, not a knob to turn.

Two earlier models were tried on these fixtures and are **wrong**: both drew the boundary by radius or by perimeter, and both landed colour on downlight LEDs — first as red at the edge midpoints, then as distinct dots *inside* the panel face. They failed for the same reason: the 8×8 grid is a square matrix mounted behind a round fixture, so any radial boundary snaps to a blocky rounded square and always catches a few panel cells. Corner cells have no such ambiguity — each cell is in exactly one half.

**There is no optical bleed between the halves.** A cell belongs to one half and lights only there. That is what makes this debuggable by eye: contamination is always a wrong cell, never diffusion.

**Verify by looking at the fixture.** `tileGetTileState64` read-back proves only what is in the fixture's *buffer*, not what lit up. A write can be accepted and still paint cells you did not intend, and a frame can be in the buffer while the panel is dark. The only proof is a photograph or your own eyes on the lit fixture.

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

The uplight/downlight split is a property of the product, not a preference: **cells
0, 7, 56, 63 are the uplight, the other 60 are the downlight panel**, compiled in as
`CEILING_UPLIGHT_CELLS` in `lib/matrix.js`. There is no schema key, no file, no path
and no per-fixture override that can move it. That is deliberate — the split was settled
on four separate fixtures by painting each half a different colour and looking at the
panel, and a setting whose only failure mode is a wrongly painted room with no undo is not
a feature.

Every boot prints one line naming what is in force, and it is always the same line:

```
geometry: uplight=4 corner cells [0,7,56,63] downlight=60 cells (fixed for pid 176/177)
```

**Other matrix products are unsupported.** This plugin models the LIFX Ceiling
(vendor 1, pid 176 US / pid 177 Intl) and nothing else; a matrix product it cannot model is
skipped at discovery rather than guessed at. That is a product decision, not a TODO. If you
want another product supported, open a hardware report with its pid and a photograph of what
lit up — `npm run doctor` prints both — and the geometry gets written into code and verified
for everyone.

## Diagnostics

```bash
npm run doctor            # versions, private-API presence, discovery, unicast, acked write round-trip
node bin/doctor.js 192.168.1.50
```

`doctor` is the one diagnostic this plugin ships. It reports the installed
`node-lifx-lan-multi` version and whether its private `_lifxLanUdp.request` is still there —
the API the ack-required tile write depends on. If a future release removes it, tile writes
silently fall back to un-acked, and this is the command that tells you. It prints the
geometry in force, checks that each ceiling answers broadcast and then a unicast request aimed
at it, and finishes with one acked svc-715 round-trip per ceiling that rewrites each
fixture's *current* colours — so the room looks exactly as it did while it runs. Non-ceiling
products are skipped by pid and by an empty tile chain, and a missing global `homebridge`
module is reported as INFO, because a plugin is installed as a dependency *of* Homebridge.

**Look at the fixture.** Paint one half red and the other blue, then walk in and see which
half is which — that single observation is what settled the geometry here. The plugin cannot
see your ceiling and does not try to.

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
- **Both halves share one physical power.** Switching one half "off" sets that half's brightness to 0; fixture power is only cut when *both* halves are off.
- **One accessory cannot be in two HomeKit rooms**, so uplight and downlight of the same fixture always live in the same room.
- **One 8×8 tile is addressed** (`tile_index: 0`). Multi-tile chains are not supported.
- **Only the LIFX Ceiling (pid 176/177) is supported.** The corner model is verified for that product and is not claimed for any other matrix product — a product it cannot model is skipped at discovery. That is a deliberate product decision, not a gap you can configure around; see "The geometry is not configurable".

## Troubleshooting

| symptom | cause and fix |
|---|---|
| Red or magenta on the downlight panel while the uplight is red | the corner model says the panel is cells other than 0, 7, 56, 63, and there is no optical bleed between the halves — so colour on the panel is a plugin bug, not diffusion. Run `npm run doctor`, note the pid, and open a hardware report with a photograph. |
| Uplight and downlight change together | both halves are being commanded to the same colour. Check you are operating two distinct tiles in Home.app (one is `… Uplight`, one `… Downlight`) and restart Homebridge; run `npm run doctor` to confirm the fixture answers and the split is the compiled-in one. |
| A light appears in Home.app twice, one always "No Response" | almost impossible since 1.1.0 — identity is the MAC, so an address change reuses the accessory. If you see it on a cache written before 1.1.0, restart Homebridge once so the MAC can be recorded, then remove the stale tile by removing and re-adding the bridge. Run `npm run doctor` to confirm the fixture answers. |
| Home.app tile says "No Response" and the ceiling is unreachable | the fixture is off the network or was powered off. The plugin counts 3 missed discovery cycles, logs that it is **keeping** the accessory and probes it by unicast — it never unregisters a light because discovery went quiet. |
| Colour commands appear to succeed but the ceiling never changes | you are writing through a helper that sends `ack_required: false` (the bundled library's `tileSetTileState64` does exactly this). Send svc 715 ack-required; a real write answers svc 45 or 3. |
| `svc 223` in the log | the fixture rejected the tile frame — usually a bad `width`/`length`/colour count or a wrong `tile_index`. `flush()` rejects rather than reporting success. |
| Wrong fixture name in Home.app | the accessory label comes from the LIFX label at publish time; rename it in Home.app, not in the LIFX app (re-discovery does not relabel a cached accessory). |
| Nothing is discovered | Discovery is multicast-only, so a LAN, VLAN or AP that blocks IGMP/multicast finds nothing — run Homebridge on the same subnet as the ceilings. Then check the fixture really is a Ceiling: `npm run doctor` prints every discovered device with its pid, `features.matrix` and tile chain, and only pid 176/177 with a populated tile are published. |

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

`lib/matrix.js` is pure and unit-tested. The LIFX dependency is loaded lazily so the test suite runs without hardware or `node_modules`.

## Credit

The zone-model question was settled by reading [Djelibeybi/hass-lifx-ceiling](https://github.com/Djelibeybi/hass-lifx-ceiling), a Home Assistant integration. This is an independent Homebridge implementation; it shares no code with it.

## License

MIT
