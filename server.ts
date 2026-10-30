import {
  type Box, type Cable, type BoxValue,
  boxes, cables, boxValues,
  getPatchNextId, setPatchNextId,
  getBorderY, setBorderY,
  getDeployedPatch, setDeployedPatch,
  routerState, groupState, latestValues, uplinkIndex,
} from "./patch-state.ts";
import { initHardware, initGrid, rebuildGridRegions, arcValues, getGridDeviceInfo, getArcDeviceInfo } from "./hardware.ts";
import {
  initEvalEngine, startEvalEngine, buildGroups,
  buildServerGraph, injectValue, injectEvent, setSourceValue, setToggle, replayLaptopParams,
  evaluateAllClients,
  findBoxByText, CC_SOURCE, queueValueUpdate, sideStamped,
} from "./eval-engine.ts";
import { getLanIP, qrText } from "./onboarding.ts";
import { boxTypeName } from "./public/gpi-types.js";
import { serializeSynthPatch } from "./deploy.ts";
import { type AbstractionDef, applyPatch, checkAbstraction } from "./apply-check.ts";

// Workshop self-signed cert — distinct filenames so generation can never
// clobber a hand-copied Let's Encrypt pair sitting in the repo root.
const SELF_CERT_FILE = "cert.selfsigned.pem";
const SELF_KEY_FILE = "key.selfsigned.pem";
// Repo-root fallback pair — used when no certbot install is present (e.g.
// hand-copied onto a router). Not the primary source anymore.
const CERT_FALLBACK = "cert.pem";
const KEY_FALLBACK = "key.pem";
const HOST_IP = Deno.env.get("HOST_IP") || "192.168.178.24";
const HOST_DOMAIN = Deno.env.get("HOST_DOMAIN") || "local.tamb.fm";
// certbot's live paths — preferred so renewal is zero-copy.
const LE_CERT = `/etc/letsencrypt/live/${HOST_DOMAIN}/fullchain.pem`;
const LE_KEY = `/etc/letsencrypt/live/${HOST_DOMAIN}/privkey.pem`;
// WiFi creds for the join QR / banner (defaults match the performance rig).
const WIFI_SSID = Deno.env.get("WIFI_SSID") || "tambourine";
const WIFI_PASSWORD = Deno.env.get("WIFI_PASSWORD") ?? "tambourine";

// --- Run mode ---
// One explicit switch drives bind host, ports, cert policy, captive portal and
// dnsmasq expectations. Tracks *who the audience is*, not where it runs.
// See notes/network-and-modes.md.
type CertKind = "none" | "self-signed" | "letsencrypt";
interface ModeConfig {
  bindHost: string;          // "127.0.0.1" (laptop only) | "0.0.0.0" (LAN)
  appPort: number;           // 8443 (unprivileged) | 443
  portalPort: number | null; // captive-portal HTTP listener, or null
  needsCaptivePortal: boolean;
  certKind: CertKind;
  needsDnsmasqWarning: boolean;
  needsStaticIP: boolean;    // informational; enforced in start-macos.sh
}
const MODES: Record<string, ModeConfig> = {
  practice:    { bindHost: "127.0.0.1", appPort: 8443, portalPort: null, needsCaptivePortal: false, certKind: "none",        needsDnsmasqWarning: false, needsStaticIP: false },
  workshop:    { bindHost: "0.0.0.0",   appPort: 8443, portalPort: null, needsCaptivePortal: false, certKind: "self-signed", needsDnsmasqWarning: false, needsStaticIP: false },
  performance: { bindHost: "0.0.0.0",   appPort: 443,  portalPort: 80,   needsCaptivePortal: true,  certKind: "letsencrypt", needsDnsmasqWarning: true,  needsStaticIP: true  },
};
const MODE = Deno.env.get("MODE") ?? "practice";
const cfg = MODES[MODE];
if (!cfg) {
  console.error(`\x1b[31m✗ Unknown MODE "${MODE}". Valid modes: ${Object.keys(MODES).join(", ")}\x1b[0m`);
  Deno.exit(1);
}


// --- Status display ---

const status = {
  ctrl: 0,
  synth: 0,
  applied: false,
  lastEvent: "",
  lastEventTime: 0,
};

function event(msg: string): void {
  status.lastEvent = msg;
  status.lastEventTime = Date.now();
  // print event above the status line
  Deno.stdout.writeSync(new TextEncoder().encode(`\r\x1b[K  ${msg}\n`));
  drawStatus();
}

