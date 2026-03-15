/**
 * Graph Evaluator — runs synth-side logic graph on each phone
 *
 * Receives a patch definition (boxes + cables + entries),
 * builds a local evaluation graph, and processes incoming
 * router values to produce engine parameter updates.
 */

// --- Helpers ---

// deep-merge engine param updates: { engineId: { param: value } }
function mergeUpdates(target, source) {
  for (const [eid, params] of Object.entries(source)) {
    if (!target[eid]) target[eid] = {};
    Object.assign(target[eid], params);
  }
}

// --- SIG (Stochastic Integer Generator) ---

function expandIntegerNotation(s) {
  const result = [];
  for (const token of s.split(",")) {
    const m = token.match(/^(-?\d+)-(-?\d+)$/);
    if (m) {
      const a = parseInt(m[1]), b = parseInt(m[2]);
      const step = a <= b ? 1 : -1;
      for (let i = a; step > 0 ? i <= b : i >= b; i += step) result.push(i);
    } else {
      result.push(Number(token));
    }
  }
  return result;
}

function createSigState(args) {
  const parts = args.split(/\s+/);
  const values = expandIntegerNotation(parts[0] || "1");
  const behaviour = parts[1] || "shuffle";
  return {
    values: [...values],
    behaviour,
    index: Math.floor(Math.random() * values.length),
  };
}

function advanceSig(state) {
  switch (state.behaviour) {
    case "shuffle":
      for (let i = state.values.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.values[i], state.values[j]] = [state.values[j], state.values[i]];
      }
      state.index = 0;
      break;
    case "asc":
      state.index = (state.index + 1) % state.values.length;
      break;
    case "desc":
      state.index = (state.index - 1 + state.values.length) % state.values.length;
      break;
    case "random":
      state.index = Math.floor(Math.random() * state.values.length);
      break;
  }
  return state.values[state.index];
}

// --- Range (per-instance random within bounds) ---

function createRangeState(args) {
  const parts = args.split(/\s+/).map(Number);
  const min = parts[0] || 0;
  const max = parts[1] || 1;
  return { min, max, value: min + Math.random() * (max - min) };
}

// --- Spread (deterministic distribution) ---

function createSpreadState(args, instanceIndex, instanceCount) {
  const parts = args.split(/\s+/).map(Number);
  const min = parts[0] || 0;
  const max = parts[1] || 1;
  const t = instanceCount > 1 ? instanceIndex / (instanceCount - 1) : 0.5;
  return { min, max, value: min + t * (max - min) };
}

// --- Graph ---

function buildGraph(patch) {
  const graph = {
    boxes: new Map(),     // id -> { type, args, inletValues, state, outletCables }
    entries: new Map(),   // routerId -> [{ targetBox, targetInlet }]
    engines: new Map(),   // boxId -> { type, paramNames }
  };

  // build box nodes
  for (const box of patch.boxes) {
    const node = {
      type: box.type,
      args: box.args || "",
      inletValues: [],
      state: null,
      outletCables: [],
    };

    // init stateful boxes
    switch (box.type) {
      case "sig":
        node.state = createSigState(box.args || "1 shuffle");
        break;
      case "range":
        node.state = createRangeState(box.args || "0 1");
        break;
      case "spread":
        node.state = createSpreadState(box.args || "0 1", patch.instanceIndex || 0, patch.instanceCount || 1);
        break;
      case "drunk":
        node.state = { value: Math.random(), step: parseFloat(box.args) || 0.01 };
        break;
      case "phasor":
        node.state = { phase: 0, period: parseFloat(box.args) || 1, paused: false };
        break;
      case "metro":
        node.state = { elapsed: 0, interval: parseFloat(box.args) || 1 };
        break;
      case "sequence":
        node.state = { index: 0, values: (box.args || "0").split(",").map(Number) };
        break;
      case "counter":
        node.state = { count: parseFloat(box.args) || 0, min: parseFloat(box.args) || 0, max: parseFloat(box.args.split(/\s+/)[1]) || 7 };
        break;
    }

    graph.boxes.set(box.id, node);
  }

  // build cables (outlet -> inlet connections)
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

  // build entry points (router:channel -> synth graph)
  for (const entry of patch.entries) {
    const key = entry.routerId + ":" + (entry.routerOutlet || 0);
    if (!graph.entries.has(key)) graph.entries.set(key, []);
    graph.entries.get(key).push({
      targetBox: entry.targetBox,
      targetInlet: entry.targetInlet,
    });
  }

  // identify engines
  for (const box of patch.boxes) {
    if (box.engine) {
      graph.engines.set(box.id, {
        type: box.type,
        paramNames: box.paramNames || [],
      });
    }
  }

  // seed values from const source boxes into downstream inlets
  for (const [id, node] of graph.boxes) {
    if (node.type === "const") {
      const val = parseFloat(node.args) || 0;
      for (const cable of node.outletCables) {
        const dst = graph.boxes.get(cable.dstBox);
        if (dst) dst.inletValues[cable.dstInlet] = val;
      }
    }
  }

  return graph;
}

