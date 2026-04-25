/**
 * Frog Worklet — single vocalising voice.
 *
 * Architecture: sawtooth oscillator + biphonic detuned secondary → 3-formant
 * biquad bank → envelope. Sawtooth (not impulse) so the formants ring
 * continuously rather than decaying between pulses — gives sustained vocal
 * buzz rather than per-pulse "snare hit" character. Two modes blend
 * continuously via `hold`:
 *   hold = 0 : chatter — discrete bursts of calls fired by `trigger` event.
 *   hold = 1 : sustained pitched tone at `pitch` Hz.
 *
 * Always-on biological micro-modulations give the voice its frogginess in
 * both modes (none of these are exposed as parameters):
 *   - Pulse-period random walk (~3% std dev, AR(1) smoothed).
 *   - Vocal-sac LFO at 6 Hz — 25% AM on overall amplitude (less in hold mode).
 *   - Formant Q breathing at sac rate — 10% Q modulation.
 *   - Biphonation: secondary pulse train at +3 Hz constant detune,
 *     30% mix relative to primary, sharing the formant bank.
 *
 * Args: optional pitch glide time in seconds (default 0.15). 0 = instant.
 */

const mapLog = (t, min, max) => Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min)));

const SAC_HZ = 6.0;
const SAC_AM_DEPTH = 0.25;
const SAC_Q_DEPTH = 0.10;
const BIPHONIC_DETUNE_HZ = 3.0;
const BIPHONIC_MIX = 0.30;
const FORMANT_RATIOS = [0.8, 1.6, 3.0];   // relative to voiceCenter
const FORMANT_BASE_Q = [8, 6, 4];          // higher Q for vocal-formant sharpness
const PULSE_JITTER_STD = 0.03;

class FrogProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "voiceCenter",   defaultValue: 0.5, automationRate: "k-rate" },
      { name: "pulseRate",     defaultValue: 0.4, automationRate: "k-rate" },
      { name: "rasp",          defaultValue: 0.2, automationRate: "k-rate" },
      { name: "sustain",       defaultValue: 0.6, automationRate: "k-rate" },
      { name: "callsPerBurst", defaultValue: 0.4, automationRate: "k-rate" },
      { name: "callRate",      defaultValue: 0.5, automationRate: "k-rate" },
      { name: "pitch",         defaultValue: 110, automationRate: "k-rate" },
      { name: "hold",          defaultValue: 0,   automationRate: "k-rate" },
      { name: "amplitude",     defaultValue: 0.5, automationRate: "k-rate" },
    ];
  }

  constructor(options) {
    super();
    this.sr = sampleRate;

    const glideSec = (options?.processorOptions?.glideSec ?? 0.15);
    this.glideCoeff = glideSec > 0 ? Math.exp(-1 / (glideSec * this.sr)) : 0;
    this.pitchCurrent = 110;

    this.holdSmoothCoeff = Math.exp(-1 / (0.05 * this.sr));
    this.holdCurrent = 0;

    // Sawtooth phase accumulators (range 0..1, wrap on overflow)
    this.sawPhase1 = 0;
    this.sawPhase2 = Math.random();        // de-phase the biphonic secondary
    this.jitterDrift = 0;                  // shared random walk on freq

    this.envValue = 0;
    this.envDecayCoeff = 0.999;
    this.callActive = false;
    this.callAttackLeft = 0;
    this.callAttackSamples = 1;

    this.callsLeftInBurst = 0;
    this.samplesUntilNextCall = 0;
    this.burstCallRateHz = 4;
    this.burstSustainSec = 0.1;

    this.sacPhase = Math.random() * 6.2832;

    // 3 biquads — direct-form I state per filter
    this.formants = FORMANT_RATIOS.map((_, i) => ({
      zX1: 0, zX2: 0, zY1: 0, zY2: 0,
      // Coefficients (recomputed once per block):
      b0: 0, b2: 0, a1: 0, a2: 0,
    }));

    this.noiseLP = 0;

    this.pendingTrigger = false;
    this.port.onmessage = (e) => {
      if (e.data?.type === "trigger") this.pendingTrigger = true;
    };
  }

  // Update the freq-jitter drift once per block; per-sample reads use
  // `this.jitterDrift` directly. AR(1) smoothing at block rate gives
  // ~250 ms drift time constant — audible vibrato-ish breath rather than
  // millisecond-scale FM noise.
  updateJitter() {
    const noise = (Math.random() * 2 - 1) * PULSE_JITTER_STD;
    this.jitterDrift = this.jitterDrift * 0.99 + noise * 0.01;
  }

  // Cookbook biquad bandpass with constant peak gain. Coefficients-only —
  // state lives on each formant.
  computeBiquadCoeffs(formant, fHz, q) {
    const w0 = 6.2832 * fHz / this.sr;
    const cosW = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.max(0.5, q));
    const a0 = 1 + alpha;
    formant.b0 = alpha / a0;
    formant.b2 = -alpha / a0;
    formant.a1 = (-2 * cosW) / a0;
    formant.a2 = (1 - alpha) / a0;
  }

  startCall(sustainSec) {
    this.envValue = 0;
    this.callAttackSamples = Math.max(1, Math.round(0.005 * this.sr));
    this.callAttackLeft = this.callAttackSamples;
    this.envDecayCoeff = Math.exp(-6.9 / (sustainSec * this.sr));
    this.callActive = true;
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const blockSize = out.length;
    const sr = this.sr;

    // --- Per-block parameter mapping ---
    const voiceCenter01 = parameters.voiceCenter[0];
    const pulseRate01   = parameters.pulseRate[0];
    const rasp          = parameters.rasp[0];
    const sustain01     = parameters.sustain[0];
    const callsPerBurst = Math.max(1, Math.round(mapLog(parameters.callsPerBurst[0], 1, 12)));
    const callRate01    = parameters.callRate[0];
    const pitchHz       = Math.max(20, parameters.pitch[0]);
    const holdTarget    = Math.min(1, Math.max(0, parameters.hold[0]));
    const amplitude     = parameters.amplitude[0];

    const voiceCenterHz = mapLog(voiceCenter01, 200, 4000);
    const pulseRateHz   = mapLog(pulseRate01, 30, 300);
    const callRateHz    = mapLog(callRate01, 2, 20);
    const sustainSec    = mapLog(sustain01, 0.030, 0.500);

    // --- Formant coefficients (block-rate, with mid-block sac wobble averaged in) ---
    // Use sac(t=block-mid) for Q so the wobble has audible LF effect without
    // recomputing per sample. Sac AM on amplitude is still per-sample.
    const sacMidBlock = Math.sin(this.sacPhase + 6.2832 * SAC_HZ * (blockSize * 0.5) / sr);
    for (let i = 0; i < this.formants.length; i++) {
      const fHz = voiceCenterHz * FORMANT_RATIOS[i];
      const q = FORMANT_BASE_Q[i] * (1 + sacMidBlock * SAC_Q_DEPTH);
      this.computeBiquadCoeffs(this.formants[i], fHz, q);
    }

    if (this.pendingTrigger) {
      this.callsLeftInBurst = callsPerBurst;
      this.samplesUntilNextCall = 0;
      this.burstCallRateHz = callRateHz;
      this.burstSustainSec = sustainSec;
      this.pendingTrigger = false;
    }

    this.updateJitter();
    const fm = 1 + this.jitterDrift;

    for (let s = 0; s < blockSize; s++) {
      // Smooth pitch (portamento)
      this.pitchCurrent = pitchHz + this.glideCoeff * (this.pitchCurrent - pitchHz);
      // Smooth hold
      this.holdCurrent = holdTarget + this.holdSmoothCoeff * (this.holdCurrent - holdTarget);
      const hold = this.holdCurrent;

      // Vocal-sac LFO
      this.sacPhase += 6.2832 * SAC_HZ / sr;
      if (this.sacPhase > 6.2832) this.sacPhase -= 6.2832;
      const sac = Math.sin(this.sacPhase);

      // Burst scheduling (paused while hold dominates)
      if (hold < 0.99 && this.callsLeftInBurst > 0) {
        if (this.samplesUntilNextCall <= 0) {
          this.startCall(this.burstSustainSec);
          this.callsLeftInBurst--;
          if (this.callsLeftInBurst > 0) {
            const jitter = 1 + (Math.random() * 2 - 1) * 0.15;
            this.samplesUntilNextCall = Math.round(sr * jitter / this.burstCallRateHz);
          }
        }
        this.samplesUntilNextCall--;
      }

      // Per-call envelope
      let callEnv = 0;
      if (this.callActive) {
        if (this.callAttackLeft > 0) {
          this.envValue += 1 / this.callAttackSamples;
          this.callAttackLeft--;
          if (this.callAttackLeft <= 0) this.envValue = 1;
        } else {
          this.envValue *= this.envDecayCoeff;
          if (this.envValue < 0.0005) {
            this.envValue = 0;
            this.callActive = false;
          }
        }
        callEnv = this.envValue;
      }

      // Morph envelope: per-call → 1 as hold → 1
      const env = callEnv + hold * (1 - callEnv);
      // Sac AM (slightly less depth in hold mode for cleaner chords)
      const sacAm = 1 + sac * SAC_AM_DEPTH * (1 - 0.3 * hold);
      const totalEnv = env * sacAm;

      // Effective fundamental frequency: pulseRate → pitch as hold rises.
      // Block-rate freq jitter applied as multiplicative FM.
      const baseHz = pulseRateHz + (this.pitchCurrent - pulseRateHz) * hold;
      const effectiveHz = Math.max(20, baseHz * fm);

      // Primary sawtooth — continuous periodic source so formants ring
      // sustained, not as per-impulse decay.
      this.sawPhase1 += effectiveHz / sr;
      if (this.sawPhase1 >= 1) this.sawPhase1 -= 1;
      const saw1 = 2 * this.sawPhase1 - 1;

      // Biphonic secondary at +3 Hz
      this.sawPhase2 += (effectiveHz + BIPHONIC_DETUNE_HZ) / sr;
      if (this.sawPhase2 >= 1) this.sawPhase2 -= 1;
      const saw2 = 2 * this.sawPhase2 - 1;

      let source = saw1 + saw2 * BIPHONIC_MIX;

      // Rasp blend — pulse → filtered noise. The formant bank colors both.
      if (rasp > 0) {
        const noise = Math.random() * 2 - 1;
        this.noiseLP = this.noiseLP * 0.85 + noise * 0.15;
        source = source * (1 - rasp) + this.noiseLP * rasp;
      }

      // Formant bank — 3 parallel biquad bandpasses
      let formantOut = 0;
      for (let i = 0; i < this.formants.length; i++) {
        const f = this.formants[i];
        const y = f.b0 * source + f.b2 * f.zX2 - f.a1 * f.zY1 - f.a2 * f.zY2;
        f.zX2 = f.zX1;
        f.zX1 = source;
        f.zY2 = f.zY1;
        f.zY1 = y;
        formantOut += y;
      }
      formantOut *= 0.4; // sum of 3 BP — keep peaks under unity

      out[s] = formantOut * totalEnv * amplitude;
    }

    return true;
  }
}

registerProcessor("frog-processor", FrogProcessor);
