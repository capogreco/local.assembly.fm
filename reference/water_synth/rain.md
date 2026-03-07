# Rain Sound Synthesis

## Two-Phase Raindrop Model

Each raindrop produces sound in two phases:

### 1. Impact Transient
- Short broadband noise burst (~1-5ms)
- Character depends on surface material (puddle vs leaf vs metal vs stone)
- Modeled as shaped noise envelope — sharp attack, fast decay
- Surface hardness controls spectral content (hard = brighter, soft = duller)

### 2. Entrained Bubble
- Splash traps air bubble underwater
- Rings as standard Minnaert damped sinusoid (same as creek model)
- Not every drop traps a bubble — entrainment probability is a key parameter
- Bubble size correlates with drop size

## Stochastic Parameters

| Parameter | Effect |
|---|---|
| Drop rate | Light drizzle → downpour |
| Drop size distribution | Small drops = patter, large = heavy plops |
| Impact surface type | Controls transient character (hard/soft/liquid) |
| Bubble entrainment probability | Ratio of drops that produce bubble resonance |
| Spatial density/spread | Distribution across stereo/spatial field |

## DSP Components

- Noise burst generator (impact): shaped white noise with envelope
- Damped sinusoid (bubble): identical to creek bubble model
- Stochastic event scheduler: Poisson-like process with size distribution

## References

- Cheng et al — Physically-based Statistical Simulation of Rain Sound (SIGGRAPH 2019)
- Raindrop-Generator — JUCE implementation (github.com/747745124/Raindrop-Generator)
