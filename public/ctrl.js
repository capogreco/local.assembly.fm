/**
 * Ctrl — Graphical Patching Interface + one-side engine host
 * Canvas-based PD-style patch editor.
 * All edits are local. Cmd+Enter applies the full state to the server.
 * Cmd+Z undoes. Server sends value updates for display.
 * Also hosts one-side engines (above the border) with audio output to laptop speakers.
 */

import { boxTypeName, boxBinding, getBoxPorts } from "./gpi-types.js";
import { PatchEditor, COLORS, BOX_HEIGHT, BOX_PAD_X, PORT_W, SMALL_FONT, abstractionTypes, loadAbstractions, isAbstraction, getPorts, getDef } from "./patch-editor.js";
import { ENGINES, BASE_NATIVE_NODES, createEngine as _createEngine, getEngineOutput } from "./engine-factory.js";

// DOM elements
const canvas = document.getElementById("c");
const input = document.getElementById("box-input");
const tooltipEl = document.getElementById("tooltip");

// --- global state ---

let ws = null, wsConnected = false;
let connectedClients = 0;
let midiDeviceNames = [];
let currentPatchName = null;

// --- one-side audio engine ---

let ctrlAudioCtx = null;
let ctrlChannelMerger = null;
let ctrlGuardLoaded = false;
let ctrlOutputStage = []; // guard + clamp nodes between the merger and the destination
let ctrlNanNotified = false;
let ctrlInputSource = null;   // MediaStreamSourceNode (shared)
let ctrlInputSplitter = null; // ChannelSplitterNode for adc~
const ctrlEngines = new Map();
const ctrlWorkletModulesLoaded = new Set();
// The laptop deploy (server.ts, deploy.ts): one-side audio boxes by id. Its
// control arrives as rv/re with r = box id, ch = inlet; while a deploy builds,
// they wait in laptopPending. Builds run one after another (laptopBuild).
const laptopBoxes = new Map();
let laptopBuild = Promise.resolve();
let laptopBuilding = 0;
let laptopPending = [];

const CTRL_NATIVE_NODES = new Set([...BASE_NATIVE_NODES, "adc~", "fftPeaks~"]);

// The context is never resumed in the build path: a page (re)loaded without a
// gesture would wait there for ever. It builds suspended and resumes on the
// first click or key (resumeLaptopAudio).
function initCtrlAudio() {
  if (ctrlAudioCtx) return;
  ctrlAudioCtx = new AudioContext({ sampleRate: 48000 });
  // Set multi-channel discrete output immediately
  ctrlAudioCtx.destination.channelCount = ctrlAudioCtx.destination.maxChannelCount;
  ctrlAudioCtx.destination.channelInterpretation = "discrete";
}

// Caller-specific ctrl node handler — adc~ (audio input) and fftPeaks~ (spectral analyser).
async function adcHandler(ctx, type, args) {
  const tokens = (args || "").split(/\s+/).filter(Boolean);

  // fftPeaks~ — an AnalyserNode the adc~ signal feeds into, scanned on trigger by
  // scanPeaks(). It's a dead-end node (no audio output), so sink it at zero gain to
  // keep it pulled by the audio graph.
  if (type === "fftPeaks~") {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    analyser.connect(sink);
    sink.connect(ctx.destination);
    return { type, node: analyser, analyser, out: sink,
             maxPeaks: parseInt(tokens[0]) || 33,
             minHz: parseFloat(tokens[1]) || 0,
             freqData: new Float32Array(analyser.frequencyBinCount), paramMap: {} };
  }

  if (type !== "adc~") return null;
  if (!ctrlInputSource) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 8 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      ctrlInputSource = ctx.createMediaStreamSource(stream);
      const channelCount = ctrlInputSource.channelCount || 2;
      ctrlInputSplitter = ctx.createChannelSplitter(channelCount);
      ctrlInputSource.connect(ctrlInputSplitter);
    } catch (err) {
      console.error("adc~ failed to get audio input:", err);
      return null;
    }
  }
  const ch = (parseInt(tokens[0]) || 1) - 1;
  const node = ctx.createGain();
  try { ctrlInputSplitter.connect(node, ch); } catch { ctrlInputSplitter.connect(node, 0); }
  return { type, node, paramMap: {} };
}