function drawStatus(): void {
  const synth = synthWsClients.size;
  const ctrl = ctrlSockets.size;
  const total = synth;
  const state = status.applied ? "\x1b[32m●\x1b[0m applied" : "\x1b[33m○\x1b[0m idle";
  const clients = total === 0 ? "\x1b[90m0 clients\x1b[0m" : `\x1b[36m${total} client${total !== 1 ? "s" : ""}\x1b[0m`;
  const ctrlLabel = ctrl > 0 ? "\x1b[32mctrl\x1b[0m" : "\x1b[90mctrl\x1b[0m";
  const line = `  ${ctrlLabel}  ${clients}  ${state}`;
  Deno.stdout.writeSync(new TextEncoder().encode(`\r\x1b[K${line}`));
}

// Wire module callbacks (function declarations are hoisted, safe to reference here)
initEvalEngine({
  broadcastSynth, sendToClient, getSynthClientIds, sendCtrl, event,
});
startEvalEngine();
initHardware({ setSourceValue, sendCtrl, event });

// --- TLS cert resolution ---
// Prefer certbot's live paths (zero-copy renewal); fall back to the repo-root
// pair for hosts without certbot. Returns null if neither pair is readable.

async function resolveLetsEncryptCert(): Promise<{ cert: string; key: string } | null> {
  for (const pair of [{ cert: LE_CERT, key: LE_KEY }, { cert: CERT_FALLBACK, key: KEY_FALLBACK }]) {
    try {
      await Deno.stat(pair.cert);
      await Deno.stat(pair.key);
      return pair;
    } catch { /* try next */ }
  }
  return null;
}

// --- Static file serving ---

function mimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html", js: "application/javascript", css: "text/css",
    json: "application/json", png: "image/png", ico: "image/x-icon",
    flac: "audio/flac", wav: "audio/wav", aiff: "audio/aiff", aif: "audio/aiff",
    ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4",
  };
  return types[ext ?? ""] ?? "application/octet-stream";
}

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

// --- Client tracking ---

let nextClientId = 1;
const synthWsClients = new Map<number, WebSocket>();
const ctrlSockets = new Set<WebSocket>();

function totalSynthClients(): number { return synthWsClients.size; }

function broadcastSynth(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const [, socket] of synthWsClients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}

function sendToClient(clientId: number, msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  const ws = synthWsClients.get(clientId);
  if (ws?.readyState === WebSocket.OPEN) ws.send(data);
}

function getSynthClientIds(): number[] {
  return [...synthWsClients.keys()];
}


// Router state, evaluation engine, and tick loop imported from eval-engine.ts

function sendCtrl(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const socket of ctrlSockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
}

function broadcastClientCount(): void {
  const count = totalSynthClients();
  console.log(`  client count: ${count}`);
  broadcastSynth({ type: "count", clients: count });
  sendCtrl({ type: "count", clients: count });
  // Rebuild group router memberships when client count changes
  for (const boxId of groupState.keys()) buildGroups(boxId);
  // Push the new count to every patch-side `clients` box
  evaluateAllClients();
}

// --- IP auth tracking ---
// A phone's IP is authenticated the first time it loads the portal (/auth) or
// connects a synth socket, and stays authenticated until the server restarts.
// There is deliberately no deauth: a locked screen or a stalled socket must not
// send the phone back to the portal, and the LAN is sealed.

const authenticatedIPs = new Set<string>();

// --- Edit handling ---

// --- Apply (replaces entire graph state from ctrl) ---

// deno-lint-ignore no-explicit-any
function handleApply(msg: any): void {
  // Build and validate the new patch in local maps first. A rejected apply
  // leaves the running patch untouched; nothing is half-applied and nothing
  // is silently dropped.
  const { errors, warnings } = applyPatch(msg, loadedAbstractions);
  if (errors.length > 0) {
    for (const err of errors) console.log(`\x1b[31m✗ apply rejected: ${err}\x1b[0m`);
    sendCtrl({ type: "apply-rejected", errors });
    return;
  }

  if (warnings.length > 0) {
    for (const err of warnings) console.log(`\x1b[33m⚠ ${err}\x1b[0m`);
    sendCtrl({ type: "errors", errors: warnings });
  }

  // Phones get the new patch first, so the one side's initial values (sent
  // as the server graph builds) land on it.
  deployPatch();
  buildServerGraph();
  rebuildGridRegions();

  // confirm to ctrl — triggers audio rebuild on ctrl client, which then asks
  // for the laptop params again (ctrl-audio-ready)
  sendCtrl({ type: "applied" });
  status.applied = true;
  event("patch applied");
}

// --- Deploy ---

