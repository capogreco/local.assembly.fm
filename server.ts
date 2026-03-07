const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";
const HTTPS_PORT = 8443;
const HTTP_PORT = 8080;
const HOST_IP = Deno.env.get("HOST_IP") || "192.168.178.10";
const HOST_DOMAIN = Deno.env.get("HOST_DOMAIN") || "local.assembly.fm";

// --- TLS cert check ---

async function ensureCerts(): Promise<void> {
  try {
    await Deno.stat(CERT_FILE);
    await Deno.stat(KEY_FILE);
    console.log("TLS certs found");
  } catch {
    console.error(
      `Missing ${CERT_FILE} and/or ${KEY_FILE}.\n` +
      `Copy from Let's Encrypt:\n` +
      `  sudo cp /etc/letsencrypt/live/${HOST_DOMAIN}/fullchain.pem ${CERT_FILE}\n` +
      `  sudo cp /etc/letsencrypt/live/${HOST_DOMAIN}/privkey.pem ${KEY_FILE}\n` +
      `  sudo chown $(whoami) ${CERT_FILE} ${KEY_FILE}`
    );
    Deno.exit(1);
  }
}

// --- Static file serving ---

function mimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html",
    js: "application/javascript",
    css: "text/css",
    json: "application/json",
    png: "image/png",
    ico: "image/x-icon",
  };
  return types[ext ?? ""] ?? "application/octet-stream";
}

async function serveFile(path: string): Promise<Response> {
  const filePath = `./public${path}`;
  try {
    const body = await Deno.readFile(filePath);
    return new Response(body, {
      headers: { "content-type": mimeType(filePath) },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

// --- Client tracking ---

let nextClientId = 1;
const wsClients = new Map<number, WebSocket>();

type SSESend = (data: Record<string, unknown>) => void;
const sseClients = new Map<number, SSESend>();

function totalClients(): number {
  return wsClients.size + sseClients.size;
}

function broadcast(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);

  for (const [, socket] of wsClients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  }

  for (const [, send] of sseClients) {
    send(msg);
  }
}

function broadcastClientCount(): void {
  broadcast({ type: "count", clients: totalClients() });
}

// --- WebSocket handler ---

const authenticatedIPs = new Set<string>();
const ipConnections = new Map<string, Set<number>>();
const deauthTimers = new Map<string, number>();

function trackConnect(clientIP: string, id: number): void {
  if (!ipConnections.has(clientIP)) {
    ipConnections.set(clientIP, new Set());
  }
  ipConnections.get(clientIP)!.add(id);
  const timer = deauthTimers.get(clientIP);
  if (timer !== undefined) {
    clearTimeout(timer);
    deauthTimers.delete(clientIP);
  }
}

function trackDisconnect(clientIP: string, id: number): void {
  const conns = ipConnections.get(clientIP);
  if (!conns || !conns.has(id)) return;
  conns.delete(id);
  if (conns.size === 0) {
    ipConnections.delete(clientIP);
    if (!deauthTimers.has(clientIP)) {
      const timer = setTimeout(() => {
        authenticatedIPs.delete(clientIP);
        deauthTimers.delete(clientIP);
        console.log(`De-authenticated ${clientIP}`);
      }, 5000);
      deauthTimers.set(clientIP, timer);
    }
  }
}

function handleWs(req: Request, info: Deno.ServeHandlerInfo): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const id = nextClientId++;
  const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;

  socket.addEventListener("open", () => {
    wsClients.set(id, socket);
    trackConnect(clientIP, id);
    console.log(`WS ${id} connected from ${clientIP} (${totalClients()} total)`);
    socket.send(JSON.stringify({
      type: "welcome",
      id,
      clients: totalClients(),
    }));
    sendInitialProgram((data) => socket.send(data));
    broadcastClientCount();
  });

  socket.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "health") {
        socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
      } else if (msg.type === "ctrl") {
        handleCtrlMessage(msg);
      }
    } catch {
      // ignore malformed
    }
  });

  socket.addEventListener("close", () => {
    wsClients.delete(id);
    trackDisconnect(clientIP, id);
    console.log(`WS ${id} disconnected (${totalClients()} total)`);
    broadcastClientCount();
  });

  return response;
}

// --- SSE handler ---

