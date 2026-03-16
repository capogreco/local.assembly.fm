/**
 * GPI — Graphical Patching Interface
 * Canvas-based PD-style patch editor.
 * All edits are local. Cmd+Enter applies the full state to the server.
 * Cmd+Z undoes. Server sends value updates for display.
 */

import { boxTypeName, getBoxPorts, getBoxZone, getBoxDef } from "./gpi-types.js";

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
  abstractionFill: "#2a2a3a", abstractionStroke: "#668",
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
let dragSnapshot = null;
let mousePos = { x: 0, y: 0 }, editingBoxId = null;
let synthBorderY = window.innerHeight * 0.55;
let hoverTimer = null, lastHoverTarget = null;
let ws = null, wsConnected = false;
let applied = false;        // has the current state been applied?
let dirty = false;          // have we made changes since last apply?
let connectedClients = 0;
let midiDeviceNames = [];

// --- abstraction registry ---

const abstractionTypes = new Map();  // name → { inlets, outlets, def }

async function loadAbstractions() {
  try {
    const res = await fetch("/abstractions");
    const names = await res.json();
    abstractionTypes.clear();
    for (const name of names) {
      const absRes = await fetch(`/abstractions/${encodeURIComponent(name)}`);
      const data = await absRes.json();
      // Count inlet/outlet boxes to determine port counts
      let maxInlet = -1, maxOutlet = -1;
      for (const [, box] of data.boxes) {
        const type = boxTypeName(box.text);
        const idx = parseInt(box.text.split(/\s+/)[1]) || 0;
        if (type === "inlet") maxInlet = Math.max(maxInlet, idx);
        if (type === "outlet") maxOutlet = Math.max(maxOutlet, idx);
      }
      abstractionTypes.set(name, {
        inlets: maxInlet + 1,
        outlets: maxOutlet + 1,
        def: { zone: "any", description: `Abstraction: ${name}`, inlets: [], outlets: [] },
        data,
      });
    }
    console.log(`Loaded ${abstractionTypes.size} abstraction(s)`);
    render();
  } catch (e) {
    console.error("Failed to load abstractions:", e);
  }
}

function getAbstractionPorts(text) {
  const name = boxTypeName(text);
  const abs = abstractionTypes.get(name);
  if (abs) return { inlets: abs.inlets, outlets: abs.outlets };
  return null;
}

function getAbstractionDef(text) {
  const name = boxTypeName(text);
  const abs = abstractionTypes.get(name);
  return abs ? abs.def : null;
}

function isAbstraction(text) {
  return abstractionTypes.has(boxTypeName(text));
}

// Wrap gpi-types helpers to also check abstractions
function getPortsWithAbstractions(text) {
  const abs = getAbstractionPorts(text);
  if (abs) return abs;
  return getBoxPorts(text);
}

function getDefWithAbstractions(text) {
  const abs = getAbstractionDef(text);
  if (abs) return abs;
  return getBoxDef(text);
}

// Use these wrappers throughout instead of direct gpi-types calls
const getPorts = getPortsWithAbstractions;
const getDef = getDefWithAbstractions;

// --- undo stack ---

const undoStack = [];
const MAX_UNDO = 50;

function serialize() {
  return JSON.stringify({ boxes: [...boxes.entries()], cables: [...cables.entries()], nextId, synthBorderY });
}

function pushUndo() {
  undoStack.push(serialize());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  dirty = true;
}

function undo() {
  if (undoStack.length === 0) return;
  const json = undoStack.pop();
  loadFromJSON(json);
  dirty = true;
  render();
}

function loadFromJSON(json) {
  try {
    const data = JSON.parse(json);
    boxes.clear(); cables.clear();
    for (const [id, box] of data.boxes) { const p = getPorts(box.text); box.inlets = p.inlets; box.outlets = p.outlets; boxes.set(id, box); }
    for (const [id, cable] of data.cables) cables.set(id, cable);
    nextId = data.nextId || 1;
    if (data.synthBorderY !== undefined) synthBorderY = data.synthBorderY;
    selection.clear(); cableSelection.clear();
  } catch (e) { console.error("Failed to load patch:", e); }
}

