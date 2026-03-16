/**
 * GPI Box Type Registry
 * Defines all operator types with their ports, zones, and documentation.
 * Port types: number, event, symbol, array, passthrough
 * Zones: ctrl, synth, any, router
 */

const BOX_TYPES = {
  // --- sources (ctrl-side) ---
  arc:            { zone: "ctrl", description: "Monome Arc encoder.", args: "index", example: "arc 0",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "Encoder position (0-1)" }] },
  breath:         { zone: "ctrl", description: "BBC2 breath pressure. CC#2.",
                    inlets: [], outlets: [
                      { name: "value", type: "number", description: "Pressure (0-1)" },
                      { name: "onset", type: "event", description: "Null event at start of breath" },
                      { name: "offset", type: "event", description: "Null event at end of breath" }] },
  bite:           { zone: "ctrl", description: "BBC2 bite pressure. CC#1.",
                    inlets: [], outlets: [
                      { name: "value", type: "number", description: "Pressure (0-1)" },
                      { name: "onset", type: "event", description: "Null event at start of bite" },
                      { name: "offset", type: "event", description: "Null event at end of bite" }] },
  nod:            { zone: "ctrl", description: "BBC2 head nod. CC#12.",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "Tilt (0-1)" }] },
  tilt:           { zone: "ctrl", description: "BBC2 head tilt. CC#13.",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "Tilt (0-1)" }] },
  key:            { zone: "ctrl", description: "MIDI keyboard input.",
                    inlets: [], outlets: [
                      { name: "pitch", type: "number", description: "Note number (0-127)" },
                      { name: "velocity", type: "number", description: "Velocity (0-1)" }] },
  "grid-region":  { zone: "ctrl", description: "Monome Grid region.", args: "x y w h mode", example: "grid-region 0 0 8 2 sig",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "Region output" }] },

  // --- abstraction interface ---
  inlet:          { zone: "any", description: "Abstraction inlet. Index determines port order.", args: "index", example: "inlet 0",
                    inlets: [], outlets: [{ name: "in", type: "passthrough", description: "Connected inside abstraction" }] },
  outlet:         { zone: "any", description: "Abstraction outlet. Index determines port order.", args: "index", example: "outlet 0",
                    inlets: [{ name: "out", type: "passthrough", description: "Connected inside abstraction" }], outlets: [] },
  comment:        { zone: "any", description: "Documentation text. No ports, just displays text.", isComment: true,
                    inlets: [], outlets: [] },

  // --- values ---
  const:          { zone: "any", description: "Constant value.", args: "value", example: "const 220",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "Constant output" }] },
  number:         { zone: "any", description: "Editable number. Drag to change in performance mode.",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "Current value" }] },
  toggle:         { zone: "any", description: "On/off switch. Click in performance mode.",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "0 or 1" }] },
  print:          { zone: "any", description: "Display incoming value on the box.",
                    inlets: [{ name: "in", type: "passthrough", description: "Value to display" }],
                    outlets: [] },
  event:          { zone: "any", description: "Manual null event. Click in performance mode.",
                    inlets: [], outlets: [{ name: "out", type: "event", description: "Null event on click" }] },

  // --- time ---
  phasor:         { zone: "any", description: "Sawtooth ramp 0-1 over period. 'once' = one-shot (no loop). Command-based through routers.", args: "period [once]", example: "phasor 4",
                    inlets: [
                      { name: "pause", type: "number", description: "0 = run, >0 = pause" },
                      { name: "reset", type: "event", description: "Reset phase to 0" },
                      { name: "period", type: "number", description: "Cycle period in seconds" }],
                    outlets: [
                      { name: "phase", type: "number", description: "Ramp (0-1)" },
                      { name: "eoc", type: "event", description: "Null event at end of cycle" }] },
  metro:          { zone: "any", description: "Periodic null event emitter.", args: "interval", example: "metro 0.5",
                    inlets: [], outlets: [{ name: "out", type: "event", description: "Null event at interval" }] },

  // --- phase shapers (0-1 in → shaped out) ---
  sine:           { zone: "any", description: "Sine waveshaper. Maps 0-1 phase to sine curve.",
                    inlets: [{ name: "in", type: "number", description: "Phase (0-1)" }],
                    outlets: [{ name: "out", type: "number", description: "Shaped output (0-1)" }] },
  tri:            { zone: "any", description: "Triangle waveshaper with adjustable symmetry.", args: "yaw", example: "tri 0.5",
                    inlets: [{ name: "in", type: "number", description: "Phase (0-1)" }],
                    outlets: [{ name: "out", type: "number", description: "Shaped output (0-1)" }] },

  // --- envelopes ---
  ar:             { zone: "any", description: "Attack-release envelope. Triggered by event.", args: "attack release", example: "ar 0.1 0.5",
                    inlets: [
                      { name: "trigger", type: "event", description: "Fire envelope" },
                      { name: "attack", type: "number", description: "Attack time in seconds" },
                      { name: "release", type: "number", description: "Release time in seconds" }],
                    outlets: [
                      { name: "value", type: "number", description: "Envelope output (0-1)" },
                      { name: "end", type: "event", description: "Null event at end of release" }] },
  adsr:           { zone: "any", description: "ADSR envelope. Gate-driven: >0 opens, 0 releases.", args: "a d s r", example: "adsr 0.05 0.1 0.7 0.3",
                    inlets: [
                      { name: "gate", type: "number", description: "Gate signal (>0 = open)" }],
                    outlets: [
                      { name: "value", type: "number", description: "Envelope output (0-1)" },
                      { name: "end", type: "event", description: "Null event at end of release" }] },
  ramp:           { zone: "any", description: "Linear ramp between two values over duration.", args: "from to duration", example: "ramp 0 1 0.5",
                    inlets: [{ name: "trigger", type: "event", description: "Start ramp" }],
                    outlets: [
                      { name: "value", type: "number", description: "Current ramp value" },
                      { name: "end", type: "event", description: "Null event at end of ramp" }] },

  // --- scheduling ---
  delay:          { zone: "any", description: "Delay a value or event.", args: "time", example: "delay 0.5",
                    inlets: [{ name: "in", type: "passthrough", description: "Value or event to delay" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Delayed output" }] },
  sequence:       { zone: "any", description: "Step through values on each null event.", args: "values", example: "sequence 0,0.5,1,0.5",
                    inlets: [{ name: "trigger", type: "event", description: "Advance to next step" }],
                    outlets: [{ name: "value", type: "number", description: "Current step value" }] },
  drunk:          { zone: "any", description: "Random walk. Step on each null event.", args: "step", example: "drunk 0.01",
                    inlets: [{ name: "trigger", type: "event", description: "Take one step" }],
                    outlets: [{ name: "value", type: "number", description: "Current position (0-1)" }] },
  counter:        { zone: "any", description: "Count up on each null event.", args: "min max", example: "counter 0 7",
                    inlets: [{ name: "trigger", type: "event", description: "Increment" }],
                    outlets: [{ name: "value", type: "number", description: "Current count" }] },

  // --- generators ---
  sig:            { zone: "any", description: "Stochastic integer generator. Traverses integer array by behaviour.", args: "values behaviour", example: "sig 1,2,3,5 shuffle",
                    inlets: [
                      { name: "trigger", type: "event", description: "Advance to next value" },
                      { name: "behaviour", type: "symbol", description: "Traversal: shuffle, asc, desc, random" },
                      { name: "values", type: "array", description: "Integer array" }],
                    outlets: [{ name: "value", type: "number", description: "Current selected integer" }] },
  range:          { zone: "any", description: "Per-instance random value within bounds.", args: "min max", example: "range 200 800",
                    inlets: [
                      { name: "min", type: "number", description: "Lower bound" },
                      { name: "max", type: "number", description: "Upper bound" }],
                    outlets: [{ name: "value", type: "number", description: "Resolved value" }] },
  spread:         { zone: "any", description: "Evenly distribute across instances.", args: "min max", example: "spread 0 1",
                    inlets: [
                      { name: "min", type: "number", description: "Value for first instance" },
                      { name: "max", type: "number", description: "Value for last instance" }],
                    outlets: [{ name: "value", type: "number", description: "Per-instance value" }] },

  // --- math / utility ---
  "+":            { zone: "any", description: "Add.", args: "operand", example: "+ 100",
                    inlets: [{ name: "a", type: "number", description: "Left operand" }, { name: "b", type: "number", description: "Right operand (or arg)" }],
                    outlets: [{ name: "result", type: "number", description: "Sum" }] },
  "-":            { zone: "any", description: "Subtract.", args: "operand", example: "- 10",
                    inlets: [{ name: "a", type: "number", description: "Left operand" }, { name: "b", type: "number", description: "Right operand (or arg)" }],
                    outlets: [{ name: "result", type: "number", description: "Difference" }] },
  "*":            { zone: "any", description: "Multiply.", args: "factor", example: "* 0.5",
                    inlets: [{ name: "a", type: "number", description: "Left operand" }, { name: "b", type: "number", description: "Right operand (or arg)" }],
                    outlets: [{ name: "result", type: "number", description: "Product" }] },
  "/":            { zone: "any", description: "Divide.", args: "divisor", example: "/ 2",
                    inlets: [{ name: "a", type: "number", description: "Numerator" }, { name: "b", type: "number", description: "Denominator (or arg)" }],
                    outlets: [{ name: "result", type: "number", description: "Quotient" }] },
  "%":            { zone: "any", description: "Modulo.", args: "divisor", example: "% 12",
                    inlets: [{ name: "a", type: "number", description: "Value" }, { name: "b", type: "number", description: "Modulus (or arg)" }],
                    outlets: [{ name: "result", type: "number", description: "Remainder" }] },
  "**":           { zone: "any", description: "Exponent.", args: "power", example: "** 2",
                    inlets: [{ name: "base", type: "number", description: "Base value" }, { name: "exp", type: "number", description: "Exponent (or arg)" }],
                    outlets: [{ name: "result", type: "number", description: "Result" }] },
  scale:          { zone: "any", description: "Map 0-1 input to output range.", args: "min max", example: "scale 55 880",
                    inlets: [{ name: "in", type: "number", description: "Input (0-1)" }],
                    outlets: [{ name: "out", type: "number", description: "Scaled output" }] },
  clip:           { zone: "any", description: "Clamp value to range.", args: "min max", example: "clip 0 1",
                    inlets: [{ name: "in", type: "number", description: "Input value" }],
                    outlets: [{ name: "out", type: "number", description: "Clamped output" }] },
  pow:            { zone: "any", description: "Raise to power.", args: "exponent", example: "pow 2",
                    inlets: [{ name: "in", type: "number", description: "Base" }],
                    outlets: [{ name: "out", type: "number", description: "Result" }] },
  quantize:       { zone: "any", description: "Snap to N equal divisions of 0-1.", args: "divisions", example: "quantize 12",
                    inlets: [{ name: "in", type: "number", description: "Input (0-1)" }],
                    outlets: [{ name: "out", type: "number", description: "Quantized output" }] },
  slew:           { zone: "any", description: "Portamento / slew limiter.", args: "time", example: "slew 0.05",
                    inlets: [{ name: "in", type: "number", description: "Target value" }],
                    outlets: [{ name: "out", type: "number", description: "Smoothed output" }] },
  lag:            { zone: "any", description: "Exponential smoothing.", args: "time", example: "lag 0.2",
                    inlets: [{ name: "in", type: "number", description: "Input value" }],
                    outlets: [{ name: "out", type: "number", description: "Smoothed output" }] },
  mtof:           { zone: "any", description: "MIDI note number to frequency.",
                    inlets: [{ name: "note", type: "number", description: "MIDI note (0-127)" }],
                    outlets: [{ name: "freq", type: "number", description: "Frequency in Hz" }] },
  gate:           { zone: "any", description: "Pass or block signal.",
                    inlets: [{ name: "in", type: "number", description: "Signal" }, { name: "gate", type: "number", description: "0 = block, >0 = pass" }],
                    outlets: [{ name: "out", type: "number", description: "Gated signal" }] },
  switch:         { zone: "any", description: "Route input to selected outlet.", args: "count", example: "switch 3",
                    inlets: [{ name: "in", type: "number", description: "Signal" }, { name: "select", type: "number", description: "Outlet index" }],
                    outlets: [{ name: "out", type: "number", description: "Selected output" }] },
  jitter:         { zone: "any", description: "Add per-instance random offset.", args: "amount", example: "jitter 0.02",
                    inlets: [{ name: "in", type: "number", description: "Input value" }],
                    outlets: [{ name: "out", type: "number", description: "Jittered output" }] },

  // --- routers (snap to border) ---
  all:            { zone: "router", description: "Send to all connected phones. Arg: number of channels.", args: "channels", example: "all 4",
                    dynamic: true,
                    inlets: [{ name: "in", type: "passthrough", description: "Value to send" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Value on each phone" }] },
  one:            { zone: "router", description: "Send to one phone at a time.",
                    inlets: [{ name: "in", type: "passthrough", description: "Value to send" }, { name: "trigger", type: "event", description: "Select next phone" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Value on selected phone" }] },
  fraction:       { zone: "router", description: "Send to a random subset of phones.", args: "fraction", example: "fraction 0.5",
                    inlets: [{ name: "in", type: "passthrough", description: "Value to send" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Value on selected phones" }] },
  sweep:          { zone: "router", description: "Send sequentially across phones on each null event.", args: "steps", example: "sweep 16",
                    inlets: [{ name: "in", type: "passthrough", description: "Value to send" }, { name: "trigger", type: "event", description: "Advance to next phone" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Value on current phone" }] },

  "sample-hold":  { zone: "any", description: "Capture value on trigger, hold until next.",
                    inlets: [
                      { name: "in", type: "number", description: "Value to sample" },
                      { name: "trigger", type: "event", description: "Sample now" }],
                    outlets: [{ name: "out", type: "number", description: "Held value" }] },

  // --- engines (synth-side) ---
  "sine-osc":     { zone: "synth", description: "Pure sine tone oscillator.",
                    inlets: [
                      { name: "freq", type: "number", description: "Frequency in Hz" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [] },
  noise:          { zone: "synth", description: "Filtered noise generator.",
                    inlets: [
                      { name: "cutoff", type: "number", description: "Lowpass cutoff in Hz (20-20000)" },
                      { name: "resonance", type: "number", description: "Filter resonance (0-1)" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [] },
  shepard:        { zone: "synth", description: "Shepard tone generator.",
                    inlets: [
                      { name: "baseFreq", type: "number", description: "Base frequency in Hz" },
                      { name: "partialCount", type: "number", description: "Number of partials" },
                      { name: "bandwidth", type: "number", description: "Spectral bandwidth" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [] },
  "impulse-cloud": { zone: "synth", description: "Stochastic impulse cloud.",
                    inlets: [
                      { name: "density", type: "number", description: "Events per second" },
                      { name: "width", type: "number", description: "Impulse width in samples" },
                      { name: "freq", type: "number", description: "Center frequency in Hz" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [] },
  bass:           { zone: "synth", description: "Bass oscillator. Square/saw with filter and PWM.",
                    inlets: [
                      { name: "freq", type: "number", description: "Frequency in Hz" },
                      { name: "filterCutoff", type: "number", description: "Lowpass cutoff in Hz" },
                      { name: "pwm", type: "number", description: "Pulse width (0-1)" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [] },
  formant:        { zone: "synth", description: "Formant synthesis. Vowel-space interpolation with FM and ring modulation.",
                    inlets: [
                      { name: "frequency", type: "number", description: "Fundamental frequency in Hz" },
                      { name: "vowelX", type: "number", description: "Vowel X axis (0-1, front-back)" },
                      { name: "vowelY", type: "number", description: "Vowel Y axis (0-1, open-close)" },
                      { name: "zingAmount", type: "number", description: "Ring modulation depth (0-1)" },
                      { name: "symmetry", type: "number", description: "Waveform asymmetry (0-1)" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [] },
  "karplus-strong": { zone: "synth", description: "Karplus-Strong plucked string synthesis.",
                    inlets: [
                      { name: "freq", type: "number", description: "Frequency in Hz" },
                      { name: "damping", type: "number", description: "Decay rate (0-1)" },
                      { name: "brightness", type: "number", description: "Lowpass filter (0-1)" },
                      { name: "excitation", type: "number", description: "Noise burst level (0-1)" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [] },
};

// --- Helpers ---

function boxTypeName(text) {
  return (text || "").split(/\s+/)[0];
}

function getBoxPorts(text) {
  const def = BOX_TYPES[boxTypeName(text)];
  if (!def) return { inlets: 1, outlets: 1 };
  if (def.dynamic) {
    const n = parseInt(text.split(/\s+/)[1]) || 1;
    return { inlets: n, outlets: n };
  }
  return { inlets: def.inlets.length, outlets: def.outlets.length };
}

function getBoxZone(text) {
  const def = BOX_TYPES[boxTypeName(text)];
  return def ? def.zone : "any";
}

function getBoxDef(text) {
  return BOX_TYPES[boxTypeName(text)] || null;
}

// ES module / CJS exports (server.ts uses CJS-style, browser uses ESM)
if (typeof exports === "object") Object.assign(exports, { BOX_TYPES, boxTypeName, getBoxPorts, getBoxZone, getBoxDef });
export { BOX_TYPES, boxTypeName, getBoxPorts, getBoxZone, getBoxDef };

