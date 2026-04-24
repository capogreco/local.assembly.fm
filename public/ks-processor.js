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
    // Latched-at-pluck buffer-read geometry. intDelay and C determine how the
    // feedback loop reads from the delay line; recomputing them mid-ring when
    // parameters change (e.g. during a parameter-send / trigger gap) can read
    // stale buffer content at a new offset, injecting a transient that rings
    // down through the loop filter. Freeze them at pluck time.
    this.intDelay = 1;
    this.C = 0;
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
    // "high modes travel faster" dispersion. Safe to update per block — the
    // cascade state is small and transitions smoothly with the coefficient.
    const stiff = Math.max(0, Math.min(1, stiffness));
    const a = -0.9 * stiff;

    // Buffer-read geometry (intDelay, C) is LATCHED AT PLUCK TIME. A pending
    // pluck recomputes it using the current params; between plucks we keep the
    // previous values so the loop reads consistent buffer content even if
    // AudioParams update mid-ring.
    if (this.pendingPluck) {
      // Phase delay of the stiffness cascade at the fundamental (in samples).
      const sw = Math.sin(w);
      const cw = Math.cos(w);
      const phaseNum = Math.atan2(-sw, a + cw);
      const phaseDen = Math.atan2(-a * sw, 1 + a * cw);
      const stiffPhaseDelay = -STIFF_K * (phaseNum - phaseDen) / w;
      const totalDelay = sampleRate / fSafe - 0.5 - stiffPhaseDelay;
      this.intDelay = Math.max(1, Math.min(this.maxLen, Math.round(totalDelay - 1)));
      // Clamp fractional delay to the well-conditioned range of the one-pole
      // allpass. Without this, high stiffness (or high pitch) can push
      // totalDelay below what the delay line can physically accommodate, and
      // `d = totalDelay - intDelay` drops out of [0.5, 1.5]. C = (1-d)/(1+d)
      // then leaves the unit disk and the loop goes unstable — reads as severe
      // DC offset. When clamped, the fundamental is slightly detuned at
      // extreme stiffness but the loop stays stable.
      const d = Math.max(0.5, Math.min(1.5, totalDelay - this.intDelay));
      this.C = (1 - d) / (1 + d);
      this.pluck(this.intDelay, brightness);
      this.pendingPluck = false;
    }

    const intDelay = this.intDelay;
    const C = this.C;

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

      // Tiny DC offset prevents the feedback loop from drifting into denormal
      // range during long ringdowns — inaudible (below 32-bit float audio
      // precision) but rules out denormal-transition artifacts on platforms
      // where sub-normal arithmetic is slow or lossy.
      const filtered = damp * 0.5 * (y + this.lpPrev) + 1e-20;
      this.lpPrev = y;

      out[s] = y * amp;

      this.buf[this.writePos] = filtered;
      this.writePos = (this.writePos + 1) % this.maxLen;
    }

    return true;
  }
}

registerProcessor("ks-processor", KSProcessor);
