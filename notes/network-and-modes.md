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

## Onboarding (QR)

Audience onboarding has two friction hops — **join the WiFi**, then **reach the
synth** — and QR codes kill both *without* DNS-hijack or a captive portal:

- **WiFi-join QR** (`WIFI:T:WPA;S:<ssid>;P:<password>;;`) — scan → "join network"
  (iOS 11+/Android). Creds come from `WIFI_SSID`/`WIFI_PASSWORD`/`WIFI_AUTH`
  (default `assembly`/`assembly`/`WPA`).
- **Synth-URL QR** — the per-mode audience base URL.

`deno task qr` fabricates **asset files** into `./onboarding/` —
`poster.svg` (both QRs + readable SSID/password/URL, ready for a flyer/slide),
plus individual `wifi`/`synth` as `.svg` (vector) and `.gif` (raster). Assets are
static and work offline at showtime — more portable than a live page. The server
banner also prints a terminal ASCII QR of the synth URL in workshop/performance.

Two caveats: a QR solves URL *discovery*, not *trust* — in `workshop` (self-signed)
the audience still taps through the cert warning after scanning; `performance`
(real cert) is clean. And the `workshop` URL embeds the LAN IP, so re-run
`deno task qr` per session; `performance` assets are static.

Built with `@paulmillr/qr` (JSR, single-file, zero-dep). PNG isn't emitted (SVG +
GIF cover posters/flyers/slides).

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

## Hardware — radios, not tiers

> Rewritten 2026-10-17. The previous version organised this by *what you buy*,
> which is the least interesting variable and the one that dates fastest. What
> actually varies is **radio count**.

### Plenum n, and which constraint is binding

**Plenum n = min(what the radios hold, what the room holds).**

That gives the only distinction worth making:

- **Radio-bound** — the gear is the limit. The apparatus is in the way of the
  practice.
- **Room-bound** — the architecture is the limit. The technology has got out of
  the way.

**The design goal for any configuration is to be room-bound.** The practice is
about n, so the ceiling on n should be the assembly, not the equipment. This
also makes "what should I buy" answerable for a given room, which "tier two"
never was.

### The topology, which never changes

```
[laptop] ──ethernet──> [router · LAN port]
                            ⋮
                         WiFi ))) phones
                       [WAN port — empty, deliberately]
```

**The laptop is always wired.** Not primarily for reliability (though at any
real n it stops the server contending for airtime with the audience it is
serving) but because the cable makes the architecture legible: there is a
server, it is separate from the audience, and the line between them is visible
in the room. Joining over WiFi collapses the server into the cloud of clients
and hides the structure — exactly the frictionlessness this practice argues
against. The unplugged WAN port is the same argument in the same register: an
empty socket where the internet would go.

Adding radios does not change this shape. That is what makes it teachable.

### The rungs are a syllabus

The rungs are not a price list. **Each one adds exactly one concept, and a real
need forces it** — nobody is taught subnets, they hit a situation where not
knowing becomes the obstacle. That is the *literacy as residue* claim in
curriculum form: the progression doesn't teach networking, it arranges for
networking to become necessary, in an order that makes each piece legible when
it arrives.

| Rung | Add | Teaches | Outgrown when |
|---|---|---|---|
| **0a** | nothing — ensemble client, simulated n | the patch language; the zone border; that n is a parameter | you want other people to hear it |
| **0b** | borrowed WiFi | there is a server and clients, and they must be able to reach each other | client isolation bites, or you want the sealed room |
| **1** | your own router, one radio | DHCP, subnets, SSID, what an address *is*; provisioning | one radio saturates — you are radio-bound |
| **2** | second radio, dumb AP, chained | router vs access point; bridging; airtime as a shared medium | still radio-bound, or the chain's fragility bites |
| **3+** | switch, star topology, channel plan | failure domains; RF planning; client steering as an unsolved problem | — |

**Plenum n at every rung from 1 upward is unmeasured.** No spec sheet states
client capacity, and it is the only number that decides any of this; the tier
language we used before hid that behind confident labels. Measuring it is the
first hardware task, and the measurement is a workshop — the ensemble client
exercises the server, not the radio, so real handsets are the only instrument
for it.

Two things about the arc are worth stating, because they are the reason to
teach it this way rather than handing someone a finished rig:

**The politics arrive as a technical obstruction, not a lecture.** The first
time a beginner's phones cannot see their laptop on a café network, they have
learned — in the only way that sticks — that infrastructure they do not control
has policies, and that those policies are not theirs. Rung 1 is then not an
ideological purchase but an obvious solution to a problem they have personally
had. The empty WAN port means something because they know what it would have
been plugged into.

