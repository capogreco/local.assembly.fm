const overlay = document.getElementById("overlay");
const connStatus = document.getElementById("conn-status");
const clientCount = document.getElementById("client-count");
const statusBar = document.getElementById("status-bar");

let ws;
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

// --- Tap to start ---

async function handleStart() {
  overlay.classList.add("hidden");
  try {
    await initAudio();
    await requestWakeLock();
  } catch (err) {
    console.error("Audio init failed:", err);
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

// --- WebSocket ---

function connect() {
  ws = new WebSocket(`wss://${location.host}`);

  ws.addEventListener("open", () => {
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
      const msg = JSON.parse(e.data);

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
    } catch {
      // ignore malformed messages
    }
  });

  ws.addEventListener("close", () => {
    connStatus.textContent = "disconnected";
    statusBar.className = "disconnected";
    clientCount.textContent = "";
    clearInterval(healthInterval);
    setTimeout(connect, 2000);
  });
}
