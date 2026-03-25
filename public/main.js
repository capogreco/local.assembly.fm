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
  "formant~":          { module: "processor.js",       worklet: "voice-processor",  channels: 4 },
  "karplus-strong~":   { module: "ks-processor.js",    worklet: "ks-processor",     channels: 1 },
  "sine-osc~":         { module: "sine-processor.js",  worklet: "sine-processor",   channels: 1 },
  "noise-engine~":     { module: "noise-processor.js", worklet: "noise-processor",  channels: 1 },
  "swarm~":            { module: "swarm-processor.js", worklet: "swarm-processor",  channels: 1 },
  "reverb~":           { module: "reverb-processor.js", worklet: "reverb-processor", channels: 1 },
};

async function createEngine(type, args) {
  // Native Web Audio nodes (oscillatorNode, gainNode, etc. + sig~, osc~, noise~)
  if (NATIVE_NODES.has(type)) return await createNativeNode(type, args);
  // Signal worklets (lfo~, phasor~, ar~, slew~)
  if (SIGNAL_WORKLETS[type]) return await createSignalWorklet(type, args);
  // Audio-rate math (+~, *~, -~, /~, scale~, clip~, mtof~)
  if (MATH_OPS.has(type)) return await createMathNode(type, args);

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
    // DO NOT connect to destination — audio topology wires this
    const engine = { type, worklet, splitter, out };
    if (type === "formant~") {
      for (const [ch, key] of [[1, "analyserF1"], [2, "analyserF2"], [3, "analyserF3"]]) {
        const a = audioCtx.createAnalyser();
        a.fftSize = 512; a.smoothingTimeConstant = 0;
        splitter.connect(a, ch);
        engine[key] = a;
      }
    }
    return engine;
  }
  // DO NOT connect to destination — audio topology wires this
  worklet.port.onmessage = (e) => {
    if (e.data?.type === "debug") console.log(`[${type}] debug:`, e.data);
  };
  return { type, worklet };
}

function getEngineOutput(engine) {
  return engine.out || engine.node || engine.worklet;
}

const NATIVE_NODES = new Set([
  "oscillatorNode~", "gainNode~", "biquadFilterNode~",
  "sig~", "osc~", "noise~",
  "send~", "s~", "receive~", "r~", "throw~", "catch~",
]);

const SIGNAL_WORKLETS = {
  "lfo~":    { module: "lfo-processor.js",    worklet: "lfo-processor" },
  "phasor~": { module: "phasor-processor.js", worklet: "phasor-processor" },
  "ar~":     { module: "ar-processor.js",     worklet: "ar-processor" },
  "slew~":   { module: "slew-processor.js",   worklet: "slew-processor" },
  "noise~-worklet": { module: "noise-signal-processor.js", worklet: "noise-signal-processor" },
};

const MATH_OPS = new Set(["+~", "-~", "*~", "/~", "scale~", "clip~", "mtof~"]);

async function createNativeNode(type, args) {
  let node, paramMap = {};
  const tokens = (args || "").split(/\s+/).filter(Boolean);

  if (type === "oscillatorNode~") {
    node = audioCtx.createOscillator();
    node.type = tokens[0] || "sine";
    node.start();
    paramMap = { frequency: node.frequency, detune: node.detune };
  } else if (type === "gainNode~") {
    node = audioCtx.createGain();
    node.gain.value = parseFloat(tokens[0]) || 1;
    paramMap = { gain: node.gain };
  } else if (type === "biquadFilterNode~") {
    node = audioCtx.createBiquadFilter();
    node.type = tokens[0] || "lowpass";
    paramMap = { frequency: node.frequency, Q: node.Q, gain: node.gain, detune: node.detune };
  } else if (type === "sig~") {
    node = audioCtx.createConstantSource();
    node.offset.value = 0;
    node.start();
    const portaTime = parseFloat(tokens[0]) || 0;
    paramMap = { value: node.offset };
    return { type, node, paramMap, portaTime };
  } else if (type === "osc~") {
    node = audioCtx.createOscillator();
    node.frequency.value = parseFloat(tokens[0]) || 1;
    node.type = tokens[1] || "sine";
    node.start();
    paramMap = { frequency: node.frequency, detune: node.detune };
  } else if (type === "send~" || type === "s~" || type === "receive~" || type === "r~"
          || type === "throw~" || type === "catch~") {
    // Wireless audio: pass-through GainNode (unity gain)
    node = audioCtx.createGain();
    return { type, node, paramMap: {} };
  } else if (type === "noise~") {
    const def = SIGNAL_WORKLETS["noise~-worklet"];
    if (!workletModulesLoaded.has(def.module)) {
      await audioCtx.audioWorklet.addModule(def.module);
      workletModulesLoaded.add(def.module);
    }
    node = new AudioWorkletNode(audioCtx, def.worklet);
    return { type, node, worklet: node, paramMap: {} };
  } else {
    return null;
  }

  return { type, node, paramMap };
}

