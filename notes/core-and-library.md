# Core objects vs the maker's library

Status: sorted 2026-10-24. Library candidates are tagged `lib: "maker"` in `public/gpi-types.js` (no behaviour change; the tag is what `lib.json` extraction will key on). Nothing has moved yet; this keeps core work from being waylaid by instrument-specific engines. The mechanism for libraries is in `notes/libraries.md`.

Rule of thumb: **core** = anything a patch language needs to be complete and that a stranger would expect (control flow, maths, time, routing, wireless, generic signal and envelope primitives, I/O). **Library** = a particular sound design or a particular piece of hardware.

## Core (priority)

| Group | Types |
|---|---|
| Abstraction and notation | `inlet` `outlet` `comment` |
| Values and UI | `const` `knob` `toggle` `print` `event` `change` |
| Time and shapes | `phasor` `lfo` `metro` `sine` `tri` `ar` `adsr` `ramp` `step` `sigmoid` `cosine` `delay` |
| Sequencing and randomness | `seq` `drunk` `counter` `random` `range` `spread` `jitter` |
| Maths and mapping | arithmetic ops, `scale` `clip` `map` `floor` `ceil` `round` `quantize` `mtof` `xor` |
| Arrays | `length` `sort` `nth` `reverse` `shuffle` `octaves` |
| Smoothing | `slew` `lag` `inertia` `follow` |
| Flow | `gate` `switch` `spigot` `fan` `trigger`/`t` `select`/`sel` `swap` `sample-hold` |
| Routers (the border) | `all` `one` `group` `sweep` `assign` `sall` |
| Wireless | `send`/`s` `receive`/`r` `throw` `catch` and the `~` versions |
| Phone I/O | `sendup` `uplink` `clients` `screen` `text` `touch` |
| Signal primitives | `osc~` `noise~` `sig~` `const~` `lfo~` `phasor~` the `~` envelopes, `trig~` and `~` maths, `dac~` `adc~` |
| Native nodes | `oscillatorNode~` `gainNode~` `biquadFilterNode~` `conv~` |
| Analysis and display | `fftPeaks~` `scope~` |
| MIDI | `cc` `key` `pad` `held` |
| Monome | `grid-trig` `grid-toggle` `grid-array` `arc` | decided: core (the OSC bridge lives in the server) |
| Core engines and effects | `karplus-strong~` `formant~` `chaos~` `reverb~` | decided: core (`reverb~` has an audio inlet, so it is an effect, not an engine) |

## Library candidates (the maker's)

| Group | Types | Why |
|---|---|---|
| Instrument engines | `ewing~` `frog~` `swarm~` `cute-sine~` `sine-osc~` `noise-engine~` | specific sound designs, each a worklet |
| BBC2 (MIDI controller) | `breath` `bite` `nod` `tilt` | just named CC inputs (CC2, 1, 12, 13); could be abstractions over `cc` |

## Definition: synthesis engine (Thomas, 2026-10-24)

An **engine** is any object that accepts only ctrl messages (no audio inlet) and has at least one audio outlet. Objects with an audio inlet are effects or processors.

Computed from `public/gpi-types.js` (rough parse, check before relying on it):
- **Engines:** `osc~` `lfo~` `phasor~` `noise~` `sig~` `const~` `chaos~` `oscillatorNode~` `sine-osc~` `cute-sine~` `noise-engine~` `formant~` `karplus-strong~` `ewing~` `frog~` `swarm~`, plus the envelope and trigger objects `ar~` `adsr~` `sigmoid~` `cosine~` `ramp~` `trig~` `step~`.
- **Edge cases that satisfy the definition but are not synthesis:** `adc~` (input), `receive~`/`r~`/`catch~` (wireless audio receivers).
- **Not engines (audio inlet):** `+~` `-~` `*~` `/~` `**~` `scale~` `clip~` `mtof~` `slew~` `gainNode~` `biquadFilterNode~` `reverb~` `conv~`.

## Decided

- `scope~` is core.
- `reverb~`, `karplus-strong~`, `formant~`, `chaos~` are core.
- Monome (`grid-*`, `arc`) is core.
- BBC2 boxes, and the instrument engines tagged `lib: "maker"`, are library candidates.

## Questions

1. Should the envelope and trigger objects (`ar~`, `adsr~`, ...) count as engines under the definition, or does the definition need a "produces a signal you hear" qualifier? And are `adc~` and the wireless receivers excluded by name or by a rule?