async function createCtrlEngine(type, args) {
  return _createEngine(ctrlAudioCtx, ctrlWorkletModulesLoaded, CTRL_NATIVE_NODES, type, args, adcHandler);
}

function resumeLaptopAudio() {
  if (ctrlAudioCtx && ctrlAudioCtx.state === "suspended") ctrlAudioCtx.resume();
}
window.addEventListener("pointerdown", resumeLaptopAudio, true);
window.addEventListener("keydown", resumeLaptopAudio, true);

async function buildLaptopAudio(patch) {
  // Tear down existing
  for (const eng of ctrlEngines.values()) {
    if (eng.node) { try { eng.node.stop?.(); } catch {} eng.node.disconnect(); }
    eng.worklet?.disconnect(); eng.splitter?.disconnect(); eng.out?.disconnect();
    if (eng.outputs) for (const o of eng.outputs) o.disconnect();
  }
  ctrlEngines.clear();
  if (ctrlChannelMerger) { ctrlChannelMerger.disconnect(); ctrlChannelMerger = null; }
  for (const n of ctrlOutputStage) n.disconnect();
  ctrlOutputStage = [];
  if (ctrlInputSplitter) { ctrlInputSplitter.disconnect(); ctrlInputSplitter = null; }
  if (ctrlInputSource) { ctrlInputSource.disconnect(); ctrlInputSource = null; }

  // The deploy is post-expansion: one-side audio inside an abstraction is in it.
  laptopBoxes.clear();
  for (const b of patch.boxes) laptopBoxes.set(b.id, b);
  // No laptop audio: no AudioContext, no microphone.
  if (laptopBoxes.size === 0) return;

  initCtrlAudio();

  // Determine max channel for multi-channel output
  let maxChannel = 2;
  for (const [, b] of laptopBoxes) {
    if (b.dac) {
      const chs = b.args.split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0);
      for (const ch of chs) maxChannel = Math.max(maxChannel, ch);
    }
  }
  ctrlAudioCtx.destination.channelCount = maxChannel;
  ctrlAudioCtx.destination.channelInterpretation = "discrete";
  ctrlChannelMerger = ctrlAudioCtx.createChannelMerger(maxChannel);
  ctrlChannelMerger.channelCountMode = "explicit";
  ctrlChannelMerger.channelInterpretation = "discrete";
  // Output clamp (see main.js). Deliberately no DC blocker: ctrl outputs can
  // carry DC-coupled control voltage.
  // The guard in front of it replaces NaN with silence and reports it.
  if (!ctrlGuardLoaded) {
    await ctrlAudioCtx.audioWorklet.addModule("output-guard-processor.js");
    ctrlGuardLoaded = true;
  }
  const ctrlOutputGuard = new AudioWorkletNode(ctrlAudioCtx, "output-guard", {
    channelCount: maxChannel, channelCountMode: "explicit", channelInterpretation: "discrete",
    outputChannelCount: [maxChannel],
  });
  ctrlNanNotified = false;
  ctrlOutputGuard.port.onmessage = (e) => {
    if (e.data.type !== "nan") return;
    console.error(`NaN at ctrl output: ${e.data.count} samples silenced`);
    if (!ctrlNanNotified) {
      ctrlNanNotified = true;
      notify([`⚠ NaN at ctrl output (silenced). Some engine above the border is producing NaN.`]);
    }
  };
  const ctrlOutputClamp = ctrlAudioCtx.createWaveShaper();
  ctrlOutputClamp.curve = new Float32Array([-1, 1]);
  ctrlOutputClamp.channelCountMode = "max";
  ctrlOutputClamp.channelInterpretation = "discrete";
  ctrlChannelMerger.connect(ctrlOutputGuard);
  ctrlOutputGuard.connect(ctrlOutputClamp);
  ctrlOutputClamp.connect(ctrlAudioCtx.destination);
  ctrlOutputStage = [ctrlOutputGuard, ctrlOutputClamp];

  // Create engines
  for (const [id, b] of laptopBoxes) {
    if (b.dac) continue;
    const engine = await createCtrlEngine(b.type, b.args);
    if (engine) ctrlEngines.set(id, engine);
    else {
      const text = `${b.type} ${b.args}`.trim();
      console.error(`ctrl cannot build "${text}" (box ${id})`);
      notify([`✗ ctrl cannot build "${text}"`]);
    }
  }

  // Wire audio cables (the deploy's audioCables: source outlet type audio)
  for (const cable of patch.audioCables) {
    const srcEng = ctrlEngines.get(cable.srcBox);
    if (!srcEng) continue;
    const srcNode = getEngineOutput(srcEng, cable.srcOutlet);

    // dac~
    const dstBox = laptopBoxes.get(cable.dstBox);
    if (dstBox?.dac) {
      const chs = dstBox.args.split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0);
      if (chs.length === 0) chs.push(1, 2); // default stereo
      for (const ch of chs) srcNode.connect(ctrlChannelMerger, 0, ch - 1);
      continue;
    }

    // AudioParam modulation (audio → number inlet): paramNames is null for audio inlets
    const paramName = dstBox?.paramNames[cable.dstInlet];
    if (paramName) {
      const dstEng = ctrlEngines.get(cable.dstBox);
      if (dstEng) {
        const param = dstEng.paramMap?.[paramName] || dstEng.worklet?.parameters?.get(paramName);
        if (param) { param.setValueAtTime(0, ctrlAudioCtx.currentTime); srcNode.connect(param); }
      }
      continue;
    }

    // Audio bus connection
    const dstEng = ctrlEngines.get(cable.dstBox);
    if (dstEng && dstBox) {
      const dstNode = dstEng.node || dstEng.worklet;
      if (dstNode) {
        // Map inlet index to Web Audio input index (as main.js)
        let audioInputIdx = 0;
        for (let i = 0; i < cable.dstInlet; i++) {
          if (dstBox.paramNames[i] === null) audioInputIdx++;
        }
        srcNode.connect(dstNode, 0, audioInputIdx);
      }
    }
  }

  // Wireless audio (same as main.js)
  const wirelessSends = new Map(), wirelessRecvs = new Map();
  const wirelessThrows = new Map(), wirelessCatches = new Map();
  const sendTypes = new Set(["send~", "s~"]), recvTypes = new Set(["receive~", "r~"]);
  for (const [id, b] of laptopBoxes) {
    const type = b.type;
    const name = b.args.trim();
    if (!name) continue;
    const eng = ctrlEngines.get(id);
    if (!eng) continue;
    const node = eng.node || eng.worklet;
    if (sendTypes.has(type)) { if (!wirelessSends.has(name)) wirelessSends.set(name, []); wirelessSends.get(name).push(node); }
    else if (recvTypes.has(type)) { if (!wirelessRecvs.has(name)) wirelessRecvs.set(name, []); wirelessRecvs.get(name).push(id); }
    else if (type === "throw~") { if (!wirelessThrows.has(name)) wirelessThrows.set(name, []); wirelessThrows.get(name).push(node); }
    else if (type === "catch~") { if (!wirelessCatches.has(name)) wirelessCatches.set(name, []); wirelessCatches.get(name).push(id); }
  }
  for (const [name, srcNodes] of wirelessSends) {
    const recvIds = wirelessRecvs.get(name); if (!recvIds) continue;
    for (const sn of srcNodes) for (const rid of recvIds) { const re = ctrlEngines.get(rid); if (re) sn.connect(re.node || re.worklet); }
  }
  for (const [name, srcNodes] of wirelessThrows) {
    const catchIds = wirelessCatches.get(name); if (!catchIds) continue;
    for (const sn of srcNodes) for (const cid of catchIds) { const ce = ctrlEngines.get(cid); if (ce) sn.connect(ce.node || ce.worklet); }
  }
}

