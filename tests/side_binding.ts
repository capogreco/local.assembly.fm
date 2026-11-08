/**
 * Apply-rejection tests for side and binding (notes/architecture.md, "Side and
 * binding"). Drives applyPatch from apply-check.ts, the step handleApply runs
 * before it evaluates or deploys anything.
 *
 * Usage: deno run --allow-read tests/side_binding.ts
 */

import { boxes, boxValues, cables, clearPatchState, ctrlState, getPatchNextId, getBorderY, setBorderY } from "../patch-state.ts";
import { applyPatch, checkAbstraction, type AbstractionDef } from "../apply-check.ts";
import { BOX_HEIGHT as H, GRID, movesOffSide } from "../public/gpi-types.js";

const BORDER = 400;
const CTRL_Y = 100, SYNTH_Y = 600;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// deno-lint-ignore no-explicit-any
type B = [number, any];
const box = (id: number, text: string, y: number, x = 0): B => [id, { x, y, text, inlets: 0, outlets: 0 }];
// deno-lint-ignore no-explicit-any
const cable = (id: number, srcBox: number, srcOutlet: number, dstBox: number, dstInlet: number): [number, any] =>
  [id, { srcBox, srcOutlet, dstBox, dstInlet }];
const msg = (b: B[], c: [number, unknown][] = []) => ({ boxes: b, cables: c, nextId: 1000, borderY: BORDER });

// An abstraction whose boxes are wired in a chain, first to last. A header
// inlet/outlet is declared (number) for each `inlet i`/`outlet i` box.
function absDef(name: string, side: "ctrl" | "synth", texts: string[]): AbstractionDef {
  const port = (kind: string) => texts.filter((t) => t.startsWith(kind + " ")).map((_, i) => ({ name: `${kind[0]}${i}`, type: "number", description: "" }));
  return {
    name, side, description: "", args: [], inlets: port("inlet"), outlets: port("outlet"), face: null,
    boxes: new Map(texts.map((text, i) => [i + 1, { x: 0, y: 0, text }])),
    cables: new Map(texts.slice(1).map((_, i) => [i + 1, { srcBox: i + 1, srcOutlet: 0, dstBox: i + 2, dstInlet: 0 }])),
  };
}
const loaded = new Map<string, AbstractionDef>([
  absDef("t/free-abs", "ctrl", ["inlet 0", "+ 1", "outlet 0"]),
  absDef("t/synth-free", "synth", ["inlet 0", "+ 1", "outlet 0"]),
  absDef("t/ctrl-abs", "ctrl", ["inlet 0", "key", "outlet 0"]),
  absDef("t/synth-abs", "synth", ["inlet 0", "touch", "outlet 0"]),
  absDef("t/mixed-abs", "ctrl", ["key", "touch"]),
  absDef("t/router-abs", "ctrl", ["inlet 0", "all 1"]),
  absDef("t/nested-mixed", "ctrl", ["t/ctrl-abs", "t/synth-abs"]),
  absDef("t/nested-ctrl", "ctrl", ["t/free-abs", "t/ctrl-abs"]),
  absDef("t/typo-abs", "ctrl", ["inlet 0", "no-such-box", "outlet 0"]),
  absDef("t/self-abs", "ctrl", ["inlet 0", "t/self-abs", "t/self-abs", "outlet 0"]),
  absDef("t/ping", "ctrl", ["inlet 0", "t/pong", "outlet 0"]),
  absDef("t/pong", "ctrl", ["inlet 0", "t/ping", "outlet 0"]),
].map((d) => [d.name, d]));

function reset(): void {
  clearPatchState();
  setBorderY(400);
}

console.log("ctrl-bound box placed synth-side");
{
  reset();
  const r = applyPatch(msg([box(1, "key", SYNTH_Y)]), loaded);
  check("rejected", r.errors.length === 1, JSON.stringify(r.errors));
  check("names the box and side", /"key".*ctrl.*synth/.test(r.errors[0] ?? ""), r.errors[0]);
}

