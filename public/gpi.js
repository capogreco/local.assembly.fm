/**
 * GPI — Graphical Patching Interface
 * Canvas-based PD-style patch editor with ctrl/synth zones,
 * graph evaluation, WebSocket transport, and WebMIDI input.
 */

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const input = document.getElementById("box-input");
const tooltipEl = document.getElementById("tooltip");

// --- constants ---

const COLORS = {
  bg: "#1a1a1a", boxFill: "#2a2a2a", boxStroke: "#666",
  boxSelectedFill: "#333", boxSelectedStroke: "#e0e0e0",
  text: "#e0e0e0", port: "#e0e0e0", cable: "#666", cableInProgress: "#999",
  synthBorder: "#555", synthLabel: "#555", synthHandle: "#666",
  routerFill: "#2a2a2a", routerStroke: "#555",
};
const BOX_HEIGHT = 22, BOX_PAD_X = 8, PORT_W = 8, PORT_H = 3, PORT_HIT = 8, SYNTH_HANDLE = 8;
const FONT = '12px "IBM Plex Mono", "Fira Mono", "Courier New", monospace';
const SMALL_FONT = '10px "IBM Plex Mono", monospace';

// --- state ---

const boxes = new Map();
const cables = new Map();
const selection = new Set();
const cableSelection = new Set();
const boxValues = new Map();
let nextId = 1;
let mode = "idle";
let dragStart = null, dragBoxPositions = null, cableFrom = null;
let mousePos = { x: 0, y: 0 }, editingBoxId = null;
let synthBorderY = window.innerHeight * 0.55;
let hoverTimer = null, lastHoverTarget = null;
let ws = null, wsConnected = false, midiAccess = null;

// --- geometry ---

function isSynthZone(px, py) { return py >= synthBorderY; }
function hitTestSynthHandle(mx, my) {
  return Math.abs(mx - SYNTH_HANDLE) < SYNTH_HANDLE && Math.abs(my - synthBorderY) < SYNTH_HANDLE;
}

function measureText(text) { ctx.font = FONT; return ctx.measureText(text).width; }

function boxWidth(box, id) {
  let text = (id !== undefined && id === editingBoxId) ? (input.value || " ") : (box.text || " ");
  return Math.ceil(Math.max(measureText(text) + BOX_PAD_X * 2, (Math.max(box.inlets, box.outlets) + 1) * (PORT_W + 4), 30));
}

function inletPos(box, i, id) {
  const w = boxWidth(box, id), s = w / (box.inlets + 1);
  return { x: box.x + s * (i + 1), y: box.y };
}

function outletPos(box, i, id) {
  const w = boxWidth(box, id), s = w / (box.outlets + 1);
  return { x: box.x + s * (i + 1), y: box.y + BOX_HEIGHT };
}

// --- hit testing ---

function hitTestOutlet(mx, my) {
  for (const [id, box] of boxes) for (let i = 0; i < box.outlets; i++) {
    const p = outletPos(box, i, id);
    if (Math.abs(mx - p.x) < PORT_HIT && Math.abs(my - p.y) < PORT_HIT) return { boxId: id, index: i };
  }
  return null;
}

function hitTestInlet(mx, my) {
  for (const [id, box] of boxes) for (let i = 0; i < box.inlets; i++) {
    const p = inletPos(box, i, id);
    if (Math.abs(mx - p.x) < PORT_HIT && Math.abs(my - p.y) < PORT_HIT) return { boxId: id, index: i };
  }
  return null;
}

