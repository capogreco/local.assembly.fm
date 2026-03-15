/**
 * Graph Evaluator — runs synth-side logic graph on each phone
 *
 * Receives a patch definition (boxes + cables + entries),
 * builds a local evaluation graph, and processes incoming
 * router values to produce engine parameter updates.
 */

// --- SIG (Stochastic Integer Generator) ---

function createSigState(args) {
  const parts = args.split(/\s+/);
  const values = (parts[0] || "1").split(",").map(Number);
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

  // build entry points (router -> synth graph)
  for (const entry of patch.entries) {
    if (!graph.entries.has(entry.routerId)) {
      graph.entries.set(entry.routerId, []);
    }
    graph.entries.get(entry.routerId).push({
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

  return graph;
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
    } else {
      // evaluate the destination box and propagate further
      const result = evaluateNode(graph, cable.dstBox);
      const further = propagateInGraph(graph, cable.dstBox, 0, result);
      // merge
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
    default:
      return {};
  }

  return propagateInGraph(graph, boxId, 0, outputValue);
}

// process a router value message: { type: "rv", r: routerId, v: value }
function processRouterValue(graph, routerId, value) {
  const entries = graph.entries.get(routerId);
  if (!entries) return {};

  let allUpdates = {};
  for (const entry of entries) {
    const node = graph.boxes.get(entry.targetBox);
    if (!node) continue;

    node.inletValues[entry.targetInlet] = value;

    // check inlet type — is this a trigger/event inlet?
    // for SIG, inlet 0 is trigger
    if (node.type === "sig" && entry.targetInlet === 0) {
      const updates = handleEvent(graph, entry.targetBox);
      Object.assign(allUpdates, updates);
    } else if ((node.type === "range" || node.type === "drunk") && entry.targetInlet === 0) {
      // range/drunk don't have explicit trigger inlets yet, but handle min/max updates
      if (node.state) {
        if (entry.targetInlet === 0) node.state.min = value;
        if (entry.targetInlet === 1) node.state.max = value;
      }
      const result = evaluateNode(graph, entry.targetBox);
      const updates = propagateInGraph(graph, entry.targetBox, 0, result);
      Object.assign(allUpdates, updates);
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
      Object.assign(allUpdates, updates);
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
    Object.assign(allUpdates, updates);
  }
  return allUpdates;
}
