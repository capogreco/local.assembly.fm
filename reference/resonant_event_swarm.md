# Resonant Event Swarm Engine — Unified Synthesis Architecture

## The Observation

Three of the researched synthesis engines share a common primitive:

| Engine | What happens |
|--------|-------------|
| Water (creek/rain/fizz) | Stochastic stream of short resonant events (bubbles) |
| Cicada (single voice) | Periodic stream of short resonant events (rib clicks) |
| Cicada (chorus) | N coupled periodic streams of resonant events |

In all cases: **something triggers a resonant body, which rings and decays.
Many of these overlapping in time create a texture.**

The differences are in:
1. How events are triggered (random vs periodic vs coupled-periodic)
2. How the resonator is shaped (pure sinusoid vs biquad filter)
3. How events interact (independent vs phase-coupled)

## The Unified Primitive: A Resonant Event

Every event in the swarm is:

```
{
  freq,           // carrier frequency (Hz)
  chirp,          // freq change per sample (Hz/sample), 0 = fixed pitch
  decay,          // per-sample amplitude multiplier (<1)
  amp,            // initial amplitude
  resonatorQ,     // Q of resonant filter (0 = pure sinusoid, >0 = filtered impulse)
  transient,      // initial noise burst duration in samples (0 = none)
  transientDecay  // noise burst envelope decay rate
}
```

When `resonatorQ = 0`, the event is a simple damped sinusoid (bubble model).
When `resonatorQ > 0`, the event is an impulse exciting a biquad resonator (tymbal model).
Both are cheap. Both produce damped ringing at a carrier frequency.
The difference is spectral shape — the biquad gives a sharper resonant peak
with a more physically accurate impulse response.

A single event costs ~6-20 ops/sample depending on mode.

## The Swarm: Three Trigger Models

### Model A — Poisson (water)
Events arrive randomly. The interval between events is exponentially distributed.
```
accumulator += rate × dt
while accumulator >= 1:
  spawn event with randomised parameters (freq, decay, chirp, etc.)
  accumulator -= 1
```
No coupling between events. Pure stochastic texture.
- Low rate: individual drops, drips
- High rate: merged wash, stream, fizz

### Model B — Periodic (single insect)
Events arrive at fixed intervals determined by a muscle/oscillator rate.
```
timer -= dt
if timer <= 0:
  spawn event (or burst of N rib-events with sequential timing)
  timer = 1 / muscleRate
```
Optional: sub-events within each trigger (rib sequence with descending freq).
Optional: phrase envelope gating the trigger on/off at a slower rate.
- Fast rate: continuous tone (cicada drone)
- Slow rate: rhythmic clicking
- With rib sequence: characteristic tymbal micro-structure

### Model C — Coupled Periodic (chorus)
N independent periodic oscillators, each with its own rate, coupled via
Kuramoto-type phase interaction:
```
for each voice i:
  phase_i += dt × (omega_i + K × Σ_neighbors sin(phase_j - phase_i))
  if phase_i crosses trigger threshold:
    spawn event(s) for voice i
    enter refractory period (silent recharge)
```
Coupling strength K controls synchronization:
- K = 0: independent voices, shimmering/beating texture
- K moderate: partial sync, waves of activity
- K high: locked sync, massive unified pulses

### The Continuum

These three models are not discrete modes — they're a continuum:

```
Poisson ←————————————————————————→ Periodic ←——————————→ Coupled
(random intervals)              (fixed intervals)      (N × fixed, linked)

  water                           single insect           chorus
  rain                            solo cicada             cicada chorus
  fizz                            dripping tap            ??? (new territory)
```

Interpolating between Poisson and Periodic:
```
interval = (1 / rate) × (1 + jitter × random())
```
- jitter = 0: perfectly periodic (insect)
- jitter = 1: fully random (water)
- jitter = 0.3: slightly irregular (natural-sounding dripping, irregular insect)

## Swarm State

