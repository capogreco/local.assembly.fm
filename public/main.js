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

// Engine factory loaded via engine-factory-global.js script tag before main.js
// Provides: window._engineFactory with ENGINES, BASE_NATIVE_NODES, MATH_OPS, createEngine, getEngineOutput
const { ENGINES, BASE_NATIVE_NODES, MATH_OPS, createEngine: _createEngine, getEngineOutput } = window._engineFactory;

const NATIVE_NODES = new Set([...BASE_NATIVE_NODES, "scope~"]);

// scope~ special handler — creates per-inlet analyser nodes for visualization
async function scopeHandler(ctx, type, args) {
  if (type !== "scope~") return null;
  const makeAnalyser = () => { const a = ctx.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = 0; return a; };
  const analyserX = makeAnalyser(), analyserY = makeAnalyser(), analyserZ = makeAnalyser();
  const analyserH = makeAnalyser(), analyserS = makeAnalyser(), analyserB = makeAnalyser();
  const dummy = ctx.createGain();
  dummy.gain.value = 0;
  analyserX.connect(dummy); analyserY.connect(dummy); analyserZ.connect(dummy);
  analyserH.connect(dummy); analyserS.connect(dummy); analyserB.connect(dummy);
  dummy.connect(ctx.destination);
  return { type, node: dummy, paramMap: {},
           audioInputs: [analyserX, analyserY, analyserZ, analyserH, analyserS, analyserB],
           scopeAnalysers: { analyserX, analyserY, analyserZ, analyserH, analyserS, analyserB } };
}