function handleSSE(req: Request, info: Deno.ServeHandlerInfo): Response {
  const id = nextClientId++;
  const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send: SSESend = (data) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // stream closed
        }
      };

      sseClients.set(id, send);
      trackConnect(clientIP, id);
      console.log(`SSE ${id} connected from ${clientIP} (${totalClients()} total)`);
      send({ type: "welcome", id, clients: totalClients() });
      send(getInitialProgram());
      broadcastClientCount();
    },
    cancel() {
      sseClients.delete(id);
      trackDisconnect(clientIP, id);
      console.log(`SSE ${id} disconnected (${totalClients()} total)`);
      broadcastClientCount();
    },
  });

  // Also clean up if the request is aborted
  req.signal.addEventListener("abort", () => {
    sseClients.delete(id);
    trackDisconnect(clientIP, id);
    console.log(`SSE ${id} aborted (${totalClients()} total)`);
    broadcastClientCount();
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}

// --- Captive portal (HTTP on port 8080) ---

function portalHandler(
  req: Request,
  info: Deno.ServeHandlerInfo,
): Response | Promise<Response> {
  const url = new URL(req.url);
  const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;

  // Known captive portal probe paths
  const probes = [
    "/hotspot-detect.html",  // Apple
    "/generate_204",         // Google/Android
    "/canonical.html",       // Firefox
    "/connecttest.txt",      // Microsoft
  ];

  if (probes.includes(url.pathname)) {
    if (authenticatedIPs.has(clientIP)) {
      // Already authenticated — return expected success so OS stays connected
      if (url.pathname === "/generate_204") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/connecttest.txt") {
        return new Response("Microsoft Connect Test", {
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>", {
        headers: { "content-type": "text/html" },
      });
    }

    // Apple CNA: redirect to HTTPS so AudioWorklet works (requires secure context)
    // Don't authenticate — keep network "captive" so CNA stays open
    if (url.pathname === "/hotspot-detect.html") {
      console.log(`CNA (Apple): redirecting ${clientIP} to HTTPS`);
      return Response.redirect(`https://${HOST_DOMAIN}:${HTTPS_PORT}`, 302);
    }

    // Android/others: redirect to HTTPS (Android Custom Tab = full browser)
    console.log(`CNA: redirecting ${clientIP} to HTTPS via ${url.pathname}`);
    return Response.redirect(`https://${HOST_DOMAIN}:${HTTPS_PORT}`, 302);
  }

  // Auth endpoint
  if (url.pathname === "/auth") {
    authenticatedIPs.add(clientIP);
    console.log(`Authenticated ${clientIP}`);
    return new Response("ok");
  }

  // SSE endpoint
  if (url.pathname === "/events") {
    return handleSSE(req, info);
  }

  // WebSocket upgrade on HTTP port
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return handleWs(req, info);
  }

  // Static assets needed by the synth client served over HTTP
  const ext = url.pathname.split(".").pop()?.toLowerCase();
  if (ext && ["js", "css", "json", "png", "ico"].includes(ext)) {
    return serveFile(url.pathname);
  }

  // Everything else (typed-in URLs) → serve synth client
  console.log(`HTTP: serving synth client to ${clientIP}`);
  return serveFile("/index.html");
}

// --- HTTPS handler ---

function httpsHandler(req: Request, info: Deno.ServeHandlerInfo): Response | Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return handleWs(req, info);
  }

  const url = new URL(req.url);

  // SSE endpoint
  if (url.pathname === "/events") {
    return handleSSE(req, info);
  }

  if (url.pathname === "/auth") {
    const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;
    authenticatedIPs.add(clientIP);
    console.log(`Authenticated ${clientIP}`);
    return new Response("ok");
  }

  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  return serveFile(path);
}

// --- Ctrl message handler (WebMIDI routing) ---

// BBC2 CC mapping (Phase 1 hardcoded)
const CC_ROUTE: Record<number, { param: string; scale: number }> = {
  2:  { param: "amplitude",  scale: 0.2 },   // breath
  1:  { param: "zingAmount", scale: 1.0 },   // bite
  12: { param: "vowelY",     scale: 1.0 },   // nod
  13: { param: "vowelX",     scale: 1.0 },   // tilt
};

function handleCtrlMessage(msg: Record<string, unknown>): void {
  if (msg.source === "cc") {
    const cc = msg.cc as number;
    const value = msg.value as number;
    const route = CC_ROUTE[cc];
    if (route) {
      const scaled = value * route.scale;
      broadcast({ type: "params", [route.param]: scaled });
    }
  } else if (msg.source === "note") {
    const note = msg.note as number;
    const velocity = msg.velocity as number;
    if (velocity > 0) {
      const freq = 440 * Math.pow(2, (note - 69) / 12);
      broadcast({
        type: "params",
        ksFrequency: freq,
        ksAmplitude: velocity * 0.3,
        ksTrigger: true,
      });
    }
  }
}

// --- Test mode: generator-based parameter broadcast ---