// check if an inlet is an event trigger that should call handleEvent
function isEventTrigger(type, inlet) {
  // inlet 0 is the trigger for these types
  if (inlet === 0 && (type === "sig" || type === "sequence" || type === "counter" || type === "drunk")) return true;
  // inlet 1 is reset for phasor
  if (inlet === 1 && type === "phasor") return true;
  return false;
}

// evaluate a single box and return its output value
function evaluateNode(graph, boxId) {
  const node = graph.boxes.get(boxId);
  if (!node) return 0;

  const args = node.args.split(/\s+/).filter(Boolean);
  const iv = node.inletValues;

  switch (node.type) {
    case "+": return (iv[0] || 0) + (iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 0);
    case "-": return (iv[0] || 0) - (iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 0);
    case "*": return (iv[0] || 0) * (iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 1);
    case "/": {
      const d = iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 1;
      return d !== 0 ? (iv[0] || 0) / d : 0;
    }
    case "%": {
      const d = iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 1;
      return d !== 0 ? (iv[0] || 0) % d : 0;
    }
    case "**": return Math.pow(iv[0] || 0, iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 1);
    case "scale": {
      const min = parseFloat(args[0]) || 0;
      const max = parseFloat(args[1]) || 1;
      return (iv[0] || 0) * (max - min) + min;
    }
    case "clip": {
      const min = parseFloat(args[0]) || 0;
      const max = parseFloat(args[1]) || 1;
      return Math.max(min, Math.min(max, iv[0] || 0));
    }
    case "pow": return Math.pow(iv[0] || 0, iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 1);
    case "mtof": return 440 * Math.pow(2, ((iv[0] || 69) - 69) / 12);
    case "const": return parseFloat(args[0]) || 0;
    case "slew":
    case "lag":
      // simplified: just pass through (proper implementation needs timing)
      return iv[0] || 0;
    case "jitter": {
      const amount = parseFloat(args[0]) || 0.01;
      return (iv[0] || 0) + (Math.random() * 2 - 1) * amount;
    }
    case "sig":
      return node.state ? node.state.values[node.state.index] : 0;
    case "range":
      return node.state ? node.state.value : 0;
    case "spread":
      return node.state ? node.state.value : 0;
    case "drunk":
      return node.state ? node.state.value : 0;
    case "phasor":
      return node.state ? node.state.phase : 0;
    case "gate":
      return (iv[1] || 0) > 0 ? (iv[0] || 0) : 0;
    case "quantize": {
      const divs = parseFloat(args[0]) || 12;
      return Math.round((iv[0] || 0) * divs) / divs;
    }
    default:
      return iv[0] || 0; // passthrough
  }
}

// propagate a value from a box's outlet through the graph
// returns an object of engine param updates: { engineBoxId: { paramName: value } }
function propagateInGraph(graph, boxId, outletIndex, value) {
  const node = graph.boxes.get(boxId);
  if (!node) return {};

  const updates = {};

  for (const cable of node.outletCables) {
    if (cable.outlet !== outletIndex) continue;

    const dstNode = graph.boxes.get(cable.dstBox);
    if (!dstNode) continue;

    // set inlet value
    dstNode.inletValues[cable.dstInlet] = value;

    // check if destination is an engine
    if (graph.engines.has(cable.dstBox)) {
      const engine = graph.engines.get(cable.dstBox);
      const paramName = engine.paramNames[cable.dstInlet];
      if (paramName) {
        if (!updates[cable.dstBox]) updates[cable.dstBox] = {};
        updates[cable.dstBox][paramName] = value;
      }
    } else if (isEventTrigger(dstNode.type, cable.dstInlet)) {
      // event inlet on a stateful box — advance state
      const further = handleEvent(graph, cable.dstBox);
      for (const [eid, params] of Object.entries(further)) {
        if (!updates[eid]) updates[eid] = {};
        Object.assign(updates[eid], params);
      }
    } else if (dstNode.type === "phasor") {
      // phasor number inlets (pause/period) — store value, don't propagate
    } else {
      // evaluate the destination box and propagate further
      const result = evaluateNode(graph, cable.dstBox);
      const further = propagateInGraph(graph, cable.dstBox, 0, result);
      for (const [eid, params] of Object.entries(further)) {
        if (!updates[eid]) updates[eid] = {};
        Object.assign(updates[eid], params);
      }
    }
  }

  return updates;
}

