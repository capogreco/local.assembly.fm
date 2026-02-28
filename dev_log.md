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
