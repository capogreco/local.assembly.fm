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

// --- WebSocket clients ---

let nextClientId = 1;
const clients = new Map<number, WebSocket>();

function broadcast(msg: Record<string, unknown>): void {
  const data = JSON.stringify(msg);
  for (const [, socket] of clients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  }
}

function broadcastClientCount(): void {
  broadcast({ type: "count", clients: clients.size });
}

function handleWs(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);
  const id = nextClientId++;

  socket.addEventListener("open", () => {
    clients.set(id, socket);
    console.log(`Client ${id} connected (${clients.size} total)`);
    socket.send(JSON.stringify({
      type: "welcome",
      id,
      clients: clients.size,
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
    clients.delete(id);
    console.log(`Client ${id} disconnected (${clients.size} total)`);
    broadcastClientCount();
  });

  return response;
}

// --- Captive portal (HTTP on port 8080) ---

const authenticatedIPs = new Set<string>();

function getClientIP(req: Request, info: Deno.ServeHandlerInfo): string {
  return (info.remoteAddr as Deno.NetAddr).hostname;
}

function portalHandler(
  req: Request,
  info: Deno.ServeHandlerInfo,
): Response | Promise<Response> {
  const url = new URL(req.url);
  const clientIP = getClientIP(req, info);

  // Apple captive portal probe
  if (url.pathname === "/hotspot-detect.html") {
    if (authenticatedIPs.has(clientIP)) {
      return new Response("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>", {
        headers: { "content-type": "text/html" },
      });
    }
    return Response.redirect(`http://${HOST_IP}:${HTTP_PORT}/portal`, 302);
  }

  // Google/Android captive portal probe
  if (url.pathname === "/generate_204") {
    if (authenticatedIPs.has(clientIP)) {
      return new Response(null, { status: 204 });
    }
    return Response.redirect(`http://${HOST_IP}:${HTTP_PORT}/portal`, 302);
  }

  // Firefox captive portal probe
  if (url.pathname === "/canonical.html") {
    if (authenticatedIPs.has(clientIP)) {
      return new Response("<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>", {
        headers: { "content-type": "text/html" },
      });
    }
    return Response.redirect(`http://${HOST_IP}:${HTTP_PORT}/portal`, 302);
  }

  // Microsoft captive portal probe
  if (url.pathname === "/connecttest.txt") {
    if (authenticatedIPs.has(clientIP)) {
      return new Response("Microsoft Connect Test", {
        headers: { "content-type": "text/plain" },
      });
    }
    return Response.redirect(`http://${HOST_IP}:${HTTP_PORT}/portal`, 302);
  }

  // Portal page
  if (url.pathname === "/portal") {
    authenticatedIPs.add(clientIP);
    console.log(`Portal: authenticated ${clientIP}`);
    return serveFile("/portal.html");
  }

  // Everything else → redirect to HTTPS app
  return Response.redirect(`https://${HOST_DOMAIN}:${HTTPS_PORT}`, 302);
}

// --- HTTPS handler ---

function httpsHandler(req: Request): Response | Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return handleWs(req);
  }

  const url = new URL(req.url);
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
  httpsHandler,
);

startTestMode();
console.log("Test mode: broadcasting parameter changes");
