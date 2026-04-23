/**
 * Differential snapshot test for the propagation harness.
 *
 * Loads the current public/graph.js + graph-core.js as CJS, exercises a curated
 * matrix of (kind × destination × route) cases, and records the resulting
 * `updates` objects (and any side effects on graph state).
 *
 * Run before refactor → save baseline.
 * Run after refactor → compare to baseline; any diff is a regression.
 *
 * Usage:
 *   deno run --allow-read --allow-write tests/propagation_snapshot.ts capture
 *   deno run --allow-read --allow-write tests/propagation_snapshot.ts verify
 */

function importCjs(src: string): any {
  const obj: Record<string, unknown> = {};
  const cjs = src.replace(/^export\s+\{[^}]*\};?\s*$/m, "");
  new Function("exports", cjs)(obj);
  return obj;
}

// Load graph-core as CJS, expose its functions as globals for graph.js
const coreSrc = await Deno.readTextFile("./public/graph-core.js");
const core: any = importCjs(coreSrc);

const graphSrc = await Deno.readTextFile("./public/graph.js");
function loadGraph() {
  const wrapped = `
var createBoxState = core.createBoxState;
var evaluatePure = core.evaluatePure;
var evaluateStateful = core.evaluateStateful;
var handleBoxEvent = core.handleBoxEvent;
var tickBox = core.tickBox;
var isEventTrigger = core.isEventTrigger;
var firesEvent = core.firesEvent;
var isHotInlet = core.isHotInlet;
var isEventOutlet = core.isEventOutlet;
var applyInletToState = core.applyInletToState;
${graphSrc}
return {
  buildGraph,
  propagateValue, propagateEvent,
  processRouterValue, processRouterEvent,
  handleEvent, evaluateNode, tickGraph,
};
  `;
  return new Function("core", wrapped)(core);
}
const g: any = loadGraph();

// --- Helpers ---

type Case = {
  name: string;
  patch: any;
  run: (graph: any) => any;
};

function buildPatch(boxes: any[], cables: any[] = [], entries: any[] = []) {
  return { boxes, cables, entries };
}

function freezeGraphState(graph: any) {
  // Capture relevant state for snapshot comparison: inletValues per box,
  // box.state if present, uplinkQueue.
  const out: any = { boxes: {}, uplinkQueue: [...graph.uplinkQueue] };
  for (const [id, node] of graph.boxes.entries()) {
    out.boxes[id] = {
      type: node.type,
      inletValues: [...node.inletValues],
      state: node.state ? JSON.parse(JSON.stringify(node.state)) : null,
    };
  }
  return out;
}

// --- Test cases ---

