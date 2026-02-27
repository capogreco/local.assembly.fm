const CERT_FILE = "cert.pem";
const KEY_FILE = "key.pem";
const PORT = 8443;

async function ensureCerts(): Promise<void> {
  try {
    await Deno.stat(CERT_FILE);
    await Deno.stat(KEY_FILE);
    console.log("TLS certs found");
  } catch {
    console.log("Generating self-signed TLS certs...");
    const cmd = new Deno.Command("openssl", {
      args: [
        "req",
        "-x509",
        "-newkey", "ec",
        "-pkeyopt", "ec_paramgen_curve:prime256v1",
        "-keyout", KEY_FILE,
        "-out", CERT_FILE,
        "-days", "365",
        "-nodes",
        "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:192.168.178.10",
      ],
    });
    const { code, stderr } = await cmd.output();
    if (code !== 0) {
      console.error(new TextDecoder().decode(stderr));
      Deno.exit(1);
    }
    console.log("Certs generated");
  }
}

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

const clients = new Set<WebSocket>();

function handleWs(req: Request): Response {
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.addEventListener("open", () => {
    clients.add(socket);
    console.log(`Client connected (${clients.size} total)`);
  });

  socket.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "health") {
        socket.send(JSON.stringify({ type: "health", ts: Date.now() }));
      }
    } catch {
      // ignore malformed messages
    }
  });

  socket.addEventListener("close", () => {
    clients.delete(socket);
    console.log(`Client disconnected (${clients.size} total)`);
  });

  return response;
}

function handler(req: Request): Response | Promise<Response> {
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return handleWs(req);
  }

  const url = new URL(req.url);
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  return serveFile(path);
}

await ensureCerts();

Deno.serve(
  {
    port: PORT,
    cert: await Deno.readTextFile(CERT_FILE),
    key: await Deno.readTextFile(KEY_FILE),
  },
  handler,
);
