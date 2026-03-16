/**
 * Sine Oscillator Worklet — pure sine tone
 * Parameters: freq, amplitude
 */

class SineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = 0;
    this.sr = sampleRate;
    this.targets = { freq: 220, amplitude: 0 };
    this.current = { ...this.targets };
    this.port.onmessage = (e) => {
      if (e.data.type === "params") {
        for (const key of Object.keys(this.targets)) {
          if (e.data[key] !== undefined) this.targets[key] = e.data[key];
        }
        this.targets.freq = Math.max(20, Math.min(20000, this.targets.freq));
        this.targets.amplitude = Math.max(0, Math.min(1, this.targets.amplitude));
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;
    const smooth = 1 - Math.exp(-1 / (this.sr * 0.005));

    for (let i = 0; i < n; i++) {
      this.current.freq += (this.targets.freq - this.current.freq) * smooth;
      this.current.amplitude += (this.targets.amplitude - this.current.amplitude) * smooth;

      out[i] = Math.sin(this.phase * 2 * Math.PI) * this.current.amplitude;
      this.phase += this.current.freq / this.sr;
      if (this.phase >= 1) this.phase -= 1;
    }
    return true;
  }
}

registerProcessor("sine-processor", SineProcessor);
