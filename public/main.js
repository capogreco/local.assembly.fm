const overlay = document.getElementById("overlay");
const connStatus = document.getElementById("conn-status");
const clientCount = document.getElementById("client-count");
const statusBar = document.getElementById("status-bar");

let ws;
let sse;
let healthInterval;
let audioCtx;
let workletNode;
let wakeLock = null;

// --- Audio initialization ---

async function initAudio() {
  audioCtx = new AudioContext();
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule("processor.js");
  workletNode = new AudioWorkletNode(audioCtx, "voice-processor", {
    outputChannelCount: [1],
  });
  workletNode.connect(audioCtx.destination);
}

// --- Screen Wake Lock ---

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
    wakeLock?.addEventListener("release", () => { wakeLock = null; });
  } catch {
    // Wake Lock not supported or denied
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx) {
    requestWakeLock();
    audioCtx.resume();
  }
});

// --- Shared message handler ---

function handleMessage(msg) {
  switch (msg.type) {
    case "health":
      break;

    case "welcome":
      clientCount.textContent = msg.clients
        ? `${msg.clients} connected`
        : "";
      break;

    case "params":
      if (workletNode) {
        workletNode.port.postMessage(msg);
      }
      break;

    case "play":
      if (workletNode) {
        workletNode.port.postMessage({ type: "params", amplitude: 0.1 });
      }
      if (audioCtx?.state === "suspended") audioCtx.resume();
      break;

    case "stop":
      if (workletNode) {
        workletNode.port.postMessage({ type: "params", amplitude: 0.0 });
      }
      break;

    case "count":
      clientCount.textContent = msg.clients
        ? `${msg.clients} connected`
        : "";
      break;
  }
}

// --- Tap to start ---

async function handleStart() {
  overlay.classList.add("hidden");
  try {
    await initAudio();
    await requestWakeLock();
  } catch (err) {
    console.error("Audio init failed:", err);
    const span = overlay.querySelector("span");
    span.textContent = "audio failed: " + err.message;
    overlay.classList.remove("hidden");
    return;
  }
  connect();
}

overlay.addEventListener("touchend", (e) => {
  e.preventDefault();
  handleStart();
}, { once: true });

overlay.addEventListener("click", () => {
  handleStart();
}, { once: true });

// --- Connection: WebSocket with SSE fallback ---

const isHTTPS = location.protocol === "https:";

function connect() {
  // Try WebSocket first
  const wsProto = isHTTPS ? "wss:" : "ws:";
  const wsUrl = `${wsProto}//${location.host}`;

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    // WebSocket constructor failed — go straight to SSE
    connectSSE();
    return;
  }

  // Give WebSocket 2 seconds to connect, otherwise fall back to SSE
  const wsTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.log("WebSocket timeout, falling back to SSE");
      ws.close();
      connectSSE();
    }
  }, 2000);

  ws.addEventListener("open", () => {
    clearTimeout(wsTimeout);
    connStatus.textContent = "connected";
    statusBar.className = "connected";

    healthInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "health" }));
      }
    }, 5000);
  });

  ws.addEventListener("message", (e) => {
    try {
      handleMessage(JSON.parse(e.data));
    } catch {
      // ignore malformed
    }
  });

  ws.addEventListener("error", () => {
    clearTimeout(wsTimeout);
    console.log("WebSocket error, falling back to SSE");
    connectSSE();
  });

  ws.addEventListener("close", () => {
    clearTimeout(wsTimeout);
    connStatus.textContent = "disconnected";
    statusBar.className = "disconnected";
    clientCount.textContent = "";
    clearInterval(healthInterval);
    // Only reconnect if SSE hasn't taken over
    if (!sse) {
      setTimeout(connect, 2000);
    }
  });
}

// --- SSE fallback ---

function connectSSE() {
  // Close any existing WebSocket
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    ws.close();
  }
  ws = null;

  const eventsUrl = `${location.protocol}//${location.host}/events`;
  sse = new EventSource(eventsUrl);

  sse.addEventListener("open", () => {
    connStatus.textContent = "connected";
    statusBar.className = "connected";
  });

  sse.addEventListener("message", (e) => {
    try {
      handleMessage(JSON.parse(e.data));
    } catch {
      // ignore malformed
    }
  });

  sse.addEventListener("error", () => {
    connStatus.textContent = "disconnected";
    statusBar.className = "disconnected";
    clientCount.textContent = "";
    // EventSource auto-reconnects, but if it's permanently dead, retry
    if (sse.readyState === EventSource.CLOSED) {
      sse = null;
      setTimeout(connectSSE, 2000);
    }
  });
}
