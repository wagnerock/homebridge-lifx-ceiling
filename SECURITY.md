# Security Policy

## What this plugin touches

- **Local LAN only.** Discovery is UDP broadcast on port 56700; control is unicast UDP to
  the fixture's address. It makes **no outbound internet requests**, contacts no LIFX
  cloud and no LIFX bridge, and requires no LIFX credentials.
- **No credentials are read or stored.** Configuration is a Homebridge platform block plus an
  optional repair file. Fixture MACs and addresses appear in logs — that is device
  identifiers on your own network, in your own Homebridge log file.
- **HomeKit writes** are limited to the Lightbulb services it publishes.

## Reporting a vulnerability

Open a [GitHub issue](../../issues) if the problem is not sensitive. For anything that
could be exploited against a running home, email the maintainer directly (see the
`author` field in `package.json`) and give 90 days before disclosure.

## Known hard edges

- Control frames are **unencrypted**: this is the LIFX LAN protocol, which is
  unauthenticated by design. Anyone on your subnet can drive the lights — that is true of
  every local LIFX tool, including the LIFX app's own LAN mode.
- The plugin depends on a **private** API (`device._lifxLanUdp.request`) in
  `node-lifx-lan-multi` to send acknowledged tile writes. `npm run doctor` reports the
  installed version and whether the API is present.
