/**
 * Encapsulate (Cmd+Shift+E; notes/abstractions.md, Editing): the selection
 * becomes a new abstraction and one instance of it. Drives the editor's
 * encapsulateRefusal / encapsulation / applyEncapsulation headless, and runs
 * each produced file through the server's save check (checkSave) and the
 * resulting patch through applyPatch. Nothing is written to disk.
 *
 * Usage: deno run --allow-read tests/encapsulate.ts
 */

import { clearPatchState, setBorderY } from "../patch-state.ts";
import { applyPatch, checkSave, createConflict, parseAbstraction, type AbstractionDef } from "../apply-check.ts";
import { BOX_HEIGHT, SNAP, getBoxPorts, textBoxWidth } from "../public/gpi-types.js";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// patch-editor.js reads a theme at import; give it just enough of a browser.
// deno-lint-ignore no-explicit-any
const g = globalThis as any;
g.matchMedia ??= () => ({ matches: false, addEventListener() {} });
g.document ??= { documentElement: { dataset: {} } };
const { PatchEditor, abstractionTypes } = await import("../public/patch-editor.js");

// The library on disk, as the server (loaded) and the editor (abstractionTypes) hold it.
const loaded = new Map<string, AbstractionDef>();
for await (const lib of Deno.readDir("libs")) {
  if (!lib.isDirectory) continue;
  for await (const f of Deno.readDir(`libs/${lib.name}/abstractions`)) {
    if (!f.name.endsWith(".json")) continue;
    const name = `${lib.name}/${f.name.slice(0, -5)}`;
    const { def, errors } = parseAbstraction(name, JSON.parse(await Deno.readTextFile(`libs/${lib.name}/abstractions/${f.name}`)));
    if (!def) throw new Error(`${name}: ${errors.join("; ")}`);
    loaded.set(name, def);
  }
}
// Register a header with the editor, as loadAbstractions does after a save.
// deno-lint-ignore no-explicit-any
function register(d: any) {
  abstractionTypes.set(d.name, { ...d, face: d.face ?? null, boxes: d.boxes instanceof Map ? d.boxes : new Map(d.boxes) });
}
for (const d of loaded.values()) register(d);

// deno-lint-ignore no-explicit-any
function mk(data: any) {
  const ed = Object.create(PatchEditor.prototype);
  Object.assign(ed, {
    boxes: new Map(), cables: new Map(), selection: new Set(), cableSelection: new Set(), boxValues: new Map(),
    undoStack: [], maxUndo: 50, borderY: 400, showBorder: true, editingBoxId: null, input: null, nextId: 1,
    zoom: 1, panX: 0, panY: 0, instances: new Map(), dirty: false,
    onDirty() {}, zoomToFit() {}, render() {},
  });
  ed.load(structuredClone(data));
  return ed;
}
const b = (x: number, y: number, text: string) => ({ x, y, text, ...getBoxPorts(text) });
const c = (srcBox: number, srcOutlet: number, dstBox: number, dstInlet: number) => ({ srcBox, srcOutlet, dstBox, dstInlet });

// Encapsulate `ids` of `ed` as `name`: plan, save check, register, apply.
// deno-lint-ignore no-explicit-any
function encapsulate(ed: any, ids: number[], name: string) {
  ed.selection = new Set(ids);
  const r = ed.encapsulation(name);
  if (r.error) return { error: r.error as string };
  // The file goes over the wire as JSON; the server parses it as it would.
  const wire = JSON.parse(JSON.stringify(r.file));
  const { def, errors } = parseAbstraction(name, wire);
  const saveErrors = def ? checkSave(def, loaded) : errors;
  if (def && saveErrors.length === 0) { loaded.set(name, def); register(wire); }
  const undo = ed.undoStack.length;
  const applied = saveErrors.length === 0 && ed.applyEncapsulation(r.plan);
  return { file: wire, plan: r.plan, saveErrors, applied, undoSteps: ed.undoStack.length - undo };
}
// deno-lint-ignore no-explicit-any
const instanceId = (ed: any, name: string) => [...ed.boxes].find(([, x]) => x.text === name)?.[0];
// deno-lint-ignore no-explicit-any
const cablesOf = (ed: any, id: number) => [...ed.cables].filter(([, x]) => x.srcBox === id || x.dstBox === id);
// Apply errors for a patch, against the library as it now stands.
// deno-lint-ignore no-explicit-any
function applyErrors(ed: any): string[] {
  clearPatchState();
  setBorderY(ed.borderY);
  const m = JSON.parse(ed.serialize());
  return applyPatch(m, loaded).errors;
}

