// apply-check.ts — pure half of "apply": expand abstractions into local maps,
// stamp each box's side, validate. Nothing here touches the running patch;
// applyPatch commits the result to the live patch only if there are no errors.
// It also holds the abstraction checks: the header (parseAbstraction), the
// contents against the header (checkAbstraction), and the boundary of each
// instance at apply (expandAbstractions). See notes/abstractions.md.
//
// Everything here reads abstractions from the `loaded` map it is given, never
// from gpi-types' table (useAbstractions), which is the editor's.

import {
  type Box, type Cable,
  boxes as liveBoxes, cables as liveCables,
  type InstanceMap,
  clearPatchState, getBorderY, setAuthoredPatch, setBorderY, setPatchNextId,
} from "./patch-state.ts";
import {
  ABS_NAME, LIB_NAME, MAX_DEPTH, PORT_TYPES, boxTypeName, boxBinding, bufferArgs, cableTypeProblem, getBoxDef, getBoxPorts, getInletDef, getOutletDef,
  boxHeight, faceContents, groupArgs, isOffSide, routerY, sideOf, wholeSide,
} from "./public/gpi-types.js";

export interface PortSpec { name: string; type: string; description: string }
export interface ArgSpec { name: string; type: "symbol" | "number"; description: string }
// The rectangle an instance shows on its parent, in grid units in the
// abstraction's own coordinates (notes/abstractions.md, "Face proposal").
export interface Face { x: number; y: number; w: number; h: number; hideName: boolean }

export interface AbstractionDef {
  name: string;                 // "lib/name"
  side: "ctrl" | "synth";
  description: string;
  args: ArgSpec[];
  inlets: PortSpec[];
  outlets: PortSpec[];
  face: Face | null;
  // deno-lint-ignore no-explicit-any
  boxes: Map<number, any>;
  // deno-lint-ignore no-explicit-any
  cables: Map<number, any>;
}

// --- Names ---

// The `lib/name` pattern is gpi-types' (the editor's too).
export { LIB_NAME };

export function isAbstractionName(name: string): boolean {
  return ABS_NAME.test(name);
}

// --- Header ---

const HEADER_KEYS = new Set(["name", "side", "description", "args", "inlets", "outlets", "face", "boxes", "cables", "nextId"]);

// deno-lint-ignore no-explicit-any
function isObj(v: any): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// deno-lint-ignore no-explicit-any
function checkSpecList(raw: any, key: string, types: readonly string[], errors: string[]): void {
  const list = raw[key];
  if (!Array.isArray(list)) { errors.push(`"${key}" must be a list`); return; }
  const names = new Set<string>();
  // deno-lint-ignore no-explicit-any
  list.forEach((s: any, i: number) => {
    const where = `${key}[${i}]`;
    if (!isObj(s)) { errors.push(`${where} must be an object`); return; }
    for (const k of Object.keys(s)) if (!["name", "type", "description"].includes(k)) errors.push(`${where} has unknown field "${k}"`);
    if (typeof s.name !== "string" || !/^\S+$/.test(s.name)) errors.push(`${where} needs a name (one word)`);
    else if (names.has(s.name)) errors.push(`${where}: name "${s.name}" is used twice`);
    else names.add(s.name);
    if (!types.includes(s.type)) errors.push(`${where} type must be one of ${types.join(", ")} (got ${JSON.stringify(s.type)})`);
    if (typeof s.description !== "string") errors.push(`${where} needs a description (a string, may be empty)`);
  });
}

// An optional face: x, y (integers), w, h (integers, at least 2), all grid
// units, and hideName (a boolean). Nothing else.
// deno-lint-ignore no-explicit-any
function checkFace(face: any, errors: string[]): void {
  if (face === undefined) return;
  if (!isObj(face)) { errors.push(`"face" must be an object { x, y, w, h, hideName }`); return; }
  for (const k of Object.keys(face)) if (!["x", "y", "w", "h", "hideName"].includes(k)) errors.push(`face has unknown field "${k}"`);
  for (const k of ["x", "y"]) if (!Number.isInteger(face[k])) errors.push(`face.${k} must be a whole number of grid units (got ${JSON.stringify(face[k])})`);
  for (const k of ["w", "h"]) if (!Number.isInteger(face[k]) || face[k] < 2) errors.push(`face.${k} must be a whole number of grid units, at least 2 (got ${JSON.stringify(face[k])})`);
  if (typeof face.hideName !== "boolean") errors.push(`face.hideName must be true or false`);
}

