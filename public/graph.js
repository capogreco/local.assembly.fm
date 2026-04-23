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

// propagate a value from a box's outlet through the graph
function propagateValue(graph, boxId, outletIndex, value) {
  const node = graph.boxes.get(boxId);
  if (!node) return {};

  const updates = {};
  const deferred = [];

  for (const cable of node.outletCables) {
    if (cable.outlet !== outletIndex) continue;

    const dstNode = graph.boxes.get(cable.dstBox);
    if (!dstNode) continue;

    dstNode.inletValues[cable.dstInlet] = value;

    // Wireless send/throw: forward as value
    if (dstNode.type === "send" || dstNode.type === "s") {
      const name = dstNode.args.trim();
      const w = graph.wireless.get(name);
      if (w) {
        for (const recvId of w.receives) {
          mergeUpdates(updates, propagateValue(graph, recvId, 0, value));
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
            mergeUpdates(updates, propagateValue(graph, catchId, 0, catchNode.inletValues[0]));
          }
        }
      }
      continue;
    }
    // Uplink send: queue value for server
    if (dstNode.type === "sendup") {
      const names = dstNode.args.split(/\s+/).filter(Boolean);
      const chName = names[cable.dstInlet];
      if (chName) graph.uplinkQueue.push({ ch: chName, v: value });
      continue;
    }
    // Display/sensor sinks: store value, handled by layer manager
    if (dstNode.type === "screen" || dstNode.type === "text" || dstNode.type === "touch") {
      continue;
    }

    if (graph.engines.has(cable.dstBox)) {
      const engine = graph.engines.get(cable.dstBox);
      const paramName = engine.paramNames[cable.dstInlet];
      if (paramName) {
        // values never fire trigger/gate — only events do
        if (paramName === "trigger" || paramName === "gate") continue;
        if (graphDebug) console.log(`  → engine box:${cable.dstBox} ${paramName}=${value}`);
        if (!updates[cable.dstBox]) updates[cable.dstBox] = {};
        updates[cable.dstBox][paramName] = value;
      }
    } else if (isEventTrigger(dstNode.type, cable.dstInlet)) {
      deferred.push(cable.dstBox);
    } else if (firesEvent(dstNode.type, cable.dstInlet)) {
      deferred.push(cable.dstBox);
    } else {
      if (dstNode.type === "phasor") {
        // number inlets — store, don't propagate
      } else if (dstNode.type === "sample-hold" && cable.dstInlet === 0) {
        // store for sampling
      } else if (dstNode.type === "adsr" && cable.dstInlet === 0) {
        // gate stored for tick loop
      } else if (dstNode.type === "seq" && cable.dstInlet >= 1) {
        // behaviour/values inlets — store only
      } else if (dstNode.state && applyInletToState(dstNode.type, dstNode.state, cable.dstInlet, value)) {
        // handled by data-driven inlet map
      } else if (dstNode.type === "toggle" && cable.dstInlet === 1) {
        if (dstNode.state) {
          const newVal = value > 0 ? 1 : 0;
          if (newVal !== dstNode.state.value) {
            dstNode.state.value = newVal;
            mergeUpdates(updates, propagateValue(graph, cable.dstBox, 0, dstNode.state.value));
          }
        }
      } else if (dstNode.type === "map") {
        if (dstNode.state) {
          if (cable.dstInlet === 1 && Array.isArray(value)) {
            dstNode.state.table = value;
          } else if (cable.dstInlet === 0) {
            const t = dstNode.state.table;
            const idx = Math.max(0, Math.min(t.length - 1, Math.floor(value)));
            mergeUpdates(updates, propagateValue(graph, cable.dstBox, 0, t[idx] !== undefined ? t[idx] : 0));
          }
        }
      } else if (dstNode.type === "change") {
        if (dstNode.state && value !== dstNode.state.prev) {
          dstNode.state.prev = value;
          mergeUpdates(updates, propagateValue(graph, cable.dstBox, 0, value));
        }
      } else {
        // Pure math / passthrough — hot/cold check
        if (dstNode.type === "spigot" && (dstNode.inletValues[1] || 0) <= 0) continue;
        if (!isHotInlet(dstNode.type, cable.dstInlet, dstNode.args)) continue; // cold inlet: stored, no eval

        const result = evaluateNode(graph, cable.dstBox);
        if (graphDebug) console.log(`  eval box:${cable.dstBox} type:${dstNode.type} inlet[${cable.dstInlet}]=${value} iv=[${dstNode.inletValues}] → ${result}`);
        mergeUpdates(updates, propagateValue(graph, cable.dstBox, 0, result));
      }
    }
  }

  // fire deferred event triggers
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

