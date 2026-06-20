# OpenWrt / GL.iNet router recipe

> Collapse the show network onto **one hackable router**. Replaces the FritzBox
> (DHCP) + UniFi APs (WiFi, and their controller-adoption pain) with a single
> GL.iNet/OpenWrt box that satisfies the network contract in
> `network-and-modes.md`. Written for GL.iNet (the reproducibility tier) with the
> underlying OpenWrt UCI, so it works on any OpenWrt router.
>
> **Status: untested on hardware** (no OpenWrt box on hand) — verify on your
> router. Commands use confirmed UCI syntax but treat them as a starting point.

## What the router must provide

From the network contract:

1. **No internet uplink** — the LAN is sealed. (Just don't plug in WAN.)
2. **DHCP** on `192.168.178.0/24` (matching the laptop's hardcoded subnet).
3. An **SSID + password** the audience joins — these must equal the
   `WIFI_SSID` / `WIFI_PASSWORD` the WiFi-join QR encodes (defaults
   `assembly` / `assembly`).
4. The **laptop at a known IP** — `192.168.178.24` (the laptop's `HOST_IP` /
   `STATIC_IP`), via a DHCP reservation.
5. **(performance only)** all DNS resolves to the laptop — so phones reach
   `local.assembly.fm` (matching the Let's Encrypt cert) and the captive portal
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

## Recipe — workshop tier (no DNS-hijack)

Just an AP + DHCP, no internet:

```sh
# WiFi AP (match the WiFi-join QR creds)
uci set wireless.@wifi-iface[0].ssid='assembly'
uci set wireless.@wifi-iface[0].encryption='psk2'
uci set wireless.@wifi-iface[0].key='assembly'
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

## Cross-link

`network-and-modes.md` should link here from its hardware/contract section (left
for whenever the QR-onboarding branch and this land together, to avoid a merge
conflict on that file).
