/**
 * Graph Evaluator — runs synth-side logic graph on each phone
 *
 * Receives a patch definition (boxes + cables + entries),
 * builds a local evaluation graph, and processes incoming
 * router values to produce engine parameter updates.
 */

// --- Debug ---
let graphDebug = false;
function enableGraphDebug() { graphDebug = true; console.log("graph debug ON"); }
function disableGraphDebug() { graphDebug = false; }

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

// --- Envelope shape functions ---

function sigmoidShape(t, duty, curve) {
  const d = Math.max(0.001, Math.min(0.999, duty));
  let phi;
  if (t <= d) phi = 0.5 * t / d;
  else phi = 0.5 + 0.5 * (t - d) / (1 - d);
  if (curve < 0.1) return phi; // near-linear
  const raw = x => 1 / (1 + Math.exp(-curve * (x - 0.5)));
  const r0 = raw(0), r1 = raw(1);
  return (raw(phi) - r0) / (r1 - r0);
}

function cosineShape(t, duty, curve) {
  const d = Math.max(0.001, Math.min(0.999, duty));
  let base;
  if (t <= d) {
    base = (1 - Math.cos(Math.PI * t / d)) / 2;
  } else {
    base = (1 + Math.cos(Math.PI * (t - d) / (1 - d))) / 2;
  }
  return Math.pow(base, curve);
}

// --- Graph ---

