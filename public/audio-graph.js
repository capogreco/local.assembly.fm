/**
 * Audio Graph — builds audio-rate subgraph from continuous sources + math → engines.
 *
 * Replaces the rAF tick loop for continuous functions (lfo, phasor, ar, adsr,
 * ramp, slew, lag, sigmoid, cosine). Math boxes between them become AudioWorkletNodes.
 * Terminal nodes connect directly to engine AudioParams for sample-accurate
 * modulation without readback overhead.
 */

const CONTINUOUS_TYPES = new Set([
  "lfo", "phasor", "ar", "adsr", "ramp", "slew", "lag", "sigmoid", "cosine",
]);

const MATH_TYPES = new Set([
  "+", "-", "*", "/", "%", "**", "pow", "scale", "clip", "mtof", "sine", "tri", "quantize",
]);

// Types that produce a constant value (not time-varying, but needed in audio chains)
const CONST_TYPES = new Set(["const", "range", "spread"]);

// Worklet modules to register at startup
const MOD_MODULES = [
  "lfo-processor.js", "phasor-processor.js", "ar-processor.js",
  "adsr-processor.js", "ramp-processor.js", "slew-processor.js",
  "lag-processor.js", "sigmoid-processor.js", "cosine-processor.js",
  "math-processor.js",
];

let modWorkletsLoaded = false;

async function loadModWorklets(audioCtx) {
  if (modWorkletsLoaded) return;
  await Promise.all(MOD_MODULES.map(m => audioCtx.audioWorklet.addModule(m)));
  modWorkletsLoaded = true;
}

// --- Identify which boxes belong to the audio-rate subgraph ---

function identifyAudioBoxes(graph) {
  const audioBoxes = new Set();

  // Seed: all continuous source boxes
  for (const [id, node] of graph.boxes) {
    if (CONTINUOUS_TYPES.has(node.type)) {
      audioBoxes.add(id);
    }
  }

  // Flood forward: any math box that receives audio input is also audio-rate
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of graph.boxes) {
      if (!audioBoxes.has(id)) continue;
      for (const cable of node.outletCables) {
        if (audioBoxes.has(cable.dstBox)) continue;
        const dst = graph.boxes.get(cable.dstBox);
        if (!dst) continue;
        if (MATH_TYPES.has(dst.type)) {
          audioBoxes.add(cable.dstBox);
          changed = true;
        }
      }
    }
  }

  // Backward pass: include const/range/spread boxes that feed into audio boxes
  // (these are static value sources needed in the audio chain)
  for (const [id, node] of graph.boxes) {
    if (audioBoxes.has(id)) continue;
    if (!CONST_TYPES.has(node.type)) continue;
    for (const cable of node.outletCables) {
      if (audioBoxes.has(cable.dstBox)) {
        audioBoxes.add(id);
        break;
      }
    }
  }

  return audioBoxes;
}

// --- Find which engine params have audio cables ---

function findAudioDrivenParams(graph, audioBoxes) {
  // Map: engineId → Map(inletIndex → sourceBoxId)
  const driven = new Map();
  for (const [id, node] of graph.boxes) {
    if (!audioBoxes.has(id)) continue;
    for (const cable of node.outletCables) {
      if (graph.engines.has(cable.dstBox)) {
        if (!driven.has(cable.dstBox)) driven.set(cable.dstBox, new Map());
        driven.get(cable.dstBox).set(cable.dstInlet, id);
      }
    }
  }
  return driven;
}

// --- Create an AudioNode for a graph box ---

