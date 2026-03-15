/**
 * Synth Client — graph-driven, patch-loaded synthesis
 * Uses: graph.js, connection.js
 */

const overlay = document.getElementById("overlay");
const connStatus = document.getElementById("conn-status");
const clientCount = document.getElementById("client-count");

let audioCtx, conn, graph = null;
let activeEngines = new Map();
const workletModulesLoaded = new Set();

// --- Engines ---

const ENGINES = {
  formant:          { module: "processor.js",    worklet: "voice-processor", channels: 4 },
  "karplus-strong": { module: "ks-processor.js", worklet: "ks-processor",   channels: 1 },
};

async function createEngine(type) {
  const def = ENGINES[type];
  if (!def) return null;
  if (!workletModulesLoaded.has(def.module)) {
    await audioCtx.audioWorklet.addModule(def.module);
    workletModulesLoaded.add(def.module);
  }
  const opts = def.channels > 1 ? { outputChannelCount: [def.channels] } : {};
  const worklet = new AudioWorkletNode(audioCtx, def.worklet, opts);
  if (def.channels > 1) {
    const splitter = audioCtx.createChannelSplitter(def.channels);
    worklet.connect(splitter);
    const out = audioCtx.createGain();
    splitter.connect(out, 0);
    out.connect(audioCtx.destination);
    return { type, worklet, splitter, out };
  }
  worklet.connect(audioCtx.destination);
  return { type, worklet };
}

function sendParams(engine, params) {
  if (!engine?.worklet) return;
  engine.worklet.port.postMessage({ type: "params", ...params });
}

// --- Patch loading ---

async function loadPatch(patch) {
  // tear down old engines
  for (const e of activeEngines.values()) {
    e.worklet?.disconnect();
    e.splitter?.disconnect();
    e.out?.disconnect();
  }
  activeEngines.clear();

  graph = buildGraph(patch);

  // create and silence engines
  for (const [id, def] of graph.engines) {
    const engine = await createEngine(def.type);
    if (engine) {
      activeEngines.set(id, engine);
      const silent = Object.fromEntries(def.paramNames.map(n => [n, 0]));
      sendParams(engine, silent);
    }
  }
  console.log("Patch loaded:", [...graph.engines.values()].map(e => e.type).join(", "));
}

// --- Messages ---

function onMessage(msg) {
  if (msg.type === "patch" && audioCtx) { loadPatch(msg); return; }
  if (msg.type === "rv" && graph) {
    const updates = processRouterValue(graph, msg.r, msg.v);
    for (const [id, params] of Object.entries(updates)) {
      const engine = activeEngines.get(Number(id));
      if (engine) sendParams(engine, params);
    }
  }
  if (msg.type === "re" && graph) {
    const updates = processRouterEvent(graph, msg.r);
    for (const [id, params] of Object.entries(updates)) {
      const engine = activeEngines.get(Number(id));
      if (engine) sendParams(engine, params);
    }
  }
}

// --- Init ---

async function handleStart() {
  overlay.classList.add("hidden");
  try {
    audioCtx = new AudioContext();
    await audioCtx.resume();
    try { const wl = await navigator.wakeLock?.request("screen"); wl?.addEventListener("release", () => {}); } catch {}
  } catch (err) {
    overlay.querySelector("span").textContent = "audio failed";
    overlay.classList.remove("hidden");
    return;
  }
  conn = connect(onMessage, connStatus, clientCount);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx) {
    audioCtx.resume();
    try { navigator.wakeLock?.request("screen"); } catch {}
  }
});

overlay.addEventListener("touchend", (e) => { e.preventDefault(); handleStart(); }, { once: true });
overlay.addEventListener("click", () => handleStart(), { once: true });
