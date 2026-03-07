# Cicada Synth — Architecture Notes

## Why Physical Model?

The tymbal mechanism is elegant and cheap to simulate:
- Impulse excitation → two cascaded resonant filters
- All timbral variation from filter coefficients + timing
- Chorus emergence from coupled oscillator dynamics
- Temperature as a single macro control affecting everything

## AudioWorklet Processor Design

### Single Voice State
```
// Tymbal state
ribIndex          // which rib is currently buckling (0..numRibs-1)
ribTimer          // countdown to next rib buckle
cyclePhase        // IN or OUT
muscleTimer       // countdown to next muscle contraction
side              // LEFT or RIGHT (alternating)

// Resonator state (2× biquad)
tymbal_z1, tymbal_z2    // tymbal biquad delay elements
airsac_z1, airsac_z2    // air sac biquad delay elements

// Per-rib biquad coefficients (precomputed)
ribFreqs[numRibs]        // descending freq per rib
ribWidths[numRibs]       // impulse width per rib

// Envelope
songPhase         // position in macro envelope (rise/sustain/fall)
phrasePhase       // position in echeme cycle (for pulsed species)
```

### Per-Sample Processing
```
1. Check muscleTimer — if elapsed, start new IN cycle:
   - Reset ribIndex = 0, cyclePhase = IN, swap side
2. Check ribTimer — if elapsed and cyclePhase == IN:
   - Generate Hamming impulse at ribWidths[ribIndex]
   - Update tymbal biquad coefficients for ribFreqs[ribIndex]
   - Advance ribIndex; if all ribs done, switch to OUT phase
3. If cyclePhase == OUT:
   - Generate quieter OUT impulse
   - Update tymbal biquad for OUT frequency
   - Reset cyclePhase, restart muscleTimer
4. Run sample through tymbal biquad → air sac biquad
5. Apply phrase envelope (if pulsed species)
6. Apply song macro envelope
7. Output
```

### Computational Cost Per Voice
- Impulse generation: trivial (timer check + occasional Hamming window)
- 2× biquad: ~10 multiplies, 8 adds per sample
- Envelope: 1 multiply
- **Total: ~20 ops per sample per voice**

### Chorus (N voices)
```
for each voice i:
  // Kuramoto-type phase coupling
  phase_i += dt × (omega_i + K × Σ_neighbors sin(phase_j - phase_i))

  if phase_i crosses calling threshold:
    voice_i.active = true  // start calling bout
    voice_i.songPhase = 0  // reset macro envelope

  if voice_i.songPhase > songDuration:
    voice_i.active = false // enter silent recharge

  if voice_i.active:
    output += processSingleVoice(voice_i) × distanceAttenuation_i
```

50 voices × 20 ops = ~1000 ops/sample. Trivially cheap.

## Server Parameters (grid-controllable)

### Per-species preset
```
carrierFreq     // 3-10+ kHz
numRibs         // 2-8
muscleRate      // 50-250 Hz
tymbalQ         // 5-20
airSacQ         // 2-8
freqSweep       // rib frequency descent range
```

### Performance controls (grid rows)
```
temperature     // maps to muscleRate + slight carrierFreq shift
density         // number of active chorus voices
coupling        // synchronization strength (K)
songEnvelope    // macro shape (continuous / pulsed / revving)
phraseRate      // echeme repetition (0 = continuous, 6 = pulsed)
yodelDepth      // FM on air sac freq (0 = Greengrocer, high = Redeye)
```

### Generator integration
- **Range** on temperature → varying activity across chorus
- **Range** on carrierFreq → species mixture
- **HRG** on carrierFreq → harmonically-related carrier frequencies (musical cicadas)
- **Walk** on coupling → slowly synchronizing/desynchronizing chorus

## Species Presets

### Greengrocer (tonal drone)
```
carrierFreq: 4300, numRibs: 4, muscleRate: 117,
tymbalQ: 9.3, airSacQ: 3.4, freqSweep: 1200,
phraseRate: 0, yodelDepth: 0
```

### Redeye (growl → yodel)
```
carrierFreq: 4000, numRibs: 4, muscleRate: 110,
tymbalQ: 7, airSacQ: 3, freqSweep: 1000,
phraseRate: 0.17 (6 revs), yodelDepth: 800
```

### Silver Princess (phrased zips)
```
carrierFreq: 8000, numRibs: 3, muscleRate: 80,
tymbalQ: 8, airSacQ: 3, freqSweep: 600,
phraseRate: 4, yodelDepth: 0
```

## Musical Territories

- **Harmonic chorus**: HRG on carrier frequencies → cicadas singing in chord
- **Temperature sweep**: slowly warming → chorus accelerates, pitch rises, sync tightens
- **Cross-species blend**: mix Greengrocer drone + Silver Princess zips + Redeye yodel
- **Extreme coupling**: perfect sync → single massive pulse, zero coupling → shimmering wash
- **Sub-audio pulse rates**: slow muscleRate below normal range → rhythmic clicking
- **Micro-tuned detuning**: very tight carrier spread → beating/phasing textures

## Relationship to Water Synth

Both engines share the same fundamental primitive:
**stochastic swarms of damped resonant events**

| | Water | Cicada |
|---|---|---|
| Oscillator | Damped sinusoid | Impulse → biquad resonator |
| Event trigger | Poisson process | Muscle contraction timer |
| Resonator | Minnaert/Helmholtz (bubble) | Helmholtz (air sac) + tymbal |
| Chorus | Independent events | Coupled oscillator sync |
| Frequency control | Bubble radius | Rib stiffness + air sac volume |

A unified "resonant event swarm" engine could potentially host both,
with the cicada mode adding coupled-oscillator synchronization
and sequential rib excitation to the water engine's Poisson process.

## Estimated Implementation Size
- Single voice processor: ~100 lines
- Chorus scheduling: ~50 lines
- Species presets: ~30 lines
- AudioWorklet boilerplate: ~30 lines
- Total: ~210 lines
