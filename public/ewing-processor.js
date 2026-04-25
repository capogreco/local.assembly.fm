/**
 * Ewing's Tree Frog (Litoria ewingii) Worklet
 *
 * Each instance is an autonomous, enclosed frog. On construction it picks its
 * own personality — formantHz, formantQ, pulseRateHz, call template, inter-call
 * interval — randomly within species-plausible ranges. That personality is
 * fixed: every call this frog makes uses the same template. Variation across
 * the chorus comes from frog-to-frog differences, not call-to-call differences.
 *
 * === Synthesis model ===
 *
 * Grains (pulses) ALWAYS fire at pulseRateHz, continuously, regardless of
 * chatter/hold mode. They excite a high-Q biquad bandpass (formant). The
 * formant rings — THAT ring is the perceived pitch.
 *
 * Each pulse is a short NOISE BURST (3 samples) rather than a single-sample
 * impulse. Broadband excitation preserves the "short sharp harsh" character
 * that Elliott-Tate & Rowley describe; single impulses produce a pure
 * sinusoidal ring which sounds too tonal.
 *
 * At high Q (14-22), ring decay > pulse period → pulses fuse into a whirring
 * formant tone, matching the literature's "individual pulses not clearly
 * audible for L. ewingii" observation.
 *
 * === Call structure (chatter) ===
 *
 * 7 notes per call (±1):
 *   - NOTE 0: long introductory note (~0.35 s), quieter — the "creeeeeee".
 *   - NOTES 1, 2: short (~0.18 s), amplitude climbing to plateau.
 *   - NOTES 3+: short (~0.18 s), uniform plateau amplitude.
 * Per-note wedge envelope: linear 0→noteAmp rise across the note, applied
 * POST biquad for a clean silhouette that terminates abruptly at peak.
 * Inter-note gap ~0.07 s, uniform.
 *
 * === Per-call formant drift ===
 *
 * Each call picks a random drift factor (0.97–1.03). The formant's tuning
 * linearly interpolates from 1.0× to that factor over the duration of the
 * call. Gives calls a subtle organic pitch arc.
 *
 * === Hold mode (singing) ===
 *
 * Not a separate "held tone" — the same grain stream keeps firing. `hold`
 * modifies the call parameters:
 *   1. Envelope "flattens" — the zero-between-notes and per-note wedge get
 *      blended toward 1.0, so the grains ring the formant CONTINUOUSLY
 *      instead of being gated into note-shapes.
 *   2. Formant frequency glides from the frog's species formantHz to the
 *      user-controlled `pitch`. The continuous grain excitation now rings
 *      the formant at the chord note.
 *   3. Per-call drift winds down as pitch takes over (implicit in the
 *      lerp — at hold=1, drift has no audible effect).
 *
 * Morph timescale: ~1 s via `holdSmoothCoeff`, slow and natural.
 *
 * Outside controls (only):
 *   hold (0-1)  : 0 = chatter. 1 = singing. Smoothly morphs.
 *   pitch (Hz)  : held-tone fundamental, with portamento. [100, 8000] clamp.
 *
 * Default amplitude 0.15 — real Ewing's are quiet.
 *
 * Args: optional pitch glide time in ms (default 100). 0 = instant.
 */

const rand    = (min, max) => min + Math.random() * (max - min);
const randLog = (min, max) => Math.exp(Math.log(min) + Math.random() * (Math.log(max) - Math.log(min)));
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

const OUTPUT_GAIN = 30;
const NOISE_BURST_LEN = 3;          // samples per pulse burst (R4)

class EwingProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "pitch",     defaultValue: 1000, automationRate: "k-rate" },
      { name: "hold",      defaultValue: 0,    automationRate: "k-rate" },
      { name: "amplitude", defaultValue: 0.15, automationRate: "k-rate" },
    ];
  }

  constructor(options) {
    super();
    this.sr = sampleRate;

    const glideMs = options?.processorOptions?.glideMs ?? 100;
    this.glideCoeff = glideMs > 0 ? Math.exp(-1 / (glideMs * 0.001 * this.sr)) : 0;

    // Hold smoothing ~1 s — slow, natural morph between chatter and singing.
    this.holdSmoothCoeff = Math.exp(-1 / (1.0 * this.sr));
    this.holdCurrent = 0;

    // Per-frog fixed personality
    this.frog = {
      formantHz:        randLog(2000, 3000),
      formantQ:         rand(14, 22),
      pulseRateHz:      randLog(70, 130),
      numNotes:         randInt(6, 8),
      climbCount:       3,
      firstNoteDurSec:  rand(0.30, 0.40),
      restNoteDurSec:   rand(0.15, 0.22),
      postNoteGapSec:   rand(0.05, 0.09),
      introAmp:         rand(0.45, 0.65),
      plateauAmp:       rand(0.90, 1.0),
      burstIntervalSec: randLog(4, 10),
      driftMagnitude:   rand(0.015, 0.035),  // per-call drift span, ~±1.5-3.5%
    };

    this.pitchCurrent = this.frog.formantHz;

    // Biquad bandpass state + coefficients (recomputed when effective
    // formant frequency changes appreciably)
    this.bq = { b0: 0, b2: 0, a1: 0, a2: 0 };
    this.bqState = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this._lastEffectiveFormantHz = -1;

    // Call state machine (always running — chatter structure is present in
    // the envelope track even during hold; hold just floods it with 1.0)
    this.callActive = false;
    this.noteIndex = 0;
    this.callStartSample = 0;       // for drift progress
    this.callTotalSamples = 1;
    this.currentCallDriftEnd = 1;   // multiplier at end of call

    this.noteActive = false;
    this.noteAmp = 0;
    this.noteSamplesElapsed = 0;
    this.noteSamplesTotal = 0;
    this.samplesUntilNextNote = 0;

    this.samplesUntilNextPulse = 0;

    // Noise-burst buffer for current pulse (R4 broadband excitation)
    this.burstBuf = new Float32Array(NOISE_BURST_LEN);
    this.burstRemaining = 0;

    // Sample clock (used for call-drift progress)
    this.sampleClock = 0;

    // First call staggered randomly so a chorus doesn't sync at startup
    this.samplesUntilNextCall = Math.round(this.sr * rand(0.3, this.frog.burstIntervalSec));
  }

  _computeBandpass(fHz, q) {
    const w0 = 6.2832 * fHz / this.sr;
    const cosW = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.max(0.5, q));
    const a0 = 1 + alpha;
    this.bq.b0 = alpha / a0;
    this.bq.b2 = -alpha / a0;
    this.bq.a1 = (-2 * cosW) / a0;
    this.bq.a2 = (1 - alpha) / a0;
  }

  scheduleNextCall() {
    const u = Math.max(0.001, Math.random());
    const interval = Math.min(20, Math.max(0.6, -Math.log(u) * this.frog.burstIntervalSec));
    this.samplesUntilNextCall = Math.round(interval * this.sr);
  }

  startCall() {
    const f = this.frog;
    this.callActive = true;
    this.noteIndex = 0;

    // Pick per-call drift: a random direction/magnitude for this call's
    // formant-tuning arc. Linear ramp from 1.0 at call start → driftEnd at
    // call end.
    const sign = Math.random() < 0.5 ? -1 : 1;
    this.currentCallDriftEnd = 1 + sign * rand(0.5, 1.0) * f.driftMagnitude;

    // Estimate total call duration for drift progress tracking.
    this.callTotalSamples = Math.round((
      f.firstNoteDurSec +
      (f.numNotes - 1) * f.restNoteDurSec +
      f.numNotes * f.postNoteGapSec
    ) * this.sr);
    this.callStartSample = this.sampleClock;

    this._startNextNote();
  }

  _startNextNote() {
    const f = this.frog;
    const i = this.noteIndex;

    // Climb across first climbCount notes, then plateau
    const climbP = Math.min(1, i / Math.max(1, f.climbCount - 1));
    const amp = f.introAmp + (f.plateauAmp - f.introAmp) * climbP;

    // Intro is longer than body notes
    const noteLengthSec = (i === 0) ? f.firstNoteDurSec : f.restNoteDurSec;

    this.noteActive = true;
    this.noteAmp = amp;
    this.noteSamplesElapsed = 0;
    this.noteSamplesTotal = Math.max(1, Math.round(noteLengthSec * this.sr));

    this.noteIndex++;
    // Schedule either the next note or the end-of-call
    const gapSamples = Math.max(0, Math.round(f.postNoteGapSec * this.sr));
    this.samplesUntilNextNote = this.noteSamplesTotal + gapSamples;
  }

  _fillBurst() {
    // Broadband noise burst for pulse excitation (R4).
    // Using flat noise (no window) — 3 random samples at ±1. The biquad
    // does the formant-shaping. Adds harsh bite that a single impulse lacks.
    for (let i = 0; i < NOISE_BURST_LEN; i++) {
      this.burstBuf[i] = Math.random() * 2 - 1;
    }
    this.burstRemaining = NOISE_BURST_LEN;
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const blockSize = out.length;
    const sr = this.sr;

    const pitchHz    = Math.max(100, Math.min(8000, parameters.pitch[0]));
    const holdTarget = Math.min(1, Math.max(0, parameters.hold[0]));
    const amplitude  = parameters.amplitude[0];

    const pulsePeriodSamples = sr / this.frog.pulseRateHz;
    const bq = this.bq;
    const st = this.bqState;

    for (let s = 0; s < blockSize; s++) {
      this.sampleClock++;

      // Smooth pitch (portamento) and hold (slow morph ~1 s)
      this.pitchCurrent = pitchHz + this.glideCoeff * (this.pitchCurrent - pitchHz);
      this.holdCurrent = holdTarget + this.holdSmoothCoeff * (this.holdCurrent - holdTarget);
      const hold = this.holdCurrent;

      // Autonomous scheduler — ALWAYS running, even during hold. The grain
      // stream is continuous; the envelope track carries chatter's note
      // structure; hold floods that envelope toward 1.0 so the grains
      // become perceptually sustained.
      if (!this.callActive) {
        if (this.samplesUntilNextCall > 0) {
          this.samplesUntilNextCall--;
        } else {
          this.startCall();
        }
      } else {
        if (this.noteActive && this.noteSamplesElapsed >= this.noteSamplesTotal) {
          this.noteActive = false;
        }
        if (this.samplesUntilNextNote > 0) {
          this.samplesUntilNextNote--;
          if (this.samplesUntilNextNote === 0) {
            if (this.noteIndex < this.frog.numNotes) {
              this._startNextNote();
            } else {
              this.callActive = false;
              this.scheduleNextCall();
            }
          }
        }
      }

      // Pulse firing — always at pulseRateHz, never silent. Each pulse
      // kicks off a short broadband noise burst.
      if (this.samplesUntilNextPulse <= 0) {
        this._fillBurst();
        this.samplesUntilNextPulse = pulsePeriodSamples;
      } else {
        this.samplesUntilNextPulse--;
      }

      // Emit this sample's contribution from the current burst (0 if burst
      // has already completed).
      let pulseSample = 0;
      if (this.burstRemaining > 0) {
        pulseSample = this.burstBuf[NOISE_BURST_LEN - this.burstRemaining];
        this.burstRemaining--;
      }

      // Effective formant frequency:
      //   chatter: frog.formantHz × drift(call_progress)
      //   hold:    pitch
      //   blended by hold via holdCurrent
      let driftFactor = 1;
      if (this.callActive) {
        const callProgress = Math.min(1, (this.sampleClock - this.callStartSample) / this.callTotalSamples);
        driftFactor = 1 + (this.currentCallDriftEnd - 1) * callProgress;
      }
      const chatterFormantHz = this.frog.formantHz * driftFactor;
      const effectiveFormantHz = chatterFormantHz + (this.pitchCurrent - chatterFormantHz) * hold;
      if (Math.abs(effectiveFormantHz - this._lastEffectiveFormantHz) > 0.5) {
        this._computeBandpass(effectiveFormantHz, this.frog.formantQ);
        this._lastEffectiveFormantHz = effectiveFormantHz;
      }

      // Biquad ring — always fed by the continuous pulse stream
      let y = bq.b0 * pulseSample + bq.b2 * st.x2 - bq.a1 * st.y1 - bq.a2 * st.y2;
      st.x2 = st.x1; st.x1 = pulseSample;
      st.y2 = st.y1; st.y1 = y;
      if (Math.abs(st.y1) < 1e-18) st.y1 = 0;
      if (Math.abs(st.y2) < 1e-18) st.y2 = 0;

      // Chatter envelope (post-biquad): the wedge silhouette of the current
      // note, or 0 between notes.
      let chatterEnv = 0;
      if (this.noteActive) {
        const wedge = this.noteSamplesElapsed / this.noteSamplesTotal;
        chatterEnv = wedge * this.noteAmp;
        this.noteSamplesElapsed++;
      }

      // Hold blends chatter envelope → 1.0 (sustained). The grain stream
      // underneath is continuous — we just stop gating it.
      const env = chatterEnv * (1 - hold) + 1.0 * hold;

      out[s] = y * env * amplitude * OUTPUT_GAIN;
    }

    return true;
  }
}

registerProcessor("ewing-processor", EwingProcessor);
