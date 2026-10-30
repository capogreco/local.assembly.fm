/**
 * Differential snapshot test for the propagation harness.
 *
 * Loads the current public/graph.js + graph-core.js as ES modules, exercises a curated
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

import * as g from "../public/graph.js";
import { deployInletDefs } from "../public/gpi-types.js";

// --- Helpers ---

type Case = {
  name: string;
  patch: any;
  run: (graph: any) => any;
};

function buildPatch(boxes: any[], cables: any[] = [], entries: any[] = []) {
  return { boxes, cables, entries };
}

// The deploy carries per-box inletDefs (serializeSynthPatch); derive them the
// same way so the cases don't spell them out.
function withInletDefs(patch: any) {
  const boxes = patch.boxes.map((b: any) => b.inletDefs ? b : { ...b, inletDefs: deployInletDefs(b.text ?? b.type) });
  return { ...patch, boxes };
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

const HOOKS_PATCH = buildPatch(
  [
    { id: 1, type: "const", args: "3", text: "const 3" },
    { id: 2, type: "+", args: "1", text: "+ 1" },
    { id: 3, type: "all", args: "1", text: "all 1" },
  ],
  [
    { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
    { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
  ],
);

const cases: Case[] = [
  // === propagateValue cases ===
  {
    name: "propagateValue → engine non-trigger paramName",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "440", text: "const 440" },
        { id: 2, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"], messagePorts: new Set(["trigger"]) },
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
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"], messagePorts: new Set(["trigger"]) },
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
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"], messagePorts: new Set(["trigger"]) },
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
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"], messagePorts: new Set(["trigger"]) },
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
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"], messagePorts: new Set(["trigger"]) },
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
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"], messagePorts: new Set(["trigger"]) },
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
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"], messagePorts: new Set(["trigger"]) },
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
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"], messagePorts: new Set(["trigger"]) },
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
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"], messagePorts: new Set(["trigger"]) },
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
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"], messagePorts: new Set(["trigger"]) },
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

  // === seams: graph.sinks / graph.onOutput (server-only; phones set neither) ===
  {
    name: "sink ← select match (event) and reject (value)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "0", text: "const 0" },
        { id: 2, type: "select", args: "60 62", text: "select 60 62" },
        { id: 3, type: "all", args: "1", text: "all 1" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 1, dstBox: 3, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 2, dstBox: 3, dstInlet: 0 },
      ],
    ),
    run: (graph) => {
      const log: any[] = [];
      graph.sinks = new Map([[3, (inlet: number, kind: string, value: any) => log.push({ inlet, kind, value })]]);
      const u1 = g.propagateValue(graph, 1, 0, 62);
      const u2 = g.propagateValue(graph, 1, 0, 99);
      return { log, u1, u2 };
    },
  },
  {
    name: "onOutput ← every outlet a value or event leaves",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "0", text: "const 0" },
        { id: 2, type: "+", args: "10", text: "+ 10" },
        { id: 3, type: "t", args: "e f", text: "t e f" },
        { id: 4, type: "counter", args: "0 7", text: "counter 0 7" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
        { srcBox: 3, srcOutlet: 0, dstBox: 4, dstInlet: 0 },
      ],
    ),
    run: (graph) => {
      const log: any[] = [];
      graph.onOutput = (boxId: number, outlet: number, kind: string, value: any) => log.push([boxId, outlet, kind, value]);
      g.propagateValue(graph, 1, 0, 5);
      return log;
    },
  },

  {
    name: "buildGraph hooks see the initial values",
    patch: HOOKS_PATCH,
    run: (graph) => {
      // The case's own graph is built without hooks; build a second one with them.
      const log: any[] = [];
      const hooked = g.buildGraph(withInletDefs(HOOKS_PATCH), {
        sinks: new Map([[3, (inlet: number, kind: string, value: any) => log.push(["sink", inlet, kind, value])]]),
        onOutput: (boxId: number, outlet: number, kind: string, value: any) => log.push(["out", boxId, outlet, kind, value]),
      });
      return { log, hasSinks: hooked.sinks instanceof Map, plainHasSinks: "sinks" in graph };
    },
  },

  // === D1: events pass passthrough/event inlets, drop at number inlets ===
  ...[1, 0].map((gate) => ({
    name: `D1: metro → spigot ${gate ? "open (forwards event)" : "closed (drops event)"} → counter`,
    patch: buildPatch(
      [
        { id: 1, type: "metro", args: "0.5", text: "metro 0.5" },
        { id: 2, type: "spigot", args: "", text: "spigot" },
        { id: 3, type: "counter", args: "0 7", text: "counter 0 7" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
      ],
    ),
    run: (graph: any) => {
      graph.boxes.get(2).inletValues[1] = gate;
      return g.propagateEvent(graph, 1, 0);
    },
  })),
  {
    name: "D1: metro → + 5 (number inlet, event dropped)",
    patch: buildPatch(
      [
        { id: 1, type: "metro", args: "0.5", text: "metro 0.5" },
        { id: 2, type: "+", args: "5", text: "+ 5" },
        { id: 3, type: "counter", args: "0 7", text: "counter 0 7" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
      ],
    ),
    run: (graph) => g.propagateEvent(graph, 1, 0),
  },
  {
    name: "D1: event → select (number inlet, no longer fires on stale value)",
    patch: buildPatch(
      [
        { id: 1, type: "metro", args: "0.5", text: "metro 0.5" },
        { id: 2, type: "select", args: "60", text: "select 60" },
        { id: 3, type: "counter", args: "0 7", text: "counter 0 7" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
      ],
    ),
    run: (graph) => {
      graph.boxes.get(2).inletValues[0] = 60;
      return g.propagateEvent(graph, 1, 0);
    },
  },
  {
    name: "D1: router event → spigot open → t e e → counter (ks_arp shape)",
    patch: {
      boxes: [
        { id: 2, type: "spigot", args: "", text: "spigot" },
        { id: 3, type: "t", args: "e e", text: "t e e" },
        { id: 4, type: "counter", args: "0 7", text: "counter 0 7" },
      ],
      cables: [
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
        { srcBox: 3, srcOutlet: 1, dstBox: 4, dstInlet: 0 },
      ],
      entries: [{ routerId: 1, routerOutlet: 0, targetBox: 2, targetInlet: 0 }],
    },
    run: (graph) => {
      graph.boxes.get(2).inletValues[1] = 1;
      return g.processRouterEvent(graph, 1, 0);
    },
  },

  // === inletDefs carry the per-type hot flag (as the server passes inletDef) ===
  {
    name: "propagateValue → octaves inlet 1 (hot:true recomputes)",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "0", text: "const 0" },
        { id: 2, type: "octaves", args: "", text: "octaves" },
        { id: 3, type: "length", args: "", text: "length" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 1 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
      ],
    ),
    run: (graph) => {
      graph.boxes.get(2).inletValues[0] = [60, 64];
      g.propagateValue(graph, 1, 0, 1);
      return graph.boxes.get(3).inletValues;
    },
  },

  // === cold stores, inertia/follow targets, tick ===
  {
    name: "metro inlet 0 (on/off) is cold: no value out of the event outlet",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "1", text: "const 1" },
        { id: 2, type: "metro", args: "0.5", text: "metro 0.5" },
        { id: 3, type: "counter", args: "0 7", text: "counter 0 7" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
      ],
    ),
    run: (graph) => g.propagateValue(graph, 1, 0, 1),
  },
  {
    name: "held inlet 0 (pitch) is cold; inlet 1 (velocity) fires",
    patch: buildPatch(
      [
        { id: 1, type: "key", args: "", text: "key" },
        { id: 2, type: "held", args: "", text: "held" },
        { id: 3, type: "length", args: "", text: "length" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 1, srcOutlet: 1, dstBox: 2, dstInlet: 1 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
      ],
    ),
    run: (graph) => {
      g.propagateValue(graph, 1, 0, 60);
      const afterPitch = [...graph.boxes.get(3).inletValues];
      g.propagateValue(graph, 1, 1, 1);
      return { afterPitch, afterVelocity: graph.boxes.get(3).inletValues };
    },
  },
  ...["inertia", "follow"].map((type) => ({
    name: `${type} inlet 0 sets target; tick moves toward it`,
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "0", text: "const 0" },
        { id: 2, type, args: "", text: type },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph: any) => {
      g.propagateValue(graph, 1, 0, 1);
      const values = [];
      for (let i = 0; i < 3; i++) { g.tickGraph(graph, 0.05); values.push(graph.boxes.get(2).state.value); }
      return { target: graph.boxes.get(2).state.target, values: values.map((v) => +v.toFixed(6)) };
    },
  })),
  {
    name: "tickGraph: metro fires once when elapsed ≥ interval",
    patch: buildPatch(
      [
        { id: 1, type: "metro", args: "0.5", text: "metro 0.5" },
        { id: 2, type: "counter", args: "0 7", text: "counter 0 7" },
      ],
      [{ srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 }],
    ),
    run: (graph) => [0.3, 0.3, 0.3].map((dt) => { g.tickGraph(graph, dt); return graph.boxes.get(2).state.count; }),
  },
  {
    name: "tickGraph: delay fires once per delayed event",
    patch: buildPatch(
      [
        { id: 1, type: "event", args: "", text: "event" },
        { id: 2, type: "delay", args: "0.1", text: "delay 0.1" },
        { id: 3, type: "counter", args: "0 7", text: "counter 0 7" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
      ],
    ),
    run: (graph) => {
      g.propagateEvent(graph, 1, 0);
      return [0.05, 0.1, 0.1].map((dt) => { g.tickGraph(graph, dt); return graph.boxes.get(3).state.count; });
    },
  },

  // === event box, phasor once ===
  ...(["event", "value"] as const).map((kind) => ({
    name: `event box: ${kind} in → event out`,
    patch: buildPatch(
      [
        { id: 1, type: "metro", args: "0.5", text: "metro 0.5" },
        { id: 2, type: "event", args: "", text: "event" },
        { id: 3, type: "counter", args: "0 7", text: "counter 0 7" },
        { id: 4, type: "karplus-strong~", engine: true,
          paramNames: ["frequency", "decay", "brightness", "stiffness", "trigger", "amplitude"], messagePorts: new Set(["trigger"]) },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 0, dstBox: 3, dstInlet: 0 },
        { srcBox: 2, srcOutlet: 0, dstBox: 4, dstInlet: 4 },
      ],
    ),
    run: (graph: any) => kind === "event" ? g.propagateEvent(graph, 1, 0) : g.propagateValue(graph, 1, 0, 7),
  })),
  {
    name: "phasor once: finishes, pause inlet doesn't restart, reset does",
    patch: buildPatch(
      [
        { id: 1, type: "const", args: "0", text: "const 0" },
        { id: 2, type: "phasor", args: "1 once", text: "phasor 1 once" },
        { id: 3, type: "event", args: "", text: "event" },
      ],
      [
        { srcBox: 1, srcOutlet: 0, dstBox: 2, dstInlet: 2 },
        { srcBox: 3, srcOutlet: 0, dstBox: 2, dstInlet: 0 },
      ],
    ),
    run: (graph) => {
      const ph = graph.boxes.get(2).state;
      g.tickGraph(graph, 1.2);
      const finished = { ...ph };
      g.propagateValue(graph, 1, 0, 1); g.propagateValue(graph, 1, 0, 0);
      g.tickGraph(graph, 0.25);
      const afterPause = { ...ph };
      g.propagateEvent(graph, 3, 0);
      g.tickGraph(graph, 0.25);
      return { finished, afterPause, afterReset: { ...ph } };
    },
  },
];

// --- Run ---

function runAll(): Record<string, any> {
  const results: Record<string, any> = {};
  for (const c of cases) {
    try {
      const graph = g.buildGraph(withInletDefs(c.patch));
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