// Read an abstraction file's JSON into an AbstractionDef. `name` is the name
// it is stored under (`lib/name`); the header must say the same. Returns the
// header problems, one line each; `def` is null if there are any.
// deno-lint-ignore no-explicit-any
export function parseAbstraction(name: string, raw: any): { def: AbstractionDef | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { def: null, errors: ["not a JSON object"] };
  for (const k of Object.keys(raw)) if (!HEADER_KEYS.has(k)) errors.push(`unknown field "${k}"`);
  if (raw.name !== name) errors.push(`"name" must be "${name}" (got ${JSON.stringify(raw.name)})`);
  if (raw.side !== "ctrl" && raw.side !== "synth") errors.push(`"side" must be "ctrl" or "synth" (got ${JSON.stringify(raw.side)})`);
  if (typeof raw.description !== "string") errors.push(`"description" must be a string`);
  checkSpecList(raw, "args", ["symbol", "number"], errors);
  checkSpecList(raw, "inlets", PORT_TYPES, errors);
  checkSpecList(raw, "outlets", PORT_TYPES, errors);
  checkFace(raw.face, errors);
  if (!Array.isArray(raw.boxes)) errors.push(`"boxes" must be a list of [id, box]`);
  if (!Array.isArray(raw.cables)) errors.push(`"cables" must be a list of [id, cable]`);
  if (errors.length > 0) return { def: null, errors };
  return {
    def: {
      name, side: raw.side, description: raw.description,
      args: raw.args, inlets: raw.inlets, outlets: raw.outlets, face: raw.face ?? null,
      boxes: new Map(raw.boxes), cables: new Map(raw.cables),
    },
    errors,
  };
}

// --- Port lookups against `loaded` ---

function absOf(text: string, loaded: Map<string, AbstractionDef>): AbstractionDef | undefined {
  return loaded.get(boxTypeName(text));
}

function portCounts(text: string, loaded: Map<string, AbstractionDef>): { inlets: number; outlets: number } {
  const a = absOf(text, loaded);
  return a ? { inlets: a.inlets.length, outlets: a.outlets.length } : getBoxPorts(text);
}

function inletSpec(text: string, i: number, loaded: Map<string, AbstractionDef>): { type: string } | null {
  const a = absOf(text, loaded);
  return a ? a.inlets[i] ?? null : getInletDef(text, i);
}

function outletSpec(text: string, i: number, loaded: Map<string, AbstractionDef>): { type: string } | null {
  const a = absOf(text, loaded);
  return a ? a.outlets[i] ?? null : getOutletDef(text, i);
}

function bindingOf(text: string, loaded: Map<string, AbstractionDef>): string {
  return absOf(text, loaded)?.side ?? boxBinding(text);
}

// Can a source of type `src` feed inlet `dstInlet` of `dstText`? The rule is
// gpi-types' cableTypeProblem (the editor's too); the inlet comes from `loaded`.
function typeProblem(src: string, dstText: string, dstInlet: number, loaded: Map<string, AbstractionDef>): string | null {
  return cableTypeProblem(src, dstText, inletSpec(dstText, dstInlet, loaded));
}

// Index of an `inlet i` / `outlet i` box, or null if it isn't exactly that.
function portIndex(text: string): number | null {
  const t = text.trim().split(/\s+/);
  return t.length === 2 && /^\d+$/.test(t[1]) ? Number(t[1]) : null;
}

const ARG_REF = /\$(\d+)/g;

// --- Contents against the header ---

