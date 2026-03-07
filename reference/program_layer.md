# Program Layer — Unified Parameter Architecture

## Core Principle: There Are No Modes

A program is a set of parameter bindings. Each binding describes where a
parameter's value comes from, how it moves over time, and how it combines
with other sources. There is no distinction between "performance mode" and
"program mode" — a program can contain any mix of live inputs, generators,
envelopes, and schedules. They coexist per-parameter, not as system states.

What we informally call "performance" is a program where most sources are
live inputs. What we call "automation" is a program where most sources are
generators with shapes. The interesting territory is the blend: a program
provides the skeleton, the performer deforms it in real time.

## The Four Aspects of a Parameter

Every parameter in a program has up to four orthogonal aspects:

### 1. Source — where the value comes from

```
// Direct: everyone gets the same value
{ type: "direct", value: 0.5 }

// HRG: each client resolves a harmonic ratio
{ type: "hrg", base: 220, nums: [1,2,3,5], dens: [1,1,2,3] }

// Range: each client picks a random value within bounds
{ type: "range", min: 0.2, max: 0.8 }

// Live input: value comes from a real-time controller
{ type: "input", id: "breath" }
{ type: "input", id: "arc.0" }
{ type: "input", id: "keyboard.note" }
{ type: "input", id: "webcam.motion" }
```

All source types are equal. A live input is just another source, not a
special "performance" overlay. A generator is just a source that happens
to resolve differently per-client.

### 2. Shape — how the value moves within the cycle

Shapes are functions of phasor phase (0→1). They modulate the source
value over time. If no shape is specified, the value is static within
the cycle (re-resolves at EOC if generator).

```
// Hold: constant for the cycle, re-resolve at EOC
{ type: "hold" }

// Ramp: linear interpolation between two resolved values
// At EOC: "to" becomes "from", new "to" resolves
{ type: "ramp", from: <source>, to: <source> }

// Envelope: breakpoints over normalised phase
// Breakpoint values can themselves be generators
{
  type: "envelope",
  points: [
    { phase: 0.0, value: <source|number> },
    { phase: 0.3, value: <source|number> },
    { phase: 0.8, value: <source|number> },
    { phase: 1.0, value: <source|number> }
  ]
}

// Sequence: N discrete values at equal cycle subdivisions
// Each step is independently resolved per-client
{
  type: "sequence",
  values: [<source>, <source>, <source>, <source>],
  interpolation: "step" | "linear" | "cosine"
}

// LFO: oscillating, optionally free-running (not phase-locked)
{ type: "lfo", rate: 6.0, depth: 0.5, shape: "sine" | "triangle" }
```

Shapes reference the phasor but don't require it to be "active."
The phasor always runs. If nothing references it, it's inert.
Adding one shape to one parameter makes that parameter start cycling.
Others remain free. This is per-parameter, not global.

### 3. Command — what happens at structural moments

Commands operate on generator state at specific phase positions.
They affect how sources re-resolve, not the values directly.

```
// At EOC: re-resolve all generators (default behaviour)
{ trigger: "eoc", action: "resolve" }

// At specific phase: fire a command on a generator
{ trigger: { phase: 0.5 }, action: "shuffle", target: "freq" }

// At sequence steps: fire commands rhythmically
{ trigger: { step: [0, 4, 8, 12] }, action: "scatter", target: "rate" }

// On silence exit: re-resolve when amplitude crosses from 0
{ trigger: "entry", action: "resolve" }

// Manual: fire from grid/controller gesture
{ trigger: "manual", action: "shuffle", target: "freq" }
```

Available actions (from existing generator system):
- `resolve` — re-randomise indices/values
- `shuffle` — Fisher-Yates shuffle + reset index
- `increment` / `decrement` — step through array
- `scatter` / `walk` / `converge` — range behaviours

### 4. Combine — how multiple sources interact

When a parameter has both a program source AND a live input, the
combine mode determines how they interact:

```
// Replace: live input takes over entirely when active
// Program resumes when input goes silent
{ mode: "replace" }

// Offset: live input adds to program value
// Good for: arc nudging a frequency center
{ mode: "offset", scale: 1.0 }

// Scale: live input multiplies program value (0-1 range)
// Good for: breath as expression/dynamics
{ mode: "scale" }

// Bias: live input shifts center of a range without changing width
// Good for: tilting a stochastic distribution
{ mode: "bias" }
```

When there is only one source (either program or live), no combine
mode is needed. The value passes through directly.

## Complete Parameter Example

```
freq: {
  source: { type: "hrg", base: 220, nums: [1,2,3,5,8], dens: [1,2,3,5,8] },
  shape: { type: "ramp", from: "resolve", to: "resolve" },
  command: { trigger: "eoc", action: "shuffle" },
  input: { id: "keyboard.note", combine: "replace" }
}
```

This says:
- Each client gets a harmonic ratio of 220Hz (different per client)
- The ratio ramps from one value to another over the cycle
- At EOC, the array shuffles and new start/end values resolve
- If a keyboard note is pressed, it takes over directly
- When the key releases, the program resumes from wherever it is

## Silence, Sparsity, and Rests

Silence is not a special state. It's the zero end of the amplitude
parameter, shaped and sourced like everything else.

```
amplitude: {
  source: { type: "range", min: 0, max: 1 },
  shape: {
    type: "sequence",
    values: [1, 1, 0, 1, 1, 0, 1, 0],
    interpolation: "step"
  },
  command: { trigger: "entry", action: "resolve" },
  input: { id: "breath", combine: "scale" }
}
```

- 8 subdivisions per cycle, some silent, some sounding
- Each client independently resolves its amplitude within the range
  (some phones rest while others play)
- On silence exit (`entry` trigger), generators re-resolve fresh
  (each phone "wakes up" with a new voice)
- Breath scales everything — not breathing = silence regardless of program
- Continuous sparsity: values of 0.3 are quiet, not silent

The `entry` trigger is particularly powerful: it means the ensemble
constantly refreshes as different phones cycle in and out of silence.
No two cycles sound the same, even with the same program.

## The Phasor

The phasor is always running. It is a shared time reference, not a mode.

- Provides normalised phase (0→1) that shapes can reference
- Drives EOC events for re-resolution
- Outputs to ES-8 as clock/CV (always available for eurorack sync)
- Configurable period and subdivision count
- If no parameter references the phasor, it's inert but available

"Free" performance is not a mode — it's what happens when no parameter
currently uses a phasor-referencing shape. Adding one envelope to one
parameter makes that parameter start cycling while others remain free.

The performer can engage and disengage the phasor's influence gradually
by adding or removing shapes from parameters, not by switching modes.

## Engine-Specific Parameters

Each engine declares its own parameter set. The program layer uses
engine-specific parameter names directly — no forced universal namespace.

### Parameter Sets Per Engine

```
formant: [
  frequency, vowelX, vowelY, zingAmount, zingMorph,
  symmetry, amplitude, vibratoWidth, vibratoRate
]

syrinx: [
  alpha, beta, gamma, Q, oecVolume, beakGape,
  tracheaReflection, amplitude
]

swarm: [
  rate, freqMin, freqMax, chirp, decay, resonatorQ,
  transientMix, jitter, couplingK, density,
  numRibs, ribSpacing, amplitude
]

trombone: [
  frequency, tongueIndex, tongueDiameter,
  constrictionIndex, constrictionDiameter,
  velum, tenseness, intensity, lipDiameter
]

karplusStrong: [
  frequency, damping, brightness, excitation, amplitude
]

reverb: [
  size, decay, absorb, mix, feedback, modSpeed, modDepth
]
```

### Controller Bindings Per Engine

Cross-engine continuity happens at the controller binding level,
not through a forced parameter abstraction. Each engine has its
own mapping from controllers to its parameters:

```
syrinx: {
  breath: "alpha",        // pressure → onset/loudness
  bite:   "beta",         // jaw tension → pitch
  nod:    "oecVolume",    // head tilt → resonance
  tilt:   "Q",            // lateral → bilateral detuning
  arc.0:  "gamma",        // species scaling
  arc.1:  "beakGape",     // radiation
}

swarm: {
  breath: "rate",         // breath → event density
  bite:   "freqMax",      // jaw → frequency ceiling
  nod:    "chirp",        // head tilt → frequency sweep
  tilt:   "jitter",       // lateral → periodic vs stochastic
  arc.0:  "couplingK",    // sync strength
  arc.1:  "resonatorQ",   // sinusoid vs biquad resonance
}

formant: {
  breath: "amplitude",    // breath → dynamics
  bite:   "zingAmount",   // jaw → zing crossfade
  nod:    "vowelY",       // head tilt → vowel Y
  tilt:   "vowelX",       // lateral → vowel X
  arc.0:  "symmetry",     // waveform shape
  arc.1:  "zingMorph",    // zing character
}

trombone: {
  breath: "intensity",    // breath → phonation
  bite:   "tenseness",    // jaw → vocal tension
  nod:    "tongueIndex",  // head tilt → tongue position
  tilt:   "tongueDiameter", // lateral → tongue shape
  arc.0:  "velum",        // nasal coupling
  arc.1:  "constrictionDiameter", // constriction
}
```

When engines switch, controller bindings swap. Breath still does
"the pressure-like thing" for each engine through explicit mapping.
More honest and flexible than forcing a universal abstraction.

## Gesture Capture

If performance and program are the same thing, recording a gesture IS
writing a program.

1. Perform: breath controls pressure, creating a dynamic curve
2. Capture: record the curve as a time-series over N phasor cycles
3. Encode: convert the recording to an envelope shape
4. Replace: the live input source becomes an envelope source

The captured gesture now plays back as part of the program. But because
generators re-resolve per-client, the playback isn't identical — it's a
distribution of variations around the original gesture.

You can then perform on top of the captured layer with a different input.
Layers of captured gesture accumulate into programs. Each layer is a
frozen performance that becomes structure for the next.

This is a parameter-space looper. Record, overdub, reshape.

## Controller Mapping Summary

| Controller | Character | Natural role |
|------------|-----------|-------------|
| **Grid** | Discrete, spatial | Source selection, sequence editing, program banks, command triggers |
| **Arc** | Continuous, high-res | Smooth parameter shaping, envelope editing, fine adjustment |
| **BBC2 Breath** | Continuous, embodied | Pressure/dynamics/onset (source type: input) |
| **BBC2 Bite** | Continuous, embodied | Tension/pitch/morph (source type: input) |
| **BBC2 Nod** | Continuous, gestural | Resonance/timbre (source type: input) |
| **BBC2 Tilt** | Continuous, gestural | Spatial/detuning (source type: input) |
| **MIDI Keyboard** | Note events + CC | Pitched input, velocity→dynamics, mod wheel |
| **ES-8** | CV/gate output | Clock, pitch CV, gate, trigger, envelope follower TO eurorack |
| **ES-8** | CV input | Clock IN from eurorack (external phasor source) |
| **Webcam** | Extracted features | Motion→activity, position→XY, brightness→level |

All controllers are just sources. The program doesn't distinguish between
a breath value and a generator value and a webcam-extracted value. They're
all streams of numbers that feed into the same parameter infrastructure.

## Program Structure (complete)