const testProgram: Record<string, unknown> = {
  type: "params",
  frequency: {
    base: 220,
    nums: [1, 5, 3, 7, 2, 9, 4],
    dens: [1, 4, 2, 4, 1, 8, 3],
    numCommand: "shuffle",
    denCommand: "shuffle",
  },
  vowelX:    { min: 0.15, max: 0.85, command: "scatter" },
  vowelY:    { min: 0.15, max: 0.85, command: "scatter" },
  zingAmount:{ min: 0.1,  max: 0.8,  command: "scatter" },
  zingMorph: { min: 0.1,  max: 0.9,  command: "scatter" },
  symmetry:  { min: 0.2,  max: 0.8,  command: "scatter" },
  amplitude: 0.1,
  orbitAngle: 0,
  orbitThrust: 0.3,
};

function getInitialProgram(): Record<string, unknown> {
  return testInterval ? testProgram : buildParamsFromShared();
}

function sendInitialProgram(send: (data: string) => void): void {
  send(JSON.stringify(getInitialProgram()));
}

// Shuffle schedule — stagger commands so params change at different times
const shuffleSchedule: { tick: number; param: string; kind: "hrg" | "range" }[] = [
  { tick: 50,  param: "frequency",  kind: "hrg" },     //  5s
  { tick: 80,  param: "vowelX",     kind: "range" },    //  8s
  { tick: 110, param: "vowelY",     kind: "range" },    // 11s
  { tick: 140, param: "zingAmount", kind: "range" },    // 14s
  { tick: 160, param: "zingMorph",  kind: "range" },    // 16s
  { tick: 180, param: "symmetry",   kind: "range" },    // 18s
];
const CYCLE_LENGTH = 200; // 20s full cycle

let testInterval: number | null = null;

function startTestMode(): void {
  if (testInterval) return;
  // Send initial program to all connected clients
  broadcast(testProgram);
  let t = 0;
  let ticks = 0;
  testInterval = setInterval(() => {
    t += 0.02;
    ticks++;
    const phase = ticks % CYCLE_LENGTH;
    const msg: Record<string, unknown> = {
      type: "params",
      amplitude: 0.1,
      orbitAngle: (t * 0.3) % (Math.PI * 2),
      orbitThrust: 0.3 + Math.sin(t * 0.1) * 0.2,
    };
    for (const entry of shuffleSchedule) {
      if (phase === entry.tick) {
        if (entry.kind === "hrg") {
          msg[entry.param] = { numCommand: "shuffle", denCommand: "shuffle" };
        } else {
          msg[entry.param] = { command: "scatter" };
        }
      }
    }
    broadcast(msg);
  }, 100);
  console.log("Test mode: started");
}

function stopTestMode(): void {
  if (!testInterval) return;
  clearInterval(testInterval);
  testInterval = null;
  console.log("Test mode: stopped");
}

// --- Monome Grid (OSC via serialosc) ---

function oscString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s + "\0");
  const padded = Math.ceil(bytes.length / 4) * 4;
  const buf = new Uint8Array(padded);
  buf.set(bytes);
  return buf;
}

function oscInt(n: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, n);
  return buf;
}

function oscMessage(address: string, ...args: (string | number)[]): Uint8Array {
  const parts: Uint8Array[] = [oscString(address)];
  let typetag = ",";
  const argParts: Uint8Array[] = [];
  for (const a of args) {
    if (typeof a === "number") {
      typetag += "i";
      argParts.push(oscInt(a));
    } else {
      typetag += "s";
      argParts.push(oscString(a));
    }
  }
  parts.push(oscString(typetag));
  parts.push(...argParts);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function parseOsc(data: Uint8Array): { address: string; args: (string | number)[] } | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 0;

  function readString(): string {
    const start = off;
    while (off < data.length && data[off] !== 0) off++;
    const s = new TextDecoder().decode(data.subarray(start, off));
    off++; // skip null
    off = Math.ceil(off / 4) * 4; // pad to 4
    return s;
  }

  function readInt(): number {
    const v = view.getInt32(off);
    off += 4;
    return v;
  }

  try {
    const address = readString();
    if (!address.startsWith("/")) return null;
    const typetag = readString();
    const args: (string | number)[] = [];
    for (let i = 1; i < typetag.length; i++) {
      if (typetag[i] === "i") args.push(readInt());
      else if (typetag[i] === "s") args.push(readString());
      else if (typetag[i] === "f") { off += 4; } // skip floats
    }
    return { address, args };
  } catch {
    return null;
  }
}

const SERIALOSC_PORT = 12002;
const GRID_PREFIX = "/assembly";
let gridPort: number | null = null;
let arcPort: number | null = null;
let gridSocket: Deno.DatagramConn | null = null;
const GRID_LISTEN_PORT = 13000;

