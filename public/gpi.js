/**
 * GPI — Graphical Patching Interface
 * Canvas-based PD-style patch editor.
 * View/editor only — server evaluates the ctrl graph.
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
let dragSnapshot = null; // { cables, boxes, nextId } saved at drag start
let mousePos = { x: 0, y: 0 }, editingBoxId = null;
let synthBorderY = window.innerHeight * 0.55;
let hoverTimer = null, lastHoverTarget = null;
let ws = null, wsConnected = false;
let deployed = false;
let patchDirty = false;
let editMode = true;
let connectedClients = 0;
let midiDeviceNames = [];

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

// --- deploy tracking ---

let deployedSnapshot = null;

function takeDeploySnapshot() {
  const snap = { boxes: new Map(), cables: [] };
  const synthIds = new Set();
  for (const [id, box] of boxes) {
    const def = getBoxDef(box.text);
    if (!def) continue;
    if (def.zone === "synth" || def.zone === "router" || (def.zone === "any" && isSynthZone(box.x, box.y))) {
      synthIds.add(id);
      snap.boxes.set(id, {
        type: boxTypeName(box.text), args: box.text.split(/\s+/).slice(1).join(" "),
        x: box.x, y: box.y, w: boxWidth(box, id), inlets: box.inlets, outlets: box.outlets,
      });
    }
  }
  for (const [, c] of cables) {
    if (synthIds.has(c.srcBox) || synthIds.has(c.dstBox))
      snap.cables.push({ srcBox: c.srcBox, srcOutlet: c.srcOutlet, dstBox: c.dstBox, dstInlet: c.dstInlet });
  }
  return snap;
}

function markDirty(boxId) {
  if (!deployed) return;
  const box = boxes.get(boxId);
  if (!box) { patchDirty = true; return; }
  const def = getBoxDef(box.text);
  const zone = def ? def.zone : "any";
  if (zone === "synth" || zone === "router" || (zone === "any" && isSynthZone(box.x, box.y))) patchDirty = true;
}

function boxDiffState(id) {
  if (!deployedSnapshot) return null;
  const box = boxes.get(id); if (!box) return null;
  const def = getBoxDef(box.text);
  const zone = def ? def.zone : "any";
  if (zone !== "synth" && zone !== "router" && !(zone === "any" && isSynthZone(box.x, box.y))) return null;
  const snap = deployedSnapshot.boxes.get(id);
  if (!snap) return "new";
  const name = boxTypeName(box.text), args = box.text.split(/\s+/).slice(1).join(" ");
  return (snap.type !== name || snap.args !== args) ? "modified" : "unchanged";
}

function cableDiffState(cable) {
  if (!deployedSnapshot) return null;
  for (const sc of deployedSnapshot.cables) {
    if (sc.srcBox === cable.srcBox && sc.srcOutlet === cable.srcOutlet && sc.dstBox === cable.dstBox && sc.dstInlet === cable.dstInlet) return "unchanged";
  }
  return "new";
}

function getDeletedBoxes() {
  if (!deployedSnapshot) return [];
  const deleted = [];
  for (const [id, snap] of deployedSnapshot.boxes) {
    if (!boxes.has(id)) deleted.push({ id, ...snap });
  }
  return deleted;
}

function getDeletedCables() {
  if (!deployedSnapshot) return [];
  return deployedSnapshot.cables.filter(sc => {
    for (const [, c] of cables) {
      if (c.srcBox === sc.srcBox && c.srcOutlet === sc.srcOutlet && c.dstBox === sc.dstBox && c.dstInlet === sc.dstInlet) return false;
    }
    return true;
  });
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

  // mode label
  ctx.font = SMALL_FONT; ctx.fillStyle = editMode ? "#555" : "#686";
  ctx.textBaseline = "top"; ctx.fillText(editMode ? "edit" : "perform", 12, 8);

  // dot grid (edit mode only)
  if (editMode) {
    ctx.fillStyle = "#333";
    for (let x = 20; x < w; x += 20) for (let y = 20; y < h; y += 20) ctx.fillRect(x, y, 1, 1);
  }

  // synth border
  ctx.strokeStyle = COLORS.synthBorder; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, synthBorderY); ctx.lineTo(w, synthBorderY); ctx.stroke();
  if (editMode) {
    ctx.fillStyle = COLORS.synthHandle;
    ctx.fillRect(SYNTH_HANDLE / 2, synthBorderY - SYNTH_HANDLE / 2, SYNTH_HANDLE, SYNTH_HANDLE);
  }
  ctx.font = SMALL_FONT; ctx.fillStyle = COLORS.synthLabel;
  ctx.textBaseline = "bottom";
  ctx.fillText("ctrl", 12, synthBorderY - 6);
  ctx.textBaseline = "top";
  const deployLabel = !deployed ? "synth" : patchDirty ? "synth (modified)" : "synth (deployed)";
  ctx.fillStyle = !deployed ? COLORS.synthLabel : patchDirty ? "#865" : "#686";
  ctx.fillText(deployLabel, 12, synthBorderY + 6);

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

  // deleted ghost cables
  if (patchDirty && deployedSnapshot) {
    for (const sc of getDeletedCables()) {
      const srcBox = boxes.get(sc.srcBox), srcSnap = deployedSnapshot.boxes.get(sc.srcBox);
      const dstBox = boxes.get(sc.dstBox), dstSnap = deployedSnapshot.boxes.get(sc.dstBox);
      const src = srcBox || srcSnap, dst = dstBox || dstSnap;
      if (!src || !dst) continue;
      const srcW = srcBox ? boxWidth(srcBox, sc.srcBox) : srcSnap.w;
      const dstW = dstBox ? boxWidth(dstBox, sc.dstBox) : dstSnap.w;
      const srcOuts = srcBox ? srcBox.outlets : srcSnap.outlets;
      const dstIns = dstBox ? dstBox.inlets : dstSnap.inlets;
      const fromX = src.x + srcW * (sc.srcOutlet + 1) / (srcOuts + 1), fromY = src.y + BOX_HEIGHT;
      const toX = dst.x + dstW * (sc.dstInlet + 1) / (dstIns + 1), toY = dst.y;
      ctx.strokeStyle = "#865"; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(toX, toY); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // cables
  ctx.lineWidth = 1;
  for (const [id, cable] of cables) {
    const from = cableFromPos(cable), to = cableToPos(cable); if (!from || !to) continue;
    const diff = patchDirty ? cableDiffState(cable) : null;
    ctx.strokeStyle = cableSelection.has(id) ? COLORS.boxSelectedStroke : diff === "new" ? "#865" : COLORS.cable;
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

  // deleted ghost boxes
  if (patchDirty) {
    for (const ghost of getDeletedBoxes()) {
      ctx.strokeStyle = "#865"; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.strokeRect(ghost.x + 0.5, ghost.y + 0.5, ghost.w - 1, BOX_HEIGHT - 1);
      ctx.setLineDash([]);
      ctx.fillStyle = "#865"; ctx.font = FONT; ctx.textBaseline = "middle";
      ctx.globalAlpha = 0.4;
      ctx.fillText(ghost.type + (ghost.args ? " " + ghost.args : ""), ghost.x + BOX_PAD_X, ghost.y + BOX_HEIGHT / 2);
      ctx.globalAlpha = 1;
    }
  }

  // boxes
  ctx.font = FONT;
  for (const [id, box] of boxes) {
    const bw = boxWidth(box, id), selected = selection.has(id);
    const def = getBoxDef(box.text), zone = def ? def.zone : "any";
    const isRouter = zone === "router", isUnknown = !def && box.text.length > 0;
    const diff = patchDirty ? boxDiffState(id) : null;
    const isChanged = diff === "new" || diff === "modified";

    ctx.fillStyle = selected ? COLORS.boxSelectedFill : isRouter ? COLORS.routerFill : COLORS.boxFill;
    ctx.fillRect(box.x, box.y, bw, BOX_HEIGHT);
    ctx.strokeStyle = selected ? COLORS.boxSelectedStroke : isChanged ? "#865" : isRouter ? COLORS.routerStroke : COLORS.boxStroke;
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
    const newText = input.value.trim();
    sendEdit({ action: "box-text", id: editingBoxId, text: newText });
    // optimistic local update for rendering
    box.text = newText;
    const ports = getBoxPorts(newText);
    box.inlets = ports.inlets; box.outlets = ports.outlets;
    if (isRouterType(newText)) box.y = synthBorderY - BOX_HEIGHT / 2;
    const zone = getBoxZone(newText);
    if (zone === "synth" && !isSynthZone(box.x, box.y)) box.y = synthBorderY + 20;
    else if (zone === "ctrl" && isSynthZone(box.x, box.y)) box.y = synthBorderY - BOX_HEIGHT - 20;
    markDirty(editingBoxId);
  } else if (!box.text) {
    markDirty(editingBoxId);
    sendEdit({ action: "box-delete", ids: [editingBoxId] });
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
  const def = getBoxDef(box.text);
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
    // add a channel to the existing router
    const router = boxes.get(routerId);
    const oldChannels = parseInt(router.text.split(/\s+/)[1]) || 1;
    const newText = "all " + (oldChannels + 1);
    router.text = newText;
    const ports = getBoxPorts(newText);
    router.inlets = ports.inlets; router.outlets = ports.outlets;
    sendEdit({ action: "box-text", id: routerId, text: newText });
    const channel = oldChannels;

    const cableId1 = nextId++, cableId2 = nextId++;
    cables.set(cableId1, { srcBox: srcBoxId, srcOutlet, dstBox: routerId, dstInlet: channel });
    cables.set(cableId2, { srcBox: routerId, srcOutlet: channel, dstBox: dstBoxId, dstInlet: dstInlet });
    sendEdit({ action: "cable-create", id: cableId1, srcBox: srcBoxId, srcOutlet, dstBox: routerId, dstInlet: channel });
    sendEdit({ action: "cable-create", id: cableId2, srcBox: routerId, srcOutlet: channel, dstBox: dstBoxId, dstInlet: dstInlet });
    sortRouterChannels(routerId);
  } else {
    routerId = nextId++;
    const ports = getBoxPorts("all 1");
    const newRouter = { x: midX - 20, y: synthBorderY - BOX_HEIGHT / 2, text: "all 1", inlets: ports.inlets, outlets: ports.outlets };
    boxes.set(routerId, newRouter);
    sendEdit({ action: "box-create", id: routerId, x: newRouter.x, y: newRouter.y, text: "all 1" });

    const cableId1 = nextId++, cableId2 = nextId++;
    cables.set(cableId1, { srcBox: srcBoxId, srcOutlet, dstBox: routerId, dstInlet: 0 });
    cables.set(cableId2, { srcBox: routerId, srcOutlet: 0, dstBox: dstBoxId, dstInlet: dstInlet });
    sendEdit({ action: "cable-create", id: cableId1, srcBox: srcBoxId, srcOutlet, dstBox: routerId, dstInlet: 0 });
    sendEdit({ action: "cable-create", id: cableId2, srcBox: routerId, srcOutlet: 0, dstBox: dstBoxId, dstInlet: dstInlet });
  }

  markDirty(dstBoxId);
  markDirty(routerId);
}

// --- sort router channels by x-position to minimise cable tangle ---

function sortRouterChannels(routerId) {
  const router = boxes.get(routerId);
  if (!router) return;
  const channels = parseInt(router.text.split(/\s+/)[1]) || 1;

  // collect channel pairs: { ch, ctrlX } where ctrlX is the x of the ctrl-side box
  const channelInfo = [];
  for (let ch = 0; ch < channels; ch++) {
    let ctrlX = 0;
    // find the cable going INTO this channel (from ctrl side)
    for (const [, c] of cables) {
      if (c.dstBox === routerId && c.dstInlet === ch) {
        const src = boxes.get(c.srcBox);
        if (src) ctrlX = src.x + boxWidth(src, c.srcBox) / 2;
        break;
      }
    }
    channelInfo.push({ ch, ctrlX });
  }

  // sort by x position
  const sorted = [...channelInfo].sort((a, b) => a.ctrlX - b.ctrlX);

  // build old→new channel mapping
  const remap = new Map();
  let changed = false;
  for (let newCh = 0; newCh < sorted.length; newCh++) {
    remap.set(sorted[newCh].ch, newCh);
    if (sorted[newCh].ch !== newCh) changed = true;
  }
  if (!changed) return;

  // remap all cables referencing this router
  for (const [id, c] of cables) {
    if (c.dstBox === routerId && remap.has(c.dstInlet)) {
      c.dstInlet = remap.get(c.dstInlet);
      sendEdit({ action: "cable-delete", ids: [id] });
      sendEdit({ action: "cable-create", id, srcBox: c.srcBox, srcOutlet: c.srcOutlet, dstBox: c.dstBox, dstInlet: c.dstInlet });
    }
    if (c.srcBox === routerId && remap.has(c.srcOutlet)) {
      c.srcOutlet = remap.get(c.srcOutlet);
      sendEdit({ action: "cable-delete", ids: [id] });
      sendEdit({ action: "cable-create", id, srcBox: c.srcBox, srcOutlet: c.srcOutlet, dstBox: c.dstBox, dstInlet: c.dstInlet });
    }
  }
}

// --- auto-route cables that cross the border after a drag ---

function autoRouteBorderCrossings(draggedIds) {
  // --- reverse: dissolve router channels where both ends are now same side ---
  for (const draggedId of draggedIds) {
    const dragged = boxes.get(draggedId);
    if (!dragged || isRouterType(dragged.text)) continue;

    // find router cable pairs involving this dragged box
    for (const [id, box] of boxes) {
      if (!isRouterType(box.text) || boxTypeName(box.text) !== "all") continue;
      const channels = parseInt(box.text.split(/\s+/)[1]) || 1;

      for (let ch = channels - 1; ch >= 0; ch--) {
        // find cable pair: something→router[ch] and router[ch]→something
        let inCable = null, inCableId = null, outCable = null, outCableId = null;
        for (const [cid, c] of cables) {
          if (c.dstBox === id && c.dstInlet === ch) { inCable = c; inCableId = cid; }
          if (c.srcBox === id && c.srcOutlet === ch) { outCable = c; outCableId = cid; }
        }
        if (!inCable || !outCable) continue;
        // only act if the dragged box is one end
        if (inCable.srcBox !== draggedId && outCable.dstBox !== draggedId) continue;
        // check if both ends are now on the same side
        const srcSynth = isSynthSide(inCable.srcBox), dstSynth = isSynthSide(outCable.dstBox);
        if (srcSynth === dstSynth) {
          // dissolve: delete both cables, restore direct cable
          cables.delete(inCableId); cables.delete(outCableId);
          sendEdit({ action: "cable-delete", ids: [inCableId, outCableId] });
          const directId = nextId++;
          cables.set(directId, { srcBox: inCable.srcBox, srcOutlet: inCable.srcOutlet, dstBox: outCable.dstBox, dstInlet: outCable.dstInlet });
          sendEdit({ action: "cable-create", id: directId, srcBox: inCable.srcBox, srcOutlet: inCable.srcOutlet, dstBox: outCable.dstBox, dstInlet: outCable.dstInlet });
          // shrink the router
          removeRouterChannel(id, ch);
        }
      }
    }
  }

  // --- forward: route cables that now cross the border ---
  const toReroute = [];
  for (const [cableId, c] of cables) {
    if (!draggedIds.has(c.srcBox) && !draggedIds.has(c.dstBox)) continue;
    const srcBox = boxes.get(c.srcBox), dstBox = boxes.get(c.dstBox);
    if (!srcBox || !dstBox) continue;
    if (isRouterType(srcBox.text) || isRouterType(dstBox.text)) continue;
    const srcSynth = isSynthSide(c.srcBox), dstSynth = isSynthSide(c.dstBox);
    if (srcSynth !== dstSynth) {
      toReroute.push({ cableId, srcBox: c.srcBox, srcOutlet: c.srcOutlet, dstBox: c.dstBox, dstInlet: c.dstInlet });
    }
  }

  for (const r of toReroute) {
    cables.delete(r.cableId);
    sendEdit({ action: "cable-delete", ids: [r.cableId] });
    autoRoute(r.srcBox, r.srcOutlet, r.dstBox, r.dstInlet);
  }
}

function removeRouterChannel(routerId, channel) {
  const router = boxes.get(routerId);
  if (!router) return;
  const oldChannels = parseInt(router.text.split(/\s+/)[1]) || 1;
  if (oldChannels <= 1) {
    // last channel — delete the router entirely
    for (const [cid, c] of cables) if (c.srcBox === routerId || c.dstBox === routerId) {
      cables.delete(cid);
      sendEdit({ action: "cable-delete", ids: [cid] });
    }
    boxes.delete(routerId);
    sendEdit({ action: "box-delete", ids: [routerId] });
    return;
  }
  // shrink channel count
  const newText = "all " + (oldChannels - 1);
  router.text = newText;
  const ports = getBoxPorts(newText);
  router.inlets = ports.inlets; router.outlets = ports.outlets;
  sendEdit({ action: "box-text", id: routerId, text: newText });
  // shift cables on higher channels down by 1
  for (const [, c] of cables) {
    if (c.dstBox === routerId && c.dstInlet > channel) c.dstInlet--;
    if (c.srcBox === routerId && c.srcOutlet > channel) c.srcOutlet--;
  }
}

// --- mouse ---

function canvasCoords(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

canvas.addEventListener("mousedown", (e) => {
  const m = canvasCoords(e); hideTooltip();
  if (!editMode) {
    const boxId = hitTestBox(m.x, m.y);
    if (boxId !== null) {
      const box = boxes.get(boxId), name = boxTypeName(box.text);
      if (name === "toggle") {
        // send toggle as a midi-like message — server handles it
      }
    }
    return;
  }
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
      const idMap = new Map(); // old id → new id
      const newSelection = new Set();
      for (const oldId of selection) {
        const box = boxes.get(oldId);
        if (!box) continue;
        const newId = nextId++;
        idMap.set(oldId, newId);
        const dup = { x: box.x, y: box.y, text: box.text, inlets: box.inlets, outlets: box.outlets };
        boxes.set(newId, dup);
        sendEdit({ action: "box-create", id: newId, x: dup.x, y: dup.y, text: dup.text });
        newSelection.add(newId);
      }
      // duplicate cables between selected boxes
      for (const [, c] of cables) {
        if (idMap.has(c.srcBox) && idMap.has(c.dstBox)) {
          const cableId = nextId++;
          const dup = { srcBox: idMap.get(c.srcBox), srcOutlet: c.srcOutlet, dstBox: idMap.get(c.dstBox), dstInlet: c.dstInlet };
          cables.set(cableId, dup);
          sendEdit({ action: "cable-create", id: cableId, ...dup });
        }
      }
      selection.clear();
      for (const id of newSelection) selection.add(id);
    }

    mode = "dragging"; dragStart = { x: m.x, y: m.y }; dragBoxPositions = new Map();
    for (const id of selection) { const b = boxes.get(id); if (b) dragBoxPositions.set(id, { x: b.x, y: b.y }); }
    // snapshot cables and routers so we can restore each frame during drag
    dragSnapshot = {
      cables: new Map([...cables.entries()].map(([id, c]) => [id, { ...c }])),
      boxes: new Map([...boxes.entries()].map(([id, b]) => [id, { ...b }])),
      nextId,
    };
    editQueue = [];
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
    // restore cables and boxes from snapshot each frame
    cables.clear();
    for (const [id, c] of dragSnapshot.cables) cables.set(id, { ...c });
    boxes.clear();
    for (const [id, b] of dragSnapshot.boxes) boxes.set(id, { ...b });
    nextId = dragSnapshot.nextId;
    editQueue = [];

    // apply drag offset to selected boxes
    const dx = m.x - dragStart.x, dy = m.y - dragStart.y;
    for (const [id, orig] of dragBoxPositions) {
      const box = boxes.get(id); if (!box) continue;
      if (isRouterType(box.text)) { box.x = orig.x + dx; box.y = synthBorderY - BOX_HEIGHT / 2; }
      else { box.x = orig.x + dx; box.y = orig.y + dy; }
    }

    // recompute auto-routing from clean state
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
    sendEdit({ action: "border-move", y: synthBorderY });
    mode = "idle"; canvas.style.cursor = "default"; return;
  }
  if (mode === "cabling" && cableFrom) {
    const inlet = hitTestInlet(m.x, m.y);
    if (inlet && inlet.boxId !== cableFrom.boxId && !inletHasCable(inlet.boxId, inlet.index)) {
      const srcBox = boxes.get(cableFrom.boxId), dstBox = boxes.get(inlet.boxId);
      const srcSynth = isSynthSide(cableFrom.boxId), dstSynth = isSynthSide(inlet.boxId);
      if (srcSynth !== dstSynth && !isRouterType(srcBox?.text) && !isRouterType(dstBox?.text)) {
        autoRoute(cableFrom.boxId, cableFrom.index, inlet.boxId, inlet.index);
      } else {
        const cableId = nextId++;
        cables.set(cableId, { srcBox: cableFrom.boxId, srcOutlet: cableFrom.index, dstBox: inlet.boxId, dstInlet: inlet.index });
        sendEdit({ action: "cable-create", id: cableId, srcBox: cableFrom.boxId, srcOutlet: cableFrom.index, dstBox: inlet.boxId, dstInlet: inlet.index });
        markDirty(inlet.boxId); markDirty(cableFrom.boxId);
      }
    }
    cableFrom = null; mode = "idle"; canvas.style.cursor = "default"; render(); return;
  }
  if (mode === "dragging") {
    if (dragBoxPositions) {
      // editQueue already has the auto-routing edits from the last mousemove frame
      // prepend the box-move edit, then flush everything
      const moves = [];
      for (const id of selection) {
        const box = boxes.get(id);
        if (box) moves.push({ id, x: box.x, y: box.y });
      }
      const routingEdits = editQueue || [];
      editQueue = null;
      if (moves.length > 0) send({ type: "edit", action: "box-move", moves });
      for (const edit of routingEdits) send({ type: "edit", ...edit });
    }
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
  if (!editMode) return;
  const m = canvasCoords(e);
  const boxId = hitTestBox(m.x, m.y);
  if (boxId !== null) { selection.clear(); selection.add(boxId); startEditing(boxId); return; }
  const cableId = hitTestCable(m.x, m.y);
  if (cableId !== null) {
    const cable = cables.get(cableId);
    cables.delete(cableId);
    sendEdit({ action: "cable-delete", ids: [cableId] });
    const id = nextId++;
    boxes.set(id, { x: m.x - 15, y: m.y - BOX_HEIGHT / 2, text: "", inlets: 1, outlets: 1 });
    sendEdit({ action: "box-create", id, x: m.x - 15, y: m.y - BOX_HEIGHT / 2, text: "" });
    const cid1 = nextId++, cid2 = nextId++;
    cables.set(cid1, { srcBox: cable.srcBox, srcOutlet: cable.srcOutlet, dstBox: id, dstInlet: 0 });
    cables.set(cid2, { srcBox: id, srcOutlet: 0, dstBox: cable.dstBox, dstInlet: cable.dstInlet });
    sendEdit({ action: "cable-create", id: cid1, srcBox: cable.srcBox, srcOutlet: cable.srcOutlet, dstBox: id, dstInlet: 0 });
    sendEdit({ action: "cable-create", id: cid2, srcBox: id, srcOutlet: 0, dstBox: cable.dstBox, dstInlet: cable.dstInlet });
    selection.clear(); selection.add(id);
    startEditing(id);
    return;
  }
  const id = nextId++;
  boxes.set(id, { x: m.x - 15, y: m.y - BOX_HEIGHT / 2, text: "", inlets: 1, outlets: 1 });
  sendEdit({ action: "box-create", id, x: m.x - 15, y: m.y - BOX_HEIGHT / 2, text: "" });
  selection.clear(); selection.add(id); startEditing(id);
});

// --- keyboard ---

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "e") {
    e.preventDefault();
    editMode = !editMode;
    selection.clear(); cableSelection.clear();
    canvas.style.cursor = "default";
    if (mode === "cabling") { mode = "idle"; cableFrom = null; }
    render();
    return;
  }
  if (!editMode && e.key === "Escape") { editMode = true; render(); return; }
  if (mode === "editing") return;
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); savePatchToServer(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "o") { e.preventDefault(); showPatchList(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendEdit({ action: "deploy" }); return; }
  if (!editMode) return;
  if (e.key === "Backspace" || e.key === "Delete") {
    if (selection.size > 0 || cableSelection.size > 0) {
      e.preventDefault();
      if (selection.size > 0) {
        const ids = [...selection];
        for (const id of ids) {
          markDirty(id);
          // remove local cables
          for (const [cid, c] of cables) if (c.srcBox === id || c.dstBox === id) cables.delete(cid);
          boxes.delete(id);
        }
        sendEdit({ action: "box-delete", ids });
      }
      if (cableSelection.size > 0) {
        const ids = [...cableSelection];
        for (const id of ids) {
          const c = cables.get(id);
          if (c) { markDirty(c.srcBox); markDirty(c.dstBox); }
          cables.delete(id);
        }
        sendEdit({ action: "cable-delete", ids });
      }
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
      else if (msg.type === "deployed") handleDeployed();
      else if (msg.type === "count") { connectedClients = msg.clients; render(); }
    } catch {}
  });
  ws.addEventListener("close", () => { wsConnected = false; ws = null; connectedClients = 0; render(); setTimeout(connectWS, 2000); });
  ws.addEventListener("error", () => { ws = null; });
}

function send(msg) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

let editQueue = null; // null = send immediately, [] = buffering
function sendEdit(edit) {
  if (editQueue) editQueue.push(edit);
  else send({ type: "edit", ...edit });
}
function flushEdits() {
  if (!editQueue) return;
  for (const edit of editQueue) send({ type: "edit", ...edit });
  editQueue = null;
}

connectWS();

// --- Server message handlers ---

function handleState(msg) {
  boxes.clear(); cables.clear(); boxValues.clear();
  for (const [id, box] of msg.boxes) {
    const p = getBoxPorts(box.text);
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
  render();
}

function handleValues(msg) {
  for (const u of msg.updates) boxValues.set(u.id, u.value);
  render();
}

function handleDeployed() {
  deployed = true;
  deployedSnapshot = takeDeploySnapshot();
  patchDirty = false;
  render();
}

// --- patch file save/load ---

let currentPatchName = null;

async function savePatchToServer() {
  const name = prompt("Patch name:", currentPatchName || "");
  if (!name) return;
  try {
    const res = await fetch(`/patches/${encodeURIComponent(name)}`, { method: "PUT" });
    if (res.ok) { currentPatchName = name; console.log("Patch saved:", name); }
  } catch (e) { console.error("Save failed:", e); }
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
    currentPatchName = name;
    console.log("Patch loaded:", name);
    // Server restores state from the file and sends us a state message
    // Then deploy
    sendEdit({ action: "deploy" });
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

  // auto-create source boxes on the server
  let nextY = 30;
  for (const box of boxes.values()) if (getBoxZone(box.text) === "ctrl" && box.y + BOX_HEIGHT + 10 > nextY) nextY = box.y + BOX_HEIGHT + 10;
  for (const name of sources) {
    let found = false;
    for (const box of boxes.values()) if (box.text === name) { found = true; break; }
    if (found) continue;
    const id = nextId++;
    const p = getBoxPorts(name);
    boxes.set(id, { x: 20, y: nextY, text: name, inlets: p.inlets, outlets: p.outlets });
    sendEdit({ action: "box-create", id, x: 20, y: nextY, text: name });
    nextY += 60;
  }
}

function onMIDIMessage(e) {
  const [status, d1, d2] = e.data, type = status & 0xf0;
  if (type === 0xb0) {
    send({ type: "midi", cc: d1, value: d2 });
  } else if (type === 0x90) {
    send({ type: "midi", note: d1, velocity: d2 });
  }
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
render();
