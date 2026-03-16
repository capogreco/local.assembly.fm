/**
 * Synth Client — unified single-instance and ensemble
 *
 * Uses: graph.js, connection.js, scope.js (optional)
 *
 * Phone mode (no #voice-count in DOM): 1 voice, 1 connection.
 * Ensemble mode (#voice-count exists): N voices, N connections.
 * Each voice is an independent virtual phone — own WebSocket,
 * own graph, own engines. Server sees N clients either way.
 */

const overlay = document.getElementById("overlay");
const connStatus = document.getElementById("conn-status");
const clientCount = document.getElementById("client-count");

// ensemble controls (null in phone mode)
const countDisplay = document.getElementById("voice-count");
const btnMinus = document.getElementById("btn-minus");
const btnPlus = document.getElementById("btn-plus");

let audioCtx, masterGain, scopeSetOrbit = null;
const workletModulesLoaded = new Set();
let currentPatch = null;

// --- Voices ---
// Each voice: { conn, graph, engines, panner, patchLoading, pendingMessages }

let voices = [];
let N = countDisplay ? parseInt(countDisplay.textContent) || 6 : 1;

const ENGINES = {
  formant:          { module: "processor.js",       worklet: "voice-processor",  channels: 4 },
  "karplus-strong": { module: "ks-processor.js",    worklet: "ks-processor",     channels: 1 },
  "sine-osc":       { module: "sine-processor.js",  worklet: "sine-processor",   channels: 1 },
  noise:            { module: "noise-processor.js", worklet: "noise-processor",  channels: 1 },
};

async function createEngine(type, destination) {
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
    out.connect(destination);
    const engine = { type, worklet, splitter, out };
    if (type === "formant") {
      for (const [ch, key] of [[1, "analyserF1"], [2, "analyserF2"], [3, "analyserF3"]]) {
        const a = audioCtx.createAnalyser();
        a.fftSize = 512; a.smoothingTimeConstant = 0;
        splitter.connect(a, ch);
        engine[key] = a;
      }
    }
    return engine;
  }
  worklet.connect(destination);
  return { type, worklet };
}

function sendParams(engine, params) {
  if (!engine?.worklet) return;
  if (!engine.currentParams) engine.currentParams = {};
  Object.assign(engine.currentParams, params);
  engine.worklet.port.postMessage({ type: "params", ...params });
}

function updateParamDisplay() {
  const el = document.getElementById("param-display");
  if (!el || voices.length === 0) return;
  const lines = [];
  for (const [, engine] of voices[0].engines) {
    if (engine.currentParams) {
      lines.push(engine.type + ":");
      for (const [k, v] of Object.entries(engine.currentParams))
        lines.push("  " + k + ": " + (typeof v === "number" ? v.toFixed(4) : v));
    }
  }
  el.textContent = lines.join("\n");
}

// --- Voice lifecycle ---

async function loadPatchForVoice(voice, patch) {
  voice.patchLoading = true;
  voice.pendingMessages = [];

  // tear down old engines
  for (const e of voice.engines.values()) {
    e.worklet?.disconnect();
    e.splitter?.disconnect();
    e.out?.disconnect();
  }
  voice.engines.clear();

  voice.graph = buildGraph({ ...patch, instanceIndex: voice.index, instanceCount: N });

  for (const [id, def] of voice.graph.engines) {
    const engine = await createEngine(def.type, voice.destination);
    if (engine) voice.engines.set(id, engine);
  }

  // apply initial values
  if (patch.initialValues) {
    for (const [key, value] of Object.entries(patch.initialValues)) {
      const [routerId, channel] = key.split(":").map(Number);
      const updates = processRouterValue(voice.graph, routerId, channel, value);
      for (const [id, params] of Object.entries(updates)) {
        const engine = voice.engines.get(Number(id));
        if (engine) sendParams(engine, params);
      }
    }
  }

  voice.patchLoading = false;
  for (const msg of voice.pendingMessages) voiceOnMessage(voice, msg);
  voice.pendingMessages = [];

  setupScope();
}

function voiceOnMessage(voice, msg) {
  if (graphDebug && msg.type !== "health") console.log("msg:", msg.type, msg);
  if (msg.type === "patch" && audioCtx) {
    currentPatch = msg;
    loadPatchForVoice(voice, msg);
    return;
  }
  if (voice.patchLoading) { voice.pendingMessages.push(msg); return; }
  if (msg.type === "rv" && voice.graph) {
    const updates = processRouterValue(voice.graph, msg.r, msg.ch, msg.v);
    for (const [id, params] of Object.entries(updates)) {
      const engine = voice.engines.get(Number(id));
      if (engine) sendParams(engine, params);
    }
    updateParamDisplay();
  }
  if (msg.type === "rv-env" && voice.graph) {
    processRouterEnvelope(voice.graph, msg);
    // envelope values are ticked in clientTick via tickEnvelopes
  }
  if ((msg.type === "rv-slew" || msg.type === "rv-lag") && voice.graph) {
    processRouterSlew(voice.graph, msg);
    // slew/lag values are ticked in clientTick via tickEnvelopes
  }
  if (msg.type === "re" && voice.graph) {
    const updates = processRouterEvent(voice.graph, msg.r);
    for (const [id, params] of Object.entries(updates)) {
      const engine = voice.engines.get(Number(id));
      if (engine) sendParams(engine, params);
    }
    updateParamDisplay();
  }
}

