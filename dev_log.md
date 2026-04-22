# Dev Log

## 2026-02-27 — Step 1: Server + Network Bringup

### What we built
- Deno 2 server with auto-generated self-signed TLS, static file serving, WebSocket
- Charcoal brutalist client UI with health-check ping every 5s and auto-reconnect

### Network misadventures

**igc driver (Intel NUC ethernet)**
The `igc` driver on kernel 6.17 has a bug where `ip link set enp86s0 up` returns
`RTNETLINK answers: No such device` even though the interface exists in `ip link show`
and `/sys/class/net/`. The fix is to reload the driver module:
```
sudo modprobe -r igc && sudo modprobe igc
```
This needs to happen after every cable change or reboot. The interface also loses its
IP address after a driver reload.

**FritzBox 7490 WiFi**
The FritzBox was intended as both DHCP server and initial WiFi for testing. Despite
the WLAN LED being green and the admin UI being accessible over ethernet, we could
not connect to its WiFi from a Pixel 9 — even after a factory reset. Spent ~30 mins
on this before giving up. The FritzBox works fine as a wired DHCP server.

**Ubiquiti U6+ APs — adoption required**
Stock U6+ APs do not broadcast any SSID. They require adoption by a UniFi controller
before they'll do anything useful. There is no standalone web UI, no Bluetooth setup
(despite documentation suggesting otherwise), and the UniFi mobile app only discovers
APs over the same WiFi network (chicken-and-egg problem).

We tried configuring WiFi via SSH (`/tmp/system.cfg`), but the AP firmware resets the
config on every boot when the device is unadopted (`mgmt.is_default=true`).

**Solution:** Ran a temporary UniFi Network Application via Docker on the NUC
(`unifi/docker-compose.yml`), adopted both APs, created the "assembly" SSID,
then shut down the controller. APs retain config after adoption.

**Cellular data override**
Phones with cellular data enabled will route traffic over cellular even when connected
to a local-only WiFi network. Airplane mode + WiFi is the workaround.

### Verification
Phone (Pixel 9) connected to "assembly" WiFi, opened `https://192.168.178.10:8443`,
saw charcoal UI, WebSocket connected, health pings working. Server correctly logs
connect/disconnect with client count.

## 2026-03-01 — Step 2: Captive Portal + Synth Engine

### What we built
- **Captive portal**: HTTP listener on port 8080 handles Apple/Google/Firefox/Microsoft
  probe URLs. Redirects to portal page, tracks authenticated IPs, returns expected
  responses on subsequent probes so the OS doesn't disconnect WiFi.
- **Portal page**: No-JS `portal.html` — works in iOS CNA. "ENTER" link opens the
  real browser at `https://local.assembly.fm:8443`.
- **Synth client**: Tap-to-start overlay, AudioContext init, AudioWorklet loading,
  WebSocket parameter forwarding to worklet, Screen Wake Lock with visibility re-acquire.
- **Formant + zing DSP**: Ported from `reference/voice.assembly.fm` (~1564 lines →
  ~260 lines). Kept full DSP core: vowel bilinear interpolation, Le Brun cross-fade
  carriers, FM formant synthesis, zing ring mod/AM morphing, symmetry phase warping,
  UPL harmonic generation. Removed HRG/RBG generators, phasor worklet dependency,
  envelope interpolation modes, multi-channel output, vibrato/noise.
- **Server broadcast**: Client IDs, welcome messages, client count broadcasts,
  test mode cycling parameters every 100ms.
- **Configurable host**: `HOST_IP` and `HOST_DOMAIN` env vars.

### Let's Encrypt certs
Self-signed certs cause a scary warning page on phones. Switched to Let's Encrypt
with DNS-01 challenge via Namecheap. dnsmasq resolves `local.assembly.fm` →
`192.168.178.10` on the LAN, so the CA-signed cert matches. Clean lock icon, no
warnings on any browser.

```
sudo certbot certonly --manual --preferred-challenges dns -d local.assembly.fm
```

Add TXT record `_acme-challenge.local` in Namecheap, then copy certs to project root.

### dnsmasq setup
Config at `/etc/dnsmasq.d/assembly.conf`:
```
interface=enp86s0
address=/#/192.168.178.10
```
`systemd-resolved` holds port 53 on loopback, so dnsmasq needs `--bind-interfaces`.
FritzBox DHCP hands out `192.168.178.10` as DNS server.

### FritzBox misadventure
Switched FritzBox to "IP client" mode — this killed DHCP and the device became
unreachable on `.1`. The 7490 has no hardware reset button. Factory reset via phone
dial (`#991*15901590*`) didn't work. Recovered via emergency IP `169.254.1.1`
(needed `sudo ip addr add 169.254.1.2/16 dev enp86s0` on NUC first). Switched back
to Internet Router mode. **Never use IP client mode on the FritzBox for this setup.**

### Browser notes
- **Brave/Chrome (Android)**: Audio works great, clean playback
- **Firefox (Android)**: AudioWorklet glitchy — likely Firefox's less optimized
  AudioWorklet implementation on Android. Not our target browser.
- Wake Lock working on both

### Verification
Pixel 9 on Brave: `https://local.assembly.fm:8443` loads with valid cert,
tap-to-start works, formant synthesis audible with server-driven parameter changes,
screen stays awake, WebSocket auto-reconnects.

### CNA (Captive Network Assistant) deep dive

The captive portal flow required significant iteration to get right on both platforms.

**iOS CNA limitations discovered:**
- WKWebView blocks WebSocket connections entirely
- AudioWorklet requires a secure context — won't work over HTTP
- Links tapped inside the CNA navigate within the CNA, don't open Safari
- URL schemes (`x-safari-https://`, etc.) are all blocked by Apple

**Solution: SSE (Server-Sent Events) fallback**
- SSE uses standard HTTP GET — works in both iOS and Android CNA WebViews
- Data flow is one-directional (server → clients), so SSE is sufficient
- `main.js` tries WebSocket first, falls back to SSE after 2s timeout or error
- Server tracks both WS and SSE clients, `broadcast()` sends to all

**Final captive portal flow:**
- **Android**: `/generate_204` probe → 302 redirect to `https://local.assembly.fm:8443`
  → Chrome Custom Tab loads synth client → SSE connects → audio + params working
- **iOS**: `/hotspot-detect.html` probe → 302 redirect to HTTPS → CNA loads synth
  client over HTTPS → SSE connects → audio + params working. CNA stays open (IP not
  authenticated) so the synth keeps running inside it.
- **Typed URL fallback**: any URL typed in browser → HTTP catch-all serves synth
  client → redirects or serves directly

**Port redirects** (iptables on Linux):
- Port 80 → 8080 (captive portal probes)
- Port 443 → 8443 (so `local.assembly.fm` works without port number)

### Final verification
- Pixel 9: CNA opens automatically, tap to start, audio + SSE working
- iPhone 10: CNA opens automatically, tap to start, audio + SSE working
- Both phones: Wake Lock active, synth responds to server parameter changes
- Multiple phones connected simultaneously

### SSE-first connection model
Flipped transport priority: SSE connects first (instant, works everywhere including
iOS CNA), then attempts WebSocket upgrade in the background. If WS succeeds, SSE is
closed and transport switches over. If WS fails (e.g. iOS CNA), stays on SSE with
no delay or disruption. Status bar shows current transport: "disconnected" / "sse" / "ws".
This eliminates the previous 2-second timeout penalty for CNA clients.

## 2026-03-18 — Step 3: macOS Deployment Setup (M2 MacBook Pro)

### Context
Performance tomorrow. First time deploying on macOS (M2 2022 MBP) instead of NUC.
Hardware: NETGEAR GS305PP PoE switch, FritzBox 7490 DHCP server, 2x Ubiquiti U6+ APs.
Goal: Get captive portal working via ethernet, use WiFi for internet/Claude access.

### Certificate Generation (Let's Encrypt)

**Challenge:** No existing certificates on Mac, need CA-signed certs for clean mobile experience.

**Process:**
```bash
# Install certbot via Homebrew
brew install certbot

# Generate certificate with DNS-01 challenge
sudo certbot certonly --manual --preferred-challenges dns -d local.assembly.fm

# Add TXT record to Namecheap DNS:
# Host: _acme-challenge.local
# Value: [provided by certbot]
# Wait 2 minutes for DNS propagation

# Copy certificates to project
sudo cp /etc/letsencrypt/live/local.assembly.fm/fullchain.pem cert.pem
sudo cp /etc/letsencrypt/live/local.assembly.fm/privkey.pem key.pem
sudo chown $(whoami) cert.pem key.pem
```

**Result:** Certificate valid until 2026-06-16.

### UniFi AP Adoption Challenges

