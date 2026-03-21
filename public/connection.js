/**
 * Server Connection — SSE-first with WebSocket upgrade
 *
 * connect(onMessage, statusEl, countEl)
 *   onMessage(msg) — called for patch, rv, re messages
 *   statusEl — span for connection status label (null to skip UI)
 *   countEl — span for client count display (null to skip UI)
 *   Returns { getClientId(), close() }
 */

function connect(onMessage, statusEl, countEl, wsOnly, delay) {
  let ws = null;
  let sse = null;
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

  let upgrading = false; // true while attempting WS upgrade — suppress SSE messages

  function connectSSE() {
    const eventsUrl = `${location.protocol}//${location.host}/events`;
    sse = new EventSource(eventsUrl);

    sse.addEventListener("open", () => {
      setStatus("sse");
      upgrading = true;
      tryWebSocket();
    });

    sse.addEventListener("message", (e) => {
      if (upgrading) return; // don't deliver messages during WS upgrade attempt
      try { handleRaw(JSON.parse(e.data)); } catch (err) { console.error("SSE message error:", err); }
    });

    sse.addEventListener("error", () => {
      setStatus("disconnected");
      if (sse.readyState === EventSource.CLOSED) {
        sse = null;
        if (!destroyed) setTimeout(connectSSE, 2000);
      }
    });
  }

  function tryWebSocket() {
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
      if (sse) { sse.close(); sse = null; }
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
      const delay = settled ? 2000 : 2000 + Math.random() * 3000;
      settled = false;
      upgrading = false;
      if (wsOnly) setTimeout(tryWebSocket, delay);
      else if (!sse) connectSSE();
    });
  }

  function close() {
    destroyed = true;
    if (ws) { ws.close(); ws = null; }
    if (sse) { sse.close(); sse = null; }
    clearInterval(healthInterval);
  }

  if (delay > 0) {
    setTimeout(() => { if (wsOnly) tryWebSocket(); else connectSSE(); }, delay);
  } else {
    if (wsOnly) tryWebSocket(); else connectSSE();
  }

  return { getClientId: () => clientId, close };
}