```
MAX_EVENTS = 512

events[MAX_EVENTS]: {
  // oscillator
  phase,          // current phase (radians)
  freq,           // current frequency
  chirp,          // freq increment per sample
  amp,            // current amplitude
  decay,          // per-sample decay multiplier

  // resonator (biquad, optional)
  useResonator,   // boolean
  b0, b1, b2,     // biquad feedforward coefficients
  a1, a2,          // biquad feedback coefficients
  z1, z2,          // biquad state

  // transient (noise burst, optional)
  transientLeft,  // remaining noise samples
  transientDecay, // noise envelope decay

  // identity
  voiceId,        // which voice/stream spawned this (-1 = Poisson)
  active          // boolean
}

activeCount: number
freeList: stack of inactive indices

// Trigger state (per voice, for periodic/coupled modes)
voices[MAX_VOICES]: {
  phase,          // oscillator phase (for coupling)
  omega,          // natural trigger rate
  timer,          // countdown to next event
  refractory,     // silent recharge countdown
  ribIndex,       // current rib in sequence (0 if no rib model)
  numRibs,        // ribs per trigger (1 = simple, 4 = tymbal)
  ribTimer,       // countdown between rib sub-events
  active,         // currently in calling phase
  amp,            // per-voice amplitude (distance, envelope)
  pan             // stereo position
}
```

## Per-Sample Processing

```
output_L = 0, output_R = 0

for each active event e:
  sample = 0

  if e.transientLeft > 0:
    sample = e.amp × noise() × transientEnvelope(e)
    e.transientLeft--
  else if e.useResonator:
    // biquad: only non-zero output when recently excited
    sample = e.b0 × impulse + e.b1 × z1 + e.b2 × z2 - e.a1 × z1 - e.a2 × z2
    // (impulse is non-zero only on the trigger sample)
  else:
    // rotating phasor (cheaper than sin())
    e.phase += 2π × e.freq / sampleRate
    sample = e.amp × sin(e.phase)
    e.freq += e.chirp

  e.amp *= e.decay

  if e.amp < threshold:
    recycle(e)  // return to freeList
    continue

  // pan to stereo (voice-based or randomised)
  output_L += sample × e.panL
  output_R += sample × e.panR
```

## Control-Rate Processing (once per block)

```
// --- Poisson trigger ---
if poissonRate > 0:
  poissonAccum += poissonRate × blockDuration
  while poissonAccum >= 1:
    spawnEvent(randomParams())
    poissonAccum -= 1

// --- Periodic / Coupled triggers ---
for each voice v:
  if coupledMode:
    // Kuramoto coupling
    v.phase += blockDuration × (v.omega + K × couplingSum(v))
  else:
    v.phase += blockDuration × v.omega

  if v.phase crosses threshold AND NOT v.refractory:
    // Start rib sequence (or single event)
    v.ribIndex = 0
    v.ribTimer = 0

  if v.ribIndex < v.numRibs:
    v.ribTimer -= blockDuration
    if v.ribTimer <= 0:
      spawnEvent(ribParams(v, v.ribIndex))
      v.ribIndex++
      v.ribTimer = ribSpacing
    if v.ribIndex >= v.numRibs:
      v.refractory = refractoryDuration
```

## Parameter Mapping from Server

All parameters map to existing generator types:

```
// Swarm-level
triggerModel    // "poisson", "periodic", "coupled" (or blend via jitter)
rate            // events/sec (Poisson) or Hz (periodic) — range generator
jitter          // 0=periodic, 1=random — range generator
couplingK       // sync strength — range generator
density         // number of active voices (coupled mode) — direct

// Per-event distribution
freqMin/Max     // Hz — range generator or HRG for harmonic sets
chirpMin/Max    // Hz/sample — range generator
decayMin/Max    // per-sample multiplier — range generator
ampMin/Max      // amplitude — range generator
resonatorQ      // 0=sinusoid, >0=biquad — range generator
transientMix    // probability of noise burst — range generator

// Rib model (periodic/coupled modes)
numRibs         // events per trigger (1=simple, 4=tymbal) — direct
ribSpacing      // ms between sub-events — range generator
ribFreqSweep    // freq descent across rib sequence — range generator

// Macro envelope
phraseRate      // echeme/chirp repetition rate (0=continuous) — range generator
phraseDuty      // on/off duty cycle — range generator
```