// handle a null event (trigger) arriving at a box
function handleEvent(graph, boxId) {
  const node = graph.boxes.get(boxId);
  if (!node) return {};

  let outputValue = 0;

  switch (node.type) {
    case "sig":
      if (node.state) outputValue = advanceSig(node.state);
      break;
    case "range":
      if (node.state) {
        node.state.value = node.state.min + Math.random() * (node.state.max - node.state.min);
        outputValue = node.state.value;
      }
      break;
    case "drunk":
      if (node.state) {
        node.state.value += (Math.random() * 2 - 1) * node.state.step;
        node.state.value = Math.max(0, Math.min(1, node.state.value));
        outputValue = node.state.value;
      }
      break;
    case "phasor":
      if (node.state) { node.state.phase = 0; outputValue = 0; }
      break;
    case "sequence":
      if (node.state) {
        node.state.index = (node.state.index + 1) % node.state.values.length;
        outputValue = node.state.values[node.state.index];
      }
      break;
    case "counter":
      if (node.state) {
        node.state.count++;
        if (node.state.count > node.state.max) node.state.count = node.state.min;
        outputValue = node.state.count;
      }
      break;
    default:
      return {};
  }

  return propagateInGraph(graph, boxId, 0, outputValue);
}

// tick time-based boxes (phasor, metro) — call at ~60Hz from the client
function tickGraph(graph, dt) {
  const allUpdates = {};
  for (const [id, node] of graph.boxes) {
    if (!node.state) continue;
    switch (node.type) {
      case "phasor": {
        if (node.state.paused) break;
        // inlet 0 = pause, inlet 2 = period override
        if (node.inletValues[0] > 0) break;
        const period = node.inletValues[2] > 0 ? node.inletValues[2] : node.state.period;
        node.state.phase += dt / period;
        if (node.state.phase >= 1) {
          node.state.phase -= 1;
          // end-of-cycle event on outlet 1
          const eocUpdates = propagateInGraph(graph, id, 1, 0);
          for (const [eid, params] of Object.entries(eocUpdates)) {
            if (!allUpdates[eid]) allUpdates[eid] = {};
            Object.assign(allUpdates[eid], params);
          }
        }
        const phaseUpdates = propagateInGraph(graph, id, 0, node.state.phase);
        for (const [eid, params] of Object.entries(phaseUpdates)) {
          if (!allUpdates[eid]) allUpdates[eid] = {};
          Object.assign(allUpdates[eid], params);
        }
        break;
      }
      case "metro": {
        node.state.elapsed += dt;
        if (node.state.elapsed >= node.state.interval) {
          node.state.elapsed -= node.state.interval;
          const updates = propagateInGraph(graph, id, 0, 1);
          for (const [eid, params] of Object.entries(updates)) {
            if (!allUpdates[eid]) allUpdates[eid] = {};
            Object.assign(allUpdates[eid], params);
          }
        }
        break;
      }
    }
  }
  return allUpdates;
}

// process a router value message: { type: "rv", r: routerId, v: value }
function processRouterValue(graph, routerId, channel, value) {
  const key = routerId + ":" + (channel || 0);
  const entries = graph.entries.get(key);
  if (!entries) return {};

  let allUpdates = {};
  for (const entry of entries) {
    const node = graph.boxes.get(entry.targetBox);
    if (!node) continue;

    node.inletValues[entry.targetInlet] = value;

    // check inlet type — is this a trigger/event inlet?
    // for SIG, inlet 0 is trigger
    if (node.type === "phasor") {
      // inlet 0 = pause, inlet 1 = reset (event), inlet 2 = period
      if (entry.targetInlet === 1 && node.state) {
        // reset event
        const updates = handleEvent(graph, entry.targetBox);
        mergeUpdates(allUpdates, updates);
      }
      // inlets 0 and 2 are stored in inletValues, read by tickGraph
      continue;
    } else if (node.type === "sequence" && entry.targetInlet === 0) {
      const updates = handleEvent(graph, entry.targetBox);
      mergeUpdates(allUpdates, updates);
    } else if (node.type === "counter" && entry.targetInlet === 0) {
      const updates = handleEvent(graph, entry.targetBox);
      mergeUpdates(allUpdates, updates);
    } else if (node.type === "sig" && entry.targetInlet === 0) {
      const updates = handleEvent(graph, entry.targetBox);
      mergeUpdates(allUpdates, updates);
    } else if ((node.type === "range" || node.type === "drunk") && entry.targetInlet === 0) {
      // range/drunk don't have explicit trigger inlets yet, but handle min/max updates
      if (node.state) {
        if (entry.targetInlet === 0) node.state.min = value;
        if (entry.targetInlet === 1) node.state.max = value;
      }
      const result = evaluateNode(graph, entry.targetBox);
      const updates = propagateInGraph(graph, entry.targetBox, 0, result);
      mergeUpdates(allUpdates, updates);
    } else if (graph.engines.has(entry.targetBox)) {
      // direct to engine — produce update immediately
      const engine = graph.engines.get(entry.targetBox);
      const paramName = engine.paramNames[entry.targetInlet];
      if (paramName) {
        if (!allUpdates[entry.targetBox]) allUpdates[entry.targetBox] = {};
        allUpdates[entry.targetBox][paramName] = value;
      }
    } else {
      // intermediate box — evaluate and propagate
      const result = evaluateNode(graph, entry.targetBox);
      const updates = propagateInGraph(graph, entry.targetBox, 0, result);
      mergeUpdates(allUpdates, updates);
    }
  }

  return allUpdates;
}

// process a router event message: { type: "re", r: routerId }
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