const cases: Case[] = [
  // === propagateValue cases ===
  {
    name: "propagateValue → engine non-trigger paramName",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "440", text: "const 440" },
        { id: 2, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"] },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph) => g.propagateValue(graph, 1, 0, 440),
  },
  {
    name: "propagateValue → engine trigger paramName (value should NOT fire)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "1", text: "const 1" },
        { id: 2, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"] },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 4 }],
    ),
    run: (graph) => g.propagateValue(graph, 1, 0, 1),
  },
  {
    name: "propagateValue → wireless send",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "55", text: "const 55" },
        { id: 2, type: "send", args: "freq", text: "send freq" },
        { id: 3, type: "receive", args: "freq", text: "receive freq" },
        { id: 4, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"] },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 3, srcOutlet: 0, dstBox: 4, dstInlet: 0 },
      ],
    ),
    run: (graph) => g.propagateValue(graph, 1, 0, 55),
  },
  {
    name: "propagateValue → wireless throw (sums into catch)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "10", text: "const 10" },
        { id: 2, type: "throw", args: "sum", text: "throw sum" },
        { id: 3, type: "catch", args: "sum", text: "catch sum" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph) => g.propagateValue(graph, 1, 0, 10),
  },
  {
    name: "propagateValue → uplink (queues to uplinkQueue)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "0.5", text: "const 0.5" },
        { id: 2, type: "sendup", args: "tx", text: "sendup tx" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph) => g.propagateValue(graph, 1, 0, 0.5),
  },
  {
    name: "propagateValue → display sink (no-op)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "1", text: "const 1" },
        { id: 2, type: "screen", args: "", text: "screen" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph) => g.propagateValue(graph, 1, 0, 1),
  },
  {
    name: "propagateValue → spigot inlet 0 with gate=0 (block)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "5", text: "const 5" },
        { id: 2, type: "spigot", args: "", text: "spigot" },
        { id: 3, type: "+", args: "10", text: "+ 10" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
      ],
    ),
    run: (graph) => {
      // Set gate to 0 first
      const sp = graph.boxes.get(2);
      sp.inletValues[1] = 0;
      return g.propagateValue(graph, 1, 0, 5);
    },
  },
  {
    name: "propagateValue → spigot inlet 0 with gate=1 (pass)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "5", text: "const 5" },
        { id: 2, type: "spigot", args: "", text: "spigot" },
        { id: 3, type: "+", args: "10", text: "+ 10" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
      ],
    ),
    run: (graph) => {
      const sp = graph.boxes.get(2);
      sp.inletValues[1] = 1;
      return g.propagateValue(graph, 1, 0, 5);
    },
  },
  {
    name: "propagateValue → toggle inlet 1 (flip when crossing)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "1", text: "const 1" },
        { id: 2, type: "toggle", args: "", text: "toggle" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 1 }],
    ),
    run: (graph) => g.propagateValue(graph, 1, 0, 1),
  },
  {
    name: "propagateValue → map inlet 1 (replace table)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "0", text: "const 0" }, // dummy source
        { id: 2, type: "map", args: "10 20 30", text: "map 10 20 30" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 1 }],
    ),
    run: (graph) => g.propagateValue(graph, 1, 0, [99, 100, 101]),
  },
  {
    name: "propagateValue → map inlet 0 (lookup)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "1", text: "const 1" },
        { id: 2, type: "map", args: "10 20 30", text: "map 10 20 30" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph) => g.propagateValue(graph, 1, 0, 1),
  },
  {
    name: "propagateValue → change (only fires on diff)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "5", text: "const 5" },
        { id: 2, type: "change", args: "", text: "change" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph) => {
      // First call: prev is undefined, 5 !== undefined → fires
      const u1 = g.propagateValue(graph, 1, 0, 5);
      // Second call: prev=5, 5 === 5 → doesn't fire
      const u2 = g.propagateValue(graph, 1, 0, 5);
      return { firstCall: u1, secondCall: u2 };
    },
  },
  {
    name: "propagateValue → applyInletToState (adsr release)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "0.7", text: "const 0.7" },
        { id: 2, type: "adsr", args: "0.05 0.1 0.7 0.3", text: "adsr 0.05 0.1 0.7 0.3" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 4 }],
    ),
    run: (graph) => {
      g.propagateValue(graph, 1, 0, 0.7);
      // Snapshot the resulting adsr state
      return graph.boxes.get(2).state;
    },
  },
  {
    name: "propagateValue → seq inlet 2 (replace values array)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "0", text: "const 0" }, // dummy
        { id: 2, type: "seq", args: "1 2 3", text: "seq 1 2 3" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 2 }],
    ),
    run: (graph) => {
      g.propagateValue(graph, 1, 0, [60, 64, 67]);
      return graph.boxes.get(2).state;
    },
  },
  {
    name: "propagateValue → pure math hot inlet (recompute and propagate)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "5", text: "const 5" },
        { id: 2, type: "+", args: "10", text: "+ 10" },
        { id: 3, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"] },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
      ],
    ),
    run: (graph) => g.propagateValue(graph, 1, 0, 5),
  },
  {
    name: "propagateValue → event-trigger inlet (defer handleEvent)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "0", text: "const 0" },
        { id: 2, type: "counter", args: "0 7", text: "counter 0 7" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph) => {
      const u = g.propagateValue(graph, 1, 0, 0);
      return { updates: u, counterState: graph.boxes.get(2).state };
    },
  },

  // === propagateEvent cases ===
  {
    name: "propagateEvent → engine trigger paramName (writes 1)",
    patch: buildPatch(
      [
        { id: 1, type: "metro", args: "0.5", text: "metro 0.5" },
        { id: 2, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"] },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 4 }],
    ),
    run: (graph) => g.propagateEvent(graph, 1, 0),
  },
  {
    name: "propagateEvent → engine non-trigger paramName (drop)",
    patch: buildPatch(
      [
        { id: 1, type: "metro", args: "0.5", text: "metro 0.5" },
        { id: 2, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"] },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph) => g.propagateEvent(graph, 1, 0),
  },
  {
    name: "propagateEvent → wireless send (forward as event)",
    patch: buildPatch(
      [
        { id: 1, type: "metro", args: "0.5", text: "metro 0.5" },
        { id: 2, type: "send", args: "trig", text: "send trig" },
        { id: 3, type: "receive", args: "trig", text: "receive trig" },
        { id: 4, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"] },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 3, srcOutlet: 0, dstBox: 4, dstInlet: 4 },
      ],
    ),
    run: (graph) => g.propagateEvent(graph, 1, 0),
  },
  {
    name: "propagateEvent → throw (drop, events don't sum)",
    patch: buildPatch(
      [
        { id: 1, type: "metro", args: "0.5", text: "metro 0.5" },
        { id: 2, type: "throw", args: "x", text: "throw x" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph) => g.propagateEvent(graph, 1, 0),
  },
  {
    name: "propagateEvent → event-trigger inlet (handleEvent fires)",
    patch: buildPatch(
      [
        { id: 1, type: "metro", args: "0.5", text: "metro 0.5" },
        { id: 2, type: "counter", args: "0 7", text: "counter 0 7" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph) => {
      const u = g.propagateEvent(graph, 1, 0);
      return { updates: u, counterState: graph.boxes.get(2).state };
    },
  },

  // === processRouterValue cases ===
  {
    name: "processRouterValue → engine paramName (write)",
    patch: {
      boxes: [
        { id: 1, type: "all", args: "1", text: "all 1" },
        { id: 2, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"] },
      ],
      cables: [],
      entries: [{ routerId: 1, routerOutlet: 0, targetBox: 2, targetInlet: 0 }],
    },
    run: (graph) => g.processRouterValue(graph, 1, 0, 880),
  },
  {
    name: "processRouterValue → r/receive (no-op, no downstream)",
    patch: {
      boxes: [
        { id: 1, type: "all", args: "1", text: "all 1" },
        { id: 2, type: "receive", args: "x", text: "receive x" },
      ],
      cables: [],
      entries: [{ routerId: 1, routerOutlet: 0, targetBox: 2, targetInlet: 0 }],
    },
    run: (graph) => g.processRouterValue(graph, 1, 0, 42),
  },

  // === processRouterEvent cases ===
  {
    name: "processRouterEvent → engine trigger (write 1)",
    patch: {
      boxes: [
        { id: 1, type: "all", args: "1", text: "all 1" },
        { id: 2, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"] },
      ],
      cables: [],
      entries: [{ routerId: 1, routerOutlet: 0, targetBox: 2, targetInlet: 4 }],
    },
    run: (graph) => g.processRouterEvent(graph, 1, 0),
  },
  {
    name: "processRouterEvent → engine non-trigger paramName (drop)",
    patch: {
      boxes: [
        { id: 1, type: "all", args: "1", text: "all 1" },
        { id: 2, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"] },
      ],
      cables: [],
      entries: [{ routerId: 1, routerOutlet: 0, targetBox: 2, targetInlet: 0 }],
    },
    run: (graph) => g.processRouterEvent(graph, 1, 0),
  },
  {
    name: "processRouterEvent → r/receive (forward as event)",
    patch: {
      boxes: [
        { id: 1, type: "all", args: "1", text: "all 1" },
        { id: 2, type: "receive", args: "x", text: "receive x" },
      ],
      cables: [],
      entries: [{ routerId: 1, routerOutlet: 0, targetBox: 2, targetInlet: 0 }],
    },
    run: (graph) => g.processRouterEvent(graph, 1, 0),
  },
];

// --- Run ---

function runAll(): Record<string, any> {
  const results: Record<string, any> = {};
  for (const c of cases) {
    try {
      const graph = g.buildGraph(c.patch);
      const result = c.run(graph);
      const state = freezeGraphState(graph);
      results[c.name] = { result, state };
    } catch (e) {
      results[c.name] = { error: String(e) };
    }
  }
  return results;
}

const mode = Deno.args[0] || "capture";
const baselinePath = "tests/propagation_baseline.json";

if (mode === "capture") {
  const results = runAll();
  await Deno.writeTextFile(baselinePath, JSON.stringify(results, null, 2));
  console.log(`Captured ${Object.keys(results).length} cases → ${baselinePath}`);
} else if (mode === "verify") {
  const baseline = JSON.parse(await Deno.readTextFile(baselinePath));
  const current = runAll();
  let pass = 0, fail = 0;
  for (const name of Object.keys(baseline)) {
    const a = JSON.stringify(baseline[name]);
    const b = JSON.stringify(current[name]);
    if (a === b) {
      pass++;
    } else {
      fail++;
      console.log(`FAIL: ${name}`);
      console.log(`  baseline: ${a}`);
      console.log(`  current:  ${b}`);
    }
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  if (fail > 0) Deno.exit(1);
} else {
  console.error(`Unknown mode: ${mode}. Use 'capture' or 'verify'.`);
  Deno.exit(1);
}