// --- geometry ---

function isSynthZone(px, py) { return py >= synthBorderY; }
function hitTestSynthHandle(mx, my) {
  return Math.abs(mx - SYNTH_HANDLE) < SYNTH_HANDLE && Math.abs(my - synthBorderY) < SYNTH_HANDLE;
}

function measureText(text) { ctx.font = FONT; return ctx.measureText(text).width; }

function boxWidth(box, id) {
  let text = (id !== undefined && id === editingBoxId) ? (input.value || " ") : (box.text || " ");
  if (boxTypeName(box.text) === "print" && id !== undefined && boxValues.has(id)) {
    const v = boxValues.get(id);
    text = "print " + (typeof v === "number" ? (Number.isInteger(v) ? v.toString() : v.toFixed(4)) : String(v));
  }
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

// --- router snapping ---

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
    const def = getDef(box.text); if (!def) continue;
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
  if (boxId !== null) { const def = getDef(boxes.get(boxId).text); if (def) return { kind: "box", boxId, def, x: mx, y: my }; }
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

  // status label (top left)
  ctx.font = SMALL_FONT; ctx.textBaseline = "top";
  if (dirty) { ctx.fillStyle = "#865"; ctx.fillText("modified", 12, 8); }
  else if (applied) { ctx.fillStyle = "#686"; ctx.fillText("applied", 12, 8); }
  else { ctx.fillStyle = "#555"; ctx.fillText("edit", 12, 8); }

  // dot grid
  ctx.fillStyle = "#333";
  for (let x = 20; x < w; x += 20) for (let y = 20; y < h; y += 20) ctx.fillRect(x, y, 1, 1);

  // synth border
  ctx.strokeStyle = COLORS.synthBorder; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, synthBorderY); ctx.lineTo(w, synthBorderY); ctx.stroke();
  ctx.fillStyle = COLORS.synthHandle;
  ctx.fillRect(SYNTH_HANDLE / 2, synthBorderY - SYNTH_HANDLE / 2, SYNTH_HANDLE, SYNTH_HANDLE);
  ctx.font = SMALL_FONT; ctx.fillStyle = COLORS.synthLabel;
  ctx.textBaseline = "bottom"; ctx.fillText("ctrl", 12, synthBorderY - 6);
  ctx.textBaseline = "top"; ctx.fillText("synth", 12, synthBorderY + 6);

  // connected devices (ctrl section, right side)
  ctx.fillStyle = "#444"; ctx.textBaseline = "top"; ctx.textAlign = "right";
  if (midiDeviceNames.length > 0) {
    for (let i = 0; i < midiDeviceNames.length; i++) ctx.fillText(midiDeviceNames[i], w - 12, 12 + i * 14);
  }

  // connected clients (synth section, right side)
  ctx.fillStyle = "#444";
  ctx.fillText(connectedClients + " client" + (connectedClients !== 1 ? "s" : ""), w - 12, synthBorderY + 8);
  ctx.textAlign = "left";
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

  // marquee
  if (mode === "selecting" && dragStart) {
    const x0 = Math.min(dragStart.x, mousePos.x), y0 = Math.min(dragStart.y, mousePos.y);
    const sw = Math.abs(mousePos.x - dragStart.x), sh = Math.abs(mousePos.y - dragStart.y);
    ctx.strokeStyle = "#555"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.strokeRect(x0, y0, sw, sh);
    ctx.setLineDash([]);
  }

  // boxes
  ctx.font = FONT;
  for (const [id, box] of boxes) {
    const bw = boxWidth(box, id), selected = selection.has(id);
    const def = getDef(box.text), zone = def ? def.zone : "any";
    const isRouter = zone === "router", isUnknown = !def && box.text.length > 0;
    const isAbs = isAbstraction(box.text);

    ctx.fillStyle = selected ? COLORS.boxSelectedFill
      : isRouter ? COLORS.routerFill
      : isAbs ? COLORS.abstractionFill
      : COLORS.boxFill;
    ctx.fillRect(box.x, box.y, bw, BOX_HEIGHT);
    ctx.strokeStyle = selected ? COLORS.boxSelectedStroke
      : isRouter ? COLORS.routerStroke
      : isAbs ? COLORS.abstractionStroke
      : COLORS.boxStroke;
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
      if (boxTypeName(box.text) === "print" && boxValues.has(id)) {
        const v = boxValues.get(id);
        const display = typeof v === "number" ? (Number.isInteger(v) ? v.toString() : v.toFixed(4)) : String(v);
        ctx.fillText("print " + display, box.x + BOX_PAD_X, box.y + BOX_HEIGHT / 2);
      } else {
        ctx.fillText(box.text, box.x + BOX_PAD_X, box.y + BOX_HEIGHT / 2);
      }
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
    pushUndo();
    const newText = input.value.trim();
    box.text = newText;
    const ports = getPorts(newText);
    box.inlets = ports.inlets; box.outlets = ports.outlets;
    // prune invalid cables
    for (const [id, c] of cables) {
      if (c.srcBox === editingBoxId && c.srcOutlet >= box.outlets) cables.delete(id);
      if (c.dstBox === editingBoxId && c.dstInlet >= box.inlets) cables.delete(id);
    }
    if (isRouterType(newText)) box.y = synthBorderY - BOX_HEIGHT / 2;
    const zone = getBoxZone(newText);
    if (zone === "synth" && !isSynthZone(box.x, box.y)) box.y = synthBorderY + 20;
    else if (zone === "ctrl" && isSynthZone(box.x, box.y)) box.y = synthBorderY - BOX_HEIGHT - 20;
  } else if (!box.text) {
    pushUndo();
    for (const [id, c] of cables) if (c.srcBox === editingBoxId || c.dstBox === editingBoxId) cables.delete(id);
    boxes.delete(editingBoxId); selection.delete(editingBoxId);
  }
  editingBoxId = null; mode = "idle"; input.style.display = "none"; input.value = ""; render();
}