async function gridSend(msg: Uint8Array): Promise<void> {
  if (!gridSocket || !gridPort) return;
  await gridSocket.send(msg, { hostname: "127.0.0.1", port: gridPort, transport: "udp" });
}

async function arcSend(msg: Uint8Array): Promise<void> {
  if (!gridSocket || !arcPort) return;
  await gridSocket.send(msg, { hostname: "127.0.0.1", port: arcPort, transport: "udp" });
}

// --- Grid Controller State ---

interface HrgRowState {
  integers: Set<number>;
  behaviour: string;
}

interface RangeRowState {
  min: number;
  max: number;
  behaviour: string;
}

type RowState = HrgRowState | RangeRowState;

interface RowDef {
  param: string;
  type: "hrg-num" | "hrg-den" | "range";
}

interface PageDef {
  name: string;
  rows: RowDef[];
}

const pages: PageDef[] = [
  { name: "pitch", rows: [
    { param: "frequency", type: "hrg-num" },
    { param: "frequency", type: "hrg-den" },
  ]},
  { name: "timbre", rows: [
    { param: "vowelX",     type: "range" },
    { param: "vowelY",     type: "range" },
    { param: "zingAmount", type: "range" },
    { param: "zingMorph",  type: "range" },
    { param: "symmetry",   type: "range" },
  ]},
];

function rowKey(param: string, type: string): string {
  if (type === "hrg-num") return `${param}:num`;
  if (type === "hrg-den") return `${param}:den`;
  return param;
}

const sharedRows = new Map<string, RowState>();
const stagedRows = new Map<string, RowState>();
const hrgBases = new Map<string, number>();
let activePageHeld: number | null = null;
let soundOn = false;

const HRG_BEHAVIOURS = ["increment", "decrement", "shuffle"];
const RANGE_BEHAVIOURS = ["scatter", "walk", "converge"];

function effectiveRow(key: string): RowState | undefined {
  return stagedRows.get(key) ?? sharedRows.get(key);
}

function ensureStaged(key: string, type: string): RowState {
  if (!stagedRows.has(key)) {
    const shared = sharedRows.get(key);
    if (shared) {
      if ("integers" in shared) {
        stagedRows.set(key, { integers: new Set(shared.integers), behaviour: shared.behaviour });
      } else {
        stagedRows.set(key, { min: shared.min, max: shared.max, behaviour: shared.behaviour });
      }
    } else if (type === "range") {
      stagedRows.set(key, { min: 0, max: 11, behaviour: "static" });
    } else {
      stagedRows.set(key, { integers: new Set([1]), behaviour: "static" });
    }
  }
  return stagedRows.get(key)!;
}

function hasStagedChanges(): boolean {
  return stagedRows.size > 0;
}

function pageHasStagedChanges(pageIdx: number): boolean {
  const page = pages[pageIdx];
  if (!page) return false;
  for (const row of page.rows) {
    if (stagedRows.has(rowKey(row.param, row.type))) return true;
  }
  return false;
}

function populateFromProgram(prog: Record<string, unknown>): void {
  sharedRows.clear();
  stagedRows.clear();
  hrgBases.clear();
  for (const [key, val] of Object.entries(prog)) {
    if (key === "type" || typeof val !== "object" || val === null) continue;
    const v = val as Record<string, unknown>;
    if (v.nums !== undefined || v.dens !== undefined) {
      if (v.base !== undefined) hrgBases.set(key, v.base as number);
      if (v.nums !== undefined) {
        sharedRows.set(`${key}:num`, {
          integers: new Set(v.nums as number[]),
          behaviour: (v.numCommand as string) || "static",
        });
      }
      if (v.dens !== undefined) {
        sharedRows.set(`${key}:den`, {
          integers: new Set(v.dens as number[]),
          behaviour: (v.denCommand as string) || "static",
        });
      }
    } else if (v.min !== undefined || v.max !== undefined) {
      sharedRows.set(key, {
        min: Math.round(((v.min as number) ?? 0) * 11),
        max: Math.round(((v.max as number) ?? 1) * 11),
        behaviour: (v.command as string) || "static",
      });
    }
  }
  if (typeof prog.amplitude === "number") {
    soundOn = (prog.amplitude as number) > 0;
  }
  // Sync arc values from range params
  for (let i = 0; i < arcParamMap.length; i++) {
    const val = prog[arcParamMap[i]];
    if (typeof val === "object" && val !== null) {
      const v = val as Record<string, unknown>;
      if (v.min !== undefined && v.max !== undefined) {
        arcValues[i] = ((v.min as number) + (v.max as number)) / 2;
      }
    } else if (typeof val === "number") {
      arcValues[i] = val;
    }
  }
}

