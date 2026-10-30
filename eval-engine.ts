// eval-engine.ts — one-side evaluation (graph.js), routing, and tick loop

import {
  type Box, type BoxValue,
  boxes, cables, boxValues,
  routerState, groupState, latestValues, assignState,
} from "./patch-state.ts";
import { arcValues } from "./hardware.ts";
import { boxTypeName, deployInletDefs, getInletDef, isAudioBox } from "./public/gpi-types.js";
import { buildGraph, propagateValue, propagateEvent, tickGraph } from "./public/graph.js";

// --- Timing instrumentation (gated; zero overhead when env vars unset) ---
// See notes/server-timing-runtime-analysis.md. Timestamps are performance.now()
// (≈ ms since process start) so they cross-correlate with --v8-flags=--trace-gc.
//   PROFILE_TICK=1   → per-second tick aggregate + [tick-late] outliers
//   PROFILE_ONSET=1  → one [onset] line per outbound synth message
// Parse the combined log with:  deno run -R notes/gc-correlate.ts <logfile>
let PROFILE_ONSET = false; // set in startEvalEngine()
function logOnset(dst: string, msg: Record<string, unknown>): void {
  const t = msg.type;
  if (t !== "re" && t !== "rv") return; // router events/values are the audible onsets
  console.log(`[onset] t=${performance.now().toFixed(2)} k=${t}:${msg.r}:${msg.ch ?? ""} dst=${dst}`);
}

// --- Callbacks injected by server.ts ---

let _broadcastSynth: (msg: Record<string, unknown>) => void;
let _sendToClient: (clientId: number, msg: Record<string, unknown>) => void;
let _getSynthClientIds: () => number[];
let _sendCtrl: (msg: Record<string, unknown>) => void;
let _event: (msg: string) => void;

// Every router message (rv/re) leaves the server through emit(): `to` is a client
// id, or omitted to broadcast. This is the one place a message could be stamped
// (an optional `t`, see notes/architecture.md) or logged.
function emit(msg: Record<string, unknown>, to?: number): void {
  if (PROFILE_ONSET) logOnset(to === undefined ? "b" : String(to), msg);
  if (to === undefined) _broadcastSynth(msg);
  else _sendToClient(to, msg);
}

export function initEvalEngine(deps: {
  broadcastSynth: (msg: Record<string, unknown>) => void;
  sendToClient: (clientId: number, msg: Record<string, unknown>) => void;
  getSynthClientIds: () => number[];
  sendCtrl: (msg: Record<string, unknown>) => void;
  event: (msg: string) => void;
}): void {
  _broadcastSynth = deps.broadcastSynth;
  _sendToClient = deps.sendToClient;
  _getSynthClientIds = deps.getSynthClientIds;
  _sendCtrl = deps.sendCtrl;
  _event = deps.event;
}

// --- Router state (for one/sweep/group targeting) ---

export function buildGroups(routerBoxId: number): void {
  const box = boxes.get(routerBoxId);
  if (!box) return;
  const n = parseInt(box.text.split(/\s+/)[1]) || 1;
  const clients = shuffleArray([..._getSynthClientIds()]);
  const groups: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < clients.length; i++) {
    groups[i % n].push(clients[i]);
  }
  groupState.set(routerBoxId, groups);
}

