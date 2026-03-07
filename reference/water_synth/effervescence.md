# Effervescence / Fizz Sound Synthesis

## Mechanism: Helmholtz Resonance (not Minnaert)

Unlike underwater bubbles, effervescent sound comes from bubbles **bursting at the surface**:
- Bubble rises to surface → thin film ruptures → cavity collapses
- Open cavity acts as Helmholtz resonator
- Frequency **sweeps upward** as film retracts and opening widens
- Each burst is very short (~1-2ms), higher frequency than underwater bubbles

## Single Event Model: Chirped Damped Sinusoid

```
y(t) = A * sin(2π * (f₀ + chirp * t) * t) * e^(-d * t)
```

- f₀ = initial frequency (from bubble size)
- chirp = rate of frequency increase (from film retraction speed)
- d = damping coefficient (fast — bursts are very brief)

## Stochastic Parameters

| Parameter | Effect |
|---|---|
| Burst rate | Freshly poured → going flat |
| Bubble size distribution | Frequency range (champagne = tiny/high, soda = larger/lower) |
| Chirp amount | Frequency sweep during burst |
| Burst duration | Very short = crisp fizz, longer = more tonal |

## Character Examples

- Champagne: very high rate, tiny bubbles (high freq), dense hiss
- Soda: moderate rate, larger bubbles, more individual crackle
- Going flat: decreasing rate over time, fewer small bubbles

## Comparison with Underwater Bubbles

| | Underwater (Minnaert) | Surface burst (Helmholtz) |
|---|---|---|
| Frequency | Fixed per bubble | Chirps upward |
| Duration | 10-50ms | 1-5ms |
| Freq range | 500Hz-5kHz | 1kHz-15kHz |
| Mechanism | Volume oscillation | Cavity opening resonance |

## References

- Sound of Effervescence (Phys. Rev. Fluids 2021)
- Pop Science: Acoustics of Bubbles (Acentech)
