/**
 * Server Connection — SSE-first with WebSocket upgrade
 *
 * connect(onMessage, statusEl, countEl)
 *   onMessage(msg) — called for patch, rv, re messages
 *   statusEl — span for connection status label (null to skip UI)
 *   countEl — span for client count display (null to skip UI)
 *   Returns { getClientId(), close() }
 */

function connect(onMessage, statusEl, countEl, wsOnly) {
  let ws = null;
  let sse = null;
  let healthInterval = null;
  let clientId = null;
  const statusBar = statusEl?.parentElement;

  function setStatus(label) {
    if (!statusEl) return;
    statusEl.textContent = label;
    statusBar.className = label === "disconnected" ? "disconnected" : "connected";
    if (label === "disconnected" && countEl) countEl.textContent = "";
  }

  function handleRaw(msg) {
    switch (msg.type) {
      case "welcome":
        clientId = msg.id;
        if (countEl) countEl.textContent = msg.clients ? `${msg.clients} connected` : "";
        break;
      case "count":
        if (countEl) countEl.textContent = msg.clients ? `${msg.clients} connected` : "";
        break;
      case "health":
        break;
      default:
        onMessage(msg);
    }
  }

  function connectSSE() {
    const eventsUrl = `${location.protocol}//${location.host}/events`;
    sse = new EventSource(eventsUrl);

    sse.addEventListener("open", () => {
      setStatus("sse");
      tryWebSocket();
    });

    sse.addEventListener("message", (e) => {
      try { handleRaw(JSON.parse(e.data)); } catch (err) { console.error("SSE message error:", err); }
    });

    sse.addEventListener("error", () => {
      setStatus("disconnected");
      if (sse.readyState === EventSource.CLOSED) {
        sse = null;
        setTimeout(connectSSE, 2000);
      }
    });
  }

  function tryWebSocket() {
    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${location.host}`;

    try { ws = new WebSocket(wsUrl); } catch { return; }

    const wsTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) { ws.close(); ws = null; }
    }, 2000);

    ws.addEventListener("open", () => {
      clearTimeout(wsTimeout);
      if (sse) { sse.close(); sse = null; }
      setStatus("ws");
      healthInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "health" }));
        }
      }, 5000);
    });

    ws.addEventListener("message", (e) => {
      try { handleRaw(JSON.parse(e.data)); } catch (err) { console.error("WS message error:", err); }
    });

    ws.addEventListener("error", () => {
      clearTimeout(wsTimeout);
      ws = null;
      if (wsOnly) { setStatus("disconnected"); setTimeout(tryWebSocket, 2000); }
      else if (!sse) connectSSE();
    });

    ws.addEventListener("close", () => {
      clearTimeout(wsTimeout);
      clearInterval(healthInterval);
      ws = null;
      if (wsOnly) { setStatus("disconnected"); setTimeout(tryWebSocket, 2000); }
      else if (!sse) connectSSE();
    });
  }

  function close() {
    if (ws) { ws.close(); ws = null; }
    if (sse) { sse.close(); sse = null; }
    clearInterval(healthInterval);
  }

  if (wsOnly) {
    tryWebSocket();
  } else {
    connectSSE();
  }

  return { getClientId: () => clientId, close };
}
