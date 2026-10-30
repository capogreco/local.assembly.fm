/**
 * Snapshot test for the server's one-side evaluation (eval-engine.ts): the
 * phones' graph.js with routers and one-side audio boxes as sinks.
 *
 * Stubs initEvalEngine deps with capturing mocks, fills the patch-state
 * globals with a test patch, builds the server graph (its initial values are
 * part of the snapshot), feeds it through the inject path (or the tick), and
 * snapshots the side effects: ctrl sends, synth broadcasts and sends, the
 * display values, each graph box's inlet values and state, router state.
 *
 * Usage:
 *   deno run --allow-read --allow-write tests/server_propagation_snapshot.ts capture
 *   deno run --allow-read --allow-write tests/server_propagation_snapshot.ts verify
 */

import {
  type Box,
  boxes, cables, boxValues,
  routerState, groupState, latestValues, uplinkIndex,
  setBorderY, getBorderY, clearPatchState, setDeployedPatch,
} from "../patch-state.ts";

import * as gpi from "../public/gpi-types.js";

// --- Capture state ---

interface Capture {
  ctrlSends: Array<Record<string, unknown>>;
  synthBroadcasts: Array<Record<string, unknown>>;
  clientSends: Array<{ clientId: number; msg: Record<string, unknown> }>;
  events: string[];
}

let capture: Capture;
function resetCapture(): void {
  capture = { ctrlSends: [], synthBroadcasts: [], clientSends: [], events: [] };
}

// --- Init eval-engine with stubbed deps ---

import {
  initEvalEngine, buildServerGraph, serverGraph, injectValue, injectEvent, setSourceValue,
  replayLaptopParams, tick,
} from "../eval-engine.ts";

initEvalEngine({
  broadcastSynth: (msg) => capture.synthBroadcasts.push(msg),
  sendToClient: (clientId, msg) => capture.clientSends.push({ clientId, msg }),
  getSynthClientIds: () => [101, 102, 103], // stable mock client ids
  sendCtrl: (msg) => capture.ctrlSends.push(msg),
  event: (msg) => capture.events.push(msg),
});

// --- Helpers for building patches ---

function reset(): void {
  clearPatchState();
  routerState.clear();
  groupState.clear();
  latestValues.clear();
  uplinkIndex.clear();
  setDeployedPatch(null);
  setBorderY(400);
  resetCapture();
}

// y defaults to the one side (border at 400).
function addBox(id: number, text: string, x = 0, y = 0): void {
  const ports = gpi.getBoxPorts(text);
  // Same stamp the server's apply runs.
  const box: Box = { x, y, text, inlets: ports.inlets, outlets: ports.outlets };
  box.side = gpi.sideOf(box, getBorderY());
  boxes.set(id, box);
}

function addCable(id: number, srcBox: number, srcOutlet: number, dstBox: number, dstInlet: number): void {
  cables.set(id, { srcBox, srcOutlet, dstBox, dstInlet });
}

// deno-lint-ignore no-explicit-any
function snapshot(): any {
  // deno-lint-ignore no-explicit-any
  const graphBoxes: any = {};
  for (const [id, node] of serverGraph().boxes) {
    graphBoxes[id] = { inletValues: [...node.inletValues], state: node.state ? JSON.parse(JSON.stringify(node.state)) : null };
  }
  return {
    capture,
    boxValues: Object.fromEntries(boxValues.entries()),
    graph: graphBoxes,
    routerState: Object.fromEntries(
      [...routerState.entries()].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])
    ),
    groupState: Object.fromEntries(groupState.entries()),
    latestValues: Object.fromEntries(latestValues.entries()),
  };
}

const ticks = (n: number) => { for (let i = 0; i < n; i++) tick(); };

// --- Test cases ---

type Case = { name: string; run: () => void };

