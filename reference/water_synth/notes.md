# Water Sound Synthesis — Bubble-Based Physical Model

## Core Model: Single Bubble = Damped Sinusoid

```
y(t) = A * sin(2π * f * t) * e^(-d * t)
```

### Minnaert Frequency (bubble resonance)

```
f = (1 / 2πr) * sqrt(3γP / ρ)
```

- **r** = bubble radius (main control — smaller = higher pitch)
- **γ** = polytropic gas coefficient (~1.4 for air)
- **P** = ambient pressure (~101325 Pa)
- **ρ** = water density (~998 kg/m³)

Simplifies to roughly **f ≈ 3.26 / r** Hz for air in water.
- 3mm bubble ≈ 1kHz
- 1mm bubble ≈ 3kHz

### Damping

Three sources: thermal, viscous, radiation. Smaller bubbles decay faster.
Typical bubble lifetimes: 10-50ms.

## Building Complex Water Sounds (van den Doel 2005)

A creek/stream/rain = stochastic process of bubble events.

### Stochastic Parameters

| Parameter | Effect |
|---|---|
| Bubble rate (events/sec) | Sparse drip → rushing torrent |
| Radius distribution (min/max) | Pitch character — deep glugs vs bright splashing |
| Radius distribution skew | Tonal center of the water |
| Amplitude distribution | Evenness vs chaotic dynamics |
| Decay rate distribution | Ring time — plunky vs washy |
| Rise chirp amount | Static pools vs flowing water |

### Character Examples

- Gentle creek: low rate (5-20/sec), medium radius (2-5mm), moderate amplitude variance
- Rushing stream: high rate (100+/sec), wider radius spread, heavy overlap
- Dripping: very low rate (0.5-2/sec), narrow radius, high amplitude per event

## AudioWorklet Feasibility

Very cheap DSP per bubble:
- One sin() or rotating phasor (2 multiplies)
- One exponential decay (multiply by constant < 1)
- Sum into output

50-100 simultaneous bubbles easily within phone budget.
Event scheduling is control-rate, not audio-rate.

## Grid Mapping Ideas

- Rate and radius range as primary row controls
- Behaviours (scatter/walk/converge) applied to stochastic params over time
- HRG could work for radius ratios (harmonic bubble relationships)

## References

- van den Doel — Physically Based Models for Liquid Sounds (ACM 2005)
- Zheng & James — Improved Water Sound Synthesis using Coupled Bubbles (Stanford)
- Moss et al — Sounding Liquids (UNC)
