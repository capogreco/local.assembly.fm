// Fabricate onboarding QR assets — run via `deno task qr`.
// Writes ./onboarding/{wifi,synth}.{svg,gif} + poster.svg for the performer to
// drop into a poster / flyer / projected slide. Two QRs kill both onboarding
// hops: WiFi-join (get on the network) and synth-URL (open the instrument).
//
// Config via env: MODE, WIFI_SSID, WIFI_PASSWORD, WIFI_AUTH, HOST_DOMAIN.
import { audienceBase, getLanIP, qrGif, qrText, wifiPayload } from "./onboarding.ts";

const MODE = Deno.env.get("MODE") ?? "practice";
const HOST_DOMAIN = Deno.env.get("HOST_DOMAIN") || "local.assembly.fm";
const WIFI_SSID = Deno.env.get("WIFI_SSID") || "assembly";
const WIFI_PASSWORD = Deno.env.get("WIFI_PASSWORD") ?? "assembly";
const WIFI_AUTH = Deno.env.get("WIFI_AUTH") || "WPA";

// Per-mode audience network (mirrors the MODES table in server.ts — kept local
// so this tool runs standalone without importing/booting the server).
const NET: Record<string, { scheme: string; host: string; port: number }> = {
  practice: { scheme: "http", host: "localhost", port: 8443 },
  workshop: { scheme: "https", host: getLanIP() ?? "0.0.0.0", port: 8443 },
  performance: { scheme: "https", host: HOST_DOMAIN, port: 443 },
};
const net = NET[MODE];
if (!net) {
  console.error(`✗ Unknown MODE "${MODE}". Use practice | workshop | performance.`);
  Deno.exit(1);
}

const synthUrl = audienceBase(net) + "/";
const wifi = wifiPayload({ ssid: WIFI_SSID, password: WIFI_PASSWORD, auth: WIFI_AUTH });

const OUT = "onboarding";
await Deno.mkdir(OUT, { recursive: true });

const wifiSvg = await qrText(wifi, "svg");
const synthSvg = await qrText(synthUrl, "svg");
await Deno.writeTextFile(`${OUT}/wifi.svg`, wifiSvg);
await Deno.writeTextFile(`${OUT}/synth.svg`, synthSvg);
await Deno.writeFile(`${OUT}/wifi.gif`, await qrGif(wifi));
await Deno.writeFile(`${OUT}/synth.gif`, await qrGif(synthUrl));
await Deno.writeTextFile(
  `${OUT}/poster.svg`,
  buildPoster({ wifiSvg, synthSvg, ssid: WIFI_SSID, password: WIFI_PASSWORD, url: synthUrl }),
);

console.log(`\x1b[32m✓ wrote onboarding assets to ./${OUT}/\x1b[0m  [${MODE}]`);
console.log(`  wifi:  ${WIFI_SSID} / ${WIFI_PASSWORD}  (${WIFI_AUTH})`);
console.log(`  synth: ${synthUrl}`);
console.log(`  files: poster.svg, wifi.{svg,gif}, synth.{svg,gif}`);
if (MODE === "workshop") {
  console.log("  note: self-signed cert — audience taps through the browser warning after scanning.");
}
if (MODE === "practice") {
  console.log("  note: practice URL is localhost — fabricate in workshop/performance for a real audience.");
}

// --- poster composition (two QRs + readable labels in one SVG) ---

function xmlEscape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

// Nest a QR's <svg> at a given position/size (it carries its own viewBox).
function place(svg: string, x: number, y: number, size: number): string {
  return svg.replace("<svg ", `<svg x="${x}" y="${y}" width="${size}" height="${size}" `);
}

function buildPoster(
  { wifiSvg, synthSvg, ssid, password, url }: {
    wifiSvg: string;
    synthSvg: string;
    ssid: string;
    password: string;
    url: string;
  },
): string {
  const W = 820, H = 540, QR = 280, GAP = 60;
  const lx = GAP, rx = W - GAP - QR, qy = 96;
  const cap = qy + QR + 40, sub = qy + QR + 70;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="${W / 2}" y="56" font-size="36" font-weight="700" text-anchor="middle">local.assembly.fm</text>
  ${place(wifiSvg, lx, qy, QR)}
  ${place(synthSvg, rx, qy, QR)}
  <text x="${lx + QR / 2}" y="${cap}" font-size="24" font-weight="700" text-anchor="middle">1 · join wifi</text>
  <text x="${lx + QR / 2}" y="${sub}" font-size="18" text-anchor="middle" fill="#555555">${xmlEscape(ssid)} / ${xmlEscape(password)}</text>
  <text x="${rx + QR / 2}" y="${cap}" font-size="24" font-weight="700" text-anchor="middle">2 · play</text>
  <text x="${rx + QR / 2}" y="${sub}" font-size="18" text-anchor="middle" fill="#555555">${xmlEscape(url)}</text>
</svg>`;
}
