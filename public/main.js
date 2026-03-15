/**
 * Synth Client — graph-driven, patch-loaded synthesis
 * Uses: graph.js, connection.js
 */

const overlay = document.getElementById("overlay");
const connStatus = document.getElementById("conn-status");
const clientCount = document.getElementById("client-count");

let audioCtx, conn, graph = null, scopeSetOrbit = null;
let activeEngines = new Map();
const workletModulesLoaded = new Set();
let patchLoading = false;
let pendingMessages = [];

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
    const engine = { type, worklet, splitter, out };
    // formant: create analysers for scope
    if (type === "formant") {
      const analyserConfig = [[1, "analyserF1"], [2, "analyserF2"], [3, "analyserF3"]];
      for (const cfg of analyserConfig) {
        const a = audioCtx.createAnalyser();
        a.fftSize = 512; a.smoothingTimeConstant = 0;
        splitter.connect(a, cfg[0]);
        engine[cfg[1]] = a;
      }
    }
    return engine;
  }
  worklet.connect(audioCtx.destination);
  return { type, worklet };
}

function sendParams(engine, params) {
  if (!engine?.worklet) return;
  if (!engine.currentParams) engine.currentParams = {};
  Object.assign(engine.currentParams, params);
  engine.worklet.port.postMessage({ type: "params", ...params });
  updateParamDisplay();
}

function updateParamDisplay() {
  const el = document.getElementById("param-display");
  if (!el) return;
  const lines = [];
  for (const [id, engine] of activeEngines) {
    if (engine.currentParams) {
      lines.push(engine.type + ":");
      for (const [k, v] of Object.entries(engine.currentParams)) {
        lines.push("  " + k + ": " + (typeof v === "number" ? v.toFixed(4) : v));
      }
    }
  }
  el.textContent = lines.join("\n");
}

// --- Patch loading ---

async function loadPatch(patch) {
  patchLoading = true;
  pendingMessages = [];

  // tear down old engines
  for (const e of activeEngines.values()) {
    e.worklet?.disconnect();
    e.splitter?.disconnect();
    e.out?.disconnect();
  }
  activeEngines.clear();

  graph = buildGraph(patch);

  // create engines
  for (const [id, def] of graph.engines) {
    const engine = await createEngine(def.type);
    if (engine) activeEngines.set(id, engine);
  }
  // init scope for formant engines
  const scopeCanvas = document.getElementById("scope");
  if (scopeCanvas && typeof initScope === "function") {
    const formantEngines = [...activeEngines.values()].filter(e => e.analyserF1);
    if (formantEngines.length > 0) scopeSetOrbit = initScope(scopeCanvas, formantEngines);
    else scopeSetOrbit = null;
  }

  console.log("Patch loaded:", [...graph.engines.values()].map(e => e.type).join(", "), "pending:", pendingMessages.length);

  // apply initial values from deploy snapshot
  if (patch.initialValues) {
    for (const [key, value] of Object.entries(patch.initialValues)) {
      const [routerId, channel] = key.split(":").map(Number);
      const updates = processRouterValue(graph, routerId, channel, value);
      for (const [id, params] of Object.entries(updates)) {
        const engine = activeEngines.get(Number(id));
        if (engine) sendParams(engine, params);
      }
    }
  }

  // replay messages that arrived during async load
  patchLoading = false;
  for (const msg of pendingMessages) onMessage(msg);
  pendingMessages = [];
}

// --- Messages ---

function onMessage(msg) {
  if (msg.type === "patch" && audioCtx) { loadPatch(msg); return; }
  if (patchLoading) { pendingMessages.push(msg); return; }
  if (msg.type === "rv" && graph) {
    const updates = processRouterValue(graph, msg.r, msg.ch, msg.v);
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
