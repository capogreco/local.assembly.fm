/**
 * Sine Oscillator Worklet — pure sine tone
 * Parameters via AudioParam: freq, amplitude
 */

class SineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "freq",      defaultValue: 220, automationRate: "k-rate" },
      { name: "amplitude", defaultValue: 0,   automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.phase = 0;
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const freq = parameters.freq[0];
    const amp = parameters.amplitude[0];
    if (amp < 0.0001) return true;

    for (let i = 0; i < out.length; i++) {
      out[i] = Math.sin(this.phase * 6.2832) * amp;
      this.phase += freq / sampleRate;
      if (this.phase >= 1) this.phase -= 1;
    }
    return true;
  }
}

registerProcessor("sine-processor", SineProcessor);
