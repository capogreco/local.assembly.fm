/**
 * Server Connection — WebSocket
 *
 * connect(onMessage, statusEl, countEl, delay)
 *   onMessage(msg) — called for patch, rv, re messages
 *   statusEl — span for connection status label (null to skip UI)
 *   countEl — span for client count display (null to skip UI)
 *   delay — ms to wait before the first connection attempt (staggers ensemble voices)
 *   Returns { getClientId(), close(), send(msg) }
 */

function connect(onMessage, statusEl, countEl, delay) {
  let ws = null;
  let healthInterval = null;
  let clientId = null;
  let destroyed = false;
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

  function connectWebSocket() {
    if (destroyed || ws) return;
    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${location.host}`;

    try { ws = new WebSocket(wsUrl); } catch { return; }

    let settled = false;
    const wsTimeout = setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) { ws.close(); }
    }, 5000);

    ws.addEventListener("open", () => {
      clearTimeout(wsTimeout);
      settled = true;
      setStatus("ws");
      healthInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "health" }));
        }
      }, 5000);
    });

    ws.addEventListener("message", (e) => {
      try { handleRaw(JSON.parse(e.data)); } catch (err) { console.error("WS message error:", err); }
    });

    ws.addEventListener("error", () => {
      clearTimeout(wsTimeout);
      // close handler will do cleanup and retry — don't duplicate
    });

    ws.addEventListener("close", () => {
      clearTimeout(wsTimeout);
      clearInterval(healthInterval);
      ws = null;
      if (destroyed) return;
      setStatus("disconnected");
      const retry = settled ? 2000 : 2000 + Math.random() * 3000;
      settled = false;
      setTimeout(connectWebSocket, retry);
    });
  }

  function close() {
    destroyed = true;
    if (ws) { ws.close(); ws = null; }
    clearInterval(healthInterval);
  }

  if (delay > 0) setTimeout(connectWebSocket, delay);
  else connectWebSocket();

  return { getClientId: () => clientId, close, send: (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }};
}
