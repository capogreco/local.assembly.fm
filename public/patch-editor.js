import { BOX_TYPES, MAX_DEPTH, GRID, SNAP, BOX_HEIGHT, snapToGrid, snapPos, routerY, textBoxWidth, formatValue, knobArgs, commentText, faceOf, faceContents, boxTypeName, boxBinding, cableTypeProblem, getAbstractionDef, getBoxPorts, getBoxDef, getInletDef, getOutletDef, isOffSide, movesOffSide, sideOf, useAbstractions } from "./gpi-types.js";
import { COLORS, onThemeChange } from "./theme.js";

// --- constants ---

// Colours come from the active theme (theme.js); COLORS is that live palette.
// GRID, SNAP and BOX_HEIGHT come from gpi-types.js: the side rule needs them.
const BOX_PAD_X = 8, PORT_W = 8, PORT_H = 3, PORT_HIT = 8, BORDER_HANDLE = 8;
const FONT = '12px "IBM Plex Mono", "Fira Mono", "Courier New", monospace';
const SMALL_FONT = '10px "IBM Plex Mono", monospace';
const SMALL_CHAR_W = 6; // SMALL_FONT's glyph advance (0.6em)
const COMMENT_FONT = 'italic 12px "IBM Plex Mono", "Fira Mono", "Courier New", monospace';

// --- editor modes ---

// The platform's command key: Cmd on macOS, Ctrl elsewhere. Cmd+E toggles the
// editor mode; holding it in edit mode uses a box as if in run mode (as in Pd).
// Ctrl on macOS is the context-menu click, so it isn't the run modifier there.
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
function platformMod(e) { return IS_MAC ? e.metaKey : e.ctrlKey; }

// Boxes that answer the pointer in run mode: gui "control" in gpi-types.
const INTERACTIVE_TYPES = new Set(Object.entries(BOX_TYPES).filter(([, d]) => d.gui === "control").map(([name]) => name));

// Knob sensitivity: normalised units per screen pixel of vertical drag.
const KNOB_DRAG_STEP = 0.005, KNOB_DRAG_STEP_FINE = 0.0005;

// --- abstraction registry ---
// name ("lib/name") → header { name, side, description, args, inlets, outlets,
// face }, straight from the file, plus `boxes` (a Map) for drawing the face.
// gpi-types reads it too (useAbstractions), so an instance's ports, port
// types, side and size resolve as for a built-in box.

const abstractionTypes = new Map();
useAbstractions(abstractionTypes);

async function loadAbstractions() {
  try {
    const res = await fetch("/abstractions");
    const names = await res.json();
    const fresh = await Promise.all(names.map(async (name) => {
      const r = await fetch(`/abstractions/${encodeURIComponent(name)}`);
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      const { side, description, args, inlets, outlets, face, boxes } = await r.json();
      return { name, side, description, args, inlets, outlets, face: face ?? null, boxes: new Map(boxes) };
    }));
    abstractionTypes.clear();
    for (const def of fresh) abstractionTypes.set(def.name, def);
    console.log(`Loaded ${abstractionTypes.size} abstraction(s)`);
  } catch (e) {
    console.error("Failed to load abstractions:", e);
  }
}

function isAbstraction(text) {
  return abstractionTypes.has(boxTypeName(text));
}

// A box type's documentation: the built-in row, or the abstraction's header
// shaped like one (args as a one-line summary).
function getDef(text) {
  const abs = abstractionTypes.get(boxTypeName(text));
  if (!abs) return getBoxDef(text);
  const args = abs.args.map((a) => `${a.name}:${a.type}`).join(" ");
  return { description: `${abs.description} (${abs.side} side)`, args: args || undefined, inlets: abs.inlets, outlets: abs.outlets };
}

// --- utility ---

// An instance's args, from its text.
function instanceArgs(text) {
  return text.trim().split(/\s+/).slice(1);
}

