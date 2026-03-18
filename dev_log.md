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