// Build a laptop deploy; rv/re that arrive meanwhile wait, then run in order.
function loadLaptopPatch(patch) {
  laptopBuilding++;
  laptopBuild = laptopBuild.then(async () => {
    try {
      await buildLaptopAudio(patch);
    } catch (err) {
      console.error("laptop audio build failed:", err);
      notify([`✗ laptop audio build failed: ${err instanceof Error ? err.message : err}`]);
    } finally {
      laptopBuilding--;
    }
    if (laptopBuilding > 0) return; // a newer deploy is queued; it drains
    const pending = laptopPending;
    laptopPending = [];
    for (const msg of pending) laptopMessage(msg);
    if (ctrlAudioCtx?.state === "suspended" && laptopBoxes.size > 0) notify(["laptop audio waits for a click or key"]);
  });
}

function laptopMessage(msg) {
  if (laptopBuilding > 0) { laptopPending.push(msg); return; }
  if (msg.type === "rv") laptopValue(msg.r, msg.ch, msg.v);
  else laptopEvent(msg.r, msg.ch);
}

// A box the deploy doesn't have: the server and this page disagree.
function laptopBox(boxId, kind) {
  const b = laptopBoxes.get(boxId);
  if (!b) console.error(`laptop ${kind} for box ${boxId}, which is not in the laptop deploy`);
  return b;
}

