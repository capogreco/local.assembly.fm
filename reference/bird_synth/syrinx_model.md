# Syrinx Physical Model — DSP Reference

## Overview

The Mindlin/Laje framework models birdsong as a pressure-driven nonlinear oscillator.
The key insight: complex song emerges from simple smooth trajectories through a
two-parameter control space (pressure, tension). No lookup tables, no samples.

## Core Equations (Normal Form near Takens-Bogdanov bifurcation)

```
dx/dt = y
dy/dt = -α·γ² - β·γ²·x - γ²·x³ - γ·x²·y + γ²·x² - γ·x·y
```

### State Variables
- `x` — labial displacement (membrane position)
- `y` — labial velocity (dx/dt) — THIS IS THE SOUND OUTPUT

### Time-Varying Control Parameters (the "gesture")
- `α` (alpha) — maps to **air sac pressure** (respiratory drive)
- `β` (beta) — maps to **labial tension/stiffness** (syringeal muscle)

### Fixed Species Parameters
- `γ` (gamma) — time constant / frequency scaling (~9000 for canary)

A song = a trajectory through the (α, β) plane.

## Practical Implementation Form (Laje-Mindlin)

```
dy[0]/dt = y[1]
dy[1]/dt = (p - b) * y[1] - k * y[0] - d * y[0]² * y[1]
```

Known parameter values:
- `b = 1000` (dissipation/friction)
- `d = 10⁸` (nonlinear dissipation — bounds motion)
- `p` = time-varying pressure (controls phonation onset)
- `k` = time-varying stiffness (controls frequency: f ∝ √k)

## Bifurcation Structure

The (α, β) plane has regions with qualitatively different dynamics:

- **Below Hopf line**: Silence. Labia at rest.
- **Cross Hopf line**: Oscillation born with zero amplitude, defined frequency.
  Produces **tonal, pure sounds** (canary-like).
- **Cross SNILC line**: Oscillation born with finite amplitude, zero frequency.
  Produces **spectrally rich sounds** (many harmonics).
- **Deep oscillatory region**: Relaxation oscillations, rich harmonics.

The PATH through the bifurcation diagram determines syllable character.
Same model, different trajectory = different syllable type.

## Two-Source (Bilateral) Model

Songbirds have independently controllable left/right syrinx:

```
d(x_l)/dt = v_l
d(v_l)/dt = (γ/M)·(2β-B)·v_l - (γβη/M)·x_l²·v_l - (γ²·K_l/M)·x_l + (γβ/M)·(v_r - v_l)

d(x_r)/dt = v_r
d(v_r)/dt = (γ/M)·(2β-B)·v_r - (γβη/M)·x_r²·v_r - (γ²·K_r/M)·x_r + (γβ/M)·(v_l - v_r)
```

Coupling terms `(v_r - v_l)` model pressure interaction through shared airway.
Detuning: `K_r = Q · K_l` — controls frequency ratio between two voices.
Q ≈ 1.0 = unison, Q ≈ 1.2 = two-voice polyphony (magpie carolling).

## Vocal Tract Filter

### Trachea (delay line)
```
p_i(t) = s(t) - r · p_i(t - T)
```
- r = reflection coefficient (~0.1)
- T = round-trip time (~0.2ms for small songbirds)
- Resonances: f_n = (2n-1) · c / (4L), c ≈ 350 m/s

### OEC (Oropharyngeal-Esophageal Cavity) — Helmholtz resonator
```
di1/dt = Ω1
dΩ1/dt = a·i1 + b·Ω1 + c·i3 + d·(dp_t/dt) + e·p_t
di3/dt = f·Ω1 + g·i3 + h·p_t
```
Output = i3. Resonance at 1.5-3 kHz (first harmonic), 6-8 kHz (third).

### Beak Radiation
High-pass filter. Wider gape = lower reflection = more radiation + wider bandwidth.

### Source-Tract COUPLING (unlike human model)
Reflected pressure feeds back into labial dynamics → frequency pulling,
subharmonics, period doubling, deterministic chaos. This is NOT a simple
source-filter model.

## Comparison with Pink Trombone (Human Vocal Model)

| Feature | Syrinx (Bird) | Larynx (Human) |
|---------|---------------|-----------------|
| Source | ODE-based self-oscillation | Parametric LF waveform |
| Sources | Two (bilateral, independent) | One |
| Frequency | Emerges from dynamics | Direct parameter |
| Spectral content | From bifurcation type | From tenseness param |
| Tract | Short tube + Helmholtz + beak | 44-segment waveguide + nasal |
| Tract params | OEC volume + beak gape (2) | Tongue, lip, velum, etc. (many) |
| Source-filter | COUPLED (feedback) | Independent |
| Control params | 2 (pressure, tension) | Many (freq, tenseness, tongue...) |

## AudioWorklet Feasibility

Per-sample cost:
- Labial ODE: ~10 multiplies, 5 adds (RK4 = 4× this = ~60 ops)
- Tracheal delay: 2 multiplies, 1 add, 1 buffer read/write
- OEC Helmholtz: ~15 ops (RK4 = ~60 ops)
- Total: ~125 ops per sample per voice

Two-source model doubles labial cost: ~185 ops per sample.
At 44.1kHz: ~8M ops/sec — easily within phone budget.

Integration method: RK4 recommended. Euler may be unstable for stiff regimes.
Oversampling (2×-4×) improves stability in chaotic regimes.

## Key Papers

- Gardner, Cecchi, Magnasco, Laje, Mindlin (2001) — "Simple Motor Gestures for Birdsongs" PRL 87
- Laje & Mindlin (2002) — "Diversity within a Birdsong" PRL 89
- Mindlin & Laje (2005) — "The Physics of Birdsong" (Springer book)
- Laje, Gardner, Mindlin (2005) — "Synthesizing bird song" Phys. Rev. E 72
- Alonso et al. (2016) — "Automatic reconstruction of physiological gestures" J. Comp. Physiol. A
- Amador, Perl, Mindlin (2017) — "Integrated model for motor control" J. Physiol. Paris
- Dottori & Mindlin (2017) — "Nonlinear dynamics in birdsong" Chaos

## Existing Implementations

| Resource | Language | Notes |
|----------|----------|-------|
| saguileran/birdsongs | Python | Full model + inverse problem + tutorials |
| ilknuricke/birdsong_generator_CPG | Matlab | CPG brain + syrinx |
| janbogar/bird_song_generator | Python | Port of above |
| notthetup/birds | Web Audio | AM/FM only — NOT physical model |
| Kelly Heaton / Nightjar | Analog circuit | Coupled oscillator PCB birds |
| Laje et al. electronic syrinx | Analog | Real-time ODE integration in hardware |

**No known JavaScript/AudioWorklet physical syrinx implementation exists.**
This is an open opportunity.
