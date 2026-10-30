# OpenWrt / GL.iNet router recipe

> Collapse the show network onto **one hackable router**. Replaces the FritzBox
> (DHCP) + UniFi APs (WiFi, and their controller-adoption pain) with a single
> GL.iNet/OpenWrt box that satisfies the network contract in
> `network-and-modes.md`. Written for GL.iNet with the underlying OpenWrt UCI,
> so it works on any OpenWrt router. Hardware selection and the radio-count
> rungs live in `network-and-modes.md` §Hardware — radios, not tiers.
>
> **Status: untested on hardware** (no OpenWrt box on hand) — verify on your
> router. Commands use confirmed UCI syntax but treat them as a starting point.

## What the router must provide

From the network contract:

1. **No internet uplink** — the LAN is sealed. (Just don't plug in WAN.)
2. **DHCP** on `192.168.178.0/24` (matching the laptop's hardcoded subnet).
3. An **SSID + password** the audience joins — these must equal the
   `WIFI_SSID` / `WIFI_PASSWORD` the WiFi-join QR encodes (defaults
   `tambourine` / `tambourine`).
4. The **laptop at a known IP** — `192.168.178.24` (the laptop's `HOST_IP` /
   `STATIC_IP`), via a DHCP reservation.
5. **(performance only)** all DNS resolves to the laptop — so phones reach
   `local.tamb.fm` (matching the Let's Encrypt cert) and the captive portal
   auto-pops.

Why DNS-hijack is performance-only: **workshop** serves over the LAN IP with a
self-signed cert and hands out the URL via the synth QR — phones never resolve a
name, so no hijack is needed. Only **performance** (domain-bound cert + captive
auto-pop) needs all DNS → laptop.

The **captive portal stays on the laptop** — once all DNS points at it, the
existing `server.ts` handler intercepts the connectivity-check probes. No router
captive software (openNDS) required.

## Subnet alignment (do this first)

The laptop hardcodes `SUBNET=192.168.178` and `STATIC_IP=192.168.178.24`
(`start-macos.sh`), and `HOST_IP` defaults to `192.168.178.24` (`server.ts`).
GL.iNet ships on `192.168.8.1`, so move the router's LAN to match:

```sh
uci set network.lan.ipaddr='192.168.178.1'
uci set network.lan.netmask='255.255.255.0'
uci commit network && /etc/init.d/network restart
```

> This moves the router's own admin UI to `192.168.178.1`. Reconnect there
> afterwards. (Alternatively, change the laptop's subnet — but it's hardcoded in
> `start-macos.sh`, so moving the router is easier.)

## Access (GL.iNet)

GL.iNet runs OpenWrt. SSH in and run UCI directly:

```sh
ssh root@192.168.8.1        # default; use 192.168.178.1 after the subnet change
```

(Some of this is also reachable in the GL.iNet web UI, but UCI is the portable,
copy-pasteable path that works on any OpenWrt box.)

## The ground-floor topology (assumed by every recipe below)

```
[laptop] ──ethernet──> [router · LAN port]
                            ⋮
                         WiFi ))) phones
                       [WAN port — empty, deliberately]
```

The laptop is **always wired into the LAN port**, never joined over WiFi. Two
reasons, in this order:

1. **It makes the architecture legible.** The cable shows there is a server and
   that it is separate from the audience. A laptop hidden among the WiFi
   clients teaches nothing about the structure it is running.
2. It stops the server contending for airtime with the audience it serves.

The **WAN port is never plugged in** — that is what "no uplink" means
physically, and the empty socket is the clearest statement of what the local
register is.

A travel router's single LAN port is therefore exactly sufficient at ground
floor: the laptop takes it, and nothing else is wired. A switch appears only at
the performance tier, when a second AP needs feeding.

Adding a second radio does not change this shape: the second AP runs as a
**dumb AP** (DHCP off, LAN bridged, same SSID, different channel) wired to a
spare LAN port, or to a switch if the router has only one.

Reference hardware: **GL.iNet Beryl AX (GL-MT3000)**. Its WAN port can be
reassigned as a second LAN port ("Change to LAN", under Internet → Ethernet),
so the second radio needs no switch — laptop on one LAN port, dumb AP on the
other. See `network-and-modes.md` §Hardware — radios, not tiers for the rungs,
the plenum-n table, and the USB-ethernet-adapter warning that now applies to
every practitioner.

## Recipe — workshop tier (no DNS-hijack)

Just an AP + DHCP, no internet:

```sh
# WiFi AP (match the WiFi-join QR creds)
uci set wireless.@wifi-iface[0].ssid='tambourine'
uci set wireless.@wifi-iface[0].encryption='psk2'
uci set wireless.@wifi-iface[0].key='tambourine'
uci set wireless.radio0.disabled='0'
uci commit wireless && wifi reload
```

DHCP is on by default on `lan`; leave WAN unplugged. On the laptop:
`./start-macos.sh workshop`. Phones scan the **WiFi-join QR** to join, then the
**synth QR** to open `https://<laptop-lan-ip>:8443/` and tap through the
self-signed warning.

## Recipe — performance tier (adds reservation + DNS-hijack)

Everything above, plus:

```sh
# Reserve the laptop at the IP the cert/captive flow expects
uci add dhcp host
uci set dhcp.@host[-1].name='assembly-server'
uci set dhcp.@host[-1].mac='AA:BB:CC:DD:EE:FF'   # <-- the laptop's WiFi/eth MAC
uci set dhcp.@host[-1].ip='192.168.178.24'

# Resolve ALL domains to the laptop (the same hijack the laptop's dnsmasq does)
uci add_list dhcp.@dnsmasq[0].address='/#/192.168.178.24'
# Wildcard records trip rebind protection — turn it off
uci set dhcp.@dnsmasq[0].rebind_protection='0'

uci commit dhcp && /etc/init.d/dnsmasq restart
```

On the laptop: `./start-macos.sh performance`.

> **Redundant laptop dnsmasq (known, harmless):** `start-macos.sh performance`
> still launches the laptop's own `dnsmasq`, and `server.ts` checks DNS against
> `127.0.0.1:53`. Clients don't use it — they use the router's DNS — so it's just
> idle. Removing it (so the router *fully* owns DNS) is the deferred laptop-side
> follow-up; until then, leave it running.

## How it maps to the contract & modes

| Contract clause | UCI | Modes |
|---|---|---|
| No uplink | WAN unplugged | all |
| DHCP on the show subnet | default `lan` DHCP | workshop, performance |
| SSID = QR creds | `wireless … ssid/key` | workshop, performance |
| Laptop at a known IP | `add dhcp host … ip` | performance (workshop: any LAN IP) |
| All DNS → laptop | `add_list … address='/#/<ip>'` | **performance only** |

## Deferred follow-up (out of scope here)

The laptop-side decoupling: make `performance` stop launching its own `dnsmasq`
and stop enforcing the static IP when the router owns DNS, and update the
`server.ts` DNS check to probe via the router rather than `127.0.0.1:53`. That's
the point at which the laptop truly becomes "a server at a known IP."

## Friction: router setup needs an agent today (Thomas, 2026-10-30)

Setting up the Beryl AX for the 2026-10-31 gig took an LLM agent at every step.
Other people must be able to do this without one. Fix it with automation,
copious scaffolding, or both.

Where the friction was:
- **Hidden prerequisite: the cert.** There was no cert for the default
  `HOST_DOMAIN` (`local.tamb.fm`), and nothing said so until a reviewer dug
  through `/etc/letsencrypt`. The repo `cert.pem` had expired silently.
  `start-macos.sh` should check the cert's domain and expiry before anything
  else, and say what to run.
- **The GUI has many settings and few answers.** Each one needed a judgement
  call: 160 MHz dynamic bandwidth (no, because DFS), the channel (36–48),
  TX power, the DNS mode (Automatic, not Encrypted), "override DNS for all
  clients" (on), and rebind protection (off). None of it is written down as a
  click-through.
- **The subnet move.** The router ships as `192.168.8.1`; we need
  `192.168.178.1/24` and a DHCP pool that leaves `.24` free. Changing it drops
  the admin session.
- **The DNS hijack needs SSH and `uci`.** That is fine for us and a wall for
  most people.
- **Verification is scattered.** It used `dig @192.168.178.1 captive.apple.com`,
  the server banner, and a phone test. Nothing runs them together.

Directions (not decided):
- **Automation:** a `router-setup` script that SSHes in once at the factory
  default and applies everything (SSID/key, channels, widths, subnet, DHCP
  pool, reservation, hijack, rebind), then verifies. Or one pasteable `uci`
  block. Plus a `doctor`/preflight that checks the cert, the subnet, DNS and
  the laptop IP.
- **Scaffolding:** a printed, screenshot-level GL.iNet click-through, one
  setting per line with the value and a one-line why. A known-good backup of
  the router config to restore. A labelled, pre-configured router as the
  default thing to hand someone.

## Cross-link

`network-and-modes.md` should link here from its hardware/contract section (left
for whenever the QR-onboarding branch and this land together, to avoid a merge
conflict on that file).
