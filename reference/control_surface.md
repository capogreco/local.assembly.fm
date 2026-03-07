# Control Surface Architecture

## Hardware Controllers

### Monome Grid 128 (16×8)
- **Connection**: serialosc → OSC over UDP (already implemented)
- **Character**: discrete, spatial, momentary/toggle
- **Use**: banks of values, pattern selection, gestures, page-based parameter editing
- **Protocol**: `/assembly/grid/key x y s` (input), `/assembly/grid/led/level/map` (output)

### Monome Arc (4 encoders)
- **Connection**: serialosc → OSC over UDP (same path as grid, handled in Deno server)
- **Note**: string.assembly.fm used Web Serial API for arc in browser; here we use
  serialosc in Deno for consistency with grid. Both go through same OSC discovery.
- **Character**: high-resolution continuous rotation, no detents
- **Protocol**: `/enc/delta n d` (input), `/ring/map n d[64]` (LED ring output)
- **Use**: smooth continuous parameters — pressure, tension, coupling, temperature
- **Natural mappings**:
  - Syrinx: α (pressure) + β (tension) on two encoders = complete gesture control
  - Water: rate + freq range on two encoders
  - Cicada: temperature + coupling on two encoders
  - Fourth encoder: mode-specific or global (master level, tempo, density)

### USB MIDI Keyboard
- **Connection**: via ctrl client (browser WebMIDI API)
- **Character**: note on/off, velocity, pitch bend, mod wheel, aftertouch
- **Use**: pitched control of syrinx/formant, event triggers for swarm engine,
  mod wheel + pitch bend as continuous controllers
- **Natural mappings**:
  - Syrinx: note → β (tension/pitch), velocity → α (pressure), aftertouch → vibrato
  - Swarm: note on → manual event trigger at pitched frequency
  - Formant: note → base frequency for HRG