function hitTestBox(mx, my) {
  for (const [id, box] of [...boxes.entries()].reverse()) {
    const w = boxWidth(box, id);
    if (mx >= box.x && mx <= box.x + w && my >= box.y && my <= box.y + BOX_HEIGHT) return id;
  }
  return null;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hitTestCable(mx, my) {
  for (const [id, cable] of cables) {
    const from = cableFromPos(cable), to = cableToPos(cable);
    if (from && to && distToSeg(mx, my, from.x, from.y, to.x, to.y) < 4) return id;
  }
  return null;
}

// --- cable helpers ---

function cableFromPos(c) { const b = boxes.get(c.srcBox); return b ? outletPos(b, c.srcOutlet, c.srcBox) : null; }
function cableToPos(c) { const b = boxes.get(c.dstBox); return b ? inletPos(b, c.dstInlet, c.dstBox) : null; }
function inletHasCable(boxId, inlet) { for (const c of cables.values()) if (c.dstBox === boxId && c.dstInlet === inlet) return true; return false; }
function removeCablesForBox(boxId) { for (const [id, c] of cables) if (c.srcBox === boxId || c.dstBox === boxId) cables.delete(id); }
function cablesFromOutlet(boxId, outlet) { const r = []; for (const [, c] of cables) if (c.srcBox === boxId && c.srcOutlet === outlet) r.push(c); return r; }

// --- router snapping ---

function snapRouterToBorder(box) { box.y = synthBorderY - BOX_HEIGHT / 2; }
function isRouterType(text) { return getBoxZone(text) === "router"; }

// --- tooltip ---

function showTooltip(x, y, html) {
  tooltipEl.innerHTML = html; tooltipEl.style.display = "block";
  tooltipEl.style.left = (x + 12) + "px"; tooltipEl.style.top = (y + 12) + "px";
  const r = tooltipEl.getBoundingClientRect();
  if (r.right > window.innerWidth) tooltipEl.style.left = (x - r.width - 4) + "px";
  if (r.bottom > window.innerHeight) tooltipEl.style.top = (y - r.height - 4) + "px";
}

function hideTooltip() {
  tooltipEl.style.display = "none";
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  lastHoverTarget = null;
}

function getHoverTarget(mx, my) {
  for (const [id, box] of boxes) {
    const def = getBoxDef(box.text); if (!def) continue;
    for (let i = 0; i < box.outlets; i++) {
      const p = outletPos(box, i, id);
      if (Math.abs(mx - p.x) < PORT_HIT && Math.abs(my - p.y) < PORT_HIT)
        return { kind: "outlet", boxId: id, index: i, def, x: mx, y: my };
    }
    for (let i = 0; i < box.inlets; i++) {
      const p = inletPos(box, i, id);
      if (Math.abs(mx - p.x) < PORT_HIT && Math.abs(my - p.y) < PORT_HIT)
        return { kind: "inlet", boxId: id, index: i, def, x: mx, y: my };
    }
  }
  const boxId = hitTestBox(mx, my);
  if (boxId !== null) { const def = getBoxDef(boxes.get(boxId).text); if (def) return { kind: "box", boxId, def, x: mx, y: my }; }
  return null;
}

function buildTooltipHtml(target) {
  const def = target.def;
  if (target.kind === "inlet" || target.kind === "outlet") {
    const port = (target.kind === "inlet" ? def.inlets : def.outlets)[target.index];
    return port ? `<span class="tt-name">${port.name}</span> <span class="tt-type">${port.type}</span><br>${port.description}` : null;
  }
  let html = `<span class="tt-name">${boxTypeName(boxes.get(target.boxId).text)}</span><br>${def.description}`;
  if (def.example) html += `<br><span class="tt-type">${def.example}</span>`;
  return html;
}

// --- render ---

function render() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.scale(dpr, dpr);

  ctx.fillStyle = COLORS.bg; ctx.fillRect(0, 0, w, h);

  // synth border
  ctx.strokeStyle = COLORS.synthBorder; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, synthBorderY); ctx.lineTo(w, synthBorderY); ctx.stroke();
  ctx.fillStyle = COLORS.synthHandle;
  ctx.fillRect(SYNTH_HANDLE / 2, synthBorderY - SYNTH_HANDLE / 2, SYNTH_HANDLE, SYNTH_HANDLE);
  ctx.font = SMALL_FONT; ctx.fillStyle = COLORS.synthLabel;
  ctx.textBaseline = "bottom"; ctx.fillText("ctrl", 12, synthBorderY - 6);
  ctx.textBaseline = "top"; ctx.fillText("synth", 12, synthBorderY + 6);
  ctx.font = FONT;

  // cables
  ctx.lineWidth = 1;
  for (const [id, cable] of cables) {
    const from = cableFromPos(cable), to = cableToPos(cable); if (!from || !to) continue;
    ctx.strokeStyle = cableSelection.has(id) ? COLORS.boxSelectedStroke : COLORS.cable;
    ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  }

  // in-progress cable
  if (mode === "cabling" && cableFrom) {
    const src = boxes.get(cableFrom.boxId);
    const from = src ? outletPos(src, cableFrom.index, cableFrom.boxId) : null;
    if (from) {
      ctx.strokeStyle = COLORS.cableInProgress; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(mousePos.x, mousePos.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // boxes
  ctx.font = FONT;
  for (const [id, box] of boxes) {
    const bw = boxWidth(box, id), selected = selection.has(id);
    const def = getBoxDef(box.text), zone = def ? def.zone : "any";
    const isRouter = zone === "router", isUnknown = !def && box.text.length > 0;

    ctx.fillStyle = selected ? COLORS.boxSelectedFill : isRouter ? COLORS.routerFill : COLORS.boxFill;
    ctx.fillRect(box.x, box.y, bw, BOX_HEIGHT);
    ctx.strokeStyle = selected ? COLORS.boxSelectedStroke : isRouter ? COLORS.routerStroke : COLORS.boxStroke;
    ctx.lineWidth = 1;
    if (isUnknown) ctx.setLineDash([4, 3]);
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, bw - 1, BOX_HEIGHT - 1);
    if (isUnknown) ctx.setLineDash([]);

    if (boxValues.has(id)) {
      const val = boxValues.get(id);
      if (val >= 0 && val <= 1) { ctx.fillStyle = "#4a4a4a"; ctx.fillRect(box.x + 1, box.y + 1, (bw - 2) * val, BOX_HEIGHT - 2); }
    }

    if (editingBoxId !== id) {
      ctx.fillStyle = COLORS.text; ctx.textBaseline = "middle";
      ctx.fillText(box.text, box.x + BOX_PAD_X, box.y + BOX_HEIGHT / 2);
    }

    ctx.fillStyle = COLORS.port;
    for (let i = 0; i < box.inlets; i++) { const p = inletPos(box, i, id); ctx.fillRect(p.x - PORT_W / 2, p.y - PORT_H + 0.5, PORT_W, PORT_H); }
    for (let i = 0; i < box.outlets; i++) { const p = outletPos(box, i, id); ctx.fillRect(p.x - PORT_W / 2, p.y - 0.5, PORT_W, PORT_H); }
  }

  // connection status dot
  ctx.beginPath(); ctx.arc(w - 16, 16, 4, 0, Math.PI * 2);
  ctx.fillStyle = wsConnected ? "#686" : "#865"; ctx.fill();

  ctx.restore();
}

// --- canvas sizing ---

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr; canvas.height = window.innerHeight * dpr;
  render();
}
window.addEventListener("resize", resize); resize();