// Problems with an abstraction's contents, one line each, all errors:
// unknown box types; its declared side against the boxes inside (a router, or a box bound to the
// other side); the inlet/outlet boxes against the header (one `inlet i` per
// header inlet, no gaps, no extras, explicit indices); port types against the
// wiring inside, and nested instances' port counts; an inlet wired straight to an outlet; a `$n` with no
// declared arg; containing itself. `loaded`
// gives nested abstractions; `def` itself need not be in it.
export function checkAbstraction(def: AbstractionDef, loaded: Map<string, AbstractionDef>): string[] {
  const all = new Map(loaded).set(def.name, def);
  const errors: string[] = [];
  const err = (m: string) => errors.push(`"${def.name}": ${m}`);

  const ports = { inlet: new Map<number, number[]>(), outlet: new Map<number, number[]>() };
  for (const [id, box] of def.boxes) {
    const text: string = box.text ?? "";
    const type = boxTypeName(text);
    if (type === "inlet" || type === "outlet") {
      const i = portIndex(text);
      if (i === null) { err(`"${text}" needs exactly one index, as "${type} 0"`); continue; }
      const m = ports[type as "inlet" | "outlet"];
      m.set(i, [...(m.get(i) ?? []), id]);
      continue;
    }
    if (text.trim() && !getBoxDef(text) && !all.has(type)) { err(`unknown box type "${type}"`); continue; }
    const b = bindingOf(text, all);
    if (b === "border") err(`contains router "${text}": an abstraction lives on a single side`);
    else if ((b === "ctrl" || b === "synth") && b !== def.side) err(`is declared ${def.side} but contains ${b}-bound "${text}"`);
    for (const [, n] of text.matchAll(ARG_REF)) {
      const k = Number(n);
      if (k > def.args.length) err(`"${text}" uses $${k}, but ${def.args.length} arg(s) are declared`);
    }
  }

  for (const kind of ["inlet", "outlet"] as const) {
    const specs = kind === "inlet" ? def.inlets : def.outlets;
    for (const [i, ids] of ports[kind]) {
      if (i >= specs.length) err(`"${kind} ${i}" has no header entry (the header declares ${specs.length} ${kind}s)`);
      else if (ids.length > 1) err(`${kind} ${i} (${specs[i].name}, ${specs[i].type}) has ${ids.length} "${kind} ${i}" boxes`);
    }
    specs.forEach((s, i) => {
      if (!ports[kind].has(i)) err(`${kind} ${i} (${s.name}, ${s.type}) has no "${kind} ${i}" box`);
    });
  }

  // Wiring through the inlet/outlet boxes, and into or out of nested abstractions.
  const inletOf = (box: { text: string }) =>
    boxTypeName(box.text) === "inlet" ? def.inlets[portIndex(box.text) ?? -1] : undefined;
  const outletOf = (box: { text: string }) =>
    boxTypeName(box.text) === "outlet" ? def.outlets[portIndex(box.text) ?? -1] : undefined;
  for (const [, c] of def.cables) {
    const src = def.boxes.get(c.srcBox), dst = def.boxes.get(c.dstBox);
    if (!src || !dst) { err(`cable ${c.srcBox}:${c.srcOutlet} → ${c.dstBox}:${c.dstInlet} has a missing end`); continue; }
    // Expansion rewires through a box on each side; a bare inlet → outlet
    // cable has nothing to land on, so it is refused rather than dropped.
    if (boxTypeName(src.text) === "inlet" && boxTypeName(dst.text) === "outlet") {
      err(`inlet ${portIndex(src.text)} is wired directly to outlet ${portIndex(dst.text)}: put a box between`);
      continue;
    }
    // A nested instance's ports are its header's.
    const srcAbs = absOf(src.text, all), dstAbs = absOf(dst.text, all);
    if (srcAbs && c.srcOutlet >= srcAbs.outlets.length) {
      err(`cable from "${src.text}" outlet ${c.srcOutlet}: no such outlet (it has ${srcAbs.outlets.length})`);
      continue;
    }
    if (dstAbs && c.dstInlet >= dstAbs.inlets.length) {
      err(`cable into "${dst.text}" inlet ${c.dstInlet}: no such inlet (it has ${dstAbs.inlets.length})`);
      continue;
    }
    const fromInlet = inletOf(src), toOutlet = outletOf(dst);
    const srcType = fromInlet?.type ?? outletSpec(src.text, c.srcOutlet, all)?.type;
    if (srcType === undefined) continue;
    if (toOutlet) {
      if ((srcType === "audio") !== (toOutlet.type === "audio")) {
        err(`${dst.text} (${toOutlet.name}, ${toOutlet.type}): fed by ${srcType} from "${src.text}"`);
      }
      continue;
    }
    if (!fromInlet && !absOf(src.text, all) && !absOf(dst.text, all)) continue;
    const problem = typeProblem(srcType, dst.text, c.dstInlet, all);
    if (problem) {
      const from = fromInlet ? `${src.text} (${fromInlet.name}, ${fromInlet.type})` : `"${src.text}" outlet ${c.srcOutlet}`;
      err(`${from} → "${dst.text}" inlet ${c.dstInlet}: ${problem}`);
    }
  }

  // The face: every GUI box wholly inside or wholly outside, and at least one inside.
  if (def.face) {
    const { shown, crossing } = faceContents(def, (n: string) => all.get(n) ?? null);
    for (const b of crossing) err(`face: "${b.text}" crosses the face's edge; move it wholly inside or outside`);
    if (shown.length === 0) err(`face: no GUI box inside (a knob, toggle, event, fan, print, scope~, comment, or a faced abstraction)`);
  }

  // Containing itself, at any depth.
  const visit = (a: AbstractionDef, path: string[]): void => {
    for (const [, box] of a.boxes) {
      const inner = absOf(box.text ?? "", all);
      if (!inner) continue;
      if (inner.name === def.name) { err(`contains itself (${[...path, inner.name].join(" → ")})`); continue; }
      if (path.includes(inner.name)) continue; // another abstraction's cycle; reported for that one
      visit(inner, [...path, inner.name]);
    }
  };
  visit(def, [def.name]);
  return errors;
}

