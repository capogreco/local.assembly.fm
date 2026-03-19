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
let N = countDisplay
  ? parseInt(new URLSearchParams(location.search).get("n")) || parseInt(countDisplay.textContent) || 6
  : 1;

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

function sendParams(engine, params, audioParamSet) {
  if (!engine?.worklet) return;
  if (!engine.currentParams) engine.currentParams = {};
  // Filter out audio-connected params — those are driven by AudioParam connections
  let filtered = params;
  if (audioParamSet) {
    filtered = {};
    for (const [k, v] of Object.entries(params)) {
      if (!audioParamSet.has(k)) filtered[k] = v;
    }
    if (Object.keys(filtered).length === 0) return;
  }
  Object.assign(engine.currentParams, filtered);
  engine.worklet.port.postMessage({ type: "params", ...filtered });
}

function voiceSendParams(voice, engineId, params) {
  const engine = voice.engines.get(engineId);
  if (!engine) return;
  const aps = voice.audioSubgraph?.audioParamSet?.get(engineId);
  sendParams(engine, params, aps);
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

  // tear down old engines and audio subgraph
  if (voice.audioSubgraph) { voice.audioSubgraph.teardown(); voice.audioSubgraph = null; }
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

  // apply const box values to engines
  for (const [engineId, engineDef] of voice.graph.engines) {
    const engineNode = voice.graph.boxes.get(engineId);
    if (!engineNode) continue;

    const engine = voice.engines.get(engineId);
    if (!engine) continue;

    const params = {};
    for (let i = 0; i < engineNode.inletValues.length; i++) {
      const value = engineNode.inletValues[i];
      if (value !== undefined) {
        const paramName = engineDef.paramNames[i];
        if (paramName) params[paramName] = value;
      }
    }

    if (Object.keys(params).length > 0) {
      sendParams(engine, params);
    }
  }

  // build audio-rate subgraph for continuous modulation
  voice.audioSubgraph = buildAudioSubgraph(audioCtx, voice.graph, voice.engines,
    (boxId, outlet, value) => {
      // Event callback: audio worklet fired an event (end, wrap) — propagate through JS graph
      const updates = propagateInGraph(voice.graph, boxId, outlet, value);
      for (const [id, params] of Object.entries(updates)) {
        voiceSendParams(voice, Number(id), params);
      }
    },
  );

  // Mark audio-hoisted boxes so tickGraph and handleEvent skip them
  if (voice.audioSubgraph) {
    voice.graph.audioBoxes = voice.audioSubgraph.audioBoxes;
    voice.graph._audioSubgraphForwardEvent = voice.audioSubgraph.forwardEvent;
    voice.graph._audioSubgraphForwardDiscrete = voice.audioSubgraph.forwardDiscreteValue;
  }

  // apply initial values
  if (patch.initialValues) {
    for (const [key, value] of Object.entries(patch.initialValues)) {
      const [routerId, channel] = key.split(":").map(Number);
      const updates = processRouterValue(voice.graph, routerId, channel, value);
      for (const [id, params] of Object.entries(updates)) {
        voiceSendParams(voice, Number(id), params);
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
    // Forward discrete values to audio subgraph boxes if applicable
    if (voice.audioSubgraph) {
      const entries = voice.graph.entries.get(msg.r + ":" + (msg.ch || 0));
      if (entries) {
        for (const entry of entries) {
          voice.audioSubgraph.forwardDiscreteValue(entry.targetBox, entry.targetInlet, msg.v);
        }
      }
    }
    const updates = processRouterValue(voice.graph, msg.r, msg.ch, msg.v);
    for (const [id, params] of Object.entries(updates)) {
      voiceSendParams(voice, Number(id), params);
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
    // Forward event triggers to audio subgraph boxes if applicable
    if (voice.audioSubgraph) {
      const entries = voice.graph.entries.get(msg.r + ":0");
      if (entries) {
        for (const entry of entries) {
          voice.audioSubgraph.forwardEvent(entry.targetBox);
        }
      }
    }
    const updates = processRouterEvent(voice.graph, msg.r);
    for (const [id, params] of Object.entries(updates)) {
      voiceSendParams(voice, Number(id), params);
    }
    updateParamDisplay();
  }
}

// --- Tear down ---

function tearDown() {
  for (const voice of voices) {
    if (voice.audioSubgraph) { voice.audioSubgraph.teardown(); voice.audioSubgraph = null; }
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
      isEnsemble ? i * 50 : 0,
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
    // tickGraph now skips audio-hoisted boxes (checked via graph.audioBoxes)
    const updates = tickGraph(voice.graph, dt);
    const envUpdates = tickEnvelopes(voice.graph, dt);
    mergeUpdates(updates, envUpdates);
    for (const [id, params] of Object.entries(updates)) {
      voiceSendParams(voice, Number(id), params);
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
    await loadModWorklets(audioCtx);
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