input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finishEditing(true); } else if (e.key === "Escape") { e.preventDefault(); finishEditing(false); } });
input.addEventListener("input", () => { if (editingBoxId === null) return; const w = Math.max(measureText(input.value || " ") + BOX_PAD_X * 2, 80); input.style.width = w + "px"; render(); });
input.addEventListener("blur", () => finishEditing(true));

// --- smart routing ---

function isSynthSide(boxId) {
  const box = boxes.get(boxId); if (!box) return false;
  const def = getDef(box.text);
  const zone = def ? def.zone : "any";
  return zone === "synth" || (zone === "any" && isSynthZone(box.x, box.y));
}

function findNearestAllRouter(nearX) {
  let best = null, bestDist = Infinity;
  for (const [id, box] of boxes) {
    if (!isRouterType(box.text) || boxTypeName(box.text) !== "all") continue;
    const dist = Math.abs(box.x + boxWidth(box, id) / 2 - nearX);
    if (dist < bestDist) { best = id; bestDist = dist; }
  }
  return best;
}

function autoRoute(srcBoxId, srcOutlet, dstBoxId, dstInlet) {
  const srcBox = boxes.get(srcBoxId), dstBox = boxes.get(dstBoxId);
  const midX = (srcBox.x + dstBox.x) / 2;
  let routerId = findNearestAllRouter(midX);

  if (routerId !== null) {
    const router = boxes.get(routerId);
    const oldChannels = parseInt(router.text.split(/\s+/)[1]) || 1;
    const newText = "all " + (oldChannels + 1);
    router.text = newText;
    const ports = getPorts(newText);
    router.inlets = ports.inlets; router.outlets = ports.outlets;
    const channel = oldChannels;
    cables.set(nextId++, { srcBox: srcBoxId, srcOutlet, dstBox: routerId, dstInlet: channel });
    cables.set(nextId++, { srcBox: routerId, srcOutlet: channel, dstBox: dstBoxId, dstInlet: dstInlet });
    sortRouterChannels(routerId);
  } else {
    routerId = nextId++;
    const ports = getPorts("all 1");
    boxes.set(routerId, { x: midX - 20, y: synthBorderY - BOX_HEIGHT / 2, text: "all 1", inlets: ports.inlets, outlets: ports.outlets });
    cables.set(nextId++, { srcBox: srcBoxId, srcOutlet, dstBox: routerId, dstInlet: 0 });
    cables.set(nextId++, { srcBox: routerId, srcOutlet: 0, dstBox: dstBoxId, dstInlet: dstInlet });
  }
}