const cases: Case[] = [
  {
    name: "const value to mtof at build",
    run: () => {
      reset();
      addBox(1, "const 60");
      addBox(2, "mtof");
      addCable(1, 1, 0, 2, 0);
      buildServerGraph();
    },
  },
  {
    name: "value through wireless send → receive",
    run: () => {
      reset();
      addBox(1, "knob 0.5");
      addBox(2, "send freq");
      addBox(3, "receive freq");
      addBox(4, "print");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 3, 0, 4, 0);
      buildServerGraph();
    },
  },
  {
    name: "value through wireless throw → catch (sums)",
    run: () => {
      reset();
      addBox(1, "knob 5");
      addBox(2, "throw bus");
      addBox(3, "catch bus");
      addBox(4, "+");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 3, 0, 4, 0);
      buildServerGraph();
      setSourceValue(1, 3); // second throw — catch sums to 8
    },
  },
  {
    name: "spigot blocks when gate=0",
    run: () => {
      reset();
      addBox(1, "knob 5");
      addBox(2, "spigot");
      addBox(3, "+ 10");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 0, 3, 0);
      buildServerGraph();
    },
  },
  {
    name: "spigot passes when gate=1",
    run: () => {
      reset();
      addBox(1, "knob 5");
      addBox(2, "spigot");
      addBox(3, "+ 10");
      addBox(4, "const 1");
      addCable(1, 4, 0, 2, 1);
      addCable(2, 1, 0, 2, 0);
      addCable(3, 2, 0, 3, 0);
      buildServerGraph();
      setSourceValue(1, 5);
    },
  },
  {
    name: "toggle inlet 1 flips on rising edge",
    run: () => {
      reset();
      addBox(1, "knob 0");
      addBox(2, "toggle");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 1);
      addCable(2, 2, 0, 3, 0);
      buildServerGraph();
      setSourceValue(1, 1);
    },
  },
  {
    name: "change passes only on diff",
    run: () => {
      reset();
      addBox(1, "knob 5");
      addBox(2, "change");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 0, 3, 0);
      buildServerGraph(); // first: prev=undefined, fires
      setSourceValue(1, 5); // same: does not fire
      setSourceValue(1, 7); // diff: fires
    },
  },
  {
    name: "adsr: release inlet maps to state, gate inlet is stored",
    run: () => {
      reset();
      addBox(1, "const 0.7");
      addBox(2, "adsr 0.05 0.1 0.7 0.3");
      addBox(3, "knob 0");
      addCable(1, 1, 0, 2, 4);
      addCable(2, 3, 0, 2, 0);
      buildServerGraph();
      setSourceValue(3, 1);
      ticks(2);
    },
  },
  {
    name: "seq inlet 2 receives an array",
    run: () => {
      reset();
      addBox(1, "held");
      addBox(2, "seq 0 asc");
      addCable(1, 1, 0, 2, 2);
      buildServerGraph();
      injectValue(1, 0, [60, 64, 67]); // as if held output an array
    },
  },
  {
    name: "seq inlet 0: an event advances it",
    run: () => {
      reset();
      addBox(1, "metro 0.1");
      addBox(2, "seq 1 2 3 asc");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 0, 3, 0);
      buildServerGraph();
      injectEvent(1, 0);
      injectEvent(1, 0);
    },
  },
  {
    name: "held: pitch on inlet 0, velocity on inlet 1 fires",
    run: () => {
      reset();
      addBox(1, "key");
      addBox(2, "held");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 0); // pitch
      addCable(2, 1, 1, 2, 1); // velocity
      addCable(3, 2, 0, 3, 0); // held array out
      buildServerGraph();
      injectValue(1, 0, 60);
      injectValue(1, 1, 100 / 127);
    },
  },
  {
    name: "router all: initial value broadcast and kept for joiners",
    run: () => {
      reset();
      addBox(1, "const 440");
      addBox(2, "all 1", 100, 389); // router (border)
      addBox(10, "karplus-strong~", 100, 500); // many side: not in the server graph
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 0, 10, 0);
      buildServerGraph();
    },
  },
  {
    name: "* hot recompute and propagate",
    run: () => {
      reset();
      addBox(1, "knob 5");
      addBox(2, "* 2");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 0, 3, 0);
      buildServerGraph();
    },
  },
  {
    name: "+ cold inlet 1 stores without re-eval",
    run: () => {
      reset();
      addBox(1, "knob 3");
      addBox(2, "+");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 1); // cold inlet
      addCable(2, 2, 0, 3, 0);
      buildServerGraph();
    },
  },

  // === routers as sinks ===
  {
    name: "select → all: a match goes out as re, a reject as rv",
    run: () => {
      reset();
      addBox(1, "knob 0");
      addBox(2, "select 60 62");
      addBox(3, "all 2", 0, 389);
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 1, 3, 0);
      addCable(3, 2, 2, 3, 1);
      buildServerGraph();
      resetCapture();
      setSourceValue(1, 62);
      setSourceValue(1, 99);
    },
  },
  {
    name: "one 1 fed by one outlet on data and fire: data lands first",
    run: () => {
      reset();
      addBox(1, "knob 0");
      addBox(2, "one 1", 0, 389);
      addCable(1, 1, 0, 2, 1); // fire, cabled first
      addCable(2, 1, 0, 2, 0); // data
      buildServerGraph();
      resetCapture();
      setSourceValue(1, 7);
    },
  },
  {
    name: "sall feeds the one side's r and broadcasts; metro event goes out as re",
    run: () => {
      reset();
      addBox(1, "knob 0");
      addBox(2, "sall freq beat", 0, 389);
      addBox(3, "r freq");
      addBox(4, "print");
      addBox(5, "metro 0.1");
      addBox(6, "r beat");
      addBox(7, "counter 0 7");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 3, 0, 4, 0);
      addCable(3, 5, 0, 2, 1);
      addCable(4, 6, 0, 7, 0);
      buildServerGraph();
      resetCapture();
      setSourceValue(1, 3);
      injectEvent(5, 0);
    },
  },
  {
    name: "one-side audio: params and events go to the laptop, params replay",
    run: () => {
      reset();
      addBox(1, "const 220");
      addBox(2, "sine-osc~");
      addBox(3, "event");
      addBox(4, "trig~");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 3, 0, 4, 0);
      buildServerGraph();
      injectEvent(3, 0); // as an event-click
      replayLaptopParams();
    },
  },

  {
    name: "replay to joiners: all and sall values only (D3)",
    run: () => {
      reset();
      addBox(1, "knob 0.5");
      addBox(2, "all 1", 0, 389);
      addBox(3, "one", 0, 389);
      addBox(4, "sweep", 0, 389);
      addBox(5, "sall x", 0, 389);
      for (const [c, r] of [[1, 2], [2, 3], [3, 4], [4, 5]]) addCable(c, 1, 0, r, 0);
      buildServerGraph();
    },
  },

  // === the tick and the phone semantics ===
  {
    name: "tick: metro fires once per interval",
    run: () => {
      reset();
      addBox(1, "metro 0.01");
      addBox(2, "counter 0 99");
      addCable(1, 1, 0, 2, 0);
      buildServerGraph();
      ticks(5); // 5/240 s ≈ 0.021 s: two intervals
    },
  },
  {
    name: "tick: delay fires once per delayed event",
    run: () => {
      reset();
      addBox(1, "event");
      addBox(2, "delay 0.01");
      addBox(3, "counter 0 99");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 0, 3, 0);
      buildServerGraph();
      injectEvent(1, 0);
      ticks(5);
    },
  },
  {
    name: "breath: gate fires on threshold crossings only",
    run: () => {
      reset();
      addBox(1, "breath");
      addBox(2, "print");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 1, 1, 3, 0);
      buildServerGraph();
      setSourceValue(1, 0.5);
      setSourceValue(1, 0.6);
      setSourceValue(1, 0);
    },
  },
];

// --- Run ---

function runAll(): Record<string, any> {
  const results: Record<string, any> = {};
  for (const c of cases) {
    try {
      c.run();
      results[c.name] = snapshot();
    } catch (e) {
      results[c.name] = { error: String(e) };
    }
  }
  return results;
}

const mode = Deno.args[0] || "capture";
const baselinePath = "tests/server_propagation_baseline.json";

if (mode === "capture") {
  const results = runAll();
  await Deno.writeTextFile(baselinePath, JSON.stringify(results, null, 2));
  console.log(`Captured ${Object.keys(results).length} cases → ${baselinePath}`);
  Deno.exit(0);
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
  Deno.exit(fail > 0 ? 1 : 0);
} else {
  console.error(`Unknown mode: ${mode}. Use 'capture' or 'verify'.`);
  Deno.exit(1);
}
