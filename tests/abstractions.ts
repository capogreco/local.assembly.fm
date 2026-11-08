/**
 * Abstraction header, save and apply checks (notes/abstractions.md): the
 * header (parseAbstraction), the contents against it (checkAbstraction), and
 * each instance's boundary at apply (applyPatch). Also the editor's port and
 * side lookups for abstractions (gpi-types useAbstractions).
 *
 * Usage: deno run --allow-read tests/abstractions.ts
 */

import { boxes, cables, clearPatchState, ctrlState, getBorderY, getPatchNextId, setBorderY } from "../patch-state.ts";
import { applyPatch, checkAbstraction, isAbstractionName, parseAbstraction, type AbstractionDef } from "../apply-check.ts";
import { boxSize, getBoxPorts, getInletDef, getOutletDef, sideOf, useAbstractions } from "../public/gpi-types.js";

const BORDER = 400;
const CTRL_Y = 100, SYNTH_Y = 600;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// deno-lint-ignore no-explicit-any
type B = [number, any];
const box = (id: number, text: string, y: number): B => [id, { x: 0, y, text, inlets: 0, outlets: 0 }];
const cable = (id: number, srcBox: number, srcOutlet: number, dstBox: number, dstInlet: number): [number, unknown] =>
  [id, { srcBox, srcOutlet, dstBox, dstInlet }];
const msg = (b: B[], c: [number, unknown][] = []) => ({ boxes: b, cables: c, nextId: 1000, borderY: BORDER });
const port = (name: string, type: string) => ({ name, type, description: "" });

// deno-lint-ignore no-explicit-any
function raw(over: Record<string, any> = {}): Record<string, any> {
  return {
    name: "t/x", side: "ctrl", description: "test",
    args: [], inlets: [port("in", "number")], outlets: [port("out", "number")],
    boxes: [[1, { x: 0, y: 0, text: "inlet 0" }], [2, { x: 0, y: 0, text: "* 2" }], [3, { x: 0, y: 0, text: "outlet 0" }]],
    cables: [[4, { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }], [5, { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 }]],
    nextId: 6,
    ...over,
  };
}
function def(over: Record<string, unknown> = {}): AbstractionDef {
  const { def, errors } = parseAbstraction((over.name as string) ?? "t/x", raw(over));
  if (!def) throw new Error(errors.join("; "));
  return def;
}
const errs = (over: Record<string, unknown>, loaded = new Map<string, AbstractionDef>()) => checkAbstraction(def(over), loaded);

console.log("names");
{
  for (const n of ["common/double", "thomas/grain-voice~", "a_b/c-d"]) check(`"${n}" accepted`, isAbstractionName(n));
  for (const n of ["double", "a/b/c", "../x", "a/.x", "a b/c", "/x", "x/", "-a/b", "a/~b"]) check(`"${n}" refused`, !isAbstractionName(n));
}

console.log("header");
{
  check("well-formed accepted", parseAbstraction("t/x", raw()).errors.length === 0);
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ["name must match the file", { name: "t/y" }, /"name" must be "t\/x"/],
    ["no side", { side: undefined }, /"side" must be "ctrl" or "synth"/],
    ["no free abstractions", { side: "free" }, /"side" must be "ctrl" or "synth"/],
    ["description required", { description: undefined }, /"description" must be a string/],
    ["unknown port type", { inlets: [port("in", "float")] }, /inlets\[0\] type must be one of/],
    ["arg type symbol|number", { args: [port("a", "audio")] }, /args\[0\] type must be one of symbol, number/],
    ["port needs a name", { outlets: [port("", "number")] }, /outlets\[0\] needs a name/],
    ["port names unique", { inlets: [port("a", "number"), port("a", "number")] }, /name "a" is used twice/],
    ["unknown field", { colour: "red" }, /unknown field "colour"/],
    ["face: not an object", { face: [] }, /"face" must be an object/],
    ["face: unknown field", { face: { x: 0, y: 0, w: 2, h: 2, hideName: false, z: 1 } }, /face has unknown field "z"/],
    ["face: whole grid units", { face: { x: 0.5, y: 0, w: 2, h: 2, hideName: false } }, /face\.x must be a whole number of grid units/],
    ["face: at least 2 wide", { face: { x: 0, y: 0, w: 1, h: 2, hideName: false } }, /face\.w must be a whole number of grid units, at least 2/],
    ["face: at least 2 high", { face: { x: 0, y: 0, w: 2, h: 1.5, hideName: false } }, /face\.h must be .* at least 2/],
    ["face: hideName required", { face: { x: 0, y: 0, w: 2, h: 2 } }, /face\.hideName must be true or false/],
    ["boxes must be a list", { boxes: {} }, /"boxes" must be a list/],
  ];
  for (const [what, over, re] of bad) {
    const { def, errors } = parseAbstraction("t/x", raw(over));
    check(what, def === null && errors.some((e) => re.test(e)), JSON.stringify(errors));
  }
}

