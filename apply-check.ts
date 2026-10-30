// apply-check.ts — pure half of "apply": expand abstractions into local maps,
// stamp each box's side, validate. Nothing here touches the running patch;
// applyPatch commits the result to the live patch only if there are no errors.

import {
  type Box, type Cable,
  boxes as liveBoxes, cables as liveCables,
  clearPatchState, getSynthBorderY, setSynthBorderY, setPatchNextId,
} from "./patch-state.ts";
import { boxTypeName, boxBinding, getBoxDef, getBoxPorts, getOutletDef, isOffSide, sideOf } from "./public/gpi-types.js";

export interface AbstractionDef {
  // deno-lint-ignore no-explicit-any
  boxes: Map<number, any>;
  // deno-lint-ignore no-explicit-any
  cables: Map<number, any>;
}

// Inner boxes of an abstraction, for binding inference (gpi-types lookup).
function innerBoxes(loaded: Map<string, AbstractionDef>) {
  return (name: string) => loaded.get(name)?.boxes.values() ?? null;
}

// Expands every abstraction instance in `boxes`/`cables` (local maps, not the
// running patch) into its contents. Returns non-fatal wiring errors.
export function expandAbstractions(
  boxes: Map<number, Box>, cables: Map<number, Cable>, nextId: number,
  loadedAbstractions: Map<string, AbstractionDef>,
): string[] {
  const errors: string[] = [];
  const MAX_DEPTH = 16;
  let globalIdCounter = 100000;
  let nextCableId = nextId + 50000;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let expanded = 0;

    for (const [boxId, box] of [...boxes]) {
      const absName = boxTypeName(box.text);
      const absDef = loadedAbstractions.get(absName);
      if (!absDef) continue;

      // Parse arguments: "scale-note 48 7" → args = ["48", "7"]
      const args = box.text.split(/\s+/).slice(1);
      const instanceId = String(globalIdCounter);  // $0

      // Build inlet/outlet index → internal box mapping
      const inletMap = new Map<number, number>();
      const outletMap = new Map<number, number>();

      for (const [localId, intBox] of absDef.boxes) {
        const type = boxTypeName(intBox.text);
        const idx = parseInt(intBox.text.split(/\s+/)[1]) || 0;
        if (type === "inlet") inletMap.set(idx, localId);
        if (type === "outlet") outletMap.set(idx, localId);
      }

      // Clone internal boxes (excluding inlet/outlet boxes)
      const localToGlobal = new Map<number, number>();
      for (const [localId, intBox] of absDef.boxes) {
        const type = boxTypeName(intBox.text);
        if (type === "inlet" || type === "outlet") continue;

        const globalId = globalIdCounter++;
        localToGlobal.set(localId, globalId);

        // Argument substitution: $0=instanceId, $1=args[0], $2=args[1], ...
        let text = intBox.text;
        text = text.replace(/\$0/g, instanceId);
        for (let i = 0; i < args.length; i++) {
          text = text.replace(new RegExp("\\$" + (i + 1), "g"), args[i]);
        }

        // Zone inheritance: cloned boxes get Y of instance box
        const clonedBox = { ...intBox, text, x: intBox.x, y: box.y };
        const p = getBoxPorts(clonedBox.text);
        clonedBox.inlets = p.inlets;
        clonedBox.outlets = p.outlets;
        boxes.set(globalId, clonedBox);
      }

      // Clone internal cables (skip those touching inlet/outlet)
      for (const [, cable] of absDef.cables) {
        const srcBox = absDef.boxes.get(cable.srcBox);
        const dstBox = absDef.boxes.get(cable.dstBox);
        const srcType = srcBox ? boxTypeName(srcBox.text) : "";
        const dstType = dstBox ? boxTypeName(dstBox.text) : "";
        if (srcType === "inlet" || dstType === "outlet") continue;

        const srcGlobal = localToGlobal.get(cable.srcBox);
        const dstGlobal = localToGlobal.get(cable.dstBox);
        if (srcGlobal === undefined || dstGlobal === undefined) continue;

        cables.set(nextCableId++, {
          srcBox: srcGlobal, srcOutlet: cable.srcOutlet,
          dstBox: dstGlobal, dstInlet: cable.dstInlet,
        });
      }

      // Rewire external cables through inlet/outlet
      for (const [cableId, cable] of [...cables]) {
        if (cable.dstBox === boxId) {
          const inletLocalId = inletMap.get(cable.dstInlet);
          if (inletLocalId === undefined) {
            errors.push(`${absName}: cable targets inlet ${cable.dstInlet}, but only inlets 0-${inletMap.size - 1} exist`);
            cables.delete(cableId);
            continue;
          }
          for (const [, intCable] of absDef.cables) {
            if (intCable.srcBox === inletLocalId) {
              const targetGlobal = localToGlobal.get(intCable.dstBox);
              if (targetGlobal !== undefined) {
                cables.set(nextCableId++, {
                  srcBox: cable.srcBox, srcOutlet: cable.srcOutlet,
                  dstBox: targetGlobal, dstInlet: intCable.dstInlet,
                });
              }
            }
          }
          cables.delete(cableId);
        }

        if (cable.srcBox === boxId) {
          const outletLocalId = outletMap.get(cable.srcOutlet);
          if (outletLocalId === undefined) {
            errors.push(`${absName}: cable from outlet ${cable.srcOutlet}, but only outlets 0-${outletMap.size - 1} exist`);
            cables.delete(cableId);
            continue;
          }
          for (const [, intCable] of absDef.cables) {
            if (intCable.dstBox === outletLocalId) {
              const sourceGlobal = localToGlobal.get(intCable.srcBox);
              if (sourceGlobal !== undefined) {
                cables.set(nextCableId++, {
                  srcBox: sourceGlobal, srcOutlet: intCable.srcOutlet,
                  dstBox: cable.dstBox, dstInlet: cable.dstInlet,
                });
              }
            }
          }
          cables.delete(cableId);
        }
      }

      boxes.delete(boxId);
      expanded++;
    }

    if (expanded === 0) break;

    // Cycle detection: check if any remaining abstraction was just expanded
    if (depth === MAX_DEPTH - 1) {
      errors.push("Abstraction nesting limit reached (16 levels) — possible circular reference");
    }
  }

  return errors;
}

