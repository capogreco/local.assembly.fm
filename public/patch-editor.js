import { BOX_TYPES, MAX_DEPTH, GRID, SNAP, BOX_HEIGHT, snapToGrid, snapPos, routerY, textBoxWidth, formatValue, knobArgs, commentText, faceOf, faceContents, boxTypeName, boxBinding, cableTypeProblem, getAbstractionDef, getBoxPorts, getBoxDef, getInletDef, getOutletDef, isOffSide, movesOffSide, sideOf, wholeSide, useAbstractions } from "./gpi-types.js";
import { COLORS, onThemeChange } from "./theme.js";

// --- constants ---

// Colours come from the active theme (theme.js); COLORS is that live palette.
// GRID, SNAP and BOX_HEIGHT come from gpi-types.js: the side rule needs them.
const BOX_PAD_X = 8, PORT_W = 8, PORT_H = 3, PORT_HIT = 8, BORDER_HANDLE = 8;
const FONT = '12px "IBM Plex Mono", "Fira Mono", "Courier New", monospace';
const SMALL_FONT = '10px "IBM Plex Mono", monospace';
const SMALL_CHAR_W = 6; // SMALL_FONT's glyph advance (0.6em)
const COMMENT_FONT = 'italic 12px "IBM Plex Mono", "Fira Mono", "Courier New", monospace';
const FIT_MARGIN = 60; // zoomToFit's margin round the patch, in screen pixels

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