function createContinuousNode(audioCtx, node) {
  const args = node.args.split(/\s+/).filter(Boolean);

  switch (node.type) {
    case "lfo": {
      const tokens = (node.args || "1").split(/\s+/);
      const period = parseFloat(tokens[0]) || 1;
      const bipolar = tokens.includes("bipolar");
      const n = new AudioWorkletNode(audioCtx, "lfo-processor");
      n.parameters.get("period").setValueAtTime(period, 0);
      n.port.postMessage({ bipolar });
      return n;
    }
    case "phasor": {
      const tokens = (node.args || "1").split(/\s+/);
      const period = parseFloat(tokens[0]) || 1;
      const loop = tokens[1] !== "once";
      const n = new AudioWorkletNode(audioCtx, "phasor-processor");
      n.parameters.get("period").setValueAtTime(period, 0);
      n.port.postMessage({ loop });
      return n;
    }
    case "ar": {
      const parts = (node.args || "0.1 0.5").split(/\s+/).map(Number);
      const n = new AudioWorkletNode(audioCtx, "ar-processor");
      n.parameters.get("attack").setValueAtTime(parts[0] || 0.1, 0);
      n.parameters.get("release").setValueAtTime(parts[1] || 0.5, 0);
      return n;
    }
    case "adsr": {
      const parts = (node.args || "0.05 0.1 0.7 0.3").split(/\s+/).map(Number);
      const n = new AudioWorkletNode(audioCtx, "adsr-processor");
      n.parameters.get("a").setValueAtTime(parts[0] || 0.05, 0);
      n.parameters.get("d").setValueAtTime(parts[1] || 0.1, 0);
      n.parameters.get("s").setValueAtTime(parts[2] || 0.7, 0);
      n.parameters.get("r").setValueAtTime(parts[3] || 0.3, 0);
      return n;
    }
    case "ramp": {
      const parts = (node.args || "0 1 0.5").split(/\s+/).map(Number);
      const n = new AudioWorkletNode(audioCtx, "ramp-processor");
      n.port.postMessage({
        type: "params",
        from: parts[0] || 0, to: parts[1] || 1, duration: parts[2] || 0.5,
      });
      return n;
    }
    case "slew": {
      const n = new AudioWorkletNode(audioCtx, "slew-processor");
      n.parameters.get("rate").setValueAtTime(parseFloat(node.args) || 0.05, 0);
      return n;
    }
    case "lag": {
      const n = new AudioWorkletNode(audioCtx, "lag-processor");
      n.parameters.get("coeff").setValueAtTime(parseFloat(node.args) || 0.2, 0);
      return n;
    }
    case "sigmoid": {
      const tokens = (node.args || "0 1 0.5 0.5 6").split(/\s+/);
      const mode = (tokens[tokens.length - 1] === "interrupt") ? "interrupt" : "respect";
      const parts = tokens.map(Number);
      const n = new AudioWorkletNode(audioCtx, "sigmoid-processor");
      n.port.postMessage({
        type: "params",
        start: parts[0] || 0, end: parts[1] !== undefined ? parts[1] : 1,
        duration: parts[2] || 0.5, duty: parts[3] !== undefined ? parts[3] : 0.5,
        curve: parts[4] !== undefined ? parts[4] : 6, mode,
      });
      return n;
    }
    case "cosine": {
      const tokens = (node.args || "1 0.5 0.5 1").split(/\s+/);
      const mode = (tokens[tokens.length - 1] === "interrupt") ? "interrupt" : "respect";
      const parts = tokens.map(Number);
      const n = new AudioWorkletNode(audioCtx, "cosine-processor");
      n.port.postMessage({
        type: "params",
        amplitude: parts[0] !== undefined ? parts[0] : 1,
        duration: parts[1] || 0.5, duty: parts[2] !== undefined ? parts[2] : 0.5,
        curve: parts[3] !== undefined ? parts[3] : 1, mode,
      });
      return n;
    }
  }
  return null;
}

function createMathNode(audioCtx, node) {
  const args = node.args.split(/\s+/).filter(Boolean).map(Number);
  const type = node.type;
  // Binary ops need 2 inputs for two audio operands
  const binaryOpts = { numberOfInputs: 2 };

  switch (type) {
    case "*": return new AudioWorkletNode(audioCtx, "math-processor", {
      ...binaryOpts, processorOptions: { op: "*", arg: args[0] !== undefined ? args[0] : 1 },
    });
    case "+": return new AudioWorkletNode(audioCtx, "math-processor", {
      ...binaryOpts, processorOptions: { op: "+", arg: args[0] || 0 },
    });
    case "-": return new AudioWorkletNode(audioCtx, "math-processor", {
      ...binaryOpts, processorOptions: { op: "-", arg: args[0] || 0 },
    });
    case "/": return new AudioWorkletNode(audioCtx, "math-processor", {
      ...binaryOpts, processorOptions: { op: "/", arg: args[0] || 1 },
    });
    case "%": return new AudioWorkletNode(audioCtx, "math-processor", {
      ...binaryOpts, processorOptions: { op: "%", arg: args[0] || 1 },
    });
    case "**": case "pow": return new AudioWorkletNode(audioCtx, "math-processor", {
      ...binaryOpts, processorOptions: { op: "**", arg: args[0] !== undefined ? args[0] : 1 },
    });
    case "scale": return new AudioWorkletNode(audioCtx, "math-processor", {
      processorOptions: { op: "scale", arg: args[0] || 0, arg2: args[1] || 1 },
    });
    case "clip": return new AudioWorkletNode(audioCtx, "math-processor", {
      processorOptions: { op: "clip", arg: args[0] || 0, arg2: args[1] || 1 },
    });
    case "mtof": return new AudioWorkletNode(audioCtx, "math-processor", {
      processorOptions: { op: "mtof" },
    });
    case "sine": return new AudioWorkletNode(audioCtx, "math-processor", {
      processorOptions: { op: "sine" },
    });
    case "tri": return new AudioWorkletNode(audioCtx, "math-processor", {
      processorOptions: { op: "tri", arg: args[0] || 0.5 },
    });
    case "quantize": return new AudioWorkletNode(audioCtx, "math-processor", {
      processorOptions: { op: "quantize", arg: args[0] || 12 },
    });
  }
  return null;
}