function buildParamsFromShared(): Record<string, unknown> {
  const msg: Record<string, unknown> = { type: "params" };
  const hrgParams = new Set<string>();
  for (const [key] of sharedRows) {
    const m = key.match(/^(.+):(num|den)$/);
    if (m) hrgParams.add(m[1]);
  }
  for (const param of hrgParams) {
    const numRow = sharedRows.get(`${param}:num`);
    const denRow = sharedRows.get(`${param}:den`);
    const obj: Record<string, unknown> = { base: hrgBases.get(param) || 220 };
    if (numRow && "integers" in numRow) {
      obj.nums = [...numRow.integers].sort((a, b) => a - b);
    }
    if (denRow && "integers" in denRow) {
      obj.dens = [...denRow.integers].sort((a, b) => a - b);
    }
    msg[param] = obj;
  }
  for (const [key, row] of sharedRows) {
    if ("min" in row) {
      msg[key] = { min: row.min / 11, max: row.max / 11 };
    }
  }
  msg.amplitude = soundOn ? 0.1 : 0.0;
  return msg;
}

function existingBehaviour(key: string): string {
  return (effectiveRow(key) as { behaviour?: string } | undefined)?.behaviour ?? "static";
}

function handleParamPress(x: number, y: number): void {
  const page = pages[activePageHeld!];
  if (y >= page.rows.length) return;
  const def = page.rows[y];
  const key = rowKey(def.param, def.type);

  // Count held buttons in this row (cols 0-11)
  const rowHeld: number[] = [];
  for (const h of heldKeys) {
    const [hx, hy] = h.split(",").map(Number);
    if (hy === y && hx < 12) rowHeld.push(hx);
  }

  if (rowHeld.length === 1) {
    // First press — clear row, set single value
    if (def.type === "range") {
      stagedRows.set(key, { min: x, max: x, behaviour: existingBehaviour(key) });
    } else {
      stagedRows.set(key, { integers: new Set([x + 1]), behaviour: existingBehaviour(key) });
    }
  } else if (rowHeld.length === 2) {
    // Second press — set range between the two held buttons
    const lo = Math.min(rowHeld[0], rowHeld[1]);
    const hi = Math.max(rowHeld[0], rowHeld[1]);
    if (def.type === "range") {
      stagedRows.set(key, { min: lo, max: hi, behaviour: existingBehaviour(key) });
    } else {
      const ints = new Set<number>();
      for (let c = lo; c <= hi; c++) ints.add(c + 1);
      stagedRows.set(key, { integers: ints, behaviour: existingBehaviour(key) });
    }
  }
  renderGrid();
}

// --- Grid LED Rendering ---

function gridLedRow(xOffset: number, y: number, levels: number[]): void {
  gridSend(oscMessage(`${GRID_PREFIX}/grid/led/level/row`, xOffset, y, ...levels));
}

function renderGrid(): void {
  const buf: number[][] = Array.from({ length: 8 }, () => new Array(16).fill(0));

  // Rows 0-5 + behaviour cols: only visible when a page is held
  if (activePageHeld !== null) {
    const page = pages[activePageHeld];
    for (let r = 0; r < page.rows.length && r < 6; r++) {
      const def = page.rows[r];
      const key = rowKey(def.param, def.type);
      const eff = effectiveRow(key);
      if (!eff) continue;

      const isStaged = stagedRows.has(key);
      const level = isStaged ? 15 : 4;

      if ("integers" in eff) {
        for (let col = 0; col < 12; col++) {
          if (eff.integers.has(col + 1)) buf[r][col] = level;
        }
        for (let i = 0; i < 3; i++) {
          if (eff.behaviour === HRG_BEHAVIOURS[i]) buf[r][12 + i] = level;
        }
      } else {
        for (let col = eff.min; col <= eff.max; col++) {
          buf[r][col] = level;
        }
        for (let i = 0; i < 3; i++) {
          if (eff.behaviour === RANGE_BEHAVIOURS[i]) buf[r][12 + i] = level;
        }
      }
    }
  }

  // Fixed buttons (always visible)
  buf[0][15] = hasStagedChanges() ? 15 : 0;  // SEND
  buf[1][15] = 4;                              // INCREMENT
  buf[7][15] = soundOn ? 15 : 0;              // ON/OFF

  // Page selectors (y=7, always visible)
  for (let i = 0; i < pages.length; i++) {
    if (i === activePageHeld) {
      buf[7][i] = 15;  // held page is bright
    } else {
      buf[7][i] = pageHasStagedChanges(i) ? 15 : 4;
    }
  }

  for (let y = 0; y < 8; y++) {
    gridLedRow(0, y, buf[y].slice(0, 8));
    gridLedRow(8, y, buf[y].slice(8, 16));
  }
}

