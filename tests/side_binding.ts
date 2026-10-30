/**
 * Apply-rejection tests for side and binding (notes/architecture.md, "Side and
 * binding"). Drives applyPatch from apply-check.ts, the step handleApply runs
 * before it evaluates or deploys anything.
 *
 * Usage: deno run --allow-read tests/side_binding.ts
 */

import { boxes, cables, clearPatchState, getPatchNextId, getBorderY, setBorderY } from "../patch-state.ts";
import { applyPatch, checkAbstraction, type AbstractionDef } from "../apply-check.ts";

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

console.log("border crossings are still caught after expansion");
{
  reset();
  const r = applyPatch(msg([box(1, "cc", ONE_Y), box(2, "free-abs", MANY_Y)], [cable(1, 1, 0, 2, 0)]), loaded);
  check("bare event cable across border rejected", r.errors.some((e) => /crosses the border without a router/.test(e)), JSON.stringify(r.errors));
}

console.log("abstraction save check");
{
  const mixed = { boxes: [[1, { text: "key" }], [2, { text: "touch" }]], cables: [] };
  check("mixed rejected", checkAbstraction("m", mixed, loaded) !== null);
  const ok = { boxes: [[1, { text: "+ 1" }]], cables: [] };
  check("free accepted", checkAbstraction("f", ok, loaded) === null);
  const self = { boxes: [[1, { text: "self" }], [2, { text: "key" }]], cables: [] };
  check("self-reference does not hang", checkAbstraction("self", self, loaded) === null);
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) Deno.exit(1);