// --- text input ---

function startEditing(boxId) {
  const box = boxes.get(boxId); if (!box) return;
  editingBoxId = boxId; mode = "editing";
  const w = Math.max(boxWidth(box, boxId), 80);
  Object.assign(input.style, { left: (box.x + BOX_PAD_X) + "px", top: box.y + "px", width: w + "px", height: BOX_HEIGHT + "px", lineHeight: BOX_HEIGHT + "px", display: "block" });
  input.value = box.text; input.focus(); input.select(); render();
}

function finishEditing(confirm) {
  if (editingBoxId === null) return;
  const box = boxes.get(editingBoxId);
  if (confirm && input.value.trim()) {
    box.text = input.value.trim();
    const ports = getBoxPorts(box.text);
    box.inlets = ports.inlets; box.outlets = ports.outlets;
    for (const [id, c] of cables) {
      if (c.srcBox === editingBoxId && c.srcOutlet >= box.outlets) cables.delete(id);
      if (c.dstBox === editingBoxId && c.dstInlet >= box.inlets) cables.delete(id);
    }
    if (isRouterType(box.text)) snapRouterToBorder(box);
    const zone = getBoxZone(box.text);
    if (zone === "synth" && !isSynthZone(box.x, box.y)) box.y = synthBorderY + 20;
    else if (zone === "ctrl" && isSynthZone(box.x, box.y)) box.y = synthBorderY - BOX_HEIGHT - 20;
  } else if (!box.text) {
    removeCablesForBox(editingBoxId); boxes.delete(editingBoxId); selection.delete(editingBoxId);
  }
  editingBoxId = null; mode = "idle"; input.style.display = "none"; input.value = ""; render();
}

