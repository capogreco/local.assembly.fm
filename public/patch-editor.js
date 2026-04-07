import { boxTypeName, getBoxPorts, getBoxZone, getBoxDef, getInletDef, getOutletDef, isAudioBox } from "./gpi-types.js";

// --- constants ---

const COLORS = {
  bg: "#1a1a1a", boxFill: "#2a2a2a", boxStroke: "#666",
  boxSelectedFill: "#333", boxSelectedStroke: "#e0e0e0",
  text: "#e0e0e0", port: "#e0e0e0", cable: "#666", cableInProgress: "#999",
  synthBorder: "#555", synthLabel: "#555", synthHandle: "#666",
  routerFill: "#2a2a2a", routerStroke: "#555",
  abstractionFill: "#2a2a3a", abstractionStroke: "#668",
  commentText: "#888",
  cableAudio: "#8af", portAudio: "#8af", portEvent: "#fa4",
};
const BOX_HEIGHT = 22, BOX_PAD_X = 8, PORT_W = 8, PORT_H = 3, PORT_HIT = 8, SYNTH_HANDLE = 8;
const FONT = '12px "IBM Plex Mono", "Fira Mono", "Courier New", monospace';
const SMALL_FONT = '10px "IBM Plex Mono", monospace';
const COMMENT_FONT = 'italic 12px "IBM Plex Mono", "Fira Mono", "Courier New", monospace';

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

    // Pan & zoom (view transform only — never mutates patch coordinates)
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.isPanning = false;
    this.panStart = null;
    this.panOrigin = null;
    this.spaceHeld = false;

    // Undo
    this.undoStack = [];
    this.maxUndo = 50;

    // Status
    this.dirty = false;
    this.applied = false;

    // Callbacks
    this.onDirty = options.onDirty ?? (() => {});
    this.renderOverlay = options.renderOverlay ?? (() => {});
    this.onSend = options.onSend ?? (() => {});
    this.onOpenAbstraction = options.onOpenAbstraction ?? (() => {});

    // Optional DOM elements
    this.tooltipEl = options.tooltipEl ?? null;

    // Bind handlers
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onDblClick = this._onDblClick.bind(this);
    this._onWheel = this._onWheel.bind(this);
  }

  bindEvents() {
    this.canvas.addEventListener("mousedown", this._onMouseDown);
    this.canvas.addEventListener("mousemove", this._onMouseMove);
    this.canvas.addEventListener("mouseup", this._onMouseUp);
    this.canvas.addEventListener("dblclick", this._onDblClick);
    this.canvas.addEventListener("wheel", this._onWheel, { passive: false });
  }

  unbindEvents() {
    this.canvas.removeEventListener("mousedown", this._onMouseDown);
    this.canvas.removeEventListener("mousemove", this._onMouseMove);
    this.canvas.removeEventListener("mouseup", this._onMouseUp);
    this.canvas.removeEventListener("dblclick", this._onDblClick);
    this.canvas.removeEventListener("wheel", this._onWheel);
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
    // Fit view to show all boxes
    this.zoomToFit();
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
    // Preserve view position across undo
    const { panX, panY, zoom } = this;
    this.load(this.undoStack.pop());
    this.panX = panX;
    this.panY = panY;
    this.zoom = zoom;
    this.dirty = true;
    this.onDirty();
    this.render();
  }

  // --- Tidy Layout (Sugiyama-style layered DAG layout) ---

  tidyLayout() {
    if (this.boxes.size === 0) return;
    this.pushUndo();

    const LAYER_Y_SPACING = 60;
    const H_GAP = 24;
    const SUBGRAPH_GAP = 50;
    const TOP_MARGIN = 30;
    const BORDER_PAD = 30;

    // Build adjacency
    const childrenOf = new Map();
    const parentsOf = new Map();
    for (const [id] of this.boxes) { childrenOf.set(id, []); parentsOf.set(id, []); }
    for (const [, cable] of this.cables) {
      childrenOf.get(cable.srcBox)?.push(cable.dstBox);
      parentsOf.get(cable.dstBox)?.push(cable.srcBox);
    }

    // Partition into server / synth / router
    const serverBoxes = [], synthBoxes = [], routerBoxes = [];
    for (const [id, box] of this.boxes) {
      if (this.isRouterType(box.text)) routerBoxes.push(id);
      else if (box.y + BOX_HEIGHT / 2 < this.synthBorderY) serverBoxes.push(id);
      else synthBoxes.push(id);
    }

    // Find connected components within a set of box ids
    const findComponents = (boxIds) => {
      const idSet = new Set(boxIds);
      const visited = new Set();
      const components = [];
      const adj = new Map();
      for (const id of boxIds) adj.set(id, []);
      for (const [, cable] of this.cables) {
        if (idSet.has(cable.srcBox) && idSet.has(cable.dstBox)) {
          adj.get(cable.srcBox).push(cable.dstBox);
          adj.get(cable.dstBox).push(cable.srcBox);
        }
      }
      for (const id of boxIds) {
        if (visited.has(id)) continue;
        const comp = [];
        const stack = [id];
        while (stack.length > 0) {
          const n = stack.pop();
          if (visited.has(n)) continue;
          visited.add(n);
          comp.push(n);
          for (const nb of adj.get(n)) {
            if (!visited.has(nb)) stack.push(nb);
          }
        }
        components.push(comp);
      }
      return components;
    };

    // Assign layers via longest-path from roots
    const assignLayers = (boxIds) => {
      const idSet = new Set(boxIds);
      const layer = new Map();
      const topo = [];
      const visited = new Set();
      const visit = (id) => {
        if (visited.has(id)) return;
        visited.add(id);
        for (const c of childrenOf.get(id) || []) {
          if (idSet.has(c)) visit(c);
        }
        topo.push(id);
      };
      for (const id of boxIds) visit(id);
      topo.reverse();

      for (const id of topo) {
        let maxParentLayer = -1;
        for (const p of parentsOf.get(id) || []) {
          if (layer.has(p)) maxParentLayer = Math.max(maxParentLayer, layer.get(p));
        }
        layer.set(id, maxParentLayer + 1);
      }

      const layers = [];
      for (const id of boxIds) {
        const l = layer.get(id) || 0;
        while (layers.length <= l) layers.push([]);
        layers[l].push(id);
      }
      return layers;
    };

    // Box width helper
    const bw = (id) => this.boxWidth(this.boxes.get(id), id);

    // Layer width
    const layerWidth = (layer) => {
      let w = 0;
      for (const id of layer) w += bw(id);
      return w + Math.max(0, layer.length - 1) * H_GAP;
    };

    // Place a layer centered on centerX
    const placeLayer = (layer, centerX) => {
      const w = layerWidth(layer);
      let x = centerX - w / 2;
      for (const id of layer) {
        this.boxes.get(id).x = x;
        x += bw(id) + H_GAP;
      }
    };

    // Layout a single connected component, returning metadata
    const layoutComponent = (boxIds) => {
      const layers = assignLayers(boxIds);
      if (layers.length === 0) return { layers: [], width: 0, height: 0, minX: 0 };

      // Initial ordering: sort each layer by original x
      for (const l of layers) {
        l.sort((a, b) => this.boxes.get(a).x - this.boxes.get(b).x);
      }

      // Rough initial placement centered at 0
      for (const l of layers) placeLayer(l, 0);

      // Barycenter ordering using actual x midpoints (6 passes)
      for (let pass = 0; pass < 6; pass++) {
        // Forward sweep
        for (let li = 1; li < layers.length; li++) {
          const bary = new Map();
          for (const id of layers[li]) {
            const ps = (parentsOf.get(id) || []).filter(p => layers[li - 1].includes(p));
            if (ps.length > 0) {
              bary.set(id, ps.reduce((s, p) => s + this.boxes.get(p).x + bw(p) / 2, 0) / ps.length);
            } else {
              bary.set(id, this.boxes.get(id).x + bw(id) / 2);
            }
          }
          layers[li].sort((a, b) => bary.get(a) - bary.get(b));
          placeLayer(layers[li], 0);
        }

        // Backward sweep
        for (let li = layers.length - 2; li >= 0; li--) {
          const bary = new Map();
          for (const id of layers[li]) {
            const cs = (childrenOf.get(id) || []).filter(c => layers[li + 1].includes(c));
            if (cs.length > 0) {
              bary.set(id, cs.reduce((s, c) => s + this.boxes.get(c).x + bw(c) / 2, 0) / cs.length);
            } else {
              bary.set(id, this.boxes.get(id).x + bw(id) / 2);
            }
          }
          layers[li].sort((a, b) => bary.get(a) - bary.get(b));
          placeLayer(layers[li], 0);
        }
      }

      // Final overlap-free placement: target barycenter, enforce min gap
      for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];
        const ideal = new Map();
        for (const id of layer) {
          const ps = (parentsOf.get(id) || []).filter(p => {
            for (let pli = 0; pli < li; pli++) if (layers[pli].includes(p)) return true;
            return false;
          });
          const cs = (childrenOf.get(id) || []).filter(c => {
            for (let cli = li + 1; cli < layers.length; cli++) if (layers[cli].includes(c)) return true;
            return false;
          });
          const connected = [...ps, ...cs];
          if (connected.length > 0) {
            ideal.set(id, connected.reduce((s, n) => s + this.boxes.get(n).x + bw(n) / 2, 0) / connected.length);
          } else {
            ideal.set(id, this.boxes.get(id).x + bw(id) / 2);
          }
        }
        layer.sort((a, b) => ideal.get(a) - ideal.get(b));

        // Greedy left-to-right: place as close to ideal as possible, no overlaps
        let minX = -Infinity;
        for (const id of layer) {
          const w = bw(id);
          const x = Math.max(ideal.get(id) - w / 2, minX);
          this.boxes.get(id).x = x;
          minX = x + w + H_GAP;
        }
      }

      // Compute bounding box
      let minBX = Infinity, maxBX = -Infinity;
      for (const l of layers) {
        for (const id of l) {
          const box = this.boxes.get(id);
          minBX = Math.min(minBX, box.x);
          maxBX = Math.max(maxBX, box.x + bw(id));
        }
      }

      return { layers, width: maxBX - minBX, height: layers.length * LAYER_Y_SPACING, minX: minBX };
    };

    // Layout a region: find components, lay each out, pack side by side
    const layoutRegion = (boxIds, startY) => {
      if (boxIds.length === 0) return startY;

      const components = findComponents(boxIds);
      components.sort((a, b) => b.length - a.length); // largest first

      const results = components.map(comp => layoutComponent(comp));

      let cursorX = 60;
      let maxHeight = 0;

      for (let ci = 0; ci < results.length; ci++) {
        const r = results[ci];
        if (r.layers.length === 0) continue;
        const offsetX = cursorX - (r.minX || 0);

        for (let li = 0; li < r.layers.length; li++) {
          for (const id of r.layers[li]) {
            const box = this.boxes.get(id);
            box.x += offsetX;
            box.y = startY + li * LAYER_Y_SPACING;
          }
        }

        cursorX += r.width + SUBGRAPH_GAP;
        maxHeight = Math.max(maxHeight, r.height);
      }

      return startY + maxHeight;
    };

    const serverEnd = layoutRegion(serverBoxes, TOP_MARGIN);
    if (serverEnd + BORDER_PAD > this.synthBorderY && serverBoxes.length > 0) {
      this.synthBorderY = serverEnd + BORDER_PAD;
    }

    // Place routers on border, x-aligned to connected boxes
    for (const id of routerBoxes) {
      const box = this.boxes.get(id);
      box.y = this.synthBorderY - BOX_HEIGHT / 2;
      const connected = [
        ...(parentsOf.get(id) || []),
        ...(childrenOf.get(id) || [])
      ].map(n => this.boxes.get(n)).filter(Boolean);
      if (connected.length > 0) {
        box.x = connected.reduce((s, b) => s + b.x, 0) / connected.length;
      }
    }

    layoutRegion(synthBoxes, this.synthBorderY + BORDER_PAD);
    this.zoomToFit();
    this.dirty = true;
    this.onDirty();
    this.render();
  }

  // --- Geometry ---

  canvasCoords(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / this.zoom + this.panX,
      y: (e.clientY - r.top) / this.zoom + this.panY,
    };
  }

  screenFromPatch(px, py) {
    return {
      x: (px - this.panX) * this.zoom,
      y: (py - this.panY) * this.zoom,
    };
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
    const _type = boxTypeName(box.text);
    if ((_type === "print" || (_type === "cc" && box.text.trim() === "cc")) && id !== undefined && this.boxValues.has(id)) {
      const v = this.boxValues.get(id);
      text = _type + " " + (typeof v === "number" ? (Number.isInteger(v) ? v.toString() : v.toFixed(4)) : String(v));
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

  isAudioCable(cable) {
    const srcBox = this.boxes.get(cable.srcBox);
    if (!srcBox) return false;
    return getOutletDef(srcBox.text, cable.srcOutlet)?.type === "audio";
  }

  isAudioInlet(boxId, inlet) {
    const box = this.boxes.get(boxId);
    if (!box) return false;
    return getInletDef(box.text, inlet)?.type === "audio";
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

    // Apply pan & zoom
    this.ctx.scale(this.zoom, this.zoom);
    this.ctx.translate(-this.panX, -this.panY);

    // Dot grid (cover visible area in patch space)
    const visW = w / this.zoom, visH = h / this.zoom;
    const gridStartX = Math.floor(this.panX / 20) * 20;
    const gridStartY = Math.floor(this.panY / 20) * 20;
    this.ctx.fillStyle = "#333";
    for (let x = gridStartX; x < this.panX + visW; x += 20) {
      for (let y = gridStartY; y < this.panY + visH; y += 20) {
        this.ctx.fillRect(x, y, 1, 1);
      }
    }

    // Synth border
    if (this.showSynthBorder) {
      this.ctx.strokeStyle = COLORS.synthBorder;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(this.panX, this.synthBorderY);
      this.ctx.lineTo(this.panX + visW, this.synthBorderY);
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
    for (const [id, cable] of this.cables) {
      const from = this.cableFromPos(cable), to = this.cableToPos(cable);
      if (!from || !to) continue;
      const audio = this.isAudioCable(cable);
      this.ctx.lineWidth = audio ? 2.5 : 1;
      this.ctx.strokeStyle = this.cableSelection.has(id) ? COLORS.boxSelectedStroke
        : (audio ? COLORS.cableAudio : COLORS.cable);
      this.ctx.beginPath();
      this.ctx.moveTo(from.x, from.y);
      this.ctx.lineTo(to.x, to.y);
      this.ctx.stroke();
    }
    this.ctx.lineWidth = 1;

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
        let barVal = val;
        // Normalize scale box display to its own range
        const _tn = boxTypeName(box.text);
        if (_tn === "scale" && typeof val === "number") {
          const _args = box.text.split(/\s+/).slice(1);
          const sMin = parseFloat(_args[0]) || 0, sMax = parseFloat(_args[1]) || 1;
          barVal = sMax !== sMin ? (val - sMin) / (sMax - sMin) : 0;
        }
        if (_tn === "knob" && typeof val === "number") {
          const _args = box.text.split(/\s+/).slice(1).map(Number);
          const kMin = _args[1] !== undefined ? _args[1] : 0, kMax = _args[2] !== undefined ? _args[2] : 1;
          const kCurve = _args[3] || 1;
          // Show linear position in normalised (pre-curve) space for intuitive bar
          barVal = kMax !== kMin ? Math.pow(Math.max(0, Math.min(1, (val - kMin) / (kMax - kMin))), 1 / kCurve) : 0;
        }
        if (typeof barVal === "number" && barVal >= 0 && barVal <= 1) {
          this.ctx.fillStyle = "#4a4a4a";
          this.ctx.fillRect(box.x + 1, box.y + 1, (bw - 2) * barVal, BOX_HEIGHT - 2);
        }
      }

      // Text
      if (this.editingBoxId !== id) {
        this.ctx.fillStyle = COLORS.text;
        this.ctx.textBaseline = "middle";
        const _bt = boxTypeName(box.text);
        if ((_bt === "print" || (_bt === "cc" && box.text.trim() === "cc")) && this.boxValues.has(id)) {
          const v = this.boxValues.get(id);
          const display = typeof v === "number" ? (Number.isInteger(v) ? v.toString() : v.toFixed(4)) : String(v);
          this.ctx.fillText(_bt + " " + display, box.x + BOX_PAD_X, box.y + BOX_HEIGHT / 2);
        } else {
          this.ctx.fillText(box.text, box.x + BOX_PAD_X, box.y + BOX_HEIGHT / 2);
        }
      }

      // Ports
      for (let i = 0; i < box.inlets; i++) {
        const p = this.inletPos(box, i, id);
        const iDef = getInletDef(box.text, i);
        let iHasAudioCable = false;
        if (iDef?.type === "number") {
          for (const [, c] of this.cables) {
            if (c.dstBox === id && c.dstInlet === i && this.isAudioCable(c)) { iHasAudioCable = true; break; }
          }
        }
        this.ctx.fillStyle = (iDef?.type === "audio" || iHasAudioCable) ? COLORS.portAudio : iDef?.type === "event" ? COLORS.portEvent : COLORS.port;
        this.ctx.fillRect(p.x - PORT_W / 2, p.y - PORT_H + 0.5, PORT_W, PORT_H);
      }
      for (let i = 0; i < box.outlets; i++) {
        const p = this.outletPos(box, i, id);
        const oDef = getOutletDef(box.text, i);
        this.ctx.fillStyle = oDef?.type === "audio" ? COLORS.portAudio : oDef?.type === "event" ? COLORS.portEvent : COLORS.port;
        this.ctx.fillRect(p.x - PORT_W / 2, p.y - 0.5, PORT_W, PORT_H);
      }
    }

    // Knob value labels (below the box)
    for (const [id, box] of this.boxes) {
      if (boxTypeName(box.text) !== "knob" || !this.boxValues.has(id)) continue;
      const v = this.boxValues.get(id);
      const display = typeof v === "number" ? (Number.isInteger(v) ? v.toString() : v.toFixed(4)) : String(v);
      this.ctx.font = SMALL_FONT;
      this.ctx.fillStyle = "#888";
      this.ctx.textBaseline = "top";
      this.ctx.fillText(display, box.x + BOX_PAD_X, box.y + BOX_HEIGHT + 2);
    }

    // Draw overlays in screen space (reset pan/zoom)
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
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
    this.input.value = box.text;
    const w = Math.max(this.boxWidth(box, boxId), 80);
    const s = this.screenFromPatch(box.x, box.y);
    const pad = BOX_PAD_X * this.zoom;
    const h = BOX_HEIGHT * this.zoom;
    Object.assign(this.input.style, {
      left: s.x + "px",
      top: s.y + "px",
      width: (w * this.zoom) + "px",
      height: h + "px",
      lineHeight: h + "px",
      fontSize: (12 * this.zoom) + "px",
      paddingLeft: pad + "px",
      paddingRight: pad + "px",
      paddingTop: "0",
      paddingBottom: "0",
      boxSizing: "border-box",
      display: "block"
    });
    this.input.focus();
    this.input.select();
    // Prevent Chrome auto-scroll from misaligning text
    requestAnimationFrame(() => { this.input.scrollLeft = 0; });
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
    if (this.tooltipEl) this.tooltipEl.style.display = "none";

    // Middle-click or spacebar+click → pan
    if (e.button === 1 || this.spaceHeld) {
      e.preventDefault();
      this.isPanning = true;
      this.panStart = { x: e.clientX, y: e.clientY };
      this.panOrigin = { x: this.panX, y: this.panY };
      this.canvas.style.cursor = "grabbing";
      return;
    }

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
    // Pan drag (before canvasCoords, since pan is in screen space)
    if (this.isPanning && this.panStart) {
      this.panX = this.panOrigin.x - (e.clientX - this.panStart.x) / this.zoom;
      this.panY = this.panOrigin.y - (e.clientY - this.panStart.y) / this.zoom;
      this.render();
      return;
    }

    const m = this.canvasCoords(e);
    this.mousePos = m;

    if (this.mode === "resizing-synth") {
      const newY = Math.max(30, m.y);
      const oldY = this.synthBorderY;
      this.synthBorderY = newY;
      for (const [, box] of this.boxes) {
        if (this.isRouterType(box.text)) {
          box.y = newY - BOX_HEIGHT / 2;
        } else if (newY > oldY) {
          // Border moving down — push synth boxes down to stay in synth zone
          if (box.y >= oldY && box.y < newY) box.y = newY + 4;
        } else if (newY < oldY) {
          // Border moving up — push ctrl boxes up to stay in ctrl zone
          if (box.y + BOX_HEIGHT > newY && box.y + BOX_HEIGHT <= oldY) box.y = newY - BOX_HEIGHT - 4;
        }
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
            if (this.tooltipEl) this.tooltipEl.innerHTML =
              `<span class="tt-name">${portDef.name}</span> <span class="tt-type">${portDef.type}</span><br>${portDef.description}`;
            if (this.tooltipEl) this.tooltipEl.style.left = (e.clientX + 12) + "px";
            if (this.tooltipEl) this.tooltipEl.style.top = (e.clientY + 12) + "px";
            if (this.tooltipEl) this.tooltipEl.style.display = "block";
          } else {
            if (this.tooltipEl) this.tooltipEl.style.display = "none";
          }
        }
      } else {
        if (this.tooltipEl) this.tooltipEl.style.display = "none";
      }
      this.render();
      return;
    }

    // Update cursor and tooltip
    if (this.hitTestSynthHandle(m.x, m.y)) {
      this.canvas.style.cursor = "ns-resize";
      if (this.tooltipEl) this.tooltipEl.style.display = "none";
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
            if (this.tooltipEl) this.tooltipEl.innerHTML =
              `<span class="tt-name">${portDef.name}</span> <span class="tt-type">${portDef.type}</span><br>${portDef.description}`;
            if (this.tooltipEl) this.tooltipEl.style.left = (e.clientX + 12) + "px";
            if (this.tooltipEl) this.tooltipEl.style.top = (e.clientY + 12) + "px";
            if (this.tooltipEl) this.tooltipEl.style.display = "block";
          } else {
            if (this.tooltipEl) this.tooltipEl.style.display = "none";
          }
        }
      } else {
        // Hover over box body — show description and args
        const boxId = this.hitTestBox(m.x, m.y);
        if (boxId !== null) {
          const box = this.boxes.get(boxId);
          const def = box ? getBoxDef(box.text) : null;
          if (def) {
            let tip = `<span class="tt-name">${boxTypeName(box.text)}</span>`;
            if (def.args) tip += ` <span class="tt-type">${def.args}</span>`;
            tip += `<br>${def.description}`;
            if (def.example) tip += `<br><span class="tt-type">e.g. ${def.example}</span>`;
            if (this.tooltipEl) this.tooltipEl.innerHTML = tip;
            if (this.tooltipEl) this.tooltipEl.style.left = (e.clientX + 12) + "px";
            if (this.tooltipEl) this.tooltipEl.style.top = (e.clientY + 12) + "px";
            if (this.tooltipEl) this.tooltipEl.style.display = "block";
          } else {
            if (this.tooltipEl) this.tooltipEl.style.display = "none";
          }
        } else {
          if (this.tooltipEl) this.tooltipEl.style.display = "none";
        }
      }
    }
  }

  _onMouseUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
      this.panStart = null;
      this.panOrigin = null;
      this.canvas.style.cursor = this.spaceHeld ? "grab" : "default";
      return;
    }

    const m = this.canvasCoords(e);

    if (this.mode === "resizing-synth") {
      this.pushUndo();
      this.mode = "idle";
      this.canvas.style.cursor = "default";
      return;
    }

    if (this.mode === "cabling" && this.cableFrom) {
      const inlet = this.hitTestInlet(m.x, m.y);
      if (inlet && inlet.boxId !== this.cableFrom.boxId) {
        // Validate cable types:
        // - audio → audio: OK (signal routing)
        // - audio → number: OK (AudioParam modulation)
        // - number → audio: REJECTED (can't send control to audio bus — use sig~)
        // - number → number: OK (control)
        const srcBoxObj = this.boxes.get(this.cableFrom.boxId);
        const srcDef = getDef(srcBoxObj?.text);
        const srcIsAudio = getOutletDef(srcBoxObj?.text, this.cableFrom.index)?.type === "audio";
        const dstIsAudio = this.isAudioInlet(inlet.boxId, inlet.index);
        if (!srcIsAudio && dstIsAudio) {
          // number → audio: rejected, use sig~ to bridge
          this.cableFrom = null;
          this.mode = "idle";
          this.canvas.style.cursor = "default";
          this.render();
          return;
        }
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
      if (this.tooltipEl) this.tooltipEl.style.display = "none";
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
            this.onSend({ type: "toggle-click", id, value: next });
            this.render();
          } else if (type === "event" || type === "fan") {
            this.onSend({ type: "event-click", id });
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
      const box = this.boxes.get(boxId);
      if (box && isAbstraction(box.text)) {
        this.onOpenAbstraction(box.text);
        return;
      }
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

    // Arrow key nudging
    if (this.selection.size > 0 && (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const step = e.shiftKey ? 20 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      for (const id of this.selection) {
        const box = this.boxes.get(id);
        if (box) { box.x += dx; box.y += dy; }
      }
      this.dirty = true;
      this.render();
      return true;
    }

    if (e.key === "Enter" && this.selection.size === 1) {
      e.preventDefault();
      this.startEditing([...this.selection][0]);
      return true;
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

  // --- Wheel: scroll to pan, ctrl/meta+scroll or pinch to zoom ---

  _onWheel(e) {
    e.preventDefault();
    // Check if scrolling over a knob box
    const m = this.canvasCoords(e);
    const knobId = this.hitTestBox(m.x, m.y);
    if (knobId !== null) {
      const box = this.boxes.get(knobId);
      if (box && boxTypeName(box.text) === "knob") {
        const args = box.text.split(/\s+/).slice(1).map(Number);
        const min = args[1] !== undefined ? args[1] : 0;
        const max = args[2] !== undefined ? args[2] : 1;
        const curve = args[3] || 1;
        const range = max - min;
        const current = this.boxValues.get(knobId) ?? (args[0] !== undefined ? args[0] : 0.5);
        // Work in normalised 0-1 space, apply curve
        const norm = range !== 0 ? Math.pow(Math.max(0, Math.min(1, (current - min) / range)), 1 / curve) : 0;
        const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        const step = e.shiftKey ? 0.0005 : 0.005;
        const newNorm = Math.max(0, Math.min(1, norm - delta * step));
        const newVal = min + Math.pow(newNorm, curve) * range;
        this.boxValues.set(knobId, newVal);
        this.onSend({ type: "knob", id: knobId, value: newVal });
        this.render();
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      // Pinch-zoom or ctrl+scroll → zoom around cursor
      const r = this.canvas.getBoundingClientRect();
      const cx = (e.clientX - r.left) / this.zoom + this.panX;
      const cy = (e.clientY - r.top) / this.zoom + this.panY;
      const factor = Math.pow(0.99, e.deltaY);
      const newZoom = Math.max(0.15, Math.min(3, this.zoom * factor));
      // Adjust pan so the point under the cursor stays fixed
      this.panX = cx - (e.clientX - r.left) / newZoom;
      this.panY = cy - (e.clientY - r.top) / newZoom;
      this.zoom = newZoom;
    } else {
      // Scroll to pan
      this.panX += e.deltaX / this.zoom;
      this.panY += e.deltaY / this.zoom;
    }
    this.render();
  }

  // --- Zoom to fit: show all boxes centered in viewport ---

  zoomToFit() {
    if (this.boxes.size === 0) return;
    const margin = 60;
    const dpr = window.devicePixelRatio || 1;
    const vw = this.canvas.width / dpr;
    const vh = this.canvas.height / dpr;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [id, box] of this.boxes) {
      const bw = this.boxWidth(box, id);
      if (box.x < minX) minX = box.x;
      if (box.y < minY) minY = box.y;
      if (box.x + bw > maxX) maxX = box.x + bw;
      if (box.y + BOX_HEIGHT > maxY) maxY = box.y + BOX_HEIGHT;
    }

    const pw = maxX - minX + margin * 2;
    const ph = maxY - minY + margin * 2;
    this.zoom = Math.min(1, vw / pw, vh / ph);
    this.panX = minX - margin - (vw / this.zoom - pw) / 2;
    this.panY = minY - margin - (vh / this.zoom - ph) / 2;
    this.render();
  }

  // --- Reset view to 100% zoom, origin ---

  resetView() {
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.render();
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

export { PatchEditor, COLORS, BOX_HEIGHT, BOX_PAD_X, PORT_W, PORT_H, PORT_HIT, SYNTH_HANDLE, FONT, SMALL_FONT, COMMENT_FONT, abstractionTypes, loadAbstractions, isAbstraction, getPorts, getDef, distToSeg };