console.log("save: inlet/outlet boxes against the header");
{
  check("matching accepted", errs({}).length === 0, JSON.stringify(errs({})));
  const gap = errs({ inlets: [port("a", "number"), port("b", "number")] });
  check("header inlet with no box", gap.some((e) => /inlet 1 \(b, number\) has no "inlet 1" box/.test(e)), JSON.stringify(gap));
  const extra = errs({ outlets: [] });
  check("box with no header entry", extra.some((e) => /"outlet 0" has no header entry/.test(e)), JSON.stringify(extra));
  const bare = errs({ boxes: [[1, { text: "inlet 0" }], [2, { text: "* 2" }], [3, { text: "outlet" }]] });
  check("bare outlet needs its index", bare.some((e) => /"outlet" needs exactly one index/.test(e)), JSON.stringify(bare));
  const dup = errs({ boxes: [[1, { text: "inlet 0" }], [2, { text: "* 2" }], [3, { text: "outlet 0" }], [9, { text: "inlet 0" }]] });
  check("duplicate inlet box", dup.some((e) => /inlet 0 \(in, number\) has 2 "inlet 0" boxes/.test(e)), JSON.stringify(dup));
}

console.log("save: port types against the wiring");
{
  const audioIn = (dst: string, inlets = [port("sig", "audio")]) => errs({
    inlets, outlets: [],
    boxes: [[1, { text: "inlet 0" }], [2, { text: dst }]],
    cables: [[3, { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }]],
  });
  check("audio inlet into an audio inlet", audioIn("dac~").length === 0, JSON.stringify(audioIn("dac~")));
  check("audio inlet into an AudioParam (osc~ frequency)", audioIn("osc~").length === 0, JSON.stringify(audioIn("osc~")));
  check("audio inlet into a value box rejected", audioIn("* 2").some((e) => /inlet 0 \(sig, audio\) → "\* 2" inlet 0: audio into a number inlet/.test(e)), JSON.stringify(audioIn("* 2")));
  check("number inlet into an audio inlet rejected", audioIn("dac~", [port("v", "number")]).some((e) => /number into an audio inlet/.test(e)), JSON.stringify(audioIn("dac~", [port("v", "number")])));
  const outFrom = (src: string, type: string) => errs({
    inlets: [], outlets: [port("out", type)],
    boxes: [[1, { text: src }], [2, { text: "outlet 0" }]],
    cables: [[3, { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }]],
  });
  check("audio outlet fed by audio", outFrom("osc~ 440", "audio").length === 0);
  check("number outlet fed by audio rejected", outFrom("osc~ 440", "number").some((e) => /outlet 0 \(out, number\): fed by audio from "osc~ 440"/.test(e)), JSON.stringify(outFrom("osc~ 440", "number")));
  check("audio outlet fed by number rejected", outFrom("+ 1", "audio").some((e) => /outlet 0 \(out, audio\): fed by number/.test(e)), JSON.stringify(outFrom("+ 1", "audio")));
}

console.log("save: $n needs a declared arg");
{
  const one = [{ name: "k", type: "number", description: "" }];
  check("$1 with one arg accepted", errs({ args: one, boxes: [[1, { text: "inlet 0" }], [2, { text: "* $1" }], [3, { text: "outlet 0" }]] }).length === 0);
  const e = errs({ args: one, boxes: [[1, { text: "inlet 0" }], [2, { text: "* $2" }], [3, { text: "outlet 0" }]] });
  check("$2 with one arg rejected", e.some((m) => /"\* \$2" uses \$2, but 1 arg\(s\) are declared/.test(m)), JSON.stringify(e));
  check("$0 needs no arg", errs({ boxes: [[1, { text: "inlet 0" }], [2, { text: "* $0" }], [3, { text: "outlet 0" }]] }).length === 0);
}

