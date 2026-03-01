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

// --- Test mode: periodic parameter broadcast ---

function startTestMode(): void {
  let t = 0;
  setInterval(() => {
    t += 0.02;
    broadcast({
      type: "params",
      frequency: 180 + Math.sin(t * 0.3) * 60,
      vowelX: 0.5 + Math.sin(t * 0.7) * 0.4,
      vowelY: 0.5 + Math.cos(t * 0.5) * 0.4,
      zingAmount: 0.5 + Math.sin(t * 0.2) * 0.3,
      zingMorph: 0.5 + Math.cos(t * 0.4) * 0.3,
      symmetry: 0.5 + Math.sin(t * 0.15) * 0.2,
      orbitAngle: (t * 0.3) % (Math.PI * 2),
      orbitThrust: 0.3 + Math.sin(t * 0.1) * 0.2,
    });
  }, 100);
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

startTestMode();
console.log("Test mode: broadcasting parameter changes");
