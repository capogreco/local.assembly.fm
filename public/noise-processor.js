/**
 * Noise Generator Worklet — white noise through resonant lowpass
 * Parameters: cutoff (Hz), resonance (0-1), amplitude (0-1)
 */

class NoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate;
    this.targets = { cutoff: 5000, resonance: 0, amplitude: 0 };
    this.current = { ...this.targets };
    // biquad state
    this.x1 = 0; this.x2 = 0;
    this.y1 = 0; this.y2 = 0;
    this.b0 = 1; this.b1 = 0; this.b2 = 0;
    this.a1 = 0; this.a2 = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === "params") {
        for (const key of Object.keys(this.targets)) {
          if (e.data[key] !== undefined) this.targets[key] = e.data[key];
        }
        this.targets.cutoff = Math.max(20, Math.min(20000, this.targets.cutoff));
        this.targets.resonance = Math.max(0, Math.min(1, this.targets.resonance));
        this.targets.amplitude = Math.max(0, Math.min(1, this.targets.amplitude));
      }
    };
  }

  updateCoeffs() {
    const freq = this.current.cutoff;
    const Q = 0.5 + this.current.resonance * 15; // Q range 0.5-15.5
    const w0 = 2 * Math.PI * freq / this.sr;
    const alpha = Math.sin(w0) / (2 * Q);
    const cosw0 = Math.cos(w0);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cosw0) / 2) / a0;
    this.b1 = (1 - cosw0) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cosw0) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const smooth = 1 - Math.exp(-1 / (this.sr * 0.005));

    for (let i = 0; i < n; i++) {
      this.current.cutoff += (this.targets.cutoff - this.current.cutoff) * smooth;
      this.current.resonance += (this.targets.resonance - this.current.resonance) * smooth;
      this.current.amplitude += (this.targets.amplitude - this.current.amplitude) * smooth;

      // update filter coefficients periodically (every 32 samples)
      if ((i & 31) === 0) this.updateCoeffs();

      // white noise
      const x = Math.random() * 2 - 1;
      // biquad lowpass
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
              - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x;
      this.y2 = this.y1; this.y1 = y;

      out[i] = y * this.current.amplitude;
    }
    return true;
  }
}

registerProcessor("noise-processor", NoiseProcessor);
