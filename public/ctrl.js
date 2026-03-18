/**
 * Ctrl — Graphical Patching Interface + ctrl-side engine host
 * Canvas-based PD-style patch editor.
 * All edits are local. Cmd+Enter applies the full state to the server.
 * Cmd+Z undoes. Server sends value updates for display.
 * Also hosts ctrl-side engines (above-border) with audio output to laptop speakers.
 */

import { boxTypeName, getBoxPorts, getBoxZone, getBoxDef } from "./gpi-types.js";

// DOM elements
const canvas = document.getElementById("c");
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
  commentText: "#888",
};
const BOX_HEIGHT = 22, BOX_PAD_X = 8, PORT_W = 8, PORT_H = 3, PORT_HIT = 8, SYNTH_HANDLE = 8;
const FONT = '12px "IBM Plex Mono", "Fira Mono", "Courier New", monospace';
const SMALL_FONT = '10px "IBM Plex Mono", monospace';
const COMMENT_FONT = 'italic 12px "IBM Plex Mono", "Fira Mono", "Courier New", monospace';

// --- global state ---

let ws = null, wsConnected = false;
let connectedClients = 0;
let midiDeviceNames = [];
let currentPatchName = null;

// --- ctrl-side audio engine ---

let ctrlAudioCtx = null;
let ctrlMasterGain = null;
const ctrlEngines = new Map(); // boxId -> { type, worklet, ... }
const ctrlWorkletModulesLoaded = new Set();

const ENGINES = {
  formant:          { module: "processor.js",       worklet: "voice-processor",  channels: 4 },
  "karplus-strong": { module: "ks-processor.js",    worklet: "ks-processor",     channels: 1 },
  "sine-osc":       { module: "sine-processor.js",  worklet: "sine-processor",   channels: 1 },
  noise:            { module: "noise-processor.js", worklet: "noise-processor",  channels: 1 },
};

async function initCtrlAudio() {
  if (ctrlAudioCtx) return;
  ctrlAudioCtx = new AudioContext();
  await ctrlAudioCtx.resume();
  ctrlMasterGain = ctrlAudioCtx.createGain();
  ctrlMasterGain.connect(ctrlAudioCtx.destination);
}

async function createCtrlEngine(type, boxId) {
  const def = ENGINES[type];
  if (!def || !ctrlAudioCtx) return null;
  if (!ctrlWorkletModulesLoaded.has(def.module)) {
    await ctrlAudioCtx.audioWorklet.addModule(def.module);
    ctrlWorkletModulesLoaded.add(def.module);
  }
  const opts = def.channels > 1 ? { outputChannelCount: [def.channels] } : {};
  const worklet = new AudioWorkletNode(ctrlAudioCtx, def.worklet, opts);
  if (def.channels > 1) {
    const splitter = ctrlAudioCtx.createChannelSplitter(def.channels);
    worklet.connect(splitter);
    const out = ctrlAudioCtx.createGain();
    splitter.connect(out, 0);
    out.connect(ctrlMasterGain);
    return { type, worklet, splitter, out };
  }
  worklet.connect(ctrlMasterGain);
  return { type, worklet };
}

function handleEngineParam(msg) {
  const engine = ctrlEngines.get(msg.boxId);
  if (engine?.worklet) {
    engine.worklet.port.postMessage({ type: "params", [msg.param]: msg.value });
  } else if (msg.engineType && !ctrlEngines.has(msg.boxId)) {
    // lazily create engine on first param message
    initCtrlAudio().then(() => {
      createCtrlEngine(msg.engineType, msg.boxId).then((eng) => {
        if (eng) {
          ctrlEngines.set(msg.boxId, eng);
          eng.worklet.port.postMessage({ type: "params", [msg.param]: msg.value });
        }
      });
    });
  }
}

// --- abstraction registry ---

const abstractionTypes = new Map();

