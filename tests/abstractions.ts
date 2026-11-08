/**
 * Abstraction header, save and apply checks (notes/abstractions.md): the
 * header (parseAbstraction), the contents against it (checkAbstraction), and
 * each instance's boundary at apply (applyPatch). Also the editor's port and
 * side lookups for abstractions (gpi-types useAbstractions).
 *
 * Usage: deno run --allow-read tests/abstractions.ts
 */

import { boxes, cables, clearPatchState, getBorderY, getPatchNextId, setBorderY } from "../patch-state.ts";
import { applyPatch, checkAbstraction, isAbstractionName, parseAbstraction, type AbstractionDef } from "../apply-check.ts";
import { cableTypeProblem, getBoxPorts, getInletDef, getOutletDef, sideOf, useAbstractions } from "../public/gpi-types.js";

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
    ["unknown field", { face: {} }, /unknown field "face"/],
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
  check("audio inlet into a message inlet (adsr~ gate) rejected", audioIn("adsr~ 0.1 0.1 0.5 0.3").some((e) => /audio into a number inlet \(a message inlet/.test(e)), JSON.stringify(audioIn("adsr~ 0.1 0.1 0.5 0.3")));
  check("audio inlet into an AudioParam (adsr~ attack)", errs({
    inlets: [port("sig", "audio")], outlets: [],
    boxes: [[1, { text: "inlet 0" }], [2, { text: "adsr~ 0.1 0.1 0.5 0.3" }]],
    cables: [[3, { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 1 }]],
  }).length === 0);
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

console.log("save: an inlet wired straight to an outlet");
{
  const e = errs({
    inlets: [port("a", "number"), port("b", "number")], outlets: [port("out", "number")],
    boxes: [[1, { text: "inlet 0" }], [2, { text: "inlet 1" }], [3, { text: "outlet 0" }]],
    cables: [[4, { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 }]],
  });
  check("refused", e.some((m) => /^"t\/x": inlet 1 is wired directly to outlet 0: put a box between$/.test(m)), JSON.stringify(e));
}

console.log("save: nested ports and unknown types");
{
  const inner = new Map([["t/x", def()]]);
  const outer = (c: [number, unknown]) => checkAbstraction(def({
    name: "t/y", inlets: [], outlets: [],
    boxes: [[1, { text: "+ 1" }], [2, { text: "t/x" }], [3, { text: "print" }]],
    cables: [c],
  }), inner);
  const intoInlet = outer([4, { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 1 }]);
  check("cable into a nested inlet out of range", intoInlet.some((m) => /^"t\/y": cable into "t\/x" inlet 1: no such inlet \(it has 1\)$/.test(m)), JSON.stringify(intoInlet));
  const fromOutlet = outer([4, { srcBox: 2, srcOutlet: 2, dstBox: 3, dstInlet: 0 }]);
  check("cable from a nested outlet out of range", fromOutlet.some((m) => /^"t\/y": cable from "t\/x" outlet 2: no such outlet \(it has 1\)$/.test(m)), JSON.stringify(fromOutlet));
  check("in range accepted", outer([4, { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }]).length === 0);
  const typo = errs({ boxes: [[1, { text: "inlet 0" }], [2, { text: "mul 2" }], [3, { text: "outlet 0" }]], cables: [] });
  check("unknown inner box type", typo.some((m) => /^"t\/x": unknown box type "mul"$/.test(m)), JSON.stringify(typo));
  const unsaved = errs({ boxes: [[1, { text: "inlet 0" }], [2, { text: "t/nope" }], [3, { text: "outlet 0" }]], cables: [] });
  check("unknown nested abstraction", unsaved.some((m) => /unknown box type "t\/nope"/.test(m)), JSON.stringify(unsaved));
}

console.log("save: $n needs a declared arg");
{
  const one = [{ name: "k", type: "number", description: "" }];
  check("$1 with one arg accepted", errs({ args: one, boxes: [[1, { text: "inlet 0" }], [2, { text: "* $1" }], [3, { text: "outlet 0" }]] }).length === 0);
  const e = errs({ args: one, boxes: [[1, { text: "inlet 0" }], [2, { text: "* $2" }], [3, { text: "outlet 0" }]] });
  check("$2 with one arg rejected", e.some((m) => /"\* \$2" uses \$2, but 1 arg\(s\) are declared/.test(m)), JSON.stringify(e));
  check("$0 needs no arg", errs({ boxes: [[1, { text: "inlet 0" }], [2, { text: "* $0" }], [3, { text: "outlet 0" }]] }).length === 0);
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
    ["audio into a message inlet (plain boxes)", msg([box(1, "osc~ 440", SYNTH_Y), box(2, "adsr~ 0.1 0.1 0.5 0.3", SYNTH_Y)], [cable(1, 1, 0, 2, 0)]),
      /^cable "osc~ 440" outlet 0 → "adsr~ 0.1 0.1 0.5 0.3" inlet 0: audio into a number inlet \(a message inlet, not an AudioParam\)$/],
    ["number into an audio inlet (plain boxes)", msg([box(1, "+ 1", SYNTH_Y), box(2, "dac~", SYNTH_Y)], [cable(1, 1, 0, 2, 0)]),
      /^cable "\+ 1" outlet 0 → "dac~" inlet 0: number into an audio inlet$/],
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

console.log("cable types: one rule for the editor and apply");
{
  check("audio into an AudioParam", cableTypeProblem("audio", "osc~", getInletDef("osc~", 0)) === null);
  check("audio into adsr~ gate refused", cableTypeProblem("audio", "adsr~", getInletDef("adsr~", 0)) !== null);
  check("audio into an abstraction's number inlet refused", (useAbstractions(loaded), cableTypeProblem("audio", "t/x", getInletDef("t/x", 0)) !== null));
  useAbstractions(new Map());
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