async function createEngine(type, args) {
  return _createEngine(audioCtx, workletModulesLoaded, NATIVE_NODES, type, args, scopeHandler);
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
  console.log("buildAudioTopology:", audioCables.length, "audio cables");
  for (const cable of audioCables) {
    const srcEng = voice.engines.get(cable.srcBox);
    if (!srcEng) { console.log("  SKIP cable: no src engine for box", cable.srcBox); continue; }
    const srcNode = getEngineOutput(srcEng, cable.srcOutlet);
    console.log("  cable:", srcEng.type, "out"+cable.srcOutlet, "→ box"+cable.dstBox, "in"+cable.dstInlet, "srcNode="+srcNode?.constructor?.name);

    // Case 1: destination is dac
    if (dacBox && cable.dstBox === dacBox.id) {
      srcNode.connect(voice.destination);
      continue;
    }

    // Case 2: destination inlet is an AudioParam (number inlet on audio box)
    // Zero the intrinsic value so the audio signal IS the value, not additive
    const param = getParam(cable.dstBox, cable.dstInlet);
    if (param) {
      param.setValueAtTime(0, audioCtx.currentTime);
      srcNode.connect(param);
      continue;
    }

    // Case 3: destination inlet is audio bus (type "audio")
    const dstEng = voice.engines.get(cable.dstBox);
    const dstNode = getNode(cable.dstBox);
    if (dstNode || dstEng) {
      const patchBox = patch.boxes.find(b => b.id === cable.dstBox);
      const inletDef = patchBox?.paramNames;
      let audioInputIdx = 0;
      if (inletDef) {
        for (let i = 0; i < cable.dstInlet; i++) {
          if (inletDef[i] === null) audioInputIdx++;
        }
      }
      // If destination has individual audio input nodes (scope~), connect directly
      if (dstEng?.audioInputs?.[audioInputIdx]) {
        srcNode.connect(dstEng.audioInputs[audioInputIdx]);
      } else if (dstNode) {
        srcNode.connect(dstNode, 0, audioInputIdx);
      }
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
  // scope~ params go to the scope renderer, not AudioParams
  if (engine.type === "scope~" && typeof setScopeParams === "function") {
    setScopeParams(params);
    // alpha controls scope layer opacity via gel stack
    if (params.a !== undefined) {
      for (const layer of layers.values()) {
        if (layer.type === "scope") { layer.el.style.opacity = params.a; break; }
      }
    }
    return;
  }
  if (params.portamento !== undefined) engine.portaTime = params.portamento;
  const port = engine.worklet?.port;
  const now = audioCtx.currentTime;
  for (const [k, v] of Object.entries(params)) {
    if (k === "portamento") continue;
    // Event trigger — forward via MessagePort
    if (k === "trigger" && port) { port.postMessage({ type: "trigger" }); continue; }
    // Gate — forward via MessagePort (adsr)
    if (k === "gate" && port) { port.postMessage({ type: "gate", value: v }); continue; }
    if (typeof v !== "number") continue;
    // sig~ uses portamento; everything else is instant
    const param = engine.paramMap?.[k] || (engine.worklet?.parameters?.has(k) ? engine.worklet.parameters.get(k) : null);
    if (param) {
      if (engine.portaTime > 0) {
        param.setTargetAtTime(v, now, engine.portaTime);
      } else {
        param.setValueAtTime(v, now);
      }
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
    if (e.outputs) for (const o of e.outputs) o.disconnect();
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

  setupLayers(voice);
  updateDisplayLayers(voice);
  setupScope();
}

// --- Uplink drain ---
function drainUplinks(voice) {
  if (!voice.graph || !voice.graph.uplinkQueue.length) return;
  for (const msg of voice.graph.uplinkQueue) {
    voice.conn.send({ type: "up", ch: msg.ch, v: msg.v });
  }
  voice.graph.uplinkQueue.length = 0;
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
    drainUplinks(voice);
    checkTouchGate(voice);
    updateDisplayLayers(voice);
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
    const updates = processRouterEvent(voice.graph, msg.r, msg.ch);
    for (const [id, params] of Object.entries(updates)) {
      voiceSendParams(voice, Number(id), params);
    }
    drainUplinks(voice);
    checkTouchGate(voice);
    updateDisplayLayers(voice);
    updateParamDisplay();
  }
}

// --- Tear down ---

function tearDown() {
  clearLayers();
  touchBoxId = null;
  if (touchCaptureEl) touchCaptureEl.classList.add("hidden");
  for (const voice of voices) {
    for (const e of voice.engines.values()) {
      e.worklet?.disconnect();
      e.splitter?.disconnect();
      e.out?.disconnect();
      if (e.outputs) for (const o of e.outputs) o.disconnect();
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
  // Find the scope canvas from the gel stack layers
  let scopeCanvas = null;
  for (const layer of layers.values()) {
    if (layer.type === "scope") { scopeCanvas = layer.el; break; }
  }
  if (!scopeCanvas || typeof window.initScope !== "function" || voices.length === 0) return;
  // Collect scope~ instances from all voices
  const scopeInstances = [];
  for (const voice of voices) {
    for (const engine of voice.engines.values()) {
      if (engine.scopeAnalysers) scopeInstances.push(engine.scopeAnalysers);
    }
  }
  // Fall back to formant~ analysers for backward compat
  if (scopeInstances.length === 0) {
    for (const voice of voices) {
      for (const engine of voice.engines.values()) {
        if (engine.analyserF1) {
          scopeInstances.push({
            analyserX: engine.analyserF1, analyserY: engine.analyserF2,
            analyserZ: engine.analyserF3, analyserC: null,
          });
        }
      }
    }
  }
  if (scopeInstances.length > 0) scopeSetOrbit = window.initScope(scopeCanvas, scopeInstances);
  else scopeSetOrbit = null;
}

// --- Gel stack: layer manager for synth-side display boxes ---

const layers = new Map();       // boxId -> { el, type, z }
const layerContainer = document.getElementById("gel-stack");

function clearLayers() {
  for (const layer of layers.values()) layer.el.remove();
  layers.clear();
}

function registerLayer(boxId, type, z, content) {
  if (!layerContainer) return;
  const isCanvas = type === "scope";
  const el = document.createElement(isCanvas ? "canvas" : "div");
  el.className = "gel-layer";
  el.style.zIndex = z;
  if (type === "text") {
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.textAlign = "center";
    el.style.padding = "2rem";
    el.style.fontSize = "1.4rem";
    el.style.letterSpacing = "0.15em";
    el.style.color = "#fff";
    el.textContent = content || "";
  }
  if (isCanvas) {
    el.style.width = "100%";
    el.style.height = "100%";
    el.style.opacity = "1"; // scope visible by default
  } else {
    el.style.opacity = "0"; // screen/text hidden by default (alpha=0)
  }
  layerContainer.appendChild(el);
  layers.set(boxId, { el, type, z });
}

function updateLayer(boxId, node) {
  const layer = layers.get(boxId);
  if (!layer) return;
  const iv = node.inletValues;
  if (layer.type === "screen") {
    const r = Math.round((iv[0] || 0) * 255);
    const g = Math.round((iv[1] || 0) * 255);
    const b = Math.round((iv[2] || 0) * 255);
    const a = iv[3] !== undefined ? iv[3] : 0;
    layer.el.style.background = `rgb(${r},${g},${b})`;
    layer.el.style.opacity = a;
  } else if (layer.type === "text") {
    const size = iv[0] !== undefined ? iv[0] : 0.5;
    const a = iv[1] !== undefined ? iv[1] : 0;
    layer.el.style.fontSize = (0.8 + size * 2.4) + "rem"; // 0.8rem to 3.2rem
    layer.el.style.opacity = a;
  }
}

// --- Touch sensor (pure, no visuals) ---

let touchBoxId = null;
let touchGated = false;
let touchThrottle = 0;
const touchCaptureEl = document.getElementById("touch-capture");

function sendTouchValues(e, gate) {
  const x = e.clientX / window.innerWidth;
  const y = 1 - (e.clientY / window.innerHeight);
  for (const voice of voices) {
    if (!voice.graph || touchBoxId === null) continue;
    const updates = {};
    mergeUpdates(updates, propagateValue(voice.graph, touchBoxId, 0, x));
    mergeUpdates(updates, propagateValue(voice.graph, touchBoxId, 1, y));
    mergeUpdates(updates, propagateValue(voice.graph, touchBoxId, 2, gate));
    for (const [id, params] of Object.entries(updates)) {
      voiceSendParams(voice, Number(id), params);
    }
    drainUplinks(voice);
  }
}

if (touchCaptureEl) {
  let touchDown = false;
  touchCaptureEl.addEventListener("pointerdown", (e) => {
    touchCaptureEl.setPointerCapture(e.pointerId);
    touchDown = true;
    touchThrottle = 0;
    sendTouchValues(e, 1);
  });
  touchCaptureEl.addEventListener("pointermove", (e) => {
    if (!touchDown) return;
    if (touchThrottle++ % 2 !== 0) return; // ~30fps throttle
    sendTouchValues(e, 1);
  });
  touchCaptureEl.addEventListener("pointerup", (e) => {
    touchDown = false;
    sendTouchValues(e, 0);
  });
  touchCaptureEl.addEventListener("pointercancel", (e) => {
    touchDown = false;
    sendTouchValues(e, 0);
  });
}

// --- Setup display layers + touch from patch ---

function setupLayers(voice) {
  clearLayers();
  touchBoxId = null;
  if (!voice.graph) return;

  for (const [id, node] of voice.graph.boxes) {
    if (node.type === "screen") {
      const z = parseInt(node.args) || 1;
      registerLayer(id, "screen", z);
    } else if (node.type === "text") {
      const tokens = (node.args || "").split(/\s+/);
      const firstIsZ = tokens.length > 0 && !isNaN(Number(tokens[0]));
      const z = firstIsZ ? parseInt(tokens[0]) : 2;
      const content = firstIsZ ? tokens.slice(1).join(" ") : node.args;
      registerLayer(id, "text", z, content);
    } else if (node.type === "scope~") {
      const z = parseInt(node.args) || 0;
      registerLayer(id, "scope", z);
    } else if (node.type === "touch") {
      touchBoxId = id;
      // gated if any cable targets inlet 0
      touchGated = false;
      for (const [, other] of voice.graph.boxes) {
        for (const cable of other.outletCables) {
          if (cable.dstBox === id && cable.dstInlet === 0) { touchGated = true; break; }
        }
        if (touchGated) break;
      }
      // show capture surface (always active if ungated, or wait for gate)
      if (touchCaptureEl) {
        if (!touchGated) touchCaptureEl.classList.remove("hidden");
        else touchCaptureEl.classList.add("hidden");
      }
    }
  }
}

function checkTouchGate(voice) {
  if (!touchCaptureEl || !touchGated || touchBoxId === null || !voice.graph) return;
  const node = voice.graph.boxes.get(touchBoxId);
  if (!node) return;
  const gate = node.inletValues[0] || 0;
  if (gate > 0) touchCaptureEl.classList.remove("hidden");
  else touchCaptureEl.classList.add("hidden");
}

function updateDisplayLayers(voice) {
  if (!voice.graph) return;
  for (const [boxId, layer] of layers) {
    const node = voice.graph.boxes.get(boxId);
    if (node) updateLayer(boxId, node);
  }
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
    drainUplinks(voice);
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
