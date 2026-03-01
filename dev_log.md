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
