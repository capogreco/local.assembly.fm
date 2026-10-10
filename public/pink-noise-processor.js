/**
 * Pink Noise Signal Worklet — -3 dB/octave noise (Paul Kellet's refined filter)
 * No parameters. Output peaks around ±1, same footprint as white noise~.
 */

class PinkNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.b0 = 0; this.b1 = 0; this.b2 = 0; this.b3 = 0;
    this.b4 = 0; this.b5 = 0; this.b6 = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      const white = Math.random() * 2 - 1;
      this.b0 = 0.99886 * this.b0 + white * 0.0555179;
      this.b1 = 0.99332 * this.b1 + white * 0.0750759;
      this.b2 = 0.96900 * this.b2 + white * 0.1538520;
      this.b3 = 0.86650 * this.b3 + white * 0.3104856;
      this.b4 = 0.55000 * this.b4 + white * 0.5329522;
      this.b5 = -0.7616 * this.b5 - white * 0.0168980;
      out[i] = (this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362) * 0.11;
      this.b6 = white * 0.115926;
    }
    return true;
  }
}

registerProcessor("pink-noise-processor", PinkNoiseProcessor);