// --- Tear down ---

function tearDown() {
  for (const voice of voices) {
    for (const e of voice.engines.values()) {
      e.worklet?.disconnect();
      e.splitter?.disconnect();
      e.out?.disconnect();
    }
    if (voice.panner) voice.panner.disconnect();
    if (voice.conn?.close) voice.conn.close();
  }
  voices = [];
}

// --- Build voices ---

function buildVoices() {
  tearDown();
  masterGain.gain.value = N > 1 ? 1 / Math.sqrt(N) : 1;

  for (let i = 0; i < N; i++) {
    let destination, panner = null;
    if (N > 1) {
      panner = audioCtx.createStereoPanner();
      panner.pan.value = -1 + 2 * i / (N - 1);
      panner.connect(masterGain);
      destination = panner;
    } else {
      destination = masterGain;
    }

    const voice = {
      index: i,
      conn: null,
      graph: null,
      engines: new Map(),
      panner,
      destination,
      patchLoading: false,
      pendingMessages: [],
    };

    // each voice gets its own server connection
    // first voice uses the status bar elements, others pass null
    // ensemble mode uses WS-only (avoids Firefox 6-connection SSE limit)
    const isEnsemble = N > 1;
    const statusEl = i === 0 ? connStatus : null;
    const countEl = i === 0 ? clientCount : null;
    voice.conn = connect(
      (msg) => voiceOnMessage(voice, msg),
      statusEl,
      countEl,
      isEnsemble,
    );

    voices.push(voice);
  }

  // scope: use analysers from first voice (attached after patch loads)
  console.log(`${N} voice${N > 1 ? "s" : ""} connected`);
  if (countDisplay) countDisplay.textContent = N;
}

function setupScope() {
  const scopeCanvas = document.getElementById("scope");
  if (!scopeCanvas || typeof window.initScope !== "function" || voices.length === 0) return;
  // collect formant engines from all voices — scope renders each as a strip
  const allFormant = [];
  for (const voice of voices) {
    for (const engine of voice.engines.values()) {
      if (engine.analyserF1) allFormant.push(engine);
    }
  }
  if (allFormant.length > 0) scopeSetOrbit = window.initScope(scopeCanvas, allFormant);
  else scopeSetOrbit = null;
}

// --- Client-side tick for synth-side time boxes ---

let lastTickTime = 0;

function clientTick(time) {
  requestAnimationFrame(clientTick);
  if (lastTickTime === 0) { lastTickTime = time; return; }
  const dt = Math.min((time - lastTickTime) / 1000, 0.05);
  lastTickTime = time;

  for (const voice of voices) {
    if (!voice.graph || voice.patchLoading) continue;
    const updates = tickGraph(voice.graph, dt);
    const envUpdates = tickEnvelopes(voice.graph, dt);
    mergeUpdates(updates, envUpdates);
    for (const [id, params] of Object.entries(updates)) {
      const engine = voice.engines.get(Number(id));
      if (engine) sendParams(engine, params);
    }
  }
}

requestAnimationFrame(clientTick);

// --- Rebuild (ensemble voice count change) ---

let rebuildTimer = null;

function rebuild() {
  // debounce: wait 200ms after last click before rebuilding
  if (rebuildTimer) clearTimeout(rebuildTimer);
  if (countDisplay) countDisplay.textContent = N;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    buildVoices();
  }, 200);
}

// --- Init ---

async function handleStart() {
  overlay.classList.add("hidden");
  try {
    audioCtx = new AudioContext();
    await audioCtx.resume();
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
    try { const wl = await navigator.wakeLock?.request("screen"); wl?.addEventListener("release", () => {}); } catch {}
  } catch (err) {
    overlay.querySelector("span").textContent = "audio failed";
    overlay.classList.remove("hidden");
    return;
  }
  buildVoices();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx) {
    audioCtx.resume();
    try { navigator.wakeLock?.request("screen"); } catch {}
  }
});

// ensemble controls
if (btnMinus) btnMinus.addEventListener("click", () => { if (N > 1 && audioCtx) { N--; rebuild(); } });
if (btnPlus) btnPlus.addEventListener("click", () => { if (N < 32 && audioCtx) { N++; rebuild(); } });

overlay.addEventListener("touchend", (e) => { e.preventDefault(); handleStart(); }, { once: true });
overlay.addEventListener("click", () => handleStart(), { once: true });