## What This Enables

### Pure Water
```
triggerModel: "poisson", rate: 30, jitter: 1.0, resonatorQ: 0,
freqMin: 800, freqMax: 4000, chirp: 0, transientMix: 0
→ bubbling creek
```

### Rain
```
triggerModel: "poisson", rate: 100, jitter: 1.0, resonatorQ: 0,
freqMin: 800, freqMax: 4000, chirp: 0, transientMix: 0.7
→ rain on water
```

### Fizz
```
triggerModel: "poisson", rate: 500, jitter: 1.0, resonatorQ: 0,
freqMin: 2000, freqMax: 12000, chirpMin: 50, chirpMax: 200,
decayMin: 0.995, decayMax: 0.999, transientMix: 0
→ effervescence
```

### Solo Cicada (Greengrocer)
```
triggerModel: "periodic", rate: 117, jitter: 0, resonatorQ: 10,
numRibs: 4, ribSpacing: 0.5, freqMin: 3200, freqMax: 4400,
ribFreqSweep: 1200, airSacQ: 3.5, transientMix: 0
→ tonal drone
```

### Cicada Chorus
```
triggerModel: "coupled", density: 40, rate: 117, jitter: 0.05,
couplingK: 0.3, resonatorQ: 10, numRibs: 4, ...
→ synchronising chorus with beating and phase drift
```

### NEW TERRITORY: Coupled Water
```
triggerModel: "coupled", density: 20, rate: 10, jitter: 0.5,
couplingK: 0.1, resonatorQ: 0, freqMin: 500, freqMax: 3000,
chirp: 0, transientMix: 0.3
→ water drops that gradually synchronise into rhythmic dripping
→ a creek that pulses
```

### NEW TERRITORY: Stochastic Cicada
```
triggerModel: "poisson", rate: 200, jitter: 1.0, resonatorQ: 8,
numRibs: 4, ribSpacing: 0.5, freqMin: 3000, freqMax: 5000,
→ tymbal-like resonance but randomly triggered
→ insect rain / chitinous fizz
```

### NEW TERRITORY: Harmonic Swarm
```
triggerModel: "coupled", density: 12, rate: 5, jitter: 0.2,
couplingK: 0.5, resonatorQ: 0,
freq: HRG { base: 220, nums: [1,2,3,4,5], dens: [1,1,1,1,1] }
→ slowly synchronising harmonic choir of resonant events
→ pitched, pulsing, organic
```

## Implementation Estimate

- Event pool + lifecycle: ~40 lines
- Poisson trigger: ~15 lines
- Periodic trigger + rib sequencer: ~40 lines
- Coupled trigger (Kuramoto): ~30 lines
- Sinusoid oscillator: ~10 lines
- Biquad resonator: ~20 lines
- Transient noise: ~10 lines
- Stereo panning: ~10 lines
- Parameter handling: ~25 lines
- **Total: ~200 lines**

Single AudioWorklet processor file. All modes coexist.
512 concurrent events × 20 ops/sample = ~10k ops/sample-block.
Well within phone budget even at high density.

## Relationship to Other Engines

The resonant event swarm covers water and cicada synthesis.
It does NOT cover:
- **Pink Trombone** (continuous waveguide, not event-based)
- **Syrinx model** (continuous ODE, not event-based)
- **Formant synth** (current engine — continuous oscillator + filter)

These continuous-source engines are fundamentally different: they produce
sound every sample, driven by continuous parameter streams. The swarm
engine produces sound only when events are active, with silence between.

The two paradigms (continuous source vs event swarm) could coexist as
separate modes in the mode-switching architecture, or even layer together
(syrinx ODE providing a continuous carrier, swarm adding transient texture).
