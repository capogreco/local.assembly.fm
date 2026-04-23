/**
 * Differential snapshot test for the server-side propagation harness in
 * eval-engine.ts. Mirrors tests/propagation_snapshot.ts but for the server.
 *
 * Stubs initEvalEngine deps with capturing mocks, populates the patch-state
 * globals to inject test patches, calls propagateAndNotify, and snapshots
 * the resulting side effects (queueValueUpdate, broadcastSynth, sendCtrl,
 * sendToClient, mutations to boxValues / inletValues / boxState / routerState).
 *
 * Run before refactor → save baseline.
 * Run after refactor → compare to baseline; any diff is a regression.
 *
 * Usage:
 *   deno run --allow-read --allow-write tests/server_propagation_snapshot.ts capture
 *   deno run --allow-read --allow-write tests/server_propagation_snapshot.ts verify
 */

import {
  type Box,
  boxes, cables, boxValues, inletValues, boxState,
  routerState, groupState, latestValues, uplinkIndex,
  setSynthBorderY, clearPatchState, setDeployedPatch,
} from "../patch-state.ts";

// gpi-types.js and graph-core.js are CJS-style; load via the same importCjs
// pattern the server uses.
// deno-lint-ignore no-explicit-any
function importCjs(src: string): any {
  const obj: Record<string, unknown> = {};
  const cjs = src.replace(/^export\s+\{[^}]*\};?\s*$/m, "");
  new Function("exports", cjs)(obj);
  return obj;
}

const gpi: any = importCjs(await Deno.readTextFile("./public/gpi-types.js"));
const gc: any = importCjs(await Deno.readTextFile("./public/graph-core.js"));

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

import { initEvalEngine, propagateAndNotify, initBoxState, shouldServerEval, queueValueUpdate } from "../eval-engine.ts";

initEvalEngine({
  broadcastSynth: (msg) => capture.synthBroadcasts.push(msg),
  sendToClient: (clientId, msg) => capture.clientSends.push({ clientId, msg }),
  getSynthClientIds: () => [101, 102, 103], // stable mock client ids
  sendCtrl: (msg) => capture.ctrlSends.push(msg),
  event: (msg) => capture.events.push(msg),
  boxTypeName: gpi.boxTypeName,
  getBoxDef: gpi.getBoxDef,
  getBoxZone: gpi.getBoxZone,
  isAudioBox: gpi.isAudioBox,
  evaluatePure: gc.evaluatePure,
  createBoxState: gc.createBoxState,
  tickBox: gc.tickBox,
  handleBoxEvent: gc.handleBoxEvent,
  applyInletToState: gc.applyInletToState,
  deliverValueToInlet: gc.deliverValueToInlet,
});

// --- Helpers for building patches ---

function reset(): void {
  clearPatchState();
  routerState.clear();
  groupState.clear();
  latestValues.clear();
  uplinkIndex.clear();
  setDeployedPatch(null);
  setSynthBorderY(400);
  resetCapture();
}

function addBox(id: number, text: string, x = 0, y = 0): void {
  const def = gpi.getBoxDef(text);
  const ports = def ? gpi.getBoxPorts(text) : { inlets: 1, outlets: 1 };
  boxes.set(id, { x, y, text, inlets: ports.inlets, outlets: ports.outlets });
  if (shouldServerEval({ x, y, text, inlets: ports.inlets, outlets: ports.outlets } as Box)) {
    initBoxState(id, boxes.get(id)!);
  }
}

function addCable(id: number, srcBox: number, srcOutlet: number, dstBox: number, dstInlet: number): void {
  cables.set(id, { srcBox, srcOutlet, dstBox, dstInlet });
}

function snapshot(): any {
  // Capture all observable side effects as a JSON-serializable object.
  return {
    capture,
    boxValues: Object.fromEntries(boxValues.entries()),
    inletValues: Object.fromEntries(
      [...inletValues.entries()].map(([k, v]) => [k, [...v]])
    ),
    boxState: Object.fromEntries(
      [...boxState.entries()].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])
    ),
    routerState: Object.fromEntries(
      [...routerState.entries()].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])
    ),
    groupState: Object.fromEntries(groupState.entries()),
    latestValues: Object.fromEntries(latestValues.entries()),
  };
}

// --- Test cases ---

type Case = { name: string; run: () => void };

