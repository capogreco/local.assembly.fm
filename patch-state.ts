// patch-state.ts — shared graph state for server.ts split
// Zero dependencies. Holds Maps, scalars, and pure helpers that
// both server (edit/apply) and eval-engine (propagation/tick) need.

// --- Interfaces ---

export interface Box {
  x: number; y: number; text: string; inlets: number; outlets: number;
  // Stamped at apply (sideOf in gpi-types.js); never sent to phones.
  side?: "one" | "many" | "border";
}

export interface Cable {
  srcBox: number; srcOutlet: number; dstBox: number; dstInlet: number;
}

export type BoxValue = number | number[] | string;

// --- Core graph state ---

export const boxes = new Map<number, Box>();
export const cables = new Map<number, Cable>();
// Last value shown on each box (display); evaluation state lives in the
// server graph (eval-engine.ts).
export const boxValues = new Map<number, BoxValue>();

let _patchNextId = 1;
export function getPatchNextId(): number { return _patchNextId; }
export function setPatchNextId(v: number): void { _patchNextId = v; }
export function bumpPatchNextId(id: number): void {
  if (id >= _patchNextId) _patchNextId = id + 1;
}

let _borderY = 400;
export function getBorderY(): number { return _borderY; }
export function setBorderY(v: number): void { _borderY = v; }

// deno-lint-ignore no-explicit-any
let _deployedPatch: Record<string, any> | null = null;
// deno-lint-ignore no-explicit-any
export function getDeployedPatch(): Record<string, any> | null { return _deployedPatch; }
// deno-lint-ignore no-explicit-any
export function setDeployedPatch(v: Record<string, any> | null): void { _deployedPatch = v; }

// The laptop deploy (one-side audio, deploy.ts), sent to every ctrl socket.
// deno-lint-ignore no-explicit-any
let _laptopPatch: Record<string, any> | null = null;
// deno-lint-ignore no-explicit-any
export function getLaptopPatch(): Record<string, any> | null { return _laptopPatch; }
// deno-lint-ignore no-explicit-any
export function setLaptopPatch(v: Record<string, any> | null): void { _laptopPatch = v; }

// --- Pipeline state ---

export const routerState = new Map<number, { index: number; order?: number[]; storedValues?: Record<number, unknown> }>();
export const groupState = new Map<number, number[][]>();
// Last rv per broadcast router channel ("routerId:ch"), replayed to a joining
// phone. Events are never stored: a replayed re would fire on join.
export const latestValues = new Map<string, Record<string, unknown>>();
export const uplinkIndex = new Map<string, Array<{ boxId: number; outletIndex: number }>>();

// Per-`assign` box state: clientIdx → assigned note. lastNotes used to detect changes.
// `amps` (optional, inlet 1) is a parallel array index-aligned to the notes array, used to
// send a [note, amp] pair per phone (spectral resynthesis); absent → plain scalar note send.
export const assignState = new Map<number, { assignment: Map<number, number>; lastNotes: number[]; amps?: number[] }>();

// --- Helpers ---

export function clearPatchState(): void {
  boxes.clear();
  cables.clear();
  boxValues.clear();
  routerState.clear();
  groupState.clear();
  assignState.clear();
}

export function removeCablesForBox(boxId: number): void {
  for (const [id, c] of cables) {
    if (c.srcBox === boxId || c.dstBox === boxId) cables.delete(id);
  }
}

export function cablesFromOutlet(boxId: number, outlet: number): Cable[] {
  const r: Cable[] = [];
  for (const [, c] of cables) {
    if (c.srcBox === boxId && c.srcOutlet === outlet) r.push(c);
  }
  return r;
}
