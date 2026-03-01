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
let analyserF1, analyserF2, analyserF3;
let setOrbit = null;

// --- Audio initialization ---

async function initAudio() {
  audioCtx = new AudioContext();
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule("processor.js");
  workletNode = new AudioWorkletNode(audioCtx, "voice-processor", {
    outputChannelCount: [4],
  });

  // Split 4-channel output: ch0 = audio, ch1-3 = per-formant for scope
  const splitter = audioCtx.createChannelSplitter(4);
  workletNode.connect(splitter);

  // Channel 0 → speakers (via gain node for proper stereo upmix)
  const audioOut = audioCtx.createGain();
  splitter.connect(audioOut, 0);
  audioOut.connect(audioCtx.destination);

  // Channels 1-3 → AnalyserNodes for oscilloscope
  analyserF1 = audioCtx.createAnalyser();
  analyserF1.fftSize = 512;
  analyserF1.smoothingTimeConstant = 0;
  splitter.connect(analyserF1, 1);

  analyserF2 = audioCtx.createAnalyser();
  analyserF2.fftSize = 512;
  analyserF2.smoothingTimeConstant = 0;
  splitter.connect(analyserF2, 2);

  analyserF3 = audioCtx.createAnalyser();
  analyserF3.fftSize = 512;
  analyserF3.smoothingTimeConstant = 0;
  splitter.connect(analyserF3, 3);
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
      if (setOrbit && (msg.orbitAngle !== undefined || msg.orbitThrust !== undefined)) {
        setOrbit(msg.orbitAngle, msg.orbitThrust);
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
  // Init oscilloscope
  const scopeCanvas = document.getElementById("scope");
  if (scopeCanvas && analyserF1 && analyserF2 && analyserF3) {
    setOrbit = initScope(scopeCanvas, analyserF1, analyserF2, analyserF3);
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

// --- Connection: SSE default, upgrade to WebSocket if available ---

function setStatus(label) {
  connStatus.textContent = label;
  statusBar.className = label === "disconnected" ? "disconnected" : "connected";
  if (label === "disconnected") clientCount.textContent = "";
}

function connect() {
  connectSSE();
}

// --- SSE (default transport) ---

function connectSSE() {
  const eventsUrl = `${location.protocol}//${location.host}/events`;
  sse = new EventSource(eventsUrl);

  sse.addEventListener("open", () => {
    setStatus("sse");
    // Try upgrading to WebSocket
    tryWebSocket();
  });

  sse.addEventListener("message", (e) => {
    try {
      handleMessage(JSON.parse(e.data));
    } catch {
      // ignore malformed
    }
  });

  sse.addEventListener("error", () => {
    setStatus("disconnected");
    if (sse.readyState === EventSource.CLOSED) {
      sse = null;
      setTimeout(connectSSE, 2000);
    }
  });
}

// --- WebSocket upgrade (optional) ---

function tryWebSocket() {
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProto}//${location.host}`;

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    return; // stay on SSE
  }

  const wsTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      ws.close();
      ws = null;
    }
  }, 2000);

  ws.addEventListener("open", () => {
    clearTimeout(wsTimeout);
    // WebSocket connected — close SSE, switch over
    if (sse) {
      sse.close();
      sse = null;
    }
    setStatus("ws");

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
    ws = null;
    // Fall back to SSE if not already connected
    if (!sse) connectSSE();
  });

  ws.addEventListener("close", () => {
    clearTimeout(wsTimeout);
    clearInterval(healthInterval);
    ws = null;
    // Reconnect via SSE first, then try WS upgrade again
    if (!sse) connectSSE();
  });
}
