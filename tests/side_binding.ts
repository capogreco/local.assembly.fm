/**
 * Apply-rejection tests for side and binding (notes/architecture.md, "Side and
 * binding"). Drives applyPatch from apply-check.ts, the step handleApply runs
 * before it evaluates or deploys anything.
 *
 * Usage: deno run --allow-read tests/side_binding.ts
 */

import { boxes, cables, clearPatchState, getPatchNextId, getBorderY, setBorderY } from "../patch-state.ts";
import { applyPatch, checkAbstraction, type AbstractionDef } from "../apply-check.ts";
import { movesOffSide } from "../public/gpi-types.js";

const BORDER = 400;
const ONE_Y = 100, MANY_Y = 600;

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

function absDef(texts: string[]): AbstractionDef {
  return {
    boxes: new Map(texts.map((text, i) => [i + 1, { x: 0, y: 0, text }])),
    // Wire the first box through the rest in a chain, as an inlet-to-outlet path.
    cables: new Map(texts.slice(1).map((_, i) => [i + 1, { srcBox: i + 1, srcOutlet: 0, dstBox: i + 2, dstInlet: 0 }])),
  };
}
const loaded = new Map<string, AbstractionDef>([
  ["free-abs", absDef(["inlet 0", "+ 1", "outlet 0"])],
  ["one-abs", absDef(["inlet 0", "key", "outlet 0"])],
  ["many-abs", absDef(["inlet 0", "touch", "outlet 0"])],
  ["mixed-abs", absDef(["key", "touch"])],
  ["router-abs", absDef(["inlet 0", "all 1"])],
  ["nested-mixed", absDef(["one-abs", "many-abs"])],
  ["nested-one", absDef(["free-abs", "one-abs"])],
  ["typo-abs", absDef(["inlet 0", "no-such-box", "outlet 0"])],
  ["self-abs", absDef(["inlet 0", "self-abs", "self-abs", "outlet 0"])],
  ["ping", absDef(["inlet 0", "pong", "outlet 0"])],
  ["pong", absDef(["inlet 0", "ping", "outlet 0"])],
]);

function reset(): void {
  clearPatchState();
  setBorderY(400);
}

console.log("one-bound box placed many-side");
{
  reset();
  const r = applyPatch(msg([box(1, "key", MANY_Y)]), loaded);
  check("rejected", r.errors.length === 1, JSON.stringify(r.errors));
  check("names the box and side", /"key".*one.*many/.test(r.errors[0] ?? ""), r.errors[0]);
}

console.log("many-bound box placed one-side");
{
  reset();
  const r = applyPatch(msg([box(1, "touch", ONE_Y)]), loaded);
  check("rejected", r.errors.length === 1, JSON.stringify(r.errors));
  check("names the box and side", /"touch".*many.*one/.test(r.errors[0] ?? ""), r.errors[0]);
}

console.log("abstraction containing a router");
{
  reset();
  const r = applyPatch(msg([box(1, "router-abs", ONE_Y)]), loaded);
  check("rejected", r.errors.some((e) => /contains router/.test(e)), JSON.stringify(r.errors));
}

console.log("abstraction mixing one- and many-bound boxes");
{
  reset();
  const r = applyPatch(msg([box(1, "mixed-abs", ONE_Y)]), loaded);
  check("rejected", r.errors.some((e) => /mixes one-bound "key" and many-bound "touch"/.test(e)), JSON.stringify(r.errors));
  const n = applyPatch(msg([box(1, "nested-mixed", ONE_Y)]), loaded);
  check("nested mix rejected", n.errors.some((e) => /mixes/.test(e)), JSON.stringify(n.errors));
}

console.log("bound abstraction placed on the wrong side");
{
  reset();
  const r = applyPatch(msg([box(1, "one-abs", MANY_Y)]), loaded);
  check("rejected", r.errors.length > 0 && /"key"/.test(r.errors[0]), JSON.stringify(r.errors));
}

console.log("valid patch accepted");
{
  reset();
  const r = applyPatch(msg(
    [box(1, "key", ONE_Y), box(2, "all 1", BORDER), box(3, "touch", MANY_Y), box(4, "free-abs", ONE_Y), box(5, "ewing~", MANY_Y), box(6, "nested-one", ONE_Y)],
    [cable(1, 1, 0, 2, 0), cable(2, 2, 0, 3, 0)],
  ), loaded);
  check("no errors", r.errors.length === 0, JSON.stringify(r.errors));
  check("committed to the live patch", boxes.has(1) && boxes.has(3) && getPatchNextId() === 1000);
  check("abstractions expanded away", ![...boxes.values()].some((b) => b.text === "free-abs" || b.text === "nested-one"));
  const sides = Object.fromEntries([...boxes].filter(([id]) => id <= 6).map(([id, b]) => [id, b.side]));
  check("sides stamped", JSON.stringify(sides) === JSON.stringify({ 1: "one", 2: "border", 3: "many", 5: "many" }), JSON.stringify(sides));
  check("every box has a side", [...boxes.values()].every((b) => b.side !== undefined));
  check("router snapped to border", boxes.get(2)!.y === BORDER - 11);
  check("free box follows position (ewing~ many-side)", boxes.get(5)!.side === "many");
  check("clone of one-bound inner box is one", [...boxes.values()].some((b) => b.text === "key" && b.side === "one" && b !== boxes.get(1)));
}