function buildGraph(patch) {
  const graph = {
    boxes: new Map(),     // id -> { type, args, inletValues, state, outletCables }
    entries: new Map(),   // routerId -> [{ targetBox, targetInlet }]
    engines: new Map(),   // boxId -> { type, paramNames }
    envelopes: new Map(), // "routerId:channel" -> envelope state (from rv-env/rv-slew/rv-lag commands)
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
      case "phasor": {
        const phasorParts = (box.args || "1").split(/\s+/);
        node.state = { phase: 0, period: parseFloat(phasorParts[0]) || 1, paused: false, loop: phasorParts[1] !== "once" };
        break;
      }
      case "metro":
        node.state = { elapsed: 0, interval: parseFloat(box.args) || 1, paused: false };
        break;
      case "sequence":
        node.state = { index: 0, values: (box.args || "0").split(",").map(Number) };
        break;
      case "counter":
        node.state = { count: parseFloat(box.args) || 0, min: parseFloat(box.args) || 0, max: parseFloat(box.args.split(/\s+/)[1]) || 7 };
        break;
      case "ar": {
        const arParts = (box.args || "0.1 0.5").split(/\s+/).map(Number);
        node.state = { value: 0, phase: "idle", elapsed: 0, attack: arParts[0] || 0.1, release: arParts[1] || 0.5 };
        break;
      }
      case "adsr": {
        const adsrParts = (box.args || "0.05 0.1 0.7 0.3").split(/\s+/).map(Number);
        node.state = { value: 0, phase: "idle", elapsed: 0, a: adsrParts[0] || 0.05, d: adsrParts[1] || 0.1, s: adsrParts[2] || 0.7, r: adsrParts[3] || 0.3, gateOpen: false };
        break;
      }
      case "ramp": {
        const rampParts = (box.args || "0 1 0.5").split(/\s+/).map(Number);
        node.state = { value: rampParts[0] || 0, from: rampParts[0] || 0, to: rampParts[1] || 1, duration: rampParts[2] || 0.5, phase: "idle", elapsed: 0 };
        break;
      }
      case "delay": {
        node.state = { queue: [], time: parseFloat(box.args) || 0.5 };
        break;
      }
      case "slew": {
        node.state = { value: 0, target: 0, rate: parseFloat(box.args) || 0.05 };
        break;
      }
      case "lag": {
        node.state = { value: 0, target: 0, coeff: parseFloat(box.args) || 0.2 };
        break;
      }
      case "sample-hold": {
        node.state = { value: 0 };
        break;
      }
      case "step": {
        const parts = (box.args || "1 0.5").split(/\s+/).map(Number);
        node.state = { active: false, remaining: 0, amplitude: parts[0] || 1, length: parts[1] || 0.5 };
        break;
      }
      case "sigmoid": {
        const tokens = (box.args || "0 1 0.5 0.5 6").split(/\s+/);
        const mode = (tokens[tokens.length - 1] === "interrupt") ? "interrupt" : "respect";
        const parts = tokens.map(Number);
        node.state = { phase: "idle", elapsed: 0, value: parts[0] || 0, start: parts[0] || 0, end: parts[1] !== undefined ? parts[1] : 1, duration: parts[2] || 0.5, duty: parts[3] !== undefined ? parts[3] : 0.5, curve: parts[4] !== undefined ? parts[4] : 6, mode };
        break;
      }
      case "cosine": {
        const tokens = (box.args || "1 0.5 0.5 1").split(/\s+/);
        const mode = (tokens[tokens.length - 1] === "interrupt") ? "interrupt" : "respect";
        const parts = tokens.map(Number);
        node.state = { phase: "idle", elapsed: 0, value: 0, amplitude: parts[0] !== undefined ? parts[0] : 1, duration: parts[1] || 0.5, duty: parts[2] !== undefined ? parts[2] : 0.5, curve: parts[3] !== undefined ? parts[3] : 1, mode };
        break;
      }
      case "random": {
        const parts = (box.args || "0 1").split(/\s+/).map(Number);
        const min = parts[0] !== undefined ? parts[0] : 0;
        const max = parts[1] !== undefined ? parts[1] : 1;
        node.state = { min, max, value: min + Math.random() * (max - min) };
        break;
      }
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
  if (inlet === 0 && (type === "sig" || type === "sequence" || type === "counter" || type === "drunk" || type === "ar" || type === "ramp" || type === "delay" || type === "step" || type === "sigmoid" || type === "cosine" || type === "random")) return true;
  if (inlet === 1 && (type === "phasor" || type === "sample-hold")) return true;
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
    case "jitter": {
      const amount = parseFloat(args[0]) || 0.01;
      return (iv[0] || 0) + (Math.random() * 2 - 1) * amount;
    }
    case "sig":
      return node.state ? node.state.values[node.state.index] : 0;
    case "phasor":
      return node.state ? node.state.phase : 0;
    case "gate":
      return (iv[1] || 0) > 0 ? (iv[0] || 0) : 0;
    case "quantize": {
      const divs = parseFloat(args[0]) || 12;
      return Math.round((iv[0] || 0) * divs) / divs;
    }
    case "sine": return Math.sin((iv[0] || 0) * Math.PI * 2) * 0.5 + 0.5;
    case "tri": {
      const yaw = parseFloat(args[0]) || 0.5;
      const t = iv[0] || 0;
      return t < yaw ? (yaw > 0 ? t / yaw : 0) : (yaw < 1 ? (1 - t) / (1 - yaw) : 0);
    }
    case "slew": case "lag":
      return node.state ? node.state.value : (iv[0] || 0);
    case "step": return node.state?.active ? node.state.amplitude : 0;
    case "range": case "spread": case "drunk": case "ar": case "adsr":
    case "ramp": case "sample-hold": case "sigmoid": case "cosine": case "random":
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

  // Two-phase propagation: deliver all values first, then fire deferred events.
  const updates = {};
  const deferred = [];

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
        if (graphDebug) console.log(`  → engine box:${cable.dstBox} ${paramName}=${value}`);
        if (!updates[cable.dstBox]) updates[cable.dstBox] = {};
        updates[cable.dstBox][paramName] = value;
      }
    } else if (isEventTrigger(dstNode.type, cable.dstInlet)) {
      // defer event triggers to phase 2
      deferred.push(cable.dstBox);
    } else if (dstNode.type === "phasor") {
      // phasor number inlets (pause/period) — store value, don't propagate
    } else if ((dstNode.type === "slew" || dstNode.type === "lag") && cable.dstInlet === 0) {
      if (dstNode.state) {
        if (graphDebug) console.log(`  ${dstNode.type} box:${cable.dstBox} target=${value} (was ${dstNode.state.target})`);
        dstNode.state.target = value;
      }
    } else if (dstNode.type === "sample-hold" && cable.dstInlet === 0) {
      // store for sampling — don't propagate until triggered
    } else if (dstNode.type === "adsr" && cable.dstInlet === 0) {
      // gate value — store for tick loop, don't propagate
    } else if (dstNode.type === "ar") {
      // number inlets (attack/release time) — store for tick
      if (cable.dstInlet === 1 && dstNode.state) dstNode.state.attack = Math.max(0.001, value);
      if (cable.dstInlet === 2 && dstNode.state) dstNode.state.release = Math.max(0.001, value);
    } else if (dstNode.type === "sigmoid" && cable.dstInlet >= 1) {
      // number inlets — store for next trigger
      if (dstNode.state) {
        if (cable.dstInlet === 1) dstNode.state.start = value;
        if (cable.dstInlet === 2) dstNode.state.end = value;
        if (cable.dstInlet === 3) dstNode.state.duration = Math.max(0.001, value);
        if (cable.dstInlet === 4) dstNode.state.duty = value;
        if (cable.dstInlet === 5) dstNode.state.curve = value;
      }
    } else if (dstNode.type === "cosine" && cable.dstInlet >= 1) {
      // number inlets — store for next trigger
      if (dstNode.state) {
        if (cable.dstInlet === 1) dstNode.state.amplitude = value;
        if (cable.dstInlet === 2) dstNode.state.duration = Math.max(0.001, value);
        if (cable.dstInlet === 3) dstNode.state.duty = value;
        if (cable.dstInlet === 4) dstNode.state.curve = value;
      }
    } else {
      // evaluate the destination box and propagate further
      const result = evaluateNode(graph, cable.dstBox);
      if (graphDebug) console.log(`  eval box:${cable.dstBox} type:${dstNode.type} inlet[${cable.dstInlet}]=${value} iv=[${dstNode.inletValues}] → ${result}`);
      const further = propagateInGraph(graph, cable.dstBox, 0, result);
      for (const [eid, params] of Object.entries(further)) {
        if (!updates[eid]) updates[eid] = {};
        Object.assign(updates[eid], params);
      }
    }
  }

  // Phase 2: fire deferred event triggers after all values delivered
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
    case "ar":
      if (node.state) {
        // update attack/release from inlets if connected
        if (node.inletValues[1] > 0) node.state.attack = node.inletValues[1];
        if (node.inletValues[2] > 0) node.state.release = node.inletValues[2];
        node.state.phase = "attack";
        node.state.elapsed = 0;
      }
      return {}; // no immediate output — tick drives it
    case "ramp":
      if (node.state) {
        node.state.phase = "running";
        node.state.elapsed = 0;
      }
      return {};
    case "delay":
      if (node.state) {
        node.state.queue.push({ value: 1, remaining: node.state.time });
      }
      return {};
    case "sample-hold":
      if (node.state) {
        node.state.value = node.inletValues[0] || 0;
        return propagateInGraph(graph, boxId, 0, node.state.value);
      }
      return {};
    case "step":
      if (node.state) {
        const amp = node.inletValues[1] !== undefined ? node.inletValues[1] : node.state.amplitude;
        const len = node.inletValues[2] !== undefined ? node.inletValues[2] : node.state.length;
        node.state.active = true;
        node.state.remaining = len;
        outputValue = amp;
      }
      break;
    case "sigmoid":
      if (node.state) {
        if (node.state.mode === "respect" && node.state.phase !== "idle") return {};
        if (node.inletValues[1] !== undefined) node.state.start = node.inletValues[1];
        if (node.inletValues[2] !== undefined) node.state.end = node.inletValues[2];
        if (node.inletValues[3] !== undefined) node.state.duration = Math.max(0.001, node.inletValues[3]);
        if (node.inletValues[4] !== undefined) node.state.duty = node.inletValues[4];
        if (node.inletValues[5] !== undefined) node.state.curve = node.inletValues[5];
        node.state.phase = "running";
        node.state.elapsed = 0;
        node.state.value = node.state.start;
      }
      return {};
    case "cosine":
      if (node.state) {
        if (node.state.mode === "respect" && node.state.phase !== "idle") return {};
        if (node.inletValues[1] !== undefined) node.state.amplitude = node.inletValues[1];
        if (node.inletValues[2] !== undefined) node.state.duration = Math.max(0.001, node.inletValues[2]);
        if (node.inletValues[3] !== undefined) node.state.duty = node.inletValues[3];
        if (node.inletValues[4] !== undefined) node.state.curve = node.inletValues[4];
        node.state.phase = "running";
        node.state.elapsed = 0;
        node.state.value = 0;
      }
      return {};
    case "random":
      if (node.state) {
        node.state.value = node.state.min + Math.random() * (node.state.max - node.state.min);
        outputValue = node.state.value;
      }
      break;
    default:
      return {};
  }

  if (graphDebug) console.log(`  event box:${boxId} type:${node.type} → ${outputValue}`);
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
          if (node.state.loop) {
            node.state.phase -= 1;
          } else {
            node.state.phase = 1;
            node.state.paused = true; // one-shot done
          }
          mergeUpdates(allUpdates, propagateInGraph(graph, id, 1, 0));
        }
        mergeUpdates(allUpdates, propagateInGraph(graph, id, 0, node.state.phase));
        break;
      }
      case "metro": {
        if (node.state.paused) break;
        if (node.inletValues[0] !== undefined && !(node.inletValues[0] > 0)) break;  // toggle: 1=run, 0=stop
        const metroInterval = node.inletValues[1] > 0 ? node.inletValues[1] : node.state.interval;
        node.state.elapsed += dt;
        if (node.state.elapsed >= metroInterval) {
          node.state.elapsed -= metroInterval;
          const u = propagateInGraph(graph, id, 0, 1);
          mergeUpdates(allUpdates, u);
        }
        break;
      }
      case "ar": {
        const s = node.state;
        if (s.phase === "idle") break;
        s.elapsed += dt;
        if (s.phase === "attack") {
          s.value = Math.min(1, s.elapsed / s.attack);
          if (s.elapsed >= s.attack) { s.phase = "release"; s.elapsed = 0; }
        } else if (s.phase === "release") {
          s.value = Math.max(0, 1 - s.elapsed / s.release);
          if (s.elapsed >= s.release) {
            s.value = 0; s.phase = "idle";
            mergeUpdates(allUpdates, propagateInGraph(graph, id, 1, 0)); // end event
          }
        }
        mergeUpdates(allUpdates, propagateInGraph(graph, id, 0, s.value));
        break;
      }
      case "adsr": {
        const s = node.state;
        const gateNow = (node.inletValues[0] || 0) > 0;
        if (gateNow && !s.gateOpen) {
          // gate opened
          s.gateOpen = true; s.phase = "attack"; s.elapsed = 0;
        } else if (!gateNow && s.gateOpen) {
          // gate closed
          s.gateOpen = false;
          if (s.phase !== "idle") { s.phase = "release"; s.elapsed = 0; }
        }
        if (s.phase === "idle") break;
        s.elapsed += dt;
        if (s.phase === "attack") {
          s.value = Math.min(1, s.elapsed / s.a);
          if (s.elapsed >= s.a) { s.phase = "decay"; s.elapsed = 0; }
        } else if (s.phase === "decay") {
          s.value = 1 - (1 - s.s) * Math.min(1, s.elapsed / s.d);
          if (s.elapsed >= s.d) { s.phase = "sustain"; s.value = s.s; }
        } else if (s.phase === "sustain") {
          s.value = s.s;
        } else if (s.phase === "release") {
          const startVal = s.value; // release from wherever we are
          s.value = startVal * Math.max(0, 1 - s.elapsed / s.r);
          if (s.elapsed >= s.r) {
            s.value = 0; s.phase = "idle";
            mergeUpdates(allUpdates, propagateInGraph(graph, id, 1, 0));
          }
        }
        mergeUpdates(allUpdates, propagateInGraph(graph, id, 0, s.value));
        break;
      }
      case "ramp": {
        const s = node.state;
        if (s.phase !== "running") break;
        s.elapsed += dt;
        const t = Math.min(1, s.elapsed / s.duration);
        s.value = s.from + (s.to - s.from) * t;
        mergeUpdates(allUpdates, propagateInGraph(graph, id, 0, s.value));
        if (t >= 1) {
          s.phase = "idle";
          mergeUpdates(allUpdates, propagateInGraph(graph, id, 1, 0)); // end event
        }
        break;
      }
      case "delay": {
        const s = node.state;
        for (let i = s.queue.length - 1; i >= 0; i--) {
          s.queue[i].remaining -= dt;
          if (s.queue[i].remaining <= 0) {
            mergeUpdates(allUpdates, propagateInGraph(graph, id, 0, s.queue[i].value));
            s.queue.splice(i, 1);
          }
        }
        break;
      }
      case "slew": {
        const s = node.state;
        if (Math.abs(s.value - s.target) > 0.0001) {
          const maxDelta = dt / s.rate;
          const diff = s.target - s.value;
          s.value += Math.sign(diff) * Math.min(Math.abs(diff), maxDelta);
          mergeUpdates(allUpdates, propagateInGraph(graph, id, 0, s.value));
        }
        break;
      }
      case "lag": {
        const s = node.state;
        if (Math.abs(s.value - s.target) > 0.0001) {
          const alpha = 1 - Math.exp(-dt / s.coeff);
          s.value += (s.target - s.value) * alpha;
          mergeUpdates(allUpdates, propagateInGraph(graph, id, 0, s.value));
        }
        break;
      }
      case "step": {
        if (!node.state.active) break;
        node.state.remaining -= dt;
        if (node.state.remaining <= 0) {
          node.state.active = false;
          node.state.remaining = 0;
          mergeUpdates(allUpdates, propagateInGraph(graph, id, 0, 0));
        }
        break;
      }
      case "sigmoid": {
        const s = node.state;
        if (s.phase !== "running") break;
        s.elapsed += dt;
        const t = Math.min(1, s.elapsed / s.duration);
        const shaped = sigmoidShape(t, s.duty, s.curve);
        s.value = s.start + (s.end - s.start) * shaped;
        mergeUpdates(allUpdates, propagateInGraph(graph, id, 0, s.value));
        if (t >= 1) {
          s.value = s.end;
          s.phase = "idle";
          mergeUpdates(allUpdates, propagateInGraph(graph, id, 1, 0)); // end event
        }
        break;
      }
      case "cosine": {
        const s = node.state;
        if (s.phase !== "running") break;
        s.elapsed += dt;
        const t = Math.min(1, s.elapsed / s.duration);
        s.value = s.amplitude * cosineShape(t, s.duty, s.curve);
        mergeUpdates(allUpdates, propagateInGraph(graph, id, 0, s.value));
        if (t >= 1) {
          s.value = 0;
          s.phase = "idle";
          mergeUpdates(allUpdates, propagateInGraph(graph, id, 1, 0)); // end event
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

  if (graphDebug) console.log(`rv r:${routerId} ch:${channel} v:${value} → ${entries.length} entries`);

  let allUpdates = {};
  for (const entry of entries) {
    const node = graph.boxes.get(entry.targetBox);
    if (!node) continue;

    node.inletValues[entry.targetInlet] = value;

    if (node.type === "phasor") {
      // phasor: inlet 0 = pause, inlet 1 = reset (event), inlet 2 = period
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

// process an envelope command: { type: "rv-env", r, ch, env, params, gate }
function processRouterEnvelope(graph, msg) {
  const key = msg.r + ":" + (msg.ch || 0);

  if (msg.gate === 0) {
    // gate close — release existing envelope
    const env = graph.envelopes.get(key);
    if (env && env.type === "adsr") {
      env.gateOpen = false;
      if (env.phase !== "idle") { env.phase = "release"; env.elapsed = 0; }
    }
    return {};
  }

  if (msg.env === "adsr") {
    graph.envelopes.set(key, {
      type: "adsr",
      a: msg.params.a, d: msg.params.d, s: msg.params.s, r: msg.params.r,
      value: 0, phase: "attack", elapsed: 0, gateOpen: true,
    });
  } else if (msg.env === "ar") {
    graph.envelopes.set(key, {
      type: "ar",
      attack: msg.params.attack, release: msg.params.release,
      value: 0, phase: "attack", elapsed: 0,
    });
  } else if (msg.env === "ramp") {
    graph.envelopes.set(key, {
      type: "ramp",
      from: msg.params.from, to: msg.params.to, duration: msg.params.duration,
      value: msg.params.from, phase: "running", elapsed: 0,
    });
  } else if (msg.env === "phasor") {
    if (msg.paused) {
      // pause existing phasor
      const env = graph.envelopes.get(key);
      if (env && env.type === "phasor") env.paused = true;
    } else {
      const existing = graph.envelopes.get(key);
      // if already running, update params but keep phase
      if (existing && existing.type === "phasor" && !msg.reset) {
        existing.period = msg.params.period;
        existing.loop = msg.params.loop;
        existing.paused = false;
      } else {
        graph.envelopes.set(key, {
          type: "phasor",
          period: msg.params.period, loop: msg.params.loop,
          phase: 0, paused: false,
        });
      }
    }
  }

  return {};
}

// process a slew/lag command: { type: "rv-slew"|"rv-lag", r, ch, v, time }
function processRouterSlew(graph, msg) {
  const key = msg.r + ":" + (msg.ch || 0);
  const existing = graph.envelopes.get(key);
  const currentValue = existing ? existing.value : msg.v;

  graph.envelopes.set(key, {
    type: msg.type === "rv-slew" ? "slew" : "lag",
    target: msg.v,
    time: msg.time,
    value: currentValue,
  });

  return {};
}

// tick envelope commands — call from client tick loop alongside tickGraph
function tickEnvelopes(graph, dt) {
  const allUpdates = {};

  for (const [key, env] of graph.envelopes) {
    const [routerId, channel] = key.split(":").map(Number);
    let changed = false;

    switch (env.type) {
      case "adsr": {
        if (env.phase === "idle") break;
        env.elapsed += dt;
        if (env.phase === "attack") {
          env.value = Math.min(1, env.elapsed / env.a);
          if (env.elapsed >= env.a) { env.phase = "decay"; env.elapsed = 0; }
          changed = true;
        } else if (env.phase === "decay") {
          env.value = 1 - (1 - env.s) * Math.min(1, env.elapsed / env.d);
          if (env.elapsed >= env.d) { env.phase = "sustain"; env.value = env.s; }
          changed = true;
        } else if (env.phase === "sustain") {
          env.value = env.s;
          // no change needed each tick during sustain
        } else if (env.phase === "release") {
          const sv = env.value;
          env.value = sv * Math.max(0, 1 - env.elapsed / env.r);
          if (env.elapsed >= env.r) { env.value = 0; env.phase = "idle"; }
          changed = true;
        }
        break;
      }
      case "ar": {
        if (env.phase === "idle") break;
        env.elapsed += dt;
        if (env.phase === "attack") {
          env.value = Math.min(1, env.elapsed / env.attack);
          if (env.elapsed >= env.attack) { env.phase = "release"; env.elapsed = 0; }
          changed = true;
        } else if (env.phase === "release") {
          env.value = Math.max(0, 1 - env.elapsed / env.release);
          if (env.elapsed >= env.release) { env.value = 0; env.phase = "idle"; }
          changed = true;
        }
        break;
      }
      case "ramp": {
        if (env.phase !== "running") break;
        env.elapsed += dt;
        const t = Math.min(1, env.elapsed / env.duration);
        env.value = env.from + (env.to - env.from) * t;
        changed = true;
        if (t >= 1) { env.phase = "idle"; }
        break;
      }
      case "phasor": {
        if (env.paused) break;
        env.phase += dt / env.period;
        if (env.phase >= 1) {
          if (env.loop) {
            env.phase -= 1;
          } else {
            env.phase = 1;
            env.paused = true; // one-shot done
          }
        }
        env.value = env.phase;
        changed = true;
        break;
      }
      case "slew": {
        if (Math.abs(env.value - env.target) > 0.0001) {
          const maxDelta = dt / env.time;
          const diff = env.target - env.value;
          env.value += Math.sign(diff) * Math.min(Math.abs(diff), maxDelta);
          changed = true;
        }
        break;
      }
      case "lag": {
        if (Math.abs(env.value - env.target) > 0.0001) {
          const alpha = 1 - Math.exp(-dt / env.time);
          env.value += (env.target - env.value) * alpha;
          changed = true;
        }
        break;
      }
    }

    if (changed) {
      const updates = processRouterValue(graph, routerId, channel, env.value);
      mergeUpdates(allUpdates, updates);
    }
  }

  return allUpdates;
}