**The syllabus ends exactly where the vendor's pitch begins.** By rung 3 you
have discovered client steering by failing to have it — three radios and most
of the room piled onto one. That is precisely the problem UniFi's controller
solves, and it is the right moment to meet it: having felt the need, you can
weigh the dependency knowingly instead of accepting it as the price of entry.
The syllabus does not tell anyone to refuse managed infrastructure. It arranges
for them to understand what they would be buying.

#### Rung 0a — the ensemble client is the real ground floor

Simulated n, no network, no purchase. It decouples *development* from
*assembly*: nobody should have to gather twenty people to test a patch. For the
community launch this is the difference between "learn this by putting on a
show" and "learn this alone on a Tuesday night." Treat it as a headline
feature, not a debug utility.

#### Rung 0b — borrowed WiFi, and why it bites

Workshop mode tolerates any LAN IP, needs no DNS hijack and no captive portal,
so five people at a friend's house works on their home router with nothing
bought. The server is on the laptop, in the room: this is squarely the **local**
register, no asterisk.

The problem is not conceptual, it is that **you do not control that AP**:

- **Client isolation** — the big one. Guest and venue networks very often
  prevent WiFi clients from reaching each other. This does not degrade the
  instrument, it breaks it outright: phones cannot see the laptop at all.
  **First thing to test on arriving anywhere.**
- No control of DHCP, so the laptop's address can move between sessions
- Possible port filtering
- A live uplink, so phones have internet and the captive portal is meaningless

Borrowed WiFi is a genuine rung and it works right up until it doesn't.

#### Rungs 1–2 — the reference rig

| Item | Note |
|---|---|
| Laptop | browser + Deno; serves from the router's LAN |
| USB-C ethernet adapter | see the warning below |
| Ethernet cable | laptop → router **LAN** port |
| OpenWrt travel router | **GL.iNet Beryl AX** — the first radio |
| *(second AP, later)* | another Beryl in **dumb-AP mode**, into the converted WAN port |

The growth path from one radio to two is deliberately "buy another one of the
same box": self-powered over USB-C, same OpenWrt, same UCI idiom, no PoE, no
controller, no second vendor. Dumb AP = DHCP off, LAN bridged, same SSID,
different channel. (Standard OpenWrt configuration, and GL.iNet exposes an
Access Point mode in their UI — **not yet verified on hardware**.)

**The box: GL.iNet Beryl AX (GL-MT3000), ~US$99.**

It ships with one 2.5G WAN and one 1G LAN port, and **the WAN port can be
reassigned as a second LAN port** — GL.iNet exposes this as a "Change to LAN"
control under Internet → Ethernet, so it needs no UCI. That gives two usable
LAN ports: laptop on one, second AP on the other, no switch.

This settles what was an open question. The Slate AX (~US$120) was the
candidate purely because it ships two LAN ports; once the Beryl's WAN converts,
that advantage is gone and its remaining differences — a microSD slot and
WireGuard throughput for a VPN this practice does not use — are irrelevant
here. The Beryl is cheaper and has **better range**, which is the one spec that
bears on covering a room. WAN port speed never mattered because the WAN port is
never plugged in.

> There is a small figure in the conversion worth noticing: at one radio the
> WAN socket sits empty and the refusal is visible. To grow, you don't add
> hardware — you repurpose that socket, and the port that would have carried
> the internet instead carries another radio in the room.

**What is still unmeasured is how many radios you need**, not which box to buy.
If one radio holds 30 phones most practitioners never add a second; if it holds
12, everyone does. That measurement is the first hardware task.

To test the whole sequence, buy **two Beryl AX** (~US$198): one radio, then two
radios via the converted WAN port, plus a range check — and it is exactly the
kit a practitioner would end up owning, since the growth path is literally
"buy another one of the same box."

#### Can you daisy-chain Beryls indefinitely?

Each box has two ethernet ports, so topologically yes — one in, one out:

```
[laptop]──[Beryl 1]──[Beryl 2]──[Beryl 3]──…
```

Each downstream unit in dumb-AP mode, DHCP off, LAN bridged, its own
management IP, its own channel. No protocol limit on hops; it is one switched
L2 segment.

**But ports were never the constraint, and neither is the backhaul.** All the
real traffic is WiFi — the wired side carries control messages, a few KB/s even
at n=100. Switching adds microseconds per hop against a ~1 ms local budget. So
chain length costs nothing in capacity or latency at any plausible n, and
anyone reasoning about backhaul bandwidth here is solving the wrong problem.

What actually limits the chain:

