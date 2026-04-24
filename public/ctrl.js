/**
 * Ctrl — Graphical Patching Interface + ctrl-side engine host
 * Canvas-based PD-style patch editor.
 * All edits are local. Cmd+Enter applies the full state to the server.
 * Cmd+Z undoes. Server sends value updates for display.
 * Also hosts ctrl-side engines (above-border) with audio output to laptop speakers.
 */

import { boxTypeName, getBoxPorts, getBoxZone, getBoxDef, getInletDef, getOutletDef, isAudioBox } from "./gpi-types.js";
import { PatchEditor, COLORS, BOX_HEIGHT, BOX_PAD_X, PORT_W, SMALL_FONT, abstractionTypes, loadAbstractions, isAbstraction, getPorts, getDef } from "./patch-editor.js";
const { ENGINES, BASE_NATIVE_NODES, createEngine: _createEngine, getEngineOutput } = window._engineFactory;

// DOM elements
const canvas = document.getElementById("c");
const input = document.getElementById("box-input");
const tooltipEl = document.getElementById("tooltip");

// --- global state ---

let ws = null, wsConnected = false;
let connectedClients = 0;
let midiDeviceNames = [];
let currentPatchName = null;

// --- ctrl-side audio engine ---

let ctrlAudioCtx = null;
let ctrlChannelMerger = null;
let ctrlInputSource = null;   // MediaStreamSourceNode (shared)
let ctrlInputSplitter = null; // ChannelSplitterNode for adc~
const ctrlEngines = new Map();
const ctrlWorkletModulesLoaded = new Set();

const CTRL_NATIVE_NODES = new Set([...BASE_NATIVE_NODES, "adc~"]);

async function initCtrlAudio() {
  if (ctrlAudioCtx) return;
  ctrlAudioCtx = new AudioContext({ sampleRate: 48000 });
  await ctrlAudioCtx.resume();
  // Set multi-channel discrete output immediately
  ctrlAudioCtx.destination.channelCount = ctrlAudioCtx.destination.maxChannelCount;
  ctrlAudioCtx.destination.channelInterpretation = "discrete";
}