console.log("synth-bound box placed ctrl-side");
{
  reset();
  const r = applyPatch(msg([box(1, "touch", CTRL_Y)]), loaded);
  check("rejected", r.errors.length === 1, JSON.stringify(r.errors));
  check("names the box and side", /"touch".*synth.*ctrl/.test(r.errors[0] ?? ""), r.errors[0]);
}

console.log("abstraction containing a router");
{
  reset();
  const r = applyPatch(msg([box(1, "t/router-abs", CTRL_Y)]), loaded);
  check("rejected", r.errors.some((e) => /contains router/.test(e)), JSON.stringify(r.errors));
}

console.log("abstraction containing a box bound to the other side");
{
  reset();
  const r = applyPatch(msg([box(1, "t/mixed-abs", CTRL_Y)]), loaded);
  check("rejected", r.errors.some((e) => /"t\/mixed-abs": is declared ctrl but contains synth-bound "touch"/.test(e)), JSON.stringify(r.errors));
  const n = applyPatch(msg([box(1, "t/nested-mixed", CTRL_Y)]), loaded);
  check("nested abstraction on the other side rejected", n.errors.some((e) => /contains synth-bound "t\/synth-abs"/.test(e)), JSON.stringify(n.errors));
}

console.log("abstraction placed on the wrong side");
{
  reset();
  const r = applyPatch(msg([box(1, "t/ctrl-abs", SYNTH_Y)]), loaded);
  check("bound contents: rejected", r.errors.length === 1 && /"t\/ctrl-abs" is bound to the ctrl side/.test(r.errors[0]), JSON.stringify(r.errors));
  const f = applyPatch(msg([box(1, "t/free-abs", SYNTH_Y)]), loaded);
  check("free contents: declared side still holds", f.errors.length === 1 && /"t\/free-abs" is bound to the ctrl side/.test(f.errors[0]), JSON.stringify(f.errors));
}

console.log("valid patch accepted");
{
  reset();
  const r = applyPatch(msg(
    [box(1, "key", CTRL_Y), box(2, "all 1", BORDER), box(3, "touch", SYNTH_Y), box(4, "t/free-abs", CTRL_Y), box(5, "ewing~", SYNTH_Y), box(6, "t/nested-ctrl", CTRL_Y)],
    [cable(1, 1, 0, 2, 0), cable(2, 2, 0, 3, 0)],
  ), loaded);
  check("no errors", r.errors.length === 0, JSON.stringify(r.errors));
  check("committed to the live patch", boxes.has(1) && boxes.has(3) && getPatchNextId() === 1000);
  check("abstractions expanded away", ![...boxes.values()].some((b) => b.text === "t/free-abs" || b.text === "t/nested-ctrl"));
  check("abstractions used, nested ones too", JSON.stringify([...r.abstractions].sort()) === JSON.stringify(["t/ctrl-abs", "t/free-abs", "t/nested-ctrl"]), JSON.stringify([...r.abstractions]));
  const sides = Object.fromEntries([...boxes].filter(([id]) => id <= 6).map(([id, b]) => [id, b.side]));
  check("sides stamped", JSON.stringify(sides) === JSON.stringify({ 1: "ctrl", 2: "border", 3: "synth", 5: "synth" }), JSON.stringify(sides));
  check("every box has a side", [...boxes.values()].every((b) => b.side !== undefined));
  check("router snapped to the row above the border", boxes.get(2)!.y === BORDER - H);
  check("free box follows position (ewing~ synth-side)", boxes.get(5)!.side === "synth");
  check("clone of ctrl-bound inner box is ctrl", [...boxes.values()].some((b) => b.text === "key" && b.side === "ctrl" && b !== boxes.get(1)));
}

