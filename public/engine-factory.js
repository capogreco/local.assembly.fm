/**
 * Engine Factory — shared audio engine creation for ctrl and synth clients.
 * Both ctrl.js and main.js import from here to avoid duplication.
 */

const ENGINES = {
  "formant~":          { module: "processor.js",       worklet: "voice-processor",  channels: 4 },
  "karplus-strong~":   { module: "ks-processor.js",    worklet: "ks-processor",     channels: 1 },
  "sine-osc~":         { module: "sine-processor.js",  worklet: "sine-processor",   channels: 1 },
  "noise-engine~":     { module: "noise-processor.js", worklet: "noise-processor",  channels: 1 },
  "swarm~":            { module: "swarm-processor.js", worklet: "swarm-processor",  channels: 1 },
  "frog~":             { module: "frog-processor.js",  worklet: "frog-processor",   channels: 1 },
  "ewing~":            { module: "ewing-processor.js", worklet: "ewing-processor",  channels: 1 },
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
  "samphold~": { module: "samphold-processor.js", worklet: "samphold-processor" },
  "play~":    { module: "buffer-processor.js",  worklet: "play-processor" },
  "noise~-worklet": { module: "noise-signal-processor.js", worklet: "noise-signal-processor" },
  "noise~-pink-worklet": { module: "pink-noise-processor.js", worklet: "pink-noise-processor" },
};

const MATH_OPS = new Set(["+~", "-~", "*~", "/~", "**~", "scale~", "clip~", "mtof~", "hann~"]);