// --- sort router channels by x-position to minimise cable tangle ---

function sortRouterChannels(routerId) {
  const router = boxes.get(routerId);
  if (!router) return;
  const channels = parseInt(router.text.split(/\s+/)[1]) || 1;

  const channelInfo = [];
  for (let ch = 0; ch < channels; ch++) {
    let ctrlX = 0;
    for (const [, c] of cables) {
      if (c.dstBox === routerId && c.dstInlet === ch) {
        const src = boxes.get(c.srcBox);
        if (src) ctrlX = src.x + boxWidth(src, c.srcBox) / 2;
        break;
      }
    }
    channelInfo.push({ ch, ctrlX });
  }

  const sorted = [...channelInfo].sort((a, b) => a.ctrlX - b.ctrlX);
  const remap = new Map();
  let changed = false;
  for (let newCh = 0; newCh < sorted.length; newCh++) {
    remap.set(sorted[newCh].ch, newCh);
    if (sorted[newCh].ch !== newCh) changed = true;
  }
  if (!changed) return;

  for (const [, c] of cables) {
    if (c.dstBox === routerId && remap.has(c.dstInlet)) c.dstInlet = remap.get(c.dstInlet);
    if (c.srcBox === routerId && remap.has(c.srcOutlet)) c.srcOutlet = remap.get(c.srcOutlet);
  }
}

// --- auto-route cables that cross the border ---

function autoRouteBorderCrossings(draggedIds) {
  // reverse: dissolve router channels where both ends are now same side
  for (const draggedId of draggedIds) {
    const dragged = boxes.get(draggedId);
    if (!dragged || isRouterType(dragged.text)) continue;
    for (const [id, box] of boxes) {
      if (!isRouterType(box.text) || boxTypeName(box.text) !== "all") continue;
      const channels = parseInt(box.text.split(/\s+/)[1]) || 1;
      for (let ch = channels - 1; ch >= 0; ch--) {
        let inCable = null, inCableId = null, outCable = null, outCableId = null;
        for (const [cid, c] of cables) {
          if (c.dstBox === id && c.dstInlet === ch) { inCable = c; inCableId = cid; }
          if (c.srcBox === id && c.srcOutlet === ch) { outCable = c; outCableId = cid; }
        }
        if (!inCable || !outCable) continue;
        if (inCable.srcBox !== draggedId && outCable.dstBox !== draggedId) continue;
        if (isSynthSide(inCable.srcBox) === isSynthSide(outCable.dstBox)) {
          cables.delete(inCableId); cables.delete(outCableId);
          cables.set(nextId++, { srcBox: inCable.srcBox, srcOutlet: inCable.srcOutlet, dstBox: outCable.dstBox, dstInlet: outCable.dstInlet });
          removeRouterChannel(id, ch);
        }
      }
    }
  }

  // forward: route cables that now cross the border
  const toReroute = [];
  for (const [cableId, c] of cables) {
    if (!draggedIds.has(c.srcBox) && !draggedIds.has(c.dstBox)) continue;
    const srcBox = boxes.get(c.srcBox), dstBox = boxes.get(c.dstBox);
    if (!srcBox || !dstBox) continue;
    if (isRouterType(srcBox.text) || isRouterType(dstBox.text)) continue;
    if (isSynthSide(c.srcBox) !== isSynthSide(c.dstBox)) {
      toReroute.push({ cableId, srcBox: c.srcBox, srcOutlet: c.srcOutlet, dstBox: c.dstBox, dstInlet: c.dstInlet });
    }
  }
  for (const r of toReroute) {
    cables.delete(r.cableId);
    autoRoute(r.srcBox, r.srcOutlet, r.dstBox, r.dstInlet);
  }
}