const granular = JSON.parse(await Deno.readTextFile("patches/granular_example.json"));

console.log("synth side: one grain voice of granular_example");
{
  const ed = mk(granular);
  const before = ed.serialize();
  const baseline = applyErrors(ed);
  // phasor~ 0.1, samphold~, *~, +~, play~ src, hann~, *~ (the left voice)
  const r = encapsulate(ed, [18, 20, 21, 24, 26, 27, 30], "test/grain-voice");
  if ("error" in r) throw new Error(r.error);
  const f = r.file;
  check("side synth, no args, no face, empty description", f.side === "synth" && f.args.length === 0 && !("face" in f) && f.description === "", JSON.stringify({ side: f.side, args: f.args }));
  check("passes the server's save check", r.saveErrors.length === 0, JSON.stringify(r.saveErrors));
  // Inlets by the inside port's x, ties by box y: phasor~ in 0 (y 480),
  // samphold~ in 0 (y 520), both flush left at x 20, then *~ in 1.
  const ins = f.inlets.map((p: { name: string; type: string }) => `${p.name}:${p.type}`);
  check("three inlets", f.inlets.length === 3, JSON.stringify(ins));
  const inBox = (i: number) => {
    const port = f.boxes.find(([, x]: [number, { text: string }]) => x.text === `inlet ${i}`)[0];
    const cab = f.cables.find(([, x]: [number, { srcBox: number }]) => x.srcBox === port)[1];
    return { box: f.boxes.find(([id]: [number]) => id === cab.dstBox)[1].text, inlet: cab.dstInlet, port: f.boxes.find(([id]: [number]) => id === port)[1] };
  };
  const order = [0, 1, 2].map((i) => `${inBox(i).box}:${inBox(i).inlet}`);
  check("inlets ordered by x, then y", JSON.stringify(order) === JSON.stringify(["phasor~ 0.1:0", "samphold~:0", "*~:1"]), JSON.stringify(order));
  const ph = (await import("../public/gpi-types.js")).getInletDef("phasor~ 0.1", 0);
  check("inlet name and type from the inside port", f.inlets[0].name === ph.name && f.inlets[0].type === ph.type && f.inlets[1].type === "audio", JSON.stringify(ins));
  check("inlet names unique", new Set(f.inlets.map((p: { name: string }) => p.name)).size === 3, JSON.stringify(ins));
  check("one audio outlet", f.outlets.length === 1 && f.outlets[0].type === "audio", JSON.stringify(f.outlets));
  check("inlet boxes on a row above the contents, outlet below", [0, 1, 2].every((i) => inBox(i).port.y === 20) &&
    f.boxes.every(([, x]: [number, { text: string; y: number }]) => /^(inlet|outlet) /.test(x.text) || x.y >= 60) &&
    f.boxes.find(([, x]: [number, { text: string }]) => x.text === "outlet 0")[1].y > 60, "");
  check("inlet boxes don't overlap", [0, 1].every((i) => inBox(i + 1).port.x >= inBox(i).port.x + textBoxWidth(`inlet ${i}`, 1)), JSON.stringify([0, 1, 2].map((i) => inBox(i).port.x)));
  check("everything inside on the half-unit grid", f.boxes.every(([, x]: [number, { x: number; y: number }]) => x.x % SNAP === 0 && x.y % SNAP === 0));
  // Relative layout kept: phasor~ 18 (20,480) and *~ 30 (20,640) are 160 apart.
  const at = (t: string) => f.boxes.filter(([, x]: [number, { text: string }]) => x.text === t).map(([, x]: [number, { x: number; y: number }]) => x);
  check("relative layout kept", at("phasor~ 0.1")[0].y + 160 === at("*~")[at("*~").length - 1].y && at("phasor~ 0.1")[0].x === 20, JSON.stringify(at("*~")));
  check("applied", r.applied === true);
  check("one undo step", r.undoSteps === 1, String(r.undoSteps));
  const id = instanceId(ed, "test/grain-voice");
  const inst = ed.boxes.get(id);
  check("instance at the selection's top-left, synth side", inst && inst.x === 20 && inst.y === 480 && inst.inlets === 3 && inst.outlets === 1, JSON.stringify(inst));
  check("selection boxes gone", [18, 20, 21, 24, 26, 27, 30].every((i) => !ed.boxes.has(i)));
  const cs = Object.fromEntries(cablesOf(ed, id));
  check("outside cables reconnected, ids kept", JSON.stringify(cs) === JSON.stringify({
    38: c(8, 1, id, 0), 48: c(13, 0, id, 1), 50: c(16, 0, id, 2), 57: c(id, 0, 32, 0),
  }), JSON.stringify(cs));
  check("instance selected", ed.selection.size === 1 && ed.selection.has(id));
  const after = applyErrors(ed);
  check("the patch applies as before", JSON.stringify(after) === JSON.stringify(baseline), JSON.stringify({ after, baseline }));
  ed.undo();
  check("undo restores the patch", ed.serialize() === before);
}

