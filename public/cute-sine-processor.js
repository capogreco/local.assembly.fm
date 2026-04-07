/**
 * Cute Sine — additive sine oscillator with brightness control.
 * 6 harmonics crossfaded by a "bright" parameter (0–1).
 * Parameters via AudioParam: freq, amplitude, bright
 */

class CuteSineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "freq",      defaultValue: 220, automationRate: "a-rate" },
      { name: "amplitude", defaultValue: 0.5, automationRate: "a-rate" },
      { name: "bright",    defaultValue: 0,   automationRate: "a-rate" },
    ];
  }

  constructor() {
    super();
    this.phase = 0;
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;

    const freqArr  = parameters.freq;
    const ampArr   = parameters.amplitude;
    const brightArr = parameters.bright;

    for (let frame = 0; frame < out.length; frame++) {
      const freq   = freqArr.length   > 1 ? freqArr[frame]   : freqArr[0];
      const amp    = ampArr.length    > 1 ? ampArr[frame]    : ampArr[0];
      const bright = brightArr.length > 1 ? brightArr[frame] : brightArr[0];

      let sig = 0;
      let brightDec = (bright * 5) + 1;

      for (let i = 1; i <= 6; i++) {
        const bAmp = Math.min(brightDec, 1);
        sig += Math.sin(this.phase * Math.PI * 2 * i) * (amp / i) * bAmp;
        brightDec = Math.max(brightDec - 1, 0);
      }

      this.phase += freq / sampleRate;
      if (this.phase >= 1) this.phase -= 1;
      out[frame] = sig;
    }
    return true;
  }
}

registerProcessor("cute-sine-processor", CuteSineProcessor);