// The checks for saving `def` over `loaded` (the registry): its own contents,
// and every other abstraction against the registry with `def` in it, so a save
// can't leave the library unloadable (a user of `def` wired to a port its new
// header dropped, a cycle through it). Every problem is an error.
export function checkSave(def: AbstractionDef, loaded: Map<string, AbstractionDef>): string[] {
  const candidate = new Map(loaded).set(def.name, def);
  const errors = checkAbstraction(def, candidate);
  for (const name of [...candidate.keys()].sort()) {
    if (name === def.name) continue;
    for (const e of checkAbstraction(candidate.get(name)!, candidate)) errors.push(`saving "${def.name}" would break ${e}`);
  }
  return errors;
}

// Every abstraction the boxes use, nested ones included.
function usedAbstractions(texts: Iterable<string>, loaded: Map<string, AbstractionDef>): Set<string> {
  const used = new Set<string>();
  const walk = (text: string) => {
    const a = absOf(text, loaded);
    if (!a || used.has(a.name)) return;
    used.add(a.name);
    for (const [, b] of a.boxes) walk(b.text ?? "");
  };
  for (const t of texts) walk(t);
  return used;
}

// --- Expansion ---

// Problems with an instance's text against its header's args.
function argProblems(text: string, def: AbstractionDef): string[] {
  const given = text.trim().split(/\s+/).slice(1);
  const out: string[] = [];
  def.args.forEach((a, i) => {
    const v = given[i];
    if (v === undefined) out.push(`"${text}" arg ${i + 1} (${a.name}, ${a.type}): missing`);
    else if (a.type === "number" && !Number.isFinite(Number(v))) out.push(`"${text}" arg ${i + 1} (${a.name}, ${a.type}): "${v}" is not a number`);
  });
  if (given.length > def.args.length) out.push(`"${text}": ${given.length} args given, ${def.args.length} declared`);
  return out;
}

