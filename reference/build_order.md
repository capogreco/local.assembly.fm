# Build Order — Increasing Difficulty, Quick Wins First

## Architecture Decisions (locked in)

- **Main thread resolution**: all program logic, generators, shapes, phasor,
  and scheduling live in the main thread. AudioParams bridge to the audio thread.
  Envelopes do not need sample accuracy. Keep the audio thread clean.
- **Per-phone reverb**: each phone has a reverb worklet at the end of its audio graph.
  Phones transduce directly to air via loudspeaker — no opportunity for summed reverb.
- **Dormant engines are free**: inactive AudioWorklet process() checks a flag and
  returns early. All engines can be wired up simultaneously with negligible cost.
- **Engine-specific parameters**: no forced universal namespace. Each engine declares
  its own parameter set. Controller bindings are per-engine.
- **Modeless paradigm**: no performance/program mode distinction. A program is a
  set of parameter bindings — some from generators, some from live inputs, some
  from envelopes. All coexist per-parameter.
- **Incremental build**: as molecular as possible. Evaluate and clean up as we go.
- **Mono synth voices**: no spatialisation. All output is mono per phone.
- **Ctrl client on MBP**: always local MacBook Pro for the show. Connects to NUC
  server over local network via WebSocket.

## Build Sequence

### Phase 1 — Quick Wins (extend what exists)

**1.1 Arc integration**
- Add `/enc/delta` handling to server alongside existing grid OSC
- Arc discovered via same serialosc path as grid
- Map 4 encoders to current formant synth params for immediate testing
- Add `/ring/map` LED feedback
- Estimated: small addition to server.ts

**1.2 Ctrl client (minimal)**
- New `public/ctrl.html` + `public/ctrl.js`
- Same tap-to-start aesthetic as synth client
- WebSocket connection to server (same as synth clients)
- WebMIDI: enumerate inputs, forward CC/note messages to server
- Server receives ctrl messages and routes to broadcast / state
- No complex UI yet — just connection status + MIDI activity indicator
- Test with BBC2 breath controller → existing formant amplitude

**1.3 Karplus-Strong worklet**
- New `public/ks-processor.js` AudioWorklet
- Delay line + LP filter + feedback = plucked string
- AudioParams: frequency, damping, brightness, excitation, amplitude
- Trigger via message port (excite the string)
- Standalone test: trigger from ctrl client MIDI note-on
- Simplest new synthesis engine — validates multi-engine architecture

### Phase 2 — New Engines

**2.1 Reverb worklet**
- New `public/reverb-processor.js` AudioWorklet
- FDN (Feedback Delay Network) reverb, Erbe-Verb inspired
- AudioParams: size, decay, absorb, mix, feedback, modSpeed, modDepth
- Wired as last node in audio graph, after synth engine output
- All reverb params controllable from program layer (not just an effect)
- Per-phone: each phone gets its own reverb instance

**2.2 Resonant event swarm (water mode first)**
- New `public/swarm-processor.js` AudioWorklet
- Bubble pool: damped sinusoid oscillators, recycling
- Poisson trigger (control rate, main thread → message port)
- AudioParams: freqMin, freqMax, decay, amplitude
- Start with creek (pure sinusoid bubbles)
- Add chirp for fizz, transient for rain
- Test: grid controls rate + freq range, arc controls chirp + decay

**2.3 Swarm periodic + coupled modes**
- Add periodic trigger (tymbal rib sequencing, biquad resonator)
- Add coupled trigger (Kuramoto phase coupling for chorus)
- Add jitter parameter (blend between Poisson and periodic)
- Test: cicada presets on grid, temperature on arc

### Phase 3 — Program Layer

**3.1 Phasor**
- Main-thread phasor: period, subdivisions, phase accumulator
- Broadcast phase to clients (lightweight, periodic message)
- ES-8 clock output from ctrl client (Web Audio pulses synced to phasor)
- Grid display: phase indicator on a row

**3.2 Source + Shape**
- Extend existing generator system with shape types (hold, ramp, envelope, sequence)
- Client-side shape evaluation driven by phasor phase
- Main thread: resolve generators, evaluate shapes, set AudioParams
- Test: ramp shapes on swarm parameters, sequence on amplitude

**3.3 Input bindings + combine modes**
- Server routes ctrl client input to named parameters
- Per-engine controller binding maps
- Combine modes: replace, offset, scale, bias
- Test: breath → swarm rate (replace), arc → freq center (bias)

**3.4 Commands + schedule**
- Phase-triggered commands (shuffle at EOC, scatter at phase 0.5)
- Entry trigger (re-resolve on silence exit)
- Manual triggers from grid
- Test: rhythmic shuffle patterns on HRG parameters

### Phase 4 — Physical Models

**4.1 Syrinx worklet**
- New `public/syrinx-processor.js` AudioWorklet
- Bilateral ODE (RK4 integration at audio rate)
- Tracheal delay line + OEC Helmholtz resonator
- AudioParams: alpha, beta, gamma, Q, oecVolume, beakGape
- Test: BBC2 breath→alpha, bite→beta (the natural mapping)

**4.2 Pink Trombone adaptation**
- Adapt reference worklet port to our architecture
- Wire tract parameters as AudioParams
- Connect to program layer with engine-specific bindings
- Test: nod/tilt → tongue position, breath → intensity

### Phase 5 — Refinement

**5.1 Gesture capture**
- Record parameter streams from live input over phasor cycles
- Encode as envelope shapes
- Store in program (captured gesture becomes automation)
- Layered recording: perform on top of captured layers

**5.2 Program banks + scene memory**
- Save/load complete programs (all params + shapes + bindings)
- Grid page for bank selection
- Per-client local state save/load (resolved values)

**5.3 ES-8 CV output**
- Ctrl client Web Audio → ES-8 channels
- Clock, gate, pitch CV, envelope follower, triggers
- Phasor-synced clock output

**5.4 Webcam integration**
- Ctrl client getUserMedia → feature extraction
- Motion, position, brightness as input sources
- Route through same input binding system

**5.5 Visualisation strategy**
- Assess what works across engines
- Potentially: engine-specific viz modules that swap with engine
- Or: flexible viz that responds to audio output generically
- The 3D scope could work as a general waveform display

## Not Yet Scheduled

- String.assembly.fm modal bowed string (could adapt from reference)
- Euclidean rhythm integration (reference folder has materials)
- Multi-engine simultaneous (different phones on different engines)
- Advanced Kuramoto dynamics (wave propagation, spatial coupling)
