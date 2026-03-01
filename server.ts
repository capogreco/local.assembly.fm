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
      send(testProgram);
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

// --- Test mode: generator-based parameter broadcast ---

// Initial generator program — sent to each new client
const SEVEN = [1, 2, 3, 4, 5, 6];

const testProgram: Record<string, unknown> = {
  type: "params",
  frequency: {
    base: 220,
    nums: [1, 5, 3, 7, 2, 9, 4],
    dens: [1, 4, 2, 4, 1, 8, 3],
    numCommand: "shuffle",
    denCommand: "shuffle",
  },
  vowelX:    { nums: SEVEN, dens: [6], numCommand: "shuffle" },
  vowelY:    { nums: SEVEN, dens: [6], numCommand: "shuffle" },
  zingAmount:{ nums: SEVEN, dens: [6], numCommand: "shuffle" },
  zingMorph: { nums: SEVEN, dens: [6], numCommand: "shuffle" },
  symmetry:  { nums: [1, 2, 3, 4, 5], dens: [6], numCommand: "shuffle" },
  amplitude: 0.1,
  orbitAngle: 0,
  orbitThrust: 0.3,
};

function sendInitialProgram(send: (data: string) => void): void {
  send(JSON.stringify(testProgram));
}

// Shuffle schedule — stagger commands so params change at different times
const shuffleSchedule: { tick: number; param: string }[] = [
  { tick: 50,  param: "frequency" },   //  5s — both num and den
  { tick: 80,  param: "vowelX" },      //  8s
  { tick: 110, param: "vowelY" },      // 11s
  { tick: 140, param: "zingAmount" },   // 14s
  { tick: 160, param: "zingMorph" },    // 16s
  { tick: 180, param: "symmetry" },     // 18s
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
        if (entry.param === "frequency") {
          msg[entry.param] = { numCommand: "shuffle", denCommand: "shuffle" };
        } else {
          msg[entry.param] = { numCommand: "shuffle" };
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
  // Silence all clients
  broadcast({ type: "params", amplitude: 0.0 });
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
let gridSocket: Deno.DatagramConn | null = null;
const GRID_LISTEN_PORT = 13000;

async function gridSend(msg: Uint8Array): Promise<void> {
  if (!gridSocket || !gridPort) return;
  await gridSocket.send(msg, { hostname: "127.0.0.1", port: gridPort, transport: "udp" });
}

function gridLed(x: number, y: number, s: number): void {
  gridSend(oscMessage(`${GRID_PREFIX}/grid/led/set`, x, y, s));
}

async function initGrid(): Promise<void> {
  try {
    gridSocket = Deno.listenDatagram({ hostname: "127.0.0.1", port: GRID_LISTEN_PORT, transport: "udp" });
  } catch {
    console.log("Grid: could not bind UDP port " + GRID_LISTEN_PORT);
    return;
  }

  // Ask serialosc for device list
  const discover = oscMessage("/serialosc/list", "127.0.0.1", GRID_LISTEN_PORT);
  try {
    await gridSocket.send(discover, { hostname: "127.0.0.1", port: SERIALOSC_PORT, transport: "udp" });
  } catch {
    console.log("Grid: serialosc not reachable on port " + SERIALOSC_PORT);
    return;
  }

  console.log("Grid: listening for serialosc on UDP " + GRID_LISTEN_PORT);

  // Listen for OSC messages
  (async () => {
    for await (const [data] of gridSocket!) {
      const msg = parseOsc(data);
      if (!msg) continue;

      if (msg.address === "/serialosc/device") {
        // Device found: id, type, port
        gridPort = msg.args[2] as number;
        console.log(`Grid: found ${msg.args[0]} (${msg.args[1]}) on port ${gridPort}`);
        // Configure: set our port and prefix
        await gridSend(oscMessage("/sys/port", GRID_LISTEN_PORT));
        await gridSend(oscMessage("/sys/host", "127.0.0.1"));
        await gridSend(oscMessage("/sys/prefix", GRID_PREFIX));
        // Light up top-right LED to show test mode state
        gridLed(15, 0, testInterval ? 1 : 0);
        // Request device info
        await gridSend(oscMessage("/sys/info"));
      }

      if (msg.address === "/sys/size") {
        console.log(`Grid: size ${msg.args[0]}x${msg.args[1]}`);
      }

      if (msg.address === `${GRID_PREFIX}/grid/key`) {
        const [x, y, s] = msg.args as number[];
        // Top-right button: toggle test mode on press
        if (x === 15 && y === 0 && s === 1) {
          if (testInterval) {
            stopTestMode();
            gridLed(15, 0, 0);
          } else {
            startTestMode();
            gridLed(15, 0, 1);
          }
        }
      }
    }
  })();

  // Subscribe to device add/remove notifications
  const notify = oscMessage("/serialosc/notify", "127.0.0.1", GRID_LISTEN_PORT);
  await gridSocket.send(notify, { hostname: "127.0.0.1", port: SERIALOSC_PORT, transport: "udp" });
}

// --- Start servers ---

await ensureCerts();

console.log(`HOST_IP: ${HOST_IP}`);

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

// Start test mode and grid controller
startTestMode();
initGrid();