input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finishEditing(true); } else if (e.key === "Escape") { e.preventDefault(); finishEditing(false); } });
input.addEventListener("input", () => { if (editingBoxId === null) return; const w = Math.max(measureText(input.value || " ") + BOX_PAD_X * 2, 80); input.style.width = w + "px"; render(); });
input.addEventListener("blur", () => finishEditing(true));

// --- mouse ---

function canvasCoords(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

canvas.addEventListener("mousedown", (e) => {
  const m = canvasCoords(e); hideTooltip();
  if (hitTestSynthHandle(m.x, m.y)) { mode = "resizing-synth"; canvas.style.cursor = "ns-resize"; return; }
  const outlet = hitTestOutlet(m.x, m.y);
  if (outlet) { mode = "cabling"; cableFrom = { boxId: outlet.boxId, index: outlet.index }; selection.clear(); cableSelection.clear(); canvas.style.cursor = "crosshair"; render(); return; }
  const boxId = hitTestBox(m.x, m.y);
  if (boxId !== null) {
    cableSelection.clear();
    if (e.shiftKey) { selection.has(boxId) ? selection.delete(boxId) : selection.add(boxId); }
    else if (!selection.has(boxId)) { selection.clear(); selection.add(boxId); }
    mode = "dragging"; dragStart = { x: m.x, y: m.y }; dragBoxPositions = new Map();
    for (const id of selection) { const b = boxes.get(id); if (b) dragBoxPositions.set(id, { x: b.x, y: b.y }); }
    render(); return;
  }
  const cableId = hitTestCable(m.x, m.y);
  if (cableId !== null) { selection.clear(); cableSelection.clear(); cableSelection.add(cableId); render(); return; }
  selection.clear(); cableSelection.clear(); render();
});

canvas.addEventListener("mousemove", (e) => {
  const m = canvasCoords(e); mousePos = m;
  if (mode === "resizing-synth") {
    synthBorderY = Math.max(100, Math.min(m.y, window.innerHeight - 100));
    for (const [, box] of boxes) if (isRouterType(box.text)) snapRouterToBorder(box);
    render(); return;
  }
  if (mode === "dragging" && dragStart) {
    const dx = m.x - dragStart.x, dy = m.y - dragStart.y;
    for (const [id, orig] of dragBoxPositions) {
      const box = boxes.get(id); if (!box) continue;
      if (isRouterType(box.text)) { box.x = orig.x + dx; snapRouterToBorder(box); }
      else { box.x = orig.x + dx; box.y = orig.y + dy; }
    }
    render(); return;
  }
  if (mode === "cabling") { render(); return; }
  // cursor + tooltip
  if (hitTestSynthHandle(m.x, m.y)) { canvas.style.cursor = "ns-resize"; hideTooltip(); }
  else {
    const o = hitTestOutlet(m.x, m.y), i = hitTestInlet(m.x, m.y);
    canvas.style.cursor = (o || i) ? "crosshair" : hitTestBox(m.x, m.y) !== null ? "move" : "default";
    const target = getHoverTarget(m.x, m.y), key = target ? target.kind + ":" + target.boxId + ":" + (target.index ?? "") : null;
    if (key !== lastHoverTarget) {
      hideTooltip(); lastHoverTarget = key;
      if (target) hoverTimer = setTimeout(() => { const h = buildTooltipHtml(target); if (h) showTooltip(target.x, target.y, h); }, 2000);
    }
  }
});

canvas.addEventListener("mouseup", (e) => {
  const m = canvasCoords(e);
  if (mode === "resizing-synth") { mode = "idle"; canvas.style.cursor = "default"; return; }
  if (mode === "cabling" && cableFrom) {
    const inlet = hitTestInlet(m.x, m.y);
    if (inlet && inlet.boxId !== cableFrom.boxId && !inletHasCable(inlet.boxId, inlet.index))
      cables.set(nextId++, { srcBox: cableFrom.boxId, srcOutlet: cableFrom.index, dstBox: inlet.boxId, dstInlet: inlet.index });
    cableFrom = null; mode = "idle"; canvas.style.cursor = "default"; render(); return;
  }
  if (mode === "dragging") { mode = "idle"; dragStart = null; dragBoxPositions = null; }
});

canvas.addEventListener("dblclick", (e) => {
  const m = canvasCoords(e), boxId = hitTestBox(m.x, m.y);
  if (boxId !== null) { selection.clear(); selection.add(boxId); startEditing(boxId); }
  else { const id = nextId++; boxes.set(id, { x: m.x - 15, y: m.y - BOX_HEIGHT / 2, text: "", inlets: 1, outlets: 1 }); selection.clear(); selection.add(id); startEditing(id); }
});

// --- persistence ---

const STORAGE_KEY = "assembly-gpi-patch";

function serialize() { return JSON.stringify({ boxes: [...boxes.entries()], cables: [...cables.entries()], nextId, synthBorderY }); }

function deserialize(json) {
  try {
    const data = JSON.parse(json); boxes.clear(); cables.clear();
    for (const [id, box] of data.boxes) { const p = getBoxPorts(box.text); box.inlets = p.inlets; box.outlets = p.outlets; boxes.set(id, box); }
    for (const [id, cable] of data.cables) cables.set(id, cable);
    nextId = data.nextId || 1;
    if (data.synthBorderY !== undefined) synthBorderY = data.synthBorderY;
    selection.clear(); cableSelection.clear(); render();
  } catch (e) { console.error("Failed to load patch:", e); }
}

function save() { localStorage.setItem(STORAGE_KEY, serialize()); }
function load() { const json = localStorage.getItem(STORAGE_KEY); if (json) deserialize(json); }

const _origRender = render;
render = function() { _origRender(); save(); };

load();

// --- keyboard ---

window.addEventListener("keydown", (e) => {
  if (mode === "editing") return;
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); deployPatch(); return; }
  if (e.key === "Backspace" || e.key === "Delete") {
    if (selection.size > 0 || cableSelection.size > 0) {
      e.preventDefault();
      for (const id of selection) { removeCablesForBox(id); boxes.delete(id); }
      for (const id of cableSelection) cables.delete(id);
      selection.clear(); cableSelection.clear(); render();
    }
    return;
  }
  if (e.key === "Escape") {
    if (mode === "cabling") { mode = "idle"; cableFrom = null; canvas.style.cursor = "default"; }
    else { selection.clear(); cableSelection.clear(); }
    render();
  }
});