function removeRouterChannel(routerId, channel) {
  const router = boxes.get(routerId);
  if (!router) return;
  const oldChannels = parseInt(router.text.split(/\s+/)[1]) || 1;
  if (oldChannels <= 1) {
    for (const [cid, c] of cables) if (c.srcBox === routerId || c.dstBox === routerId) cables.delete(cid);
    boxes.delete(routerId);
    return;
  }
  router.text = "all " + (oldChannels - 1);
  const ports = getPorts(router.text);
  router.inlets = ports.inlets; router.outlets = ports.outlets;
  for (const [, c] of cables) {
    if (c.dstBox === routerId && c.dstInlet > channel) c.dstInlet--;
    if (c.srcBox === routerId && c.srcOutlet > channel) c.srcOutlet--;
  }
}

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

    // option+drag: duplicate selection
    if (e.altKey && selection.size > 0) {
      pushUndo();
      const idMap = new Map();
      const newSelection = new Set();
      for (const oldId of selection) {
        const box = boxes.get(oldId);
        if (!box) continue;
        const newId = nextId++;
        idMap.set(oldId, newId);
        boxes.set(newId, { x: box.x, y: box.y, text: box.text, inlets: box.inlets, outlets: box.outlets });
        newSelection.add(newId);
      }
      for (const [, c] of cables) {
        if (idMap.has(c.srcBox) && idMap.has(c.dstBox)) {
          cables.set(nextId++, { srcBox: idMap.get(c.srcBox), srcOutlet: c.srcOutlet, dstBox: idMap.get(c.dstBox), dstInlet: c.dstInlet });
        }
      }
      selection.clear();
      for (const id of newSelection) selection.add(id);
    }

    mode = "dragging"; dragStart = { x: m.x, y: m.y }; dragBoxPositions = new Map();
    for (const id of selection) { const b = boxes.get(id); if (b) dragBoxPositions.set(id, { x: b.x, y: b.y }); }
    dragSnapshot = {
      cables: new Map([...cables.entries()].map(([id, c]) => [id, { ...c }])),
      boxes: new Map([...boxes.entries()].map(([id, b]) => [id, { ...b }])),
      nextId,
    };
    render(); return;
  }
  const cableId = hitTestCable(m.x, m.y);
  if (cableId !== null) { selection.clear(); cableSelection.clear(); cableSelection.add(cableId); render(); return; }
  if (!e.shiftKey) { selection.clear(); cableSelection.clear(); }
  mode = "selecting"; dragStart = { x: m.x, y: m.y };
  render();
});

