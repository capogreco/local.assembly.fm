/**
 * Graph Evaluator — runs synth-side logic graph on each phone
 *
 * Receives a patch definition (boxes + cables + entries),
 * builds a local evaluation graph, and processes incoming
 * router values to produce engine parameter updates.
 *
 * Pure evaluation logic (state creation, math, ticking) lives in graph-core.js.
 */

// --- Debug ---
let graphDebug = false;
function enableGraphDebug() { graphDebug = true; console.log("graph debug ON"); }
function disableGraphDebug() { graphDebug = false; }

// --- Helpers ---
// `mergeUpdates` and `deliverEventToInlet` are shared from graph-core.js
// (loaded as globals before this script).

// --- Graph ---

function buildGraph(patch) {
  const graph = {
    boxes: new Map(),
    entries: new Map(),
    engines: new Map(),
    envelopes: new Map(),
    wireless: new Map(),    // name -> { sends: [boxId], receives: [boxId], throws: [boxId], catches: [boxId] }
    uplinkQueue: [],        // collected { ch, v } messages for sendup → server
  };

  for (const box of patch.boxes) {
    const node = {
      type: box.type,
      args: box.args || "",
      inletValues: [],
      state: createBoxState(box.type, box.args || "", patch.instanceIndex || 0, patch.instanceCount || 1),
      outletCables: [],
    };
    graph.boxes.set(box.id, node);
  }

  for (const cable of patch.cables) {
    const srcNode = graph.boxes.get(cable.srcBox);
    if (srcNode) {
      srcNode.outletCables.push({
        outlet: cable.srcOutlet,
        dstBox: cable.dstBox,
        dstInlet: cable.dstInlet,
      });
    }
  }

  for (const entry of patch.entries) {
    const key = entry.routerId + ":" + (entry.routerOutlet || 0);
    if (!graph.entries.has(key)) graph.entries.set(key, []);
    graph.entries.get(key).push({
      targetBox: entry.targetBox,
      targetInlet: entry.targetInlet,
    });
  }

  for (const box of patch.boxes) {
    if (box.engine) {
      graph.engines.set(box.id, {
        type: box.type,
        args: box.args || "",
        paramNames: box.paramNames || [],
      });
    }
  }

  // build wireless send/receive map
  const wirelessTypes = { send: "sends", s: "sends", receive: "receives", r: "receives",
                          throw: "throws", catch: "catches" };
  for (const [id, node] of graph.boxes) {
    const role = wirelessTypes[node.type];
    if (!role) continue;
    const name = node.args.trim();
    if (!name) continue;
    if (!graph.wireless.has(name)) graph.wireless.set(name, { sends: [], receives: [], throws: [], catches: [] });
    graph.wireless.get(name)[role].push(id);
  }

  // propagate initial values from all boxes with deterministic state
  for (const [id, node] of graph.boxes) {
    if (node.state && node.state.value !== undefined) {
      propagateValue(graph, id, 0, node.state.value);
    }
  }

  return graph;
}

// evaluate a single box and return its output value
function evaluateNode(graph, boxId) {
  const node = graph.boxes.get(boxId);
  if (!node) return 0;

  const args = node.args.split(/\s+/).filter(Boolean);

  // try pure evaluation first
  const pureResult = evaluatePure(node.type, args, node.inletValues);
  if (pureResult !== null) return pureResult;

  // try stateful read
  if (node.state) {
    const statefulResult = evaluateStateful(node.type, node.state);
    if (statefulResult !== null) return statefulResult;
  }

  return node.inletValues[0] || 0; // passthrough
}

// Client-side value-path helpers — same shape as event helpers above but
// capturing propagateValue + evaluateNode for the shared dispatch's recursion.
const _clientValueHelpers = {
  propagateValue: (graph, boxId, outlet, value) => propagateValue(graph, boxId, outlet, value),
  evaluateNode: (graph, boxId) => evaluateNode(graph, boxId),
  get debug() { return graphDebug; },
};

// propagate a value from a box's outlet through the graph
function propagateValue(graph, boxId, outletIndex, value) {
  const node = graph.boxes.get(boxId);
  if (!node) return {};

  const updates = {};
  const deferred = [];

  for (const cable of node.outletCables) {
    if (cable.outlet !== outletIndex) continue;
    if (!graph.boxes.has(cable.dstBox)) continue;

    const r = deliverValueToInlet(graph, cable.dstBox, cable.dstInlet, value, _clientValueHelpers);
    mergeUpdates(updates, r.updates);
    if (r.deferEvent) deferred.push(cable.dstBox);
  }

  // fire deferred event triggers (cable path: defer until all cold-inlet
  // stores in this batch have landed, so handleEvent sees consistent iv)
  for (const dstBoxId of deferred) {
    mergeUpdates(updates, handleEvent(graph, dstBoxId));
  }

  return updates;
}