function createConstNode(audioCtx, node) {
  // ConstantSourceNode for const/range/spread values
  const src = audioCtx.createConstantSource();
  let val = 0;
  if (node.type === "const") val = parseFloat(node.args) || 0;
  else if (node.state) val = node.state.value;
  src.offset.value = val;
  src.start();
  return src;
}

// --- Build the audio-rate subgraph ---

function buildAudioSubgraph(audioCtx, graph, engines, onEvent) {
  const audioBoxes = identifyAudioBoxes(graph);
  if (audioBoxes.size === 0) return null;

  const audioDrivenParams = findAudioDrivenParams(graph, audioBoxes);
  const audioNodes = new Map(); // boxId → AudioNode
  const constantSources = [];   // for teardown
  const audioParamSet = new Map(); // engineId → Set(paramName) — audio-driven params

  // Create AudioNodes for all audio-rate boxes
  for (const id of audioBoxes) {
    const node = graph.boxes.get(id);
    if (!node) continue;

    let audioNode = null;

    if (CONTINUOUS_TYPES.has(node.type)) {
      audioNode = createContinuousNode(audioCtx, node);
    } else if (MATH_TYPES.has(node.type)) {
      audioNode = createMathNode(audioCtx, node);
    } else if (CONST_TYPES.has(node.type)) {
      audioNode = createConstNode(audioCtx, node);
      constantSources.push(audioNode);
    }

    if (audioNode) {
      audioNodes.set(id, audioNode);
    }
  }

  // AudioParam name maps for continuous types that accept audio-rate param modulation
  const CONTINUOUS_PARAM_MAPS = {
    lfo:    { 0: "period" },
    phasor: { 0: "pause", 2: "period" },
    ar:     { 1: "attack", 2: "release" },
    slew:   { 0: "rate" },
    lag:    { 0: "coeff" },
  };

  // Wire audio connections between boxes
  for (const [id, node] of graph.boxes) {
    if (!audioBoxes.has(id)) continue;
    const srcAudioNode = audioNodes.get(id);
    if (!srcAudioNode) continue;

    for (const cable of node.outletCables) {
      // Skip event outlets (outlet 1+) — only wire audio from outlet 0
      if (cable.outlet && cable.outlet !== 0) continue;

      const dstAudioNode = audioNodes.get(cable.dstBox);
      if (dstAudioNode) {
        const dstNode = graph.boxes.get(cable.dstBox);
        if (dstNode && MATH_TYPES.has(dstNode.type)) {
          srcAudioNode.connect(dstAudioNode, 0, cable.dstInlet);
        } else if (dstNode && CONTINUOUS_TYPES.has(dstNode.type)) {
          // Continuous→continuous: connect to AudioParam if mapping exists
          const paramMap = CONTINUOUS_PARAM_MAPS[dstNode.type];
          const paramName = paramMap?.[cable.dstInlet];
          if (paramName) {
            const param = dstAudioNode.parameters.get(paramName);
            if (param) {
              // Zero the scheduled value — audio signal provides the full value
              param.setValueAtTime(0, audioCtx.currentTime);
              srcAudioNode.connect(param);
              continue;
            }
          }
          // Fallback: connect to audio input 0
          srcAudioNode.connect(dstAudioNode, 0, 0);
        } else {
          srcAudioNode.connect(dstAudioNode);
        }
      }

      // Direct AudioParam connection: audio box → engine param
      if (graph.engines.has(cable.dstBox)) {
        const engineDef = graph.engines.get(cable.dstBox);
        const paramName = engineDef.paramNames[cable.dstInlet];
        const engine = engines.get(cable.dstBox);
        if (paramName && engine?.worklet) {
          const param = engine.worklet.parameters.get(paramName);
          if (param) {
            param.setValueAtTime(0, audioCtx.currentTime);
            srcAudioNode.connect(param);
            // Track which params are audio-connected
            if (!audioParamSet.has(cable.dstBox)) audioParamSet.set(cable.dstBox, new Set());
            audioParamSet.get(cable.dstBox).add(paramName);
          }
        }
      }
    }
  }

  // Set up event listeners for continuous sources (end, wrap events → JS graph)
  for (const [id, audioNode] of audioNodes) {
    const node = graph.boxes.get(id);
    if (!node || !CONTINUOUS_TYPES.has(node.type)) continue;

    audioNode.port.onmessage = (e) => {
      if (e.data.type === "end" || e.data.type === "wrap") {
        // Fire event on outlet 1 back into the JS graph
        if (onEvent) onEvent(id, 1, 0);
      }
    };
  }

  // Forward discrete values to audio nodes when they arrive at audio-rate boxes
  function forwardDiscreteValue(boxId, inlet, value) {
    const audioNode = audioNodes.get(boxId);
    if (!audioNode) return false;

    const node = graph.boxes.get(boxId);
    if (!node) return false;

    // Continuous sources: forward param updates
    if (node.type === "lfo" && inlet === 0) {
      audioNode.parameters.get("period").setValueAtTime(Math.max(0.001, value), audioCtx.currentTime);
      return true;
    }
    if (node.type === "phasor") {
      if (inlet === 2) { audioNode.parameters.get("period").setValueAtTime(Math.max(0.001, value), audioCtx.currentTime); return true; }
      if (inlet === 0) { audioNode.parameters.get("pause").setValueAtTime(value, audioCtx.currentTime); return true; }
    }
    if (node.type === "ar") {
      if (inlet === 1) { audioNode.parameters.get("attack").setValueAtTime(Math.max(0.001, value), audioCtx.currentTime); return true; }
      if (inlet === 2) { audioNode.parameters.get("release").setValueAtTime(Math.max(0.001, value), audioCtx.currentTime); return true; }
    }
    if (node.type === "sigmoid" && inlet >= 1) {
      const names = [null, "start", "end", "duration", "duty", "curve"];
      const msg = { type: "params" };
      msg[names[inlet]] = inlet === 3 ? Math.max(0.001, value) : value;
      audioNode.port.postMessage(msg);
      return true;
    }
    if (node.type === "cosine" && inlet >= 1) {
      const names = [null, "amplitude", "duration", "duty", "curve"];
      const msg = { type: "params" };
      msg[names[inlet]] = inlet === 2 ? Math.max(0.001, value) : value;
      audioNode.port.postMessage(msg);
      return true;
    }
    if (node.type === "adsr" && inlet === 0) {
      // Gate value
      audioNode.port.postMessage({ type: "gate", value });
      return true;
    }
    if ((node.type === "slew" || node.type === "lag") && inlet === 0) {
      // Target value (when not audio-connected)
      audioNode.port.postMessage({ type: "target", value });
      return true;
    }

    // Math boxes: update arg value
    if (MATH_TYPES.has(node.type)) {
      if (inlet === 1) {
        audioNode.port.postMessage({ arg: value });
        return true;
      }
    }

    return false;
  }

  // Forward events (triggers) to audio-rate boxes
  function forwardEvent(boxId) {
    const audioNode = audioNodes.get(boxId);
    if (!audioNode) return false;

    const node = graph.boxes.get(boxId);
    if (!node) return false;

    if (node.type === "ar") {
      audioNode.port.postMessage({ type: "trigger" });
      return true;
    }
    if (node.type === "sigmoid") {
      audioNode.port.postMessage({ type: "trigger" });
      return true;
    }
    if (node.type === "cosine") {
      audioNode.port.postMessage({ type: "trigger" });
      return true;
    }
    if (node.type === "ramp") {
      audioNode.port.postMessage({ type: "trigger" });
      return true;
    }
    if (node.type === "phasor") {
      audioNode.port.postMessage({ type: "reset" });
      return true;
    }
    return false;
  }

  // Notify engines which params are audio-connected (so they skip portamento for those)
  for (const [engineId, paramNames] of audioParamSet) {
    const engine = engines.get(engineId);
    if (engine?.worklet) {
      engine.worklet.port.postMessage({ type: "audioConnected", params: [...paramNames] });
    }
  }

  function teardown() {
    for (const [, audioNode] of audioNodes) {
      try { audioNode.disconnect(); } catch {}
    }
    for (const src of constantSources) {
      try { src.stop(); src.disconnect(); } catch {}
    }
    audioNodes.clear();
  }

  return {
    audioNodes,
    audioBoxes,
    audioParamSet,
    forwardDiscreteValue,
    forwardEvent,
    teardown,
  };
}