// propagate an event (bang) from a box's outlet through the graph
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

  let allUpdates = {};
  for (const entry of entries) {
    const node = graph.boxes.get(entry.targetBox);
    if (!node) continue;

    node.inletValues[entry.targetInlet] = value;

    if (node.type === "phasor") {
      if (entry.targetInlet === 0 && node.state) {
        mergeUpdates(allUpdates, handleEvent(graph, entry.targetBox));
      }
      continue;
    } else if (isEventTrigger(node.type, entry.targetInlet)) {
      mergeUpdates(allUpdates, handleEvent(graph, entry.targetBox));
    } else if (firesEvent(node.type, entry.targetInlet)) {
      mergeUpdates(allUpdates, handleEvent(graph, entry.targetBox));
    } else {
      if ((node.type === "range" || node.type === "drunk") && entry.targetInlet === 0) {
        if (node.state) {
          if (entry.targetInlet === 0) node.state.min = value;
          if (entry.targetInlet === 1) node.state.max = value;
        }
        mergeUpdates(allUpdates, propagateValue(graph, entry.targetBox, 0, evaluateNode(graph, entry.targetBox)));
      } else if (graph.engines.has(entry.targetBox)) {
        const engine = graph.engines.get(entry.targetBox);
        const paramName = engine.paramNames[entry.targetInlet];
        if (paramName) {
          if (!allUpdates[entry.targetBox]) allUpdates[entry.targetBox] = {};
          allUpdates[entry.targetBox][paramName] = value;
        }
      } else if (node.type === "send" || node.type === "s") {
        const name = node.args.trim();
        const w = graph.wireless.get(name);
        if (w) {
          for (const recvId of w.receives) {
            mergeUpdates(allUpdates, propagateValue(graph, recvId, 0, value));
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
              mergeUpdates(allUpdates, propagateValue(graph, catchId, 0, catchNode.inletValues[0]));
            }
          }
        }
      } else if (node.type === "toggle" && entry.targetInlet === 1) {
        if (node.state) {
          const newVal = value > 0 ? 1 : 0;
          if (newVal !== node.state.value) {
            node.state.value = newVal;
            mergeUpdates(allUpdates, propagateValue(graph, entry.targetBox, 0, node.state.value));
          }
        }
      } else if (node.type === "sendup") {
        const names = node.args.split(/\s+/).filter(Boolean);
        const chName = names[entry.targetInlet];
        if (chName) graph.uplinkQueue.push({ ch: chName, v: value });
      } else if (node.type === "map") {
        if (node.state) {
          if (entry.targetInlet === 1 && Array.isArray(value)) {
            node.state.table = value;
          } else if (entry.targetInlet === 0) {
            const t = node.state.table;
            const idx = Math.max(0, Math.min(t.length - 1, Math.floor(value)));
            mergeUpdates(allUpdates, propagateValue(graph, entry.targetBox, 0, t[idx] !== undefined ? t[idx] : 0));
          }
        }
      } else if (node.type === "change") {
        if (node.state && value !== node.state.prev) {
          node.state.prev = value;
          mergeUpdates(allUpdates, propagateValue(graph, entry.targetBox, 0, value));
        }
      } else if (node.state && applyInletToState(node.type, node.state, entry.targetInlet, value)) {
        // handled by data-driven inlet map
      } else if (node.type === "touch" || node.type === "screen" || node.type === "text") {
        // display/sensor boxes: values stored in inletValues, handled by layer manager
      } else {
        if (node.type === "spigot" && (node.inletValues[1] || 0) <= 0) continue;
        if (!isHotInlet(node.type, entry.targetInlet, node.args)) continue;
        const result = evaluateNode(graph, entry.targetBox);
        mergeUpdates(allUpdates, propagateValue(graph, entry.targetBox, 0, result));
      }
    }
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