// --- Grid Button Handlers ---

function handleSend(): void {
  if (!hasStagedChanges()) return;
  if (testInterval) stopTestMode();

  for (const [key, row] of stagedRows) {
    if ("integers" in row) {
      sharedRows.set(key, { integers: new Set(row.integers), behaviour: row.behaviour });
    } else {
      sharedRows.set(key, { min: row.min, max: row.max, behaviour: row.behaviour });
    }
  }
  stagedRows.clear();

  const shared = buildParamsFromShared();
  broadcast(shared);
  syncArcFromParams(shared);
  renderGrid();
  console.log("Grid: SEND");
}

function handleIncrement(): void {
  const msg: Record<string, unknown> = { type: "params" };
  let hasCommands = false;

  for (const page of pages) {
    for (const rowDef of page.rows) {
      const key = rowKey(rowDef.param, rowDef.type);
      const eff = effectiveRow(key);
      if (!eff) continue;

      if ("integers" in eff && eff.behaviour !== "static") {
        if (!msg[rowDef.param]) msg[rowDef.param] = {};
        const cmdKey = rowDef.type === "hrg-num" ? "numCommand" : "denCommand";
        (msg[rowDef.param] as Record<string, unknown>)[cmdKey] = eff.behaviour;
        hasCommands = true;
      } else if ("min" in eff && eff.behaviour !== "static") {
        msg[rowDef.param] = { command: eff.behaviour };
        hasCommands = true;
      }
    }
  }

  if (hasCommands) broadcast(msg);

  // Flash INCREMENT LED
  gridSend(oscMessage(`${GRID_PREFIX}/grid/led/level/set`, 15, 1, 15));
  setTimeout(() => {
    gridSend(oscMessage(`${GRID_PREFIX}/grid/led/level/set`, 15, 1, 4));
  }, 100);
}

function handleOnOff(): void {
  soundOn = !soundOn;
  broadcast({ type: "params", amplitude: soundOn ? 0.1 : 0.0 });
  renderGrid();
  console.log(`Grid: sound ${soundOn ? "on" : "off"}`);
}

function handleBehaviourCol(x: number, y: number): void {
  const page = pages[activePageHeld!];
  if (y >= page.rows.length) return;
  const def = page.rows[y];
  const key = rowKey(def.param, def.type);
  const row = ensureStaged(key, def.type);
  const behaviours = def.type === "range" ? RANGE_BEHAVIOURS : HRG_BEHAVIOURS;
  const behaviour = behaviours[x - 12];
  row.behaviour = row.behaviour === behaviour ? "static" : behaviour;
  renderGrid();
}

// --- Arc State ---

const arcValues: number[] = [0.5, 0.5, 0.5, 0.5];
const arcParamMap: string[] = ["vowelX", "vowelY", "zingAmount", "symmetry"];
const ARC_SENSITIVITY = 0.005;

let lastArcRender = 0;
function handleArcDelta(encoder: number, delta: number): void {
  if (encoder < 0 || encoder > 3) return;
  arcValues[encoder] = Math.max(0, Math.min(1, arcValues[encoder] + delta * ARC_SENSITIVITY));
  const param = arcParamMap[encoder];
  broadcast({ type: "params", [param]: arcValues[encoder] });
  // Throttle LED updates to avoid flooding the serial REPL
  const now = Date.now();
  if (now - lastArcRender > 50) {
    lastArcRender = now;
    renderArcRing(encoder);
  }
}

function buildArcLevels(n: number): number[] {
  const pos = arcValues[n] * 63;
  const levels: number[] = new Array(64).fill(0);
  const center = Math.round(pos);
  for (let i = -3; i <= 3; i++) {
    const idx = (center + i + 64) % 64;
    const dist = Math.abs(i);
    if (dist === 0) levels[idx] = 15;
    else if (dist === 1) levels[idx] = 10;
    else if (dist === 2) levels[idx] = 5;
    else levels[idx] = 2;
  }
  return levels;
}

function renderArcRing(n: number): void {
  const levels = buildArcLevels(n);
  if (arcFile) {
    arcSerialUpdateRing(n, levels);
  } else {
    arcSend(oscMessage(`${GRID_PREFIX}/ring/map`, n, ...levels));
  }
}

function renderAllArcRings(): void {
  for (let i = 0; i < 4; i++) renderArcRing(i);
}

function syncArcFromParams(params: Record<string, unknown>): void {
  for (let i = 0; i < arcParamMap.length; i++) {
    const val = params[arcParamMap[i]];
    if (typeof val === "number") {
      arcValues[i] = val;
    }
  }
  if (arcPort) renderAllArcRings();
}