function deployPatch(): void {
  setDeployedPatch(serializeSynthPatch());
  latestValues.clear();
  // rebuild uplink channel index
  uplinkIndex.clear();
  for (const [id, box] of boxes) {
    if (boxTypeName(box.text) !== "uplink") continue;
    const names = box.text.split(/\s+/).slice(1);
    for (let i = 0; i < names.length; i++) {
      const ch = names[i];
      if (!uplinkIndex.has(ch)) uplinkIndex.set(ch, []);
      uplinkIndex.get(ch)!.push({ boxId: id, outletIndex: i });
    }
  }
  broadcastSynth(getDeployedPatch()!);
  event("patch deployed to " + totalSynthClients() + " clients");
  sendCtrl({ type: "deployed" });
}

// --- Full state sync for ctrl ---

function getFullState(): Record<string, unknown> {
  const bv: Record<number, BoxValue> = {};
  for (const [id, v] of boxValues) bv[id] = v;
  return {
    type: "state",
    // `side` is stamped at apply from position and binding; the editor derives
    // its own, so a stamped one would go stale on the first drag (and be saved).
    boxes: [...boxes.entries()].map(([id, { side: _side, ...box }]) => [id, box]),
    cables: [...cables.entries()],
    nextId: getPatchNextId(),
    borderY: getBorderY(),
    boxValues: bv,
  };
}

// --- Ctrl WebSocket handler ---

function handleCtrlWs(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.addEventListener("open", () => {
    ctrlSockets.add(socket);
    event("ctrl connected");
    drawStatus();
    socket.send(JSON.stringify(getFullState()));
    socket.send(JSON.stringify({ type: "count", clients: totalSynthClients() }));
    const gridInfo = getGridDeviceInfo();
    if (gridInfo) {
      socket.send(JSON.stringify({ type: "grid-connected", deviceType: gridInfo.deviceType, deviceId: gridInfo.deviceId }));
    }
    const arcInfo = getArcDeviceInfo();
    if (arcInfo) {
      socket.send(JSON.stringify({ type: "arc-connected", deviceType: arcInfo.deviceType, deviceId: arcInfo.deviceId }));
    }
  });

  socket.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "apply") {
        handleApply(msg);
      } else if (msg.type === "midi") {
        if (msg.cc !== undefined) {
          // Named CC sources (breath, bite, nod, tilt)
          const name = CC_SOURCE[msg.cc];
          if (name) {
            const id = findBoxByText(name);
            if (id !== null) setSourceValue(id, msg.value / 127);
          }
          const value = msg.value / 127;
          // Generic CC boxes: each box can list one or more CC numbers as args;
          // each arg position maps to a same-indexed outlet. A bare `cc` (no
          // args) is a passive monitor — display the last cc:value, don't
          // propagate.
          for (const [ccId, ccBox] of boxes) {
            if (boxTypeName(ccBox.text) !== "cc") continue;
            const tokens = ccBox.text.split(/\s+/);
            if (tokens.length === 1) {
              boxValues.set(ccId, value);
              queueValueUpdate(ccId, msg.cc + ":" + value.toFixed(2));
              continue;
            }
            for (let i = 1; i < tokens.length; i++) {
              if (parseInt(tokens[i]) === msg.cc) {
                boxValues.set(ccId, value);
                queueValueUpdate(ccId, value);
                injectValue(ccId, i - 1, value);
              }
            }
          }
        } else if (msg.note !== undefined) {
          // Iterate every `key` box and dispatch based on its args:
          //   `key`       — all channels, fire outlets
          //   `key N`     — channel N only (1–16), fire outlets
          //   `key ?`     — all channels, display-only monitor (no outlets)
          const velocity = (msg.velocity ?? 0) / 127;
          for (const [id, box] of boxes) {
            if (boxTypeName(box.text) !== "key") continue;
            const arg = box.text.split(/\s+/)[1];
            if (arg === "?") {
              const display = `? ${msg.note} ${velocity.toFixed(2)} ch${msg.channel}`;
              boxValues.set(id, display);
              queueValueUpdate(id, display);
              continue;
            }
            if (arg !== undefined) {
              const ch = parseInt(arg);
              if (!isNaN(ch) && ch !== msg.channel) continue;
            }
            injectValue(id, 0, msg.note);   // outlet 0: pitch (shown on the box)
            injectValue(id, 1, velocity);   // outlet 1: velocity (0-1)
          }
        }
      } else if (msg.type === "knob") {
        setSourceValue(msg.id, msg.value);
      } else if (msg.type === "toggle-click") {
        setToggle(msg.id, msg.value);
      } else if (msg.type === "ctrl-audio-ready") {
        replayLaptopParams();
      } else if (msg.type === "event-click") {
        injectEvent(msg.id, 0);
        // Flash the event box briefly
        queueValueUpdate(msg.id, 1);
        setTimeout(() => queueValueUpdate(msg.id, 0), 100);
      } else if (msg.type === "peaks") {
        // fftPeaks~ spectral analysis injected from the ctrl client (audio→control).
        // Propagate amps first (outlet 1) so a downstream `assign` stores them before
        // freqs (outlet 0) trigger its reallocation.
        injectValue(msg.box, 1, msg.amps);
        injectValue(msg.box, 0, msg.freqs);
      } else if (msg.type === "health") {
        socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
      }
    } catch (err) { console.error("WS error:", err); }
  });

  socket.addEventListener("close", () => {
    ctrlSockets.delete(socket);
    event("ctrl disconnected");
    drawStatus();
  });

  return response;
}