console.log("rejected apply leaves the previous patch in place");
{
  reset();
  const good = applyPatch(msg([box(1, "key", CTRL_Y), box(2, "touch", SYNTH_Y)]), loaded);
  check("first apply accepted", good.errors.length === 0, JSON.stringify(good.errors));
  const before = JSON.stringify({ b: [...boxes], c: [...cables], n: getPatchNextId(), y: getBorderY() });
  const bad = [
    msg([box(7, "key", SYNTH_Y)]),
    msg([box(7, "t/mixed-abs", CTRL_Y)]),
    msg([box(7, "no-such-box", CTRL_Y)]),
    { ...msg([box(7, "t/free-abs", CTRL_Y), box(8, "key", SYNTH_Y)]), borderY: 250, nextId: 5 },
  ];
  for (const m of bad) {
    const snapshot = JSON.stringify(m);
    const r = applyPatch(m, loaded);
    check(`rejected: ${m.boxes.map((b) => b[1].text).join(", ")}`, r.errors.length > 0);
    check("running patch untouched",
      JSON.stringify({ b: [...boxes], c: [...cables], n: getPatchNextId(), y: getBorderY() }) === before);
    check("message not mutated", JSON.stringify(m) === snapshot);
  }
}

console.log("abstraction that contains itself");
{
  reset();
  const r = applyPatch(msg([box(1, "t/self-abs", CTRL_Y)]), loaded);
  check("direct cycle rejected", r.errors.some((e) => /"t\/self-abs": contains itself/.test(e)), JSON.stringify(r.errors));
  check("nothing committed", boxes.size === 0);
  const m = applyPatch(msg([box(1, "t/ping", CTRL_Y)]), loaded);
  check("mutual cycle rejected", m.errors.some((e) => /contains itself/.test(e)), JSON.stringify(m.errors));
}

console.log("unknown box type inside an abstraction");
{
  reset();
  const r = applyPatch(msg([box(1, "t/typo-abs", CTRL_Y)]), loaded);
  check("rejected", r.errors.some((e) => /unknown box type "no-such-box"/.test(e)), JSON.stringify(r.errors));
  check("nothing committed", boxes.size === 0);
}

console.log("group args: a count or two or more positive weights");
{
  for (const text of ["group", "group 0", "group 2.5", "group x", "group 2 0", "group 2 -1", "group 1 x", "group 1 Infinity"]) {
    reset();
    const r = applyPatch(msg([box(1, text, BORDER)]), loaded);
    check(`"${text}" rejected`, r.errors.length === 1 && r.errors[0].startsWith(`"${text}"`), JSON.stringify(r.errors));
    check(`"${text}" nothing committed`, boxes.size === 0);
  }
  for (const [text, inlets] of [["group 3", 4], ["group 1", 2], ["group 2 1", 3], ["group 1.5 0.5 1", 4]] as const) {
    reset();
    const r = applyPatch(msg([box(1, text, BORDER)]), loaded);
    check(`"${text}" accepted, ${inlets} inlets, 2 outlets`, r.errors.length === 0 && boxes.get(1)?.inlets === inlets && boxes.get(1)?.outlets === 2, JSON.stringify(r.errors));
  }
}

console.log("border crossings are still caught after expansion");
{
  reset();
  const r = applyPatch(msg([box(1, "cc", CTRL_Y), box(2, "t/synth-free", SYNTH_Y)], [cable(1, 1, 0, 2, 0)]), loaded);
  check("bare event cable across border rejected", r.errors.some((e) => /crosses the border without a router/.test(e)), JSON.stringify(r.errors));
}

console.log("bound box overhanging the border");
{
  // H = BOX_HEIGHT. A key with its bottom 1 below the line, a touch with its top 1 above.
  reset();
  const r = applyPatch(msg([box(1, "key", BORDER - H + 1)]), loaded);
  check("ctrl-bound overhang rejected", r.errors.length === 1 && /"key".*ctrl.*overhangs/.test(r.errors[0] ?? ""), JSON.stringify(r.errors));
  reset();
  const m = applyPatch(msg([box(1, "touch", BORDER - 1)]), loaded);
  check("synth-bound overhang rejected", m.errors.length === 1 && /"touch".*synth.*overhangs/.test(m.errors[0] ?? ""), JSON.stringify(m.errors));
  reset();
  const edge = applyPatch(msg([box(1, "key", BORDER - H), box(2, "touch", BORDER)]), loaded);
  check("bottom on the line is ctrl, top on the line is synth", edge.errors.length === 0, JSON.stringify(edge.errors));
}