### TEControl BBC2 (Breath & Bite Controller 2)
- **Connection**: via ctrl client (browser WebMIDI API), USB-MIDI class compliant
- **Sensors**: 4 continuous controllers, all hands-free:
  - **Breath** (CC#2): air pressure, high resolution
  - **Bite** (CC#1): jaw/lip pressure via piezo in mouthpiece
  - **Nod** (CC#12): head tilt up/down (accelerometer)
  - **Tilt** (CC#13): head tilt left/right (accelerometer)
- **Config**: CCs, sensitivity curves, input/output range, attack/decay all
  configurable via TEControl utility. Can also output pitch bend or aftertouch.
- **Natural mappings**:
  - Syrinx (complete gesture control, hands-free):
    - Breath → α (air sac pressure) — phonation onset, amplitude
    - Bite → β (labial tension) — pitch control
    - Nod → OEC volume — head tilt shifts Helmholtz resonance
    - Tilt → Q detuning — bilateral voice spread
  - Water:
    - Breath → event rate (gentle = drip, hard = torrent)
    - Bite → frequency range (jaw tension = higher pitch)
    - Nod → chirp amount
    - Tilt → stereo spread
  - Cicada:
    - Breath → chorus density / individual volume
    - Bite → temperature (muscle rate)
    - Nod → coupling strength
    - Tilt → carrier frequency detune
  - Formant:
    - Breath → amplitude
    - Bite → vowel morph / zing
    - Nod/Tilt → vowel X/Y

### Expert Sleepers ES-8 (DC-coupled USB audio interface)
- **Connection**: via ctrl client (browser Web Audio API → USB audio)
- **Character**: 8 output channels, DC-coupled, eurorack level (±10V)
- **Use**: CV/gate/clock output to eurorack
- **Capabilities**:
  - Clock pulses at server tempo (any division/multiplication)
  - Gate signals from note on/off
  - CV from any continuous parameter (pitch, pressure, LFO, envelope)
  - Trigger pulses from swarm events (bubble/click → trigger out)
  - Up to 8 simultaneous CV/gate channels
- **Timing**: Web Audio buffer at 128 samples / 44.1kHz = ~3ms jitter.
  At 48kHz with small buffer: <3ms. Acceptable for musical clock.
  AudioWorklet gives sample-accurate timing within the buffer.
- **No clamping needed**: ES-8 is DC-coupled to eurorack standards,
  outputs ±10V directly from Web Audio ±1.0 float range.

### Webcam
- **Connection**: via ctrl client (browser getUserMedia API)
- **Character**: video stream, processed client-side into parameter streams
- **Potential mappings**:
  - Motion detection → activity/density parameter
  - Hand tracking (MediaPipe) → X/Y continuous control
  - Color/brightness tracking → parameter modulation
  - Face/pose estimation → gestural control
  - Optical flow → velocity-based modulation
- **Processing**: all done in browser (canvas pixel manipulation or ML library),
  only extracted parameter values sent to server via WebSocket.
  Keeps video data local, sends lightweight control messages.

## The Ctrl Client

A dedicated browser page (`ctrl.html`) that translates hardware protocols
into server WebSocket messages.

### Architecture
```
┌─────────────────────────────────────┐
│           ctrl.html (browser)       │
│                                     │
│  WebMIDI ←── USB MIDI keyboard      │
│  WebMIDI ←── MIDI breath controller │
│  getUserMedia ←── webcam            │
│  Web Audio ──→ ES-8 ──→ eurorack   │
│                                     │
│  WebSocket ←──→ server              │
│                                     │
│  Local processing:                  │
│  - MIDI → param messages            │
│  - Video → extracted features       │
│  - Server clock → audio pulses      │
│  - UI for mapping / monitoring      │
└─────────────────────────────────────┘
```

### Message Flow
- MIDI note on → `{ type: "ctrl", source: "keyboard", note: 60, vel: 100 }`
- Breath CC → `{ type: "ctrl", source: "breath", value: 0.73 }`
- Webcam motion → `{ type: "ctrl", source: "webcam", motion: 0.4, x: 0.6, y: 0.3 }`
- Server can route these to any synthesis parameter via mapping config

### Ctrl Client Location
The ctrl client always runs on a local MacBook Pro (for the show).
This gives access to:
- USB MIDI devices (keyboard, BBC2) via WebMIDI
- ES-8 audio output via Web Audio
- Webcam via getUserMedia
- Reliable display for monitoring

The ctrl client connects to the NUC server over the local network
via WebSocket, same as synth clients. The NUC handles grid + arc
directly via serialosc/UDP.

## Full Signal Flow

```
                        ┌──────────────────────────────┐
                        │        SERVER (Deno)          │
                        │                               │
  Grid  ──── OSC/UDP ──│  grid controller               │
  Arc   ──── OSC/UDP ──│  arc controller                │
                        │                               │
                        │  parameter state / routing     │
                        │         │                     │
                        │  WebSocket hub ───────────────│──→ phone clients (synth)
                        │    ↑          ↑               │──→ ensemble client
                        │    │          │               │
                        └────│──────────│───────────────┘
                             │          │
                      ┌──────┴───┐ ┌────┴──────┐
                      │ctrl (NUC)│ │ctrl (other)│
                      │          │ │            │
                      │ keyboard │ │ webcam     │
                      │ breath   │ │ touch      │
                      │ ES-8 out │ │            │
                      └──────────┘ └────────────┘
```

## Mapping Layer

The server needs a mapping layer that routes control inputs to synthesis parameters.
This could be:
- Static mappings defined in code / config
- Dynamic mappings configurable from the grid (a "mapping" page)
- Per-mode mappings that change when the synthesis engine switches

Example mapping config:
```
{
  "syrinx": {
    "arc.0": "alpha",           // arc encoder 0 → pressure
    "arc.1": "beta",            // arc encoder 1 → tension
    "arc.2": "Q",               // arc encoder 2 → bilateral detuning
    "arc.3": "oecVolume",       // arc encoder 3 → OEC resonance
    "breath": "alpha",          // breath overrides arc.0 when active
    "keyboard.note": "beta",    // keyboard note → pitch/tension
    "keyboard.velocity": "alpha", // velocity → pressure
    "webcam.motion": "vibrato"  // motion → vibrato depth
  },
  "water": {
    "arc.0": "rate",
    "arc.1": "freqCenter",
    "arc.2": "chirp",
    "arc.3": "transientMix",
    "breath": "rate",
    "keyboard.note": "freqCenter"
  }
}
```

The mapping layer sits in the server between control input and synthesis broadcast.
Grid/arc manipulate the mapping config itself (meta-control).