// Client-side event-path helpers object passed into the shared dispatch.
// Captures graph.js's recursion stack so deliverEventToInlet can call back in.
const _clientEventHelpers = {
  propagateEvent: (graph, boxId, outlet) => propagateEvent(graph, boxId, outlet),
  handleEvent: (graph, boxId) => handleEvent(graph, boxId),
  get debug() { return graphDebug; },
};

// propagate a null event from a box's outlet through the graph
function propagateEvent(graph, boxId, outletIndex) {
  const node = graph.boxes.get(boxId);
  if (!node) return {};

  const updates = {};

  for (const cable of node.outletCables) {
    if (cable.outlet !== outletIndex) continue;
    if (!graph.boxes.has(cable.dstBox)) continue;
    mergeUpdates(updates, deliverEventToInlet(graph, cable.dstBox, cable.dstInlet, _clientEventHelpers));
  }

  return updates;
}

// handle a null event (trigger) arriving at a box
function handleEvent(graph, boxId) {
  const node = graph.boxes.get(boxId);
  if (!node) return {};

  if (!node.state) return {};

  const result = handleBoxEvent(node.type, node.state, node.inletValues);
  if (!result) return {};

  if (graphDebug) console.log(`  event box:${boxId} type:${node.type} → ${result.value}`);

  // Multi-outlet typed output (e.g. fan, trigger, select, swap)
  if (result.outputs) {
    let allUpdates = {};
    for (const out of result.outputs) {
      if (out.type === "event") {
        mergeUpdates(allUpdates, propagateEvent(graph, boxId, out.outlet));
      } else {
        mergeUpdates(allUpdates, propagateValue(graph, boxId, out.outlet, out.value));
      }
    }
    return allUpdates;
  }

  if (result.propagate) {
    return propagateValue(graph, boxId, 0, result.value);
  }
  return {};
}

// tick time-based boxes — call at ~60Hz from the client
function tickGraph(graph, dt) {
  const allUpdates = {};
  for (const [id, node] of graph.boxes) {
    if (!node.state) continue;

    const result = tickBox(node.type, node.state, node.inletValues, dt);
    if (!result) continue;

    // Event-typed outlet 0 (e.g. metro): tick value is display-only, only propagate events
    if (isEventOutlet(node.type, 0)) {
      for (const outlet of result.events) {
        mergeUpdates(allUpdates, propagateEvent(graph, id, outlet));
      }
    } else {
      mergeUpdates(allUpdates, propagateValue(graph, id, 0, result.value));
      for (const outlet of result.events) {
        mergeUpdates(allUpdates, propagateEvent(graph, id, outlet));
      }
    }
  }
  return allUpdates;
}

// process a router value message
function processRouterValue(graph, routerId, channel, value) {
  const key = routerId + ":" + (channel || 0);
  const entries = graph.entries.get(key);
  if (!entries) return {};

  if (graphDebug) console.log(`rv r:${routerId} ch:${channel} v:${value} → ${entries.length} entries`);

  const allUpdates = {};
  for (const entry of entries) {
    const node = graph.boxes.get(entry.targetBox);
    if (!node) continue;

    // Router-specific: phasor inlet 0 fires handleEvent immediately
    // (cable path defers via isEventTrigger; net effect identical).
    if (node.type === "phasor" && entry.targetInlet === 0) {
      node.inletValues[entry.targetInlet] = value;
      if (node.state) mergeUpdates(allUpdates, handleEvent(graph, entry.targetBox));
      continue;
    }

    // Router-specific: range/drunk inlets 0/1 set min/max then re-emit
    // evaluated value. Cable path doesn't update min/max — preserved divergence.
    if ((node.type === "range" || node.type === "drunk") && (entry.targetInlet === 0 || entry.targetInlet === 1)) {
      node.inletValues[entry.targetInlet] = value;
      if (node.state) {
        if (entry.targetInlet === 0) node.state.min = value;
        if (entry.targetInlet === 1) node.state.max = value;
      }
      mergeUpdates(allUpdates, propagateValue(graph, entry.targetBox, 0, evaluateNode(graph, entry.targetBox)));
      continue;
    }

    // Router-specific: engine paramName writes go through directly, allowing
    // any paramName including trigger/gate. The shared helper skips
    // trigger/gate for values; the router historically did not.
    if (graph.engines.has(entry.targetBox)) {
      node.inletValues[entry.targetInlet] = value;
      const engine = graph.engines.get(entry.targetBox);
      const paramName = engine.paramNames[entry.targetInlet];
      if (paramName) {
        if (!allUpdates[entry.targetBox]) allUpdates[entry.targetBox] = {};
        allUpdates[entry.targetBox][paramName] = value;
      }
      continue;
    }

    // Shared dispatch. Router policy: if helper signals deferEvent, fire
    // handleEvent IMMEDIATELY (not deferred — each router entry is its own
    // delivery, no batched cable group to flush).
    const r = deliverValueToInlet(graph, entry.targetBox, entry.targetInlet, value, _clientValueHelpers);
    mergeUpdates(allUpdates, r.updates);
    if (r.deferEvent) mergeUpdates(allUpdates, handleEvent(graph, entry.targetBox));
  }

  return allUpdates;
}