// Routers carry ctrl to synth only; values go up through sendup and uplink.
const ROUTER_TO_CTRL = "a router's outlets feed the synth side only; values go up through sendup and uplink";

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
    this.gestureUndo = null;  // serialized patch at a gesture's start (pushGestureUndo)
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

  // `state` is a serialized patch to return to (default: now). A gesture
  // (drag, Option-drag, border drag) keeps the state from its start and
  // pushes it at the drop, if the patch changed (pushGestureUndo).
  pushUndo(state = this.serialize()) {
    this.undoStack.push(state);
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.dirty = true;
    this.onDirty();
  }

  // End of a gesture: one undo step back to its start, if anything changed.
  pushGestureUndo() {
    const state = this.gestureUndo;
    this.gestureUndo = null;
    if (state && state !== this.serialize()) this.pushUndo(state);
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

  // --- Rebuild layout (`l`; notes/editor-modes.md, Grid) ---
  // Ctrl editor, edit mode; one undo step (none if nothing moves). The
  // selection's flow, or the whole patch's, is laid out afresh. Routers are
  // the spine: they stay on the border row (x may move), ctrl boxes layer
  // upward from the router inlets they feed (longest path), synth boxes
  // downward from router outlets; a piece with no router layers from its own
  // ends. Rows are level, as tall as their tallest box (faces), the gap
  // between them the patch's most common one (half a unit if it has none).
  // Within a row, boxes are ordered by barycentre sweeps out from the
  // routers, seeded by their current x (so a router's port order orders the
  // columns); an outlet 0 → inlet 0 chain between neighbouring rows becomes
  // one vertical line, other boxes sit at their sources' barycentre, pushed
  // at least a unit apart. Boxes stacked flush (outlet 0 into inlet 0,
  // touching) move as one. A comment rides with the box it sits over
  // (nearest within three units, same side, routers aside), keeping its
  // offset; the rows make room for it. Boxes with no cable to another in
  // scope, comments with no box near, and (with a selection) every box
  // outside it stay where they are, and nothing rebuilt lands on them.
  // Separate pieces are shelf-packed into rows as wide as the window at the
  // current zoom, from the scope's top-left. The border moves down when the
  // ctrl side needs the room above it, never up, pushing boxes it crosses as
  // a border drag does. Then the view fits the patch.

  rebuildLayout() {
    if (this.boxes.size === 0) return;
    const before = this.serialize();
    // A pass is seeded by the current x, so it is repeated (up to four
    // times) until it reproduces itself: pressing `l` again changes nothing.
    const positions = () => JSON.stringify([...this.boxes].map(([id, b]) => [id, b.x, b.y]).concat(this.borderY));
    for (let pass = 0; pass < 4; pass++) {
      const was = positions();
      this.layoutPass();
      if (positions() === was) break;
    }
    if (this.serialize() === before) return;
    this.pushUndo(before);
    this.zoomToFit();
  }

  // One pass of rebuildLayout.
  layoutPass() {
    const B = (id) => this.boxes.get(id);
    const wOf = (id) => this.boxWidth(B(id), id), hOf = (id) => this.boxHeight(B(id), id);
    const isComment = (id) => !!getDef(B(id).text)?.isComment;
    const isRouter = (id) => this.showBorder && this.isRouterType(B(id).text);
    const border0 = this.borderY;
    const sideAt = (id) => !this.showBorder ? "synth" : isRouter(id) ? "border" : this.sideOfBox(B(id), border0);
    const outOff = (id, i) => this.outletPos(B(id), i, id).x - B(id).x;
    const inOff = (id, i) => this.inletPos(B(id), i, id).x - B(id).x;
    const scope = new Set(this.selection.size > 0 ? [...this.selection].filter((id) => this.boxes.has(id)) : this.boxes.keys());

    // Snap. A loaded patch already is; this catches a box put off the grid
    // some other way.
    for (const id of scope) {
      const b = B(id);
      b.x = snapPos(b.x);
      b.y = isRouter(id) ? routerY(border0) : snapPos(b.y);
    }

    const cables = [...this.cables.values()].filter((c) => c.srcBox !== c.dstBox && this.boxes.has(c.srcBox) && this.boxes.has(c.dstBox));
    const rebuilt = new Set();
    for (const c of cables) {
      if (scope.has(c.srcBox) && scope.has(c.dstBox)) { rebuilt.add(c.srcBox); rebuilt.add(c.dstBox); }
    }
    if (rebuilt.size === 0) return;

    // Flush stacks: outlet 0 straight into inlet 0, touching, same side.
    const flushDown = new Map(), flushUp = new Map();
    for (const c of cables) {
      const s = c.srcBox, d = c.dstBox;
      if (c.srcOutlet !== 0 || c.dstInlet !== 0 || !rebuilt.has(s) || !rebuilt.has(d) || isRouter(s) || isRouter(d)) continue;
      if (flushDown.has(s) || flushUp.has(d) || sideAt(s) !== sideAt(d)) continue;
      if (B(d).x === B(s).x && B(d).y === B(s).y + hOf(s)) { flushDown.set(s, d); flushUp.set(d, s); }
    }

    // The gap between rows: the most common gap over the scope's cables
    // (half units, up to three units; the smaller on a tie), else half a unit.
    const hist = new Map();
    for (const c of cables) {
      const s = c.srcBox, d = c.dstBox;
      if (!rebuilt.has(s) || !rebuilt.has(d) || isRouter(s) || isRouter(d) || flushDown.get(s) === d) continue;
      const g = snapPos(B(d).y - (B(s).y + hOf(s)));
      if (g >= 0 && g <= 3 * GRID) hist.set(g, (hist.get(g) ?? 0) + 1);
    }
    let gap = SNAP, most = 0;
    for (const [g, n] of [...hist].sort((a, b) => a[0] - b[0])) if (n > most) { most = n; gap = g; }

    // Nodes: a box, or a flush stack moving as one (members share x).
    const nodes = new Map(), nodeOf = new Map();
    for (const id of rebuilt) {
      if (flushUp.has(id)) continue;
      const members = [];
      let h = 0;
      for (let m = id; m !== undefined; m = flushDown.get(m)) { members.push({ id: m, dy: h }); h += hOf(m); }
      const w = Math.max(...members.map((m) => wOf(m.id)));
      nodes.set(id, { members, w, h, side: sideAt(id), x0: B(id).x, y0: B(id).y, ext: { l: 0, t: 0, r: w, b: h }, riders: [] });
      for (const m of members) nodeOf.set(m.id, id);
    }

    // Comments ride with the box they sit over: the nearest within three
    // units on their side (the one below on a tie), if it is rebuilt.
    const riding = new Set();
    for (const id of scope) {
      if (!isComment(id)) continue;
      const c = B(id), cw = wOf(id), ch = hOf(id), side = sideAt(id);
      let host = null, best = null;
      for (const [oid, o] of this.boxes) {
        if (oid === id || isComment(oid) || isRouter(oid) || sideAt(oid) !== side) continue;
        const dx = Math.max(0, o.x - (c.x + cw), c.x - (o.x + wOf(oid)));
        const dy = Math.max(0, o.y - (c.y + ch), c.y - (o.y + hOf(oid)));
        const d = Math.hypot(dx, dy), below = o.y >= c.y ? 0 : 1;
        if (d > 3 * GRID) continue;
        if (best === null || d < best[0] || (d === best[0] && below < best[1])) { best = [d, below]; host = oid; }
      }
      if (host === null || !rebuilt.has(host)) continue;
      const n = nodes.get(nodeOf.get(host)), dy = n.members.find((m) => m.id === host).dy;
      const ox = c.x - B(host).x, oy = c.y - B(host).y + dy;
      n.riders.push({ id, ox, oy, side });
      // The rows make room above and below for it; it widens its box only
      // where it sits beside it (a heading above doesn't push the row apart).
      n.ext.t = Math.min(n.ext.t, oy);
      n.ext.b = Math.max(n.ext.b, oy + ch);
      if (oy < n.h && oy + ch > 0) {
        n.ext.l = Math.min(n.ext.l, ox);
        n.ext.r = Math.max(n.ext.r, ox + cw);
      }
      riding.add(id);
    }

    // Edges between nodes (cables the side rules allow), and context: cables
    // to boxes that stay, which only steer the order within rows. A router
    // outside the scope still anchors the boxes it is cabled to.
    const edges = [], context = new Map(), anchors = new Set();
    for (const c of cables) {
      const s = c.srcBox, d = c.dstBox, sn = nodeOf.get(s), dn = nodeOf.get(d);
      if (sn !== undefined && dn !== undefined) {
        if (sn === dn) continue;
        const ss = nodes.get(sn).side, ds = nodes.get(dn).side;
        const ok = ss === ds ? ss !== "border" : (ss === "ctrl" && ds === "border") || (ss === "border" && ds === "synth");
        if (!ok) continue;
        edges.push({ s: sn, d: dn, so: c.srcOutlet, di: c.dstInlet, sOff: outOff(s, c.srcOutlet), dOff: inOff(d, c.dstInlet), sBottom: !flushDown.has(s), dTop: !flushUp.has(d), back: false });
      } else if (sn !== undefined) {
        if (!context.has(sn)) context.set(sn, []);
        context.get(sn).push(this.inletPos(B(d), c.dstInlet, d).x - outOff(s, c.srcOutlet));
        if (isRouter(d) && nodes.get(sn).side === "ctrl") anchors.add(sn);
      } else if (dn !== undefined) {
        if (!context.has(dn)) context.set(dn, []);
        context.get(dn).push(this.outletPos(B(s), c.srcOutlet, s).x - inOff(d, c.dstInlet));
        if (isRouter(s) && nodes.get(dn).side === "synth") anchors.add(dn);
      }
    }

    // Cycles: drop back edges (a DFS from the top-left) from layering.
    const order = [...nodes.keys()].sort((a, b) => nodes.get(a).y0 - nodes.get(b).y0 || nodes.get(a).x0 - nodes.get(b).x0 || a - b);
    const outEdges = new Map(order.map((k) => [k, []]));
    for (const e of edges) outEdges.get(e.s).push(e);
    const state = new Map();
    const dfs = (k) => {
      state.set(k, 1);
      for (const e of outEdges.get(k)) {
        if (state.get(e.d) === 1) e.back = true;
        else if (!state.has(e.d)) dfs(e.d);
      }
      state.set(k, 2);
    };
    for (const k of order) if (!state.has(k)) dfs(k);
    const fwd = edges.filter((e) => !e.back);

    // Ranks: distance from the border row, counted along the flow away from
    // it (ctrl: against the cables, synth: with them). Boxes a router reaches
    // take the longest path from it; the rest sit just above (ctrl: below)
    // what they feed, and at least their own longest path from their ends.
    const rank = new Map();
    for (const [k, n] of nodes) if (n.side === "border") rank.set(k, 0);
    for (const side of ["ctrl", "synth"]) {
      const vs = order.filter((k) => nodes.get(k).side === side), vset = new Set(vs);
      const par = new Map(vs.map((k) => [k, []])), kid = new Map(vs.map((k) => [k, []]));
      const anchored = new Set([...anchors].filter((k) => vset.has(k)));
      for (const e of fwd) {
        const [a, b] = side === "synth" ? [e.s, e.d] : [e.d, e.s];
        if (!vset.has(b)) continue;
        if (vset.has(a)) { par.get(b).push(a); kid.get(a).push(b); }
        else if (nodes.get(a).side === "border") anchored.add(b);
      }
      const indeg = new Map(vs.map((k) => [k, par.get(k).length]));
      const topo = vs.filter((k) => indeg.get(k) === 0);
      for (let i = 0; i < topo.length; i++) {
        for (const b of kid.get(topo[i])) { indeg.set(b, indeg.get(b) - 1); if (indeg.get(b) === 0) topo.push(b); }
      }
      const reached = new Set(), lp = new Map();
      for (const v of topo) {
        const rp = par.get(v).filter((p) => reached.has(p));
        if (anchored.has(v) || rp.length > 0) {
          reached.add(v);
          rank.set(v, Math.max(anchored.has(v) ? 1 : 0, ...rp.map((p) => rank.get(p) + 1)));
        } else {
          lp.set(v, Math.max(1, ...par.get(v).map((p) => lp.get(p) + 1)));
        }
      }
      for (const v of [...topo].reverse()) {
        if (reached.has(v)) continue;
        const ks = kid.get(v).map((c) => rank.get(c));
        rank.set(v, ks.length > 0 ? Math.max(lp.get(v), Math.min(...ks) - 1) : lp.get(v));
      }
      for (const v of topo) for (const p of par.get(v)) rank.set(v, Math.max(rank.get(v), rank.get(p) + 1));
    }
    const rowOf = (k) => nodes.get(k).side === "ctrl" ? -rank.get(k) : rank.get(k);
    const left = (k) => nodes.get(k).ext.l, right = (k) => nodes.get(k).ext.r;

    // Neighbours of each node, for ordering and x.
    const adj = new Map([...nodes.keys()].map((k) => [k, []]));
    for (const e of edges) {
      adj.get(e.s).push({ other: e.d, mine: e.sOff, theirs: e.dOff, e });
      adj.get(e.d).push({ other: e.s, mine: e.dOff, theirs: e.sOff, e });
    }

    // Pieces: connected through the edges (routers join the sides).
    const pieceOf = new Map();
    const find = (k) => { while (pieceOf.has(k) && pieceOf.get(k) !== k) k = pieceOf.get(k); return k; };
    for (const k of nodes.keys()) pieceOf.set(k, k);
    for (const e of edges) { const a = find(e.s), b = find(e.d); if (a !== b) pieceOf.set(b, a); }
    const byPiece = new Map();
    for (const k of order) { const r = find(k); if (!byPiece.has(r)) byPiece.set(r, []); byPiece.get(r).push(k); }

    const layoutPiece = (keys) => {
      const px = new Map(keys.map((k) => [k, nodes.get(k).x0]));
      const rowIds = [...new Set(keys.map(rowOf))].sort((a, b) => a - b);
      const rows = new Map(rowIds.map((r) => [r, keys.filter((k) => rowOf(k) === r).sort((a, b) => px.get(a) - px.get(b) || a - b)]));

      // Order a row by where its neighbours in the `ref` rows (and boxes that
      // stay) would have it, then spread it a unit apart from those keys.
      const orderRow = (r, ref) => {
        const row = rows.get(r), key = new Map();
        for (const k of row) {
          const ts = [];
          for (const a of adj.get(k)) if (ref(rowOf(a.other))) ts.push(px.get(a.other) + a.theirs - a.mine);
          for (const t of context.get(k) ?? []) ts.push(t);
          key.set(k, ts.length > 0 ? ts.reduce((s, t) => s + t, 0) / ts.length : px.get(k));
        }
        row.sort((a, b) => key.get(a) - key.get(b) || px.get(a) - px.get(b) || a - b);
        let edge = -Infinity;
        for (const k of row) {
          const x = Math.max(key.get(k), edge - left(k));
          px.set(k, x);
          edge = x + right(k) + GRID;
        }
      };
      const ctrlRows = rowIds.filter((r) => r < 0), synthRows = rowIds.filter((r) => r > 0);
      const outward = () => {
        for (const r of [...ctrlRows].reverse()) orderRow(r, (q) => q > r);
        for (const r of synthRows) orderRow(r, (q) => q < r);
      };
      const inward = () => {
        for (const r of ctrlRows) orderRow(r, (q) => q < r);
        for (const r of [...synthRows].reverse()) orderRow(r, (q) => q > r);
        if (rows.has(0)) orderRow(0, (q) => q !== 0);
      };
      for (let i = 0; i < 4; i++) { outward(); inward(); }
      outward();

      // Vertical chains: outlet 0 → inlet 0 between neighbouring rows, at
      // most one each way per node, never crossing another.
      const idx = new Map();
      for (const [, row] of rows) row.forEach((k, i) => idx.set(k, i));
      let down = new Map(), up = new Map();
      for (const r of rowIds) {
        if (!rows.has(r + 1)) continue;
        let last = -1;
        for (const v of rows.get(r + 1)) {
          let best = null;
          for (const a of adj.get(v)) {
            const e = a.e, u = e.s;
            if (e.back || e.d !== v || e.so !== 0 || e.di !== 0 || !e.sBottom || !e.dTop) continue;
            if (rowOf(u) !== r || down.has(u) || idx.get(u) <= last) continue;
            if (best === null || Math.abs(px.get(u) - px.get(v)) < Math.abs(px.get(best) - px.get(v))) best = u;
          }
          if (best !== null) { down.set(best, v); up.set(v, best); last = idx.get(best); }
        }
      }

      // Blocks (a chain shares one x) and the order constraints between them.
      const blockOf = new Map();
      const graph = () => {
        blockOf.clear();
        for (const k of keys) if (!up.has(k)) for (let m = k; m !== undefined; m = down.get(m)) blockOf.set(m, k);
        const preds = new Map(), succs = new Map(), indeg = new Map();
        for (const k of keys) if (blockOf.get(k) === k) { preds.set(k, new Map()); succs.set(k, new Set()); indeg.set(k, 0); }
        for (const [, row] of rows) {
          for (let i = 1; i < row.length; i++) {
            const a = blockOf.get(row[i - 1]), b = blockOf.get(row[i]), w = right(row[i - 1]) - left(row[i]) + GRID;
            if (!succs.get(a).has(b)) { succs.get(a).add(b); indeg.set(b, indeg.get(b) + 1); }
            preds.get(b).set(a, Math.max(preds.get(b).get(a) ?? -Infinity, w));
          }
        }
        const topo = [...indeg].filter(([, d]) => d === 0).map(([k]) => k);
        for (let i = 0; i < topo.length; i++) {
          for (const b of succs.get(topo[i])) { indeg.set(b, indeg.get(b) - 1); if (indeg.get(b) === 0) topo.push(b); }
        }
        return topo.length === preds.size ? { preds, topo } : null;
      };
      let g = graph();
      if (!g) { down = new Map(); up = new Map(); g = graph(); }
      const members = new Map();
      for (const k of keys) { const b = blockOf.get(k); if (!members.has(b)) members.set(b, []); members.get(b).push(k); }

      // x: each block at its sources' barycentre (its targets' if it has no
      // sources); row neighbours that come closer than a unit are pushed
      // apart evenly, then exactly (rightward, in order); repeated to a
      // standstill.
      const cons = [];
      for (const b of g.topo) for (const [a, w] of g.preds.get(b)) cons.push([a, b, w]);
      let bx = new Map(g.topo.map((b) => [b, snapPos(px.get(b))]));
      const target = (b) => {
        const par = [], kid = [];
        for (const k of members.get(b)) {
          for (const a of adj.get(k)) {
            const ob = blockOf.get(a.other);
            if (ob === b || a.e.back) continue;
            (rowOf(a.other) < rowOf(k) ? par : kid).push(bx.get(ob) + a.theirs - a.mine);
          }
        }
        const ts = par.length > 0 ? par : kid;
        return ts.length > 0 ? snapPos(ts.reduce((s, t) => s + t, 0) / ts.length) : bx.get(b);
      };
      for (let it = 0; it < 100; it++) {
        const x = new Map(g.topo.map((b) => [b, target(b)]));
        for (let pass = 0; pass < 100; pass++) {
          let pushed = false;
          for (const [a, b, w] of cons) {
            const v = x.get(a) + w - x.get(b);
            if (v > 0.5) { x.set(a, x.get(a) - v / 2); x.set(b, x.get(b) + v / 2); pushed = true; }
          }
          if (!pushed) break;
        }
        for (const b of g.topo) {
          let v = snapPos(x.get(b));
          for (const [a, w] of g.preds.get(b)) v = Math.max(v, x.get(a) + w);
          x.set(b, v);
        }
        const same = g.topo.every((b) => x.get(b) === bx.get(b));
        bx = x;
        if (same) break;
      }
      const xs = new Map(keys.map((k) => [k, bx.get(blockOf.get(k))]));
      const minL = Math.min(...keys.map((k) => xs.get(k) + left(k)));
      const maxR = Math.max(...keys.map((k) => xs.get(k) + right(k)));
      const lx = new Map(keys.map((k) => [k, xs.get(k) - minL]));
      const hasRouter = keys.some((k) => nodes.get(k).side === "border");
      return {
        keys, lx, width: maxR - minL,
        type: hasRouter ? "R" : nodes.get(keys[0]).side,
        cx: Math.min(...keys.map((k) => nodes.get(k).x0 + left(k))),
        cy0: Math.min(...keys.map((k) => nodes.get(k).y0 + nodes.get(k).ext.t)),
        cy1: Math.max(...keys.map((k) => nodes.get(k).y0 + nodes.get(k).ext.b)),
      };
    };
    const pieces = [...byPiece.values()].map(layoutPiece);

    // Reading order, kept from the arrangement: pieces whose extents overlap
    // vertically form a line, lines from the border outward, each by x.
    const lines = (ps, ctrl) => {
      ps.sort((a, b) => (ctrl ? b.cy1 - a.cy1 : a.cy0 - b.cy0) || a.cx - b.cx);
      const out = [];
      let cur = null, lo = 0, hi = 0;
      for (const p of ps) {
        if (cur && p.cy0 < hi && p.cy1 > lo) { cur.push(p); lo = Math.min(lo, p.cy0); hi = Math.max(hi, p.cy1); }
        else { cur = [p]; out.push(cur); lo = p.cy0; hi = p.cy1; }
      }
      return out.flatMap((l) => l.sort((a, b) => a.cx - b.cx));
    };
    const W = this.viewWidth(), PIECE_GAP = 3 * GRID, SHELF_GAP = 2 * GRID;
    const R = pieces.filter((p) => p.type === "R").sort((a, b) => a.cx - b.cx);
    let rEnd = 0;
    for (const p of R) rEnd += p.width + PIECE_GAP;
    const shelve = (ps) => {
      const shelves = [{ ps: [], end: rEnd }];
      for (const p of ps) {
        let s = shelves[shelves.length - 1];
        if (s.end > 0 && s.end + p.width > W) { s = { ps: [], end: 0 }; shelves.push(s); }
        p.shelf = shelves.length - 1;
        s.ps.push(p);
        s.end += p.width + PIECE_GAP;
      }
      return shelves;
    };
    for (const p of R) p.shelf = 0;
    const ctrlShelves = shelve(lines(pieces.filter((p) => p.type === "ctrl"), true));
    const synthShelves = shelve(lines(pieces.filter((p) => p.type === "synth"), false));

    // Rows per shelf: y of each rank relative to the shelf's base (ctrl: its
    // bottom, rows going up; synth: its top, rows going down), and the
    // shelf's far edge.
    const shelfRows = (shelf, i, side) => {
      const ext = new Map();
      for (const p of i === 0 ? [...R, ...shelf.ps] : shelf.ps) {
        for (const k of p.keys) {
          const n = nodes.get(k);
          if (n.side !== side) continue;
          const e = ext.get(rank.get(k)) ?? { t: 0, b: 0 };
          e.t = Math.min(e.t, n.ext.t);
          e.b = Math.max(e.b, n.ext.b);
          ext.set(rank.get(k), e);
        }
      }
      const ys = new Map();
      let edge = 0;
      for (const r of [...ext.keys()].sort((a, b) => a - b)) {
        const e = ext.get(r);
        if (side === "ctrl") { ys.set(r, edge - e.b); edge = edge - e.b + e.t - gap; }
        else { ys.set(r, edge - e.t); edge = edge - e.t + e.b + gap; }
      }
      const far = ys.size === 0 ? 0 : side === "ctrl" ? edge + gap : edge - gap;
      return { ys, far };
    };
    const stack = (shelves, side) => {
      const out = [];
      let base = 0;
      shelves.forEach((s, i) => {
        const r = shelfRows(s, i, side);
        out.push({ base, ys: r.ys });
        if (r.far !== 0) base = side === "ctrl" ? base + r.far - SHELF_GAP : base + r.far + SHELF_GAP;
      });
      return { shelves: out, far: base === 0 ? 0 : side === "ctrl" ? base + SHELF_GAP : base - SHELF_GAP };
    };
    const ctrlStack = stack(ctrlShelves, "ctrl"), synthStack = stack(synthShelves, "synth");

    // Anchor: at the scope's top-left; with routers, the rows hang off the
    // border row. The border moves down for room above, never up.
    const top0 = (side) => Math.min(...[...nodes.values()].filter((n) => n.side === side).map((n) => n.y0 + n.ext.t));
    const hasCtrl = [...nodes.values()].some((n) => n.side === "ctrl");
    let border = border0, ctrlBase = 0;
    if (hasCtrl) {
      if (R.length > 0) {
        ctrlBase = routerY(border) - gap;
        const need = top0("ctrl") - (ctrlBase + ctrlStack.far);
        if (need > 0) { border += Math.ceil(need / GRID) * GRID; ctrlBase += border - border0; }
      } else {
        ctrlBase = top0("ctrl") - ctrlStack.far;
        if (this.showBorder && ctrlBase > border) border = Math.ceil(ctrlBase / GRID) * GRID;
      }
    }
    const synthBase = R.length > 0 ? routerY(border) + BOX_HEIGHT + gap
      : Math.max(top0("synth"), this.showBorder ? border : -Infinity);

    // The border moved: routers ride it, boxes that stay and that it now
    // crosses are pushed down, as a border drag pushes them.
    if (border !== border0) {
      this.borderY = border;
      const stays = (id) => !rebuilt.has(id) && !riding.has(id);
      const moved = new Set();
      for (const [id, b] of this.boxes) {
        if (this.isRouterType(b.text)) { b.y = routerY(border); continue; }
        if (stays(id) && this.sideOf(b, border0) === "synth" && b.y < border) { b.y = border; moved.add(id); }
      }
      this.cascadeOverlaps("down", 0, "synth", border0, moved, null, stays);
    }

    // y of each node.
    const nodeY = (p, k) => {
      const n = nodes.get(k);
      if (n.side === "border") return routerY(border);
      const st = n.side === "ctrl" ? ctrlStack : synthStack, s = st.shelves[p.shelf];
      return (n.side === "ctrl" ? ctrlBase : synthBase) + s.base + s.ys.get(rank.get(k));
    };

    // x: pieces left to right along their shelves, from the scope's left
    // edge, each moved right past any box that stays which it would land on.
    const obstacles = [];
    for (const [id, b] of this.boxes) {
      if (!rebuilt.has(id) && !riding.has(id)) obstacles.push({ x0: b.x, y0: b.y, x1: b.x + wOf(id), y1: b.y + hOf(id) });
    }
    const rects = (p, x) => {
      const out = [];
      for (const k of p.keys) {
        const n = nodes.get(k), nx = x + p.lx.get(k), ny = nodeY(p, k);
        for (const m of n.members) out.push({ x0: nx, y0: ny + m.dy, x1: nx + wOf(m.id), y1: ny + m.dy + hOf(m.id) });
        for (const r of n.riders) out.push({ x0: nx + r.ox, y0: ny + r.oy, x1: nx + r.ox + wOf(r.id), y1: ny + r.oy + hOf(r.id) });
      }
      return out;
    };
    const place = (p, x) => {
      for (let guard = 0; guard < 500; guard++) {
        let shift = 0;
        for (const r of rects(p, x)) {
          for (const o of obstacles) {
            if (r.x0 < o.x1 + SNAP && o.x0 < r.x1 + SNAP && r.y0 < o.y1 + SNAP && o.y0 < r.y1 + SNAP) shift = Math.max(shift, o.x1 + GRID - r.x0);
          }
        }
        if (shift <= 0) break;
        x += shift;
      }
      p.ax = x;
      return x + p.width + PIECE_GAP;
    };
    const X0 = Math.min(...[...nodes.values()].map((n) => n.x0 + n.ext.l));
    let rCursor = X0;
    for (const p of R) rCursor = place(p, rCursor);
    for (const shelves of [ctrlShelves, synthShelves]) {
      shelves.forEach((s, i) => {
        let cursor = i === 0 && R.length > 0 ? rCursor : X0;
        for (const p of s.ps) cursor = place(p, cursor);
      });
    }

    // Write the positions; comments follow their boxes, kept on their side.
    for (const p of pieces) {
      for (const k of p.keys) {
        const n = nodes.get(k), x = p.ax + p.lx.get(k), y = nodeY(p, k);
        for (const m of n.members) { B(m.id).x = x; B(m.id).y = y + m.dy; }
        for (const r of n.riders) {
          const c = B(r.id), h = hOf(r.id);
          c.x = x + r.ox;
          c.y = y + r.oy;
          if (this.showBorder) c.y = r.side === "ctrl" ? Math.min(c.y, border - h) : Math.max(c.y, border);
        }
      }
    }
  }

  // The patch width the window shows at the current zoom, less zoomToFit's
  // margins: the width `l` packs pieces into.
  viewWidth() {
    const dpr = globalThis.devicePixelRatio || 1;
    const vw = this.canvas?.width ? this.canvas.width / dpr : 0;
    return Math.max(10 * GRID, vw / (this.zoom || 1) - 2 * FIT_MARGIN);
  }

  // --- Geometry ---

  boxesAABBOverlap(aId, a, bId, b) {
    const aW = this.boxWidth(a, aId);
    const bW = this.boxWidth(b, bId);
    const xOverlap = a.x < b.x + bW && b.x < a.x + aW;
    const yOverlap = a.y < b.y + this.boxHeight(b, bId) && b.y < a.y + this.boxHeight(a, aId);
    return xOverlap && yOverlap;
  }

  // Piston cascade: after a membrane displacement, resolve the overlaps the
  // push made, pushing in the sweep direction until settled. `direction` is
  // "down" (the synth side was squeezed: push lower boxes further down) or
  // "up" (the ctrl side: push upper boxes further up). Only boxes on the
  // squeezed `side` (against `lineY`, the line before this step) take part,
  // and only overlaps involving a box already moved (`moved`, ids the piston
  // pushed; a box pushed here joins it): overlaps that were already there
  // stay. Every push is away from the line, so no box changes side. Routers
  // are anchored to the border and skipped. `orderY` (id → y, the gesture's
  // start) keeps the stack's order: boxes the piston leaves level are taken
  // nearest the line first, so the one that began farther from it is pushed
  // farther, whatever the ids. `only` (id → bool), if given, limits it to
  // those boxes (`l` pushes only the boxes that stay).
  cascadeOverlaps(direction, PAD, side, lineY, moved, orderY = null, only = null) {
    const ids = [];
    for (const [id, box] of this.boxes) {
      if (!this.isRouterType(box.text) && this.sideOf(box, lineY) === side && (!only || only(id))) ids.push(id);
    }
    if (orderY) {
      const y = (id) => orderY.get(id) ?? this.boxes.get(id).y;
      ids.sort((a, b) => direction === "down" ? y(a) - y(b) : y(b) - y(a));
    }
    const MAX_ITERS = ids.length + 5;
    for (let iter = 0; iter < MAX_ITERS; iter++) {
      let pushed = false;
      for (let i = 0; i < ids.length; i++) {
        const a = this.boxes.get(ids[i]);
        for (let j = i + 1; j < ids.length; j++) {
          if (!moved.has(ids[i]) && !moved.has(ids[j])) continue;
          const b = this.boxes.get(ids[j]);
          if (!this.boxesAABBOverlap(ids[i], a, ids[j], b)) continue;
          const ha = this.boxHeight(a, ids[i]), hb = this.boxHeight(b, ids[j]);
          // Level boxes: push the one not yet moved, so a pushed box stays snug.
          const tie = a.y === b.y && moved.has(ids[j]) && !moved.has(ids[i]);
          let id;
          if (direction === "down") {
            // Push the lower of the two further down
            if (a.y > b.y || (a.y === b.y && tie)) { a.y = b.y + hb + PAD; id = ids[i]; }
            else { b.y = a.y + ha + PAD; id = ids[j]; }
          } else {
            // Push the upper of the two further up
            if (a.y < b.y || (a.y === b.y && tie)) { a.y = b.y - ha - PAD; id = ids[i]; }
            else { b.y = a.y - hb - PAD; id = ids[j]; }
          }
          moved.add(id);
          pushed = true;
        }
      }
      if (!pushed) break;
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
  // halfway between), where a box made there goes; wholly on the pointer's
  // side of the line (on the line counts as synth), so a click within half a
  // unit above the line makes a box snug above it, not one straddling it.
  gridCell(m) {
    const y = Math.floor(m.y / SNAP) * SNAP;
    return { x: Math.floor(m.x / SNAP) * SNAP, y: this.keepNewBoxOnSide(y, m.y >= this.borderY) };
  }

  // Where Tab puts a new box below box srcId: one empty row below it. A
  // source wholly on the ctrl side keeps its new box on that side: if one
  // row below would cross the line, the box goes as low as the side allows
  // (bottom on the line), and if that would overlap the source, to the right
  // of it instead, one empty unit apart, bottoms aligned.
  tabCell(srcId) {
    const src = this.boxes.get(srcId), h = this.boxHeight(src, srcId);
    const below = { x: src.x, y: src.y + h + GRID };
    if (!this.showBorder || wholeSide(src, this.borderY, h) !== "ctrl") return below;
    const y = this.keepNewBoxOnSide(below.y, false);
    if (y >= src.y + h) return { x: src.x, y };
    return { x: src.x + this.boxWidth(src, srcId) + GRID, y: src.y + h - BOX_HEIGHT };
  }

  // Pasted copies of clipboard boxes ([id, box] pairs), not yet added: one
  // unit right and one down, snapped. The step down is cut short so no box
  // wholly on the ctrl side crosses the line (boxes keep the side they were
  // copied from); then each lands in its zone (placeOnSide).
  pastedBoxes(clipBoxes) {
    let dy = GRID;
    if (this.showBorder) {
      for (const [, box] of clipBoxes) {
        const b = { ...box, x: snapPos(box.x), y: snapPos(box.y) }, h = this.boxHeight(b);
        if (!this.isRouterType(b.text) && wholeSide(b, this.borderY, h) === "ctrl") dy = Math.min(dy, this.borderY - h - b.y);
      }
    }
    return clipBoxes.map(([oldId, box]) => {
      const pasted = { x: snapPos(box.x) + GRID, y: snapPos(box.y) + dy, text: box.text, inlets: box.inlets, outlets: box.outlets };
      this.placeOnSide(pasted);
      return [oldId, pasted];
    });
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

  // Audio never crosses the border, routers carry events and values only, and
  // a router's outlets feed the synth side only (on the server a router is a
  // sink; apply refuses the same). Returns a reason string, or null when the
  // cable is fine.
  cableBorderProblem(srcBoxId, srcOutlet, dstBoxId) {
    const src = this.boxes.get(srcBoxId), dst = this.boxes.get(dstBoxId);
    if (!src || !dst) return null;
    return this.cableProblemAt(src, srcOutlet, dst, this.borderY);
  }

  // cableBorderProblem for boxes at given positions, against a given line.
  cableProblemAt(src, srcOutlet, dst, borderY) {
    if (this.showBorder && this.isRouterType(src.text) && this.sideOfBox(dst, borderY) === "ctrl") return ROUTER_TO_CTRL;
    if (getOutletDef(src.text, srcOutlet)?.type !== "audio") return null;
    if (this.isRouterType(src.text) || this.isRouterType(dst.text)) return "routers carry events and values, not audio";
    if (this.showBorder && this.sideOfBox(src, borderY) !== this.sideOfBox(dst, borderY)) return "audio can't cross the border; events and values cross through routers";
    return null;
  }

  // An audio cable the move just made a problem. Judged like
  // boundSideViolation: `before` holds each box's position (id → {x, y}) when
  // the move began, against beforeY, and a cable already a problem then
  // doesn't block the move.
  cableBorderViolation(before, beforeY = this.borderY) {
    for (const c of this.cables.values()) {
      const src = this.boxes.get(c.srcBox), dst = this.boxes.get(c.dstBox);
      if (!src || !dst) continue;
      const problem = this.cableProblemAt(src, c.srcOutlet, dst, this.borderY);
      if (!problem) continue;
      const ps = before.get(c.srcBox), pd = before.get(c.dstBox);
      if (ps && pd && this.cableProblemAt({ ...src, x: ps.x, y: ps.y }, c.srcOutlet, { ...dst, x: pd.x, y: pd.y }, beforeY)) continue;
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

  // A box the move just took off side (isOffSide: a bound box on the other
  // side, or any box but a router straddling the border). `before` holds
  // each box's position (id → {x, y}) when the move began, against beforeY;
  // a box already off side then moves freely, so it can be brought back
  // (movesOffSide). A free box moved wholly across is fine: that side is now
  // its side. The abstraction editor has no border, so nothing is off side
  // there.
  boundSideViolation(before, beforeY = this.borderY) {
    if (!this.showBorder) return null;
    for (const [id, box] of this.boxes) {
      const prev = before.get(id);
      const from = prev ? { ...box, x: prev.x, y: prev.y } : null;
      if (movesOffSide(from, beforeY, box, this.borderY)) {
        const binding = boxBinding(box.text);
        if (binding === "free") return `"${box.text}" would cross the border; only routers do`;
        return `"${box.text}" is bound to the ${binding} side`;
      }
    }
    return null;
  }

  // Put a box in its zone once its text is committed (or it is pasted): the
  // zone comes from its type. A router goes on the border row; a bound box
  // that straddles the line or lies on the other side goes snug against the
  // line on its own side (top on the line for synth, bottom on it for ctrl).
  // A free box has no zone from its type and never straddles in the editor
  // (creation, drag, nudge, paste can't make it), so it stays put; one that
  // straddles anyway (an old or hand-edited patch) goes snug to the side
  // holding more of it (sideOf; a centre on the line counts as synth). Used
  // where a box lands without a drag to refuse (text commit, paste).
  placeOnSide(box) {
    if (!this.showBorder) return;
    if (this.isRouterType(box.text)) { box.y = routerY(this.borderY); return; }
    const h = this.boxHeight(box);
    if (!isOffSide(box, this.borderY, h)) return;
    box.y = this.sideOfBox(box) === "synth" ? this.borderY : this.borderY - h;
  }

  // Where a new one-unit box goes for a point on a side of the line: `y`
  // moved, if need be, so the box lies wholly on that side (`below` true:
  // synth, top at the line at least; false: ctrl, bottom on the line at
  // most). New boxes are free until their text is committed, so they must
  // not straddle.
  keepNewBoxOnSide(y, below) {
    if (!this.showBorder) return y;
    return below ? Math.max(y, this.borderY) : Math.min(y, this.borderY - BOX_HEIGHT);
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
      this.gestureUndo = this.serialize();
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

      // The whole gesture (duplicate and move) is one undo step, back to now.
      this.gestureUndo = this.serialize();
      // Option+drag: duplicate
      if (e.altKey && this.selection.size > 0) {
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
      if (newY === this.borderY) return;
      this.borderY = newY;
      // Every step works from the gesture's start: restore the positions
      // from then, and push for the whole move from the line then. So boxes
      // spring back as the border retreats, never past where they began.
      const snap = this.resizeSnapshot, oldY = snap.borderY;
      for (const [id, pos] of snap.boxes) {
        const box = this.boxes.get(id);
        if (box) { box.x = pos.x; box.y = pos.y; }
      }
      // Pushed boxes stay on the grid, snug against the line.
      const PAD = 0;
      // Piston: a box on the side the membrane moves into, which the new line
      // crosses, is pushed wholly back onto its side (taken against the old
      // line), snug against the line, as placeOnSide places it. Then
      // cascade-resolve overlaps in the sweep direction so the push
      // propagates through stacked boxes instead of squashing them. Routers
      // ride the line.
      const moved = new Set();
      for (const [id, box] of this.boxes) {
        if (this.isRouterType(box.text)) {
          box.y = routerY(newY);
          continue;
        }
        const side = this.sideOf(box, oldY), h = this.boxHeight(box, id);
        if (newY > oldY && side === "synth" && box.y < newY) { box.y = newY + PAD; moved.add(id); }
        else if (newY < oldY && side === "ctrl" && box.y + h > newY) { box.y = newY - h - PAD; moved.add(id); }
      }
      const orderY = new Map([...snap.boxes].map(([id, pos]) => [id, pos.y]));
      if (newY !== oldY) this.cascadeOverlaps(newY > oldY ? "down" : "up", PAD, newY > oldY ? "synth" : "ctrl", oldY, moved, orderY);
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
      const problem = this.resizeSnapshot && (this.cableBorderViolation(this.resizeSnapshot.boxes, this.resizeSnapshot.borderY) ?? this.boundSideViolation(this.resizeSnapshot.boxes, this.resizeSnapshot.borderY));
      if (problem) {
        this.borderY = this.resizeSnapshot.borderY;
        for (const [id, pos] of this.resizeSnapshot.boxes) {
          const box = this.boxes.get(id);
          if (box) { box.x = pos.x; box.y = pos.y; }
        }
        this.onError(["✗ border move cancelled: " + problem]);
        this.render();
      }
      this.pushGestureUndo();
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
        const sideProblem = this.cableBorderProblem(this.cableFrom.boxId, this.cableFrom.index, inlet.boxId);
        if (sideProblem) {
          this.onError(["✗ cable rejected: " + sideProblem]);
          this.cableFrom = null;
          this.mode = "idle";
          this.canvas.style.cursor = "default";
          this.render();
          return;
        }
        const srcSynth = this.isSynthSide(this.cableFrom.boxId);
        const dstSynth = this.isSynthSide(inlet.boxId);
        const srcBox = this.boxes.get(this.cableFrom.boxId);
        const dstBox = this.boxes.get(inlet.boxId);
        // A synth box into a ctrl one would be auto-routed through a router.
        if (this.showBorder && srcSynth && !dstSynth && !this.isRouterType(srcBox?.text) && !this.isRouterType(dstBox?.text)) {
          this.onError(["✗ cable rejected: " + ROUTER_TO_CTRL]);
          this.cableFrom = null;
          this.mode = "idle";
          this.canvas.style.cursor = "default";
          this.render();
          return;
        }
        this.pushUndo();
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
      const dropProblem = moved && this.dragSnapshot ? (this.cableBorderViolation(this.dragSnapshot.boxes) ?? this.boundSideViolation(this.dragSnapshot.boxes)) : null;
      if (dropProblem) {
        this.cables.clear();
        for (const [id, c] of this.dragSnapshot.cables) this.cables.set(id, { ...c });
        this.boxes.clear();
        for (const [id, b] of this.dragSnapshot.boxes) this.boxes.set(id, { ...b });
        this.nextId = this.dragSnapshot.nextId;
        this.onError(["✗ move cancelled: " + dropProblem]);
        this.render();
      }
      // An Option-drag's duplicates stay even when its move is cancelled, so
      // that is a change too.
      this.pushGestureUndo();
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
      const undoState = this.serialize();  // one undo step per press, if it happens
      // Routers stay on the border, as in a drag: they nudge sideways only.
      const ddy = (box) => this.isRouterType(box.text) ? 0 : dy;
      for (const id of this.selection) {
        const box = this.boxes.get(id);
        if (box) { box.x += dx; box.y += ddy(box); }
      }
      // Same rule as a drop: a nudge that takes a bound box off side, or audio
      // across the border, doesn't happen.
      const problem = this.cableBorderViolation(before) ?? this.boundSideViolation(before);
      if (problem) {
        for (const id of this.selection) {
          const box = this.boxes.get(id);
          if (box) { box.x -= dx; box.y -= ddy(box); }
        }
        this.onError(["✗ move cancelled: " + problem]);
      } else {
        this.pushUndo(undoState);
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
      this.boxes.set(id, { ...this.tabCell(srcId), text: "", inlets: 1, outlets: 1 });
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
    const margin = FIT_MARGIN;
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