```
{
  // Phasor configuration
  phasor: {
    period: 4.0,          // seconds per cycle
    subdivisions: 16,     // steps per cycle
    running: true         // always true, but here for completeness
  },

  // Engine-specific parameters
  engine: "formant",

  params: {
    frequency: {
      source: { type: "hrg", base: 220, nums: [1,2,3,5], dens: [1,1,2,3] },
      shape: { type: "ramp", from: "resolve", to: "resolve" },
      command: { trigger: "eoc", action: "shuffle" },
      input: { id: "keyboard.note", combine: "replace" }
    },
    amplitude: {
      source: { type: "range", min: 0.5, max: 1.0 },
      shape: {
        type: "sequence",
        values: [1, 1, 0.5, 1, 0, 1, 0.8, 0],
        interpolation: "step"
      },
      command: { trigger: "entry", action: "resolve" },
      input: { id: "breath", combine: "scale" }
    },
    vowelX: {
      source: { type: "range", min: 0.2, max: 0.8 },
      shape: { type: "hold" },
      input: { id: "tilt", combine: "bias" }
    },
    vowelY: {
      source: { type: "range", min: 0.2, max: 0.8 },
      shape: { type: "hold" },
      input: { id: "nod", combine: "bias" }
    },
    zingAmount: {
      source: { type: "direct", value: 0.5 },
      input: { id: "bite", combine: "replace" }
    },
    symmetry: {
      source: { type: "direct", value: 0.3 },
      input: { id: "arc.0", combine: "replace" }
    }
  },

  // Global schedule (commands not tied to specific params)
  schedule: [
    { trigger: { phase: 0.0 }, action: "resolve" },
    { trigger: { phase: 0.5 }, action: "shuffle", target: "frequency" }
  ],

  // Program metadata
  meta: {
    name: "gentle drift",
    bank: 3
  }
}
```

## Resolution Flow

```
For each parameter, each client, each sample:

1. RESOLVE source
   - direct: use value
   - hrg: base × nums[idx] / dens[idx] (idx is per-client)
   - range: per-client random within bounds
   - input: latest value from controller stream

2. APPLY shape (if any)
   - Read current phasor phase
   - Evaluate shape at that phase
   - Modulate resolved source value by shape output

3. COMBINE with live input (if both source and input exist)
   - replace: use input when active, source when not
   - offset: source + (input × scale)
   - scale: source × input
   - bias: shift source center by input offset

4. MAP to engine parameter
   - Look up engine mapping table
   - Apply any engine-specific scaling/range clamping

5. SEND to synthesis processor
   - AudioParam.setValueAtTime (for sample-accurate timing)
   - Or message port for complex state (generator definitions)
```

Steps 2 and 3 happen on the client side, driven by the local phasor.
Step 1 (resolution) happens either client-side (generators) or arrives
via WebSocket (live inputs, after server routing).

## What This Enables

### Pure performance (no phasor reference)
```
freq:     { source: { type: "input", id: "keyboard.note" } }
pressure: { source: { type: "input", id: "breath" } }
colour:   { source: { type: "input", id: "bite" } }
```
You're playing an instrument. No cycling, no generators, no stochasticity.

### Pure program (no live inputs)
```
freq:     { source: { type: "hrg", ... }, shape: { type: "ramp" } }
pressure: { source: { type: "range", ... }, shape: { type: "envelope", ... } }
```
The system runs itself. Each client varies. The performer listens.

### Performer shaping a program
```
freq:     { source: { type: "hrg", ... }, shape: { type: "ramp" },
            input: { id: "keyboard.note", combine: "replace" } }
pressure: { source: { type: "range", ... }, shape: { type: "envelope", ... },
            input: { id: "breath", combine: "scale" } }
```
The program provides the structure. The performer intervenes — overriding
pitch with keyboard, scaling dynamics with breath. Let go and the program
continues from where it was. This is conducting.

### Cross-engine continuity
Switch engine from "formant" to "syrinx". Controller bindings swap.
Breath was scaling formant amplitude, now it drives syrinx alpha.
The keyboard was overriding formant frequency, now it overrides beta.
Same physical gestures, transformed sonic result. The continuity is
in the performer's body, not in a forced parameter abstraction.

### Gesture capture and layering
1. Perform breath → pressure. Record the gesture.
2. The breath curve becomes an envelope shape on pressure.
3. Now perform bite → colour on top of the captured breath layer.
4. Record that too. Two layers of frozen performance.
5. Now perform live with arc, deforming both captured layers.
6. Programs accumulate from performance. Performance builds on programs.
