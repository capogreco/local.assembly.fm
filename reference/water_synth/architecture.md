# Water Synth — Unified Engine Architecture

## Core Concept: Modeless Stochastic Bubble Swarm

All water sounds (creek, rain, fizz, and everything between) share one DSP primitive:
**a pool of short damped sinusoids driven by a stochastic event scheduler.**

The differences between creek/rain/fizz are just parameter regimes — no mode switching needed.

## Unified Bubble Oscillator

Each bubble event has:
- **frequency** (f₀) — from Minnaert equation or direct
- **chirp** (0 = pure Minnaert, positive = Helmholtz-style upward sweep)
- **damping** (controls ring time — fast for fizz, slower for creek)
- **amplitude**
- **transient mix** (0 = pure tone, 1 = noise burst prepended)

### Parameter Regimes

| | Creek | Rain | Fizz | In-between |
|---|---|---|---|---|
| chirp | 0 | 0 | high | continuous |
| transient | 0 | 0.5-1.0 | 0 | continuous |
| damping | low | low | high | continuous |
| rate | 5-100/s | 10-1000/s | 100-1000+/s | continuous |
| freq range | 500Hz-5kHz | 500Hz-5kHz | 1kHz-15kHz | continuous |

## Stochastic Event Scheduler (control rate)

Runs once per audio block (not per sample). Rolls dice, spawns bubble events into pool.

Parameters:
- **event rate** — bubbles per second
- **radius/frequency distribution** — min, max, skew
- **chirp distribution** — min, max
- **damping distribution** — min, max
- **transient probability and intensity**
- **amplitude distribution**

Dead bubbles (amplitude below threshold) get recycled. Ring buffer of bubble slots.

## AudioWorklet Processor State

```
bubblePool[MAX_BUBBLES]: {
  phase,        // current oscillator phase
  freq,         // current frequency (Hz)
  chirp,        // freq increment per sample (Hz/sample)
  decay,        // multiply-per-sample envelope (<1)
  amp,          // current amplitude
  transientLeft // remaining transient noise samples (0 = done)
}
activeBubbles: number
scheduler: {
  accumulator,  // fractional sample counter for next event
  rate          // events per second
}
```

## Per-Sample DSP (~6-8 ops per bubble)

```
for each active bubble:
  if transientLeft > 0:
    output += amp * noise() * transientEnvelope
    transientLeft--
  else:
    // rotating phasor (avoids sin() call)
    phasor.re = phasor.re * cos(dphase) - phasor.im * sin(dphase)
    phasor.im = phasor.im * cos(dphase) + phasor.re * sin(dphase)
    output += amp * phasor.im
    freq += chirp
  amp *= decay
  if amp < threshold: recycle bubble
```

## Performance Budget (phone)

- 100 concurrent bubbles × 8 ops × 44100 samples/sec = ~35M ops/sec
- Well within phone AudioWorklet budget (~500M+ ops/sec available)
- 300-500 concurrent bubbles feasible for dense fizz

## Server Parameters (grid-controllable)

All map to existing generator types:

```
rate        — range generator (scatter/walk/converge)
freqMin     — HRG (harmonic frequency ratios) or range
freqMax     — HRG or range
freqSkew    — direct value or range
chirpMin    — range generator
chirpMax    — range generator
dampMin     — range generator
dampMax     — range generator
transientMix     — range generator (0=creek/fizz, 1=rain)
transientDecay   — range generator
amplitude        — range generator
```

## Musical Territories to Explore

- **Harmonic water**: HRG applied to bubble frequencies → pitched bubbling in tune
- **Slow fizz + low freq**: volcanic mud pool texture
- **Sparse rain + high chirp**: melodic pitch-sweep drops
- **Creek→rain crossfade**: gradually introduce impact transients
- **Creek→fizz crossfade**: increase chirp + damping, shift freq up
- **Dense rain + quantized freq**: rhythmic pitched percussion

## Implementation Plan

1. Single AudioWorklet processor file (~150-200 lines)
2. Bubble pool with fixed max size, recycling
3. Stochastic scheduler at block rate
4. All parameters received via message port from server
5. Integrate with existing generator/resolver system
6. Visualization: could map bubble events to visual particles (position = freq, size = amplitude, brightness = decay)