// adc~ special handler — creates audio input from shared splitter
async function adcHandler(ctx, type, args) {
  if (type !== "adc~") return null;
  const tokens = (args || "").split(/\s+/).filter(Boolean);
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

async function buildCtrlAudioTopology() {
  // Tear down existing
  for (const eng of ctrlEngines.values()) {
    if (eng.node) { try { eng.node.stop?.(); } catch {} eng.node.disconnect(); }
    eng.worklet?.disconnect(); eng.splitter?.disconnect(); eng.out?.disconnect();
    if (eng.outputs) for (const o of eng.outputs) o.disconnect();
  }
  ctrlEngines.clear();
  if (ctrlChannelMerger) { ctrlChannelMerger.disconnect(); ctrlChannelMerger = null; }
  if (ctrlInputSplitter) { ctrlInputSplitter.disconnect(); ctrlInputSplitter = null; }
  if (ctrlInputSource) { ctrlInputSource.disconnect(); ctrlInputSource = null; }

  // Collect ctrl-zone audio boxes
  const ctrlAudioBoxes = new Map();
  for (const [id, box] of mainEditor.boxes) {
    if (isAudioBox(box.text) && !mainEditor.isSynthZone(box.y)) {
      ctrlAudioBoxes.set(id, box);
    }
  }
  if (ctrlAudioBoxes.size === 0) return;

  await initCtrlAudio();

  // Determine max channel for multi-channel output
  let maxChannel = 2;
  for (const [, box] of ctrlAudioBoxes) {
    if (boxTypeName(box.text) === "dac~") {
      const chs = box.text.split(/\s+/).slice(1).map(Number).filter(n => !isNaN(n) && n > 0);
      for (const ch of chs) maxChannel = Math.max(maxChannel, ch);
    }
  }
  ctrlAudioCtx.destination.channelCount = maxChannel;
  ctrlAudioCtx.destination.channelInterpretation = "discrete";
  ctrlChannelMerger = ctrlAudioCtx.createChannelMerger(maxChannel);
  ctrlChannelMerger.channelCountMode = "explicit";
  ctrlChannelMerger.channelInterpretation = "discrete";
  ctrlChannelMerger.connect(ctrlAudioCtx.destination);

  // Create engines
  for (const [id, box] of ctrlAudioBoxes) {
    const type = boxTypeName(box.text);
    if (type === "dac~") continue;
    const args = box.text.split(/\s+/).slice(1).join(" ");
    const engine = await createCtrlEngine(type, args);
    if (engine) ctrlEngines.set(id, engine);
  }

  // Collect audio cables between ctrl-zone audio boxes
  const audioCables = [];
  for (const [, cable] of mainEditor.cables) {
    if (!ctrlAudioBoxes.has(cable.srcBox) && !ctrlAudioBoxes.has(cable.dstBox)) continue;
    const srcBox = mainEditor.boxes.get(cable.srcBox);
    if (!srcBox) continue;
    const srcOutletDef = getOutletDef(srcBox.text, cable.srcOutlet);
    if (srcOutletDef?.type === "audio") audioCables.push(cable);
  }

  // Wire audio cables
  for (const cable of audioCables) {
    const srcEng = ctrlEngines.get(cable.srcBox);
    if (!srcEng) continue;
    const srcNode = getEngineOutput(srcEng, cable.srcOutlet);

    // dac~
    const dstBox = mainEditor.boxes.get(cable.dstBox);
    if (dstBox && boxTypeName(dstBox.text) === "dac~") {
      const chs = dstBox.text.split(/\s+/).slice(1).map(Number).filter(n => !isNaN(n) && n > 0);
      if (chs.length === 0) chs.push(1, 2); // default stereo
      for (const ch of chs) srcNode.connect(ctrlChannelMerger, 0, ch - 1);
      continue;
    }

    // AudioParam modulation (audio → number inlet)
    const dstInletDef = dstBox ? getInletDef(dstBox.text, cable.dstInlet) : null;
    if (dstInletDef && dstInletDef.type !== "audio") {
      const dstEng = ctrlEngines.get(cable.dstBox);
      if (dstEng) {
        const paramName = dstInletDef.name;
        const param = dstEng.paramMap?.[paramName] || dstEng.worklet?.parameters?.get(paramName);
        if (param) { param.setValueAtTime(0, ctrlAudioCtx.currentTime); srcNode.connect(param); }
      }
      continue;
    }

    // Audio bus connection
    const dstEng = ctrlEngines.get(cable.dstBox);
    if (dstEng) {
      const dstNode = dstEng.node || dstEng.worklet;
      if (dstNode) {
        // Map inlet index to Web Audio input index
        const dstDef = dstBox ? getBoxDef(dstBox.text) : null;
        let audioInputIdx = 0;
        if (dstDef) {
          for (let i = 0; i < cable.dstInlet; i++) {
            if (dstDef.inlets[i]?.type === "audio") audioInputIdx++;
          }
        }
        srcNode.connect(dstNode, 0, audioInputIdx);
      }
    }
  }

  // Wireless audio (same as main.js)
  const wirelessSends = new Map(), wirelessRecvs = new Map();
  const wirelessThrows = new Map(), wirelessCatches = new Map();
  const sendTypes = new Set(["send~", "s~"]), recvTypes = new Set(["receive~", "r~"]);
  for (const [id, box] of ctrlAudioBoxes) {
    const type = boxTypeName(box.text);
    const name = box.text.split(/\s+/).slice(1).join(" ").trim();
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

function handleCtrlAudioParam(msg) {
  const engine = ctrlEngines.get(msg.boxId);
  if (!engine) return;
  const box = mainEditor.boxes.get(msg.boxId);
  if (!box) return;
  const inletDef = getInletDef(box.text, msg.inlet);
  if (!inletDef) return;
  const paramName = inletDef.name;

  if (paramName === "trigger") {
    (engine.worklet?.port || engine.node?.port)?.postMessage({ type: "trigger" });
  } else if (paramName === "gate") {
    (engine.worklet?.port || engine.node?.port)?.postMessage({ type: "gate", value: msg.value });
  } else if (paramName === "portamento" && engine.portaTime !== undefined) {
    engine.portaTime = msg.value;
  } else if (typeof msg.value === "number") {
    const param = engine.paramMap?.[paramName] || engine.worklet?.parameters?.get(paramName);
    if (param) {
      const now = ctrlAudioCtx.currentTime;
      if (engine.portaTime > 0) param.setTargetAtTime(msg.value, now, engine.portaTime);
      else param.setValueAtTime(msg.value, now);
    }
  }
}

function handleCtrlAudioEvent(msg) {
  const engine = ctrlEngines.get(msg.boxId);
  if (!engine) return;
  (engine.worklet?.port || engine.node?.port)?.postMessage({ type: "trigger" });
}

// =============================================================================
// Main Editor Setup (PatchEditor imported from patch-editor.js)
// =============================================================================

// =============================================================================
// Main Editor
// =============================================================================

const mainEditor = new PatchEditor(canvas, {
  synthBorderY: window.innerHeight * 0.55,
  showSynthBorder: true,
  input: input,
  tooltipEl: tooltipEl,
  onSend: (msg) => send(msg),
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

    // Client count (position relative to synth border in screen space)
    const borderScreen = mainEditor.screenFromPatch(0, mainEditor.synthBorderY);
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

let helpEditor = null;
let helpPopup = null;
let helpDirty = false;
let helpName = null;

async function openHelp(typeName) {
  const helpPatchName = typeName + "-help";
  try {
    const res = await fetch(`/abstractions/${encodeURIComponent(helpPatchName)}`);
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
    showSynthBorder: false,
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
    fetch(`/abstractions/${encodeURIComponent(helpName)}`, { method: "PUT", body: helpEditor.serialize() });
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
      mainEditor.boxes.set(newId, { x: box.x + offset, y: box.y + offset, text: box.text, inlets: box.inlets, outlets: box.outlets });
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
        buildCtrlAudioTopology().then(() => send({ type: "ctrl-audio-ready" }));
        mainEditor.render();
      } else if (msg.type === "errors") {
        for (const err of msg.errors) console.warn("⚠ " + err);
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
      } else if (msg.type === "ctrl-audio-param") {
        handleCtrlAudioParam(msg);
      } else if (msg.type === "ctrl-audio-event") {
        handleCtrlAudioEvent(msg);
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
    synthBorderY: mainEditor.synthBorderY,
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
    if (getBoxZone(box.text) === "ctrl" && box.y + BOX_HEIGHT + 10 > nextY) nextY = box.y + BOX_HEIGHT + 10;
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