console.log("fan-out across the boundary: one outlet, every cable on it");
{
  const ed = mk(granular);
  // sig~, noise~, sig~, *~, +~: the position-jitter sum
  const r = encapsulate(ed, [9, 10, 11, 12, 13], "test/jitter");
  if ("error" in r) throw new Error(r.error);
  check("saved", r.saveErrors.length === 0, JSON.stringify(r.saveErrors));
  check("two inlets, by x (sig~ left, sig~ right)", r.file.inlets.length === 2 && r.plan.inbound.map((x: { id: number; inlet: number }) => `${x.id}>${x.inlet}`).join() === "36>0,37>1", JSON.stringify(r.plan.inbound));
  check("one outlet for +~ feeding two samphold~s", r.file.outlets.length === 1 && r.plan.outbound.length === 2 && r.plan.outbound.every((x: { outlet: number }) => x.outlet === 0), JSON.stringify(r.plan.outbound));
  const id = instanceId(ed, "test/jitter");
  check("both samphold~s fed from the instance", [20, 22].every((d) => [...ed.cables.values()].some((x) => x.srcBox === id && x.dstBox === d && x.dstInlet === 0)));
  check("applies", applyErrors(ed).length === applyErrors(mk(granular)).length);
}

console.log("fan-in across the boundary");
{
  // Two outside sources into one inside port: one inlet, both cables on it.
  const ed = mk(granular);
  const r = encapsulate(ed, [32], "test/out");
  if ("error" in r) throw new Error(r.error);
  check("one inlet, audio, two cables", r.saveErrors.length === 0 && r.file.inlets.length === 1 && r.file.inlets[0].type === "audio" && r.plan.inbound.length === 2 && r.plan.inbound.every((x: { inlet: number }) => x.inlet === 0), JSON.stringify([r.file.inlets, r.plan.inbound, r.saveErrors]));
  check("no outlets", r.file.outlets.length === 0);
  // One outside source into two inside ports: two inlets, names kept unique.
  const ed2 = mk(granular);
  const r2 = encapsulate(ed2, [18, 19], "test/two-phasors");
  if ("error" in r2) throw new Error(r2.error);
  const names = r2.file.inlets.map((p: { name: string }) => p.name);
  check("two inlets from one source, unique names", r2.saveErrors.length === 0 && names.length === 2 && names[0] !== names[1], JSON.stringify([names, r2.saveErrors]));
  check("phasor~ 0.1 then phasor~ 0.1 0.5 (by x)", r2.plan.inbound.map((x: { id: number; inlet: number }) => `${x.id}>${x.inlet}`).join() === "38>0,39>1", JSON.stringify(r2.plan.inbound));
  check("outputs fan out from two outlets", r2.file.outlets.length === 2 && r2.plan.outbound.length === 6, JSON.stringify(r2.plan.outbound));
}