export interface ApplyResult {
  errors: string[];          // reject the apply if non-empty
  warnings: string[];        // abstraction wiring problems; apply goes ahead
  boxes: Map<number, Box>;   // expanded, with `side` stamped
  cables: Map<number, Cable>;
  borderY: number;
}

// Box types that are neither built in nor a known abstraction. Empty boxes are
// ignored (a freshly placed box has no text yet).
function findUnknownBoxTypes(boxes: Map<number, Box>, loaded: Map<string, AbstractionDef>): string[] {
  const unknown = new Set<string>();
  for (const [, box] of boxes) {
    const text = (box.text ?? "").trim();
    if (!text) continue;
    const type = boxTypeName(text);
    if (!getBoxDef(text) && !loaded.has(type)) unknown.add(type);
  }
  return [...unknown];
}

// Rejections that need the expanded graph and stamped sides. Audio never
// crosses the border, and routers carry events and values only: events and
// values cross the border through a router, never on a bare cable. A bound box
// must sit on its own side. The editor refuses these and auto-routes the rest;
// this catches patch files edited by hand and anything else that bypasses it.
function findSideViolations(boxes: Map<number, Box>, cables: Map<number, Cable>, borderY: number, loaded: Map<string, AbstractionDef>): string[] {
  const problems = new Set<string>();
  for (const [, box] of boxes) {
    if (isOffSide(box, borderY, innerBoxes(loaded))) {
      problems.add(`"${box.text}" is bound to the ${box.side} side but placed on the ${box.side === "one" ? "many" : "one"} side`);
    }
  }
  for (const [, c] of cables) {
    const src = boxes.get(c.srcBox), dst = boxes.get(c.dstBox);
    if (!src || !dst) continue;
    const viaRouter = src.side === "border" || dst.side === "border";
    if (getOutletDef(src.text, c.srcOutlet)?.type === "audio") {
      if (viaRouter) {
        problems.add(`audio cable "${src.text}" to "${dst.text}": routers carry events and values, not audio`);
      } else if (src.side !== dst.side) {
        problems.add(`audio cable "${src.text}" to "${dst.text}" crosses the border`);
      }
    } else if (!viaRouter && src.side !== dst.side) {
      problems.add(`cable "${src.text}" to "${dst.text}" crosses the border without a router`);
    }
  }
  return [...problems];
}

// Build the patch an apply message describes, without touching any global.
// Order: unknown types, abstraction bindings, expand, stamp sides, validate.
// deno-lint-ignore no-explicit-any
export function checkApply(msg: any, loaded: Map<string, AbstractionDef>, currentBorderY: number): ApplyResult {
  const borderY: number = msg.synthBorderY ?? currentBorderY;
  const boxes = new Map<number, Box>();
  const cables = new Map<number, Cable>();
  // deno-lint-ignore no-explicit-any
  for (const [id, box] of msg.boxes as [number, any][]) {
    const p = getBoxPorts(box.text);
    const copy: Box = { ...box, inlets: p.inlets, outlets: p.outlets };
    // snap routers to border
    if (boxBinding(copy.text).binding === "border") copy.y = borderY - 11;
    boxes.set(id, copy);
  }
  // deno-lint-ignore no-explicit-any
  for (const [id, cable] of msg.cables as [number, any][]) cables.set(id, cable);

  const errors = findUnknownBoxTypes(boxes, loaded).map((t) => `unknown box type "${t}"`);
  const lookup = innerBoxes(loaded);
  const absErrors = new Set<string>();
  for (const [, box] of boxes) {
    const { error } = boxBinding(box.text, lookup);
    if (error) absErrors.add(error);
  }
  errors.push(...absErrors);
  // An inconsistent abstraction cannot be given a side; stop before expanding.
  if (absErrors.size > 0) return { errors, warnings: [], boxes, cables, borderY };

  const warnings = expandAbstractions(boxes, cables, msg.nextId || 1, loaded);
  for (const [, box] of boxes) box.side = sideOf(box, borderY, lookup);
  errors.push(...findSideViolations(boxes, cables, borderY, loaded));
  return { errors, warnings, boxes, cables, borderY };
}

// Validate, and only if clean, replace the running patch. A rejected apply
// leaves it untouched. Evaluation and deploy are the caller's job.
// deno-lint-ignore no-explicit-any
export function applyPatch(msg: any, loaded: Map<string, AbstractionDef>): ApplyResult {
  const result = checkApply(msg, loaded, getSynthBorderY());
  if (result.errors.length > 0) return result;
  clearPatchState();
  for (const [id, box] of result.boxes) liveBoxes.set(id, box);
  for (const [id, cable] of result.cables) liveCables.set(id, cable);
  setPatchNextId(msg.nextId || 1);
  setSynthBorderY(result.borderY);
  return result;
}

// Binding error for an abstraction about to be saved (null if it is fine).
// deno-lint-ignore no-explicit-any
export function checkAbstraction(name: string, raw: any, loaded: Map<string, AbstractionDef>): string | null {
  const withNew = new Map(loaded);
  withNew.set(name, { boxes: new Map(raw.boxes), cables: new Map(raw.cables) });
  return boxBinding(name, innerBoxes(withNew)).error;
}