function laptopValue(boxId, inlet, value) {
  const b = laptopBox(boxId, "rv");
  if (!b) return;
  const engine = ctrlEngines.get(boxId);
  if (!engine) return; // not built (already reported)
  const paramName = b.paramNames[inlet];
  if (!paramName) return;

  // fftPeaks~ has no AudioParams — its `max` and `minHz` inlets update the engine directly.
  if (engine.type === "fftPeaks~" && paramName === "max") {
    engine.maxPeaks = Math.max(0, Math.round(value));
    return;
  }
  if (engine.type === "fftPeaks~" && paramName === "minHz") {
    engine.minHz = Math.max(0, value);
    return;
  }

  if (b.messagePorts.includes(paramName)) {
    (engine.worklet?.port || engine.node?.port)?.postMessage({ type: paramName, value });
  } else if (paramName === "portamento" && engine.portaTime !== undefined) {
    engine.portaTime = value;
  } else if (typeof value === "number") {
    const param = engine.paramMap?.[paramName] || engine.worklet?.parameters?.get(paramName);
    if (param) {
      const now = ctrlAudioCtx.currentTime;
      if (engine.portaTime > 0) param.setTargetAtTime(value, now, engine.portaTime);
      else param.setValueAtTime(value, now);
    }
  }
}

function laptopEvent(boxId, inlet) {
  const b = laptopBox(boxId, "re");
  if (!b) return;
  const engine = ctrlEngines.get(boxId);
  if (!engine) return;
  if (engine.type === "fftPeaks~") { scanPeaks(engine, boxId); return; }
  // The phone shape (main.js sendParams): the inlet's port name, value 1.
  (engine.worklet?.port || engine.node?.port)?.postMessage({ type: b.paramNames[inlet] ?? "trigger", value: 1 });
}

// fftPeaks~ scan: read the analyser's magnitude spectrum, pick the loudest local-maxima
// peaks, and send them up to the server as two parallel arrays (loudest first). The
// server propagates them on the box's two outlets (freqs, amps).
function scanPeaks(engine, boxId) {
  const a = engine.analyser;
  const data = engine.freqData; // dB magnitudes per bin
  a.getFloatFrequencyData(data);
  const binHz = ctrlAudioCtx.sampleRate / a.fftSize;
  const FLOOR_DB = -90;
  // Ignore bins below minHz (filters DC offset, mains hum, room rumble). Skip bin 0
  // regardless, since a peak needs a lower neighbour to compare against.
  const startBin = Math.max(1, engine.minHz > 0 ? Math.ceil(engine.minHz / binHz) : 1);
  const peaks = [];
  for (let i = startBin; i < data.length - 1; i++) {
    const m = data[i];
    if (m > FLOOR_DB && m > data[i - 1] && m >= data[i + 1]) peaks.push({ f: i * binHz, db: m });
  }
  peaks.sort((x, y) => y.db - x.db); // loudest first
  const top = peaks.slice(0, engine.maxPeaks);
  send({
    type: "peaks",
    box: boxId,
    freqs: top.map(p => p.f),
    amps: top.map(p => Math.pow(10, p.db / 20)), // dB → linear
  });
}

// =============================================================================
// Main Editor Setup (PatchEditor imported from patch-editor.js)
// =============================================================================

// =============================================================================
// Main Editor
// =============================================================================