const heldKeys = new Set<string>();

function handleGridKey(x: number, y: number, s: number): void {
  if (s === 1) {
    heldKeys.add(`${x},${y}`);

    // Fixed buttons (col 15)
    if (x === 15) {
      if (y === 0) { handleSend(); return; }
      if (y === 1) { handleIncrement(); return; }
      if (y === 7) { handleOnOff(); return; }
      return;
    }

    // Page selectors (y=7) — momentary hold
    if (y === 7 && x < pages.length) {
      activePageHeld = x;
      renderGrid();
      console.log(`Grid: page ${pages[x].name} held`);
      return;
    }

    // Ignore param presses when no page held
    if (activePageHeld === null) return;

    const page = pages[activePageHeld];
    if (y >= page.rows.length) return;

    if (x < 12) {
      handleParamPress(x, y);
    } else if (x >= 12 && x <= 14) {
      handleBehaviourCol(x, y);
    }
  } else {
    heldKeys.delete(`${x},${y}`);

    // Page release — momentary
    if (y === 7 && x === activePageHeld) {
      activePageHeld = null;
      renderGrid();
    }
  }
}

// --- Arc Direct Serial (iii Lua REPL) ---

let arcFile: Deno.FsFile | null = null;
let arcReady = false;
const arcEncoder = new TextEncoder();

async function findArcDevice(): Promise<string | null> {
  try {
    for await (const entry of Deno.readDir("/dev/serial/by-id")) {
      if (entry.name.includes("arc")) {
        const path = `/dev/serial/by-id/${entry.name}`;
        const real = await Deno.realPath(path);
        return real;
      }
    }
  } catch { /* no /dev/serial/by-id */ }
  return null;
}

async function arcCommand(cmd: string): Promise<void> {
  if (!arcFile) return;
  try {
    await arcFile.write(arcEncoder.encode(cmd + "\r\n"));
  } catch { /* disconnected */ }
}

function arcSerialUpdateRing(ring: number, levels: number[]): void {
  if (!arcFile || !arcReady) return;
  // Call the Lua helper defined in arcTakeControl
  // Pass value (0-1) so Lua renders the ring
  const value = arcValues[ring];
  arcCommand(`update_ring(${ring + 1}, ${value})`);
}

async function arcTakeControl(): Promise<void> {
  const commands = [
    // Stop everything — metros, callbacks, redraw
    "metro.allstop()",
    "for i=1,100 do if metro[i] then metro[i]:stop() end end",
    "tick = function() end",
    "redraw = function() end",
    "key = function() end",
    "enc = function() end",
    "init = function() end",
    "cleanup = function() end",

    // Define LED ring rendering function (must be ONE line for the REPL)
    "function update_ring(n, val) local num_leds = math.floor(val * 64) arc_led_all(n, 0) for i=1,num_leds do local pos = ((32 + i - 2) % 64) + 1 arc_led(n, pos, 15) end arc_refresh() end",

    // Clear all rings
    "for n=1,4 do update_ring(n, 0) end",

    // Define our encoder handler
    "arc = function(n, d) print(string.format('ENC:%d:%d', n, d)) end",

    // Confirm control
    "print('ARC_READY')",
  ];

  for (const cmd of commands) {
    await arcCommand(cmd);
    await new Promise(r => setTimeout(r, 150));
  }
}

async function initArc(): Promise<void> {
  const devPath = await findArcDevice();
  if (!devPath) {
    console.log("Arc: no device found");
    return;
  }

  // Configure serial port (baud irrelevant for CDC ACM but set for consistency)
  const stty = new Deno.Command("stty", {
    args: ["-F", devPath, "115200", "-echo", "-echoe", "-echok", "raw"],
  });
  const result = await stty.output();
  if (!result.success) {
    console.log("Arc: failed to configure serial port");
    return;
  }

  try {
    arcFile = await Deno.open(devPath, { read: true, write: true });
  } catch (e) {
    console.log(`Arc: failed to open ${devPath}: ${(e as Error).message}`);
    return;
  }

  console.log(`Arc: opened ${devPath} (iii Lua REPL)`);

  // Read loop — text-based, line-delimited
  const readBuf = new Uint8Array(1024);
  let textBuffer = "";

  (async () => {
    while (arcFile) {
      let n: number | null;
      try {
        n = await arcFile.read(readBuf);
      } catch {
        break;
      }
      if (n === null) break;

      textBuffer += new TextDecoder().decode(readBuf.subarray(0, n));

      // Process complete lines
      const lines = textBuffer.split("\n");
      textBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed === "ARC_READY") {
          arcReady = true;
          console.log("Arc: control established");
          renderAllArcRings();
          continue;
        }

        // ENC:encoder:delta (1-based encoder from Lua)
        const match = trimmed.match(/^ENC:(\d+):(-?\d+)$/);
        if (match) {
          const encoder = parseInt(match[1]) - 1; // Convert to 0-based
          const delta = parseInt(match[2]);
          handleArcDelta(encoder, delta);
        }
      }
    }
    console.log("Arc: serial read loop ended");
  })();

  // Wait for device to settle, then take control
  await new Promise(r => setTimeout(r, 500));
  await arcTakeControl();
}