async function createSignalWorklet(type, args) {
  const def = SIGNAL_WORKLETS[type];
  if (!def) return null;
  if (!workletModulesLoaded.has(def.module)) {
    await audioCtx.audioWorklet.addModule(def.module);
    workletModulesLoaded.add(def.module);
  }
  const tokens = (args || "").split(/\s+/).filter(Boolean);
  const node = new AudioWorkletNode(audioCtx, def.worklet);

  const paramMap = {};
  for (const [name, param] of node.parameters) paramMap[name] = param;

  // Set initial values from args
  if (type === "lfo~") {
    if (tokens[0]) node.parameters.get("period")?.setValueAtTime(parseFloat(tokens[0]), 0);
  } else if (type === "phasor~") {
    if (tokens[0]) node.parameters.get("period")?.setValueAtTime(parseFloat(tokens[0]), 0);
  } else if (type === "ar~") {
    if (tokens[0]) node.parameters.get("attack")?.setValueAtTime(parseFloat(tokens[0]), 0);
    if (tokens[1]) node.parameters.get("release")?.setValueAtTime(parseFloat(tokens[1]), 0);
  } else if (type === "slew~") {
    if (tokens[0]) node.parameters.get("rate")?.setValueAtTime(parseFloat(tokens[0]), 0);
  }

  return { type, node, worklet: node, paramMap };
}

async function createMathNode(type, args) {
  const op = type.replace("~", "");
  if (!workletModulesLoaded.has("math-processor.js")) {
    await audioCtx.audioWorklet.addModule("math-processor.js");
    workletModulesLoaded.add("math-processor.js");
  }
  const tokens = (args || "").split(/\s+/).filter(Boolean);
  const arg = parseFloat(tokens[0]) || (op === "*" ? 1 : 0);
  const node = new AudioWorkletNode(audioCtx, "math-processor", {
    numberOfInputs: 2,
    processorOptions: { op, arg },
  });
  return { type, node, worklet: node, paramMap: {} };
}