const mainEditor = new PatchEditor(canvas, {
  borderY: window.innerHeight * 0.55,
  showBorder: true,
  input: input,
  tooltipEl: tooltipEl,
  onSend: (msg) => send(msg),
  onError: (lines) => notify(lines),
  onOpenAbstraction: (text) => openAbstractionForEdit(text),
  onDirty: () => {},
  renderOverlay: (ctx, w, h) => {
    // Status label
    ctx.font = SMALL_FONT;
    ctx.textBaseline = "top";
    if (mainEditor.dirty) { ctx.fillStyle = "#865"; ctx.fillText("modified", 12, 8); }
    else if (mainEditor.applied) { ctx.fillStyle = "#686"; ctx.fillText("applied", 12, 8); }
    else { ctx.fillStyle = "#555"; ctx.fillText("edit", 12, 8); }

    // Patch name
    if (currentPatchName) {
      ctx.fillStyle = "#555";
      ctx.textAlign = "center";
      ctx.fillText(currentPatchName, w / 2, 8);
    }

    // Connection dot
    ctx.beginPath();
    ctx.arc(w - 16, 16, 4, 0, Math.PI * 2);
    ctx.fillStyle = wsConnected ? "#686" : "#865";
    ctx.fill();

    // MIDI/Grid devices (under connection dot)
    ctx.fillStyle = "#444";
    ctx.textAlign = "right";
    for (let i = 0; i < midiDeviceNames.length; i++) {
      ctx.fillText(midiDeviceNames[i], w - 12, 28 + i * 14);
    }

    // Client count (position relative to the border in screen space)
    const borderScreen = mainEditor.screenFromPatch(0, mainEditor.borderY);
    ctx.fillText(connectedClients + " client" + (connectedClients !== 1 ? "s" : ""), w - 12, borderScreen.y + 8);
    ctx.textAlign = "left";
  }
});

mainEditor.bindEvents();

// Input handlers
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); mainEditor.finishEditing(true); }
  else if (e.key === "Escape") { e.preventDefault(); mainEditor.finishEditing(false); }
});
input.addEventListener("input", () => {
  if (mainEditor.editingBoxId === null) return;
  const box = mainEditor.boxes.get(mainEditor.editingBoxId);
  if (!box) return;
  const w = Math.max(mainEditor.measureText(input.value || " ") + BOX_PAD_X * 2,
    (Math.max(box.inlets, box.outlets) + 1) * (PORT_W + 4), 80);
  input.style.width = (w * mainEditor.zoom) + "px";
  mainEditor.render();
});
input.addEventListener("blur", () => mainEditor.finishEditing(true));

// Resize
function resize() {
  mainEditor.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);
resize();

// --- Help System ---

// Visible error channel. Stays up until clicked (errors must not scroll past in a console).
function notify(lines) {
  const el = document.getElementById("notice");
  el.textContent = [].concat(lines).join("\n");
  el.style.display = "block";
  el.onclick = () => { el.style.display = "none"; };
}

// "press h for help" on load; goes away on the first key or click.
{
  const hint = document.getElementById("hint");
  const dismiss = () => {
    hint.style.display = "none";
    window.removeEventListener("keydown", dismiss, true);
    window.removeEventListener("pointerdown", dismiss, true);
  };
  hint.style.display = "block";
  window.addEventListener("keydown", dismiss, true);
  window.addEventListener("pointerdown", dismiss, true);
}

let helpEditor = null;
let helpPopup = null;
let helpDirty = false;
let helpName = null;

async function openHelp(typeName) {
  const helpPatchName = typeName + "-help";
  try {
    const res = await fetch(`/help/${encodeURIComponent(helpPatchName)}`);
    if (!res.ok) {
      console.log(`No help for "${typeName}"`);
      return;
    }
    showHelpPopup(helpPatchName, await res.json());
  } catch (e) {
    console.error("Failed to load help:", e);
  }
}

function showHelpPopup(name, data) {
  helpName = name;
  let popup = document.getElementById("help-popup");
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "help-popup";
    popup.innerHTML = `
      <div class="help-titlebar">
        <span class="help-title"></span>
        <button class="help-close">\u00d7</button>
      </div>
      <canvas id="help-canvas"></canvas>
    `;
    document.body.appendChild(popup);
    popup.querySelector(".help-close").onclick = closeHelpPopup;
    makeDraggable(popup, popup.querySelector(".help-titlebar"));
  }

  popup.querySelector(".help-title").textContent = name;
  popup.classList.remove("hidden");

  const helpCanvas = popup.querySelector("#help-canvas");
  const dpr = window.devicePixelRatio || 1;
  const rect = popup.getBoundingClientRect();
  const titleH = popup.querySelector(".help-titlebar").offsetHeight;
  helpCanvas.width = (rect.width - 2) * dpr;
  helpCanvas.height = (rect.height - titleH - 2) * dpr;
  helpCanvas.style.width = (rect.width - 2) + "px";
  helpCanvas.style.height = (rect.height - titleH - 2) + "px";

  helpEditor = new PatchEditor(helpCanvas, {
    showBorder: false,
    onDirty: () => { helpDirty = true; popup.querySelector(".help-title").textContent = name + " *"; }
  });
  helpEditor.bindEvents();
  helpEditor.load(data);
  helpEditor.render();

  helpPopup = popup;
  helpDirty = false;
}