// process a router event message
function processRouterEvent(graph, routerId, channel) {
  const key = routerId + ":" + (channel || 0);
  const entries = graph.entries.get(key);
  if (!entries) return {};

  const allUpdates = {};
  for (const entry of entries) {
    if (!graph.boxes.has(entry.targetBox)) continue;
    mergeUpdates(allUpdates, deliverEventToInlet(graph, entry.targetBox, entry.targetInlet, _clientEventHelpers));
  }
  return allUpdates;
}

// process an envelope command
function processRouterEnvelope(graph, msg) {
  const key = msg.r + ":" + (msg.ch || 0);

  if (msg.gate === 0) {
    const env = graph.envelopes.get(key);
    if (env && env.type === "adsr") {
      env.gateOpen = false;
      if (env.phase !== "idle") { env.phase = "release"; env.elapsed = 0; }
    }
    return {};
  }

  if (msg.env === "adsr") {
    graph.envelopes.set(key, {
      type: "adsr", a: msg.params.a, d: msg.params.d, s: msg.params.s, r: msg.params.r,
      value: 0, phase: "attack", elapsed: 0, gateOpen: true,
    });
  } else if (msg.env === "ar") {
    graph.envelopes.set(key, {
      type: "ar", attack: msg.params.attack, release: msg.params.release,
      value: 0, phase: "attack", elapsed: 0,
    });
  } else if (msg.env === "ramp") {
    graph.envelopes.set(key, {
      type: "ramp", from: msg.params.from, to: msg.params.to, duration: msg.params.duration,
      value: msg.params.from, phase: "running", elapsed: 0,
    });
  } else if (msg.env === "phasor") {
    if (msg.paused) {
      const env = graph.envelopes.get(key);
      if (env && env.type === "phasor") env.paused = true;
    } else {
      const existing = graph.envelopes.get(key);
      if (existing && existing.type === "phasor" && !msg.reset) {
        existing.period = msg.params.period;
        existing.loop = msg.params.loop;
        existing.paused = false;
      } else {
        graph.envelopes.set(key, {
          type: "phasor", period: msg.params.period, loop: msg.params.loop,
          phase: 0, paused: false,
        });
      }
    }
  }

  return {};
}

// process a slew/lag command
function processRouterSlew(graph, msg) {
  const key = msg.r + ":" + (msg.ch || 0);
  const existing = graph.envelopes.get(key);
  const currentValue = existing ? existing.value : msg.v;

  graph.envelopes.set(key, {
    type: msg.type === "rv-slew" ? "slew" : "lag",
    target: msg.v, time: msg.time, value: currentValue,
  });

  return {};
}

// tick envelope commands — uses tickBox for shared math
function tickEnvelopes(graph, dt) {
  const allUpdates = {};

  for (const [key, env] of graph.envelopes) {
    const [routerId, channel] = key.split(":").map(Number);

    // envelope state uses the same shapes as box state — use tickBox
    const result = tickBox(env.type, env, [], dt);
    if (result) {
      const updates = processRouterValue(graph, routerId, channel, result.value);
      mergeUpdates(allUpdates, updates);
    }
  }

  return allUpdates;
}
