# Cicada Sound Synthesis — Tymbal Physical Model

## Physical Mechanism

### The Tymbal System
- **Tymbal membrane**: ribbed, sclerotized (hardened chitin) plate on first abdominal segment
- **Tymbal muscle**: fast-twitch muscle pulls tymbal inward via apodeme
- **Resilin pad**: elastic protein at rib base, stores energy for outward recovery
- **Abdominal air sac**: large hollow cavity, acts as Helmholtz resonator

### Buckling Mechanism (Cyclochila australasiae reference)
- Muscle contracts → ribs buckle **sequentially, posterior to anterior**
- Each rib undergoes bistable snap-through (convex → V-shape)
- **IN cycle**: 4 ribs buckle → 4 sound pulses (damped oscillations)
- **OUT cycle**: resilin springs tymbal back → 1 quieter pulse
- One IN-OUT cycle = ~5 pulses per muscle contraction
- IN pulses ~10 dB louder than OUT pulse

### Abdominal Helmholtz Resonator

```
f₀ = (c / 2π) × √(A / (V × L_eff))
```

- c = speed of sound (~340 m/s)
- A = combined tympanal opening area
- V = air sac volume
- L_eff = effective neck length ≈ 1.7 × r (for hole in thin wall)

For C. australasiae: predicts **~4.3 kHz** — matches observation.

### Coupled Resonator System
- **Tymbal resonance**: Q ≈ 9-10, freq shifts 5.5 → 4.3 kHz as ribs buckle
- **Air sac resonance**: Q ≈ 3.4, fixed at ~4.3 kHz
- **Combined Q ≈ 12.5** (approximately additive)
- Per-rib dominant frequencies: 4.37, 4.19, 3.92, 3.17 kHz

## Signal Structure (Hierarchical)

### Level 1 — The Click (single rib buckling)
Damped sinusoidal pulse at resonant frequency. Duration ~1-3 ms.

### Level 2 — The Pulse Train (one IN-OUT cycle)
4 IN clicks + 1 OUT click. If Q high enough, decaying oscillations
overlap and reinforce → sustained tone emerges from rapid impulses.

### Level 3 — Bilateral Alternation
Left and right tymbals alternate. Combined pulse rate = 2× individual muscle rate.
C. australasiae: 117 Hz per side = **234 Hz combined pulse rate**.

### Level 4 — Echeme/Phrase
Species-specific groupings. Some species pulse at 6 Hz chirp rate.
Others continuous drone. "Revving" = repeated crescendo-decrescendo.

### Level 5 — Calling Song
Macro envelope: rise-sustain-fall over seconds to minutes.
Can last hours in hot weather.

## DSP Architecture (Smyth & Smith, CCRMA Stanford)

```
[Impulse Generator] → [Biquad: Tymbal] → [Biquad: Air Sac] → [AM Envelope] → output
                           ↑
                    coefficients update
                    per rib (freq sweep)
```

### Excitation
Variable-width **Hamming-windowed impulse** per rib buckling event.
Width varies per rib (~0.1-1ms).

### Resonators
Two cascaded **biquad (IIR) filters**:
1. Tymbal resonator (Q~10, freq updates per rib)
2. Air sac resonator (Q~3.5, fixed freq)

### Dynamic Coefficients
Each IN cycle: biquad coefficients update per rib to model
descending resonant frequency as more ribs buckle.

## Synthesis Parameters

| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| carrierFreq | 1000-8000 Hz | 4300 | Tymbal/air sac resonant frequency |
| numRibs | 2-8 | 4 | Ribs per tymbal |
| muscleRate | 50-250 Hz | 120 | Contraction rate per side |
| ribSpacing | 0.2-2.0 ms | 0.5 | Time between rib clicks |
| tymbalQ | 5-20 | 10 | Tymbal resonance Q |
| airSacQ | 2-8 | 3.5 | Air sac resonance Q |
| freqSweep | 0-2000 Hz | 1200 | Freq drop across rib sequence |
| impulseWidth | 0.1-1.0 ms | 0.3 | Hamming impulse width |
| inOutRatio | 0-1 | 0.3 | OUT/IN amplitude ratio |
| phraseRate | 0-20 Hz | 0 | Chirp/echeme rate (0=continuous) |
| phraseDuty | 0.1-0.9 | 0.5 | Chirp on/off duty cycle |
| temperature | 18-40°C | 28 | Maps to muscle rate + carrier freq |

## Chorus Model

### Synchronization (Sheppard et al. 2020)
Relaxation oscillator ensemble — each cicada alternates calling/silent phases.
Positive feedback: louder ambient sound → shorter silent interval.

Emergent behaviour:
1. Asynchronous (low coupling)
2. Within-tree sync (intra-tree coupling)
3. Between-tree phase sync (inter-tree coupling)

### Kuramoto-type coupling
```
d(θᵢ)/dt = ωᵢ + (K/N) × Σⱼ sin(θⱼ - θᵢ)
```
- θᵢ = phase of cicada i
- ωᵢ = natural calling frequency (with variation)
- K = coupling strength
- When K > critical threshold: incoherence → partial sync → full sync

### Chorus parameters
- N voices with detuned carriers (~5-10% variation)
- Individual phase offsets (initially random, converging)
- Spatial positions (distance-based attenuation + coupling delay)
- Density: sparse individuals → wall of sound (transition at ~10-50 voices)

## AudioWorklet Feasibility

Per-voice cost:
- Impulse generator: trivial (timer + Hamming window)
- 2× biquad filters: ~10 multiplies, 8 adds per sample
- AM envelope: 1 multiply
- Total: ~20 ops per sample per voice

For chorus of 50 voices: ~1M ops/sample-block (128 samples) = trivial.
The stochastic chorus scheduling is control-rate.

## References

- Bennet-Clark & Young 1992 — Model of sound production in cicadas (J. Exp. Biol.)
- Young & Bennet-Clark 1995 — Role of tymbal (J. Exp. Biol.)
- Young 1997 — Tymbal mechanics C. australasiae (J. Exp. Biol.)
- Bennet-Clark & Daws 1999 — Transduction of mechanical energy (J. Exp. Biol.)
- Smyth & Smith 2001 — Musical instrument from cicada model (ICMC, CCRMA Stanford)
- Smyth & Smith 2002 — Sustained tones via sequential buckling (NIME)
- Nature Communications 2025 — Tymbal as metastructure (coupled bistable oscillator chain)
- Sheppard et al. 2020 — Self-organizing cicada choruses (Ecology and Evolution)
- Farnell — Designing Sound (procedural insect synthesis, Pure Data)
