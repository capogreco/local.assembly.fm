/**
 * Karplus-Strong Worklet — plucked string synthesis
 * AudioParams: frequency, decay, brightness, stiffness, amplitude
 * Pluck fires on port message { type: "trigger" }.
 *
 * Tuning: one-pole allpass for fractional delay, compensated for loop-filter
 * group delay and stiffness cascade phase delay so the fundamental stays
 * accurate regardless of stiffness setting.
 *
 * Decay: user specifies T60 in seconds; worklet computes per-sample loss
 * coefficient from (freq, decay) so decay time stays uniform across the range.
 *
 * Stiffness: cascade of K=4 first-order allpasses injects frequency-dependent
 * phase delay in the loop, so higher modes tune progressively sharp — the
 * inharmonicity of a real string. Stiffness=0 is classic harmonic KS.
 */

const STIFF_K = 4;

class KSProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "frequency",  defaultValue: 220, automationRate: "k-rate" },
      { name: "decay",      defaultValue: 2.0, automationRate: "k-rate" },
      { name: "brightness", defaultValue: 0.8, automationRate: "k-rate" },
      { name: "stiffness",  defaultValue: 0.0, automationRate: "k-rate" },
      { name: "amplitude",  defaultValue: 0.5, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.maxLen = Math.ceil(sampleRate / 20); // longest delay line: 20 Hz
    this.buf = new Float32Array(this.maxLen);
    this.writePos = 0;
    this.lpPrev = 0;
    this.apPrevIn = 0;
    this.apPrevOut = 0;
    this.stiffState = new Float32Array(STIFF_K);
    this.pendingPluck = false;
    this.port.onmessage = (e) => {
      if (e.data?.type === "trigger") this.pendingPluck = true;
    };
  }

  pluck(delay, brightness) {
    let prev = 0;
    const len = Math.min(delay, this.maxLen);
    for (let i = 0; i < len; i++) {
      const noise = Math.random() * 2 - 1;
      const sample = prev + brightness * (noise - prev);
      prev = sample;
      this.buf[(this.writePos - delay + i + this.maxLen) % this.maxLen] = sample;
    }
    this.lpPrev = 0;
    this.apPrevIn = 0;
    this.apPrevOut = 0;
    this.stiffState.fill(0);
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;

    const freq = parameters.frequency[0];
    const decay = parameters.decay[0];
    const brightness = parameters.brightness[0];
    const stiffness = parameters.stiffness[0];
    const amp = parameters.amplitude[0];

    const fSafe = Math.max(freq, 20);
    const w = 2 * Math.PI * fSafe / sampleRate;

    // Per-sample feedback coefficient chosen so T60 = `decay` regardless of pitch.
    // damp^(freq*decay) = 0.001 (i.e. -60 dB) → damp = 0.001^(1/(freq*decay))
    const damp = decay > 0 ? Math.pow(0.001, 1 / (fSafe * decay)) : 0;

    // Stiffness cascade allpass coefficient. Negative a produces the physical
    // "high modes travel faster" dispersion. Clamp magnitude to stay stable.
    const stiff = Math.max(0, Math.min(1, stiffness));
    const a = -0.9 * stiff;

    // Phase delay of the stiffness cascade at the fundamental (in samples),
    // so we can subtract it from the integer delay and keep the fundamental
    // tuned correctly regardless of stiffness.
    const sw = Math.sin(w);
    const cw = Math.cos(w);
    const phaseNum = Math.atan2(-sw, a + cw);
    const phaseDen = Math.atan2(-a * sw, 1 + a * cw);
    const stiffPhaseDelay = -STIFF_K * (phaseNum - phaseDen) / w;

    // Total target loop delay = period − loop-filter group delay − stiffness delay
    const totalDelay = sampleRate / fSafe - 0.5 - stiffPhaseDelay;
    const intDelay = Math.max(1, Math.min(this.maxLen, Math.round(totalDelay - 1)));
    const d = totalDelay - intDelay;
    const C = (1 - d) / (1 + d);

    if (this.pendingPluck) {
      this.pluck(intDelay, brightness);
      this.pendingPluck = false;
    }

    for (let s = 0; s < out.length; s++) {
      const readPos = (this.writePos - intDelay + this.maxLen) % this.maxLen;
      const xN = this.buf[readPos];

      // Tuning allpass: fractional delay so the fundamental sits exactly at freq.
      let y = C * (xN - this.apPrevOut) + this.apPrevIn;
      this.apPrevIn = xN;
      this.apPrevOut = y;

      // Stiffness cascade: K first-order allpasses, direct-form II transposed.
      for (let k = 0; k < STIFF_K; k++) {
        const yOut = a * y + this.stiffState[k];
        this.stiffState[k] = y - a * yOut;
        y = yOut;
      }

      const filtered = damp * 0.5 * (y + this.lpPrev);
      this.lpPrev = y;

      out[s] = y * amp;

      this.buf[this.writePos] = filtered;
      this.writePos = (this.writePos + 1) % this.maxLen;
    }

    return true;
  }
}

registerProcessor("ks-processor", KSProcessor);