canvas.addEventListener("mousemove", (e) => {
  const m = canvasCoords(e); mousePos = m;
  if (mode === "resizing-synth") {
    synthBorderY = Math.max(100, Math.min(m.y, window.innerHeight - 100));
    for (const [, box] of boxes) if (isRouterType(box.text)) box.y = synthBorderY - BOX_HEIGHT / 2;
    render(); return;
  }
  if (mode === "dragging" && dragStart && dragSnapshot) {
    // restore from snapshot each frame
    cables.clear();
    for (const [id, c] of dragSnapshot.cables) cables.set(id, { ...c });
    boxes.clear();
    for (const [id, b] of dragSnapshot.boxes) boxes.set(id, { ...b });
    nextId = dragSnapshot.nextId;

    const dx = m.x - dragStart.x, dy = m.y - dragStart.y;
    for (const [id, orig] of dragBoxPositions) {
      const box = boxes.get(id); if (!box) continue;
      if (isRouterType(box.text)) { box.x = orig.x + dx; box.y = synthBorderY - BOX_HEIGHT / 2; }
      else { box.x = orig.x + dx; box.y = orig.y + dy; }
    }

    autoRouteBorderCrossings(selection);
    render(); return;
  }
  if (mode === "selecting" && dragStart) { render(); return; }
  if (mode === "cabling") { render(); return; }
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
  if (mode === "resizing-synth") {
    pushUndo();
    mode = "idle"; canvas.style.cursor = "default"; return;
  }
  if (mode === "cabling" && cableFrom) {
    const inlet = hitTestInlet(m.x, m.y);
    if (inlet && inlet.boxId !== cableFrom.boxId && !inletHasCable(inlet.boxId, inlet.index)) {
      pushUndo();
      const srcSynth = isSynthSide(cableFrom.boxId), dstSynth = isSynthSide(inlet.boxId);
      const srcBox = boxes.get(cableFrom.boxId), dstBox = boxes.get(inlet.boxId);
      if (srcSynth !== dstSynth && !isRouterType(srcBox?.text) && !isRouterType(dstBox?.text)) {
        autoRoute(cableFrom.boxId, cableFrom.index, inlet.boxId, inlet.index);
      } else {
        cables.set(nextId++, { srcBox: cableFrom.boxId, srcOutlet: cableFrom.index, dstBox: inlet.boxId, dstInlet: inlet.index });
      }
    }
    cableFrom = null; mode = "idle"; canvas.style.cursor = "default"; render(); return;
  }
  if (mode === "dragging") {
    // check if anything actually moved
    let moved = false;
    if (dragBoxPositions && dragStart) {
      for (const [id, orig] of dragBoxPositions) {
        const box = boxes.get(id);
        if (box && (box.x !== orig.x || box.y !== orig.y)) { moved = true; break; }
      }
    }
    if (moved) pushUndo();
    mode = "idle"; dragStart = null; dragBoxPositions = null; dragSnapshot = null;
  }
  if (mode === "selecting" && dragStart) {
    const x0 = Math.min(dragStart.x, m.x), y0 = Math.min(dragStart.y, m.y);
    const x1 = Math.max(dragStart.x, m.x), y1 = Math.max(dragStart.y, m.y);
    for (const [id, box] of boxes) {
      const bw = boxWidth(box, id);
      if (box.x + bw > x0 && box.x < x1 && box.y + BOX_HEIGHT > y0 && box.y < y1) selection.add(id);
    }
    mode = "idle"; dragStart = null; render();
  }
});

canvas.addEventListener("dblclick", (e) => {
  const m = canvasCoords(e);
  const boxId = hitTestBox(m.x, m.y);
  if (boxId !== null) { selection.clear(); selection.add(boxId); startEditing(boxId); return; }
  const cableId = hitTestCable(m.x, m.y);
  if (cableId !== null) {
    pushUndo();
    const cable = cables.get(cableId);
    cables.delete(cableId);
    const id = nextId++;
    boxes.set(id, { x: m.x - 15, y: m.y - BOX_HEIGHT / 2, text: "", inlets: 1, outlets: 1 });
    cables.set(nextId++, { srcBox: cable.srcBox, srcOutlet: cable.srcOutlet, dstBox: id, dstInlet: 0 });
    cables.set(nextId++, { srcBox: id, srcOutlet: 0, dstBox: cable.dstBox, dstInlet: cable.dstInlet });
    selection.clear(); selection.add(id);
    startEditing(id);
    return;
  }
  pushUndo();
  const id = nextId++;
  boxes.set(id, { x: m.x - 15, y: m.y - BOX_HEIGHT / 2, text: "", inlets: 1, outlets: 1 });
  selection.clear(); selection.add(id); startEditing(id);
});