// Expands every abstraction instance in `boxes`/`cables` (local maps, not the
// running patch) into its contents, checking each instance's boundary as it
// goes: its args, and each cable on it against the header's port count and
// types. Instances nested inside are expanded (and checked, with their args
// filled in) on the next pass. Every problem is an error. Each instance's
// local→global id map goes into `instances`, nested ones under their own
// (global) id, so the maps chain.
export function expandAbstractions(
  boxes: Map<number, Box>, cables: Map<number, Cable>, nextId: number,
  loaded: Map<string, AbstractionDef>, instances: Map<number, InstanceMap> = new Map(),
): string[] {
  const errors: string[] = [];
  let globalIdCounter = 100000;
  let nextCableId = nextId + 50000;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let expanded = 0;

    for (const [boxId, box] of [...boxes]) {
      const absDef = absOf(box.text, loaded);
      if (!absDef) continue;

      errors.push(...argProblems(box.text, absDef));
      const args = box.text.trim().split(/\s+/).slice(1);
      const instanceId = String(globalIdCounter);  // $0

      // Build inlet/outlet index → internal box mapping
      const inletMap = new Map<number, number>();
      const outletMap = new Map<number, number>();
      for (const [localId, intBox] of absDef.boxes) {
        const type = boxTypeName(intBox.text);
        const idx = portIndex(intBox.text);
        if (idx === null) continue;
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
        // One pass with a function, so an arg is inserted as written: its own
        // `$&`, `$$` or `$1` is neither a replacement pattern nor substituted again.
        const text = intBox.text.replace(ARG_REF, (ref: string, n: string) =>
          n === "0" ? instanceId : args[Number(n) - 1] ?? ref);

        // Side inheritance: cloned boxes get Y of instance box
        const clonedBox = { ...intBox, text, x: intBox.x, y: box.y };
        const p = portCounts(clonedBox.text, loaded);
        clonedBox.inlets = p.inlets;
        clonedBox.outlets = p.outlets;
        boxes.set(globalId, clonedBox);
      }

      instances.set(boxId, { text: box.text, ids: Object.fromEntries(localToGlobal) });

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

      // Rewire external cables through inlet/outlet, checking each against the header.
      for (const [cableId, cable] of [...cables]) {
        if (cable.dstBox === boxId) {
          cables.delete(cableId);
          const i = cable.dstInlet;
          const spec = absDef.inlets[i];
          const inletLocalId = inletMap.get(i);
          if (!spec || inletLocalId === undefined) {
            errors.push(`"${box.text}" inlet ${i}: no such inlet (it has ${absDef.inlets.length})`);
            continue;
          }
          const src = boxes.get(cable.srcBox);
          const srcType = src ? outletSpec(src.text, cable.srcOutlet, loaded)?.type : undefined;
          if (srcType !== undefined && (srcType === "audio") !== (spec.type === "audio")) {
            errors.push(`"${box.text}" inlet ${i} (${spec.name}, ${spec.type}): fed by ${srcType} from "${src!.text}"`);
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
        }

        if (cable.srcBox === boxId) {
          cables.delete(cableId);
          const o = cable.srcOutlet;
          const spec = absDef.outlets[o];
          const outletLocalId = outletMap.get(o);
          if (!spec || outletLocalId === undefined) {
            errors.push(`"${box.text}" outlet ${o}: no such outlet (it has ${absDef.outlets.length})`);
            continue;
          }
          const dst = boxes.get(cable.dstBox);
          const problem = dst ? typeProblem(spec.type, dst.text, cable.dstInlet, loaded) : null;
          if (problem) {
            errors.push(`"${box.text}" outlet ${o} (${spec.name}, ${spec.type}): into "${dst!.text}" inlet ${cable.dstInlet}: ${problem}`);
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
        }
      }

      boxes.delete(boxId);
      expanded++;
    }

    if (expanded === 0) break;
  }

  const left = [...boxes.values()].filter((b) => absOf(b.text, loaded));
  if (left.length > 0) errors.push(`abstractions nested deeper than ${MAX_DEPTH} levels ("${left[0].text}")`);
  return errors;
}

export interface ApplyResult {
  errors: string[];          // reject the apply if non-empty
  boxes: Map<number, Box>;   // expanded, with `side` stamped
  cables: Map<number, Cable>;
  borderY: number;
  abstractions: Set<string>; // every abstraction the patch uses, nested ones too
  instances: Map<number, InstanceMap>; // instance id → its local→global id map
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

// Args a box type can't run with: a `group` count or weights (groupArgs).
function findBadArgs(boxes: Map<number, Box>): string[] {
  const bad = new Set<string>();
  for (const [, box] of boxes) {
    if (boxTypeName(box.text) !== "group") continue;
    const { error } = groupArgs(box.text);
    if (error) bad.add(error);
  }
  return [...bad];
}

// A box not where its side allows: the problem, or null. No part of any box
// but a router crosses the line; a box bound to `binding` ("ctrl" or
// "synth": a built-in or an abstraction instance) lies wholly on that side; a
// free box ("free") may lie wholly on either. `h` is the box's true height (a
// faced instance is taller than a unit).
function offSideProblem(box: Box, borderY: number, binding: string, h: number): string | null {
  if (binding === "border") return null;
  const whole = wholeSide(box, borderY, h);
  if (binding === "free") return whole === null ? `"${box.text}" crosses the border; only routers may` : null;
  if (whole === binding) return null;
  const where = whole === null ? "overhangs the border" : `is placed on the ${binding === "ctrl" ? "synth" : "ctrl"} side`;
  return `"${box.text}" is bound to the ${binding} side but ${where}`;
}

// Named buffers, on the expanded graph with sides stamped (names are per
// side: each side's AudioContext has its own). A buffer~ needs good args and,
// for a file, one that exists in public/media/; a name is defined once per
// side; a play~ names a buffer~ on its own side.
const MEDIA_DIR = "./public/media";

function findBufferProblems(boxes: Map<number, Box>): string[] {
  const problems = new Set<string>();
  const defined = new Map<string, string>(); // "side name" → box text
  for (const [, box] of boxes) {
    if (boxTypeName(box.text) !== "buffer~") continue;
    const b = bufferArgs(box.text);
    if (b.error) { problems.add(b.error); continue; }
    const key = `${box.side} ${b.name}`;
    if (defined.has(key)) problems.add(`buffer~ "${b.name}" is defined twice on the ${box.side} side ("${defined.get(key)}", "${box.text}")`);
    defined.set(key, box.text);
    if (b.file !== undefined) {
      try { Deno.statSync(`${MEDIA_DIR}/${b.file}`); }
      catch { problems.add(`"${box.text}": no file public/media/${b.file}`); }
    }
  }
  for (const [, box] of boxes) {
    if (boxTypeName(box.text) !== "play~") continue;
    const name = box.text.split(/\s+/)[1];
    if (!name) problems.add(`"${box.text}": play~ needs a buffer name`);
    else if (!defined.has(`${box.side} ${name}`)) problems.add(`"${box.text}": no buffer~ ${name} on the ${box.side} side`);
  }
  return [...problems];
}

// Rejections that need the expanded graph and stamped sides. Audio never
// crosses the border, and routers carry events and values only: events and
// values cross the border through a router, never on a bare cable. A bound box
// must sit wholly on its own side, and no box but a router crosses the line. The editor refuses these and auto-routes the rest;
// this catches patch files edited by hand and anything else that bypasses it.
// Port types on every cable of the expanded graph, by the editor's rule, so a
// cable the editor refuses is refused here too (hand-edited files).
function findTypeProblems(boxes: Map<number, Box>, cables: Map<number, Cable>): string[] {
  const problems = new Set<string>();
  for (const [, c] of cables) {
    const src = boxes.get(c.srcBox), dst = boxes.get(c.dstBox);
    if (!src || !dst) continue;
    const problem = cableTypeProblem(getOutletDef(src.text, c.srcOutlet)?.type, dst.text, getInletDef(dst.text, c.dstInlet));
    if (problem) problems.add(`cable "${src.text}" outlet ${c.srcOutlet} → "${dst.text}" inlet ${c.dstInlet}: ${problem}`);
  }
  return [...problems];
}

function findSideViolations(boxes: Map<number, Box>, cables: Map<number, Cable>, borderY: number): string[] {
  const problems = new Set<string>();
  for (const [, box] of boxes) {
    // Expanded boxes are built-ins, so gpi-types' own binding and height
    // apply (contents of an instance sit at its y, which passed above).
    if (isOffSide(box, borderY)) problems.add(offSideProblem(box, borderY, boxBinding(box.text), boxHeight(box))!);
  }
  for (const [, c] of cables) {
    const src = boxes.get(c.srcBox), dst = boxes.get(c.dstBox);
    if (!src || !dst) continue;
    const viaRouter = src.side === "border" || dst.side === "border";
    // A router's outlets feed phones (deploy.ts entries); on the server it is a
    // sink, so a ctrl box or router cabled from one would never hear from it.
    // Its inlets are fed by the server's ctrl graph, which holds no synth box.
    if (src.side === "border" && dst.side === "border") {
      problems.add(`cable "${src.text}" to "${dst.text}": a router's outlets feed the synth side only, not another router`);
      continue;
    }
    if (src.side === "border" && dst.side === "ctrl") {
      problems.add(`cable "${src.text}" to "${dst.text}": a router's outlets feed the synth side only`);
      continue;
    }
    if (src.side === "synth" && dst.side === "border") {
      problems.add(`cable "${src.text}" to "${dst.text}": a router's inlets take the ctrl side only`);
      continue;
    }
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
// Order: the abstractions it uses (contents against headers), instances on
// their declared sides, expand (boundaries), unknown types, stamp sides,
// validate. Unknown types are checked on the expanded graph, so a typo inside
// an abstraction is caught too.
// deno-lint-ignore no-explicit-any
export function checkApply(msg: any, loaded: Map<string, AbstractionDef>, currentBorderY: number): ApplyResult {
  const borderY: number = msg.borderY ?? currentBorderY;
  const boxes = new Map<number, Box>();
  const cables = new Map<number, Cable>();
  // deno-lint-ignore no-explicit-any
  for (const [id, box] of msg.boxes as [number, any][]) {
    const p = portCounts(box.text, loaded);
    const copy: Box = { ...box, inlets: p.inlets, outlets: p.outlets };
    // snap routers to border
    if (boxBinding(copy.text) === "border") copy.y = routerY(borderY);
    boxes.set(id, copy);
  }
  // deno-lint-ignore no-explicit-any
  for (const [id, cable] of msg.cables as [number, any][]) cables.set(id, cable);

  const used = usedAbstractions([...boxes.values()].map((b) => b.text), loaded);
  const instances = new Map<number, InstanceMap>();
  const result = (errors: string[]): ApplyResult => ({ errors, boxes, cables, borderY, abstractions: used, instances });

  // Files can be edited by hand, so the abstractions are checked again here.
  const errors: string[] = [];
  for (const name of [...used].sort()) errors.push(...checkAbstraction(loaded.get(name)!, loaded));
  if (errors.length > 0) return result(errors);

  // `$n` means an abstraction's arg; in the patch itself there is none to fill in.
  for (const [, box] of boxes) {
    if (/\$\d/.test(box.text ?? "")) errors.push(`"${box.text}": $n is an abstraction's arg; the patch has none`);
  }
  if (errors.length > 0) return result(errors);

  // Every box of the patch as authored, at its true height (a faced instance
  // from `loaded`): none but a router crosses the line, and a bound one (an
  // instance on its declared side) lies wholly on its side. An instance's
  // contents take their side from it.
  const lookup = (n: string) => loaded.get(n) ?? null;
  for (const [, box] of boxes) {
    const problem = offSideProblem(box, borderY, bindingOf(box.text, loaded), boxHeight(box, lookup));
    if (problem) errors.push(problem);
  }
  if (errors.length > 0) return result(errors);

  errors.push(...expandAbstractions(boxes, cables, msg.nextId || 1, loaded, instances));
  errors.push(...findUnknownBoxTypes(boxes, loaded).map((t) => `unknown box type "${t}"`), ...findBadArgs(boxes));
  if (errors.length > 0) return result(errors);
  for (const [, box] of boxes) box.side = sideOf(box, borderY);
  errors.push(...findTypeProblems(boxes, cables), ...findSideViolations(boxes, cables, borderY), ...findBufferProblems(boxes));
  return result(errors);
}

// Validate, and only if clean, replace the running patch. A rejected apply
// leaves it untouched. Evaluation and deploy are the caller's job.
// deno-lint-ignore no-explicit-any
export function applyPatch(msg: any, loaded: Map<string, AbstractionDef>): ApplyResult {
  const result = checkApply(msg, loaded, getBorderY());
  if (result.errors.length > 0) return result;
  clearPatchState();
  for (const [id, box] of result.boxes) liveBoxes.set(id, box);
  for (const [id, cable] of result.cables) liveCables.set(id, cable);
  setPatchNextId(msg.nextId || 1);
  setBorderY(result.borderY);
  // A copy: the caller's message must not change what a reconnecting ctrl sees.
  setAuthoredPatch(structuredClone({
    boxes: msg.boxes, cables: msg.cables, nextId: msg.nextId || 1, borderY: result.borderY,
    instances: Object.fromEntries(result.instances),
  }));
  return result;
}
