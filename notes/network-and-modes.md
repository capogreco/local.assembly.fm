# Network, modes, and hardware

> Design note for the lines release. Defines what "hardware-agnostic" actually
> means for this project, names the three run modes, and records the hardware
> tiers. Pairs with the `MODE` refactor in `server.ts` / `start-macos.sh`
> (not yet implemented — this doc is the spec it should satisfy).

## Why this exists

"Make it hardware-agnostic" hides two different problems wearing one costume:

- **The network contract** — pure infrastructure (DHCP, DNS, no uplink). Cheap,
  reproducible, satisfiable by any access point. This is genuinely
  hardware-agnostic.
- **The trust contract** — a domain you control plus a CA-trusted cert for it.
  *Not* hardware, *not* free, *not* reproducible by copying someone's rig. This
  is the hidden asterisk on "agnostic," and it only bites when you put real
  audience phones on the network.

Conflating them is the trap. The two contracts are documented separately below,
and the three run modes exist precisely so the heavyweight trust requirements
are quarantined to the one mode that actually needs them.

---

## The network contract

Any access point / router works if it can make these three things true:

1. **No internet uplink.** The LAN is sealed. (Round-trip latency on local
   5 GHz is what makes control feel immediate; an uplink only invites trouble.)
2. **DHCP hands out the server's IP as the DNS server.** Clients ask the laptop
   for DNS.
3. **All DNS resolves to the server's IP.** Every domain → the laptop. This is
   what lets the captive portal catch connectivity-check probes and redirect.

That's it. Satisfy those and the brand of AP is irrelevant. The decoupling goal
is to push roles 2–3 *down into the router* (OpenWrt/MikroTik do this natively
in a text config) so the laptop stops running `dnsmasq` and stops enforcing a
specific static IP — it becomes "a server at a known IP," nothing more.

---

## The trust contract

This is the part that isn't hardware. The dependency chain is forced, link by
link:

- The synth client uses **AudioWorklets**, which only exist in a **secure
  context** → HTTPS is mandatory for any multi-device use.
  - *Exception:* `localhost` counts as a secure context even over plain HTTP.
    This is why `practice` mode needs no cert at all.
- A secure context that **uncontrolled audience phones** will accept needs a
  **publicly trusted cert** — you cannot ask 100 strangers to tap through a
  warning, and iOS's Captive Network Assistant won't even offer the bypass for
  an untrusted cert.
- Public CAs **cannot issue for private IPs or `.local` names** → you must own a
  **real registered domain**.
- An offline LAN has no inbound internet → **DNS-01 is the only usable ACME
  challenge** → issuance/renewal is tied to owning the domain and scripting the
  registrar (Namecheap, per `dev_log.md`).

So: *AudioWorklet → HTTPS → trusted cert → real domain → DNS-01 → registrar.*
None of those links is hardware, and none is free.

### Renewal fragility (performance only)

Let's Encrypt certs expire every 90 days and DNS-01 renewal needs internet — but
the performance LAN has no uplink, so **renewal can never happen at the venue.**
A forgotten renewal is a dead show with no on-site recovery. Renew at home (or
briefly tether the laptop) before load-in. This risk is isolated to
`performance` mode by design.

---

## The three modes

One explicit `MODE` switch replaces today's split-brained inference (cert-file
presence + `start-macos.sh` subcommand). The modes track *who the audience is*,
not *where it runs*.

| Axis | `practice` | `workshop` | `performance` |
|---|---|---|---|
| Audience | just you | small, consenting group | public strangers |
| Musician's sense | solo woodshedding | workshopping a piece | the show |
| Bind | `localhost` only | `0.0.0.0` (LAN) | `0.0.0.0` (LAN) |
| Ports | `8443` (no sudo) | `8443` (no sudo) | `80` + `443` (**sudo**) |
| Cert | none needed | self-signed, auto-generated | Let's Encrypt — required |
| Clients reach it via | `http://localhost:8443` | `https://<server-ip>:8443/` + tap through warning | `https://<domain>/`, auto-pop |
| Captive portal | off | off | **on** |
| DNS-hijack / dnsmasq | off | off | **required** |
| Static IP / subnet check | off | off (any LAN IP) | enforced |
| dnsmasq-absent warning | silent | silent | active |

### `practice`

Solo, laptop only. Patch building and testing the box set. Binds
`localhost:8443` on high ports, so **no `sudo`, no cert, no network hardware** —
`localhost` is a secure context, so AudioWorklets just work over plain HTTP.
Genuinely zero-setup. (Replaces today's `local` subcommand, which despite the
name ran the full server and only skipped the dnsmasq/subnet bringup.)

### `workshop`

Real phones on a LAN, for a small group you can talk to. Binds `0.0.0.0:8443`
(**no `sudo`** — unprivileged port) with a **self-signed cert auto-generated on
first run** (SANs: `localhost`, `127.0.0.1`, and the detected LAN IP).
Participants open `https://<server-ip>:8443/` and tap through the one-time
warning — **no domain, no dnsmasq, no captive portal, no sudo.** You hand out the
IP instead of relying on the auto-pop. This is the mode that makes the
instrument reproducible for the community: an AP and nothing else.