console.log("ctrl side, an abstraction inside the selection");
{
  const patch = {
    boxes: [
      [1, b(20, 100, "knob 0.5 0 1")],
      [2, b(20, 160, "common/double")],
      [3, b(20, 200, "+ 1")],
      [4, b(20, routerYOf(400), "all 1")],
      [5, b(20, 440, "sig~")],
      [6, b(20, 480, "dac~")],
    ],
    cables: [[7, c(1, 0, 2, 0)], [8, c(2, 0, 3, 0)], [9, c(3, 0, 4, 0)], [10, c(4, 0, 5, 0)], [11, c(5, 0, 6, 0)]],
    nextId: 12, borderY: 400,
  };
  const ed = mk(patch);
  const r = encapsulate(ed, [2, 3], "test/double-plus");
  if ("error" in r) throw new Error(r.error);
  check("side ctrl", r.file.side === "ctrl");
  check("inlet from the nested header (in, number)", r.file.inlets.length === 1 && r.file.inlets[0].name === "in" && r.file.inlets[0].type === "number", JSON.stringify(r.file.inlets));
  check("outlet from + 1", r.file.outlets.length === 1 && r.file.outlets[0].type === "number", JSON.stringify(r.file.outlets));
  check("passes the save check (nesting)", r.saveErrors.length === 0, JSON.stringify(r.saveErrors));
  const id = instanceId(ed, "test/double-plus");
  check("knob → instance → router", ed.cables.get(7)?.dstBox === id && ed.cables.get(9)?.srcBox === id && ed.cables.get(9)?.dstBox === 4);
  check("instance wholly ctrl", ed.boxes.get(id).y + BOX_HEIGHT <= 400);
  check("patch applies", applyErrors(ed).length === 0, JSON.stringify(applyErrors(ed)));
}

console.log("audio into an AudioParam from outside: the inlet is audio");
{
  const patch = {
    boxes: [[1, b(20, 420, "noise~")], [2, b(20, 480, "osc~ 440")], [3, b(20, 520, "dac~")]],
    cables: [[4, c(1, 0, 2, 0)], [5, c(2, 0, 3, 0)]],
    nextId: 6, borderY: 400,
  };
  const ed = mk(patch);
  const inl = (await import("../public/gpi-types.js")).getInletDef("osc~ 440", 0);
  const r = encapsulate(ed, [2], "test/osc");
  if ("error" in r) throw new Error(r.error);
  check(`osc~ inlet 0 (${inl?.type}) becomes an audio inlet`, r.file.inlets[0]?.type === "audio" && r.saveErrors.length === 0, JSON.stringify([r.file.inlets, r.saveErrors]));
  check("patch applies", applyErrors(ed).length === 0, JSON.stringify(applyErrors(ed)));
}

console.log("refusals change nothing");
{
  const patch = {
    boxes: [
      [1, b(20, 100, "knob 0.5 0 1")], [2, b(20, 200, "+ 1")], [3, b(20, routerYOf(400), "all 1")],
      [4, b(20, 440, "sig~")], [5, b(200, 100, "")], [6, b(20, 500, "outlet 0")],
    ],
    cables: [[7, c(1, 0, 2, 0)], [8, c(2, 0, 3, 0)], [9, c(3, 0, 4, 0)]],
    nextId: 10, borderY: 400,
  };
  const cases: [string, number[], RegExp][] = [
    ["empty selection", [], /nothing selected/],
    ["a router", [2, 3], /"all 1" is a router/],
    ["boxes from both zones", [2, 4], /both sides/],
    ["an empty box", [1, 5], /empty box/],
    ["an outlet box", [6], /only works inside an abstraction/],
  ];
  for (const [what, ids, re] of cases) {
    const ed = mk(patch);
    const before = ed.serialize();
    ed.selection = new Set(ids);
    const refusal = ed.encapsulateRefusal();
    const r = ed.encapsulation("test/nope");
    check(`${what}: refused`, re.test(refusal ?? "") && r.error === refusal, `${refusal} / ${r.error}`);
    check(`${what}: nothing changed`, ed.serialize() === before && ed.undoStack.length === 0);
  }
  const ed = mk(patch);
  ed.selection = new Set([2]);
  ed.editingBoxId = 2;
  check("the box being typed into: refused", /empty box/.test(ed.encapsulateRefusal() ?? ""));
  // Audio and numbers from outside into one AudioParam.
  const mixed = mk({
    boxes: [[1, b(20, 420, "noise~")], [2, b(200, 420, "const 3")], [3, b(20, 480, "osc~ 440")]],
    cables: [[4, c(1, 0, 3, 0)], [5, c(2, 0, 3, 0)]], nextId: 6, borderY: 400,
  });
  mixed.selection = new Set([3]);
  const m = mixed.encapsulation("test/nope");
  check("audio and numbers into one inlet: refused", /audio and other values/.test(m.error ?? ""), JSON.stringify(m.error));
  // The plan is stale once the patch changes: applying it changes nothing.
  const ed2 = mk(patch);
  ed2.selection = new Set([2]);
  const r = ed2.encapsulation("test/stale");
  ed2.boxes.get(1).x += 10;
  const snap = ed2.serialize();
  check("a stale plan isn't applied", ed2.applyEncapsulation(r.plan) === false && ed2.serialize() === snap && ed2.undoStack.length === 0);
}