function closeHelpPopup() {
  if (helpDirty && confirm(`Save changes to ${helpName}?`)) {
    fetch(`/help/${encodeURIComponent(helpName)}`, { method: "PUT", body: helpEditor.serialize() });
  }
  document.getElementById("help-popup")?.classList.add("hidden");
  helpEditor?.unbindEvents();
  helpEditor = null;
  helpPopup = null;
  helpDirty = false;
}

function makeDraggable(el, handle) {
  let ox = 0, oy = 0, sx = 0, sy = 0;
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    sx = e.clientX; sy = e.clientY;
    ox = el.offsetLeft; oy = el.offsetTop;
    document.addEventListener("mousemove", drag);
    document.addEventListener("mouseup", () => document.removeEventListener("mousemove", drag), { once: true });
  });
  function drag(e) {
    el.style.left = (ox + e.clientX - sx) + "px";
    el.style.top = (oy + e.clientY - sy) + "px";
    el.style.right = "auto";
  }
}

// --- Abstraction editor (separate window) ---

function openAbstractionForEdit(text) {
  const name = boxTypeName(text);
  window.open(`/abs-editor.html?name=${encodeURIComponent(name)}`, `abs-${name}`, "width=800,height=600");
}

function newAbstraction() {
  const name = prompt("Abstraction name:");
  if (!name) return;
  window.open(`/abs-editor.html?name=${encodeURIComponent(name)}`, `abs-${name}`, "width=800,height=600");
}

// Refresh abstractions when abs-editor saves
window.addEventListener("message", async (e) => {
  if (e.data?.type === "abs-saved") {
    await loadAbstractions();
    mainEditor.render();
  }
});

// --- Keyboard ---

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && helpPopup) { closeHelpPopup(); return; }
  if (mainEditor.mode === "editing") return;
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); applyToServer(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); mainEditor.undo(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "c") {
    e.preventDefault();
    if (mainEditor.selection.size === 0) return;
    // Copy selected boxes + internal cables
    const copyBoxes = [];
    const copyCables = [];
    for (const id of mainEditor.selection) {
      const box = mainEditor.boxes.get(id);
      if (box) copyBoxes.push([id, { ...box }]);
    }
    for (const [cid, c] of mainEditor.cables) {
      if (mainEditor.selection.has(c.srcBox) && mainEditor.selection.has(c.dstBox)) {
        copyCables.push([cid, { ...c }]);
      }
    }
    localStorage.setItem("clipboard", JSON.stringify({ boxes: copyBoxes, cables: copyCables }));
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "v") {
    e.preventDefault();
    const clip = localStorage.getItem("clipboard");
    if (!clip) return;
    const clipData = JSON.parse(clip);
    mainEditor.pushUndo();
    const idMap = new Map();
    const newSel = new Set();
    const offset = 30;
    for (const [oldId, box] of clipData.boxes) {
      const newId = mainEditor.nextId++;
      idMap.set(oldId, newId);
      const pasted = { x: box.x + offset, y: box.y + offset, text: box.text, inlets: box.inlets, outlets: box.outlets };
      mainEditor.placeOnSide(pasted);  // a paste has no drag to refuse, so bound boxes snap to their side
      mainEditor.boxes.set(newId, pasted);
      newSel.add(newId);
    }
    for (const [, c] of clipData.cables) {
      if (idMap.has(c.srcBox) && idMap.has(c.dstBox)) {
        mainEditor.cables.set(mainEditor.nextId++, { srcBox: idMap.get(c.srcBox), srcOutlet: c.srcOutlet, dstBox: idMap.get(c.dstBox), dstInlet: c.dstInlet });
      }
    }
    mainEditor.selection.clear();
    for (const id of newSel) mainEditor.selection.add(id);
    mainEditor.dirty = true;
    mainEditor.render();
    return;
  }
  if (e.key === "z" && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (mainEditor.zoom < 1) mainEditor.resetView();
    else mainEditor.zoomToFit();
    return;
  }
  if (e.key === "s" && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); savePatch(); return; }
  if (e.key === "N" && !e.metaKey && !e.ctrlKey && e.shiftKey) { e.preventDefault(); newAbstraction(); return; }
  if (e.key === "o" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); loadPatch(); return; }
  if (e.key === "p" && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); fetch("/patches/reveal", { method: "POST" }); return; }
  if (e.key === "n" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); mainEditor.pushUndo(); mainEditor.boxes.clear(); mainEditor.cables.clear(); mainEditor.selection.clear(); mainEditor.cableSelection.clear(); mainEditor.nextId = 1; mainEditor.dirty = true; mainEditor.onDirty(); mainEditor.resetView(); currentPatchName = null; mainEditor.render(); return; }
  if (e.key === "h" && mainEditor.selection.size === 1) {
    e.preventDefault();
    const boxId = [...mainEditor.selection][0];
    openHelp(boxTypeName(mainEditor.boxes.get(boxId).text));
    return;
  }
  if (e.key === "h" && mainEditor.selection.size === 0 && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    openHelp("tambourine");
    return;
  }
  if (e.key === " " && mainEditor.mode !== "editing") {
    e.preventDefault();
    mainEditor.spaceHeld = true;
    if (!mainEditor.isPanning) mainEditor.canvas.style.cursor = "grab";
    return;
  }
  mainEditor.onKeyDown(e);
});