function buildAudioTopology(voice, patch) {
  const audioCables = patch.audioCables || [];
  if (audioCables.length === 0) return;

  const dacBox = patch.boxes.find(b => b.dac);

  // Get AudioNode for any box
  function getNode(boxId) {
    const eng = voice.engines.get(boxId);
    if (!eng) return null;
    return eng.node || eng.worklet || null;
  }

  // Get AudioParam for a destination inlet (number inlet on an audio box)
  function getParam(boxId, inletIndex) {
    const patchBox = patch.boxes.find(b => b.id === boxId);
    if (!patchBox?.paramNames) return null;
    const paramName = patchBox.paramNames[inletIndex];
    if (!paramName) return null; // null = audio inlet, not a param
    const eng = voice.engines.get(boxId);
    if (!eng) return null;
    return eng.paramMap?.[paramName] || eng.worklet?.parameters?.get(paramName) || null;
  }

  // Process each audio cable
  for (const cable of audioCables) {
    const srcEng = voice.engines.get(cable.srcBox);
    if (!srcEng) continue;
    const srcNode = getEngineOutput(srcEng);

    // Case 1: destination is dac
    if (dacBox && cable.dstBox === dacBox.id) {
      srcNode.connect(voice.destination);
      continue;
    }

    // Case 2: destination inlet is an AudioParam (number inlet on audio box)
    const param = getParam(cable.dstBox, cable.dstInlet);
    if (param) {
      srcNode.connect(param);
      continue;
    }

    // Case 3: destination inlet is audio bus (type "audio")
    const dstNode = getNode(cable.dstBox);
    if (dstNode) {
      // For multi-input nodes (math), dstInlet maps to Web Audio input index
      const patchBox = patch.boxes.find(b => b.id === cable.dstBox);
      const inletDef = patchBox?.paramNames;
      // Count audio inlets before this one to get the Web Audio input index
      let audioInputIdx = 0;
      if (inletDef) {
        for (let i = 0; i < cable.dstInlet; i++) {
          if (inletDef[i] === null) audioInputIdx++;
        }
      }
      srcNode.connect(dstNode, 0, audioInputIdx);
    }
  }

  // Wireless audio connections: send~/s~ → receive~/r~, throw~/catch~
  const wirelessSends = new Map(); // name -> [srcNode]
  const wirelessRecvs = new Map(); // name -> [boxId]
  const wirelessThrows = new Map();
  const wirelessCatches = new Map();
  const sendTypes = new Set(["send~", "s~"]);
  const recvTypes = new Set(["receive~", "r~"]);

  for (const box of patch.boxes) {
    const name = box.args?.trim();
    if (!name) continue;
    if (sendTypes.has(box.type)) {
      if (!wirelessSends.has(name)) wirelessSends.set(name, []);
      const node = getNode(box.id);
      if (node) wirelessSends.get(name).push(node);
    } else if (recvTypes.has(box.type)) {
      if (!wirelessRecvs.has(name)) wirelessRecvs.set(name, []);
      wirelessRecvs.get(name).push(box.id);
    } else if (box.type === "throw~") {
      if (!wirelessThrows.has(name)) wirelessThrows.set(name, []);
      const node = getNode(box.id);
      if (node) wirelessThrows.get(name).push(node);
    } else if (box.type === "catch~") {
      if (!wirelessCatches.has(name)) wirelessCatches.set(name, []);
      wirelessCatches.get(name).push(box.id);
    }
  }

  // send~ → receive~ (one-to-many: each send connects to all matching receives)
  for (const [name, srcNodes] of wirelessSends) {
    const recvIds = wirelessRecvs.get(name);
    if (!recvIds) continue;
    for (const srcNode of srcNodes) {
      for (const recvId of recvIds) {
        const recvNode = getNode(recvId);
        if (recvNode) srcNode.connect(recvNode);
      }
    }
  }

  // throw~ → catch~ (many-to-one: all throws connect to matching catch, Web Audio sums)
  for (const [name, srcNodes] of wirelessThrows) {
    const catchIds = wirelessCatches.get(name);
    if (!catchIds) continue;
    for (const srcNode of srcNodes) {
      for (const catchId of catchIds) {
        const catchNode = getNode(catchId);
        if (catchNode) srcNode.connect(catchNode);
      }
    }
  }
}

function sendParams(engine, params) {
  if (!engine) return;
  if (!engine.currentParams) engine.currentParams = {};
  Object.assign(engine.currentParams, params);
  // Update portamento time if provided (sig~ inlet 1)
  if (params.portamento !== undefined) engine.portaTime = params.portamento;
  const timeConst = engine.portaTime > 0 ? engine.portaTime : 0.005;
  for (const [k, v] of Object.entries(params)) {
    if (k === "portamento") continue; // not an AudioParam
    if (typeof v !== "number") continue;
    // Native node: use paramMap
    if (engine.paramMap?.[k]) {
      engine.paramMap[k].setTargetAtTime(v, audioCtx.currentTime, timeConst);
    }
    // Worklet: use parameters AudioParamMap
    else if (engine.worklet?.parameters?.has(k)) {
      engine.worklet.parameters.get(k).setTargetAtTime(v, audioCtx.currentTime, 0.005);
    }
  }
}

function voiceSendParams(voice, engineId, params) {
  const engine = voice.engines.get(engineId);
  if (!engine) return;
  sendParams(engine, params);
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
  for (const e of voice.engines.values()) {
    if (e.node) {
      try { e.node.stop?.(); } catch {}
      e.node.disconnect();
    }
    e.worklet?.disconnect();
    e.splitter?.disconnect();
    e.out?.disconnect();
  }
  voice.engines.clear();

  voice.graph = buildGraph({ ...patch, instanceIndex: voice.index, instanceCount: N });

  // Create all engines and effects (unconnected)
  for (const [id, def] of voice.graph.engines) {
    const engine = await createEngine(def.type, def.args);
    if (engine) voice.engines.set(id, engine);
  }

  // Wire audio topology from patch audioCables (engines → effects → dac → destination)
  buildAudioTopology(voice, patch);

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