**Problem:** APs previously adopted on NUC. When UniFi controller started via Docker on Mac
(`unifi/docker-compose.yml`), APs showed as "Device Unreachable" due to Docker networking
on macOS (bridge mode can't easily reach physical ethernet devices).

**Discovery:**
- Mac IP: `192.168.178.24` (USB ethernet adapter `en5`)
- APs at: `192.168.178.20`, `192.168.178.21`
- APs pingable but Docker container couldn't reach them

**Attempted Solutions (didn't work):**
- Port mapping (8080, 8443, 10001/udp) — Docker can receive connections but can't initiate to LAN
- Network mode: host (doesn't work properly on macOS Docker)
- set-inform via curl to port 8080 — APs not responding on inform port (still tied to old controller)

**Working Solution: Factory Reset + SSH Adoption**
```bash
# 1. Factory reset both U6+ APs
# Physical: Press and hold reset button 10-15 seconds until LED changes pattern
# LEDs will blink slowly when ready (blue = adoption mode)

# 2. Power cycle (unplug ethernet, wait 10s, replug)
# APs came back with same IPs (.20, .21) due to FritzBox DHCP reservations

# 3. SSH with default credentials (factory reset succeeded)
ssh ubnt@192.168.178.20  # password: ubnt
ssh ubnt@192.168.178.21  # password: ubnt

# 4. Manual set-inform to point APs at Mac's IP
# In each SSH session:
set-inform http://192.168.178.24:8080/inform

# 5. APs showed solid bright blue LEDs (communicating with controller)

# 6. In UniFi controller web interface (https://localhost:8443):
# - Complete initial setup wizard (skip cloud, create local admin)
# - Navigate to Devices section
# - Click "Adopt" on both U6+ devices
# - Wait 2-3 minutes for adoption to complete (status: "Connected")

# 7. Create WiFi network:
# Settings → WiFi Networks → Create New
# - Type: Standard (NOT Hotspot - clients need to reach server)
# - Name: assembly
# - Security: WPA Personal
# - Password: assembly
```

**Key Learning:** Docker UniFi controller on macOS has network isolation issues. SSH +
set-inform + adoption via localhost interface works reliably.

### DNS Configuration (dnsmasq)

**Requirement:** All DNS queries from clients must resolve to server IP for captive portal.

```bash
# Install dnsmasq
brew install dnsmasq

# Create config file (fish shell syntax)
echo "interface=en5
address=/#/192.168.178.24" | sudo tee /opt/homebrew/etc/dnsmasq.d/assembly.conf

# Start dnsmasq
# --bind-interfaces required because macOS has system DNS on port 53 (loopback only)
sudo /opt/homebrew/opt/dnsmasq/sbin/dnsmasq \
  --keep-in-foreground \
  --bind-interfaces \
  --conf-file=/opt/homebrew/etc/dnsmasq.d/assembly.conf

# Verify DNS working
dig @192.168.178.24 example.com +short
# Should return: 192.168.178.24
```

**FritzBox Configuration:**
- Access: `http://192.168.178.1`
- Navigate to DNS settings (varies by firmware, look in Network or DHCP sections)
- Set DNS server to: `192.168.178.24`
- This tells FritzBox to hand out Mac's IP as DNS server via DHCP

**Verification:**
- Phone connects to "assembly" WiFi
- Check WiFi details on phone → DNS should show `192.168.178.24`
- May need to forget network and reconnect for new DHCP lease

### Port Forwarding Challenge (macOS pfctl)

**Problem:** Deno server runs on ports 8080 (HTTP) and 8443 (HTTPS), but captive portal
probes and standard web traffic use ports 80 and 443.

**Attempted Solution: pfctl (macOS packet filter)**
```bash
# Create redirect rules
echo "rdr pass on en5 inet proto tcp from any to any port 80 -> 127.0.0.1 port 8080
rdr pass on en5 inet proto tcp from any to any port 443 -> 127.0.0.1 port 8443" \
| sudo tee /etc/pf.anchors/assembly

# Load rules into anchor
sudo pfctl -a assembly -f /etc/pf.anchors/assembly
sudo pfctl -e

# Verify
sudo pfctl -s rules | grep rdr
```

**Result:** Rules didn't load properly (showed nothing when queried). macOS pfctl is
finicky and the redirect syntax may have issues with the interface or loopback target.

**Working Solution: Run Server on Standard Ports**

Changed server to use ports 80 and 443 directly, requires sudo:

```bash
# Edit server.ts
# Changed:
#   const HTTPS_PORT = 8443;
#   const HTTP_PORT = 8080;
# To:
#   const HTTPS_PORT = 443;
#   const HTTP_PORT = 80;

# Run with sudo (required for ports < 1024)
cd /Users/capo_greco/Documents/local.assembly.fm
sudo HOST_IP=192.168.178.24 deno task start
```

**Result:** Captive portal works! Phone auto-detects network, portal notification appears,
redirects to synth client.

### Final Working Configuration

**Network Topology:**
```
Mac (192.168.178.24, USB ethernet en5)
  ↓
NETGEAR GS305PP PoE Switch
  ├─ FritzBox 7490 (192.168.178.1) — DHCP + gateway
  ├─ U6+ AP #1 (192.168.178.20) — SSID "assembly"
  └─ U6+ AP #2 (192.168.178.21) — SSID "assembly"
```

**Services Running on Mac:**

1. **dnsmasq** (resolves all DNS to 192.168.178.24):
```bash
sudo /opt/homebrew/opt/dnsmasq/sbin/dnsmasq \
  --keep-in-foreground \
  --bind-interfaces \
  --conf-file=/opt/homebrew/etc/dnsmasq.d/assembly.conf
```

2. **Deno Server** (ports 80/443, requires sudo):
```bash
cd /Users/capo_greco/Documents/local.assembly.fm
sudo HOST_IP=192.168.178.24 deno task start
```

**Startup Checklist (for performance day):**

1. Connect Mac to PoE switch via ethernet (USB adapter)
2. Verify Mac has IP `192.168.178.24` (may need DHCP renewal or manual config)
3. Start dnsmasq (command above) — leave running in terminal
4. Start Deno server (command above) — leave running in terminal
5. Verify U6+ APs have solid LEDs (powered via PoE)
6. Test: Connect phone to "assembly" WiFi (password: `assembly`)
7. Captive portal should auto-appear, or visit any HTTP URL to trigger redirect

**Key Differences from NUC/Linux Setup:**

| Aspect | NUC/Linux | macOS |
|--------|-----------|-------|
| Port forwarding | iptables | Not working (pfctl unreliable) — use ports 80/443 directly |
| DNS | dnsmasq systemd service | dnsmasq via Homebrew, manual start |
| Server ports | 8080/8443 with iptables redirect | 80/443 with sudo |
| Ethernet interface | enp86s0 (Intel NUC) | en5 (USB adapter) |
| Static IP | Manual via ip command | DHCP from FritzBox or manual in Network prefs |
| Docker networking | Works (iptables PREROUTING) | Broken (can't reach LAN from container) |
| UniFi adoption | Via Docker controller | Factory reset + SSH set-inform + Docker controller |

**Known Issues:**

- **Port forwarding:** pfctl rules don't load reliably, so server MUST run on 80/443
- **sudo required:** Running on standard ports requires sudo (privilege escalation)
- **Process management:** No systemd, must keep terminals open or use `screen`/`tmux`
- **DHCP:** Mac IP might change on reboot if not statically configured
- **Docker controller:** Only needed for AP adoption/config changes, not for performance

**Verification (working as of 2026-03-18):**

- Phone connects to "assembly" WiFi
- Captive portal notification appears automatically
- Tapping notification loads synth client (https)
- Alternative: Typing any URL (e.g., `example.com`) redirects to synth
- Server logs show SSE/WebSocket connections
- Audio synthesis working on phone after "TAP TO START"

## 2026-03-18 — Monome Grid Support

### What we built

Implemented full monome grid integration with three new ctrl-zone box types for the patch editor:

- **grid-trig**: Momentary trigger region (outputs 1 on press, 0 on release)
- **grid-toggle**: Latching toggle region (flips 0/1 on each press)
- **grid-array**: Integer array with range gesture support
  - Single press: toggle value in/out of array
  - Hold + press: fill range (if first button inactive) or clear range (if first button active)
  - Values are 1-indexed (button x=0 → value 1)
  - Ranges are inclusive of both endpoints

### OSC Infrastructure

**Communication flow:**
- Server listens on port 12003 for grid messages
- Discovers serialosc on port 12002 via `/serialosc/list`
- Subscribes to `/serialosc/notify` for hot-plug detection
- Configures grid with `/sys/port`, `/sys/host`, `/sys/prefix`
- Sends LED updates via `/grid/led/set` (per-button) and `/grid/led/all` (clear)
- Receives button presses via `/assembly/grid/key` (x, y, pressed)

**Critical bug discovered and fixed:**
Initial implementation prepended `GRID_PREFIX` to ALL messages including `/sys/*` configuration, sending `/assembly/sys/port` instead of `/sys/port`. This prevented the grid from being properly configured, so button presses were never received. Fixed by splitting into two functions:
- `gridSend()` — adds prefix for LED/key messages (`/assembly/...`)
- `gridSysSend()` — NO prefix for system configuration (`/sys/...`)

### Grid-array gesture state machine

Implementing the range gesture logic required careful state tracking to avoid spurious toggles:

**State structure:**
```typescript
interface GridArrayState {
  array: number[];           // Current array contents (1-indexed)
  heldButtons: Set<number>;  // Held button x-coordinates
  rangeGestureActive: boolean; // Prevents toggle on release after range
}
```

**Behavior:**
- Press: track as held, check if another button already held → perform range operation
- Release: only toggle if ALL buttons released AND no range gesture occurred
- Range fill/clear: determined by FIRST button's state (active = clear, inactive = fill)

**Bug fixes during implementation:**
1. Initially toggled on press → range detection broken (first button already active by time second pressed)
2. Fixed by deferring toggles to release
3. Release after range operation triggered spurious toggle → added `rangeGestureActive` flag

### Patch editor integration

- Added box type definitions to `gpi-types.js` with args format "x y w h"
- Grid regions tracked in `Map<boxId, GridRegion>` on server
- Regions rebuilt on patch apply/edit
- LED rendering synchronized with box state
- Array values propagate through patch cable system

### Hot-plug and reconnection

Initial implementation had issues with hot-plug detection:

**Problem 1: Disconnection not reflected in ctrl client**
- Server received `/sys/disconnect` from grid but didn't notify ctrl clients
- Fixed by adding `sendCtrl({ type: "grid-disconnected" })` handler

**Problem 2: Reconnection broken**
- When unplugging grid: `/sys/disconnect` followed by `/serialosc/remove`
- Both handlers were clearing `gridDevicePort`, so `/sys/connect` on replug couldn't restore connection
- LED rendering would fail with `gridSend failed: port=null`

**Solution:**
- Preserve `gridDevicePort` across disconnection/reconnection cycle
- Only clear `gridDeviceInfo` on disconnect (marks as "not connected")
- On `/sys/connect`, query serialosc to restore full device info
- Deduplicate disconnect notifications (both messages can arrive)

### Verification (working as of 2026-03-18)

- Grid hot-plug detection working (shows "grid connected/disconnected" in status bar)
- Grid reconnection working (unplug → replug restores connection and LED control)
- All three box types functioning correctly
- LED feedback with appropriate brightness (toggle: 0/15, array: 4/15)
- Range gestures: hold+press fills/clears inclusive ranges
- Single button toggles work without spurious state changes
- Arrays output correctly through patch system (e.g., `[1, 2, 3, 4]`)
- Tested with grid_test.json patch (grid-trig, grid-toggle, grid-array → print)

---

## Monome Arc Support (2026-03-18)

### Implementation approach

Initially attempted serial communication via CDC ACM (inspired by commit d746e01), but encountered fundamental issues:
- Arc iii devices boot into a closed script mode with read-only serial from host
- Special `^^` protocol commands required to enter REPL mode
- Serial approach was unreliable and platform-specific

**Switched to OSC via serialosc** (user's original suggestion):
- Arc devices are detected by serialosc alongside grid devices
- Same reliable OSC communication path
- Cross-platform compatibility
- Standard monome ecosystem integration

### Arc box type

Format: `arc i m` where:
- `i` = encoder index (0-3 for arc 4)
- `m` = mode (0 = continuous rotation, outputs 0-1)

Added to `gpi-types.js`:
```javascript
arc: {
  zone: "ctrl",
  description: "Monome Arc encoder. Mode 0: continuous rotation (0-1).",
  args: "i m",
  example: "arc 0 0",
  inlets: [],
  outlets: [{ name: "value", type: "number", description: "Encoder position (0-1)" }]
}
```

### OSC communication

**Detection and configuration:**
- Arc devices detected through existing serialosc discovery (`/serialosc/list`)
- Device type string contains "arc" → route to arc handlers
- Configuration messages: `/sys/port`, `/sys/host`, `/sys/prefix`
- OSC prefix: `/assembly` (same as grid)

**Encoder messages:**
- Receive: `/assembly/enc/delta [encoder, delta]`
- Delta values are encoder ticks (positive = clockwise, negative = counter-clockwise)
- Sensitivity: `0.0003` (fine-tuned after testing)

**LED control:**
- Send: `/ring/map [encoder, led0, led1, ..., led63]` (64 LEDs per ring)
- Arc has 64 LEDs per ring (0-63), LED 0 at 12 o'clock
- Rendering starts at 6 o'clock (LED 32), fills clockwise
- Brightness: 0 (off) to 15 (full)

### State management

Server.ts additions:
```typescript
const arcEncoders = new Map<number, ArcEncoder>();  // boxId → encoder definition
const arcValues = new Map<number, number>();        // boxId → current value (0-1)
let arcDevicePort: number | null = null;
let arcDeviceInfo: { deviceType: string; deviceId: string } | null = null;
```

**Critical bug fix:** Using `??` instead of `||` for default values:
```typescript
const currentValue = arcValues.get(boxId) ?? 0.5;  // Correct
const currentValue = arcValues.get(boxId) || 0.5;  // BUG: treats 0 as falsy
```
Without this fix, value 0 would wrap to 0.5 when turning counter-clockwise.

### LED rendering

**Visual design:**
- Start at 6 o'clock (bottom) instead of 12 o'clock (top)
- Fill clockwise as value increases from 0 to 1
- Value 0.5 = half ring filled (180°)

**Implementation:**
```typescript
const numLeds = Math.floor(value * 64);
const ledData: number[] = new Array(64).fill(0);
for (let i = 0; i < numLeds; i++) {
  const ledIndex = (32 + i) % 64;  // Start at LED 32 (6 o'clock)
  ledData[ledIndex] = 15;
}
arcSend("/ring/map", typeTags, encoder, ...ledData);
```

### Value clamping

Values clamp at 0 and 1 (no wrapping):
```typescript
const newValue = Math.max(0, Math.min(1, currentValue + delta * ARC_SENSITIVITY));
```

### Hot-plug support

Same pattern as grid:
- `/serialosc/device` or `/serialosc/add` → configure and notify ctrl clients
- `/sys/disconnect` → clear device info, keep port for reconnection
- `/serialosc/remove` → deduplicate disconnect notification
- `/sys/connect` → query serialosc to restore device info

**Ctrl client integration:**
- Arc device shown in status bar with device type and ID
- Device info sent on ctrl websocket connection (server.ts:1653-1655)
- Fixes refresh issue where arc was functional but not listed

### Verification (working as of 2026-03-18)

- Arc detected via serialosc on both macOS and Linux
- Hot-plug detection working (shows "monome arc (m08212311)" in devices list)
- Reconnection working (unplug → replug restores connection)
- Encoder deltas correctly update box values
- LED ring renders correctly starting from 6 o'clock
- Value clamping prevents wrapping at 0 and 1
- Sensitivity tuned for precise control (0.0003)
- Ctrl client shows arc on refresh/reconnect
- Tested with patches/arc_test.json (arc 0 0 → print)

## Router Positioning and Browser Caching (2026-03-18)

### Problem

Routers (border-crossing boxes like `one`, `fraction`, `sweep`) were loading with incorrect Y positions, appearing above or below the synthBorderY line. Moving them caused "modified" state, and the position would revert on next load.

### Root causes discovered

**1. Browser caching**
The `serveFile()` function in server.ts had no cache headers, causing aggressive browser caching of ctrl.js. Hard refreshes and "Empty Cache and Hard Reload" were not loading updated code.

**2. Scaling logic interference**
The `ensureAllBoxesVisible()` function in ctrl.js used complex scaling logic that repositioned ALL boxes (including routers) after load, overriding the intended border position.

### Fixes implemented

**Cache-Control headers (server.ts:83-95)**
```typescript
async function serveFile(path: string): Promise<Response> {
  try {
    const body = await Deno.readFile(`./public${path}`);
    return new Response(body, {
      headers: {
        "content-type": mimeType(path),
        "cache-control": "no-cache, must-revalidate"
      }
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}
```

**Router position enforcement (ctrl.js:251-259)**
Added Y position override in `load()` function to ensure routers always load at `synthBorderY - BOX_HEIGHT / 2`:

```javascript
// Fix router Y positions to always be at border
for (const [, box] of this.boxes) {
  if (this.isRouterType(box.text)) {
    box.y = this.synthBorderY - BOX_HEIGHT / 2;
  }
}
```

**Simplified ensureAllBoxesVisible (ctrl.js:267-333)**
Replaced complex scaling logic with proportional nudging:
1. First pass: Calculate maximum out-of-bounds distance as percentage
2. Second pass: Nudge all boxes by that percentage toward safe positions
3. **Routers are skipped entirely** - they stay locked at border

Key improvement: No scaling, just proportional nudging toward center (X) and border (Y). The worst offender reaches the margin exactly, everything else moves proportionally.

### Architecture clarification

**Router positioning rule:**
- Routers have **horizontal-only** positioning
- Y coordinate is architecturally fixed: `y = synthBorderY - BOX_HEIGHT / 2`
- With synthBorderY=400, BOX_HEIGHT=22: router y=389 (center at y=400)
- Router straddles border: 11px in ctrl zone, 11px in synth zone

**Why this matters:**
Routers are the architectural boundary between ctrl (discrete events) and synth (continuous DSP). Their position must be deterministic and visually clear.

### Verification (working as of 2026-03-18)

- Routers load at correct Y position (389 with default synthBorderY=400)
- Moving router horizontally doesn't trigger "modified" state
- Dragging routers constrains movement to X-axis only
- Browser cache updates correctly with new ctrl.js
- Test patch router_one_test.json loads with router on border
- `ensureAllBoxesVisible()` no longer interferes with router positions

## Const Box Engine Initialization (2026-03-18)

### Problem

Test patch `router_one_test.json` was not producing sound in synth clients despite router values being transmitted correctly. Symptom: frequency parameter was updating (visible in param display) but amplitude was not listed.

**Patch structure:**
```
metro 0.25 → random 200 800 → one (router) → sine-osc (freq inlet)
                                    ↓
const 0.3 ────────────────────────────────→ sine-osc (amp inlet)
```

The `const 0.3` box has no inlets, so nothing ever triggered its evaluation. While the const value was seeded into the sine-osc node's `inletValues` during graph construction (graph.js:221-230), this value was never sent to the audio engine.

### Architecture insight

Similar to Pure Data's "loadbang" object, const boxes with no inlets need initialization at graph load time. The existing const initialization in `buildGraph()` set `inletValues` but didn't update engines.

### Fix implemented (main.js:110-130)

After engines are created, iterate through all engine boxes and apply their inlet values:

```javascript
// apply const box values to engines
for (const [engineId, engineDef] of voice.graph.engines) {
  const engineNode = voice.graph.boxes.get(engineId);
  if (!engineNode) continue;

  const engine = voice.engines.get(engineId);
  if (!engine) continue;

  const params = {};
  for (let i = 0; i < engineNode.inletValues.length; i++) {
    const value = engineNode.inletValues[i];
    if (value !== undefined) {
      const paramName = engineDef.paramNames[i];
      if (paramName) params[paramName] = value;
    }
  }

  if (Object.keys(params).length > 0) {
    sendParams(engine, params);
  }
}
```

This ensures all inlet values (including those seeded by const boxes during `buildGraph()`) are sent to the audio engine via `sendParams()`.

### Verification (working as of 2026-03-18)

- Synth clients now produce sound with router_one_test.json
- Param display shows both `frequency` and `amplitude` parameters
- Amplitude remains constant at 0.3 while frequency changes with router values
- Router targeting working correctly: only the targeted voice produces sound

## Sigmoid + Cosine Envelopes (2026-03-19)

### Design

Two new trigger envelopes that share a phase-distortion engine, each with five parameters:

**Sigmoid** (`sigmoid start end duration duty curve`) — transition envelope, stays at end value.
- Phase distortion via `duty`: controls where in the duration the transition occurs (0.5 = centered, 0.2 = early, 0.8 = late)
- `curve` controls steepness: 0 = linear ramp, 6 = smooth S-curve, 20+ = near-step
- At extreme curve + any duty = step envelope with controllable trigger point

**Cosine** (`cosine amplitude duration duty curve`) — hump envelope, returns to zero.
- `duty` controls asymmetry: 0.5 = symmetric, 0.2 = fast attack/slow decay (percussive), 0.8 = slow swell/fast drop
- `curve` controls peakedness: 0.5 = broad, 1 = cosine, 2+ = sharp peak
- Rise and fall are independent half-cosines split at the duty point

### Shape functions

```javascript
function sigmoidShape(t, duty, curve) {
  const d = Math.max(0.001, Math.min(0.999, duty));
  let phi;
  if (t <= d) phi = 0.5 * t / d;
  else phi = 0.5 + 0.5 * (t - d) / (1 - d);
  if (curve < 0.1) return phi;
  const raw = x => 1 / (1 + Math.exp(-curve * (x - 0.5)));
  const r0 = raw(0), r1 = raw(1);
  return (raw(phi) - r0) / (r1 - r0);
}

function cosineShape(t, duty, curve) {
  const d = Math.max(0.001, Math.min(0.999, duty));
  let base;
  if (t <= d) base = (1 - Math.cos(Math.PI * t / d)) / 2;
  else base = (1 + Math.cos(Math.PI * (t - d) / (1 - d))) / 2;
  return Math.pow(base, curve);
}
```

### Architecture note

Envelopes are synth-side only. They run in `graph.js` on clients at ~60Hz via `tickGraph()`. The server never ticks envelopes — it sends triggers and values through routers, and the client-side graph handles all time-based envelope animation.

## Two-Phase Propagation (2026-03-19)

### Problem

When a source box (e.g. `metro`) fans out to multiple destinations via cables, the propagation order depended on cable creation order (Map iteration). This caused the `one` router's trigger inlet to fire before its value inlet received data, resulting in values going to wrong clients, skipped clients, and repeated hits.

### Solution

Split `propagateAndNotify` (server) and `propagateInGraph` (client) into two phases:

1. **Phase 1 (store):** Deliver all values — set inlet values, evaluate math boxes, buffer router values. Event-type inlets are collected into a deferred queue instead of firing immediately.
2. **Phase 2 (trigger):** After all values from this fan-out are delivered, fire the deferred events.

The inlet `type` field in gpi-types.js (`"event"` vs `"number"` vs `"passthrough"`) is the discriminator. This guarantees values arrive before triggers regardless of cable draw order.

### Other fixes in this session

- `arcReady` ReferenceError — variable used but never declared, silently broke all patch applies via swallowed catch block
- Silent error swallowing — changed `catch { /* ignore malformed */ }` to `catch (err) { console.error("WS error:", err); }`
- Server-side `sig`, `random`, `step` — added to `initBoxState` + `handleEventBox` so ctrl-side event chains (metro → sig) work
- Ensemble voice count URL param — `?n=12` on ensemble.html

## Editor UX + One Router + Envelope Modes (2026-03-19)

### Tab to create connected box

Pressing Tab with a single box selected creates a new empty box directly below, connected outlet 0 → inlet 0, and opens it for editing. Mirrors the double-click-on-cable workflow but from a selected box.

### `//` comment shorthand

`//` is now an alias for `comment` in the box type registry. Type `// my note` in a box for inline documentation.

### One router auto-advance

The `one` router now auto-advances to the next phone on every value received. Single inlet, no trigger cable needed. This eliminates the ordering issues with separate value/trigger paths and simplifies patching.

### Envelope respect/interrupt modes

Sigmoid and cosine envelopes now support two trigger modes via a trailing arg:

- **respect** (default): if an envelope is still running, new triggers are ignored
- **interrupt**: new triggers cancel the running envelope and restart

Example: `cosine 1 0.3 0.2 1 interrupt` for percussive use, `sigmoid 0 1 2 0.5 6` (default respect) for long transitions that shouldn't be cut short.

## Interactive Boxes + Metro Animation + Connection Fix (2026-03-19)

### Clickable toggle and event boxes

No performance mode — interactive boxes trigger on click-without-drag (if you move the box even 1px, it's a drag not a click). This avoids accidental triggers while editing and means the performer can edit mid-show without mode switching.

- **toggle**: click to flip 0/1, inlet 0 sets state programmatically. Value bar shows state.
- **event**: click to emit null event from outlet 0.

### Metro inlets and animation

Metro now accepts two inlets: toggle (0=run, >0=pause) and period (overrides arg interval). The value bar fills 0→1 over each interval as a visual heartbeat, so you can see whether metros are ticking in the server.

### WebSocket connection storm fix

**Problem:** Ensemble mode with n=24 was showing 200+ clients. All 24 voices called `tryWebSocket()` simultaneously, overwhelming the browser's concurrent WS limit. Failed connections triggered retries from both `error` AND `close` handlers, doubling the retry rate. Each retry opened a new server-side connection before the old one fully closed.

**Fixes:**
- Only `close` handler retries (not `error`) — prevents double retry
- Guard `tryWebSocket` against re-entry if a WS already exists
- Stagger initial ensemble connections (50ms apart, 24 voices = 1.2s total)
- Jitter retry delay on failure (2-5s random) to prevent thundering herd
- Increased WS open timeout from 2s to 5s

## Serialosc Hot-Plug Fixes (2026-03-19)

### Problem

With grid and arc sharing a USB hub and the same OSC listener port (13000):

1. **`/sys/disconnect` cleared both devices** — this message doesn't identify which device disconnected, so both `arcDeviceInfo` and `gridDeviceInfo` were wiped whenever either device was unplugged.

2. **`/sys/connect` triggered redundant rediscovery** — caused reconnect loops with repeated `/sys/disconnect` → `/sys/connect` cycles.

3. **`/serialosc/add` spammed on initial connect** — each detection re-configured the device, which caused serialosc to send more add messages, creating a feedback loop.

4. **Hot-plug stopped working after first event** — serialosc only fires one `/serialosc/add` or `/serialosc/remove` notification per subscription. Without re-subscribing, subsequent plug/unplug events were silent.

### Fixes

- **Ignore `/sys/disconnect` and `/sys/connect` entirely** — these are ambiguous with multiple devices. Device lifecycle now handled exclusively via `/serialosc/add` (connect) and `/serialosc/remove` (disconnect), which carry device IDs.
- **Skip re-detection for already-known devices** — if a `/serialosc/add` arrives for a device ID that's already registered, skip it. Breaks the feedback loop.
- **Re-subscribe to serialosc notifications after every add/remove** — ensures hot-plug detection continues working indefinitely.
- **Suppress `/sys/port`, `/sys/host`, `/sys/prefix` echo logs** — these are just the device echoing back config commands.

## Canvas Pan & Zoom — replacing ensureAllBoxesVisible (2026-03-20)

### Problem

Patches authored on a large monitor (LG 28MQ780) didn't fit on the 13" M2 MBP used for performances. The previous fix (`ensureAllBoxesVisible`) nudged box coordinates toward the synth border to force-fit the viewport, but this caused critical bugs:

- Boxes pushed across the synth border were excluded from serialization, silently dropping ~20 objects from the patch
- Boxes stacked on top of each other, making the patch unreadable
- The nudge was unbounded and violated zone invariants

### Root cause

The fundamental mistake was treating a **viewport problem** as a **layout problem**. The patch coordinates were correct — they just didn't fit on a smaller screen. Mutating coordinates to force-fit destroyed layout and broke zone semantics.

### Solution: view-only pan & zoom

Added pan and zoom as a pure view transform — patch coordinates are never modified.

**Pan gestures:**
- Two-finger scroll / trackpad
- Scroll wheel
- Middle-click drag
- Spacebar + drag

**Zoom:**
- Ctrl/Cmd + scroll (anchored on cursor position)
- `z` key toggles between zoom-to-fit and 100% reset

**Removed:**
- `ensureAllBoxesVisible()` — deleted entirely
- `l` key binding (was tidyLayout) — `tidyLayout()` still exists but is unbound

**Key design decisions:**
- Pan/zoom is not serialized — it's a per-session view concern, not patch data
- Undo preserves view position (doesn't snap back on undo)
- Overlay UI (status, connection dot, client count) draws in screen space
- Synth border, boxes, cables all draw in patch space via canvas transform
- `zoomToFit()` called on patch load to auto-fit content to current viewport
- Zoom capped at 100% (never zooms in past native size) and minimum 15%

## Shared evaluation module — graph-core.js (2026-03-20)

### Problem

`server.ts` (ctrl-side evaluation) and `graph.js` (synth-side evaluation) contained ~500 lines of duplicated logic: `expandIntegerNotation`, `advanceSig`, box state initialization, pure math evaluation, tick logic, and event handling. Every new box type had to be implemented in both files and kept in sync.

### Solution

Extracted shared evaluation logic into `public/graph-core.js` (~450 lines), imported by both server (via CJS) and browser (via `<script>` tag). The shared module provides:

- `createBoxState(type, args)` — unified state initialization for all stateful box types
- `evaluatePure(type, args, iv)` — stateless math evaluation (+, -, *, /, scale, clip, mtof, etc.)
- `evaluateStateful(type, state)` — read current output from stateful boxes
- `handleBoxEvent(type, state, iv)` — event-triggered state mutations, returns `{ value, propagate }`
- `tickBox(type, state, iv, dt)` — time-step advancement, returns `{ value, events[] }`
- `sigmoidShape()`, `cosineShape()` — pure envelope shape functions
- `isEventTrigger(type, inlet)` — check if an inlet triggers event handling

**Result:** graph.js dropped from 1009 → 389 lines. server.ts dropped from 2150 → ~1900 lines. 432 fewer lines total, zero duplicated evaluation logic.

### Propagation model remains separate

The shared module is pure logic — no I/O or propagation. Each consumer wraps results with its own wiring:
- Server: `setBoxValueAndNotify()` → `propagateAndNotify()` → routers → WebSocket
- Client: `propagateInGraph()` → engine param updates → AudioWorklet

## Device initialization on apply (2026-03-20)

### Problem

After applying a patch (Cmd+Enter), `boxValues.clear()` destroyed all device values. Control devices (arc, breath, bite, etc.) had no value until the user physically moved them, leaving the synth side in an undefined state.

### Solution

Added `evaluateAllDevices()` which runs after `evaluateAllConsts()` during apply. Ctrl device boxes now propagate init values through the graph on apply:

- Per-device defaults: breath/bite → 0, arc → 0.5, nod/tilt → 0.5
- Optional init arg overrides: `arc 0 0 0.7`, `breath 0.3`
- Toggle boxes also propagate on apply, with optional init: `toggle 1`
- Pre-sets `boxValues` before `setBoxValueAndNotify` to suppress spurious onset events

### BoxValue type fix

Widened the type system to make arrays first-class: `type BoxValue = number | number[]`. Grid-array was already passing `number[]` through functions typed as `number` — TypeScript flagged this with 3 errors that had been silently ignored. Added type guards at the boundary where ctrl-side boxes narrow to `number`.

## Explicit audio signal routing — DAC, effects, audio cables (2026-03-20)

### Architecture change

Engines were previously implicit audio sinks — they auto-connected to `voice.destination` internally. Now the audio signal chain is explicit in the patch graph:

```
formant → reverb → dac
```

**New concepts:**
- `dac` box — audio output (maps to `voice.destination`). Zone: synth, role: "dac".
- `role` field on engine/effect/dac types in gpi-types.js — replaces the old `outlets.length === 0` heuristic for engine detection.
- Audio cables — visually distinct (bold blue `#8af`, 2.5px width) from control cables (grey, 1px). Connection validation prevents audio↔control mismatches.
- Audio port type `"audio"` — in gpi-types.js inlet/outlet definitions. Audio ports render in blue.

**Signal flow:** `main.js` traces `audioCables` from the serialized patch, walking backward from the DAC through effects to engines, and builds the corresponding Web Audio node graph. Multiple engines into one DAC sum automatically (Web Audio native behaviour).

**Breaking change:** old patches without a `dac` box produce no audio. Add a `dac` and wire engine audio outlets to it.

### New engines

**Reverb** (`reverb-processor.js`, ~130 lines) — 4-line FDN:
- Mutually prime delay lengths [1087, 1283, 1511, 1753] samples
- Hadamard 4x4 feedback matrix (energy preserving)
- 2 cascaded allpass diffusers at input (53, 79 samples, g=0.6)
- LFO modulation on delay read positions (de-comb filtering)
- One-pole LP in feedback path (absorb parameter)
- DC blocker on output
- Freeze mode: decay ≥ 0.999 → feedback = 1.0
- Params: size, decay, absorb, mix, modSpeed, modDepth

**Swarm** (`swarm-processor.js`, ~200 lines) — stochastic event pool:
- 128 pre-allocated events (parallel typed arrays)
- Poisson trigger (once per audio block)
- Per-event: damped sinusoid + optional chirp + optional noise transient + optional biquad resonator
- Params: rate, freqMin, freqMax, chirp, decay, amplitude, transientMix, resonatorQ, density
- Parameter regimes yield creek (low rate, no chirp/transient), fizz (high rate, chirp), rain (moderate rate, high transientMix)

### Logic operators

Added `&&`, `||`, `xor`, `!`, `>`, `<`, `==` to gpi-types.js and graph-core.js. Truthy: >0, falsy: ≤0, output: 1 or 0.

### Server serialization

`serializeSynthPatch()` now emits a separate `audioCables` array alongside control `cables`. Engine/effect/dac boxes include a `role` field. `paramNames` uses null placeholders for audio inlets to preserve index alignment with cable `dstInlet`.

### `fan` box — multi-value output

New box type `fan` outputs stored values on separate outlets when triggered. `fan 30 500 4000` has 3 outlets; click or trigger inlet to fire all values simultaneously. Useful for preset recall — wire each outlet to a different engine inlet.

### Swarm DSP audit and fixes (2026-03-21)

Opus audit identified several bugs in swarm-processor.js:

**Decay mapping** — was `0.99 + decay * 0.00995` (14ms-2.9s range, too narrow at the short end for fizz). Now uses T60-based mapping: `T60 = 0.001 + decay * 0.499` seconds, giving 1ms (fizz) to 500ms (long ring). Per-sample multiplier computed from `exp(-6.9 / (T60 * sr))`.

**Poisson trigger** — was a regular clock (uniform spacing). Now uses exponential inter-arrival times: `nextEvent += -ln(U) / rate`. Gives natural clustering/gaps.

**Noise transient** — was flat-amplitude rectangle (clicks at transition). Now has linear decay envelope with variable length 1-5ms.

**Amplitude randomization** — widened from 50-100% to 0-100% of amplitude param for more natural variation.

**Other fixes:** random initial phase (prevents phase alignment), phase wrapping (prevents float precision loss), proper biquad impulse injection via flag.

### Swarm physical modelling improvements (2026-03-21)

Implemented 9 recommendations from perceptual research (Geffen et al. 2011, van den Doel 2005, Zheng & James):

1. **Log-uniform frequency distribution** — equal probability per octave, not per Hz
2. **Amplitude-frequency correlation** — 1/f scaling (bigger bubble = louder)
3. **Constant-Q decay** — T60 = Q/freq. Decay param maps to Q (5-30 cycles). The key perceptual finding: humans detect constant-time decay as unnatural
4. **Downward chirp with decay** — auto-chirp when chirp=0, bubbles settle to Minnaert frequency
5. **Filtered noise transients** — one-pole LP on noise, exponential envelope
6. **Transient-sinusoid overlap** — cross-fade during transient window
7. **Temporal clustering** — rate modulated by slow mean-reverting random walk
8. **Global spectral shaping** — gentle LP on output (air absorption)
9. **Sibling bubble spawning** — 30% chance of 1-3 related-frequency siblings

Pool increased to 192. Added DC blocker on output. Added `ready` flag to prevent spawning before first params message (fixes duplicate engine sound in Firefox).

### Async load race condition fix (2026-03-21)

`loadPatchForVoice` is async (awaits worklet module loading). When the synth client receives the patch twice in quick succession (initial state + apply), the first load's engines get built, then immediately torn down by the second load — wasteful and producing duplicate audio.

**Root cause:** The SSE→WebSocket upgrade in `connection.js`. SSE opens, server sends `deployedPatch` via SSE. Meanwhile `tryWebSocket()` is called, WebSocket opens, server sends `deployedPatch` again via WS. Both messages reach `voiceOnMessage` → two `loadPatchForVoice` calls.

**Fix:** Added `upgrading` flag in `connection.js`. When SSE opens and WebSocket upgrade begins, SSE messages are suppressed. Only WebSocket messages are delivered. If WebSocket fails, the flag clears and SSE resumes as active transport. Single patch load, no teardown of wasted work.

## CC box, scale curve, and patching improvements (2026-03-25)

### Generic MIDI CC input (`cc` box)
- `cc 14` — listens to CC#14, outputs 0-1
- `cc` (bare, no arg) — monitor mode, displays incoming CC number and value on the box (like `print`)
- Unknown MIDI devices no longer auto-create `key` boxes — user places `cc` or `key` explicitly

### Scale curve parameter
`scale` now accepts an optional third argument for response curve: `scale 100 5000 3` applies `pow(input, 3)` before mapping. Curve=1 is linear (default), >1 is exponential (good for frequency knobs), <1 is logarithmic.

### Patching changes
- Multiple cables to the same inlet now allowed (last value wins, like Pd)
- Bare key shortcuts: `n`=new, `s`=save, `S`=save abstraction, `o`=open (avoids fighting browser Cmd shortcuts)

## AudioParam migration — MessagePort → AudioParam for all engine params (2026-03-25)

### Problem

All engine worklets received parameter values via `port.postMessage({ type: "params", ... })` with custom per-worklet portamento smoothing. This required:
- 15-25 lines of portamento boilerplate per worklet (`targets`, `current`, `portamentoAlpha`)
- An `audioConnectedParams` Set + notification message to switch between MessagePort and AudioParam per-param
- The `ready` flag pattern (swarm) to gate processing until first async message arrived
- No way to unify with native Web Audio nodes (which use AudioParams, not MessagePort)

### Fix

Migrated all engine worklets to receive numeric parameters exclusively via AudioParam:
- `sendParams()` now calls `param.setTargetAtTime(value, now, 0.005)` — smoothing handled natively
- All portamento boilerplate removed from worklets (targets, current, smoothing loops)
- `audioConnected` notification message removed from `audio-graph.js`
- Formant engine reads per-sample from `parameters[name]` for audio-rate modulation
- Swarm uses `amplitude: 0` default to gate spawning (replaces `ready` flag)
- KS processor keeps MessagePort only for `{ type: "excite" }` (imperative trigger)

### Why this matters

Native Web Audio nodes (OscillatorNode, BiquadFilterNode, GainNode, etc.) use AudioParams. With worklets also on AudioParams, the patching system can treat custom worklets and native nodes identically — unified parameter delivery via `setTargetAtTime`. This is the foundation for exposing Web Audio API nodes as GPI objects.

## Native Web Audio API nodes in GPI (2026-03-25)

Added `oscillatorNode`, `gainNode`, `biquadFilterNode` as native Web Audio objects in the patching system. These use the browser's built-in audio processing — no custom worklets.

- `oscillatorNode sawtooth` — OscillatorNode with type arg. Params: frequency, detune
- `gainNode 0.5` — GainNode with initial gain arg. Param: gain
- `biquadFilterNode highpass` — BiquadFilterNode with type arg. Params: frequency, Q, gain, detune

Native nodes use `paramMap` (direct AudioParam references) instead of `worklet.parameters`. `sendParams()` and `audio-graph.js` handle both transparently. `createNativeNode()` creates and starts the node; teardown calls `.stop()` for oscillators.

Example subtractive synth chain: `oscillatorNode sawtooth → biquadFilterNode lowpass → gainNode → dac`

## UI improvements (2026-03-25)

- Enter key on selected box starts text editing
- Fixed input text alignment: `boxWidth()` was measuring empty input because `editingBoxId` was set before input value was populated. Moved value assignment before width calculation.
- Chrome auto-scroll on `input.select()` defeated with `requestAnimationFrame(() => scrollLeft = 0)`

## Removed `role` field — derive from port types (2026-03-25)

The `role` field (`"engine"`, `"effect"`, `"dac"`, and proposed `"signal"`) was an artificial distinction. An `osc~` used for modulation and an `osc~` going to speakers are the same object — the wiring determines the role, not a label.

Replaced with port-type helpers: `hasAudioIn()`, `hasAudioOut()`, `isDac()`, `isAudioBox()`. The server derives `engine` flag and `paramNames` from port types: any synth-zone box with audio ports and number inlets gets paramNames. The topology builder checks for audio inlets to determine recursive wiring, not a role string.

This simplification is prerequisite for the `~` paradigm — audio-rate signal objects need to work identically whether they're modulating a parameter or producing audible output.

## Explicit audio-rate `~` paradigm (2026-03-25)

### Architecture

Introduced Pd-style `~` suffix objects for explicit audio-rate signal processing. The user places `osc~` when they want audio-rate, `lfo` when they want control-rate — no inference, no auto-hoisting.

**New `~` objects:**
- `sig~` — number→audio bridge (ConstantSourceNode). The explicit converter between control and audio worlds.
- `osc~` — audio oscillator (native OscillatorNode wrapper)
- `lfo~`, `phasor~` — audio-rate modulation sources (existing worklet processors)
- `noise~` — white noise source (new `noise-signal-processor.js`)
- `ar~` — audio-rate AR envelope
- `+~`, `-~`, `*~`, `/~` — audio-rate math (existing `math-processor.js`)
- `scale~`, `clip~`, `mtof~`, `slew~` — audio-rate utilities

**Audio→AudioParam modulation:** Audio cables from `~` outlets can connect to number inlets on engines/effects. `buildAudioTopology` detects this: if the destination inlet maps to an AudioParam (paramName is not null), it does `srcNode.connect(param)`. This is the foundation for FM synthesis, filter modulation, etc.

**Connection rules:**
- audio→audio: OK (signal routing)
- audio→number: OK (AudioParam modulation)
- number→audio: REJECTED (use `sig~` to bridge)
- number→number: OK (control)

**Port colours:** blue=audio, orange=event, white=number.

### Removed `audio-graph.js`

The automatic audio-rate hoisting system (`identifyAudioBoxes`, `buildAudioSubgraph`, `CONTINUOUS_TYPES`, `loadModWorklets`, `audioConnectedParams` notification) is deleted entirely. All audio-rate processing is now explicit via `~` objects placed by the user. Removed from `main.js`, `graph.js`, `index.html`, `ensemble.html`.

### `~` naming convention

All objects with audio ports get the `~` suffix. Renamed: `dac~`, `formant~`, `swarm~`, `sine-osc~`, `noise-engine~`, `karplus-strong~`, `shepard~`, `impulse-cloud~`, `reverb~`, `oscillatorNode~`, `gainNode~`, `biquadFilterNode~`. Removed `bass~` (redundant with native nodes). Breaking change for all existing patches.

### `sig~` portamento

`sig~` now accepts an optional portamento time arg: `sig~ 0.1` = 100ms glide. Also settable dynamically via inlet 1. The `portaTime` is used by `sendParams` as the `setTargetAtTime` time constant.

### Wireless connections

Control-rate: `send`/`s` + `receive`/`r` (one-to-many), `throw`/`catch` (many-to-one summing). Audio-rate: `send~`/`s~` + `receive~`/`r~`, `throw~`/`catch~`. Do not cross the ctrl/synth membrane — server evaluates ctrl-zone wireless, client evaluates synth-zone wireless. Audio wireless uses pass-through GainNodes connected during topology build.

### Math processor race condition fix

`createMathNode` was sending `{ op, arg }` via `postMessage` after construction, but the worklet constructor defaulted to `op: "+"`. If `process()` ran before the message arrived, `*~` would add instead of multiply. Fixed by passing `processorOptions: { op, arg }` in the constructor options.

### Wireless send/receive fix for router targets

Wireless sends (`s`, `send`) in the synth zone weren't forwarding when reached via router entries. `processRouterValue` delivered the value but `propagateInGraph` never triggered the wireless forwarding (send boxes have no outlet cables). Fixed by adding wireless type checks directly in `processRouterValue`.

### AudioParam zeroing on audio connection

When an audio cable connects to a number inlet (AudioParam modulation), the intrinsic value is now zeroed: `param.setValueAtTime(0, now)`. This makes the audio signal the actual value, not additive to the default. Without this, `*~ → oscillatorNode~.frequency` would add to the 440Hz default instead of replacing it.

### No-inlet audio boxes (noise~, const~)

`serializeSynthPatch` only marked boxes as `engine: true` if they had inlets. Boxes with audio outlets but no inlets (`noise~`, `const~`) were never created on the synth client. Fixed by checking `isAudioBox()` without the inlet count condition.

### New objects

- `const~` — constant audio signal (ConstantSourceNode, no inlets)
- `**~` — audio-rate exponent

### Audio-rate envelope migration (2026-03-25)

All envelope processors (sigmoid~, cosine~, ramp~) migrated from MessagePort to AudioParam for numeric params. Triggers stay on MessagePort. `sendParams` now forwards "trigger" and "gate" messages via MessagePort automatically.

Fixed trigger-before-process race: envelope processors now use `_pendingTrigger` flag. Trigger handler sets flag, `process()` reads fresh AudioParam values before starting the envelope.

New audio-rate envelopes: `adsr~`, `sigmoid~`, `cosine~`, `ramp~`, `step~` (new worklet).

### Merged seq object (2026-03-26)

`sig` (stochastic integer generator) and `sequence` merged into `seq`. Supports all behaviours: `seq 0,0.5,1 asc` (default), `seq 1-12 shuffle`, `seq 100,200 random`, `seq 5,3,1 desc`. Float values supported via comma separation, integer ranges via dash notation.

### Group router (2026-03-26)

`group N` partitions phones into N equal-ish groups. N value inlets + 1 shuffle inlet, 1 outlet. Server sends directly to group members (no wasted bandwidth). Groups auto-rebuild on client connect/disconnect. Removed `fraction` router (achievable synth-side with `random → gate`).

### Fixes (2026-03-26)

- `sendParams` now uses `setValueAtTime` (instant) instead of `setTargetAtTime` (smoothed). Smoothing is explicit via `sig~` portamento. Fixes stale param values at trigger time.
- Event boxes flash briefly on click (value bar 1→0 over 100ms).
- `sig~` portamento settable via inlet 1.
- Synth-side const propagation now uses `propagateInGraph` (full graph traversal including wireless sends). Fixes const→send→receive paths not reaching engines.
- `getInletDef`/`getOutletDef` helpers resolve port definitions for dynamic types (group router shows correct port colours).
- Border drag collects boxes to keep them in their zone.
- LFO processor: removed minValue constraint, clamps in process() instead (no console warnings).

### UI improvements (2026-03-26)

- Arrow key nudging: arrows move selected boxes 1px, shift+arrows 20px.
- Copy/paste: Cmd+C copies selected boxes + internal cables, Cmd+V pastes with offset and new IDs.
- Random now accepts optional curve arg: `random 0 1 2` biases toward min.
- Scale value bar normalizes display to the scale's own range.

## Chaotic attractor modulation — chaos~ (2026-03-28)

### Motivation

Inspired by Nonlinear Circuits (Andrew Fitch) Eurorack modules, particularly the Sloth series. Chaotic systems provide modulation that is bounded, correlated across outputs, and never repeats — qualities that are uniquely interesting for distributed synthesis where each phone can run the same attractor from different initial conditions, producing coherent but non-unison variation.

### Implementation

New `chaos-processor.js` AudioWorklet with 3-channel output (x, y, z state variables). RK4 integration with adaptive normalisation. 22 selectable systems via arg:

**Classic attractors:** `rossler`, `lorenz`
**Sprott simple chaotic flows:** `sprott-b` through `sprott-s` (19 algebraically simple systems, 5-6 terms each)
**Simplest chaotic flow:** `jerk` (Sprott's x''' + Ax'' - x'² + x = 0)
**NLC-inspired:** `sloth` (mathematical essence of the double-scroll comparator system, not circuit model)

**Parameters:**
- `speed` (inlet 0) — time dilation. 1=audio rate, 0.01=slow modulation, 0.00001=glacial drift
- `param` (inlet 1) — system-specific character (e.g. Rössler's c, Lorenz's rho)

**Multi-output architecture:** First `~` object with 3 audio outlets. Uses ChannelSplitter to separate 3-channel worklet output into individual GainNodes. `getEngineOutput(engine, outletIndex)` selects the correct output. `buildAudioTopology` passes `cable.srcOutlet` to source node selection.

**Per-instance divergence:** Random initial conditions ensure each phone's chaos trajectory diverges immediately (butterfly effect). All phones are on the same attractor but at different positions — coherent without unison.

### References

- Sprott, "Some Simple Chaotic Flows" (Physical Review E, 1994)
- Sprott, "Simplest Dissipative Chaotic Flow" (Physics Letters A, 1997)
- Nonlinear Circuits Sloth Chaos (Andrew Fitch)
- Hetrick/NonlinearCircuits VCV Rack port (DSP by Don Cross)

## Chaos-driven swarm engine (2026-03-28)

Replaced `Math.random()` in the swarm event spawner with an embedded Rössler attractor. Events are now temporally correlated: chaos x modulates event rate (natural clustering), chaos y drives frequency selection (spectral sweeps), chaos z drives amplitude (emergent dynamics). Only noise burst samples remain random (because that IS noise).

New `chaosSpeed` AudioParam controls attractor traversal speed independently of event rate. Per-instance random initial conditions ensure each phone diverges.

Fixed attractor stepping: was stepping once per event spawn (barely moving). Now steps continuously per audio block (`chaosSpeed * 10` steps/block) plus between consecutive event spawns. Eliminates spectral bias from attractor's natural orbital frequency.

## Knob object (2026-03-28)

Interactive `knob` box with scroll wheel control. Args: `knob init [min] [max] [curve]`. Shift+scroll for fine control. Value displayed underneath the box (args stay visible). Value bar normalised to range in pre-curve space. Curve arg applies `pow` mapping (same as `scale`).

Propagates init value on apply. Server handles `knob` message type for real-time updates.

## Ctrl-side audio — ~ objects above the border (2026-03-28)

### Architecture change

All `~` objects changed from `zone: "synth"` to `zone: "any"` — they can now live in either ctrl or synth zone. Where they are determines which AudioContext they run on:
- **Synth zone (below border)**: phone AudioContext, routed via synth patch deployment
- **Ctrl zone (above border)**: laptop AudioContext, built locally by ctrl client

### Ctrl audio topology

The ctrl client now has a full `buildCtrlAudioTopology()` that mirrors main.js: creates AudioWorkletNodes, native Web Audio nodes, wires audio cables, handles AudioParam modulation, wireless send~/receive~, and multi-output nodes (chaos~). Rebuilt on every apply.

### Multi-channel `dac~` for ES-8

`dac~` in ctrl zone takes channel arguments: `dac~ 3` routes to ES-8 channel 3, `dac~ 1 2` stereo to channels 1+2. Uses ChannelMergerNode with discrete channel interpretation. No args defaults to stereo (channels 1+2).

`dac~` in synth zone remains mono (dual-mono to phone speakers), no channel args.

### Server changes

`shouldServerEval` now skips `isAudioBox` boxes — audio boxes run on clients, not the server. `propagateAndNotify` sends `ctrl-audio-param` and `ctrl-audio-event` messages to the ctrl client when control values reach ctrl-zone audio boxes. Replaces the old `engine-param` system entirely.

### What this enables

- CV output to Eurorack via ES-8 (8-channel DC-coupled)
- Direct synthesis from ctrl client to PA (bass, effects)
- Same `~` objects, same patching, different output destination
- Full audio-rate signal chains on the laptop alongside phone distribution

## Audio input — adc~ (2026-03-28)

`adc~ 1` reads from audio interface input channel 1 (1-indexed). Shared `getUserMedia` call across all `adc~` boxes with echo cancellation, noise suppression, and auto gain control disabled (essential for DC-coupled CV from ES-8). ChannelSplitterNode separates channels, each `adc~` taps its channel via GainNode. Enables bidirectional CV bridge with Eurorack.

## scope~ — decoupled 3D Lissajous oscilloscope (2026-03-29)

### Disarticulation from formant~

The 3D Lissajous scope was hardwired to formant~'s internal F1/F2/F3 analyser channels. Now `scope~` is a standalone GPI object that accepts any 3 audio signals as X/Y/Z coordinates. formant~ gains 4 audio outlets (main + F1 + F2 + F3) so formants can be routed to scope~ or used elsewhere.

### scope~ features

**Audio inlets:** x, y, z (position), colour (brightness along knot)
**Number inlets:** hue, saturation, persistence, zoom, spin, density, bgR, bgG, bgB

**Per-vertex colour:** Each point stamped with current hue at write time. Changing hue only affects new points — the trail paints a colour history. Brightness from 4th audio inlet drives HSB B channel per-vertex.

**Continuous ring buffer:** 256K vertex capacity. One point per render frame at density=0 (71 min trail), up to 2048 points per frame at density=1 (~2 sec of audio-rate detail). Persistence and density are independent orthogonal controls.

**Per-axis auto-scaling:** Each axis (X/Y/Z) tracks its own peak and normalises independently. Prevents one dominant axis from squashing the others.

**AnalyserNode fftSize=2048:** ~42ms window overlaps frame intervals (~16.6ms), eliminating gaps between frames for continuous LINE_STRIP rendering.

### formant~ multi-output

formant~ now exposes 4 audio outlets via ChannelSplitter → individual GainNodes, same architecture as chaos~. Outlet 0 = main audio, outlets 1-3 = F1/F2/F3 formant signals.

### Object tooltips

Hovering over a box body shows description, args, and example in the tooltip.

### scope~ audio-rate HSB colour (2026-03-29)

Unified colour model for knot and background. Knot colour is fully audio-rate HSB via 3 audio inlets (knotH, knotS, knotB) — each vertex carries its own hue, saturation, and brightness. Background uses control-rate HSB via number inlets (bgH, bgS, bgB) with JS-side HSB→RGB conversion.

Replaces the previous single `colour` audio inlet + `hue`/`saturation` number inlets. 6 audio inlets total (x, y, z, knotH, knotS, knotB). 7 floats per vertex in the ring buffer.

### Dynamic inlet colouring

Number inlets turn blue when an audio-rate cable is connected, showing they're receiving audio-rate modulation.

### Chaos processor stability fixes (2026-04-03)

**Sloth**: replaced hand-tuned coefficients with exact NLC circuit-derived values. y coupling was 1000× too small, z derivative 1000× too small. Now uses actual component values (C1=2µF, C2=1.42µF, C3=50µF, R1=1MΩ, etc.) with proper ±11.38V/-10.64V comparator switching. Produces double-scroll chaos at Torpor speed (~24s orbit).

**General stability**: per-system `ATTRACTOR_BOUNDS` table eliminates adaptive normalisation jitter. On-attractor initial conditions (`ATTRACTOR_ICS`) avoid transient warm-up. Energy-based damping at 2× expected bound prevents slow divergence. System-specific blow-up thresholds with on-attractor reset.

**Scope batched upload**: replaced per-vertex `bufferSubData` calls (2048 individual calls at density=1) with single batched upload. Eliminates frame rate drops at high density.

**Instance divergence**: increased IC jitter from ±0.005 to ±0.25, plus random Euler warm-up (50K-150K steps, ~1-2 orbits) to spread instances across the attractor. Each phone lands at a different orbital phase immediately — no waiting for butterfly effect.

## 2026-04-03 — macOS Startup Automation

### Problem
Every time the hardware was set up at a new location, the ethernet interface name changed (en5 → en6 etc.), the DHCP-assigned IP didn't match what the FritzBox was handing out as DNS, and stale dnsmasq processes from previous sessions blocked startup. Required manual editing of `start-macos.sh`, `server.ts`, and `/opt/homebrew/etc/dnsmasq.d/assembly.conf` each time.

### Solution
`start-macos.sh start` now handles everything in a single command:
- **Auto-detects** whichever interface has a `192.168.178.x` address
- **Enforces static IP** `.24` (matching FritzBox DNS config) via `ifconfig` if DHCP assigned something different
- **Kills stale dnsmasq** if running with wrong interface/IP, skips restart if already correct
- **Auto-updates dnsmasq config** (`/opt/homebrew/etc/dnsmasq.d/assembly.conf`) when interface or IP changes
- **Runs dnsmasq + Deno in one terminal** — Ctrl+C cleans up both
- Server default `HOST_IP` changed to `.24` to match FritzBox config, eliminating need to pass env vars through `sudo`

### Other fixes
- HTTPS server now binds to `0.0.0.0` (was missing `hostname`, defaulting to localhost-only)
- dnsmasq health check in server.ts queries `127.0.0.1:53` instead of external interface (macOS firewall blocks the latter)
- Banner shows LAN IP and clickable `https://localhost/ctrl.html` for local ctrl access
- Self-signed cert generation for dev/testing (no Let's Encrypt needed)

### Two-computer dev setup
MBP (ES-8 for CV) + Mac Studio (Arturia 16Rig for audio monitoring). Mac Studio on "assembly" wifi connects via captive portal. MBP accesses ctrl at `https://localhost/ctrl.html` while connected to home wifi on a different interface.

## 2026-04-03 — trig~ object, multi-channel output fix

### trig~ — CV trigger pulse
New audio-rate object for sending CV triggers via ES-8. Outputs amplitude for a fixed number of samples, then drops to 0. Duration in samples (default 64 ≈ 1.3ms at 48kHz) — appropriate for eurorack trigger signals.

- **Inlets:** trigger (event), amplitude (number), samples (number)
- **Outlets:** trigger signal (audio)
- Registered in both synth-side (`main.js`) and ctrl-side (`ctrl.js`) worklet maps

### Multi-channel dac~ output on macOS
macOS CoreAudio applies surround speaker mapping (7.1 etc.) to multi-channel devices, reordering channels. `dac~ 8` was routing to physical output 4 instead of 8 on the ES-8.

**Fix (two parts):**
1. **Code:** Set `channelInterpretation = "discrete"` and `channelCount = maxChannelCount` on the AudioContext destination immediately at init, before any connections. Also set `channelCountMode = "explicit"` and `channelInterpretation = "discrete"` on the ChannelMerger.
2. **macOS config:** Create an **Aggregate Device** wrapping the ES-8 in Audio MIDI Setup and set it as default output. Aggregate devices bypass CoreAudio's surround speaker mapping and present channels sequentially 1:1.

### Sensible defaults audit (2026-04-03)

Audited all audio worklet processors for silent-failure defaults. Several objects had `amplitude: 0` as default, meaning creating them with no args produced silence with no error.

**Fixed amplitude defaults (0 → 0.5):** formant~, sine-osc~, noise-engine~, karplus-strong~, swarm~

**Fixed swarm~ texture defaults:** transientMix (0 → 0.3), resonatorQ (0 → 5)

**Fixed math operator defaults:** `/~` and `**~` with no args now default operand to 1 instead of 0 (avoids divide-by-zero / useless exponentiation).

### sall — wireless send-all router (2026-04-03)

New router object: `sall name` combines wireless send with an `all` router. One box replaces the `s → r → all → s → r` chain for ctrl→synth value broadcasting.

- Zone: router (snaps to border)
- 1 inlet, 0 outlets — value goes wireless
- On the server: propagates to ctrl-side `r name` boxes AND broadcasts `rv` to all synth clients
- On synth clients: entries map directly to synth-side `r name` boxes by matching the name argument
- Usage: `sall freq` on the border, `r freq` anywhere on the synth side

### Fix: synth-side metro progress leaking into event inlets

Metro's continuous progress value (0→1) was propagating to engine `trigger`/`gate` inlets, causing ramp~ to re-trigger on every tick instead of once per cycle. Added `isEvent` flag to `propagateInGraph` — event params on engines only fire when the propagation originates from an actual event (metro bang, handleEvent), not from continuous value updates. Router value paths (`processRouterValue`) also propagate with `isEvent=true` since `rv` messages are discrete.

### Propagation model audit (2026-04-03)

Audited our propagation model against Pure Data's. Identified core architectural drift: Pd has two separate data planes (messages = discrete/depth-first, signals = continuous/block-computed) while our system collapsed them into one path, patching ambiguity with the `isEvent` flag.

**Key divergences from Pd:**
- Metro outputs progress values into the graph (Pd metro only outputs bangs; progress is not observable)
- No hot/cold inlet distinction (Pd: only inlet 0 triggers computation; our math boxes re-evaluate on any inlet)
- Events and values share one propagation path (Pd: bang is a distinct message type)
- Two-phase propagation (our adaptation of Pd's right-to-left convention — this is reasonable)

**Planned refactor:**
1. Split `propagateInGraph`/`propagateAndNotify` into separate value and event paths, typed by outlet definition
2. Separate metro display value (UI-only) from output value (propagation-only)
3. Adopt hot/cold inlet semantics for pure math boxes
4. Evaluate Pd convenience objects (`trigger`, `pack`/`unpack`, `select`, etc.) for managing execution order

### Propagation refactor (2026-04-04)

Implemented the planned refactor across all four critical files.

**Phase 1 — Split propagation (graph.js, server.ts):**
Replaced `propagateInGraph` with two functions: `propagateValue` (stores values, skips engine trigger/gate) and `propagateEvent` (fires bangs, sends trigger/gate=1). Removed the `isEvent` parameter entirely. Metro tick values no longer propagate — generalized to any box with event-typed outlet 0 via `isEventOutlet()`.

**Phase 2 — Hot/cold inlets (graph-core.js, graph.js, server.ts):**
Inlet 0 is hot (triggers evaluation), all others cold (store silently). `isHotInlet()` in graph-core.js. Math boxes (+, -, *, / etc.) no longer re-evaluate when inlet 1 changes.

**Phase 3 — Typed outputs + Pd convenience objects (graph-core.js, gpi-types.js):**
`handleBoxEvent` outputs now carry `type: "value"|"event"`. New boxes:
- `trigger`/`t` — right-to-left outlet firing (b=bang, f=float)
- `select`/`sel` — match→event on outlet N, reject→value on last outlet
- `spigot` — conditional pass (gate on inlet 1)
- `swap` — swap two stored values, fire right-to-left

Added `firesEvent()` function: inlets where arriving values also trigger event handling (trigger, select, swap inlet 0).

**Architecture fix — no BOX_TYPES in graph.js:**
Initially referenced `BOX_TYPES` from gpi-types.js for inlet/outlet metadata, but synth clients (index.html, ensemble.html) don't load gpi-types.js. This caused `ReferenceError` on ensemble clients. Moved all metadata into self-contained functions in graph-core.js: `isEventTrigger`, `firesEvent`, `isHotInlet`, `isEventOutlet`. graph.js now has zero dependency on gpi-types.js.

**Router event propagation (server.ts, graph.js):**
Events flowing through routers (sall, all, etc.) were being broadcast as `rv` (router value), losing their event nature. Synth clients couldn't trigger ramp~/ar~/etc. via routed events. Fix: `propagateAndNotify` detects event-typed source outlets and passes `isEvent` to `handleRouterInlet`, which broadcasts `re` (router event) instead of `rv`. Fixed `processRouterEvent` key format and stateless `r` box passthrough.

**Ctrl-side audio param timing (server.ts, ctrl.js):**
`ctrl-audio-param` messages were sent before the ctrl client finished rebuilding its audio graph (async worklet loading). Params were silently dropped. Fix: ctrl client sends `ctrl-audio-ready` after `buildCtrlAudioTopology()` completes; server re-evaluates all consts/devices on receipt.

**Other fixes:**
- `**~` and `**`/`pow` now sign-preserving: `sign(x) * |x|^y` — no more NaN for negative bases, correct bipolar CV shaping
- `ramp~` and `ramp` gained a `curve` parameter (1=linear, >1=exponential, <1=logarithmic)
- Fixed control-rate `ramp` state init: `to=0` no longer overridden to 1 (falsy `||` default bug)

**Cosmetic animations for ctrl-side audio boxes (server.ts):**
Ctrl-side audio boxes (trig~, ramp~, ar~, etc.) run their signal in the ctrl client's worklet — no server-side state. For visual feedback, the server now maintains lightweight cosmetic shadow state:
- `trig~`, `ar~`, `sigmoid~`, `cosine~`, `step~`: brief flash (80ms) on trigger
- `ramp~`: progress bar that sweeps 0→1 over the duration with curve shaping, matching the worklet's behaviour

Shadow state reads from `inletValues` (which now stores ctrl-audio-param values alongside forwarding to the worklet). This is explicitly cosmetic — the worklet remains the source of truth for the actual signal.

## 2026-04-04 — Bidirectional Comms: sendup/uplink + touch sensor

### The problem
Data flow was strictly one-directional: ctrl → server → synth clients. No way for a phone to send data back. This blocked **sortition** — selecting one audience member to control all phones via touch.

### New box types

**`sendup name1 [name2 ...]`** (zone: synth) — sends values from phone back to server on named channels. Dynamic ports: N inlets, one per name arg. Wire protocol: `{ type: "up", ch: "name", v: value }`. SSE-only clients silently drop (graceful degradation).

**`uplink name1 [name2 ...]`** (zone: ctrl) — receives values from synth clients on named channels. Dynamic ports: N outlets. Server matches incoming `up` messages to uplink boxes and calls `propagateAndNotify()` — same injection pattern as `cc`, `key`, `arc`.

**`touch [prompt]`** (zone: synth) — full-screen pointer capture. Inlet 0: gate (show/hide overlay). Outlets: x (0-1), y (0-1), gate (0/1). Pink overlay with prompt text. Pointer events throttled to ~30fps (every other pointermove). Auto-dismisses on finger-up when gated.

### Architecture

The `sendup`/`uplink` pair is general-purpose plumbing — the reverse of `sall`/`r`. Touch is just one sensor that uses it. Future sensors (accelerometer, mic level, buttons) follow the same pattern: synth-side source → `sendup` → server → `uplink` → ctrl graph.

Graph evaluation collects uplink messages in `graph.uplinkQueue` during propagation. After each evaluation cycle (rv, re, tick), `drainUplinks()` sends them via WebSocket.

### Multi-name sall extension
`sall` now supports multiple named buses: `sall freq vowelX` = 2 inlets, each broadcasting to its own named bus. `processRouterEvent` updated to accept channel parameter.

### Gel stack visual paradigm
Separated synth-side visuals into composable full-screen layers (theatrical gel stack metaphor):

- **`screen [z]`** — colored rectangle. Inlets: r, g, b, a (all 0-1). Alpha controls visibility.
- **`text [z] content...`** — centered text. Content from args (first arg is z if numeric, rest is text). Inlets: size, a.
- **`touch`** — stripped to pure sensor. No visuals. Pointer capture on invisible full-screen surface.
- **`scope~`** — removed bgH/bgS/bgB inlets. Canvas now clears to transparent. Background comes from `screen` layers behind it.

Layer manager in main.js creates/destroys DOM elements on patch load. Each layer is a `position: fixed; inset: 0` div with z-index from args. System layers (overlay, status bar) at reserved z-levels.

### Toggle fix
Toggle was broken — inlet 0 was typed as `number` ("set") but toggle is stateful and needs event-driven flip. Added `handleBoxEvent` case for toggle (flips state.value 0↔1) and registered inlet 0 as event trigger in `isEventTrigger`.

### Display layer initial render fix
`setupLayers()` was called after `initialValues` were applied but `updateDisplayLayers()` wasn't called after setup, so initial layer state was never rendered. Added `updateDisplayLayers(voice)` call right after `setupLayers(voice)` in `loadPatchForVoice`.

## 2026-04-05 — GPI Audit: Inlet Regime, Scope Gel Stack, Cleanup

Full audit of box type consistency across zones, inlet/outlet ordering, args, and naming.

### Inlet regime fixes
Established convention: inlet 0 = primary action (trigger/gate), subsequent = params by importance.

- **`phasor`**: reordered from pause(0)/reset(1)/period(2) to reset(0)/period(1)/pause(2). Updated `isEventTrigger`, `tickBox`, `handleStatefulInlet`, and synth-side `processRouterValue`.
- **`ramp`**: added from(1)/to(2)/duration(3)/curve(4) inlets after trigger. Previously params were args-only with no runtime override. Now matches `ramp~`.
- **`adsr`**: added a(1)/d(2)/s(3)/r(4) inlets after gate. Previously params were args-only. Now matches `adsr~`.

### scope~ gel stack integration
- Zone: `"any"` → `"synth"` (only makes sense on phones)
- Added z-index arg: `scope~ 5` sets layer z-order
- Added alpha inlet (position 10): composable with screen/text layers
- Removed hardcoded `<canvas id="scope">` from index.html and ensemble.html
- Canvas now dynamically created by layer manager on patch load
- Alpha applied via `sendParams` → layer opacity (separate from scope.js params)

### Cleanup
- Deleted `pow` box (redundant with `**`)
- Clarified `gate` vs `spigot` descriptions (gate zeros output; spigot blocks propagation)
- Removed dead `handleStatefulInlet` toggle code (toggle now uses event path)

## 2026-04-07 — cute-sine~ engine, touch mouse gating, dev mode, router event fix

### cute-sine~ engine
- New additive sine oscillator with 6 harmonics and brightness crossfade
- Ported from lcld.xyz/240326_infinite_appreciation
- Inlets: freq, amplitude, bright (0=fundamental only, 1=all harmonics)
- All params a-rate for audio-rate modulation

### Touch mouse gating
- Touch capture element now only sends x/y/gate when mouse button is held down
- Previously `pointermove` fired regardless of button state, sending data with gate=1 even when not clicking

### start-macos.sh dev mode
- `./start-macos.sh dev` runs Deno with `--watch` for auto-reload on file changes
- Manages dnsmasq lifecycle same as default mode (was missing, causing DNS resolution failures)

### Router event display fix
- `"re"` (router event) handler in synth client was missing `checkTouchGate()` and `updateDisplayLayers()` calls
- Events through routers updated graph state correctly but display/touch layers never re-read the values
- `"rv"` (router value) handler had both calls, so only event-based routing was broken

### "hot" modifier for math boxes
- Math boxes (`+`, `-`, `*`, `/`, `**`, etc.) now accept `hot` arg: e.g. `** hot`, `* hot`
- Makes all inlets hot — any inlet receiving a value triggers evaluation
- Solves cold-inlet problem where changing values on inlet 1 were stored but never triggered re-evaluation
- Implemented in `isHotInlet()` (graph-core.js) and server-side propagation (server.ts)

### CNA portal escape for Android
- Captive portal redirect now goes to `/portal.html` landing page instead of directly to synth client
- Android: uses intent URI to escape CNA webview into default browser, with 500ms fallback to direct navigation
- iOS: direct link (Safari handles CNA links natively)
- Needs multi-device testing (flagged in memory)

### cute-sine~ inlet reorder + amplitude convention
- Reordered cute-sine~ inlets: freq, bright, amplitude (was freq, amplitude, bright)
- Matches convention across other engines: amplitude is always the rightmost inlet
- Changed amplitude defaultValue from 0.5 to 0 in processor

### Touch y-axis inversion
- Touch y output is now 1 at top, 0 at bottom (was inverted)

### New/updated box types
- **const**: added event inlet 0 — re-propagates stored value on bang
- **toggle**: added set inlet 1 — sets to 0 (on 0) or 1 (on >0), only propagates on change
- **event**: added trigger inlet 0 — receiving an event fires the event (same as clicking)
- **change**: new box — only passes value through when it differs from previous
- **select/sel**: fixed outlet typing — reject outlet (last) now correctly typed as number, not event

### New boxes: floor, ceil, round, map, length
- `floor`, `ceil`, `round` — integer rounding primitives
- `map 0 4 7 11` — index lookup into arg values (clamped). Inlet 1 accepts array to replace table dynamically (e.g. from grid-array)
- `length` — outputs array length (returns 1 for non-array values)
- Server-side `propagateAndNotify` coerces non-numbers to 0 for ctrl-side boxes — `length` and `map` needed special handling to receive raw arrays

### Synth-side initial value propagation fix
- `buildGraph` init pass was only propagating `const` boxes
- Generalized to propagate all boxes with `state.value !== undefined` (const, toggle, range, drunk, random, spread)
- Fixes chains like `const 220 → * hot` where the const value never reached the math box

### select/sel outlet type fix
- Reject outlet (last) was incorrectly typed as "event" due to `getOutletDef` repeating the single dynamic outlet definition
- Fixed: match outlets are events, reject outlet is number

### Data-driven inlet routing
- Added `INLET_MAPS` and `applyInletToState()` to graph-core.js
- Maps inlet index → state field with optional min/max clamping for 11 box types
- Collapsed ~80 lines of per-type if/else branches across graph.js and server.ts into single generic calls
- Special cases preserved: toggle (change-sensitive), map (array/lookup), change (dedup), phasor (event), metro (boolean inversion)
- Adding a new box type with stateful inlets is now one line in INLET_MAPS

### Engine factory extraction
- Extracted shared engine creation code into `engine-factory.js` (~255 lines)
- Eliminates ~400 lines of duplication between ctrl.js and main.js
- ENGINES, SIGNAL_WORKLETS, MATH_OPS, createNativeNode, createSignalWorklet, createMathNode, createEngine, getEngineOutput — all defined once
- Caller-specific nodes (adc~ for ctrl, scope~ for synth) handled via specialHandler callback
- IIFE wrapper avoids global scope pollution; access via window._engineFactory
- Adding a new engine type is now a single-file change

### PatchEditor extraction + abstraction editor
- Extracted PatchEditor class (~1500 lines) from ctrl.js into `patch-editor.js` as reusable ES module
- ctrl.js slimmed from ~2400 to ~800 lines — imports PatchEditor + constants + helpers
- Three coupling points resolved via constructor options: `onSend`, `onOpenAbstraction`, `tooltipEl`
- New standalone `abs-editor.html` + `abs-editor.js` — opens in separate browser window via Shift+N or double-click on abstraction instance
- Clean import graph: `gpi-types.js ← patch-editor.js ← ctrl.js / abs-editor.js`
- Cross-window clipboard via localStorage (copy in ctrl, paste in abs-editor)
- Abstraction editor: no synth/ctrl membrane, own keyboard shortcuts, Cmd+S saves, beforeunload dirty prompt
- Server: iterative abstraction expansion (nesting up to 16 levels), $0/$1/$2 argument substitution, zone inheritance (cloned boxes get Y of instance), error reporting to ctrl client, synthBorderY stripped on save
- Server: `.html` added to static file extension whitelist

### --watch fix for non-imported files
- `gpi-types.js` and `graph-core.js` are loaded via `readTextFile` + `importCjs`, not Deno imports
- Deno's `--watch` didn't track them — changes required manual server restart
- Fixed by adding explicit `--watch=server.ts,public/gpi-types.js,public/graph-core.js`
- Root cause of a confusing bug: inlet reorder in gpi-types wasn't picked up, stale paramNames sent wrong values to engine params

### PatchState extraction (step 1 of server.ts split)
- Audited all 20 Maps in server.ts — 11 are module-local, 9 cross module boundaries
- Cross-module Maps fall into two patterns: shared graph state (5 core Maps) and one-way pipelines (4 Maps)
- Extracted `patch-state.ts` (77 lines, zero dependencies) at project root as Deno-only ES module
- Moved: 9 Maps (`boxes`, `cables`, `boxValues`, `inletValues`, `boxState`, `routerState`, `groupState`, `latestValues`, `uplinkIndex`), 3 scalars (`patchNextId`, `synthBorderY`, `deployedPatch` via getter/setter), interfaces (`Box`, `Cable`, `BoxValue`), 4 helpers (`clearPatchState`, `removeCablesForBox`, `cablesFromOutlet`, `isSynthZone`)
- Scalars use getter/setter functions (not `export let`) for readability — avoids `import *` syntax requirement
- `bumpPatchNextId(id)` helper replaces the repeated `if (id >= patchNextId) patchNextId = id + 1` pattern
- server.ts: 2213 → 2185 lines (net -28 after removing declarations, adding import)
- Since patch-state.ts is a real `import`, Deno `--watch` tracks it automatically (unlike `readTextFile` + `importCjs` modules)
- Tested with sendup_test patch: apply, propagate, deploy all working

### hardware.ts extraction (step 2 of server.ts split)
- Extracted all grid, arc, and OSC/serialosc code into `hardware.ts` (561 lines)
- Moved: 6 hardware-local Maps (`gridRegions`, `gridToggleStates`, `gridArrayStates`, `arcEncoders`, `arcValues`, plus device state), all OSC encoding/parsing, all grid/arc handlers, `initGrid()`, `rebuildGridRegions()`
- Dependency injection via `initHardware()` — server passes `setBoxValueAndNotify`, `sendCtrl`, `event`, `boxTypeName`, `getBoxDef` as callbacks, avoiding circular imports
- `arcValues` exported for the one line in `evaluateAllDevices()` that sets arc init values
- `getGridDeviceInfo()` / `getArcDeviceInfo()` exported for ctrl client sync on connect
- hardware.ts imports from `patch-state.ts` directly (`boxes`, `boxValues`) — no server.ts dependency
- server.ts: 2185 → 1618 lines (-567)
- Tested with sendup_test patch

### eval-engine.ts extraction (step 3 of server.ts split — complete)
- Extracted propagation, routing, evaluation, tick loop, and animations into `eval-engine.ts` (636 lines)
- Moved: router state functions (`buildGroups`, `handleRouterInlet`, `routerDispatch`, `sendViaRouter`, `sendCommandViaRouter`, `traceToRouters`, `sendEnvCommand`), evaluation core (`evaluateBox`, `setBoxValueAndNotify`, `propagateAndNotify`, `evaluateAllConsts`, `evaluateAllDevices`), box state management (`initBoxState`, `shouldServerEval`, `initAllBoxState`), tick loop (`tick`, `handleStatefulInlet`, `handleEventBox`, `ctrlAudioTrigger`, `tickCtrlAudioAnims`), wireless helpers, value batching (`queueValueUpdate`, `pendingValueUpdates`, flush interval), MIDI CC mapping
- Dependency injection via `initEvalEngine()` — server passes `broadcastSynth`, `sendToClient`, `getSynthClientIds`, `sendCtrl`, `event`, plus gpi-types/graph-core functions (`boxTypeName`, `getBoxDef`, `getBoxZone`, `isAudioBox`, `evaluatePure`, `createBoxState`, `tickBox`, `handleBoxEvent`, `applyInletToState`)
- `expandAbstractions` + `loadedAbstractions` stayed in server.ts — patch transformation, not evaluation
- server.ts: 1618 → 1037 lines (-581)
- Tested with sendup_test patch

### server.ts split — final structure
| File | Lines | Role |
|------|-------|------|
| server.ts | 1037 | HTTP/WS/SSE, client tracking, edit/apply dispatch, deploy, storage API |
| eval-engine.ts | 636 | Propagation, routing, evaluation, tick loop, animations |
| hardware.ts | 561 | Monome grid, arc, OSC/serialosc |
| patch-state.ts | 77 | Shared Maps, scalars, pure helpers |

All modules use dependency injection (`initX()` callbacks) to avoid circular imports. Import graph: `patch-state.ts ← eval-engine.ts / hardware.ts ← server.ts`. No module imports from server.ts.

### CNA portal redesign
- Replaced Android intent URI approach with universal tap-to-copy-URL flow
- URL shown prominently with clipboard API + execCommand fallback
- Chrome recommended explicitly for AudioWorklet support
- "Open in browser" link as secondary path
- Uses `var` (not const/let) for maximum CNA webview compatibility
- Silent `/auth` ping preserved

### MIDI key handling fix
- Server `key` handler now propagates pitch (outlet 0) and velocity (outlet 1) separately — was sending note number from both outlets
- ctrl.js: note-off (`0x80`) messages now handled, sending velocity 0
- Server: synth client IPs auto-authenticated on WS connect (stops CNA probe redirect spam)

### karplus-strong~ engine rewrite
- Root cause: delay line topology was broken — pluck noise was written ahead of writePos but process loop read behind it, so noise was overwritten before being read
- Removed all MessagePort/postMessage code — excitation now exclusively via AudioParam edge detection (rising edge past 0.5), consistent with all other engines
- Damping default changed from 0.5 to 0.996 (standard KS feedback coefficient)
- `frequency` paramName in gpi-types fixed to match processor (was `freq`, causing param routing to fail)
- KS now produces sound via AudioParam control — tested via console
- **Still TODO**: key → router → KS excitation path not triggering from ctrl client (values reach engine but pluck doesn't fire — likely a routing/timing issue)

### New patches (initial versions)
- **sparkly-keys**: MIDI keyboard → karplus-strong~ with reverb (WIP, routing issue above)
- **infants**: Grid-toggle just-intonation tones (1, 5/4, 4/3, 3/2, 2/1) with 5 sine-osc~ voices, 2s fades, cathedral reverb
- **epimetheus**: Sortition touch control — swarm~ water + cute-sine~ crossfade via grid-triggered phone selection (complex, untested)

### Fix key → KS routing
- Root cause: `initialValues` in `serializeSynthPatch()` sent raw `boxValues` (note number, e.g. 60) for the key box through the velocity cable path, poisoning KS excitation's edge detector (`excPrev` stuck at 60, so `0.8 > 0.5 && 60 <= 0.5` always false)
- Fix: removed `initialValues` entirely from server.ts and main.js — redundant since `latestValues` already handles synth client state sync correctly
- 26 lines removed, 0 added. KS now plucks on first keypress from ctrl client.

### karplus-strong~ trigger → port message
- Reverses the "exclusively via AudioParam edge detection" decision from the recent rewrite. Rationale: a-rate edge-detect was never used musically, and all other tilde trigger boxes (ar~, adsr~, sigmoid~, cosine~, ramp~, step~, trig~) already go through port messages. Unifying gets rid of a one-off mechanism.
- `ks-processor.js`: removed `excitation` AudioParam and `excPrev` edge-detector. Added `port.onmessage` handler that sets `pendingPluck = true` on `{type:"trigger"}`; `process()` fires at top of next block.
- `gpi-types.js`: renamed inlet 3 from `excitation` (number) to `trigger` (event, description "Fire a pluck"). Server-derived `paramNames[3]` becomes `"trigger"`, which `main.js:204` already catches and translates to `port.postMessage({type:"trigger"})`. No changes to graph.js required — the existing `paramName === "trigger" || paramName === "gate"` handshake just works.
- Reference doc fixes: `reference/build_order.md` and `reference/program_layer.md` updated to drop `excitation` from KS AudioParam lists.

### karplus-strong~ allpass fractional delay
- Fixes the classic KS high-octave flattening. Root cause: the integer-sample delay line could only approximate the true period, and the two-point loop lowpass adds ~0.5 samples of group delay that always makes pitch flatter. At 880 Hz the combined error was ~15¢ flat; by A6+ it was tens of cents, unusable for tonal music.
- Added a one-pole allpass between the delay-line read and the loop filter. `totalDelay = sampleRate/freq - 0.5` compensates the filter's group delay; `intDelay = round(totalDelay - 1)` picks a buffer-read position such that the allpass fractional delay `d = totalDelay - intDelay` lands in [0.5, 1.5] — the well-conditioned range for the one-pole form. Coefficient `C = (1-d)/(1+d)`; recurrence `y[n] = C*(x[n] - y[n-1]) + x[n-1]`.
- Output and loop feedback both use the allpass-filtered signal (not the raw buffer read), so the pitch the listener hears matches the loop's actual period.
- `pluck()` resets the allpass state alongside `lpPrev` for clean re-plucks.

### karplus-strong~ decay (seconds) + stiffness cascade
- **Param rename**: `damping` (0-1 per-sample feedback coefficient) → `decay` (T60 in seconds). Worklet computes `damp = 0.001^(1/(freq*decay))` per block so decay time is uniform across the pitch range instead of 1/f (each octave halving). Default 2.0s.
- **New param**: `stiffness` (0-1). Drives a cascade of K=4 first-order allpasses in the feedback loop with coefficient `a = -0.9 * stiffness`. Produces frequency-dependent phase delay: low modes slower, high modes faster, so the Nth mode tunes progressively sharp of N×f₀ — physical inharmonicity. Stiffness=0 is classic harmonic KS.
- **Fundamental-tuning compensation**: stiffness cascade has nonzero phase delay at f₀, so we compute its phase delay analytically (two `atan2`s at block rate) and subtract from the target loop delay. The tuning allpass picks up the fractional remainder. Result: stiffness sweeps don't wobble the fundamental — they only change the harmonic structure above it.
- **Inlet layout**: follows the convention (set by `sine-osc~`, `cute-sine~`, `noise-engine~`, `shepard~`, `formant~`) that `amplitude` is the rightmost inlet. Final order: `frequency, decay, brightness, stiffness, trigger, amplitude`. This shifts `trigger` from index 3 → 4 and `amplitude` from 4 → 5 relative to the prior layout, so existing patches using those inlets need re-cabling. Inlet 1 is now `decay`, semantically different from the old `damping`. Per prototype-mode: no compatibility shim.
- **Doc sync**: `reference/build_order.md`, `reference/program_layer.md` updated.
- Deleted `public/audio-graph.js` (462 lines) — orphaned remnant of the automatic audio-rate hoisting system that was torn out when the explicit `~` convention landed. No HTML file loaded it; its functions (`identifyAudioBoxes`, `buildAudioSubgraph`, `createContinuousNode`, `forwardDiscreteValue`, `forwardEvent`) had no callers. `engine-factory.js` does the equivalent job now, triggered by the user typing `~` rather than inferred from topology.

### Router events lost channel on generic `all` path
- `eval-engine.ts` `handleRouterInlet`: the `re` message built for generic routers (`all` and fall-through) omitted `ch`, so `processRouterEvent` on the client side always defaulted to channel 0 regardless of which inlet fired. Events into `all 2` inlet 1 were therefore delivered on outlet 0 of the synth-side router, never reaching cables wired from outlet 1.
- The value path (`sendViaRouter`) and the `sall` event path both already included `ch`; only the generic-router event path was wrong. One-line fix: `{ type: "re", r: routerBoxId, ch: inlet }`.

### Router events dropped when target was an engine inlet
- `public/graph.js` `processRouterEvent` had two branches — `node.state` → `handleEvent`, else propagate from outlet 0 — and no engine branch. When the router delivered an event whose target was an engine's trigger/gate inlet (e.g. `all 2` → `karplus-strong~` trigger), the engine has no `state` so the code fired an event OUT of the engine's audio outlet 0 into `dac~`, a no-op. The trigger paramName was never written.
- Fix: add an engine-destination branch that mirrors the value path in `processRouterValue` — `allUpdates[box][paramName] = 1` when the target inlet resolves to `"trigger"` or `"gate"`.
- Both this and the `ch`-on-`re` bug were discovered debugging sparkly-keys (MIDI key → `> 0` → `sel 1` → `all 2` → KS trigger). Each one alone kept the patch silent.

### Architecture note — destination-dispatch duplication (deferred refactor)

Both router-event bugs above were instances of the same pattern: the **value path had a case the event path was missing**. Bug 1 (server): value path included `ch` in the outbound message, event path didn't. Bug 2 (client): `processRouterValue` handled engine destinations; `processRouterEvent` didn't.

**Root cause.** Propagation code has two axes — kind (value / event) and route (normal cable / router entry) — giving four top-level functions: `propagateValue`, `propagateEvent`, `processRouterValue`, `processRouterEvent`. Each one independently enumerates *every destination type* (engine AudioParam, stateful control box, wireless send/throw, phasor, adsr, toggle, …) inline. A new destination type has to be wired into all four; miss one and you get a silent-path bug.

The 2026-04-04 propagation refactor split value vs event at the top level (correct — they have different semantics at every inlet), but didn't factor the destination dispatch below that split. So the split accumulated duplication instead of simplifying it.

**Proposed fix.** Extract a per-inlet delivery layer:

```
deliverValueToInlet(graph, boxId, inlet, value) → updates
deliverEventToInlet(graph, boxId, inlet) → updates
```

All destination-type logic lives inside those two functions. Then:
- `propagateValue` walks outlet cables → calls `deliverValueToInlet` per cable.
- `propagateEvent` walks outlet cables → calls `deliverEventToInlet` per cable.
- `processRouterValue` walks entries → calls `deliverValueToInlet`.
- `processRouterEvent` walks entries → calls `deliverEventToInlet`.

Normal-cable vs router-entry axis collapses to "how do I find the destination"; destination dispatch becomes one place per kind. Adding a destination is editing 2 files instead of 4.

Server side (`eval-engine.ts`) has an analogous wart: `handleRouterInlet(..., isEvent)` builds `rv` / `re` messages with slightly different shapes inline. A `buildRouterMessage(routerId, ch, kind, value?)` helper would prevent the shape drift that caused Bug 1.

**When to do this.** Not mid-session after debugging. The propagation layer is load-bearing and silent-miswire is the worst failure mode. Do it as:
- A pre-step when adding a new destination type (the new case lands in one place, cost of porting existing cases is justified), OR
- A focused standalone session with a behavioural-equivalence test plan: a matrix of (kind × destination × route) sample patches that must route identically before and after.

### `one N` — explicit-fire bundling router
- `one` (no arg) keeps its current auto-advance-on-value behavior: single data inlet, shuffle on inlet 1. Patches using it aren't affected.
- `one N` (arg ≥ 1) is a new bundling variant. Inlets 0..N-1 are cold-stored data inlets; inlet N is `fire` (event); inlet N+1 is `shuffle`. Outlets 0..N-1 are passthrough; outlet N is event. A fire event dispatches every stored value + the event atomically to the current target phone, then advances the pointer. Stored values persist across fires, so you can set long-lived state (e.g. decay, brightness) once and then fire trigger+freq bundles to walk through phones.
- Data inlets that have never been set produce no message — partial bundles are legitimate.
- Server-side state: extends `routerState` entry with `storedValues: Record<number, unknown>`. Dispatch sends one `rv` per stored inlet followed by one `re` for the fire event, all to a single client via `_sendToClient`.
- Client-side changes: none. Existing `processRouterValue` / `processRouterEvent` (with the engine-destination branch fixed earlier in this session) handle the incoming messages unchanged.
- Known latent issue surfaced during implementation (not fixed): `propagateAndNotify` uses `def.inlets[cable.dstInlet]` and `def.outlets[outletIndex]` — the static defs — to determine inlet/outlet types. For dynamic boxes like `one N` and `sel 1 2`, indices beyond the static def return undefined. The typical path (event sources into router fire/shuffle inlets) still works because `isEventSource` covers the common case, but relying on the source rather than the destination is fragile. Fits the destination-dispatch duplication deferred refactor; fix there.

### `held` + `sort` + `nth` — MIDI held-notes accumulator with array accessors
- `held` (ctrl-zone, stateful): two inlets (pitch, velocity), four outlets (held-array, added-event, removed-event, count). Velocity > 0 adds pitch to an ordered set in press order; velocity == 0 removes. Dedupe on repeat-press (no-op, no `added` event); graceful skip on release-without-press. Array re-emits on every event arrival so downstream stays live; outlet 0 is a fresh copy so consumers can't mutate internal state.
- `sort [desc]` (pure): numeric sort of an incoming array, ascending by default, `desc` arg flips. Non-array input passes through.
- `nth N` (pure): extract element at index N with JS `at()` semantics (negative counts from end). Empty / out-of-bounds / non-array → 0, keeping the chain numeric-safe.
- All three slot into existing switch statements (`createBoxState`, `evaluatePure`, `handleBoxEvent`, `isEventTrigger` in `public/graph-core.js`) plus a `gpi-types.js` entry each. No changes to `eval-engine.ts` or client-side propagation — arrays already travel as first-class inlet values within the ctrl zone (they can't cross to synth via `rv` messages, which only carry numbers, so held-note patches must terminate extraction in ctrl-zone before sending to phones).
- Covers arp-in-press-order (`held → seq`), ascending/descending arp (`held → sort [desc] → seq`), min/max (`held → sort → nth 0/-1`), latest-press / earliest-press mono-priority (`held → nth -1/0`), count-gated textures (`held → length`).
- Smoke-tested via CJS-shim script: add/remove/dedupe/release-not-held semantics verified; sort/nth edge cases (non-array, empty, out-of-bounds, negative indices) verified.

### Next up
- **Abstraction workflow** needs more testing: argument substitution ($1/$2), nesting, error reporting
- **CNA portal** needs multi-device testing (Chrome Android, Samsung, iOS)