console.log("save: the face");
{
  const face = { x: 0, y: 0, w: 10, h: 3, hideName: false };
  // "knob 0.5 0 1" is 160px (8 units) wide, room for its value label inside:
  // inside at (20, 20), across the right edge at (60, 20).
  const with_ = (extra: B[], f: unknown = face) => errs({
    face: f,
    boxes: [[1, { x: 0, y: 200, text: "inlet 0" }], [2, { x: 0, y: 220, text: "* 2" }], [3, { x: 0, y: 260, text: "outlet 0" }], ...extra],
  });
  const ok = with_([[10, { x: 20, y: 20, text: "knob 0.5 0 1" }]]);
  check("a knob wholly inside accepted", ok.length === 0, JSON.stringify(ok));
  check("parsed into the def", def({ face }).face?.w === 10);
  check("a knob's width leaves room for its widest label", boxSize("knob 0.5 0 1").w === 160 && boxSize("knob 220 50 1000 2").w === 220, JSON.stringify([boxSize("knob 0.5 0 1"), boxSize("knob 220 50 1000 2")]));
  check("no face is null", def().face === null);
  const across = with_([[10, { x: 60, y: 20, text: "knob 0.5 0 1" }]]);
  check("a GUI box across the edge rejected, named", across.some((e) => /face: "knob 0\.5 0 1" crosses the face's edge/.test(e)), JSON.stringify(across));
  const below = with_([[10, { x: 20, y: 20, text: "knob 0.5 0 1" }], [11, { x: 0, y: 40, text: "toggle" }]]);
  check("bottom edge counts too", below.length === 0, JSON.stringify(below));
  const low = with_([[10, { x: 20, y: 20, text: "knob 0.5 0 1" }], [11, { x: 0, y: 50, text: "toggle" }]]);
  check("a box over the bottom edge rejected", low.some((e) => /"toggle" crosses/.test(e)), JSON.stringify(low));
  const outside = with_([[10, { x: 20, y: 20, text: "knob 0.5 0 1" }], [11, { x: 400, y: 400, text: "knob" }]]);
  check("a GUI box wholly outside is fine (not shown)", outside.length === 0, JSON.stringify(outside));
  const hidden = with_([[10, { x: 20, y: 20, text: "comment hi" }], [11, { x: 100, y: 20, text: "+ 1 2 3 4 5 6 7 8 9 10" }]]);
  check("a non-GUI box across the edge is fine (hidden)", hidden.length === 0, JSON.stringify(hidden));
  const empty = with_([]);
  check("no GUI box inside rejected", empty.some((e) => /face: no GUI box inside/.test(e)), JSON.stringify(empty));
  const label = with_([[10, { x: 0, y: 0, text: "comment hi" }]]);
  check("a comment counts", label.length === 0, JSON.stringify(label));
  // A faced abstraction counts as a GUI box of its parent, at its face's size.
  const inner = def({ name: "t/inner", face: { x: 0, y: 0, w: 3, h: 2, hideName: true },
    boxes: [[1, { x: 0, y: 200, text: "inlet 0" }], [2, { x: 0, y: 0, text: "toggle" }], [3, { x: 0, y: 260, text: "outlet 0" }]],
    cables: [[4, { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }], [5, { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 }]] });
  const lib = new Map([["t/inner", inner]]);
  const outer = (x: number) => errs({ face, outlets: [], inlets: [], boxes: [[1, { x, y: 0, text: "t/inner" }]], cables: [] }, lib);
  check("a faced instance inside counts", outer(100).length === 0, JSON.stringify(outer(100)));
  check("a faced instance across the edge rejected", outer(160).some((e) => /"t\/inner" crosses/.test(e)), JSON.stringify(outer(160)));
}

// --- Apply ---

const audioAbs = def({
  name: "t/gain~", side: "synth", inlets: [port("in", "audio")], outlets: [port("out", "audio")],
  args: [{ name: "gain", type: "number", description: "" }],
  boxes: [[1, { text: "inlet 0" }], [2, { text: "*~ $1" }], [3, { text: "outlet 0" }]],
  cables: [[4, { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }], [5, { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 }]],
});
const nested = def({
  name: "t/outer", side: "synth", inlets: [port("in", "audio")], outlets: [port("out", "audio")],
  args: [{ name: "g", type: "symbol", description: "" }],
  boxes: [[1, { text: "inlet 0" }], [2, { text: "t/gain~ $1" }], [3, { text: "outlet 0" }]],
  cables: [[4, { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }], [5, { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 }]],
});
const loaded = new Map([["t/x", def()], ["t/gain~", audioAbs], ["t/outer", nested]]);
function reset(): void { clearPatchState(); setBorderY(BORDER); }

console.log("apply: a good instance");
{
  reset();
  const r = applyPatch(msg([box(1, "osc~ 440", SYNTH_Y), box(2, "t/gain~ 0.5", SYNTH_Y), box(3, "dac~", SYNTH_Y)],
    [cable(1, 1, 0, 2, 0), cable(2, 2, 0, 3, 0)]), loaded);
  check("accepted", r.errors.length === 0, JSON.stringify(r.errors));
  check("arg filled in", [...boxes.values()].some((b) => b.text === "*~ 0.5"));
  check("wired through", [...cables.values()].length === 2);
}

console.log("apply: instance maps, chained through nesting");
{
  reset();
  const r = applyPatch(msg([box(1, "osc~ 440", SYNTH_Y), box(2, "t/outer 0.5", SYNTH_Y), box(3, "dac~", SYNTH_Y)],
    [cable(1, 1, 0, 2, 0), cable(2, 2, 0, 3, 0)]), loaded);
  check("accepted", r.errors.length === 0, JSON.stringify(r.errors));
  const top = r.instances.get(2);
  check("top-level instance mapped, with its text", top?.text === "t/outer 0.5", JSON.stringify(top));
  const g = top?.ids[2];
  const inner = g === undefined ? undefined : r.instances.get(g);
  check("nested instance mapped under its global id, args filled in", inner?.text === "t/gain~ 0.5", JSON.stringify([...r.instances]));
  const leaf = inner?.ids[2];
  check("the chain ends at the live box", leaf !== undefined && boxes.get(leaf)?.text === "*~ 0.5");
  check("inlet/outlet boxes aren't mapped", top !== undefined && !(1 in top.ids) && !(3 in top.ids));
  // deno-lint-ignore no-explicit-any
  const st = ctrlState() as any;
  check("ctrl state carries the maps", JSON.stringify(st.instances) === JSON.stringify(Object.fromEntries(r.instances)), JSON.stringify(st.instances));
}

console.log("apply: boundary errors");
{
  const cases: [string, ReturnType<typeof msg>, RegExp][] = [
    ["inlet count", msg([box(1, "+ 1", CTRL_Y), box(2, "t/x", CTRL_Y)], [cable(1, 1, 0, 2, 1)]),
      /^"t\/x" inlet 1: no such inlet \(it has 1\)$/],
    ["outlet count", msg([box(1, "t/x", CTRL_Y), box(2, "print", CTRL_Y)], [cable(1, 1, 3, 2, 0)]),
      /^"t\/x" outlet 3: no such outlet \(it has 1\)$/],
    ["number into an audio inlet", msg([box(1, "+ 1", SYNTH_Y), box(2, "t/gain~ 1", SYNTH_Y)], [cable(1, 1, 0, 2, 0)]),
      /^"t\/gain~ 1" inlet 0 \(in, audio\): fed by number from "\+ 1"$/],
    ["audio into a number inlet", msg([box(1, "osc~", CTRL_Y), box(2, "t/x", CTRL_Y)], [cable(1, 1, 0, 2, 0)]),
      /^"t\/x" inlet 0 \(in, number\): fed by audio from "osc~"$/],
    ["audio outlet into a value box", msg([box(1, "t/gain~ 1", SYNTH_Y), box(2, "+ 1", SYNTH_Y)], [cable(1, 1, 0, 2, 0)]),
      /^"t\/gain~ 1" outlet 0 \(out, audio\): into "\+ 1" inlet 0: audio into a number inlet$/],
    ["missing arg", msg([box(1, "t/gain~", SYNTH_Y)]),
      /^"t\/gain~" arg 1 \(gain, number\): missing$/],
    ["arg not a number", msg([box(1, "t/gain~ loud", SYNTH_Y)]),
      /^"t\/gain~ loud" arg 1 \(gain, number\): "loud" is not a number$/],
    ["too many args", msg([box(1, "t/gain~ 1 2", SYNTH_Y)]),
      /^"t\/gain~ 1 2": 2 args given, 1 declared$/],
    ["nested: missing arg", msg([box(1, "t/outer", SYNTH_Y)]),
      /^"t\/outer" arg 1 \(g, symbol\): missing$/],
    ["nested: bad arg reaches the inner instance", msg([box(1, "t/outer loud", SYNTH_Y)]),
      /^"t\/gain~ loud" arg 1 \(gain, number\): "loud" is not a number$/],
  ];
  reset();
  const good = applyPatch(msg([box(1, "key", CTRL_Y), box(2, "t/outer 0.5", SYNTH_Y)]), loaded);
  check("nested instance with its arg accepted", good.errors.length === 0, JSON.stringify(good.errors));
  const before = JSON.stringify({ b: [...boxes], c: [...cables], n: getPatchNextId(), y: getBorderY() });
  for (const [what, m, re] of cases) {
    const r = applyPatch(m, loaded);
    check(`${what}: an error`, r.errors.some((e) => re.test(e)), JSON.stringify(r.errors));
    check(`${what}: running patch untouched`, JSON.stringify({ b: [...boxes], c: [...cables], n: getPatchNextId(), y: getBorderY() }) === before);
  }
}

console.log("apply: a hand-edited abstraction is checked again");
{
  reset();
  const broken = new Map(loaded).set("t/x", { ...def(), outlets: [] });
  const r = applyPatch(msg([box(1, "t/x", CTRL_Y)]), broken);
  check("rejected", r.errors.some((e) => /"outlet 0" has no header entry/.test(e)), JSON.stringify(r.errors));
}

console.log("apply: a faced instance lies wholly on its side");
{
  const faced = def({ name: "t/faced", face: { x: 0, y: 0, w: 4, h: 3, hideName: false },
    boxes: [[1, { x: 0, y: 200, text: "inlet 0" }], [2, { x: 0, y: 0, text: "toggle" }], [3, { x: 0, y: 260, text: "outlet 0" }]],
    cables: [[4, { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }], [5, { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 }]] });
  const lib = new Map(loaded).set("t/faced", faced);
  reset();
  const fits = applyPatch(msg([box(1, "t/faced", BORDER - 60)]), lib);
  check("bottom on the line accepted", fits.errors.length === 0, JSON.stringify(fits.errors));
  reset();
  const over = applyPatch(msg([box(1, "t/faced", BORDER - 40)]), lib);
  check("three units tall, two above the line: overhangs", over.errors.some((e) => /"t\/faced" is bound to the ctrl side but overhangs the border/.test(e)), JSON.stringify(over.errors));
}

console.log("editor lookups (useAbstractions)");
{
  useAbstractions(loaded);
  check("ports from the header", JSON.stringify(getBoxPorts("t/gain~ 1")) === JSON.stringify({ inlets: 1, outlets: 1 }));
  check("inlet def", getInletDef("t/gain~ 1", 0)?.type === "audio" && getInletDef("t/gain~ 1", 0)?.name === "in");
  check("outlet def", getOutletDef("t/x", 0)?.type === "number");
  check("no def past the header", getInletDef("t/x", 1) === null);
  check("declared side", sideOf({ x: 0, y: CTRL_Y, text: "t/gain~ 1" }, BORDER) === "synth");
  useAbstractions(new Map());
  check("unregistered: free", sideOf({ x: 0, y: CTRL_Y, text: "t/gain~ 1" }, BORDER) === "ctrl");
}

console.log("bundled libraries: headers and contents pass");
{
  const libs = new Map<string, AbstractionDef>();
  for (const lib of Deno.readDirSync("libs")) {
    for (const e of Deno.readDirSync(`libs/${lib.name}/abstractions`)) {
      const name = `${lib.name}/${e.name.replace(/\.json$/, "")}`;
      const { def, errors } = parseAbstraction(name, JSON.parse(Deno.readTextFileSync(`libs/${lib.name}/abstractions/${e.name}`)));
      check(`${name} header`, def !== null, JSON.stringify(errors));
      if (def) libs.set(name, def);
    }
  }
  for (const [name, d] of libs) {
    const e = checkAbstraction(d, libs);
    check(`${name} contents`, e.length === 0, JSON.stringify(e));
  }
  check("common/double is ctrl, common/quantiser synth", libs.get("common/double")?.side === "ctrl" && libs.get("common/quantiser")?.side === "synth");
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) Deno.exit(1);