const BASE_NATIVE_NODES = new Set([
  "oscillatorNode~", "gainNode~", "biquadFilterNode~",
  "const~", "sig~", "osc~", "noise~",
  "send~", "s~", "receive~", "r~", "throw~", "catch~",
  "conv~",
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
    const def = SIGNAL_WORKLETS[tokens[0] === "pink" ? "noise~-pink-worklet" : "noise~-worklet"];
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
  } else if (type === "conv~") {
    // Browser-native ConvolverNode — partitioned FFT convolution, bounded
    // output (output = input ⊛ IR, no feedback, can't run away).
    // Arg is the IR filename under /impulse_responses/. Default: GiantCave.flac.
    // IR loads async; node outputs silence until the buffer is set.
    node = ctx.createConvolver();
    node.normalize = true; // auto-scale IR so peaks sit near 0 dB
    const irName = tokens[0] || "GiantCave.flac";
    fetch("/impulse_responses/" + irName)
      .then((r) => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((buf) => ctx.decodeAudioData(buf))
      .then((audioBuffer) => { node.buffer = audioBuffer; })
      .catch((e) => console.error(`conv~: failed to load ${irName}:`, e));
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

  // Options the processor needs from its first render quantum.
  let options = {};
  if (type === "phasor~") {
    // phasor~ period [phase] [once]
    const phase = tokens[1] !== undefined && tokens[1] !== "once" ? parseFloat(tokens[1]) : 0;
    options = { processorOptions: { phase: Number.isFinite(phase) ? phase : 0, loop: !tokens.includes("once") } };
  } else if (type === "samphold~") {
    options = { numberOfInputs: 2 };
  } else if (type === "play~") {
    options = { processorOptions: { name: tokens[0] ?? "" } };
  }
  const node = new AudioWorkletNode(ctx, def.worklet, options);
  const paramMap = {};
  for (const [name, param] of node.parameters) paramMap[name] = param;

  // Set initial values from args
  if (type === "lfo~") {
    if (tokens[0]) node.parameters.get("period")?.setValueAtTime(parseFloat(tokens[0]), 0);
    node.port.postMessage({
      bipolar: tokens.includes("bipolar"),
      ...(tokens.includes("random") && { phase: Math.random() }),
    });
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
  // frog~ / ewing~ take an optional pitch-glide-seconds arg via processorOptions.
  if (type === "frog~" || type === "ewing~") {
    const glideSec = parseFloat((args || "").split(/\s+/)[0]);
    const defaultSec = type === "ewing~" ? 1.0 : 0.15;
    opts.processorOptions = { glideSec: isNaN(glideSec) ? defaultSec : glideSec };
  }
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

// --- Named sample buffers (buffer~, play~) ---
// A deploy lists its buffers: { id, name, file } loaded from /media/<file>, or
// { id, name, seconds } silent. Each is decoded here, mixed to mono, and its
// samples transferred once to the context's registry node, where every play~
// in the context finds it by name (buffer-processor.js). Per context: one
// registry node and what it holds, so a re-deploy fetches only what changed
// and drops buffers it no longer lists. Syncs on one context run one after
// another.

const bufferStores = new WeakMap(); // AudioContext → { registry, held: Map<name, key>, lengths: Map<name, s>, chain }

function bufferKey(b) {
  return b.file !== undefined ? `file:${b.file}` : `silent:${b.seconds}`;
}

// A stalled download or decode must not hold the patch back: past these the
// buffer counts as failed, the patch starts, and its play~ is silent.
const FETCH_TIMEOUT_MS = 30000;
const DECODE_TIMEOUT_MS = 30000;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function decodeMono(ctx, file) {
  // AbortController + setTimeout rather than AbortSignal.timeout, which older
  // Safari lacks. The abort covers the body download as well as the headers.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  let data;
  try {
    const r = await fetch("/media/" + encodeURIComponent(file), { signal: abort.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.arrayBuffer();
  } catch (err) {
    if (abort.signal.aborted) throw new Error(`download timed out after ${FETCH_TIMEOUT_MS / 1000} s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const audio = await withTimeout(ctx.decodeAudioData(data), DECODE_TIMEOUT_MS, "decode");
  const n = audio.numberOfChannels;
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < n; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i];
  }
  if (n > 1) for (let i = 0; i < mono.length; i++) mono[i] /= n;
  return mono;
}

/**
 * Make the context hold exactly the deploy's buffers.
 * onProgress(loaded, total) runs after each buffer, loaded or failed.
 * Resolves to { lengths: Map<boxId, seconds>, errors: string[] }; a buffer
 * that fails stays missing (play~ is silent) and is named in `errors`.
 */
function syncBuffers(ctx, modulesLoaded, list, onProgress) {
  let store = bufferStores.get(ctx);
  if (!store) {
    store = { registry: null, held: new Map(), lengths: new Map(), chain: Promise.resolve() };
    bufferStores.set(ctx, store);
  }
  const run = async () => {
    const lengths = new Map(), errors = [];
    const total = list.length;
    if (total === 0 && store.held.size === 0) return { lengths, errors };
    if (!modulesLoaded.has("buffer-processor.js")) {
      await ctx.audioWorklet.addModule("buffer-processor.js");
      modulesLoaded.add("buffer-processor.js");
    }
    if (!store.registry) store.registry = new AudioWorkletNode(ctx, "buffer-registry");
    const port = store.registry.port;
    const wanted = new Set(list.map((b) => b.name));
    for (const name of store.held.keys()) {
      if (wanted.has(name)) continue;
      port.postMessage({ type: "delete", name });
      store.held.delete(name);
      store.lengths.delete(name);
    }
    let done = 0;
    onProgress?.(0, total);
    for (const b of list) {
      const key = bufferKey(b);
      try {
        if (store.held.get(b.name) !== key) {
          const samples = b.file !== undefined
            ? await decodeMono(ctx, b.file)
            : new Float32Array(Math.max(1, Math.round(b.seconds * ctx.sampleRate)));
          // Read the length first: the transfer detaches `samples`.
          const seconds = samples.length / ctx.sampleRate;
          port.postMessage({ type: "set", name: b.name, samples }, [samples.buffer]);
          store.held.set(b.name, key);
          store.lengths.set(b.name, seconds);
        }
        lengths.set(b.id, store.lengths.get(b.name));
      } catch (err) {
        // A failed reload must not leave the old samples under the name.
        if (store.held.has(b.name)) port.postMessage({ type: "delete", name: b.name });
        store.held.delete(b.name);
        store.lengths.delete(b.name);
        errors.push(`buffer~ ${b.name}: ${b.file ?? b.seconds} failed to load: ${err?.message ?? err}`);
      }
      onProgress?.(++done, total);
    }
    return { lengths, errors };
  };
  const result = store.chain.then(run);
  store.chain = result.catch(() => {});
  return result;
}

// --- Exports ---
export { ENGINES, SIGNAL_WORKLETS, MATH_OPS, BASE_NATIVE_NODES, createEngine, syncBuffers, createNativeNode, createSignalWorklet, createMathNode, getEngineOutput };