// --- Synth WebSocket handler ---

const lastNanReport = new Map<number, number>();

function handleSynthWs(req: Request, info: Deno.ServeHandlerInfo): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const id = nextClientId++;
  const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;

  socket.addEventListener("open", () => {
    synthWsClients.set(id, socket);
    authenticatedIPs.add(clientIP);
    drawStatus();
    socket.send(JSON.stringify({ type: "welcome", id, clients: totalSynthClients() }));
    if (getDeployedPatch()) {
      socket.send(JSON.stringify(getDeployedPatch()));
      for (const data of latestValues.values()) socket.send(data);
    }
    broadcastClientCount();
  });

  socket.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "health") {
        socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
      } else if (msg.type === "nan") {
        // A phone's output guard saw NaN. Throttled per client so one broken engine can't flood ctrl.
        const now = Date.now();
        if (now - (lastNanReport.get(id) ?? 0) > 5000) {
          lastNanReport.set(id, now);
          const text = `client ${id}: NaN at output (${msg.count} samples silenced so far)`;
          console.log(`\x1b[33m⚠ ${text}\x1b[0m`);
          sendCtrl({ type: "errors", errors: [text] });
        }
      } else if (msg.type === "build-error" && Array.isArray(msg.boxes)) {
        // A phone couldn't build some boxes. It sends once per patch load; group by
        // type and reason so 40 unbuildable adc~ boxes become one readable line.
        const groups = new Map<string, { type: string; reason: string; ids: number[] }>();
        for (const b of msg.boxes) {
          const key = `${b.type}\0${b.reason}`;
          if (!groups.has(key)) groups.set(key, { type: b.type, reason: b.reason, ids: [] });
          groups.get(key)!.ids.push(b.id);
        }
        const parts = [...groups.values()].map(({ type, reason, ids }) =>
          ids.length === 1 ? `${type} (box ${ids[0]}: ${reason})` : `${type} ×${ids.length} (${reason})`);
        const text = `client ${id}: cannot build ${parts.join(", ")}`;
        console.log(`\x1b[33m⚠ ${text}\x1b[0m`);
        sendCtrl({ type: "errors", errors: [text] });
      } else if (msg.type === "up" && typeof msg.ch === "string") {
        const targets = uplinkIndex.get(msg.ch);
        if (targets) {
          for (const { boxId, outletIndex } of targets) {
            boxValues.set(boxId, msg.v);   // any channel shows, not only outlet 0
            queueValueUpdate(boxId, msg.v);
            injectValue(boxId, outletIndex, msg.v);
          }
        }
      }
    } catch (err) { console.error("WS error:", err); }
  });

  socket.addEventListener("close", () => {
    synthWsClients.delete(id);
    drawStatus();
    broadcastClientCount();
  });

  return response;
}

// --- Request handler ---
// One handler for every mode. The captive-portal CNA branch is active only when
// cfg.needsCaptivePortal (performance); in practice/workshop the probe paths
// fall through to ordinary file serving, so the redirect simply doesn't exist.

function appHandler(req: Request, info: Deno.ServeHandlerInfo, insecure = false): Response | Promise<Response> {
  const url = new URL(req.url);
  const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;

  if (cfg.needsCaptivePortal) {
    const probes = ["/hotspot-detect.html", "/generate_204", "/canonical.html", "/connecttest.txt"];
    if (probes.includes(url.pathname)) {
      if (authenticatedIPs.has(clientIP)) {
        if (url.pathname === "/generate_204") return new Response(null, { status: 204 });
        if (url.pathname === "/connecttest.txt") return new Response("Microsoft Connect Test", { headers: { "content-type": "text/plain" } });
        return new Response("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>", { headers: { "content-type": "text/html" } });
      }
      event(`CNA redirect ${clientIP}`);
      return Response.redirect(`https://${HOST_DOMAIN}:${cfg.appPort}/portal.html`, 302);
    }
  }

  if (url.pathname === "/auth") { authenticatedIPs.add(clientIP); return new Response("ok"); }

  // The portal listener is plaintext. Never serve the app over it: AudioWorklet
  // requires a secure context, so an http client connects, starts, and is
  // silently inert (cost a set's worth of debugging at the 2026-10-10 show).
  // The CNA probes above must still answer on http to trigger the portal.
  if (insecure) {
    const port = cfg.appPort === 443 ? "" : `:${cfg.appPort}`;
    return Response.redirect(`https://${HOST_DOMAIN}${port}${url.pathname}${url.search}`, 302);
  }

  // route WebSocket by path
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (url.pathname === "/ws/ctrl") return handleCtrlWs(req);
    return handleSynthWs(req, info);
  }
  if (url.pathname.startsWith("/patches")) return handlePatchAPI(req, url);
  if (url.pathname.startsWith("/abstractions")) return handleAbstractionAPI(req, url);
  if (url.pathname === "/help" || url.pathname.startsWith("/help/")) return handleHelpAPI(req, url);
  const ext = url.pathname.split(".").pop()?.toLowerCase();
  if (ext && ["html", "js", "css", "json", "png", "ico", "flac", "wav", "aiff", "aif", "ogg", "mp3", "m4a"].includes(ext)) return serveFile(url.pathname);
  return serveFile("/index.html");
}

