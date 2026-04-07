/**
 * Engine Factory — shared audio engine creation for ctrl and synth clients.
 * Both ctrl.js and main.js import from here to avoid duplication.
 * Wrapped in IIFE to avoid polluting global scope — access via window._engineFactory.
 */

(function() {

const ENGINES = {
  "formant~":          { module: "processor.js",       worklet: "voice-processor",  channels: 4 },
  "karplus-strong~":   { module: "ks-processor.js",    worklet: "ks-processor",     channels: 1 },
  "sine-osc~":         { module: "sine-processor.js",  worklet: "sine-processor",   channels: 1 },
  "noise-engine~":     { module: "noise-processor.js", worklet: "noise-processor",  channels: 1 },
  "swarm~":            { module: "swarm-processor.js", worklet: "swarm-processor",  channels: 1 },
  "reverb~":           { module: "reverb-processor.js", worklet: "reverb-processor", channels: 1 },
  "cute-sine~":        { module: "cute-sine-processor.js", worklet: "cute-sine-processor", channels: 1 },
};

const SIGNAL_WORKLETS = {
  "chaos~":   { module: "chaos-processor.js",   worklet: "chaos-processor" },
  "lfo~":     { module: "lfo-processor.js",     worklet: "lfo-processor" },
  "phasor~":  { module: "phasor-processor.js",  worklet: "phasor-processor" },
  "ar~":      { module: "ar-processor.js",      worklet: "ar-processor" },
  "adsr~":    { module: "adsr-processor.js",    worklet: "adsr-processor" },
  "sigmoid~": { module: "sigmoid-processor.js", worklet: "sigmoid-processor" },
  "cosine~":  { module: "cosine-processor.js",  worklet: "cosine-processor" },
  "ramp~":    { module: "ramp-processor.js",    worklet: "ramp-processor" },
  "step~":    { module: "step-processor.js",    worklet: "step-processor" },
  "trig~":    { module: "trig-processor.js",    worklet: "trig-processor" },
  "slew~":    { module: "slew-processor.js",    worklet: "slew-processor" },
  "noise~-worklet": { module: "noise-signal-processor.js", worklet: "noise-signal-processor" },
};

const MATH_OPS = new Set(["+~", "-~", "*~", "/~", "**~", "scale~", "clip~", "mtof~"]);

const BASE_NATIVE_NODES = new Set([
  "oscillatorNode~", "gainNode~", "biquadFilterNode~",
  "const~", "sig~", "osc~", "noise~",
  "send~", "s~", "receive~", "r~", "throw~", "catch~",
]);

// --- Shared functions ---

function getEngineOutput(engine, outletIndex) {
  if (engine.outputs && outletIndex !== undefined) return engine.outputs[outletIndex];
  return engine.out || engine.node || engine.worklet;
}

/**
 * Create a native Web Audio node.
 * @param {AudioContext} ctx
 * @param {Set} modulesLoaded - tracks loaded worklet modules
 * @param {string} type - box type name
 * @param {string} args - box arguments string
 * @param {Function} specialHandler - (ctx, type, args) => engine|null for caller-specific types (adc~, scope~)
 */
async function createNativeNode(ctx, modulesLoaded, type, args, specialHandler) {
  let node, paramMap = {};
  const tokens = (args || "").split(/\s+/).filter(Boolean);

  if (type === "oscillatorNode~") {
    node = ctx.createOscillator();
    node.type = tokens[0] || "sine";
    node.start();
    paramMap = { frequency: node.frequency, detune: node.detune };
  } else if (type === "gainNode~") {
    node = ctx.createGain();
    node.gain.value = parseFloat(tokens[0]) || 1;
    paramMap = { gain: node.gain };
  } else if (type === "biquadFilterNode~") {
    node = ctx.createBiquadFilter();
    node.type = tokens[0] || "lowpass";
    paramMap = { frequency: node.frequency, Q: node.Q, gain: node.gain, detune: node.detune };
  } else if (type === "const~") {
    node = ctx.createConstantSource();
    node.offset.value = parseFloat(tokens[0]) || 0;
    node.start();
    return { type, node, paramMap: {} };
  } else if (type === "sig~") {
    node = ctx.createConstantSource();
    node.offset.value = 0;
    node.start();
    const portaTime = parseFloat(tokens[0]) || 0;
    paramMap = { value: node.offset };
    return { type, node, paramMap, portaTime };
  } else if (type === "osc~") {
    node = ctx.createOscillator();
    node.frequency.value = parseFloat(tokens[0]) || 1;
    node.type = tokens[1] || "sine";
    node.start();
    paramMap = { frequency: node.frequency, detune: node.detune };
  } else if (type === "noise~") {
    const def = SIGNAL_WORKLETS["noise~-worklet"];
    if (!modulesLoaded.has(def.module)) {
      await ctx.audioWorklet.addModule(def.module);
      modulesLoaded.add(def.module);
    }
    node = new AudioWorkletNode(ctx, def.worklet);
    return { type, node, worklet: node, paramMap: {} };
  } else if (type === "send~" || type === "s~" || type === "receive~" || type === "r~"
          || type === "throw~" || type === "catch~") {
    node = ctx.createGain();
    return { type, node, paramMap: {} };
  } else if (specialHandler) {
    return await specialHandler(ctx, type, args);
  } else {
    return null;
  }

  return { type, node, paramMap };
}

/**
 * Create a signal-rate AudioWorklet node (lfo~, ar~, adsr~, etc.)
 */
async function createSignalWorklet(ctx, modulesLoaded, type, args) {
  const def = SIGNAL_WORKLETS[type];
  if (!def) return null;
  if (!modulesLoaded.has(def.module)) {
    await ctx.audioWorklet.addModule(def.module);
    modulesLoaded.add(def.module);
  }
  const tokens = (args || "").split(/\s+/).filter(Boolean);

  // chaos~ needs 3-channel output + splitter
  if (type === "chaos~") {
    const system = tokens[0] || "rossler";
    const node = new AudioWorkletNode(ctx, def.worklet, {
      outputChannelCount: [3],
      processorOptions: { system },
    });
    const splitter = ctx.createChannelSplitter(3);
    node.connect(splitter);
    const outX = ctx.createGain(); splitter.connect(outX, 0);
    const outY = ctx.createGain(); splitter.connect(outY, 1);
    const outZ = ctx.createGain(); splitter.connect(outZ, 2);
    const paramMap = {};
    for (const [name, param] of node.parameters) paramMap[name] = param;
    node.port.onmessage = (e) => { if (e.data?.type === "debug") console.log(`[${type}] ${e.data.msg}`); };
    return { type, worklet: node, splitter, outputs: [outX, outY, outZ], paramMap };
  }

  const node = new AudioWorkletNode(ctx, def.worklet);
  const paramMap = {};
  for (const [name, param] of node.parameters) paramMap[name] = param;

  // Set initial values from args
  if (type === "lfo~") {
    if (tokens[0]) node.parameters.get("period")?.setValueAtTime(parseFloat(tokens[0]), 0);
  } else if (type === "phasor~") {
    if (tokens[0]) node.parameters.get("period")?.setValueAtTime(parseFloat(tokens[0]), 0);
  } else if (type === "ar~") {
    if (tokens[0]) node.parameters.get("attack")?.setValueAtTime(parseFloat(tokens[0]), 0);
    if (tokens[1]) node.parameters.get("release")?.setValueAtTime(parseFloat(tokens[1]), 0);
  } else if (type === "adsr~") {
    if (tokens[0]) node.parameters.get("a")?.setValueAtTime(parseFloat(tokens[0]), 0);
    if (tokens[1]) node.parameters.get("d")?.setValueAtTime(parseFloat(tokens[1]), 0);
    if (tokens[2]) node.parameters.get("s")?.setValueAtTime(parseFloat(tokens[2]), 0);
    if (tokens[3]) node.parameters.get("r")?.setValueAtTime(parseFloat(tokens[3]), 0);
  } else if (type === "sigmoid~") {
    if (tokens[0]) node.parameters.get("start")?.setValueAtTime(parseFloat(tokens[0]), 0);
    if (tokens[1]) node.parameters.get("end")?.setValueAtTime(parseFloat(tokens[1]), 0);
    if (tokens[2]) node.parameters.get("duration")?.setValueAtTime(parseFloat(tokens[2]), 0);
    if (tokens[3]) node.parameters.get("duty")?.setValueAtTime(parseFloat(tokens[3]), 0);
    if (tokens[4]) node.parameters.get("curve")?.setValueAtTime(parseFloat(tokens[4]), 0);
    const modeToken = tokens.find(t => t === "interrupt" || t === "respect");
    if (modeToken) node.port.postMessage({ mode: modeToken });
  } else if (type === "cosine~") {
    if (tokens[0]) node.parameters.get("amplitude")?.setValueAtTime(parseFloat(tokens[0]), 0);
    if (tokens[1]) node.parameters.get("duration")?.setValueAtTime(parseFloat(tokens[1]), 0);
    if (tokens[2]) node.parameters.get("duty")?.setValueAtTime(parseFloat(tokens[2]), 0);
    if (tokens[3]) node.parameters.get("curve")?.setValueAtTime(parseFloat(tokens[3]), 0);
    const modeToken = tokens.find(t => t === "interrupt" || t === "respect");
    if (modeToken) node.port.postMessage({ mode: modeToken });
  } else if (type === "ramp~") {
    if (tokens[0]) node.parameters.get("from")?.setValueAtTime(parseFloat(tokens[0]), 0);
    if (tokens[1]) node.parameters.get("to")?.setValueAtTime(parseFloat(tokens[1]), 0);
    if (tokens[2]) node.parameters.get("duration")?.setValueAtTime(parseFloat(tokens[2]), 0);
    if (tokens[3]) node.parameters.get("curve")?.setValueAtTime(parseFloat(tokens[3]), 0);
  } else if (type === "step~") {
    if (tokens[0]) node.parameters.get("amplitude")?.setValueAtTime(parseFloat(tokens[0]), 0);
    if (tokens[1]) node.parameters.get("length")?.setValueAtTime(parseFloat(tokens[1]), 0);
  } else if (type === "trig~") {
    if (tokens[0]) node.parameters.get("amplitude")?.setValueAtTime(parseFloat(tokens[0]), 0);
    if (tokens[1]) node.parameters.get("samples")?.setValueAtTime(parseFloat(tokens[1]), 0);
  } else if (type === "slew~") {
    if (tokens[0]) node.parameters.get("rate")?.setValueAtTime(parseFloat(tokens[0]), 0);
  }

  return { type, node, worklet: node, paramMap };
}

/**
 * Create an audio-rate math node (+~, *~, etc.)
 */
async function createMathNode(ctx, modulesLoaded, type, args) {
  const op = type.replace("~", "");
  if (!modulesLoaded.has("math-processor.js")) {
    await ctx.audioWorklet.addModule("math-processor.js");
    modulesLoaded.add("math-processor.js");
  }
  const tokens = (args || "").split(/\s+/).filter(Boolean);
  const arg = parseFloat(tokens[0]) || (op === "*" || op === "/" || op === "**" ? 1 : 0);
  const node = new AudioWorkletNode(ctx, "math-processor", {
    numberOfInputs: 2,
    processorOptions: { op, arg },
  });
  return { type, node, worklet: node, paramMap: {} };
}

/**
 * Create any engine type — dispatcher.
 * @param {AudioContext} ctx
 * @param {Set} modulesLoaded
 * @param {Set} nativeNodes - set of native node type names (BASE_NATIVE_NODES + caller extras)
 * @param {string} type
 * @param {string} args
 * @param {Function} specialHandler - for caller-specific native nodes (adc~, scope~)
 */
async function createEngine(ctx, modulesLoaded, nativeNodes, type, args, specialHandler) {
  if (nativeNodes.has(type)) return await createNativeNode(ctx, modulesLoaded, type, args, specialHandler);
  if (SIGNAL_WORKLETS[type]) return await createSignalWorklet(ctx, modulesLoaded, type, args);
  if (MATH_OPS.has(type)) return await createMathNode(ctx, modulesLoaded, type, args);

  const def = ENGINES[type];
  if (!def) return null;
  if (!modulesLoaded.has(def.module)) {
    await ctx.audioWorklet.addModule(def.module);
    modulesLoaded.add(def.module);
  }
  const opts = def.channels > 1 ? { outputChannelCount: [def.channels] } : {};
  const worklet = new AudioWorkletNode(ctx, def.worklet, opts);
  if (def.channels > 1) {
    const splitter = ctx.createChannelSplitter(def.channels);
    worklet.connect(splitter);
    const out = ctx.createGain();
    splitter.connect(out, 0);
    const engine = { type, worklet, splitter, out };
    if (type === "formant~") {
      const outF1 = ctx.createGain(); splitter.connect(outF1, 1);
      const outF2 = ctx.createGain(); splitter.connect(outF2, 2);
      const outF3 = ctx.createGain(); splitter.connect(outF3, 3);
      engine.outputs = [out, outF1, outF2, outF3];
    }
    return engine;
  }
  worklet.port.onmessage = (e) => {
    if (e.data?.type === "debug") console.log(`[${type}] debug:`, e.data);
  };
  return { type, worklet };
}

// --- Export via global ---
window._engineFactory = { ENGINES, SIGNAL_WORKLETS, MATH_OPS, BASE_NATIVE_NODES, createEngine, createNativeNode, createSignalWorklet, createMathNode, getEngineOutput };

})();
