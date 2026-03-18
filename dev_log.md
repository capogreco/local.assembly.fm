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