window.addEventListener("keyup", (e) => {
  if (e.key === " ") {
    mainEditor.spaceHeld = false;
    if (!mainEditor.isPanning) mainEditor.canvas.style.cursor = "default";
  }
});

// --- WebSocket ---

function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try { ws = new WebSocket(`${proto}//${location.host}/ws/ctrl`); } catch { setTimeout(connectWS, 2000); return; }
  ws.addEventListener("open", () => { wsConnected = true; mainEditor.render(); });
  ws.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "state") {
        mainEditor.load(msg);
        if (msg.boxValues) {
          for (const [id, v] of Object.entries(msg.boxValues)) mainEditor.boxValues.set(Number(id), v);
        }
        mainEditor.applied = true;
        mainEditor.dirty = false;
        mainEditor.undoStack.length = 0;
        mainEditor.render();
      } else if (msg.type === "values") {
        for (const u of msg.updates) mainEditor.boxValues.set(u.id, u.value);
        mainEditor.render();
      } else if (msg.type === "applied") {
        mainEditor.applied = true;
        mainEditor.dirty = false;
        mainEditor.render();
      } else if (msg.type === "errors") {
        for (const err of msg.errors) console.warn("⚠ " + err);
        notify(msg.errors.map((e) => "⚠ " + e));
      } else if (msg.type === "apply-rejected") {
        notify(["✗ apply rejected, previous patch still running", ...msg.errors]);
      } else if (msg.type === "count") {
        connectedClients = msg.clients;
        mainEditor.render();
      } else if (msg.type === "grid-connected") {
        const deviceName = `${msg.deviceType} (${msg.deviceId})`;
        if (!midiDeviceNames.includes(deviceName)) {
          midiDeviceNames.push(deviceName);
          mainEditor.render();
        }
      } else if (msg.type === "grid-disconnected") {
        const deviceName = `${msg.deviceType} (${msg.deviceId})`;
        const index = midiDeviceNames.indexOf(deviceName);
        if (index !== -1) {
          midiDeviceNames.splice(index, 1);
          mainEditor.render();
        }
      } else if (msg.type === "arc-connected") {
        const deviceName = `${msg.deviceType} (${msg.deviceId})`;
        if (!midiDeviceNames.includes(deviceName)) {
          midiDeviceNames.push(deviceName);
          mainEditor.render();
        }
      } else if (msg.type === "arc-disconnected") {
        // Remove the specific arc device from list
        const deviceName = `${msg.deviceType} (${msg.deviceId})`;
        const arcIndex = midiDeviceNames.indexOf(deviceName);
        if (arcIndex !== -1) {
          midiDeviceNames.splice(arcIndex, 1);
          mainEditor.render();
        }
      } else if (msg.type === "patch") {
        loadLaptopPatch(msg);
      } else if (msg.type === "rv" || msg.type === "re") {
        laptopMessage(msg);
      }
    } catch {}
  });
  ws.addEventListener("close", () => { wsConnected = false; ws = null; connectedClients = 0; mainEditor.render(); setTimeout(connectWS, 2000); });
  ws.addEventListener("error", () => { ws = null; });
}