> Cost of by-IP addressing: the URL is an ugly IP and a SAN mismatch warning is
> possible if the LAN IP differs from generation time. Acceptable — participants
> tap through regardless.

### `performance`

Public audience on uncontrolled phones. The only mode that earns the full
weight: **Let's Encrypt cert for a real domain (required — fail loud if
missing), captive portal on, DNS-hijack required, static IP enforced, ports
80+443, and the only mode that needs `sudo`.** This is also the only mode
carrying the 90-day renewal ritual. When
the router eventually owns DNS-hijack (see decoupling goal), the laptop-dnsmasq
requirement drops out of *this* mode without touching the other two.

---

## Implementation notes (for the refactor that follows this doc)

- Add `MODE` (env var or `start-macos.sh` arg), **default `practice`** (the safe,
  no-privilege mode). `server.ts` branches on it for bind host, ports,
  captive-portal activation, dnsmasq warning, and cert policy.
- Retire the two implicit signals: cert-file presence no longer *means* a mode
  (`server.ts:1009`–`1075`); `performance` requires a real cert and refuses to
  boot without one; `practice`/`workshop` never look for Let's Encrypt and
  auto-generate a self-signed cert when needed.
- `start-macos.sh`: rename `local` → `practice`; add `workshop`; `dev`/default →
  `performance`. Move `detect_network`, `STATIC_IP` enforcement, and the dnsmasq
  launch *inside the performance branch only*. `sudo` is needed *only* for
  `performance` (the other two bind unprivileged `8443`).
- **Watch/auto-reload is orthogonal to mode** — a flag any mode can take, not a
  fourth mode. (Today `dev` is performance+watch; split them.)
- Only `performance` mounts the port-80 captive listener (`portalHandler`,
  `server.ts:781`). `practice`/`workshop` serve a single app handler on `8443`;
  the CNA-probe redirect doesn't exist in those modes.
- **Portability:** the `MODE` switch and all binding/cert-policy logic live in
  `server.ts` so `MODE=… deno run server.ts` works on any OS. `start-macos.sh`
  stays a macOS convenience wrapper. Self-signed cert generation
  (`genSelfSignedCert`) is **pure-Deno** — WebCrypto (RSA-2048) + `@peculiar/x509`,
  no `openssl`, no system tool; deps are lazy-imported so only workshop loads them
  and are pinned via `deno.lock` (`deno task setup` installs them once online).
  RSA, not EC: Deno's rustls rejected LibreSSL's EC keys with `KeyMismatch`.
- Existing config knobs already present and reused: `HOST_IP`, `HOST_DOMAIN`
  (`server.ts:23`–`24`).

---

## Hardware tiers

Two orthogonal axes: the *mode* (above) is about trust/audience; the *tier*
below is about the AP. They combine freely.

### Reproducibility tier (the lines on-ramp)

**GL.iNet Flint 2 (GL-MT6000), ~$130.** Ships *with* OpenWrt, so `hostapd` +
`dnsmasq` are in `/etc/config` — the entire network contract becomes one UCI
snippet a reader pastes in. WiFi 6, 8-stream MU-MIMO/OFDMA. Perfect for the 5–40
phones a community member will actually have. Controller-free, cheap, portable.

### Performance tier (your ~100-phone shows)

**Split across 2+ APs — don't trust one box.** The honest density picture:
Meraki's own high-density guidance caps WiFi 6 APs at ~75–100 clients per radio
*under good conditions*; the MikroTik forum has no real-world reports of 50–100
active phones on the newer `wifiwave2` driver. So at 100 phones:

- **2× GL.iNet Flint 2 on one SSID** — matches your current two-AP topology while
  being fully hackable and controller-free.
- **MikroTik (hAP ax3 / cAP ax)** — RouterOS is scriptable with no controller and
  has a built-in hotspot/captive-portal feature; better density headroom, steeper
  learning curve. The upgrade path if 2× GL.iNet isn't enough.

Either kills the UniFi-controller dependency (U6+ won't broadcast an SSID until
adopted — see `dev_log.md`). UniFi's only real advantage was density, which you
were already solving with *two* APs.

### Sources

- [GL.iNet Flint 2 (GL-MT6000)](https://store.gl-inet.com/products/flint-2-gl-mt6000-wi-fi-6-high-performance-home-router)
- [Meraki high-density design](https://documentation.meraki.com/Wireless/Design_and_Configure/Architecture_and_Best_Practices/Approximating_Maximum_Clients_per_Access_Point)
- [MikroTik hAP ax3 client-count thread](https://forum.mikrotik.com/t/how-many-clients-can-be-connected-to-hap-ax3/170323)
- [MikroTik HotSpot / captive portal docs](https://help.mikrotik.com/docs/spaces/ROS/pages/56459266/HotSpot+-+Captive+portal)
- [OpenWrt / openNDS walled garden](https://opennds.readthedocs.io/en/stable/walledgarden.html)
</content>
</invoke>