console.log("stale selection ids: nothing selected");
{
  const ed = mk(granular);
  ed.selection = new Set([999, 998]);
  const r = ed.encapsulation("test/nope");
  check("refused, no throw", ed.encapsulateRefusal() === "nothing selected" && r.error === "nothing selected", JSON.stringify(r));
}

console.log("a wider instance is nudged clear of its neighbours, in the same undo step");
{
  // `+ 1` is two units wide; the instance's long name is wider and would
  // run into `print` just right of it.
  const patch = {
    boxes: [[1, b(20, 100, "const 1")], [2, b(20, 160, "+ 1")], [3, b(80, 160, "print")], [4, b(20, 220, "print")]],
    cables: [[5, c(1, 0, 2, 0)], [6, c(2, 0, 4, 0)]], nextId: 7, borderY: 400,
  };
  const ed = mk(patch);
  const before = ed.serialize();
  const r = encapsulate(ed, [2], "test/a-rather-long-name");
  if ("error" in r) throw new Error(r.error);
  const id = instanceId(ed, "test/a-rather-long-name");
  const inst = ed.boxes.get(id), pr = ed.boxes.get(3);
  const gx = Math.max(pr.x - (inst.x + ed.boxWidth(inst, id)), inst.x - (pr.x + ed.boxWidth(pr, 3)));
  const gy = Math.max(pr.y - (inst.y + BOX_HEIGHT), inst.y - (pr.y + BOX_HEIGHT));
  check("instance clear of print", gx >= SNAP || gy >= SNAP, JSON.stringify({ inst, pr }));
  check("neighbours didn't move", pr.x === 80 && pr.y === 160 && ed.boxes.get(4).y === 220);
  check("still one undo step", r.undoSteps === 1, String(r.undoSteps));
  ed.undo();
  check("undo restores the patch", ed.serialize() === before);
}

console.log("create-only save (PUT ?create=1)");
{
  check("a free name passes", createConflict("test/fresh-name", loaded, false) === null);
  check("a loaded name: taken", /already exists/.test(createConflict("common/double", loaded, false) ?? ""));
  check("a file on disk not in the registry: taken", /already exists/.test(createConflict("test/fresh-name", loaded, true) ?? ""));
}

console.log("the server's save check rejects a bad encapsulation");
{
  // $1 in a box: the new abstraction declares no args.
  const ed = mk({ boxes: [[1, b(20, 100, "+ $1")], [2, b(20, 160, "print")]], cables: [[3, c(1, 0, 2, 0)]], nextId: 4, borderY: 400 });
  const before = ed.serialize();
  const r = encapsulate(ed, [1], "test/dollar");
  if ("error" in r) throw new Error(r.error);
  check("rejected, named", r.saveErrors.some((e: string) => /uses \$1/.test(e)), JSON.stringify(r.saveErrors));
  check("patch unchanged", ed.serialize() === before && r.applied === false);
}

function routerYOf(border: number) { return border - BOX_HEIGHT / 2; }

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) Deno.exit(1);