console.log("free box sided by its centre");
{
  reset();
  // Top above the line but centre below: synth. Top above, centre above: ctrl.
  // Off-grid positions: the editor never makes them, but apply doesn't refuse them.
  const r = applyPatch(msg([box(1, "+ 1", BORDER - H / 2 + 1), box(2, "+ 2", BORDER - H / 2 - 1), box(3, "+ 3", BORDER - H / 2)]), loaded);
  check("accepted", r.errors.length === 0, JSON.stringify(r.errors));
  check("centre below → synth", boxes.get(1)!.side === "synth");
  check("centre above → ctrl", boxes.get(2)!.side === "ctrl");
  check("centre on the line → synth", boxes.get(3)!.side === "synth");
  // On the grid (the border on a dot row): the row above the line is ctrl, the row on it synth.
  reset();
  const g = applyPatch(msg([box(1, "+ 1", BORDER - GRID), box(2, "+ 2", BORDER)]), loaded);
  check("grid row above the line → ctrl", g.errors.length === 0 && boxes.get(1)!.side === "ctrl");
  check("grid row on the line → synth", boxes.get(2)!.side === "synth");
}

console.log("router unchanged");
{
  reset();
  const r = applyPatch(msg([box(1, "all 1", SYNTH_Y)]), loaded);
  check("accepted", r.errors.length === 0, JSON.stringify(r.errors));
  check("side is border", boxes.get(1)!.side === "border");
  check("snapped to borderY - BOX_HEIGHT (routerY)", boxes.get(1)!.y === BORDER - H, String(boxes.get(1)!.y));
}

console.log("a reconnecting ctrl gets the patch as authored, not the expanded graph");
{
  reset();
  check("before any apply: an empty patch", JSON.stringify(ctrlState().boxes) === "[]");
  const m = msg([box(1, "knob 0.5", CTRL_Y), box(2, "t/free-abs", CTRL_Y), box(3, "print", CTRL_Y)], [cable(1, 1, 0, 2, 0), cable(2, 2, 0, 3, 0)]);
  const r = applyPatch(m, loaded);
  check("accepted", r.errors.length === 0, JSON.stringify(r.errors));
  check("live graph is expanded", !boxes.has(2) && [...boxes.values()].some((b) => b.text === "+ 1"));
  // deno-lint-ignore no-explicit-any
  const st = ctrlState() as any;
  check("state has the instance, not its insides", JSON.stringify(st.boxes.map(([id, b]: B) => [id, b.text])) === JSON.stringify([[1, "knob 0.5"], [2, "t/free-abs"], [3, "print"]]), JSON.stringify(st.boxes));
  check("state has the authored cables", JSON.stringify(st.cables) === JSON.stringify(m.cables));
  check("state has the authored nextId and border", st.nextId === 1000 && st.borderY === BORDER);
  check("top-level ids survive expansion, so values line up", boxes.has(1) && boxes.has(3));
  boxValues.set(1, 0.5);
  check("values keyed by those ids", (ctrlState() as { boxValues: Record<number, unknown> }).boxValues[1] === 0.5);
  m.boxes[0][1].text = "changed";
  check("a copy: the message changing later doesn't reach the state", JSON.stringify(ctrlState().boxes).includes("knob 0.5"));
  const bad = applyPatch(msg([box(1, "key", SYNTH_Y)]), loaded);
  check("a rejected apply keeps the last authored patch", bad.errors.length > 0 && JSON.stringify(ctrlState().boxes).includes("free-abs"));
}