const cases: Case[] = [
  {
    name: "propagate const value to mtof",
    run: () => {
      reset();
      addBox(1, "const 60");
      addBox(2, "mtof");
      addCable(1, 1, 0, 2, 0);
      // const evaluates statically — propagate its initial value
      propagateAndNotify(1, 0, 60);
    },
  },
  {
    name: "propagate value to wireless send → receive",
    run: () => {
      reset();
      addBox(1, "const 0.5");
      addBox(2, "send freq");
      addBox(3, "receive freq");
      addBox(4, "print");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 3, 0, 4, 0);
      propagateAndNotify(1, 0, 0.5);
    },
  },
  {
    name: "propagate value through wireless throw → catch (sums)",
    run: () => {
      reset();
      addBox(1, "const 5");
      addBox(2, "throw bus");
      addBox(3, "catch bus");
      addBox(4, "+");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 3, 0, 4, 0);
      propagateAndNotify(1, 0, 5);
      propagateAndNotify(1, 0, 3); // second throw — should sum to 8 in catch
    },
  },
  {
    name: "spigot blocks when gate=0",
    run: () => {
      reset();
      addBox(1, "const 5");
      addBox(2, "spigot");
      addBox(3, "+ 10");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 0, 3, 0);
      // gate inlet 1 stays 0
      propagateAndNotify(1, 0, 5);
    },
  },
  {
    name: "spigot passes when gate=1",
    run: () => {
      reset();
      addBox(1, "const 5");
      addBox(2, "spigot");
      addBox(3, "+ 10");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 0, 3, 0);
      // set gate first
      const sp = inletValues.get(2) || [];
      inletValues.set(2, sp);
      sp[1] = 1;
      propagateAndNotify(1, 0, 5);
    },
  },
  {
    name: "toggle inlet 1 flips on rising edge",
    run: () => {
      reset();
      addBox(1, "const 1");
      addBox(2, "toggle");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 1);
      addCable(2, 2, 0, 3, 0);
      propagateAndNotify(1, 0, 1);
    },
  },
  {
    name: "change passes only on diff",
    run: () => {
      reset();
      addBox(1, "const 5");
      addBox(2, "change");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 0, 3, 0);
      propagateAndNotify(1, 0, 5); // first: prev=undefined, fires
      propagateAndNotify(1, 0, 5); // same: should NOT fire
      propagateAndNotify(1, 0, 7); // diff: fires
    },
  },
  {
    name: "applyInletToState on adsr release",
    run: () => {
      reset();
      addBox(1, "const 0.7");
      addBox(2, "adsr 0.05 0.1 0.7 0.3");
      addCable(1, 1, 0, 2, 4);
      propagateAndNotify(1, 0, 0.7);
    },
  },
  {
    name: "seq inlet 2 receives array (preserved through propagation)",
    run: () => {
      reset();
      addBox(1, "held");
      addBox(2, "seq 0 asc");
      addCable(1, 1, 0, 2, 2);
      // simulate held outputting an array on outlet 0
      propagateAndNotify(1, 0, [60, 64, 67]);
    },
  },
  {
    name: "seq inlet 0 trigger advances",
    run: () => {
      reset();
      addBox(1, "metro 0.1");
      addBox(2, "seq 1 2 3 asc");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 0, 3, 0);
      propagateAndNotify(1, 0, 0); // metro fires with value 0
      propagateAndNotify(1, 0, 0); // again
    },
  },
  {
    name: "held: pitch on inlet 0, velocity on inlet 1 fires event",
    run: () => {
      reset();
      addBox(1, "key");
      addBox(2, "held");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 0); // pitch
      addCable(2, 1, 1, 2, 1); // velocity
      addCable(3, 2, 0, 3, 0); // held array out
      propagateAndNotify(1, 0, 60); // pitch=60
      propagateAndNotify(1, 1, 100); // velocity=100 (note on)
    },
  },
  {
    name: "router all → engine paramName",
    run: () => {
      reset();
      addBox(1, "const 440");
      addBox(2, "all 1", 100, 350); // ctrl-side router
      addBox(10, "karplus-strong~", 100, 500); // synth-side
      addCable(1, 1, 0, 2, 0);
      // router entry would be added during patch deploy; simulate by
      // calling propagateAndNotify which routes via handleRouterInlet
      propagateAndNotify(1, 0, 440);
    },
  },
  {
    name: "* hot recompute and propagate",
    run: () => {
      reset();
      addBox(1, "const 5");
      addBox(2, "* 2");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 0);
      addCable(2, 2, 0, 3, 0);
      propagateAndNotify(1, 0, 5);
    },
  },
  {
    name: "+ cold inlet 1 stores without re-eval",
    run: () => {
      reset();
      addBox(1, "const 3");
      addBox(2, "+");
      addBox(3, "print");
      addCable(1, 1, 0, 2, 1); // cold inlet
      addCable(2, 2, 0, 3, 0);
      propagateAndNotify(1, 0, 3);
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
  // eval-engine.ts starts a setInterval tick loop; force-exit to avoid hang.
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
