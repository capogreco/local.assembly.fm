# Bird Synth — Architecture Notes

## The Opportunity

No JavaScript/AudioWorklet implementation of a physical syrinx model exists.
The Mindlin ODE model is computationally cheap (~185 ops/sample for two-source)
and produces remarkably rich, natural-sounding birdsong from just two control parameters.

## Why Physical Model Over AM/FM Approximation?

The syrinx ODE naturally produces:
- Tonal ↔ noisy transitions (by crossing different bifurcation boundaries)
- Subharmonics, period doubling, deterministic chaos
- Two-voice biphonation (bilateral syrinx)
- Realistic attack/decay characteristics (emerge from dynamics, not enveloped)
- Source-tract coupling effects

An AM/FM approximation requires manually designing each of these.
The physical model gets them for free from the math.

## AudioWorklet Processor Design

### State (per voice)
```
// Labial dynamics (left + right for bilateral)
x_l, y_l, x_r, y_r    // position + velocity, both sides

// OEC Helmholtz resonator
i1, omega1, i3          // 3 state variables

// Tracheal delay
delay_buffer[N]         // circular buffer, N ≈ 10 samples at 48kHz
delay_idx

// Envelope / gating
active                  // boolean
```

### Parameters (from server via message port)
```
alpha       // pressure — controls onset/offset, shifts freq up
beta        // tension — primary pitch control (f ∝ √k)
gamma       // species scaling — fixed per "bird type"
Q           // detuning — bilateral frequency ratio (1.0=unison)
r           // tracheal reflection coefficient
T           // tracheal delay time
oec_volume  // OEC cavity size (shifts Helmholtz resonance)
beak_gape   // radiation filter / reflection
```

### Per-Sample Processing
```
1. Integrate left labial ODE (RK4)  → x_l, y_l
2. Integrate right labial ODE (RK4) → x_r, y_r
3. Source signal s = y_l + y_r (sum velocities)
4. Tracheal delay: p_i = s - r × delayed_p_i
5. Transmitted: p_t = (1-r) × delayed half-trip
6. Integrate OEC ODE (RK4 or Euler) → i3
7. Output = i3
```

## Gesture System (how to make it sing)

A "gesture" is a trajectory through (α, β) space over time.
Each syllable = an elliptical or looping path.

### For Darebin Creek birds, gesture types needed:

**Tonal whistle** (Pardalote, Butcherbird piping, Currawong):
- Smooth entry across Hopf line, sustained in tonal region
- β controls pitch, slow β ramp = glissando

**Rich/harsh call** (Cockatoo screech, Wattlebird yack):
- Entry across SNILC line, deep in oscillatory region
- High α (pressure) for loudness and spectral richness

**Tremolo/trill** (Kookaburra rolling, Fairy-wren trill):
- Rapid α oscillation (on/off boundary) at tremolo rate
- Or rapid β oscillation for pitch trill

**Biphonation** (Magpie carol):
- Q ≠ 1.0, both sources active
- Independent β_l, β_r for two-voice intervals

**Percussive chip** (Noisy Miner, alarm calls):
- Very fast α spike across bifurcation and back
- Brief excursion into oscillatory region

### Gesture sequencing from server:
```
{
  type: "gesture",
  syllables: [
    { alpha: [0, 0.3, 0.3, 0], beta: [0.5, 0.5, 0.8, 0.8], duration: 400 },
    { gap: 100 },
    { alpha: [0, 0.4, 0.4, 0], beta: [0.8, 0.3, 0.3, 0.8], duration: 600 }
  ]
}
```

Each syllable's α and β arrays define control points for interpolation
over the syllable duration. The processor interpolates sample-by-sample.

## Grid Mapping Ideas

- Row 1: α (pressure) base level — controls loudness / onset threshold
- Row 2: β (tension) — controls pitch
- Row 3: Q (detuning) — unison to biphonation
- Row 4: gesture speed — tempo of syllable sequences
- Row 5: γ (species) — frequency scaling
- Row 6: OEC resonance — timbral filtering

Behaviours:
- HRG on β → harmonic pitch sequences
- Range on α → varying loudness/onset dynamics
- Shuffle on gesture bank → randomized syllable ordering

## Estimated Implementation Size

- Syrinx ODE + bilateral: ~60 lines
- Tracheal delay: ~15 lines
- OEC filter: ~30 lines
- Gesture interpolation: ~30 lines
- AudioWorklet boilerplate: ~30 lines
- Total: ~165 lines

## References

See syrinx_model.md for equations and papers.
See darebin_creek_birds.md for species-specific synthesis targets.