// --- Patch storage API ---

const PATCHES_DIR = "./patches";
const ABSTRACTIONS_DIR = "./abstractions";
const HELP_DIR = "./help";
await Deno.mkdir(PATCHES_DIR, { recursive: true });
await Deno.mkdir(ABSTRACTIONS_DIR, { recursive: true });
await Deno.mkdir(HELP_DIR, { recursive: true });

// --- Abstraction loading ---

const loadedAbstractions = new Map<string, AbstractionDef>();

async function loadAbstractions(): Promise<void> {
  loadedAbstractions.clear();
  try {
    for await (const entry of Deno.readDir(ABSTRACTIONS_DIR)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      const name = entry.name.replace(".json", "");
      try {
        const data = JSON.parse(await Deno.readTextFile(`${ABSTRACTIONS_DIR}/${entry.name}`));
        const absBoxes = new Map<number, any>();
        const absCables = new Map<number, any>();
        for (const [id, box] of data.boxes) absBoxes.set(id, box);
        for (const [id, cable] of data.cables) absCables.set(id, cable);
        loadedAbstractions.set(name, { boxes: absBoxes, cables: absCables });
      } catch (e) {
        console.error(`Failed to load abstraction ${name}:`, e);
      }
    }
    event(`loaded ${loadedAbstractions.size} abstraction(s)`);
  } catch {
    // Directory may not exist yet
  }
}

// Load abstractions on startup
await loadAbstractions();

function sanitizeName(name: string): string | null {
  const clean = name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim();
  return clean.length > 0 ? clean : null;
}

