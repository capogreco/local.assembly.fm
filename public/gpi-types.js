/**
 * GPI Box Type Registry
 * Defines all operator types with their ports, zones, and documentation.
 * Port types: number, event, symbol, array, passthrough
 * Zones: ctrl, synth, any, router
 */

const BOX_TYPES = {
  // --- sources (ctrl-side) ---
  arc:            { zone: "ctrl", description: "Monome Arc encoder. Mode 0: continuous rotation (0-1). Optional init value.", args: "i m [init]", example: "arc 0 0 0.5",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "Encoder position (0-1)" }] },
  breath:         { zone: "ctrl", description: "BBC2 breath pressure. CC#2. Optional init value.", args: "[init]",
                    inlets: [], outlets: [
                      { name: "value", type: "number", description: "Pressure (0-1)" },
                      { name: "onset", type: "event", description: "Null event at start of breath" },
                      { name: "offset", type: "event", description: "Null event at end of breath" }] },
  bite:           { zone: "ctrl", description: "BBC2 bite pressure. CC#1. Optional init value.", args: "[init]",
                    inlets: [], outlets: [
                      { name: "value", type: "number", description: "Pressure (0-1)" },
                      { name: "onset", type: "event", description: "Null event at start of bite" },
                      { name: "offset", type: "event", description: "Null event at end of bite" }] },
  nod:            { zone: "ctrl", description: "BBC2 head nod. CC#12. Optional init value.", args: "[init]",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "Tilt (0-1)" }] },
  tilt:           { zone: "ctrl", description: "BBC2 head tilt. CC#13. Optional init value.", args: "[init]",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "Tilt (0-1)" }] },
  cc:             { zone: "ctrl", description: "MIDI CC input. Arg is CC number. No arg = monitor all CCs (displays cc:value).", args: "[number]", example: "cc 1",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "CC value (0-1)" }] },
  key:            { zone: "ctrl", description: "MIDI keyboard input.",
                    inlets: [], outlets: [
                      { name: "pitch", type: "number", description: "Note number (0-127)" },
                      { name: "velocity", type: "number", description: "Velocity (0-1)" }] },
  "grid-trig":    { zone: "ctrl", description: "Monome Grid trigger region. Outputs 1 on press, 0 on release.", args: "x y w h", example: "grid-trig 0 0 4 2",
                    inlets: [], outlets: [{ name: "trig", type: "number", description: "1 when pressed, 0 when released" }] },
  "grid-toggle":  { zone: "ctrl", description: "Monome Grid toggle region. Press to flip between 0 and 1.", args: "x y w h", example: "grid-toggle 4 0 2 1",
                    inlets: [], outlets: [{ name: "state", type: "number", description: "Toggle state (0 or 1)" }] },
  "grid-array":   { zone: "ctrl", description: "Monome Grid integer array. Press to toggle values, hold+press for range fill/clear.", args: "x y w h", example: "grid-array 0 2 12 1",
                    inlets: [], outlets: [{ name: "array", type: "array", description: "Array of 1-indexed integers" }] },
  uplink:         { zone: "ctrl", description: "Receive values from synth clients on named channels.", args: "name1 [name2 ...]", example: "uplink tx ty tg",
                    dynamic: true,
                    inlets: [], outlets: [{ name: "out", type: "number", description: "Value from synth" }] },

  // --- abstraction interface ---
  inlet:          { zone: "any", description: "Abstraction inlet. Index determines port order.", args: "index", example: "inlet 0",
                    inlets: [], outlets: [{ name: "in", type: "passthrough", description: "Connected inside abstraction" }] },
  outlet:         { zone: "any", description: "Abstraction outlet. Index determines port order.", args: "index", example: "outlet 0",
                    inlets: [{ name: "out", type: "passthrough", description: "Connected inside abstraction" }], outlets: [] },
  comment:        { zone: "any", description: "Documentation text. No ports, just displays text.", isComment: true,
                    inlets: [], outlets: [] },
  "//":           { zone: "any", description: "Comment. Same as comment.", isComment: true,
                    inlets: [], outlets: [] },

  // --- values ---
  const:          { zone: "any", description: "Constant value.", args: "value", example: "const 220",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "Constant output" }] },
  knob:           { zone: "any", description: "Interactive knob. Scroll wheel to change value. Args: init [min] [max] [curve].", args: "init [min] [max] [curve]", example: "knob 0.5 0 1",
                    inlets: [], outlets: [{ name: "value", type: "number", description: "Current value" }] },
  toggle:         { zone: "any", description: "On/off switch. Click or event to flip.",
                    inlets: [{ name: "trigger", type: "event", description: "Flip state" }],
                    outlets: [{ name: "value", type: "number", description: "0 or 1" }] },
  print:          { zone: "any", description: "Display incoming value on the box.",
                    inlets: [{ name: "in", type: "passthrough", description: "Value to display" }],
                    outlets: [] },
  event:          { zone: "any", description: "Manual null event. Click in performance mode.",
                    inlets: [], outlets: [{ name: "out", type: "event", description: "Null event on click" }] },

  // --- time ---
  phasor:         { zone: "any", description: "Sawtooth ramp 0-1 over period. 'once' = one-shot (no loop).", args: "period [once]", example: "phasor 4",
                    inlets: [
                      { name: "reset", type: "event", description: "Reset phase to 0" },
                      { name: "period", type: "number", description: "Cycle period in seconds" },
                      { name: "pause", type: "number", description: "0 = run, >0 = pause" }],
                    outlets: [
                      { name: "phase", type: "number", description: "Ramp (0-1)" },
                      { name: "eoc", type: "event", description: "Null event at end of cycle" }] },
  lfo:            { zone: "any", description: "Sine LFO. Outputs 0-1 (unipolar) or -1 to 1 (bipolar). Append 'bipolar' to args.", args: "period [bipolar]", example: "lfo 4",
                    inlets: [
                      { name: "period", type: "number", description: "Cycle period in seconds" }],
                    outlets: [{ name: "value", type: "number", description: "Sine output" }] },
  metro:          { zone: "any", description: "Periodic null event emitter.", args: "interval", example: "metro 0.5",
                    inlets: [
                      { name: "toggle", type: "number", description: "1 = run, 0 = stop" },
                      { name: "period", type: "number", description: "Interval in seconds" }],
                    outlets: [{ name: "out", type: "event", description: "Null event at interval" }] },

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
                      { name: "gate", type: "number", description: "Gate signal (>0 = open)" },
                      { name: "a", type: "number", description: "Attack time in seconds" },
                      { name: "d", type: "number", description: "Decay time in seconds" },
                      { name: "s", type: "number", description: "Sustain level (0-1)" },
                      { name: "r", type: "number", description: "Release time in seconds" }],
                    outlets: [
                      { name: "value", type: "number", description: "Envelope output (0-1)" },
                      { name: "end", type: "event", description: "Null event at end of release" }] },
  ramp:           { zone: "any", description: "Ramp between two values over duration with curve shaping. curve=1 linear, >1 exponential (slow start), <1 logarithmic (fast start).", args: "from to duration [curve]", example: "ramp 0 1 0.5 2",
                    inlets: [
                      { name: "trigger", type: "event", description: "Start ramp" },
                      { name: "from", type: "number", description: "Start value" },
                      { name: "to", type: "number", description: "End value" },
                      { name: "duration", type: "number", description: "Duration in seconds" },
                      { name: "curve", type: "number", description: "Curve shape (1=linear)" }],
                    outlets: [
                      { name: "value", type: "number", description: "Current ramp value" },
                      { name: "end", type: "event", description: "Null event at end of ramp" }] },
  step:           { zone: "any", description: "Triggered one-shot gate. Jumps to amplitude, holds for length, drops to 0.", args: "amplitude length", example: "step 1 0.5",
                    inlets: [
                      { name: "trigger", type: "event", description: "Fire the envelope" },
                      { name: "amplitude", type: "number", description: "Peak amplitude (overrides arg)" },
                      { name: "length", type: "number", description: "Hold duration in seconds (overrides arg)" }],
                    outlets: [{ name: "value", type: "number", description: "Current envelope value" }] },
  sigmoid:        { zone: "any", description: "Shaped transition from start to end. Phase-distorted sigmoid with variable duty cycle and curve. Append 'interrupt' to retrigger mid-envelope (default: respect).", args: "start end duration duty curve [mode]", example: "sigmoid 0 1 0.5 0.5 6",
                    inlets: [
                      { name: "trigger", type: "event", description: "Fire the envelope" },
                      { name: "start", type: "number", description: "Start value" },
                      { name: "end", type: "number", description: "End value" },
                      { name: "duration", type: "number", description: "Transition time in seconds" },
                      { name: "duty", type: "number", description: "Where transition occurs (0-1, default 0.5)" },
                      { name: "curve", type: "number", description: "Steepness (0=linear, 6=smooth S, 20+=step)" }],
                    outlets: [
                      { name: "value", type: "number", description: "Current envelope value" },
                      { name: "end", type: "event", description: "Null event at end of envelope" }] },
  cosine:         { zone: "any", description: "Shaped hump envelope. Returns to zero. Phase-distorted cosine with variable duty and curve. Append 'interrupt' to retrigger mid-envelope (default: respect).", args: "amplitude duration duty curve [mode]", example: "cosine 1 0.5 0.5 1",
                    inlets: [
                      { name: "trigger", type: "event", description: "Fire the envelope" },
                      { name: "amplitude", type: "number", description: "Peak amplitude" },
                      { name: "duration", type: "number", description: "Total duration in seconds" },
                      { name: "duty", type: "number", description: "Where peak falls (0-1, default 0.5)" },
                      { name: "curve", type: "number", description: "Peakedness (0.5=broad, 1=cosine, 2+=sharp)" }],
                    outlets: [
                      { name: "value", type: "number", description: "Current envelope value" },
                      { name: "end", type: "event", description: "Null event at end of envelope" }] },

  // --- scheduling ---
  delay:          { zone: "any", description: "Delay a value or event.", args: "time", example: "delay 0.5",
                    inlets: [{ name: "in", type: "passthrough", description: "Value or event to delay" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Delayed output" }] },
  seq:            { zone: "any", description: "Sequence iterator. Traverses values by behaviour: asc (default), desc, shuffle, random.", args: "values [behaviour]", example: "seq 1,2,3,5 shuffle",
                    inlets: [
                      { name: "trigger", type: "event", description: "Advance to next value" },
                      { name: "behaviour", type: "symbol", description: "Traversal: asc, desc, shuffle, random" },
                      { name: "values", type: "array", description: "Value array" }],
                    outlets: [{ name: "value", type: "number", description: "Current value" }] },
  drunk:          { zone: "any", description: "Random walk. Step on each null event.", args: "step", example: "drunk 0.01",
                    inlets: [{ name: "trigger", type: "event", description: "Take one step" }],
                    outlets: [{ name: "value", type: "number", description: "Current position (0-1)" }] },
  counter:        { zone: "any", description: "Count up on each null event.", args: "min max", example: "counter 0 7",
                    inlets: [{ name: "trigger", type: "event", description: "Increment" }],
                    outlets: [{ name: "value", type: "number", description: "Current count" }] },

  // --- generators ---
  random:         { zone: "any", description: "Random value on each trigger. Optional curve: 1=uniform (default), 2+=bias low, 0.5=bias high.", args: "min max [curve]", example: "random 0 1 2",
                    inlets: [{ name: "trigger", type: "event", description: "Generate new random value" }],
                    outlets: [{ name: "value", type: "number", description: "Random value in range" }] },
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
  scale:          { zone: "any", description: "Map 0-1 input to output range. Optional curve: 1=linear (default), 2+=exponential, 0.5=logarithmic.", args: "min max [curve]", example: "scale 55 880 2",
                    inlets: [{ name: "in", type: "number", description: "Input (0-1)" }],
                    outlets: [{ name: "out", type: "number", description: "Scaled output" }] },
  clip:           { zone: "any", description: "Clamp value to range.", args: "min max", example: "clip 0 1",
                    inlets: [{ name: "in", type: "number", description: "Input value" }],
                    outlets: [{ name: "out", type: "number", description: "Clamped output" }] },
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
  gate:           { zone: "any", description: "Pass or zero signal. Outputs 0 when closed (cf. spigot which blocks propagation).",
                    inlets: [{ name: "in", type: "number", description: "Signal" }, { name: "gate", type: "number", description: "0 = block, >0 = pass" }],
                    outlets: [{ name: "out", type: "number", description: "Gated signal" }] },
  switch:         { zone: "any", description: "Route input to selected outlet.", args: "count", example: "switch 3",
                    inlets: [{ name: "in", type: "number", description: "Signal" }, { name: "select", type: "number", description: "Outlet index" }],
                    outlets: [{ name: "out", type: "number", description: "Selected output" }] },
  jitter:         { zone: "any", description: "Add per-instance random offset.", args: "amount", example: "jitter 0.02",
                    inlets: [{ name: "in", type: "number", description: "Input value" }],
                    outlets: [{ name: "out", type: "number", description: "Jittered output" }] },

  // --- logic (truthy: >0, falsy: <=0, output: 1 or 0) ---
  "&&":           { zone: "any", description: "Logical AND.", args: "operand",
                    inlets: [{ name: "a", type: "number", description: "Left operand" }, { name: "b", type: "number", description: "Right operand (or arg)" }],
                    outlets: [{ name: "result", type: "number", description: "1 or 0" }] },
  "||":           { zone: "any", description: "Logical OR.", args: "operand",
                    inlets: [{ name: "a", type: "number", description: "Left operand" }, { name: "b", type: "number", description: "Right operand (or arg)" }],
                    outlets: [{ name: "result", type: "number", description: "1 or 0" }] },
  "xor":          { zone: "any", description: "Logical XOR.",
                    inlets: [{ name: "a", type: "number", description: "Left operand" }, { name: "b", type: "number", description: "Right operand" }],
                    outlets: [{ name: "result", type: "number", description: "1 or 0" }] },
  "!":            { zone: "any", description: "Logical NOT.",
                    inlets: [{ name: "in", type: "number", description: "Input" }],
                    outlets: [{ name: "out", type: "number", description: "1 or 0" }] },
  ">":            { zone: "any", description: "Greater than.", args: "operand",
                    inlets: [{ name: "a", type: "number", description: "Left operand" }, { name: "b", type: "number", description: "Right operand (or arg)" }],
                    outlets: [{ name: "result", type: "number", description: "1 or 0" }] },
  "<":            { zone: "any", description: "Less than.", args: "operand",
                    inlets: [{ name: "a", type: "number", description: "Left operand" }, { name: "b", type: "number", description: "Right operand (or arg)" }],
                    outlets: [{ name: "result", type: "number", description: "1 or 0" }] },
  "==":           { zone: "any", description: "Equal (within 0.0001).", args: "operand",
                    inlets: [{ name: "a", type: "number", description: "Left operand" }, { name: "b", type: "number", description: "Right operand (or arg)" }],
                    outlets: [{ name: "result", type: "number", description: "1 or 0" }] },

  // --- fan (multi-value output) ---
  fan:            { zone: "any", description: "Output stored values on trigger. One outlet per value. Click or trigger inlet to fire.", args: "values...", example: "fan 30 500 4000",
                    dynamic: true,
                    inlets: [{ name: "trigger", type: "event", description: "Fire all values" }],
                    outlets: [{ name: "out", type: "number", description: "Value" }] },

  // --- message routing (Pd-style) ---
  trigger:        { zone: "any", description: "Right-to-left outlet firing. Args: b (bang/event) or f (float/value) per outlet.", args: "types...", example: "trigger b f",
                    dynamic: true,
                    inlets: [{ name: "in", type: "passthrough", hot: true, firesEvent: true, description: "Input value or event" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Output" }] },
  t:              { zone: "any", description: "Trigger (shorthand). Right-to-left outlet firing.", args: "types...", example: "t b f",
                    dynamic: true,
                    inlets: [{ name: "in", type: "passthrough", hot: true, firesEvent: true, description: "Input value or event" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Output" }] },
  select:         { zone: "any", description: "Match and route. One event outlet per match value + reject outlet.", args: "values...", example: "select 0 1 2",
                    dynamic: true,
                    inlets: [{ name: "in", type: "number", hot: true, firesEvent: true, description: "Value to match" }],
                    outlets: [{ name: "match", type: "event", description: "Event on match" }] },
  sel:            { zone: "any", description: "Select (shorthand). Match and route.", args: "values...", example: "sel 0 1 2",
                    dynamic: true,
                    inlets: [{ name: "in", type: "number", hot: true, firesEvent: true, description: "Value to match" }],
                    outlets: [{ name: "match", type: "event", description: "Event on match" }] },
  spigot:         { zone: "any", description: "Block propagation. When closed, nothing passes downstream (cf. gate which outputs 0).",
                    inlets: [{ name: "in", type: "number", description: "Signal to pass" }, { name: "gate", type: "number", description: "0 = block, >0 = pass" }],
                    outlets: [{ name: "out", type: "number", description: "Passed signal" }] },
  swap:           { zone: "any", description: "Swap two values. Hot inlet 0, cold inlet 1. Fires right-to-left.", args: "[default]", example: "swap 0",
                    inlets: [{ name: "a", type: "number", hot: true, firesEvent: true, description: "Left value (hot)" }, { name: "b", type: "number", description: "Right value (cold)" }],
                    outlets: [{ name: "left", type: "number", description: "Former right value" }, { name: "right", type: "number", description: "Former left value" }] },

  // --- routers (snap to border) ---
  all:            { zone: "router", description: "Send to all connected phones. Arg: number of channels.", args: "channels", example: "all 4",
                    dynamic: true,
                    inlets: [{ name: "in", type: "passthrough", description: "Value to send" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Value on each phone" }] },
  one:            { zone: "router", description: "Send to one phone at a time. Auto-advances on each value.",
                    inlets: [{ name: "in", type: "passthrough", description: "Value to send" }, { name: "shuffle", type: "event", description: "Randomize visit order" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Value on selected phone" }] },
  group:          { zone: "router", description: "Partitioned send. Phones divided into N groups. Last inlet shuffles membership.", args: "groups", example: "group 3",
                    dynamic: true,
                    inlets: [{ name: "in", type: "passthrough", description: "Value for this group" }, { name: "shuffle", type: "event", description: "Re-randomize groups" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Value received by phone" }] },
  sweep:          { zone: "router", description: "Send sequentially across phones on each null event.", args: "steps", example: "sweep 16",
                    inlets: [{ name: "in", type: "passthrough", description: "Value to send" }, { name: "trigger", type: "event", description: "Advance to next phone" }],
                    outlets: [{ name: "out", type: "passthrough", description: "Value on current phone" }] },
  sall:           { zone: "router", description: "Wireless send-all. Broadcasts to all phones, delivered to matching r boxes.", args: "name1 [name2 ...]", example: "sall freq vowelX",
                    dynamic: true,
                    inlets: [{ name: "in", type: "passthrough", description: "Value to broadcast" }],
                    outlets: [] },

  "sample-hold":  { zone: "any", description: "Capture value on trigger, hold until next.",
                    inlets: [
                      { name: "in", type: "number", description: "Value to sample" },
                      { name: "trigger", type: "event", description: "Sample now" }],
                    outlets: [{ name: "out", type: "number", description: "Held value" }] },

  // --- wireless connections (control-rate) ---
  send:           { zone: "any", description: "Wireless send. One-to-many.", args: "name", example: "send freq",
                    inlets: [{ name: "in", type: "passthrough", description: "Value to send" }], outlets: [] },
  s:              { zone: "any", description: "Wireless send (shorthand).", args: "name", example: "s freq",
                    inlets: [{ name: "in", type: "passthrough", description: "Value to send" }], outlets: [] },
  receive:        { zone: "any", description: "Wireless receive. Receives from matching send.", args: "name", example: "receive freq",
                    inlets: [], outlets: [{ name: "out", type: "passthrough", description: "Received value" }] },
  r:              { zone: "any", description: "Wireless receive (shorthand).", args: "name", example: "r freq",
                    inlets: [], outlets: [{ name: "out", type: "passthrough", description: "Received value" }] },
  throw:          { zone: "any", description: "Wireless throw. Many-to-one summing bus.", args: "name", example: "throw mix",
                    inlets: [{ name: "in", type: "number", description: "Value to add" }], outlets: [] },
  catch:          { zone: "any", description: "Wireless catch. Sums all matching throws.", args: "name", example: "catch mix",
                    inlets: [], outlets: [{ name: "out", type: "number", description: "Summed value" }] },

  // --- synth-side uplink ---
  sendup:         { zone: "synth", description: "Send value from phone back to server on named channels.", args: "name1 [name2 ...]", example: "sendup tx ty tg",
                    dynamic: true,
                    inlets: [{ name: "in", type: "passthrough", description: "Value to send up" }], outlets: [] },

  // --- synth-side display (gel stack) ---
  screen:         { zone: "synth", description: "Full-screen color layer. Args: z-index (default 1).", args: "[z]", example: "screen 2",
                    inlets: [
                      { name: "r", type: "number", description: "Red (0-1)" },
                      { name: "g", type: "number", description: "Green (0-1)" },
                      { name: "b", type: "number", description: "Blue (0-1)" },
                      { name: "a", type: "number", description: "Alpha (0-1, default 0)" }],
                    outlets: [] },
  text:           { zone: "synth", description: "Full-screen centered text. First arg is z-index if numeric, rest is display text.", args: "[z] content...", example: "text 3 drag here",
                    inlets: [
                      { name: "size", type: "number", description: "Font size (0-1, default 0.5)" },
                      { name: "a", type: "number", description: "Alpha (0-1, default 0)" }],
                    outlets: [] },
  touch:          { zone: "synth", description: "Full-screen pointer capture. Pure sensor, no visuals.", args: "",
                    inlets: [{ name: "gate", type: "number", description: "1=enable capture, 0=disable. No cable=always active" }],
                    outlets: [
                      { name: "x", type: "number", description: "Normalized X position (0-1)" },
                      { name: "y", type: "number", description: "Normalized Y position (0-1)" },
                      { name: "gate", type: "number", description: "1 while touching, 0 on release" }] },

  // --- wireless connections (audio-rate) ---
  "send~":        { zone: "any", description: "Wireless audio send. One-to-many.", args: "name", example: "send~ verb",
                    inlets: [{ name: "in", type: "audio", description: "Audio to send" }], outlets: [] },
  "s~":           { zone: "any", description: "Wireless audio send (shorthand).", args: "name", example: "s~ verb",
                    inlets: [{ name: "in", type: "audio", description: "Audio to send" }], outlets: [] },
  "receive~":     { zone: "any", description: "Wireless audio receive. Receives from matching send~.", args: "name", example: "receive~ verb",
                    inlets: [], outlets: [{ name: "out", type: "audio", description: "Received audio" }] },
  "r~":           { zone: "any", description: "Wireless audio receive (shorthand).", args: "name", example: "r~ verb",
                    inlets: [], outlets: [{ name: "out", type: "audio", description: "Received audio" }] },
  "throw~":       { zone: "any", description: "Wireless audio throw. Many-to-one summing bus.", args: "name", example: "throw~ mix",
                    inlets: [{ name: "in", type: "audio", description: "Audio to add" }], outlets: [] },
  "catch~":       { zone: "any", description: "Wireless audio catch. Sums all matching throw~.", args: "name", example: "catch~ mix",
                    inlets: [], outlets: [{ name: "out", type: "audio", description: "Summed audio" }] },

  // --- audio-rate objects (~) — any box with audio ports ---
  "scope~":       { zone: "synth", description: "3D Lissajous oscilloscope. Maps 3 audio signals to X/Y/Z. Knot colour via audio-rate HSB.", args: "[z]", example: "scope~ 5",
                    inlets: [
                      { name: "x", type: "audio", description: "X axis signal" },
                      { name: "y", type: "audio", description: "Y axis signal" },
                      { name: "z", type: "audio", description: "Z axis signal" },
                      { name: "knotH", type: "audio", description: "Knot hue (0-1)" },
                      { name: "knotS", type: "audio", description: "Knot saturation (0-1)" },
                      { name: "knotB", type: "audio", description: "Knot brightness (0-1)" },
                      { name: "persistence", type: "number", description: "Trail length (0-1)" },
                      { name: "zoom", type: "number", description: "Camera distance (0.5-20)" },
                      { name: "spin", type: "number", description: "Auto-rotation speed (0-1)" },
                      { name: "density", type: "number", description: "Points per frame (0=1pt, 1=full)" },
                      { name: "a", type: "number", description: "Alpha (0-1)" }],
                    outlets: [] },
  "adc~":         { zone: "any", description: "Audio input. Channel arg selects input channel from audio interface.", args: "[channel]", example: "adc~ 1",
                    inlets: [],
                    outlets: [{ name: "out", type: "audio", description: "Audio input signal" }] },
  "dac~":         { zone: "any", description: "Audio output. Synth zone: mono to speaker. Ctrl zone: channel arg routes to interface.", args: "[channels...]", example: "dac~ 1 2",
                    inlets: [{ name: "in", type: "audio", description: "Audio signal" }],
                    outlets: [] },
  "const~":       { zone: "any", description: "Constant audio signal.", args: "value", example: "const~ 440",
                    inlets: [],
                    outlets: [{ name: "out", type: "audio", description: "Constant audio signal" }] },
  "sig~":         { zone: "any", description: "Convert number to audio signal. Optional portamento time in seconds.", args: "[portamento]", example: "sig~ 0.1",
                    inlets: [
                      { name: "value", type: "number", description: "Value to output as audio" },
                      { name: "portamento", type: "number", description: "Glide time in seconds" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio signal" }] },
  "chaos~":       { zone: "any", description: "Chaotic attractor. Systems: rossler, lorenz, sprott-b to sprott-s, jerk, sloth. 3 outputs (x,y,z).", args: "system", example: "chaos~ rossler",
                    inlets: [
                      { name: "speed", type: "number", description: "Time dilation (1=audio rate, 0.001=slow)" },
                      { name: "param", type: "number", description: "System-specific character" }],
                    outlets: [
                      { name: "x", type: "audio", description: "State variable X" },
                      { name: "y", type: "audio", description: "State variable Y" },
                      { name: "z", type: "audio", description: "State variable Z" }] },
  "osc~":         { zone: "any", description: "Audio-rate oscillator. Types: sine, square, sawtooth, triangle.", args: "[freq] [type]", example: "osc~ 2 sine",
                    inlets: [
                      { name: "frequency", type: "number", description: "Frequency in Hz" },
                      { name: "detune", type: "number", description: "Detune in cents" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio signal" }] },
  "lfo~":         { zone: "any", description: "Audio-rate LFO. Unipolar (0-1) or bipolar (-1 to 1).", args: "period [bipolar]", example: "lfo~ 4",
                    inlets: [
                      { name: "period", type: "number", description: "Cycle period in seconds" }],
                    outlets: [{ name: "out", type: "audio", description: "LFO signal" }] },
  "phasor~":      { zone: "any", description: "Audio-rate ramp 0-1.", args: "period [once]", example: "phasor~ 4",
                    inlets: [
                      { name: "period", type: "number", description: "Cycle period in seconds" }],
                    outlets: [{ name: "out", type: "audio", description: "Ramp signal" }] },
  "noise~":       { zone: "any", description: "White noise source.",
                    inlets: [],
                    outlets: [{ name: "out", type: "audio", description: "Noise signal" }] },
  "ar~":          { zone: "any", description: "Audio-rate attack-release envelope.", args: "attack release", example: "ar~ 0.01 0.3",
                    inlets: [
                      { name: "trigger", type: "event", description: "Fire envelope" },
                      { name: "attack", type: "number", description: "Attack time in seconds" },
                      { name: "release", type: "number", description: "Release time in seconds" }],
                    outlets: [{ name: "out", type: "audio", description: "Envelope signal" }] },
  "adsr~":        { zone: "any", description: "Audio-rate ADSR envelope. Gate-driven.", args: "a d s r", example: "adsr~ 0.05 0.1 0.7 0.3",
                    inlets: [
                      { name: "gate", type: "number", description: "Gate signal (>0 = open)" },
                      { name: "a", type: "number", description: "Attack time" },
                      { name: "d", type: "number", description: "Decay time" },
                      { name: "s", type: "number", description: "Sustain level (0-1)" },
                      { name: "r", type: "number", description: "Release time" }],
                    outlets: [{ name: "out", type: "audio", description: "Envelope signal" }] },
  "sigmoid~":     { zone: "any", description: "Audio-rate shaped sigmoid transition.", args: "start end duration duty curve [mode]", example: "sigmoid~ 0 1 0.5 0.5 6",
                    inlets: [
                      { name: "trigger", type: "event", description: "Fire envelope" },
                      { name: "start", type: "number", description: "Start value" },
                      { name: "end", type: "number", description: "End value" },
                      { name: "duration", type: "number", description: "Duration in seconds" },
                      { name: "duty", type: "number", description: "Where transition occurs (0-1)" },
                      { name: "curve", type: "number", description: "Steepness" }],
                    outlets: [{ name: "out", type: "audio", description: "Envelope signal" }] },
  "cosine~":      { zone: "any", description: "Audio-rate shaped cosine hump.", args: "amplitude duration duty curve [mode]", example: "cosine~ 1 0.5 0.5 1",
                    inlets: [
                      { name: "trigger", type: "event", description: "Fire envelope" },
                      { name: "amplitude", type: "number", description: "Peak amplitude" },
                      { name: "duration", type: "number", description: "Duration in seconds" },
                      { name: "duty", type: "number", description: "Where peak falls (0-1)" },
                      { name: "curve", type: "number", description: "Peakedness" }],
                    outlets: [{ name: "out", type: "audio", description: "Envelope signal" }] },
  "ramp~":        { zone: "any", description: "Audio-rate ramp with curve shaping. curve=1 linear, >1 exponential (slow start), <1 logarithmic (fast start).", args: "from to duration [curve]", example: "ramp~ 0 1 0.5 2",
                    inlets: [
                      { name: "trigger", type: "event", description: "Start ramp" },
                      { name: "from", type: "number", description: "Start value" },
                      { name: "to", type: "number", description: "End value" },
                      { name: "duration", type: "number", description: "Duration in seconds" },
                      { name: "curve", type: "number", description: "Shape: 1=linear, >1=exponential, <1=logarithmic" }],
                    outlets: [{ name: "out", type: "audio", description: "Ramp signal" }] },
  "trig~":        { zone: "any", description: "CV trigger pulse.", args: "amplitude samples", example: "trig~ 1 64",
                    inlets: [
                      { name: "trigger", type: "event", description: "Fire" },
                      { name: "amplitude", type: "number", description: "Peak amplitude" },
                      { name: "samples", type: "number", description: "Pulse duration in samples (default 64)" }],
                    outlets: [{ name: "out", type: "audio", description: "Trigger signal" }] },
  "step~":        { zone: "any", description: "Audio-rate one-shot gate.", args: "amplitude length", example: "step~ 1 0.5",
                    inlets: [
                      { name: "trigger", type: "event", description: "Fire" },
                      { name: "amplitude", type: "number", description: "Peak amplitude" },
                      { name: "length", type: "number", description: "Hold duration in seconds" }],
                    outlets: [{ name: "out", type: "audio", description: "Gate signal" }] },
  "+~":           { zone: "any", description: "Audio-rate add.", args: "[operand]", example: "+~ 100",
                    inlets: [
                      { name: "a", type: "audio", description: "Left operand" },
                      { name: "b", type: "audio", description: "Right operand (or arg)" }],
                    outlets: [{ name: "out", type: "audio", description: "Sum" }] },
  "-~":           { zone: "any", description: "Audio-rate subtract.", args: "[operand]", example: "-~ 1",
                    inlets: [
                      { name: "a", type: "audio", description: "Left operand" },
                      { name: "b", type: "audio", description: "Right operand (or arg)" }],
                    outlets: [{ name: "out", type: "audio", description: "Difference" }] },
  "*~":           { zone: "any", description: "Audio-rate multiply.", args: "[factor]", example: "*~ 0.5",
                    inlets: [
                      { name: "a", type: "audio", description: "Left operand" },
                      { name: "b", type: "audio", description: "Right operand (or arg)" }],
                    outlets: [{ name: "out", type: "audio", description: "Product" }] },
  "/~":           { zone: "any", description: "Audio-rate divide.", args: "[divisor]", example: "/~ 2",
                    inlets: [
                      { name: "a", type: "audio", description: "Left operand" },
                      { name: "b", type: "audio", description: "Right operand (or arg)" }],
                    outlets: [{ name: "out", type: "audio", description: "Quotient" }] },
  "**~":          { zone: "any", description: "Audio-rate exponent.", args: "[power]", example: "**~ 2",
                    inlets: [
                      { name: "base", type: "audio", description: "Base value" },
                      { name: "exp", type: "audio", description: "Exponent (or arg)" }],
                    outlets: [{ name: "out", type: "audio", description: "Result" }] },
  "scale~":       { zone: "any", description: "Audio-rate range mapping.", args: "min max", example: "scale~ 100 5000",
                    inlets: [{ name: "in", type: "audio", description: "Input (0-1)" }],
                    outlets: [{ name: "out", type: "audio", description: "Scaled output" }] },
  "clip~":        { zone: "any", description: "Audio-rate clamp.", args: "min max", example: "clip~ 0 1",
                    inlets: [{ name: "in", type: "audio", description: "Input" }],
                    outlets: [{ name: "out", type: "audio", description: "Clamped output" }] },
  "mtof~":        { zone: "any", description: "Audio-rate MIDI note to frequency.",
                    inlets: [{ name: "in", type: "audio", description: "MIDI note" }],
                    outlets: [{ name: "out", type: "audio", description: "Frequency in Hz" }] },
  "slew~":        { zone: "any", description: "Audio-rate slew limiter.", args: "time", example: "slew~ 0.05",
                    inlets: [{ name: "in", type: "audio", description: "Input" }],
                    outlets: [{ name: "out", type: "audio", description: "Smoothed output" }] },

  "oscillatorNode~": { zone: "any", description: "Native Web Audio oscillator. Types: sine, square, sawtooth, triangle.", args: "[type]", example: "oscillatorNode~ sawtooth",
                    inlets: [
                      { name: "frequency", type: "number", description: "Frequency in Hz" },
                      { name: "detune", type: "number", description: "Detune in cents" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio output" }] },
  "gainNode~":    { zone: "any", description: "Native Web Audio gain. Multiplies audio signal.", args: "[gain]", example: "gainNode~ 0.5",
                    inlets: [
                      { name: "in", type: "audio", description: "Audio input" },
                      { name: "gain", type: "number", description: "Gain multiplier (default 1)" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio output" }] },
  "biquadFilterNode~": { zone: "any", description: "Native Web Audio biquad filter. Types: lowpass, highpass, bandpass, notch, allpass, peaking, lowshelf, highshelf.", args: "[type]", example: "biquadFilterNode~ highpass",
                    inlets: [
                      { name: "in", type: "audio", description: "Audio input" },
                      { name: "frequency", type: "number", description: "Cutoff/center frequency in Hz" },
                      { name: "Q", type: "number", description: "Quality factor" },
                      { name: "gain", type: "number", description: "Gain in dB (shelf/peaking only)" },
                      { name: "detune", type: "number", description: "Detune in cents" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio output" }] },

  "reverb~":      { zone: "any", description: "FDN reverb. Metallic resonance to deep halls. Freeze at decay=1.",
                    inlets: [
                      { name: "in", type: "audio", description: "Audio input" },
                      { name: "size", type: "number", description: "Room size (0-1)" },
                      { name: "decay", type: "number", description: "Decay time (0-1, 1=freeze)" },
                      { name: "absorb", type: "number", description: "High-freq damping (0-1)" },
                      { name: "mix", type: "number", description: "Dry/wet (0-1)" },
                      { name: "modSpeed", type: "number", description: "Mod LFO speed (0-1)" },
                      { name: "modDepth", type: "number", description: "Mod LFO depth (0-1)" }],
                    outlets: [{ name: "out", type: "audio", description: "Processed audio" }] },

  "sine-osc~":    { zone: "any", description: "Pure sine tone oscillator.",
                    inlets: [
                      { name: "freq", type: "number", description: "Frequency in Hz" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio output" }] },
  "cute-sine~":   { zone: "any", description: "Additive sine oscillator with brightness. 6 harmonics crossfaded by bright param.",
                    inlets: [
                      { name: "freq", type: "number", description: "Frequency in Hz" },
                      { name: "bright", type: "number", description: "Brightness (0=fundamental only, 1=all 6 harmonics)" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio output" }] },
  "noise-engine~": { zone: "any", description: "Filtered noise generator.",
                    inlets: [
                      { name: "cutoff", type: "number", description: "Lowpass cutoff in Hz (20-20000)" },
                      { name: "resonance", type: "number", description: "Filter resonance (0-1)" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio output" }] },
  "shepard~":     { zone: "any", description: "Shepard tone generator.",
                    inlets: [
                      { name: "baseFreq", type: "number", description: "Base frequency in Hz" },
                      { name: "partialCount", type: "number", description: "Number of partials" },
                      { name: "bandwidth", type: "number", description: "Spectral bandwidth" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio output" }] },
  "impulse-cloud~": { zone: "any", description: "Stochastic impulse cloud.",
                    inlets: [
                      { name: "density", type: "number", description: "Events per second" },
                      { name: "width", type: "number", description: "Impulse width in samples" },
                      { name: "freq", type: "number", description: "Center frequency in Hz" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio output" }] },
  "formant~":     { zone: "any", description: "Formant synthesis. Vowel-space interpolation with FM and ring modulation.",
                    inlets: [
                      { name: "frequency", type: "number", description: "Fundamental frequency in Hz" },
                      { name: "vowelX", type: "number", description: "Vowel X axis (0-1, front-back)" },
                      { name: "vowelY", type: "number", description: "Vowel Y axis (0-1, open-close)" },
                      { name: "zingAmount", type: "number", description: "Ring modulation depth (0-1)" },
                      { name: "symmetry", type: "number", description: "Waveform asymmetry (0-1)" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [
                      { name: "out", type: "audio", description: "Main audio output" },
                      { name: "F1", type: "audio", description: "Formant 1 signal" },
                      { name: "F2", type: "audio", description: "Formant 2 signal" },
                      { name: "F3", type: "audio", description: "Formant 3 signal" }] },
  "karplus-strong~": { zone: "any", description: "Karplus-Strong plucked string synthesis.",
                    inlets: [
                      { name: "freq", type: "number", description: "Frequency in Hz" },
                      { name: "damping", type: "number", description: "Decay rate (0-1)" },
                      { name: "brightness", type: "number", description: "Lowpass filter (0-1)" },
                      { name: "excitation", type: "number", description: "Noise burst level (0-1)" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio output" }] },
  "swarm~":       { zone: "any", description: "Resonant event swarm. Water, rain, fizz, metallic textures via parameter regimes.",
                    inlets: [
                      { name: "rate", type: "number", description: "Events per second" },
                      { name: "freqMin", type: "number", description: "Min frequency in Hz" },
                      { name: "freqMax", type: "number", description: "Max frequency in Hz" },
                      { name: "chirp", type: "number", description: "Freq sweep rate (Hz/s)" },
                      { name: "decay", type: "number", description: "Event decay (0=fast, 1=slow)" },
                      { name: "amplitude", type: "number", description: "Output level (0-1)" },
                      { name: "transientMix", type: "number", description: "Noise burst probability (0-1)" },
                      { name: "resonatorQ", type: "number", description: "Biquad Q (0=sinusoid, >0=resonator)" },
                      { name: "density", type: "number", description: "Output scaling (0-1)" },
                      { name: "chaosSpeed", type: "number", description: "Chaos attractor speed (0.1=slow, 1=normal, 10=fast)" }],
                    outlets: [{ name: "out", type: "audio", description: "Audio output" }] },
};

// --- Helpers ---

function boxTypeName(text) {
  return (text || "").split(/\s+/)[0];
}

function getBoxPorts(text) {
  const def = BOX_TYPES[boxTypeName(text)];
  if (!def) return { inlets: 1, outlets: 1 };
  if (def.dynamic) {
    const name = boxTypeName(text);
    if (name === "fan") {
      const n = Math.max(1, text.split(/\s+/).length - 1);
      return { inlets: 1, outlets: n };
    }
    if (name === "trigger" || name === "t") {
      const types = text.split(/\s+/).slice(1);
      const n = Math.max(1, types.length);
      return { inlets: 1, outlets: n };
    }
    if (name === "select" || name === "sel") {
      const vals = text.split(/\s+/).slice(1);
      const n = Math.max(1, vals.length);
      return { inlets: 1, outlets: n + 1 }; // one per match + reject
    }
    if (name === "group") {
      const n = parseInt(text.split(/\s+/)[1]) || 1;
      return { inlets: n + 1, outlets: 1 }; // N group inlets + 1 shuffle, 1 outlet
    }
    if (name === "sendup" || name === "sall") {
      const n = Math.max(1, text.split(/\s+/).length - 1);
      return { inlets: n, outlets: 0 };
    }
    if (name === "uplink") {
      const n = Math.max(1, text.split(/\s+/).length - 1);
      return { inlets: 0, outlets: n };
    }
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

// Resolve port definition for a specific inlet/outlet index (handles dynamic types)
function getInletDef(text, index) {
  const def = BOX_TYPES[boxTypeName(text)];
  if (!def) return null;
  const name = boxTypeName(text);
  if (name === "group") {
    const n = parseInt(text.split(/\s+/)[1]) || 1;
    if (index < n) return def.inlets[0]; // group channel inlet
    if (index === n) return def.inlets[1]; // shuffle inlet
    return null;
  }
  // For other dynamic types (all, fan), repeat the first definition
  if (def.dynamic && def.inlets.length === 1) return def.inlets[0];
  return def.inlets?.[index] || null;
}

function getOutletDef(text, index) {
  const def = BOX_TYPES[boxTypeName(text)];
  if (!def) return null;
  if (def.dynamic && def.outlets.length === 1) return def.outlets[0];
  return def.outlets?.[index] || null;
}

// Derive audio characteristics from port types
function hasAudioIn(text) {
  const def = BOX_TYPES[boxTypeName(text)];
  return def?.inlets?.some(i => i.type === "audio") || false;
}

function hasAudioOut(text) {
  const def = BOX_TYPES[boxTypeName(text)];
  return def?.outlets?.some(o => o.type === "audio") || false;
}

function isDac(text) {
  return boxTypeName(text) === "dac~";
}

// Does this box need an AudioNode? (has any audio ports)
function isAudioBox(text) {
  return hasAudioIn(text) || hasAudioOut(text) || isDac(text);
}

// ES module / CJS exports (server.ts uses CJS-style, browser uses ESM)
if (typeof exports === "object") Object.assign(exports, { BOX_TYPES, boxTypeName, getBoxPorts, getBoxZone, getBoxDef, getInletDef, getOutletDef, hasAudioIn, hasAudioOut, isDac, isAudioBox });
export { BOX_TYPES, boxTypeName, getBoxPorts, getBoxZone, getBoxDef, getInletDef, getOutletDef, hasAudioIn, hasAudioOut, isDac, isAudioBox };

