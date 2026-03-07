/**
 * Phone Client — single synth instance with generator resolver
 *
 * Uses: resolve.js, synth-instance.js, connection.js, scope.js
 */

const overlay = document.getElementById("overlay");
const connStatus = document.getElementById("conn-status");
const clientCount = document.getElementById("client-count");

let audioCtx, instance, ksNode, genState, setOrbit, conn;
let wakeLock = null;

async function handleStart() {
  overlay.classList.add("hidden");
  try {
    audioCtx = new AudioContext();
    await audioCtx.resume();
    await audioCtx.audioWorklet.addModule("processor.js");
    await audioCtx.audioWorklet.addModule("ks-processor.js");
    instance = await createSynthInstance(audioCtx);

    // Channel 0 -> speakers
    const audioOut = audioCtx.createGain();
    instance.splitter.connect(audioOut, 0);
    audioOut.connect(audioCtx.destination);

    // Karplus-Strong engine (silent until triggered)
    ksNode = new AudioWorkletNode(audioCtx, "ks-processor");
    ksNode.connect(audioCtx.destination);

    await requestWakeLock();
  } catch (err) {
    console.error("Audio init failed:", err);
    overlay.querySelector("span").textContent = "audio failed: " + err.message;
    overlay.classList.remove("hidden");
    return;
  }

  const scopeCanvas = document.getElementById("scope");
  if (scopeCanvas) {
    setOrbit = initScope(scopeCanvas, [instance]);
  }

  conn = connect(onMessage, connStatus, clientCount);
}

function onMessage(msg) {
  if (msg.type === "params") {
    if (!genState) genState = createGeneratorState();
    const resolved = processMessage(msg, genState);
    instance.worklet.port.postMessage(resolved);
    if (setOrbit && (resolved.orbitAngle !== undefined || resolved.orbitThrust !== undefined)) {
      setOrbit(resolved.orbitAngle, resolved.orbitThrust);
    }

    // Forward ks-prefixed params to KS worklet
    if (ksNode) {
      const ksParams = {};
      let hasTrigger = false;
      let hasKs = false;
      for (const key of Object.keys(msg)) {
        if (key === "ksTrigger") { hasTrigger = true; continue; }
        if (key.startsWith("ks")) {
          // Strip "ks" prefix and lowercase first char
          const stripped = key[2].toLowerCase() + key.slice(3);
          ksParams[stripped] = msg[key];
          hasKs = true;
        }
      }
      if (hasKs) ksNode.port.postMessage({ type: "params", ...ksParams });
      if (hasTrigger) ksNode.port.postMessage({ type: "excite" });
    }
  }
}

// --- Wake Lock ---

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
    wakeLock?.addEventListener("release", () => { wakeLock = null; });
  } catch {}
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx) {
    requestWakeLock();
    audioCtx.resume();
  }
});

// --- Tap to start ---

overlay.addEventListener("touchend", (e) => { e.preventDefault(); handleStart(); }, { once: true });
overlay.addEventListener("click", () => handleStart(), { once: true });
