/**
 * Graph Core — shared evaluation logic
 *
 * Pure functions for box state creation, evaluation, ticking, and event handling.
 * Used by both server.ts (ctrl-side) and graph.js (synth-side).
 * No I/O, no propagation — callers handle wiring.
 */

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

const SIG_BEHAVIOURS = ["shuffle", "asc", "desc", "random"];

function parseValues(s) {
  // If it contains a dot or only commas (no dashes for ranges), parse as float CSV
  if (s.includes(".") || !s.match(/\d-\d/)) return s.split(",").map(Number);
  // Otherwise use integer notation (supports ranges like 1-5)
  return expandIntegerNotation(s);
}

function createSigState(args) {
  const parts = args.split(/\s+/);
  const firstIsBehaviour = SIG_BEHAVIOURS.includes(parts[0]);
  const values = firstIsBehaviour ? [0] : parseValues(parts[0] || "0");
  const behaviour = firstIsBehaviour ? parts[0] : (parts[1] || "asc");
  return {
    values: [...values],
    behaviour,
    index: Math.floor(Math.random() * values.length),
  };
}

function advanceSig(state) {
  // Guard: empty values → nothing to advance, reset index and output 0.
  if (!state.values || state.values.length === 0) {
    state.index = 0;
    return 0;
  }
  // Guard: recover from NaN/invalid index (e.g. after values was emptied
  // then repopulated — prior modulo-by-zero leaves index as NaN).
  if (!Number.isFinite(state.index) || state.index < 0 || state.index >= state.values.length) {
    state.index = 0;
  }
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

// --- Envelope shape functions ---

function sigmoidShape(t, duty, curve) {
  const d = Math.max(0.001, Math.min(0.999, duty));
  let phi;
  if (t <= d) phi = 0.5 * t / d;
  else phi = 0.5 + 0.5 * (t - d) / (1 - d);
  if (curve < 0.1) return phi;
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

// --- Box state creation ---

function createBoxState(type, args, instanceIndex, instanceCount) {
  switch (type) {
    case "seq":
      return createSigState(args || "0 asc");
    case "range": {
      const parts = (args || "0 1").split(/\s+/).map(Number);
      const min = parts[0] || 0, max = parts[1] || 1;
      return { min, max, value: min + Math.random() * (max - min) };
    }
    case "spread": {
      const parts = (args || "0 1").split(/\s+/).map(Number);
      const min = parts[0] || 0, max = parts[1] || 1;
      const t = (instanceCount || 1) > 1 ? (instanceIndex || 0) / ((instanceCount || 1) - 1) : 0.5;
      return { min, max, value: min + t * (max - min) };
    }
    case "drunk":
      return { value: Math.random(), step: parseFloat(args) || 0.01 };
    case "lfo": {
      const tokens = (args || "1").split(/\s+/);
      return { phase: 0, period: parseFloat(tokens[0]) || 1, bipolar: tokens.includes("bipolar") };
    }
    case "phasor": {
      const parts = (args || "1").split(/\s+/);
      return { phase: 0, period: parseFloat(parts[0]) || 1, paused: false, loop: parts[1] !== "once" };
    }
    case "metro":
      return { elapsed: 0, interval: parseFloat(args) || 1, paused: false };
    case "const":
      return { value: parseFloat(args) || 0 };
    case "map":
      return { table: (args || "0").split(/\s+/).map(Number) };
    case "change":
      return { prev: undefined };
    case "toggle":
      return { value: parseFloat(args) > 0 ? 1 : 0 };
    case "counter": {
      const parts = (args || "0 7").split(/\s+/).map(Number);
      return { count: parts[0] || 0, min: parts[0] || 0, max: parts[1] || 7 };
    }
    case "ar": {
      const parts = (args || "0.1 0.5").split(/\s+/).map(Number);
      return { value: 0, phase: "idle", elapsed: 0, attack: parts[0] || 0.1, release: parts[1] || 0.5 };
    }
    case "adsr": {
      const parts = (args || "0.05 0.1 0.7 0.3").split(/\s+/).map(Number);
      return { value: 0, phase: "idle", elapsed: 0, a: parts[0] || 0.05, d: parts[1] || 0.1, s: parts[2] || 0.7, r: parts[3] || 0.3, gateOpen: false };
    }
    case "ramp": {
      const parts = (args || "0 1 0.5 1").split(/\s+/).map(Number);
      const from = parts[0] !== undefined && !isNaN(parts[0]) ? parts[0] : 0;
      const to = parts[1] !== undefined && !isNaN(parts[1]) ? parts[1] : 1;
      return { value: from, from, to, duration: parts[2] || 0.5, curve: parts[3] || 1, phase: "idle", elapsed: 0 };
    }
    case "delay":
      return { queue: [], time: parseFloat(args) || 0.5 };
    case "slew":
      return { value: 0, target: 0, rate: parseFloat(args) || 0.05 };
    case "lag":
      return { value: 0, target: 0, coeff: parseFloat(args) || 0.2 };
    case "sample-hold":
      return { value: 0 };
    case "step": {
      const parts = (args || "1 0.5").split(/\s+/).map(Number);
      return { active: false, remaining: 0, amplitude: parts[0] || 1, length: parts[1] || 0.5 };
    }
    case "sigmoid": {
      const tokens = (args || "0 1 0.5 0.5 6").split(/\s+/);
      const mode = (tokens[tokens.length - 1] === "interrupt") ? "interrupt" : "respect";
      const parts = tokens.map(Number);
      return { phase: "idle", elapsed: 0, value: parts[0] || 0, start: parts[0] || 0, end: parts[1] !== undefined ? parts[1] : 1, duration: parts[2] || 0.5, duty: parts[3] !== undefined ? parts[3] : 0.5, curve: parts[4] !== undefined ? parts[4] : 6, mode };
    }
    case "cosine": {
      const tokens = (args || "1 0.5 0.5 1").split(/\s+/);
      const mode = (tokens[tokens.length - 1] === "interrupt") ? "interrupt" : "respect";
      const parts = tokens.map(Number);
      return { phase: "idle", elapsed: 0, value: 0, amplitude: parts[0] !== undefined ? parts[0] : 1, duration: parts[1] || 0.5, duty: parts[2] !== undefined ? parts[2] : 0.5, curve: parts[3] !== undefined ? parts[3] : 1, mode };
    }
    case "random": {
      const parts = (args || "0 1").split(/\s+/).map(Number);
      const min = parts[0] !== undefined ? parts[0] : 0;
      const max = parts[1] !== undefined ? parts[1] : 1;
      const curve = parts[2] || 1;
      return { min, max, curve, value: min + Math.pow(Math.random(), curve) * (max - min) };
    }
    case "fan":
      return { values: (args || "0").split(/\s+/).map(Number) };
    case "trigger": case "t":
      return { types: (args || "b").split(/\s+/) };
    case "select": case "sel":
      return { matchValues: (args || "0").split(/\s+/).map(Number) };
    case "swap":
      return { defaultRight: parseFloat(args) || 0 };
    case "spigot":
      return {};
    case "held":
      return { pitches: [] };
    default:
      return null;
  }
}

// --- Pure evaluation (stateless math boxes) ---

function evaluatePure(type, args, iv) {
  args = args.filter(a => a !== "hot");
  const a = iv[0] || 0;
  const b = iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 0;
  switch (type) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * (iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 1);
    case "/": { const d = iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 1; return d !== 0 ? a / d : 0; }
    case "%": { const d = iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 1; return d !== 0 ? a % d : 0; }
    case "**": { const exp = iv[1] !== undefined ? iv[1] : parseFloat(args[0]) || 1; return Math.sign(a) * Math.pow(Math.abs(a), exp); }
    case "scale": { const min = parseFloat(args[0]) || 0, max = parseFloat(args[1]) || 1, curve = parseFloat(args[2]) || 1; return Math.pow(Math.max(0, Math.min(1, a)), curve) * (max - min) + min; }
    case "clip": { const min = parseFloat(args[0]) || 0, max = parseFloat(args[1]) || 1; return Math.max(min, Math.min(max, a)); }
    case "mtof": return 440 * Math.pow(2, ((iv[0] || 69) - 69) / 12);
    case "const": return parseFloat(args[0]) || 0;
    case "gate": return (iv[1] || 0) > 0 ? a : 0;
    case "spigot": return a; // gate check at propagation level
    case "quantize": { const d = parseFloat(args[0]) || 12; return Math.round(a * d) / d; }
    case "length": return Array.isArray(iv[0]) ? iv[0].length : 1;
    case "sort": {
      if (!Array.isArray(iv[0])) return iv[0];
      const desc = args[0] === "desc";
      return [...iv[0]].sort((x, y) => desc ? y - x : x - y);
    }
    case "nth": {
      const n = parseInt(args[0]) || 0;
      if (!Array.isArray(iv[0])) return 0;
      const arr = iv[0];
      const idx = n < 0 ? arr.length + n : n;
      return (idx >= 0 && idx < arr.length) ? arr[idx] : 0;
    }
    case "octaves": {
      if (!Array.isArray(iv[0])) return iv[0];
      const raw = iv[1] !== undefined ? iv[1] : (parseFloat(args[0]) || 0);
      const n = Math.max(0, raw);
      const fullLayers = Math.floor(n);
      const frac = n - fullLayers;
      const arr = iv[0];
      const out = [];
      // k = 0 is originals; k = 1..fullLayers are full octave layers above.
      for (let k = 0; k <= fullLayers; k++) {
        for (const p of arr) out.push(p + 12 * k);
      }
      // Fractional layer: add the first floor(frac × arr.length) notes of the
      // next octave up, so sweeping N adds notes one at a time rather than in
      // whole-layer jumps.
      if (frac > 0 && arr.length > 0) {
        const partialCount = Math.floor(frac * arr.length);
        for (let i = 0; i < partialCount; i++) out.push(arr[i] + 12 * (fullLayers + 1));
      }
      return out;
    }
    case "floor": return Math.floor(a);
    case "ceil": return Math.ceil(a);
    case "round": return Math.round(a);
    case "sine": return Math.sin(a * Math.PI * 2) * 0.5 + 0.5;
    case "tri": { const yaw = parseFloat(args[0]) || 0.5; return a < yaw ? (yaw > 0 ? a / yaw : 0) : (yaw < 1 ? (1 - a) / (1 - yaw) : 0); }
    case "jitter": { const amount = parseFloat(args[0]) || 0.01; return a + (Math.random() * 2 - 1) * amount; }
    case "&&": return (a > 0 && b > 0) ? 1 : 0;
    case "||": return (a > 0 || b > 0) ? 1 : 0;
    case "xor": return ((a > 0) !== (b > 0)) ? 1 : 0;
    case "!": return a > 0 ? 0 : 1;
    case ">": return a > b ? 1 : 0;
    case "<": return a < b ? 1 : 0;
    case "==": return Math.abs(a - b) < 0.0001 ? 1 : 0;
    default: return null; // not a pure box
  }
}

// --- Stateful box read (returns current output without mutation) ---

function evaluateStateful(type, state) {
  switch (type) {
    case "lfo": {
      const raw = Math.sin(state.phase * Math.PI * 2);
      return state.bipolar ? raw : raw * 0.5 + 0.5;
    }
    case "seq": return state.values[state.index];
    case "phasor": return state.phase;
    case "slew": case "lag": return state.value;
    case "step": return state.active ? state.amplitude : 0;
    case "range": case "spread": case "drunk": case "ar": case "adsr":
    case "ramp": case "sample-hold": case "sigmoid": case "cosine": case "random":
      return state.value;
    default: return null;
  }
}

// --- Event handling (state mutation on trigger) ---
// Returns { value, propagate } — caller decides what to do with the output.
// propagate=false means the box is tick-driven (ar, ramp, sigmoid, cosine) — no immediate output.

function handleBoxEvent(type, state, iv) {
  switch (type) {
    case "seq":
      if (iv[1] !== undefined && typeof iv[1] === "string") state.behaviour = iv[1];
      if (iv[2] !== undefined && Array.isArray(iv[2])) {
        state.values = [...iv[2]];
        if (state.index >= state.values.length) state.index = 0;
      }
      return { value: advanceSig(state), propagate: true };
    case "range":
      state.value = state.min + Math.random() * (state.max - state.min);
      return { value: state.value, propagate: true };
    case "drunk":
      state.value += (Math.random() * 2 - 1) * state.step;
      state.value = Math.max(0, Math.min(1, state.value));
      return { value: state.value, propagate: true };
    case "phasor":
      state.phase = 0;
      return { value: 0, propagate: true };
    case "counter":
      state.count++;
      if (state.count > state.max) state.count = state.min;
      return { value: state.count, propagate: true };
    case "ar":
      if (iv[1] > 0) state.attack = iv[1];
      if (iv[2] > 0) state.release = iv[2];
      state.phase = "attack";
      state.elapsed = 0;
      return { value: state.value, propagate: false };
    case "ramp":
      if (iv[1] !== undefined) state.from = iv[1];
      if (iv[2] !== undefined) state.to = iv[2];
      if (iv[3] !== undefined) state.duration = Math.max(0.001, iv[3]);
      if (iv[4] !== undefined) state.curve = iv[4];
      state.value = state.from;
      state.phase = "running";
      state.elapsed = 0;
      return { value: state.value, propagate: false };
    case "delay":
      state.queue.push({ value: 1, remaining: state.time });
      return { value: 0, propagate: false };
    case "const":
      return { value: state.value, propagate: true };
    case "toggle":
      state.value = state.value > 0 ? 0 : 1;
      return { value: state.value, propagate: true };
    case "sample-hold":
      state.value = iv[0] || 0;
      return { value: state.value, propagate: true };
    case "step": {
      const amp = iv[1] !== undefined ? iv[1] : state.amplitude;
      const len = iv[2] !== undefined ? iv[2] : state.length;
      state.active = true;
      state.remaining = len;
      return { value: amp, propagate: true };
    }
    case "sigmoid":
      if (state.mode === "respect" && state.phase !== "idle") return { value: state.value, propagate: false };
      if (iv[1] !== undefined) state.start = iv[1];
      if (iv[2] !== undefined) state.end = iv[2];
      if (iv[3] !== undefined) state.duration = Math.max(0.001, iv[3]);
      if (iv[4] !== undefined) state.duty = iv[4];
      if (iv[5] !== undefined) state.curve = iv[5];
      state.phase = "running";
      state.elapsed = 0;
      state.value = state.start;
      return { value: state.value, propagate: false };
    case "cosine":
      if (state.mode === "respect" && state.phase !== "idle") return { value: state.value, propagate: false };
      if (iv[1] !== undefined) state.amplitude = iv[1];
      if (iv[2] !== undefined) state.duration = Math.max(0.001, iv[2]);
      if (iv[3] !== undefined) state.duty = iv[3];
      if (iv[4] !== undefined) state.curve = iv[4];
      state.phase = "running";
      state.elapsed = 0;
      state.value = 0;
      return { value: state.value, propagate: false };
    case "random":
      state.value = state.min + Math.pow(Math.random(), state.curve || 1) * (state.max - state.min);
      return { value: state.value, propagate: true };
    case "fan":
      // Output each stored value on its corresponding outlet
      return { value: 0, propagate: false, outputs: state.values.map((v, i) => ({ outlet: i, value: v, type: "value" })) };
    case "held": {
      const pitch = iv[0];
      const velocity = iv[1];
      if (typeof pitch !== "number") return null;
      const idx = state.pitches.indexOf(pitch);
      const outputs = [];
      if (velocity > 0) {
        if (idx === -1) {
          state.pitches.push(pitch);
          outputs.push({ outlet: 1, value: null, type: "event" });
        }
      } else {
        if (idx !== -1) {
          state.pitches.splice(idx, 1);
          outputs.push({ outlet: 2, value: null, type: "event" });
        }
      }
      outputs.push({ outlet: 0, value: [...state.pitches], type: "value" });
      outputs.push({ outlet: 3, value: state.pitches.length, type: "value" });
      return { value: 0, propagate: false, outputs };
    }
    case "trigger": case "t": {
      const types = state.types || ["b"];
      const outputs = [];
      for (let i = types.length - 1; i >= 0; i--) {  // right-to-left
        if (types[i] === "b") outputs.push({ outlet: i, value: null, type: "event" });
        else outputs.push({ outlet: i, value: typeof iv[0] === "number" ? iv[0] : 0, type: "value" });
      }
      return { value: 0, propagate: false, outputs };
    }
    case "select": case "sel": {
      const vals = state.matchValues;
      const outputs = [];
      const matchIdx = vals.indexOf(iv[0]);
      if (matchIdx >= 0) {
        outputs.push({ outlet: matchIdx, value: null, type: "event" });
      } else {
        outputs.push({ outlet: vals.length, value: iv[0], type: "value" });
      }
      return { value: 0, propagate: false, outputs };
    }
    case "swap": {
      return { value: 0, propagate: false, outputs: [
        { outlet: 1, value: iv[0], type: "value" },  // right first
        { outlet: 0, value: iv[1] !== undefined ? iv[1] : (state.defaultRight || 0), type: "value" }
      ]};
    }
    default:
      return null;
  }
}

// --- Tick (advance one time step) ---
// Returns { value, events[] } — events are outlet indices that fired (e.g. end-of-cycle).

function tickBox(type, state, iv, dt) {
  switch (type) {
    case "lfo": {
      const period = iv[0] > 0 ? iv[0] : state.period;
      state.phase += dt / period;
      if (state.phase >= 1) state.phase -= 1;
      const raw = Math.sin(state.phase * Math.PI * 2);
      return { value: state.bipolar ? raw : raw * 0.5 + 0.5, events: [] };
    }
    case "phasor": {
      if (state.paused) return null;
      if (iv[2] > 0) return null; // pause inlet (2)
      const period = iv[1] > 0 ? iv[1] : state.period;
      state.phase += dt / period;
      const events = [];
      if (state.phase >= 1) {
        if (state.loop) { state.phase -= 1; } else { state.phase = 1; state.paused = true; }
        events.push(1); // wrap/end event on outlet 1
      }
      return { value: state.phase, events };
    }
    case "metro": {
      if (state.paused) return null;
      if (iv[0] !== undefined && !(iv[0] > 0)) return null;
      const interval = iv[1] > 0 ? iv[1] : state.interval;
      state.elapsed += dt;
      if (state.elapsed >= interval) {
        state.elapsed -= interval;
        return { value: 1, events: [0] }; // bang on outlet 0
      }
      return { value: state.elapsed / interval, events: [] };
    }
    case "ar": {
      if (state.phase === "idle") return null;
      state.elapsed += dt;
      const events = [];
      if (state.phase === "attack") {
        state.value = Math.min(1, state.elapsed / state.attack);
        if (state.elapsed >= state.attack) { state.phase = "release"; state.elapsed = 0; }
      } else if (state.phase === "release") {
        state.value = Math.max(0, 1 - state.elapsed / state.release);
        if (state.elapsed >= state.release) { state.value = 0; state.phase = "idle"; events.push(1); }
      }
      return { value: state.value, events };
    }
    case "adsr": {
      const gateNow = (iv[0] || 0) > 0;
      if (gateNow && !state.gateOpen) { state.gateOpen = true; state.phase = "attack"; state.elapsed = 0; }
      else if (!gateNow && state.gateOpen) { state.gateOpen = false; if (state.phase !== "idle") { state.phase = "release"; state.elapsed = 0; } }
      if (state.phase === "idle") return null;
      state.elapsed += dt;
      const events = [];
      if (state.phase === "attack") {
        state.value = Math.min(1, state.elapsed / state.a);
        if (state.elapsed >= state.a) { state.phase = "decay"; state.elapsed = 0; }
      } else if (state.phase === "decay") {
        state.value = 1 - (1 - state.s) * Math.min(1, state.elapsed / state.d);
        if (state.elapsed >= state.d) { state.phase = "sustain"; state.value = state.s; }
      } else if (state.phase === "sustain") {
        state.value = state.s;
      } else if (state.phase === "release") {
        const sv = state.value;
        state.value = sv * Math.max(0, 1 - state.elapsed / state.r);
        if (state.elapsed >= state.r) { state.value = 0; state.phase = "idle"; events.push(1); }
      }
      return { value: state.value, events };
    }
    case "ramp": {
      if (state.phase !== "running") return null;
      state.elapsed += dt;
      const t = Math.min(1, state.elapsed / state.duration);
      const shaped = state.curve === 1 ? t : Math.pow(t, state.curve);
      state.value = state.from + (state.to - state.from) * shaped;
      const events = [];
      if (t >= 1) { state.phase = "idle"; events.push(1); }
      return { value: state.value, events };
    }
    case "delay": {
      const events = [];
      for (let i = state.queue.length - 1; i >= 0; i--) {
        state.queue[i].remaining -= dt;
        if (state.queue[i].remaining <= 0) {
          events.push(0); // fire on outlet 0
          state.queue.splice(i, 1);
        }
      }
      return events.length > 0 ? { value: 1, events } : null;
    }
    case "slew": {
      if (Math.abs(state.value - state.target) <= 0.0001) return null;
      const maxDelta = dt / state.rate;
      const diff = state.target - state.value;
      state.value += Math.sign(diff) * Math.min(Math.abs(diff), maxDelta);
      return { value: state.value, events: [] };
    }
    case "lag": {
      if (Math.abs(state.value - state.target) <= 0.0001) return null;
      const alpha = 1 - Math.exp(-dt / state.coeff);
      state.value += (state.target - state.value) * alpha;
      return { value: state.value, events: [] };
    }
    case "step": {
      if (!state.active) return null;
      state.remaining -= dt;
      if (state.remaining <= 0) {
        state.active = false;
        state.remaining = 0;
        return { value: 0, events: [] };
      }
      return null;
    }
    case "sigmoid": {
      if (state.phase !== "running") return null;
      state.elapsed += dt;
      const t = Math.min(1, state.elapsed / state.duration);
      state.value = state.start + (state.end - state.start) * sigmoidShape(t, state.duty, state.curve);
      const events = [];
      if (t >= 1) { state.value = state.end; state.phase = "idle"; events.push(1); }
      return { value: state.value, events };
    }
    case "cosine": {
      if (state.phase !== "running") return null;
      state.elapsed += dt;
      const t = Math.min(1, state.elapsed / state.duration);
      state.value = state.amplitude * cosineShape(t, state.duty, state.curve);
      const events = [];
      if (t >= 1) { state.value = 0; state.phase = "idle"; events.push(1); }
      return { value: state.value, events };
    }
    default:
      return null;
  }
}

// --- Inlet/outlet type detection ---
// Self-contained — no dependency on gpi-types.js (synth clients don't load it)

function isEventTrigger(type, inlet) {
  if (inlet === 0 && (type === "seq" || type === "counter" || type === "drunk" || type === "ar" || type === "ramp" || type === "delay" || type === "step" || type === "sigmoid" || type === "cosine" || type === "random" || type === "fan" || type === "toggle" || type === "const")) return true;
  if (inlet === 0 && type === "phasor") return true;
  if (inlet === 1 && (type === "sample-hold" || type === "held")) return true;
  return false;
}

// Inlets where arriving values should ALSO fire handleEvent
function firesEvent(type, inlet) {
  return inlet === 0 && (type === "trigger" || type === "t" || type === "select" || type === "sel" || type === "swap");
}

// Hot inlets trigger evaluation; cold inlets just store.
// - inlet 0 is hot by default
// - args "... hot" makes all inlets hot (per-instance opt-in)
// - inletDef.hot:true flag (from gpi-types) makes a specific inlet hot (per-type)
function isHotInlet(type, inlet, args, inletDef) {
  if (inlet === 0) return true;
  if (inletDef?.hot === true) return true;
  if (args && /\bhot\b/.test(args)) return true;
  return false;
}

// Event-typed outlets: tick values are display-only, not propagated
function isEventOutlet(type, outlet) {
  return type === "metro" && outlet === 0;
}

// --- Data-driven inlet routing ---
// Maps inlet index → state field for stateful boxes.
// String = field name (no clamping). Object = { field, min?, max? }.

const INLET_MAPS = {
  adsr:    { 1: { field: "a", min: 0.001 }, 2: { field: "d", min: 0.001 }, 3: { field: "s", min: 0, max: 1 }, 4: { field: "r", min: 0.001 } },
  ar:      { 1: { field: "attack", min: 0.001 }, 2: { field: "release", min: 0.001 } },
  ramp:    { 1: "from", 2: "to", 3: { field: "duration", min: 0.001 }, 4: "curve" },
  sigmoid: { 1: "start", 2: "end", 3: { field: "duration", min: 0.001 }, 4: "duty", 5: "curve" },
  cosine:  { 1: "amplitude", 2: { field: "duration", min: 0.001 }, 3: "duty", 4: "curve" },
  lfo:     { 0: { field: "period", min: 0.001 } },
  phasor:  { 1: { field: "period", min: 0.001 } },
  metro:   { 1: { field: "interval", min: 0.001 } },
  slew:    { 0: "target" },
  lag:     { 0: "target" },
  step:    { 1: "amplitude", 2: "length" },
};

// Apply an inlet value to box state using the inlet map.
// Returns true if handled, false if no mapping exists.
function applyInletToState(type, state, inlet, value) {
  const map = INLET_MAPS[type];
  if (!map || !map[inlet]) return false;
  const entry = map[inlet];
  const field = typeof entry === "string" ? entry : entry.field;
  let v = value;
  if (typeof entry !== "string") {
    if (entry.min !== undefined) v = Math.max(entry.min, v);
    if (entry.max !== undefined) v = Math.min(entry.max, v);
  }
  state[field] = v;
  return true;
}

// --- Propagation harness (shared between client + server) ---
// Both runtimes call these helpers to dispatch values/events to box inlets.
// Recursion (propagateValue/propagateEvent/handleEvent) is provided via the
// `helpers` object so each runtime can supply its own stack.

function mergeUpdates(target, source) {
  for (const eid of Object.keys(source)) {
    if (!target[eid]) target[eid] = {};
    Object.assign(target[eid], source[eid]);
  }
}

// Single source of truth for event-path destination dispatch. Called by both
// client (propagateEvent / processRouterEvent) and server-side equivalents.
//
// `helpers`: { propagateEvent(graph, boxId, outlet) → updates,
//              handleEvent(graph, boxId) → updates,
//              debug?: boolean }
//
// `graph`: { boxes: Map, engines: Map, wireless: Map }
//   Engines map can be empty on server (no engines on ctrl side); the engine
//   branch then never fires, naturally degrading to no-op.
function deliverEventToInlet(graph, boxId, inlet, helpers) {
  const updates = {};
  const node = graph.boxes.get(boxId);
  if (!node) return updates;

  // Wireless send: forward as event to every receiver of the same name.
  if (node.type === "send" || node.type === "s") {
    const name = (node.args || "").trim();
    const w = graph.wireless && graph.wireless.get(name);
    if (w) {
      for (const recvId of w.receives) {
        mergeUpdates(updates, helpers.propagateEvent(graph, recvId, 0));
      }
    }
    return updates;
  }
  // throw sums values; events don't sum, so drop.
  if (node.type === "throw") return updates;
  // sendup channels numbers to the server; events aren't forwarded.
  if (node.type === "sendup") return updates;
  // Wireless receive / passthrough: forward event from outlet 0.
  // This path matters when a router entry lands directly on an r/receive box.
  if (node.type === "receive" || node.type === "r") {
    mergeUpdates(updates, helpers.propagateEvent(graph, boxId, 0));
    return updates;
  }

  // Engine trigger/gate: write 1 to the AudioParam.
  if (graph.engines && graph.engines.has(boxId)) {
    const engine = graph.engines.get(boxId);
    const paramName = engine.paramNames[inlet];
    if (paramName && (paramName === "trigger" || paramName === "gate")) {
      if (helpers.debug) console.log(`  → engine event box:${boxId} ${paramName}=1`);
      updates[boxId] = { [paramName]: 1 };
    }
    return updates;
  }

  // Event-trigger inlets (isEventTrigger) or firesEvent boxes: fire handleEvent.
  if (isEventTrigger(node.type, inlet) || firesEvent(node.type, inlet)) {
    mergeUpdates(updates, helpers.handleEvent(graph, boxId));
    return updates;
  }

  // Everything else (plain number inlets, display sinks): event is dropped.
  return updates;
}

// Single source of truth for value-path destination dispatch. Called by both
// client (propagateValue / processRouterValue) and server-side equivalents.
//
// `helpers`: { propagateValue(graph, boxId, outlet, value) → updates,
//              evaluateNode(graph, boxId) → value,
//              debug?: boolean }
//
// Returns `{ updates, deferEvent }`. When `deferEvent` is true, the caller
// should fire handleEvent for `boxId` — either deferred (cable path) or
// immediately (router-entry path), per the caller's policy.
//
// This helper handles the SHARED destination cases. The two callers may add
// path-specific pre-dispatch (e.g. processRouterValue handles range/drunk
// min/max update before delegating).
function deliverValueToInlet(graph, boxId, inlet, value, helpers, inletDef) {
  const updates = {};
  const node = graph.boxes.get(boxId);
  if (!node) return { updates, deferEvent: false };

  // Always store the incoming value first (preserving arrays). Matches the
  // original cable path where inletValues was set before any branching.
  node.inletValues[inlet] = value;

  // Spigot gate: block downstream propagation on inlet 0 when inlet 1 ≤ 0.
  // The value IS stored (above); we just don't evaluate or forward.
  if (node.type === "spigot" && inlet === 0 && (node.inletValues[1] || 0) <= 0) {
    return { updates, deferEvent: false };
  }

  // Display/sensor sinks: just stored, no dispatch.
  if (node.type === "screen" || node.type === "text" || node.type === "touch") {
    return { updates, deferEvent: false };
  }

  // Wireless send: forward to every named receiver.
  if (node.type === "send" || node.type === "s") {
    const w = graph.wireless && graph.wireless.get((node.args || "").trim());
    if (w) {
      for (const recvId of w.receives) {
        mergeUpdates(updates, helpers.propagateValue(graph, recvId, 0, value));
      }
    }
    return { updates, deferEvent: false };
  }

  // Wireless throw: sum into every named catch's inlet 0.
  if (node.type === "throw") {
    const w = graph.wireless && graph.wireless.get((node.args || "").trim());
    if (w) {
      for (const catchId of w.catches) {
        const catchNode = graph.boxes.get(catchId);
        if (catchNode) {
          catchNode.inletValues[0] = (catchNode.inletValues[0] || 0) + value;
          mergeUpdates(updates, helpers.propagateValue(graph, catchId, 0, catchNode.inletValues[0]));
        }
      }
    }
    return { updates, deferEvent: false };
  }

  // Uplink: queue value on a named channel for the server.
  if (node.type === "sendup") {
    const names = (node.args || "").split(/\s+/).filter(Boolean);
    const chName = names[inlet];
    if (chName && graph.uplinkQueue) graph.uplinkQueue.push({ ch: chName, v: value });
    return { updates, deferEvent: false };
  }

  // Engine destination: write to AudioParam by paramName. Values never fire
  // trigger/gate — only events do (skip those branches).
  if (graph.engines && graph.engines.has(boxId)) {
    const engine = graph.engines.get(boxId);
    const paramName = engine.paramNames[inlet];
    if (paramName) {
      if (paramName === "trigger" || paramName === "gate") return { updates, deferEvent: false };
      if (helpers.debug) console.log(`  → engine box:${boxId} ${paramName}=${value}`);
      updates[boxId] = { [paramName]: value };
    }
    return { updates, deferEvent: false };
  }

  // Event-trigger / firesEvent inlets: caller fires handleEvent.
  if (isEventTrigger(node.type, inlet) || firesEvent(node.type, inlet)) {
    return { updates, deferEvent: true };
  }

  // Cold-store-only stateful boxes (value already stored above; no further side effect).
  if (node.type === "phasor") return { updates, deferEvent: false };
  if (node.type === "sample-hold" && inlet === 0) return { updates, deferEvent: false };
  if (node.type === "adsr" && inlet === 0) return { updates, deferEvent: false };
  if (node.type === "seq" && inlet >= 1) return { updates, deferEvent: false };

  // Data-driven inlet map (adsr/ar/ramp/sigmoid/cosine/lfo/phasor/metro/slew/lag/step).
  if (node.state && applyInletToState(node.type, node.state, inlet, value)) {
    return { updates, deferEvent: false };
  }

  // Toggle inlet 1: flip on rising edge, propagate state.
  if (node.type === "toggle" && inlet === 1) {
    if (node.state) {
      const newVal = value > 0 ? 1 : 0;
      if (newVal !== node.state.value) {
        node.state.value = newVal;
        mergeUpdates(updates, helpers.propagateValue(graph, boxId, 0, node.state.value));
      }
    }
    return { updates, deferEvent: false };
  }

  // Map: inlet 1 replaces table (array); inlet 0 indexes and propagates.
  if (node.type === "map") {
    if (node.state) {
      if (inlet === 1 && Array.isArray(value)) {
        node.state.table = value;
      } else if (inlet === 0) {
        const t = node.state.table;
        const idx = Math.max(0, Math.min(t.length - 1, Math.floor(value)));
        mergeUpdates(updates, helpers.propagateValue(graph, boxId, 0, t[idx] !== undefined ? t[idx] : 0));
      }
    }
    return { updates, deferEvent: false };
  }

  // Change: only propagate when value differs from previous.
  if (node.type === "change") {
    if (node.state && value !== node.state.prev) {
      node.state.prev = value;
      mergeUpdates(updates, helpers.propagateValue(graph, boxId, 0, value));
    }
    return { updates, deferEvent: false };
  }

  // Default: pure math / passthrough. Hot inlet → evaluate + propagate; cold just stored.
  if (!isHotInlet(node.type, inlet, node.args, inletDef)) return { updates, deferEvent: false };
  if (helpers.evaluateNode) {
    const result = helpers.evaluateNode(graph, boxId);
    if (helpers.debug) console.log(`  eval box:${boxId} type:${node.type} inlet[${inlet}]=${value} → ${result}`);
    mergeUpdates(updates, helpers.propagateValue(graph, boxId, 0, result));
  }
  return { updates, deferEvent: false };
}

// --- Exports (CJS for server, globals for browser) ---

if (typeof exports === "object") Object.assign(exports, {
  expandIntegerNotation, SIG_BEHAVIOURS, createSigState, advanceSig,
  sigmoidShape, cosineShape,
  createBoxState, evaluatePure, evaluateStateful,
  handleBoxEvent, tickBox,
  isEventTrigger, firesEvent, isHotInlet, isEventOutlet, parseValues,
  INLET_MAPS, applyInletToState,
  mergeUpdates, deliverEventToInlet, deliverValueToInlet,
});