console.log("abstraction save check: side against contents");
{
  check("other side rejected", checkAbstraction(absDef("t/m", "ctrl", ["key", "touch"]), loaded).length === 1);
  check("free contents accepted on either side", checkAbstraction(absDef("t/f", "synth", ["+ 1"]), loaded).length === 0);
  check("self-reference rejected", checkAbstraction(absDef("t/self", "ctrl", ["t/self", "key"]), loaded).some((e) => /contains itself/.test(e)));
}

console.log("editor move judged by where it ends (movesOffSide)");
{
  const at = (text: string, y: number) => ({ x: 0, y, text });
  check("on side to on side accepted", !movesOffSide(at("key", CTRL_Y), BORDER, at("key", CTRL_Y + 50), BORDER));
  check("on side to off side refused", movesOffSide(at("key", CTRL_Y), BORDER, at("key", SYNTH_Y), BORDER));
  check("on side to overhang refused", movesOffSide(at("key", CTRL_Y), BORDER, at("key", BORDER - H + 1), BORDER));
  check("off side back on side accepted", !movesOffSide(at("key", SYNTH_Y), BORDER, at("key", CTRL_Y), BORDER));
  check("off side moves freely while off side", !movesOffSide(at("key", SYNTH_Y), BORDER, at("key", SYNTH_Y + 30), BORDER));
  check("border moved onto a bound box refused", movesOffSide(at("touch", SYNTH_Y), BORDER, at("touch", SYNTH_Y), SYNTH_Y + 1));
  check("new box judged by where it lands", movesOffSide(null, BORDER, at("touch", CTRL_Y), BORDER) && !movesOffSide(null, BORDER, at("touch", SYNTH_Y), BORDER));
  check("free box never off side", !movesOffSide(at("+ 1", CTRL_Y), BORDER, at("+ 1", SYNTH_Y), BORDER));
}

console.log("buffer~ and play~ names are per side");
{
  reset();
  const ok = applyPatch(msg([box(1, "buffer~ a test-phrase.wav", SYNTH_Y), box(2, "play~ a", SYNTH_Y + 40),
    box(3, "buffer~ a 2", CTRL_Y), box(4, "play~ a", CTRL_Y + 40)]), loaded);
  check("same name on both sides accepted", ok.errors.length === 0, JSON.stringify(ok.errors));
  reset();
  const twice = applyPatch(msg([box(1, "buffer~ a 1", SYNTH_Y), box(2, "buffer~ a 2", SYNTH_Y + 40)]), loaded);
  check("name twice on one side rejected", twice.errors.some((e) => /defined twice on the synth side/.test(e)), JSON.stringify(twice.errors));
  reset();
  const other = applyPatch(msg([box(1, "buffer~ a 1", CTRL_Y), box(2, "play~ a", SYNTH_Y)]), loaded);
  check("play~ with the buffer on the other side rejected", other.errors.some((e) => /no buffer~ a on the synth side/.test(e)), JSON.stringify(other.errors));
  reset();
  const missing = applyPatch(msg([box(1, "buffer~ a no-such-file.wav", SYNTH_Y)]), loaded);
  check("missing media file rejected", missing.errors.some((e) => /no file public\/media\/no-such-file.wav/.test(e)), JSON.stringify(missing.errors));
  reset();
  const path = applyPatch(msg([box(1, "buffer~ a ../server.ts", SYNTH_Y)]), loaded);
  check("path as file rejected", path.errors.some((e) => /not a path/.test(e)), JSON.stringify(path.errors));
  for (const bad of ["my%20file.wav", "café.wav", ".hidden.wav", "a?b.wav"]) {
    reset();
    const r = applyPatch(msg([box(1, `buffer~ a ${bad}`, SYNTH_Y)]), loaded);
    check(`file name ${JSON.stringify(bad)} rejected`, r.errors.some((e) => /not a path/.test(e)), JSON.stringify(r.errors));
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) Deno.exit(1);