// --- keyboard ---

window.addEventListener("keydown", (e) => {
  if (mode === "editing") return;
  // Cmd+Enter — apply to server
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); applyToServer(); return; }
  // Cmd+Z — undo
  if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); undo(); return; }
  // Cmd+Shift+S — save as abstraction
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "s") { e.preventDefault(); saveAsAbstraction(); return; }
  // Cmd+S — save patch
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); savePatchToServer(); return; }
  // Cmd+O — load patch
  if ((e.metaKey || e.ctrlKey) && e.key === "o") { e.preventDefault(); showPatchList(); return; }
  // Delete
  if (e.key === "Backspace" || e.key === "Delete") {
    if (selection.size > 0 || cableSelection.size > 0) {
      e.preventDefault();
      pushUndo();
      for (const id of selection) {
        for (const [cid, c] of cables) if (c.srcBox === id || c.dstBox === id) cables.delete(cid);
        boxes.delete(id);
      }
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

// --- WebSocket to server (GPI path) ---

function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try { ws = new WebSocket(`${proto}//${location.host}/ws/gpi`); } catch { setTimeout(connectWS, 2000); return; }
  ws.addEventListener("open", () => { wsConnected = true; render(); });
  ws.addEventListener("message", (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "state") handleState(msg);
      else if (msg.type === "values") handleValues(msg);
      else if (msg.type === "applied") handleApplied();
      else if (msg.type === "count") { connectedClients = msg.clients; render(); }
    } catch {}
  });
  ws.addEventListener("close", () => { wsConnected = false; ws = null; connectedClients = 0; render(); setTimeout(connectWS, 2000); });
  ws.addEventListener("error", () => { ws = null; });
}