// --- WebSocket ---

function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try { ws = new WebSocket(`${proto}//${location.host}`); } catch { setTimeout(connectWS, 2000); return; }
  ws.addEventListener("open", () => { wsConnected = true; render(); evaluateConstBoxes(); });
  ws.addEventListener("close", () => { wsConnected = false; ws = null; render(); setTimeout(connectWS, 2000); });
  ws.addEventListener("error", () => { ws = null; });
}

function send(msg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

connectWS();

// --- graph evaluation ---

function findBoxByText(text) { for (const [id, box] of boxes) if (box.text === text) return id; return null; }

function evaluateBox(box, iv) {
  const name = boxTypeName(box.text), args = box.text.split(/\s+/).slice(1);
  const a = iv[0], b = iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 0;
  switch (name) {
    case "+": return a + b; case "-": return a - b; case "*": return a * b;
    case "/": return b !== 0 ? a / b : 0; case "%": return b !== 0 ? a % b : 0;
    case "scale": { const mn = parseFloat(args[0]) || 0, mx = parseFloat(args[1]) || 1; return a * (mx - mn) + mn; }
    case "clip": { const mn = parseFloat(args[0]) || 0, mx = parseFloat(args[1]) || 1; return Math.max(mn, Math.min(mx, a)); }
    case "pow": return Math.pow(a, b);
    case "mtof": return 440 * Math.pow(2, (a - 69) / 12);
    case "const": return parseFloat(args[0]) || 0;
    default: return a;
  }
}

function propagate(boxId, outletIndex, value) {
  for (const cable of cablesFromOutlet(boxId, outletIndex)) {
    const dst = boxes.get(cable.dstBox); if (!dst) continue;
    const def = getBoxDef(dst.text); if (!def) continue;
    if (def.zone === "router") {
      send({ type: "rv", r: cable.dstBox, v: value });
    } else if (def.zone !== "synth") {
      if (!dst._iv) dst._iv = [];
      dst._iv[cable.dstInlet] = value;
      const result = evaluateBox(dst, dst._iv);
      boxValues.set(cable.dstBox, result);
      for (let i = 0; i < (def.outlets.length || 1); i++) propagate(cable.dstBox, i, result);
    }
  }
}

function setBoxValue(boxId, value) {
  boxValues.set(boxId, value);
  const box = boxes.get(boxId); if (!box) return;
  const def = getBoxDef(box.text);
  for (let i = 0; i < (def ? def.outlets.length : 1); i++) propagate(boxId, i, value);
  render();
}

function evaluateConstBoxes() {
  for (const [id, box] of boxes) {
    if (boxTypeName(box.text) === "const") setBoxValue(id, parseFloat(box.text.split(/\s+/)[1]) || 0);
  }
}

// --- patch deploy ---

function serializePatch() {
  const patchBoxes = [], patchCables = [], entries = [], synthIds = new Set();
  for (const [id, box] of boxes) {
    const def = getBoxDef(box.text); if (!def) continue;
    if (def.zone === "synth" || (def.zone === "any" && isSynthZone(box.x, box.y))) {
      synthIds.add(id);
      const name = boxTypeName(box.text), args = box.text.split(/\s+/).slice(1).join(" ");
      const isEngine = def.outlets.length === 0 && def.inlets.length > 0;
      const pb = { id, type: name, args };
      if (isEngine) { pb.engine = true; pb.paramNames = def.inlets.map(i => i.name); }
      patchBoxes.push(pb);
    }
  }
  for (const [, c] of cables) {
    if (synthIds.has(c.srcBox) && synthIds.has(c.dstBox))
      patchCables.push({ srcBox: c.srcBox, srcOutlet: c.srcOutlet, dstBox: c.dstBox, dstInlet: c.dstInlet });
  }
  for (const [id] of boxes) {
    const def = getBoxDef(boxes.get(id).text); if (!def || def.zone !== "router") continue;
    for (const c of cablesFromOutlet(id, 0))
      if (synthIds.has(c.dstBox)) entries.push({ routerId: id, targetBox: c.dstBox, targetInlet: c.dstInlet });
  }
  return { type: "patch", boxes: patchBoxes, cables: patchCables, entries };
}

function deployPatch() {
  const patch = serializePatch();
  console.log("Deploying patch:", patch);
  send(patch);
  setTimeout(evaluateConstBoxes, 100);
}

// --- WebMIDI ---

const CC_SOURCE = { 2: "breath", 1: "bite", 12: "nod", 13: "tilt" };
const MIDI_DEVICES = [{ match: ["bbc", "tecontrol", "breath controller"], sources: ["breath", "bite", "nod", "tilt"] }];
const MIDI_IGNORE = ["af16rig"];

function autoCreateSources(deviceName) {
  const lower = deviceName.toLowerCase();
  console.log("MIDI device:", deviceName);
  if (MIDI_IGNORE.some(p => lower.includes(p))) return;
  let sources = null;
  for (const dev of MIDI_DEVICES) if (dev.match.some(p => lower.includes(p))) { sources = dev.sources; break; }
  if (!sources) sources = ["key"];

  let nextY = 30, created = false;
  for (const box of boxes.values()) if (getBoxZone(box.text) === "ctrl" && box.y + BOX_HEIGHT + 10 > nextY) nextY = box.y + BOX_HEIGHT + 10;
  for (const name of sources) {
    if (findBoxByText(name) !== null) continue;
    const id = nextId++, p = getBoxPorts(name);
    boxes.set(id, { x: 20, y: nextY, text: name, inlets: p.inlets, outlets: p.outlets });
    nextY += 60; created = true;
  }
  if (created) render();
}

function onMIDIMessage(e) {
  const [status, d1, d2] = e.data, type = status & 0xf0;
  if (type === 0xb0) { const name = CC_SOURCE[d1]; if (name) { const id = findBoxByText(name); if (id !== null) setBoxValue(id, d2 / 127); } }
  else if (type === 0x90) { const id = findBoxByText("key"); if (id !== null) setBoxValue(id, d1); }
}

async function initMIDI() {
  try { midiAccess = await navigator.requestMIDIAccess(); } catch { return; }
  for (const input of midiAccess.inputs.values()) { autoCreateSources(input.name || "keyboard"); input.onmidimessage = onMIDIMessage; }
  midiAccess.onstatechange = (e) => {
    if (e.port.type === "input" && e.port.state === "connected") { autoCreateSources(e.port.name || "keyboard"); e.port.onmidimessage = onMIDIMessage; }
  };
}

initMIDI();
render();