function shuffleArray(arr: number[]): number[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function handleRouterInlet(routerBoxId: number, inlet: number, value: BoxValue, isEvent = false): void {
  const box = boxes.get(routerBoxId);
  if (!box) return;
  const routerType = boxTypeName(box.text);

  // `one` with arg N: explicit-fire bundling semantics.
  // Inlets 0..N-1 = data (cold store), inlet N = fire (flush + advance), inlet N+1 = shuffle.
  // `one` with no arg: auto-advance — falls through to routerDispatch below.
  if (routerType === "one") {
    const tokens = box.text.split(/\s+/);
    if (tokens.length > 1) {
      const n = parseInt(tokens[1]) || 1;
      if (!routerState.has(routerBoxId)) routerState.set(routerBoxId, { index: 0, storedValues: {} });
      const state = routerState.get(routerBoxId)!;
      if (!state.storedValues) state.storedValues = {};

      if (inlet < n) {
        state.storedValues[inlet] = value;
        return;
      }
      if (inlet === n) {
        const clients = _getSynthClientIds();
        if (clients.length === 0) return;
        const clientIndex = state.order
          ? state.order[state.index % state.order.length]
          : state.index;
        const targetClient = clients[clientIndex % clients.length];

        for (const [storedInletStr, storedValue] of Object.entries(state.storedValues)) {
          const storedInlet = parseInt(storedInletStr);
          emit({ type: "rv", r: routerBoxId, ch: storedInlet, v: storedValue }, targetClient);
        }
        emit({ type: "re", r: routerBoxId, ch: n }, targetClient);

        const len = state.order ? state.order.length : clients.length;
        state.index = (state.index + 1) % len;
        return;
      }
      if (inlet === n + 1) {
        const clients = _getSynthClientIds();
        state.order = shuffleArray([...Array(clients.length).keys()]);
        state.index = 0;
        return;
      }
      return;
    }
    // No-arg `one`: inlet 1 is shuffle; inlet 0 falls through to routerDispatch (auto-advance).
    if (inlet === 1) {
      if (!routerState.has(routerBoxId)) routerState.set(routerBoxId, { index: 0 });
      const state = routerState.get(routerBoxId)!;
      const clients = _getSynthClientIds();
      state.order = shuffleArray([...Array(clients.length).keys()]);
      state.index = 0;
      return;
    }
  }

  // for `group`: last inlet is shuffle trigger
  if (routerType === "group") {
    const n = parseInt(box.text.split(/\s+/)[1]) || 1;
    if (inlet === n) {
      buildGroups(routerBoxId);
      return;
    }
    if (!groupState.has(routerBoxId)) buildGroups(routerBoxId);
    const groups = groupState.get(routerBoxId)!;
    if (inlet < groups.length) {
      const msg = { type: "rv", r: routerBoxId, ch: 0, v: value } as Record<string, unknown>;
      for (const clientId of groups[inlet]) emit(msg, clientId);
    }
    return;
  }

  // for `sweep`: inlet 1 is trigger to advance
  if (inlet === 1 && routerType === "sweep") {
    if (!routerState.has(routerBoxId)) routerState.set(routerBoxId, { index: 0 });
    const state = routerState.get(routerBoxId)!;
    const clients = _getSynthClientIds();
    if (clients.length > 0) state.index = (state.index + 1) % clients.length;
    return;
  }

  // assign — stable voice allocation across phones with minimum movement.
  // inlet 0 = notes/freqs array (triggers reallocation); inlet 1 = parallel amps array
  // (stored, index-aligned to notes; turns each per-phone send into a [note, amp] pair).
  if (routerType === "assign") {
    if (inlet === 1 && Array.isArray(value)) {
      if (!assignState.has(routerBoxId)) {
        assignState.set(routerBoxId, { assignment: new Map(), lastNotes: [] });
      }
      assignState.get(routerBoxId)!.amps = value as number[];
    } else if (Array.isArray(value)) {
      reassign(routerBoxId, value as number[]);
    }
    return;
  }

  // sall — wireless send + broadcast to all synth clients
  if (routerType === "sall") {
    const names = box.text.split(/\s+/).slice(1);
    const name = names[inlet];
    if (!name) return;
    // It also feeds the one side's receives of that name.
    const w = graph.wireless.get(name);
    for (const recvId of w ? w.receives : []) {
      if (isEvent) propagateEvent(graph, recvId, 0);
      else propagateValue(graph, recvId, 0, value);
    }
    if (isEvent) {
      emit({ type: "re", r: routerBoxId, ch: inlet });
    } else {
      const msg = { type: "rv", r: routerBoxId, ch: inlet, v: value } as Record<string, unknown>;
      latestValues.set(routerBoxId + ":" + inlet, JSON.stringify(msg));
      emit(msg);
    }
    return;
  }

  // all routers — send immediately
  if (isEvent) {
    routerDispatch(routerBoxId, { type: "re", r: routerBoxId, ch: inlet }, { advanceSweep: true, storeLatest: false });
  } else {
    sendViaRouter(routerBoxId, inlet, value);
  }
}

function routerDispatch(routerBoxId: number, msg: Record<string, unknown>, opts: { advanceSweep: boolean; storeLatest: boolean }): void {
  const box = boxes.get(routerBoxId);
  if (!box) return;
  const routerType = boxTypeName(box.text);

  // Only a broadcast is replayed to a joining phone: a `one`/`sweep` value was
  // meant for one phone (D3). sall stores its own.
  if (opts.storeLatest && routerType === "all") {
    latestValues.set(routerBoxId + ":" + (msg.ch || 0), JSON.stringify(msg));
  }

  const clients = _getSynthClientIds();
  if (clients.length === 0) return;

  switch (routerType) {
    case "all":
      emit(msg);
      break;
    case "one": {
      if (!routerState.has(routerBoxId)) routerState.set(routerBoxId, { index: 0 });
      const state = routerState.get(routerBoxId)!;
      const clientIndex = state.order
        ? state.order[state.index % state.order.length]
        : state.index;
      emit(msg, clients[clientIndex % clients.length]);
      const len = state.order ? state.order.length : clients.length;
      state.index = (state.index + 1) % len;
      break;
    }
    case "sweep": {
      if (!routerState.has(routerBoxId)) routerState.set(routerBoxId, { index: 0 });
      const state = routerState.get(routerBoxId)!;
      emit(msg, clients[state.index % clients.length]);
      if (opts.advanceSweep) state.index = (state.index + 1) % clients.length;
      break;
    }
    default:
      emit(msg);
  }
}

function sendViaRouter(routerBoxId: number, channel: number, value: BoxValue): void {
  const msg = { type: "rv", r: routerBoxId, ch: channel, v: value } as Record<string, unknown>;
  routerDispatch(routerBoxId, msg, { advanceSweep: true, storeLatest: true });
}

// --- Batched value updates to ctrl at ~30fps ---

let pendingValueUpdates = new Map<number, BoxValue>();

export function queueValueUpdate(id: number, value: BoxValue): void {
  pendingValueUpdates.set(id, value);
}

function flushValueUpdates(): void {
  if (pendingValueUpdates.size === 0) return;
  const updates: Array<{ id: number; value: BoxValue }> = [];
  for (const [id, value] of pendingValueUpdates) updates.push({ id, value });
  pendingValueUpdates = new Map();
  _sendCtrl({ type: "values", updates });
}

// --- The one-side graph ---
//
// The server evaluates the one side with the phones' graph.js. Its graph holds
// the one-side boxes and the routers; routers and one-side audio boxes are
// sinks (graph.sinks), the way engines are on a phone: delivery at them is
// handed back here instead of evaluated.

// deno-lint-ignore no-explicit-any
let graph: any = null;

// The live graph, for tests.
// deno-lint-ignore no-explicit-any
export function serverGraph(): any { return graph; }

// Sink deliveries are queued and run when the injection that caused them
// returns: values first, then events, so data lands before a fire (`one N`
// fed by one outlet on both its data and fire inlets). A sink that re-enters
// the graph (sall → one-side r) queues more, run in the next round.
let pending: Array<{ event: boolean; run: () => void }> = [];
let depth = 0;

// Every evaluation (tick, input, build) runs in a batch, so the outermost one
// is where a throw is caught: reported, and the server keeps running.
function batch(fn: () => void): void {
  if (depth > 0) {
    depth++;
    try { fn(); } finally { depth--; }
    return;
  }
  depth++;
  try {
    fn();
    while (pending.length > 0) {
      const due = pending;
      pending = [];
      for (const d of due) if (!d.event) d.run();
      for (const d of due) if (d.event) d.run();
    }
  } catch (e) {
    pending = [];
    reportEvalError(e);
  } finally {
    depth--;
  }
}

// A throw is logged and sent to ctrl the first time; repeats of the same
// message are counted and reported once a second while they keep coming, so
// a throw every tick can't flood the page.
const evalErrorRepeats = new Map<string, number>();
let evalErrorTimer = 0;

function sendEvalError(text: string): void {
  console.log(`\x1b[31m✗ ${text}\x1b[0m`);
  _sendCtrl({ type: "errors", errors: [text] });
}

function reportEvalError(e: unknown): void {
  const text = "evaluation error: " + (e instanceof Error ? e.message : String(e));
  const repeats = evalErrorRepeats.get(text);
  if (repeats !== undefined) { evalErrorRepeats.set(text, repeats + 1); return; }
  evalErrorRepeats.set(text, 0);
  sendEvalError(text);
  if (e instanceof Error && e.stack) console.log(e.stack);
  if (!evalErrorTimer) evalErrorTimer = setTimeout(reportEvalErrorRepeats, 1000);
}

function reportEvalErrorRepeats(): void {
  evalErrorTimer = 0;
  for (const [text, n] of evalErrorRepeats) {
    if (n === 0) { evalErrorRepeats.delete(text); continue; }
    sendEvalError(`${text} (×${n} in the last second)`);
    evalErrorRepeats.set(text, 0);
  }
  if (evalErrorRepeats.size > 0) evalErrorTimer = setTimeout(reportEvalErrorRepeats, 1000);
}

// A value at an event-typed inlet fires it, as before (`key` → `one 2` fire).
function deliversEvent(boxId: number, inlet: number, kind: string): boolean {
  return kind === "event" || getInletDef(boxes.get(boxId)!.text, inlet)?.type === "event";
}

function routerSink(id: number) {
  return (inlet: number, kind: string, value?: BoxValue) => {
    const isEvent = deliversEvent(id, inlet, kind);
    pending.push({ event: isEvent, run: () => handleRouterInlet(id, inlet, value as BoxValue, isEvent) });
  };
}

// One-side audio runs on the laptop (ctrl.js). Stage C gives it a deploy;
// until then it keeps the ctrl-audio-* messages. The latest param per inlet is
// kept so a laptop that rebuilds its audio after `applied` can have them again.
const laptopLatest = new Map<string, Record<string, unknown>>();

function laptopSink(id: number) {
  return (inlet: number, kind: string, value?: BoxValue) => {
    if (deliversEvent(id, inlet, kind)) {
      pending.push({ event: true, run: () => {
        _sendCtrl({ type: "ctrl-audio-event", boxId: id, inlet });
        ctrlAudioTrigger(id);
      } });
    } else {
      pending.push({ event: false, run: () => {
        const msg = { type: "ctrl-audio-param", boxId: id, inlet, value };
        laptopLatest.set(id + ":" + inlet, msg);
        _sendCtrl(msg);
      } });
    }
  };
}

export function replayLaptopParams(): void {
  for (const msg of laptopLatest.values()) _sendCtrl(msg);
}

// Display: a box shows what leaves its outlet 0. Sources that show something
// else (bare `cc`, `key`) set their display themselves. Audio boxes are shown
// by ctrlAudioAnims.
function onOutput(boxId: number, outlet: number, kind: string, value?: BoxValue): void {
  if (kind !== "value" || outlet !== 0) return;
  const box = boxes.get(boxId);
  if (!box || isAudioBox(box.text)) return;
  boxValues.set(boxId, value as BoxValue);
  queueValueUpdate(boxId, value as BoxValue);
}

// Side is stamped at apply (sideOf in gpi-types.js). An unstamped box means
// a path skipped the stamp pass: fail loudly rather than guess.
export function sideStamped(box: Box): "one" | "many" | "border" {
  if (box.side === undefined) throw new Error(`box "${box.text}" has no side: apply must stamp sides before evaluation`);
  return box.side;
}

let metroIds: number[] = [];

// Build the one-side graph from the applied patch. Initial values (const,
// toggle and every other box with a state value, as on a phone) reach the
// sinks; then the sources with no graph state get theirs.
export function buildServerGraph(): void {
  // deno-lint-ignore no-explicit-any
  const graphBoxes: any[] = [];
  const ids = new Set<number>();
  const sinks = new Map<number, (inlet: number, kind: string, value?: BoxValue) => void>();
  for (const [id, box] of boxes) {
    const side = sideStamped(box);
    if (side === "many") continue;
    ids.add(id);
    graphBoxes.push({ id, type: boxTypeName(box.text), args: box.text.split(/\s+/).slice(1).join(" "), inletDefs: deployInletDefs(box.text) });
    if (side === "border") sinks.set(id, routerSink(id));
    else if (isAudioBox(box.text)) sinks.set(id, laptopSink(id));
  }
  const graphCables = [...cables.values()].filter((c) => ids.has(c.srcBox) && ids.has(c.dstBox));
  laptopLatest.clear();
  ctrlAudioAnims.clear();
  graph = null; // a build that throws leaves no graph, not the old one
  metroIds = [];
  batch(() => { graph = buildGraph({ boxes: graphBoxes, cables: graphCables, entries: [] }, { sinks, onOutput }); });
  if (!graph) return;
  metroIds = graphBoxes.filter((b) => b.type === "metro").map((b) => b.id);
  initSources();
}

// --- Sources: server-only inputs enter the graph here ---

function graphHas(boxId: number): boolean {
  if (!graph) return false;
  if (graph.boxes.has(boxId)) return true;
  const box = boxes.get(boxId);
  if (box) console.log(`\x1b[31m✗ input to "${box.text}" (box ${boxId}) dropped: not a one-side box\x1b[0m`);
  return false;
}

export function injectValue(boxId: number, outlet: number, value: BoxValue): void {
  if (!graphHas(boxId)) return;
  batch(() => propagateValue(graph, boxId, outlet, value));
}

export function injectEvent(boxId: number, outlet: number): void {
  if (!graphHas(boxId)) return;
  batch(() => propagateEvent(graph, boxId, outlet));
}

const ONSET_THRESHOLD = 0.01;

// A single-outlet source's new value (knob, grid, arc, BBC2, clients).
// breath/bite: outlet 0 = value (0-1 pressure), outlet 1 = gate (0 below
// threshold, 1 above), fired only on threshold crossings.
export function setSourceValue(boxId: number, value: BoxValue): void {
  const box = boxes.get(boxId);
  if (!box) return;
  const name = boxTypeName(box.text);
  if (name === "breath" || name === "bite") {
    const prev = boxValues.get(boxId) ?? 0;
    injectValue(boxId, 0, value);
    const p = typeof prev === "number" ? prev : 0;
    const v = typeof value === "number" ? value : 0;
    if (p < ONSET_THRESHOLD && v >= ONSET_THRESHOLD) injectValue(boxId, 1, 1);
    else if (p >= ONSET_THRESHOLD && v < ONSET_THRESHOLD) injectValue(boxId, 1, 0);
    return;
  }
  injectValue(boxId, 0, value);
}

// The toggle's state is set, then sent on.
export function setToggle(boxId: number, value: number): void {
  const node = graph?.boxes.get(boxId);
  if (!node?.state) return;
  node.state.value = value;
  injectValue(boxId, 0, value);
}

const DEVICE_DEFAULTS: Record<string, number> = {
  breath: 0, bite: 0, nod: 0.5, tilt: 0.5, arc: 0.5,
};

function getDeviceInitValue(name: string, text: string): number {
  const args = text.split(/\s+/).slice(1);
  if (name === "arc" && args.length >= 3) {
    const v = parseFloat(args[2]);
    if (!isNaN(v)) return v;
  }
  if (name !== "arc" && args.length >= 1) {
    const v = parseFloat(args[0]);
    if (!isNaN(v)) return v;
  }
  return DEVICE_DEFAULTS[name] ?? 0;
}

// Knobs and devices start at their arg (or default); `clients` at the count.
function initSources(): void {
  for (const [id, box] of boxes) {
    if (!graph.boxes.has(id)) continue;
    const name = boxTypeName(box.text);
    if (name === "knob") {
      const init = box.text.split(/\s+/).slice(1).map(Number)[0];
      setSourceValue(id, init !== undefined ? init : 0.5);
    } else if (name in DEVICE_DEFAULTS) {
      const init = getDeviceInitValue(name, box.text);
      setSourceValue(id, init);
      if (name === "arc") arcValues.set(id, init);
    }
  }
  evaluateAllClients();
}

// Push the live synth-client count to every `clients` box. Called from
// server.ts on patch deploy and on every client connect/disconnect.
// Also re-runs `assign` allocation against its last-seen notes array, so
// new phones get an assignment immediately and departing phones cause an
// audible reshuffle. (User-spec behaviour 3.)
export function evaluateAllClients(): void {
  if (!graph) return;
  const count = _getSynthClientIds().length;
  for (const [id, box] of boxes) {
    if (!graph.boxes.has(id)) continue;
    const name = boxTypeName(box.text);
    if (name === "clients") {
      setSourceValue(id, count);
    } else if (name === "assign") {
      const s = assignState.get(id);
      if (s && s.lastNotes.length > 0) reassign(id, s.lastNotes);
    }
  }
}

// Stable voice allocation. Notes array represents currently-held pitches in
// press order (e.g. from `held` outlet 0). Distributes one note per phone
// such that:
//   - per-note count is balanced (±1) across phones
//   - phones already at a note that's still held don't move (minimum motion)
//   - if more notes than phones, the OLDEST notes (front of array) are dropped
//     so the most recently pressed notes always have coverage
//   - empty array stops emitting; phones keep their last value
function reassign(routerBoxId: number, notes: number[]): void {
  if (!assignState.has(routerBoxId)) {
    assignState.set(routerBoxId, { assignment: new Map(), lastNotes: [] });
  }
  const state = assignState.get(routerBoxId)!;
  state.lastNotes = notes.slice();

  const clients = _getSynthClientIds();
  const N = clients.length;
  if (N === 0 || notes.length === 0) return;

  // Overflow: keep most recently pressed notes, drop the oldest.
  const active = notes.length > N ? notes.slice(notes.length - N) : notes;
  const M = active.length;

  // Target counts per note: first (N % M) notes get ⌈N/M⌉, rest get ⌊N/M⌋.
  const ceilCount = Math.ceil(N / M);
  const floorCount = Math.floor(N / M);
  const numCeil = N % M;
  const targetByNote = new Map<number, number>();
  for (let i = 0; i < M; i++) {
    targetByNote.set(active[i], i < numCeil ? ceilCount : floorCount);
  }

  // Phase 1: keep phones already at notes still held, up to the target count.
  const noteToPhones = new Map<number, number[]>();
  for (const note of active) noteToPhones.set(note, []);
  const displaced: number[] = [];

  for (let i = 0; i < N; i++) {
    const currentNote = state.assignment.get(i);
    if (currentNote !== undefined && targetByNote.has(currentNote)) {
      const list = noteToPhones.get(currentNote)!;
      if (list.length < targetByNote.get(currentNote)!) {
        list.push(i);
        continue;
      }
    }
    displaced.push(i);
  }

  // Phase 2: distribute displaced phones across under-filled notes.
  for (const note of active) {
    const list = noteToPhones.get(note)!;
    while (list.length < targetByNote.get(note)! && displaced.length > 0) {
      list.push(displaced.shift()!);
    }
  }

  // Build new assignment, push updates only for phones whose value changed.
  const newAssignment = new Map<number, number>();
  for (const [note, phoneList] of noteToPhones) {
    for (const clientIdx of phoneList) newAssignment.set(clientIdx, note);
  }

  // Spectral mode: if an amps array (inlet 1) is present, send each phone a [note, amp]
  // pair. amps are index-aligned to the full `notes` array, so map note→amp before the
  // active slice. Continuous spectral data changes every frame, so always send in this
  // mode (a stable, bin-quantized note would otherwise freeze its amplitude); held-notes
  // mode keeps the diffed scalar send.
  const amps = state.amps ?? [];
  const spectral = amps.length > 0;
  const ampByNote = new Map<number, number>();
  if (spectral) for (let i = 0; i < notes.length; i++) ampByNote.set(notes[i], amps[i] ?? 1);

  for (let i = 0; i < N; i++) {
    const newNote = newAssignment.get(i);
    if (newNote === undefined) continue;
    const oldNote = state.assignment.get(i);
    if (newNote !== oldNote || spectral) {
      const v = spectral ? [newNote, ampByNote.get(newNote) ?? 1] : newNote;
      emit({ type: "rv", r: routerBoxId, ch: 0, v }, clients[i]);
    }
  }

  state.assignment = newAssignment;
}

// --- Cosmetic animations for one-side audio boxes ---

const ctrlAudioAnims = new Map<number, { type: string; elapsed: number; duration: number; curve: number }>();

function ctrlAudioTrigger(boxId: number): void {
  const box = boxes.get(boxId);
  if (!box) return;
  const name = boxTypeName(box.text);

  if (name === "trig~") {
    queueValueUpdate(boxId, 1);
    setTimeout(() => queueValueUpdate(boxId, 0), 80);
  } else if (name === "ramp~") {
    const args = box.text.split(/\s+/).slice(1).map(Number);
    const iv = graph.boxes.get(boxId)?.inletValues || [];
    const duration = iv[3] || args[2] || 0.5;
    const curve = iv[4] || args[3] || 1;
    ctrlAudioAnims.set(boxId, { type: "ramp", elapsed: 0, duration, curve });
  } else if (name === "ar~" || name === "sigmoid~" || name === "cosine~" || name === "step~") {
    queueValueUpdate(boxId, 1);
    setTimeout(() => queueValueUpdate(boxId, 0), 80);
  }
}

function tickCtrlAudioAnims(dt: number): void {
  for (const [id, anim] of ctrlAudioAnims) {
    anim.elapsed += dt;
    const t = Math.min(1, anim.elapsed / anim.duration);
    const shaped = anim.curve === 1 ? t : Math.pow(t, anim.curve);
    queueValueUpdate(id, shaped);
    if (t >= 1) ctrlAudioAnims.delete(id);
  }
}

const TICK_RATE = 240;
const TICK_DT = 1 / TICK_RATE;

// The server's clock drives graph.js's tick. A metro fires only events, so
// its phase is shown from its state.
export function tick(): void {
  if (graph) {
    batch(() => tickGraph(graph, TICK_DT));
    for (const id of metroIds) {
      const node = graph.boxes.get(id);
      const interval = node.inletValues[1] > 0 ? node.inletValues[1] : node.state.interval;
      queueValueUpdate(id, node.state.elapsed / interval);
    }
  }
  tickCtrlAudioAnims(TICK_DT);
}

// Tick-interval instrumentation. Enabled when PROFILE_TICK env is set
// (any non-empty value). Logs p50/p95/max inter-tick delta once per second.
// Cross-correlate with --v8-flags=--trace-gc output to see if outliers
// coincide with GC events.
let PROFILE_TICK = false; // set in startEvalEngine()
const _TICK_LATE_MS = (1000 / TICK_RATE) * 2; // outlier threshold: 2× the target interval
let _tickProfileLast = 0;
let _tickProfileBuf: number[] = [];
const _tickProfileWindow = TICK_RATE; // 1 second worth of intervals

function tickLoop(): void {
  if (PROFILE_TICK) {
    const now = performance.now();
    if (_tickProfileLast > 0) {
      const delta = now - _tickProfileLast;
      _tickProfileBuf.push(delta);
      if (delta > _TICK_LATE_MS) {
        console.log(`[tick-late] t=${now.toFixed(2)} interval=${delta.toFixed(2)} over=${(delta - 1000 / TICK_RATE).toFixed(2)}`);
      }
    }
    _tickProfileLast = now;
    if (_tickProfileBuf.length >= _tickProfileWindow) {
      _tickProfileBuf.sort((a, b) => a - b);
      const p50 = _tickProfileBuf[_tickProfileWindow >> 1];
      const p95 = _tickProfileBuf[Math.floor(_tickProfileWindow * 0.95)];
      const p99 = _tickProfileBuf[Math.floor(_tickProfileWindow * 0.99)];
      const max = _tickProfileBuf[_tickProfileWindow - 1];
      console.log(`[tick-profile] p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms (target=${(1000/TICK_RATE).toFixed(2)}ms)`);
      _tickProfileBuf.length = 0;
    }
  }
  tick();
}

// Starts the value-flush and tick timers and reads the PROFILE_* env vars.
// Called once by server.ts after initEvalEngine(); importing this module has no side effects.
export function startEvalEngine(): void {
  PROFILE_ONSET = !!Deno.env.get("PROFILE_ONSET");
  PROFILE_TICK = !!Deno.env.get("PROFILE_TICK");
  setInterval(flushValueUpdates, 33);
  setInterval(tickLoop, 1000 / TICK_RATE);
}

// --- MIDI CC mapping ---

export const CC_SOURCE: Record<number, string> = { 2: "breath", 1: "bite", 12: "nod", 13: "tilt" };

export function findBoxByText(text: string): number | null {
  for (const [id, box] of boxes) if (box.text === text) return id;
  return null;
}