async function handlePatchAPI(req: Request, url: URL): Promise<Response> {
  const headers = { "content-type": "application/json" };

  // GET /patches — list saved patches
  if (req.method === "GET" && url.pathname === "/patches") {
    const patches: string[] = [];
    for await (const entry of Deno.readDir(PATCHES_DIR)) {
      if (entry.isFile && entry.name.endsWith(".json")) patches.push(entry.name.replace(".json", ""));
    }
    patches.sort();
    return new Response(JSON.stringify(patches), { headers });
  }

  // GET /patches/name — load a patch
  if (req.method === "GET" && url.pathname.startsWith("/patches/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(9)));
    if (!name) return new Response("Invalid name", { status: 400 });
    try {
      const data = await Deno.readTextFile(`${PATCHES_DIR}/${name}.json`);
      return new Response(data, { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  // PUT /patches/name — save a patch
  if (req.method === "PUT" && url.pathname.startsWith("/patches/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(9)));
    if (!name) return new Response("Invalid name", { status: 400 });
    const data = await req.text();
    await Deno.writeTextFile(`${PATCHES_DIR}/${name}.json`, data);
    event(`saved patch: ${name}`);
    return new Response(JSON.stringify({ ok: true, name }), { headers });
  }

  // POST /patches/reveal — open the patches folder in Finder (macOS)
  if (req.method === "POST" && url.pathname === "/patches/reveal") {
    try {
      const cmd = new Deno.Command("open", { args: [PATCHES_DIR] });
      await cmd.output();
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, err: String(err) }), { status: 500, headers });
    }
  }

  // DELETE /patches/name — delete a patch
  if (req.method === "DELETE" && url.pathname.startsWith("/patches/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(9)));
    if (!name) return new Response("Invalid name", { status: 400 });
    try {
      await Deno.remove(`${PATCHES_DIR}/${name}.json`);
      event(`deleted patch: ${name}`);
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  return new Response("Not found", { status: 404 });
}

// --- Abstraction storage API ---

// Help patches are named after the box type they document: `<type>-help.json`,
// with the type's own spelling (a trailing `~` is kept: `ewing~-help.json`).
function sanitizeHelpName(name: string): string | null {
  const clean = name.replace(/[^a-zA-Z0-9_\-~ ]/g, "").trim();
  return clean.length > 0 ? clean : null;
}

async function handleHelpAPI(req: Request, url: URL): Promise<Response> {
  const headers = { "content-type": "application/json" };

  // GET /help — list help patches
  if (req.method === "GET" && url.pathname === "/help") {
    const names: string[] = [];
    for await (const entry of Deno.readDir(HELP_DIR)) {
      if (entry.isFile && entry.name.endsWith(".json")) names.push(entry.name.replace(/\.json$/, ""));
    }
    names.sort();
    return new Response(JSON.stringify(names), { headers });
  }

  const name = sanitizeHelpName(decodeURIComponent(url.pathname.slice(6)));
  if (!name) return new Response("Invalid name", { status: 400 });

  // GET /help/name — load a help patch
  if (req.method === "GET") {
    try {
      return new Response(await Deno.readTextFile(`${HELP_DIR}/${name}.json`), { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  // PUT /help/name — save a help patch
  if (req.method === "PUT") {
    const raw = JSON.parse(await req.text());
    delete raw.borderY;
    await Deno.writeTextFile(`${HELP_DIR}/${name}.json`, JSON.stringify(raw));
    event(`saved help: ${name}`);
    return new Response(JSON.stringify({ ok: true, name }), { headers });
  }

  return new Response("Method not allowed", { status: 405 });
}

async function handleAbstractionAPI(req: Request, url: URL): Promise<Response> {
  const headers = { "content-type": "application/json" };

  // GET /abstractions — list available abstractions
  if (req.method === "GET" && url.pathname === "/abstractions") {
    const abstractions: string[] = [];
    for await (const entry of Deno.readDir(ABSTRACTIONS_DIR)) {
      if (entry.isFile && entry.name.endsWith(".json")) abstractions.push(entry.name.replace(".json", ""));
    }
    abstractions.sort();
    return new Response(JSON.stringify(abstractions), { headers });
  }

  // GET /abstractions/name — load an abstraction
  if (req.method === "GET" && url.pathname.startsWith("/abstractions/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(14)));
    if (!name) return new Response("Invalid name", { status: 400 });
    try {
      const data = await Deno.readTextFile(`${ABSTRACTIONS_DIR}/${name}.json`);
      return new Response(data, { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  // PUT /abstractions/name — save an abstraction
  if (req.method === "PUT" && url.pathname.startsWith("/abstractions/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(14)));
    if (!name) return new Response("Invalid name", { status: 400 });
    const raw = JSON.parse(await req.text());
    delete raw.borderY;
    const bindingError = checkAbstraction(name, raw, loadedAbstractions);
    if (bindingError) {
      console.log(`\x1b[31m✗ abstraction ${name} rejected: ${bindingError}\x1b[0m`);
      return new Response(JSON.stringify({ ok: false, error: bindingError }), { status: 400, headers });
    }
    await Deno.writeTextFile(`${ABSTRACTIONS_DIR}/${name}.json`, JSON.stringify(raw));
    event(`saved abstraction: ${name}`);
    await loadAbstractions();  // Reload registry
    return new Response(JSON.stringify({ ok: true, name }), { headers });
  }

  // DELETE /abstractions/name — delete an abstraction
  if (req.method === "DELETE" && url.pathname.startsWith("/abstractions/")) {
    const name = sanitizeName(decodeURIComponent(url.pathname.slice(14)));
    if (!name) return new Response("Invalid name", { status: 400 });
    try {
      await Deno.remove(`${ABSTRACTIONS_DIR}/${name}.json`);
      event(`deleted abstraction: ${name}`);
      await loadAbstractions();  // Reload registry
      return new Response(JSON.stringify({ ok: true }), { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  return new Response("Not found", { status: 404 });
}

// --- Self-signed cert generation (workshop) ---
// Pure-Deno and OS-agnostic: WebCrypto generates the key, @peculiar/x509 builds
// the cert — no openssl, no system tool. RSA-2048 (not EC): Deno's rustls accepts
// RSA reliably, whereas macOS LibreSSL's EC output was rejected with KeyMismatch.
// Deps are lazy-imported so only workshop mode loads the tree. Writes SELF_* only.
async function genSelfSignedCert(): Promise<void> {
  const ip = getLanIP();
  try {
    await import("reflect-metadata"); // tsyringe polyfill — must load before x509
    const x509 = await import("@peculiar/x509");

    const alg: RsaHashedKeyGenParams = {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      publicExponent: new Uint8Array([1, 0, 1]),
      modulusLength: 2048,
    };
    const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]) as CryptoKeyPair;

    const names = [
      { type: "dns", value: "localhost" },
      { type: "ip", value: "127.0.0.1" },
      ...(ip ? [{ type: "ip", value: ip }] : []),
    ];
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=local.tamb.fm",
      notBefore: new Date(),
      notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      signingAlgorithm: alg,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.SubjectAlternativeNameExtension(
          names as ConstructorParameters<typeof x509.SubjectAlternativeNameExtension>[0],
        ),
      ],
    }, crypto);

    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    await Deno.writeTextFile(SELF_CERT_FILE, cert.toString("pem"));
    await Deno.writeTextFile(SELF_KEY_FILE, x509.PemConverter.encode([pkcs8], "PRIVATE KEY"));

    const san = names.map((n) => `${n.type}:${n.value}`).join(",");
    console.log(`\x1b[32m✓ generated self-signed cert\x1b[0m (SAN: ${san})`);
  } catch (e) {
    console.error("\x1b[31m✗ workshop mode could not generate a self-signed cert.\x1b[0m");
    console.error("  The cert dependencies may not be installed — run `deno task setup` once with internet.");
    console.error(`  ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
}

const lanIP = getLanIP();

// --- Start ---

const isMacOS = Deno.build.os === "darwin";

// Resolve TLS material per mode. performance requires a real cert (fail loud);
// workshop generates a self-signed one once; practice serves plain HTTP.
let cert: string | undefined;
let key: string | undefined;
let certSource: string | null = null;
if (cfg.certKind === "letsencrypt") {
  const paths = await resolveLetsEncryptCert();
  if (!paths) {
    console.error("\x1b[31m✗ performance mode requires a real TLS cert.\x1b[0m");
    console.error(`  Looked for (in order):`);
    console.error(`    ${LE_CERT}`);
    console.error(`    ./${CERT_FALLBACK} (repo-root fallback)`);
    console.error(`  Get one with: ./start-macos.sh renew`);
    Deno.exit(1);
  }
  cert = await Deno.readTextFile(paths.cert);
  key = await Deno.readTextFile(paths.key);
  certSource = paths.cert;

  // Defense-in-depth for callers that bypass start-macos.sh (raw `deno run …`).
  // rustls happily serves expired certs; browsers reject client-side. openssl is
  // a fair assumption on any host that already has a Let's Encrypt cert.
  const checkend = (sec: number) => new Deno.Command("openssl", {
    args: ["x509", "-checkend", String(sec), "-noout", "-in", paths.cert],
    stdout: "null", stderr: "null",
  }).output();
  const notAfter = async () => {
    const o = await new Deno.Command("openssl", {
      args: ["x509", "-enddate", "-noout", "-in", paths.cert],
      stdout: "piped", stderr: "null",
    }).output();
    return new TextDecoder().decode(o.stdout).trim().replace(/^notAfter=/, "");
  };
  try {
    if (!(await checkend(0)).success) {
      console.error(`\x1b[31m✗ ${paths.cert} expired (notAfter: ${await notAfter()}).\x1b[0m`);
      console.error("  Every browser will reject the connection. Renew with: ./start-macos.sh renew");
      Deno.exit(1);
    }
    if (!(await checkend(7 * 86400)).success) {
      console.warn(`\x1b[33m⚠ ${paths.cert} expires within 7 days (${await notAfter()}). Renew soon.\x1b[0m`);
    }
  } catch {
    // openssl missing — shell wrapper covers macOS; on other hosts, operator's call.
  }
} else if (cfg.certKind === "self-signed") {
  const exists = (p: string) => Deno.stat(p).then(() => true).catch(() => false);
  if (!((await exists(SELF_CERT_FILE)) && (await exists(SELF_KEY_FILE)))) await genSelfSignedCert();
  cert = await Deno.readTextFile(SELF_CERT_FILE);
  key = await Deno.readTextFile(SELF_KEY_FILE);
}

// dnsmasq DNS-hijack check — performance only.
if (cfg.needsDnsmasqWarning) {
  try {
    const dnsCheck = await Deno.resolveDns("test.example.com", "A", { nameServer: { ipAddr: "127.0.0.1", port: 53 } });
    const allPointToHost = dnsCheck.every(record => record === HOST_IP);
    if (!allPointToHost) {
      console.log("\x1b[33m⚠️  WARNING: dnsmasq may not be configured correctly!\x1b[0m");
      console.log(`\x1b[33mCaptive portal requires all DNS queries to resolve to ${HOST_IP}\x1b[0m`);
      console.log("\x1b[33mStart dnsmasq with:\x1b[0m");
      console.log("\x1b[33m  ./start-macos.sh dns\x1b[0m");
      console.log("");
    }
  } catch {
    console.log("\x1b[33m⚠️  WARNING: dnsmasq is not running!\x1b[0m");
    console.log("\x1b[33mCaptive portal requires dnsmasq for DNS resolution.\x1b[0m");
    console.log("\x1b[33mStart dnsmasq with:\x1b[0m");
    console.log("\x1b[33m  ./start-macos.sh dns\x1b[0m");
    console.log("");
  }
}

// serialosc / monome — orthogonal to mode, macOS-only.
if (isMacOS) {
  try {
    const psOutput = await new Deno.Command("pgrep", { args: ["serialoscd"] }).output();
    if (!psOutput.success) {
      console.log("\x1b[33m⚠️  WARNING: serialosc is not running!\x1b[0m");
      console.log("\x1b[33mMonome grid/arc require serialosc daemon.\x1b[0m");
      console.log("\x1b[33mStart serialosc with:\x1b[0m");
      console.log("\x1b[33m  brew services start serialosc\x1b[0m");
      console.log("");
    } else {
      // serialosc is running — initialize grid and arc (both via OSC)
      await initGrid();
    }
  } catch {
    // pgrep not found or other error - skip check
  }
}

// --- Banner ---
if (MODE === "workshop" && !lanIP) {
  console.log("\x1b[33m⚠️  workshop mode: no LAN IPv4 detected — connect to a network so phones can reach the server.\x1b[0m");
}
const scheme = cfg.certKind === "none" ? "http" : "https";
const appHost = MODE === "performance" ? HOST_DOMAIN : MODE === "workshop" ? (lanIP ?? "0.0.0.0") : "localhost";
const portSuffix = cfg.appPort === 443 ? "" : `:${cfg.appPort}`;
const base = `${scheme}://${appHost}${portSuffix}`;
const lanNote = MODE === "performance" && lanIP && lanIP !== HOST_IP ? `\n  \x1b[90mLAN IP:   ${lanIP}\x1b[0m` : "";
const certNote = certSource ? `\n  \x1b[90mcert:     ${certSource}\x1b[0m` : "";
// Operator click-target on the same host as the server. Loopback sidesteps
// two MBP-local issues: (1) dnsmasq binds to en6:53, macOS resolver doesn't
// query it; (2) after a DHCP→static IP swap, en6's own IP has no lo0 alias,
// so outbound connections to it fail with EADDRNOTAVAIL. Expect a one-time
// cert warning (SAN is local.tamb.fm, not 127.0.0.1).
const opNote = MODE === "performance" ? `\n  \x1b[90mop:       https://127.0.0.1/ctrl.html\x1b[0m` : "";
const banner = `
  \x1b[1mlocal.tamb.fm\x1b[0m  \x1b[90m[${MODE}]\x1b[0m
  synth:    ${base}/
  ctrl:     ${base}/ctrl.html
  ensemble: ${base}/ensemble.html${lanNote}${certNote}${opNote}
`;
console.log(banner);

// Onboarding QR — workshop/performance only (a localhost QR is useless in
// practice). qrText lazy-loads the encoder, so practice never pulls the dep.
if (MODE !== "practice") {
  console.log(`  \x1b[90mwifi:\x1b[0m     ${WIFI_SSID} / ${WIFI_PASSWORD}`);
  console.log(await qrText(`${base}/`, "ascii"));
  console.log("  \x1b[90mscan to play · run `deno task qr` for a printable WiFi + URL poster\x1b[0m\n");
}

// --- Serve ---
// practice: app only, plain HTTP, localhost. workshop: app only, HTTPS, LAN.
// performance: captive-portal HTTP listener + HTTPS app listener.
try {
  if (cfg.portalPort !== null) {
    Deno.serve({ port: cfg.portalPort, hostname: cfg.bindHost }, (req, info) => appHandler(req, info, true));
  }
  if (cfg.certKind === "none") {
    Deno.serve({ port: cfg.appPort, hostname: cfg.bindHost }, (req, info) => appHandler(req, info));
  } else {
    Deno.serve({ port: cfg.appPort, hostname: cfg.bindHost, cert: cert!, key: key! }, (req, info) => appHandler(req, info));
  }
} catch (e) {
  if (e instanceof Deno.errors.PermissionDenied) {
    const ports = cfg.portalPort !== null ? `${cfg.portalPort}/${cfg.appPort}` : `${cfg.appPort}`;
    console.error(`\x1b[31m✗ permission denied binding port ${ports}.\x1b[0m`);
    console.error("  performance mode binds privileged ports 80/443 — run it with sudo (./start-macos.sh).");
    Deno.exit(1);
  }
  throw e;
}

drawStatus();

setInterval(() => {
  broadcastSynth({ type: "health", ts: Date.now() });
  for (const socket of ctrlSockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
  }
}, 5000);
