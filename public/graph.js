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

function mergeUpdates(target, source) {
  for (const [eid, params] of Object.entries(source)) {
    if (!target[eid]) target[eid] = {};
    Object.assign(target[eid], params);
  }
}

// --- Graph ---

function buildGraph(patch) {
  const graph = {
    boxes: new Map(),
    entries: new Map(),
    engines: new Map(),
    envelopes: new Map(),
    wireless: new Map(),    // name -> { sends: [boxId], receives: [boxId], throws: [boxId], catches: [boxId] }
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

  // propagate const values through the full graph (including wireless)
  for (const [id, node] of graph.boxes) {
    if (node.type === "const") {
      const val = parseFloat(node.args) || 0;
      propagateInGraph(graph, id, 0, val);
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

// propagate a value from a box's outlet through the graph
function propagateInGraph(graph, boxId, outletIndex, value) {
  const node = graph.boxes.get(boxId);
  if (!node) return {};

  const updates = {};
  const deferred = [];

  for (const cable of node.outletCables) {
    if (cable.outlet !== outletIndex) continue;

    const dstNode = graph.boxes.get(cable.dstBox);
    if (!dstNode) continue;

    dstNode.inletValues[cable.dstInlet] = value;

    // Wireless send/throw: propagate to matching receives/catches
    if (dstNode.type === "send" || dstNode.type === "s") {
      const name = dstNode.args.trim();
      const w = graph.wireless.get(name);
      if (w) {
        for (const recvId of w.receives) {
          mergeUpdates(updates, propagateInGraph(graph, recvId, 0, value));
        }
      }
      continue;
    }
    if (dstNode.type === "throw") {
      const name = dstNode.args.trim();
      const w = graph.wireless.get(name);
      if (w) {
        for (const catchId of w.catches) {
          const catchNode = graph.boxes.get(catchId);
          if (catchNode) {
            catchNode.inletValues[0] = (catchNode.inletValues[0] || 0) + value;
            mergeUpdates(updates, propagateInGraph(graph, catchId, 0, catchNode.inletValues[0]));
          }
        }
      }
      continue;
    }

    if (graph.engines.has(cable.dstBox)) {
      const engine = graph.engines.get(cable.dstBox);
      const paramName = engine.paramNames[cable.dstInlet];
      if (paramName) {
        if (graphDebug) console.log(`  → engine box:${cable.dstBox} ${paramName}=${value}`);
        if (!updates[cable.dstBox]) updates[cable.dstBox] = {};
        updates[cable.dstBox][paramName] = value;
      }
    } else if (isEventTrigger(dstNode.type, cable.dstInlet)) {
      deferred.push(cable.dstBox);
    } else if (dstNode.type === "phasor") {
      // number inlets — store, don't propagate
    } else if ((dstNode.type === "slew" || dstNode.type === "lag") && cable.dstInlet === 0) {
      if (dstNode.state) {
        if (graphDebug) console.log(`  ${dstNode.type} box:${cable.dstBox} target=${value} (was ${dstNode.state.target})`);
        dstNode.state.target = value;
      }
    } else if (dstNode.type === "sample-hold" && cable.dstInlet === 0) {
      // store for sampling
    } else if (dstNode.type === "adsr" && cable.dstInlet === 0) {
      // gate — store for tick
    } else if (dstNode.type === "ar") {
      if (cable.dstInlet === 1 && dstNode.state) dstNode.state.attack = Math.max(0.001, value);
      if (cable.dstInlet === 2 && dstNode.state) dstNode.state.release = Math.max(0.001, value);
    } else if (dstNode.type === "seq" && cable.dstInlet >= 1) {
      // behaviour/values inlets
    } else if (dstNode.type === "sigmoid" && cable.dstInlet >= 1) {
      if (dstNode.state) {
        if (cable.dstInlet === 1) dstNode.state.start = value;
        if (cable.dstInlet === 2) dstNode.state.end = value;
        if (cable.dstInlet === 3) dstNode.state.duration = Math.max(0.001, value);
        if (cable.dstInlet === 4) dstNode.state.duty = value;
        if (cable.dstInlet === 5) dstNode.state.curve = value;
      }
    } else if (dstNode.type === "cosine" && cable.dstInlet >= 1) {
      if (dstNode.state) {
        if (cable.dstInlet === 1) dstNode.state.amplitude = value;
        if (cable.dstInlet === 2) dstNode.state.duration = Math.max(0.001, value);
        if (cable.dstInlet === 3) dstNode.state.duty = value;
        if (cable.dstInlet === 4) dstNode.state.curve = value;
      }
    } else {
      const result = evaluateNode(graph, cable.dstBox);
      if (graphDebug) console.log(`  eval box:${cable.dstBox} type:${dstNode.type} inlet[${cable.dstInlet}]=${value} iv=[${dstNode.inletValues}] → ${result}`);
      const further = propagateInGraph(graph, cable.dstBox, 0, result);
      for (const [eid, params] of Object.entries(further)) {
        if (!updates[eid]) updates[eid] = {};
        Object.assign(updates[eid], params);
      }
    }
  }

  // Phase 2: fire deferred event triggers
  for (const dstBoxId of deferred) {
    const further = handleEvent(graph, dstBoxId);
    for (const [eid, params] of Object.entries(further)) {
      if (!updates[eid]) updates[eid] = {};
      Object.assign(updates[eid], params);
    }
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

  // Multi-outlet output (e.g. fan)
  if (result.outputs) {
    let allUpdates = {};
    for (const { outlet, value } of result.outputs) {
      mergeUpdates(allUpdates, propagateInGraph(graph, boxId, outlet, value));
    }
    return allUpdates;
  }

  if (result.propagate) {
    return propagateInGraph(graph, boxId, 0, result.value);
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

    mergeUpdates(allUpdates, propagateInGraph(graph, id, 0, result.value));
    for (const outlet of result.events) {
      mergeUpdates(allUpdates, propagateInGraph(graph, id, outlet, 0));
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

  let allUpdates = {};
  for (const entry of entries) {
    const node = graph.boxes.get(entry.targetBox);
    if (!node) continue;

    node.inletValues[entry.targetInlet] = value;

    if (node.type === "phasor") {
      if (entry.targetInlet === 1 && node.state) {
        mergeUpdates(allUpdates, handleEvent(graph, entry.targetBox));
      }
      continue;
    } else if (isEventTrigger(node.type, entry.targetInlet)) {
      mergeUpdates(allUpdates, handleEvent(graph, entry.targetBox));
    } else if ((node.type === "range" || node.type === "drunk") && entry.targetInlet === 0) {
      if (node.state) {
        if (entry.targetInlet === 0) node.state.min = value;
        if (entry.targetInlet === 1) node.state.max = value;
      }
      mergeUpdates(allUpdates, propagateInGraph(graph, entry.targetBox, 0, evaluateNode(graph, entry.targetBox)));
    } else if (graph.engines.has(entry.targetBox)) {
      const engine = graph.engines.get(entry.targetBox);
      const paramName = engine.paramNames[entry.targetInlet];
      if (paramName) {
        if (!allUpdates[entry.targetBox]) allUpdates[entry.targetBox] = {};
        allUpdates[entry.targetBox][paramName] = value;
      }
    } else if (node.type === "send" || node.type === "s") {
      // Wireless send: forward to matching receives
      const name = node.args.trim();
      const w = graph.wireless.get(name);
      if (w) {
        for (const recvId of w.receives) {
          mergeUpdates(allUpdates, propagateInGraph(graph, recvId, 0, value));
        }
      }
    } else if (node.type === "throw") {
      const name = node.args.trim();
      const w = graph.wireless.get(name);
      if (w) {
        for (const catchId of w.catches) {
          const catchNode = graph.boxes.get(catchId);
          if (catchNode) {
            catchNode.inletValues[0] = (catchNode.inletValues[0] || 0) + value;
            mergeUpdates(allUpdates, propagateInGraph(graph, catchId, 0, catchNode.inletValues[0]));
          }
        }
      }
    } else {
      const result = evaluateNode(graph, entry.targetBox);
      const updates = propagateInGraph(graph, entry.targetBox, 0, result);
      mergeUpdates(allUpdates, updates);
    }
  }

  return allUpdates;
}

// process a router event message
function processRouterEvent(graph, routerId) {
  const entries = graph.entries.get(routerId);
  if (!entries) return {};

  let allUpdates = {};
  for (const entry of entries) {
    const updates = handleEvent(graph, entry.targetBox);
    mergeUpdates(allUpdates, updates);
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
