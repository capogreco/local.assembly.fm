// eval-engine.ts — graph evaluation, propagation, routing, and tick loop
// Extracted from server.ts as part of the server split.

import {
  type Box, type BoxValue,
  boxes, cables, boxValues, inletValues, boxState,
  routerState, groupState, latestValues, assignState,
  cablesFromOutlet,
} from "./patch-state.ts";
import { arcValues } from "./hardware.ts";
import { boxTypeName, getBoxDef, isAudioBox } from "./public/gpi-types.js";
import { evaluatePure, createBoxState, tickBox, handleBoxEvent, applyInletToState, deliverValueToInlet } from "./public/graph-core.js";

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
    for (const [recvId, recvBox] of boxes) {
      if (isWirelessReceive(recvBox.text) && recvBox.text.split(/\s+/).slice(1).join(" ") === name && isOneSide(recvBox)) {
        setBoxValueAndNotify(recvId, value);
      }
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

  if (opts.storeLatest) {
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

// --- Evaluation core ---

function evaluateBox(box: Box, iv: number[]): number {
  const name = boxTypeName(box.text);
  const args = box.text.split(/\s+/).slice(1);
  const result = evaluatePure(name, args, iv);
  return result !== null ? result : (iv[0] || 0);
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

const ONSET_THRESHOLD = 0.01;

export function setBoxValueAndNotify(boxId: number, value: BoxValue): void {
  const prev = boxValues.get(boxId) ?? 0;
  boxValues.set(boxId, value);
  queueValueUpdate(boxId, value);
  const box = boxes.get(boxId);
  if (!box) return;
  const name = boxTypeName(box.text);
  const def = getBoxDef(box.text);
  if (!def) return;

  // breath/bite: outlet 0 = value (0-1 pressure), outlet 1 = gate (0 below threshold, 1 above).
  // Gate only fires on threshold crossings, not every tick.
  if (name === "breath" || name === "bite") {
    propagateAndNotify(boxId, 0, value);
    const p = typeof prev === "number" ? prev : 0;
    const v = typeof value === "number" ? value : 0;
    if (p < ONSET_THRESHOLD && v >= ONSET_THRESHOLD) propagateAndNotify(boxId, 1, 1);
    else if (p >= ONSET_THRESHOLD && v < ONSET_THRESHOLD) propagateAndNotify(boxId, 1, 0);
    return;
  }

  const outlets = def.outlets.length || 1;
  for (let i = 0; i < outlets; i++) propagateAndNotify(boxId, i, value);
}

// --- Server graph-view adapter for the shared deliverValueToInlet helper ---
//
// The shared helper (graph-core.js) expects a graph object with a few uniform
// shapes: boxes.get(id) → { type, args, inletValues, state }, engines, wireless,
// uplinkQueue. Server stores these across globals (boxes, boxState, inletValues
// in patch-state.ts), so we wrap them in a thin view that returns shared
// references — mutations to inletValues / state via the helper land in the
// real server state.

// deno-lint-ignore no-explicit-any
const _serverGraphView: any = {
  boxes: {
    get(id: number) {
      const box = boxes.get(id);
      if (!box) return undefined;
      const type = boxTypeName(box.text);
      const args = box.text.split(/\s+/).slice(1).join(" ");
      let iv = inletValues.get(id);
      if (!iv) { iv = []; inletValues.set(id, iv); }
      return { type, args, inletValues: iv, state: boxState.get(id) || null };
    },
    has(id: number): boolean { return boxes.has(id); },
  },
  // Server has no engines (engines live on the many side) — empty Map keeps
  // the helper's engine branch from firing.
  engines: { has: () => false, get: () => undefined },
  // Wireless lookups are kept INLINE in propagateAndNotify (server uses
  // boxValues for catch summing rather than inletValues[0]). The helper's
  // wireless branches are bypassed by handling send/throw before delegation.
  wireless: { get: () => null },
  // Server doesn't use uplinkQueue (sendup is many-bound — server has
  // its own uplinkIndex for the receive direction).
  uplinkQueue: null,
};

// Server-side helpers passed to deliverValueToInlet. Bridge the helper's
// recursive callbacks to server-specific side effects.
// deno-lint-ignore no-explicit-any
const _serverDeliverHelpers: any = {
  // Helper calls this for: wireless send forward, toggle inlet 1 propagation,
  // map inlet 0 lookup, change diff propagation, default hot-inlet eval.
  // Server's setBoxValueAndNotify sets boxValues + queueValueUpdate +
  // propagates through all outlets — equivalent for single-outlet ctrl boxes.
  // deno-lint-ignore no-explicit-any
  propagateValue: (_graph: any, targetBoxId: number, _outlet: number, v: BoxValue) => {
    setBoxValueAndNotify(targetBoxId, v);
    return {};
  },
  // Helper calls this for default hot-inlet recompute.
  // deno-lint-ignore no-explicit-any
  evaluateNode: (_graph: any, targetBoxId: number) => {
    const targetBox = boxes.get(targetBoxId);
    if (!targetBox) return 0;
    const iv = inletValues.get(targetBoxId) || [];
    return evaluateBox(targetBox, iv);
  },
  debug: false,
};

export function propagateAndNotify(boxId: number, outletIndex: number, value: BoxValue): void {
  const deferred: Array<() => void> = [];

  const srcBox = boxes.get(boxId);
  const srcDef = srcBox ? getBoxDef(srcBox.text) : null;
  const isEventSource = srcDef?.outlets?.[outletIndex]?.type === "event";

  for (const cable of cablesFromOutlet(boxId, outletIndex)) {
    const dst = boxes.get(cable.dstBox);
    if (!dst) continue;
    const def = getBoxDef(dst.text);
    if (!def) continue;
    if (dst.side === "border") {
      const inletDef = def.inlets[cable.dstInlet];
      if (inletDef && inletDef.type === "event") {
        deferred.push(() => handleRouterInlet(cable.dstBox, cable.dstInlet, value, true));
      } else {
        handleRouterInlet(cable.dstBox, cable.dstInlet, value, isEventSource);
      }
    } else if (isAudioBox(dst.text) && isOneSide(dst)) {
      const inletDef = def.inlets[cable.dstInlet];
      if (inletDef?.type === "event") {
        deferred.push(() => {
          _sendCtrl({ type: "ctrl-audio-event", boxId: cable.dstBox, inlet: cable.dstInlet });
          ctrlAudioTrigger(cable.dstBox);
        });
      } else {
        _sendCtrl({ type: "ctrl-audio-param", boxId: cable.dstBox, inlet: cable.dstInlet, value });
        if (typeof value === "number") {
          let iv = inletValues.get(cable.dstBox);
          if (!iv) { iv = []; inletValues.set(cable.dstBox, iv); }
          iv[cable.dstInlet] = value;
        }
      }
    } else if (isWirelessSend(dst.text)) {
      const name = dst.text.split(/\s+/).slice(1).join(" ");
      for (const [recvId, recvBox] of boxes) {
        if (isWirelessReceive(recvBox.text) && recvBox.text.split(/\s+/).slice(1).join(" ") === name && isOneSide(recvBox)) {
          setBoxValueAndNotify(recvId, value);
        }
      }
    } else if (isWirelessThrow(dst.text)) {
      const name = dst.text.split(/\s+/).slice(1).join(" ");
      const numValue = typeof value === "number" ? value : 0;
      for (const [catchId, catchBox] of boxes) {
        if (isWirelessCatch(catchBox.text) && catchBox.text.split(/\s+/).slice(1).join(" ") === name && isOneSide(catchBox)) {
          const prev = typeof boxValues.get(catchId) === "number" ? boxValues.get(catchId) as number : 0;
          setBoxValueAndNotify(catchId, prev + numValue);
        }
      }
    } else if (sideStamped(dst) !== "many") {
      // Pre-helper: event-typed inlet on a stateful box (e.g. ar/sigmoid/cosine
      // trigger). The shared helper's isEventTrigger covers most of these but
      // there are edge cases (event-type inlet on stateful boxes not in the
      // hardcoded list); preserve the explicit check.
      const inletDef = def.inlets[cable.dstInlet];
      if (inletDef && inletDef.type === "event" && boxState.has(cable.dstBox) && !inletDef.firesEvent) {
        const numValue = typeof value === "number" ? value : 0;
        deferred.push(() => handleEventBox(cable.dstBox, numValue));
        continue;
      }

      // Pre-helper: seq inlet 2 array preservation. handleStatefulInlet would
      // store the coerced numValue (0 for arrays), losing the array; the
      // shared helper's seq inlet ≥1 branch correctly preserves it via the
      // top-of-function value-store. Delegate to the helper for this case.
      const dstName = boxTypeName(dst.text);
      const numValueForStateful = typeof value === "number" ? value : 0;
      if (dstName === "seq" && cable.dstInlet === 2) {
        // fall through to shared dispatch below
      } else if (handleStatefulInlet(cable.dstBox, cable.dstInlet, numValueForStateful)) {
        // one-side stateful inlet stores (toggle, sample-hold, adsr inlet 0,
        // INLET_MAPS-driven cold params, etc.) — handled, no further dispatch.
        continue;
      }

      // Pre-helper: length is a server-special with array-aware computation
      // and queueValueUpdate (the helper doesn't know about queueValueUpdate).
      if (boxTypeName(dst.text) === "length") {
        const result = Array.isArray(value) ? value.length : 1;
        boxValues.set(cable.dstBox, result);
        queueValueUpdate(cable.dstBox, result);
        propagateAndNotify(cable.dstBox, 0, result);
        continue;
      }

      // Shared dispatch — handles seq inlet 2 (array-preserving), map,
      // change, spigot gate, default hot-inlet evaluation, firesEvent
      // signalling, and miscellaneous cold-store cases. inletDef passed
      // through so the helper can respect per-inlet hot:true metadata.
      const r = deliverValueToInlet(_serverGraphView, cable.dstBox, cable.dstInlet, value, _serverDeliverHelpers, inletDef);
      if (r.deferEvent) {
        const numValue = typeof value === "number" ? value : 0;
        deferred.push(() => handleEventBox(cable.dstBox, numValue));
      }
    } else {
      // A many-side destination reached by a bare cable. handleApply rejects
      // these, so getting here means a rule was bypassed: say so, don't drop.
      console.log(`\x1b[31m✗ cable to "${dst.text}" (box ${cable.dstBox}) dropped: many-side box reached without a router\x1b[0m`);
    }
  }

  // Phase 2: fire all deferred events after values have been delivered
  for (const fn of deferred) fn();
}

function isWirelessSend(text: string): boolean { const t = boxTypeName(text); return t === "send" || t === "s"; }
function isWirelessReceive(text: string): boolean { const t = boxTypeName(text); return t === "receive" || t === "r"; }
function isWirelessThrow(text: string): boolean { return boxTypeName(text) === "throw"; }
function isWirelessCatch(text: string): boolean { return boxTypeName(text) === "catch"; }

// Side is stamped at apply (sideOf in gpi-types.js). An unstamped box means
// a path skipped the stamp pass: fail loudly rather than guess.
export function sideStamped(box: Box): "one" | "many" | "border" {
  if (box.side === undefined) throw new Error(`box "${box.text}" has no side: apply must stamp sides before evaluation`);
  return box.side;
}

// The server evaluates the one side and the border (routers).
function isOneSide(box: Box): boolean {
  return sideStamped(box) !== "many";
}

export function evaluateAllConsts(): void {
  for (const [id, box] of boxes) {
    if (!isOneSide(box)) continue;
    const name = boxTypeName(box.text);
    if (name === "const") {
      setBoxValueAndNotify(id, parseFloat(box.text.split(/\s+/)[1]) || 0);
    } else if (name === "knob") {
      const kArgs = box.text.split(/\s+/).slice(1).map(Number);
      const init = kArgs[0] !== undefined ? kArgs[0] : 0.5;
      boxValues.set(id, init);
      setBoxValueAndNotify(id, init);
    } else if (name === "toggle") {
      const state = boxState.get(id);
      if (state) setBoxValueAndNotify(id, state.value);
    }
  }
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

export function evaluateAllDevices(): void {
  for (const [id, box] of boxes) {
    if (!isOneSide(box)) continue;
    const name = boxTypeName(box.text);
    if (!(name in DEVICE_DEFAULTS)) continue;
    const init = getDeviceInitValue(name, box.text);
    boxValues.set(id, init);
    setBoxValueAndNotify(id, init);
    if (name === "arc") arcValues.set(id, init);
  }
}

// Push the live synth-client count to every `clients` box. Called from
// server.ts on patch deploy and on every client connect/disconnect.
// Also re-runs `assign` allocation against its last-seen notes array, so
// new phones get an assignment immediately and departing phones cause an
// audible reshuffle. (User-spec behaviour 3.)
export function evaluateAllClients(): void {
  const count = _getSynthClientIds().length;
  for (const [id, box] of boxes) {
    if (!isOneSide(box)) continue;
    const name = boxTypeName(box.text);
    if (name === "clients") {
      setBoxValueAndNotify(id, count);
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

// --- Time-based box tick ---

export function initBoxState(id: number, box: Box): void {
  const name = boxTypeName(box.text);
  const args = box.text.split(/\s+/).slice(1).join(" ");
  const state = createBoxState(name, args);
  if (state) boxState.set(id, state);
}

export function shouldServerEval(box: Box): boolean {
  if (sideStamped(box) === "many") return false;
  if (isAudioBox(box.text)) return false;
  return true;
}

export function initAllBoxState(): void {
  boxState.clear();
  for (const [id, box] of boxes) {
    if (!shouldServerEval(box)) continue;
    initBoxState(id, box);
  }
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
    const iv = inletValues.get(boxId) || [];
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

function tick(): void {
  for (const [id, box] of boxes) {
    if (!shouldServerEval(box)) continue;
    const name = boxTypeName(box.text);
    const state = boxState.get(id);
    if (!state) continue;

    if (name === "slew" || name === "lag" || name === "inertia" || name === "follow") {
      const iv = inletValues.get(id);
      if (iv) state.target = iv[0] || 0;
    }

    const iv = inletValues.get(id) || [];
    const result = tickBox(name, state, iv, TICK_DT);
    if (!result) continue;

    const def = getBoxDef(box.text);
    const outlet0Def = def?.outlets?.[0];
    if (outlet0Def?.type === "event") {
      queueValueUpdate(id, result.value);
      for (const outlet of result.events) {
        propagateAndNotify(id, outlet, 0);
      }
    } else {
      boxValues.set(id, result.value);
      queueValueUpdate(id, result.value);
      propagateAndNotify(id, 0, result.value);
      for (const outlet of result.events) {
        propagateAndNotify(id, outlet, 0);
      }
    }
  }
  tickCtrlAudioAnims(TICK_DT);
}

function handleStatefulInlet(id: number, inlet: number, value: number): boolean {
  const box = boxes.get(id);
  if (!box) return false;
  const name = boxTypeName(box.text);
  const state = boxState.get(id);
  if (!state) return false;

  if (applyInletToState(name, state, inlet, value)) return true;

  if (name === "phasor" && inlet === 2) { state.paused = value > 0; return true; }
  if (name === "metro" && inlet === 0) { state.paused = !(value > 0); return true; }
  if (name === "adsr" && inlet === 0) return true;
  if (name === "sample-hold" && inlet === 0) return true;
  if (name === "seq" && (inlet === 1 || inlet === 2)) {
    let iv = inletValues.get(id);
    if (!iv) { iv = []; inletValues.set(id, iv); }
    iv[inlet] = value;
    return true;
  }
  if (name === "held" && inlet === 0) {
    let iv = inletValues.get(id);
    if (!iv) { iv = []; inletValues.set(id, iv); }
    iv[0] = value;
    return true;
  }
  if (name === "map" && inlet === 1) {
    const arr = inletValues.get(id)?.[1];
    if (Array.isArray(arr)) state.table = arr;
    return true;
  }
  if (name === "toggle" && inlet === 1) {
    const newVal = value > 0 ? 1 : 0;
    if (newVal !== state.value) {
      state.value = newVal;
      setBoxValueAndNotify(id, state.value);
    }
    return true;
  }
  return false;
}

function handleEventBox(id: number, _value: number): void {
  const box = boxes.get(id);
  if (!box) return;
  const name = boxTypeName(box.text);
  const state = boxState.get(id);
  if (!state) {
    propagateAndNotify(id, 0, 1);
    return;
  }

  const iv = inletValues.get(id) || [];
  const result = handleBoxEvent(name, state, iv);
  if (!result) return;

  if (result.outputs) {
    for (const out of result.outputs) {
      if (out.type !== "event") {
        boxValues.set(id, out.value);
        queueValueUpdate(id, out.value);
      }
      propagateAndNotify(id, out.outlet, out.type === "event" ? 0 : out.value);
    }
    return;
  }

  if (result.propagate) {
    setBoxValueAndNotify(id, result.value);
  }
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
