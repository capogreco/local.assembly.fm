const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";
const HTTPS_PORT = 8443;
const HTTP_PORT = 8080;
const HOST_IP = Deno.env.get("HOST_IP") || "192.168.178.10";
const HOST_DOMAIN = Deno.env.get("HOST_DOMAIN") || "local.assembly.fm";

// --- TLS cert check ---

async function hasCerts(): Promise<boolean> {
  try {
    await Deno.stat(CERT_FILE);
    await Deno.stat(KEY_FILE);
    return true;
  } catch {
    return false;
  }
}

// --- Static file serving ---

function mimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html", js: "application/javascript", css: "text/css",
    json: "application/json", png: "image/png", ico: "image/x-icon",
  };
  return types[ext ?? ""] ?? "application/octet-stream";
}

async function serveFile(path: string): Promise<Response> {
  try {
    const body = await Deno.readFile(`./public${path}`);
    return new Response(body, { headers: { "content-type": mimeType(path) } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

// --- Client tracking ---

let nextClientId = 1;
const wsClients = new Map<number, WebSocket>();
type SSESend = (data: Record<string, unknown>) => void;
const sseClients = new Map<number, SSESend>();

function totalClients(): number { return wsClients.size + sseClients.size; }

function broadcast(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const [, socket] of wsClients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  }
  for (const [, send] of sseClients) send(msg);
}

function broadcastClientCount(): void {
  broadcast({ type: "count", clients: totalClients() });
}

// --- IP auth tracking ---

const authenticatedIPs = new Set<string>();
const ipConnections = new Map<string, Set<number>>();
const deauthTimers = new Map<string, number>();

function trackConnect(clientIP: string, id: number): void {
  if (!ipConnections.has(clientIP)) ipConnections.set(clientIP, new Set());
  ipConnections.get(clientIP)!.add(id);
  const timer = deauthTimers.get(clientIP);
  if (timer !== undefined) { clearTimeout(timer); deauthTimers.delete(clientIP); }
}

function trackDisconnect(clientIP: string, id: number): void {
  const conns = ipConnections.get(clientIP);
  if (!conns?.has(id)) return;
  conns.delete(id);
  if (conns.size === 0) {
    ipConnections.delete(clientIP);
    if (!deauthTimers.has(clientIP)) {
      const timer = setTimeout(() => {
        authenticatedIPs.delete(clientIP);
        deauthTimers.delete(clientIP);
      }, 5000);
      deauthTimers.set(clientIP, timer);
    }
  }
}

// --- Deployed patch ---

let deployedPatch: Record<string, unknown> | null = null;

// --- WebSocket handler ---

function handleWs(req: Request, info: Deno.ServeHandlerInfo): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const id = nextClientId++;
  const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;

  socket.addEventListener("open", () => {
    wsClients.set(id, socket);
    trackConnect(clientIP, id);
    console.log(`WS ${id} connected from ${clientIP} (${totalClients()} total)`);
    socket.send(JSON.stringify({ type: "welcome", id, clients: totalClients() }));
    if (deployedPatch) socket.send(JSON.stringify(deployedPatch));
    broadcastClientCount();
  });

  socket.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "health") {
        socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
      } else if (msg.type === "patch") {
        deployedPatch = msg;
        broadcast(msg);
        console.log("Patch deployed");
      } else if (msg.type === "rv" || msg.type === "re") {
        broadcast(msg);
      }
    } catch { /* ignore malformed */ }
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
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { /* stream closed */ }
      };
      sseClients.set(id, send);
      trackConnect(clientIP, id);
      console.log(`SSE ${id} connected from ${clientIP} (${totalClients()} total)`);
      send({ type: "welcome", id, clients: totalClients() });
      if (deployedPatch) send(deployedPatch);
      broadcastClientCount();
    },
    cancel() {
      sseClients.delete(id);
      trackDisconnect(clientIP, id);
      console.log(`SSE ${id} disconnected (${totalClients()} total)`);
      broadcastClientCount();
    },
  });

  req.signal.addEventListener("abort", () => {
    sseClients.delete(id);
    trackDisconnect(clientIP, id);
    broadcastClientCount();
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" },
  });
}

// --- Captive portal (HTTP) ---

function portalHandler(req: Request, info: Deno.ServeHandlerInfo): Response | Promise<Response> {
  const url = new URL(req.url);
  const clientIP = (info.remoteAddr as Deno.NetAddr).hostname;
  const probes = ["/hotspot-detect.html", "/generate_204", "/canonical.html", "/connecttest.txt"];

  if (probes.includes(url.pathname)) {
    if (authenticatedIPs.has(clientIP)) {
      if (url.pathname === "/generate_204") return new Response(null, { status: 204 });
      if (url.pathname === "/connecttest.txt") return new Response("Microsoft Connect Test", { headers: { "content-type": "text/plain" } });
      return new Response("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>", { headers: { "content-type": "text/html" } });
    }
    console.log(`CNA: redirecting ${clientIP} to HTTPS via ${url.pathname}`);
    return Response.redirect(`https://${HOST_DOMAIN}:${HTTPS_PORT}`, 302);
  }

  if (url.pathname === "/auth") { authenticatedIPs.add(clientIP); return new Response("ok"); }
  if (url.pathname === "/events") return handleSSE(req, info);
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return handleWs(req, info);
  const ext = url.pathname.split(".").pop()?.toLowerCase();
  if (ext && ["js", "css", "json", "png", "ico"].includes(ext)) return serveFile(url.pathname);
  return serveFile("/index.html");
}

// --- HTTPS handler ---

function httpsHandler(req: Request, info: Deno.ServeHandlerInfo): Response | Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return handleWs(req, info);
  const url = new URL(req.url);
  if (url.pathname === "/events") return handleSSE(req, info);
  if (url.pathname === "/auth") { authenticatedIPs.add((info.remoteAddr as Deno.NetAddr).hostname); return new Response("ok"); }
  return serveFile(url.pathname === "/" ? "/index.html" : url.pathname);
}

// --- Start ---

const tlsAvailable = await hasCerts();
console.log(`HOST_IP: ${HOST_IP}`);

if (tlsAvailable) {
  console.log("TLS certs found — starting HTTPS + HTTP portal");
  console.log(`Synth:  https://localhost:${HTTPS_PORT}/`);
  console.log(`Ctrl:   https://localhost:${HTTPS_PORT}/ctrl.html`);
  Deno.serve({ port: HTTP_PORT, hostname: "0.0.0.0" }, (req, info) => portalHandler(req, info));
  Deno.serve({ port: HTTPS_PORT, cert: await Deno.readTextFile(CERT_FILE), key: await Deno.readTextFile(KEY_FILE) }, (req, info) => httpsHandler(req, info));
} else {
  console.log("No TLS certs — dev mode (HTTP only)");
  console.log(`Synth:  http://localhost:${HTTP_PORT}/`);
  console.log(`Ctrl:   http://localhost:${HTTP_PORT}/ctrl.html`);
  Deno.serve({ port: HTTP_PORT, hostname: "0.0.0.0" }, (req, info) => httpsHandler(req, info));
}

setInterval(() => { broadcast({ type: "health", ts: Date.now() }); }, 5000);