// A box inside an abstraction, with the instance's args for $1, $2, ... as
// expansion fills them in ($0 stays: only the server knows it).
function fillArgs(text, args) {
  return text.replace(/\$(\d+)/g, (ref, n) => (n !== "0" && args[n - 1] !== undefined ? args[n - 1] : ref));
}

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
    this.onError = options.onError ?? (() => {});

    // Patch data
    this.boxes = new Map();
    this.cables = new Map();
    this.nextId = 1;

    // Selection
    this.selection = new Set();
    this.cableSelection = new Set();

    // Runtime values
    this.boxValues = new Map();
    // The running patch's abstraction instances (the server's `instances`):
    // id → { text, ids: local id → live id }. A face finds the live box
    // behind each of its boxes here; nested instances are keys too.
    this.instances = new Map();

    // Interaction state: idle / dragging / cabling / selecting / resizing-border / text-editing
    this.mode = "idle";
    this.dragStart = null;
    this.dragBoxPositions = null;
    this.cableFrom = null;
    this.dragSnapshot = null;
    this.resizeSnapshot = null;
    this.mousePos = { x: 0, y: 0 };
    this.editingBoxId = null;
    this.knobDrag = null;
    // Whether the run modifier (Cmd, or Ctrl off macOS) is held. Kept by the
    // host page's keydown/keyup and by every mouse move, so cursors set
    // outside a pointer event (mode switch, end of a knob drag) can use it.
    this.modHeld = false;

    // Editor mode: "edit" (select, move, cable, type) or "run" (the pointer
    // plays interactive boxes). Local to this editor; never sent anywhere.
    this.editorMode = "edit";

    // Layout
    this.borderY = snapToGrid(options.borderY ?? canvas.height * 0.55);
    this.showBorder = options.showBorder ?? true;

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
    this._endKnobDrag = this._endKnobDrag.bind(this);
  }

  bindEvents() {
    this._offTheme = onThemeChange(() => this.render());
    this.canvas.addEventListener("mousedown", this._onMouseDown);
    this.canvas.addEventListener("mousemove", this._onMouseMove);
    this.canvas.addEventListener("mouseup", this._onMouseUp);
    this.canvas.addEventListener("dblclick", this._onDblClick);
    this.canvas.addEventListener("wheel", this._onWheel, { passive: false });
  }

  unbindEvents() {
    this._offTheme?.();
    this._offTheme = null;
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
      borderY: this.borderY
    });
  }

  load(data) {
    if (typeof data === "string") data = JSON.parse(data);
    this.boxes.clear();
    this.cables.clear();
    for (const [id, box] of data.boxes) {
      const p = getBoxPorts(box.text);
      box.inlets = p.inlets;
      box.outlets = p.outlets;
      this.boxes.set(id, box);
    }
    for (const [id, cable] of data.cables) this.cables.set(id, cable);
    this.nextId = data.nextId || 1;
    if (data.borderY !== undefined) this.borderY = snapToGrid(data.borderY);
    // The grid is binding: patches saved before it snap as they load, and
    // routers straddle the border.
    for (const [, box] of this.boxes) {
      box.x = snapPos(box.x);
      box.y = this.isRouterType(box.text) ? routerY(this.borderY) : snapPos(box.y);
    }
    this.selection.clear();
    this.cableSelection.clear();
    // Fit view to show all boxes
    this.zoomToFit();
  }

  // After the abstraction registry loads (startup, a save): every instance
  // takes its header's port counts, and a cable to a port that no longer
  // exists is dropped. Returns one line per dropped cable, and one per faced
  // instance its new face size takes off its side, for the caller to show
  // (notes/abstractions.md, step 6).
  syncAbstractionPorts() {
    for (const box of this.boxes.values()) {
      if (!isAbstraction(box.text)) continue;
      const p = getBoxPorts(box.text);
      box.inlets = p.inlets;
      box.outlets = p.outlets;
    }
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const dropped = [];
    for (const [id, c] of [...this.cables]) {
      const src = this.boxes.get(c.srcBox), dst = this.boxes.get(c.dstBox);
      let line = null;
      if (dst && isAbstraction(dst.text) && c.dstInlet >= dst.inlets) {
        line = `"${boxTypeName(dst.text)}": cable to inlet ${c.dstInlet} dropped (now ${plural(dst.inlets, "inlet")})`;
      } else if (src && isAbstraction(src.text) && c.srcOutlet >= src.outlets) {
        line = `"${boxTypeName(src.text)}": cable from outlet ${c.srcOutlet} dropped (now ${plural(src.outlets, "outlet")})`;
      }
      if (!line) continue;
      this.cables.delete(id);
      this.cableSelection.delete(id);
      dropped.push(line);
    }
    const cut = dropped.length;
    // A faced instance takes its size from the header too (boxWidth and
    // boxHeight read the face live). A face that changed may no longer lie
    // wholly on its side: listed, not moved; apply refuses it until it is.
    if (this.showBorder) {
      for (const box of this.boxes.values()) {
        const face = faceOf(box.text);
        if (!face || !isOffSide(box, this.borderY)) continue;
        dropped.push(`"${boxTypeName(box.text)}": its face is now ${face.w}×${face.h} and no longer lies wholly on the ${boxBinding(box.text)} side; move it`);
      }
    }
    if (cut > 0) {
      this.dirty = true;
      this.onDirty();
    }
    return dropped;
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

  // Forget the instance maps of every instance of these abstractions (names),
  // nested ones too: after a save their layout may not match the ids the
  // running patch was built with, so their faces grey out until the next
  // apply.
  forgetInstancesOf(names) {
    for (const [id, m] of this.instances) {
      if (names.has(boxTypeName(m.text))) this.instances.delete(id);
    }
  }

  // Take the server's instance maps (JSON: string keys).
  setInstances(record) {
    this.instances = new Map(Object.entries(record ?? {}).map(([id, m]) => [Number(id), m]));
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

    // Whole grid units, so a final snap (below) can't make boxes overlap.
    // A layer is as tall as its tallest box (a face is several units), then
    // this gap before the next.
    const LAYER_GAP = 2 * GRID;
    const H_GAP = GRID;
    const SUBGRAPH_GAP = 3 * GRID;
    const TOP_MARGIN = 2 * GRID;
    const BORDER_PAD = 2 * GRID;

    // Build adjacency
    const childrenOf = new Map();
    const parentsOf = new Map();
    for (const [id] of this.boxes) { childrenOf.set(id, []); parentsOf.set(id, []); }
    for (const [, cable] of this.cables) {
      childrenOf.get(cable.srcBox)?.push(cable.dstBox);
      parentsOf.get(cable.dstBox)?.push(cable.srcBox);
    }

    // Partition into ctrl / synth / router
    const ctrlBoxes = [], synthBoxes = [], routerBoxes = [];
    for (const [id, box] of this.boxes) {
      if (this.isRouterType(box.text)) routerBoxes.push(id);
      else if (this.sideOfBox(box) === "ctrl") ctrlBoxes.push(id);
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
      if (layers.length === 0) return { layers: [], tops: [], width: 0, height: 0, minX: 0 };

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

      // Each layer's top, accumulated from the tallest box in the layers above.
      const tops = [];
      let y = 0;
      for (const l of layers) {
        tops.push(y);
        y += Math.max(BOX_HEIGHT, ...l.map((id) => this.boxHeight(this.boxes.get(id), id))) + LAYER_GAP;
      }
      return { layers, tops, width: maxBX - minBX, height: y, minX: minBX };
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
            box.y = startY + r.tops[li];
          }
        }

        cursorX += r.width + SUBGRAPH_GAP;
        maxHeight = Math.max(maxHeight, r.height);
      }

      return startY + maxHeight;
    };

    const ctrlEnd = layoutRegion(ctrlBoxes, TOP_MARGIN);
    if (ctrlEnd + BORDER_PAD > this.borderY && ctrlBoxes.length > 0) {
      this.borderY = snapToGrid(ctrlEnd + BORDER_PAD);
    }

    // Place routers on border, x-aligned to connected boxes
    for (const id of routerBoxes) {
      const box = this.boxes.get(id);
      box.y = routerY(this.borderY);
      const connected = [
        ...(parentsOf.get(id) || []),
        ...(childrenOf.get(id) || [])
      ].map(n => this.boxes.get(n)).filter(Boolean);
      if (connected.length > 0) {
        box.x = connected.reduce((s, b) => s + b.x, 0) / connected.length;
      }
    }

    layoutRegion(synthBoxes, this.borderY + BORDER_PAD);
    // Snap to the grid. Widths and gaps are whole units, so rounding each x
    // moves neighbours at most half a unit closer and never into each other.
    for (const [, box] of this.boxes) { box.x = snapPos(box.x); box.y = snapPos(box.y); }
    this.zoomToFit();
    this.dirty = true;
    this.onDirty();
    this.render();
  }

  // --- Geometry ---

  boxesAABBOverlap(aId, a, bId, b) {
    const aW = this.boxWidth(a, aId);
    const bW = this.boxWidth(b, bId);
    const xOverlap = a.x < b.x + bW && b.x < a.x + aW;
    const yOverlap = a.y < b.y + this.boxHeight(b, bId) && b.y < a.y + this.boxHeight(a, aId);
    return xOverlap && yOverlap;
  }

  // Piston cascade: after a membrane displacement, resolve any remaining
  // box overlaps by pushing in the sweep direction until settled.
  // `direction` is "down" (synth side was squeezed — push lower boxes further
  // down) or "up" (ctrl side was squeezed — push upper boxes further up).
  // Routers are anchored to the border and skipped.
  cascadeOverlaps(direction, PAD) {
    const ids = [];
    for (const [id, box] of this.boxes) {
      if (!this.isRouterType(box.text)) ids.push(id);
    }
    const MAX_ITERS = ids.length + 5;
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      let moved = false;
      for (let i = 0; i < ids.length; i++) {
        const a = this.boxes.get(ids[i]);
        for (let j = i + 1; j < ids.length; j++) {
          const b = this.boxes.get(ids[j]);
          if (!this.boxesAABBOverlap(ids[i], a, ids[j], b)) continue;
          const ha = this.boxHeight(a, ids[i]), hb = this.boxHeight(b, ids[j]);
          if (direction === "down") {
            // Push the lower of the two further down
            if (a.y >= b.y) { a.y = b.y + hb + PAD; }
            else { b.y = a.y + ha + PAD; }
          } else {
            // Push the upper of the two further up
            if (a.y <= b.y) { a.y = b.y - ha - PAD; }
            else { b.y = a.y - hb - PAD; }
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  canvasCoords(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / this.zoom + this.panX,
      y: (e.clientY - r.top) / this.zoom + this.panY,
    };
  }

  // The half-unit cell under patch point m: its top-left corner (a dot or
  // halfway between), where a box made there goes.
  gridCell(m) {
    return { x: Math.floor(m.x / SNAP) * SNAP, y: Math.floor(m.y / SNAP) * SNAP };
  }

  screenFromPatch(px, py) {
    return {
      x: (px - this.panX) * this.zoom,
      y: (py - this.panY) * this.zoom,
    };
  }

  hitTestBorderHandle(mx, my) {
    if (!this.showBorder) return false;
    // Handle is drawn pinned to viewport-left at world-x = panX + (BORDER_HANDLE/2)/zoom
    // with width BORDER_HANDLE/zoom. Hit area is 2x the visible width (matches the
    // pre-pin behaviour where hit was Math.abs(mx - BORDER_HANDLE) < BORDER_HANDLE).
    const handleCenter = this.panX + BORDER_HANDLE / this.zoom;
    const hitRadius = BORDER_HANDLE / this.zoom;
    return Math.abs(mx - handleCenter) < hitRadius && Math.abs(my - this.borderY) < hitRadius;
  }

  measureText(text) {
    this.ctx.font = FONT;
    return this.ctx.measureText(text).width;
  }

  // A faced abstraction instance's face { x, y, w, h, hideName }, or null.
  // While its text is being edited the instance is an ordinary text box.
  faceOfBox(box, id) {
    if (id !== undefined && id === this.editingBoxId) return null;
    return faceOf(box.text);
  }

  // Height of a box: one unit, or a faced instance's face height.
  boxHeight(box, id) {
    const face = this.faceOfBox(box, id);
    return face ? face.h * GRID : BOX_HEIGHT;
  }

  boxWidth(box, id) {
    const face = this.faceOfBox(box, id);
    if (face) return face.w * GRID;
    let text = (id !== undefined && id === this.editingBoxId && this.input)
      ? (this.input.value || " ") : (box.text || " ");
    const _type = boxTypeName(box.text);
    const _isMonitor = _type === "print"
      || (_type === "cc" && box.text.trim() === "cc")
      || (_type === "key" && box.text.split(/\s+/)[1] === "?");
    if (_isMonitor && id !== undefined && this.boxValues.has(id)) {
      const v = this.boxValues.get(id);
      text = _type + " " + (typeof v === "number" ? (Number.isInteger(v) ? v.toString() : v.toFixed(4)) : String(v));
    }
    // gpi-types' formula, which the server's face check uses too; a knob
    // gets room for its value label inside the box.
    return textBoxWidth(text, Math.max(box.inlets, box.outlets));
  }

  // Port centre x, as in Pd: port 0 flush with the left edge, the last port
  // flush with the right, the others evenly spaced between. A single port
  // sits flush left.
  portX(box, i, n, id) {
    if (n <= 1) return box.x + PORT_W / 2;
    const w = this.boxWidth(box, id);
    return box.x + PORT_W / 2 + i * (w - PORT_W) / (n - 1);
  }

  inletPos(box, i, id) {
    return { x: this.portX(box, i, box.inlets, id), y: box.y };
  }

  outletPos(box, i, id) {
    return { x: this.portX(box, i, box.outlets, id), y: box.y + this.boxHeight(box, id) };
  }

  // --- Hit Testing ---

  // A port's zone: PORT_HIT either side of its centre across, and down its
  // own box's half (inlets the top half, outlets the bottom) plus PORT_HIT
  // outside the box. Boxes stack flush on the grid, so the outside margin
  // counts only where no box is under the pointer: over a box, only that
  // box's ports can be hit, and a box's own halves never overlap.
  // `under` is the box under the pointer (hitTestBox), or null.
  portHit(id, box, mx, my, p, inlet, under) {
    if (under !== null && under !== id) return false;
    if (Math.abs(mx - p.x) >= PORT_HIT) return false;
    const h = this.boxHeight(box, id), mid = box.y + h / 2;
    return inlet ? my >= box.y - PORT_HIT && my < mid : my >= mid && my < box.y + h + PORT_HIT;
  }

  hitTestOutlet(mx, my) {
    const under = this.hitTestBox(mx, my);
    for (const [id, box] of this.boxes) {
      for (let i = 0; i < box.outlets; i++) {
        if (this.portHit(id, box, mx, my, this.outletPos(box, i, id), false, under)) return { boxId: id, index: i };
      }
    }
    return null;
  }

  hitTestInlet(mx, my) {
    const under = this.hitTestBox(mx, my);
    for (const [id, box] of this.boxes) {
      for (let i = 0; i < box.inlets; i++) {
        if (this.portHit(id, box, mx, my, this.inletPos(box, i, id), true, under)) return { boxId: id, index: i };
      }
    }
    return null;
  }

  hitTestBox(mx, my) {
    for (const [id, box] of [...this.boxes.entries()].reverse()) {
      const w = this.boxWidth(box, id);
      if (mx >= box.x && mx <= box.x + w && my >= box.y && my <= box.y + this.boxHeight(box, id)) return id;
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

  // Audio never crosses the border, and routers carry events and values only.
  // Returns a reason string, or null when the cable is fine.
  audioCableProblem(srcBoxId, srcOutlet, dstBoxId) {
    const src = this.boxes.get(srcBoxId), dst = this.boxes.get(dstBoxId);
    if (!src || !dst) return null;
    return this.audioProblemAt(src, srcOutlet, dst, this.borderY);
  }

  // audioCableProblem for boxes at given positions, against a given line.
  audioProblemAt(src, srcOutlet, dst, borderY) {
    if (getOutletDef(src.text, srcOutlet)?.type !== "audio") return null;
    if (this.isRouterType(src.text) || this.isRouterType(dst.text)) return "routers carry events and values, not audio";
    if (this.showBorder && this.sideOfBox(src, borderY) !== this.sideOfBox(dst, borderY)) return "audio can't cross the border; events and values cross through routers";
    return null;
  }

  // An audio cable the move just made a problem. Judged like
  // boundSideViolation: `before` holds each box's position (id → {x, y}) when
  // the move began, against beforeY, and a cable already a problem then
  // doesn't block the move.
  audioBorderViolation(before, beforeY = this.borderY) {
    for (const c of this.cables.values()) {
      const src = this.boxes.get(c.srcBox), dst = this.boxes.get(c.dstBox);
      if (!src || !dst) continue;
      const problem = this.audioProblemAt(src, c.srcOutlet, dst, this.borderY);
      if (!problem) continue;
      const ps = before.get(c.srcBox), pd = before.get(c.dstBox);
      if (ps && pd && this.audioProblemAt({ ...src, x: ps.x, y: ps.y }, c.srcOutlet, { ...dst, x: pd.x, y: pd.y }, beforeY)) continue;
      return problem;
    }
    return null;
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

  sideOfBox(box, borderY = this.borderY) {
    return sideOf(box, borderY);
  }

  // Side of a box against a line other than this.borderY (the border resize).
  sideOf(box, borderY) {
    return sideOf(box, borderY);
  }

  isSynthSide(boxId) {
    const box = this.boxes.get(boxId);
    return box ? this.sideOfBox(box) === "synth" : false;
  }

  // A bound box the move just took off side (isOffSide: on the other side, or
  // straddling the border). `before` holds each box's position (id → {x, y})
  // when the move began, against beforeY; a box already off side then moves
  // freely, so it can be brought back (movesOffSide). The abstraction editor
  // has no border, so nothing is off side there.
  boundSideViolation(before, beforeY = this.borderY) {
    if (!this.showBorder) return null;
    for (const [id, box] of this.boxes) {
      const prev = before.get(id);
      const from = prev ? { ...box, x: prev.x, y: prev.y } : null;
      if (movesOffSide(from, beforeY, box, this.borderY)) {
        const binding = this.sideOfBox(box);
        return `"${box.text}" is bound to the ${binding} side`;
      }
    }
    return null;
  }

  // Put a newly placed box where its type belongs: routers on the border,
  // bound boxes on their side, clear of the router row (which straddles the
  // line). Used where a box lands without a drag to refuse (text commit, paste).
  placeOnSide(box) {
    if (!this.showBorder) return;
    const rowTop = routerY(this.borderY);
    if (this.isRouterType(box.text)) { box.y = rowTop; return; }
    if (!isOffSide(box, this.borderY)) return;
    box.y = this.sideOfBox(box) === "synth" ? rowTop + BOX_HEIGHT : rowTop - this.boxHeight(box);
  }

  isRouterType(text) { return boxBinding(text) === "border"; }

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
      const ports = getBoxPorts(router.text);
      router.inlets = ports.inlets;
      router.outlets = ports.outlets;
      const channel = oldChannels;
      this.cables.set(this.nextId++, { srcBox: srcBoxId, srcOutlet, dstBox: routerId, dstInlet: channel });
      this.cables.set(this.nextId++, { srcBox: routerId, srcOutlet: channel, dstBox: dstBoxId, dstInlet });
      this.sortRouterChannels(routerId);
    } else {
      routerId = this.nextId++;
      const ports = getBoxPorts("all 1");
      this.boxes.set(routerId, { x: snapPos(midX - GRID), y: routerY(this.borderY), text: "all 1", inlets: ports.inlets, outlets: ports.outlets });
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
      let oneX = 0;
      for (const [, c] of this.cables) {
        if (c.dstBox === routerId && c.dstInlet === ch) {
          const src = this.boxes.get(c.srcBox);
          if (src) oneX = src.x + this.boxWidth(src, c.srcBox) / 2;
          break;
        }
      }
      channelInfo.push({ ch, oneX });
    }
    const sorted = [...channelInfo].sort((a, b) => a.oneX - b.oneX);
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
    const ports = getBoxPorts(router.text);
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
      if (this.isAudioCable(c)) continue; // audio is never routed; the drop is rejected on release
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

    // Dot grid (cover visible area in patch space), edit mode only
    const visW = w / this.zoom, visH = h / this.zoom;
    if (this.editorMode === "edit") {
      const gridStartX = Math.floor(this.panX / GRID) * GRID;
      const gridStartY = Math.floor(this.panY / GRID) * GRID;
      this.ctx.fillStyle = COLORS.grid;
      for (let x = gridStartX; x < this.panX + visW; x += GRID) {
        for (let y = gridStartY; y < this.panY + visH; y += GRID) {
          this.ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    // Border
    if (this.showBorder) {
      this.ctx.strokeStyle = COLORS.border;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(this.panX, this.borderY);
      this.ctx.lineTo(this.panX + visW, this.borderY);
      this.ctx.stroke();
      // Handle + labels: pin to canvas-left regardless of pan/zoom by
      // converting "12px from viewport left" → world coord (panX + 12/zoom).
      const handleX = this.panX + (BORDER_HANDLE / 2) / this.zoom;
      const handleSize = BORDER_HANDLE / this.zoom;
      const labelX = this.panX + 12 / this.zoom;
      this.ctx.fillStyle = COLORS.borderHandle;
      this.ctx.fillRect(handleX, this.borderY - handleSize / 2, handleSize, handleSize);
      this.ctx.font = SMALL_FONT;
      this.ctx.fillStyle = COLORS.borderLabel;
      this.ctx.textBaseline = "bottom";
      this.ctx.fillText("ctrl", labelX, this.borderY - 6 / this.zoom);
      this.ctx.textBaseline = "top";
      this.ctx.fillText("synth", labelX, this.borderY + 6 / this.zoom);
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
      this.ctx.strokeStyle = COLORS.marquee;
      this.ctx.setLineDash([3, 3]);
      this.ctx.strokeRect(x0, y0, sw, sh);
      this.ctx.setLineDash([]);
    }

    // Boxes
    for (const [id, box] of this.boxes) {
      const selected = this.selection.has(id);
      const face = this.faceOfBox(box, id);
      if (face) {
        this.drawFace(box.text, box.x, box.y, face, this.liveInstance(id, box.text), 0, selected);
        this.drawPorts(box, id);
        continue;
      }
      const bw = this.boxWidth(box, id);
      const def = getDef(box.text);

      // Comment: just text
      if (def?.isComment) {
        if (this.editingBoxId !== id) this.drawComment(box.text, box.x, box.y, selected);
        if (selected) {
          this.ctx.strokeStyle = COLORS.boxSelectedStroke;
          this.ctx.setLineDash([2, 2]);
          this.ctx.strokeRect(box.x + 0.5, box.y + 0.5, bw - 1, BOX_HEIGHT - 1);
          this.ctx.setLineDash([]);
        }
        continue;
      }

      const isRouter = def?.binding === "border";
      const isAbs = isAbstraction(box.text);
      this.drawBoxBody(box.text, box.x, box.y, bw, {
        fill: selected ? COLORS.boxSelectedFill : isRouter ? COLORS.routerFill : isAbs ? COLORS.abstractionFill : COLORS.boxFill,
        stroke: selected ? COLORS.boxSelectedStroke : isRouter ? COLORS.routerStroke : isAbs ? COLORS.abstractionStroke : COLORS.boxStroke,
        dashed: !def && box.text.length > 0,
        value: this.boxValues.has(id) ? this.boxValues.get(id) : undefined,
        hideText: this.editingBoxId === id,
      });
      this.drawPorts(box, id);
    }

    // Knob value labels: inside the box, right-aligned (boxWidth leaves room).
    for (const [id, box] of this.boxes) {
      if (boxTypeName(box.text) !== "knob" || !this.boxValues.has(id) || this.editingBoxId === id) continue;
      this.drawKnobLabel(this.boxValues.get(id), box.x, box.y, this.boxWidth(box, id));
    }

    // Draw overlays in screen space (reset pan/zoom)
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    this.renderOverlay(this.ctx, w, h);

    this.ctx.restore();
  }

  // --- Drawing pieces (top-level boxes and the boxes on a face) ---

  // A one-unit text box: fill, stroke, value bar and text (a monitor shows
  // its value). `value` undefined: no bar.
  drawBoxBody(text, x, y, w, { fill, stroke, dashed = false, value, hideText = false }) {
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, BOX_HEIGHT);
    ctx.strokeStyle = stroke;
    if (dashed) ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, BOX_HEIGHT - 1);
    if (dashed) ctx.setLineDash([]);

    const type = boxTypeName(text);
    if (value !== undefined) {
      let barVal = value;
      // Normalize scale box display to its own range
      if (type === "scale" && typeof value === "number") {
        const args = text.split(/\s+/).slice(1);
        const sMin = parseFloat(args[0]) || 0, sMax = parseFloat(args[1]) || 1;
        barVal = sMax !== sMin ? (value - sMin) / (sMax - sMin) : 0;
      }
      if (type === "knob" && typeof value === "number") {
        // Show linear position in normalised (pre-curve) space for intuitive bar
        const { min, max, curve } = this.knobArgs(text);
        barVal = max !== min ? Math.pow(Math.max(0, Math.min(1, (value - min) / (max - min))), 1 / curve) : 0;
      }
      if (typeof barVal === "number" && barVal >= 0 && barVal <= 1) {
        ctx.fillStyle = COLORS.valueBar;
        ctx.fillRect(x + 1, y + 1, (w - 2) * barVal, BOX_HEIGHT - 2);
      }
    }

    if (hideText) return;
    ctx.font = FONT;
    ctx.fillStyle = COLORS.text;
    ctx.textBaseline = "middle";
    const isMon = type === "print"
      || (type === "cc" && text.trim() === "cc")
      || (type === "key" && text.split(/\s+/)[1] === "?");
    if (isMon && value !== undefined) {
      ctx.fillText(type + " " + formatValue(value), x + BOX_PAD_X, y + BOX_HEIGHT / 2);
    } else {
      ctx.fillText(text, x + BOX_PAD_X, y + BOX_HEIGHT / 2);
    }
  }

  drawComment(text, x, y, selected) {
    this.ctx.font = COMMENT_FONT;
    this.ctx.fillStyle = selected ? COLORS.text : COLORS.commentText;
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(commentText(text), x + BOX_PAD_X, y + BOX_HEIGHT / 2);
  }

  // A knob's value: inside its box (width w), right-aligned (textBoxWidth
  // leaves room for the widest value it shows).
  drawKnobLabel(value, x, y, w) {
    this.ctx.font = SMALL_FONT;
    this.ctx.fillStyle = COLORS.valueText;
    this.ctx.textBaseline = "middle";
    this.ctx.textAlign = "right";
    this.ctx.fillText(formatValue(value), x + w - BOX_PAD_X, y + BOX_HEIGHT / 2);
    this.ctx.textAlign = "left";
  }

  // Inlets inside the top edge, outlets inside the bottom, coloured by port
  // type, as in Pd: nothing of a box protrudes, so it can sit snug against
  // the border line. Cables meet the edge (inletPos, outletPos).
  drawPorts(box, id) {
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
      this.ctx.fillRect(p.x - PORT_W / 2, p.y, PORT_W, PORT_H);
    }
    for (let i = 0; i < box.outlets; i++) {
      const p = this.outletPos(box, i, id);
      const oDef = getOutletDef(box.text, i);
      this.ctx.fillStyle = oDef?.type === "audio" ? COLORS.portAudio : oDef?.type === "event" ? COLORS.portEvent : COLORS.port;
      this.ctx.fillRect(p.x - PORT_W / 2, p.y - PORT_H, PORT_W, PORT_H);
    }
  }

  // --- Faces ---
  // A faced instance draws at its face's size and shows the GUI boxes inside
  // the face (gpi-types faceContents), translated and clipped. Each box on a
  // face is driven by its live box: `live` is the instance's map from the
  // server (local id → live id), null before the patch is applied, when the
  // face shows its boxes' starting values, greyed, and doesn't play.

  // The running instance behind top-level box `id`, if its text hasn't
  // changed since the apply.
  liveInstance(id, text) {
    const m = this.instances.get(id);
    return m && m.text === text ? m : null;
  }

  // A box on a face: the value it shows, from its live box, or (not yet
  // applied) the value it starts at.
  faceValue(text, liveId, applied) {
    if (applied) return liveId !== undefined && this.boxValues.has(liveId) ? this.boxValues.get(liveId) : undefined;
    const type = boxTypeName(text);
    if (type === "knob") return this.knobArgs(text).init;
    if (type === "toggle") return 0;
    return undefined;
  }

  drawFace(text, x, y, face, live, depth, selected) {
    const ctx = this.ctx;
    const W = face.w * GRID, H = face.h * GRID;
    ctx.fillStyle = selected ? COLORS.boxSelectedFill : COLORS.abstractionFill;
    ctx.fillRect(x, y, W, H);
    const def = getAbstractionDef(boxTypeName(text));
    if (def && depth < MAX_DEPTH) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, W, H);
      ctx.clip();
      if (!live && depth === 0) ctx.globalAlpha *= 0.45;
      const args = instanceArgs(text);
      const knobs = [];
      for (const item of faceContents(def).shown) {
        const ix = x + item.x, iy = y + item.y;
        const t = fillArgs(item.box.text, args);
        const liveId = live ? live.ids[item.id] : undefined;
        if (item.kind === "face") {
          const inner = liveId !== undefined ? this.instances.get(liveId) ?? null : null;
          this.drawFace(t, ix, iy, faceOf(t), inner, depth + 1, false);
          continue;
        }
        if (item.kind === "label") { this.drawComment(t, ix, iy, false); continue; }
        const value = this.faceValue(t, liveId, !!live);
        this.drawBoxBody(t, ix, iy, item.w, { fill: COLORS.boxFill, stroke: COLORS.boxStroke, value });
        if (boxTypeName(t) === "knob" && value !== undefined) knobs.push([value, ix, iy, item.w]);
      }
      for (const [v, kx, ky, kw] of knobs) this.drawKnobLabel(v, kx, ky, kw);
      ctx.restore();
    }
    // The name and args, in the top row: inside the face, cut to its width.
    if (!face.hideName) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, W, H);
      ctx.clip();
      ctx.font = SMALL_FONT;
      ctx.fillStyle = COLORS.commentText;
      ctx.textBaseline = "top";
      const fit = Math.floor((W - 6) / SMALL_CHAR_W);
      ctx.fillText(text.length > fit ? text.slice(0, Math.max(0, fit - 1)) + "…" : text, x + 3, y + 2);
      ctx.restore();
    }
    ctx.strokeStyle = selected ? COLORS.boxSelectedStroke : COLORS.abstractionStroke;
    ctx.strokeRect(x + 0.5, y + 0.5, W - 1, H - 1);
  }

  // What a run press at patch point m plays: { id, text } — the live box id
  // the server knows and its text (args filled in) — or null. On a face, the
  // control under the pointer, through nested faces.
  runTargetAt(m) {
    const id = this.hitTestBox(m.x, m.y);
    if (id === null) return null;
    const box = this.boxes.get(id);
    const face = this.faceOfBox(box, id);
    if (!face) return INTERACTIVE_TYPES.has(boxTypeName(box.text)) ? { id, text: box.text } : null;
    return this.faceTargetAt(box.text, box.x, box.y, this.liveInstance(id, box.text), m, 0);
  }

  faceTargetAt(text, x, y, live, m, depth) {
    // Not applied yet: the face doesn't play.
    if (!live || depth >= MAX_DEPTH) return null;
    const def = getAbstractionDef(boxTypeName(text));
    if (!def) return null;
    const args = instanceArgs(text);
    const shown = faceContents(def).shown;
    for (let i = shown.length - 1; i >= 0; i--) {
      const item = shown[i];
      const ix = x + item.x, iy = y + item.y;
      if (m.x < ix || m.x > ix + item.w || m.y < iy || m.y > iy + item.h) continue;
      const liveId = live.ids[item.id];
      const t = fillArgs(item.box.text, args);
      if (item.kind === "face") return this.faceTargetAt(t, ix, iy, liveId !== undefined ? this.instances.get(liveId) ?? null : null, m, depth + 1);
      if (item.kind !== "control" || liveId === undefined) return null;
      return { id: liveId, text: t };
    }
    return null;
  }

  // --- Editor mode ---

  // Switch between "edit" and "run". A box being typed into is committed
  // first. Returns false (and stays put) while the mouse is mid-gesture.
  setEditorMode(next) {
    if (next !== "edit" && next !== "run") throw new Error(`unknown editor mode: ${next}`);
    if (next === this.editorMode) return true;
    if (this.mode === "text-editing") this.finishEditing(true);
    if (this.mode !== "idle" || this.isPanning) return false;
    this.editorMode = next;
    if (next === "run") {
      // As in Pd: nothing stays selected in run mode.
      this.selection.clear();
      this.cableSelection.clear();
    }
    if (this.tooltipEl) this.tooltipEl.style.display = "none";
    this.canvas.style.cursor = this.spaceHeld ? "grab" : this.hoverCursor(this.mousePos, this.modHeld);
    this.render();
    return true;
  }

  toggleEditorMode() {
    return this.setEditorMode(this.editorMode === "edit" ? "run" : "edit");
  }

  // Whether a pointer event acts as run mode: in run mode, or Cmd/Ctrl held in edit.
  isRunPress(e) {
    return this.editorMode === "run" || platformMod(e);
  }

  // Cursor for the pointer resting at patch point m (no gesture in progress).
  hoverCursor(m, runPress) {
    if (runPress || this.editorMode === "run") {
      const target = this.runTargetAt(m);
      if (!target) return "default";
      return boxTypeName(target.text) === "knob" ? "ns-resize" : "pointer";
    }
    if (this.hitTestBorderHandle(m.x, m.y)) return "ns-resize";
    if (this.hitTestOutlet(m.x, m.y) || this.hitTestInlet(m.x, m.y)) return "crosshair";
    return this.hitTestBox(m.x, m.y) !== null ? "move" : "default";
  }

  // --- Knob value (normalised 0-1 space, with the knob's curve) ---

  knobArgs(text) { return knobArgs(text); }

  // A knob is { id, text }: its live id and its text (runTargetAt), so a
  // knob on a face works as one in the patch.
  knobNorm(knob) {
    const { init, min, max, curve } = this.knobArgs(knob.text);
    const range = max - min;
    const current = this.boxValues.get(knob.id) ?? init;
    return range !== 0 ? Math.pow(Math.max(0, Math.min(1, (current - min) / range)), 1 / curve) : 0;
  }

  setKnobNorm(knob, norm) {
    const { min, max, curve } = this.knobArgs(knob.text);
    const clamped = Math.max(0, Math.min(1, norm));
    const value = min + Math.pow(clamped, curve) * (max - min);
    this.boxValues.set(knob.id, value);
    this.onSend({ type: "knob", id: knob.id, value });
    this.render();
  }

  // --- Run-mode press: toggles and events fire on mousedown, knobs start a drag ---
  // The target may be a control on a face: its live id goes to the server.

  _onRunPress(e, m) {
    if (e.button !== 0) return;
    const target = this.runTargetAt(m);
    if (!target) return;
    const { id } = target;
    const type = boxTypeName(target.text);
    if (type === "toggle") {
      const cur = this.boxValues.get(id) || 0;
      const next = cur > 0 ? 0 : 1;
      this.boxValues.set(id, next);
      this.onSend({ type: "toggle-click", id, value: next });
      this.render();
    } else if (type === "event" || type === "fan") {
      this.onSend({ type: "event-click", id });
    } else if (type === "knob") {
      e.preventDefault();
      this.mode = "knob-dragging";
      this.knobDrag = { knob: target, lastY: e.clientY, norm: this.knobNorm(target) };
      this.canvas.style.cursor = "ns-resize";
      // The button may come up off the canvas, where the canvas never hears it.
      globalThis.addEventListener("mouseup", this._endKnobDrag, { once: true });
    }
  }

  // --- Text Editing ---

  startEditing(boxId) {
    if (!this.input) return;
    const box = this.boxes.get(boxId);
    if (!box) return;
    this.editingBoxId = boxId;
    this.mode = "text-editing";
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
      const ports = getBoxPorts(newText);
      box.inlets = ports.inlets;
      box.outlets = ports.outlets;
      // Prune invalid cables
      for (const [id, c] of this.cables) {
        if (c.srcBox === this.editingBoxId && c.srcOutlet >= box.outlets) this.cables.delete(id);
        if (c.dstBox === this.editingBoxId && c.dstInlet >= box.inlets) this.cables.delete(id);
      }
      this.placeOnSide(box);
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

    if (this.isRunPress(e)) {
      this._onRunPress(e, m);
      return;
    }

    if (this.hitTestBorderHandle(m.x, m.y)) {
      this.mode = "resizing-border";
      // The piston moves boxes as well as the border; keep both to restore.
      this.resizeSnapshot = {
        borderY: this.borderY,
        boxes: new Map([...this.boxes.entries()].map(([id, b]) => [id, { x: b.x, y: b.y }])),
      };
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
    this.modHeld = platformMod(e);

    if (this.mode === "knob-dragging") {
      // Vertical drag: up raises, Shift for fine. Incremental, so pressing or
      // releasing Shift mid-drag doesn't make the value jump.
      const step = e.shiftKey ? KNOB_DRAG_STEP_FINE : KNOB_DRAG_STEP;
      const kd = this.knobDrag;
      kd.norm = Math.max(0, Math.min(1, kd.norm - (e.clientY - kd.lastY) * step));
      kd.lastY = e.clientY;
      this.setKnobNorm(kd.knob, kd.norm);
      return;
    }

    if (this.mode === "resizing-border") {
      // The border sits on a row of dots (whole units, not SNAP), low enough
      // to leave room for the router row above it.
      const newY = Math.max(2 * GRID, snapToGrid(m.y));
      const oldY = this.borderY;
      if (newY === oldY) return;
      this.borderY = newY;
      // Pushed boxes stay on the grid, touching the router row.
      const PAD = 0;
      // Piston: a box on the side the membrane moves into, which the new line
      // touches, is pushed wholly clear of it, keeping its side (taken against
      // the old line). Then cascade-resolve overlaps in the sweep direction so
      // the push propagates through stacked boxes instead of squashing them.
      // The router row straddles the line (routerY .. + BOX_HEIGHT), so a box
      // is pushed clear of that whole row, as placeOnSide places it.
      const ctrlLimit = routerY(newY), synthLimit = ctrlLimit + BOX_HEIGHT;
      for (const [id, box] of this.boxes) {
        if (this.isRouterType(box.text)) {
          box.y = ctrlLimit;
          continue;
        }
        const side = this.sideOf(box, oldY), h = this.boxHeight(box, id);
        if (newY > oldY && side === "synth" && box.y < synthLimit) box.y = synthLimit + PAD;
        else if (newY < oldY && side === "ctrl" && box.y + h > ctrlLimit) box.y = ctrlLimit - h - PAD;
      }
      this.cascadeOverlaps(newY > oldY ? "down" : "up", PAD);
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

      // Live snap: the drag moves in half units, so boxes stay on the grid.
      const dx = snapPos(m.x - this.dragStart.x), dy = snapPos(m.y - this.dragStart.y);
      for (const [id, orig] of this.dragBoxPositions) {
        const box = this.boxes.get(id);
        if (!box) continue;
        box.x = orig.x + dx;
        box.y = this.isRouterType(box.text) ? routerY(this.borderY) : orig.y + dy;
      }
      if (this.showBorder) this.autoRouteBorderCrossings(this.selection);
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
          const portDef = i
            ? getInletDef(box.text, port.index)
            : getOutletDef(box.text, port.index);
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
    const runPress = this.isRunPress(e);
    if (!this.spaceHeld) this.canvas.style.cursor = this.hoverCursor(m, runPress);
    if (!runPress && this.hitTestBorderHandle(m.x, m.y)) {
      if (this.tooltipEl) this.tooltipEl.style.display = "none";
    } else {
      // Ports can't be cabled in run mode, so only box tooltips show there.
      const o = runPress ? null : this.hitTestOutlet(m.x, m.y);
      const i = runPress ? null : this.hitTestInlet(m.x, m.y);

      const port = i || o;
      if (port) {
        const box = this.boxes.get(port.boxId);
        if (box) {
          const portDef = i
            ? getInletDef(box.text, port.index)
            : getOutletDef(box.text, port.index);
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
          const def = box ? getDef(box.text) : null;
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

    if (this.mode === "knob-dragging") {
      this._endKnobDrag();
      return;
    }

    const m = this.canvasCoords(e);

    if (this.mode === "resizing-border") {
      const problem = this.resizeSnapshot && (this.audioBorderViolation(this.resizeSnapshot.boxes, this.resizeSnapshot.borderY) ?? this.boundSideViolation(this.resizeSnapshot.boxes, this.resizeSnapshot.borderY));
      if (problem) {
        this.borderY = this.resizeSnapshot.borderY;
        for (const [id, pos] of this.resizeSnapshot.boxes) {
          const box = this.boxes.get(id);
          if (box) { box.x = pos.x; box.y = pos.y; }
        }
        this.onError(["✗ border move cancelled: " + problem]);
        this.render();
      } else {
        this.pushUndo();
      }
      this.resizeSnapshot = null;
      this.mode = "idle";
      this.canvas.style.cursor = "default";
      return;
    }

    if (this.mode === "cabling" && this.cableFrom) {
      const inlet = this.hitTestInlet(m.x, m.y);
      if (inlet && inlet.boxId !== this.cableFrom.boxId) {
        // Port types, by the rule apply uses (gpi-types cableTypeProblem):
        // audio into audio or a built-in audio box's AudioParam; nothing
        // else into audio (bridge with sig~).
        const srcBoxObj = this.boxes.get(this.cableFrom.boxId);
        const dstBoxObj = this.boxes.get(inlet.boxId);
        const typeProblem = cableTypeProblem(
          getOutletDef(srcBoxObj?.text, this.cableFrom.index)?.type,
          dstBoxObj?.text, getInletDef(dstBoxObj?.text, inlet.index));
        if (typeProblem) {
          this.onError(["✗ cable rejected: " + typeProblem]);
          this.cableFrom = null;
          this.mode = "idle";
          this.canvas.style.cursor = "default";
          this.render();
          return;
        }
        const audioProblem = this.audioCableProblem(this.cableFrom.boxId, this.cableFrom.index, inlet.boxId);
        if (audioProblem) {
          this.onError(["✗ cable rejected: " + audioProblem]);
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
        if (this.showBorder && srcSynth !== dstSynth && !this.isRouterType(srcBox?.text) && !this.isRouterType(dstBox?.text)) {
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
      const dropProblem = moved && this.dragSnapshot ? (this.audioBorderViolation(this.dragSnapshot.boxes) ?? this.boundSideViolation(this.dragSnapshot.boxes)) : null;
      if (dropProblem) {
        this.cables.clear();
        for (const [id, c] of this.dragSnapshot.cables) this.cables.set(id, { ...c });
        this.boxes.clear();
        for (const [id, b] of this.dragSnapshot.boxes) this.boxes.set(id, { ...b });
        this.nextId = this.dragSnapshot.nextId;
        this.onError(["✗ move cancelled: " + dropProblem]);
        this.render();
      } else if (moved) {
        this.pushUndo();
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
        if (box.x + bw > x0 && box.x < x1 && box.y + this.boxHeight(box, id) > y0 && box.y < y1) {
          this.selection.add(id);
        }
      }
      this.mode = "idle";
      this.dragStart = null;
      this.render();
    }
  }

  // Called by both the canvas mouseup and the one-shot window mouseup, so
  // the second call finds the drag already over.
  _endKnobDrag() {
    if (this.mode !== "knob-dragging") return;
    this.mode = "idle";
    this.knobDrag = null;
    this.canvas.style.cursor = this.spaceHeld ? "grab" : this.hoverCursor(this.mousePos, this.modHeld);
  }

  _onDblClick(e) {
    // Run mode (or a Cmd-held run press in edit) never edits text or makes boxes.
    if (this.isRunPress(e)) return;
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
      this.boxes.set(id, { ...this.gridCell(m), text: "", inlets: 1, outlets: 1 });
      this.cables.set(this.nextId++, { srcBox: cable.srcBox, srcOutlet: cable.srcOutlet, dstBox: id, dstInlet: 0 });
      this.cables.set(this.nextId++, { srcBox: id, srcOutlet: 0, dstBox: cable.dstBox, dstInlet: cable.dstInlet });
      this.selection.clear();
      this.selection.add(id);
      this.startEditing(id);
      return;
    }
    this.pushUndo();
    const id = this.nextId++;
    this.boxes.set(id, { ...this.gridCell(m), text: "", inlets: 1, outlets: 1 });
    this.selection.clear();
    this.selection.add(id);
    this.startEditing(id);
  }

  // --- Keyboard (called externally) ---

  onKeyDown(e) {
    if (this.mode === "text-editing") return false;
    // Delete, nudge, Enter-to-edit, Tab-create, Escape: all edit-mode only.
    if (this.editorMode === "run") return false;

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
      // Half a unit per press, a whole unit with Shift: the grid is binding.
      const step = e.shiftKey ? GRID : SNAP;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      const before = new Map([...this.boxes].map(([id, b]) => [id, { x: b.x, y: b.y }]));
      // Routers stay on the border, as in a drag: they nudge sideways only.
      const ddy = (box) => this.isRouterType(box.text) ? 0 : dy;
      for (const id of this.selection) {
        const box = this.boxes.get(id);
        if (box) { box.x += dx; box.y += ddy(box); }
      }
      // Same rule as a drop: a nudge that takes a bound box off side, or audio
      // across the border, doesn't happen.
      const problem = this.audioBorderViolation(before) ?? this.boundSideViolation(before);
      if (problem) {
        for (const id of this.selection) {
          const box = this.boxes.get(id);
          if (box) { box.x -= dx; box.y -= ddy(box); }
        }
        this.onError(["✗ move cancelled: " + problem]);
      } else {
        this.dirty = true;
      }
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
      this.boxes.set(id, { x: srcBox.x, y: srcBox.y + this.boxHeight(srcBox, srcId) + GRID, text: "", inlets: 1, outlets: 1 });
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
    // Scrolling over a knob sets it, in run mode only. Ctrl/meta wheel is
    // zoom, and pinch-zoom arrives as a ctrl wheel, so those always zoom,
    // even over a knob.
    const zoomGesture = e.ctrlKey || e.metaKey;
    if (this.editorMode === "run" && !zoomGesture) {
      const m = this.canvasCoords(e);
      const knob = this.runTargetAt(m);
      if (knob && boxTypeName(knob.text) === "knob") {
        const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        const step = e.shiftKey ? 0.0005 : 0.005;
        this.setKnobNorm(knob, this.knobNorm(knob) - delta * step);
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
      if (box.y + this.boxHeight(box, id) > maxY) maxY = box.y + this.boxHeight(box, id);
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

export { PatchEditor, platformMod, COLORS, GRID, BOX_HEIGHT, snapToGrid, BOX_PAD_X, PORT_W, PORT_H, PORT_HIT, BORDER_HANDLE, FONT, SMALL_FONT, COMMENT_FONT, abstractionTypes, loadAbstractions, isAbstraction, getDef, distToSeg };
