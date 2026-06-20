// Onboarding helpers — LAN detection, WiFi-QR payloads, audience URLs, and QR
// rendering. The QR encoder (@paulmillr/qr) is lazy-loaded so importing this
// module stays dependency-free; practice mode never pulls it in.

/** First non-loopback IPv4 address on this machine, or null. */
export function getLanIP(): string | null {
  try {
    const ifaces = Deno.networkInterfaces();
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.address.startsWith("127.")) {
        return iface.address;
      }
    }
  } catch { /* permission denied or unavailable */ }
  return null;
}

/** `scheme://host[:port]` with the default port (80/443) omitted. No trailing slash. */
export function audienceBase(
  { scheme, host, port }: { scheme: string; host: string; port: number },
): string {
  const isDefaultPort = (scheme === "https" && port === 443) ||
    (scheme === "http" && port === 80);
  return `${scheme}://${host}${isDefaultPort ? "" : `:${port}`}`;
}

// Backslash-escape the WiFi-QR special characters: \ ; , : "
function escapeWifi(s: string): string {
  return s.replace(/([\\;,:"])/g, "\\$1");
}

/**
 * WiFi-join QR payload. Scanning it offers "join network" on iOS 11+/Android.
 * Format: WIFI:T:<auth>;S:<ssid>;P:<password>;;  (auth = nopass when no password)
 */
export function wifiPayload(
  { ssid, password, auth = "WPA", hidden = false }: {
    ssid: string;
    password: string;
    auth?: string;
    hidden?: boolean;
  },
): string {
  const t = password ? auth : "nopass";
  const p = password ? `P:${escapeWifi(password)};` : "";
  const h = hidden ? "H:true;" : "";
  return `WIFI:T:${t};S:${escapeWifi(ssid)};${p}${h};`;
}

/** Render a QR as text (ascii/term/svg). Lazy-loads the encoder. */
export async function qrText(
  text: string,
  fmt: "ascii" | "term" | "svg",
): Promise<string> {
  // encodeQR is overloaded per output literal; cast to a loose signature so the
  // union fmt type-checks. Runtime dispatches on the actual value.
  const { default: encodeQR } = await import("@paulmillr/qr");
  return (encodeQR as (t: string, f: string) => string)(text, fmt);
}

/** Render a QR as a raster GIF (native, no rasterizer dependency). */
export async function qrGif(text: string): Promise<Uint8Array> {
  const { default: encodeQR } = await import("@paulmillr/qr");
  return (encodeQR as (t: string, f: string) => Uint8Array)(text, "gif");
}