async function loadAbstractions() {
  try {
    const res = await fetch("/abstractions");
    const names = await res.json();
    abstractionTypes.clear();
    for (const name of names) {
      const absRes = await fetch(`/abstractions/${encodeURIComponent(name)}`);
      const data = await absRes.json();
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
    mainEditor?.render();
  } catch (e) {
    console.error("Failed to load abstractions:", e);
  }
}

function isAbstraction(text) {
  return abstractionTypes.has(boxTypeName(text));
}

function getPorts(text) {
  const name = boxTypeName(text);
  const abs = abstractionTypes.get(name);
  if (abs) return { inlets: abs.inlets, outlets: abs.outlets };
  return getBoxPorts(text);
}

function getDef(text) {
  const name = boxTypeName(text);
  const abs = abstractionTypes.get(name);
  if (abs) return abs.def;
  return getBoxDef(text);
}

// --- utility ---

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// =============================================================================
// PatchEditor Class
// =============================================================================

class PatchEditor {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.input = options.input ?? null;

    // Patch data
    this.boxes = new Map();
    this.cables = new Map();
    this.nextId = 1;

    // Selection
    this.selection = new Set();
    this.cableSelection = new Set();

    // Runtime values
    this.boxValues = new Map();

    // Interaction state
    this.mode = "idle";
    this.dragStart = null;
    this.dragBoxPositions = null;
    this.cableFrom = null;
    this.dragSnapshot = null;
    this.mousePos = { x: 0, y: 0 };
    this.editingBoxId = null;

    // Layout
    this.synthBorderY = options.synthBorderY ?? canvas.height * 0.55;
    this.showSynthBorder = options.showSynthBorder ?? true;

    // Undo
    this.undoStack = [];
    this.maxUndo = 50;

    // Status
    this.dirty = false;
    this.applied = false;

    // Callbacks
    this.onDirty = options.onDirty ?? (() => {});
    this.renderOverlay = options.renderOverlay ?? (() => {});

    // Bind handlers
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onDblClick = this._onDblClick.bind(this);
  }

  bindEvents() {
    this.canvas.addEventListener("mousedown", this._onMouseDown);
    this.canvas.addEventListener("mousemove", this._onMouseMove);
    this.canvas.addEventListener("mouseup", this._onMouseUp);
    this.canvas.addEventListener("dblclick", this._onDblClick);
  }

  unbindEvents() {
    this.canvas.removeEventListener("mousedown", this._onMouseDown);
    this.canvas.removeEventListener("mousemove", this._onMouseMove);
    this.canvas.removeEventListener("mouseup", this._onMouseUp);
    this.canvas.removeEventListener("dblclick", this._onDblClick);
  }

  // --- Serialization ---

  serialize() {
    return JSON.stringify({
      boxes: [...this.boxes.entries()],
      cables: [...this.cables.entries()],
      nextId: this.nextId,
      synthBorderY: this.synthBorderY
    });
  }

  load(data) {
    if (typeof data === "string") data = JSON.parse(data);
    this.boxes.clear();
    this.cables.clear();
    for (const [id, box] of data.boxes) {
      const p = getPorts(box.text);
      box.inlets = p.inlets;
      box.outlets = p.outlets;
      this.boxes.set(id, box);
    }
    for (const [id, cable] of data.cables) this.cables.set(id, cable);
    this.nextId = data.nextId || 1;
    if (data.synthBorderY !== undefined) this.synthBorderY = data.synthBorderY;
    // Fix router Y positions to always be at border
    for (const [, box] of this.boxes) {
      if (this.isRouterType(box.text)) {
        box.y = this.synthBorderY - BOX_HEIGHT / 2;
      }
    }
    this.selection.clear();
    this.cableSelection.clear();
    // Auto-resize canvas to fit all boxes
    this.ensureAllBoxesVisible();
  }

  ensureAllBoxesVisible() {
    if (this.boxes.size === 0) return;

    const margin = 50;
    const dpr = window.devicePixelRatio || 1;
    const viewportWidth = this.canvas.width / dpr;
    const viewportHeight = this.canvas.height / dpr;
    const centerX = viewportWidth / 2;
    const boxWidth = 200; // Approximate

    // Find maximum distance out of bounds (as percentage)
    let maxOutX = 0;
    let maxOutYCtrl = 0;
    let maxOutYSynth = 0;

    for (const box of this.boxes.values()) {
      if (this.isRouterType(box.text)) continue;

      // Check X bounds
      if (box.x < margin) {
        maxOutX = Math.max(maxOutX, (margin - box.x) / viewportWidth);
      } else if (box.x + boxWidth > viewportWidth - margin) {
        maxOutX = Math.max(maxOutX, (box.x + boxWidth - (viewportWidth - margin)) / viewportWidth);
      }

      // Check Y bounds
      if (box.y < this.synthBorderY) {
        // Ctrl zone
        if (box.y < margin) {
          maxOutYCtrl = Math.max(maxOutYCtrl, (margin - box.y) / this.synthBorderY);
        } else if (box.y + BOX_HEIGHT > this.synthBorderY - margin) {
          maxOutYCtrl = Math.max(maxOutYCtrl, (box.y + BOX_HEIGHT - (this.synthBorderY - margin)) / this.synthBorderY);
        }
      } else {
        // Synth zone
        const synthZoneHeight = viewportHeight - this.synthBorderY;
        if (box.y < this.synthBorderY + margin) {
          maxOutYSynth = Math.max(maxOutYSynth, (this.synthBorderY + margin - box.y) / synthZoneHeight);
        } else if (box.y + BOX_HEIGHT > viewportHeight - margin) {
          maxOutYSynth = Math.max(maxOutYSynth, (box.y + BOX_HEIGHT - (viewportHeight - margin)) / synthZoneHeight);
        }
      }
    }

    // Nudge all boxes by the maximum percentage needed
    for (const box of this.boxes.values()) {
      if (this.isRouterType(box.text)) continue;

      // Nudge X toward center
      if (maxOutX > 0) {
        box.x += (centerX - box.x) * maxOutX;
      }

      // Nudge Y toward border
      if (box.y < this.synthBorderY) {
        if (maxOutYCtrl > 0) {
          const targetY = this.synthBorderY - BOX_HEIGHT - margin;
          box.y += (targetY - box.y) * maxOutYCtrl;
        }
      } else {
        if (maxOutYSynth > 0) {
          const targetY = this.synthBorderY + margin;
          box.y += (targetY - box.y) * maxOutYSynth;
        }
      }
    }
  }

  getBounds(boxes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const boxWidth = 200; // Approximate box width
    const boxHeight = 40; // Approximate box height

    for (const box of boxes) {
      if (box.x < minX) minX = box.x;
      if (box.y < minY) minY = box.y;
      if (box.x + boxWidth > maxX) maxX = box.x + boxWidth;
      if (box.y + boxHeight > maxY) maxY = box.y + boxHeight;
    }

    return { minX, minY, maxX, maxY };
  }

  // --- Undo ---

  pushUndo() {
    this.undoStack.push(this.serialize());
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.dirty = true;
    this.onDirty();
  }

  undo() {
    if (this.undoStack.length === 0) return;
    this.load(this.undoStack.pop());
    this.dirty = true;
    this.onDirty();
    this.render();
  }

  // --- Geometry ---

  canvasCoords(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  isSynthZone(y) { return y >= this.synthBorderY; }

  hitTestSynthHandle(mx, my) {
    if (!this.showSynthBorder) return false;
    return Math.abs(mx - SYNTH_HANDLE) < SYNTH_HANDLE && Math.abs(my - this.synthBorderY) < SYNTH_HANDLE;
  }

  measureText(text) {
    this.ctx.font = FONT;
    return this.ctx.measureText(text).width;
  }

  boxWidth(box, id) {
    let text = (id !== undefined && id === this.editingBoxId && this.input)
      ? (this.input.value || " ") : (box.text || " ");
    if (boxTypeName(box.text) === "print" && id !== undefined && this.boxValues.has(id)) {
      const v = this.boxValues.get(id);
      text = "print " + (typeof v === "number" ? (Number.isInteger(v) ? v.toString() : v.toFixed(4)) : String(v));
    }
    return Math.ceil(Math.max(this.measureText(text) + BOX_PAD_X * 2, (Math.max(box.inlets, box.outlets) + 1) * (PORT_W + 4), 30));
  }

  inletPos(box, i, id) {
    const w = this.boxWidth(box, id), s = w / (box.inlets + 1);
    return { x: box.x + s * (i + 1), y: box.y };
  }

  outletPos(box, i, id) {
    const w = this.boxWidth(box, id), s = w / (box.outlets + 1);
    return { x: box.x + s * (i + 1), y: box.y + BOX_HEIGHT };
  }

  // --- Hit Testing ---

  hitTestOutlet(mx, my) {
    for (const [id, box] of this.boxes) {
      for (let i = 0; i < box.outlets; i++) {
        const p = this.outletPos(box, i, id);
        if (Math.abs(mx - p.x) < PORT_HIT && Math.abs(my - p.y) < PORT_HIT) return { boxId: id, index: i };
      }
    }
    return null;
  }

  hitTestInlet(mx, my) {
    for (const [id, box] of this.boxes) {
      for (let i = 0; i < box.inlets; i++) {
        const p = this.inletPos(box, i, id);
        if (Math.abs(mx - p.x) < PORT_HIT && Math.abs(my - p.y) < PORT_HIT) return { boxId: id, index: i };
      }
    }
    return null;
  }

  hitTestBox(mx, my) {
    for (const [id, box] of [...this.boxes.entries()].reverse()) {
      const w = this.boxWidth(box, id);
      if (mx >= box.x && mx <= box.x + w && my >= box.y && my <= box.y + BOX_HEIGHT) return id;
    }
    return null;
  }

  hitTestCable(mx, my) {
    for (const [id, cable] of this.cables) {
      const from = this.cableFromPos(cable), to = this.cableToPos(cable);
      if (from && to && distToSeg(mx, my, from.x, from.y, to.x, to.y) < 4) return id;
    }
    return null;
  }

  cableFromPos(c) {
    const b = this.boxes.get(c.srcBox);
    return b ? this.outletPos(b, c.srcOutlet, c.srcBox) : null;
  }

  cableToPos(c) {
    const b = this.boxes.get(c.dstBox);
    return b ? this.inletPos(b, c.dstInlet, c.dstBox) : null;
  }

  inletHasCable(boxId, inlet) {
    for (const c of this.cables.values()) {
      if (c.dstBox === boxId && c.dstInlet === inlet) return true;
    }
    return false;
  }

  // --- Routing ---

  isSynthSide(boxId) {
    const box = this.boxes.get(boxId);
    if (!box) return false;
    const def = getDef(box.text);
    const zone = def ? def.zone : "any";
    return zone === "synth" || (zone === "any" && this.isSynthZone(box.y));
  }

  isRouterType(text) { return getBoxZone(text) === "router"; }

  findNearestAllRouter(nearX) {
    let best = null, bestDist = Infinity;
    for (const [id, box] of this.boxes) {
      if (!this.isRouterType(box.text) || boxTypeName(box.text) !== "all") continue;
      const dist = Math.abs(box.x + this.boxWidth(box, id) / 2 - nearX);
      if (dist < bestDist) { best = id; bestDist = dist; }
    }
    return best;
  }

  autoRoute(srcBoxId, srcOutlet, dstBoxId, dstInlet) {
    const srcBox = this.boxes.get(srcBoxId), dstBox = this.boxes.get(dstBoxId);
    const midX = (srcBox.x + dstBox.x) / 2;
    let routerId = this.findNearestAllRouter(midX);

    if (routerId !== null) {
      const router = this.boxes.get(routerId);
      const oldChannels = parseInt(router.text.split(/\s+/)[1]) || 1;
      router.text = "all " + (oldChannels + 1);
      const ports = getPorts(router.text);
      router.inlets = ports.inlets;
      router.outlets = ports.outlets;
      const channel = oldChannels;
      this.cables.set(this.nextId++, { srcBox: srcBoxId, srcOutlet, dstBox: routerId, dstInlet: channel });
      this.cables.set(this.nextId++, { srcBox: routerId, srcOutlet: channel, dstBox: dstBoxId, dstInlet });
      this.sortRouterChannels(routerId);
    } else {
      routerId = this.nextId++;
      const ports = getPorts("all 1");
      this.boxes.set(routerId, { x: midX - 20, y: this.synthBorderY - BOX_HEIGHT / 2, text: "all 1", inlets: ports.inlets, outlets: ports.outlets });
      this.cables.set(this.nextId++, { srcBox: srcBoxId, srcOutlet, dstBox: routerId, dstInlet: 0 });
      this.cables.set(this.nextId++, { srcBox: routerId, srcOutlet: 0, dstBox: dstBoxId, dstInlet });
    }
  }

  sortRouterChannels(routerId) {
    const router = this.boxes.get(routerId);
    if (!router) return;
    const channels = parseInt(router.text.split(/\s+/)[1]) || 1;
    const channelInfo = [];
    for (let ch = 0; ch < channels; ch++) {
      let ctrlX = 0;
      for (const [, c] of this.cables) {
        if (c.dstBox === routerId && c.dstInlet === ch) {
          const src = this.boxes.get(c.srcBox);
          if (src) ctrlX = src.x + this.boxWidth(src, c.srcBox) / 2;
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
    for (const [, c] of this.cables) {
      if (c.dstBox === routerId && remap.has(c.dstInlet)) c.dstInlet = remap.get(c.dstInlet);
      if (c.srcBox === routerId && remap.has(c.srcOutlet)) c.srcOutlet = remap.get(c.srcOutlet);
    }
  }

  removeRouterChannel(routerId, channel) {
    const router = this.boxes.get(routerId);
    if (!router) return;
    const oldChannels = parseInt(router.text.split(/\s+/)[1]) || 1;
    if (oldChannels <= 1) {
      for (const [cid, c] of this.cables) {
        if (c.srcBox === routerId || c.dstBox === routerId) this.cables.delete(cid);
      }
      this.boxes.delete(routerId);
      return;
    }
    router.text = "all " + (oldChannels - 1);
    const ports = getPorts(router.text);
    router.inlets = ports.inlets;
    router.outlets = ports.outlets;
    for (const [, c] of this.cables) {
      if (c.dstBox === routerId && c.dstInlet > channel) c.dstInlet--;
      if (c.srcBox === routerId && c.srcOutlet > channel) c.srcOutlet--;
    }
  }

  autoRouteBorderCrossings(draggedIds) {
    // Dissolve router channels where both ends now same side
    for (const draggedId of draggedIds) {
      const dragged = this.boxes.get(draggedId);
      if (!dragged || this.isRouterType(dragged.text)) continue;
      for (const [id, box] of this.boxes) {
        if (!this.isRouterType(box.text) || boxTypeName(box.text) !== "all") continue;
        const channels = parseInt(box.text.split(/\s+/)[1]) || 1;
        for (let ch = channels - 1; ch >= 0; ch--) {
          let inCable = null, inCableId = null, outCable = null, outCableId = null;
          for (const [cid, c] of this.cables) {
            if (c.dstBox === id && c.dstInlet === ch) { inCable = c; inCableId = cid; }
            if (c.srcBox === id && c.srcOutlet === ch) { outCable = c; outCableId = cid; }
          }
          if (!inCable || !outCable) continue;
          if (inCable.srcBox !== draggedId && outCable.dstBox !== draggedId) continue;
          if (this.isSynthSide(inCable.srcBox) === this.isSynthSide(outCable.dstBox)) {
            this.cables.delete(inCableId);
            this.cables.delete(outCableId);
            this.cables.set(this.nextId++, { srcBox: inCable.srcBox, srcOutlet: inCable.srcOutlet, dstBox: outCable.dstBox, dstInlet: outCable.dstInlet });
            this.removeRouterChannel(id, ch);
          }
        }
      }
    }
    // Route cables that now cross border
    const toReroute = [];
    for (const [cableId, c] of this.cables) {
      if (!draggedIds.has(c.srcBox) && !draggedIds.has(c.dstBox)) continue;
      const srcBox = this.boxes.get(c.srcBox), dstBox = this.boxes.get(c.dstBox);
      if (!srcBox || !dstBox) continue;
      if (this.isRouterType(srcBox.text) || this.isRouterType(dstBox.text)) continue;
      if (this.isSynthSide(c.srcBox) !== this.isSynthSide(c.dstBox)) {
        toReroute.push({ cableId, srcBox: c.srcBox, srcOutlet: c.srcOutlet, dstBox: c.dstBox, dstInlet: c.dstInlet });
      }
    }
    for (const r of toReroute) {
      this.cables.delete(r.cableId);
      this.autoRoute(r.srcBox, r.srcOutlet, r.dstBox, r.dstInlet);
    }
  }

  // --- Render ---

  render() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.scale(dpr, dpr);

    this.ctx.fillStyle = COLORS.bg;
    this.ctx.fillRect(0, 0, w, h);

    // Dot grid
    this.ctx.fillStyle = "#333";
    for (let x = 20; x < w; x += 20) {
      for (let y = 20; y < h; y += 20) {
        this.ctx.fillRect(x, y, 1, 1);
      }
    }

    // Synth border
    if (this.showSynthBorder) {
      this.ctx.strokeStyle = COLORS.synthBorder;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(0, this.synthBorderY);
      this.ctx.lineTo(w, this.synthBorderY);
      this.ctx.stroke();
      this.ctx.fillStyle = COLORS.synthHandle;
      this.ctx.fillRect(SYNTH_HANDLE / 2, this.synthBorderY - SYNTH_HANDLE / 2, SYNTH_HANDLE, SYNTH_HANDLE);
      this.ctx.font = SMALL_FONT;
      this.ctx.fillStyle = COLORS.synthLabel;
      this.ctx.textBaseline = "bottom";
      this.ctx.fillText("ctrl", 12, this.synthBorderY - 6);
      this.ctx.textBaseline = "top";
      this.ctx.fillText("synth", 12, this.synthBorderY + 6);
    }

    // Cables
    this.ctx.lineWidth = 1;
    for (const [id, cable] of this.cables) {
      const from = this.cableFromPos(cable), to = this.cableToPos(cable);
      if (!from || !to) continue;
      this.ctx.strokeStyle = this.cableSelection.has(id) ? COLORS.boxSelectedStroke : COLORS.cable;
      this.ctx.beginPath();
      this.ctx.moveTo(from.x, from.y);
      this.ctx.lineTo(to.x, to.y);
      this.ctx.stroke();
    }

    // In-progress cable
    if (this.mode === "cabling" && this.cableFrom) {
      const src = this.boxes.get(this.cableFrom.boxId);
      const from = src ? this.outletPos(src, this.cableFrom.index, this.cableFrom.boxId) : null;
      if (from) {
        this.ctx.strokeStyle = COLORS.cableInProgress;
        this.ctx.setLineDash([4, 4]);
        this.ctx.beginPath();
        this.ctx.moveTo(from.x, from.y);
        this.ctx.lineTo(this.mousePos.x, this.mousePos.y);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      }
    }

    // Marquee
    if (this.mode === "selecting" && this.dragStart) {
      const x0 = Math.min(this.dragStart.x, this.mousePos.x);
      const y0 = Math.min(this.dragStart.y, this.mousePos.y);
      const sw = Math.abs(this.mousePos.x - this.dragStart.x);
      const sh = Math.abs(this.mousePos.y - this.dragStart.y);
      this.ctx.strokeStyle = "#555";
      this.ctx.setLineDash([3, 3]);
      this.ctx.strokeRect(x0, y0, sw, sh);
      this.ctx.setLineDash([]);
    }

    // Boxes
    this.ctx.font = FONT;
    for (const [id, box] of this.boxes) {
      const bw = this.boxWidth(box, id);
      const selected = this.selection.has(id);
      const def = getDef(box.text);
      const zone = def ? def.zone : "any";
      const isRouter = zone === "router";
      const isUnknown = !def && box.text.length > 0;
      const isAbs = isAbstraction(box.text);
      const isComment = def?.isComment;

      // Comment: just text
      if (isComment) {
        this.ctx.font = COMMENT_FONT;
        this.ctx.fillStyle = selected ? COLORS.text : COLORS.commentText;
        this.ctx.textBaseline = "middle";
        const displayText = box.text.replace(/^comment\s*/, "");
        if (this.editingBoxId !== id) {
          this.ctx.fillText(displayText, box.x + BOX_PAD_X, box.y + BOX_HEIGHT / 2);
        }
        if (selected) {
          this.ctx.strokeStyle = COLORS.boxSelectedStroke;
          this.ctx.setLineDash([2, 2]);
          this.ctx.strokeRect(box.x + 0.5, box.y + 0.5, bw - 1, BOX_HEIGHT - 1);
          this.ctx.setLineDash([]);
        }
        this.ctx.font = FONT;
        continue;
      }

      // Box fill
      this.ctx.fillStyle = selected ? COLORS.boxSelectedFill
        : isRouter ? COLORS.routerFill
        : isAbs ? COLORS.abstractionFill
        : COLORS.boxFill;
      this.ctx.fillRect(box.x, box.y, bw, BOX_HEIGHT);

      // Box stroke
      this.ctx.strokeStyle = selected ? COLORS.boxSelectedStroke
        : isRouter ? COLORS.routerStroke
        : isAbs ? COLORS.abstractionStroke
        : COLORS.boxStroke;
      if (isUnknown) this.ctx.setLineDash([4, 3]);
      this.ctx.strokeRect(box.x + 0.5, box.y + 0.5, bw - 1, BOX_HEIGHT - 1);
      if (isUnknown) this.ctx.setLineDash([]);

      // Value bar
      if (this.boxValues.has(id)) {
        const val = this.boxValues.get(id);
        if (val >= 0 && val <= 1) {
          this.ctx.fillStyle = "#4a4a4a";
          this.ctx.fillRect(box.x + 1, box.y + 1, (bw - 2) * val, BOX_HEIGHT - 2);
        }
      }

      // Text
      if (this.editingBoxId !== id) {
        this.ctx.fillStyle = COLORS.text;
        this.ctx.textBaseline = "middle";
        if (boxTypeName(box.text) === "print" && this.boxValues.has(id)) {
          const v = this.boxValues.get(id);
          const display = typeof v === "number" ? (Number.isInteger(v) ? v.toString() : v.toFixed(4)) : String(v);
          this.ctx.fillText("print " + display, box.x + BOX_PAD_X, box.y + BOX_HEIGHT / 2);
        } else {
          this.ctx.fillText(box.text, box.x + BOX_PAD_X, box.y + BOX_HEIGHT / 2);
        }
      }

      // Ports
      this.ctx.fillStyle = COLORS.port;
      for (let i = 0; i < box.inlets; i++) {
        const p = this.inletPos(box, i, id);
        this.ctx.fillRect(p.x - PORT_W / 2, p.y - PORT_H + 0.5, PORT_W, PORT_H);
      }
      for (let i = 0; i < box.outlets; i++) {
        const p = this.outletPos(box, i, id);
        this.ctx.fillRect(p.x - PORT_W / 2, p.y - 0.5, PORT_W, PORT_H);
      }
    }

    // Let owner draw overlays
    this.renderOverlay(this.ctx, w, h);

    this.ctx.restore();
  }

  // --- Text Editing ---

  startEditing(boxId) {
    if (!this.input) return;
    const box = this.boxes.get(boxId);
    if (!box) return;
    this.editingBoxId = boxId;
    this.mode = "editing";
    const w = Math.max(this.boxWidth(box, boxId), 80);
    Object.assign(this.input.style, {
      left: (box.x + BOX_PAD_X) + "px",
      top: box.y + "px",
      width: w + "px",
      height: BOX_HEIGHT + "px",
      lineHeight: BOX_HEIGHT + "px",
      display: "block"
    });
    this.input.value = box.text;
    this.input.focus();
    this.input.select();
    this.render();
  }

  finishEditing(confirm) {
    if (this.editingBoxId === null || !this.input) return;
    const box = this.boxes.get(this.editingBoxId);
    if (confirm && this.input.value.trim()) {
      this.pushUndo();
      const newText = this.input.value.trim();
      box.text = newText;
      const ports = getPorts(newText);
      box.inlets = ports.inlets;
      box.outlets = ports.outlets;
      // Prune invalid cables
      for (const [id, c] of this.cables) {
        if (c.srcBox === this.editingBoxId && c.srcOutlet >= box.outlets) this.cables.delete(id);
        if (c.dstBox === this.editingBoxId && c.dstInlet >= box.inlets) this.cables.delete(id);
      }
      if (this.isRouterType(newText)) box.y = this.synthBorderY - BOX_HEIGHT / 2;
      const zone = getBoxZone(newText);
      if (zone === "synth" && !this.isSynthZone(box.y)) box.y = this.synthBorderY + 20;
      else if (zone === "ctrl" && this.isSynthZone(box.y)) box.y = this.synthBorderY - BOX_HEIGHT - 20;
    } else if (!box.text) {
      this.pushUndo();
      for (const [id, c] of this.cables) {
        if (c.srcBox === this.editingBoxId || c.dstBox === this.editingBoxId) this.cables.delete(id);
      }
      this.boxes.delete(this.editingBoxId);
      this.selection.delete(this.editingBoxId);
    }
    this.editingBoxId = null;
    this.mode = "idle";
    this.input.style.display = "none";
    this.input.value = "";
    this.render();
  }

  // --- Mouse Handlers ---

  _onMouseDown(e) {
    const m = this.canvasCoords(e);
    tooltipEl.style.display = "none";

    if (this.hitTestSynthHandle(m.x, m.y)) {
      this.mode = "resizing-synth";
      this.canvas.style.cursor = "ns-resize";
      return;
    }

    const outlet = this.hitTestOutlet(m.x, m.y);
    if (outlet) {
      this.mode = "cabling";
      this.cableFrom = { boxId: outlet.boxId, index: outlet.index };
      this.selection.clear();
      this.cableSelection.clear();
      this.canvas.style.cursor = "crosshair";
      this.render();
      return;
    }

    const boxId = this.hitTestBox(m.x, m.y);
    if (boxId !== null) {
      this.cableSelection.clear();
      if (e.shiftKey) {
        this.selection.has(boxId) ? this.selection.delete(boxId) : this.selection.add(boxId);
      } else if (!this.selection.has(boxId)) {
        this.selection.clear();
        this.selection.add(boxId);
      }

      // Option+drag: duplicate
      if (e.altKey && this.selection.size > 0) {
        this.pushUndo();
        const idMap = new Map();
        const newSel = new Set();
        for (const oldId of this.selection) {
          const box = this.boxes.get(oldId);
          if (!box) continue;
          const newId = this.nextId++;
          idMap.set(oldId, newId);
          this.boxes.set(newId, { x: box.x, y: box.y, text: box.text, inlets: box.inlets, outlets: box.outlets });
          newSel.add(newId);
        }
        for (const [, c] of this.cables) {
          if (idMap.has(c.srcBox) && idMap.has(c.dstBox)) {
            this.cables.set(this.nextId++, { srcBox: idMap.get(c.srcBox), srcOutlet: c.srcOutlet, dstBox: idMap.get(c.dstBox), dstInlet: c.dstInlet });
          }
        }
        this.selection.clear();
        for (const id of newSel) this.selection.add(id);
      }

      this.mode = "dragging";
      this.dragStart = { x: m.x, y: m.y };
      this.dragBoxPositions = new Map();
      for (const id of this.selection) {
        const b = this.boxes.get(id);
        if (b) this.dragBoxPositions.set(id, { x: b.x, y: b.y });
      }
      this.dragSnapshot = {
        cables: new Map([...this.cables.entries()].map(([id, c]) => [id, { ...c }])),
        boxes: new Map([...this.boxes.entries()].map(([id, b]) => [id, { ...b }])),
        nextId: this.nextId,
      };
      this.render();
      return;
    }

    const cableId = this.hitTestCable(m.x, m.y);
    if (cableId !== null) {
      this.selection.clear();
      this.cableSelection.clear();
      this.cableSelection.add(cableId);
      this.render();
      return;
    }

    if (!e.shiftKey) {
      this.selection.clear();
      this.cableSelection.clear();
    }
    this.mode = "selecting";
    this.dragStart = { x: m.x, y: m.y };
    this.render();
  }

  _onMouseMove(e) {
    const m = this.canvasCoords(e);
    this.mousePos = m;

    if (this.mode === "resizing-synth") {
      const h = this.canvas.height / (window.devicePixelRatio || 1);
      this.synthBorderY = Math.max(100, Math.min(m.y, h - 100));
      for (const [, box] of this.boxes) {
        if (this.isRouterType(box.text)) box.y = this.synthBorderY - BOX_HEIGHT / 2;
      }
      this.render();
      return;
    }

    if (this.mode === "dragging" && this.dragStart && this.dragSnapshot) {
      // Restore from snapshot
      this.cables.clear();
      for (const [id, c] of this.dragSnapshot.cables) this.cables.set(id, { ...c });
      this.boxes.clear();
      for (const [id, b] of this.dragSnapshot.boxes) this.boxes.set(id, { ...b });
      this.nextId = this.dragSnapshot.nextId;

      const dx = m.x - this.dragStart.x, dy = m.y - this.dragStart.y;
      for (const [id, orig] of this.dragBoxPositions) {
        const box = this.boxes.get(id);
        if (!box) continue;
        if (this.isRouterType(box.text)) {
          box.x = orig.x + dx;
          box.y = this.synthBorderY - BOX_HEIGHT / 2;
        } else {
          box.x = orig.x + dx;
          box.y = orig.y + dy;
        }
      }
      this.autoRouteBorderCrossings(this.selection);
      this.render();
      return;
    }

    if (this.mode === "selecting") {
      this.render();
      return;
    }

    if (this.mode === "cabling") {
      // show tooltip on inlet/outlet while dragging cable
      const i = this.hitTestInlet(m.x, m.y);
      const o = this.hitTestOutlet(m.x, m.y);
      const port = i || o;
      if (port) {
        const box = this.boxes.get(port.boxId);
        if (box) {
          const def = getBoxDef(box.text);
          const portList = i ? def?.inlets : def?.outlets;
          const portDef = portList?.[port.index];
          if (portDef) {
            tooltipEl.innerHTML =
              `<span class="tt-name">${portDef.name}</span> <span class="tt-type">${portDef.type}</span><br>${portDef.description}`;
            tooltipEl.style.left = (e.clientX + 12) + "px";
            tooltipEl.style.top = (e.clientY + 12) + "px";
            tooltipEl.style.display = "block";
          } else {
            tooltipEl.style.display = "none";
          }
        }
      } else {
        tooltipEl.style.display = "none";
      }
      this.render();
      return;
    }

    // Update cursor and tooltip
    if (this.hitTestSynthHandle(m.x, m.y)) {
      this.canvas.style.cursor = "ns-resize";
      tooltipEl.style.display = "none";
    } else {
      const o = this.hitTestOutlet(m.x, m.y);
      const i = this.hitTestInlet(m.x, m.y);
      this.canvas.style.cursor = (o || i) ? "crosshair" : this.hitTestBox(m.x, m.y) !== null ? "move" : "default";

      const port = i || o;
      if (port) {
        const box = this.boxes.get(port.boxId);
        if (box) {
          const def = getBoxDef(box.text);
          const portList = i ? def?.inlets : def?.outlets;
          const portDef = portList?.[port.index];
          if (portDef) {
            tooltipEl.innerHTML =
              `<span class="tt-name">${portDef.name}</span> <span class="tt-type">${portDef.type}</span><br>${portDef.description}`;
            tooltipEl.style.left = (e.clientX + 12) + "px";
            tooltipEl.style.top = (e.clientY + 12) + "px";
            tooltipEl.style.display = "block";
          } else {
            tooltipEl.style.display = "none";
          }
        }
      } else {
        tooltipEl.style.display = "none";
      }
    }
  }

  _onMouseUp(e) {
    const m = this.canvasCoords(e);

    if (this.mode === "resizing-synth") {
      this.pushUndo();
      this.mode = "idle";
      this.canvas.style.cursor = "default";
      return;
    }

    if (this.mode === "cabling" && this.cableFrom) {
      const inlet = this.hitTestInlet(m.x, m.y);
      if (inlet && inlet.boxId !== this.cableFrom.boxId && !this.inletHasCable(inlet.boxId, inlet.index)) {
        this.pushUndo();
        const srcSynth = this.isSynthSide(this.cableFrom.boxId);
        const dstSynth = this.isSynthSide(inlet.boxId);
        const srcBox = this.boxes.get(this.cableFrom.boxId);
        const dstBox = this.boxes.get(inlet.boxId);
        if (srcSynth !== dstSynth && !this.isRouterType(srcBox?.text) && !this.isRouterType(dstBox?.text)) {
          this.autoRoute(this.cableFrom.boxId, this.cableFrom.index, inlet.boxId, inlet.index);
        } else {
          this.cables.set(this.nextId++, { srcBox: this.cableFrom.boxId, srcOutlet: this.cableFrom.index, dstBox: inlet.boxId, dstInlet: inlet.index });
        }
      }
      this.cableFrom = null;
      this.mode = "idle";
      this.canvas.style.cursor = "default";
      tooltipEl.style.display = "none";
      this.render();
      return;
    }

    if (this.mode === "dragging") {
      let moved = false;
      if (this.dragBoxPositions && this.dragStart) {
        for (const [id, orig] of this.dragBoxPositions) {
          const box = this.boxes.get(id);
          if (box && (box.x !== orig.x || box.y !== orig.y)) { moved = true; break; }
        }
      }
      if (moved) {
        this.pushUndo();
      } else if (this.selection.size === 1) {
        // click without drag — check for interactive boxes
        const id = [...this.selection][0];
        const box = this.boxes.get(id);
        if (box) {
          const type = boxTypeName(box.text);
          if (type === "toggle") {
            const cur = this.boxValues.get(id) || 0;
            const next = cur > 0 ? 0 : 1;
            this.boxValues.set(id, next);
            send({ type: "toggle-click", id, value: next });
            this.render();
          } else if (type === "event") {
            send({ type: "event-click", id });
          }
        }
      }
      this.mode = "idle";
      this.dragStart = null;
      this.dragBoxPositions = null;
      this.dragSnapshot = null;
    }

    if (this.mode === "selecting" && this.dragStart) {
      const x0 = Math.min(this.dragStart.x, m.x), y0 = Math.min(this.dragStart.y, m.y);
      const x1 = Math.max(this.dragStart.x, m.x), y1 = Math.max(this.dragStart.y, m.y);
      for (const [id, box] of this.boxes) {
        const bw = this.boxWidth(box, id);
        if (box.x + bw > x0 && box.x < x1 && box.y + BOX_HEIGHT > y0 && box.y < y1) {
          this.selection.add(id);
        }
      }
      this.mode = "idle";
      this.dragStart = null;
      this.render();
    }
  }

  _onDblClick(e) {
    const m = this.canvasCoords(e);
    const boxId = this.hitTestBox(m.x, m.y);
    if (boxId !== null) {
      this.selection.clear();
      this.selection.add(boxId);
      this.startEditing(boxId);
      return;
    }
    const cableId = this.hitTestCable(m.x, m.y);
    if (cableId !== null) {
      this.pushUndo();
      const cable = this.cables.get(cableId);
      this.cables.delete(cableId);
      const id = this.nextId++;
      this.boxes.set(id, { x: m.x - 15, y: m.y - BOX_HEIGHT / 2, text: "", inlets: 1, outlets: 1 });
      this.cables.set(this.nextId++, { srcBox: cable.srcBox, srcOutlet: cable.srcOutlet, dstBox: id, dstInlet: 0 });
      this.cables.set(this.nextId++, { srcBox: id, srcOutlet: 0, dstBox: cable.dstBox, dstInlet: cable.dstInlet });
      this.selection.clear();
      this.selection.add(id);
      this.startEditing(id);
      return;
    }
    this.pushUndo();
    const id = this.nextId++;
    this.boxes.set(id, { x: m.x - 15, y: m.y - BOX_HEIGHT / 2, text: "", inlets: 1, outlets: 1 });
    this.selection.clear();
    this.selection.add(id);
    this.startEditing(id);
  }

  // --- Keyboard (called externally) ---

  onKeyDown(e) {
    if (this.mode === "editing") return false;

    if (e.key === "Backspace" || e.key === "Delete") {
      if (this.selection.size > 0 || this.cableSelection.size > 0) {
        e.preventDefault();
        this.pushUndo();
        for (const id of this.selection) {
          for (const [cid, c] of this.cables) {
            if (c.srcBox === id || c.dstBox === id) this.cables.delete(cid);
          }
          this.boxes.delete(id);
        }
        for (const id of this.cableSelection) this.cables.delete(id);
        this.selection.clear();
        this.cableSelection.clear();
        this.render();
        return true;
      }
    }

    if (e.key === "Tab" && this.selection.size === 1) {
      e.preventDefault();
      const srcId = [...this.selection][0];
      const srcBox = this.boxes.get(srcId);
      if (!srcBox) return true;
      this.pushUndo();
      const id = this.nextId++;
      this.boxes.set(id, { x: srcBox.x, y: srcBox.y + BOX_HEIGHT + 30, text: "", inlets: 1, outlets: 1 });
      this.cables.set(this.nextId++, { srcBox: srcId, srcOutlet: 0, dstBox: id, dstInlet: 0 });
      this.selection.clear();
      this.selection.add(id);
      this.startEditing(id);
      return true;
    }

    if (e.key === "Escape") {
      if (this.mode === "cabling") {
        this.mode = "idle";
        this.cableFrom = null;
        this.canvas.style.cursor = "default";
      } else {
        this.selection.clear();
        this.cableSelection.clear();
      }
      this.render();
      return true;
    }

    return false;
  }

  resize(width, height) {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    // Update CSS dimensions to match logical size (prevents squishing)
    this.canvas.style.width = width + "px";
    this.canvas.style.height = height + "px";
    this.render();
  }
}

// =============================================================================
// Main Editor
// =============================================================================

const mainEditor = new PatchEditor(canvas, {
  synthBorderY: window.innerHeight * 0.55,
  showSynthBorder: true,
  input: input,
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

    // Client count
    ctx.fillText(connectedClients + " client" + (connectedClients !== 1 ? "s" : ""), w - 12, mainEditor.synthBorderY + 8);
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
  const w = Math.max(mainEditor.measureText(input.value || " ") + BOX_PAD_X * 2, 80);
  input.style.width = w + "px";
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

// --- Keyboard ---

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && helpPopup) { closeHelpPopup(); return; }
  if (mainEditor.mode === "editing") return;
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); applyToServer(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); mainEditor.undo(); return; }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "s") { e.preventDefault(); saveAsAbstraction(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); savePatch(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === "o") { e.preventDefault(); loadPatch(); return; }
  if (e.key === "h" && mainEditor.selection.size === 1) {
    e.preventDefault();
    const boxId = [...mainEditor.selection][0];
    openHelp(boxTypeName(mainEditor.boxes.get(boxId).text));
    return;
  }
  mainEditor.onKeyDown(e);
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
        // tear down ctrl-side engines — they'll be re-created on demand
        for (const eng of ctrlEngines.values()) {
          eng.worklet?.disconnect();
          eng.splitter?.disconnect();
          eng.out?.disconnect();
        }
        ctrlEngines.clear();
        mainEditor.render();
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
      } else if (msg.type === "engine-param") {
        handleEngineParam(msg);
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

async function saveAsAbstraction() {
  let hasInterface = false;
  for (const box of mainEditor.boxes.values()) {
    const type = boxTypeName(box.text);
    if (type === "inlet" || type === "outlet") { hasInterface = true; break; }
  }
  if (!hasInterface) { alert("Add inlet/outlet boxes first"); return; }
  const name = prompt("Abstraction name:");
  if (!name) return;
  const res = await fetch(`/abstractions/${encodeURIComponent(name)}`, { method: "PUT", body: mainEditor.serialize() });
  if (res.ok) { console.log("Abstraction saved:", name); await loadAbstractions(); }
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
  if (!sources) sources = ["key"];

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
  const [status, d1, d2] = e.data, type = status & 0xf0;
  if (type === 0xb0) send({ type: "midi", cc: d1, value: d2 });
  else if (type === 0x90) send({ type: "midi", note: d1, velocity: d2 });
}

async function initMIDI() {
  try {
    const ma = await navigator.requestMIDIAccess();
    for (const inp of ma.inputs.values()) { autoCreateSources(inp.name || "keyboard"); inp.onmidimessage = onMIDIMessage; }
    ma.onstatechange = (e) => {
      if (e.port.type === "input" && e.port.state === "connected") {
        autoCreateSources(e.port.name || "keyboard");
        e.port.onmidimessage = onMIDIMessage;
      }
    };
  } catch {}
}

// --- Init ---

connectWS();
initMIDI();
loadAbstractions();