// --- Grid Init ---

async function initGrid(): Promise<void> {
  try {
    gridSocket = Deno.listenDatagram({ hostname: "127.0.0.1", port: GRID_LISTEN_PORT, transport: "udp", reuseAddress: true });
  } catch {
    console.log("Grid: could not bind UDP port " + GRID_LISTEN_PORT);
    return;
  }

  const discover = oscMessage("/serialosc/list", "127.0.0.1", GRID_LISTEN_PORT);
  try {
    await gridSocket.send(discover, { hostname: "127.0.0.1", port: SERIALOSC_PORT, transport: "udp" });
  } catch {
    console.log("Grid: serialosc not reachable on port " + SERIALOSC_PORT);
    return;
  }

  console.log("Grid: listening for serialosc on UDP " + GRID_LISTEN_PORT);

  let deviceFound = false;
  setTimeout(() => {
    if (!deviceFound) {
      console.log("Grid: no response from serialosc — is serialoscd running? (sudo systemctl start serialosc)");
    }
  }, 2000);

  (async () => {
    for await (const [data] of gridSocket!) {
      const msg = parseOsc(data);
      if (!msg) continue;

      if (msg.address === "/serialosc/device") {
        deviceFound = true;
        const devName = msg.args[0] as string;
        const devType = msg.args[1] as string;
        const devPort = msg.args[2] as number;
        const isArc = devType.includes("arc") || devName.includes("arc");

        if (isArc) {
          if (arcPort === devPort) continue; // already configured
          arcPort = devPort;
          console.log(`Arc: found ${devName} (${devType}) on port ${arcPort}`);
          await arcSend(oscMessage("/sys/port", GRID_LISTEN_PORT));
          await arcSend(oscMessage("/sys/host", "127.0.0.1"));
          await arcSend(oscMessage("/sys/prefix", GRID_PREFIX));
          renderAllArcRings();
          await arcSend(oscMessage("/sys/info"));
        } else {
          if (gridPort === devPort) continue; // already configured
          gridPort = devPort;
          console.log(`Grid: found ${devName} (${devType}) on port ${gridPort}`);
          await gridSend(oscMessage("/sys/port", GRID_LISTEN_PORT));
          await gridSend(oscMessage("/sys/host", "127.0.0.1"));
          await gridSend(oscMessage("/sys/prefix", GRID_PREFIX));
          populateFromProgram(testProgram);
          renderGrid();
          await gridSend(oscMessage("/sys/info"));
        }
      }

      if (msg.address === "/sys/size") {
        console.log(`Grid: size ${msg.args[0]}x${msg.args[1]}`);
      }

      if (msg.address === `${GRID_PREFIX}/grid/key`) {
        const [x, y, s] = msg.args as number[];
        handleGridKey(x, y, s);
      }

      if (msg.address === `${GRID_PREFIX}/enc/delta`) {
        const [n, d] = msg.args as number[];
        handleArcDelta(n, d);
      }
    }
  })();

  const notify = oscMessage("/serialosc/notify", "127.0.0.1", GRID_LISTEN_PORT);
  await gridSocket.send(notify, { hostname: "127.0.0.1", port: SERIALOSC_PORT, transport: "udp" });
}

// --- Start servers ---

await ensureCerts();

console.log(`HOST_IP: ${HOST_IP}`);
console.log(`Ensemble: https://localhost:${HTTPS_PORT}/ensemble.html`);

// HTTP captive portal on port 8080
Deno.serve(
  { port: HTTP_PORT, hostname: "0.0.0.0" },
  (req: Request, info: Deno.ServeHandlerInfo) => portalHandler(req, info),
);

// HTTPS main server on port 8443
Deno.serve(
  {
    port: HTTPS_PORT,
    cert: await Deno.readTextFile(CERT_FILE),
    key: await Deno.readTextFile(KEY_FILE),
  },
  (req: Request, info: Deno.ServeHandlerInfo) => httpsHandler(req, info),
);

// Server heartbeat — detects dead connections + keepalive
setInterval(() => {
  broadcast({ type: "health", ts: Date.now() });
}, 5000);

// Start test mode, grid controller, and arc
startTestMode();
initGrid();
initArc();