- **RF.** Radios only add capacity on non-overlapping channels, and you share
  the air with whatever the venue already runs. Two APs on the same channel
  share airtime rather than doubling it — they are closer to one AP than two.
  Past about four radios you are doing real channel planning.
- **Client distribution, with no controller.** The sharp one, and the thing
  UniFi was actually selling. Dumb APs on one SSID with nothing steering means
  each phone associates by its own logic, usually strongest signal. Three
  radios with 70% of the room on one is an ordinary outcome. **More radios
  multiply capacity but provide no mechanism to make the room use it.**
- **Fragility.** Unplug or crash Beryl 2 and everything downstream goes with
  it. A star through a switch has no such property — which matters live.

So: **chain at two, star at three or more.** Chaining four boxes saves about
$20 against an unmanaged switch and costs the robustness; that is a bad trade.
The chain's real value is at two radios, where it means never owning a switch
at all.

This also sharpens what the capacity measurement should measure. Not only
*phones per radio*, but **how evenly they distribute across two radios with no
steering.** If they pile onto one box, the second radio buys far less than
arithmetic suggests — and no spec sheet will ever tell you that number.

> **The cost of dropping PoE.** PoE exists because APs go where power doesn't.
> USB-C-powered APs need a mains socket within reach of wherever you want the
> radio — so socket placement constrains AP placement, which constrains
> coverage, which constrains plenum n. This is invisible on a spec sheet and
> obvious in a room. It probably doesn't matter with one or two radios near the
> performer; it will matter at 100 people in an awkward room. This is the real
> argument for keeping the PoE path documented below rather than deprecating it.

#### Warning: the USB ethernet adapter

Making wired the ground floor means every practitioner is on a dongle, so the
dongle failure mode becomes everyone's. A USB ethernet adapter that
re-enumerates under a new BSD name leaves macOS's configured network services
bound to the old one (`en5` → `en6` → …), so the interface never comes up and
never gets a lease. **This presents identically to an unplugged cable** and has
cost real time at least three times (see `dev_log.md`).

- `detect_network` in `start-macos.sh` now checks the USB bus for this case and
  prints the `networksetup -createnetworkservice` remedy instead of blaming the
  cable. That diagnostic is load-bearing for the community tier.
- Recommend an **ASIX AX88179 / AX88179A**-class adapter — about as widely
  supported as USB ethernet gets.
- Document that the interface name *will* change between sessions and that this
  is normal, not a fault.

### Many radios — the PoE path (your ~100-phone shows)

Above two or three radios the siting problem above becomes binding, and PoE
stops being legacy baggage and starts being the reason the rig works: one cable
carries data *and* power to wherever the radio needs to be. This is the tier
where the current rig's architecture is correct and the travel-router path runs
out.

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

That dependency is worth naming as more than an inconvenience. A stock U6+ is
**inert until the vendor's software blesses it** — no standalone web UI, no
SSID, nothing, until a controller adopts it. You can self-host that controller,
so it isn't cloud-dependency exactly; but a device you have bought and cannot
use without running the manufacturer's program is rented in everything but
invoice. For a register whose entire claim is infrastructural autonomy, that is
a contradiction sitting in the rack. The OpenWrt path is not merely cheaper and
easier to document — it is the only one coherent with what the local register
is *for*.

### Sources

- [GL.iNet Beryl AX (GL-MT3000)](https://store.gl-inet.com/products/beryl-ax-gl-mt3000-pocket-sized-wi-fi-6-wireless-travel-gigabit-router) — the pick
- [GL-MT3000 user guide](https://docs.gl-inet.com/router/en/4/user_guide/gl-mt3000/) — "Change to LAN" lives under Internet → Ethernet
- [Slate AX vs Beryl AX comparison (RTINGS)](https://www.rtings.com/router/tools/compare/gl-inet-slate-ax-gl-axt1800-vs-gl-inet-beryl-ax-gl-mt3000/42772/42784) — port counts, range
- [GL.iNet Flint 2 (GL-MT6000)](https://store.gl-inet.com/products/flint-2-gl-mt6000-wi-fi-6-high-performance-home-router)
- [Meraki high-density design](https://documentation.meraki.com/Wireless/Design_and_Configure/Architecture_and_Best_Practices/Approximating_Maximum_Clients_per_Access_Point)
- [MikroTik hAP ax3 client-count thread](https://forum.mikrotik.com/t/how-many-clients-can-be-connected-to-hap-ax3/170323)
- [MikroTik HotSpot / captive portal docs](https://help.mikrotik.com/docs/spaces/ROS/pages/56459266/HotSpot+-+Captive+portal)
- [OpenWrt / openNDS walled garden](https://opennds.readthedocs.io/en/stable/walledgarden.html)
</content>
</invoke>
