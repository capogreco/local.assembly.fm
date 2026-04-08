// patch-state.ts — shared graph state for server.ts split
// Zero dependencies. Holds Maps, scalars, and pure helpers that
// both server (edit/apply) and eval-engine (propagation/tick) need.

// --- Interfaces ---

export interface Box {
  x: number; y: number; text: string; inlets: number; outlets: number;
}

export interface Cable {
  srcBox: number; srcOutlet: number; dstBox: number; dstInlet: number;
}

export type BoxValue = number | number[] | string;

// --- Core graph state ---

export const boxes = new Map<number, Box>();
export const cables = new Map<number, Cable>();
export const boxValues = new Map<number, BoxValue>();
export const inletValues = new Map<number, number[]>();
// deno-lint-ignore no-explicit-any
export const boxState = new Map<number, any>();

let _patchNextId = 1;
export function getPatchNextId(): number { return _patchNextId; }
export function setPatchNextId(v: number): void { _patchNextId = v; }
export function bumpPatchNextId(id: number): void {
  if (id >= _patchNextId) _patchNextId = id + 1;
}

let _synthBorderY = 400;
export function getSynthBorderY(): number { return _synthBorderY; }
export function setSynthBorderY(v: number): void { _synthBorderY = v; }

// deno-lint-ignore no-explicit-any
let _deployedPatch: Record<string, any> | null = null;
// deno-lint-ignore no-explicit-any
export function getDeployedPatch(): Record<string, any> | null { return _deployedPatch; }
// deno-lint-ignore no-explicit-any
export function setDeployedPatch(v: Record<string, any> | null): void { _deployedPatch = v; }

// --- Pipeline state ---

export const routerState = new Map<number, { index: number; order?: number[] }>();
export const groupState = new Map<number, number[][]>();
export const latestValues = new Map<string, string>();
export const uplinkIndex = new Map<string, Array<{ boxId: number; outletIndex: number }>>();

// --- Helpers ---

export function clearPatchState(): void {
  boxes.clear();
  cables.clear();
  boxValues.clear();
  inletValues.clear();
  boxState.clear();
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

export function isSynthZone(_px: number, py: number): boolean {
  return py >= _synthBorderY;
}
