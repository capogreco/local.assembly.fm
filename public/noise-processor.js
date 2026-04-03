/**
 * Noise Generator Worklet — white noise through resonant lowpass
 * Parameters via AudioParam: cutoff, resonance, amplitude
 */

class NoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "cutoff",    defaultValue: 5000, automationRate: "k-rate" },
      { name: "resonance", defaultValue: 0,    automationRate: "k-rate" },
      { name: "amplitude", defaultValue: 0.5,  automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    // biquad state
    this.x1 = 0; this.x2 = 0;
    this.y1 = 0; this.y2 = 0;
    this.b0 = 1; this.b1 = 0; this.b2 = 0;
    this.a1 = 0; this.a2 = 0;
    this.coeffSample = 0;
  }

  updateCoeffs(freq, resonance) {
    const Q = 0.5 + resonance * 15;
    const w0 = 6.2832 * freq / sampleRate;
    const alpha = Math.sin(w0) / (2 * Q);
    const cosw0 = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cosw0) / 2) / a0;
    this.b1 = (1 - cosw0) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cosw0) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const cutoff = parameters.cutoff[0];
    const resonance = parameters.resonance[0];
    const amp = parameters.amplitude[0];
    if (amp < 0.0001) return true;

    // Update filter coefficients once per block
    this.updateCoeffs(cutoff, resonance);

    for (let i = 0; i < out.length; i++) {
      const x = Math.random() * 2 - 1;
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
              - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x;
      this.y2 = this.y1; this.y1 = y;
      out[i] = y * amp;
    }
    return true;
  }
}

registerProcessor("noise-processor", NoiseProcessor);