function send(msg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

// --- Server Communication ---

function applyToServer() {
  send({
    type: "apply",
    boxes: [...mainEditor.boxes.entries()],
    cables: [...mainEditor.cables.entries()],
    nextId: mainEditor.nextId,
    borderY: mainEditor.borderY,
  });
}

async function savePatch() {
  const name = prompt("Patch name:", currentPatchName || "");
  if (!name) return;
  const res = await fetch(`/patches/${encodeURIComponent(name)}`, { method: "PUT", body: mainEditor.serialize() });
  if (res.ok) { currentPatchName = name; console.log("Saved:", name); mainEditor.render(); }
}

async function loadPatch() {
  const res = await fetch("/patches");
  const patches = await res.json();
  if (patches.length === 0) { console.log("No patches"); return; }
  const name = prompt("Load:\n\n" + patches.map((p, i) => `${i + 1}. ${p}`).join("\n") + "\n\nName or number:");
  if (!name) return;
  const resolved = /^\d+$/.test(name) ? patches[parseInt(name) - 1] : name;
  if (!resolved) return;
  const patchRes = await fetch(`/patches/${encodeURIComponent(resolved)}`);
  if (!patchRes.ok) { console.error("Not found:", resolved); return; }
  mainEditor.pushUndo();
  mainEditor.load(await patchRes.text());
  currentPatchName = resolved;
  mainEditor.dirty = true;
  console.log("Loaded:", resolved, "— Cmd+Enter to apply");
  mainEditor.render();
}


// --- WebMIDI ---

const MIDI_DEVICES = [{ match: ["bbc", "tecontrol", "breath controller"], sources: ["breath", "bite", "nod", "tilt"] }];
const MIDI_IGNORE = ["af16rig"];

function autoCreateSources(deviceName) {
  const lower = deviceName.toLowerCase();
  if (MIDI_IGNORE.some(p => lower.includes(p))) return;
  if (!midiDeviceNames.includes(deviceName)) { midiDeviceNames.push(deviceName); mainEditor.render(); }
  let sources = null;
  for (const dev of MIDI_DEVICES) if (dev.match.some(p => lower.includes(p))) { sources = dev.sources; break; }
  if (!sources) return; // unknown device — don't auto-create boxes

  let nextY = 30, created = false;
  for (const box of mainEditor.boxes.values()) {
    if (boxBinding(box.text).binding === "one" && box.y + BOX_HEIGHT + 10 > nextY) nextY = box.y + BOX_HEIGHT + 10;
  }
  for (const name of sources) {
    let found = false;
    for (const box of mainEditor.boxes.values()) if (box.text === name) { found = true; break; }
    if (found) continue;
    const p = getPorts(name);
    mainEditor.boxes.set(mainEditor.nextId++, { x: 20, y: nextY, text: name, inlets: p.inlets, outlets: p.outlets });
    nextY += 60;
    created = true;
  }
  if (created) { mainEditor.dirty = true; mainEditor.render(); }
}

function onMIDIMessage(e) {
  const [status, d1, d2] = e.data, type = status & 0xf0, channel = (status & 0x0f) + 1;
  if (type === 0xb0) send({ type: "midi", cc: d1, value: d2, channel });
  else if (type === 0x90) send({ type: "midi", note: d1, velocity: d2, channel });
  else if (type === 0x80) send({ type: "midi", note: d1, velocity: 0, channel });
}

async function initMIDI() {
  try {
    const ma = await navigator.requestMIDIAccess();
    for (const inp of ma.inputs.values()) { autoCreateSources(inp.name || "keyboard"); inp.onmidimessage = onMIDIMessage; }
    ma.onstatechange = (e) => {
      if (e.port.type !== "input") return;
      if (e.port.state === "connected") {
        autoCreateSources(e.port.name || "keyboard");
        e.port.onmidimessage = onMIDIMessage;
      } else if (e.port.state === "disconnected") {
        const i = midiDeviceNames.indexOf(e.port.name);
        if (i >= 0) { midiDeviceNames.splice(i, 1); mainEditor.render(); }
      }
    };
  } catch {}
}

// --- Init ---

connectWS();
initMIDI();
loadAbstractions();