console.log("rejected apply leaves the previous patch in place");
{
  reset();
  const good = applyPatch(msg([box(1, "key", ONE_Y), box(2, "touch", MANY_Y)]), loaded);
  check("first apply accepted", good.errors.length === 0, JSON.stringify(good.errors));
  const before = JSON.stringify({ b: [...boxes], c: [...cables], n: getPatchNextId(), y: getBorderY() });
  const bad = [
    msg([box(7, "key", MANY_Y)]),
    msg([box(7, "mixed-abs", ONE_Y)]),
    msg([box(7, "no-such-box", ONE_Y)]),
    { ...msg([box(7, "free-abs", ONE_Y), box(8, "key", MANY_Y)]), borderY: 250, nextId: 5 },
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
  const r = applyPatch(msg([box(1, "self-abs", ONE_Y)]), loaded);
  check("direct cycle rejected", r.errors.some((e) => /"self-abs" contains itself/.test(e)), JSON.stringify(r.errors));
  check("nothing committed", boxes.size === 0);
  const m = applyPatch(msg([box(1, "ping", ONE_Y)]), loaded);
  check("mutual cycle rejected", m.errors.some((e) => /contains itself/.test(e)), JSON.stringify(m.errors));
}

console.log("unknown box type inside an abstraction");
{
  reset();
  const r = applyPatch(msg([box(1, "typo-abs", ONE_Y)]), loaded);
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
  const r = applyPatch(msg([box(1, "cc", ONE_Y), box(2, "free-abs", MANY_Y)], [cable(1, 1, 0, 2, 0)]), loaded);
  check("bare event cable across border rejected", r.errors.some((e) => /crosses the border without a router/.test(e)), JSON.stringify(r.errors));
}

console.log("bound box overhanging the border");
{
  // H = BOX_HEIGHT = 22. A key with its bottom 1 below the line, a touch with its top 1 above.
  reset();
  const r = applyPatch(msg([box(1, "key", BORDER - 21)]), loaded);
  check("one-bound overhang rejected", r.errors.length === 1 && /"key".*one.*overhangs/.test(r.errors[0] ?? ""), JSON.stringify(r.errors));
  reset();
  const m = applyPatch(msg([box(1, "touch", BORDER - 1)]), loaded);
  check("many-bound overhang rejected", m.errors.length === 1 && /"touch".*many.*overhangs/.test(m.errors[0] ?? ""), JSON.stringify(m.errors));
  reset();
  const edge = applyPatch(msg([box(1, "key", BORDER - 22), box(2, "touch", BORDER)]), loaded);
  check("bottom on the line is one, top on the line is many", edge.errors.length === 0, JSON.stringify(edge.errors));
}

console.log("free box sided by its centre");
{
  reset();
  // Top above the line but centre below: many. Top above, centre above: one.
  const r = applyPatch(msg([box(1, "+ 1", BORDER - 10), box(2, "+ 2", BORDER - 12), box(3, "+ 3", BORDER - 11)]), loaded);
  check("accepted", r.errors.length === 0, JSON.stringify(r.errors));
  check("centre below → many", boxes.get(1)!.side === "many");
  check("centre above → one", boxes.get(2)!.side === "one");
  check("centre on the line → many", boxes.get(3)!.side === "many");
}

console.log("router unchanged");
{
  reset();
  const r = applyPatch(msg([box(1, "all 1", MANY_Y)]), loaded);
  check("accepted", r.errors.length === 0, JSON.stringify(r.errors));
  check("side is border", boxes.get(1)!.side === "border");
  check("snapped to borderY - BOX_HEIGHT/2", boxes.get(1)!.y === BORDER - 11, String(boxes.get(1)!.y));
}

console.log("abstraction save check");
{
  const mixed = { boxes: [[1, { text: "key" }], [2, { text: "touch" }]], cables: [] };
  check("mixed rejected", checkAbstraction("m", mixed, loaded) !== null);
  const ok = { boxes: [[1, { text: "+ 1" }]], cables: [] };
  check("free accepted", checkAbstraction("f", ok, loaded) === null);
  const self = { boxes: [[1, { text: "self" }], [2, { text: "key" }]], cables: [] };
  check("self-reference rejected", /contains itself/.test(checkAbstraction("self", self, loaded) ?? ""));
}

console.log("editor move judged by where it ends (movesOffSide)");
{
  const at = (text: string, y: number) => ({ x: 0, y, text });
  check("on side to on side accepted", !movesOffSide(at("key", ONE_Y), BORDER, at("key", ONE_Y + 50), BORDER));
  check("on side to off side refused", movesOffSide(at("key", ONE_Y), BORDER, at("key", MANY_Y), BORDER));
  check("on side to overhang refused", movesOffSide(at("key", ONE_Y), BORDER, at("key", BORDER - 21), BORDER));
  check("off side back on side accepted", !movesOffSide(at("key", MANY_Y), BORDER, at("key", ONE_Y), BORDER));
  check("off side moves freely while off side", !movesOffSide(at("key", MANY_Y), BORDER, at("key", MANY_Y + 30), BORDER));
  check("border moved onto a bound box refused", movesOffSide(at("touch", MANY_Y), BORDER, at("touch", MANY_Y), MANY_Y + 1));
  check("new box judged by where it lands", movesOffSide(null, BORDER, at("touch", ONE_Y), BORDER) && !movesOffSide(null, BORDER, at("touch", MANY_Y), BORDER));
  check("free box never off side", !movesOffSide(at("+ 1", ONE_Y), BORDER, at("+ 1", MANY_Y), BORDER));
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) Deno.exit(1);