function send(msg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

connectWS();

// --- Apply (Cmd+Enter) ---

function applyToServer() {
  send({
    type: "apply",
    boxes: [...boxes.entries()],
    cables: [...cables.entries()],
    nextId,
    synthBorderY,
  });
}

// --- Server message handlers ---

function handleState(msg) {
  boxes.clear(); cables.clear(); boxValues.clear();
  for (const [id, box] of msg.boxes) {
    const p = getPorts(box.text);
    box.inlets = p.inlets; box.outlets = p.outlets;
    boxes.set(id, box);
  }
  for (const [id, cable] of msg.cables) cables.set(id, cable);
  nextId = msg.nextId || 1;
  if (msg.synthBorderY !== undefined) synthBorderY = msg.synthBorderY;
  if (msg.boxValues) {
    for (const [id, v] of Object.entries(msg.boxValues)) boxValues.set(Number(id), v);
  }
  selection.clear(); cableSelection.clear();
  applied = true; dirty = false;
  undoStack.length = 0;
  render();
}

function handleValues(msg) {
  for (const u of msg.updates) boxValues.set(u.id, u.value);
  render();
}

function handleApplied() {
  applied = true; dirty = false;
  render();
}

// --- patch file save/load ---

let currentPatchName = null;

async function savePatchToServer() {
  const name = prompt("Patch name:", currentPatchName || "");
  if (!name) return;
  try {
    const res = await fetch(`/patches/${encodeURIComponent(name)}`, { method: "PUT", body: serialize() });
    if (res.ok) { currentPatchName = name; console.log("Patch saved:", name); }
  } catch (e) { console.error("Save failed:", e); }
}

async function saveAsAbstraction() {
  // Validate: patch must contain at least one inlet or outlet
  let hasInterface = false;
  for (const box of boxes.values()) {
    const type = boxTypeName(box.text);
    if (type === "inlet" || type === "outlet") { hasInterface = true; break; }
  }
  if (!hasInterface) {
    console.error("Cannot save as abstraction: patch must contain at least one inlet or outlet box");
    alert("Add inlet and/or outlet boxes to define the abstraction's interface");
    return;
  }

  const name = prompt("Abstraction name:");
  if (!name) return;

  try {
    const res = await fetch(`/abstractions/${encodeURIComponent(name)}`, { method: "PUT", body: serialize() });
    if (res.ok) {
      console.log("Abstraction saved:", name);
      await loadAbstractions();  // Refresh registry
    }
  } catch (e) { console.error("Save abstraction failed:", e); }
}

async function showPatchList() {
  try {
    const res = await fetch("/patches");
    const patches = await res.json();
    if (patches.length === 0) { console.log("No saved patches"); return; }
    const name = prompt("Load patch:\n\n" + patches.map((p, i) => `${i + 1}. ${p}`).join("\n") + "\n\nType name or number:");
    if (!name) return;
    const resolved = /^\d+$/.test(name) ? patches[parseInt(name) - 1] : name;
    if (!resolved) return;
    await loadPatchFromServer(resolved);
  } catch (e) { console.error("Load failed:", e); }
}

async function loadPatchFromServer(name) {
  try {
    const res = await fetch(`/patches/${encodeURIComponent(name)}`);
    if (!res.ok) { console.error("Patch not found:", name); return; }
    const json = await res.text();
    pushUndo();
    loadFromJSON(json);
    currentPatchName = name;
    dirty = true;
    console.log("Patch loaded:", name, "— Cmd+Enter to apply");
    render();
  } catch (e) { console.error("Load failed:", e); }
}

// --- WebMIDI ---

const CC_SOURCE = { 2: "breath", 1: "bite", 12: "nod", 13: "tilt" };
const MIDI_DEVICES = [{ match: ["bbc", "tecontrol", "breath controller"], sources: ["breath", "bite", "nod", "tilt"] }];
const MIDI_IGNORE = ["af16rig"];

function autoCreateSources(deviceName) {
  const lower = deviceName.toLowerCase();
  if (MIDI_IGNORE.some(p => lower.includes(p))) return;
  if (!midiDeviceNames.includes(deviceName)) { midiDeviceNames.push(deviceName); render(); }
  let sources = null;
  for (const dev of MIDI_DEVICES) if (dev.match.some(p => lower.includes(p))) { sources = dev.sources; break; }
  if (!sources) sources = ["key"];

  let nextY = 30, created = false;
  for (const box of boxes.values()) if (getBoxZone(box.text) === "ctrl" && box.y + BOX_HEIGHT + 10 > nextY) nextY = box.y + BOX_HEIGHT + 10;
  for (const name of sources) {
    let found = false;
    for (const box of boxes.values()) if (box.text === name) { found = true; break; }
    if (found) continue;
    const p = getPorts(name);
    boxes.set(nextId++, { x: 20, y: nextY, text: name, inlets: p.inlets, outlets: p.outlets });
    nextY += 60; created = true;
  }
  if (created) { dirty = true; render(); }
}

function onMIDIMessage(e) {
  const [status, d1, d2] = e.data, type = status & 0xf0;
  if (type === 0xb0) send({ type: "midi", cc: d1, value: d2 });
  else if (type === 0x90) send({ type: "midi", note: d1, velocity: d2 });
}

async function initMIDI() {
  try { const ma = await navigator.requestMIDIAccess(); setupMIDI(ma); } catch {}
}

function setupMIDI(ma) {
  for (const inp of ma.inputs.values()) { autoCreateSources(inp.name || "keyboard"); inp.onmidimessage = onMIDIMessage; }
  ma.onstatechange = (e) => {
    if (e.port.type === "input" && e.port.state === "connected") { autoCreateSources(e.port.name || "keyboard"); e.port.onmidimessage = onMIDIMessage; }
  };
}

initMIDI();
loadAbstractions();
render();
